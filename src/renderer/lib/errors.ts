/**
 * ipcRenderer.invoke wraps errors thrown in main: "Error invoking remote method 'x': Error: <message>",
 * with the error's own name, such as HubError, where it has one. Strip that.
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '')
}
