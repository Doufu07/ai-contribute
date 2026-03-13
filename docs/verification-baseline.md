# AI 贡献验证逻辑深度解析：文件来源与基准

本文档深入解析 `ai-contribute` 工具在验证 AI 代码贡献时，关于“文件来源”和“基准判定”的核心逻辑。

## 核心结论

**验证系统的基准是：本地磁盘文件 (Local Disk) + Git 辅助增强 (Git-Assisted)。**

系统通过读取项目当前时刻在磁盘上的实际文件内容作为“真实库存”，并利用 Git 仓库的历史信息来圈定文件范围和修正部分 AI 工具（如 Trae）的增量误报。

## 逻辑架构图

```mermaid
graph TD
    %% 输入源
    InputLogs[AI Session Logs] -->|Claim: 我写了这些代码| PendingCode(待验证代码片段)
    
    subgraph TruthSource [真值来源 (Source of Truth)]
        LocalDisk[本地磁盘文件 (Local Disk)]
        GitRepo[Git 仓库 (Git Repo)]
    end
    
    %% 作用路径
    GitRepo -->|git ls-files| Scope[1. 圈定文件范围]
    LocalDisk -->|fs.readFileSync| Content[2. 读取当前内容]
    GitRepo -->|git show| History[3. 获取历史快照]
    
    %% 验证过程
    Scope --> Content
    Content -->|建立索引| Inventory[当前代码库存索引]
    
    PendingCode --> VerifyProcess{验证过程}
    Inventory -->|主验证依据| VerifyProcess
    History -->|辅助修正 (Trae)| VerifyProcess
    
    %% 结果
    VerifyProcess -->|Match| Valid[有效贡献 (Verified)]
    VerifyProcess -->|No Match| Invalid[无效贡献 (Discarded)]
    
    style TruthSource fill:#e3f2fd,stroke:#1565c0
    style LocalDisk fill:#fff,stroke:#333
    style GitRepo fill:#fff,stroke:#333
    style Valid fill:#e8f5e9,stroke:#2e7d32
    style Invalid fill:#ffebee,stroke:#c62828
```

## 详细机制解析

### 1. 文件范围圈定 (Scope Definition)
系统首先需要知道“哪些文件属于项目”。
- **首选策略**: `git ls-files`
    - 系统优先调用 Git 命令获取受版本控制的文件列表。
    - 优势：自动排除 `node_modules`、构建产物等被 `.gitignore` 忽略的文件。
- **兜底策略**: `Glob Scan`
    - 如果项目没有初始化 Git，则回退到文件系统遍历（Glob），配合内置的忽略规则。

### 2. 内容基准获取 (Content Baseline)
验证的核心在于比对 AI 生成的代码是否 **当前依然存在**。
- **操作**: `fs.readFileSync`
- **逻辑**: 系统遍历圈定后的文件列表，读取 **磁盘上的物理文件**。
- **意义**: 
    - 无论代码是否已 commit，只要在工作区（Working Tree）里，就算存在。
    - 如果代码被 AI 生成后又被用户删除了，磁盘上不存在，则验证失败（不计入贡献）。

### 3. 历史辅助修正 (Historical Correction)
针对 Trae 等工具可能存在的“全量覆盖”记录问题，系统引入 Git 历史作为辅助裁判。
- **场景**: Trae 记录显示“创建”了一个文件，但实际上该文件在 Git 历史中早已存在。
- **操作**: `git show <commit>:<path>`
- **逻辑**: 
    1. 检查文件的 Git 创建时间。
    2. 如果 `Session Time > Git Create Time`，说明是修改而非新建。
    3. 获取 Session 发生前的文件快照，从 AI 贡献中剔除这些旧代码。
- **意义**: 防止将原有代码误算为 AI 贡献，确保“增量”计算的准确性。

## 代码证据链

| 逻辑环节 | 代码位置 | 关键实现 |
| :--- | :--- | :--- |
| **读取本地文件** | [analyzer.ts](src/analyzer.ts) | `fs.readFileSync(path.join(this.projectPath, file))` |
| **Git 圈定范围** | [analyzer.ts](src/analyzer.ts) | `this.runGitLsFiles(['ls-files', ...])` |
| **Trae 修正** | [analyzer.ts](src/analyzer.ts) | `this.getFileLinesSetBeforeTimestamp(...)` |

## 总结

- **验证对象**: 本地磁盘上的当前文件。
- **Git 角色**: 
    1. **过滤器**: 告诉分析器该看哪些文件。
    2. **裁判员**: 在 AI 工具声称“这是新文件”时，通过历史记录进行查证。
