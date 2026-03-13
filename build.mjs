import * as esbuild from 'esbuild'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Clean dist directory
const distDir = path.join(__dirname, 'dist')
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true })
}
fs.mkdirSync(distDir, { recursive: true })

// Read package.json for version info
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))

await esbuild.build({
  entryPoints: ['src/cli.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist/cli.js',
  define: {
    'packageJson.version': JSON.stringify(packageJson.version)
  },
  external: [
    // Native modules that shouldn't be bundled
    'sqlite3',
  ],
})

// Add shebang to the output file
const cliPath = path.join(__dirname, 'dist/cli.js')
let content = fs.readFileSync(cliPath, 'utf8')
content = '#!/usr/bin/env node\n' + content
fs.writeFileSync(cliPath, content)

console.log('Build complete: dist/cli.js')
