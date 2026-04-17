import * as fs from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
import { DEFAULT_IGNORES } from './config/ignore.js';
import {
  AISession,
  AITool,
  ContributionStats,
  FileChange,
  FileStats,
  ToolStats,
  VerificationMode,
  SessionType,
  SessionTypeStats,
} from './types.js';
import { BaseScanner } from './scanners/index.js';
import { ScannerManager } from './core/scanners.js';
import { GitAnalyzer } from './core/git.js';
import { ContributionVerifier, normalizeLine, getFileCreateTime, type RepoFileInfo, type VerifiedSession, type VerifiedChange, GitHistoryProvider } from './core/algorithmv.js';

/**
 * Main analyzer that coordinates all scanners and computes statistics
 */
export class ContributionAnalyzer {
  private projectPath: string;
  private scannerManager: ScannerManager;
  private verificationMode: VerificationMode;
  private targetDirectory?: string;
  private since?: Date;
  private ignores: Ignore;
  private historyProvider: GitHistoryProvider;
  private gitAnalyzer: GitAnalyzer;

  constructor(projectPath: string, verificationMode: VerificationMode = 'relaxed', targetDirectory?: string, since?: Date) {
    this.projectPath = path.resolve(projectPath);
    this.verificationMode = verificationMode;
    this.since = since;
    this.historyProvider = new GitHistoryProvider(this.projectPath);
    this.scannerManager = new ScannerManager();

    // Initialize ignores with defaults
    const ignoreFactory = (ignore as unknown as { default?: () => Ignore }).default
      ?? (ignore as unknown as () => Ignore);
    this.ignores = ignoreFactory();
    this.ignores.add(DEFAULT_IGNORES);

    this.gitAnalyzer = new GitAnalyzer(this.projectPath, this.ignores);
    // Resolve target directory to project-relative prefix to match GitAnalyzer semantics
    this.targetDirectory = targetDirectory ? this.gitAnalyzer.resolveTargetDirectory(this.normalizeDirectory(targetDirectory)) : undefined;
  }

  /**
   * Load .gitignore patterns
   */
  private loadGitignore(): void {
    const gitignorePath = path.join(this.projectPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
      try {
        const content = fs.readFileSync(gitignorePath, 'utf-8');
        this.ignores.add(content);
      } catch {
        // Ignore read errors
      }
    }
  }

  /**
   * Normalize directory path (remove leading/trailing slashes, convert to forward slashes)
   */
  private normalizeDirectory(dir: string): string {
    return dir.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  }

  /**
   * Get list of available AI tools
   */
  getAvailableTools(): AITool[] {
    return this.scannerManager.getAvailableTools();
  }

  /**
   * Scan all sessions from all tools
   */
  scanAllSessions(tools?: AITool[]): AISession[] {
    return this.scannerManager.scanAllSessions(this.projectPath, tools, this.since);
  }

  /**
   * Analyze the repository and compute contribution statistics
   */
  analyze(tools?: AITool[], onProgress?: (filePath: string) => void): ContributionStats {
    this.loadGitignore();
    const sessions = this.scanAllSessions(tools);

    // Filter session changes by target directory if specified
    if (this.targetDirectory !== undefined && this.targetDirectory !== '') {
      const prefix = this.targetDirectory + '/';
      for (const session of sessions) {
        session.changes = session.changes.filter(change =>
          change.filePath.startsWith(prefix) || change.filePath.startsWith('/' + prefix)
        );
        // Recalculate session totals
        session.totalFilesChanged = new Set(session.changes.map(c => c.filePath)).size;
        session.totalLinesAdded = session.changes.reduce((sum, c) => sum + c.linesAdded, 0);
        session.totalLinesRemoved = session.changes.reduce((sum, c) => sum + c.linesRemoved, 0);
      }
    }

    // Calculate raw statistics before verification
    const rawStats = this.calculateRawStats(sessions);

    // Get repository file stats
    const allRepoFiles = this.gitAnalyzer.getRepoFiles(this.targetDirectory);
    let repoFiles = [...allRepoFiles];

    // Calculate project total lines (regardless of --since)
    // We do this by building a lightweight index for all files if needed
    let projectTotalLines = 0;
    
    // If we're filtering by --since, we need to calculate the full project stats separately
    if (this.since) {
      // Create a temporary index for all files just to count lines
      // We pass empty set for filesNeedingLineSet to avoid expensive line processing
      const fullRepoIndex = this.buildRepoFileIndex(allRepoFiles, undefined);
      projectTotalLines = this.sumRepoLines(fullRepoIndex);

      const touchedFiles = new Set<string>();
      for (const session of sessions) {
        for (const change of session.changes) {
          touchedFiles.add(change.filePath);
        }
      }
      // Only keep files that were actually touched in the filtered sessions
      repoFiles = repoFiles.filter(file => touchedFiles.has(file));
    } else {
      // If not filtering, we'll calculate total lines later from the main index
    }

    const repoFileSet = new Set(repoFiles);
    const filesNeedingLineSet = this.verificationMode === 'historical'
      ? undefined
      : new Set<string>();

    for (const session of sessions) {
      for (const change of session.changes) {
        if (filesNeedingLineSet && repoFileSet.has(change.filePath)) {
          filesNeedingLineSet.add(change.filePath);
        }
      }
    }

    const repoFileIndex = this.buildRepoFileIndex(repoFiles, filesNeedingLineSet, onProgress);
    const totalLines = this.sumRepoLines(repoFileIndex);

    // If projectTotalLines wasn't calculated earlier (because no filter), use totalLines
    if (!this.since) {
      projectTotalLines = totalLines;
    }

    // Pre-verify all changes with deduplication
    const verifier = new ContributionVerifier(this.projectPath, this.verificationMode, this.historyProvider);
    const verifiedSessions = verifier.verifySessions(sessions, repoFileIndex);

    // Compute statistics from verified data
    const byTool = this.computeToolStats(verifiedSessions);
    const byFile = this.computeFileStats(verifiedSessions, repoFileIndex);

    // Count AI-touched files and lines (only count files that exist in repo)
    let aiTouchedFiles = 0;
    let aiContributedLines = 0;
    const aiContributedContent = new Map<string, string[]>();

    for (const [filePath, stats] of byFile) {
      // Only count files that exist in the repo
      if (stats.aiContributedLines > 0 && repoFiles.includes(filePath)) {
        aiTouchedFiles++;
        // Cap contribution at actual file lines to avoid >100%
        aiContributedLines += Math.min(stats.aiContributedLines, stats.totalLines);
      }
    }

    // Collect verified content
    for (const vs of verifiedSessions) {
      for (const contrib of vs.contributions) {
        if (contrib.verifiedContent && contrib.verifiedContent.length > 0) {
          const filePath = contrib.change.filePath;
          const current = aiContributedContent.get(filePath) || [];
          aiContributedContent.set(filePath, current.concat(contrib.verifiedContent));
        }
      }
    }

    // Get project changes for potential scaling
    const projectChanges = this.since ? this.gitAnalyzer.getProjectChanges(this.since, this.targetDirectory) : undefined;

    // ============================================================================
    // TODO [临时代码 - 删除标记 1/2]: AI 贡献上限截断逻辑调用
    // 预期在 1-2 个迭代内完成根因修复后删除此段代码
    // 对应的函数定义见下方 applyContributionCapping() 方法（删除标记 2/2）
    // ============================================================================
    if (projectChanges && projectChanges.linesAdded > 0) {
      const result = this.applyContributionCapping(projectChanges, byFile, byTool, repoFiles);
      aiTouchedFiles = result.aiTouchedFiles;
      aiContributedLines = result.aiContributedLines;
    }
    // ============================================================================
    // TODO [临时代码 - 删除标记 1/2 结束]
    // ============================================================================

    const gitInfo = this.gitAnalyzer.getGitInfo();

    return {
      repoPath: this.projectPath,
      repoUrl: this.gitAnalyzer.getRepoUrl(),
      gitBranch: gitInfo.branch,
      gitUsername: gitInfo.username,
      gitEmail: gitInfo.email,
      scanTime: new Date(),
      verificationMode: this.verificationMode,
      targetDirectory: this.targetDirectory,
      totalFiles: repoFiles.length,
      totalLines,
      projectTotalFiles: allRepoFiles.length,
      projectTotalLines,
      aiTouchedFiles,
      aiContributedLines,
      aiContributedContent,
      sessions: verifiedSessions.map(vs => {
        // Update session totals with verified values
        const session = vs.session;
        if (vs.contributions.length > 0) {
          session.totalLinesAdded = vs.contributions.reduce((sum, c) => sum + c.verifiedLinesAdded, 0);
          session.totalLinesRemoved = vs.contributions.reduce((sum, c) => sum + c.change.linesRemoved, 0);
          session.totalFilesChanged = new Set(vs.contributions.map(c => c.change.filePath)).size;
        } else if (session.tool !== AITool.TRAE) {
          session.totalLinesAdded = 0;
          session.totalLinesRemoved = 0;
          session.totalFilesChanged = 0;
        }
        return session;
      }),
      byTool,
      byFile,
      rawStats,
      sessionTypeStats: this.computeSessionTypeStats(sessions),
      projectChanges,
    };
  }

  // ============================================================================
  // TODO [临时代码 - 删除标记 2/2]: AI 贡献上限截断逻辑函数定义
  // 预期在 1-2 个迭代内完成根因修复后删除整个 applyContributionCapping() 方法
  // 对应的调用点见上方 analyze() 方法中（删除标记 1/2）
  // ============================================================================
  /**
   * TODO [短期止血方案]: AI 贡献上限截断逻辑
   *
   * 这是一个临时修正方案，用于防止 AI 贡献行数超过 Git 统计新增行数导致的 >100% 异常值
   * 根本原因是 Scanner 在全文件重写、基线缺失等场景下会过度上报 addedLines
   * 长期方案应该是修复 Scanner 的过度计算问题（见 docs/git-first-architecture.md）
   *
   * 优化策略：
   * 1. 先在文件级别截断：每个文件的 AI 贡献不超过该文件的 Git 新增行数
   * 2. 再在全局级别截断：总 AI 贡献不超过 Git 总新增行数
   *
   * 预期在 1-2 个迭代内完成根因修复后移除此方法
   *
   * @param projectChanges Git 统计的项目变更信息
   * @param byFile 文件级别的统计数据（会被修改）
   * @param byTool 工具级别的统计数据（会被修改）
   * @param repoFiles 仓库中的文件列表
   * @returns 重新计算后的全局 AI 贡献统计
   */
  private applyContributionCapping(
    projectChanges: { linesAdded: number; fileStats: Map<string, { added: number }> },
    byFile: Map<string, FileStats>,
    byTool: Map<AITool, ToolStats>,
    repoFiles: string[]
  ): { aiTouchedFiles: number; aiContributedLines: number } {
    // 步骤 1: 文件级别截断
    // 对于每个文件，如果 AI 贡献 > Git 新增，则截断为 Git 新增
    const fileScaleMap = new Map<string, number>(); // 记录每个文件的缩放比例

    for (const [filePath, fileStats] of byFile) {
      if (fileStats.aiContributedLines > 0) {
        const gitFileStats = projectChanges.fileStats.get(filePath);
        if (gitFileStats && gitFileStats.added > 0) {
          // 该文件在 Git 中有新增行数
          if (fileStats.aiContributedLines > gitFileStats.added) {
            // AI 贡献超过了 Git 新增，需要截断
            const fileScale = gitFileStats.added / fileStats.aiContributedLines;
            fileScaleMap.set(filePath, fileScale);

            if (process.env.DEBUG) {
              console.warn(`⚠️  文件 ${filePath} 的 AI 贡献被截断:`);
              console.warn(`   原始 AI 贡献: ${fileStats.aiContributedLines} 行`);
              console.warn(`   Git 新增: ${gitFileStats.added} 行`);
              console.warn(`   截断比例: ${fileScale.toFixed(3)}`);
            }

            fileStats.aiContributedLines = gitFileStats.added;

            // 重新计算比例
            if (fileStats.totalLines > 0) {
              fileStats.aiContributionRatio = Math.min(
                fileStats.aiContributedLines / fileStats.totalLines,
                1.0
              );
            }
          }
        }
      }
    }

    // 步骤 2: 如果有文件被截断，需要重新计算 byTool 和 byModel
    if (fileScaleMap.size > 0) {
      // 保存原始的模型比例（在清零之前）
      const modelRatios = new Map<AITool, Map<string, number>>();
      for (const [tool, toolStats] of byTool) {
        const toolTotal = toolStats.linesAdded;
        if (toolTotal > 0) {
          const ratios = new Map<string, number>();
          for (const [modelName, modelStats] of toolStats.byModel) {
            ratios.set(modelName, modelStats.linesAdded / toolTotal);
          }
          modelRatios.set(tool, ratios);
        }
      }

      // 重新计算 byTool 统计（基于截断后的 byFile）
      // 清空 linesAdded，重新从 byFile 累加
      for (const [, toolStats] of byTool) {
        toolStats.linesAdded = 0;
        for (const [, modelStats] of toolStats.byModel) {
          modelStats.linesAdded = 0;
        }
      }

      // 从 byFile 重新累加（使用截断后的值）
      for (const [, fileStats] of byFile) {
        if (fileStats.aiContributedLines > 0) {
          // 按比例分配到各个工具
          const toolEntries = Array.from(fileStats.contributions.entries());
          const totalFileContribution = toolEntries.reduce((sum, [, c]) => sum + c, 0);
          let remainingLinesInFile = fileStats.aiContributedLines;

          for (let i = 0; i < toolEntries.length; i++) {
            const [tool, toolContribution] = toolEntries[i];
            const toolStats = byTool.get(tool);

            if (toolStats) {
              if (i === toolEntries.length - 1) {
                // 最后一个工具：分配剩余的所有行数
                toolStats.linesAdded += remainingLinesInFile;
              } else {
                // 其他工具：按比例分配
                const toolRatio = totalFileContribution > 0 ? toolContribution / totalFileContribution : 0;
                const toolLinesInFile = Math.floor(fileStats.aiContributedLines * toolRatio);
                toolStats.linesAdded += toolLinesInFile;
                remainingLinesInFile -= toolLinesInFile;
              }
            }
          }
        }
      }

      // 重新计算 netLines 和 byModel
      for (const [tool, toolStats] of byTool) {
        toolStats.netLines = toolStats.linesAdded - toolStats.linesRemoved;

        // 使用保存的原始比例重新分配 byModel
        const ratios = modelRatios.get(tool);
        if (ratios && ratios.size > 0 && toolStats.linesAdded > 0) {
          const modelEntries = Array.from(toolStats.byModel.entries());
          let remainingLines = toolStats.linesAdded;

          // 按比例分配，最后一个模型分配剩余的所有行数（避免精度损失）
          for (let i = 0; i < modelEntries.length; i++) {
            const [modelName, modelStats] = modelEntries[i];
            const ratio = ratios.get(modelName) || 0;

            if (i === modelEntries.length - 1) {
              // 最后一个模型：分配剩余的所有行数
              modelStats.linesAdded = remainingLines;
            } else {
              // 其他模型：按比例分配
              const allocatedLines = Math.floor(toolStats.linesAdded * ratio);
              modelStats.linesAdded = allocatedLines;
              remainingLines -= allocatedLines;
            }

            modelStats.netLines = modelStats.linesAdded - modelStats.linesRemoved;
          }
        }
      }

      if (process.env.DEBUG) {
        console.warn(`⚠️  文件级截断后重新计算了 byTool 统计`);
      }
    }

    // 步骤 3: 重新汇总全局 AI 贡献
    let aiTouchedFiles = 0;
    let aiContributedLines = 0;
    for (const [filePath, fileStats] of byFile) {
      if (fileStats.aiContributedLines > 0 && repoFiles.includes(filePath)) {
        aiTouchedFiles++;
        aiContributedLines += Math.min(fileStats.aiContributedLines, fileStats.totalLines);
      }
    }

    // 步骤 4: 全局级别截断（如果文件级截断后仍然超标）
    if (aiContributedLines > projectChanges.linesAdded) {
      const globalScale = projectChanges.linesAdded / aiContributedLines;

      if (process.env.DEBUG) {
        console.warn(`⚠️  全局 AI 贡献被缩放了 ${((1 - globalScale) * 100).toFixed(1)}%`);
        console.warn(`   原始 AI 贡献: ${aiContributedLines} 行`);
        console.warn(`   Git 新增代码: ${projectChanges.linesAdded} 行`);
        console.warn(`   缩放比例: ${globalScale.toFixed(3)}`);
      }

      // 4.1 缩放 byFile 层级
      for (const [, fileStats] of byFile) {
        if (fileStats.aiContributedLines > 0) {
          const originalLines = fileStats.aiContributedLines;
          fileStats.aiContributedLines = Math.max(1, Math.floor(originalLines * globalScale));

          // 重新计算比例，确保不超过 100%
          if (fileStats.totalLines > 0) {
            fileStats.aiContributionRatio = Math.min(
              fileStats.aiContributedLines / fileStats.totalLines,
              1.0
            );
          }
        }
      }

      // 4.2 缩放 byTool 层级
      for (const [, toolStats] of byTool) {
        if (toolStats.linesAdded > 0) {
          const originalToolLines = toolStats.linesAdded;
          toolStats.linesAdded = Math.max(1, Math.floor(toolStats.linesAdded * globalScale));
          toolStats.netLines = toolStats.linesAdded - toolStats.linesRemoved;

          // 4.3 缩放 byModel 层级（确保总和一致）
          const modelEntries = Array.from(toolStats.byModel.entries());
          if (modelEntries.length > 0) {
            let remainingLines = toolStats.linesAdded;

            // 按比例分配，最后一个模型分配剩余的所有行数
            for (let i = 0; i < modelEntries.length; i++) {
              const [, modelStats] = modelEntries[i];

              if (modelStats.linesAdded > 0) {
                if (i === modelEntries.length - 1) {
                  // 最后一个模型：分配剩余的所有行数
                  modelStats.linesAdded = Math.max(1, remainingLines);
                } else {
                  // 其他模型：按比例分配
                  const modelRatio = modelStats.linesAdded / originalToolLines;
                  const allocatedLines = Math.max(1, Math.floor(toolStats.linesAdded * modelRatio));
                  modelStats.linesAdded = allocatedLines;
                  remainingLines -= allocatedLines;
                }

                modelStats.netLines = modelStats.linesAdded - modelStats.linesRemoved;
              }
            }
          }
        }
      }

      // 4.4 重新汇总全局指标
      aiTouchedFiles = 0;
      aiContributedLines = 0;
      for (const [filePath, fileStats] of byFile) {
        if (fileStats.aiContributedLines > 0 && repoFiles.includes(filePath)) {
          aiTouchedFiles++;
          aiContributedLines += Math.min(fileStats.aiContributedLines, fileStats.totalLines);
        }
      }

      // 4.5 最终兜底：确保不超过 Git 统计值
      if (aiContributedLines > projectChanges.linesAdded) {
        aiContributedLines = projectChanges.linesAdded;
      }
    }

    return { aiTouchedFiles, aiContributedLines };
  }
  // ============================================================================
  // TODO [临时代码 - 删除标记 2/2 结束]
  // ============================================================================

  /**
   * 扫描并验证会话，供按会话导出 Markdown 等场景使用（不构建完整 ContributionStats）
   */
  getVerifiedSessions(tools?: AITool[], onProgress?: (filePath: string) => void): VerifiedSession[] {
    this.loadGitignore();
    const sessions = this.scanAllSessions(tools);

    if (this.targetDirectory !== undefined && this.targetDirectory !== '') {
      const prefix = this.targetDirectory + '/';
      for (const session of sessions) {
        session.changes = session.changes.filter(change =>
          change.filePath.startsWith(prefix) || change.filePath.startsWith('/' + prefix)
        );
        session.totalFilesChanged = new Set(session.changes.map(c => c.filePath)).size;
        session.totalLinesAdded = session.changes.reduce((sum, c) => sum + c.linesAdded, 0);
        session.totalLinesRemoved = session.changes.reduce((sum, c) => sum + c.linesRemoved, 0);
      }
    }

    const allRepoFiles = this.gitAnalyzer.getRepoFiles(this.targetDirectory);
    let repoFiles = [...allRepoFiles];

    if (this.since) {
      const touchedFiles = new Set<string>();
      for (const session of sessions) {
        for (const change of session.changes) {
          touchedFiles.add(change.filePath);
        }
      }
      repoFiles = repoFiles.filter(file => touchedFiles.has(file));
    }

    const repoFileSet = new Set(repoFiles);
    const filesNeedingLineSet = this.verificationMode === 'historical'
      ? undefined
      : new Set<string>();

    for (const session of sessions) {
      for (const change of session.changes) {
        if (filesNeedingLineSet && repoFileSet.has(change.filePath)) {
          filesNeedingLineSet.add(change.filePath);
        }
      }
    }

    const repoFileIndex = this.buildRepoFileIndex(repoFiles, filesNeedingLineSet, onProgress);
    const verifier = new ContributionVerifier(this.projectPath, this.verificationMode, this.historyProvider);
    return verifier.verifySessions(sessions, repoFileIndex);
  }

  /**
   * Compute session type statistics for all sessions
   */
  private computeSessionTypeStats(allSessions: AISession[]): Map<SessionType, SessionTypeStats> {
    const typeStats = new Map<SessionType, SessionTypeStats>();

    for (const session of allSessions) {
      // Determine session type if not already set
      const sessionType = session.sessionType || this.classifySession(session);

      if (!typeStats.has(sessionType)) {
        typeStats.set(sessionType, {
          type: sessionType,
          count: 0,
          sessions: [],
          byTool: new Map<AITool, number>(),
        });
      }

      const stats = typeStats.get(sessionType)!;
      stats.count++;
      stats.sessions.push(session);

      const toolCount = stats.byTool.get(session.tool) || 0;
      stats.byTool.set(session.tool, toolCount + 1);
    }

    return typeStats;
  }

  /**
   * Classify a session based on its operations
   */
  private classifySession(session: AISession): SessionType {
    // If session has operations info, use it
    if (session.operations) {
      return BaseScanner.classifySessionFromOps(session.operations);
    }

    // Otherwise, infer from changes
    if (session.changes.length > 0 && (session.totalLinesAdded > 0 || session.totalLinesRemoved > 0)) {
      return 'code_contribution';
    }

    // Default to analysis if we can't determine
    return 'analysis';
  }

  /**
   * Calculate raw statistics before verification
   */
  private calculateRawStats(sessions: AISession[]): { sessionsCount: number; totalFiles: number; linesAdded: number; linesRemoved: number } {
    const allFiles = new Set<string>();
    let linesAdded = 0;
    let linesRemoved = 0;

    for (const session of sessions) {
      for (const change of session.changes) {
        allFiles.add(change.filePath);
        linesAdded += change.linesAdded;
        linesRemoved += change.linesRemoved;
      }
    }

    return {
      sessionsCount: sessions.length,
      totalFiles: allFiles.size,
      linesAdded,
      linesRemoved,
    };
  }


  /**
   * Build a file index for verification and totals
   */
  private buildRepoFileIndex(
    files: string[],
    filesNeedingLineSet?: Set<string>,
    onProgress?: (filePath: string) => void
  ): Map<string, RepoFileInfo> {
    const index = new Map<string, RepoFileInfo>();
    const emptyLineSet = new Set<string>();
    const emptyNormalizedLineSet = new Set<string>();
    const emptyLineCounts = new Map<string, number>();
    const emptyNormalizedLineCounts = new Map<string, number>();

    for (const file of files) {
      if (onProgress) {
        onProgress(this.formatDisplayPath(file));
      }
      try {
        const content = fs.readFileSync(path.join(this.projectPath, file), 'utf-8');
        const normalizedLines = content.split(/\r?\n/);
        const totalLines = normalizedLines.length;
        let nonEmptyLines = 0;
        const buildLineSet = filesNeedingLineSet?.has(file) ?? false;
        const buildNormalizedLineSet = buildLineSet && this.verificationMode === 'relaxed';
        const lineSet = buildLineSet ? new Set<string>() : emptyLineSet;
        const normalizedLineSet = buildNormalizedLineSet ? new Set<string>() : emptyNormalizedLineSet;
        const lineCounts = buildLineSet ? new Map<string, number>() : emptyLineCounts;
        const normalizedLineCounts = buildNormalizedLineSet ? new Map<string, number>() : emptyNormalizedLineCounts;

        for (const line of normalizedLines) {
          if (line.length === 0) continue;
          nonEmptyLines++;
          if (buildLineSet) {
            lineSet.add(line);
            lineCounts.set(line, (lineCounts.get(line) || 0) + 1);
          }
          if (buildNormalizedLineSet) {
            const normalized = normalizeLine(line);
            if (normalized.length > 0) {
              normalizedLineSet.add(normalized);
              normalizedLineCounts.set(normalized, (normalizedLineCounts.get(normalized) || 0) + 1);
            }
          }
        }

        index.set(file, { totalLines, nonEmptyLines, lineSet, normalizedLineSet, lineCounts, normalizedLineCounts });
      } catch {
        index.set(file, {
          totalLines: 0,
          nonEmptyLines: 0,
          lineSet: emptyLineSet,
          normalizedLineSet: emptyNormalizedLineSet,
          lineCounts: emptyLineCounts,
          normalizedLineCounts: emptyNormalizedLineCounts,
        });
      }
    }

    return index;
  }

  /**
   * Format a repo-relative path for display (include repo name).
   */
  private formatDisplayPath(repoRelativePath: string): string {
    const fullPath = path.join(this.projectPath, repoRelativePath);
    const displayPath = path.relative(path.dirname(this.projectPath), fullPath);
    return displayPath.replace(/\\/g, '/');
  }

  /**
   * Sum total lines from the repository index
   */
  private sumRepoLines(repoFileIndex: Map<string, RepoFileInfo>): number {
    let total = 0;
    for (const info of repoFileIndex.values()) {
      total += info.nonEmptyLines;
    }
    return total;
  }



  /**
   * Compute statistics by AI tool from verified sessions
   */
  private computeToolStats(verifiedSessions: VerifiedSession[]): Map<AITool, ToolStats> {
    const stats = new Map<AITool, ToolStats>();
    const filesByTool = new Map<AITool, Set<string>>();
    const filesByModel = new Map<string, Set<string>>();

    for (const { session, contributions } of verifiedSessions) {
      // Handle Trae sessions without verified contributions
      if (contributions.length === 0 && session.tool === AITool.TRAE) {
        let toolStats = stats.get(session.tool);
        if (!toolStats) {
          toolStats = {
            tool: session.tool,
            sessionsCount: 0,
            filesCreated: 0,
            filesModified: 0,
            totalFiles: 0,
            linesAdded: 0,
            linesRemoved: 0,
            netLines: 0,
            byModel: new Map(),
          };
          stats.set(session.tool, toolStats);
          filesByTool.set(session.tool, new Set());
        }
        toolStats.sessionsCount++;

        const modelName = session.model || 'unknown';
        let modelStats = toolStats.byModel.get(modelName);
        if (!modelStats) {
          modelStats = {
            model: modelName,
            sessionsCount: 0,
            filesCreated: 0,
            filesModified: 0,
            totalFiles: 0,
            linesAdded: 0,
            linesRemoved: 0,
            netLines: 0,
          };
          toolStats.byModel.set(modelName, modelStats);
          filesByModel.set(`${session.tool}:${modelName}`, new Set());
        }
        modelStats.sessionsCount++;
        continue;
      }

      let toolStats = stats.get(session.tool);
      if (!toolStats) {
        toolStats = {
          tool: session.tool,
          sessionsCount: 0,
          filesCreated: 0,
          filesModified: 0,
          totalFiles: 0,
          linesAdded: 0,
          linesRemoved: 0,
          netLines: 0,
          byModel: new Map(),
        };
        stats.set(session.tool, toolStats);
        filesByTool.set(session.tool, new Set());
      }

      toolStats.sessionsCount++;
      const toolFiles = filesByTool.get(session.tool)!;
      const modelsInSession = new Set<string>();

      for (const { change, verifiedLinesAdded, modelName } of contributions) {
        toolFiles.add(change.filePath);
        toolStats.linesAdded += verifiedLinesAdded;
        toolStats.linesRemoved += change.linesRemoved;

        if (change.changeType === 'create') {
          toolStats.filesCreated++;
        } else {
          toolStats.filesModified++;
        }

        modelsInSession.add(modelName);

        // Aggregate by model
        let modelStats = toolStats.byModel.get(modelName);
        if (!modelStats) {
          modelStats = {
            model: modelName,
            sessionsCount: 0,
            filesCreated: 0,
            filesModified: 0,
            totalFiles: 0,
            linesAdded: 0,
            linesRemoved: 0,
            netLines: 0,
          };
          toolStats.byModel.set(modelName, modelStats);
          filesByModel.set(`${session.tool}:${modelName}`, new Set());
        }

        const modelFiles = filesByModel.get(`${session.tool}:${modelName}`)!;
        modelFiles.add(change.filePath);
        modelStats.linesAdded += verifiedLinesAdded;
        modelStats.linesRemoved += change.linesRemoved;

        if (change.changeType === 'create') {
          modelStats.filesCreated++;
        } else {
          modelStats.filesModified++;
        }
      }

      for (const modelName of modelsInSession) {
        const modelStats = toolStats.byModel.get(modelName);
        if (modelStats) {
          modelStats.sessionsCount++;
        }
      }
    }

    // Update totalFiles with unique count
    for (const [tool, toolStats] of stats) {
      toolStats.totalFiles = filesByTool.get(tool)?.size || 0;
      toolStats.netLines = toolStats.linesAdded - toolStats.linesRemoved;

      for (const [modelName, modelStats] of toolStats.byModel) {
        modelStats.totalFiles = filesByModel.get(`${tool}:${modelName}`)?.size || 0;
        modelStats.netLines = modelStats.linesAdded - modelStats.linesRemoved;
      }
    }

    return stats;
  }

  /**
   * Compute statistics by file from verified sessions
   */
  private computeFileStats(
    verifiedSessions: VerifiedSession[],
    repoFileIndex: Map<string, RepoFileInfo>
  ): Map<string, FileStats> {
    const stats = new Map<string, FileStats>();

    // Track sessions per file (for session count)
    const sessionsPerFile = new Map<string, Set<string>>();

    // Initialize stats for all repo files
    for (const [file, info] of repoFileIndex) {
      stats.set(file, {
        filePath: file,
        totalLines: info.nonEmptyLines,
        aiContributedLines: 0,
        aiContributionRatio: 0,
        contributions: new Map(),
        sessionCount: 0,
        fileCreateTime: getFileCreateTime(this.projectPath, file),
        contributionType: 'unknown',
      });
    }

    // Accumulate verified AI contributions
    for (const { session, contributions } of verifiedSessions) {
      for (const { change, verifiedLinesAdded } of contributions) {
        let fileStats = stats.get(change.filePath);

        if (!fileStats) {
          fileStats = {
            filePath: change.filePath,
            totalLines: 0,
            aiContributedLines: 0,
            aiContributionRatio: 0,
            contributions: new Map(),
            sessionCount: 0,
            fileCreateTime: getFileCreateTime(this.projectPath, change.filePath),
            contributionType: 'unknown',
          };
          stats.set(change.filePath, fileStats);
        }

        fileStats.aiContributedLines += verifiedLinesAdded;

        // Track unique sessions per file
        if (!sessionsPerFile.has(change.filePath)) {
          sessionsPerFile.set(change.filePath, new Set());
        }
        sessionsPerFile.get(change.filePath)!.add(session.id);

        // Determine contribution type based on file creation time vs AI session time
        if (fileStats.fileCreateTime && session.timestamp) {
          // Allow 1 minute buffer for clock skew
          const creationTimeWithBuffer = new Date(fileStats.fileCreateTime.getTime() + 60000);
          
          if (session.timestamp <= creationTimeWithBuffer) {
            // If any session happened at or before file creation, it's an AI creation
            fileStats.contributionType = 'create';
          } else if (fileStats.contributionType !== 'create') {
            // Only mark as enhance if we haven't already identified it as a creation
            fileStats.contributionType = 'enhance';
          }
        } else if (fileStats.contributionType === 'unknown') {
          // Fallback: if no git history, assume create if it's a new file in session
          // This will be refined later based on ratio if still unknown
          if (change.changeType === 'create') {
            fileStats.contributionType = 'create';
          }
        }

        const currentToolContrib = fileStats.contributions.get(session.tool) || 0;
        fileStats.contributions.set(session.tool, currentToolContrib + verifiedLinesAdded);
      }
    }

    // Set session counts
    for (const [filePath, sessionSet] of sessionsPerFile) {
      const fileStats = stats.get(filePath);
      if (fileStats) {
        fileStats.sessionCount = sessionSet.size;
      }
    }

    // Calculate ratios - cap at 100%
    // TODO [短期止血]: 确保单文件级别的 AI 贡献比例不超过 100%
    // 这里处理两种异常情况：
    // 1. aiContributedLines > totalLines（Scanner 过度上报）
    // 2. totalLines = 0 但 aiContributedLines > 0（文件已删除或不在 repo 中）
    for (const [, fileStats] of stats) {
      if (fileStats.totalLines > 0) {
        // 先截断 AI 贡献行数，不能超过文件总行数
        fileStats.aiContributedLines = Math.min(fileStats.aiContributedLines, fileStats.totalLines);
        // 再计算比例，确保不超过 100%
        fileStats.aiContributionRatio = Math.min(
          fileStats.aiContributedLines / fileStats.totalLines,
          1.0
        );
      } else if (fileStats.aiContributedLines > 0) {
        // 文件总行数为 0 但有 AI 贡献（文件已删除或不存在）
        // 将比例设为 0，避免除以 0 或显示异常值
        fileStats.aiContributionRatio = 0;
      }

      // Finalize contribution type for files without git history
      // If file is 100% AI contributed and type is still unknown, mark as 'create'
      if (fileStats.contributionType === 'unknown' && fileStats.aiContributionRatio >= 1.0) {
        fileStats.contributionType = 'create';
      } else if (fileStats.contributionType === 'unknown' && fileStats.aiContributedLines > 0) {
        fileStats.contributionType = 'enhance';
      }
    }

    return stats;
  }
}
