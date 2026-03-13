import { AITool, FileChange, VerificationMode } from '../src/types.js';

export type RepoFileInfo = {
  totalLines: number;
  nonEmptyLines: number;
  lineSet: Set<string>;
  normalizedLineSet: Set<string>;
  // Track line counts to handle duplicate lines properly
  lineCounts: Map<string, number>;
  normalizedLineCounts: Map<string, number>;
};

export type VerificationResult = {
  matched: number;
  content: string[];
};

export interface HistoryProvider {
  getFileCreateTime(filePath: string): Date | null;
  getFileLinesSetBeforeTimestamp(filePath: string, timestamp: Date): Set<string> | null;
  getFileLineCountsBeforeTimestamp(filePath: string, timestamp: Date): Map<string, number> | null;
}

/**
 * 工具方法：判断是否为空白字符
 * 直接判断ASCII码，比字符串对比/charAt()更高效
 * 匹配：空格(32)、制表符(9)、换行(10)、回车(13)
 */
function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * 判断一行是否全为空白字符
 */
function isLineEmptyOrWhitespace(line: string): boolean {
  const len = line.length;
  if (len === 0) return true;
  for (let i = 0; i < len; i++) {
    if (!isWhitespace(line.charCodeAt(i))) {
      return false;
    }
  }
  return true;
}

export class ContributionVerifier {
  private verificationMode: VerificationMode;
  private historyProvider?: HistoryProvider;

  constructor(verificationMode: VerificationMode, historyProvider?: HistoryProvider) {
    this.verificationMode = verificationMode;
    this.historyProvider = historyProvider;
  }

  /**
   * Split content into non-empty lines (excluding whitespace-only lines)
   */
  public splitNonEmptyLines(content: string | undefined): string[] {
    if (!content) return [];
    return content.split(/\r?\n/).filter(line => !isLineEmptyOrWhitespace(line));
  }

  /**
   * Normalize a line for relaxed matching (collapse whitespace)
   * 优化后的行归一化方法：手动处理空白，替代正则
   * 功能：与原逻辑一致（trim+连续空白压缩为单个空格）
   * 优势：无正则引擎开销，一次遍历完成所有处理
   */
  public normalizeLine(line: string): string {
    const len = line.length;
    let res = '';
    let isLastWhitespace = false;
    // 跳过首部空白（替代trimStart）
    let start = 0;
    while (start < len && isWhitespace(line.charCodeAt(start))) start++;
    // 遍历字符，压缩连续空白
    for (let i = start; i < len; i++) {
      const code = line.charCodeAt(i);
      const curWhitespace = isWhitespace(code);
      if (curWhitespace) {
        if (!isLastWhitespace) res += ' ';
        isLastWhitespace = true;
      } else {
        res += line[i];
        isLastWhitespace = false;
      }
    }
    // 去除尾部空白（替代trimEnd）
    return res.endsWith(' ') ? res.slice(0, -1) : res;
  }

  /**
   * Get added lines from a change, falling back to content
   */
  public getAddedLines(change: FileChange): string[] {
    if (change.addedLines && change.addedLines.length > 0) {
      return change.addedLines;
    }
    if (change.content) {
      return this.splitNonEmptyLines(change.content);
    }
    return [];
  }

  /**
   * Verify lines for a single change, tracking globally to avoid duplicates
   */
  public verifyChangeLines(
    change: FileChange,
    fileInfo: RepoFileInfo,
    verifiedLinesRemainingByFile: Map<string, Map<string, number>>,
    verifiedNormalizedRemainingByFile: Map<string, Map<string, number>>
  ): VerificationResult {
    let addedLines = this.getAddedLines(change);

    // Filter out lines that were just moved or reformatted (exist in removedLinesContent)
    if (change.removedLinesContent && change.removedLinesContent.length > 0) {
      const removedCounts = new Map<string, number>();
      for (const line of change.removedLinesContent) {
        removedCounts.set(line, (removedCounts.get(line) || 0) + 1);
      }
      
      const filteredAddedLines: string[] = [];
      for (const line of addedLines) {
        const count = removedCounts.get(line);
        if (count && count > 0) {
          removedCounts.set(line, count - 1);
          // Skip this line as it was "removed" and "added" back
        } else {
          filteredAddedLines.push(line);
        }
      }
      addedLines = filteredAddedLines;
    }
    
    const resultLines: string[] = [];

    if (this.verificationMode === 'historical') {
      if (change.linesAdded > 0) {
        return { matched: change.linesAdded, content: addedLines.slice(0, change.linesAdded) };
      }
      return { matched: 0, content: [] };
    }

    // Special handling for Trae: if addedLines is empty but linesAdded > 0,
    // it means we couldn't extract specific lines (e.g. binary or too large diff),
    // or it's a full file rewrite where we don't have the "before" state easily.
    // In this case, we trust the linesAdded count BUT cap it at the current file size.
    if (addedLines.length === 0 && change.linesAdded > 0 && change.tool === AITool.TRAE) {
       // Try to get historical line counts to filter out non-added lines
       // This prevents counting existing lines as AI contribution when Trae rewrites the whole file
       const lineCountsBefore = this.historyProvider?.getFileLineCountsBeforeTimestamp(change.filePath, change.timestamp || new Date());
       
       if (lineCountsBefore) {
          // Calculate "Bag of Lines" difference: Current - Before
          // We only count the positive difference (added lines)
          let estimatedAddedCount = 0;
          const filePath = change.filePath;
          const remainingExact = verifiedLinesRemainingByFile.get(filePath);

          // Iterate through current file lines
          // Since we don't have the content array here, we iterate the counts map
          // Note: This loses line order, but for count verification it's acceptable
          if (remainingExact) {
            for (const [line, currentCount] of fileInfo.lineCounts) {
               // Stop if we have reached the linesAdded limit claimed by the tool
               if (estimatedAddedCount >= change.linesAdded) break;

               if (isLineEmptyOrWhitespace(line)) continue;

               const beforeCount = lineCountsBefore.get(line) || 0;
               const diff = currentCount - beforeCount;
               
               if (diff > 0) {
                  // This line appears more times now than before
                  const remaining = remainingExact.get(line) || 0;
                  // We can take the minimum of:
                  // 1. The actual increase in count (diff)
                  // 2. The remaining unclaimed instances (remaining)
                  const claimable = Math.min(diff, remaining);
                  
                  if (claimable > 0) {
                     // Don't claim more than what the tool reported
                     const take = Math.min(claimable, change.linesAdded - estimatedAddedCount);
                     
                     if (take > 0) {
                        estimatedAddedCount += take;
                        remainingExact.set(line, remaining - take);
                        // We push a placeholder to content just to keep the count consistent if needed
                        // But since we don't have order, we might skip content for this special case
                     }
                  }
               }
            }
            return { matched: estimatedAddedCount, content: [] };
          }
       }

       // For Trae full-file rewrites/creations that match current file content
       // We can't verify line-by-line without the addedLines content.
       // However, if the file exists and has content, and Trae claims to have written it,
       // we can optimistically count it, but cap at current file lines.
       return { matched: Math.min(change.linesAdded, fileInfo.nonEmptyLines), content: [] };
    }

    // Special handling for Trae with addedLines: check git history to avoid overcounting
    // If Trae claims to "create" a file that already existed in git before the session,
    // we should only count the NEW lines, not the entire file.
    if (change.tool === AITool.TRAE && change.changeType === 'create' && addedLines.length > 0) {
      const fileCreateTime = this.historyProvider?.getFileCreateTime(change.filePath);
      if (fileCreateTime && change.timestamp && change.timestamp > fileCreateTime) {
        // File existed before the AI session, get the lines before the session
        const linesBeforeSet = this.historyProvider?.getFileLinesSetBeforeTimestamp(change.filePath, change.timestamp);
        if (linesBeforeSet !== null && linesBeforeSet && linesBeforeSet.size > 0) {
          // File existed with content, so this is a modification, not a creation
          // We should only count lines that didn't exist before
          const filePath = change.filePath;
          const remainingExact = verifiedLinesRemainingByFile.get(filePath);
          const remainingNormalized = verifiedNormalizedRemainingByFile.get(filePath);

          let matched = 0;
          try {
            for (const line of addedLines) {
              if (isLineEmptyOrWhitespace(line)) continue;

              // Check if line exists in current file
              const exactMatch = fileInfo.lineSet.has(line);
              
              // 极简分支：优先查精确匹配
              if (exactMatch && remainingExact) {
                const remaining = remainingExact.get(line) || 0;
                if (remaining > 0) {
                  // In relaxed mode, check if we have normalized quota available
                  let normalized = '';
                  if (this.verificationMode === 'relaxed' && remainingNormalized) {
                     normalized = this.normalizeLine(line);
                     // If normalized quota is exhausted, we cannot claim this exact match
                     // because it must have been consumed by a fuzzy match previously.
                     // Exception: if normalizeLine returns empty string (whitespace), we might still allow it?
                     // Current logic: if normalized is empty, we skip normalized check.
                     if (normalized.length > 0) {
                        const normRemaining = remainingNormalized.get(normalized) || 0;
                        if (normRemaining <= 0) {
                           continue; // Skip exact match to avoid double counting
                        }
                     }
                  }

                  remainingExact.set(line, remaining - 1);
                  if (this.verificationMode === 'relaxed' && remainingNormalized && normalized.length > 0) {
                     const normRemaining = remainingNormalized.get(normalized) || 0;
                     if (normRemaining > 0) {
                       remainingNormalized.set(normalized, normRemaining - 1);
                     }
                  }
                  matched++;
                  resultLines.push(line);
                  continue; // 跳过后续逻辑
                }
              }

              // 精确匹配失败，且为relaxed模式，才进行归一化处理
              if (this.verificationMode === 'relaxed' && remainingNormalized) {
                const normalized = this.normalizeLine(line);
                if (normalized.length > 0 && fileInfo.normalizedLineSet.has(normalized)) {
                   const remaining = remainingNormalized.get(normalized) || 0;
                   if (remaining > 0) {
                     remainingNormalized.set(normalized, remaining - 1);
                     matched++;
                     resultLines.push(line);
                   }
                }
              }
            }
          } catch (err) {
            console.error('Error in verifyChangeLines:', err);
          }
          
          return { matched, content: resultLines };
        }
      }
    }

    if (addedLines.length === 0) {
      // If we don't have added lines (e.g. binary or too large diff), but tool says linesAdded > 0
      // For Trae, we might trust it if verification mode is relaxed/historical
      if (change.tool === AITool.TRAE && change.linesAdded > 0 && this.verificationMode !== 'strict') {
          return { matched: Math.min(change.linesAdded, fileInfo.nonEmptyLines), content: [] };
      }
      return { matched: 0, content: [] };
    }

    // Get remaining counts for this file
    const filePath = change.filePath;
    const remainingExact = verifiedLinesRemainingByFile.get(filePath);
    const remainingNormalized = verifiedNormalizedRemainingByFile.get(filePath);

    if (!remainingExact) {
      return { matched: 0, content: [] };
    }

    let matched = 0;
    try {
      for (const line of addedLines) {
        if (isLineEmptyOrWhitespace(line)) continue;

        // 极简分支：优先查精确匹配
        const exactMatch = fileInfo.lineSet.has(line);
        if (exactMatch) {
          const remaining = remainingExact.get(line) || 0;
          if (remaining > 0) {
            // In relaxed mode, check if we have normalized quota available
            let normalized = '';
            if (this.verificationMode === 'relaxed' && remainingNormalized) {
               normalized = this.normalizeLine(line);
               // If normalized quota is exhausted, we cannot claim this exact match
               if (normalized.length > 0) {
                  const normRemaining = remainingNormalized.get(normalized) || 0;
                  if (normRemaining <= 0) {
                     continue; // Skip exact match to avoid double counting
                  }
               }
            }

            remainingExact.set(line, remaining - 1);
            if (this.verificationMode === 'relaxed' && remainingNormalized && normalized.length > 0) {
               const normRemaining = remainingNormalized.get(normalized) || 0;
               if (normRemaining > 0) {
                 remainingNormalized.set(normalized, normRemaining - 1);
               }
            }
            matched++;
            resultLines.push(line);
            continue; // 跳过后续归一化逻辑
          }
        }
        
        // 精确匹配失败，且为relaxed模式，才进行归一化处理
        if (this.verificationMode === 'relaxed' && remainingNormalized) {
          const normalized = this.normalizeLine(line);
          // Check normalized match
          if (normalized.length > 0 && fileInfo.normalizedLineSet.has(normalized)) {
             const remaining = remainingNormalized.get(normalized) || 0;
             if (remaining > 0) {
               remainingNormalized.set(normalized, remaining - 1);
               matched++;
               resultLines.push(line);
             }
          }
        }
      }
    } catch (err) {
      console.error('Error in verifyChangeLines:', err);
      throw err;
    }

    if (change.linesAdded > 0) {
      const finalCount = Math.min(matched, change.linesAdded);
      if (resultLines.length > finalCount) resultLines.length = finalCount;
      return { matched: finalCount, content: resultLines };
    }

    const finalCount = Math.min(matched, addedLines.length);
    if (resultLines.length > finalCount) resultLines.length = finalCount;
    return { matched: finalCount, content: resultLines };
  }

  /**
   * Build a file index for verification and totals (Single Pass Optimization)
   */
  public buildRepoFileInfo(content: string, buildLineSet: boolean): RepoFileInfo {
    const normalizedLines = content.split(/\r?\n/);
    const totalLines = normalizedLines.length;
    let nonEmptyLines = 0;
    
    const buildNormalizedLineSet = buildLineSet && this.verificationMode === 'relaxed';
    const lineSet = buildLineSet ? new Set<string>() : new Set<string>();
    const normalizedLineSet = buildNormalizedLineSet ? new Set<string>() : new Set<string>();
    const lineCounts = buildLineSet ? new Map<string, number>() : new Map<string, number>();
    const normalizedLineCounts = buildNormalizedLineSet ? new Map<string, number>() : new Map<string, number>();

    // Single pass traversal
    for (const line of normalizedLines) {
      if (isLineEmptyOrWhitespace(line)) continue;
      nonEmptyLines++;
      
      if (buildLineSet) {
        lineSet.add(line);
        const count = lineCounts.get(line) || 0;
        lineCounts.set(line, count + 1);
      }
      
      if (buildNormalizedLineSet) {
        const normalized = this.normalizeLine(line);
        if (normalized.length > 0) {
          normalizedLineSet.add(normalized);
          const normCount = normalizedLineCounts.get(normalized) || 0;
          normalizedLineCounts.set(normalized, normCount + 1);
        }
      }
    }

    return { totalLines, nonEmptyLines, lineSet, normalizedLineSet, lineCounts, normalizedLineCounts };
  }
}