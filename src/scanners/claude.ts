import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { AISession, AITool, FileChange, SessionType, SessionOperations } from '../types.js';
import { BaseScanner } from './base.js';

/**
 * Scanner for Claude Code sessions
 * 
 * Claude Code stores session data in:
 * ~/.claude/projects/<path-encoded-project-name>/*.jsonl
 * 
 * Each JSONL file contains conversation turns with tool_use blocks
 * that record file operations (write, edit, etc.)
 */
export class ClaudeScanner extends BaseScanner {
  get tool(): AITool {
    return AITool.CLAUDE_CODE;
  }

  get storagePath(): string {
    return '~/.claude/projects';
  }

  /**
   * Encode project path to match Claude's directory naming convention
   * Claude encodes paths by replacing / (and \ on Windows) with -
   */
  private encodeProjectPath(projectPath: string): string {
    return projectPath.replace(/[\\/]/g, '-').replace(/^-/, '');
  }

  /**
   * Decode Claude's directory name back to a path
   */
  private decodeProjectPath(encodedPath: string): string {
    return '/' + encodedPath.replace(/-/g, '/');
  }

  /**
   * Normalize a path for comparison (lowercase drive letter, forward slashes)
   */
  private normForCompare(p: string): string {
    let s = this.toForwardSlash(p);
    // Normalize Windows drive letter to lowercase: C:/... -> c:/...
    if (/^[A-Z]:\//.test(s)) {
      s = s[0].toLowerCase() + s.slice(1);
    }
    return s;
  }

  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];
    const basePath = this.resolveStoragePath();

    if (!fs.existsSync(basePath)) {
      return sessions;
    }

    // Try to find the project directory
    const encodedPath = this.encodeProjectPath(projectPath);
    const projectDir = path.join(basePath, encodedPath);
    const projectBasename = path.basename(projectPath);

    // Collect all possible matching directories
    const possibleDirs = new Set<string>();

    // Add exact match
    if (fs.existsSync(projectDir)) {
      possibleDirs.add(projectDir);
    }

    // Scan all directories to find matches
    try {
      const allDirs = fs.readdirSync(basePath).sort();
      for (const dir of allDirs) {
        const fullDir = path.join(basePath, dir);
        if (!fs.statSync(fullDir).isDirectory()) continue;

        // Check various matching criteria
        const decodedPath = this.decodeProjectPath(dir);
        const normProject = this.normForCompare(projectPath);
        const normDecoded = this.normForCompare(decodedPath);

        // Match by:
        // 1. Directory name contains project basename
        // 2. Decoded path ends with project path
        // 3. Project path ends with decoded path
        // 4. Same basename
        if (dir.includes(projectBasename) ||
            dir.toLowerCase().includes(projectBasename.toLowerCase()) ||
            normDecoded.endsWith(normProject) ||
            normProject.endsWith(normDecoded.slice(1)) ||
            path.basename(decodedPath) === projectBasename) {
          possibleDirs.add(fullDir);
        }
      }
    } catch {
      // Ignore errors
    }

    // Parse all session files from matching directories
    for (const dir of Array.from(possibleDirs).sort()) {
      try {
        const files = glob.sync('*.jsonl', { cwd: dir }).sort();
        for (const file of files) {
          const session = this.parseSessionFile(path.join(dir, file), projectPath);
          // Return all sessions (including those without code changes)
          // The analyzer will classify them by type
          if (session) {
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
    const changes: FileChange[] = [];
    let sessionTimestamp: Date | null = null;
    let sessionModel: string | undefined = undefined;
    let hasEntries = false;

    // Track all operations for session type classification
    const operations: SessionOperations = {
      readCount: 0,
      editCount: 0,
      writeCount: 0,
      bashCount: 0,
      grepCount: 0,
      globCount: 0,
      taskCount: 0,
      otherCount: 0,
    };

    this.forEachJsonlEntry(filePath, entry => {
      hasEntries = true;
      // Extract timestamp from various possible fields
      if (!sessionTimestamp) {
        if (entry.timestamp) {
          sessionTimestamp = new Date(entry.timestamp);
        } else if (entry.created_at) {
          sessionTimestamp = new Date(entry.created_at);
        }
      }

      // Extract model (try entry.model or entry.message.model)
      if (!sessionModel) {
        if (entry.model) {
          sessionModel = entry.model;
        } else if (entry.message && entry.message.model) {
          sessionModel = entry.message.model;
        }
      }

      // Look for assistant messages with tool_use
      if (entry.type === 'assistant' && entry.message?.content) {
        const content = Array.isArray(entry.message.content)
          ? entry.message.content
          : [entry.message.content];

        for (const block of content) {
          if (block.type === 'tool_use') {
            // Count all tool operations for classification
            const toolName = (block.name || '').toLowerCase();
            this.countOperation(toolName, operations);

            const change = this.parseToolUse(block, projectPath, entry.timestamp, sessionModel);
            if (change) {
              changes.push(change);
            }
          }
        }
      }

      // Also check for tool_result entries that might contain file info
      if (entry.type === 'tool_result' && entry.content) {
        // Tool results might indicate successful file operations
        // but we primarily track from tool_use
      }
    });

    if (!hasEntries) return null;

    // Determine session type based on operations
    const sessionType = this.determineSessionType(operations, changes);

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
      sessionType,
      operations,
    };
  }

  /**
   * Count operation by tool name
   */
  private countOperation(toolName: string, ops: SessionOperations): void {
    switch (toolName) {
      case 'read':
        ops.readCount++;
        break;
      case 'edit':
        ops.editCount++;
        break;
      case 'write':
        ops.writeCount++;
        break;
      case 'bash':
        ops.bashCount++;
        break;
      case 'grep':
        ops.grepCount++;
        break;
      case 'glob':
        ops.globCount++;
        break;
      case 'task':
        ops.taskCount++;
        break;
      default:
        ops.otherCount++;
    }
  }

  /**
   * Determine session type based on operations and changes
   */
  private determineSessionType(ops: SessionOperations, changes: FileChange[]): SessionType {
    // If there are actual code changes, it's a code contribution
    if (changes.length > 0 && changes.some(c => c.linesAdded > 0 || c.linesRemoved > 0)) {
      return 'code_contribution';
    }

    // Otherwise, classify based on operations
    return BaseScanner.classifySessionFromOps(ops);
  }

  /**
   * Parse a tool_use block to extract file changes
   */
  private parseToolUse(block: any, projectPath: string, timestamp?: number, model?: string): FileChange | null {
    const toolName = block.name?.toLowerCase() || '';
    const input = block.input || {};

    // Supported write operations - expanded list
    const writeOps = ['write', 'write_file', 'create_file', 'str_replace_editor', 'save_file', 'create'];
    const editOps = ['edit', 'edit_file', 'str_replace', 'apply_diff', 'patch', 'update_file'];

    // Try various field names for file path
    let filePath = input.path || input.file_path || input.filename || input.file || input.target || '';
    let newContent = input.content || input.new_str || input.new_string || input.text || input.code || '';
    let oldContent = input.old_str || input.old_string || input.old_content || input.original || '';

    if (!filePath) return null;

    // Normalize path
    filePath = this.normalizePath(filePath, projectPath);

    let changeType: 'create' | 'modify' | 'delete' = 'modify';
    let linesAdded = 0;
    let linesRemoved = 0;
    let addedLines: string[] = [];
    let operation: 'write' | 'edit' | undefined;

    if (writeOps.includes(toolName)) {
      changeType = oldContent ? 'modify' : 'create';
      operation = 'write';
      const stats = this.diffLineCounts(oldContent, newContent);
      linesAdded = stats.added;
      linesRemoved = stats.removed;
      if (oldContent && newContent) {
        addedLines = this.diffAddedLines(oldContent, newContent);
      } else {
        addedLines = this.extractNonEmptyLines(newContent);
      }
    } else if (editOps.includes(toolName)) {
      changeType = 'modify';
      operation = 'edit';
      if (oldContent && newContent) {
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
      // Unknown tool, try to extract what we can
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
      changeType,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
      tool: this.tool,
      content: newContent,
      addedLines,
      model,
      operation,
    };
  }
}
