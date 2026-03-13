# Architecture Overview

AI Contribution Tracker follows a clean architecture pattern with three main components: **Scanners**, **Analyzer**, and **Reporters**.

## System Architecture

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Scanners   │───▶│  Analyzer   │───▶│  Reporters  │
│ (Data Source)│    │(Business   │    │ (Output     │
│             │    │  Logic)     │    │  Formatting)│
└─────────────┘    └─────────────┘    └─────────────┘
```

## Core Components

### 1. Scanners (`src/scanners/`)

Scanners are responsible for parsing AI tool session files and extracting file change events.

**Base Scanner (`base.ts`)**
- Abstract class that all scanners extend
- Defines common interface: `tool`, `storagePath`, `scan()`, `parseSessionFile()`
- Handles file system operations and error handling

**Tool-Specific Scanners**
- `claude.ts`: Parses Claude Code JSONL files
- `codex.ts`: Handles Codex CLI session files
- `cursor.ts`: Reads Cursor SQLite database
- `gemini.ts`: Processes Gemini CLI JSON files
- `opencode.ts`: Handles Opencode sessions
- `trae.ts`: Reads Trae SQLite database

### 2. Analyzer (`src/analyzer.ts`)

The analyzer orchestrates the scanning process and aggregates results.

**Key Responsibilities:**
- Coordinates multiple scanners
- Applies verification logic to filter contributions
- Aggregates statistics across tools and files
- Handles deduplication of overlapping contributions

**Verification Process:**
1. Parse AI session files using appropriate scanners
2. Extract file change events (additions, modifications, deletions)
3. Verify changes against current codebase state
4. Apply verification mode (strict/relaxed/historical)
5. Aggregate statistics by tool, file, and time period

### 3. Reporters (`src/reporter.ts`)

Reporters format and output analysis results in different formats.

**Output Formats:**
- **Console**: Human-readable tables with visual indicators
- **JSON**: Machine-readable structured data
- **Markdown**: Documentation-friendly format

### 4. CLI (`src/cli.ts`)

The CLI provides the user interface and command handling.

**Features:**
- Worker thread support for non-blocking analysis
- Multiple output formats
- Filtering options (tools, directories, time ranges)
- Progress indicators and error handling

## Data Flow

```
1. User runs CLI command
2. CLI creates worker thread for analysis
3. Analyzer initializes scanners for detected tools
4. Each scanner parses its tool's session files
5. Analyzer verifies contributions against current codebase
6. Reporter formats results based on user preference
7. CLI displays results to user
```

## Key Design Patterns

### Strategy Pattern
Different scanners implement the same interface, allowing easy addition of new AI tools.

### Factory Pattern
Scanner creation is centralized in the analyzer based on tool detection.

### Template Method Pattern
Base scanner defines the scanning workflow, with tool-specific implementations.

### Observer Pattern
Worker thread communicates progress and results back to main thread.

## Type System

The project uses TypeScript with strict typing for all major components:

```typescript
// Core types defined in src/types.ts
interface FileChange {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  changeType: 'create' | 'modify' | 'delete';
  timestamp: Date;
  tool: AITool;
}

interface AISession {
  id: string;
  tool: AITool;
  timestamp: Date;
  projectPath: string;
  changes: FileChange[];
}

interface ContributionStats {
  repoPath: string;
  totalFiles: number;
  totalLines: number;
  aiTouchedFiles: number;
  aiContributedLines: number;
  sessions: AISession[];
  byTool: Map<AITool, ToolStats>;
  byFile: Map<string, FileStats>;
}
```

## Performance Considerations

- **Worker Threads**: Analysis runs in separate thread to avoid blocking UI
- **Streaming Parsing**: Large session files are parsed incrementally
- **Memory Management**: Results are streamed back to main thread
- **Caching**: File system operations are minimized through smart caching

## Extension Points

### Adding New AI Tools
1. Create scanner in `src/scanners/<tool>.ts`
2. Extend `BaseScanner` class
3. Implement required methods
4. Register in analyzer constructor
5. Add to type definitions

### Adding New Output Formats
1. Extend reporter with new format method
2. Add format option to CLI
3. Update type definitions

### Adding New Verification Modes
1. Implement verification logic in analyzer
2. Add mode to type definitions
3. Update CLI options