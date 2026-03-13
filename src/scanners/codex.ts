import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { AISession, AITool, FileChange } from '../types.js';
import { BaseScanner } from './base.js';

/**
 * Scanner for OpenAI Codex CLI sessions
 *
 * Codex CLI stores session data in:
 * ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 *
 * Each JSONL entry has a top-level `type` and `payload` field:
 * - type: "session_meta" | "turn_context" | "response_item" | "event_msg"
 * - turn_context entries contain { payload: { cwd, model, ... } }
 * - response_item entries with payload.type "custom_tool_call" contain
 *   apply_patch operations with a custom patch format
 * - response_item entries with payload.type "function_call" contain
 *   shell_command calls
 */
export class CodexScanner extends BaseScanner {
  get tool(): AITool {
    return AITool.CODEX;
  }

  get storagePath(): string {
    return '~/.codex/sessions';
  }

  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];
    const basePath = this.resolveStoragePath();

    if (!fs.existsSync(basePath)) {
      return sessions;
    }

    try {
      // Recursively find all JSONL files
      const files = glob.sync('**/*.jsonl', { cwd: basePath });

      for (const file of files) {
        const fullPath = path.join(basePath, file);
        const session = this.parseSessionFile(fullPath, projectPath);
        if (session && session.changes.length > 0) {
          sessions.push(session);
        }
      }
    } catch {
      // Ignore errors
    }

    return sessions;
  }

  parseSessionFile(filePath: string, projectPath: string): AISession | null {
    const changes: FileChange[] = [];
    let sessionTimestamp: Date | null = null;
    let sessionProjectPath: string | null = null;
    let sessionModel: string | undefined;
    let hasEntries = false;

    this.forEachJsonlEntry(filePath, entry => {
      hasEntries = true;
      const payload = entry.payload || {};

      // Extract timestamp
      if (!sessionTimestamp && entry.timestamp) {
        sessionTimestamp = new Date(entry.timestamp);
      }

      // Extract project path from turn_context or session_meta
      if (!sessionProjectPath) {
        if (entry.type === 'turn_context' && payload.cwd) {
          sessionProjectPath = payload.cwd;
        } else if (entry.type === 'session_meta' && payload.cwd) {
          sessionProjectPath = payload.cwd;
        }
      }

      // Extract model if available (turn_context/session_meta often include it)
      if (!sessionModel) {
        const rawModel = payload.model || payload.model_id || payload.modelId || payload.modelName;
        if (typeof rawModel === 'string' && rawModel) {
          sessionModel = rawModel;
        } else if (rawModel && typeof rawModel === 'object') {
          const modelName = rawModel.name || rawModel.id || rawModel.model;
          if (typeof modelName === 'string' && modelName) {
            sessionModel = modelName;
          }
        }
      }

      // Handle custom_tool_call (apply_patch) — the primary way Codex writes files
      if (entry.type === 'response_item' && payload.type === 'custom_tool_call') {
        const patchChanges = this.parseApplyPatch(payload, projectPath, sessionProjectPath, entry.timestamp);
        changes.push(...patchChanges);
        return;
      }

      // Handle function_call (shell_command with file writes)
      if (entry.type === 'response_item' && payload.type === 'function_call') {
        const funcName = (payload.name || '').toLowerCase();
        let args: any = {};
        try {
          args = typeof payload.arguments === 'string'
            ? JSON.parse(payload.arguments)
            : payload.arguments || {};
        } catch {
          return;
        }

        const change = this.parseFunctionCall(funcName, args, projectPath, sessionProjectPath, entry.timestamp);
        if (change) {
          changes.push(change);
        }
        return;
      }

      // Legacy format: top-level tool_calls / function_calls arrays
      const toolCalls = entry.tool_calls || entry.function_calls || [];
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          const change = this.parseToolCall(toolCall, projectPath, sessionProjectPath, entry.timestamp);
          if (change) {
            changes.push(change);
          }
        }
      }

      // Legacy: direct function format
      if (entry.function && entry.function.name) {
        const change = this.parseToolCall({ function: entry.function }, projectPath, sessionProjectPath, entry.timestamp);
        if (change) {
          changes.push(change);
        }
      }
    });

    // Filter: only include sessions that match the project path
    if (sessionProjectPath) {
      const normalizedSessionPath = path.resolve(sessionProjectPath);
      const normalizedProjectPath = path.resolve(projectPath);

      if (!this.pathsMatch(normalizedSessionPath, normalizedProjectPath)) {
        if (changes.length === 0) {
          return null;
        }
      }
    }

    if (!hasEntries || changes.length === 0) return null;

    return {
      id: this.generateSessionId(filePath),
      tool: this.tool,
      timestamp: sessionTimestamp || new Date(),
      projectPath,
      changes,
      totalFilesChanged: new Set(changes.map(c => c.filePath)).size,
      totalLinesAdded: changes.reduce((sum, c) => sum + c.linesAdded, 0),
      totalLinesRemoved: changes.reduce((sum, c) => sum + c.linesRemoved, 0),
      model: sessionModel,
    };
  }

  /**
   * Check if the session path belongs to the target project.
   * The session cwd must be exactly the project path or a subdirectory of it.
   */
  private pathsMatch(sessionPath: string, projectPath: string): boolean {
    const s = this.normForCompare(sessionPath);
    const p = this.normForCompare(projectPath);
    if (s === p) return true;
    // Session opened inside a subdirectory of the project
    if (s.startsWith(p + '/')) return true;
    return false;
  }

  /**
   * Normalize a path for comparison (trim trailing slash, normalize Windows case).
   */
  private normForCompare(p: string): string {
    let s = this.toForwardSlash(p).replace(/\/+$/, '');
    const isWindowsPath = /^[A-Za-z]:\//.test(s) || s.startsWith('//');
    if (isWindowsPath) {
      s = s.toLowerCase();
    }
    return s;
  }

  /**
   * Parse Codex apply_patch custom_tool_call entries.
   *
   * The patch format looks like:
   *   *** Begin Patch
   *   *** Update File: path/to/file.swift
   *   @@
   *    context line
   *   +added line
   *   -removed line
   *   *** Add File: path/to/new_file.swift
   *   +new file content
   *   *** End Patch
   */
  private parseApplyPatch(
    payload: any,
    projectPath: string,
    sessionCwd: string | null,
    timestamp?: string
  ): FileChange[] {
    const name = (payload.name || '').toLowerCase();
    if (name !== 'apply_patch') return [];

    const input = this.resolvePatchInput(payload);
    if (!input) return [];

    const changes: FileChange[] = [];
    const lines = input.split(/\r?\n/);

    let currentFile: string | null = null;
    let changeType: 'create' | 'modify' | 'delete' = 'modify';
    let linesAdded = 0;
    let linesRemoved = 0;
    let addedLines: string[] = [];

    const flushFile = () => {
      if (currentFile && (linesAdded > 0 || linesRemoved > 0)) {
        const resolvedPath = this.resolveFilePath(currentFile, projectPath, sessionCwd);
        if (resolvedPath) {
          changes.push({
            filePath: resolvedPath,
            linesAdded,
            linesRemoved,
            changeType,
            timestamp: timestamp ? new Date(timestamp) : new Date(),
            tool: this.tool,
            content: addedLines.join('\n'),
            addedLines,
          });
        }
      }
      currentFile = null;
      linesAdded = 0;
      linesRemoved = 0;
      changeType = 'modify';
      addedLines = [];
    };

    for (const line of lines) {
      if (line.startsWith('*** Update File:')) {
        flushFile();
        currentFile = line.replace('*** Update File:', '').trim();
        changeType = 'modify';
      } else if (line.startsWith('*** Add File:')) {
        flushFile();
        currentFile = line.replace('*** Add File:', '').trim();
        changeType = 'create';
      } else if (line.startsWith('*** Delete File:')) {
        flushFile();
        currentFile = line.replace('*** Delete File:', '').trim();
        changeType = 'delete';
      } else if (line.startsWith('*** ')) {
        // Other directives (Begin Patch, End Patch, etc.) — skip
        continue;
      } else if (line.startsWith('@@')) {
        // Hunk header — skip
        continue;
      } else if (currentFile) {
        if (line.startsWith('+')) {
          linesAdded++;
          addedLines.push(line.substring(1));
        } else if (line.startsWith('-')) {
          linesRemoved++;
        }
        // Context lines (starting with ' ') are ignored
      }
    }

    flushFile();
    return changes;
  }

  /**
   * Resolve the patch text from a Codex custom_tool_call payload.
   */
  private resolvePatchInput(payload: any): string | null {
    const rawInput = payload?.input;
    if (!rawInput) return null;
    if (typeof rawInput === 'string') return rawInput;
    if (Array.isArray(rawInput)) {
      const parts = rawInput.filter(part => typeof part === 'string');
      return parts.length > 0 ? parts.join('\n') : null;
    }
    if (typeof rawInput === 'object') {
      const patch =
        rawInput.patch ||
        rawInput.diff ||
        rawInput.text ||
        rawInput.content ||
        rawInput.input;
      return typeof patch === 'string' && patch ? patch : null;
    }
    return null;
  }

  /**
   * Resolve a file path against session cwd, then normalize to project-relative.
   */
  private resolveFilePath(
    filePath: string,
    projectPath: string,
    sessionCwd: string | null
  ): string | null {
    let resolvedPath = filePath;
    if (!path.isAbsolute(resolvedPath) && sessionCwd) {
      resolvedPath = path.resolve(sessionCwd, resolvedPath);
    }

    if (!this.isProjectFile(resolvedPath, projectPath)) {
      return null;
    }

    return this.normalizePath(resolvedPath, projectPath);
  }

  /**
   * Parse a function_call payload (e.g. shell_command with file write operations)
   */
  private parseFunctionCall(
    funcName: string,
    args: any,
    projectPath: string,
    sessionCwd: string | null,
    timestamp?: string
  ): FileChange | null {
    const writeOps = ['write_file', 'create_file', 'write', 'save_file', 'create', 'writefile'];
    const editOps = ['edit_file', 'apply_diff', 'patch', 'replace_in_file', 'edit', 'update_file', 'modify_file'];

    let filePath = args.path || args.file_path || args.filename || args.file || args.target || '';
    let newContent = args.content || args.new_content || args.text || args.code || args.data || '';
    let oldContent = args.old_content || args.original || args.old_text || '';

    if (!filePath) return null;
    const resolvedPath = this.resolveFilePath(filePath, projectPath, sessionCwd);
    if (!resolvedPath) return null;

    let changeType: 'create' | 'modify' | 'delete' = 'modify';
    let linesAdded = 0;
    let linesRemoved = 0;
    let addedLines: string[] = [];

    if (writeOps.includes(funcName)) {
      changeType = oldContent ? 'modify' : 'create';
      const stats = this.diffLineCounts(oldContent, newContent);
      linesAdded = stats.added;
      linesRemoved = stats.removed;
      if (oldContent && newContent) {
        addedLines = this.diffAddedLines(oldContent, newContent);
      } else {
        addedLines = this.extractNonEmptyLines(newContent);
      }
    } else if (editOps.includes(funcName)) {
      changeType = 'modify';
      if ((funcName === 'apply_diff' || funcName === 'patch') && args.diff) {
        const diffStats = this.parseDiff(args.diff);
        linesAdded = diffStats.added;
        linesRemoved = diffStats.removed;
        addedLines = this.extractAddedLinesFromDiff(args.diff);
      } else if (oldContent && newContent) {
        const stats = this.diffLineCounts(oldContent, newContent);
        linesAdded = stats.added;
        linesRemoved = stats.removed;
        addedLines = this.diffAddedLines(oldContent, newContent);
      } else {
        const stats = this.diffLineCounts(oldContent, newContent);
        linesAdded = stats.added;
        linesRemoved = stats.removed;
        addedLines = this.extractNonEmptyLines(newContent);
      }
    } else {
      return null;
    }

    if (linesAdded === 0 && linesRemoved === 0) return null;

    return {
      filePath: resolvedPath,
      linesAdded,
      linesRemoved,
      changeType,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      tool: this.tool,
      content: newContent,
      addedLines,
    };
  }

  /**
   * Parse a legacy tool_call object to extract file changes
   */
  private parseToolCall(
    toolCall: any,
    projectPath: string,
    sessionCwd: string | null,
    timestamp?: string
  ): FileChange | null {
    const func = toolCall.function;
    if (!func) return null;

    const funcName = (func.name || '').toLowerCase();

    let args: any = {};
    try {
      if (typeof func.arguments === 'string') {
        args = JSON.parse(func.arguments);
      } else if (typeof func.arguments === 'object') {
        args = func.arguments || {};
      }
    } catch {
      return null;
    }

    return this.parseFunctionCall(funcName, args, projectPath, sessionCwd, timestamp);
  }

  /**
   * Parse a unified diff to count added/removed lines
   */
  private parseDiff(diff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;

    const lines = diff.split('\n');
    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        added++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removed++;
      }
    }

    return { added, removed };
  }
}
