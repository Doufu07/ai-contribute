# ai-contribute Project Context

## Project Overview

`ai-contribute` is a command-line interface (CLI) tool designed to track, analyze, and report on contributions made by various AI coding assistants within a software project. It scans specific log directories or files associated with tools like Claude Code, Codex CLI, Gemini CLI, and Aider to quantify their impact.

**Key Features:**
*   **Multi-Tool Support:** Detailed scanners for Claude Code, Codex CLI, Gemini CLI, and Aider.
*   **Metrics:** Calculates lines of code added/removed, files touched, and contribution ratios.
*   **Reporting:** Outputs analysis in Console (with visual charts), JSON, or Markdown formats.
*   **Architecture:** Built with TypeScript, utilizing `worker_threads` for non-blocking analysis and `commander` for CLI interactions.

## Building and Running

This project is a Node.js application using TypeScript.

**Prerequisites:**
*   Node.js (>=18.0.0)
*   npm

**Key Commands:**

*   **Install Dependencies:**
    ```bash
    npm install
    ```

*   **Development Run:**
    Runs the CLI directly from source using `tsx`.
    ```bash
    npm run dev -- [args]
    # Example: npm run dev -- scan . -v
    ```

*   **Build:**
    Compiles TypeScript to JavaScript in the `dist/` directory.
    ```bash
    npm run build
    ```

*   **Run Built Code:**
    ```bash
    npm start -- [args]
    ```

## Development Conventions

**Code Structure:**
*   `src/cli.ts`: Main entry point. Handles argument parsing, worker thread creation, and UI rendering (spinners, color output).
*   `src/analyzer.ts`: Core logic class `ContributionAnalyzer` that coordinates the scanning process.
*   `src/scanners/`: Directory containing scanner implementations.
    *   `base.ts`: Defines the `BaseScanner` abstract class.
    *   Specific tool scanners (e.g., `claude.ts`, `gemini.ts`) extend `BaseScanner` to implement tool-specific parsing logic (JSON/JSONL/Markdown).
*   `src/types.ts`: TypeScript definitions for `AISession`, `FileChange`, `ContributionStats`, etc.

**Adding a New AI Tool:**
1.  Create a new scanner file in `src/scanners/`.
2.  Extend `BaseScanner` and implement `scan()` and `parseSessionFile()` methods.
3.  Register the new scanner in `src/analyzer.ts` inside the `ContributionAnalyzer` constructor.
4.  Add the tool to the `AITool` enum and `TOOL_MAP` in `src/types.ts` and `src/cli.ts`.

**Tech Stack:**
*   **Language:** TypeScript (ES Modules)
*   **CLI Framework:** `commander`
*   **Utilities:** `chalk` (styling), `glob` (file searching), `tsx` (execution).
