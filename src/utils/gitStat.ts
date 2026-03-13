
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ignore from 'ignore';
import { GitAnalyzer } from '../core/git.js';

/**
 * Execute Git analysis logic
 */
export function runGitAnalysis(resolvedPath: string, sinceDate: Date, directory?: string) {
    console.log(chalk.blue(`Analyzing Git changes in ${resolvedPath} since ${sinceDate.toISOString()}...`));
    
    // Initialize GitAnalyzer with default ignores
    const ig = ignore();
    ig.add(['.git', 'node_modules', 'dist', 'build', 'coverage', '**/*.pyc', '__pycache__', '.DS_Store']);
    
    // Try to read .gitignore
    const gitignorePath = path.join(resolvedPath, '.gitignore');
    if (fs.existsSync(gitignorePath)) {
        try {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf-8');
            ig.add(gitignoreContent);
        } catch (e) {
            // ignore error
        }
    }

    const analyzer = new GitAnalyzer(resolvedPath, ig);
    const changes = analyzer.getProjectChanges(sinceDate, directory);

    if (changes) {
        printGitAnalysisResult(changes);
    } else {
        console.error(chalk.red('Failed to get Git changes.'));
        process.exit(1);
    }
}

/**
 * Print detailed Git analysis result to console
 * Replicates the logic from git.test.ts for CLI usage
 */
export function printGitAnalysisResult(changes: {
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
  netLinesAdded: number;
  totalLinesOfChangedFiles: number;
  files: string[];
  fileStats: Map<string, { added: number, removed: number }>;
  gitStatusWarning?: string;
  emptyLinesAdded: number;
  emptyLinesRemoved: number;
}) {
  console.log('--- Git Analysis Result ---');
  console.log(`Total Files Changed: ${changes.totalFiles}`);
  console.log(`Lines Added: ${changes.linesAdded}`);
  console.log(`Lines Removed: ${changes.linesRemoved}`);
  console.log(`Net Increment: ${changes.netLinesAdded}`);
  console.log(`Total Lines of Changed Files: ${changes.totalLinesOfChangedFiles}`);
  console.log(`Empty Lines Added: ${changes.emptyLinesAdded}`);
  console.log(`Empty Lines Removed: ${changes.emptyLinesRemoved}`);
  
  console.log('\nChanged Files:');
  changes.files.forEach(f => {
    const stats = changes.fileStats.get(f);
    const statsStr = stats ? `(+${stats.added}, -${stats.removed})` : '';
    console.log(`- ${f} ${statsStr}`);
  });

  if (changes.gitStatusWarning) {
    console.warn(`\nWarning: ${changes.gitStatusWarning}`);
  }
}
