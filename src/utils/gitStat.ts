
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ignore from 'ignore';
import { GitAnalyzer } from '../core/git.js';
import { DEFAULT_IGNORES } from '../config/ignore.js';

/**
 * Execute Git analysis logic
 */
export function runGitAnalysis(resolvedPath: string, sinceDate: Date, directory?: string) {
    console.log(chalk.blue(`正在分析 ${resolvedPath} 中自 ${sinceDate.toISOString()} 以来的 Git 变更...`));
    
    // Initialize GitAnalyzer with default ignores
    const ig = ignore();
    ig.add(DEFAULT_IGNORES);
    
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
        if (changes.gitStatusWarning) {
            console.warn(chalk.yellow(`警告: ${changes.gitStatusWarning}`));
        }
        
        // Print Git metadata
        const gitInfo = analyzer.getGitInfo();
        if (gitInfo.branch || gitInfo.username || gitInfo.email || gitInfo.remoteUrl) {
            console.log(chalk.cyan('\n--- Git 信息 ---'));
            if (gitInfo.branch) console.log(chalk.gray(`当前分支: ${gitInfo.branch}`));
            if (gitInfo.username) console.log(chalk.gray(`用户名称: ${gitInfo.username}`));
            if (gitInfo.email) console.log(chalk.gray(`用户邮箱: ${gitInfo.email}`));
            if (gitInfo.remoteUrl) console.log(chalk.gray(`远程仓库: ${gitInfo.remoteUrl}`));
        }
        
        printGitAnalysisResult(changes);
    } else {
        console.error(chalk.red('获取 Git 变更失败。'));
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
  console.log('--- Git 分析结果 ---');
  console.log(`变更文件总数: ${changes.totalFiles}`);
  console.log(`新增代码行数: ${changes.linesAdded}`);
  console.log(`删除代码行数: ${changes.linesRemoved}`);
  console.log(`变更文件总行数: ${changes.totalLinesOfChangedFiles}`);
  console.log(`新增空行数: ${changes.emptyLinesAdded}`);
  console.log(`删除空行数: ${changes.emptyLinesRemoved}`);
  
  console.log('\n变更文件列表:');
  changes.files.forEach(f => {
    const stats = changes.fileStats.get(f);
    const statsStr = stats ? `(+${stats.added}, -${stats.removed})` : '';
    console.log(`- ${f} ${statsStr}`);
  });

  if (changes.gitStatusWarning) {
    console.warn(`\n警告: ${changes.gitStatusWarning}`);
  }
}
