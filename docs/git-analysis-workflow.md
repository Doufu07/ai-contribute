# Git Analyzer Core Module

本文档描述了 `src/core/git.ts` 模块的工作流程，该模块负责通过 Git 历史和文件系统状态来分析项目的代码变更量。

## 核心职责

`GitAnalyzer` 类的主要职责是：
1.  **项目变更分析 (`getProjectChanges`)**：计算自指定时间点 (`since`) 以来项目的代码变更量（新增行、删除行、净增量）。
2.  **文件列表获取 (`getRepoFiles`)**：获取当前项目中的所有有效源代码文件列表（遵循 `.gitignore` 规则）。
3.  **元数据获取**：如 Git 远程仓库地址 (`getRepoUrl`)。

## 变更分析流程 (`getProjectChanges`)

该方法采用了 **"Git-First Strategy" (Git 优先策略)**，在 Git 环境可用时优先使用 Git 命令获取精确的差异数据，仅在必要时回退到基于文件修改时间 (`mtime`) 的估算策略。

### 流程图

```mermaid
graph TD
    A[开始: getProjectChanges(since)] --> B{检查 Git 可靠性?}
    B -- 否 --> C[Fallback 策略]
    B -- 是 --> D{查找 Base Commit}
    D -- 无 (新仓库/无历史) --> C
    D -- 有 (找到 SHA) --> E[Git-First 策略]
    
    subgraph "Git-First 策略 (精确)"
    E --> F[获取 Base Commit 到当前工作区的 Diff]
    F --> G[解析 git diff --numstat]
    G --> H[获取 Untracked Files]
    H --> I[获取详细 Diff 内容 (unified=0)]
    I --> J[汇总统计数据]
    end
    
    subgraph "Fallback 策略 (估算)"
    C --> K[Glob 扫描所有文件]
    K --> L[过滤 mtime >= since 的文件]
    L --> M{尝试获取 Git 变更?}
    M -- Git 可用 --> N[git log + git diff 组合]
    M -- Git 不可用 --> O[保守模式: 视为全部新增]
    N --> P[汇总统计数据]
    O --> P
    end
    
    J --> Q[返回结果]
    P --> Q
```

## 详细策略说明

### 1. Git-First Strategy (推荐)

这是最准确的统计方式，它通过比较历史提交和当前工作区来计算真实的"净增量"。

1.  **定位基准点 (Base Commit)**:
    *   使用 `git rev-list -1 --before=SINCE HEAD` 找到 `since` 时间点之前的最后一个提交。
2.  **计算净增量 (Net Increment)**:
    *   直接运行 `git diff BASE_COMMIT --numstat`。
    *   **优势**：这会一次性比较 `Base Commit` 与 `Current Working Tree` (包含已提交、已暂存、未暂存的所有变更)。它能自动抵消中间过程的反复修改（例如：增加一行又删除一行，净增量为 0），从而提供真实的贡献量。
3.  **处理未跟踪文件 (Untracked)**:
    *   使用 `git ls-files --others --exclude-standard` 找出未纳入版本控制的新文件。
    *   这些文件的全部内容都被视为"新增"。

### 2. Fallback Strategy (回退机制)

当 Git 环境不可用（如未安装 Git、非 Git 目录）或找不到基准提交（如浅克隆、新仓库）时使用。

1.  **文件扫描**:
    *   使用 `glob` 扫描项目目录下的所有文件。
2.  **时间过滤**:
    *   检查文件的 `mtime` (修改时间)，只保留在 `since` 之后有过修改的文件。
3.  **变更计算**:
    *   **尝试 Git**: 如果 Git 仍然部分可用，尝试组合 `git log` (已提交) + `git diff` (未提交) 来获取变更行数。
    *   **保守模式**: 如果 Git 完全不可用，为了不漏记贡献，会将所有被修改文件的当前行数全部视为"新增"。这可能会导致统计数据虚高，但保证了"宁可多记，不可漏记"的原则。

## 关键 API

### `getProjectChanges(since: Date, targetDirectory?: string)`

*   **输入**:
    *   `since`: 统计的起始时间。
    *   `targetDirectory`: (可选) 限制统计的子目录。
*   **输出**:
    *   `totalFiles`: 发生变更的文件数量。
    *   `linesAdded`: 新增行数。
    *   `linesRemoved`: 删除行数。
    *   `netLinesAdded`: 净增行数 (`Added - Removed`)。
    *   `fileStats`: 每个文件的具体变更统计 `Map<filepath, {added, removed}>`。
    *   `fileDiffs`: 每个文件的差异内容快照（用于后续的 AI 代码归因验证）。

### `getRepoFiles(targetDirectory?: string)`

获取项目中的所有源文件列表。

1.  优先尝试 `git ls-files` (Tracked + Untracked - Ignored)。
2.  失败则回退到 `glob` 扫描，并手动应用 `.gitignore` 规则。
3.  自动过滤非文本文件（如图片、二进制文件）和常见的构建产物目录（`node_modules`, `dist` 等）。
