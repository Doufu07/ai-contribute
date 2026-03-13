
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test files to run
const testFiles = [
  'test-verifier.ts',
  'test-performance.ts',
  'test-stress-memory.ts'
];

async function runScript(scriptName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log(`\n==================================================`);
    console.log(`🎬 Running: ${scriptName}`);
    console.log(`==================================================\n`);

    // Use tsx to run the TypeScript files directly
    const command = 'npx';
    const args = ['tsx', path.join(__dirname, scriptName)];

    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' } // Ensure stress test has memory
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`\n✅ ${scriptName} passed successfully.`);
        resolve();
      } else {
        console.error(`\n❌ ${scriptName} failed with exit code ${code}.`);
        // We reject but catch it in runAll to allow continuing
        reject(new Error(`${scriptName} failed`));
      }
    });

    child.on('error', (err) => {
      console.error(`\n❌ Failed to start ${scriptName}:`, err);
      reject(err);
    });
  });
}

async function runAll() {
  console.log('🚀 Starting Core Algorithm Test Suite...');
  
  const startTime = Date.now();
  let failedCount = 0;

  for (const file of testFiles) {
    try {
      await runScript(file);
    } catch (err) {
      failedCount++;
      // We continue running other tests even if one fails
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  
  console.log(`\n==================================================`);
  if (failedCount === 0) {
    console.log(`🎉 All tests passed in ${duration}s!`);
    process.exit(0);
  } else {
    console.error(`💥 ${failedCount} test(s) failed in ${duration}s.`);
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
