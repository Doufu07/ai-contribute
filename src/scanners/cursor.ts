import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { AISession, AITool, FileChange } from '../types.js';
import { BaseScanner } from './base.js';

type ComposerSummary = {
  composerId: string;
  createdAt?: number;
  lastUpdatedAt?: number;
  name?: string;
};

type FileAccumulator = {
  filePath: string;
  added: number;
  removed: number;
  addedLines: string[];
};

type SqlJsCache = {
  mode: 'workspace' | 'global';
  workspaceValues: Map<string, string>;
  composerData: Map<string, string>;
  composerDataLoaded: boolean;
  codeBlockDiffByComposer: Map<string, Map<string, string>>;
};

// CommonJS compatibility
declare const require: any;

/**
 * Scanner for Cursor sessions stored in VS Code-style SQLite databases.
 *
 * Workspace metadata:
 *   ~/Library/Application Support/Cursor/User/workspaceStorage/<id>/state.vscdb
 * Global content (per-composer):
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 */
export class CursorScanner extends BaseScanner {
  private sqliteMode: 'cli' | 'sqljs' | 'none' | null = null;
  private warnedMissingSqlite = false;
  private nodeRequire = require;
  private sqlJsCache = new Map<string, SqlJsCache>();

  get tool(): AITool {
    return AITool.CURSOR;
  }

  get storagePath(): string {
    const platform = os.platform();
    if (platform === 'darwin') {
      return '~/Library/Application Support/Cursor/User/workspaceStorage';
    }
    if (platform === 'win32') {
      return '~/AppData/Roaming/Cursor/User/workspaceStorage';
    }
    return '~/.config/Cursor/User/workspaceStorage';
  }

  /**
   * Scan Cursor workspace storage for sessions affecting the project.
   */
  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];
    const basePath = this.resolveStoragePath();
    const globalDbPath = this.getGlobalStorageDbPath();

    if (!fs.existsSync(basePath) || !fs.existsSync(globalDbPath)) {
      return sessions;
    }

    if (!this.ensureSqliteAvailable()) {
      return sessions;
    }

    const workspaceDirs = this.safeReadDir(basePath);
    const normalizedProjectPath = path.resolve(projectPath);
    const seenComposerIds = new Set<string>();

    for (const dir of workspaceDirs) {
      const workspaceDir = path.join(basePath, dir);
      const workspaceJsonPath = path.join(workspaceDir, 'workspace.json');
      if (!fs.existsSync(workspaceJsonPath)) continue;

      const workspaceRoots = this.readWorkspaceRoots(workspaceJsonPath);
      if (workspaceRoots.length === 0) continue;

      const matchesProject = workspaceRoots.some(root => this.pathsOverlap(root, normalizedProjectPath));
      if (!matchesProject) continue;

      const workspaceDbPath = path.join(workspaceDir, 'state.vscdb');
      if (!fs.existsSync(workspaceDbPath)) continue;

      const composerSummaries = this.readComposerSummaries(workspaceDbPath);
      if (composerSummaries.length === 0) continue;

      for (const summary of composerSummaries) {
        if (!summary.composerId || seenComposerIds.has(summary.composerId)) continue;
        seenComposerIds.add(summary.composerId);

        const composerData = this.readComposerData(globalDbPath, summary.composerId);
        if (!composerData) continue;

        const timestamp = this.getComposerTimestamp(composerData, summary);
        const model = this.extractModelName(composerData);
        const changes = this.buildChangesFromComposerData(
          summary.composerId,
          composerData,
          normalizedProjectPath,
          globalDbPath,
          timestamp,
          model
        );

        if (changes.length === 0) continue;

        sessions.push({
          id: `cursor-${summary.composerId}`,
          tool: this.tool,
          timestamp,
          projectPath: normalizedProjectPath,
          changes,
          totalFilesChanged: new Set(changes.map(c => c.filePath)).size,
          totalLinesAdded: changes.reduce((sum, c) => sum + c.linesAdded, 0),
          totalLinesRemoved: changes.reduce((sum, c) => sum + c.linesRemoved, 0),
          model,
        });
      }
    }

    return sessions;
  }

  /**
   * Cursor scanning is driven by workspace + global databases rather than session files.
   */
  parseSessionFile(_filePath: string, _projectPath: string): AISession | null {
    return null;
  }

  /**
   * Check whether Cursor data and SQLite access are available.
   */
  isAvailable(): boolean {
    if (!super.isAvailable()) return false;
    const globalDbPath = this.getGlobalStorageDbPath();
    if (!fs.existsSync(globalDbPath)) return false;
    return this.ensureSqliteAvailable();
  }

  private getGlobalStorageDbPath(): string {
    const platform = os.platform();
    if (platform === 'darwin') {
      return path.join(this.homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
    if (platform === 'win32') {
      return path.join(this.homeDir, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    }
    return path.join(this.homeDir, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
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
      // ignore and fall back
    }

    if (this.isSqlJsAvailable()) {
      this.sqliteMode = 'sqljs';
      return true;
    }

    this.sqliteMode = 'none';
    this.warnMissingSqlite();
    return false;
  }

  private warnMissingSqlite(): void {
    if (this.warnedMissingSqlite) return;
    this.warnedMissingSqlite = true;
    // eslint-disable-next-line no-console
    console.warn('[ai-contribute] Cursor scanner requires sqlite3 CLI or the sql.js dependency. Install sqlite3 to enable Cursor stats.');
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

  private extractUriPath(input: unknown): string | null {
    if (!input) return null;
    if (typeof input === 'string') {
      return this.fileUriToPath(input) ?? null;
    }
    if (typeof input === 'object') {
      const record = input as { fsPath?: string; path?: string; external?: string };
      if (record.fsPath) return record.fsPath;
      if (record.path) return record.path;
      if (record.external && typeof record.external === 'string') {
        return this.fileUriToPath(record.external);
      }
    }
    return null;
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
    if (os.platform() === 'win32') {
      normalized = normalized.toLowerCase();
    }
    return normalized;
  }

  private readComposerSummaries(workspaceDbPath: string): ComposerSummary[] {
    const raw = this.readCursorValue(workspaceDbPath, 'composer.composerData');
    if (!raw) return [];

    const data = this.safeJsonParse<{ allComposers?: any[] }>(raw);
    if (!data || !Array.isArray(data.allComposers)) return [];

    return data.allComposers
      .map(entry => ({
        composerId: entry?.composerId,
        createdAt: entry?.createdAt,
        lastUpdatedAt: entry?.lastUpdatedAt,
        name: entry?.name,
      }))
      .filter(entry => typeof entry.composerId === 'string');
  }

  private readComposerData(globalDbPath: string, composerId: string): any | null {
    const key = `composerData:${composerId}`;
    const raw = this.readCursorValue(globalDbPath, key);
    if (!raw) return null;
    return this.safeJsonParse<any>(raw);
  }

  private buildChangesFromComposerData(
    composerId: string,
    composerData: any,
    projectPath: string,
    globalDbPath: string,
    timestamp: Date,
    model?: string
  ): FileChange[] {
    const changes: FileChange[] = [];
    const fileChanges = new Map<string, FileAccumulator>();
    const createdFiles = new Set<string>();
    const originalContentByPath = new Map<string, string>();
    const originalContentByUri = new Map<string, string>();
    const diffCache = new Map<string, any>();
    const seenDiffIds = new Set<string>();

    const originalFileStates = composerData?.originalFileStates ?? {};
    if (originalFileStates && typeof originalFileStates === 'object') {
      for (const [uri, state] of Object.entries(originalFileStates as Record<string, unknown>)) {
        if (!state || typeof state !== 'object') continue;
        const stateRecord = state as { content?: unknown; isNewlyCreated?: boolean };
        const content = typeof stateRecord.content === 'string' ? stateRecord.content : '';
        if (typeof uri === 'string') {
          originalContentByUri.set(uri, content);
          const filePath = this.fileUriToPath(uri);
          if (filePath) {
            originalContentByPath.set(path.resolve(filePath), content);
          }
        }
        if (stateRecord.isNewlyCreated) {
          const filePath = this.fileUriToPath(uri);
          if (filePath) createdFiles.add(path.resolve(filePath));
        }
      }
    }

    const newlyCreatedFiles = composerData?.newlyCreatedFiles ?? [];
    if (Array.isArray(newlyCreatedFiles)) {
      for (const entry of newlyCreatedFiles) {
        const filePath = this.extractUriPath(entry?.uri);
        if (filePath) createdFiles.add(path.resolve(filePath));
      }
    }

    const codeBlockData = composerData?.codeBlockData ?? {};
    if (codeBlockData && typeof codeBlockData === 'object') {
      for (const [fileUriKey, rawBlocks] of Object.entries(codeBlockData)) {
        const blocks = this.flattenBlocks(rawBlocks);
        for (const block of blocks) {
          if (this.shouldSkipBlock(block)) continue;
          const diffId = typeof block.diffId === 'string' ? block.diffId : (typeof block.lastDiffId === 'string' ? block.lastDiffId : '');
          if (!diffId || seenDiffIds.has(diffId)) continue;
          seenDiffIds.add(diffId);

          const diff = this.readCodeBlockDiff(globalDbPath, composerId, diffId, diffCache);
          if (!diff) continue;

          const segments = this.extractDiffSegments(diff);
          if (segments.length === 0) continue;

          const filePath = this.resolveBlockFilePath(fileUriKey, block);
          if (!filePath) continue;
          const resolvedPath = path.resolve(filePath);
          if (!this.isProjectFile(resolvedPath, projectPath)) continue;

          const acc = this.getAccumulator(fileChanges, resolvedPath);
          const originalContent =
            originalContentByPath.get(resolvedPath) ??
            originalContentByUri.get(fileUriKey) ??
            '';
          this.applyDiffSegments(acc, segments, originalContent);
        }
      }
    }

    const fallbackTargets = new Set<string>();
    for (const filePath of originalContentByPath.keys()) fallbackTargets.add(filePath);
    for (const filePath of createdFiles) fallbackTargets.add(filePath);

    for (const filePath of fallbackTargets) {
      if (fileChanges.has(filePath)) continue;
      if (!this.isProjectFile(filePath, projectPath)) continue;
      const currentContent = this.readFileContentSafe(filePath);
      if (currentContent === null) continue;

      const originalContent = originalContentByPath.get(filePath) ?? '';
      const acc = this.getAccumulator(fileChanges, filePath);

      if (createdFiles.has(filePath) && !originalContent) {
        const addedLines = this.extractNonEmptyLines(currentContent);
        acc.added = addedLines.length;
        acc.addedLines.push(...addedLines);
      } else if (originalContent) {
        const counts = this.diffLineCounts(originalContent, currentContent);
        acc.added = counts.added;
        acc.removed = counts.removed;
        acc.addedLines.push(...this.diffAddedLines(originalContent, currentContent));
      }
    }

    for (const [filePath, acc] of fileChanges.entries()) {
      if (acc.added === 0 && acc.removed === 0) continue;
      const relativePath = this.normalizePath(filePath, projectPath);
      changes.push({
        filePath: relativePath,
        linesAdded: acc.added,
        linesRemoved: acc.removed,
        changeType: createdFiles.has(filePath) ? 'create' : 'modify',
        timestamp,
        tool: this.tool,
        addedLines: acc.addedLines.length > 0 ? acc.addedLines : undefined,
        model,
      });
    }

    return changes;
  }

  private flattenBlocks(rawBlocks: unknown): any[] {
    if (!rawBlocks) return [];
    if (Array.isArray(rawBlocks)) return rawBlocks;
    if (typeof rawBlocks === 'object') {
      return Object.values(rawBlocks as Record<string, any>);
    }
    return [];
  }

  private shouldSkipBlock(block: any): boolean {
    if (!block || typeof block !== 'object') return true;
    if (block.isNoOp === true) return true;
    const status = typeof block.status === 'string' ? block.status.toLowerCase() : '';
    if (status === 'aborted' || status === 'rejected' || status === 'error' || status === 'failed') {
      return true;
    }
    return false;
  }

  private resolveBlockFilePath(fileUriKey: string, block: any): string | null {
    const keyPath = this.extractUriPath(fileUriKey);
    if (keyPath) return keyPath;
    return this.extractUriPath(block?.uri);
  }

  private readCodeBlockDiff(
    globalDbPath: string,
    composerId: string,
    diffId: string,
    cache: Map<string, any>
  ): any | null {
    const cacheKey = `${composerId}:${diffId}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const key = `codeBlockDiff:${composerId}:${diffId}`;
    const raw = this.readCursorValue(globalDbPath, key);
    if (!raw) return null;
    const parsed = this.safeJsonParse<any>(raw);
    if (parsed) cache.set(cacheKey, parsed);
    return parsed;
  }

  private extractDiffSegments(diff: any): any[] {
    if (!diff || typeof diff !== 'object') return [];
    const candidates = [
      diff.newModelDiffWrtV0,
      diff.modelDiffWrtV0,
      diff.originalModelDiffWrtV0,
      diff.diff,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  private applyDiffSegments(acc: FileAccumulator, segments: any[], originalContent: string): void {
    const originalLines = originalContent ? this.splitLines(originalContent) : [];

    for (const segment of segments) {
      if (!segment || typeof segment !== 'object') continue;
      const modified: string[] = Array.isArray(segment.modified)
        ? segment.modified.filter((line: unknown): line is string => typeof line === 'string')
        : (typeof segment.modified === 'string' ? this.splitLines(segment.modified) : []);
      const addedLines = modified.filter((line: string) => line.length > 0);
      acc.added += addedLines.length;
      acc.addedLines.push(...addedLines);

      if (segment.original && typeof segment.original === 'object') {
        const start = typeof segment.original.startLineNumber === 'number'
          ? segment.original.startLineNumber
          : null;
        const end = typeof segment.original.endLineNumberExclusive === 'number'
          ? segment.original.endLineNumberExclusive
          : null;
        if (start !== null && end !== null && originalLines.length > 0) {
          const removed = this.countNonEmptyLinesInRange(originalLines, start, end);
          acc.removed += removed;
        }
      }
    }
  }

  private countNonEmptyLinesInRange(lines: string[], startLineNumber: number, endLineNumberExclusive: number): number {
    if (endLineNumberExclusive <= startLineNumber) return 0;
    const startIdx = Math.max(0, startLineNumber - 1);
    const endIdx = Math.max(startIdx, endLineNumberExclusive - 1);
    let count = 0;
    for (let i = startIdx; i < Math.min(endIdx, lines.length); i++) {
      if (lines[i].length > 0) count++;
    }
    return count;
  }

  private getAccumulator(map: Map<string, FileAccumulator>, filePath: string): FileAccumulator {
    let acc = map.get(filePath);
    if (!acc) {
      acc = { filePath, added: 0, removed: 0, addedLines: [] };
      map.set(filePath, acc);
    }
    return acc;
  }

  private readFileContentSafe(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }

  private getComposerTimestamp(composerData: any, summary: ComposerSummary): Date {
    const candidate = composerData?.createdAt ?? summary.createdAt ?? summary.lastUpdatedAt;
    if (typeof candidate === 'number') {
      return new Date(candidate);
    }
    return new Date();
  }

  private extractModelName(composerData: any): string | undefined {
    const modelConfig = composerData?.modelConfig;
    if (modelConfig && typeof modelConfig === 'object') {
      const name = modelConfig.modelName || modelConfig.modelId;
      if (typeof name === 'string' && name.trim().length > 0) {
        return name;
      }
    }
    const usageModel = composerData?.usageData?.model;
    if (typeof usageModel === 'string' && usageModel.trim().length > 0) {
      return usageModel;
    }
    return undefined;
  }

  private querySqliteValue(dbPath: string, query: string): string | null {
    if (this.sqliteMode === 'sqljs') {
      return this.querySqliteValueWithSqlJs(dbPath, query);
    }
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

  private querySqliteValueWithSqlJs(dbPath: string, query: string): string | null {
    const sqlJsPath = this.getSqlJsEntryPath();
    if (!sqlJsPath) return null;
    const script = [
      "const sqlJsPath = process.env.SQLJS_MODULE_PATH;",
      "if (!sqlJsPath) { process.exit(0); }",
      "const initSqlJs = require(sqlJsPath);",
      "const fs = require('fs');",
      "const path = require('path');",
      "const dbPath = process.env.SQLJS_DB_PATH;",
      "const query = process.env.SQLJS_QUERY;",
      "if (!dbPath || !query) { process.exit(0); }",
      "initSqlJs({ locateFile: file => path.join(path.dirname(sqlJsPath), file) })",
      "  .then(SQL => {",
      "    const data = fs.readFileSync(dbPath);",
      "    const db = new SQL.Database(data);",
      "    const res = db.exec(query);",
      "    if (!res || res.length === 0 || res[0].values.length === 0) return;",
      "    const val = res[0].values[0][0];",
      "    if (val === null || val === undefined) return;",
      "    process.stdout.write(String(val));",
      "  })",
      "  .catch(() => { process.exit(1); });",
    ].join('');

    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SQLJS_DB_PATH: dbPath,
          SQLJS_QUERY: query,
          SQLJS_MODULE_PATH: sqlJsPath,
        },
      });
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

  private isSqlJsAvailable(): boolean {
    return this.getSqlJsEntryPath() !== null;
  }

  private readCursorValue(dbPath: string, key: string): string | null {
    if (this.sqliteMode === 'sqljs') {
      return this.readCursorValueWithSqlJs(dbPath, key);
    }
    const escaped = this.escapeSqliteString(key);
    const cursorKv = this.querySqliteValue(
      dbPath,
      `select value from cursorDiskKV where key='${escaped}' limit 1;`
    );
    if (cursorKv) return cursorKv;
    return this.querySqliteValue(
      dbPath,
      `select cast(value as text) from ItemTable where key='${escaped}' limit 1;`
    );
  }

  private escapeSqliteString(value: string): string {
    return value.replace(/'/g, "''");
  }

  private readCursorValueWithSqlJs(dbPath: string, key: string): string | null {
    const cache = this.getSqlJsCache(dbPath);
    if (!cache) return null;

    if (cache.mode === 'workspace') {
      if (cache.workspaceValues.has(key)) return cache.workspaceValues.get(key) ?? null;
      const rows = this.querySqlitePairsWithSqlJs(
        dbPath,
        `select key, value from cursorDiskKV where key='${this.escapeSqliteString(key)}'
         union all
         select key, value from ItemTable where key='${this.escapeSqliteString(key)}'`
      );
      this.insertIfMissing(cache.workspaceValues, rows);
      return cache.workspaceValues.get(key) ?? null;
    }

    if (key.startsWith('composerData:')) {
      if (!cache.composerDataLoaded) {
        cache.composerDataLoaded = true;
        const rows = this.querySqlitePairsWithSqlJs(
          dbPath,
          "select key, value from cursorDiskKV where key like 'composerData:%' " +
          "union all select key, value from ItemTable where key like 'composerData:%'"
        );
        this.insertIfMissing(cache.composerData, rows);
      }
      return cache.composerData.get(key) ?? null;
    }

    if (key.startsWith('codeBlockDiff:')) {
      const composerId = key.split(':')[1];
      if (!composerId) return null;
      if (!cache.codeBlockDiffByComposer.has(composerId)) {
        const rows = this.querySqlitePairsWithSqlJs(
          dbPath,
          `select key, value from cursorDiskKV where key like 'codeBlockDiff:${this.escapeSqliteString(composerId)}:%'
           union all
           select key, value from ItemTable where key like 'codeBlockDiff:${this.escapeSqliteString(composerId)}:%'`
        );
        const map = new Map<string, string>();
        this.insertIfMissing(map, rows);
        cache.codeBlockDiffByComposer.set(composerId, map);
      }
      return cache.codeBlockDiffByComposer.get(composerId)?.get(key) ?? null;
    }

    return null;
  }

  private insertIfMissing(map: Map<string, string>, rows: Array<[string, string]>): void {
    for (const [rowKey, rowValue] of rows) {
      if (!map.has(rowKey)) {
        map.set(rowKey, rowValue);
      }
    }
  }

  private getSqlJsCache(dbPath: string): SqlJsCache | null {
    const existing = this.sqlJsCache.get(dbPath);
    if (existing) return existing;
    const cache: SqlJsCache = {
      mode: this.isGlobalDbPath(dbPath) ? 'global' : 'workspace',
      workspaceValues: new Map(),
      composerData: new Map(),
      composerDataLoaded: false,
      codeBlockDiffByComposer: new Map(),
    };
    this.sqlJsCache.set(dbPath, cache);
    return cache;
  }

  private isGlobalDbPath(dbPath: string): boolean {
    const normalized = path.resolve(dbPath);
    const globalPath = path.resolve(this.getGlobalStorageDbPath());
    if (os.platform() === 'win32') {
      return normalized.toLowerCase() === globalPath.toLowerCase();
    }
    return normalized === globalPath;
  }

  private querySqlitePairsWithSqlJs(dbPath: string, query: string): Array<[string, string]> {
    const sqlJsPath = this.getSqlJsEntryPath();
    if (!sqlJsPath) return [];
    const script = [
      "const sqlJsPath = process.env.SQLJS_MODULE_PATH;",
      "if (!sqlJsPath) { process.exit(0); }",
      "const initSqlJs = require(sqlJsPath);",
      "const fs = require('fs');",
      "const path = require('path');",
      "const dbPath = process.env.SQLJS_DB_PATH;",
      "const query = process.env.SQLJS_QUERY;",
      "if (!dbPath || !query) { process.exit(0); }",
      "const toStr = v => {",
      "  if (v === null || v === undefined) return null;",
      "  if (v instanceof Uint8Array) return Buffer.from(v).toString('utf8');",
      "  return String(v);",
      "};",
      "initSqlJs({ locateFile: file => path.join(path.dirname(sqlJsPath), file) })",
      "  .then(SQL => {",
      "    const data = fs.readFileSync(dbPath);",
      "    const db = new SQL.Database(data);",
      "    const res = db.exec(query);",
      "    const rows = res && res[0] && Array.isArray(res[0].values) ? res[0].values : [];",
      "    const out = rows.map(r => [String(r[0]), toStr(r[1])]).filter(r => typeof r[1] === 'string');",
      "    process.stdout.write(JSON.stringify(out));",
      "  })",
      "  .catch(() => { process.exit(1); });",
    ].join('');

    try {
      const result = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          SQLJS_DB_PATH: dbPath,
          SQLJS_QUERY: query,
          SQLJS_MODULE_PATH: sqlJsPath,
        },
        maxBuffer: 1024 * 1024 * 16,
      });
      if (result.error || result.status !== 0) {
        return [];
      }
      const output = result.stdout ? result.stdout.toString() : '';
      const parsed = JSON.parse(output);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((row: unknown): row is [string, string] => {
        return Array.isArray(row) && typeof row[0] === 'string' && typeof row[1] === 'string';
      });
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

  private getSqlJsEntryPath(): string | null {
    try {
      return this.nodeRequire.resolve('sql.js');
    } catch {
      return null;
    }
  }
}
