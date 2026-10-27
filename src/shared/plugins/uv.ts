// uv and uvx ship with the app, so a plugin connection that runs either runs the app's own: a Python
// server then works on a computer that never installed uv or Python, since uv fetches the Python a
// script asks for itself. What is shipped is in scripts/fetch-uv.mjs; where it is, src/main/plugins/uv.ts.

/** The app's own file for a connection's command when the command is uv or uvx; null for any other. */
export function uvFile(command: string, platform: string): string | null {
  if (command !== 'uv' && command !== 'uvx') return null
  return platform === 'win32' ? `${command}.exe` : command
}
