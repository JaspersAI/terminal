import vm from 'node:vm'
import * as zod from 'zod'
import * as sdkDefine from '@jaspers-ai/sdk/define'
import * as sdkSkills from '@jaspers-ai/sdk/skills'
import { validatePluginDefinition, type ValidatedPlugin } from '../../shared/plugins/plugins.ts'

// A plugin's definitions, read by running its build. Main does it to register what the plugin
// defines; the plugin's host does it again to run what the plugin does. The sandbox is the new
// context's global object, so the require shim is the only way in and module, exports, and console
// are the only things out. It contains mistakes, not malice: a vm context can be escaped.

/** Long enough for a definitions file, short enough that a loop in one does not hang the process. */
const EVAL_TIMEOUT_MS = 2000

/**
 * The definitions, read by running them. The sandbox is the new context's global object, so the
 * `require` below is the only way in and `module`, `exports`, and `console` are the only things out.
 * Components are never called here: the React the shim hands out throws from every hook.
 */
export function evaluatePlugin(code: string, id: string): ValidatedPlugin {
  const wrapper = { exports: {} as Record<string, unknown> }
  const sandbox = {
    module: wrapper,
    exports: wrapper.exports,
    require: (name: string) => {
      const found = MODULES[name]
      if (found) return found
      throw new Error(`Plugins may import only react, zod, and @jaspers-ai/sdk; ${name} is not available`)
    },
    console,
    // The web platform's own pieces a backend needs, none of which reach a file or the network:
    // timers, cancellation, URLs, text encoding, cloning. fetch comes from the context, guarded.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
    AbortController,
    AbortSignal,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
  }
  vm.runInNewContext(code, sandbox, { timeout: EVAL_TIMEOUT_MS, filename: `${id}/plugin.tsx` })
  const exported = wrapper.exports['default'] ?? wrapper.exports
  return validatePluginDefinition(exported, id)
}

/** A hook reached here means a component was called outside a view, which is never on purpose. */
function stubHook(name: string): () => never {
  return () => {
    throw new Error(`${name} cannot run here; components render only in views`)
  }
}

const reactStub = {
  createElement: () => null,
  Fragment: Symbol.for('react.fragment'),
  createContext: () => ({}),
  forwardRef: (component: unknown) => component,
  memo: (component: unknown) => component,
  useState: stubHook('useState'),
  useEffect: stubHook('useEffect'),
  useMemo: stubHook('useMemo'),
  useRef: stubHook('useRef'),
  useCallback: stubHook('useCallback'),
  useContext: stubHook('useContext'),
  useSyncExternalStore: stubHook('useSyncExternalStore'),
  useReducer: stubHook('useReducer'),
  useLayoutEffect: stubHook('useLayoutEffect'),
  useId: stubHook('useId'),
}

/** The SDK as a process without views can offer it: the definition functions and the skills helpers for real, the hooks as stubs. */
const sdkForBackend = {
  ...sdkDefine,
  ...sdkSkills,
  BridgeProvider: () => null,
  PanelProvider: () => null,
  useBridge: stubHook('useBridge'),
  usePanel: stubHook('usePanel'),
  usePanelState: stubHook('usePanelState'),
  usePublish: stubHook('usePublish'),
  usePublishText: stubHook('usePublishText'),
  useData: stubHook('useData'),
}

/** The five names a plugin may import. zod is this process's own, so the schemas a plugin builds are ones it can run. */
const MODULES: Record<string, unknown> = {
  react: { ...reactStub, default: reactStub },
  'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: reactStub.Fragment },
  'react-dom': {},
  'react-dom/client': {},
  '@jaspers-ai/sdk': { ...sdkForBackend, default: sdkForBackend },
  zod: { ...zod, default: zod },
}
