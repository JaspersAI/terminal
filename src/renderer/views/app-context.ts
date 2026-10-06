// The app's theme under the names a server's page reads. The MCP Apps extension fixes a list of CSS
// variables a host may hand a page, so one page looks at home in every host; this is the app's own
// (`src/host-runtime/theme.css`) written under those. A name the app has no value for is left out,
// and the page keeps its own default for it. No DOM: the caller says how a variable is read.

/** The extension's name, then the app's variable that answers to it. */
const COLORS: [string, string][] = [
  ['--color-background-primary', '--jaspers-background'],
  ['--color-background-secondary', '--jaspers-muted'],
  ['--color-background-tertiary', '--jaspers-muted'],
  ['--color-background-inverse', '--jaspers-primary'],
  ['--color-text-primary', '--jaspers-foreground'],
  ['--color-text-secondary', '--jaspers-muted-foreground'],
  ['--color-text-tertiary', '--jaspers-muted-foreground'],
  ['--color-text-inverse', '--jaspers-primary-foreground'],
  ['--color-text-danger', '--jaspers-destructive'],
  ['--color-text-success', '--jaspers-positive'],
  ['--color-border-primary', '--jaspers-border'],
  ['--color-border-secondary', '--jaspers-border'],
  ['--color-border-tertiary', '--jaspers-border'],
  ['--color-border-inverse', '--jaspers-primary'],
  ['--color-border-danger', '--jaspers-destructive'],
  ['--color-border-success', '--jaspers-positive'],
  ['--color-ring-primary', '--jaspers-primary'],
  ['--color-ring-danger', '--jaspers-destructive'],
  ['--font-sans', '--jaspers-font-sans'],
  ['--font-mono', '--jaspers-font-mono'],
]

/** What holds whatever the theme: the app's corners are square and its lines one pixel. */
const FIXED: [string, string][] = [
  ...['xs', 'sm', 'md', 'lg', 'xl', 'full'].map((size): [string, string] => [`--border-radius-${size}`, '0px']),
  ['--border-width-regular', '1px'],
]

/** The variables a page is handed. `read` answers one of the app's own, or nothing. */
export function hostStyles(read: (name: string) => string): Record<string, string> {
  const styles: Record<string, string> = Object.fromEntries(FIXED)
  for (const [name, own] of COLORS) {
    const value = read(own).trim()
    if (value !== '') styles[name] = value
  }
  return styles
}
