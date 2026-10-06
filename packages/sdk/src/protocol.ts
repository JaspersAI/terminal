// What the two ends of an iframe view say to each other. The iframe asks, the host answers, and the
// host sends notifications nobody asked for. JSON only: the messages cross a postMessage boundary,
// so anything that does not survive structured cloning cannot be in them.

/** The bridge's methods, one per call a view can make. The same names the host bridge has. */
export type BridgeMethod =
  | 'store.get'
  | 'store.subscribe'
  | 'store.unsubscribe'
  | 'panel.setState'
  | 'panel.publish'
  | 'panel.publishText'
  | 'source.run'
  | 'dataset.rows'
  | 'link.open'
  | 'clipboard.write'

/** iframe → host. `id` comes back on the reply, and is what tells a reply from a notification. */
export interface BridgeRequest {
  id: number
  method: BridgeMethod
  params: unknown
}

/** host → iframe, for one request. One of `result` or `error`. */
export interface BridgeReply {
  id: number
  result?: unknown
  error?: { message: string }
}

/** host → iframe, unasked: a value the view is subscribed to, its size, or whether it is focused. */
export type BridgeNotification =
  | { method: 'store.changed'; params: { subId: number; value: unknown } }
  | { method: 'resize'; params: { width: number; height: number } }
  | { method: 'focus'; params: { focused: boolean } }
