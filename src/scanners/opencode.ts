import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { AISession, AITool, FileChange } from '../types.js';
import { BaseScanner } from './base.js';

/**
 * Scanner for Opencode (opencode.ai) sessions
 *
 * Opencode stores session data in:
 * ~/.local/share/opencode/storage/
 *
 * Structure:
 * - storage/session/ - session metadata files (named by session ID)
 * - storage/message/ - individual message files with file change diffs
 * - storage/part/ - message parts
 *
 * File changes are recorded in message.info.summary.diffs with:
 * - file: relative file path
 * - before: previous content
 * - after: new content
 */
export class OpencodeScanner extends BaseScanner {
  get tool(): AITool {
    return AITool.OPENCODE;
  }

  get storagePath(): string {
    return '~/.local/share/opencode';
  }

  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];
    const basePath = this.resolveStoragePath();

    if (!fs.existsSync(basePath)) {
      return sessions;
    }

    const sessionDir = path.join(basePath, 'storage', 'session');
    if (!fs.existsSync(sessionDir)) {
      return sessions;
    }

    try {
      // Find all session files recursively (they are in subdirectories by project hash)
      const sessionFiles = glob.sync('**/*.json', { cwd: sessionDir });

      for (const file of sessionFiles) {
        const session = this.parseSessionFile(path.join(sessionDir, file), projectPath);
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
    const sessionData = this.readJsonFile(filePath);
    if (!sessionData) return null;

    const basePath = this.resolveStoragePath();

    // Extract session info
    const sessionId = sessionData.id || path.basename(filePath, '.json');
    const sessionProjectPath = sessionData.directory || sessionData.projectPath || null;
    const sessionTimestamp = sessionData.time?.created
      ? new Date(sessionData.time.created)
      : new Date();

    // Filter by project path
    if (sessionProjectPath) {
      const normalizedSessionPath = path.resolve(sessionProjectPath);
      const normalizedProjectPath = path.resolve(projectPath);

      if (!this.pathsMatch(normalizedSessionPath, normalizedProjectPath)) {
        return null;
      }
    }

    // Parse file changes from messages
    const changes: FileChange[] = [];
    let sessionModel: string | undefined;

    // First, try to parse individual message files if available (more granular)
    const messageDir = path.join(basePath, 'storage', 'message');
    if (fs.existsSync(messageDir) && sessionData.id) {
      try {
        // Messages are stored in subdirectories by session ID
        const sessionMessageDir = path.join(messageDir, sessionData.id);
        if (fs.existsSync(sessionMessageDir)) {
          const messageFiles = glob.sync('*.json', { cwd: sessionMessageDir });
          for (const msgFile of messageFiles) {
            const msgData = this.readJsonFile(path.join(sessionMessageDir, msgFile));
            if (msgData?.sessionID === sessionData.id) {
              // Extract model from message
              const msgModel = msgData.model?.modelID;
              if (msgModel && !sessionModel) {
                sessionModel = msgModel;
              }
              const msgChanges = this.parseMessageChanges(msgData, projectPath, msgModel);
              changes.push(...msgChanges);
            }
          }
        }
      } catch {
        // Ignore errors
      }
    }

    // If no changes found in messages, fall back to session summary
    if (changes.length === 0 && sessionData.summary?.diffs && Array.isArray(sessionData.summary.diffs)) {
      for (const diff of sessionData.summary.diffs) {
        const change = this.parseDiff(diff, projectPath, sessionTimestamp, sessionModel);
        if (change) {
          changes.push(change);
        }
      }
    }

    if (changes.length === 0) return null;

    // Remove duplicate changes (same file, same content)
    const uniqueChanges = this.deduplicateChanges(changes);

    // Update all changes with the session model if found
    if (sessionModel) {
      for (const change of uniqueChanges) {
        if (!change.model) {
          change.model = sessionModel;
        }
      }
    }

    return {
      id: sessionId,
      tool: this.tool,
      model: sessionModel,
      timestamp: sessionTimestamp,
      projectPath,
      changes: uniqueChanges,
      totalFilesChanged: new Set(uniqueChanges.map(c => c.filePath)).size,
      totalLinesAdded: uniqueChanges.reduce((sum, c) => sum + c.linesAdded, 0),
      totalLinesRemoved: uniqueChanges.reduce((sum, c) => sum + c.linesRemoved, 0),
    };
  }

  /**
   * Check if two paths match (session belongs to project)
   */
  private pathsMatch(sessionPath: string, projectPath: string): boolean {
    const s = this.toForwardSlash(sessionPath);
    const p = this.toForwardSlash(projectPath);
    if (s === p) return true;
    if (s.startsWith(p + '/')) return true;
    if (p.startsWith(s + '/')) return true;
    if (path.basename(sessionPath) === path.basename(projectPath)) return true;
    return false;
  }

  /**
   * Parse a diff object to extract file change
   */
  private parseDiff(diff: any, projectPath: string, timestamp: Date, model?: string): FileChange | null {
    if (!diff || !diff.file) return null;

    const filePath = this.normalizePath(diff.file, projectPath);
    const beforeContent = diff.before || '';
    const afterContent = diff.after || '';

    const changeType = (!beforeContent && afterContent) ? 'create' 
      : (beforeContent && !afterContent) ? 'delete' 
      : 'modify';

    // Use opencode's provided diff stats if available (most accurate)
    // additions/deletions are pre-calculated by opencode
    const diffStats = this.diffLineCounts(beforeContent, afterContent);
    const addedLines = this.diffAddedLines(beforeContent, afterContent);
    const linesAdded = typeof diff.additions === 'number' ? diff.additions : diffStats.added;
    const linesRemoved = typeof diff.deletions === 'number' ? diff.deletions : diffStats.removed;

    return {
      filePath,
      linesAdded,
      linesRemoved,
      changeType,
      timestamp,
      tool: this.tool,
      model,
      content: afterContent,
      addedLines,
    };
  }

  /**
   * Parse message data for file changes
   */
  private parseMessageChanges(msgData: any, projectPath: string, model?: string): FileChange[] {
    const changes: FileChange[] = [];
    const timestamp = msgData.time?.created
      ? new Date(msgData.time.created)
      : new Date();

    const diffs = msgData.summary?.diffs;
    if (diffs && Array.isArray(diffs)) {
      for (const diff of diffs) {
        const change = this.parseDiff(diff, projectPath, timestamp, model);
        if (change) {
          changes.push(change);
        }
      }
    }

    return changes;
  }

  /**
   * Remove duplicate file changes
   */
  private deduplicateChanges(changes: FileChange[]): FileChange[] {
    const seen = new Set<string>();
    const unique: FileChange[] = [];

    for (const change of changes) {
      const key = `${change.filePath}-${change.linesAdded}-${change.linesRemoved}-${change.timestamp.getTime()}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(change);
      }
    }

    return unique;
  }
}
