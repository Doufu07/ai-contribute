import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AITool } from '../../src/types.js';

// Define mock implementations
const mockScan = vi.fn();
const mockIsAvailable = vi.fn();

// Mock the scanners module
vi.mock('../../src/scanners/index.js', () => {
  class MockBaseScanner {
    tool: any;
    constructor(tool: any) { this.tool = tool; }
    isAvailable() { return mockIsAvailable(this.tool); }
    scan(path: string) { return mockScan(this.tool, path); }
  }

  return {
    BaseScanner: MockBaseScanner,
    ClaudeScanner: class extends MockBaseScanner { constructor() { super('claude'); } },
    CodexScanner: class extends MockBaseScanner { constructor() { super('codex'); } },
    CursorScanner: class extends MockBaseScanner { constructor() { super('cursor'); } },
    GeminiScanner: class extends MockBaseScanner { constructor() { super('gemini'); } },
    OpencodeScanner: class extends MockBaseScanner { constructor() { super('opencode'); } },
    TraeScanner: class extends MockBaseScanner { constructor() { super('trae'); } },
  };
});

// Import ScannerManager AFTER mocking
import { ScannerManager } from '../../src/core/scanners.js';

describe('ScannerManager', () => {
  let manager: ScannerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default behavior: all available, return empty sessions
    mockIsAvailable.mockReturnValue(true);
    mockScan.mockReturnValue([]);
    manager = new ScannerManager();
  });

  describe('getAvailableTools', () => {
    it('should return all tools when all are available', () => {
      const tools = manager.getAvailableTools();
      console.log('Available tools (all):', tools);
      expect(tools).toHaveLength(6);
      expect(tools).toContain(AITool.CLAUDE_CODE);
      expect(tools).toContain(AITool.TRAE);
    });

    it('should filter out unavailable tools', () => {
      mockIsAvailable.mockImplementation((tool) => tool === AITool.CLAUDE_CODE || tool === AITool.TRAE);
      
      const tools = manager.getAvailableTools();
      console.log('Available tools (filtered):', tools);
      expect(tools).toHaveLength(2);
      expect(tools).toContain(AITool.CLAUDE_CODE);
      expect(tools).toContain(AITool.TRAE);
      expect(tools).not.toContain(AITool.CURSOR);
    });

    it('should return empty array when no tools are available', () => {
      mockIsAvailable.mockReturnValue(false);
      const tools = manager.getAvailableTools();
      expect(tools).toEqual([]);
    });
  });

  describe('scanAllSessions', () => {
    const mockDate = new Date('2024-01-01');
    const mockSession1 = { 
      id: '1', 
      timestamp: new Date('2024-01-02'), 
      tool: AITool.CLAUDE_CODE,
      changes: [
        {
          filePath: 'src/utils.ts',
          linesAdded: 10,
          linesRemoved: 0,
          content: 'export function add(a, b) { return a + b; }'
        }
      ]
    };
    const mockSession2 = { 
      id: '2', 
      timestamp: new Date('2024-01-03'), 
      tool: AITool.TRAE,
      changes: [
        {
          filePath: 'src/components/Button.tsx',
          linesAdded: 5,
          linesRemoved: 2,
          content: 'export const Button = () => <button>Click me</button>;'
        }
      ]
    };
    
    // Session for 2026-03-13 13:00 (after 12:00)
    const mockSession3 = { 
      id: '3', 
      timestamp: new Date('2026-03-13T13:00:00Z'), 
      tool: AITool.TRAE,
      changes: [
        {
          filePath: 'src/new-feature.ts',
          linesAdded: 20,
          linesRemoved: 0,
          content: '// New feature implementation'
        }
      ]
    };

    it('should scan all tools and aggregate sessions', () => {
      mockScan.mockImplementation((tool) => {
        if (tool === AITool.CLAUDE_CODE) return [mockSession1];
        if (tool === AITool.TRAE) return [mockSession2, mockSession3];
        return [];
      });

      const sessions = manager.scanAllSessions('/test/path');
      
      // Output in log format
      console.log(`AI Contribution Log - ${new Date().toISOString()}`);
      console.log(`Project: /test/path`);
      
      const totalLines = sessions.reduce((sum, s) => 
        sum + (s.changes?.reduce((cSum, c) => cSum + c.linesAdded, 0) || 0), 0);
      console.log(`Total AI Contributed Lines: ${totalLines}\n`);

      // Group changes by file
      const changesByFile = new Map<string, Array<{content: string, lines: number}>>();
      
      sessions.forEach(session => {
        session.changes?.forEach(change => {
          if (!changesByFile.has(change.filePath)) {
            changesByFile.set(change.filePath, []);
          }
          if (change.content) {
             changesByFile.get(change.filePath)?.push({
               content: change.content,
               lines: change.linesAdded
             });
          }
        });
      });

      // Output per file
      changesByFile.forEach((changes, filePath) => {
        const totalFileLines = changes.reduce((sum, c) => sum + c.lines, 0);
        console.log(`File: ${filePath} (${totalFileLines} lines)`);
        console.log('-'.repeat(40));
        
        let lineNum = 1;
        changes.forEach(change => {
          // Split content into lines and print each
          // Handle potential array of strings or single string
          const contentLines = Array.isArray(change.content) 
            ? change.content 
            : change.content.split('\n');
            
          contentLines.forEach(line => {
             console.log(`${lineNum.toString().padStart(4, ' ')} | ${line}`);
             lineNum++;
          });
        });
        console.log(''); // Empty line between files
      });

      expect(sessions).toHaveLength(3);
      expect(sessions).toContainEqual(mockSession1);
      expect(sessions).toContainEqual(mockSession2);
      expect(sessions).toContainEqual(mockSession3);
      expect(mockScan).toHaveBeenCalledTimes(6); // Called for all 6 tools
    });

    it('should filter by specific tools if provided', () => {
      mockScan.mockImplementation((tool) => {
        if (tool === AITool.CLAUDE_CODE) return [mockSession1];
        if (tool === AITool.TRAE) return [mockSession2];
        return [];
      });

      const sessions = manager.scanAllSessions('/test/path', [AITool.CLAUDE_CODE]);
      console.log('Filtered sessions by tool (claude only):', sessions);
      
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual(mockSession1);
      // Should not verify call count for filtered tools strictly as implementation iterates all but continues
      // But we can check if scan was NOT called for excluded tools?
      // Implementation: if (tools && !tools.includes(scanner.tool)) continue;
      // So scan() should only be called for CLAUDE_CODE
      expect(mockScan).toHaveBeenCalledWith(AITool.CLAUDE_CODE, '/test/path');
      expect(mockScan).not.toHaveBeenCalledWith(AITool.TRAE, '/test/path');
    });

    it('should filter sessions by date (since) with various formats', () => {
      mockScan.mockImplementation((tool) => {
        if (tool === AITool.CLAUDE_CODE) return [mockSession1]; // Jan 2
        if (tool === AITool.TRAE) return [mockSession3]; // 2025-03-13
        return [];
      });

      // Helper to parse dates (simulating CLI logic)
      const parseDate = (dateStr: string) => {
        if (/^\d{12}$/.test(dateStr)) {
          const y = parseInt(dateStr.slice(0, 4), 10);
          const m = parseInt(dateStr.slice(4, 6), 10) - 1;
          const d = parseInt(dateStr.slice(6, 8), 10);
          const h = parseInt(dateStr.slice(8, 10), 10);
          const min = parseInt(dateStr.slice(10, 12), 10);
          return new Date(y, m, d, h, min);
        }
        if (/^\d{8}$/.test(dateStr)) {
          const y = parseInt(dateStr.slice(0, 4), 10);
          const m = parseInt(dateStr.slice(4, 6), 10) - 1;
          const d = parseInt(dateStr.slice(6, 8), 10);
          return new Date(y, m, d);
        }
        return new Date(dateStr);
      };

      // Case 3: Filter since 202603131200 (YYYYMMDDHHmm)
      const since3 = parseDate('202603131200');
      const sessions3 = manager.scanAllSessions('/test/path', undefined, since3);
      console.log(`Sessions since 202603131200 (${since3.toISOString()}):`, sessions3);
      expect(sessions3).toHaveLength(1); // Should include mockSession3 (13:00 > 12:00)
      expect(sessions3[0]).toEqual(mockSession3);

       // Case 4: Filter since 202401010900 (YYYYMMDDHHmm)
      const since4 = parseDate('202401010900');
      const sessions4 = manager.scanAllSessions('/test/path', undefined, since4);
      console.log(`Sessions since 202401010900 (${since4.toISOString()}):`, sessions4);
      expect(sessions4).toHaveLength(2); // Should include mockSession1 and mockSession3
    });

    it('should sort sessions by timestamp', () => {
      mockScan.mockImplementation((tool) => {
        if (tool === AITool.CLAUDE_CODE) return [mockSession2]; // Jan 3
        if (tool === AITool.TRAE) return [mockSession1]; // Jan 2
        return [];
      });

      const sessions = manager.scanAllSessions('/test/path');
      console.log('Sorted sessions by timestamp:', sessions.map(s => ({ id: s.id, time: s.timestamp.toISOString() })));
      
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toEqual(mockSession1); // Jan 2 first
      expect(sessions[1]).toEqual(mockSession2); // Jan 3 second
    });

    it('should handle scanner errors gracefully', () => {
      mockScan.mockImplementation((tool) => {
        if (tool === AITool.CLAUDE_CODE) {
            console.log('Simulating error in claude scanner...');
            throw new Error('Scan failed');
        }
        if (tool === AITool.TRAE) return [mockSession2];
        return [];
      });

      const sessions = manager.scanAllSessions('/test/path');
      console.log('Sessions after partial failure:', sessions);
      
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual(mockSession2);
    });
  });
});
