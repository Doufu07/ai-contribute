# AGENTS.md

This file provides guidance to agentic coding agents (Claude Code, Codex, etc.) working with this repository.

## Build & Run Commands

```bash
# Build TypeScript to dist/
npm run build              # tsc

# Run directly without building (development)
npm run dev                # tsx src/cli.ts

# Run compiled CLI
npm start                  # node dist/cli.js
node dist/cli.js .         # Analyze current directory
node dist/cli.js <path> -v # Verbose output
```

**No test framework is configured.** Tests are currently not available for this project.

## Architecture

**Pipeline: Scanners → Analyzer → Reporters**

- `src/scanners/` - Parse AI tool session files from each tool's local storage
- `src/analyzer.ts` - Orchestrates scanners and aggregates `FileChange` events
- `src/reporter.ts` - Formats stats for output (Console, JSON, Markdown)
- `src/cli.ts` - Main CLI entry point with worker thread for analysis
- `src/types.ts` - Type definitions (FileChange, AISession, ContributionStats)

**Adding a new AI tool scanner:**
1. Create `src/scanners/<tool>.ts` extending `BaseScanner`
2. Add tool to `AITool` enum in `src/types.ts`
3. Register scanner in `ContributionAnalyzer` constructor
4. Add display name/color/path in `src/cli.ts` and `src/reporter.ts`

## Code Style Guidelines

### TypeScript Configuration
- Target: ES2022, Module: NodeNext (strict mode enabled)
- Output: `dist/`, Source: `src/`
- Always use `.js` extension in local imports (required by NodeNext)

### Imports
```typescript
// Node.js built-ins - use namespace import
import * as fs from 'fs';
import * as path from 'path';

// npm packages - direct import
import { Command } from 'commander';
import chalk from 'chalk';

// Local files - MUST include .js extension
import { BaseScanner } from './base.js';
import { AISession } from '../types.js';
```

### Naming Conventions
- **Classes/Interfaces/Enums**: PascalCase (e.g., `BaseScanner`, `FileChange`, `AITool`)
- **Methods/Variables**: camelCase (e.g., `parseSessionFile`, `storagePath`)
- **Enum members**: PascalCase keys with lowercase string values
- **Private methods**: Use `private` keyword prefix

### Type Annotations
- Always specify return types on public methods
- Use explicit parameter types
- Prefer interfaces for object shapes
- Use `Map<K, V>` for key-value collections

### Comments
- Use JSDoc style for classes and public methods
- Document complex logic with inline comments

### Error Handling
- Use try-catch blocks, empty catch acceptable for graceful degradation
- Return null/empty array rather than throwing when possible
- Example: `catch { return []; }`

### Code Organization
- Abstract base classes in `base.ts`
- One scanner per AI tool in `src/scanners/`
- Re-export all scanners from `src/scanners/index.ts`
- Keep classes focused on single responsibility

## Agent Run Log

- 2026-02-03 16:59:44 local: ran `pnpm dev` (tsc + `node dist/cli.js`) successfully. Cursor detected with 2 sessions; overall summary showed 19 files, 4501 lines, 14 AI sessions.
