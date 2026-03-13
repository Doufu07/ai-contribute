import { describe, it, expect } from 'vitest';
import { ScannerManager } from '../../src/core/scanners.js';
import * as path from 'path';
import * as fs from 'fs';

// Helper to parse dates (simulating CLI logic)
const parseDate = (dateStr: string) => {
  if (/^\d{14}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const min = parseInt(dateStr.slice(10, 12), 10);
    const s = parseInt(dateStr.slice(12, 14), 10);
    return new Date(y, m, d, h, min, s);
  }
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

describe('ScannerManager (Real Data)', () => {
  const manager = new ScannerManager();
  const projectPath = path.resolve(process.cwd()); // Use current project as test target
  
  // Get date from env or default to a recent date
  const testSinceStr = process.env.TEST_SINCE || '202603131200';

  it('should scan real sessions from the current project', () => {
    console.log(`Scanning project at: ${projectPath}`);
    const sessions = manager.scanAllSessions(projectPath);
    
    console.log(`Found ${sessions.length} sessions in total.`);
    
    // Output basic stats
    const tools = new Set(sessions.map(s => s.tool));
    console.log('Tools found:', Array.from(tools));
    
    const totalLines = sessions.reduce((sum, s) => 
      sum + (s.changes?.reduce((cSum, c) => cSum + c.linesAdded, 0) || 0), 0);
    console.log(`Total AI Contributed Lines: ${totalLines}`);

    // Verify we found at least some sessions (assuming the project itself has AI contributions)
    expect(sessions.length).toBeGreaterThan(0);
  });

  it(`should filter real sessions by date ${testSinceStr} and export content`, () => {
    const sinceStr = testSinceStr;
    const since = parseDate(sinceStr);
    
    console.log(`Filtering sessions since: ${sinceStr} (${since.toISOString()})`);
    const sessions = manager.scanAllSessions(projectPath, undefined, since);
    
    console.log(`Found ${sessions.length} sessions since ${sinceStr}`);
    
    // Export content to file
    if (sessions.length > 0) {
      const exportDir = path.resolve(projectPath, 'exports');
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }
      
      const datePrefix = sinceStr.slice(0, 8); // Extract YYYYMMDD
       const exportPath = path.join(exportDir, `ai-contributions-${datePrefix}.md`);
       let content = `# AI Contributions since ${sinceStr}\n\n`;
      content += `Generated at: ${new Date().toISOString()}\n`;
      content += `Total Sessions: ${sessions.length}\n\n`;
      
      sessions.forEach(s => {
        content += `## Session: ${s.id}\n`;
        content += `- Tool: ${s.tool}\n`;
        content += `- Date: ${s.timestamp.toISOString()}\n`;
        content += `- Files Changed: ${s.changes.length}\n\n`;
        
        s.changes.forEach(change => {
            content += `### File: ${change.filePath}\n`;
            content += `- Type: ${change.changeType}\n`;
            content += `- Lines Added: ${change.linesAdded}\n`;
            content += `- Lines Removed: ${change.linesRemoved}\n\n`;
            
            if (change.content) {
                content += '```typescript\n';
                content += change.content;
                content += '\n```\n\n';
            } else if (change.addedLines && change.addedLines.length > 0) {
                content += '```typescript\n';
                content += change.addedLines.join('\n');
                content += '\n```\n\n';
            } else {
                content += '> No content available\n\n';
            }

            // Try to read current file content for reference
            const fullPath = path.resolve(projectPath, change.filePath);
            if (fs.existsSync(fullPath)) {
                try {
                    const fileContent = fs.readFileSync(fullPath, 'utf-8');
                    content += '#### Current File Content (Reference)\n';
                    content += '```typescript\n';
                    content += fileContent;
                    content += '\n```\n\n';
                } catch (e) {
                    content += `> Error reading file: ${e}\n\n`;
                }
            } else {
                content += '> File not found on disk (may have been deleted or moved)\n\n';
            }
        });
        content += '---\n\n';
      });
      
      fs.writeFileSync(exportPath, content);
      console.log(`Exported session content to: ${exportPath}`);
    }

    // Verify all returned sessions are actually after the date
    sessions.forEach(s => {
      expect(s.timestamp.getTime()).toBeGreaterThanOrEqual(since.getTime());
    });
  });
});
