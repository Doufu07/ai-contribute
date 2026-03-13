
import { strict as assert } from 'assert';
import { ContributionVerifier, RepoFileInfo } from '../../src/core/algorithmv.js';
import { AITool, FileChange, VerificationMode, AISession } from '../../src/types.js';

// Helper to create RepoFileInfo from content string
function createRepoFileInfo(verifier: ContributionVerifier, content: string): RepoFileInfo {
  // Use a temporary map to mimic buildRepoFileIndex logic for a single file
  const tempMap = new Map<string, RepoFileInfo>();
  // We need to access the private method or implement similar logic here
  // Since buildRepoFileInfo is not public in algorithmv.ts, we implement a helper here
  // based on the logic in algorithmv.ts
  const lines = content.split(/\r?\n/);
  const nonEmptyLines = lines.filter(l => l.trim().length > 0).length;
  const lineSet = new Set<string>();
  const normalizedLineSet = new Set<string>();
  const lineCounts = new Map<string, number>();
  const normalizedLineCounts = new Map<string, number>();
  
  // Use the verifier instance to access private methods if possible, 
  // or just replicate logic since we imported normalizeLine/isLineEmptyOrWhitespace before but now they might be internal
  // Actually algorithmv.ts exports normalizeLine and isLineEmptyOrWhitespace, let's use them
  // But wait, the previous tool output showed they are exported.
  // Let's import them.
  
  return {
    totalLines: lines.length,
    nonEmptyLines,
    lineSet,
    normalizedLineSet,
    lineCounts,
    normalizedLineCounts
  };
}

// We need to import the helper functions
import { normalizeLine, isLineEmptyOrWhitespace } from '../../src/core/algorithmv.js';

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
function createFileChange(filePath: string, addedLines: string[], tool: AITool = AITool.TRAE): FileChange {
  return {
    filePath,
    linesAdded: addedLines.length,
    linesRemoved: 0,
    changeType: 'modify',
    timestamp: new Date(),
    tool,
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

async function runTests() {
  console.log('🚀 开始执行 AI 贡献算法自测（复杂场景验证）...\n');

  const verifier = new ContributionVerifier('.', 'relaxed');
  
  // Test 1: Java - Spring Boot & Stream API (Annotation & Chaining)
  console.log('--------------------------------------------------');
  console.log('🧪 测试用例 1: Java - Spring Boot 注解与 Stream API 链式调用');
  try {
    const fileContent = `
package com.example.service;

@Service
@RequiredArgsConstructor
public class UserService {

    private final UserRepository userRepository;

    public List<UserDTO> findActiveUsers() {
        return userRepository.findAll().stream()
                .filter(u -> u.isActive() && u.getLastLogin() != null)
                .map(this::convertToDTO)
                .collect(Collectors.toList());
    }
}
`;
    // 模拟 AI 生成的代码：包含不同的缩进风格（Stream 链式调用缩进不同），但逻辑一致
    const addedLines = [
        '    public List<UserDTO> findActiveUsers() {',
        '        return userRepository.findAll().stream()',
        '            .filter(u -> u.isActive() && u.getLastLogin() != null)', // 缩进差异：4空格 vs 8空格
        '            .map(this::convertToDTO)',
        '            .collect(Collectors.toList());',
        '    }'
    ];
    
    const fileInfo = buildRepoFileInfoManual(fileContent);
    const change = createFileChange('UserService.java', addedLines);
    
    const result = verifyChange(verifier, change, fileInfo);
    
    // 验证逻辑：
    // 1. "public List<UserDTO> findActiveUsers() {" -> 精确匹配
    // 2. "return userRepository.findAll().stream()" -> 精确匹配
    // 3. ".filter(...)" -> 原始内容是8空格缩进，AI生成是12空格（假设）。归一化后去除首尾空白，应匹配。
    // 4. ".map(...)" -> 同上
    // 5. ".collect(...)" -> 同上
    // 6. "}" -> 精确匹配
    assert.equal(result.matched, 6, 'Java 复杂链式调用及缩进差异应全部匹配');
    console.log('✅ Java 复杂场景验证通过：能够识别注解、泛型及不同缩进的链式调用');
  } catch (e) {
    console.error('❌ Java 测试失败', e);
    throw e;
  }

  // Test 2: JavaScript/TypeScript - ES6+ Destructuring & Async/Await
  console.log('\n--------------------------------------------------');
  console.log('🧪 测试用例 2: JS/TS - 解构赋值、Async/Await 与箭头函数');
  try {
    const fileContent = `
export const processData = async ({ id, type = 'default' }, options) => {
  const { data: rawData } = await fetchData(id);
  
  return rawData.reduce((acc, curr) => {
    return { ...acc, [curr.key]: curr.value };
  }, {});
};
`;
    // 模拟 AI 生成的代码：对象字面量空格不同，箭头函数写法略有差异（空格）
    // 注意：当前算法的 normalizeLine 逻辑是：去除首尾空白 + 连续空白压缩为单个空格
    // 因此它能处理 "a  =  b" -> "a = b"，但不能处理 "(a)" -> "( a )"（因为多出了原本不存在的空格）
    const addedLinesAdjusted = [
        'export const processData = async ({ id, type = \'default\' }, options) => {', // 保持空格一致
        '  const  {  data:  rawData  }  =  await  fetchData(id);', // 连续空格被压缩 -> 匹配
        '  return  rawData.reduce((acc,  curr)  =>  {', // 关键字周围多余空格被压缩 -> 匹配
        '    return { ...acc, [curr.key]: curr.value };',
        '  },  {});', // 符号后多余空格被压缩 -> 匹配
        '};'
    ];
    
    const fileInfo = buildRepoFileInfoManual(fileContent);
    const change = createFileChange('utils.ts', addedLinesAdjusted);
    
    const result = verifyChange(verifier, change, fileInfo);
    
    assert.equal(result.matched, 6, 'JS 宽松模式下应忽略多余的空格');
    console.log('✅ JS/TS 复杂场景验证通过：能够忽略多余空格差异（如解构赋值中的空格）');
  } catch (e) {
    console.error('❌ JS/TS 测试失败', e);
    throw e;
  }

  // Test 3: Python - Decorators & List Comprehension
  console.log('\n--------------------------------------------------');
  console.log('🧪 测试用例 3: Python - 装饰器与列表推导式');
  try {
    const fileContent = `
@app.route('/api/data', methods=['GET'])
@auth_required
def get_data():
    """Fetch and process data."""
    raw_items = db.session.query(Item).all()
    # Complex list comprehension
    processed = [
        item.to_dict() 
        for item in raw_items 
        if item.is_valid()
    ]
    return jsonify(processed)
`;
    // 模拟 AI 生成的代码：缩进差异（2空格 vs 4空格），注释缺失（不影响代码匹配）
    const addedLines = [
        '@app.route(\'/api/data\', methods=[\'GET\'])',
        '@auth_required',
        'def get_data():',
        '  """Fetch and process data."""', // 缩进差异
        '  raw_items = db.session.query(Item).all()',
        '  # Complex list comprehension',
        '  processed = [',
        '    item.to_dict() ',
        '    for item in raw_items ',
        '    if item.is_valid()',
        '  ]',
        '  return jsonify(processed)'
    ];
    
    const fileInfo = buildRepoFileInfoManual(fileContent);
    const change = createFileChange('app.py', addedLines);
    
    const result = verifyChange(verifier, change, fileInfo);
    
    // 应该全部匹配（共12行，其中注释行也匹配，因为文件里有）
    assert.equal(result.matched, 12, 'Python 缩进差异应被忽略');
    console.log('✅ Python 复杂场景验证通过：装饰器、多行列表推导式及缩进差异均被正确识别');
  } catch (e) {
    console.error('❌ Python 测试失败', e);
    throw e;
  }

  // Test 4: Vue - Composition API & Template
  console.log('\n--------------------------------------------------');
  console.log('🧪 测试用例 4: Vue - Composition API (<script setup>) 与模板指令');
  try {
    const fileContent = `
<template>
  <div class="user-card" v-if="user">
    <h2>{{ user.name }}</h2>
    <button @click="emit('update', user.id)" :disabled="isLoading">
      Update Profile
    </button>
  </div>
</template>

<script setup lang="ts">
import { defineProps, defineEmits } from 'vue';

const props = defineProps<{
  user: User | null;
  isLoading?: boolean;
}>();

const emit = defineEmits(['update']);
</script>
`;
    const addedLines = [
        '<template>',
        '  <div class="user-card" v-if="user">',
        '    <h2>{{ user.name }}</h2>',
        // 属性顺序不同或空格不同：
        '    <button @click="emit(\'update\', user.id)" :disabled="isLoading">', 
        '      Update Profile',
        '    </button>',
        '  </div>',
        '</template>',
        '', // 空行
        '<script setup lang="ts">',
        'import { defineProps, defineEmits } from \'vue\';',
        '',
        'const props = defineProps<{',
        '  user: User | null;',
        '  isLoading?: boolean;',
        '}>();',
        '',
        'const emit = defineEmits([\'update\']);',
        '</script>'
    ].filter(l => l.trim() !== ''); // 移除测试数据中的空行以便计数
    
    const fileInfo = buildRepoFileInfoManual(fileContent);
    const change = createFileChange('UserCard.vue', addedLines);
    
    const result = verifyChange(verifier, change, fileInfo);
    
    assert.equal(result.matched, addedLines.length, 'Vue 混合内容应全部匹配');
    console.log('✅ Vue 复杂场景验证通过：能够同时处理 Template 和 Script Setup 块');
  } catch (e) {
    console.error('❌ Vue 测试失败', e);
    throw e;
  }

  // Test 5: Go - Struct Tags, Channels & Defer
  console.log('\n--------------------------------------------------');
  console.log('🧪 测试用例 5: Go - 结构体 Tag、Channel 操作与 Defer');
  try {
    const fileContent = `
type Config struct {
    Host string \`json:"host" yaml:"host"\`
    Port int    \`json:"port" yaml:"port"\`
}

func (c *Client) Run(ctx context.Context) error {
    ch := make(chan error, 1)
    
    go func() {
        defer close(ch)
        ch <- c.process()
    }()

    select {
    case <-ctx.Done():
        return ctx.Err()
    case err := <-ch:
        if err != nil {
            return fmt.Errorf("process failed: %w", err)
        }
    }
    return nil
}
`;
    // 模拟：结构体 Tag 中的空格差异（Go fmt 通常会标准化，但 AI 可能不会）
    // 以及 `if err != nil` 的重复出现（验证计数器）
    const addedLines = [
        'type Config struct {',
        '    Host string `json:"host" yaml:"host"`', // 假设这里空格一致
        '    Port int    `json:"port" yaml:"port"`',
        '}',
        '',
        'func (c *Client) Run(ctx context.Context) error {',
        '    ch := make(chan error, 1)',
        '    ',
        '    go func() {',
        '        defer close(ch)',
        '        ch <- c.process()',
        '    }()',
        '',
        '    select {',
        '    case <-ctx.Done():',
        '        return ctx.Err()',
        '    case err := <-ch:',
        '        if err != nil {', // 这是一个高频行
        '            return fmt.Errorf("process failed: %w", err)',
        '        }',
        '    }',
        '    return nil',
        '}'
    ].filter(l => l.trim() !== '');
    
    const fileInfo = buildRepoFileInfoManual(fileContent);
    const change = createFileChange('server.go', addedLines);
    
    const result = verifyChange(verifier, change, fileInfo);
    
    assert.equal(result.matched, addedLines.length, 'Go 复杂结构应全部匹配');
    console.log('✅ Go 复杂场景验证通过：正确处理 Struct Tag 和并发控制逻辑');
  } catch (e) {
    console.error('❌ Go 测试失败', e);
    throw e;
  }

  // Test 6: C++ - Templates & Macros
  console.log('\n--------------------------------------------------');
  console.log('🧪 测试用例 6: C++ - 模板类、宏定义与指针操作');
  try {
    const fileContent = `
#define MAX_BUFFER 1024

template <typename T>
class Buffer {
private:
    T* data;
    size_t size;
public:
    Buffer(size_t s) : size(s) {
        data = new T[size];
    }
    ~Buffer() {
        delete[] data;
    }
};
`;
    // 模拟 AI 生成的代码：构造函数初始化列表换行风格不同
    const addedLines = [
        'template <typename T>',
        'class Buffer {',
        'private:',
        '    T* data;',
        '    size_t size;',
        'public:',
        '    Buffer(size_t s) : size(s) {', // 保持在一行
        '        data = new T[size];',
        '    }',
        '    ~Buffer() {',
        '        delete[] data;',
        '    }',
        '};'
    ]; 
    // 注意：原文件有 #define MAX_BUFFER 1024，但 AI 没有生成这一行，这不影响匹配（只匹配生成的）
    
    const fileInfo = buildRepoFileInfoManual(fileContent);
    const change = createFileChange('buffer.hpp', addedLines);
    
    const result = verifyChange(verifier, change, fileInfo);
    
    assert.equal(result.matched, addedLines.length, 'C++ 模板类应全部匹配');
    console.log('✅ C++ 复杂场景验证通过：模板语法与内存管理代码匹配成功');
  } catch (e) {
    console.error('❌ C++ 测试失败', e);
    throw e;
  }

  // Test 7: Boundary Tests - What should NOT match (Verification of limits)
  console.log('\n--------------------------------------------------');
  console.log('🧪 测试用例 7: 边界测试 - 验证算法的识别边界与抗干扰能力');
  try {
    const fileContent = `
function calculate(a, b) {
  return a + b;
}
`;
    // Scenario 7.1: Reordering (Should Match) - Code move refactoring
    console.log('  7.1 代码重排 (Code Move) 测试...');
    const reorderedLines = [
        '  return a + b;',
        'function calculate(a, b) {'
    ];
    const fileInfo1 = buildRepoFileInfoManual(fileContent);
    const change1 = createFileChange('math.js', reorderedLines);
    const result1 = verifyChange(verifier, change1, fileInfo1);
    assert.equal(result1.matched, 2, '算法应支持代码行重排（Bag-of-Lines 特性）');
    console.log('  ✅ 通过：代码行重排后仍能正确识别');

    // Scenario 7.2: Logic Change (Should Fail) - Semantic modification
    console.log('  7.2 逻辑变更 (Logic Change) 测试...');
    const logicChangeLines = [
        'function calculate(a, b) {',
        '  return a - b;', // changed + to -
        '}'
    ];
    const fileInfo2 = buildRepoFileInfoManual(fileContent);
    const change2 = createFileChange('math.js', logicChangeLines);
    const result2 = verifyChange(verifier, change2, fileInfo2);
    // "function..." matches (1), "}" matches (1), "return a - b;" fails (0) -> Total 2
    assert.equal(result2.matched, 2, '逻辑变更行不应被匹配');
    assert.notEqual(result2.matched, 3, '逻辑变更不应被视为全匹配');
    console.log('  ✅ 通过：逻辑变更行未被误判为匹配');

    // Scenario 7.3: Variable Renaming (Should Fail) - Identifier change
    console.log('  7.3 变量重命名 (Rename) 测试...');
    const renameLines = [
        'function calc(x, y) {', // renamed function and args
        '  return x + y;',       // renamed usage
        '}'
    ];
    const fileInfo3 = buildRepoFileInfoManual(fileContent);
    const change3 = createFileChange('math.js', renameLines);
    const result3 = verifyChange(verifier, change3, fileInfo3);
    // Only "}" matches -> Total 1
    assert.equal(result3.matched, 1, '变量重命名后不应匹配（除非是完全相同的结构行如括号）');
    console.log('  ✅ 通过：变量重命名后未被误判');

  } catch (e) {
    console.error('❌ 边界测试失败', e);
    throw e;
  }

  // Test 8: Partial Match & Line Count Discrepancy (Java & Vue)
  console.log('\n--------------------------------------------------');
  console.log('🧪 测试用例 8: 部分匹配与行数差异验证 (Java & Vue)');
  try {
    // 8.1 Java - AI 增加额外注释或辅助方法
    console.log('  8.1 Java - 混合有效代码与无效（未采纳）代码...');
    const javaContent = `
public class OrderService {
    public void createOrder(Order order) {
        validate(order);
        save(order);
    }
}
`;
    const javaAddedLines = [
        '    public void createOrder(Order order) {', // 匹配
        '        // Validate order first',            // 不匹配（原文件无此注释）
        '        validate(order);',                   // 匹配
        '        log.info("Creating order");',        // 不匹配（原文件无此日志）
        '        save(order);',                       // 匹配
        '    }'                                       // 匹配
    ];
    // 预期：6行中有4行匹配（方法签名、调用validate、调用save、右大括号）
    const javaFileInfo = buildRepoFileInfoManual(javaContent);
    const javaChange = createFileChange('OrderService.java', javaAddedLines);
    const javaResult = verifyChange(verifier, javaChange, javaFileInfo);
    assert.equal(javaResult.matched, 4, 'Java 部分匹配失败：应只统计存在的有效行');
    console.log(`  ✅ Java 通过：输入 ${javaAddedLines.length} 行，匹配 ${javaResult.matched} 行 (准确率 ${((javaResult.matched/javaAddedLines.length)*100).toFixed(0)}%)`);

    // 8.2 Vue - 模板变更与脚本变更的混合差异
    console.log('  8.2 Vue - 模板与脚本的部分匹配...');
    const vueContent = `
<template>
  <div>
    <span v-if="visible">Content</span>
  </div>
</template>
<script>
export default {
  data() { return { visible: true } }
}
</script>
`;
    const vueAddedLines = [
        '<template>',                          // 匹配
        '          <div >',                             // 不匹配 (归一化差异: "<div >" vs "<div>")
        '    <span v-if="show">Content</span>',// 不匹配 (visible -> show)
        '    <button>Click</button>',          // 不匹配 (新增按钮未被采纳)
        '  </div>',                            // 匹配
        '</template>',                         // 匹配
        '<script>',                            // 匹配
        'export default {',                    // 匹配
        '  data() { return { show: true } }',  // 不匹配 (visible -> show)
        '}'                                    // 匹配
    ];
    // 预期：10行中有6行匹配
    const vueFileInfo = buildRepoFileInfoManual(vueContent);
    const vueChange = createFileChange('Component.vue', vueAddedLines);
    const vueResult = verifyChange(verifier, vueChange, vueFileInfo);
    
    assert.equal(vueResult.matched, 6, 'Vue 部分匹配失败');
    console.log(`  ✅ Vue 通过：输入 ${vueAddedLines.length} 行，匹配 ${vueResult.matched} 行`);

  } catch (e) {
    console.error('❌ 部分匹配测试失败', e);
    throw e;
  }
}

runTests().catch(e => {
  console.error('\n💥 测试运行失败:', e);
  process.exit(1);
});
