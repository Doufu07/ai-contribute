import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { glob } from 'glob';
import { AISession, AITool, FileChange } from '../types.js';
import { BaseScanner } from './base.js';

/**
 * Scanner for Gemini CLI sessions
 * 
 * Gemini CLI stores session data in:
 * ~/.gemini/tmp/<project_hash>/chats/*.json
 * or ~/.gemini/history/*.json
 * 
 * Each JSON file contains a complete conversation with messages
 * that include functionCall objects for file operations.
 */
export class GeminiScanner extends BaseScanner {
  get tool(): AITool {
    return AITool.GEMINI;
  }

  get storagePath(): string {
    return '~/.gemini';
  }

  /**
   * Hash project path to match Gemini's directory naming
   * Normalize to forward slashes so the hash is consistent across platforms
   */
  private hashProjectPath(projectPath: string): string {
    const normalized = this.toForwardSlash(projectPath);
    return crypto.createHash('md5').update(normalized).digest('hex').substring(0, 16);
  }

  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];
    const basePath = this.resolveStoragePath();
    
    if (!fs.existsSync(basePath)) {
      return sessions;
    }

    const possibleDirs: string[] = [];

    // Check tmp directory structure
    const tmpDir = path.join(basePath, 'tmp');
    if (fs.existsSync(tmpDir)) {
      try {
        const allDirs = fs.readdirSync(tmpDir).sort();
        for (const dir of allDirs) {
          const fullDir = path.join(tmpDir, dir);
          if (fs.statSync(fullDir).isDirectory()) {
            // Check for chats subdirectory
            const chatsDir = path.join(fullDir, 'chats');
            if (fs.existsSync(chatsDir)) {
              possibleDirs.push(chatsDir);
            }
            // Also check the directory itself for JSON files
            possibleDirs.push(fullDir);
          }
        }
      } catch {
        // Ignore errors
      }
    }

    // Also check history directory
    const historyDir = path.join(basePath, 'history');
    if (fs.existsSync(historyDir)) {
      possibleDirs.push(historyDir);
    }

    // Check sessions directory
    const sessionsDir = path.join(basePath, 'sessions');
    if (fs.existsSync(sessionsDir)) {
      possibleDirs.push(sessionsDir);
    }

    for (const dir of possibleDirs) {
      try {
        const files = glob.sync('*.json', { cwd: dir }).sort();
        for (const file of files) {
          const session = this.parseSessionFile(path.join(dir, file), projectPath);
          if (session && session.changes.length > 0) {
            sessions.push(session);
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return sessions;
  }

  parseSessionFile(filePath: string, projectPath: string): AISession | null {
    const data = this.readJsonFile(filePath);
    if (!data) return null;

    const changes: FileChange[] = [];
    let sessionTimestamp: Date | null = null;
    let sessionProjectPath: string | null = null;

    // Extract metadata from various possible fields
    if (data.created_at) {
      sessionTimestamp = new Date(data.created_at);
    } else if (data.timestamp) {
      sessionTimestamp = new Date(data.timestamp);
    } else if (data.startTime) {
      sessionTimestamp = new Date(data.startTime);
    }

    // Try to find project path from various fields
    sessionProjectPath = this.findProjectPath(data);

    // Require explicit project path match when available
    if (sessionProjectPath) {
      const normalizedSessionPath = path.resolve(sessionProjectPath);
      const normalizedProjectPath = path.resolve(projectPath);
      
      if (!this.pathsMatch(normalizedSessionPath, normalizedProjectPath)) {
        return null;
      }
    }

    // Extract model if available (check root or messages)
    let sessionModel = data.model || data.defaultModel;
    if (!sessionModel && data.messages) {
      for (const msg of data.messages) {
        if (msg.model) {
          sessionModel = msg.model;
          break;
        }
      }
    }

    // Parse messages from various possible structures
    const messages = data.messages || data.turns || data.conversation || data.history || [];
    for (const message of messages) {
      // Check for assistant/model role
      const role = message.role || message.type;
      if (['assistant', 'model', 'ASSISTANT', 'gemini'].includes(role)) {
        const messageTimestamp = message.timestamp ? new Date(message.timestamp) : sessionTimestamp;
        const parts = message.parts || message.content || message.text || [];
        const partsArray = Array.isArray(parts) ? parts : [parts];
        
        for (const part of partsArray) {
          // Check for function calls in various formats
          if (part.functionCall) {
            const change = this.parseFunctionCall(part.functionCall, projectPath, messageTimestamp, sessionModel);
            if (change) {
              changes.push(change);
            }
          }
          
          // Also check for tool_use format (similar to Claude)
          if (part.type === 'tool_use' || part.type === 'function_call') {
            const change = this.parseFunctionCall({
              name: part.name,
              args: part.input || part.args || part.arguments
            }, projectPath, messageTimestamp, sessionModel);
            if (change) {
              changes.push(change);
            }
          }
        }
      }
      
      // Also check for tool_calls array format (snake_case)
      if (message.tool_calls && Array.isArray(message.tool_calls)) {
        const messageTimestamp = message.timestamp ? new Date(message.timestamp) : sessionTimestamp;
        for (const toolCall of message.tool_calls) {
          const func = toolCall.function || toolCall;
          const change = this.parseFunctionCall({
            name: func.name,
            args: typeof func.arguments === 'string' ? JSON.parse(func.arguments) : func.arguments
          }, projectPath, messageTimestamp, sessionModel);
          if (change) {
            changes.push(change);
          }
        }
      }

      // Check for toolCalls array format (camelCase - common in some Gemini versions)
      if (message.toolCalls && Array.isArray(message.toolCalls)) {
        const messageTimestamp = message.timestamp ? new Date(message.timestamp) : sessionTimestamp;
        for (const toolCall of message.toolCalls) {
          const change = this.parseFunctionCall({
            name: toolCall.name,
            args: toolCall.args
          }, projectPath, messageTimestamp, sessionModel);
          if (change) {
            changes.push(change);
          }
        }
      }
    }

    if (changes.length === 0) return null;

    // If no explicit project path, only keep changes that belong to the target project
    if (!sessionProjectPath) {
      const filteredChanges = changes.filter(change => this.isProjectFile(change.filePath, projectPath));
      if (filteredChanges.length === 0) {
        return null;
      }
      changes.length = 0;
      changes.push(...filteredChanges);
    }

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
   * Check if two paths match or are related
   */
  private pathsMatch(path1: string, path2: string): boolean {
    const p1 = this.toForwardSlash(path1);
    const p2 = this.toForwardSlash(path2);
    if (p1 === p2) return true;
    if (p1.startsWith(p2 + '/')) return true;
    return false;
  }

  /**
   * Find explicit project path from known fields in the session data
   */
  private findProjectPath(data: any): string | null {
    if (!data || typeof data !== 'object') return null;

    const keys = new Set([
      'projectPath',
      'project_path',
      'cwd',
      'working_directory',
      'workspace',
      'workspacePath',
      'rootPath',
      'repoPath',
    ]);

    const queue: Array<{ value: any; depth: number }> = [{ value: data, depth: 0 }];
    const maxDepth = 6;

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) break;
      const { value, depth } = current;
      if (!value || typeof value !== 'object') continue;
      if (depth > maxDepth) continue;

      if (Array.isArray(value)) {
        for (const item of value) {
          queue.push({ value: item, depth: depth + 1 });
        }
        continue;
      }

      for (const [key, val] of Object.entries(value)) {
        if (keys.has(key) && typeof val === 'string' && path.isAbsolute(val)) {
          return val;
        }
        if (val && typeof val === 'object') {
          queue.push({ value: val, depth: depth + 1 });
        }
      }
    }

    return null;
  }

  /**
   * Parse a functionCall object to extract file changes
   */
  private parseFunctionCall(funcCall: any, projectPath: string, timestamp?: Date | null, model?: string): FileChange | null {
    if (!funcCall) return null;
    
    const funcName = (funcCall.name || '').toLowerCase();
    const args = funcCall.args || funcCall.arguments || {};

    // Supported operations - expanded list
    const writeOps = ['write_file', 'create_file', 'write', 'save_file', 'create', 'writefile'];
    const editOps = ['edit_file', 'update_file', 'modify_file', 'replace_in_file', 'edit', 'patch', 'apply_diff', 'replace'];

    // Try various field names for file path
    let filePath = args.path || args.file_path || args.filename || args.file || args.target || '';
    let newContent = args.content || args.newContent || args.text || args.code || args.data || args.new_string || args.new_str || '';
    let oldContent = args.oldContent || args.original || args.old_content || args.old_string || args.old_str || '';

    if (!filePath) return null;

    // Normalize path
    filePath = this.normalizePath(filePath, projectPath);

    const changeType = (!oldContent && newContent) ? 'create' 
      : (oldContent && !newContent) ? 'delete' 
      : 'modify';

    // Calculate diff stats
    let linesAdded = 0;
    let linesRemoved = 0;
    let addedLines: string[] = [];
    let operation: 'write' | 'edit' | undefined;

    if (writeOps.includes(funcName)) {
      const stats = this.calculateDiffStats(oldContent, newContent);
      linesAdded = stats.added;
      linesRemoved = stats.removed;
      operation = 'write';
      if (oldContent && newContent) {
        addedLines = this.diffAddedLines(oldContent, newContent);
      } else {
        addedLines = this.extractNonEmptyLines(newContent);
      }
    } else if (editOps.includes(funcName)) {
      // Use LCS for edits to be accurate
      const stats = this.calculateDiffStats(oldContent, newContent);
      linesAdded = stats.added;
      linesRemoved = stats.removed;
      operation = 'edit';
      if (oldContent && newContent) {
        addedLines = this.diffAddedLines(oldContent, newContent);
      } else {
        addedLines = this.extractNonEmptyLines(newContent);
      }
    } else {
      if (newContent) {
        linesAdded = this.countLines(newContent);
        addedLines = this.extractNonEmptyLines(newContent);
      }
    }

    if (linesAdded === 0 && linesRemoved === 0) return null;

    return {
      filePath,
      linesAdded,
      linesRemoved,
      changeType: writeOps.includes(funcName) && !oldContent ? 'create' : 'modify',
      timestamp: timestamp || new Date(),
      tool: this.tool,
      content: newContent,
      addedLines,
      model,
      operation,
    };
  }

  /**
   * Calculate lines added and removed using simple diff (LCS)
   */
  private calculateDiffStats(before: string, after: string): { added: number, removed: number } {
    if (!before) return { added: this.countLines(after), removed: 0 };
    if (!after) return { added: 0, removed: this.countLines(before) };

    const beforeLines = before.split(/\r?\n/);
    const afterLines = after.split(/\r?\n/);
    
    // Optimization: trim matching start
    let start = 0;
    while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
      start++;
    }
    
    // Optimization: trim matching end
    let endBefore = beforeLines.length - 1;
    let endAfter = afterLines.length - 1;
    
    while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
      endBefore--;
      endAfter--;
    }
    
    const remainingBefore = beforeLines.slice(start, endBefore + 1);
    const remainingAfter = afterLines.slice(start, endAfter + 1);
    
    // If nothing remaining, no changes
    if (remainingBefore.length === 0 && remainingAfter.length === 0) {
      return { added: 0, removed: 0 };
    }

    // Calculate LCS on the remaining parts
    const lcs = this.computeLCS(remainingBefore, remainingAfter);
    
    return {
      added: remainingAfter.length - lcs,
      removed: remainingBefore.length - lcs
    };
  }

  private computeLCS(lines1: string[], lines2: string[]): number {
    const m = lines1.length;
    const n = lines2.length;
    
    // Use two rows for O(min(M,N)) space
    let prev = new Array(n + 1).fill(0);
    let curr = new Array(n + 1).fill(0);
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (lines1[i - 1] === lines2[j - 1]) {
          curr[j] = prev[j - 1] + 1;
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      // Swap references
      const temp = prev;
      prev = curr;
      curr = temp;
    }
    
    return prev[n];
  }
}
