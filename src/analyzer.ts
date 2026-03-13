import * as fs from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
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
    this.targetDirectory = targetDirectory ? this.normalizeDirectory(targetDirectory) : undefined;
    this.since = since;
    this.historyProvider = new GitHistoryProvider(this.projectPath);
    this.scannerManager = new ScannerManager();

    // Initialize ignores with defaults
    const ignoreFactory = (ignore as unknown as { default?: () => Ignore }).default
      ?? (ignore as unknown as () => Ignore);
    this.ignores = ignoreFactory();
    this.ignores.add([
      '.git',
      'node_modules',
      'dist',
      'build',
      'coverage',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      '**/*.pyc',
      '__pycache__',
      '.DS_Store',
      '.next',
      '.nuxt',
      '.venv',
      '*.iml',
      '.idea',
      'target',
      '*.log',
      'venv',
      // Documentation files
      '**/*.md',
      '**/*.mdx',
      '**/*.txt',
      '**/*.rst'
    ]);

    this.gitAnalyzer = new GitAnalyzer(this.projectPath, this.ignores);
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
    if (this.targetDirectory) {
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

    return {
      repoPath: this.projectPath,
      repoUrl: this.gitAnalyzer.getRepoUrl(),
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
      projectChanges: this.since ? this.gitAnalyzer.getProjectChanges(this.since, this.targetDirectory) : undefined,
    };
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
    for (const [, fileStats] of stats) {
      if (fileStats.totalLines > 0) {
        fileStats.aiContributedLines = Math.min(fileStats.aiContributedLines, fileStats.totalLines);
        fileStats.aiContributionRatio = Math.min(
          fileStats.aiContributedLines / fileStats.totalLines,
          1.0
        );
      } else if (fileStats.aiContributedLines > 0) {
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
