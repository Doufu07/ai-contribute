
/**
 * Default ignore patterns for file scanning and git analysis
 */
export const DEFAULT_IGNORES = [
  // Version control
  '.git',
  '.gitignore',

  // Node.js
  'node_modules',
  'dist',
  'build',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',

  // Testing & coverage
  'coverage',

  // Python
  '__pycache__',
  '*.pyc',
  '.venv',
  'venv',

  // IDE & editor
  '.idea',
  '*.iml',

  // Build outputs
  '.next',
  '.nuxt',
  'target',

  // OS files
  '.DS_Store',

  // Logs
  '*.log',

  // Documentation files
  '**/*.md',
  '**/*.mdx',
  '**/*.txt',
  '**/*.rst',

  // Dot files and directories (hidden files in Unix)
  '.*',
];
