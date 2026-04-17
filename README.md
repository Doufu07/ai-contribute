# AI Contribution Tracker

A command-line tool to track and analyze AI coding assistants' contributions in your codebase (macOS/Linux/Windows). Supports **Claude Code**, **Codex CLI**, **Cursor**, **Gemini CLI**, **Opencode**, and **Trae**.

一款用于追踪和分析 AI 编码助手对代码库贡献的命令行工具（支持 macOS/Linux/Windows）。支持 **Claude Code**、**Codex CLI**、**Cursor**、**Gemini CLI**、**Opencode** 和 **Trae**。

## Quick Start / 快速开始

```bash
# Method 1: Use tsx directly (recommended for development)
# 方法 1：直接使用 tsx 运行（推荐开发模式，无需构建）
npm run dev -- .

# Method 2: Build then run
# 方法 2：先构建再运行
npm run build
node dist/cli.js

# Method 3: Use npx (requires the package to be published or linked)
# 方法 3：使用 npx（需要已发布或 link）
npx ai-contribute
```

## Features / 功能特性

- 🔍 **Auto-detection / 自动检测**: Automatically finds AI tool session data on your system
- 📊 **Detailed Statistics / 详细统计**: Lines of code, files modified, contribution ratios
- 🤖 **Multi-tool Support / 多工具支持**: Claude Code, Codex CLI, Cursor, Gemini CLI, Opencode, Trae
- 📈 **Visual Reports / 可视化报告**: Console, JSON, and Markdown output formats
- 📅 **Timeline View / 时间线视图**: Track AI contributions over time (use `-v` or `history` command)
- 📁 **File-level Analysis / 文件级分析**: See which files have the most AI contributions
- 🎯 **Directory Filter / 目录过滤**: Analyze only specific directories like `src` or `lib` (use `-d` flag)
- ✅ **Verification Comparison / 验证对比**: Compare raw AI data vs verified contributions
- 📤 **Session Export / 会话导出**: Export verified AI sessions to Markdown with diffs (`export-sessions` command)
- 🏷️ **Session Type Classification / 会话类型分类**: Classify sessions as code contribution, code review, analysis, or mixed
- 📝 **Contribution Type Tracking / 贡献类型追踪**: Distinguish between AI-created files vs enhanced existing files
- 📋 **Project Changes Analysis / 项目变更分析**: Show file-level git changes with --since flag
- 🗂️ **Log File Generation / 日志文件生成**: Generate detailed log files with --log flag (`logs/ai-contributions-{timestamp}.log`, `logs/original-files-{timestamp}.log`)
- 🔀 **Git Metadata Display / Git 信息显示**: Show current branch, username, and remote repo in reports

## Usage / 使用方法

```bash
# Run via tsx (development mode, no build needed)
# 使用 tsx 直接运行（开发模式，无需构建）
npm run dev -- [path] [options]
npm run dev -- scan --since 2026-01-01

# Run via npx (requires build: npm run build)
npx ai-contribute

# Run built binary (after npm run build)
node dist/cli.js

# Analyze current directory
npx ai-contribute

# Analyze a specific repository / 分析指定仓库
npx ai-contribute /path/to/your/repo

# Show detailed output (files, timeline, distribution)
# 显示详细输出（文件、时间线、分布）
npx ai-contribute -v

# Export as JSON / 导出为 JSON
npx ai-contribute -f json -o report.json

# Export as Markdown / 导出为 Markdown
npx ai-contribute -f markdown -o report.md

# Only analyze specific tools / 只分析特定工具
npx ai-contribute -t claude,codex,trae

# Only analyze a specific directory (useful for Vue/React projects)
# 只分析特定目录（适用于 Vue/React 等前端项目）
npx ai-contribute -d src -v
npx ai-contribute -d src/components -v

# Only analyze backend source directory
# 只分析后端源码目录
npx ai-contribute /path/to/backend -d lib -v

# Analyze contributions since a specific date
# 分析指定日期之后的贡献
npx ai-contribute --since 2026-01-01

# Show detailed analysis with project changes
# 显示详细分析（含项目变更）
npx ai-contribute --since 2026-01-01 -v

# Generate detailed log files of AI contributions
# 生成详细的 AI 贡献日志文件（logs/ai-contributions-{timestamp}.log 和 logs/original-files-{timestamp}.log）
npx ai-contribute --log
npx ai-contribute --since 2026-01-01 --log -v

# Export verified AI sessions to Markdown
# 将验证后的 AI 会话导出为 Markdown 文件
npx ai-contribute export-sessions
npx ai-contribute export-sessions -t claude,codex
npx ai-contribute export-sessions --op edit,write
npx ai-contribute export-sessions --since 2026-01-01 -d src

# View git statistics (requires --since)
# 查看 Git 统计信息（需要 --since 参数）
npx ai-contribute git-stat --since 20260101
npx ai-contribute git-stat /path/to/repo --since 2026-01-01
npx ai-contribute git-stat --since 20260101 -d src

# List detected AI tools
# 列出检测到的 AI 工具
npx ai-contribute list
```

## Commands / 命令

### Scan (Default) / 扫描（默认）

The main command to analyze a repository. If no command is specified, `scan` is implied.

```bash
npx ai-contribute scan [path] [options]
# or simply
npx ai-contribute [path] [options]

# Options / 选项:
#   -f, --format <format>   Output format: console (default), json, markdown / 输出格式
#   -o, --output <file>     Output file path / 输出文件路径
#   -t, --tools <tools>     Comma-separated list of tools (claude,codex,cursor,gemini,opencode,trae,all)
#   --verification <mode>   Verification mode: strict, relaxed (default), historical / 验证模式
#   -d, --directory <dir>   Only analyze files in specific directory (e.g., src, lib) / 只分析指定目录
#   --since <date>          Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD) / 只分析指定日期后的贡献
#   -v, --verbose           Show detailed output (files, timeline, distribution) / 显示详细输出
#   --log                   Generate detailed log files of AI contributions / 生成详细的 AI 贡献日志文件
```

### Export Sessions / 导出会话

Export verified AI session code changes to Markdown files for documentation or review.

```bash
npx ai-contribute export-sessions [path] [options]

# Options / 选项:
#   -t, --tools <tools>     AI tools to scan (claude,codex,... or all) / 要扫描的 AI 工具
#   --verification <mode>   Verification mode (strict / relaxed / historical) / 验证模式
#   -d, --directory <dir>   Only include file changes in this directory (e.g., src) / 仅包含该目录下的文件变更
#   --since <date>          Only export sessions since date (YYYYMMDD or YYYY-MM-DD) / 仅导出该日期及之后的会话
#   --op <ops>              Only export specified operation types (edit / write / edit,write), default: edit,write / 仅导出指定操作类型

# Examples / 示例:
npx ai-contribute export-sessions
npx ai-contribute export-sessions -t claude,codex
npx ai-contribute export-sessions --op edit
npx ai-contribute export-sessions --since 2026-01-01
npx ai-contribute export-sessions -d src --op write
```

Output: Creates `logs/session-md/session-md-{timestamp}/` directory with:

- Individual session Markdown files (e.g., `001-{session-id}.md`)
- An index file `_index.md` listing all sessions
- Each session includes: metadata, verified code diffs, AI raw code, and git baseline comparison

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
  Opencode        ~/.local/share/opencode/          ✓ Available
  Trae            Trae/User/workspaceStorage       ✓ Available
```

### File-level Analysis / 文件级分析

Show detailed contribution statistics for individual files.

```bash
npx ai-contribute files [path] [-n LIMIT] [-d DIR] [--verification MODE] [--since DATE]

# Options:
#   -n, --limit <number>    Number of files to show (default: 20)
#   -d, --directory <dir>   Only analyze files in specific directory
#   --verification <mode>   Verification mode (strict/relaxed/historical)
#   --since <date>          Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD)
```

### Contribution History / 贡献历史

Show a timeline of AI contributions.

```bash
npx ai-contribute history [path] [-n LIMIT] [-d DIR] [--verification MODE] [--since DATE]

# Options:
#   -n, --limit <number>    Number of entries to show (default: 20)
#   -d, --directory <dir>   Only analyze files in specific directory
#   --verification <mode>   Verification mode (strict/relaxed/historical)
#   --since <date>          Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD)
```

### Session List / 会话列表

List verified AI sessions found for the repository.

```bash
npx ai-contribute sessions [path] [-t TOOLS] [-d DIR] [--since DATE]

# Options:
#   -t, --tools <tools>     Filter by specific tools (comma-separated)
#   -d, --directory <dir>   Only analyze files in specific directory
#   --since <date>          Only show sessions since date (YYYYMMDD or YYYY-MM-DD)
```

### Git Statistics / Git 统计

Show Git contribution statistics for the repository (requires `--since` option).

```bash
npx ai-contribute git-stat [path] --since <date> [-d DIR]

# Options:
#   --since <date>          Only analyze contributions since date (YYYYMMDD or YYYY-MM-DD) - Required
#   -d, --directory <dir>   Only analyze files in specific directory

# Examples / 示例:
npx ai-contribute git-stat --since 20260101
npx ai-contribute git-stat --since 2026-01-01
npx ai-contribute git-stat /path/to/repo --since 20260101 -d src
```

## Output Example / 输出示例

```
AI 代码贡献分析
代码库: ai-contribute.git
当前分支: dev-1.3.0
用户名称: Doufu07
扫描时间: 2026/4/17 15:06:04
验证模式: relaxed
文件总数: 23
代码总行数: 8009

📊 AI 贡献统计
┌──────────┬──────────┬──────────┬────────┬────────┬────────────┐
│ 指标     │ 原始数据 │ 新增代码 │ AI生成 │ AI贡献 │ AI生成占比 │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 会话数   │ 85       │ -        │ 85     │ 27     │ -          │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 文件数   │ 18       │ -        │ 34     │ 15     │ 83.3%      │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 代码行数 │ 7499     │ +1629    │ 5659   │ 803    │ 49.3%      │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 删除行   │ 279      │ -        │ 1451   │ 876    │ -          │
└──────────┴──────────┴──────────┴────────┴────────┴────────────┘

📊 会话类型统计
┌──────────┬────────┬────────────────────────┐
│ 类型     │ 会话数 │ 说明                   │
├──────────┼────────┼────────────────────────┤
│ 代码贡献 │ 43     │ 修改或创建了项目代码   │
├──────────┼────────┼────────────────────────┤
│ 代码审查 │ 9      │ 只读取文件，未做修改   │
├──────────┼────────┼────────────────────────┤
│ 问题分析 │ 3      │ 调试、搜索、运行命令等 │
├──────────┼────────┼────────────────────────┤
│ 混合操作 │ 30     │ 多种操作但无代码变更   │
└──────────┴────────┴────────────────────────┘

🤖 各 AI 工具贡献明细
┌────────────────────┬────────┬────────┬──────────┬──────────┬─────────────────┐
│ 工具/模型          │ 会话数 │ 文件数 │ 新增行数 │ 删除行数 │ 占比            │
├────────────────────┼────────┼────────┼──────────┼──────────┼─────────────────┤
│ Claude Code        │ 27     │ 15     │ +803     │ -876     │ 49.3%           │
├────────────────────┼────────┼────────┼──────────┼──────────┼─────────────────┤
│   └─ kimi-for-coding│ 17     │ 15     │ +325     │ -345     │ 40.5% (工具内)  │
├────────────────────┼────────┼────────┼──────────┼──────────┼─────────────────┤
│   └─ claude-opus-4-7│ 5      │ 3      │ +286     │ -386     │ 35.6% (工具内)  │
└────────────────────┴────────┴────────┴──────────┴──────────┴─────────────────┘

📈 贡献分布

  ████████████████████████████████████████████████████████████

  ● Claude Code     49.3%  (803 行)
  ● 未知/人工           50.7%  (826 行)

📁 AI 贡献最多的文件
┌──────────────────────────────┬──────────┬──────────┬───────────────┬────────┬────────┬──────────────────────────────┐
│ 文件                         │ 原始数据 │ 新增代码 │ AI 贡献       │ 会话数 │ 类型   │ 贡献者详情                   │
├──────────────────────────────┼──────────┼──────────┼───────────────┼────────┼────────┼──────────────────────────────┤
│ src/analyzer.ts              │ 841      │ +291     │ 291 (100.0%)  │ 6      │ 优化   │ Claude Code                  │
├──────────────────────────────┼──────────┼──────────┼───────────────┼────────┼────────┼──────────────────────────────┤
│ src/reporter.ts              │ 719      │ +47      │ 37 (78.7%)    │ 7      │ 优化   │ Claude Code                  │
├──────────────────────────────┼──────────┼──────────┼───────────────┼────────┼────────┼──────────────────────────────┤
│ src/core/git.ts              │ 1359     │ +748     │ 418 (55.9%)   │ 9      │ 优化   │ Claude Code                  │
└──────────────────────────────┴──────────┴──────────┴───────────────┴────────┴────────┴──────────────────────────────┘

📅 近期 AI 活动
┌──────────────────┬─────────────────────────────┬────────┬───────────┐
│ 时间             │ 工具/模型                   │ 文件数 │ 变更      │
├──────────────────┼─────────────────────────────┼────────┼───────────┤
│ 2026/04/17 14:57 │ Claude Code Kimi-for-coding │ 3      │ +25 -0    │
├──────────────────┼─────────────────────────────┼────────┼───────────┤
│ 2026/04/17 14:55 │ Claude Code Kimi-for-coding │ 1      │ +2 -2     │
└──────────────────┴─────────────────────────────┴────────┴───────────┘
```

## Supported AI Tools / 支持的 AI 工具


| Tool        | Storage Location                        | Format                 |
| ----------- | --------------------------------------- | ---------------------- |
| Claude Code | `~/.claude/projects/<path>/`            | JSONL                  |
| Codex CLI   | `~/.codex/sessions/YYYY/MM/DD/`         | JSONL                  |
| Cursor      | `Cursor/User/workspaceStorage`          | SQLite (`state.vscdb`) |
| Gemini CLI  | `~/.gemini/tmp/<hash>/chats/`           | JSON                   |
| Opencode    | `~/.local/share/opencode/`              | JSON                   |
| Trae        | `Trae/User/workspaceStorage`            | SQLite (`state.vscdb`) |


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
  - Operation type (`edit` = partial edit, `write` = full file write)
4. **Verify Against Current Codebase**: Before counting any line as an AI contribution, the tool:
  - Reads the current content of the target file from the repository
  - For each line that AI claims to have added, checks if a matching line exists in the current file
  - In **relaxed** mode, matching ignores whitespace-only differences (trim + collapse spaces)
  - In **strict** mode, matching is character-for-character
5. **Calculate Statistics**: The verified lines are then aggregated into:
  - Per-file contribution counts
  - Per-directory contribution statistics
  - Per-tool contribution totals
  - **Sessions, files, and models are counted only when at least one verified line exists**

### Verification Modes

You can switch modes with `--verification`.

- `relaxed` (default): Match lines after normalizing whitespace.
- `strict`: Match lines exactly (character-for-character).
- `historical`: Count tool-reported added lines for files that still exist, capped by the current file's non-empty line count.

### Session Type Classification / 会话类型分类

Each AI session is classified into one of four types based on its operations:


| Type                | Chinese | Description                             |
| ------------------- | ------- | --------------------------------------- |
| `code_contribution` | 代码贡献    | Modified or created project code files  |
| `code_review`       | 代码审查    | Only read files, no modifications       |
| `analysis`          | 问题分析    | Debugging, searching, running commands  |
| `mixed`             | 混合操作    | Multiple operations but no code changes |


### Contribution Type Tracking / 贡献类型追踪

Each file is classified based on how AI contributed to it:


| Type      | Chinese | Description                                                      |
| --------- | ------- | ---------------------------------------------------------------- |
| `create`  | 新增      | AI created this file (session timestamp near file creation time) |
| `enhance` | 优化      | AI modified/enhanced an existing file                            |
| `unknown` | 未知      | Unable to determine (no git history)                             |


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
📊 AI 贡献统计
┌──────────┬──────────┬──────────┬────────┬────────┬────────────┐
│ 指标     │ 原始数据 │ 新增代码 │ AI生成 │ AI贡献 │ AI生成占比 │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 会话数   │ 5        │ -        │ 5      │ 5      │ -          │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 文件数   │ 13       │ -        │ 13     │ 10     │ 76.9%      │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 代码行数 │ 1145     │ +1145    │ 1145   │ 727    │ 63.5%      │
├──────────┼──────────┼──────────┼────────┼────────┼────────────┤
│ 删除行   │ 710      │ -        │ 710    │ 448    │ -          │
└──────────┴──────────┴──────────┴────────┴────────┴────────────┘
```

**What causes the difference? / 差异原因:**


| Cause              | Description                                      |
| ------------------ | ------------------------------------------------ |
| Code modified      | Lines changed by humans or other AI tools        |
| Code deleted       | Files or lines removed from codebase             |
| Duplicate edits    | Same line modified multiple times (counted once) |
| File renamed/moved | Cannot verify contributions to moved files       |


**AI generation share interpretation / AI 生成占比解读:**

- **100%**: All code in the analyzed scope was generated by AI
- **< 100%**: A portion of the code was written by humans or other sources
- **Low share**: AI played a smaller role in the codebase changes

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
4. Add the tool to the `AITool` enum in `src/types.ts`
5. Register the scanner in `src/core/scanners.ts` (`ScannerManager` constructor)
6. Add tool display name, color, and storage path in `src/cli.ts` and `src/reporter.ts`

## License

MIT