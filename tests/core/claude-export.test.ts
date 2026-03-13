
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClaudeScanner } from '../../src/scanners/claude.js';
import { AITool } from '../../src/types.js';

class TestClaudeScanner extends ClaudeScanner {
  constructor(private customStoragePath: string) {
    super();
  }

  get storagePath(): string {
    return this.customStoragePath;
  }
}

describe('ClaudeScanner Export Logic', () => {
  const tmpDir = path.join(os.tmpdir(), 'claude-export-test-' + Date.now());
  const projectPath = path.join(tmpDir, 'project');
  const storagePath = path.join(tmpDir, 'claude-storage');

  beforeEach(() => {
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(storagePath, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should include full file content for edit operations', () => {
    // 1. Create a file in the project
    const filePath = path.join(projectPath, 'src', 'hello.ts');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fileContent = `
export function hello() {
  console.log("Hello World");
  console.log("This is the full content");
}
`;
    fs.writeFileSync(filePath, fileContent);

    // 2. Create a mock Claude session file
    // Claude encodes project path by replacing / with - and removing leading -
    const encodedPath = projectPath.replace(/[\\/]/g, '-').replace(/^-/, '');
    const sessionDir = path.join(storagePath, encodedPath);
    fs.mkdirSync(sessionDir, { recursive: true });

    const sessionFile = path.join(sessionDir, 'session.jsonl');
    
    // Mock a session with an edit operation
    // Note: The input 'content' is just a snippet (the diff), but we want the scanner to return the full file
    const sessionData = [
      {
        type: 'assistant',
        timestamp: new Date().toISOString(),
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'edit',
              input: {
                path: 'src/hello.ts',
                old_str: 'console.log("Hello World");',
                new_str: 'console.log("Hello Universe");' // This is just the snippet
              }
            }
          ]
        }
      }
    ];

    fs.writeFileSync(sessionFile, sessionData.map(d => JSON.stringify(d)).join('\n'));

    // 3. Scan using the test scanner
    const scanner = new TestClaudeScanner(storagePath);
    const sessions = scanner.scan(projectPath);

    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.changes).toHaveLength(1);
    
    const change = session.changes[0];
    expect(change.filePath).toBe('src/hello.ts');
    
    // 4. Verify content is the FULL file content from disk, NOT just the snippet
    // The snippet was 'console.log("Hello Universe");'
    // But the file content on disk is 'fileContent' (because we wrote it in step 1)
    // Wait, in step 1 we wrote "Hello World".
    // The session says it changed it to "Hello Universe".
    // But since we didn't actually apply the change to disk (we just mocked the session),
    // the scanner will read what's on disk ("Hello World").
    // This confirms the scanner is reading from disk!
    
    expect(change.content).toBe(fileContent);
    expect(change.content).toContain('This is the full content');
    
    // Also verify linesAdded/Removed are calculated from the snippet (diff)
    // The diff was 1 line changed
    // edit operation: old_str has 1 line, new_str has 1 line.
    // So linesAdded should be roughly 1 (depending on diff logic)
    // old_str: console.log("Hello World");
    // new_str: console.log("Hello Universe");
    // diffLineCounts: added 1, removed 1?
    // Let's check logic: diffLineCounts compares full strings.
    // Since they are different and single lines, added=1, removed=1.
    
    // However, if logic uses LCS on lines, and lines are different, it's 1 add, 1 remove.
    expect(change.linesAdded).toBeGreaterThan(0);
  });
});
