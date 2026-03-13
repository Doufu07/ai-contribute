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

      // 2. Get base commit
      // 2. 获取基准提交（指定时间之前的最近一次提交）
      const baseCommit = this.getGitBaseCommit(since);
      if (!baseCommit) {
        // Fallback to time-based if no base commit found
        // 如果找不到基准提交，回退到基于时间的分析
        return this.getProjectChangesFallback(since, targetDirectory);
      }

      // 3. Get changes from Git (committed + staged + working tree)
      // 3. 从 Git 获取变更（包含已提交、暂存区和工作区的变更）
      const gitChangesMap = this.getGitChangesFromBase(baseCommit);
      
      // 4. Get untracked files
      // 4. 获取未跟踪的文件
      const untrackedFiles = this.getUntrackedFiles();

      // Process Git changes
      // 处理 Git 变更
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

            // If file exists, get current lines
            // 如果文件存在，获取当前行数
            const fullPath = path.resolve(this.projectPath, filePath);
            if (fs.existsSync(fullPath)) {
                try {
                    const content = fs.readFileSync(fullPath, 'utf8');
                    totalLinesOfChangedFiles += content.split('\n').length;
                } catch {
                    // Ignore read errors
                    // 忽略读取错误
                }
            }
        }
      }

      // 5. Get file diffs for analysis
      // 5. 获取文件差异内容用于分析
      const fileDiffs = new Map<string, string>();
      if (baseCommit) {
          try {
            // Get diff content for tracked files
            // 获取已跟踪文件的差异内容
            const diffContent = execFileSync('git', [
                'diff',
                baseCommit,
                '--unified=0', // No context lines to save space / 不显示上下文行以节省空间
                '--no-color',
            ], {
                cwd: this.projectPath,
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
                maxBuffer: 50 * 1024 * 1024,
            });
            
            this.parseDiffContent(diffContent, fileDiffs);
          } catch (e) {
              // Ignore diff errors
              // 忽略 diff 错误
          }
      }

      // Process untracked files
      // 处理未跟踪的文件
      for (const filePath of untrackedFiles) {
        // Filter by target directory
        // 过滤目标目录
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
        
        const fullPath = path.resolve(this.projectPath, filePath);
        try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const allLines = content.split('\n');
            const nonEmptyLines = allLines.filter(l => !isLineEmptyOrWhitespace(l)).length;
            const emptyLines = allLines.length - nonEmptyLines;
            
            totalLinesAdded += nonEmptyLines;
            totalEmptyLinesAdded += emptyLines;
            totalLinesOfChangedFiles += allLines.length;
            fileStats.set(filePath, { added: nonEmptyLines, removed: 0 });
            
            // For untracked files, the whole content is the diff
            // 对于未跟踪文件，整个内容即为差异
            fileDiffs.set(filePath, `New file: ${filePath}\n${content}`);
        } catch {
            // Ignore
        }
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
   */
  private getProjectChangesFallback(since: Date, targetDirectory?: string): { totalFiles: number; linesAdded: number; linesRemoved: number; netLinesAdded: number; totalLinesOfChangedFiles: number; files: string[]; fileStats: Map<string, { added: number, removed: number }>; fileDiffs?: Map<string, string>; gitStatusWarning?: string; emptyLinesAdded: number; emptyLinesRemoved: number } | undefined {
    try {
      // 1. Get all files and filter by mtime >= since
      // 1. 获取所有文件并过滤出修改时间 >= since 的文件
      const allFiles = this.getRepoFilesFromGlob();
      const activeFiles = new Set<string>();
      
      // Filter by target directory if set
      // 如果设置了目标目录，则进行过滤
      const targetFiles = this.filterByDirectory(allFiles, targetDirectory);

      // Check mtime for each file
      // 检查每个文件的修改时间
      for (const filePath of targetFiles) {
        const fullPath = path.resolve(this.projectPath, filePath);
        try {
          const stats = fs.statSync(fullPath);
          if (stats.mtime >= since) {
            activeFiles.add(filePath);
          }
        } catch {
          // Ignore errors
        }
      }

      if (activeFiles.size === 0) {
        return {
          totalFiles: 0,
          linesAdded: 0,
          linesRemoved: 0,
          netLinesAdded: 0,
          totalLinesOfChangedFiles: 0,
          files: [],
          fileStats: new Map(),
          emptyLinesAdded: 0,
          emptyLinesRemoved: 0,
        };
      }

      // 2. Try to get Git changes for all files
      // 2. 尝试获取所有文件的 Git 变更
      const gitChangesMap = this.getGitChangesMap(since);
      
      const isGitAvailable = this.isGitReliable();
      let trackedFiles: Set<string>;
      let gitStatusWarning = '';
      
      if (!isGitAvailable) {
        console.warn('⚠️  Warning: Git is not available or reliable. Assuming all files are tracked to avoid over-counting.');
        trackedFiles = new Set(allFiles);
        gitStatusWarning = 'Git unavailable - conservative mode';
      } else {
        const trackedFilesList = this.getTrackedFilesFromGit();
        if (trackedFilesList === null) {
          console.warn('⚠️  Warning: Failed to get tracked files from Git. Assuming all files are tracked to avoid over-counting.');
          trackedFiles = new Set(allFiles);
          gitStatusWarning = 'Failed to get tracked files - conservative mode';
        } else {
          trackedFiles = new Set(trackedFilesList);
        }
      }
      
      let totalLinesAdded = 0;
      let totalLinesRemoved = 0;
      let totalEmptyLinesAdded = 0;
      let totalEmptyLinesRemoved = 0;
      let totalLinesOfChangedFiles = 0;
      const fileStats = new Map<string, { added: number, removed: number }>();

      // 3. Iterate active files and aggregate stats
      // 3. 遍历活跃文件并聚合统计信息
      const verifiedActiveFiles = new Set<string>();
      
      for (const filePath of activeFiles) {
        let currentFileLines = 0;
        let currentFileNonEmptyLines = 0;
        const fullPath = path.resolve(this.projectPath, filePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          currentFileLines = lines.length;
          currentFileNonEmptyLines = lines.filter(l => !isLineEmptyOrWhitespace(l)).length;
        } catch {
          continue;
        }
        
        if (gitChangesMap && gitChangesMap.has(filePath)) {
          const gitStats = gitChangesMap.get(filePath)!;
          totalLinesAdded += gitStats.added;
          totalLinesRemoved += gitStats.removed;
          totalEmptyLinesAdded += (gitStats.emptyAdded || 0);
          totalEmptyLinesRemoved += (gitStats.emptyRemoved || 0);
          totalLinesOfChangedFiles += currentFileLines;
          verifiedActiveFiles.add(filePath);
          fileStats.set(filePath, { added: gitStats.added, removed: gitStats.removed });
        } else {
          if (trackedFiles.has(filePath)) {
            // Tracked file but no git changes => content unmodified
            // 已跟踪文件但无 Git 变更 => 内容未修改
          } else {
             // Untracked file => assume whole file is new
             // 未跟踪文件 => 假设整个文件都是新增的
             totalLinesAdded += currentFileNonEmptyLines;
             totalEmptyLinesAdded += (currentFileLines - currentFileNonEmptyLines);
             totalLinesOfChangedFiles += currentFileLines;
             verifiedActiveFiles.add(filePath);
             fileStats.set(filePath, { added: currentFileNonEmptyLines, removed: 0 });
          }
        }
      }

      if (gitChangesMap) {
        for (const [filePath, stats] of gitChangesMap.entries()) {
          if (!activeFiles.has(filePath) && !fs.existsSync(path.resolve(this.projectPath, filePath))) {
             totalLinesRemoved += stats.removed;
             totalEmptyLinesRemoved += (stats.emptyRemoved || 0);
             verifiedActiveFiles.add(filePath);
             fileStats.set(filePath, { added: stats.added, removed: stats.removed });
          }
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

  private getGitBaseCommit(since: Date): string | null {
    try {
      const result = execFileSync('git', ['rev-list', '-1', '--before=' + since.toISOString(), 'HEAD'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return result.length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  private getUntrackedFiles(): string[] {
    try {
      const output = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd: this.projectPath,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 50 * 1024 * 1024,
      });
      return output.split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/'));
    } catch {
      return [];
    }
  }

  private parseDiffContent(diffOutput: string, fileDiffs: Map<string, string>): void {
    const lines = diffOutput.split('\n');
    let currentFile: string | null = null;
    let currentDiff: string[] = [];

    for (const line of lines) {
      if (line.startsWith('diff --git')) {
        if (currentFile && currentDiff.length > 0) {
          fileDiffs.set(currentFile, currentDiff.join('\n'));
        }
        
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

    if (currentFile && currentDiff.length > 0) {
      fileDiffs.set(currentFile, currentDiff.join('\n'));
    }
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
        `--since=${since.toISOString()}`,
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
