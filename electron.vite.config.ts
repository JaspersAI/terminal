import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defaultClientConditions, defaultServerConditions } from 'vite'

// The SDK is the workspace package @jaspers-ai/sdk. Its exports point `jaspers-source` at its
// TypeScript, so the app bundles the SDK from source; a published copy is read from its dist/.
// electron-vite builds main and preload as SSR bundles, which read `ssr.resolve`.
const SOURCE = 'jaspers-source'
const serverConditions = { resolve: { conditions: [SOURCE, ...defaultServerConditions] } }

export default defineConfig({
  // externalizeDepsPlugin leaves everything in `dependencies` to be required from node_modules at
  // run time: the MCP SDK spawns child processes and zod is shared with the renderer's schemas,
  // and neither survives being flattened into one Rollup bundle.
  // Main has three entries: the app's main process, the host a plugin's backend runs in, and the
  // store, each forked by main from out/main/<name>.js.
  main: {
    plugins: [externalizeDepsPlugin()],
    ssr: serverConditions,
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'plugin-host': resolve('src/plugin-host/index.ts'),
          store: resolve('src/store/index.ts'),
        },
      },
    },
  },
  // The key must exist or electron-vite skips building it.
  preload: { plugins: [externalizeDepsPlugin()], ssr: serverConditions },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { conditions: [SOURCE, ...defaultClientConditions] },
    // Every asset as a file, none inlined. The renderer's policy is `default-src 'self'` with no
    // `img-src`, so a data: URI, which is what Vite inlines a small file as, is refused: a provider
    // logo under 4 KB would draw as a broken image. Files cost a request each from the app itself.
    build: { assetsInlineLimit: 0 },
  },
})
