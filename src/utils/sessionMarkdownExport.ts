import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import type { VerifiedSession } from '../core/algorithmv.js';
import { AITool, SessionOperations, SessionType } from '../types.js';

const TOOL_DISPLAY: Record<AITool, string> = {
  [AITool.CLAUDE_CODE]: 'Claude Code',
  [AITool.CODEX]: 'Codex CLI',
  [AITool.CURSOR]: 'Cursor',
  [AITool.GEMINI]: 'Gemini CLI',
  [AITool.OPENCODE]: 'Opencode',
  [AITool.TRAE]: 'Trae',
};

const SESSION_TYPE_LABEL: Record<SessionType, string> = {
  code_contribution: '代码贡献',
  code_review: '代码审查',
  analysis: '问题分析',
  mixed: '混合操作',
};

const FENCE_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx',
  '.js': 'javascript', '.jsx': 'javascript',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.md': 'markdown',
  '.css': 'css', '.scss': 'scss',
  '.html': 'html', '.vue': 'vue',
  '.py': 'python', '.rs': 'rust',
  '.go': 'go', '.java': 'java',
  '.kt': 'kotlin', '.swift': 'swift',
  '.rb': 'ruby', '.sh': 'bash',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.sql': 'sql', '.cs': 'csharp',
  '.cpp': 'cpp', '.c': 'c',
  '.h': 'c', '.hpp': 'cpp',
};

function escapeMdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function escapeFenceBody(lines: string[]): string {
  return lines.map(l => l.replace(/```/g, '`\\`\\`')).join('\n');
}

function guessFenceLang(filePath: string): string {
  return FENCE_LANG[path.extname(filePath).toLowerCase()] || '';
}

function formatOpsSummary(ops?: SessionOperations): string {
  if (!ops) return '—';
  const parts: string[] = [];
  if (ops.editCount) parts.push(`Edit×${ops.editCount}`);
  if (ops.writeCount) parts.push(`Write×${ops.writeCount}`);
  if (ops.readCount) parts.push(`Read×${ops.readCount}`);
  if (ops.bashCount) parts.push(`Bash×${ops.bashCount}`);
  if (ops.grepCount) parts.push(`Grep×${ops.grepCount}`);
  if (ops.globCount) parts.push(`Glob×${ops.globCount}`);
  if (ops.taskCount) parts.push(`Task×${ops.taskCount}`);
  if (ops.otherCount) parts.push(`其他×${ops.otherCount}`);
  return parts.length > 0 ? parts.join(', ') : '—';
}

function beijingTime(d: Date): string {
  return d.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function collectVerifiedLines(contrib: VerifiedSession['contributions'][0]): string[] {
  if (contrib.verifiedContent && contrib.verifiedContent.length > 0) {
    return contrib.verifiedContent;
  }
  if (contrib.change.addedLines && contrib.change.addedLines.length > 0) {
    return contrib.change.addedLines;
  }
  if (contrib.change.content && contrib.change.content.trim()) {
    return contrib.change.content.split(/\r?\n/);
  }
  return [];
}

/**
 * 获取 AI 原始代码（不经过验证过滤）
 */
function collectRawLines(change: VerifiedSession['contributions'][0]['change']): string[] {
  if (change.addedLines && change.addedLines.length > 0) {
    return change.addedLines;
  }
  if (change.content && change.content.trim()) {
    return change.content.split(/\r?\n/);
  }
  return [];
}

/**
 * 从 git 历史获取会话时刻的文件内容（原始基线）
 */
function getGitBaseline(repoPath: string, filePath: string, timestamp: Date): string[] | null {
  try {
    const isoTs = timestamp.toISOString();
    const hash = execFileSync('git', ['log', '-1', '--format=%H', `--before=${isoTs}`, '--', filePath], {
      cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!hash) return null;
    const content = execFileSync('git', ['show', `${hash}:${filePath}`], {
      cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return content.split(/\r?\n/);
  } catch {
    return null;
  }
}

/**
 * 获取当前文件的最新内容
 */
function getCurrentFileContent(repoPath: string, filePath: string): string[] | null {
  try {
    const fp = path.join(repoPath, filePath);
    return fs.readFileSync(fp, 'utf-8').split(/\r?\n/);
  } catch {
    return null;
  }
}

function sanitize(s: string): string {
  const r = s.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return r.length > 140 ? r.slice(0, 140) : r;
}

function highlightDiffLines(
  baseline: string[],
  current: string[],
  verifiedLines: string[]
): { before: string[]; added: string[] } {
  const verifiedSet = new Set(verifiedLines);
  const currentSet = new Set(current);

  const before: string[] = [];
  const added: string[] = [];

  for (const line of current) {
    if (verifiedSet.has(line)) added.push(`+ ${line}`);
  }

  for (const line of baseline) {
    if (!currentSet.has(line) && !verifiedSet.has(line)) before.push(`- ${line}`);
  }

  return { before, added };
}

export interface SessionMarkdownExportOptions {
  /** 仅导出指定操作类型的变更（默认全部导出） */
  filterOperations?: ('edit' | 'write')[];
}

export interface SessionMarkdownExportResult {
  outDir: string;
  indexPath: string;
  sessionFiles: string[];
}

export function exportVerifiedSessionsToMarkdown(
  verifiedSessions: VerifiedSession[],
  repoPath: string,
  cwdForLogs: string = process.cwd(),
  options: SessionMarkdownExportOptions = {}
): SessionMarkdownExportResult {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const logsRoot = path.resolve(cwdForLogs, 'logs', 'session-md');
  if (!fs.existsSync(logsRoot)) fs.mkdirSync(logsRoot, { recursive: true });
  const outDir = path.join(logsRoot, `session-md-${ts}`);
  fs.mkdirSync(outDir, { recursive: true });

  const sessionFiles: string[] = [];
  const filteredPerSession: VerifiedSession['contributions'][] = [];
  let seq = 0;
  const { filterOperations } = options;

  for (const vs of verifiedSessions) {
    const { session, contributions } = vs;

    // 按操作类型过滤
    const filtered = filterOperations && filterOperations.length > 0
      ? contributions.filter(c => c.change.operation && filterOperations.includes(c.change.operation))
      : contributions;
    filteredPerSession.push(filtered);

    seq += 1;
    const base = `${String(seq).padStart(3, '0')}-${sanitize(session.id)}`;
    const mdPath = path.join(outDir, `${base}.md`);

    const linesOut: string[] = [];
    linesOut.push('# AI 会话代码导出');
    linesOut.push('');
    linesOut.push('## 会话元数据');
    linesOut.push('');
    linesOut.push('| 属性 | 值 |');
    linesOut.push('|------|-----|');
    linesOut.push(`| 会话 ID | ${escapeMdCell(session.id)} |`);
    linesOut.push(`| Slug | ${escapeMdCell(session.slug || '—')} |`);
    linesOut.push(`| 时间 (UTC) | ${session.timestamp.toISOString()} |`);
    linesOut.push(`| 时间 (北京时间) | ${beijingTime(session.timestamp)} |`);
    linesOut.push(`| AI 工具 | ${escapeMdCell(TOOL_DISPLAY[session.tool] || session.tool)} |`);
    linesOut.push(`| 模型 | ${escapeMdCell(session.model || '—')} |`);
    linesOut.push(`| 会话类型 | ${escapeMdCell(session.sessionType ? SESSION_TYPE_LABEL[session.sessionType] : '—')} |`);
    linesOut.push(`| 工具调用统计 | ${escapeMdCell(formatOpsSummary(session.operations))} |`);
    linesOut.push(`| 变更文件数（过滤后） | ${new Set(filtered.map(c => c.change.filePath)).size} |`);
    const verifiedAdded = filtered.reduce((s, c) => s + c.verifiedLinesAdded, 0);
    linesOut.push(`| 验证后新增行（过滤后） | ${verifiedAdded} |`);
    linesOut.push(`| 仓库路径 | ${escapeMdCell(repoPath)} |`);
    linesOut.push('');

    if (filtered.length === 0) {
      linesOut.push('## 代码内容');
      linesOut.push('');
      if (filterOperations && filterOperations.length > 0) {
        linesOut.push(`> 本会话无 [${filterOperations.join('/')}] 操作类型的已验证变更。`);
      } else {
        linesOut.push('> 本会话无已验证的文件变更。');
      }
      linesOut.push('');
      fs.writeFileSync(mdPath, linesOut.join('\n'), 'utf-8');
      sessionFiles.push(mdPath);
      continue;
    }

    linesOut.push('## 代码内容（按文件）');
    linesOut.push('');

    for (const contrib of filtered) {
      const fp = contrib.change.filePath;
      const lang = guessFenceLang(fp);
      const verifiedLines = collectVerifiedLines(contrib);
      const verifiedCount = contrib.verifiedLinesAdded;

      linesOut.push(`### \`${fp}\``);
      linesOut.push('');
      linesOut.push(`| 变更类型 | ${contrib.change.changeType} |`);
      linesOut.push(`| 操作类型 | ${contrib.change.operation || '—'} |`);
      linesOut.push(`| AI 原始新增行 | ${contrib.change.linesAdded} |`);
      linesOut.push(`| 验证通过行 | ${verifiedCount} |`);
      linesOut.push(`| 验证模型 | ${escapeMdCell(contrib.modelName || '—')} |`);
      linesOut.push('');

      // 原始 AI 代码（不经过 verifyChangeLines 过滤）
      const rawLines = collectRawLines(contrib.change);
      const rawCount = rawLines.filter(l => l.trim()).length;

      // 获取基线和当前文件内容
      const baselineLines = getGitBaseline(repoPath, fp, session.timestamp);
      const currentLines = getCurrentFileContent(repoPath, fp);

      // --- 1. 如果有验证通过的代码，展示 diff ---
      if (verifiedLines.length > 0) {
        if (baselineLines && currentLines) {
          const diff = highlightDiffLines(baselineLines, currentLines, verifiedLines);
          if (diff.before.length > 0 || diff.added.length > 0) {
            linesOut.push('#### 验证后代码（当前文件中的 AI 代码）');
            linesOut.push('');
            linesOut.push('```diff ' + (lang || ''));
            for (const l of diff.before) linesOut.push(l);
            for (const l of diff.added) linesOut.push(l);
            linesOut.push('```');
            linesOut.push('');
          }
        } else {
          linesOut.push('#### 验证后代码（当前文件中的 AI 代码）');
          linesOut.push('');
          linesOut.push('```' + lang);
          for (const l of verifiedLines) linesOut.push(l);
          linesOut.push('```');
          linesOut.push('');
        }
      }

      // --- 2. 展示 AI 原始代码（change.content 完整内容）---
      const rawContent = contrib.change.content?.trim();
      if (rawContent) {
        const rawContentLines = rawContent.split(/\r?\n/);
        // 过滤掉全空行
        const nonEmptyLines = rawContentLines.filter(l => l.trim().length > 0);
        if (nonEmptyLines.length > 0) {
          linesOut.push('#### AI 原始代码（会话记录）');
          linesOut.push('');
          linesOut.push('> 以下为 AI 会话中记录的原始代码（含未验证通过的部分）');
          linesOut.push('');
          linesOut.push('```' + lang);
          for (const l of nonEmptyLines) linesOut.push(l);
          linesOut.push('```');
          linesOut.push('');
        }
      }
    }

    fs.writeFileSync(mdPath, linesOut.join('\n'), 'utf-8');
    sessionFiles.push(mdPath);
  }

  const indexPath = path.join(outDir, '_index.md');
  const indexLines: string[] = [];
  indexLines.push('# AI 会话导出索引');
  indexLines.push('');
  indexLines.push(`**生成时间:** ${new Date().toISOString()}`);
  indexLines.push(`**仓库:** \`${repoPath}\``);
  if (filterOperations && filterOperations.length > 0) {
    indexLines.push(`**操作过滤:** ${filterOperations.join('/')}`);
  }
  indexLines.push(`**会话总数:** ${verifiedSessions.length}`);
  indexLines.push('');
  indexLines.push('| # | 会话 ID | Slug | 时间 (UTC) | 工具 | 模型 | 验证新增行 | 详情 |');
  indexLines.push('|---|---------|------|------------|------|------|----------|------|');

  verifiedSessions.forEach((vs, i) => {
    const s = vs.session;
    const fname = path.basename(sessionFiles[i] || '');
    const link = fname ? `[打开](./${fname})` : '—';
    const vAdded = filteredPerSession[i].reduce((sum, c) => sum + c.verifiedLinesAdded, 0);
    indexLines.push(
      `| ${i + 1} | ${escapeMdCell(s.id)} | ${escapeMdCell(s.slug || '—')} | ${s.timestamp.toISOString()} | ${escapeMdCell(TOOL_DISPLAY[s.tool] || s.tool)} | ${escapeMdCell(s.model || '—')} | ${vAdded} | ${link} |`
    );
  });

  indexLines.push('');
  fs.writeFileSync(indexPath, indexLines.join('\n'), 'utf-8');
  return { outDir, indexPath, sessionFiles };
}
