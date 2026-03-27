import chalk from 'chalk'
import Table from 'cli-table3'
import * as fs from 'fs'
import * as path from 'path'
import { AITool, ContributionStats, SessionType } from './types.js'

/**
 * Tool display names
 */
const TOOL_NAMES: Record<AITool, string> = {
  [AITool.CLAUDE_CODE]: 'Claude Code',
  [AITool.CODEX]: 'Codex CLI',
  [AITool.CURSOR]: 'Cursor',
  [AITool.GEMINI]: 'Gemini CLI',
  [AITool.OPENCODE]: 'Opencode',
  [AITool.TRAE]: 'Trae',
};

/**
 * Tool colors for console output
 */
const TOOL_COLORS: Record<AITool, typeof chalk> = {
  [AITool.CLAUDE_CODE]: chalk.hex('#D97757'),
  [AITool.CODEX]: chalk.hex('#00A67E'),
  [AITool.CURSOR]: chalk.hex('#FF6B6B'),
  [AITool.GEMINI]: chalk.hex('#4796E3'),
  [AITool.OPENCODE]: chalk.yellow,
  [AITool.TRAE]: chalk.hex('#5D5FEF'),
};

/**
 * Console reporter for terminal output
 */
export class ConsoleReporter {
  /**
   * Print the full summary report (without distribution)
   */
  printSummary(stats: ContributionStats): void {
    this.printHeader(stats);
    this.printOverview(stats);
    this.printToolBreakdown(stats);
    this.printFiles(stats);
  }

  /**
   * Print distribution bar (to be called at the end)
   */
  printDistribution(stats: ContributionStats): void {
    this.printDistributionBar(stats);
  }

  /**
   * Print report header with project overview
   */
  private printHeader(stats: ContributionStats): void {
    const title = 'AI 代码贡献分析';
    
    // Use project-wide totals if available
    const projectTotalFiles = stats.projectTotalFiles ?? stats.totalFiles;
    const projectTotalLines = stats.projectTotalLines ?? stats.totalLines;

    console.log();
    console.log(chalk.bold(title));
    console.log(`代码库: ${stats.repoUrl || stats.repoPath}`);
    if (stats.targetDirectory) {
      console.log(`目标目录: ${stats.targetDirectory}`);
    }
    console.log(`扫描时间: ${stats.scanTime.toLocaleString('zh-CN')}`);
    console.log(`验证模式: ${stats.verificationMode}`);
    console.log(`文件总数: ${projectTotalFiles}`);
    console.log(`代码总行数: ${projectTotalLines}`);
    console.log();
  }

  /**
   * Print AI contribution statistics
   */
  private printOverview(stats: ContributionStats): void {
    console.log(chalk.bold('📊 AI 贡献统计'));

    const table = new Table({
      head: ['指标', '原始数据', '新增代码', 'AI生成', 'AI贡献', 'AI生成占比', '采纳率'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });

    const raw = stats.rawStats;
    if (!raw) {
        console.log(chalk.yellow('无原始数据可供统计。'));
        return;
    }

    const verifiedSessions = stats.sessions.length;
    // Calculate verified lines from tool stats to handle deletions properly if needed,
    // but stats.aiContributedLines is the definitive "Added & Existing" lines.
    // For consistency with "lines added", we use stats.aiContributedLines.
    const verifiedLines = stats.aiContributedLines;
    const verifiedFiles = stats.aiTouchedFiles;
    
    // Determine raw data (Project Activity since X or Project Totals)
    let rawFilesDisplay = raw.totalFiles.toString();
    let rawLinesDisplay = raw.linesAdded.toString();
    let rawDeletedDisplay = raw.linesRemoved.toString();

    let shareFilesDenominator = stats.projectTotalFiles ?? stats.totalFiles;
    let shareLinesDenominator = stats.projectTotalLines ?? stats.totalLines;

    if (stats.projectChanges) {
      // Use project activity since time as "Original Data"
      rawFilesDisplay = stats.projectChanges.totalFiles.toString();
      // Use total lines of changed files as "Original Data" (current file sizes)
      rawLinesDisplay = stats.projectChanges.totalLinesOfChangedFiles.toString();

      rawDeletedDisplay = stats.projectChanges.linesRemoved.toString();

      // AI Contribution share is relative to total lines of changed files
      shareFilesDenominator = stats.projectChanges.totalFiles;
      shareLinesDenominator = stats.projectChanges.totalLinesOfChangedFiles;
    } else {
      // For full scans, "Original Data" is the whole project
      rawFilesDisplay = (stats.projectTotalFiles ?? stats.totalFiles).toString();
      rawLinesDisplay = (stats.projectTotalLines ?? stats.totalLines).toString();
      rawDeletedDisplay = '-';
    }

    // Change Data = AI Raw Generated
    const changeFilesDisplay = raw.totalFiles.toString();
    const changeLinesDisplay = raw.linesAdded.toString();
    const changeDeletedDisplay = raw.linesRemoved.toString();

    // Calculate pass rates (Adoption Rate = Verified / Raw)
    // Reverting to Verified / Raw as per user request "采纳率 还是AI贡献/变动数据"
    const sessionPassRate = raw.sessionsCount > 0
      ? ((verifiedSessions / raw.sessionsCount) * 100).toFixed(1) + '%'
      : '-';

    const filePassRate = raw.totalFiles > 0
      ? ((verifiedFiles / raw.totalFiles) * 100).toFixed(1) + '%'
      : '-';

    const linePassRate = raw.linesAdded > 0
      ? ((verifiedLines / raw.linesAdded) * 100).toFixed(1) + '%'
      : '-';

    // Calculate AI Generation Share (AI Contribution / Original Data)
    let originalFiles = stats.projectTotalFiles ?? stats.totalFiles;
    let originalLines = stats.projectTotalLines ?? stats.totalLines;
    
    // When using --since, denominator logic:
    // Files: Total active files
    // Lines: Added Lines (Gross) — same as "新增代码" column
    if (stats.projectChanges) {
        originalFiles = stats.projectChanges.totalFiles;
        originalLines = stats.projectChanges.linesAdded;
    }

    const fileShare = originalFiles > 0
      ? ((verifiedFiles / originalFiles) * 100).toFixed(1) + '%'
      : '0.0%';

    const lineShare = originalLines > 0
      ? ((verifiedLines / originalLines) * 100).toFixed(1) + '%'
      : '0.0%';

    // AI Contribution = Verified
    const verifiedDeleted = Array.from(stats.byTool.values()).reduce((sum, t) => sum + t.linesRemoved, 0);
    const contribFilesDisplay = verifiedFiles.toString();
    const contribLinesDisplay = verifiedLines.toString();
    const contribDeletedDisplay = verifiedDeleted.toString();

    // Calculate Display for Added Lines (Gross)
    let rawNetDisplay = '-';
    if (stats.projectChanges) {
        const added = stats.projectChanges.linesAdded;
        rawNetDisplay = added > 0 ? chalk.green(`+${added}`) : '0';
    } else {
        rawNetDisplay = chalk.green(`+${stats.totalLines}`);
    }
    
    table.push(
      ['会话数', raw.sessionsCount.toString(), '-', raw.sessionsCount.toString(), verifiedSessions.toString(), '-', sessionPassRate],
      ['文件数', rawFilesDisplay, '-', changeFilesDisplay, contribFilesDisplay, fileShare, filePassRate],
      ['代码行数', rawLinesDisplay, rawNetDisplay, changeLinesDisplay, contribLinesDisplay, lineShare, linePassRate],
      ['删除行', rawDeletedDisplay, '-', changeDeletedDisplay, contribDeletedDisplay, '-', '-'],
    );

    console.log(table.toString());
    console.log();
  }

  /**
   * Print breakdown by AI tool
   */
  private printToolBreakdown(stats: ContributionStats): void {
    if (stats.aiContributedLines === 0 && stats.sessions.length === 0) {
      console.log(chalk.yellow('未发现 AI 贡献记录。'));
      console.log();
      return;
    }

    if (stats.byTool.size === 0) {
      console.log(chalk.yellow('未发现 AI 贡献记录。'));
      console.log();
      return;
    }

    console.log(chalk.bold('🤖 各 AI 工具贡献明细'));

    const table = new Table({
      head: ['工具/模型', '会话数', '文件数', '新增行数', '删除行数', '占比'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });

    const totalLines = Array.from(stats.byTool.values())
      .reduce((sum, t) => sum + t.linesAdded, 0);

    const sortedTools = Array.from(stats.byTool.entries())
      .sort((a, b) => b[1].linesAdded - a[1].linesAdded);

    for (const [tool, toolStats] of sortedTools) {
      const share = totalLines > 0
        ? ((toolStats.linesAdded / totalLines) * 100).toFixed(1)
        : '0.0';
      const color = TOOL_COLORS[tool] || chalk.white;

      // Add tool row
      table.push([
        color(TOOL_NAMES[tool]),
        toolStats.sessionsCount.toString(),
        toolStats.totalFiles.toString(),
        chalk.green(`+${toolStats.linesAdded}`),
        chalk.red(`-${toolStats.linesRemoved}`),
        `${share}%`,
      ]);

      // Add model rows (if known and more than just "unknown" or if explicitly wanted)
      if (toolStats.byModel.size > 0) {
        // Sort models by lines added
        const sortedModels = Array.from(toolStats.byModel.entries())
          .sort((a, b) => b[1].linesAdded - a[1].linesAdded);

        for (const [modelName, modelStats] of sortedModels) {
           // Skip if model is 'unknown' and it's the only one (redundant)
           if (modelName === 'unknown' && toolStats.byModel.size === 1) continue;

           const modelShare = toolStats.linesAdded > 0
             ? ((modelStats.linesAdded / toolStats.linesAdded) * 100).toFixed(1)
             : '0.0';

           table.push([
             chalk.dim(`  └─ ${modelName}`),
             chalk.dim(modelStats.sessionsCount.toString()),
             chalk.dim(modelStats.totalFiles.toString()),
             chalk.dim(`+${modelStats.linesAdded}`),
             chalk.dim(`-${modelStats.linesRemoved}`),
             chalk.dim(`${modelShare}% (工具内)`),
           ]);
        }
      }
    }

    console.log(table.toString());
    console.log();
  }

  /**
   * Print distribution pie chart showing all code proportions
   */
  private printDistributionBar(stats: ContributionStats): void {
    console.log(chalk.bold('📈 贡献分布'));
    console.log();

    // Determine total lines for distribution base (Added Lines)
    let totalBaseLines = stats.projectTotalLines ?? stats.totalLines;
    
    // If using --since (projectChanges exists), use Original Data Added Lines
    if (stats.projectChanges) {
      totalBaseLines = stats.projectChanges.linesAdded;
    }

    if (totalBaseLines <= 0) {
      console.log(chalk.gray(`  项目新增代码量为 ${totalBaseLines}，无法展示分布。`));
      console.log();
      return;
    }

    // Build slices: proportion each AI tool's share of Added Lines
    const slices: { label: string; value: number; color: (s: string) => string }[] = [];

    // Calculate AI contribution for each tool (Added Lines)
    const sortedTools = Array.from(stats.byTool.entries())
      .sort((a, b) => b[1].linesAdded - a[1].linesAdded);

    let totalAIAddedLines = 0;
    
    for (const [tool, toolStats] of sortedTools) {
      // Use Verified Added Lines
      const toolAdded = toolStats.linesAdded;
      
      if (toolAdded > 0) {
        const color = TOOL_COLORS[tool] || chalk.white;
        slices.push({ 
          label: TOOL_NAMES[tool], 
          value: toolAdded, 
          color: (s: string) => color(s) 
        });
        totalAIAddedLines += toolAdded;
      }
    }

    // Remaining is "Unknown/Human" (Project Added - AI Added)
    let humanAddedLines = totalBaseLines - totalAIAddedLines;
    
    // If human added is negative (AI claims more added lines than project total,
    // possible due to verification inaccuracies or deleted-then-added scenarios), clamp to 0
    if (humanAddedLines < 0) {
        humanAddedLines = 0;
    }
    
    if (humanAddedLines > 0) {
      slices.push({ 
        label: '未知/人工', 
        value: humanAddedLines, 
        color: (s: string) => chalk.gray(s) 
      });
    }

    // The visual bar represents the sum of all components
    const displayTotal = totalAIAddedLines + humanAddedLines;
    
    // Render stacked horizontal bar
    const barWidth = 60;
    let bar = '';
    
    for (const slice of slices) {
      const ratio = slice.value / displayTotal;
      const width = Math.max(0, Math.round(ratio * barWidth));
      if (width > 0) {
        bar += slice.color('█'.repeat(width));
      }
    }
    
    // Fill remaining if rounding errors
    const currentLength = bar.replace(/\u001b\[\d+m/g, '').replace(/\u001b\[39m/g, '').length; // strip ansi
    if (currentLength < barWidth && slices.length > 0) {
       // Add to last slice
       // This is tricky with ANSI codes, simplified approach:
       // Just let it be slightly shorter or longer is fine for CLI visual
    }

    console.log(`  ${bar}`);
    console.log();

    // Legend with percentage bars per slice
    for (const slice of slices) {
      const pct = (slice.value / displayTotal) * 100;
      const dot = slice.color('●');
      console.log(`  ${dot} ${slice.label.padEnd(14)} ${pct.toFixed(1).padStart(5)}%  (${slice.value} 行)`);
    }

    console.log();
  }

  /**
   * Print detailed list of project changes
   */
  printProjectChanges(stats: ContributionStats, limit: number = 20): void {
    if (!stats.projectChanges || stats.projectChanges.files.length === 0) return;

    console.log(chalk.bold('📄 原始变动文件列表 (Original Data)'));
    
    // Sort files alphabetically
    const files = [...stats.projectChanges.files].sort();
    const displayFiles = limit > 0 ? files.slice(0, limit) : files;
    
    const table = new Table({
      head: ['文件路径', '新增行', '删除行', '净增量'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [60, 10, 10, 10],
    });

    for (const file of displayFiles) {
      // Use map check instead of optional chaining for safer access
      const fileStats = (stats.projectChanges.fileStats && stats.projectChanges.fileStats.get(file)) || { added: 0, removed: 0 };
      const net = fileStats.added - fileStats.removed;
      const netDisplay = net > 0 ? chalk.green(`+${net}`) : net < 0 ? chalk.red(`${net}`) : '0';
      
      table.push([
        file,
        fileStats.added.toString(),
        fileStats.removed.toString(),
        netDisplay
      ]);
    }

    console.log(table.toString());
    
    if (limit > 0 && files.length > limit) {
      console.log(chalk.dim(`... 还有 ${files.length - limit} 个文件未显示`));
    }
    console.log();
  }

  /**
   * Print file-level statistics
   */
  printFiles(stats: ContributionStats, limit: number = 20): void {
    console.log(chalk.bold('📁 AI 贡献最多的文件'));

    const table = new Table({
      head: ['文件', '原始数据', '新增代码', 'AI 贡献', '会话数', '类型', '贡献者详情'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
      colWidths: [30, 10, 10, 15, 8, 8, 30],
    });

    // Sort files by AI contribution lines (descending)
    const sortedFiles = Array.from(stats.byFile.entries())
      .filter(([, s]) => s.aiContributedLines > 0)
      .sort((a, b) => b[1].aiContributedLines - a[1].aiContributedLines)
      .slice(0, limit);

    for (const [filePath, fileStats] of sortedFiles) {
      // 1. File Path (Truncated)
      const displayPath = filePath.length > 28
        ? '...' + filePath.slice(-25)
        : filePath;

      // 2. Original Data (Total Lines)
      const originalData = fileStats.totalLines.toString();

      // 3. Added Lines (formerly Net Increment)
      let addedLinesDisplay = '-';
      let addedLinesValue = 0;
      if (stats.projectChanges && stats.projectChanges.fileStats) {
        const changeStats = stats.projectChanges.fileStats.get(filePath);
        if (changeStats) {
          const added = changeStats.added;
          addedLinesValue = added;
          addedLinesDisplay = chalk.green('+' + added.toString());
        }
      } else if (fileStats.contributionType === 'create') {
         // If created by AI (and we don't have projectChanges or it's not covered there),
         // we might assume added lines is total lines if it's a new file.
         addedLinesValue = fileStats.totalLines;
         addedLinesDisplay = chalk.green('+' + fileStats.totalLines);
      } else {
        // Fallback to total lines if no history/create info
        addedLinesValue = fileStats.totalLines;
      }

      // 4. AI Contribution (Lines + Ratio)
      // If we have added lines data (from --since or creation), calculate ratio against that.
      // Otherwise fallback to total lines ratio.
      let ratioValue = fileStats.aiContributionRatio;

      if (stats.projectChanges && addedLinesValue > 0) {
        // AI Contribution / Added Lines
        ratioValue = fileStats.aiContributedLines / addedLinesValue;
      } else if (stats.projectChanges && addedLinesValue === 0 && fileStats.totalLines > 0) {
        // File is in projectChanges but Git reports 0 added (e.g. file predates --since baseline).
        // Fall back to total lines ratio so we don't divide by zero or show meaningless %.
        ratioValue = fileStats.aiContributedLines / fileStats.totalLines;
      }

      // Cap at 100% to avoid displaying >100% due to counting discrepancies between
      // Git diff and scanner output (e.g. blank line treatment differences).
      ratioValue = Math.min(ratioValue, 1.0);
      const ratio = (ratioValue * 100).toFixed(1) + '%';
      const aiContribution = `${fileStats.aiContributedLines} (${ratio})`;

      // 5. Session Count
      const sessions = fileStats.sessionCount.toString();

      // 6. Type (Contribution Type)
      let type = '-';
      if (fileStats.contributionType === 'create') {
        type = chalk.green('新增');
      } else if (fileStats.contributionType === 'enhance') {
        type = chalk.yellow('优化');
      } else {
        type = chalk.gray('未知');
      }

      // 7. Contributors
      const contributors = Array.from(fileStats.contributions.entries())
        .sort((a, b) => b[1] - a[1]) // Sort by lines desc
        .map(([tool]) => TOOL_NAMES[tool])
        .join(', ');

      const displayContributors = contributors.length > 28 
        ? contributors.slice(0, 28) + '…' 
        : contributors;

      table.push([
        displayPath,
        originalData,
        addedLinesDisplay,
        aiContribution,
        sessions,
        type,
        displayContributors
      ]);
    }

    console.log(table.toString());
    console.log();
  }

  /**
   * Print session type statistics
   */
  printSessionTypes(stats: ContributionStats): void {
    if (!stats.sessionTypeStats || stats.sessionTypeStats.size === 0) return;

    console.log(chalk.bold('📊 会话类型统计'));
    console.log();

    const table = new Table({
      head: ['类型', '会话数', '说明'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });

    // Type labels and descriptions
    const typeInfo: Record<SessionType, { label: string; desc: string }> = {
      'code_contribution': { label: '代码贡献', desc: '修改或创建了项目代码' },
      'code_review': { label: '代码审查', desc: '只读取文件，未做修改' },
      'analysis': { label: '问题分析', desc: '调试、搜索、运行命令等' },
      'mixed': { label: '混合操作', desc: '多种操作但无代码变更' },
    };

    // Order by significance
    const typeOrder: SessionType[] = ['code_contribution', 'code_review', 'analysis', 'mixed'];

    for (const type of typeOrder) {
      const typeStats = stats.sessionTypeStats.get(type);
      if (!typeStats) continue;

      const info = typeInfo[type];
      const typeColor = type === 'code_contribution' ? chalk.green
        : type === 'code_review' ? chalk.blue
        : type === 'analysis' ? chalk.yellow
        : chalk.gray;

      // Count by tool
      const toolCounts = Array.from(typeStats.byTool.entries())
        .map(([tool, count]) => `${TOOL_NAMES[tool]}:${count}`)
        .join(', ');

      table.push([
        typeColor(info.label),
        typeStats.count.toString(),
        chalk.dim(info.desc),
      ]);
    }

    console.log(table.toString());
    console.log();
  }

  /**
   * Print timeline of AI activity
   */
  printTimeline(stats: ContributionStats, limit: number = 20): void {
    console.log(chalk.bold('📅 近期 AI 活动'));

    const table = new Table({
      head: ['时间', '工具/模型', '文件数', '变更'].map(h => chalk.bold(h)),
      style: { head: [], border: [] },
    });

    const recentSessions = stats.sessions.slice(-limit).reverse();

    for (const session of recentSessions) {
      const date = session.timestamp.toLocaleString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      const color = TOOL_COLORS[session.tool] || chalk.white;

      // Show tool name and model if available
      let toolDisplay = color(TOOL_NAMES[session.tool]);
      if (session.model && session.model !== 'unknown') {
        const modelShort = this.formatModelName(session.model);
        toolDisplay = toolDisplay + ' ' + chalk.dim(modelShort);
      }

      table.push([
        chalk.dim(date),
        toolDisplay,
        session.totalFilesChanged.toString(),
        chalk.green(`+${session.totalLinesAdded}`) + ' ' + chalk.red(`-${session.totalLinesRemoved}`),
      ]);
    }

    console.log(table.toString());
    console.log();
  }

  /**
   * Format model name for display (shorten long names)
   */
  private formatModelName(model: string): string {
    // Common model name patterns
    const patterns: Array<{ regex: RegExp; replacement: string }> = [
      { regex: /^claude-(\d+(?:\.\d+)?)-(\w+)$/i, replacement: 'Claude $1 $2' },
      { regex: /^claude-(\d+(?:\.\d+)?)$/i, replacement: 'Claude $1' },
      { regex: /^gpt-(\d+(?:\.\d+)?)-(\w+)$/i, replacement: 'GPT-$1 $2' },
      { regex: /^gpt-(\d+)$/i, replacement: 'GPT-$1' },
      { regex: /^gemini[-_]?(\d+(?:\.\d+)?)[-._]?(\w+)$/i, replacement: 'Gemini $1 $2' },
      { regex: /^gemini[-_]?(\d+(?:\.\d+)?)$/i, replacement: 'Gemini $1' },
    ];

    for (const { regex, replacement } of patterns) {
      const match = model.match(regex);
      if (match) {
        return model.replace(regex, replacement);
      }
    }

    // Handle Trae-style model names like "1_-_gemini-3-pro"
    if (model.includes('_-_')) {
      const parts = model.split('_-_');
      if (parts.length === 2) {
        return this.formatModelName(parts[1]);
      }
    }

    // Capitalize first letter if short enough
    if (model.length <= 15) {
      return model.charAt(0).toUpperCase() + model.slice(1);
    }

    // Truncate long names
    return model.substring(0, 12) + '...';
  }
}

/**
 * JSON reporter for structured output
 */
export class JsonReporter {
  /**
   * Generate JSON report
   */
  generate(stats: ContributionStats): string {
    const output = {
      repo_path: stats.repoPath,
      target_directory: stats.targetDirectory || null,
      scan_time: stats.scanTime.toISOString(),
      verification_mode: stats.verificationMode,
      overview: {
        total_files: stats.totalFiles,
        total_lines: stats.totalLines,
        ai_touched_files: stats.aiTouchedFiles,
        ai_contributed_lines: stats.aiContributedLines,
        ai_file_ratio: stats.totalFiles > 0 ? stats.aiTouchedFiles / stats.totalFiles : 0,
        ai_line_ratio: stats.totalLines > 0 ? stats.aiContributedLines / stats.totalLines : 0,
        total_sessions: stats.sessions.length,
      },
      by_tool: Object.fromEntries(
        Array.from(stats.byTool.entries())
          .sort((a, b) => b[1].linesAdded - a[1].linesAdded)
          .map(([tool, toolStats]) => [
          tool,
          {
            sessions_count: toolStats.sessionsCount,
            files_created: toolStats.filesCreated,
            files_modified: toolStats.filesModified,
            total_files: toolStats.totalFiles,
            lines_added: toolStats.linesAdded,
            lines_removed: toolStats.linesRemoved,
            net_lines: toolStats.netLines,
          },
        ])
      ),
      by_file: Object.fromEntries(
        Array.from(stats.byFile.entries())
          .filter(([, s]) => s.aiContributedLines > 0)
          .map(([filePath, fileStats]) => [
            filePath,
            {
              total_lines: fileStats.totalLines,
              ai_contributed_lines: fileStats.aiContributedLines,
              ai_contribution_ratio: fileStats.aiContributionRatio,
              contributions: Object.fromEntries(fileStats.contributions),
            },
          ])
      ),
      session_type_stats: stats.sessionTypeStats ? Object.fromEntries(
        Array.from(stats.sessionTypeStats.entries()).map(([type, typeStats]) => [
          type,
          {
            count: typeStats.count,
            by_tool: Object.fromEntries(typeStats.byTool),
          },
        ])
      ) : {},
    };

    return JSON.stringify(output, null, 2);
  }

  /**
   * Save JSON report to file
   */
  save(stats: ContributionStats, outputPath: string): void {
    const json = this.generate(stats);
    fs.writeFileSync(outputPath, json, 'utf-8');
  }
}

/**
 * Markdown reporter for documentation
 */
export class MarkdownReporter {
  /**
   * Generate Markdown report
   */
  generate(stats: ContributionStats): string {
    const lines: string[] = [];

    lines.push('# AI Contribution Report');
    lines.push('');
    lines.push(`**Repository:** \`${stats.repoPath}\``);
    if (stats.targetDirectory) {
      lines.push(`**Directory:** \`${stats.targetDirectory}\``);
    }
    lines.push(`**Generated:** ${stats.scanTime.toLocaleString()}`);
    lines.push(`**Verification:** ${stats.verificationMode}`);
    lines.push('');

    // Overview
    lines.push('## Overview');
    lines.push('');
    lines.push('| Metric | Total | AI Contribution |');
    lines.push('|--------|-------|-----------------|');

    const fileRatio = stats.totalFiles > 0 
      ? ((stats.aiTouchedFiles / stats.totalFiles) * 100).toFixed(1) 
      : '0.0';
    const lineRatio = stats.totalLines > 0 
      ? ((stats.aiContributedLines / stats.totalLines) * 100).toFixed(1) 
      : '0.0';

    lines.push(`| Files | ${stats.totalFiles} | ${stats.aiTouchedFiles} (${fileRatio}%) |`);
    lines.push(`| Lines | ${stats.totalLines} | ${stats.aiContributedLines} (${lineRatio}%) |`);
    lines.push(`| Sessions | ${stats.sessions.length} | - |`);
    lines.push('');

    // By Tool
    if (stats.byTool.size > 0) {
      lines.push('## Contribution by AI Tool');
      lines.push('');
      lines.push('| Tool | Sessions | Files | Lines Added | Lines Removed | Share |');
      lines.push('|------|----------|-------|-------------|---------------|-------|');

      const totalLines = Array.from(stats.byTool.values())
        .reduce((sum, t) => sum + t.linesAdded, 0);

      const sortedTools = Array.from(stats.byTool.entries())
        .sort((a, b) => b[1].linesAdded - a[1].linesAdded);
      for (const [tool, toolStats] of sortedTools) {
        const share = totalLines > 0 
          ? ((toolStats.linesAdded / totalLines) * 100).toFixed(1) 
          : '0.0';

        lines.push(
          `| ${TOOL_NAMES[tool]} | ${toolStats.sessionsCount} | ${toolStats.totalFiles} | +${toolStats.linesAdded} | -${toolStats.linesRemoved} | ${share}% |`
        );
      }
      lines.push('');
    }

    // Top Files
    const topFiles = Array.from(stats.byFile.entries())
      .filter(([, s]) => s.aiContributedLines > 0)
      .sort((a, b) => b[1].aiContributionRatio - a[1].aiContributionRatio)
      .slice(0, 10);

    if (topFiles.length > 0) {
      lines.push('## Top AI-Contributed Files');
      lines.push('');
      lines.push('| File | Total Lines | AI Lines | AI Ratio |');
      lines.push('|------|-------------|----------|----------|');

      for (const [filePath, fileStats] of topFiles) {
        const ratio = (fileStats.aiContributionRatio * 100).toFixed(1) + '%';
        lines.push(`| \`${filePath}\` | ${fileStats.totalLines} | ${fileStats.aiContributedLines} | ${ratio} |`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Save Markdown report to file
   */
  save(stats: ContributionStats, outputPath: string): void {
    const markdown = this.generate(stats);
    fs.writeFileSync(outputPath, markdown, 'utf-8');
  }
}
