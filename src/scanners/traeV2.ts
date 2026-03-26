import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { AISession, AITool, FileChange, SessionType, SessionOperations } from '../types.js';
import { BaseScanner } from './base.js';

// CommonJS compatibility
declare const require: any;

interface TraeSessionSummary {
  sessionId: string;
  isCurrent: boolean;
  messages?: any[];
}

interface TraeInputHistory {
  inputText: string;
  parsedQuery?: string[];
  multiMedia?: any[];
}

export class TraeScanner extends BaseScanner {
  private sqliteMode: 'cli' | 'sqljs' | 'none' | null = null;
  private warnedMissingSqlite = false;
  private nodeRequire = require;

  get tool(): AITool {
    return AITool.TRAE;
  }

  get storagePath(): string {
    const platform = os.platform();
    if (platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'workspaceStorage');
    }
    if (platform === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'workspaceStorage');
    }
    return path.join(os.homedir(), '.config', 'Trae', 'User', 'workspaceStorage');
  }

  /**
   * Get path to Trae's global storage database
   */
  private get globalStoragePath(): string {
    const platform = os.platform();
    if (platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'globalStorage', 'state.vscdb');
    }
    if (platform === 'win32') {
      return path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'User', 'globalStorage', 'state.vscdb');
    }
    return path.join(os.homedir(), '.config', 'Trae', 'User', 'globalStorage', 'state.vscdb');
  }

  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];
    const basePath = this.storagePath;

    if (!fs.existsSync(basePath)) {
      return sessions;
    }

    if (!this.ensureSqliteAvailable()) {
      return sessions;
    }

    const workspaceDirs = this.safeReadDir(basePath);
    const normalizedProjectPath = path.resolve(projectPath);

    for (const dir of workspaceDirs) {
      try {
        const workspaceDir = path.join(basePath, dir);
        const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
        if (!fs.existsSync(workspaceJsonPath)) {
          continue;
        }

        const workspaceRoots = this.readWorkspaceRoots(workspaceJsonPath);
        if (workspaceRoots.length === 0) continue;

        const matchesProject = workspaceRoots.some(root => this.pathsOverlap(root, normalizedProjectPath));
        if (!matchesProject) {
          continue;
        }

        const workspaceDbPath = path.join(workspaceDir, 'state.vscdb');
        if (!fs.existsSync(workspaceDbPath)) {
          continue;
        }

        // 1. 读取 Session 列表
        const sessionListRaw = this.readSqliteValue(workspaceDbPath, 'memento/icube-ai-agent-storage');
        if (!sessionListRaw) {
          continue;
        }

        const sessionData = this.safeJsonParse<{ list: TraeSessionSummary[] }>(sessionListRaw);
        if (!sessionData || !Array.isArray(sessionData.list)) {
            continue;
        }

        // 3. 读取模型映射
        const modelMap = this.readModelMap(workspaceDbPath);

        // 4. 读取默认模型（作为 fallback）
        const defaultModel = this.readDefaultModel(workspaceDbPath);

        for (const session of sessionData.list) {
            if (!session.sessionId) continue;

            const model = modelMap.get(session.sessionId) || defaultModel;
            const gitRepoPath = this.getGitSnapshotPath(session.sessionId);

            let changes: FileChange[] = [];
            let sessionTimestamp = new Date();

            if (gitRepoPath && fs.existsSync(gitRepoPath)) {
              const result = this.analyzeGitChanges(gitRepoPath, normalizedProjectPath, session.sessionId, model);
              changes = result.changes;
              sessionTimestamp = result.timestamp;
            }

            // Skip sessions with no changes
            if (changes.length === 0) continue;

            sessions.push({
            id: `trae-${session.sessionId}`,
            tool: this.tool,
            timestamp: sessionTimestamp,
            projectPath: normalizedProjectPath,
            changes,
            totalFilesChanged: new Set(changes.map(c => c.filePath)).size,
            totalLinesAdded: changes.reduce((sum, c) => sum + c.linesAdded, 0),
            totalLinesRemoved: changes.reduce((sum, c) => sum + c.linesRemoved, 0),
            model,
            // Trae sessions with changes are always code contributions
            sessionType: 'code_contribution' as SessionType,
            });
        }
      } catch (err) {
        // ignore errors
      }
    }
    
    return sessions;
  }

  private getGitSnapshotPath(sessionId: string): string | null {
    const platform = os.platform();
    let modularDataPath = '';
    if (platform === 'darwin') {
      modularDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'ModularData');
    } else if (platform === 'win32') {
      modularDataPath = path.join(os.homedir(), 'AppData', 'Roaming', 'Trae', 'ModularData');
    } else {
      modularDataPath = path.join(os.homedir(), '.config', 'Trae', 'ModularData');
    }

    const snapshotPath = path.join(modularDataPath, 'ai-agent', 'snapshot', sessionId, 'v2');
    return fs.existsSync(snapshotPath) ? snapshotPath : null;
  }

  private analyzeGitChanges(
    gitRepoPath: string,
    projectPath: string,
    sessionId: string,
    model: string,
    extractLineContent: boolean = false
  ): { changes: FileChange[]; timestamp: Date } {
    const changes: FileChange[] = [];
    let sessionTimestamp = new Date();

    try {
      // Get all tags sorted by creation time
      const tags = spawnSync('git', ['tag', '--sort=creatordate'], {
        cwd: gitRepoPath,
        encoding: 'utf8'
      }).stdout.split('\n').filter(t => t.trim());

      // Find chain-start
      const chainStartTag = tags.find(t => t.startsWith('chain-start-'));
      
      // Get all files ever touched in this session's disk/content
      // [修复说明] 为什么我们需要遍历所有文件而不是直接 diff chain-start 和最后一次 tag？
      // 因为 Trae 的快照机制有一个特点：如果 AI 在长会话中期创建或修改了文件，但在会话结束前该文件被关闭或脱离了追踪，
      // 那么在最后一次 tag 的快照里，这个文件可能会消失（相当于回到了 chain-start 的状态）。
      // 导致如果只对比首尾 tag，这个文件的改动会被误判为 0。
      // 因此，这里的逻辑改为：找出这个会话中曾出现过的所有文件，然后为【每个文件】单独找到它“最后一次实际存在的 tag 快照”，
      // 用这个特定的最后一次 tag 与 chain-start 进行对比，从而找回所有真实的 AI 贡献。
      const allFilesOutput = spawnSync('git', ['log', '--all', '--name-only', '--pretty=format:', '--', 'disk/content/*'], {
        cwd: gitRepoPath,
        encoding: 'utf8'
      }).stdout;
      
      const allFiles = Array.from(new Set(
        (allFilesOutput || '').split('\n')
          .map(f => f.trim())
          .filter(f => f.startsWith('disk/content/'))
      ));

      // Combine toolcall and after-chat tags in chronological order
      const relevantTags = tags.filter(t => t.startsWith('toolcall-') || t.startsWith('after-chat-turn-'));
      if (relevantTags.length === 0 || !chainStartTag) {
        return { changes, timestamp: sessionTimestamp };
      }

      // Get the session timestamp from the very last tag
      const finalEndTag = relevantTags[relevantTags.length - 1];
      
      // [P0优化] 一次性获取所有 relevantTags 的时间戳，避免在文件循环内重复调用
      const tagTimestampMap = new Map<string, Date>();
      for (const tag of relevantTags) {
        const dateResult = spawnSync('git', ['tag', '--format=%(creatordate:iso)', '-l', tag], {
          cwd: gitRepoPath,
          encoding: 'utf8'
        });
        if (dateResult.stdout) {
          const dateStr = dateResult.stdout.trim();
          if (dateStr) tagTimestampMap.set(tag, new Date(dateStr));
        }
      }
      
      if (tagTimestampMap.has(finalEndTag)) {
        sessionTimestamp = tagTimestampMap.get(finalEndTag)!;
      }

      // [P1优化] 提前获取项目文件列表并缓存，避免在文件循环内重复调用 git ls-files
      const projectFilesByLower = new Map<string, string>();
      try {
        const lsOutput = spawnSync('git', ['ls-files'], { cwd: projectPath, encoding: 'utf8' }).stdout;
        for (const f of lsOutput.split('\n')) {
          const trimmed = f.trim();
          if (trimmed) projectFilesByLower.set(trimmed.toLowerCase(), trimmed);
        }
      } catch {
        // ignore - project may not be a git repo
      }

      // [P1优化] 使用 O(M) 算法查找 lastTag，而不是 O(N×M)
      // 步骤 1: 构建 tag -> Set<files> 映射 (遍历 tags 一次)
      const tagToFilesMap = new Map<string, Set<string>>();
      for (const tag of relevantTags) {
        const filesInTag = new Set<string>();
        const lsTreeOutput = spawnSync('git', ['ls-tree', '-r', '--name-only', tag, 'disk/content'], {
          cwd: gitRepoPath,
          encoding: 'utf8'
        }).stdout;
        
        for (const f of lsTreeOutput.split('\n')) {
          const trimmed = f.trim();
          if (trimmed) filesInTag.add(trimmed);
        }
        tagToFilesMap.set(tag, filesInTag);
      }

      // 步骤 2: 构建 file -> lastTag 映射 (从后向前遍历 tags，只设置第一次遇到的)
      const fileToLastTagMap = new Map<string, string>();
      for (let i = relevantTags.length - 1; i >= 0; i--) {
        const tag = relevantTags[i];
        const filesInTag = tagToFilesMap.get(tag);
        if (!filesInTag) continue;
        
        for (const filePath of filesInTag) {
          // 只设置还没有 lastTag 的文件（从后向前确保找到最近的）
          if (!fileToLastTagMap.has(filePath)) {
            fileToLastTagMap.set(filePath, tag);
          }
        }
      }

      for (const filePath of allFiles) {
        // [P1优化] 直接从 Map 获取 lastTag，O(1) 复杂度
        const lastTagWithFile = fileToLastTagMap.get(filePath) || null;

        if (!lastTagWithFile) continue;

        // Get the specific timestamp for this file's last change (使用缓存的 tagTimestampMap)
        let fileTimestamp = sessionTimestamp;
        const cachedTimestamp = tagTimestampMap.get(lastTagWithFile);
        if (cachedTimestamp) {
          fileTimestamp = cachedTimestamp;
        }

        // Use git diff to get net changes between start and the last tag containing the file
        const diffOutput = spawnSync('git', ['diff', '--numstat', chainStartTag, lastTagWithFile, '--', filePath], {
          cwd: gitRepoPath,
          encoding: 'utf8'
        }).stdout;

        if (!diffOutput) continue;

        const lines = diffOutput.trim().split('\n');
        for (const line of lines) {
          const parts = line.split('\t');
          if (parts.length < 3) continue;

          const added = parseInt(parts[0], 10) || 0;
          const removed = parseInt(parts[1], 10) || 0;
          
          let relativePath = filePath;
          if (filePath.startsWith('disk/content/')) {
            relativePath = filePath.substring('disk/content/'.length);
          } else {
            continue;
          }

          // [P0优化] 使用预缓存的 projectFilesByLower 进行大小写不敏感匹配
          const matchedRealFile = projectFilesByLower.get(relativePath.toLowerCase());
          if (matchedRealFile) {
            relativePath = matchedRealFile;
          }

          // Skip files with no changes
          if (added === 0 && removed === 0) continue;

          let addedLines: string[] = [];
          let removedLines: string[] = [];
          let realAdded = added;
          let realRemoved = removed;

          // Try to get more accurate diff by comparing base/ vs disk/ if available
          const basePath = filePath.replace(/^disk\//, 'base/');
          
          // Check if base version exists in the end tag
          let hasBase = false;
          try {
             const checkBase = spawnSync('git', ['cat-file', '-e', `${lastTagWithFile}:${basePath}`], {
               cwd: gitRepoPath,
               stdio: 'ignore'
             });
             hasBase = checkBase.status === 0;

             if (hasBase) {
                const checkBaseStart = spawnSync('git', ['cat-file', '-e', `${chainStartTag}:${basePath}`], {
                   cwd: gitRepoPath,
                   stdio: 'ignore'
                });
                if (checkBaseStart.status !== 0) {
                   hasBase = false;
                }
             }
          } catch {
             hasBase = false;
          }

          if (hasBase) {
            try {
              const numstat = spawnSync('git', ['diff', '--numstat', `${lastTagWithFile}:${basePath}`, `${lastTagWithFile}:${filePath}`], {
                cwd: gitRepoPath,
                encoding: 'utf8'
              });
              
              if (numstat.stdout) {
                const parts = numstat.stdout.trim().split(/\s+/);
                if (parts.length >= 2) {
                  realAdded = parseInt(parts[0], 10) || 0;
                  realRemoved = parseInt(parts[1], 10) || 0;
                }
              }

              // [P1优化] 仅在 extractLineContent 为 true 时才执行 diff + 解析行内容
              if (extractLineContent && (realAdded > 0 || realRemoved > 0)) {
                const fileDiff = spawnSync('git', ['diff', '-U0', `${lastTagWithFile}:${basePath}`, `${lastTagWithFile}:${filePath}`], {
                  cwd: gitRepoPath,
                  encoding: 'utf8'
                }).stdout;
                addedLines = this.extractAddedLinesFromDiff(fileDiff);
                removedLines = this.extractRemovedLinesFromDiff(fileDiff);
              }
            } catch (e) {}
          } else if (added > 0 && extractLineContent) {
             try {
               const fileDiff = spawnSync('git', ['diff', '-U0', chainStartTag, lastTagWithFile, '--', filePath], {
                 cwd: gitRepoPath,
                 encoding: 'utf8'
               }).stdout;
               addedLines = this.extractAddedLinesFromDiff(fileDiff);
               removedLines = this.extractRemovedLinesFromDiff(fileDiff);
             } catch {}
          }

          changes.push({
            filePath: relativePath,
            linesAdded: realAdded,
            linesRemoved: realRemoved,
            changeType: realAdded > 0 && realRemoved === 0 ? 'create' : 'modify',
            timestamp: fileTimestamp,
            tool: this.tool,
            model,
            addedLines: addedLines.length > 0 ? addedLines : undefined,
            removedLinesContent: removedLines.length > 0 ? removedLines : undefined
          });
        }
      }
    } catch (e) {
      // console.error('Error analyzing git changes', e);
    }

    return { changes, timestamp: sessionTimestamp };
  }

  parseSessionFile(_filePath: string, _projectPath: string): AISession | null {
    return null;
  }

  isAvailable(): boolean {
    if (!super.isAvailable()) return false;
    return this.ensureSqliteAvailable();
  }

  private ensureSqliteAvailable(): boolean {
    if (this.sqliteMode !== null) return this.sqliteMode !== 'none';
    try {
      const result = spawnSync('sqlite3', ['-version'], { encoding: 'utf8' });
      if (result.status === 0 && !result.error) {
        this.sqliteMode = 'cli';
        return true;
      }
    } catch {
      // ignore
    }
    this.sqliteMode = 'none';
    this.warnMissingSqlite();
    return false;
  }

  private warnMissingSqlite(): void {
    if (this.warnedMissingSqlite) return;
    this.warnedMissingSqlite = true;
    // eslint-disable-next-line no-console
    console.warn('[ai-contribute] Trae scanner requires sqlite3 CLI. Install sqlite3 to enable Trae stats.');
  }

  private safeReadDir(dirPath: string): string[] {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return [];
    }
  }

  private readWorkspaceRoots(workspaceJsonPath: string): string[] {
    const data = this.readJsonFile(workspaceJsonPath);
    if (!data) return [];

    const roots: string[] = [];
    if (typeof data.folder === 'string') {
      const folderPath = this.fileUriToPath(data.folder) ?? data.folder;
      roots.push(path.resolve(folderPath));
    }

    if (typeof data.workspace === 'string') {
      const workspaceFilePath = this.fileUriToPath(data.workspace) ?? data.workspace;
      roots.push(...this.readWorkspaceFileRoots(workspaceFilePath));
    }

    return roots.filter(Boolean);
  }

  private readWorkspaceFileRoots(workspaceFilePath: string): string[] {
    const workspaceData = this.readJsonFile(workspaceFilePath);
    if (!workspaceData || !Array.isArray(workspaceData.folders)) return [];

    const baseDir = path.dirname(workspaceFilePath);
    const roots: string[] = [];

    for (const entry of workspaceData.folders) {
      if (!entry) continue;
      if (typeof entry.path === 'string') {
        const resolved = path.isAbsolute(entry.path)
          ? entry.path
          : path.resolve(baseDir, entry.path);
        roots.push(resolved);
        continue;
      }
      if (typeof entry.uri === 'string') {
        const resolved = this.fileUriToPath(entry.uri);
        if (resolved) roots.push(resolved);
      }
    }

    return roots;
  }

  private fileUriToPath(uri: string): string | null {
    if (!uri) return null;
    if (!uri.startsWith('file://')) {
      return uri;
    }
    try {
      const url = new URL(uri);
      if (url.protocol !== 'file:') return null;
      let filePath = decodeURIComponent(url.pathname);
      if (os.platform() === 'win32' && filePath.startsWith('/')) {
        filePath = filePath.slice(1);
      }
      return filePath;
    } catch {
      return null;
    }
  }

  private pathsOverlap(a: string, b: string): boolean {
    const first = this.normalizeForCompare(a);
    const second = this.normalizeForCompare(b);
    if (first === second) return true;
    if (first.startsWith(second + '/')) return true;
    if (second.startsWith(first + '/')) return true;
    return false;
  }

  private normalizeForCompare(p: string): string {
    let normalized = this.toForwardSlash(path.resolve(p)).replace(/\/+$/, '');
    if (os.platform() === 'win32' || os.platform() === 'darwin') {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }

  private readSqliteValue(dbPath: string, key: string): string | null {
    const escaped = key.replace(/'/g, "''");
    // Trae's ItemTable stores keys as text
    return this.querySqliteValue(
      dbPath,
      `select value from ItemTable where key='${escaped}' limit 1;`
    );
  }

  private readModelMap(dbPath: string): Map<string, string> {
    const map = new Map<string, string>();
    // 查询所有包含 modelMap 的 key
    // 典型的 key 格式: "7581719317113947148_ai-chat:sessionRelation:modelMap"
    // Value 格式: {"SESSION_ID": {"solo_builder": "MODEL_NAME", "dev_builder": "MODEL_NAME"}, ...}

    const rows = this.querySqliteRows(
      dbPath,
      "select value from ItemTable where key like '%ai-chat:sessionRelation:modelMap%'"
    );

    // Session IDs are hex strings (e.g., "697c3eee3cc3ce6e16f38dde")
    const sessionIdPattern = /^[0-9a-f]{20,}$/i;

    for (const row of rows) {
      const data = this.safeJsonParse<Record<string, any>>(row);
      if (data) {
        for (const [sessionId, modelInfo] of Object.entries(data)) {
          // Skip invalid keys that are not session IDs (e.g., "dev_builder", "solo_builder")
          if (!sessionIdPattern.test(sessionId)) {
            continue;
          }

          let name = 'Unknown Model';
          if (typeof modelInfo === 'string') {
            name = this.formatModelName(modelInfo);
          } else if (typeof modelInfo === 'object' && modelInfo !== null) {
            // Trae stores model as {solo_builder: "model-name", dev_builder: "model-name"}
            const rawName = modelInfo.solo_builder || modelInfo.dev_builder ||
                   modelInfo.name || modelInfo.modelName ||
                   modelInfo.id || modelInfo.modelId || 'Unknown Model';
            name = this.formatModelName(rawName);
          }
          map.set(sessionId, name);
        }
      }
    }

    return map;
  }

  /**
   * Read the default/selected model from workspace database
   * Used as fallback when a session doesn't have a model mapping
   * Also checks global storage as final fallback
   */
  private readDefaultModel(dbPath: string): string {
    // 1. Try workspace selected_model
    const raw = this.querySqliteValue(
      dbPath,
      "select value from ItemTable where key like '%AI.agent.model.selected_model' limit 1;"
    );

    if (raw) {
      const data = this.safeJsonParse<{ name?: string; display_name?: string }>(raw);
      if (data) {
        const modelName = data.display_name || data.name;
        if (modelName) {
          return this.formatModelName(modelName);
        }
      }
    }

    // 2. Fallback to global storage selected_model
    const globalDbPath = this.globalStoragePath;
    if (fs.existsSync(globalDbPath)) {
      const globalRaw = this.querySqliteValue(
        globalDbPath,
        "select value from ItemTable where key like '%AI.agent.model.selected_model' limit 1;"
      );

      if (globalRaw) {
        const data = this.safeJsonParse<{ name?: string; display_name?: string }>(globalRaw);
        if (data) {
          const modelName = data.display_name || data.name;
          if (modelName) {
            return this.formatModelName(modelName);
          }
        }
      }

      // 3. Fallback to global globalModelMap
      const globalModelMapRaw = this.querySqliteValue(
        globalDbPath,
        "select value from ItemTable where key like '%globalModelMap%' limit 1;"
      );

      if (globalModelMapRaw) {
        const data = this.safeJsonParse<{ solo_builder?: string; dev_builder?: string }>(globalModelMapRaw);
        if (data) {
          const modelName = data.solo_builder || data.dev_builder;
          if (modelName) {
            return this.formatModelName(modelName);
          }
        }
      }
    }

    return 'Unknown Model';
  }

  /**
   * Format Trae's internal model name to a friendly display name
   * E.g., "1_-_gemini-3-pro" -> "Gemini 3 Pro"
   */
  private formatModelName(name: string): string {
    if (!name || name === 'Unknown Model') return name;

    // Remove prefix like "1_-_" or "2_-_"
    let formatted = name.replace(/^\d+_-_/, '');

    // Convert kebab-case to title case
    formatted = formatted
      .split('-')
      .map(word => {
        // Capitalize first letter, keep rest lowercase
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(' ');

    // Handle special cases
    const specialCases: Record<string, string> = {
      'Gpt': 'GPT',
      'Gpt 4': 'GPT-4',
      'Gpt 4o': 'GPT-4o',
      'Gpt 5': 'GPT-5',
      'Claude 3 5': 'Claude 3.5',
      'Claude 3 5 Sonnet': 'Claude 3.5 Sonnet',
      'Deepseek': 'DeepSeek',
    };

    for (const [key, value] of Object.entries(specialCases)) {
      formatted = formatted.replace(new RegExp(key, 'gi'), value);
    }

    return formatted || name;
  }

  private querySqliteValue(dbPath: string, query: string): string | null {
    try {
      const result = spawnSync('sqlite3', ['-readonly', dbPath, query], { encoding: 'utf8' });
      if (result.error || result.status !== 0) {
        return null;
      }
      const output = result.stdout ? result.stdout.toString() : '';
      const trimmed = output.trimEnd();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  private querySqliteRows(dbPath: string, query: string): string[] {
    try {
      const result = spawnSync('sqlite3', ['-readonly', dbPath, query], { encoding: 'utf8' });
      if (result.error || result.status !== 0) {
        return [];
      }
      return result.stdout.split('\n').filter(line => line.trim().length > 0);
    } catch {
      return [];
    }
  }

  private safeJsonParse<T>(raw: string): T | null {
    try {
      return JSON.parse(raw.trim());
    } catch {
      return null;
    }
  }
}
