/**
 * Supported AI coding tools
 */
export enum AITool {
  CLAUDE_CODE = 'claude',
  CODEX = 'codex',
  CURSOR = 'cursor',
  GEMINI = 'gemini',
  OPENCODE = 'opencode',
  TRAE = 'trae',
}

/**
 * Session type classification based on operations performed
 */
export type SessionType = 'code_contribution' | 'code_review' | 'analysis' | 'mixed';

/**
 * Operation counts for a session
 */
export interface SessionOperations {
  readCount: number;        // Number of Read operations
  editCount: number;        // Number of Edit operations
  writeCount: number;       // Number of Write operations
  bashCount: number;        // Number of Bash operations
  grepCount: number;        // Number of Grep operations
  globCount: number;        // Number of Glob operations
  taskCount: number;        // Number of Task operations
  otherCount: number;       // Other tool operations
}

/**
 * Verification mode for counting AI contributions
 */
export type VerificationMode = 'strict' | 'relaxed' | 'historical';

/**
 * Represents a single file change made by an AI tool
 */
export interface FileChange {
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  changeType: 'create' | 'modify' | 'delete';
  timestamp: Date;
  tool: AITool;
  content?: string;
  addedLines?: string[];
  removedLinesContent?: string[];
  model?: string;
  /** 操作类型：'write' = 新建/覆盖文件，'edit' = 局部编辑 */
  operation?: 'write' | 'edit';
}

/**
 * Represents an AI session containing multiple file changes
 */
export interface AISession {
  id: string;
  tool: AITool;
  timestamp: Date;
  projectPath: string;
  changes: FileChange[];
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  model?: string;
  /** Session type classification based on operations */
  sessionType?: SessionType;
  /** Detailed operation counts */
  operations?: SessionOperations;
}

/**
 * Statistics for a single AI model
 */
export interface ModelStats {
  model: string;
  sessionsCount: number;
  filesCreated: number;
  filesModified: number;
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
  netLines: number;
}

/**
 * Statistics for a single AI tool
 */
export interface ToolStats {
  tool: AITool;
  sessionsCount: number;
  filesCreated: number;
  filesModified: number;
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
  netLines: number;
  byModel: Map<string, ModelStats>;
}

/**
 * Contribution type for a file
 */
export type ContributionType = 'create' | 'enhance' | 'unknown';

/**
 * Statistics for a single file
 */
export interface FileStats {
  filePath: string;
  totalLines: number;
  aiContributedLines: number;
  aiContributionRatio: number;
  contributions: Map<AITool, number>;
  /** Number of AI sessions that contributed to this file */
  sessionCount: number;
  /** File creation time in git history (null if not tracked or error) */
  fileCreateTime?: Date | null;
  /** Type of AI contribution: create (AI created), enhance (AI optimized existing), unknown */
  contributionType?: ContributionType;
}

/**
 * Raw statistics before verification (for comparison)
 */
export interface RawStats {
  sessionsCount: number;
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Statistics for a session type
 */
export interface SessionTypeStats {
  type: SessionType;
  count: number;
  sessions: AISession[];
  byTool: Map<AITool, number>;
}

/**
 * Overall contribution statistics
 */
export interface ContributionStats {
  repoPath: string;
  repoUrl?: string; // Git remote URL if available
  scanTime: Date;
  verificationMode: VerificationMode;
  targetDirectory?: string;
  totalFiles: number;
  totalLines: number;
  projectTotalFiles?: number;
  projectTotalLines?: number;
  aiTouchedFiles: number;
  aiContributedLines: number;
  sessions: AISession[];
  byTool: Map<AITool, ToolStats>;
  byFile: Map<string, FileStats>;
  /** Raw statistics before verification for comparison */
  rawStats?: RawStats;
  /** Session type statistics (classification of all sessions) */
  sessionTypeStats?: Map<SessionType, SessionTypeStats>;
  // Project-wide changes if time filter is applied
  projectChanges?: {
    totalFiles: number;
    linesAdded: number;
    linesRemoved: number;
    netLinesAdded: number;
    totalLinesOfChangedFiles: number; // Total current lines of files changed in this period
    files: string[]; // List of changed files
    fileStats: Map<string, { added: number, removed: number }>; // Detailed stats per file
    fileDiffs?: Map<string, string>; // Actual diff content per file
    gitStatusWarning?: string; // Warning message if git was unreliable or conservative mode used
  };
  /**
   * Detailed content of AI contributions (only populated if requested)
   * Key: filePath, Value: Array of contributed lines
   */
  aiContributedContent?: Map<string, string[]>;
}

/**
 * Output format options
 */
export type OutputFormat = 'console' | 'json' | 'markdown';

/**
 * CLI options
 */
export interface CLIOptions {
  format: OutputFormat;
  output?: string;
  tools?: AITool[];
  verbose: boolean;
  verificationMode?: VerificationMode;
  directory?: string;
}
