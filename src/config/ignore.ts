
/**
 * Default ignore patterns for file scanning and git analysis
 */
export const DEFAULT_IGNORES = [
  '.git',
  '.gitignore',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '**/*.pyc',
  '__pycache__',
  '.DS_Store',
  '.next',
  '.nuxt',
  '.venv',
  '*.iml',
  '.idea',
  'target',
  '*.log',
  'venv',
  // Documentation files
  '**/*.md',
  '**/*.mdx',
  '**/*.txt',
  '**/*.rst'
];
