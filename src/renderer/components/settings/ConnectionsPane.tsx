import { useCallback, useEffect, useId, useState, type FormEvent, type ReactElement } from 'react'
import {
  checkForm,
  CONNECTION_NAME,
  EMPTY_FORM,
  type Auth,
  type ConnectionForm,
  type Transport,
} from '../../../shared/plugins/connection-plugin'
import type { ConnectionInfo, PluginInfo } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { BUTTON, FIELD, Row } from './Row'
import { Entry, ListHeading, PinnedEntry, PlusIcon, Split } from './Split'
import { shownEntry } from './summary'

// Settings > Connections: the MCP servers the app can reach, and adding one without writing code.
//
// A connection of the user's own is still a plugin of their own; the app writes the folder and the
// watcher picks it up. So this pane adds nothing to what the app trusts, and what it wrote can be
// read, edited by hand, or removed here.

const ADD = '+add'

const STATUS: Record<ConnectionInfo['status'], string> = {
  'needs-secret': 'Needs a key',
  'needs-auth': 'Needs authorization',
  'needs-sign-in': 'Needs sign-in',
  connecting: 'Connecting',
  ready: 'Ready',
  error: 'Error',
}
const ALERT: ConnectionInfo['status'][] = ['needs-secret', 'needs-auth', 'needs-sign-in', 'error']

export function ConnectionsPane(): ReactElement {
  const connections = useAppState((s) => s.connections)
  const plugins = useAppState((s) => s.plugins)
  const [open, setOpen] = useState<string | null>(null)
  const [ours, setOurs] = useState<Record<string, ConnectionForm>>({})

  const reload = useCallback((): void => {
    void window.app.connections
      .list()
      .then(setOurs)
      .catch(() => undefined)
  }, [])
  useEffect(reload, [reload])

  const all = Object.values(connections).sort((a, b) => a.id.localeCompare(b.id))
  const mine = all.filter((connection) => ours[pluginOf(connection.id)])
  const theirs = all.filter((connection) => !ours[pluginOf(connection.id)])
  const shown = shownEntry(open, [ADD, ...all.map((connection) => connection.id)])
  const current = shown.id === null || shown.id === ADD ? undefined : connections[shown.id]

  return (
    <Split
      label="Connections"
      shown={shown.id}
      picked={shown.picked}
      onBack={() => setOpen(null)}
      list={
        <>
          <PinnedEntry id={ADD} selected={shown.id === ADD} onSelect={() => setOpen(ADD)} icon={<PlusIcon />}>
            Add a connection
          </PinnedEntry>
          {all.length === 0 ? (
            <p className="px-4 py-2 text-sm text-muted-foreground">No connections yet.</p>
          ) : (
            <>
              {mine.length > 0 && <ListHeading>Yours</ListHeading>}
              <ul>
                {mine.map((connection) => (
                  <ConnectionEntry
                    key={connection.id}
                    connection={connection}
                    selected={shown.id === connection.id}
                    onSelect={() => setOpen(connection.id)}
                  />
                ))}
              </ul>
              {theirs.length > 0 && <ListHeading>From plugins</ListHeading>}
              <ul>
                {theirs.map((connection) => (
                  <ConnectionEntry
                    key={connection.id}
                    connection={connection}
                    selected={shown.id === connection.id}
                    onSelect={() => setOpen(connection.id)}
                  />
                ))}
              </ul>
            </>
          )}
        </>
      }
      detail={
        current ? (
          <ConnectionSection
            connection={current}
            form={ours[pluginOf(current.id)]}
            secrets={plugins[pluginOf(current.id)]?.secrets ?? []}
            onRemoved={() => {
              setOpen(null)
              reload()
            }}
          />
        ) : (
          <AddForm
            taken={Object.keys(plugins)}
            onAdded={(id) => {
              reload()
              setOpen(`${id}/${CONNECTION_NAME}`)
            }}
          />
        )
      }
    />
  )
}

function pluginOf(id: string): string {
  return id.slice(0, id.indexOf('/'))
}

function ConnectionEntry({
  connection,
  selected,
  onSelect,
}: {
  connection: ConnectionInfo
  selected: boolean
  onSelect: () => void
}): ReactElement {
  return (
    <Entry
      id={connection.id}
      selected={selected}
      onSelect={onSelect}
      title={connection.id}
      line={
        <>
          {connection.transport === 'http' ? 'HTTP' : 'stdio'} ·{' '}
          <span className={ALERT.includes(connection.status) ? 'text-destructive' : undefined}>
            {STATUS[connection.status]}
          </span>
          {connection.status === 'ready' &&
            `, ${connection.tools.length} tool${connection.tools.length === 1 ? '' : 's'}`}
        </>
      }
    />
  )
}

/** One connection: what it is, what it needs, and away with it when this pane wrote it. */
interface SectionProps {
  connection: ConnectionInfo
  form?: ConnectionForm
  secrets: PluginInfo['secrets']
  onRemoved: () => void
}

function ConnectionSection({ connection, form, secrets, onRemoved }: SectionProps): ReactElement {
  const [failed, setFailed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const plugin = pluginOf(connection.id)

  function act(action: Parameters<typeof dispatch>[0]): void {
    setFailed(null)
    dispatch(action).catch((error: unknown) => setFailed(errorMessage(error)))
  }

  function remove(): void {
    setConfirming(false)
    window.app.connections
      .remove(plugin)
      .then(onRemoved)
      .catch((error: unknown) => setFailed(errorMessage(error)))
  }

  return (
    <section aria-label={`Connection ${connection.id}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 pr-8">
        <h3 className="text-base font-semibold">{connection.id}</h3>
        <span className={`text-sm ${ALERT.includes(connection.status) ? 'text-destructive' : 'text-muted-foreground'}`}>
          {STATUS[connection.status]}
        </span>
      </div>
      {connection.error && <p className="mt-1 text-sm break-words text-destructive">{connection.error}</p>}
      {failed && <p className="mt-1 text-sm break-words text-destructive">{failed}</p>}

      <div className="mt-3 border-t border-border">
        <Row label="Transport" hint={form ? 'Added here, in this pane' : `Declared by the ${plugin} plugin`}>
          <span className="text-right font-mono text-xs break-all text-muted-foreground">
            {form
              ? form.transport === 'http'
                ? form.url
                : form.command
              : connection.transport === 'http'
                ? 'Streamable HTTP'
                : 'stdio'}
          </span>
        </Row>
        <Row label="Tools" hint={connection.status === 'ready' ? 'What the server offers' : 'Once it is connected'}>
          <span className="text-right font-mono text-xs break-words text-muted-foreground">
            {connection.tools.map((tool) => tool.name).join(', ') || 'none'}
          </span>
        </Row>
        {secrets
          .filter((secret) => connection.missing.includes(secret.key) || secret.set)
          .map((secret) => (
            <SecretRow key={secret.key} plugin={plugin} secret={secret} onFail={setFailed} />
          ))}
        <Row label="Connection" hint="What it is doing now">
          <div className="flex justify-end gap-2">
            {connection.status === 'needs-auth' && (
              <button
                type="button"
                onClick={() => act({ type: 'connection.authorize', id: connection.id })}
                className={BUTTON}
              >
                Authorize
              </button>
            )}
            {connection.status === 'needs-sign-in' && (
              <button type="button" onClick={() => act({ type: 'jaspers.signIn' })} className={BUTTON}>
                Sign in with Jaspers
              </button>
            )}
            <button
              type="button"
              onClick={() => act({ type: 'connection.reconnect', id: connection.id })}
              className={BUTTON}
            >
              Reconnect
            </button>
          </div>
        </Row>
        {form && (
          <Row label="Remove" hint={`Moves the ${plugin} folder to the trash`}>
            {confirming ? (
              <>
                <p className="text-sm">Remove {plugin}? Its key is deleted with it.</p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirming(false)} className={BUTTON}>
                    Keep
                  </button>
                  <button type="button" onClick={remove} className={`${BUTTON} text-destructive`}>
                    Remove
                  </button>
                </div>
              </>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className={`${BUTTON} self-end`}>
                Remove
              </button>
            )}
          </Row>
        )}
      </div>
    </section>
  )
}

/**
 * The key the connection needs, asked for where the connection is. It goes straight to main, is
 * sealed there, and every connection of the plugin that refers to it reconnects; all this ever
 * learns is that it is set.
 */
function SecretRow({
  plugin,
  secret,
  onFail,
}: {
  plugin: string
  secret: PluginInfo['secrets'][number]
  onFail: (message: string | null) => void
}): ReactElement {
  const [value, setValue] = useState('')
  const field = useId()

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!value) return
    onFail(null)
    // Cleared first: nothing holds the value once it is on its way to main.
    const sending = value
    setValue('')
    dispatch({ type: 'plugin.setSecret', plugin, key: secret.key, value: sending }).catch((error: unknown) =>
      onFail(errorMessage(error)),
    )
  }

  return (
    <Row
      label={secret.label}
      htmlFor={field}
      hint={secret.set ? 'Saved in the OS keychain' : 'Sealed in the OS keychain when saved'}
    >
      <form onSubmit={save} className="flex gap-2">
        <input
          id={field}
          name={secret.key}
          type="password"
          value={value}
          autoComplete="off"
          placeholder={secret.set ? 'Paste to replace' : 'Paste the key'}
          onChange={(event) => setValue(event.target.value)}
          className={`${FIELD} min-w-0 flex-1 font-mono`}
        />
        <button type="submit" className={BUTTON}>
          Save
        </button>
      </form>
    </Row>
  )
}

/** The form that writes a plugin. What it refuses, it refuses before anything is written. */
function AddForm({ taken, onAdded }: { taken: string[]; onAdded: (id: string) => void }): ReactElement {
  const [form, setForm] = useState<ConnectionForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)
  const field = useId()
  const set = <K extends keyof ConnectionForm>(key: K, value: ConnectionForm[K]): void =>
    setForm((previous) => ({ ...previous, [key]: value }))
  const refusal = checkForm(form, taken)

  function submit(event: FormEvent): void {
    event.preventDefault()
    setTouched(true)
    if (refusal) return
    setBusy(true)
    setFailed(null)
    window.app.connections
      .add(form)
      .then((id) => {
        setForm(EMPTY_FORM)
        setTouched(false)
        onAdded(id)
      })
      .catch((error: unknown) => setFailed(errorMessage(error)))
      .finally(() => setBusy(false))
  }

  return (
    <form onSubmit={submit} aria-label="Add a connection">
      <div className="pr-8">
        <h3 className="text-base font-semibold">Add a connection</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          An MCP server, reached over HTTP or run on this machine. The app writes it as a plugin folder of your own,
          which you can read and edit afterwards; its tools go to the assistant, and its data to any view.
        </p>
      </div>

      <div className="mt-5 border-t border-border">
        <Row label="Name" htmlFor={`${field}-id`} hint="The folder it is written to, and how it reads: name/server">
          <input
            id={`${field}-id`}
            name="connection-id"
            value={form.id}
            placeholder="polygon"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => set('id', event.target.value)}
            className={`${FIELD} font-mono`}
          />
        </Row>
        <Row label="Reached by" hint="Over the network, or a program run here">
          <div className="flex justify-end gap-2">
            {(['http', 'stdio'] as Transport[]).map((transport) => (
              <button
                key={transport}
                type="button"
                aria-pressed={form.transport === transport}
                onClick={() => set('transport', transport)}
                className={`${BUTTON} ${form.transport === transport ? 'bg-muted' : ''}`}
              >
                {transport === 'http' ? 'A URL' : 'A command'}
              </button>
            ))}
          </div>
        </Row>
        {form.transport === 'http' ? (
          <Row label="URL" htmlFor={`${field}-url`} hint="The server's streamable HTTP endpoint">
            <input
              id={`${field}-url`}
              name="connection-url"
              value={form.url}
              placeholder="https://mcp.example.com/mcp"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set('url', event.target.value)}
              className={`${FIELD} font-mono`}
            />
          </Row>
        ) : (
          <Row label="Command" htmlFor={`${field}-command`} hint="Run from your own PATH. Quote a path that has spaces">
            <input
              id={`${field}-command`}
              name="connection-command"
              value={form.command}
              placeholder="uvx some-mcp-server"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set('command', event.target.value)}
              className={`${FIELD} font-mono`}
            />
          </Row>
        )}
        <Row label="Sign in with" hint="How the server knows you">
          <div className="flex flex-wrap justify-end gap-2">
            {(['none', 'bearer', 'oauth'] as Auth[]).map((auth) => (
              <button
                key={auth}
                type="button"
                disabled={auth === 'oauth' && form.transport === 'stdio'}
                aria-pressed={form.auth === auth}
                onClick={() => set('auth', auth)}
                className={`${BUTTON} ${form.auth === auth ? 'bg-muted' : ''}`}
              >
                {auth === 'none' ? 'Nothing' : auth === 'bearer' ? 'A key' : 'The browser'}
              </button>
            ))}
          </div>
        </Row>
        {form.auth === 'bearer' && (
          <>
            <Row
              label="The key is called"
              htmlFor={`${field}-label`}
              hint="What the field asking for it says. Paste the key itself under Plugins"
            >
              <input
                id={`${field}-label`}
                name="connection-key-label"
                value={form.keyLabel}
                placeholder="Polygon API key"
                autoComplete="off"
                onChange={(event) => set('keyLabel', event.target.value)}
                className={FIELD}
              />
            </Row>
            {form.transport === 'stdio' && (
              <Row
                label="Passed as"
                htmlFor={`${field}-env`}
                hint="The environment variable the server reads it from. Never the command line, which every program can read"
              >
                <input
                  id={`${field}-env`}
                  name="connection-env"
                  value={form.envName}
                  placeholder="API_KEY"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(event) => set('envName', event.target.value.toUpperCase())}
                  className={`${FIELD} font-mono`}
                />
              </Row>
            )}
          </>
        )}
        <Row
          label=""
          hint={form.auth === 'oauth' ? 'Authorize it once it is added, from its own page here' : undefined}
        >
          <div className="flex items-center justify-end gap-3">
            <button type="submit" disabled={busy} className={BUTTON}>
              {busy ? 'Adding…' : 'Add'}
            </button>
          </div>
          {failed ? (
            <p className="text-xs break-words text-destructive">{failed}</p>
          ) : touched && refusal ? (
            <p className="text-xs text-destructive">{refusal}</p>
          ) : null}
        </Row>
      </div>
    </form>
  )
}
