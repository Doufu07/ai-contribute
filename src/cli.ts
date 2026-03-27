import { Command } from 'commander'
import chalk from 'chalk'
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'readline'
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads'
import { ContributionAnalyzer } from './analyzer.js'
import { ConsoleReporter, JsonReporter, MarkdownReporter } from './reporter.js'
import { AITool, ContributionStats, OutputFormat, VerificationMode } from './types.js'
import { parseDate, formatCSTDisplay } from './utils/time.js'
import { printGitAnalysisResult, runGitAnalysis } from './utils/gitStat.js'

// This is replaced at build time with the actual version
const packageJson = { version: '1.0.0' };

// CommonJS compatibility
declare const __filename: string;

// Worker thread: run analysis off the main thread so ora can animate
if (!isMainThread) {
  const { projectPath, tools, verificationMode, directory, since } = workerData;
  console.error('Worker received since:', since, typeof since);
  const sinceDate = since ? new Date(since) : undefined;
  const analyzer = new ContributionAnalyzer(projectPath, verificationMode as VerificationMode | undefined, directory, sinceDate);
  let lastProgressSent = 0;
  let pendingPath: string | null = null;
  const sendProgress = (filePath: string) => {
    const now = Date.now();
    if (now - lastProgressSent < 50) {
      pendingPath = filePath;
      return;
    }
    const nextPath = pendingPath ?? filePath;
    pendingPath = null;
    lastProgressSent = now;
    parentPort!.postMessage({ type: 'progress', path: nextPath });
  };

  const stats = analyzer.analyze(tools, sendProgress);
  // ContributionStats contains Maps which can't be transferred directly
  // Serialize to JSON-safe format
  parentPort!.postMessage(JSON.stringify(stats, (_key, value) => {
    if (value instanceof Map) return { __type: 'Map', entries: Array.from(value.entries()) };
    return value;
  }));
  process.exit(0);
}

/**
 * Run analyzer in a worker thread to keep the main thread free for spinner animation
 */
function analyzeInWorker(
  projectPath: string,
  tools?: AITool[],
  verificationMode?: VerificationMode,
  directory?: string,
  since?: Date,
  onProgress?: (filePath: string) => void
): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(__filename, {
      workerData: {
        projectPath,
        tools,
        verificationMode,
        directory,
        since: since?.toISOString()
      },
    });
    worker.on('message', (msg: any) => {
      if (msg && typeof msg === 'object' && msg.type === 'progress') {
        if (onProgress && typeof msg.path === 'string') {
          onProgress(msg.path);
        }
        return;
      }
      const parsed = JSON.parse(msg, (_key, value) => {
        if (value && value.__type === 'Map') return new Map(value.entries);
        return value;
      });
      // Restore Date objects from ISO strings
      if (parsed.scanTime) parsed.scanTime = new Date(parsed.scanTime);
      if (parsed.sessions) {
        for (const s of parsed.sessions) {
          if (s.timestamp) s.timestamp = new Date(s.timestamp);
          if (s.changes) for (const c of s.changes) { if (c.timestamp) c.timestamp = new Date(c.timestamp); }
        }
      }
      resolve(parsed);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

/**
 * Rainbow text animation (same algorithm as chalk-animation)
 * Each character gets a hue from a full rainbow spread across the string,
 * shifting by 5 degrees per frame for smooth flow.
 */
function rainbowText(str: string, frame: number): string {
  const len = str.length;
  if (len === 0) return str;
  let result = '';
  for (let i = 0; i < len; i++) {
    if (str[i] === ' ') { result += ' '; continue; }
    const hue = ((i / len) * 360 - frame * 5 % 360 + 360) % 360;
    const [r, g, b] = hsvToRgb(hue, 1, 1);
    result += chalk.rgb(r, g, b)(str[i]);
  }
  return result;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function startRainbowLoading(text: string) {
  let frame = 0;
  let displayText = text;
  let secondaryText = '';
  const supportsCursor = process.stderr.isTTY === true;

  const fitToWidth = (input: string): string => {
    const columns = typeof process.stderr.columns === 'number' ? process.stderr.columns : 80;
    const maxWidth = Math.max(1, columns - 1);
    if (input.length <= maxWidth) return input;
    if (maxWidth <= 1) return input.slice(0, maxWidth);
    return `…${input.slice(input.length - (maxWidth - 1))}`;
  };

  const render = () => {
    if (!supportsCursor) return;
    const primary = fitToWidth(displayText);
    const secondary = fitToWidth(secondaryText);
    readline.moveCursor(process.stderr, 0, -1);
    readline.clearLine(process.stderr, 0);
    readline.cursorTo(process.stderr, 0);
    process.stderr.write(rainbowText(primary, frame));
    readline.moveCursor(process.stderr, 0, 1);
    readline.clearLine(process.stderr, 0);
    readline.cursorTo(process.stderr, 0);
    process.stderr.write(chalk.white(secondary));
  };

  process.stderr.write('\u001B[?25l'); // hide cursor
  if (supportsCursor) {
    process.stderr.write(`${rainbowText(fitToWidth(displayText), frame)}\n`);
    process.stderr.write(chalk.white(fitToWidth(secondaryText)));
  } else {
    process.stderr.write(`${displayText}\n`);
  }
  const interval = setInterval(() => {
    if (!supportsCursor) {
      frame++;
      return;
    }
    render();
    frame++;
  }, 15);
  return {
    updateSecondary(nextText: string) {
      secondaryText = nextText;
      render();
    },
    stop() {
      clearInterval(interval);
      if (supportsCursor) {
        readline.clearLine(process.stderr, 0);
        readline.moveCursor(process.stderr, 0, -1);
        readline.clearLine(process.stderr, 0);
        readline.moveCursor(process.stderr, 0, 1);
      }
      process.stderr.write('\u001B[?25h'); // show cursor
    },
    fail(msg: string) {
      clearInterval(interval);
      if (supportsCursor) {
        readline.clearLine(process.stderr, 0);
        readline.moveCursor(process.stderr, 0, -1);
        readline.clearLine(process.stderr, 0);
        readline.moveCursor(process.stderr, 0, 1);
      }
      process.stderr.write(`\r${chalk.red('✖')} ${msg}\n`);
      process.stderr.write('\u001B[?25h');
    },
  };
}

function generateLogFile(stats: any, repoPath: string) {
  if (!stats.aiContributedContent || stats.aiContributedContent.size === 0) {
    console.log(chalk.yellow('No AI contributions found to log.'));
    return;
  }

  const logsDir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFileName = `ai-contributions-${timestamp}.log`;
  const logPath = path.resolve(logsDir, logFileName);
  
  let logContent = `AI Contribution Log - ${formatCSTDisplay(new Date())}\n`;
  logContent += `Project: ${repoPath}\n`;
  logContent += `Total AI Contributed Lines: ${stats.aiContributedLines}\n\n`;
  
  // Sort files
  const files = Array.from(stats.aiContributedContent.keys()).sort() as string[];
  
  for (const file of files) {
      const lines = stats.aiContributedContent.get(file);
      if (lines && lines.length > 0) {
          logContent += `File: ${file} (${lines.length} lines)\n`;
          logContent += `----------------------------------------\n`;
          lines.forEach((line: string, index: number) => {
              logContent += `${(index + 1).toString().padStart(4, ' ')} | ${line}\n`;
          });
          logContent += `\n`;
      }
  }
  
  fs.writeFileSync(logPath, logContent);
  console.log(chalk.green(`Detailed contribution log saved to logs/${logFileName}`));
  
  generateOriginalFilesLog(stats, repoPath, timestamp);
}

function generateOriginalFilesLog(stats: any, repoPath: string, timestamp: string) {
  // Use projectChanges.files if available (when using --since), otherwise use aiContributedContent keys
  let files: string[] = [];
  let title = '';
  
  if (stats.projectChanges && stats.projectChanges.files.length > 0) {
      files = [...stats.projectChanges.files].sort();
      title = 'Project Changed Files Log (Net Increment)';
  } else if (stats.aiContributedContent && stats.aiContributedContent.size > 0) {
      files = Array.from(stats.aiContributedContent.keys()).sort() as string[];
      title = 'AI Contributed Files Log';
  } else {
      return;
  }

  const logsDir = path.resolve(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logFileName = `original-files-${timestamp}.log`;
  const logPath = path.resolve(logsDir, logFileName);
  
  let logContent = `${title} - ${formatCSTDisplay(new Date())}\n`;
  logContent += `Project: ${repoPath}\n`;
  if (stats.projectChanges) {
      const net = stats.projectChanges.netLinesAdded;
      const sign = net >= 0 ? '+' : '';
      logContent += `Total Net Increment: ${sign}${net} lines\n`;
      logContent += `Note: Showing content of files that changed during the period.\n\n`;
  } else {
      logContent += `Note: Showing content of files that have AI contributions.\n\n`;
  }
  
  for (const file of files) {
      const fullPath = path.resolve(repoPath, file);
      
      // Get file stats if available
      let fileStatsStr = '';
      if (stats.projectChanges && stats.projectChanges.fileStats) {
          const fileStat = stats.projectChanges.fileStats.get(file);
          if (fileStat) {
              const net = fileStat.added - fileStat.removed;
              const sign = net >= 0 ? '+' : '';
              fileStatsStr = ` (Added: ${fileStat.added}, Removed: ${fileStat.removed}, Net: ${sign}${net})`;
          }
      }

      // Check if we have diff content available (for projectChanges)
      if (stats.projectChanges && stats.projectChanges.fileDiffs && stats.projectChanges.fileDiffs.has(file)) {
          const diff = stats.projectChanges.fileDiffs.get(file);
          logContent += `File: ${file}${fileStatsStr} (Net Increment Diff)\n`;
          logContent += `----------------------------------------\n`;
          logContent += `${diff}\n\n`;
          continue;
      }

      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split(/\r?\n/);
          
          logContent += `File: ${file}${fileStatsStr} (Total: ${lines.length} lines)\n`;
          logContent += `----------------------------------------\n`;
          lines.forEach((line: string, index: number) => {
              logContent += `${(index + 1).toString().padStart(4, ' ')} | ${line}\n`;
          });
          logContent += `\n`;
        } else {
          // File might have been deleted
          logContent += `File: ${file}${fileStatsStr} (File not found/Deleted)\n\n`;
        }
      } catch (err) {
        logContent += `File: ${file} (Error reading file: ${err})\n\n`;
      }
  }
  
  fs.writeFileSync(logPath, logContent);
  console.log(chalk.green(`Original files log saved to logs/${logFileName}`));
}

const TOOL_MAP: Record<string, AITool> = {
  claude: AITool.CLAUDE_CODE,
  codex: AITool.CODEX,
  cursor: AITool.CURSOR,
  gemini: AITool.GEMINI,
  opencode: AITool.OPENCODE,
  trae: AITool.TRAE,
};

const TOOL_INFO: Record<AITool, { name: string; path: string }> = {
  [AITool.CLAUDE_CODE]: { name: 'Claude Code', path: '~/.claude/projects/' },
  [AITool.CODEX]: { name: 'Codex CLI', path: '~/.codex/sessions/' },
  [AITool.CURSOR]: { name: 'Cursor', path: 'Cursor/User/workspaceStorage' },
  [AITool.GEMINI]: { name: 'Gemini CLI', path: '~/.gemini/tmp/' },
  [AITool.OPENCODE]: { name: 'Opencode', path: '~/.local/share/opencode/' },
  [AITool.TRAE]: { name: 'Trae', path: 'Trae/User/workspaceStorage' },
};

/**
 * Parse tool string into array of AITool enums
 */
function parseTools(toolStr: string | undefined): AITool[] | undefined {
  if (!toolStr || toolStr.toLowerCase() === 'all') {
    return undefined;
  }

  const tools: AITool[] = [];
  for (const t of toolStr.toLowerCase().split(',')) {
    const trimmed = t.trim();
    if (trimmed in TOOL_MAP) {
      tools.push(TOOL_MAP[trimmed]);
    }
  }

  return tools.length > 0 ? tools : undefined;
}

function parseVerificationMode(mode: string | undefined): VerificationMode {
  const normalized = (mode || 'strict').toLowerCase();
  if (normalized === 'strict' || normalized === 'relaxed' || normalized === 'historical') {
    return normalized;
  }
  console.error(chalk.red(`Error: Invalid verification mode '${mode}'. Use strict, relaxed, or historical.`));
  process.exit(1);
}

function manualParseSince(options: any) {
  if (options.since) return;
  const args = process.argv;
  const idx = args.indexOf('--since');
  if (idx !== -1 && idx < args.length - 1) {
    options.since = args[idx + 1];
    // console.log('DEBUG: Manually parsed since:', options.since);
  }
}

const program = new Command();

program
  .name('ai-contribute')
  .description('CLI tool to track and analyze AI coding assistants\' contributions in your codebase')
  .version(packageJson.version);

// Main scan command
program
  .command('scan [path]')
  .description('Scan repository for AI contributions')
  .option('-f, --format <format>', 'Output format (console, json, markdown)', 'console')
  .option('-o, --output <file>', 'Output file path (for json/markdown formats)')
  .option('-t, --tools <tools>', 'AI tools to analyze (claude,codex,gemini,opencode or all)', 'all')
  .option('--verification <mode>', 'Verification mode (strict, relaxed, historical)', 'relaxed')
  .option('-d, --directory <dir>', 'Only analyze files in specific directory (e.g., src, lib)')
  .option('--since <date>', 'Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD)')
  .option('-v, --verbose', 'Show detailed output including files and timeline')
  .option('--log', 'Generate a detailed log file of AI contributions')
  .action(async (repoPath: string = '.', options) => {
    // Check if repoPath is actually options (when no path argument is provided)
    if (typeof repoPath === 'object' && repoPath !== null) {
      options = repoPath;
      repoPath = '.';
    }
    manualParseSince(options);

    const resolvedPath = path.resolve(repoPath);

    if (!fs.existsSync(resolvedPath)) {
      console.error(chalk.red(`Error: Path '${repoPath}' does not exist.`));
      process.exit(1);
    }

    const baseText = 'Analyzing repository...';
    const spinner = startRainbowLoading(baseText);

    try {
      const tools = parseTools(options.tools);
      const verificationMode = parseVerificationMode(options.verification);
      const sinceDate = parseDate(options.since);

      const stats = await analyzeInWorker(resolvedPath, tools, verificationMode, options.directory, sinceDate, (filePath) => {
        spinner.updateSecondary(filePath);
      });

      spinner.stop();

      if (options.log) {
        generateLogFile(stats, resolvedPath);
      }

      const format = options.format as OutputFormat;

      if (format === 'console') {
        const reporter = new ConsoleReporter();
        reporter.printSummary(stats);

        // Print session type statistics after summary
        reporter.printSessionTypes(stats);

        if (options.verbose) {
          reporter.printTimeline(stats);
        }

        reporter.printDistribution(stats);
      } else if (format === 'json') {
        const reporter = new JsonReporter();
        if (options.output) {
          reporter.save(stats, options.output);
          console.log(chalk.green(`Report saved to ${options.output}`));
        } else {
          console.log(reporter.generate(stats));
        }
      } else if (format === 'markdown') {
        const reporter = new MarkdownReporter();
        if (options.output) {
          reporter.save(stats, options.output);
          console.log(chalk.green(`Report saved to ${options.output}`));
        } else {
          console.log(reporter.generate(stats));
        }
      }
    } catch (error: any) {
      spinner.fail('Analysis failed');
      console.error(chalk.red(`Error details:`));
      if (error && error.stack) {
        console.error(error.stack);
      } else {
        console.error(error);
      }
      process.exit(1);
    }
  });

// Git Stat command
program
  .command('git-stat [path]')
  .description('Show Git contribution statistics (replicates git.test.ts logic)')
  .option('--since <date>', 'Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD)')
  .option('-d, --directory <dir>', 'Only analyze files in specific directory')
  .action(async (repoPath: string = '.', options) => {
    // Check if repoPath is actually options
    if (typeof repoPath === 'object' && repoPath !== null) {
      options = repoPath;
      repoPath = '.';
    }
    manualParseSince(options);

    const resolvedPath = path.resolve(repoPath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(chalk.red(`Error: Path '${repoPath}' does not exist.`));
      process.exit(1);
    }

    if (!options.since) {
      console.error(chalk.red('Error: --since <date> is required for git-stat command.'));
      console.log(chalk.yellow('Example: npx ai-contribute git-stat --since 20260101'));
      process.exit(1);
    }

    const sinceDate = parseDate(options.since);
    if (!sinceDate) {
       console.error(chalk.red('Error: Invalid date format.'));
       process.exit(1);
    }

    runGitAnalysis(resolvedPath, sinceDate, options.directory);
  });

// List command
program
  .command('list')
  .description('List detected AI tools with available data')
  .action(() => {
    console.log();
    console.log(chalk.bold('🔍 Detected AI Tools'));
    console.log();

    const analyzer = new ContributionAnalyzer('.');
    const available = analyzer.getAvailableTools();

    for (const tool of Object.values(AITool)) {
      const info = TOOL_INFO[tool];
      const status = available.includes(tool)
        ? chalk.green('✓ Available')
        : chalk.dim('✗ Not found');

      console.log(`  ${info.name.padEnd(15)} ${info.path.padEnd(30)} ${status}`);
    }

    console.log();
  });

// Files command
program
  .command('files [path]')
  .description('Show file-level AI contribution details')
  .option('-n, --limit <number>', 'Number of files to show', '20')
  .option('--verification <mode>', 'Verification mode (strict, relaxed, historical)', 'relaxed')
  .option('-d, --directory <dir>', 'Only analyze files in specific directory (e.g., src, lib)')
  .option('--since <date>', 'Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD)')
  .action(async (repoPath: string = '.', options) => {
    // Check if repoPath is actually options (when no path argument is provided)
    if (typeof repoPath === 'object' && repoPath !== null) {
      options = repoPath;
      repoPath = '.';
    }
    manualParseSince(options);

    const resolvedPath = path.resolve(repoPath);
    const baseText = 'Analyzing files...';
    const spinner = startRainbowLoading(baseText);

    try {
      const verificationMode = parseVerificationMode(options.verification);
      const sinceDate = parseDate(options.since);
      const stats = await analyzeInWorker(resolvedPath, undefined, verificationMode, options.directory, sinceDate, (filePath) => {
        spinner.updateSecondary(filePath);
      });
      spinner.stop();

      const reporter = new ConsoleReporter();
      reporter.printFiles(stats, parseInt(options.limit, 10));
    } catch (error: any) {
      spinner.fail('Analysis failed');
      console.error(chalk.red(`Error details:`));
      if (error && error.stack) {
        console.error(error.stack);
      } else {
        console.error(error);
      }
      process.exit(1);
    }
  });

// History command
program
  .command('history [path]')
  .description('Show AI contribution history/timeline')
  .option('-n, --limit <number>', 'Number of entries to show', '20')
  .option('--verification <mode>', 'Verification mode (strict, relaxed, historical)', 'relaxed')
  .option('-d, --directory <dir>', 'Only analyze files in specific directory (e.g., src, lib)')
  .option('--since <date>', 'Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD)')
  .action(async (repoPath, options, cmd) => {
    // Check if repoPath is actually options (when no path argument is provided)
    if (typeof repoPath === 'object' && repoPath !== null) {
      cmd = options;
      options = repoPath;
      repoPath = '.';
    }
    
    // Manual fallback for --since
    manualParseSince(options);

    const resolvedPath = path.resolve(repoPath || '.');
    const baseText = 'Loading history...';
    const spinner = startRainbowLoading(baseText);

    try {
      const verificationMode = parseVerificationMode(options.verification);
      const sinceDate = parseDate(options.since);
      const stats = await analyzeInWorker(resolvedPath, undefined, verificationMode, options.directory, sinceDate, (filePath) => {
        spinner.updateSecondary(filePath);
      });
      spinner.stop();

      const reporter = new ConsoleReporter();
      reporter.printTimeline(stats, parseInt(options.limit, 10));
    } catch (error: any) {
      // spinner.fail('Analysis failed');
      console.error(chalk.red(`Error details:`));
      if (error && error.stack) {
        console.error(error.stack);
      } else {
        console.error(error);
      }
      process.exit(1);
    }
  });

// Sessions command
program
  .command('sessions [path]')
  .description('List all AI sessions for the repository')
  .option('-t, --tools <tools>', 'AI tools to include', 'all')
  .option('-d, --directory <dir>', 'Only analyze files in specific directory (e.g., src, lib)')
  .option('--since <date>', 'Only show sessions since date (YYYYMMDD or YYYY-MM-DD)')
  .action(async (repoPath: string = '.', options) => {
    // Check if repoPath is actually options (when no path argument is provided)
    if (typeof repoPath === 'object' && repoPath !== null) {
      options = repoPath;
      repoPath = '.';
    }
    manualParseSince(options);

    const resolvedPath = path.resolve(repoPath);
    const sinceDate = parseDate(options.since);
    const analyzer = new ContributionAnalyzer(resolvedPath, 'relaxed', options.directory, sinceDate);
    const tools = parseTools(options.tools);
    // Use analyze() to get verified session data
    const stats = analyzer.analyze(tools);
    const sessions = stats.sessions;

    console.log();
    console.log(chalk.bold(`📋 AI Sessions for ${resolvedPath}`));
    console.log();

    if (sessions.length === 0) {
      console.log(chalk.yellow('No sessions found.'));
      return;
    }

    const toolColors: Record<AITool, typeof chalk> = {
      [AITool.CLAUDE_CODE]: chalk.hex('#D97757'),
      [AITool.CODEX]: chalk.hex('#00A67E'),
      [AITool.CURSOR]: chalk.hex('#FF6B6B'),
      [AITool.GEMINI]: chalk.hex('#4796E3'),
      [AITool.OPENCODE]: chalk.yellow,
      [AITool.TRAE]: chalk.hex('#5D5FEF'),
    };

    // Show last 20 sessions
    const recentSessions = sessions.slice(-20);
    for (const session of recentSessions) {
      const color = toolColors[session.tool] || chalk.white;
      const toolName = TOOL_INFO[session.tool].name;
      const date = session.timestamp.toLocaleString('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });

      console.log(
        `  ${color(toolName.padEnd(12))} ` +
        `${chalk.dim(date)}  ` +
        `Files: ${session.totalFilesChanged.toString().padStart(3)}  ` +
        `Lines: ${chalk.green(`+${session.totalLinesAdded}`)}`
      );
    }

    console.log();
    console.log(chalk.dim(`Total: ${sessions.length} sessions`));
    console.log();
  });

// Default command (scan current directory)
program
  .argument('[path]', 'Repository path to analyze', '.')
  .option('-f, --format <format>', 'Output format (console, json, markdown)', 'console')
  .option('-o, --output <file>', 'Output file path')
  .option('-t, --tools <tools>', 'AI tools to analyze', 'all')
  .option('--verification <mode>', 'Verification mode (strict, relaxed, historical)', 'relaxed')
  .option('-d, --directory <dir>', 'Only analyze files in specific directory (e.g., src, lib)')
  .option('--since <date>', 'Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD)')
  .option('-v, --verbose', 'Show detailed output')
  .option('--log', 'Generate a detailed log file of AI contributions')
  .action(async (repoPath: string, options) => {
    manualParseSince(options);
    // If no subcommand is provided, run scan
    const resolvedPath = path.resolve(repoPath);

    if (!fs.existsSync(resolvedPath)) {
      console.error(chalk.red(`Error: Path '${repoPath}' does not exist.`));
      process.exit(1);
    }

    const baseText = 'Analyzing repository...';
    const spinner = startRainbowLoading(baseText);

    try {
      const tools = parseTools(options.tools);
      const verificationMode = parseVerificationMode(options.verification);
      const sinceDate = parseDate(options.since);
      const stats = await analyzeInWorker(resolvedPath, tools, verificationMode, options.directory, sinceDate, (filePath) => {
        spinner.updateSecondary(filePath);
      });

      spinner.stop();

      if (options.log) {
        generateLogFile(stats, resolvedPath);
      }

      const format = options.format as OutputFormat;

      if (format === 'console') {
        const reporter = new ConsoleReporter();
        reporter.printSummary(stats);

        // Print session type statistics after summary
        reporter.printSessionTypes(stats);

        if (options.verbose) {
          reporter.printTimeline(stats);
        }

        reporter.printDistribution(stats);
      } else if (format === 'json') {
        const reporter = new JsonReporter();
        if (options.output) {
          reporter.save(stats, options.output);
          console.log(chalk.green(`Report saved to ${options.output}`));
        } else {
          console.log(reporter.generate(stats));
        }
      } else if (format === 'markdown') {
        const reporter = new MarkdownReporter();
        if (options.output) {
          reporter.save(stats, options.output);
          console.log(chalk.green(`Report saved to ${options.output}`));
        } else {
          console.log(reporter.generate(stats));
        }
      }
    } catch (error: any) {
      spinner.fail('Analysis failed');
      console.error(chalk.red(`Error details:`));
      if (error && error.stack) {
        console.error(error.stack);
      } else {
        console.error(error);
      }
      process.exit(1);
    }
  });

program.parse();
