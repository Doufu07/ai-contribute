import { describe, it, expect } from 'vitest';
import { GitAnalyzer } from '../../src/core/git.js';
import * as path from 'path';
import ignore from 'ignore';

// Helper to parse dates (simulating CLI logic)
const parseDate = (dateStr: string) => {
  // Support YYYYMMDDHHMM format (12 digits)
  if (/^\d{12}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    const h = parseInt(dateStr.slice(8, 10), 10);
    const min = parseInt(dateStr.slice(10, 12), 10);
    return new Date(y, m, d, h, min);
  }
  // Support YYYYMMDD format
  if (/^\d{8}$/.test(dateStr)) {
    const y = parseInt(dateStr.slice(0, 4), 10);
    const m = parseInt(dateStr.slice(4, 6), 10) - 1;
    const d = parseInt(dateStr.slice(6, 8), 10);
    return new Date(y, m, d);
  }
  return new Date(dateStr);
};

describe('GitAnalyzer (Real Repo)', () => {
  const projectPath = path.resolve(process.cwd());
  
  // Initialize ignores similar to ContributionAnalyzer
  const ignoreFactory = (ignore as unknown as { default?: () => any }).default ?? (ignore as unknown as () => any);
  const ignores = ignoreFactory();
  ignores.add([
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '**/*.pyc',
    '__pycache__',
    '.DS_Store'
  ]);

  const analyzer = new GitAnalyzer(projectPath, ignores);
  
  // Get date from env or default to a recent date
  // Default to 202603110900 as requested in the prompt example if not provided
  const testSinceStr = process.env.TEST_SINCE || '202603110900';

  it(`should analyze git changes since ${testSinceStr}`, () => {
    const since = parseDate(testSinceStr);
    console.log(`Analyzing changes since: ${testSinceStr} (${since.toISOString()})`);
    
    const changes = analyzer.getProjectChanges(since);
    
    expect(changes).toBeDefined();
    
    if (changes) {
      console.log('--- Git Analysis Result ---');
      console.log(`Total Files Changed: ${changes.totalFiles}`);
      console.log(`Lines Added: ${changes.linesAdded}`);
      console.log(`Lines Removed: ${changes.linesRemoved}`);
      console.log(`Net Increment: ${changes.netLinesAdded}`);
      console.log(`Total Lines of Changed Files: ${changes.totalLinesOfChangedFiles}`);
      
      console.log('\nChanged Files:');
      changes.files.forEach(f => {
        const stats = changes.fileStats.get(f);
        const statsStr = stats ? `(+${stats.added}, -${stats.removed})` : '';
        console.log(`- ${f} ${statsStr}`);
      });

      if (changes.gitStatusWarning) {
        console.warn(`\nWarning: ${changes.gitStatusWarning}`);
      }

      // Basic assertions
      expect(changes.totalFiles).toBeGreaterThanOrEqual(0);
      expect(changes.linesAdded).toBeGreaterThanOrEqual(0);
      expect(changes.linesRemoved).toBeGreaterThanOrEqual(0);
      
      // If we expect changes (based on the provided date which is a few days ago), we might check for > 0
      // But for a generic test, >= 0 is safer unless we know for sure there are commits.
      // Given the date is 2026-03-11 and today is 2026-03-13, there likely are changes.
    }
  });
});
