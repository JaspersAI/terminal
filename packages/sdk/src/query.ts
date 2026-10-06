// What a read of the store answers with. The store itself is the app's; this is only the shape that
// comes back, so a view can be typed against it.

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  /** Set when there was more than the answer could carry. */
  truncated: boolean
}
