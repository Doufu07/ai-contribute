# AI Contribution Tracker

A command-line tool to track and analyze AI coding assistants' contributions in your codebase (macOS/Linux/Windows). Supports **Claude Code**, **Codex CLI**, **Cursor**, **Gemini CLI**, **Opencode**, and **Trae**.

一款用于追踪和分析 AI 编码助手对代码库贡献的命令行工具（支持 macOS/Linux/Windows）。支持 **Claude Code**、**Codex CLI**、**Cursor**、**Gemini CLI**、**Opencode** 和 **Trae**。

## Quick Start / 快速开始

```bash
# Run directly with npx (no installation required)
# 直接使用 npx 运行（无需安装）
npx ai-contribute

# Or install globally
# 或全局安装
npm install -g ai-contribute
ai-contribute
```

## Features / 功能特性

- 🔍 **Auto-detection / 自动检测**: Automatically finds AI tool session data on your system
- 📊 **Detailed Statistics / 详细统计**: Lines of code, files modified, contribution ratios
- 🤖 **Multi-tool Support / 多工具支持**: Claude Code, Codex CLI, Cursor, Gemini CLI, Opencode, Trae
- 📈 **Visual Reports / 可视化报告**: Console, JSON, and Markdown output formats
- 📅 **Timeline View / 时间线视图**: Track AI contributions over time (use `-v` or `history` command)
- 📁 **File-level Analysis / 文件级分析**: See which files have the most AI contributions
- 📂 **Directory Statistics / 目录统计**: Aggregate contribution stats by directory (use `-v` flag)
- 🎯 **Directory Filter / 目录过滤**: Analyze only specific directories like `src` or `lib` (use `-d` flag)
- ✅ **Verification Comparison / 验证对比**: Compare raw AI data vs verified contributions with pass rate

## Usage / 使用方法

```bash
# Analyze current directory (default relaxed verification)
# 分析当前目录（默认宽松验证模式）
npx ai-contribute

# Analyze a specific repository / 分析指定仓库
npx ai-contribute /path/to/your/repo

# Show detailed output with directory, file stats and timeline
# 显示详细输出（包含目录、文件统计和时间线）
npx ai-contribute -v

# Export as JSON / 导出为 JSON
npx ai-contribute -f json -o report.json

# Only analyze specific tools / 只分析特定工具
npx ai-contribute -t claude,codex,trae

# Only analyze a specific directory (useful for Vue/React projects)
# 只分析特定目录（适用于 Vue/React 等前端项目）
npx ai-contribute -d src -v
npx ai-contribute -d src/components -v

# Only analyze backend source directory
# 只分析后端源码目录
npx ai-contribute /path/to/backend -d lib -v
```

## Commands / 命令

### Scan (Default) / 扫描（默认）

The main command to analyze a repository. If no command is specified, `scan` is implied.

```bash
npx ai-contribute scan [path] [options]
# or simply / 或直接使用
npx ai-contribute [path] [options]

# Options / 选项:
#   -f, --format <format>   Output format: console (default), json, markdown / 输出格式
#   -o, --output <file>     Output file path / 输出文件路径
#   -t, --tools <tools>     Comma-separated list of tools (claude,codex,cursor,gemini,opencode,trae,all)
#   --verification <mode>   Verification mode: strict, relaxed (default), historical / 验证模式
#   -d, --directory <dir>   Only analyze files in specific directory (e.g., src, lib) / 只分析指定目录
#   -v, --verbose           Show detailed output (directories, files, timeline) / 显示详细输出
```

### List Detected Tools / 列出检测到的工具

Shows which AI tools have data available on your system.

```bash
npx ai-contribute list
```

Example output:
```
🔍 Detected AI Tools

  Claude Code     ~/.claude/projects/              ✓ Available
  Codex CLI       ~/.codex/sessions/               ✓ Available
  Cursor          Cursor/User/workspaceStorage     ✓ Available
  Gemini CLI      ~/.gemini/tmp/                   ✗ Not found
  Opencode        ~/.local/share/opencode/         ✓ Available
  Trae            Trae/User/workspaceStorage       ✓ Available
```

### File-level Analysis / 文件级分析

Show detailed contribution statistics for individual files.

```bash
npx ai-contribute files [path] [-n LIMIT] [-d DIR] [--verification MODE]

# Options:
#   -n, --limit <number>    Number of files to show (default: 20)
#   -d, --directory <dir>   Only analyze files in specific directory
#   --verification <mode>   Verification mode (strict/relaxed/historical)
```

### Contribution History / 贡献历史

Show a timeline of AI contributions.

```bash
npx ai-contribute history [path] [-n LIMIT] [-d DIR] [--verification MODE]

# Options:
#   -n, --limit <number>    Number of entries to show (default: 20)
#   -d, --directory <dir>   Only analyze files in specific directory
#   --verification <mode>   Verification mode (strict/relaxed/historical)
```

### Session List / 会话列表

List verified AI sessions found for the repository.

```bash
npx ai-contribute sessions [path] [-t TOOLS] [-d DIR]

# Options:
#   -t, --tools <tools>     Filter by specific tools (comma-separated)
#   -d, --directory <dir>   Only analyze files in specific directory
```

## Output Example / 输出示例

```
╭──────────────────────────────────────────────────╮
│ AI 代码贡献分析                                   │
│ 代码库: /Users/xxx/project                        │
│ 扫描时间: 2026/3/5 09:41:47                       │
│ 验证模式: relaxed                                 │
╰──────────────────────────────────────────────────╯

📊 总体概览
┌────────────┬──────┬──────────────┐
│ 指标       │ 数值 │ AI 贡献      │
├────────────┼──────┼──────────────┤
│ 文件总数   │ 20   │ 4 (20.0%)    │
├────────────┼──────┼──────────────┤
│ 代码总行数 │ 5577 │ 1125 (20.2%) │
├────────────┼──────┼──────────────┤
│ AI 会话数  │ 2    │ -            │
└────────────┴──────┴──────────────┘

📋 验证对比 (原始 → 验证后)

┌────────┬──────────┬────────┬────────┐
│ 指标   │ 原始数据 │ 验证后 │ 通过率 │
├────────┼──────────┼────────┼────────┤
│ 会话数 │ 5        │ 5      │ 100.0% │
├────────┼──────────┼────────┼────────┤
│ 文件数 │ 13       │ 10     │ 76.9%  │
├────────┼──────────┼────────┼────────┤
│ 新增行 │ +1145    │ +727   │ 63.5%  │
├────────┼──────────┼────────┼────────┤
│ 删除行 │ -710     │ -448   │ -      │
└────────┴──────────┴────────┴────────┘
  验证模式: relaxed (只统计当前代码库中仍存在的贡献)

🤖 各 AI 工具贡献明细
┌────────────────────┬────────┬────────┬──────────┬──────────┬─────────────────┐
│ 工具/模型          │ 会话数 │ 文件数 │ 新增行数 │ 删除行数 │ 占比            │
├────────────────────┼────────┼────────┼──────────┼──────────┼─────────────────┤
│ Trae               │ 1      │ 2      │ +1042    │ -0       │ 86.1%           │
├────────────────────┼────────┼────────┼──────────┼──────────┼─────────────────┤
│ Claude Code        │ 1      │ 4      │ +168     │ -94      │ 13.9%           │
└────────────────────┴────────┴────────┴──────────┴──────────┴─────────────────┘

📈 贡献分布

  ████████████████████████████████████████████████████████████

  ● Trae            17.4%  (969 行)
  ● Claude Code      2.8%  (156 行)
  ● 未知/人工           79.8%  (4452 行)

📂 各目录 AI 贡献统计
┌────────┬────────┬─────────┬────────┬─────────┬─────────┐
│ 目录   │ 文件数 │ AI 文件 │ 总行数 │ AI 行数 │ AI 占比 │
├────────┼────────┼─────────┼────────┼─────────┼─────────┤
│ src    │ 13     │ 4       │ 4238   │ 1125    │ 26.5%   │
├────────┼────────┼─────────┼────────┼─────────┼─────────┤
│ 根目录 │ 7      │ 0       │ 600    │ 0       │ 0.0%    │
└────────┴────────┴─────────┴────────┴─────────┴─────────┘

📁 AI 贡献最多的文件
┌──────────────────────────────┬────────────┬──────────┬──────────┬───────────────┐
│ 文件                         │ 总行数     │ AI 行数  │ AI 占比  │ 贡献者        │
├──────────────────────────────┼────────────┼──────────┼──────────┼───────────────┤
│ src/analyzer.ts              │ 656        │ 656      │ 100.0%   │ Trae, Claude  │
├──────────────────────────────┼────────────┼──────────┼──────────┼───────────────┤
│ src/scanners/trae.ts         │ 386        │ 386      │ 100.0%   │ Claude Code   │
└──────────────────────────────┴────────────┴──────────┴──────────┴───────────────┘

📅 近期 AI 活动
┌──────────────────┬─────────────┬────────┬──────────┐
│ 时间             │ 工具        │ 文件数 │ 变更     │
├──────────────────┼─────────────┼────────┼──────────┤
│ 2026/03/02 13:02 │ Trae        │ 2      │ +1153 -0 │
├──────────────────┼─────────────┼────────┼──────────┤
│ 2026/03/02 11:07 │ Claude Code │ 4      │ +168 -94 │
└──────────────────┴─────────────┴────────┴──────────┘
```

## Supported AI Tools / 支持的 AI 工具

| Tool | Storage Location | Format |
|------|------------------|--------|
| Claude Code | `~/.claude/projects/<path>/` | JSONL |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/` | JSONL |
| Cursor | `~/Library/Application Support/Cursor/User/workspaceStorage` | SQLite (`state.vscdb`) |
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/` | JSON |
| Opencode | `~/.local/share/opencode/` | JSON |
| Trae | `~/Library/Application Support/Trae/User/workspaceStorage` | SQLite (`state.vscdb`) |

## How It Works

`ai-contribute` analyzes session log files from AI coding assistants and extracts file change records to quantify code contributions. Each AI tool stores its session data in a different format and location.

## Contribution Statistics Methodology

### Core Principle: Verified Existence

The tool applies a verification rule when calculating AI contribution statistics. The default is **relaxed**.

> **Only lines that currently exist in the codebase are counted as AI contributions.**

### How It Works

1. **Parse AI Session Logs**: The scanner reads session files from each AI tool and extracts file change events (writes, edits, patches).

2. **Build Repository File Set**: The tool gathers repository files using text-file extensions, excluding common build/vendor folders and honoring the root `.gitignore`.

3. **Extract Changed Content**: For each file change, the tool captures:
   - The file path
   - Lines added (new content)
   - Lines removed (old content)

4. **Verify Against Current Codebase**: Before counting any line as an AI contribution, the tool:
   - Reads the current content of the target file from the repository
   - For each line that AI claims to have added, checks if a matching line exists in the current file
   - In **relaxed** mode, matching ignores whitespace-only differences (trim + collapse spaces)
   - In **strict** mode, matching is character-for-character

5. **Calculate Statistics**: The verified lines are then aggregated into:
   - Per-file contribution counts
   - Per-directory contribution statistics
   - Per-tool contribution totals
   - Overall repository contribution ratios
   - **Sessions, files, and models are counted only when at least one verified line exists**

### Verification Modes

You can switch modes with `--verification`.

- `relaxed` (default): Match lines after normalizing whitespace.
- `strict`: Match lines exactly (character-for-character).
- `historical`: Count tool-reported added lines for files that still exist, capped by the current file's non-empty line count.

### Deduplication / 去重机制

The tool automatically deduplicates contributions to avoid over-counting:

- **Line-level deduplication**: If the same line was added by multiple AI sessions, it's only counted once
- **Normalized matching**: In relaxed mode, lines with only whitespace differences are considered duplicates
- **Per-file tracking**: Each file maintains a set of verified lines to prevent double-counting

### Why This Approach?

This methodology ensures that:
- Statistics reflect **actual, surviving** AI contributions
- Code that was later modified or removed by humans (or other AI tools) is not attributed to the original AI
- Contribution ratios are accurate and meaningful for understanding the current state of the codebase

### Verification Comparison / 验证对比

The tool shows a comparison between **raw AI session data** and **verified contributions**:

```
📋 验证对比 (原始 → 验证后)

┌────────┬──────────┬────────┬────────┐
│ 指标   │ 原始数据 │ 验证后 │ 通过率 │
├────────┼──────────┼────────┼────────┤
│ 会话数 │ 5        │ 5      │ 100.0% │
├────────┼──────────┼────────┼────────┤
│ 文件数 │ 13       │ 10     │ 76.9%  │
├────────┼──────────┼────────┼────────┤
│ 新增行 │ +1145    │ +727   │ 63.5%  │
└────────┴──────────┴────────┴────────┘
```

**What causes the difference? / 差异原因:**

| Cause | Description |
|-------|-------------|
| Code modified | Lines changed by humans or other AI tools |
| Code deleted | Files or lines removed from codebase |
| Duplicate edits | Same line modified multiple times (counted once) |
| File renamed/moved | Cannot verify contributions to moved files |

**Pass rate interpretation / 通过率解读:**
- **100%**: All AI contributions still exist in codebase
- **< 100%**: Some contributions were modified/removed
- **Low pass rate**: Code has been heavily modified since AI contributions

## Limitations

- Only tracks AI contributions that are recorded in local session files
- Cannot detect AI-generated code that was copy-pasted manually
- Accuracy depends on the completeness of AI tool session logs
- Some AI tools may not record all file operations
- Files ignored by the root `.gitignore` are excluded from Total Files/Lines
- Windows support for some tools depends on their session storage format compatibility

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

### Adding Support for New AI Tools

1. Create a new scanner in `src/scanners/`
2. Extend the `BaseScanner` class
3. Implement `tool`, `storagePath`, `scan()`, and `parseSessionFile()` methods
4. Add the scanner to `analyzer.ts`