# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build          # Bundle with esbuild (outputs single dist/cli.js)
npm run dev            # Run directly via tsx without building
node dist/cli.js       # Run compiled CLI (build first)
node dist/cli.js .     # Analyze current directory
node dist/cli.js <path> -v   # Verbose output with file details and timeline
```

No test framework is configured.

## Architecture

Pipeline: **Scanners → Analyzer → Reporters**

1. **Scanners** (`src/scanners/`) parse AI tool session files from each tool's local storage
2. **Analyzer** (`src/analyzer.ts`) orchestrates scanners and aggregates `FileChange` events into `ContributionStats`
3. **Reporters** (`src/reporter.ts`) format stats for output (Console, JSON, Markdown)

### Scanner system

All scanners extend `BaseScanner` (`src/scanners/base.ts`) and implement:
- `tool` / `storagePath` — identity and where to find session data
- `scan(projectPath)` — find and parse sessions matching a project
- `parseSessionFile(filePath, projectPath)` — extract `FileChange[]` from one session file

Each tool has a different storage format:

| Tool | Storage | Format | Key detail |
|------|---------|--------|------------|
| Claude Code | `~/.claude/projects/<encoded-path>/*.jsonl` | JSONL with `tool_use` blocks | Path encoding: `/` → `-` |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | JSONL with `custom_tool_call` (`apply_patch`) and `function_call` entries nested under `payload` | `cwd` in `turn_context` entries |
| Gemini CLI | `~/.gemini/tmp/<md5-hash>/chats/*.json` | JSON with `functionCall` in message parts | Project matched by MD5 hash |
| Aider | `.aider.chat.history.md` (project-local) | Markdown with code blocks and SEARCH/REPLACE patterns | Only scanner not reading from `~/` |

### CLI (`src/cli.ts`)

- Analysis runs in a **worker thread** so the main thread stays free for the rainbow loading animation
- Worker serializes `ContributionStats` (which contains `Map` objects) to JSON and back
- Commands: `scan` (default), `list`, `files`, `history`, `sessions`

### Adding a new AI tool

1. Create `src/scanners/<tool>.ts` extending `BaseScanner`
2. Add the tool to `AITool` enum in `src/types.ts`
3. Register the scanner in `ContributionAnalyzer` constructor (`src/analyzer.ts`)
4. Add display name/color/path in `src/cli.ts` (`TOOL_MAP`, `TOOL_INFO`) and `src/reporter.ts` (`TOOL_NAMES`, `TOOL_COLORS`)

## Key types (`src/types.ts`)

- `FileChange` — single file operation (path, lines added/removed, tool, timestamp)
- `AISession` — group of FileChanges from one session
- `ContributionStats` — full analysis result with `byTool: Map<AITool, ToolStats>` and `byFile: Map<string, FileStats>`

## Project matching

Codex scanner's `pathsMatch` is strict: session `cwd` must equal or be a subdirectory of the project path. Parent directory sessions do not match child projects.

Claude scanner matches by encoded path or basename against `~/.claude/projects/` directory names.
