import {
  BaseScanner,
  ClaudeScanner,
  CodexScanner,
  CursorScanner,
  GeminiScanner,
  OpencodeScanner,
  TraeScanner,
} from '../scanners/index.js';
import { AISession, AITool } from '../types.js';

/**
 * Manages the available scanners and coordinates scanning sessions across multiple AI tools.
 */
export class ScannerManager {
  private scanners: BaseScanner[];

  constructor() {
    this.scanners = [
      new ClaudeScanner(),
      new CodexScanner(),
      new CursorScanner(),
      new GeminiScanner(),
      new OpencodeScanner(),
      new TraeScanner(),
    ];
  }

  /**
   * Get list of available AI tools
   */
  getAvailableTools(): AITool[] {
    const available: AITool[] = [];

    for (const scanner of this.scanners) {
      if (scanner.isAvailable()) {
        available.push(scanner.tool);
      }
    }

    return available;
  }

  /**
   * Scan all sessions from all tools
   * @param projectPath The path to the project to scan
   * @param tools Optional list of tools to scan (if not provided, scans all available tools)
   * @param since Optional date to filter sessions (only sessions after this date will be included)
   */
  scanAllSessions(projectPath: string, tools?: AITool[], since?: Date): AISession[] {
    const sessions: AISession[] = [];

    for (const scanner of this.scanners) {
      if (tools && !tools.includes(scanner.tool)) {
        continue;
      }

      try {
        const toolSessions = scanner.scan(projectPath);
        sessions.push(...toolSessions);
      } catch (error) {
        // Silently ignore scanner errors
      }
    }

    // Filter by date if specified
    if (since) {
      const sinceTime = since.getTime();
      const filtered = sessions.filter(s => s.timestamp.getTime() >= sinceTime);
      sessions.length = 0;
      sessions.push(...filtered);
    }

    // Sort by timestamp, then by session ID for deterministic order
    sessions.sort((a, b) => {
      const timeDiff = a.timestamp.getTime() - b.timestamp.getTime();
      if (timeDiff !== 0) return timeDiff;
      // Secondary sort by session ID for stable ordering when timestamps are equal
      return a.id.localeCompare(b.id);
    });

    return sessions;
  }
}
