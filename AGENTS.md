# AGENTS.md (AI 助手指南)

本文件为使用此仓库的 AI 编程助手（如 Claude Code, Codex, Trae 等）提供指导。

## 构建与运行命令 (Build & Run Commands)

```bash
# 编译 TypeScript 到 dist/ 目录
npm run build              # tsc

# 直接运行无需编译（开发模式）
npm run dev                # tsx src/cli.ts

# 运行编译后的 CLI
npm start                  # node dist/cli.js
node dist/cli.js .         # 分析当前目录
node dist/cli.js <path> -v # 详细输出模式
```

**未配置测试框架。** 目前本项目暂无可用测试。

## 架构 (Architecture)

**流水线：扫描器 (Scanners) → 分析器 (Analyzer) → 报告器 (Reporters)**

- `src/core/` - 核心逻辑与算法
  - `git.ts` - Git 操作与项目文件分析
  - `algorithmv.ts` - 贡献验证算法与历史记录提供者
  - `scanners.ts` - 扫描器管理器 (ScannerManager)
- `src/scanners/` - 各 AI 工具的具体扫描实现
- `src/analyzer.ts` - 核心协调者，编排扫描、验证与统计
- `src/reporter.ts` - 格式化统计数据以便输出（控制台、JSON、Markdown）
- `src/cli.ts` - CLI 主入口，包含用于分析的工作线程 (worker thread)
- `src/types.ts` - 类型定义 (FileChange, AISession, ContributionStats)

**添加新的 AI 工具扫描器：**
1. 在 `src/scanners/<tool>.ts` 创建继承自 `BaseScanner` 的类
2. 在 `src/types.ts` 的 `AITool` 枚举中添加该工具
3. 在 `src/scanners/index.ts` 中导出该扫描器
4. 在 `src/core/scanners.ts` 的 `ScannerManager` 构造函数中注册该扫描器
5. 在 `src/cli.ts` 和 `src/reporter.ts` 中添加显示名称/颜色/路径

## 代码风格指南 (Code Style Guidelines)

### TypeScript 配置
- 目标版本：ES2022，模块：NodeNext (启用严格模式)
- 输出目录：`dist/`，源码目录：`src/`
- 本地导入 **必须** 使用 `.js` 扩展名（NodeNext 要求）

### 导入规范 (Imports)
```typescript
// Node.js 内置模块 - 使用命名空间导入
import * as fs from 'fs';
import * as path from 'path';

// npm 包 - 直接导入
import { Command } from 'commander';
import chalk from 'chalk';

// 本地文件 - 必须包含 .js 扩展名
import { BaseScanner } from './base.js';
import { AISession } from '../types.js';
```

### 命名约定 (Naming Conventions)
- **类/接口/枚举**：大驼峰命名法 (PascalCase)，如 `BaseScanner`, `FileChange`, `AITool`
- **方法/变量**：小驼峰命名法 (camelCase)，如 `parseSessionFile`, `storagePath`
- **枚举成员**：PascalCase 键名，对应小写字符串值
- **私有方法**：使用 `private` 关键字前缀

### 类型注解 (Type Annotations)
- 公共方法 **必须** 指定返回类型
- 使用显式的参数类型
- 对象形状优先使用接口 (Interface)
- 键值集合使用 `Map<K, V>`

### 注释 (Comments)
- 类和公共方法使用 JSDoc 风格
- 复杂逻辑使用行内注释说明
- **所有注释必须使用中文描述**

### 错误处理 (Error Handling)
- 使用 try-catch 块，允许空 catch 以实现优雅降级
- 尽可能返回 null 或空数组而不是抛出异常
- 示例：`catch { return []; }`

### 代码组织 (Code Organization)
- 抽象基类放在 `base.ts`
- 每个 AI 工具一个扫描器文件，放在 `src/scanners/`
- 在 `src/scanners/index.ts` 中重新导出所有扫描器
- 保持类专注于单一职责

## Agent 运行日志 (Agent Run Log)

- 2026-02-03 16:59:44 local: 成功运行 `pnpm dev` (tsc + `node dist/cli.js`)。检测到 Cursor 有 2 个会话；总体汇总显示 19 个文件，4501 行，14 个 AI 会话。
https://mp.weixin.qq.com/s/8bmDf4GJH5zHjscW-_SX6g
