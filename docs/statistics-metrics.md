# 统计指标与逻辑说明 (Statistics Metrics & Logic)

本文档详细说明了 AI 贡献分析工具中各项核心指标的定义与统计逻辑，特别是"原始数据（Original Data）"、"新增代码"以及贡献占比的计算规则。

## 核心策略

工具采用 **Git 优先 (Git-First) + 降级策略 (Fallback)** 的混合机制，以确保在各种环境下（Git 仓库、浅克隆、非 Git 目录）都能获得最准确的统计结果。

> **技术实现细节**：
> 1. **Git 优先策略 (Git-First)**：
>    - 优先尝试查找指定时间（`--since`）之前的最近一次提交作为基准（Base Commit）。
>    - 通过 `git diff` 对比基准提交与当前状态（HEAD + Staged + Unstaged）的差异。
>    - 结合 `git ls-files --others` 获取未追踪（Untracked）的新文件。
>    - 此策略能最精准地反映代码变更量，不受文件修改时间（mtime）可能不准确的影响。
>
> 2. **降级策略 (Fallback)**：
>    - 当 Git 不可用、不可靠或找不到基准提交（如新仓库、浅克隆）时，自动降级到"mtime + glob"策略。
>    - 使用文件系统 glob 扫描获取文件列表，通过文件修改时间（mtime）筛选活跃文件。
>    - 再尝试使用 Git 获取增量信息，若 Git 完全不可用则采用保守策略（假设文件已追踪）以避免虚高。

## 逻辑流程图

```mermaid
graph TD
    A[开始分析] --> B{Git 可用且可靠?}
    B -- 否 --> C[进入降级策略 (Fallback)]
    B -- 是 --> D{存在基准提交 (Base Commit)?}
    D -- 否 --> C
    D -- 是 --> E[Git 优先策略 (Git-First)]
    
    subgraph GitFirst [Git 优先策略]
        E --> F[Diff Base..HEAD]
        E --> G[Diff Staged/Unstaged]
        E --> H[List Untracked Files]
        F & G --> I[汇总变更行数 (Added/Removed)]
        H --> J[统计全量 (新文件总行数)]
        I & J --> K[输出统计结果]
    end

    subgraph Fallback [降级策略]
        C --> L[文件系统 glob 扫描]
        L --> M{mtime >= since?}
        M -- 否 --> N[忽略]
        M -- 是 --> O{Git 可用?}
        O -- 否 --> P[保守策略: 假设已追踪]
        O -- 是 --> Q[获取 Git 变更 & 状态]
        Q --> R{有变更记录?}
        R -- 是 --> S[统计 Git 增量]
        R -- 否 --> T{Untracked?}
        T -- 是 --> U[统计全量]
        T -- 否 --> V[忽略 (内容未变)]
    end
```

## 详细规则说明

### 1. Git 优先策略 (Primary Strategy)
这是工具的首选策略，适用于标准的 Git 开发环境。
- **基准定位**：使用 `git rev-list -1 --before=...` 找到统计起始时间前的最后一个 commit。
- **全量差异**：
  - **Tracked Changes**: `git diff base --numstat` (直接比较基准提交与当前工作区的差异，包含 Committed, Staged 和 Unstaged)。
  - **Untracked Changes**: `git ls-files --others` (获取未追踪的新文件)。
- **统计方式**：
  - 对于追踪文件：直接统计 diff 中的 added/removed 行数。此方式能自动去重，避免因中间状态（如 Staged 和 Unstaged 同时修改同一行）导致的重复统计。
  - 对于未追踪文件（Untracked）：统计文件当前的全部行数。

### 2. 降级策略 (Fallback Strategy)
当无法使用 Git 优先策略时（例如没有 Git 历史、Git 命令报错），回退到基于文件修改时间的策略。
- **活跃筛选**：遍历所有文件，仅处理 `mtime >= since` 的文件。
- **变更计算**：
  - 尝试调用 `git log --since` 和 `git diff` 获取变更。
  - 如果 Git 完全不可用，则假设所有文件均为 "Tracked"（已追踪），仅在 mtime 变化但无法验证内容差异时，采取保守忽略或根据具体情况处理，通常会发出警告。
  - **注意**：在 Git 不可用时，为了防止将已有的大量代码误判为新增，工具默认假设文件是"旧的"，除非有明确证据表明它是新的。

### 3. 通用规则
- **目标目录过滤**：无论哪种策略，都支持 `--target-directory` 参数，仅统计指定目录下的变更。
- **文件过滤**：始终应用 `.gitignore` 规则和内置的忽略列表（如 `node_modules`）。
- **文本文件检查**：仅统计文本文件，自动跳过二进制文件。

### 4. 新增代码统计 (Added Code Statistics)
为了更准确地反映 AI 在项目演进中的贡献占比，工具在统计原始数据时，重点关注**新增代码（Lines Added）**。

- **新增代码定义**：
  - **Git 模式**：`git diff` 中的 Added 行数 + Untracked 文件总行数。
  - **非 Git 模式**：活跃文件的总行数（保守估计）。
- **展示**：在报表的原始数据列中，展示活跃文件的统计信息。当指定 `--since` 时，代码行数列会明确展示新增行数（例如：`+1000`）。
- **AI生成占比计算**：
  - **公式**：`AI生成占比 = AI有效贡献 / 项目新增代码总行数`
  - **意义**：此指标反映了在指定时间段内，项目**新产生的代码**中有多少是由 AI 贡献的。
  - **注意**：这与全量扫描模式不同。在全量模式下，分母是项目当前总行数；而在增量模式（`--since`）下，分母是期间的新增代码量，不再减去删除行数（即不使用净增量），以避免分母过小导致占比失真。

## 场景举例

假设统计起始时间为 `2026-03-01`：

| 场景 | 采用策略 | 处理逻辑 | 结果 |
| :--- | :--- | :--- | :--- |
| **正常 Git 仓库** | Git-First | 找到 2月28日的 commit 作为基准，计算之后的所有 diff + untracked | 精准增量 + 新文件全量 |
| **浅克隆 (Shallow Clone)** | Fallback | 找不到基准 commit，降级使用 mtime 筛选活跃文件，再尝试 git diff | 精准增量 (依赖 mtime) |
| **非 Git 目录** | Fallback | Git 命令失败，降级使用 mtime | 仅 mtime 活跃文件被关注 (保守模式) |
| **新增未提交文件** | Git-First | `git ls-files --others` 捕获该文件 | 计入文件总行数 |
| **修改未提交文件** | Git-First | `git diff` (unstaged) 捕获差异 | 计入差异行数 |

## 总结优势

1. **更精准的基准**：通过 Git Commit ID 作为基准，避免了 `mtime` 可能因 `touch`、分支切换或系统时间问题导致的误判。
2. **完整的变更视图**：Git-First 策略能一次性获取 Committed、Staged、Unstaged 和 Untracked 的所有变更，无遗漏。
3. **鲁棒性**：双重策略保证了在 Git 环境异常时（如 CI/CD 中的特殊检出方式）仍能产出合理的统计数据。
4. **性能更好**：Git-First 策略通常只需要几次 Git 命令，避免了对大量文件的逐个 `stat` 和逻辑判断。
