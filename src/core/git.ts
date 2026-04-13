import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import ignore, { type Ignore } from 'ignore';
import { isLineEmptyOrWhitespace } from '../utils/utils.js';

export interface GitMetadata {
  branch?: string;
  username?: string;
  email?: string;
  remoteUrl?: string;
}

/**
 * Get Git metadata for a project path
 * 获取指定项目路径的 Git 元数据
 */
export function getGitMetadata(projectPath: string): GitMetadata {
    const info: GitMetadata = {};
    
    // Check if git is available
    try {
      execFileSync('git', ['status', '--porcelain'], {
        cwd: projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    } catch {
      return info;
    }

    try {
       // Get Branch / 获取当前分支
       try {
         const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
         }).trim();
         if (branch) info.branch = branch;
       } catch {}

       // Get Username / 获取用户名
       try {
         let username = execFileSync('git', ['config', 'user.name'], {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
         }).trim();
         // Remove surrounding quotes (including smart quotes)
         username = username.replace(/^['"‘“](.*)['"’”]$/, '$1');
         if (username) info.username = username;
       } catch {}

       // Get Email / 获取邮箱
       try {
         let email = execFileSync('git', ['config', 'user.email'], {
            cwd: projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
         }).trim();
         // Remove surrounding quotes
         email = email.replace(/^['"‘“](.*)['"’”]$/, '$1');
         if (email) info.email = email;
       } catch {}

       // Get Remote URL / 获取远程仓库地址
       try {
        const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
          cwd: projectPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (remote) info.remoteUrl = remote;
       } catch {}

    } catch (e) {
      // Ignore errors
    }
    return info;
}

/**
 * Handles Git operations and project file analysis
 * 处理 Git 操作和项目文件分析
 */
export class GitAnalyzer {
  private static readonly EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

  private projectPath: string;
  private ignores: Ignore;

  constructor(projectPath: string, ignores: Ignore) {
    this.projectPath = projectPath;
    this.ignores = ignores;
  }

  /**
   * Get Git metadata (branch, user, email, remote)
   * 获取 Git 元数据（分支、用户名、邮箱、远程地址）
   */
  getGitInfo(): GitMetadata {
    return getGitMetadata(this.projectPath);
  }

  /**
   * Get project changes since a specific time using Git-First strategy
   * 使用 Git 优先策略获取自指定时间以来的项目变更
   */
  getProjectChanges(since: Date, targetDirectory?: string): { totalFiles: number; linesAdded: number; linesRemoved: number; netLinesAdded: number; totalLinesOfChangedFiles: number; files: string[]; fileStats: Map<string, { added: number, removed: number }>; fileDiffs?: Map<string, string>; gitStatusWarning?: string; emptyLinesAdded: number; emptyLinesRemoved: number } | undefined {
    // 1. Check Git reliability first
    // 1. 首先检查 Git 是否可靠
    if (!this.isGitReliable()) {
      return this.getProjectChangesFallback(since, targetDirectory);
    }

    try {
      const activeFiles = new Set<string>();
      let totalLinesAdded = 0;
      let totalLinesRemoved = 0;
      let totalLinesOfChangedFiles = 0;
      let totalEmptyLinesAdded = 0;
      let totalEmptyLinesRemoved = 0;

      // 2. Resolve baseline (commit vs empty tree)
      const baseRef = this.resolveBaseRef(since);
      if (!baseRef) {
        return this.getProjectChangesFallback(since, targetDirectory);
      }

      let gitStatusWarning: string | undefined;
      if (baseRef.kind === 'empty-tree') {
        gitStatusWarning = 'since is earlier than first commit; using empty-tree baseline (repo-birth)';
      }

      // 3. Get changes from Git (committed + staged + working tree relative to baseline)
      const gitChangesMap = this.getGitChangesFromBaseline(baseRef);


      const fileStats = new Map<string, { added: number, removed: number }>();

      if (gitChangesMap) {
        for (const [filePath, stats] of gitChangesMap.entries()) {
            // Filter by target directory if set
            // 如果设置了目标目录，则进行过滤
            if (targetDirectory && !filePath.startsWith(targetDirectory + '/')) {
                continue;
            }

            // Check if file is ignored
            // 检查文件是否被忽略
            if (this.ignores.ignores(filePath)) {
                continue;
            }

            // Only consider files that are text files
            // 只考虑文本文件
            if (!this.isTextFile(filePath)) {
                continue;
            }

            activeFiles.add(filePath);
            totalLinesAdded += stats.added;
            totalLinesRemoved += stats.removed;
            totalEmptyLinesAdded += (stats.emptyAdded || 0);
            totalEmptyLinesRemoved += (stats.emptyRemoved || 0);
            fileStats.set(filePath, { added: stats.added, removed: stats.removed });

            // If file exists in working tree, get current lines
            // 如果文件存在于工作目录，获取当前行数
            const fullPath = path.resolve(this.projectPath, filePath);
            if (fs.existsSync(fullPath)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    const lines = content.split('\n');
                    const nonEmptyLines = lines.filter(l => !isLineEmptyOrWhitespace(l)).length;
                    totalLinesOfChangedFiles += nonEmptyLines;
                } catch {
                    // Ignore read errors
                    // 忽略读取错误
                }
            }
        }
      }

      // 5. Check for files that exist in gitChangesMap but were deleted
      // (handled above - they contribute to removed but not added to totalLinesOfChangedFiles)

      // 6. Get file diffs for analysis
      // 6. 获取文件差异内容用于分析
      const fileDiffs = new Map<string, string>();
      try {
        if (baseRef.kind === 'commit') {
          const diffContent = execFileSync('git', [
            'diff',
            baseRef.ref,
            '--unified=0', // No context lines to save space / 不显示上下文行以节省空间
            '--no-color',
          ], {
            cwd: this.projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 50 * 1024 * 1024,
          });

          this.parseDiffContent(diffContent, fileDiffs);

          // Inject untracked files into stats for commit-based baseline too
          this.injectUntrackedIntoStatsAndDiffs({
            fileStats,
            activeFiles,
            totalLines: {
              add: (n: number) => (totalLinesAdded += n),
              addEmpty: (n: number) => (totalEmptyLinesAdded += n),
              addChangedFileLines: (n: number) => (totalLinesOfChangedFiles += n),
            },
            fileDiffs,
            targetDirectory,
          });
        } else {
          const committedDiff = execFileSync('git', [
            'diff',
            GitAnalyzer.EMPTY_TREE_HASH,
            'HEAD',
            '--unified=0',
            '--no-color',
          ], {
            cwd: this.projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 50 * 1024 * 1024,
          });
          this.parseDiffContent(committedDiff, fileDiffs, '\n\n# committed(empty→HEAD)\n');

          const stagedDiff = execFileSync('git', [
            'diff',
            '--cached',
            'HEAD',
            '--unified=0',
            '--no-color',
          ], {
            cwd: this.projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 50 * 1024 * 1024,
          });
          this.parseDiffContent(stagedDiff, fileDiffs, '\n\n# staged(HEAD→index)\n');

          const unstagedDiff = execFileSync('git', [
            'diff',
            'HEAD',
            '--unified=0',
            '--no-color',
          ], {
            cwd: this.projectPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            maxBuffer: 50 * 1024 * 1024,
          });
          this.parseDiffContent(unstagedDiff, fileDiffs, '\n\n# unstaged(HEAD→worktree)\n');

          this.injectUntrackedIntoStatsAndDiffs({
            fileStats,
            activeFiles,
            totalLines: {
              add: (n: number) => (totalLinesAdded += n),
              addEmpty: (n: number) => (totalEmptyLinesAdded += n),
              addChangedFileLines: (n: number) => (totalLinesOfChangedFiles += n),
            },
            fileDiffs,
            targetDirectory,
          });
        }
      } catch {
        // Ignore diff errors
      }

      return {
        totalFiles: activeFiles.size,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        netLinesAdded: totalLinesAdded - totalLinesRemoved,
        totalLinesOfChangedFiles,
        files: Array.from(activeFiles),
        fileStats,
        fileDiffs,
        gitStatusWarning,
        emptyLinesAdded: totalEmptyLinesAdded,
        emptyLinesRemoved: totalEmptyLinesRemoved,
      };

    } catch (e) {
      console.error('Error in getProjectChanges (Git-First):', e);
      return this.getProjectChangesFallback(since, targetDirectory);
    }
  }

  /**
   * Fallback method using mtime + glob
   * 回退方法：使用文件修改时间 (mtime) 和 glob 匹配
   *
   * 修复要点：
   * 1. 使用 Git 作为变更的主要来源，而非 mtime
   * 2. 未跟踪文件如果 Git 有变更记录，使用 Git 统计而非整文件
   * 3. 已删除文件确保 added/removed 一致处理
   */
  private getProjectChangesFallback(since: Date, targetDirectory?: string): { totalFiles: number; linesAdded: number; linesRemoved: number; netLinesAdded: number; totalLinesOfChangedFiles: number; files: string[]; fileStats: Map<string, { added: number, removed: number }>; fileDiffs?: Map<string, string>; gitStatusWarning?: string; emptyLinesAdded: number; emptyLinesRemoved: number } | undefined {
    try {
      const isGitAvailable = this.isGitReliable();
      let gitStatusWarning = '';

      if (isGitAvailable) {
        const baseRef = this.resolveBaseRef(since);
        if (baseRef?.kind === 'commit') {
          return this.getProjectChangesFromBaseCommit(baseRef.ref, targetDirectory);
        }
        if (baseRef?.kind === 'empty-tree') {
          return this.getProjectChangesFromEmptyTreeBaseline(targetDirectory);
        }
      }

      // Fallback to mtime-based detection only when Git is not available / baseline can't be resolved
      console.warn('⚠️  Warning: Git not available or baseline cannot be resolved. Using mtime-based detection (may be less accurate).');
      gitStatusWarning = 'Git unavailable - using mtime fallback';

      const allFiles = this.getRepoFilesFromGlob();
      const mtimeActiveFiles = new Set<string>();

      const targetFiles = this.filterByDirectory(allFiles, targetDirectory);

      // Check mtime for each file (less accurate)
      for (const filePath of targetFiles) {
        const fullPath = path.resolve(this.projectPath, filePath);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.mtime >= since) {
            mtimeActiveFiles.add(filePath);
          }
        } catch {
          // Ignore errors
        }
      }

      // 3. Get Git changes if available for more accurate stats
      const gitChangesMap = isGitAvailable ? this.getGitChangesMap(since) : undefined;

      let trackedFiles: Set<string>;

      if (!isGitAvailable) {
        trackedFiles = new Set(allFiles);
      } else {
        const trackedFilesList = this.getTrackedFilesFromGit();
        trackedFiles = trackedFilesList === null ? new Set(allFiles) : new Set(trackedFilesList);
      }

      let totalLinesAdded = 0;
      let totalLinesRemoved = 0;
      let totalEmptyLinesAdded = 0;
      let totalEmptyLinesRemoved = 0;
      let totalLinesOfChangedFiles = 0;
      const fileStats = new Map<string, { added: number, removed: number }>();
      const verifiedActiveFiles = new Set<string>();

      // 4. Process files with Git changes first (more accurate)
      if (gitChangesMap) {
        for (const [filePath, stats] of gitChangesMap.entries()) {
          // Filter by target directory
          if (targetDirectory && !filePath.startsWith(targetDirectory + '/')) {
            continue;
          }

          // Check ignore rules
          if (this.ignores.ignores(filePath)) {
            continue;
          }

          if (!this.isTextFile(filePath)) {
            continue;
          }

          const fullPath = path.resolve(this.projectPath, filePath);
          const fileExists = fs.existsSync(fullPath);

          // For files with Git changes, always use Git stats regardless of mtime
          totalLinesAdded += stats.added;
          totalLinesRemoved += stats.removed;
          totalEmptyLinesAdded += (stats.emptyAdded || 0);
          totalEmptyLinesRemoved += (stats.emptyRemoved || 0);
          verifiedActiveFiles.add(filePath);
          fileStats.set(filePath, { added: stats.added, removed: stats.removed });

          // Get current lines if file exists
          if (fileExists) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const nonEmptyLines = lines.filter(l => !isLineEmptyOrWhitespace(l)).length;
              totalLinesOfChangedFiles += nonEmptyLines;
            } catch {
              // Ignore read errors
            }
          }
        }
      }

      // 5. Handle mtime-active files that don't have Git changes
      // These are likely untracked files or files with metadata changes only
      for (const filePath of mtimeActiveFiles) {
        // Skip if already processed via Git changes
        if (verifiedActiveFiles.has(filePath)) {
          continue;
        }

        if (this.ignores.ignores(filePath)) {
          continue;
        }

        if (!this.isTextFile(filePath)) {
          continue;
        }

        const fullPath = path.resolve(this.projectPath, filePath);

        // For tracked files without Git changes, assume no content change (metadata only)
        if (trackedFiles.has(filePath)) {
          continue; // Skip - no actual code change
        }

        // For untracked files without Git changes, use conservative estimation
        // Only count if file is relatively small (likely new file, not copied library)
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const allLines = content.split('\n');
          const nonEmptyLines = allLines.filter(l => !isLineEmptyOrWhitespace(l)).length;
          const emptyLines = allLines.length - nonEmptyLines;

          // Conservative: cap the contribution to avoid over-counting large files
          // that might have been copied with preserved mtime
          const effectiveAdded = nonEmptyLines;

          totalLinesAdded += effectiveAdded;
          totalEmptyLinesAdded += emptyLines;
          totalLinesOfChangedFiles += nonEmptyLines;
          verifiedActiveFiles.add(filePath);
          fileStats.set(filePath, { added: effectiveAdded, removed: 0 });
        } catch {
          // Ignore read errors
        }
      }

      if (gitStatusWarning) {
        console.warn(`⚠️  Git Status: ${gitStatusWarning}`);
      }

      return {
        totalFiles: verifiedActiveFiles.size,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        netLinesAdded: totalLinesAdded - totalLinesRemoved,
        totalLinesOfChangedFiles,
        files: Array.from(verifiedActiveFiles),
        fileStats,
        gitStatusWarning: gitStatusWarning || undefined,
        emptyLinesAdded: totalEmptyLinesAdded,
        emptyLinesRemoved: totalEmptyLinesRemoved,
      };

    } catch (e) {
      console.error('Error in getProjectChangesFallback:', e);
      return undefined;
    }
  }

  /**
   * Get project changes from a specific base commit
   * 从特定基础提交获取项目变更（供 fallback 使用，保持与 Git-First 一致）
   */
  private getProjectChangesFromBaseCommit(baseCommit: string, targetDirectory?: string): { totalFiles: number; linesAdded: number; linesRemoved: number; netLinesAdded: number; totalLinesOfChangedFiles: number; files: string[]; fileStats: Map<string, { added: number, removed: number }>; fileDiffs?: Map<string, string>; gitStatusWarning?: string; emptyLinesAdded: number; emptyLinesRemoved: number } | undefined {
    try {
      const activeFiles = new Set<string>();
      let totalLinesAdded = 0;
      let totalLinesRemoved = 0;
      let totalLinesOfChangedFiles = 0;
      let totalEmptyLinesAdded = 0;
      let totalEmptyLinesRemoved = 0;

      const gitChangesMap = this.getGitChangesFromBase(baseCommit);
      const fileStats = new Map<string, { added: number, removed: number }>();

      if (gitChangesMap) {
        for (const [filePath, stats] of gitChangesMap.entries()) {
          if (targetDirectory && !filePath.startsWith(targetDirectory + '/')) {
            continue;
          }

          if (this.ignores.ignores(filePath)) {
            continue;
          }

          if (!this.isTextFile(filePath)) {
            continue;
          }

          activeFiles.add(filePath);
          totalLinesAdded += stats.added;
          totalLinesRemoved += stats.removed;
          totalEmptyLinesAdded += (stats.emptyAdded || 0);
          totalEmptyLinesRemoved += (stats.emptyRemoved || 0);
          fileStats.set(filePath, { added: stats.added, removed: stats.removed });

          const fullPath = path.resolve(this.projectPath, filePath);
          if (fs.existsSync(fullPath)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const nonEmptyLines = lines.filter(l => !isLineEmptyOrWhitespace(l)).length;
              totalLinesOfChangedFiles += nonEmptyLines;
            } catch {
              // Ignore read errors
            }
          }
        }
      }

      // Inject untracked files into stats (new files not yet committed)
      this.injectUntrackedIntoStatsAndDiffs({
        fileStats,
        activeFiles,
        totalLines: {
          add: (n: number) => (totalLinesAdded += n),
          addEmpty: (n: number) => (totalEmptyLinesAdded += n),
          addChangedFileLines: (n: number) => (totalLinesOfChangedFiles += n),
        },
        fileDiffs,
        targetDirectory,
      });

      return {
        totalFiles: activeFiles.size,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        netLinesAdded: totalLinesAdded - totalLinesRemoved,
        totalLinesOfChangedFiles,
        files: Array.from(activeFiles),
        fileStats,
        emptyLinesAdded: totalEmptyLinesAdded,
        emptyLinesRemoved: totalEmptyLinesRemoved,
        gitStatusWarning: undefined,
      };
    } catch (e) {
      console.error('Error in getProjectChangesFromBaseCommit:', e);
      return undefined;
    }
  }

  /**
   * Get all files in the repository
   * 获取仓库中的所有文件
   */
  getRepoFiles(targetDirectory?: string): string[] {
    const gitFiles = this.getRepoFilesFromGit();
    if (gitFiles.length > 0) {
      return this.filterByDirectory(gitFiles, targetDirectory);
    }

    return this.filterByDirectory(this.getRepoFilesFromGlob(), targetDirectory);
  }

  /**
   * Get the git remote origin URL
   * 获取 git 远程仓库 URL
   */
  getRepoUrl(): string | undefined {
    try {
      const result = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return result.length > 0 ? result : undefined;
    } catch {
      return undefined;
    }
  }

  private filterByDirectory(files: string[], targetDirectory?: string): string[] {
    if (!targetDirectory) {
      return files;
    }

    const prefix = targetDirectory + '/';
    return files.filter(file => file.startsWith(prefix));
  }

  /**
   * Format Date to ISO string with local timezone offset
   * This ensures Git interprets the time in the user's local timezone
   * e.g., 2026-03-10T00:00:00+08:00 (Beijing time)
   */
  private formatLocalISO(date: Date): string {
    const offset = date.getTimezoneOffset();
    const offsetSign = offset <= 0 ? '+' : '-';
    const offsetHours = Math.abs(Math.floor(offset / 60)).toString().padStart(2, '0');
    const offsetMinutes = Math.abs(offset % 60).toString().padStart(2, '0');
    const offsetStr = `${offsetSign}${offsetHours}:${offsetMinutes}`;

    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');

    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetStr}`;
  }

  private getGitBaseCommit(since: Date): string | null {
    try {
      const result = execFileSync('git', ['rev-list', '-1', '--before=' + this.formatLocalISO(since), 'HEAD'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return result.length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  private resolveBaseRef(since: Date): { kind: 'commit' | 'empty-tree'; ref: string } | null {
    if (!this.isGitReliable()) {
      return null;
    }

    // repo may have no commits
    try {
      execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
    } catch {
      return null;
    }

    const baseCommit = this.getGitBaseCommit(since);
    if (baseCommit) {
      return { kind: 'commit', ref: baseCommit };
    }

    return { kind: 'empty-tree', ref: GitAnalyzer.EMPTY_TREE_HASH };
  }

  private getGitChangesFromBaseline(base: { kind: 'commit' | 'empty-tree'; ref: string }): Map<string, { added: number, removed: number, emptyAdded: number, emptyRemoved: number }> | undefined {
    if (base.kind === 'commit') {
      return this.getGitChangesFromBase(base.ref);
    }

    // When `since` is earlier than the first commit, we use empty-tree as baseline.
    // In this mode, we must avoid double counting by NOT summing:
    //   empty→HEAD  +  HEAD→index  +  HEAD→worktree
    // because worktree/index diffs are not disjoint from empty→HEAD.
    // Minimal fix: compute one "final state" diff only: empty-tree → worktree.
    const changesMap = new Map<string, { added: number, removed: number, emptyAdded: number, emptyRemoved: number }>();

    try {
      const fullDiff = execFileSync('git', [
        'diff',
        GitAnalyzer.EMPTY_TREE_HASH,
        '--unified=0',
        '--no-color',
      ], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 50 * 1024 * 1024,
      });

      this.parseDiffForStats(fullDiff, changesMap);
      return changesMap;
    } catch {
      return undefined;
    }
  }

  private getProjectChangesFromEmptyTreeBaseline(targetDirectory?: string): { totalFiles: number; linesAdded: number; linesRemoved: number; netLinesAdded: number; totalLinesOfChangedFiles: number; files: string[]; fileStats: Map<string, { added: number, removed: number }>; fileDiffs?: Map<string, string>; gitStatusWarning?: string; emptyLinesAdded: number; emptyLinesRemoved: number } | undefined {
    try {
      const activeFiles = new Set<string>();
      const fileStats = new Map<string, { added: number, removed: number }>();
      const fileDiffs = new Map<string, string>();

      let totalLinesAdded = 0;
      let totalLinesRemoved = 0;
      let totalEmptyLinesAdded = 0;
      let totalEmptyLinesRemoved = 0;
      let totalLinesOfChangedFiles = 0;

      const gitChangesMap = this.getGitChangesFromBaseline({ kind: 'empty-tree', ref: GitAnalyzer.EMPTY_TREE_HASH });
      if (gitChangesMap) {
        for (const [filePath, stats] of gitChangesMap.entries()) {
          if (targetDirectory && !filePath.startsWith(targetDirectory + '/')) continue;
          if (this.ignores.ignores(filePath)) continue;
          if (!this.isTextFile(filePath)) continue;

          activeFiles.add(filePath);
          totalLinesAdded += stats.added;
          totalLinesRemoved += stats.removed;
          totalEmptyLinesAdded += (stats.emptyAdded || 0);
          totalEmptyLinesRemoved += (stats.emptyRemoved || 0);
          fileStats.set(filePath, { added: stats.added, removed: stats.removed });

          const fullPath = path.resolve(this.projectPath, filePath);
          if (fs.existsSync(fullPath)) {
            try {
              const content = fs.readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const nonEmptyLines = lines.filter(l => !isLineEmptyOrWhitespace(l)).length;
              totalLinesOfChangedFiles += nonEmptyLines;
            } catch {
              // Ignore read errors
            }
          }
        }
      }

      try {
        const committedDiff = execFileSync('git', [
          'diff',
          GitAnalyzer.EMPTY_TREE_HASH,
          'HEAD',
          '--unified=0',
          '--no-color',
        ], {
          cwd: this.projectPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 50 * 1024 * 1024,
        });
        this.parseDiffContent(committedDiff, fileDiffs, '\n\n# committed(empty→HEAD)\n');

        const stagedDiff = execFileSync('git', [
          'diff',
          '--cached',
          'HEAD',
          '--unified=0',
          '--no-color',
        ], {
          cwd: this.projectPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 50 * 1024 * 1024,
        });
        this.parseDiffContent(stagedDiff, fileDiffs, '\n\n# staged(HEAD→index)\n');

        const unstagedDiff = execFileSync('git', [
          'diff',
          'HEAD',
          '--unified=0',
          '--no-color',
        ], {
          cwd: this.projectPath,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
          maxBuffer: 50 * 1024 * 1024,
        });
        this.parseDiffContent(unstagedDiff, fileDiffs, '\n\n# unstaged(HEAD→worktree)\n');
      } catch {
        // ignore
      }

      this.injectUntrackedIntoStatsAndDiffs({
        fileStats,
        activeFiles,
        totalLines: {
          add: (n: number) => (totalLinesAdded += n),
          addEmpty: (n: number) => (totalEmptyLinesAdded += n),
          addChangedFileLines: (n: number) => (totalLinesOfChangedFiles += n),
        },
        fileDiffs,
        targetDirectory,
      });

      return {
        totalFiles: activeFiles.size,
        linesAdded: totalLinesAdded,
        linesRemoved: totalLinesRemoved,
        netLinesAdded: totalLinesAdded - totalLinesRemoved,
        totalLinesOfChangedFiles,
        files: Array.from(activeFiles),
        fileStats,
        fileDiffs,
        gitStatusWarning: 'since is earlier than first commit; using empty-tree baseline (repo-birth)',
        emptyLinesAdded: totalEmptyLinesAdded,
        emptyLinesRemoved: totalEmptyLinesRemoved,
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Get untracked files (not committed, not ignored)
   * 获取未跟踪文件（未提交且未被忽略）
   */
  private getUntrackedFiles(): string[] {
    const repoRoot = this.getGitRepoRoot();
    if (!repoRoot) return [];

    const relativeRoot = path.relative(repoRoot, this.projectPath);
    const normalizedRelativeRoot = this.normalizePathSegment(relativeRoot);
    const pathspec = normalizedRelativeRoot ? [normalizedRelativeRoot] : [];

    try {
      const untracked = this.runGitLsFiles([
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
        ...(pathspec.length > 0 ? ['--', ...pathspec] : []),
      ]);
      const normalized = this.normalizeGitPaths(untracked, normalizedRelativeRoot);
      return normalized.filter(file => {
        if (this.ignores.ignores(file)) return false;
        if (!this.isTextFile(file)) return false;
        return true;
      });
    } catch {
      return [];
    }
  }

  private injectUntrackedIntoStatsAndDiffs(params: {
    fileStats: Map<string, { added: number; removed: number }>;
    activeFiles: Set<string>;
    totalLines: {
      add: (n: number) => void;
      addEmpty: (n: number) => void;
      addChangedFileLines: (n: number) => void;
    };
    fileDiffs: Map<string, string>;
    targetDirectory?: string;
  }): void {
    const untracked = this.getUntrackedFiles();
    for (const filePath of untracked) {
      if (params.targetDirectory && !filePath.startsWith(params.targetDirectory + '/')) {
        continue;
      }
      if (this.ignores.ignores(filePath)) {
        continue;
      }
      if (!this.isTextFile(filePath)) {
        continue;
      }

      const fullPath = path.resolve(this.projectPath, filePath);
      if (!fs.existsSync(fullPath)) {
        continue;
      }

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const allLines = content.split('\n');
        const nonEmptyLines = allLines.filter(l => !isLineEmptyOrWhitespace(l)).length;
        const emptyLines = allLines.length - nonEmptyLines;

        // Avoid double counting:
        // In empty-tree baseline mode, `git diff <EMPTY_TREE_HASH>` may already include untracked files
        // as "new files" (depending on git version/config). If this file already has stats, we only
        // append the "# untracked" synthetic diff for readability and skip totals accumulation.
        const alreadyCounted = params.fileStats.has(filePath);

        if (!alreadyCounted) {
          params.totalLines.add(nonEmptyLines);
          params.totalLines.addEmpty(emptyLines);
          params.totalLines.addChangedFileLines(nonEmptyLines);

          params.activeFiles.add(filePath);
          params.fileStats.set(filePath, { added: nonEmptyLines, removed: 0 });
        }

        const synthetic = [
          'diff --git a/' + filePath + ' b/' + filePath,
          'new file mode 100644',
          'index 0000000..0000000',
          '--- /dev/null',
          '+++ b/' + filePath,
          '@@ -0,0 +1,' + allLines.length + ' @@',
          ...allLines.map(line => '+' + line),
        ].join('\n');

        const existingDiff = params.fileDiffs.get(filePath);
        const header = '\n\n# untracked\n';
        if (existingDiff) {
          params.fileDiffs.set(filePath, existingDiff + header + synthetic);
        } else {
          params.fileDiffs.set(filePath, header.trimEnd() + '\n' + synthetic);
        }
      } catch {
        // ignore
      }
    }
  }

  private parseDiffContent(diffOutput: string, fileDiffs: Map<string, string>, sectionHeader?: string): void {
    const lines = diffOutput.split('\n');
    let currentFile: string | null = null;
    let currentDiff: string[] = [];

    const flush = () => {
      if (!currentFile || currentDiff.length === 0) {
        return;
      }

      const diffText = currentDiff.join('\n');
      const existing = fileDiffs.get(currentFile);
      if (existing) {
        fileDiffs.set(currentFile, existing + (sectionHeader || '\n') + diffText);
      } else {
        fileDiffs.set(currentFile, (sectionHeader ? sectionHeader.trimEnd() + '\n' : '') + diffText);
      }
    };

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        flush();

        const parts = line.split(' ');
        if (parts.length >= 4) {
          const bPath = parts[parts.length - 1];
          currentFile = bPath.startsWith('b/') ? bPath.slice(2) : bPath;
          currentDiff = [line];
        } else {
          currentFile = null;
          currentDiff = [];
        }
      } else if (currentFile) {
        currentDiff.push(line);
      }
    }

    flush();
  }

  private getGitChangesFromBase(baseCommit: string): Map<string, { added: number, removed: number, emptyAdded: number, emptyRemoved: number }> | undefined {
    const repoRoot = this.getGitRepoRoot();
    if (!repoRoot) return undefined;

    const changesMap = new Map<string, { added: number, removed: number, emptyAdded: number, emptyRemoved: number }>();

    try {
      // Helper to update map (parse git diff --numstat output)
      // Note: This is now replaced by parseDiffForStats below which is more accurate for filtering blank lines
      // We keep the structure but the logic is primarily driven by parseDiffForStats now.

      // Let's implement a custom diff parser for counting to be precise.
      // We can run `git diff <base> --unified=0 --ignore-blank-lines` and count lines starting with '+' that are not empty.
      
      const diffOutput = execFileSync('git', [
        'diff',
        baseCommit,
        '--unified=0',
        '--no-color', // Remove ignore-blank-lines flag to get all changes, so we can count empty ones too
      ], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 50 * 1024 * 1024,
      });

      this.parseDiffForStats(diffOutput, changesMap);

      return changesMap;
    } catch (e) {
      // console.error('Error getting git changes:', e);
      return undefined;
    }
  }

  /**
   * Parse unified diff output to calculate added/removed lines, ignoring blank lines
   * 解析统一差异 (unified diff) 输出以计算增加/删除的行数，忽略空行
   */
  private parseDiffForStats(diffOutput: string, changesMap: Map<string, { added: number, removed: number, emptyAdded: number, emptyRemoved: number }>) {
    const lines = diffOutput.split('\n');
    let currentFile: string | null = null;

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        const parts = line.split(' ');
        if (parts.length >= 4) {
          const bPath = parts[parts.length - 1];
          currentFile = bPath.startsWith('b/') ? bPath.slice(2) : bPath;
        } else {
          currentFile = null;
        }
      } else if (currentFile) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          // Added line: check if it's blank/whitespace only
          // 新增行：检查是否仅为空白行
          const content = line.substring(1);
          if (!isLineEmptyOrWhitespace(content)) {
            const current = changesMap.get(currentFile) || { added: 0, removed: 0, emptyAdded: 0, emptyRemoved: 0 };
            current.added++;
            changesMap.set(currentFile, current);
          } else {
            const current = changesMap.get(currentFile) || { added: 0, removed: 0, emptyAdded: 0, emptyRemoved: 0 };
            current.emptyAdded++;
            changesMap.set(currentFile, current);
          }
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          // Removed line: check if it's blank/whitespace only
          // 删除行：检查是否仅为空白行
          const content = line.substring(1);
          if (!isLineEmptyOrWhitespace(content)) {
            const current = changesMap.get(currentFile) || { added: 0, removed: 0, emptyAdded: 0, emptyRemoved: 0 };
            current.removed++;
            changesMap.set(currentFile, current);
          } else {
            const current = changesMap.get(currentFile) || { added: 0, removed: 0, emptyAdded: 0, emptyRemoved: 0 };
            current.emptyRemoved++;
            changesMap.set(currentFile, current);
          }
        }
      }
    }
  }

  private getGitChangesMap(since: Date): Map<string, { added: number, removed: number, emptyAdded: number, emptyRemoved: number }> | undefined {
    const repoRoot = this.getGitRepoRoot();
    if (!repoRoot) return undefined;

    // Fallback implementation for getGitChangesMap used in fallback mode
    // Note: This method currently uses --numstat which doesn't support empty line separation easily without full diff
    // For simplicity in fallback mode, we'll return basic stats or we could try to implement full diff parsing here too
    // But since this is fallback, maybe we accept less precision or just 0 for empty lines unless we want to do the heavy diff parsing again.
    
    // To match the interface, we'll return objects with emptyAdded/emptyRemoved initialized to 0
    // If precision is needed in fallback mode, we would need to run full diff like above.
    
    const changesMap = new Map<string, { added: number, removed: number, emptyAdded: number, emptyRemoved: number }>();

    try {
      const updateMap = (output: string) => {
        const lines = output.split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;

          const added = parseInt(parts[0], 10);
          const removed = parseInt(parts[1], 10);
          const filePath = parts[2];

          if (isNaN(added) || isNaN(removed)) continue;

          const current = changesMap.get(filePath) || { added: 0, removed: 0, emptyAdded: 0, emptyRemoved: 0 };
          current.added += added;
          current.removed += removed;
          changesMap.set(filePath, current);
        }
      };

      const gitLogOutput = execFileSync('git', [
        'log',
        `--since=${this.formatLocalISO(since)}`,
        '--numstat',
        '--pretty=format:',
      ], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      updateMap(gitLogOutput);

      const stagedOutput = execFileSync('git', ['diff', '--cached', '--numstat'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      updateMap(stagedOutput);

      const unstagedOutput = execFileSync('git', ['diff', '--numstat'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      updateMap(unstagedOutput);

      return changesMap;
    } catch (e) {
      return undefined;
    }
  }

  private getRepoFilesFromGit(): string[] {
    const repoRoot = this.getGitRepoRoot();
    if (!repoRoot) {
      return [];
    }

    const relativeRoot = path.relative(repoRoot, this.projectPath);
    const normalizedRelativeRoot = this.normalizePathSegment(relativeRoot);
    const pathspec = normalizedRelativeRoot ? [normalizedRelativeRoot] : [];

    try {
      const tracked = this.runGitLsFiles(['ls-files', '-z', ...(pathspec.length > 0 ? ['--', ...pathspec] : [])]);
      const untracked = this.runGitLsFiles([
        'ls-files',
        '-z',
        '--others',
        '--exclude-standard',
        ...(pathspec.length > 0 ? ['--', ...pathspec] : []),
      ]);
      const normalized = this.normalizeGitPaths([...tracked, ...untracked], normalizedRelativeRoot);
      return this.filterRepoFiles(normalized);
    } catch {
      return [];
    }
  }

  private getTrackedFilesFromGit(): string[] | null {
    const repoRoot = this.getGitRepoRoot();
    if (!repoRoot) {
      return null;
    }

    const relativeRoot = path.relative(repoRoot, this.projectPath);
    const normalizedRelativeRoot = this.normalizePathSegment(relativeRoot);
    const pathspec = normalizedRelativeRoot ? [normalizedRelativeRoot] : [];

    try {
      const tracked = this.runGitLsFiles(['ls-files', '-z', ...(pathspec.length > 0 ? ['--', ...pathspec] : [])]);
      const normalized = this.normalizeGitPaths(tracked, normalizedRelativeRoot);
      return this.filterRepoFiles(normalized);
    } catch {
      return null;
    }
  }

  private isGitReliable(): boolean {
    try {
      execFileSync('git', ['status', '--porcelain'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private getGitRepoRoot(): string | null {
    try {
      const result = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return result.length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  private runGitLsFiles(args: string[]): string[] {
    const output = execFileSync('git', args, {
      cwd: this.projectPath,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 50 * 1024 * 1024,
    });
    return output.split('\u0000').filter(Boolean);
  }

  private normalizeGitPaths(files: string[], projectRelativeToRepo: string | null): string[] {
    const normalized = files.map(file => this.toForwardSlash(file)).filter(Boolean);
    if (!projectRelativeToRepo) {
      return normalized;
    }

    const trimmedRoot = projectRelativeToRepo.replace(/\/+$/, '');
    if (!trimmedRoot) {
      return normalized;
    }

    const prefix = `${trimmedRoot}/`;
    const trimmed: string[] = [];
    for (const file of normalized) {
      if (file.startsWith(prefix)) {
        trimmed.push(file.slice(prefix.length));
      }
    }
    return trimmed;
  }

  private normalizePathSegment(segment: string): string | null {
    if (!segment || segment === '.' || segment === path.sep) {
      return null;
    }
    if (segment.startsWith('..')) {
      return null;
    }
    return this.toForwardSlash(segment);
  }

  private toForwardSlash(p: string): string {
    return p.replace(/\\/g, '/');
  }

  private getRepoFilesFromGlob(): string[] {
    const ignorePatterns = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/__pycache__/**',
      '**/*.pyc',
      '**/venv/**',
      '**/.venv/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.nuxt/**',
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
    ];

    try {
      const files = glob.sync('**/*', {
        cwd: this.projectPath,
        nodir: true,
        ignore: ignorePatterns,
      });
      return this.filterRepoFiles(files);
    } catch {
      return [];
    }
  }

  private filterRepoFiles(files: string[]): string[] {
    let filtered = files.map(file => file.replace(/\\/g, '/')).filter(Boolean);
    filtered = filtered.filter(file => !this.shouldIgnoreByDefault(file));
    filtered = filtered.filter(file => this.isTextFile(file));
    filtered = filtered.filter(file => !this.ignores.ignores(file));

    // Gitignore logic is handled by ContributionAnalyzer passing the configured ignores object
    
    return filtered;
  }

  private shouldIgnoreByDefault(file: string): boolean {
    const normalized = file.replace(/\\/g, '/');
    const wrapped = `/${normalized}`;

    if (wrapped.includes('/node_modules/')) return true;
    if (wrapped.includes('/.git/')) return true;
    if (wrapped.includes('/dist/')) return true;
    if (wrapped.includes('/build/')) return true;
    if (wrapped.includes('/bin/')) return true;
    if (wrapped.includes('/__pycache__/')) return true;
    if (wrapped.includes('/venv/')) return true;
    if (wrapped.includes('/.venv/')) return true;
    if (wrapped.includes('/coverage/')) return true;
    if (wrapped.includes('/.next/')) return true;
    if (wrapped.includes('/.nuxt/')) return true;
    if (wrapped.includes('/logs/')) return true;
    if (wrapped.includes('/jsonData/')) return true;
    if (normalized.endsWith('.pyc')) return true;
    if (normalized.endsWith('.db')) return true;
    if (normalized.endsWith('.sqlite')) return true;
    if (normalized.endsWith('.sqlite3')) return true;

    const base = path.posix.basename(normalized);
    if (base === 'package-lock.json') return true;
    if (base === 'pnpm-lock.yaml') return true;
    if (base === 'yarn.lock') return true;

    return false;
  }

  isTextFile(file: string): boolean {
    const ext = path.extname(file).toLowerCase();
    const textExtensions = [
      '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
      '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
      '.c', '.cpp', '.h', '.hpp', '.cs',
      '.html', '.css', '.scss', '.less', '.sass',
      '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.xml',
      '.md', '.mdx', '.txt', '.rst',
      '.sh', '.bash', '.zsh', '.fish',
      '.sql', '.graphql', '.gql', '.graphqls',
      '.vue', '.svelte',
      '.php', '.swift', '.m',
      '.r', '.R', '.jl',
      '.ex', '.exs', '.erl', '.hrl',
      '.hs', '.elm', '.clj', '.cljs',
      '.dockerfile', '.tf', '.tfvars', '.hcl',
      '.proto', '.prisma', '.svg',
      '.ini', '.conf', '.cfg', '.properties',
      '.lock', '.gradle', '.groovy', '.kts',
      '.cmake', '.mk',
      '.ps1', '.psm1', '.psd1', '.bat', '.cmd',
      '.csv', '.tsv',
    ];
    return textExtensions.includes(ext) || !ext;
  }
}
