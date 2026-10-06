import { evaluatePlugin } from '../main/plugins/plugin-eval'
import { createRpc } from '../shared/rpc'
import { createHost } from './host'

// A plugin's host: the utility process main forks for one plugin with code of its own to run. Main
// sends the build and calls into it over parentPort; whatever the plugin reaches beyond its own
// memory is a request back to main. Its console output is piped into main's log.

process.on('unhandledRejection', (reason) => {
  console.error('unhandled rejection:', reason instanceof Error ? reason.message : reason)
})

const port = process.parentPort

createHost(
  createRpc({
    postMessage: (message) => port.postMessage(message),
    onMessage: (listener) => {
      const handler = (event: Electron.MessageEvent): void => listener(event.data)
      port.on('message', handler)
      return () => port.off('message', handler)
    },
  }),
  { evaluate: evaluatePlugin, exit: (code) => process.exit(code) },
)
