import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as stringDecoder from 'string_decoder';
import { AISession, AITool, FileChange, SessionType, SessionOperations } from '../types.js';

/**
 * Base class for AI tool scanners
 */
export abstract class BaseScanner {
  protected homeDir: string;
  
  constructor() {
    this.homeDir = os.homedir();
  }

  /**
   * The AI tool this scanner handles
   */
  abstract get tool(): AITool;

  /**
   * The storage path for this tool's session data
   */
  abstract get storagePath(): string;

  /**
   * Check if this tool has data available
   */
  isAvailable(): boolean {
    const fullPath = this.resolveStoragePath();
    return fs.existsSync(fullPath);
  }

  /**
   * Resolve the full storage path
   */
  protected resolveStoragePath(): string {
    return path.join(this.storagePath.replace('~', this.homeDir));
  }

  /**
   * Scan for sessions related to a specific project
   */
  abstract scan(projectPath: string): AISession[];

  /**
   * Parse a session file and extract file changes
   */
  abstract parseSessionFile(filePath: string, projectPath: string): AISession | null;

  /**
   * Count lines in a string
   */
  protected countLines(content: string | undefined): number {
    if (!content) return 0;
    return content.split('\n').filter(line => line.length > 0).length;
  }

  /**
   * Split content into lines, preserving whitespace
   */
  protected splitLines(content: string | undefined): string[] {
    if (!content) return [];
    return content.split(/\r?\n/);
  }

  /**
   * Extract non-empty lines from content
   */
  protected extractNonEmptyLines(content: string | undefined): string[] {
    return this.splitLines(content).filter(line => line.length > 0);
  }

  /**
   * Compute added lines using LCS diff (non-empty lines only)
   */
  protected diffAddedLines(before: string | undefined, after: string | undefined): string[] {
    const beforeLines = this.extractNonEmptyLines(before);
    const afterLines = this.extractNonEmptyLines(after);

    if (beforeLines.length === 0) return afterLines;
    if (afterLines.length === 0) return [];

    // Optimization: Trim common prefix
    let start = 0;
    while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
      start++;
    }

    // Optimization: Trim common suffix
    let endBefore = beforeLines.length - 1;
    let endAfter = afterLines.length - 1;
    while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
      endBefore--;
      endAfter--;
    }

    // If identical or only common parts
    if (start > endBefore && start > endAfter) {
      return [];
    }

    // Run LCS on the changed part
    const subBefore = beforeLines.slice(start, endBefore + 1);
    const subAfter = afterLines.slice(start, endAfter + 1);

    const m = subBefore.length;
    const n = subAfter.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (subBefore[i - 1] === subAfter[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    const added: string[] = [];
    let i = m;
    let j = n;
    while (i > 0 && j > 0) {
      if (subBefore[i - 1] === subAfter[j - 1]) {
        i--;
        j--;
      } else if (dp[i - 1][j] >= dp[i][j - 1]) {
        i--;
      } else {
        added.push(subAfter[j - 1]);
        j--;
      }
    }
    while (j > 0) {
      added.push(subAfter[j - 1]);
      j--;
    }

    return added.reverse();
  }

  /**
   * Compute added/removed line counts using LCS diff (non-empty lines only)
   */
  protected diffLineCounts(before: string | undefined, after: string | undefined): { added: number; removed: number } {
    const beforeLines = this.extractNonEmptyLines(before);
    const afterLines = this.extractNonEmptyLines(after);

    if (beforeLines.length === 0) return { added: afterLines.length, removed: 0 };
    if (afterLines.length === 0) return { added: 0, removed: beforeLines.length };

    // Optimization: Trim common prefix
    let start = 0;
    while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
      start++;
    }

    // Optimization: Trim common suffix
    let endBefore = beforeLines.length - 1;
    let endAfter = afterLines.length - 1;
    while (endBefore >= start && endAfter >= start && beforeLines[endBefore] === afterLines[endAfter]) {
      endBefore--;
      endAfter--;
    }

    // If identical
    if (start > endBefore && start > endAfter) {
      return { added: 0, removed: 0 };
    }

    const subBefore = beforeLines.slice(start, endBefore + 1);
    const subAfter = afterLines.slice(start, endAfter + 1);

    const m = subBefore.length;
    const n = subAfter.length;
    let prev = new Array(n + 1).fill(0);
    let curr = new Array(n + 1).fill(0);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (subBefore[i - 1] === subAfter[j - 1]) {
          curr[j] = prev[j - 1] + 1;
        } else {
          curr[j] = Math.max(prev[j], curr[j - 1]);
        }
      }
      const temp = prev;
      prev = curr;
      curr = temp;
      curr.fill(0);
    }

    const lcs = prev[n];
    return {
      added: subAfter.length - lcs,
      removed: subBefore.length - lcs,
    };
  }

  /**
   * Extract added lines from a unified diff
   */
  protected extractAddedLinesFromDiff(diff: string | undefined): string[] {
    if (!diff) return [];
    const lines = diff.split(/\r?\n/);
    const added: string[] = [];

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const content = line.slice(1);
        if (content.length > 0) {
          added.push(content);
        }
      }
    }

    return added;
  }

  /**
   * Extract removed lines from a unified diff
   */
  protected extractRemovedLinesFromDiff(diff: string | undefined): string[] {
    if (!diff) return [];
    const lines = diff.split(/\r?\n/);
    const removed: string[] = [];

    for (const line of lines) {
      if (line.startsWith('-') && !line.startsWith('---')) {
        const content = line.slice(1);
        if (content.length > 0) {
          removed.push(content);
        }
      }
    }

    return removed;
  }

  /**
   * Normalize separators to forward slashes (consistent with glob output)
   */
  protected toForwardSlash(p: string): string {
    return p.replace(/\\/g, '/');
  }

  /**
   * Normalize file path relative to project
   */
  protected normalizePath(filePath: string, projectPath: string): string {
    if (path.isAbsolute(filePath)) {
      return this.toForwardSlash(path.relative(projectPath, filePath));
    }
    return this.toForwardSlash(filePath);
  }

  /**
   * Check if a file path belongs to the project
   */
  protected isProjectFile(filePath: string, projectPath: string): boolean {
    const normalizedPath = this.normalizePath(filePath, projectPath);
    // Exclude paths that go outside the project
    return !normalizedPath.startsWith('..');
  }

  /**
   * Read and parse JSON file safely
   */
  protected readJsonFile(filePath: string): any {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Read and parse JSONL file safely
   */
  protected readJsonlFile(filePath: string): any[] {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());
      return lines.map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * Iterate JSONL entries without loading the full file into memory
   */
  protected forEachJsonlEntry(filePath: string, onEntry: (entry: any) => void): void {
    const bufferSize = 64 * 1024;
    const buffer = Buffer.alloc(bufferSize);
    let fd: number | null = null;
    let leftover = '';
    const decoder = new stringDecoder.StringDecoder('utf8');

    try {
      fd = fs.openSync(filePath, 'r');
      while (true) {
        const bytesRead = fs.readSync(fd, buffer, 0, bufferSize, null);
        if (bytesRead <= 0) break;

        const chunk = decoder.write(buffer.subarray(0, bytesRead));
        const lines = (leftover + chunk).split(/\r?\n/);
        leftover = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            onEntry(JSON.parse(trimmed));
          } catch {
            // Skip malformed JSON lines
          }
        }
      }

      const tail = (leftover + decoder.end()).trim();
      if (tail) {
        try {
          onEntry(JSON.parse(tail));
        } catch {
          // Skip malformed tail
        }
      }
    } catch {
      // Ignore file read errors
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {
          // Ignore close errors
        }
      }
    }
  }

  /**
   * Generate a unique session ID
   */
  protected generateSessionId(filePath: string): string {
    return `${this.tool}-${path.basename(filePath, path.extname(filePath))}`;
  }

  /**
   * Classify session type based on operations
   *
   * Classification rules:
   * - code_contribution: Has Edit/Write operations on project files (lines changed > 0)
   * - code_review: Only Read operations (no Edit/Write, but has Read)
   * - analysis: Bash/Grep/Glob operations (debugging, searching, analyzing)
   * - mixed: Multiple operation types but no actual code changes
   */
  static classifySessionType(session: AISession): { type: SessionType; operations: SessionOperations } {
    const ops: SessionOperations = {
      readCount: 0,
      editCount: 0,
      writeCount: 0,
      bashCount: 0,
      grepCount: 0,
      globCount: 0,
      taskCount: 0,
      otherCount: 0,
    };

    // Count operations from changes (each change represents a tool use)
    for (const change of session.changes) {
      // Changes are only created for Edit/Write operations with actual content
      if (change.linesAdded > 0 || change.linesRemoved > 0) {
        ops.editCount++;
      }
    }

    // If we have actual code changes, it's a code contribution
    if (session.changes.length > 0 && (session.totalLinesAdded > 0 || session.totalLinesRemoved > 0)) {
      return { type: 'code_contribution', operations: ops };
    }

    // For sessions without changes, we need to look at raw operations
    // This information might not be available in all scanners
    // Default to 'analysis' if we can't determine
    return { type: 'analysis', operations: ops };
  }

  /**
   * Classify session based on raw operation counts (used when changes array is empty)
   */
  static classifySessionFromOps(ops: SessionOperations): SessionType {
    const hasReads = ops.readCount > 0;
    const hasEdits = ops.editCount > 0 || ops.writeCount > 0;
    const hasAnalysis = ops.bashCount > 0 || ops.grepCount > 0 || ops.globCount > 0;

    if (hasEdits) {
      return 'code_contribution';
    }
    if (hasReads && !hasAnalysis) {
      return 'code_review';
    }
    if (hasAnalysis && !hasReads) {
      return 'analysis';
    }
    return 'mixed';
  }
}
