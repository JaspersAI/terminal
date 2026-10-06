import type * as esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { inside } from './confine.ts'

// A plugin folder's two builds: ESM for the browser, which the view host loads into an iframe, and
// CJS for Node, which main and the plugin's host evaluate to learn what the plugin defines. No
// Electron here: where the browser bundle goes is handed in, so a test builds a folder the way the
// app does. A packaged app points esbuild at its unpacked binary (esbuild-path.ts) before the first
// build, which is why esbuild is loaded on that build rather than with this module.

let esbuildModule: Promise<typeof esbuild> | null = null
function loadEsbuild(): Promise<typeof esbuild> {
  esbuildModule ??= import('esbuild')
  return esbuildModule
}

/** Writes the browser bundle to `outfile` and answers the definitions bundle as text. */
export async function bundlePlugin(dir: string, outfile: string): Promise<string> {
  const esbuild = await loadEsbuild()
  const common: esbuild.BuildOptions = {
    entryPoints: [path.join(dir, 'plugin.tsx')],
    bundle: true,
    jsx: 'automatic',
    logLevel: 'silent',
    // What the host provides. Everything else the plugin imports is bundled into it.
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', '@jaspers-ai/sdk', 'zod'],
    absWorkingDir: dir,
    plugins: [confine(dir)],
  }
  await esbuild.build({
    ...common,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    outfile,
    sourcemap: 'inline',
    define: { 'process.env.NODE_ENV': '"development"' },
  })
  // The definitions run in a vm, in main and in the plugin's host, with no Node APIs: a dependency
  // resolves to its browser build (yaml's Node build requires process, its browser build does not).
  const definitions = await esbuild.build({
    ...common,
    format: 'cjs',
    platform: 'neutral',
    mainFields: ['browser', 'module', 'main'],
    write: false,
    outfile: 'definitions.cjs',
  })
  const code = definitions.outputFiles?.[0]?.text
  if (code === undefined) throw new Error('esbuild built plugin.tsx into nothing.')
  return code
}

/**
 * A plugin's code imports only its own files and the packages in its node_modules. esbuild would
 * otherwise follow `../../anything` and climb to a parent's node_modules, and a bundle is code a
 * model may have written: what it can read has to stop at the folder the user approved.
 */
function confine(dir: string): esbuild.Plugin {
  return {
    name: 'confine-to-plugin-folder',
    setup(build) {
      const root = realpath(dir)
      build.onResolve({ filter: /.*/ }, async (args) => {
        // Our own resolve below comes back through here; it is marked so it is let through.
        if (args.kind === 'entry-point' || (args.pluginData as { confined?: boolean } | undefined)?.confined)
          return null
        const result = await build.resolve(args.path, {
          resolveDir: args.resolveDir,
          importer: args.importer,
          kind: args.kind,
          pluginData: { confined: true },
        })
        if (result.errors.length > 0 || result.external || result.namespace !== 'file') return result
        if (!inside(root, realpath(result.path))) {
          return {
            errors: [
              {
                text: `${args.path} is outside the plugin's folder. A plugin imports only its own files and the packages installed in its node_modules.`,
              },
            ],
          }
        }
        return result
      })
    },
  }
}

function realpath(file: string): string {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}
