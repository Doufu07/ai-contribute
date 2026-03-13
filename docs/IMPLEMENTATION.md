# AI 贡献统计实现原理

本文档详细解读 `ai-contribute` 工具如何实现 AI 贡献行数统计，从整体架构到具体实现细节。

## 目录

- [整体架构](#整体架构)
- [五阶段流水线](#五阶段流水线)
- [关键实现详解](#关键实现详解)
- [核心技术亮点](#核心技术亮点)
- [数据流转示例](#数据流转示例)
- [扩展指南](#扩展指南)

---

## 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                 用户运行分析命令                          │
│           node dist/cli.js <project-path>                │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│              CLI (src/cli.ts)                            │
│  - 解析命令行参数                                        │
│  - 启动 worker 线程执行分析                              │
│  - 显示进度动画                                          │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│         ContributionAnalyzer (src/analyzer.ts)           │
│                                                          │
│  核心方法：                                              │
│  1. scanAllSessions()      - 扫描所有工具会话           │
│  2. analyze()              - 主分析流程                 │
│  3. verifySessions()       - 验证贡献有效性             │
│  4. computeToolStats()     - 计算工具级统计             │
│  5. computeFileStats()     - 计算文件级统计             │
└─────────────────────┬───────────────────────────────────┘
                      │
        ┌────────────┼────────────┬────────────┐
        ▼            ▼            ▼            ▼
   ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐
   │ Claude  │  │  Trae   │  │ Codex   │  │ Gemini  │
   │ Scanner │  │ Scanner │  │ Scanner │  │ Scanner │
   └─────────┘  └─────────┘  └─────────┘  └─────────┘
        │            │            │            │
        └────────────┴────────────┴────────────┘
                     │
                     ▼
         返回 AISession[] (会话数据)
                     │
                     ▼
         验证 & 统计 & 输出报告
```

---

## 五阶段流水线

```
┌─────────────┐
│ 步骤1: 扫描 │ 扫描各 AI 工具的本地存储，获取会话记录
└──────┬──────┘
       ↓
┌─────────────┐
│ 步骤2: 提取 │ 从会话快照或日志中提取文件变更和新增行内容
│             │ (Trae: git diff | 其他: 解析 JSONL/JSON)
└──────┬──────┘
       ↓
┌─────────────┐
│ 步骤3: 验证 │ 确认 AI 贡献的代码仍存在于当前工作目录
└──────┬──────┘
       ↓
┌─────────────┐
│ 步骤4: 统计 │ 计算每个工具、每个文件的贡献行数
└──────┬──────┘
       ↓
┌─────────────┐
│ 步骤5: 输出 │ 格式化展示统计结果
└─────────────┘
```

---

## 关键实现详解

### 1️⃣ 扫描阶段 - 如何发现 AI 会话？

**实现位置:** `src/analyzer.ts:95-115`

```typescript
scanAllSessions(tools?: AITool[]): AISession[] {
  const sessions: AISession[] = [];

  for (const scanner of this.scanners) {
    // 调用每个工具的扫描器
    const toolSessions = scanner.scan(this.projectPath);
    sessions.push(...toolSessions);
  }

  // 按时间排序
  sessions.sort((a, b) =>
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  return sessions;
}
```

**每个扫描器的工作：**

| 扫描器 | 数据位置 | 格式 |
|--------|---------|------|
| Claude Scanner | `~/.claude/projects/<encoded-path>/*.jsonl` | JSONL |
| Trae Scanner | `~/Library/Application Support/Trae/User/workspaceStorage` | SQLite + Git 快照 |
| Codex Scanner | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` | JSONL (自定义 Patch) |
| Gemini Scanner | `~/.gemini/tmp/<hash>/chats/*.json` | JSON |
| Cursor Scanner | `~/Library/Application Support/Cursor/User/workspaceStorage` | SQLite |
| Opencode Scanner | `~/.local/share/opencode/` | JSON |

**输出数据结构:**

```typescript
interface AISession {
  id: string;              // 会话ID
  tool: AITool;           // 工具类型
  timestamp: Date;        // 会话时间
  projectPath: string;    // 项目路径
  changes: FileChange[];  // 文件变更列表
  totalFilesChanged: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  model?: string;         // 使用的模型
  sessionType?: SessionType;  // 会话类型分类
  operations?: SessionOperations;  // 操作统计
}

// 会话类型
type SessionType = 'code_contribution' | 'code_review' | 'analysis' | 'mixed';

// 操作统计
interface SessionOperations {
  readCount: number;
  editCount: number;
  writeCount: number;
  bashCount: number;
  grepCount: number;
  globCount: number;
  taskCount: number;
  otherCount: number;
}
```

---

#### 会话过滤机制 - 只统计有实际贡献的会话

**问题：** 为什么有些会话存在但不出现在贡献统计中？

AI 工具的会话记录中包含多种操作，但并非所有操作都会修改项目代码：

```
~/.claude/projects/-Users-xxx-project/*.jsonl

会话文件列表：
├── 46a692d1-... .jsonl   # 2026-03-02 16:15  ✓ 有代码贡献
├── 1220ae9c-... .jsonl   # 2026-03-02 17:11  ✓ 有代码贡献
├── ...
├── e4299078-... .jsonl   # 2026-03-05 22:01  ✓ 有代码贡献 (最后贡献)
├── ec994931-... .jsonl   # 2026-03-05 23:34  ✗ 无代码贡献
└── 64b6dfe1-... .jsonl   # 2026-03-06 08:38  ✗ 无代码贡献
```

**过滤规则：**

扫描器在解析会话时，会根据以下规则过滤：

```typescript
parseSessionFile(filePath, projectPath): AISession | null {
  const changes: FileChange[] = [];

  // 解析会话中的工具调用
  for (const entry of sessionEntries) {
    if (entry.type === 'tool_use') {
      const toolName = entry.name;

      // 只处理文件修改操作
      if (toolName === 'Edit' || toolName === 'Write') {
        const filePath = entry.input.file_path;

        // 排除临时文件
        if (filePath.startsWith('/tmp')) continue;
        if (filePath.startsWith('/var')) continue;

        // 排除非项目文件
        if (!filePath.startsWith(projectPath)) continue;

        changes.push(parseChange(entry));
      }
      // Read, Bash, Grep 等操作不产生代码贡献
    }
  }

  // 关键：没有实际代码变更的会话返回 null
  if (changes.length === 0) return null;

  return { id, tool, timestamp, changes, ... };
}
```

**常见无贡献会话类型：**

| 会话类型 | 操作内容 | 是否计入统计 |
|---------|---------|------------|
| 纯调试会话 | 运行命令、查看日志 | ✗ 不计入 |
| 代码审查 | Read 文件、分析代码 | ✗ 不计入 |
| 临时测试 | Write/Edit `/tmp/*` | ✗ 不计入 |
| 问题排查 | Bash、Grep、Glob | ✗ 不计入 |
| 代码修改 | Edit 项目文件 | ✓ 计入 |
| 文件创建 | Write 新文件 | ✓ 计入 |

**实际案例：**

```
会话 e4299078 (2026-03-05 22:01):
  操作: 16 次 Edit (项目文件)
  文件: IMPLEMENTATION.md, src/analyzer.ts, src/reporter.ts, ...
  结果: +761 -34 → ✓ 计入统计

会话 ec994931 (2026-03-05 23:34):
  操作: 多次 Read, Bash, Write(/tmp/*)
  文件: 无项目文件修改
  结果: changes = [] → ✗ 不计入统计

会话 64b6dfe1 (2026-03-06 08:38):
  操作: Read, Bash, Task (当前会话)
  文件: 无项目文件修改
  结果: changes = [] → ✗ 不计入统计
```

**为什么这样设计：**

1. **避免虚假统计** - 纯查看/调试会话不应计入代码贡献
2. **聚焦实际产出** - 只统计真正修改项目代码的操作
3. **准确反映贡献** - 代码贡献统计应基于实际变更，而非会话数量

**输出说明：**

在 `sessions` 命令输出中，只会显示有实际代码贡献的会话：

```
📋 AI Sessions for /Users/xxx/project

  Claude Code  03/05/2026, 10:01 PM  Files:   5  Lines: +761  ← 最后贡献
  Claude Code  03/05/2026, 09:29 PM  Files:   2  Lines:   +4
  ...

Total: 12 sessions  ← 只统计有贡献的会话
```

---

### 2️⃣ 提取阶段 - 如何获取新增行？

不同 AI 工具存储会话数据的方式各异，提取文件变更的方法也不同：

#### 提取方式对比

| 工具 | 存储方式 | 提取方法 | 数据来源 |
|------|---------|---------|---------|
| **Trae** | Git 仓库快照 | `git diff` 命令 | 快照仓库 |
| **Claude Code** | JSONL 日志 | 解析工具调用 | 会话文件 |
| **Codex** | JSONL 日志 | 解析 patch | 会话文件 |
| **Gemini** | JSON 日志 | 解析 functionCall | 聊天文件 |

#### Trae - 使用 Git 命令 + SQLite 提取

**实现位置：** `src/scanners/trae.ts`

Trae 使用两种数据源协同工作：

**1. SQLite 数据库读取会话列表和模型信息**

```typescript
// 存储路径
get storagePath(): string {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Trae', 'User', 'workspaceStorage');
  }
  // 支持 Windows 和 Linux
}

// 读取会话列表
const sessionListRaw = this.readSqliteValue(workspaceDbPath, 'memento/icube-ai-agent-storage');

// 读取模型映射
const modelMap = this.readModelMap(workspaceDbPath);
// 模型名称格式化: "1_-_gemini-3-pro" -> "Gemini 3 Pro"
```

**2. Git 快照提取变更内容**

```typescript
analyzeGitChanges(gitRepoPath, projectPath, sessionId, model) {
  // 1. 获取 git 标签
  const tags = git tag --sort=creatordate

  // 2. 找到会话开始和结束标签
  const chainStartTag = tags.find(t => t.startsWith('chain-start-'))
  const lastAfterChatTag = tags.filter(t => t.startsWith('after-chat-turn-')).pop()

  // 3. 获取文件变更统计
  const diffOutput = git diff --numstat $chainStartTag $lastAfterChatTag
  // 输出: "19\t0\tdisk/content/src/bus/index.js"

  // 4. 提取新增行内容
  for (每个变更文件) {
    const fileDiff = git diff -U0 $chainStartTag $lastAfterChatTag -- $filePath
    const addedLines = extractAddedLinesFromDiff(fileDiff)
    // addedLines = ["/**", " * Vue事件总线模块", ...]

    changes.push({
      filePath: relativePath,
      linesAdded: 19,
      linesRemoved: 0,
      changeType: 'create',
      timestamp: sessionTimestamp,
      tool: AITool.TRAE,
      model,
      addedLines  // ← 关键：存储了具体的新增行内容
    })
  }

  return { changes, timestamp }
}
```

**为什么 Trae 使用 Git + SQLite？**

Trae 在 `ModularData/ai-agent/snapshot/<session-id>/v2` 下维护了完整的 Git 仓库，同时在 workspaceStorage 的 SQLite 中存储会话元数据。

**优点：**
- ✅ 精确追踪每次修改
- ✅ 获取完整 diff 信息
- ✅ 支持复杂历史查询（如 Git 历史感知验证）
- ✅ 可以回溯到任意快照状态
- ✅ SQLite 提供会话列表和模型信息，无需遍历文件系统

**缺点：**
- ❌ 依赖 Git 环境
- ❌ 存储空间较大
- ❌ 需要 git 命令支持

---

#### Claude Code - 解析 JSONL 日志

**实现位置：** `src/scanners/claude.ts`

```typescript
parseSessionFile(filePath, projectPath) {
  // 读取 JSONL 文件（每行一个 JSON 对象）
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n')

  for (const line of lines) {
    const entry = JSON.parse(line)

    // 查找 tool_use 类型的记录
    if (entry.type === 'tool_use') {
      const toolCall = entry.tool_call

      if (toolCall.name === 'write_file') {
        // 直接提取文件内容
        const filePath = toolCall.input.file_path
        const content = toolCall.input.content

        // 从内容中提取非空行
        const addedLines = content.split('\n').filter(l => l.length > 0)

        changes.push({
          filePath,
          linesAdded: addedLines.length,
          addedLines,
          ...
        })
      } else if (toolCall.name === 'apply_patch') {
        // 解析 patch 格式
        const patch = toolCall.input.patch
        const addedLines = extractAddedLinesFromDiff(patch)
        ...
      }
    }
  }
}
```

**Claude Code 日志示例：**

```jsonl
{"type":"text","text":"让我帮你创建这个文件..."}
{"type":"tool_use","tool_call":{"name":"write_file","input":{"file_path":"src/bus/index.js","content":"import Vue from 'vue';\n\nlet eventBus;\n..."}}}
{"type":"tool_result","content":"文件已成功创建"}
```

---

#### Codex - 解析自定义 Patch 格式

**实现位置：** `src/scanners/codex.ts`

Codex 使用**自定义 patch 格式**而非标准 unified diff，需要专门的解析方法：

```typescript
parseSessionFile(filePath, projectPath) {
  const lines = content.split('\n')

  for (const line of lines) {
    const entry = JSON.parse(line)

    // 解析 custom_tool_call（apply_patch）
    if (entry.type === 'custom_tool_call' && entry.name === 'apply_patch') {
      const args = JSON.parse(entry.arguments)
      const patch = args.patch  // 获取 patch 内容

      // 解析自定义 patch 格式（非标准 diff）
      const changes = parseApplyPatch(patch)
      ...
    }
  }
}

// 自定义 patch 解析
private parseApplyPatch(patch: string): FileChange[] {
  // Codex patch 格式:
  // *** Begin Patch
  // *** Update File: path/to/file.swift
  // @@
  //  context line
  // +added line
  // -removed line
  // *** Add File: path/to/new_file.swift
  // +new file content
  // *** End Patch

  const lines = patch.split('\n')
  let currentFile: string | null = null
  let changeType: 'create' | 'modify' = 'modify'
  const addedLines: string[] = []
  const removedLines: string[] = []

  for (const line of lines) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) continue

    if (line.startsWith('*** Update File:')) {
      currentFile = line.substring('*** Update File:'.length).trim()
      changeType = 'modify'
    } else if (line.startsWith('*** Add File:')) {
      currentFile = line.substring('*** Add File:'.length).trim()
      changeType = 'create'
    } else if (line.startsWith('*** Delete File:')) {
      // 处理删除文件
    } else if (currentFile) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        addedLines.push(line.slice(1))
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        removedLines.push(line.slice(1))
      }
    }
  }

  return [{ filePath: currentFile, addedLines, removedLines, changeType, ... }]
}
```

**Codex 日志示例：**

```jsonl
{"type":"user_message","content":"创建事件总线文件"}
{"type":"custom_tool_call","name":"apply_patch","arguments":"{\"patch\":\"*** Begin Patch\\n*** Add File: src/bus/index.js\\n+import Vue from 'vue';\\n+\\n+let eventBus;\\n*** End Patch\"}"}
```

---

#### Gemini - 解析 Function Call（智能路径匹配）

**实现位置：** `src/scanners/gemini.ts`

Gemini 使用递归搜索在 JSON 数据中查找项目路径，而非 MD5 哈希匹配：

```typescript
parseSessionFile(filePath, projectPath) {
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

  // 智能项目路径匹配（非 MD5）
  const detectedProjectPath = this.findProjectPath(data)

  for (const message of data.messages) {
    // 查找 functionCall
    if (message.functionCall) {
      const fn = message.functionCall

      if (fn.name === 'write_file') {
        const args = fn.args
        const content = args.content
        const filePath = args.file_path

        const addedLines = content.split('\n').filter(l => l.length > 0)

        changes.push({
          filePath,
          linesAdded: addedLines.length,
          addedLines,
          ...
        })
      }
    }
  }
}

// 项目路径智能匹配
private findProjectPath(data: any): string | null {
  const keys = new Set([
    'projectPath', 'project_path', 'cwd', 'working_directory',
    'workspace', 'workspacePath', 'rootPath', 'repoPath',
  ]);

  // BFS 深度优先搜索嵌套对象
  const queue: Array<{ value: any; depth: number }> = [{ value: data, depth: 0 }];
  const maxDepth = 6;

  while (queue.length > 0) {
    const { value, depth } = queue.shift()!;

    if (depth > maxDepth) continue;

    if (typeof value === 'object' && value !== null) {
      for (const key of keys) {
        if (value[key] && typeof value[key] === 'string') {
          return value[key];
        }
      }

      for (const val of Object.values(value)) {
        queue.push({ value: val, depth: depth + 1 });
      }
    }
  }

  return null;
}
```

**Gemini 日志示例：**

```json
{
  "messages": [
    {
      "role": "user",
      "content": "创建事件总线"
    },
    {
      "role": "assistant",
      "functionCall": {
        "name": "write_file",
        "args": {
          "file_path": "src/bus/index.js",
          "content": "import Vue from 'vue';\n\nlet eventBus;\n..."
        }
      }
    }
  ],
  "projectPath": "/Users/xxx/project"
}
```

---

#### Cursor - SQLite 双数据库协同

**实现位置：** `src/scanners/cursor.ts`

Cursor 使用两个 SQLite 数据库协同工作，支持 Composer 会话解析：

**数据源结构：**
```
~/Library/Application Support/Cursor/User/
├── workspaceStorage/<workspace-id>/
│   └── state.vscdb         # 工作区级数据库
└── globalStorage/
    └── cursorDiskKV.db     # 全局键值存储
```

**核心实现：**

```typescript
export class CursorScanner extends BaseScanner {
  // 双模式 SQLite 访问（CLI 或 sql.js）
  private sqliteMode: 'cli' | 'sqljs' | 'none' | null = null;

  // 智能缓存（避免重复加载 sql.js WASM）
  private sqlJsCache = new Map<string, SqlJsCache>();

  // 双数据库键查找
  private readCursorValue(dbPath: string, key: string): string | null {
    // 优先查询 cursorDiskKV 表
    const cursorKv = this.querySqliteValue(dbPath,
      `select value from cursorDiskKV where key='${escaped}' limit 1;`);
    if (cursorKv) return cursorKv;

    // 回退到 ItemTable（VSCode 标准表）
    return this.querySqliteValue(dbPath,
      `select cast(value as text) from ItemTable where key='${escaped}' limit 1;`);
  }

  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];

    // 1. 扫描工作区数据库
    const workspacePath = this.findWorkspacePath(projectPath);
    const dbPath = path.join(workspacePath, 'state.vscdb');

    // 2. 读取 Composer 会话列表
    const composerData = this.readCursorValue(dbPath, 'composer/allComposerData');
    const composers = JSON.parse(composerData || '[]');

    for (const composer of composers) {
      // 3. 读取每个 Composer 的详细数据
      const sessionKey = `composer/${composer.composerId}`;
      const sessionData = this.readCursorValue(dbPath, sessionKey);

      // 4. 解析 CodeBlock 和 Diff
      const changes = this.parseComposerSession(sessionData, projectPath);

      sessions.push({
        id: composer.composerId,
        tool: AITool.CURSOR,
        changes,
        ...
      });
    }

    return sessions;
  }

  // 解析 Composer 会话中的代码变更
  private parseComposerSession(sessionData: string, projectPath: string): FileChange[] {
    const data = JSON.parse(sessionData);
    const changes: FileChange[] = [];

    for (const block of data.codeBlocks || []) {
      // 提取 CodeBlock 中的 diff
      const diffResult = this.parseCodeBlockDiff(block);

      changes.push({
        filePath: block.filePath,
        addedLines: diffResult.addedLines,
        linesAdded: diffResult.addedLines.length,
        linesRemoved: diffResult.removedLines.length,
        ...
      });
    }

    return changes;
  }
}
```

**CodeBlock Diff 解析：**

```typescript
private parseCodeBlockDiff(block: CodeBlock): DiffResult {
  const addedLines: string[] = [];
  const removedLines: string[] = [];

  // Cursor 存储原始文件状态和变更后状态
  const beforeContent = block.originalContent || '';
  const afterContent = block.content || '';

  // 使用 LCS 算法计算精确 diff
  return this.diffAddedLines(beforeContent, afterContent);
}
```

**技术特点：**
- ✅ 双模式 SQLite（CLI `sqlite3` 命令 或 sql.js WASM）
- ✅ 双数据库协同（workspace + global）
- ✅ 原始文件状态跟踪，支持精确 diff 计算
- ✅ 智能缓存避免重复初始化 sql.js

---

#### Opencode - 分层存储解析

**实现位置：** `src/scanners/opencode.ts`

Opencode 使用三层目录结构存储会话数据：

**存储结构：**
```
~/.local/share/opencode/storage/
├── session/    # 会话元数据
├── message/    # 消息文件（含 diff）
└── part/       # 消息部分
```

**核心实现：**

```typescript
export class OpencodeScanner extends BaseScanner {
  get storagePath(): string {
    return path.join(os.homedir(), '.local', 'share', 'opencode', 'storage');
  }

  scan(projectPath: string): AISession[] {
    const sessions: AISession[] = [];
    const sessionDir = path.join(this.storagePath, 'session');

    // 1. 读取所有会话元数据
    for (const sessionFile of fs.readdirSync(sessionDir)) {
      const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));

      // 2. 匹配项目路径
      if (!this.pathsMatch(sessionData.projectPath, projectPath)) continue;

      // 3. 读取会话中的所有消息
      const changes = this.parseSessionMessages(sessionData.id);

      sessions.push({
        id: sessionData.id,
        tool: AITool.OPENCODE,
        model: sessionData.model,
        changes,
        ...
      });
    }

    return sessions;
  }

  private parseSessionMessages(sessionId: string): FileChange[] {
    const changes: FileChange[] = [];
    const messageDir = path.join(this.storagePath, 'message', sessionId);

    for (const msgFile of fs.readdirSync(messageDir)) {
      const msgData = JSON.parse(fs.readFileSync(msgFile, 'utf-8'));

      // Opencode 提供预计算的 diff 统计
      if (msgData.diff) {
        const addedLines = this.extractAddedLinesFromDiff(msgData.diff);

        changes.push({
          filePath: msgData.filePath,
          addedLines,
          linesAdded: addedLines.length,
          linesRemoved: msgData.linesRemoved || 0,
          ...
        });
      }
    }

    return changes;
  }
}
```

**去重机制：**

```typescript
// Opencode 可能在多个消息中记录同一文件的多次修改
// 使用去重避免重复统计
private deduplicateChanges(changes: FileChange[]): FileChange[] {
  const byFile = new Map<string, FileChange>();

  for (const change of changes) {
    const existing = byFile.get(change.filePath);
    if (existing) {
      // 合并相同文件的多次修改
      existing.addedLines.push(...change.addedLines);
      existing.linesAdded += change.linesAdded;
      existing.linesRemoved += change.linesRemoved;
    } else {
      byFile.set(change.filePath, { ...change });
    }
  }

  return Array.from(byFile.values());
}
```

---

#### 通用 Diff 解析函数

所有工具最终都需要从 diff 或 patch 格式中提取新增行，这个通用函数在 `src/scanners/base.ts:205-220`：

```typescript
protected extractAddedLinesFromDiff(diff: string): string[] {
  const lines = diff.split(/\r?\n/)
  const added: string[] = []

  for (const line of lines) {
    // 以 '+' 开头但不是 '+++' (文件头)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1)  // 去掉 '+'
      if (content.length > 0) {
        added.push(content)
      }
    }
  }

  return added
}
```

---

#### LCS Diff 算法 - 精确新增行计算

**实现位置：** `src/scanners/base.ts:75-200`

当扫描器能获取文件的前后内容时，使用 LCS（最长公共子序列）算法精确计算新增行：

```typescript
protected diffAddedLines(before: string | undefined, after: string | undefined): string[] {
  if (!after) return [];
  if (!before) {
    // 文件新建，所有行都是新增
    return after.split('\n').filter(l => l.length > 0);
  }

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  // 优化1：去除公共前缀
  let start = 0;
  while (start < beforeLines.length &&
         start < afterLines.length &&
         beforeLines[start] === afterLines[start]) {
    start++;
  }

  // 优化2：去除公共后缀
  let endBefore = beforeLines.length - 1;
  let endAfter = afterLines.length - 1;
  while (endBefore >= start &&
         endAfter >= start &&
         beforeLines[endBefore] === afterLines[endAfter]) {
    endBefore--;
    endAfter--;
  }

  // 只对变化部分运行 LCS
  const changedBefore = beforeLines.slice(start, endBefore + 1);
  const changedAfter = afterLines.slice(start, endAfter + 1);

  // LCS 动态规划
  const m = changedBefore.length;
  const n = changedAfter.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (changedBefore[i - 1] === changedAfter[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯找出新增行
  const addedLines: string[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && changedBefore[i - 1] === changedAfter[j - 1]) {
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // 新增行
      if (changedAfter[j - 1].length > 0) {
        addedLines.unshift(changedAfter[j - 1]);
      }
      j--;
    } else {
      i--;
    }
  }

  return addedLines;
}
```

**优化效果：**
- ✅ 前后缀优化减少 LCS 计算量
- ✅ 精确识别新增行，排除移动/未变行
- ✅ 时间复杂度 O(m×n)，空间复杂度 O(m×n)

---

#### 为什么使用 LCS 而非简单行数计算？

**问题：** 为什么统计结果显示的行数与简单的 `new_lines - old_lines` 不同？

**示例对比：**

```
会话 e4299078 修改了 5 个文件：

简单计算 (new_lines - old_lines):  +1122 行
LCS Diff 算法计算:                 +761 行, -34 行
```

**原因分析：**

LCS 算法识别修改前后有部分相同的内容行，计算的是**实际新增的行数**，而非简单的行数差值。

```typescript
// diffLineCounts 核心逻辑
const beforeLines = ["line1", "line2", "line3", "line4"];  // 4 行
const afterLines = ["line1", "line2", "newLine", "line4"];  // 4 行

// ❌ 简单计算
const simpleAdded = afterLines.length - beforeLines.length;  // = 0 (错误)

// ✅ LCS 计算
const lcs = 3;  // 最长公共子序列: line1, line2, line4
const added = afterLines.length - lcs;   // = 1 (正确)
const removed = beforeLines.length - lcs; // = 1 (正确)
```

**实际场景示例：**

```typescript
// Claude Code 会话中的 Edit 操作
{
  name: "Edit",
  input: {
    file_path: "src/analyzer.ts",
    old_string: "const total = files.length;\nconst count = 0;",  // 2 行
    new_string: "const total = files.length;\nconst count = 0;\nconst debug = true;"  // 3 行
  }
}

// ❌ 简单计算: 3 - 2 = 1 行新增
// ✅ LCS 计算:
//   - 公共子序列: 2 行 (const total..., const count...)
//   - 新增: 3 - 2 = 1 行 (const debug...)
//   - 删除: 2 - 2 = 0 行
// 结果: +1 -0 (正确)
```

**更复杂的修改场景：**

```typescript
// 替换多行内容
old_string: [
  "// old comment 1",
  "// old comment 2",
  "function old() {}",
  "const x = 1;"
].join('\n');  // 4 行

new_string: [
  "// new comment",
  "function new() {}",
  "const x = 1;",
  "const y = 2;"
].join('\n');  // 4 行

// ❌ 简单计算: 4 - 4 = 0 行变更
// ✅ LCS 计算:
//   - 公共子序列: 1 行 (const x = 1;)
//   - 新增: 4 - 1 = 3 行
//   - 删除: 4 - 1 = 3 行
// 结果: +3 -3 (准确反映实际变更)
```

**统计差异的意义：**

| 指标 | 简单计算 | LCS 算法 | 说明 |
|------|----------|----------|------|
| 新增行 | +1122 | +761 | LCS 排除了移动/未变的行 |
| 删除行 | -0 | -34 | 简单计算无法识别删除 |
| 准确性 | 低 | 高 | LCS 反映真实代码变更 |

**结论：**

使用 LCS Diff 算法能够：
1. **精确统计实际变更** - 识别真正新增和删除的行
2. **处理修改场景** - 正确计算替换操作的行数变化
3. **提供删除统计** - 简单计算无法识别删除行

---

#### 流式 JSONL 解析 - 大文件内存优化

**实现位置：** `src/scanners/base.ts:280-329`

处理大型 JSONL 文件时，使用流式解析避免一次性加载整个文件到内存：

```typescript
protected forEachJsonlEntry(filePath: string, onEntry: (entry: any) => void): void {
  const fd = fs.openSync(filePath, 'r');
  const bufferSize = 64 * 1024;  // 64KB 缓冲区
  const buffer = Buffer.alloc(bufferSize);
  let leftover = '';
  const decoder = new stringDecoder.StringDecoder('utf8');

  try {
    while (true) {
      const bytesRead = fs.readSync(fd, buffer, 0, bufferSize, null);

      if (bytesRead === 0) break;

      const chunk = decoder.write(buffer.slice(0, bytesRead));
      const data = leftover + chunk;
      const lines = data.split('\n');

      // 保留最后一行（可能不完整）
      leftover = lines.pop() || '';

      // 处理完整的行
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length > 0) {
          try {
            const entry = JSON.parse(trimmed);
            onEntry(entry);
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    // 处理最后剩余的行
    if (leftover.trim().length > 0) {
      try {
        const entry = JSON.parse(leftover.trim());
        onEntry(entry);
      } catch (e) {
        // 忽略
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}
```

**使用示例：**

```typescript
// 在 Claude Scanner 中使用
parseSessionFile(filePath: string, projectPath: string): AISession {
  const changes: FileChange[] = [];

  this.forEachJsonlEntry(filePath, (entry) => {
    if (entry.type === 'tool_use' && entry.tool_call?.name === 'write_file') {
      const content = entry.tool_call.input.content;
      const addedLines = content.split('\n').filter(l => l.length > 0);
      changes.push({
        filePath: entry.tool_call.input.file_path,
        addedLines,
        ...
      });
    }
  });

  return { id: ..., changes, ... };
}
```

**优化效果：**
- ✅ 固定内存占用（64KB 缓冲区）
- ✅ 支持任意大小 JSONL 文件
- ✅ 避免 `fs.readFileSync` 的内存压力

**示例：从 diff 提取新增行**

输入 diff:
```diff
diff --git a/src/bus/index.js b/src/bus/index.js
--- /dev/null
+++ b/src/bus/index.js
@@ -0,0 +1,8 @@
+import Vue from 'vue';
+
+let eventBus;
+if (!eventBus) {
+  eventBus = new Vue();
+}
+
+export const EventBus = eventBus;
```

提取结果:
```javascript
[
  "import Vue from 'vue';",
  "let eventBus;",
  "if (!eventBus) {",
  "  eventBus = new Vue();",
  "}",
  "export const EventBus = eventBus;"
]
```

---

### 3️⃣ 验证阶段 - 如何确认贡献真实有效？

**实现位置:** `src/analyzer.ts:237-312, 348-538`

**验证流程:**

```typescript
verifySessions(sessions, repoFileIndex) {
  // 跟踪每行的剩余可验证次数（支持重复行）
  const verifiedLinesRemainingByFile = new Map<string, Map<string, number>>()
  const verifiedNormalizedRemainingByFile = new Map<string, Map<string, number>>()

  for (const session of sessions) {
    for (const change of session.changes) {
      const fileInfo = repoFileIndex.get(change.filePath)

      // 初始化剩余次数（从文件实际行数）
      if (!verifiedLinesRemainingByFile.has(change.filePath)) {
        verifiedLinesRemainingByFile.set(
          change.filePath,
          new Map(fileInfo.lineCounts)  // 每行可出现的次数
        )
      }

      // 验证每一行
      const verifiedLinesAdded = verifyChangeLines(
        change,
        fileInfo,
        verifiedLinesRemainingByFile,
        verifiedNormalizedRemainingByFile
      )

      if (verifiedLinesAdded > 0) {
        contributions.push({ change, verifiedLinesAdded, modelName })
      }
    }
  }

  return verifiedSessions
}
```

**核心验证逻辑 (verifyChangeLines):**

```typescript
verifyChangeLines(change, fileInfo, remainingExact, remainingNormalized, previousLines) {
  const addedLines = change.addedLines  // AI 声称新增的行

  // 特殊处理 Trae (Git 历史感知验证)
  if (change.tool === AITool.TRAE && change.changeType === 'create') {
    const fileCreateTime = getFileCreateTime(change.filePath)

    if (fileCreateTime && change.timestamp > fileCreateTime) {
      // 文件在会话前已存在！
      const linesBeforeSet = getFileLinesSetBeforeTimestamp(...)

      // 只统计真正新增的行
      for (const line of addedLines) {
        if (line exists in currentFile &&
            line NOT in linesBeforeSet) {  // ← 关键检查
          matched++
        }
      }
      return matched
    }
  }

  // 标准验证流程
  for (const line of addedLines) {
    // 1. 检查行是否存在于当前文件
    if (fileInfo.lineSet.has(line)) {
      // 2. 跳过之前会话已贡献的行
      if (previousLines.has(line)) continue

      // 3. 检查剩余可验证次数（支持重复行）
      const remaining = remainingExact.get(line) || 0
      if (remaining <= 0) continue  // 该行已全部验证完

      // 4. 递减剩余次数
      remainingExact.set(line, remaining - 1)
      matched++
    }
  }

  return matched
}
```

**为什么使用 Map<string, number> 而不是 Set<string>？**

文件中可能存在重复行（如 Markdown 中的 ``` 或 `---`），使用 Set 会漏计。

```typescript
// 文件示例: IMPLEMENTATION.md 有重复行
// ``` 出现 33 次，--- 出现 20 次

// ❌ 使用 Set（错误）: 只统计唯一行
verifiedSet.has('```')  // 只能统计 1 次

// ✅ 使用 Map（正确）: 统计每次出现
lineCounts.get('```')   // 返回 33，可验证 33 次
remainingExact.set('```', 32)  // 验证后递减
```
```

**getFileLinesSetBeforeTimestamp 实现 (Git 历史感知的关键):**

```typescript
private getFileLinesSetBeforeTimestamp(
  filePath: string,
  timestamp: Date
): Set<string> | null {
  // 1. 找到会话前最后一次修改该文件的提交
  const commit = git log -1 --format=%H --before=$timestamp -- $filePath

  // 2. 获取该提交时的文件内容
  const content = git show $commit:$filePath

  // 3. 返回非空行的集合
  const lines = content.split('\n').filter(line => line.length > 0)
  return new Set(lines)
}
```

**示例：验证过程演示**

```
AI 声称新增的行 (addedLines):
  [
    "/**",
    " * Vue事件总线模块",
    " * 用于实现非父子组件之间的通信",
    " * 通过创建一个空的Vue实例作为中央事件处理器",
    " */",
    "// 单例模式：确保全局只有一个事件总线实例",
    "// 导出事件总线实例，供其他组件使用"
  ]  (7行)

检查 Git 历史:
  文件创建时间: 2024-08-29
  AI 会话时间: 2026-02-03

  获取 2026-02-03 之前的文件内容:
  [
    "import Vue from 'vue';",
    "let eventBus;",
    "if (!eventBus) {",
    "  eventBus = new Vue();",
    "}",
    "export const EventBus = eventBus;"
  ]  (8行已存在)

验证每行:
  "/**" - 存在于当前文件? ✓ - 存在于历史? ✗ → 计入 ✓
  " * Vue事件总线模块" - 存在于当前文件? ✓ - 存在于历史? ✗ → 计入 ✓
  ... (共 7 行通过验证)

结果: verifiedLinesAdded = 7
```

---

### 4️⃣ 统计阶段 - 如何汇总数据？

**按工具统计 (computeToolStats):**

```typescript
computeToolStats(verifiedSessions) {
  const stats = new Map<AITool, ToolStats>()

  for (const { session, contributions } of verifiedSessions) {
    let toolStats = stats.get(session.tool)

    toolStats.sessionsCount++

    for (const { change, verifiedLinesAdded, modelName } of contributions) {
      toolStats.linesAdded += verifiedLinesAdded
      toolStats.linesRemoved += change.linesRemoved

      // 按模型细分统计
      let modelStats = toolStats.byModel.get(modelName)
      if (!modelStats) {
        modelStats = {
          model: modelName,
          sessionsCount: 0,
          filesCreated: 0,
          filesModified: 0,
          totalFiles: 0,
          linesAdded: 0,
          linesRemoved: 0,
          netLines: 0
        }
        toolStats.byModel.set(modelName, modelStats)
      }
      modelStats.linesAdded += verifiedLinesAdded
      modelStats.sessionsCount++
    }
  }

  return stats
}
```

**模型级统计类型定义：**

```typescript
interface ModelStats {
  model: string;
  sessionsCount: number;
  filesCreated: number;
  filesModified: number;
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
  netLines: number;
}

interface ToolStats {
  sessionsCount: number;
  filesCreated: number;
  filesModified: number;
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
  byModel: Map<string, ModelStats>;  // 按模型细分
}
```

---

**原始数据统计 (RawStats) - 验证对比基础：**

```typescript
// 原始统计数据（验证前）
interface RawStats {
  sessionsCount: number;
  totalFiles: number;
  linesAdded: number;
  linesRemoved: number;
}

// 在分析时同时计算原始数据和验证后数据
analyze(sessions: AISession[]): ContributionStats {
  // 1. 计算原始统计（直接从会话数据汇总）
  const rawStats: RawStats = this.computeRawStats(sessions);

  // 2. 验证会话贡献
  const verifiedSessions = this.verifySessions(sessions);

  // 3. 计算验证后统计
  const toolStats = this.computeToolStats(verifiedSessions);
  const fileStats = this.computeFileStats(verifiedSessions);

  return {
    rawStats,       // 原始数据
    toolStats,      // 验证后数据
    fileStats,
    // ...
  };
}
```

---

**目录过滤功能：**

```typescript
// ContributionStats 新增字段
interface ContributionStats {
  // ...
  targetDirectory?: string;  // 目标目录
  // ...
}

// 分析器支持目录过滤
analyze(sessions: AISession[], options?: AnalyzeOptions): ContributionStats {
  const targetDir = options?.directory;

  // 1. 构建仓库文件索引时过滤目录
  const repoFiles = this.buildRepoFileIndex(projectPath, targetDir);

  // 2. 验证时只处理目标目录内的文件
  if (targetDir) {
    const normalizedTarget = targetDir.replace(/\\/g, '/');
    for (const session of sessions) {
      session.changes = session.changes.filter(change => {
        const normalizedPath = change.filePath.replace(/\\/g, '/');
        return normalizedPath.startsWith(normalizedTarget);
      });
    }
  }

  // 3. 标记统计结果
  stats.targetDirectory = targetDir;

  return stats;
}
```

**目录过滤使用场景：**
- Vue/React 前端项目：`ai-contribute -d src -v`
- 只分析组件目录：`ai-contribute -d src/components -v`
- 后端项目：`ai-contribute /path/to/backend -d lib -v`
```

**按文件统计 (computeFileStats):**

```typescript
computeFileStats(verifiedSessions, repoFileIndex) {
  const stats = new Map<string, FileStats>()

  // 初始化所有文件的统计
  for (const [file, info] of repoFileIndex) {
    stats.set(file, {
      filePath: file,
      totalLines: info.nonEmptyLines,
      aiContributedLines: 0,
      contributions: new Map<AITool, number>(),
      fileCreateTime: getFileCreateTime(file),  // 可能为 null（无 git 历史）
      contributionType: 'unknown'
    })
  }

  // 累加 AI 贡献
  for (const { session, contributions } of verifiedSessions) {
    for (const { change, verifiedLinesAdded } of contributions) {
      let fileStats = stats.get(change.filePath)

      fileStats.aiContributedLines += verifiedLinesAdded

      // 记录每个工具的贡献
      const currentToolContrib = fileStats.contributions.get(session.tool) || 0
      fileStats.contributions.set(session.tool, currentToolContrib + verifiedLinesAdded)

      // 判断贡献类型（有 git 历史时）
      if (fileStats.fileCreateTime && session.timestamp > fileStats.fileCreateTime) {
        fileStats.contributionType = 'enhance'  // 优化
      } else if (fileStats.fileCreateTime) {
        fileStats.contributionType = 'create'   // 创建
      }
    }
  }

  // 计算占比 & 处理无 git 历史的文件
  for (const [, fileStats] of stats) {
    fileStats.aiContributionRatio =
      fileStats.aiContributedLines / fileStats.totalLines

    // 无 git 历史时的备用判断逻辑
    if (fileStats.contributionType === 'unknown') {
      if (fileStats.aiContributionRatio >= 1.0) {
        fileStats.contributionType = 'create'   // 100% AI 贡献
      } else if (fileStats.aiContributedLines > 0) {
        fileStats.contributionType = 'enhance'  // 部分 AI 贡献
      }
    }
  }

  return stats
}
```

**贡献类型判断逻辑：**

| 条件 | 类型 | 说明 |
|------|------|------|
| 有 git 历史 && AI 会话时间 > 文件创建时间 | `enhance` | AI 优化了已存在的文件 |
| 有 git 历史 && AI 会话时间 ≤ 文件创建时间 | `create` | AI 创建了文件 |
| 无 git 历史 && AI 贡献率 = 100% | `create` | 推断为 AI 创建 |
| 无 git 历史 && 0 < AI 贡献率 < 100% | `enhance` | 推断为 AI 优化 |
```

---

### 5️⃣ 输出阶段 - 如何展示结果？

**Reporter 实现** (`src/reporter.ts`)

**1. 验证对比表格 - 显示原始数据 vs 验证后数据**

```typescript
private printVerificationComparison(stats: ContributionStats): void {
  const raw = stats.rawStats;
  const verified = this.computeVerifiedStats(stats);

  console.log('📋 验证对比 (原始 → 验证后)\n');

  const table = new Table({
    head: ['指标', '原始数据', '验证后', '通过率'],
  });

  // 会话通过率
  const sessionRate = raw.sessionsCount > 0
    ? ((verified.sessionsCount / raw.sessionsCount) * 100).toFixed(1)
    : '0.0';
  table.push(['会话数', raw.sessionsCount, verified.sessionsCount, `${sessionRate}%`]);

  // 文件通过率
  const fileRate = raw.totalFiles > 0
    ? ((verified.totalFiles / raw.totalFiles) * 100).toFixed(1)
    : '0.0';
  table.push(['文件数', raw.totalFiles, verified.totalFiles, `${fileRate}%`]);

  // 新增行通过率
  const lineRate = raw.linesAdded > 0
    ? ((verified.linesAdded / raw.linesAdded) * 100).toFixed(1)
    : '0.0';
  table.push(['新增行', `+${raw.linesAdded}`, `+${verified.linesAdded}`, `${lineRate}%`]);

  // 删除行（无通过率概念）
  table.push(['删除行', `-${raw.linesRemoved}`, `-${verified.linesRemoved}`, '-']);

  console.log(table.toString());
  console.log('  验证模式: relaxed (只统计当前代码库中仍存在的贡献)\n');
}
```

**输出示例：**
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
├────────┼──────────┼────────┼────────┤
│ 删除行 │ -710     │ -448   │ -      │
└────────┴──────────┴────────┴────────┘
  验证模式: relaxed (只统计当前代码库中仍存在的贡献)
```

---

**2. 分布可视化条形图 - 直观展示各工具贡献占比**

```typescript
private printDistributionBar(stats: ContributionStats): void {
  const totalLines = stats.totalLines;
  const aiLines = stats.totalAiLines;
  const humanLines = totalLines - aiLines;

  // 计算每个工具的贡献
  const contributions: Array<{ tool: AITool; lines: number; ratio: number }> = [];
  for (const [tool, toolStats] of stats.byTool) {
    contributions.push({
      tool,
      lines: toolStats.linesAdded,
      ratio: toolStats.linesAdded / totalLines,
    });
  }
  contributions.sort((a, b) => b.lines - a.lines);

  // 绘制条形图
  const barWidth = 60;  // 总宽度
  let barParts: string[] = [];

  // AI 工具部分
  for (const contrib of contributions) {
    const width = Math.max(1, Math.round(contrib.ratio * barWidth));
    const color = TOOL_COLORS[contrib.tool];
    barParts.push(color('█'.repeat(width)));
  }

  // 未知/人工部分
  const humanRatio = humanLines / totalLines;
  const humanWidth = Math.max(0, Math.round(humanRatio * barWidth));
  barParts.push(chalk.gray('█'.repeat(humanWidth)));

  console.log('\n📈 贡献分布\n');
  console.log('  ' + barParts.join('') + '\n');

  // 图例
  for (const contrib of contributions) {
    const toolName = TOOL_NAMES[contrib.tool];
    const percentage = (contrib.ratio * 100).toFixed(1);
    const lines = contrib.lines;
    const color = TOOL_COLORS[contrib.tool];
    console.log(`  ● ${color(toolName.padEnd(12))} ${percentage}%  (${lines} 行)`);
  }
  const humanPercentage = (humanRatio * 100).toFixed(1);
  console.log(`  ● ${chalk.gray('未知/人工'.padEnd(12))} ${humanPercentage}%  (${humanLines} 行)\n`);
}
```

**输出示例：**
```
📈 贡献分布

  ████████████████████████████████████████████████████████████

  ● Trae            17.4%  (969 行)
  ● Claude Code      2.8%  (156 行)
  ● 未知/人工           79.8%  (4452 行)
```

---

**3. 目录级统计 - 按目录汇总 AI 贡献**

```typescript
printDirectories(stats: ContributionStats, limit: number = 15): void {
  // 按目录聚合文件统计
  const dirStats = new Map<string, {
    totalFiles: number;
    aiFiles: number;
    totalLines: number;
    aiLines: number;
  }>();

  for (const [filePath, fileStats] of stats.byFile) {
    const dir = path.dirname(filePath);
    const normalizedDir = dir === '.' ? '根目录' : dir;

    let dirData = dirStats.get(normalizedDir);
    if (!dirData) {
      dirData = { totalFiles: 0, aiFiles: 0, totalLines: 0, aiLines: 0 };
      dirStats.set(normalizedDir, dirData);
    }

    dirData.totalFiles++;
    dirData.totalLines += fileStats.totalLines;
    dirData.aiLines += fileStats.aiContributedLines;
    if (fileStats.aiContributedLines > 0) {
      dirData.aiFiles++;
    }
  }

  // 按总行数排序
  const sorted = Array.from(dirStats.entries())
    .sort((a, b) => b[1].totalLines - a[1].totalLines)
    .slice(0, limit);

  console.log('📂 各目录 AI 贡献统计');

  const table = new Table({
    head: ['目录', '文件数', 'AI 文件', '总行数', 'AI 行数', 'AI 占比'],
  });

  for (const [dir, data] of sorted) {
    const aiRatio = data.totalLines > 0
      ? ((data.aiLines / data.totalLines) * 100).toFixed(1)
      : '0.0';
    table.push([
      dir,
      data.totalFiles,
      data.aiFiles,
      data.totalLines,
      data.aiLines,
      `${aiRatio}%`,
    ]);
  }

  console.log(table.toString());
}
```

**输出示例：**
```
📂 各目录 AI 贡献统计
┌────────┬────────┬─────────┬────────┬─────────┬─────────┐
│ 目录   │ 文件数 │ AI 文件 │ 总行数 │ AI 行数 │ AI 占比 │
├────────┼────────┼─────────┼────────┼─────────┼─────────┤
│ src    │ 13     │ 4       │ 4238   │ 1125    │ 26.5%   │
├────────┼────────┼─────────┼────────┼─────────┼─────────┤
│ 根目录 │ 7      │ 0       │ 600    │ 0       │ 0.0%    │
└────────┴────────┴─────────┴────────┴─────────┴─────────┘
```

---

**4. 文件级统计表**

```typescript
printFiles(stats: ContributionStats) {
  const table = new Table({
    head: ['文件', '总行数', 'AI 行数', 'AI 占比', '类型', '贡献者详情']
  })

  for (const [filePath, fileStats] of sortedFiles) {
    // 贡献者详情：显示每个工具的具体贡献行数
    const contributors = Array.from(fileStats.contributions.entries())
      .map(([tool, lines]) => `${TOOL_NAMES[tool]}:${lines}`)
      .sort((a, b) => parseInt(b.split(':')[1]) - parseInt(a.split(':')[1]))
      .join(', ')

    // 类型显示
    let typeDisplay = '-'
    if (fileStats.contributionType === 'create') {
      typeDisplay = chalk.green('创建')
    } else if (fileStats.contributionType === 'enhance') {
      typeDisplay = chalk.yellow('优化')
    }

    table.push([
      filePath,
      fileStats.totalLines,
      fileStats.aiContributedLines,
      (fileStats.aiContributionRatio * 100).toFixed(1) + '%',
      typeDisplay,
      contributors
    ])
  }

  console.log(table.toString())
}
```

---

## 核心技术亮点

### 🎯 亮点1: 基于 Git 的历史感知验证

**问题：** Trae 快照不完整，误判"创建"为"修改"

**解决方案：**
```typescript
// 1. 查询文件创建时间
git log --diff-filter=A --format=%ai -- <file>

// 2. 获取会话前的文件内容
git log -1 --before=<timestamp> -- <file>
git show <commit>:<file>

// 3. 只统计真正新增的行
if (line NOT in linesBeforeSession) {
  count++
}
```

**效果：**
- ✅ 从误报 19 行 → 准确统计 7 行
- ✅ 正确识别为"优化"而非"创建"

---

### 🎯 亮点2: 多维度去重机制

**场景：** 同一行代码可能被多个工具多次修改，且文件中可能存在重复行

**解决方案：**
```typescript
// 使用 Map<string, number> 跟踪每行的剩余可验证次数
const verifiedLinesRemainingByFile = new Map<string, Map<string, number>>()
const verifiedNormalizedRemainingByFile = new Map<string, Map<string, number>>()

// 初始化时从文件实际行数开始
verifiedLinesRemainingByFile.set(filePath, new Map(fileInfo.lineCounts))
// lineCounts: { "```": 33, "---": 20, "let x = 1;": 2, ... }

// 验证时递减剩余次数
const remaining = remainingExact.get(line) || 0
if (remaining <= 0) continue  // 已全部验证
remainingExact.set(line, remaining - 1)

// relaxed 模式还支持规范化匹配
const normalized = line.trim().replace(/\s+/g, ' ')
if (remainingNormalized.get(normalized) > 0) {
  remainingNormalized.set(normalized, remainingNormalized.get(normalized) - 1)
}
```

**效果：**
- ✅ 正确处理重复行（如 Markdown 代码块标记）
- ✅ IMPLEMENTATION.md 从误报 70.3% → 准确 100%
- ✅ 避免多工具重复统计

---

### 🎯 亮点3: 增量验证策略

**问题：** 验证需要读取所有文件内容，性能开销大

**优化：**
```typescript
// 只为 AI 修改过的文件建立行索引
const filesNeedingLineSet = new Set<string>()

for (const session of sessions) {
  for (const change of session.changes) {
    if (repoFileSet.has(change.filePath)) {
      filesNeedingLineSet.add(change.filePath)
    }
  }
}

// 只读取这些文件
const repoFileIndex = buildRepoFileIndex(repoFiles, filesNeedingLineSet)
```

**效果：** 大幅减少 I/O 操作，提升性能

---

### 🎯 亮点4: 三种验证模式

| 模式 | 特点 | 适用场景 |
|------|------|----------|
| **strict** | 精确匹配，每一行必须完全一致 | 严格审计场景 |
| **relaxed** | 宽松匹配，支持空白字符差异 | 日常使用（默认） |
| **historical** | 信任历史数据，不验证 | 快速预览 |

---

### 🎯 亮点5: 无 Git 历史时的智能推断

**问题：** 非 Git 项目无法获取文件创建时间，贡献类型显示为空

**解决方案：**
```typescript
// 在统计阶段结束后，对 unknown 类型进行推断
if (fileStats.contributionType === 'unknown') {
  if (fileStats.aiContributionRatio >= 1.0) {
    fileStats.contributionType = 'create'   // 100% AI → 推断为创建
  } else if (fileStats.aiContributedLines > 0) {
    fileStats.contributionType = 'enhance'  // 部分 AI → 推断为优化
  }
}
```

**效果：**
- ✅ 非 Git 项目也能正确显示"创建"或"优化"
- ✅ IMPLEMENTATION.md 显示"创建"（100% AI 贡献）

---

### 🎯 亮点7: 会话类型智能分类

**问题：** 不是所有 AI 会话都会修改项目代码，需要区分不同类型的会话

**解决方案：**

基于会话中的操作类型进行智能分类：

```typescript
// src/types.ts
export type SessionType = 'code_contribution' | 'code_review' | 'analysis' | 'mixed';

export interface SessionOperations {
  readCount: number;    // Read 操作次数
  editCount: number;    // Edit 操作次数
  writeCount: number;   // Write 操作次数
  bashCount: number;    // Bash 操作次数
  grepCount: number;    // Grep 操作次数
  globCount: number;    // Glob 操作次数
  taskCount: number;    // Task 操作次数
  otherCount: number;   // 其他操作次数
}
```

**分类规则：**

```typescript
// src/scanners/base.ts
static classifySessionFromOps(ops: SessionOperations): SessionType {
  const hasReads = ops.readCount > 0;
  const hasEdits = ops.editCount > 0 || ops.writeCount > 0;
  const hasAnalysis = ops.bashCount > 0 || ops.grepCount > 0 || ops.globCount > 0;

  if (hasEdits) {
    return 'code_contribution';  // 有代码修改
  }
  if (hasReads && !hasAnalysis) {
    return 'code_review';        // 只读取文件
  }
  if (hasAnalysis && !hasReads) {
    return 'analysis';           // 调试/搜索
  }
  return 'mixed';                // 混合操作
}
```

**会话类型说明：**

| 类型 | 说明 | 典型场景 |
|------|------|----------|
| **代码贡献** | 修改或创建了项目代码 | 开发新功能、修复 Bug |
| **代码审查** | 只读取文件，未做修改 | Code Review、代码理解 |
| **问题分析** | 调试、搜索、运行命令 | 排查问题、查找文件 |
| **混合操作** | 多种操作但无代码变更 | 复杂调试场景 |

**输出效果：**

```
📊 会话类型统计

┌──────────┬────────┬──────────────────────┐
│ 类型     │ 会话数 │ 说明                 │
├──────────┼────────┼──────────────────────┤
│ 代码贡献 │ 14     │ 修改或创建了项目代码 │
├──────────┼────────┼──────────────────────┤
│ 混合操作 │ 6      │ 多种操作但无代码变更 │
└──────────┴────────┴──────────────────────┘
```

**实现细节：**

Claude Scanner 在解析会话时收集所有操作：

```typescript
// src/scanners/claude.ts
parseSessionFile(filePath: string, projectPath: string): AISession | null {
  const operations: SessionOperations = {
    readCount: 0, editCount: 0, writeCount: 0,
    bashCount: 0, grepCount: 0, globCount: 0,
    taskCount: 0, otherCount: 0,
  };

  // 遍历所有 tool_use 块
  for (const block of content) {
    if (block.type === 'tool_use') {
      const toolName = (block.name || '').toLowerCase();
      this.countOperation(toolName, operations);
      // ...
    }
  }

  return {
    // ...
    sessionType: this.determineSessionType(operations, changes),
    operations,
  };
}
```

**效果：**
- ✅ 清晰区分有代码贡献和无贡献的会话
- ✅ 帮助理解 AI 工具的实际使用场景
- ✅ 独立表格展示，不影响原有统计

---

### 🎯 亮点6: 智能文件过滤

**位置：** `src/analyzer.ts:663-718`

实际实现的过滤规则比文档描述更丰富：

**默认忽略规则：**

```typescript
private shouldIgnoreByDefault(file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  const wrapped = '/' + normalized + '/';

  // 标准忽略
  if (normalized.startsWith('node_modules/')) return true;
  if (normalized.startsWith('.git/')) return true;
  if (normalized.startsWith('dist/')) return true;
  if (normalized.startsWith('build/')) return true;
  if (normalized.startsWith('.next/')) return true;

  // 扩展忽略
  if (wrapped.includes('/logs/')) return true;
  if (wrapped.includes('/jsonData/')) return true;
  if (normalized.endsWith('.db')) return true;
  if (normalized.endsWith('.sqlite')) return true;
  if (normalized.endsWith('.sqlite3')) return true;
  if (normalized.endsWith('.lock')) return true;

  // 二进制文件
  if (this.isBinaryFile(normalized)) return true;

  return false;
}
```

**文本文件识别：**

```typescript
private isTextFile(file: string): boolean {
  // 支持 70+ 种文本文件扩展名
  const textExtensions = [
    // JavaScript/TypeScript
    '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
    // Python
    '.py', '.pyw', '.pyi',
    // 其他语言
    '.rb', '.go', '.rs', '.java', '.kt', '.scala',
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
    '.cs', '.swift', '.m', '.mm',
    '.php', '.lua', '.r', '.ex', '.exs',
    // Web
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.vue', '.svelte', '.astro',
    // 配置
    '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg',
    '.xml', '.svg', '.graphql', '.gql',
    // 文档
    '.md', '.mdx', '.txt', '.rst', '.adoc',
    '.rst', '.org', '.wiki',
    // Shell
    '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat',
    // 其他
    '.sql', '.prisma', '.proto', '.thrift',
    '.dockerfile', '.makefile', '.rakefile',
    '.gitignore', '.dockerignore', '.editorconfig',
    '.eslintrc', '.prettierrc', '.babelrc',
  ];

  const ext = path.extname(file).toLowerCase();
  return textExtensions.includes(ext) ||
         textExtensions.includes(ext.replace('.', ''));
}

// 无扩展名文件处理
private hasNoExtension(file: string): boolean {
  const basename = path.basename(file);
  return !basename.includes('.');
}

// 特殊文件名识别
private isSpecialTextFile(file: string): boolean {
  const basename = path.basename(file).toLowerCase();
  const specialFiles = [
    'dockerfile', 'makefile', 'rakefile', 'gemfile',
    'license', 'readme', 'changelog', 'authors',
    'vagrantfile', 'procfile', 'brewfile',
  ];
  return specialFiles.includes(basename);
}
```

**效果：**
- ✅ 准确识别文本文件，避免误统计二进制文件
- ✅ 支持无扩展名配置文件（Dockerfile、Makefile 等）
- ✅ 自动忽略日志、数据库、锁文件

---

## 数据流转示例

以 `src/bus/index.js` 为例：

```
┌─────────────────────────────────────────────────────────┐
│ 1. 扫描阶段                                              │
│    Trae Scanner 发现会话 69814bbb793ce3a67f31f0aa       │
│    时间: 2026-02-03 09:14:27                            │
└─────────────────────┬───────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────┐
│ 2. 提取阶段                                              │
│    git diff chain-start after-chat-turn                 │
│    输出: disk/content/src/bus/index.js +19 -0          │
│                                                          │
│    提取新增行:                                           │
│    [                                                     │
│      "/**",                                              │
│      " * Vue事件总线模块",                               │
│      ... (19行)                                          │
│    ]                                                     │
└─────────────────────┬───────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────┐
│ 3. 验证阶段                                              │
│    检查: 文件创建时间 2024-08-29 < 会话时间 2026-02-03   │
│    获取历史版本: 8 行已存在                              │
│                                                          │
│    验证新增的 19 行:                                     │
│    - 存在于当前文件? ✓                                   │
│    - 不在历史版本? ✓ (7行)                               │
│                                                          │
│    结果: verifiedLinesAdded = 7                         │
└─────────────────────┬───────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────┐
│ 4. 统计阶段                                              │
│    byTool: Trae.linesAdded += 7                         │
│    byFile: src/bus/index.js.aiContributedLines += 7     │
│    byFile: src/bus/index.js.contributions[Trae] = 7    │
│    contributionType = 'enhance'                         │
└─────────────────────┬───────────────────────────────────┘
                      ↓
┌─────────────────────────────────────────────────────────┐
│ 5. 输出阶段                                              │
│    文件: src/bus/index.js                                │
│    总行数: 13                                            │
│    AI 行数: 7 (Trae:1, Claude Code:6)                   │
│    AI 占比: 53.8%                                        │
│    类型: 优化                                            │
└─────────────────────────────────────────────────────────┘
```

---

## 关键文件说明

| 文件 | 作用 | 关键方法 |
|------|------|----------|
| `src/types.ts` | 类型定义 | `FileChange`, `AISession`, `FileStats` |
| `src/analyzer.ts` | 核心分析器 | `analyze()`, `verifySessions()`, `computeStats()` |
| `src/scanners/*.ts` | 工具扫描器 | `scan()`, `parseSessionFile()` |
| `src/reporter.ts` | 报告输出 | `printFiles()`, `printTools()` |
| `src/cli.ts` | 命令行入口 | 参数解析，启动分析 |

---

## 扩展指南

### 添加新工具只需 4 步

**1. 创建 Scanner** (`src/scanners/newtool.ts`)

```typescript
export class NewToolScanner extends BaseScanner {
  get tool(): AITool { return AITool.NEWTOOL; }
  get storagePath(): string { return '~/.newtool/sessions'; }

  scan(projectPath: string): AISession[] {
    // 解析工具的会话存储格式
    // 返回 AISession[]
  }
}
```

**2. 添加类型** (`src/types.ts`)

```typescript
export enum AITool {
  NEWTOOL = 'newtool',
}
```

**3. 注册扫描器** (`src/analyzer.ts`)

```typescript
this.scanners = [
  new NewToolScanner(),
  // ...
];
```

**4. 添加显示信息** (`src/cli.ts`, `src/reporter.ts`)

```typescript
TOOL_NAMES[AITool.NEWTOOL] = 'NewTool';
TOOL_COLORS[AITool.NEWTOOL] = chalk.magenta;
```

---

## 算法复杂度分析

| 阶段 | 复杂度 | 说明 |
|------|--------|------|
| 扫描阶段 | O(n) | n = 会话数 |
| 提取阶段 | O(m) | m = 文件变更数 |
| 验证阶段 | O(m × k) | k = 平均每文件行数 |
| 统计阶段 | O(m) | - |
| **总体** | **O(n + m × k)** | - |

**性能优化措施:**
- 使用 Set 数据结构加速查找 O(1)
- 只为必要文件建立索引
- Worker 线程避免阻塞主线程

---

## 版本更新记录

### v2.0 - 多工具支持与验证增强

**新增 AI 工具支持：**
- **Cursor Scanner** - 支持 Cursor IDE 的 Composer 会话
  - 双模式 SQLite 访问（CLI 和 sql.js WASM）
  - 双数据库协同（workspace + global）
  - 原始文件状态跟踪，支持精确 diff 计算

- **Opencode Scanner** - 支持 Opencode 工具
  - 三层存储结构解析（session/message/part）
  - 预计算 diff 统计支持
  - 自动去重机制

**新增核心功能：**

1. **RawStats 原始统计对比**
   - 显示验证前后的数据对比
   - 计算会话、文件、行级别的通过率
   - 帮助理解 AI 贡献的留存情况

2. **目录过滤功能**
   - 支持 `-d/--directory` 参数
   - 只分析指定子目录的贡献
   - 适用于 Vue/React 前端项目

3. **模型级细粒度统计**
   - 按模型细分统计每个工具的贡献
   - 支持显示具体模型名称（如 Gemini 3 Pro）

4. **LCS Diff 算法**
   - 精确计算文件变更中的新增行
   - 前后缀优化减少计算量
   - 支持前后内容对比

5. **流式 JSONL 解析**
   - 大文件内存优化
   - 固定 64KB 缓冲区
   - 支持任意大小文件

**Reporter 输出增强：**

1. **验证对比表格** - 显示原始数据 vs 验证后数据及通过率
2. **分布可视化条形图** - 彩色堆叠条形图展示各工具贡献占比
3. **目录级统计** - 按目录汇总 AI 贡献

**文件过滤增强：**
- 支持 70+ 种文本文件扩展名
- 自动识别无扩展名配置文件
- 扩展忽略规则（日志、数据库、锁文件）

**实现优化：**
- Trae Scanner 改用 SQLite 读取会话列表和模型信息
- Gemini Scanner 改用递归搜索匹配项目路径
- Codex Scanner 支持自定义 patch 格式解析

---

## 未来改进方向

### 性能优化
- 缓存 git 历史查询结果
- 增量更新机制
- 并行处理多个仓库

### 功能增强
- 支持更多 AI 工具
- 增加时间范围过滤
- 支持分支对比
- 生成趋势报告

### 展示优化
- 生成 HTML 交互式报告
- 增加可视化图表
- 支持导出 CSV/JSON
- IDE 集成插件