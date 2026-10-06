// What the app itself needs from the SDK and a plugin does not: the messages an iframe view and the
// host exchange, and the view's side of that bridge. Imported as `@jaspers-ai/sdk/host`.

export * from './protocol'
export { createIframeBridge } from './iframe-bridge'
