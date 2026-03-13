# AI 贡献统计分析流程图

本文档描述了 `ai-contribute` 工具如何从本地日志和项目状态中计算 AI 代码贡献度。

## 核心流程图 (Mermaid)

```mermaid
graph TD
    %% 阶段 1: 初始化与数据采集
    Start([开始分析 analyze]) --> Init[加载配置 & .gitignore]
    Init --> ScanStep[扫描 AI 会话 scanAllSessions]
    
    subgraph Scanners [数据采集 (Data Collection)]
        ScanStep --> LoopScanners[遍历 Scanners: Trae, Cursor, Claude...]
        LoopScanners -->|读取| ReadStorage[读取本地 Session 存储 (DB/JSON)]
        ReadStorage --> Parse[解析为统一格式 AISession]
        Parse --> FilterTime{是否指定 --since?}
        FilterTime -->|Yes| FilterSession[过滤时间范围内的 Session]
        FilterTime -->|No| KeepAll[保留所有 Session]
    end

    FilterSession --> BuildBaseline
    KeepAll --> BuildBaseline

    %% 阶段 2: 构建基准
    subgraph Baseline [基准构建 (Baseline Building)]
        BuildBaseline[获取当前项目文件列表] -->|git ls-files / glob| FileList[文件列表]
        
        FileList --> BuildIndex[构建库存索引 buildRepoFileIndex]
        BuildIndex --> ReadFiles[读取物理文件内容 fs.readFileSync]
        ReadFiles --> GenIndex[生成行级索引 LineSet & Counts]
        
        noteIndex>库存索引: 记录每个文件当前存在的代码行\n及其出现次数]
        GenIndex -.-> noteIndex
        
        FilterTime -->|Yes| GitDiff[计算项目增量 getProjectChanges]
        GitDiff -->|git diff| CalcAdded[计算基准分母: 项目新增代码量]
    end

    GenIndex --> VerifyStep

    %% 阶段 3: 核销验证
    subgraph Verification [核销验证 (Verification & Accounting)]
        VerifyStep[开始验证 verifySessions] --> InitPool[初始化全局剩余库存 Map]
        noteIndex --> InitPool
        
        InitPool --> LoopSess[遍历 Session (按时间正序)]
        LoopSess --> LoopChange[遍历变更 FileChange]
        
        LoopChange --> CheckLine{逐行比对库存}
        
        CheckLine -->|库存 > 0| MatchSuccess[匹配成功]
        MatchSuccess --> Deduct[扣减库存 Count--]
        Deduct --> MarkValid[标记为有效贡献 VerifiedChange]
        
        CheckLine -->|库存 = 0| MatchFail[匹配失败]
        MatchFail --> MarkInvalid[标记为无效 (已删除/被覆盖)]
        
        CheckLine -->|文件不存在| MarkInvalid
    end

    MarkValid --> Stats
    MarkInvalid --> Stats

    %% 阶段 4: 统计输出
    subgraph Reporting [统计输出 (Reporting)]
        Stats[聚合统计 computeStats] --> CalcMetric1[计算 AI 有效贡献行数]
        Stats --> CalcMetric2[计算 AI 参与文件数]
        
        CalcAdded --> CalcRatio[计算核心指标]
        CalcMetric1 --> CalcRatio
        
        CalcRatio -->|公式| Result1[AI 生成占比 = AI有效 / 项目新增代码行]
        CalcRatio -->|公式| Result2[AI 采纳率 = AI有效 / AI原始生成]
        
        Result1 --> Output([生成最终报表])
    end

    style Start fill:#f9f,stroke:#333,stroke-width:2px
    style Output fill:#f9f,stroke:#333,stroke-width:2px
    style Scanners fill:#e1f5fe,stroke:#01579b
    style Baseline fill:#e8f5e9,stroke:#2e7d32
    style Verification fill:#fff3e0,stroke:#ef6c00
    style Reporting fill:#f3e5f5,stroke:#7b1fa2
```

## 关键步骤解析

### 1. 数据采集 (Data Collection)
- **输入**: 各 AI 工具（Trae, Cursor 等）的本地数据库或日志文件。
- **动作**: `Scanner` 负责将不同格式的日志统一转换为 `AISession` 对象。
- **目的**: 收集“AI 到底写了什么”。

### 2. 基准构建 (Baseline Building)
- **输入**: 当前项目的源代码文件。
- **动作**: `buildRepoFileIndex` 逐个读取文件，建立“库存清单”。
- **目的**: 确定“现在项目里到底有什么”。这是去伪存真的基础。
- **特殊处理**: 如果指定了 `--since`，还会通过 `git diff` 计算这段时间项目的总新增代码量，作为计算占比的分母。

### 3. 核销验证 (Verification)
- **输入**: AI 会话记录 + 库存清单。
- **动作**: `verifySessions` 模拟“会计核销”过程。
    - 既然 AI 写了这行代码，那项目里现在应该有这行代码。
    - 如果有，记为有效，并从库存里扣除（防止多个人抢同一行代码的功劳）。
    - 如果没有（比如被用户删了），则记为无效。
- **目的**: 只有 **留存下来** 的代码才算有效贡献。

### 4. 统计输出 (Reporting)
- **输入**: 验证后的有效贡献数据。
- **动作**: 计算各类占比指标。
- **核心公式**:
    - **AI 生成占比**: `AI有效贡献 / 项目新增代码总行数`
    - **采纳率**: `AI有效贡献 / AI原始生成总行数`
