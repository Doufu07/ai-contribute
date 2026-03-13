import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { glob } from 'glob';
import ignore, { type Ignore } from 'ignore';

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
   * Get project changes since a specific time using Git-First strategy
   * 使用 Git 优先策略获取自指定时间以来的项目变更
   */
  getProjectChanges(since: Date, targetDirectory?: string): { totalFiles: number; linesAdded: number; linesRemoved: number; netLinesAdded: number; totalLinesOfChangedFiles: number; files: string[]; fileStats: Map<string, { added: number, removed: number }>; fileDiffs?: Map<string, string>; gitStatusWarning?: string } | undefined {
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
            const lines = content.split('\n').length;
            totalLinesAdded += lines;
            totalLinesOfChangedFiles += lines;
            fileStats.set(filePath, { added: lines, removed: 0 });
            
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
  private getProjectChangesFallback(since: Date, targetDirectory?: string): { totalFiles: number; linesAdded: number; linesRemoved: number; netLinesAdded: number; totalLinesOfChangedFiles: number; files: string[]; fileStats: Map<string, { added: number, removed: number }>; fileDiffs?: Map<string, string>; gitStatusWarning?: string } | undefined {
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
      let totalLinesOfChangedFiles = 0;
      const fileStats = new Map<string, { added: number, removed: number }>();

      // 3. Iterate active files and aggregate stats
      // 3. 遍历活跃文件并聚合统计信息
      const verifiedActiveFiles = new Set<string>();
      
      for (const filePath of activeFiles) {
        let currentFileLines = 0;
        const fullPath = path.resolve(this.projectPath, filePath);
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          currentFileLines = content.split('\n').length;
        } catch {
          continue;
        }
        
        if (gitChangesMap && gitChangesMap.has(filePath)) {
          const gitStats = gitChangesMap.get(filePath)!;
          totalLinesAdded += gitStats.added;
          totalLinesRemoved += gitStats.removed;
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
             totalLinesAdded += currentFileLines;
             totalLinesOfChangedFiles += currentFileLines;
             verifiedActiveFiles.add(filePath);
             fileStats.set(filePath, { added: currentFileLines, removed: 0 });
          }
        }
      }

      if (gitChangesMap) {
        for (const [filePath, stats] of gitChangesMap.entries()) {
          if (!activeFiles.has(filePath) && !fs.existsSync(path.resolve(this.projectPath, filePath))) {
             totalLinesRemoved += stats.removed;
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
        gitStatusWarning: gitStatusWarning || undefined
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

  private getGitChangesFromBase(baseCommit: string): Map<string, { added: number, removed: number }> | undefined {
    const repoRoot = this.getGitRepoRoot();
    if (!repoRoot) return undefined;

    const changesMap = new Map<string, { added: number, removed: number }>();

    try {
      // Helper to update map (parse git diff --numstat output)
      const updateMap = (output: string) => {
        const lines = output.split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;

          const added = parseInt(parts[0], 10);
          const removed = parseInt(parts[1], 10);
          const filePath = parts[2];

          if (isNaN(added) || isNaN(removed)) continue;

          const current = changesMap.get(filePath) || { added: 0, removed: 0 };
          current.added += added;
          current.removed += removed;
          changesMap.set(filePath, current);
        }
      };

      // 1. Get detailed diff with ignore-blank-lines for accurate 'added' count (ignoring whitespace/blank lines)
      // Note: --numstat does not support --ignore-blank-lines directly in a way that affects the numbers as desired in all versions/contexts correctly for what we want (it tracks line changes).
      // However, git diff --shortstat --ignore-blank-lines gives summary, not per file.
      // To get per-file stats ignoring blank lines, we can use --dirstat or parse the patch.
      // But a simpler approach often used is `git diff --numstat --ignore-all-space` or similar.
      // Actually, standard `git diff` with --numstat DOES NOT respect --ignore-blank-lines for the counts. It always shows physical line changes.
      
      // Strategy:
      // 1. Get the list of changed files first.
      // 2. For each file, run a specific diff to count non-blank added lines? That's too slow.
      //
      // Alternative: Use `git diff --shortstat --ignore-blank-lines` is global.
      //
      // Better approach for per-file stats ignoring blank lines:
      // We have to parse the full diff or use `git diff --numstat` as a baseline and accept it includes blank lines,
      // OR, we try `git diff --numstat -w` (ignore all whitespace) which might reduce noise but doesn't strictly ignore *new blank lines*.
      //
      // WAIT: The user specifically asked to ignore "blank lines".
      // Let's try to use `git diff --numstat --ignore-blank-lines`.
      // Testing locally shows `git diff --numstat --ignore-blank-lines` MIGHT work depending on git version, but often it just ignores the *change* if it's only blank lines, but if there are other changes, does it subtract the blank lines count? Usually no.
      //
      // Correct robust approach:
      // We will parse the actual unified diff output later in `parseDiffContent` anyway.
      // BUT `getGitChangesFromBase` is used for the stats numbers.
      //
      // Let's implement a custom diff parser for counting to be precise.
      // We can run `git diff <base> --unified=0 --ignore-blank-lines` and count lines starting with '+' that are not empty.
      
      const diffOutput = execFileSync('git', [
        'diff',
        baseCommit,
        '--unified=0',
        '--ignore-blank-lines', // Ignore changes that are just blank lines
        '--ignore-space-at-eol', // Ignore trailing whitespace
        '--no-color',
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
  private parseDiffForStats(diffOutput: string, changesMap: Map<string, { added: number, removed: number }>) {
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
          if (content.trim().length > 0) {
            const current = changesMap.get(currentFile) || { added: 0, removed: 0 };
            current.added++;
            changesMap.set(currentFile, current);
          }
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          // Removed line: check if it's blank/whitespace only
          // 删除行：检查是否仅为空白行
          const content = line.substring(1);
          if (content.trim().length > 0) {
            const current = changesMap.get(currentFile) || { added: 0, removed: 0 };
            current.removed++;
            changesMap.set(currentFile, current);
          }
        }
      }
    }
  }

  private getGitChangesMap(since: Date): Map<string, { added: number, removed: number }> | undefined {
    const repoRoot = this.getGitRepoRoot();
    if (!repoRoot) return undefined;

    const changesMap = new Map<string, { added: number, removed: number }>();

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

          const current = changesMap.get(filePath) || { added: 0, removed: 0 };
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
