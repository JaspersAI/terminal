import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import * as esbuild from 'esbuild'

// Builds the package for publishing: dist/ holds the four entries as ESM, sharing one chunk, and
// their type declarations. The app never reads this build; it bundles src/ through the
// jaspers-source condition.

const pkg = path.resolve(import.meta.dirname, '..')
const dist = path.join(pkg, 'dist')
const ENTRIES = ['index', 'define', 'skills', 'host']
// TypeScript 7 exports its package.json but not its bin, so the compiler is found beside it.
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'bin', 'tsc')

fs.rmSync(dist, { recursive: true, force: true })
await esbuild.build({
  entryPoints: ENTRIES.map((name) => path.join(pkg, 'src', `${name}.ts`)),
  outdir: dist,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  jsx: 'automatic',
  chunkNames: 'chunks/[name]-[hash]',
  external: ['react', 'react/jsx-runtime', 'react-dom', 'zod'],
})
execFileSync(
  process.execPath,
  [
    tsc,
    '--ignoreConfig',
    ...ENTRIES.map((name) => `src/${name}.ts`),
    '--declaration',
    '--emitDeclarationOnly',
    '--outDir',
    path.join(dist, 'types'),
    '--rootDir',
    'src',
    '--jsx',
    'react-jsx',
    '--module',
    'esnext',
    '--moduleResolution',
    'bundler',
    '--target',
    'es2022',
    '--strict',
    '--skipLibCheck',
    '--allowImportingTsExtensions',
    '--types',
    'node',
  ],
  { cwd: pkg, stdio: 'inherit' },
)
fs.copyFileSync(path.join(pkg, '..', '..', 'LICENSE'), path.join(pkg, 'LICENSE'))
console.log(`built ${path.relative(process.cwd(), dist)}`)
