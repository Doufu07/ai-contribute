
import { strict as assert } from 'assert';
import { ContributionVerifier, RepoFileInfo, normalizeLine, isLineEmptyOrWhitespace } from '../../src/core/algorithmv.js';
import { AITool, FileChange, AISession } from '../../src/types.js';

// Helper to format bytes to MB
function formatMB(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// Generate highly optimized string for massive scale
// We reuse string parts to minimize memory allocation overhead during generation
function generateMassiveContent(lineCount: number): string {
  const lineTemplate = 'const x = calculateValue(index, multiplier); // This is a standard line of code';
  const lines = [];
  
  for (let i = 0; i < lineCount; i++) {
    // 90% duplicate lines to simulate real-world repetition and save memory
    // 10% unique lines to force hash map entries
    if (i % 10 === 0) {
        lines.push(`// Unique line identifier ${i}`);
    } else {
        lines.push(lineTemplate);
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
function createFileChange(filePath: string, addedLines: string[]): FileChange {
  return {
    filePath,
    linesAdded: addedLines.length,
    linesRemoved: 0,
    changeType: 'modify',
    timestamp: new Date(),
    tool: AITool.TRAE,
    addedLines,
    content: addedLines.join('\n')
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

async function runStressTest() {
  // Test Case 1: 100行 (100 Lines) - Tiny
  // Test Case 2: 1000行 (1k Lines) - Small
  // Test Case 3: 5000行 (5k Lines) - Medium
  // Test Case 4: 1万行 (10k Lines) - Baseline
  
  const testCases = [100, 1000, 5000, 10000];

  console.log('🚀 开始执行极限压力测试 (Memory Stress Test)...');
  console.log('⚠️  注意: 1亿行单文件 (10000万) 会超出 V8 字符串长度限制，本次测试上限为 1000万行。');
  console.log('--------------------------------------------------');

  for (const LINE_COUNT of testCases) {
    console.log(`\n[测试规模: ${LINE_COUNT.toLocaleString()} 行]`);
    
    try {
      if (global.gc) global.gc();
      const initialMemory = process.memoryUsage();

      // 1. 生成数据
      const startGen = process.hrtime.bigint();
      const fileContent = generateMassiveContent(LINE_COUNT);
      const endGen = process.hrtime.bigint();
      const genTimeMs = Number(endGen - startGen) / 1e6;
      
      const contentSizeMB = Buffer.byteLength(fileContent, 'utf8') / 1024 / 1024;
      // console.log(`📝 内容生成耗时: ${genTimeMs.toFixed(0)} ms`);
      console.log(`📦 文本大小: ${contentSizeMB.toFixed(2)} MB`);

      // 2. 构建索引
      const verifier = new ContributionVerifier('.', 'relaxed');
      const startBuild = process.hrtime.bigint();
      const fileInfo = buildRepoFileInfoManual(fileContent);
      const endBuild = process.hrtime.bigint();
      const buildTimeMs = Number(endBuild - startBuild) / 1e6;

      console.log(`⏱️  索引构建耗时: ${buildTimeMs.toFixed(0)} ms`);
      console.log(`📊 统计信息: Unique Lines = ${fileInfo.lineSet.size.toLocaleString()}`);

      // 3. 验证变更 (模拟 1% 的变更量，上限 10000行)
      const changeSize = Math.min(10000, Math.floor(LINE_COUNT * 0.01));
      if (changeSize > 0) {
          // 从头部切分出一部分作为变更代码
          const addedLines = fileContent.substring(0, Math.min(fileContent.length, changeSize * 100)).split('\n').slice(0, changeSize);
          
          const change = createFileChange('StressTest.js', addedLines);
          
          const startVerify = process.hrtime.bigint();
          const result = verifyChange(verifier, change, fileInfo);
          const endVerify = process.hrtime.bigint();
          const verifyTimeMs = Number(endVerify - startVerify) / 1e6;
    
          console.log(`⚡ 验证耗时 (${changeSize} 行): ${verifyTimeMs.toFixed(3)} ms`);
      }

      // 4. 内存快照
      const finalMemory = process.memoryUsage();
      const heapUsedDiff = Number(finalMemory.heapUsed - initialMemory.heapUsed);
      
      console.log(`💾 内存增量 (Heap): ${formatMB(heapUsedDiff)}`);
      console.log(`💾 总堆内存占用:   ${formatMB(Number(finalMemory.heapUsed))}`);

    } catch (err: any) {
      console.error(`❌ 测试失败 (${LINE_COUNT} 行):`, err.message);
      if (err.message.includes('Invalid string length')) {
        console.error('   -> 达到 V8 引擎字符串长度限制 (通常约 512MB)');
      } else if (err.message.includes('heap out of memory')) {
        console.error('   -> 堆内存溢出');
      }
    }
    
    // 清理以释放内存给下一轮
    if (global.gc) global.gc();
  }
}

runStressTest().catch(err => {
  console.error(err);
  process.exit(1);
});
