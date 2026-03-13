
import { strict as assert } from 'assert';
import { ContributionVerifier, normalizeLine, isLineEmptyOrWhitespace, RepoFileInfo } from '../../src/core/algorithmv.js';
import { AITool, FileChange, AISession } from '../../src/types.js';

// Helper to format bytes to MB
function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// Generate large file content
function generateLargeFileContent(lineCount: number): string {
  const lines: string[] = [];
  const templates = [
    'public void processData(String data) {',
    '    if (data == null) return;',
    '    System.out.println("Processing " + data);',
    '    int result = calculateHash(data);',
    '    saveToDatabase(result);',
    '}',
    '',
    '// Helper function',
    'private int calculateHash(String input) {',
    '    return input.hashCode() * 31;',
    '}'
  ];

  // 10,000 lines
  for (let i = 0; i < lineCount; i++) {
    // Add some uniqueness to avoid extreme deduplication optimization in V8 strings, 
    // though for the algorithm it matters how many unique lines there are.
    // Let's make every 10th block unique to simulate real code mix of repeats and unique logic.
    if (i % 100 === 0) {
        lines.push(`// Unique comment section ${i}`);
    } else {
        const templateIndex = i % templates.length;
        lines.push(templates[templateIndex]);
    }
  }
  return lines.join('\n');
}

function buildRepoFileInfoManual(content: string): RepoFileInfo {
    const lines = content.split(/\r?\n/);
    const lineSet = new Set<string>();
    const normalizedLineSet = new Set<string>();
    const lineCounts = new Map<string, number>();
    const normalizedLineCounts = new Map<string, number>();
    let nonEmptyLines = 0;

    for (const line of lines) {
        if (isLineEmptyOrWhitespace(line)) continue;
        nonEmptyLines++;

        lineSet.add(line);
        lineCounts.set(line, (lineCounts.get(line) || 0) + 1);

        const normalized = normalizeLine(line);
        if (normalized.length > 0) {
            normalizedLineSet.add(normalized);
            normalizedLineCounts.set(normalized, (normalizedLineCounts.get(normalized) || 0) + 1);
        }
    }

    return {
        totalLines: lines.length,
        nonEmptyLines,
        lineSet,
        normalizedLineSet,
        lineCounts,
        normalizedLineCounts
    };
}

// Helper to create a FileChange object
function createFileChange(filePath: string, content: string): FileChange {
  const addedLines = content.split('\n');
  return {
    filePath,
    linesAdded: addedLines.length,
    linesRemoved: 0,
    changeType: 'modify',
    timestamp: new Date(),
    tool: AITool.TRAE,
    addedLines,
    content
  };
}

// Helper to wrap verification logic using public API
function verifyChange(verifier: ContributionVerifier, change: FileChange, fileInfo: RepoFileInfo): { matched: number } {
    const session: AISession = {
        id: 'test-session',
        projectPath: '.',
        tool: change.tool,
        timestamp: new Date(),
        changes: [change],
        totalFilesChanged: 1,
        totalLinesAdded: change.linesAdded,
        totalLinesRemoved: 0
    };

    const repoIndex = new Map<string, RepoFileInfo>([[change.filePath, fileInfo]]);
    const results = verifier.verifySessions([session], repoIndex);
    
    if (results.length > 0 && results[0].contributions.length > 0) {
        return { matched: results[0].contributions[0].verifiedLinesAdded };
    }
    return { matched: 0 };
}

async function runPerformanceTest() {
  const LINE_COUNT = 10000; // 1万行
  const CHANGE_SIZE = 1000; // 模拟一次提交 1000 行变更
  
  console.log(`🚀 开始执行性能基准测试...`);
  console.log(`📄 目标文件大小: ${LINE_COUNT} 行`);
  console.log(`📝 模拟变更大小: ${CHANGE_SIZE} 行`);
  console.log('--------------------------------------------------');

  // 0. 准备数据
  console.log('⏳ 正在生成测试数据...');
  const fileContent = generateLargeFileContent(LINE_COUNT);
  // 模拟变更：提取文件中的一部分作为"新增"代码（模拟复制粘贴或重构）
  const addedLines = fileContent.split('\n').slice(2000, 2000 + CHANGE_SIZE);
  const addedContent = addedLines.join('\n');
  
  // 强制垃圾回收（如果运行时支持）以获取准确初始内存
  if (global.gc) {
      global.gc();
  }
  const initialMemory = process.memoryUsage();

  const verifier = new ContributionVerifier('.', 'relaxed');

  // 1. 测试索引构建性能 (buildRepoFileInfo)
  console.log('\n[阶段 1] 构建文件索引 (Indexing)');
  const startBuild = process.hrtime.bigint();
  
  const fileInfo = buildRepoFileInfoManual(fileContent);
  
  const endBuild = process.hrtime.bigint();
  const buildTimeMs = Number(endBuild - startBuild) / 1e6;
  
  console.log(`⏱️  耗时: ${buildTimeMs.toFixed(3)} ms`);
  console.log(`📊 索引统计: Total=${fileInfo.totalLines}, NonEmpty=${fileInfo.nonEmptyLines}, Unique=${fileInfo.lineSet.size}`);

  // 2. 测试验证性能 (verifyChangeLines)
  console.log('\n[阶段 2] 验证变更代码 (Verification)');
  
  const change = createFileChange('LargeService.java', addedContent);
  
  const startVerify = process.hrtime.bigint();
  
  const result = verifyChange(verifier, change, fileInfo);
  
  const endVerify = process.hrtime.bigint();
  const verifyTimeMs = Number(endVerify - startVerify) / 1e6;

  console.log(`⏱️  耗时: ${verifyTimeMs.toFixed(3)} ms`);
  console.log(`✅ 匹配行数: ${result.matched} / ${CHANGE_SIZE}`); // Note: matched might be less due to empty lines filtering

  // 3. 内存占用分析
  const finalMemory = process.memoryUsage();
  const heapUsedDiff = Number(finalMemory.heapUsed - initialMemory.heapUsed);
  const rssDiff = Number(finalMemory.rss - initialMemory.rss);

  console.log('\n--------------------------------------------------');
  console.log('💾 内存占用报告 (Memory Usage)');
  console.log(`Heap Used (Initial): ${formatMB(Number(initialMemory.heapUsed))}`);
  console.log(`Heap Used (Final):   ${formatMB(Number(finalMemory.heapUsed))}`);
  console.log(`Delta (Approx cost): ${formatMB(heapUsedDiff)}`);
  console.log(`RSS Delta:           ${formatMB(rssDiff)}`);
  
  console.log('\n--------------------------------------------------');
  console.log('🏁 结论');
  if (buildTimeMs < 100) {
      console.log(`✨ 索引构建速度极快 (<100ms)，完全满足实时处理需求。`);
  } else if (buildTimeMs < 500) {
      console.log(`👌 索引构建速度良好 (<500ms)。`);
  } else {
      console.log(`⚠️ 索引构建速度较慢 (>500ms)，可能有优化空间。`);
  }
  
  if (verifyTimeMs < 50) {
      console.log(`✨ 验证速度极快 (<50ms)，不会阻塞分析流程。`);
  } else {
      console.log(`⚠️ 验证速度: ${verifyTimeMs.toFixed(3)}ms`);
  }
}

runPerformanceTest().catch(err => {
  console.error(err);
  process.exit(1);
});
