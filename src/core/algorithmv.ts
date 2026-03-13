import { execFileSync } from 'child_process';
import { AISession, AITool, FileChange, VerificationMode } from '../types.js';

export type RepoFileInfo = {
  totalLines: number;
  nonEmptyLines: number;
  lineSet: Set<string>;
  normalizedLineSet: Set<string>;
  // Track line counts to handle duplicate lines properly
  lineCounts: Map<string, number>;
  normalizedLineCounts: Map<string, number>;
  // Optimization: Cache for high-frequency short lines (e.g. "}", "return;")
  // This is optional and can be populated during verification if not present
  highFreqLineCounts?: Record<string, number>;
};

/** Verified contribution for a single change */
export type VerifiedChange = {
  change: FileChange;
  verifiedLinesAdded: number;
  verifiedContent: string[];
  modelName: string;
};

/** All verified contributions for a session */
export type VerifiedSession = {
  session: AISession;
  contributions: VerifiedChange[];
};

// High frequency line length threshold
const HIGH_FREQ_THRESHOLD = 16;

export interface HistoryProvider {
  getFileCreateTime(filePath: string): Date | null;
  getFileLinesSetBeforeTimestamp(filePath: string, timestamp: Date): Set<string> | null;
}

export class GitHistoryProvider implements HistoryProvider {
  private projectPath: string;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
  }

  getFileCreateTime(filePath: string): Date | null {
    return getFileCreateTime(this.projectPath, filePath);
  }

  getFileLinesSetBeforeTimestamp(filePath: string, timestamp: Date): Set<string> | null {
    try {
      // Find the last commit before the timestamp that modified this file
      const isoTimestamp = timestamp.toISOString();
      const result = execFileSync(
        'git',
        ['log', '-1', '--format=%H', '--before=' + isoTimestamp, '--', filePath],
        {
          cwd: this.projectPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();

      if (result) {
        // Get the file content at that commit
        const content = execFileSync(
          'git',
          ['show', result + ':' + filePath],
          {
            cwd: this.projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }
        );

        // Return set of non-empty lines
        const lines = content.split(/\r?\n/).filter(line => line.length > 0);
        return new Set(lines);
      }
    } catch {
      // File might not have existed before this timestamp
    }
    return null;
  }
}

export class ContributionVerifier {
  private projectPath: string;
  private verificationMode: VerificationMode;
  private historyProvider: HistoryProvider;

  constructor(projectPath: string, verificationMode: VerificationMode, historyProvider?: HistoryProvider) {
    this.projectPath = projectPath;
    this.verificationMode = verificationMode;
    this.historyProvider = historyProvider || new GitHistoryProvider(projectPath);
  }

  /**
   * Verify all sessions and compute verified contributions with deduplication
   */
  verifySessions(sessions: AISession[], repoFileIndex: Map<string, RepoFileInfo>): VerifiedSession[] {
    // Track verified line counts globally to avoid double-counting across sessions
    // Key: filePath, Value: Map of line -> remaining count that can be verified
    const verifiedLinesRemainingByFile = new Map<string, Map<string, number>>();
    // Optimization: Object-based cache for high-frequency lines
    const verifiedHighFreqRemainingByFile = new Map<string, Record<string, number>>();
    
    const verifiedNormalizedRemainingByFile = new Map<string, Map<string, number>>();

    const result: VerifiedSession[] = [];

    for (const session of sessions) {
      const contributions: VerifiedChange[] = [];

      for (const change of session.changes) {
        const fileInfo = repoFileIndex.get(change.filePath);
        if (!fileInfo) continue;

        // Initialize remaining counts from file's actual line counts
        if (!verifiedLinesRemainingByFile.has(change.filePath)) {
          const normalMap = new Map<string, number>();
          const highFreqObj: Record<string, number> = {};
          
          // Populate from fileInfo
          if (fileInfo.highFreqLineCounts) {
             // If already computed (future optimization in analyzer)
             Object.assign(highFreqObj, fileInfo.highFreqLineCounts);
             for (const [line, count] of fileInfo.lineCounts) {
                 normalMap.set(line, count);
             }
          } else {
             // Split on the fly
             for (const [line, count] of fileInfo.lineCounts) {
                 if (line.length < HIGH_FREQ_THRESHOLD) {
                     highFreqObj[line] = count;
                 } else {
                     normalMap.set(line, count);
                 }
             }
          }
          
          verifiedLinesRemainingByFile.set(change.filePath, normalMap);
          verifiedHighFreqRemainingByFile.set(change.filePath, highFreqObj);
        }
        
        if (this.verificationMode === 'relaxed' && !verifiedNormalizedRemainingByFile.has(change.filePath)) {
          verifiedNormalizedRemainingByFile.set(change.filePath, new Map(fileInfo.normalizedLineCounts));
        }

        const verificationResult = this.verifyChangeLines(
          change,
          fileInfo,
          verifiedLinesRemainingByFile,
          verifiedHighFreqRemainingByFile,
          verifiedNormalizedRemainingByFile
        );
        const verifiedLinesAdded = verificationResult.matched;
        const verifiedContent = verificationResult.content;

        // Include change if it has verified added lines OR if it has deleted lines
        if (verifiedLinesAdded > 0 || change.linesRemoved > 0) {
          const modelName = change.model || session.model || 'unknown';
          contributions.push({ change, verifiedLinesAdded, verifiedContent, modelName });
        }
      }

      // Include session if it has contributions OR it's a Trae session (which we can't verify)
      if (contributions.length > 0 || session.tool === AITool.TRAE) {
        result.push({ session, contributions });
      }
    }

    return result;
  }

  /**
   * Verify lines for a single change, tracking globally to avoid duplicates
   */
  private verifyChangeLines(
    change: FileChange,
    fileInfo: RepoFileInfo,
    verifiedLinesRemainingByFile: Map<string, Map<string, number>>,
    verifiedHighFreqRemainingByFile: Map<string, Record<string, number>>,
    verifiedNormalizedRemainingByFile: Map<string, Map<string, number>>
  ): { matched: number; content: string[] } {
    let addedLines = this.getAddedLines(change);

    // Filter out lines that were just moved or reformatted (exist in removedLinesContent)
    if (change.removedLinesContent && change.removedLinesContent.length > 0) {
      const removedCounts = new Map<string, number>();
      for (const line of change.removedLinesContent) {
        if (isLineEmptyOrWhitespace(line)) continue;
        removedCounts.set(line, (removedCounts.get(line) || 0) + 1);
      }
      
      const filteredAddedLines: string[] = [];
      for (const line of addedLines) {
        if (isLineEmptyOrWhitespace(line)) continue;
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
        // Only return non-empty lines
        const nonEmpty = addedLines.filter(l => !isLineEmptyOrWhitespace(l));
        return { matched: change.linesAdded, content: nonEmpty.slice(0, change.linesAdded) };
      }
      return { matched: 0, content: [] };
    }

    // Special handling for Trae: if addedLines is empty but linesAdded > 0,
    // it means we couldn't extract specific lines (e.g. binary or too large diff),
    // or it's a full file rewrite where we don't have the "before" state easily.
    // In this case, we trust the linesAdded count BUT cap it at the current file size.
    if (addedLines.length === 0 && change.linesAdded > 0 && change.tool === AITool.TRAE) {
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
      const fileCreateTime = this.getFileCreateTime(change.filePath);
      if (fileCreateTime && change.timestamp && change.timestamp > fileCreateTime) {
        // File existed before the AI session, get the lines before the session
        const linesBeforeSet = this.getFileLinesSetBeforeTimestamp(change.filePath, change.timestamp);
        if (linesBeforeSet !== null && linesBeforeSet.size > 0) {
          // File existed with content, so this is a modification, not a creation
          // We should only count lines that didn't exist before
          const filePath = change.filePath;
          const remainingExact = verifiedLinesRemainingByFile.get(filePath);
          const remainingHighFreq = verifiedHighFreqRemainingByFile.get(filePath);
          const remainingNormalized = verifiedNormalizedRemainingByFile.get(filePath);

          let matched = 0;
          try {
            for (const line of addedLines) {
              if (isLineEmptyOrWhitespace(line)) continue;

              // Check if line exists in current file
              const exactMatch = fileInfo.lineSet.has(line);
              let normalizedMatch = false;
              if (!exactMatch && this.verificationMode === 'relaxed') {
                const normalized = normalizeLine(line);
                normalizedMatch = normalized.length > 0 && fileInfo.normalizedLineSet.has(normalized);
              }

              if (!exactMatch && !normalizedMatch) continue;

              // Skip if line existed before the session
              if (linesBeforeSet.has(line)) continue;

              // Check if we have remaining count for this line
              if (exactMatch) {
                if (line.length < HIGH_FREQ_THRESHOLD && remainingHighFreq) {
                   const count = remainingHighFreq[line] || 0;
                   if (count > 0) {
                       remainingHighFreq[line] = count - 1;
                       matched++;
                       resultLines.push(line);
                   }
                } else if (remainingExact) {
                    const remaining = remainingExact.get(line) || 0;
                    if (remaining > 0) {
                        remainingExact.set(line, remaining - 1);
                        matched++;
                        resultLines.push(line);
                    }
                }
              } else if (normalizedMatch && remainingNormalized) {
                const normalized = normalizeLine(line);
                const remaining = remainingNormalized.get(normalized) || 0;
                if (remaining > 0) {
                  remainingNormalized.set(normalized, remaining - 1);
                  matched++;
                  resultLines.push(line);
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
    const remainingHighFreq = verifiedHighFreqRemainingByFile.get(filePath);
    const remainingNormalized = verifiedNormalizedRemainingByFile.get(filePath);

    if (!remainingExact && !remainingHighFreq) {
      // console.log(`[DEBUG] No remaining lines for ${filePath}`);
      return { matched: 0, content: [] };
    }

    let matched = 0;
    try {
      for (const line of addedLines) {
        if (isLineEmptyOrWhitespace(line)) continue;

        // Check if line exists in file
        const exactMatch = fileInfo.lineSet.has(line);
        let normalizedMatch = false;
        if (!exactMatch && this.verificationMode === 'relaxed') {
          const normalized = normalizeLine(line);
          normalizedMatch = normalized.length > 0 && fileInfo.normalizedLineSet.has(normalized);
        }
        
        if (!exactMatch && !normalizedMatch) continue;

        // Check if we have remaining count for this line
        if (exactMatch) {
          let counted = false;
          // Try high frequency cache first
          if (line.length < HIGH_FREQ_THRESHOLD && remainingHighFreq) {
             const count = remainingHighFreq[line] || 0;
             if (count > 0) {
                 remainingHighFreq[line] = count - 1;
                 counted = true;
             }
          } 
          
          // Try normal map if not found in high freq (or not high freq)
          if (!counted && remainingExact) {
              // Only check map if not high freq (or if implementation allows fallback, though high freq should be exclusive)
              // Here we assume exclusive split: if it's high freq, it's ONLY in high freq obj
              if (line.length >= HIGH_FREQ_THRESHOLD) {
                  const remaining = remainingExact.get(line) || 0;
                  if (remaining > 0) {
                      remainingExact.set(line, remaining - 1);
                      counted = true;
                  }
              }
          }
          
          if (counted) {
              // Also decrement normalized count if in relaxed mode
              if (this.verificationMode === 'relaxed' && remainingNormalized) {
                const normalized = normalizeLine(line);
                const normRemaining = remainingNormalized.get(normalized) || 0;
                if (normRemaining > 0) {
                  remainingNormalized.set(normalized, normRemaining - 1);
                }
              }
              matched++;
              resultLines.push(line);
          }
          
        } else if (normalizedMatch && remainingNormalized) {
          const normalized = normalizeLine(line);
          const remaining = remainingNormalized.get(normalized) || 0;
          if (remaining > 0) {
            remainingNormalized.set(normalized, remaining - 1);
            matched++;
            resultLines.push(line);
          }
        }

      }
    } catch (err) {
      console.error('Error in verifyChangeLines:', err);
      console.error('filePath:', filePath);
      console.error('mode:', this.verificationMode);
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
   * Split content into non-empty lines
   */
  private splitNonEmptyLines(content: string | undefined): string[] {
    if (!content) return [];
    return content.split(/\r?\n/).filter(line => line.length > 0);
  }

  /**
   * Get added lines from a change, falling back to content
   */
  private getAddedLines(change: FileChange): string[] {
    if (change.addedLines && change.addedLines.length > 0) {
      return change.addedLines;
    }
    if (change.content) {
      return this.splitNonEmptyLines(change.content);
    }
    return [];
  }

  /**
   * Get file creation time from history provider
   * Returns null if file is not tracked or error occurs
   */
  private getFileCreateTime(filePath: string): Date | null {
    return this.historyProvider.getFileCreateTime(filePath);
  }

  /**
   * Get file lines before a given timestamp (as a Set for comparison)
   * Returns null if file didn't exist or error occurs
   */
  private getFileLinesSetBeforeTimestamp(filePath: string, timestamp: Date): Set<string> | null {
    return this.historyProvider.getFileLinesSetBeforeTimestamp(filePath, timestamp);
  }
}

/**
 * Normalize a line for relaxed matching (collapse whitespace)
 * Optimized version using character traversal instead of regex
 */
export function normalizeLine(line: string): string {
  if (!line) return '';
  
  let res = '';
  let isSpace = false;
  let start = 0;
  const len = line.length;

  // Skip leading whitespace
  while (start < len) {
    const code = line.charCodeAt(start);
    // 32: space, 9: tab, 10: \n, 13: \r
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    start++;
  }

  if (start === len) return '';

  // Find end to skip trailing whitespace
  let end = len - 1;
  while (end > start) {
    const code = line.charCodeAt(end);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) break;
    end--;
  }

  for (let i = start; i <= end; i++) {
    const code = line.charCodeAt(i);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      if (!isSpace) {
        isSpace = true;
        res += ' ';
      }
    } else {
      isSpace = false;
      res += line[i];
    }
  }
  
  return res;
}

/**
 * Check if a line is empty or contains only whitespace
 * Optimized version using character traversal
 */
export function isLineEmptyOrWhitespace(line: string): boolean {
  if (!line || line.length === 0) return true;
  
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
      return false;
    }
  }
  return true;
}

/**
 * Get file creation time from git history
 * Returns null if file is not tracked or error occurs
 */
export function getFileCreateTime(projectPath: string, filePath: string): Date | null {
    try {
      const result = execFileSync(
        'git',
        ['log', '--diff-filter=A', '--format=%ai', '--', filePath],
        {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim();

      if (result) {
        const lines = result.split('\n');
        // Get the earliest creation time (first line)
        const firstLine = lines[0]?.trim();
        if (firstLine) {
          return new Date(firstLine);
        }
      }
    } catch {
      // File might not be tracked or other git error
    }
    return null;
}
