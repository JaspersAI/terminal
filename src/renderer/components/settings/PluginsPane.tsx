import { useId, useState, type FormEvent, type ReactElement, type ReactNode } from 'react'
import type { Action, ConnectionInfo, PluginInfo } from '../../../shared/state'
import { errorMessage } from '../../lib/errors'
import { dispatch, useAppState } from '../../lib/state'
import { Directory } from './Directory'
import { HubItems, PublishToHub } from './HubPublish'
import { StatusLine } from './InstallPrompt'
import { useInstall, type Install } from './use-install'
import { BUTTON, FIELD, Row } from './Row'
import { Entry, ListHeading, PinnedEntry, PlusIcon, Split } from './Split'
import { pluginLine, shownEntry } from './summary'

/** The entry above the plugins. A plugin's id is a folder name, which never starts with +. */
const ADD = '+add'
/** The entry under the plugins for what the user published to Jaspers Hub. */
const HUB_ITEMS = '+hub'

/** Settings' Plugins pane: installing one, and every plugin main found a folder for, with its keys and the servers it reaches. */
export function PluginsPane(): ReactElement {
  const plugins = useAppState((s) => s.plugins)
  const connections = useAppState((s) => s.connections)
  return <PluginList plugins={plugins} connections={connections} installs />
}

interface ListProps {
  plugins: Record<string, PluginInfo>
  connections: Record<string, ConnectionInfo>
  /** Settings puts installing above the plugins; the core/plugins view leaves it out. */
  installs?: boolean
}

/**
 * The plugins by id, and the one picked beside them. Settings shows the list, and so does the
 * core/plugins view. The install under way is held here rather than in a section, since picking
 * another plugin unmounts the section that started it and the prompt still has to ask.
 */
export function PluginList({ plugins, connections, installs = false }: ListProps): ReactElement {
  const [open, setOpen] = useState<string | null>(null)
  const installer = useInstall()
  // Settings lists what the user published to Hub, which needs the sign-in to read.
  const hubItems = useAppState((s) => installs && s.jaspers.signedIn)
  const list = Object.values(plugins).sort((a, b) => a.id.localeCompare(b.id))
  if (!installs && list.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No plugins. Install one in Settings, or put a folder with plugin.tsx in ~/Jaspers/plugins.
      </p>
    )
  }

  const connectionsOf = (plugin: PluginInfo): ConnectionInfo[] =>
    plugin.connections.flatMap((id) => (connections[id] ? [connections[id]!] : []))
  const shown = shownEntry(open, [
    ...(installs ? [ADD] : []),
    ...list.map((plugin) => plugin.id),
    ...(hubItems ? [HUB_ITEMS] : []),
  ])
  const current = shown.id === null ? undefined : plugins[shown.id]

  return (
    <>
      <Split
        label="Plugins"
        shown={shown.id}
        picked={shown.picked}
        onBack={() => setOpen(null)}
        list={
          <>
            {installs && (
              <PinnedEntry id={ADD} selected={shown.id === ADD} onSelect={() => setOpen(ADD)} icon={<PlusIcon />}>
                Add a plugin
              </PinnedEntry>
            )}
            {list.length === 0 ? (
              <p className="px-4 py-2 text-sm text-muted-foreground">No plugins yet.</p>
            ) : (
              <ul>
                {list.map((plugin) => {
                  const { version, status, alert } = pluginLine(plugin, connectionsOf(plugin))
                  return (
                    <Entry
                      key={plugin.id}
                      id={plugin.id}
                      selected={shown.id === plugin.id}
                      onSelect={() => setOpen(plugin.id)}
                      title={plugin.id}
                      line={
                        <>
                          {version} · <span className={alert ? 'text-destructive' : undefined}>{status}</span>
                        </>
                      }
                    />
                  )
                })}
              </ul>
            )}
            {hubItems && (
              <section aria-label="Jaspers Hub">
                <ListHeading>Jaspers Hub</ListHeading>
                <ul>
                  <Entry
                    id={HUB_ITEMS}
                    selected={shown.id === HUB_ITEMS}
                    onSelect={() => setOpen(HUB_ITEMS)}
                    title="Your Hub items"
                  />
                </ul>
              </section>
            )}
          </>
        }
        detail={
          current ? (
            <PluginSection plugin={current} connections={connectionsOf(current)} installer={installer} />
          ) : shown.id === HUB_ITEMS ? (
            <HubItems />
          ) : (
            <Directory installer={installer} search />
          )
        }
      />
      {installer.prompt}
    </>
  )
}

const PLUGIN_STATUS: Record<PluginInfo['status'], string> = { building: 'Building', ready: 'Ready', error: 'Error' }
const PLUGIN_COLOR: Record<PluginInfo['status'], string> = {
  building: 'text-muted-foreground',
  ready: 'text-foreground',
  error: 'text-destructive',
}

const STATUS: Record<ConnectionInfo['status'], string> = {
  'needs-secret': 'Needs a key',
  'needs-auth': 'Needs authorization',
  'needs-sign-in': 'Needs sign-in',
  connecting: 'Connecting',
  ready: 'Ready',
  error: 'Error',
}

const STATUS_COLOR: Record<ConnectionInfo['status'], string> = {
  'needs-secret': 'text-destructive',
  'needs-auth': 'text-destructive',
  'needs-sign-in': 'text-destructive',
  connecting: 'text-muted-foreground',
  ready: 'text-foreground',
  error: 'text-destructive',
}

interface SectionProps {
  plugin: PluginInfo
  connections: ConnectionInfo[]
  installer: Install
}

/**
 * One plugin: what it built to, what it asks for, and what it reaches. This is where a key is pasted
 * and an OAuth flow is started, so it dispatches actions of its own: it is part of the host, not a
 * plugin, and the bridge deliberately carries no such call. A value goes straight to main and never
 * comes back; all the section ever learns is that it is set.
 */
function PluginSection({ plugin, connections, installer }: SectionProps): ReactElement {
  // Two lines, not one falling back to the other: a dispatch that failed stays until the next one
  // starts, and it must not stand in front of the build error its author is here to read.
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <section aria-label={`Plugin ${plugin.id}`}>
      {/* Clear of the close cross in the corner. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 pr-8">
        <h3 className="text-base font-semibold">{plugin.id}</h3>
        <span className={`text-sm ${PLUGIN_COLOR[plugin.status]}`}>{PLUGIN_STATUS[plugin.status]}</span>
        {/* Builds, not the package's version, which the Installed row and the list show. */}
        <span className="text-sm text-muted-foreground">build {plugin.version}</span>
      </div>
      {plugin.errors[0] && <p className="mt-1 text-sm break-words text-destructive">{plugin.errors[0]}</p>}
      {failed && <p className="mt-1 text-sm break-words text-destructive">{failed}</p>}

      <div className="mt-3 border-t border-border">
        {plugin.secrets.map((secret) => (
          <SecretRow key={secret.key} plugin={plugin.id} secret={secret} onFail={setFailed} />
        ))}
        {connections.map((connection) => (
          <ConnectionBlock key={connection.id} connection={connection} onFail={setFailed} />
        ))}
        {plugin.origin === 'installed' && plugin.install && (
          <InstalledRow plugin={plugin} install={plugin.install} installer={installer} />
        )}
        {plugin.origin === 'built' && plugin.built && (
          <BuiltRow plugin={plugin} built={plugin.built} installer={installer} />
        )}
        {(plugin.origin === 'local' || plugin.origin === 'built') && (
          <Row label="Jaspers Hub" hint="Others can install it once Hub reviews it.">
            <PublishToHub kind="plugin" id={plugin.id} />
          </Row>
        )}
        <Row label="Views">
          <Names ids={plugin.views} />
        </Row>
        <Row label="Sources">
          <Names ids={plugin.sources} />
        </Row>
        {plugin.skills.length > 0 && (
          <Row label="Skills">
            <span className="text-right font-mono text-xs break-words text-muted-foreground">
              {plugin.skills.map((id) => id.slice(id.indexOf(':') + 1)).join(', ')}
            </span>
          </Row>
        )}
        {plugin.host !== 'none' && (
          <Row label="Backend">
            <span className="text-right text-sm text-muted-foreground">
              host {plugin.host}
              {plugin.capabilities.length > 0 && `, ${plugin.capabilities.join(', ')}`}
              {plugin.jobs.length > 0 && `, ${plugin.jobs.length} job${plugin.jobs.length === 1 ? '' : 's'} running`}
            </span>
          </Row>
        )}
        <div className="border-b border-border py-3 text-sm">
          <span>Folder</span>
          <p className="mt-1 font-mono text-xs break-all text-muted-foreground">{plugin.dir}</p>
        </div>
      </div>
    </section>
  )
}

interface InstalledProps {
  plugin: PluginInfo
  install: NonNullable<PluginInfo['install']>
  installer: Install
}

/** An installed plugin: where it came from, a new version from there, or away with it. */
function InstalledRow({ plugin, install, installer }: InstalledProps): ReactElement {
  const { busy, start } = installer
  return (
    <Row label={`Installed ${install.version}`} hint={install.source}>
      <Removal plugin={plugin} installer={installer}>
        {install.updatable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => start({ kind: 'update', id: plugin.id })}
            className={BUTTON}
          >
            Update
          </button>
        )}
      </Removal>
    </Row>
  )
}

interface BuiltProps {
  plugin: PluginInfo
  built: NonNullable<PluginInfo['built']>
  installer: Install
}

/** A plugin the assistant built: what it is for, when the user approved it, or away with it. */
function BuiltRow({ plugin, built, installer }: BuiltProps): ReactElement {
  const when = new Date(built.at)
  const date = Number.isNaN(when.getTime()) ? '' : ` ${when.toLocaleDateString()}`
  return (
    <Row label={`Built by the assistant${date}`} hint={built.purpose}>
      <Removal plugin={plugin} installer={installer} />
    </Row>
  )
}

/** How a plugin the app put there leaves: a confirmation, then its folder to the trash. `children` are the row's other buttons. */
function Removal({
  plugin,
  installer,
  children,
}: {
  plugin: PluginInfo
  installer: Install
  children?: ReactNode
}): ReactElement {
  const { busy } = installer
  const [confirming, setConfirming] = useState(false)
  const [removal, setRemoval] = useState<{ text: string; error: boolean } | null>(null)
  // The plugin's own files live beside the plugins folder, under its id.
  const data = plugin.dir.replace(/[/\\]plugins[/\\][^/\\]+$/, (match) => `${match[0]}${plugin.id}`)

  function remove(): void {
    setConfirming(false)
    setRemoval({ text: `Removing ${plugin.id}…`, error: false })
    dispatch({ type: 'plugin.remove', id: plugin.id }).catch((err: unknown) =>
      setRemoval({ text: errorMessage(err), error: true }),
    )
  }

  return (
    <>
      {confirming ? (
        <>
          <p className="text-sm">
            Remove {plugin.id}? Its keys are deleted. Its files in {data} stay.
          </p>
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
        <div className="flex justify-end gap-2">
          {children}
          <button type="button" disabled={busy} onClick={() => setConfirming(true)} className={BUTTON}>
            Remove
          </button>
        </div>
      )}
      <StatusLine line={removal ?? (installer.lineFor === plugin.id ? installer.line : null)} />
    </>
  )
}

/** Registry ids without the plugin's own prefix, since the section is the plugin's. */
function Names({ ids }: { ids: string[] }): ReactElement {
  return (
    <span className="text-right font-mono text-xs break-words text-muted-foreground">
      {ids.map((id) => id.slice(id.indexOf('/') + 1)).join(', ') || 'none'}
    </span>
  )
}

function ConnectionBlock({
  connection,
  onFail,
}: {
  connection: ConnectionInfo
  onFail: (message: string | null) => void
}): ReactElement {
  const { id, status, tools } = connection
  const name = id.slice(id.indexOf('/') + 1)

  function act(action: Action): void {
    onFail(null)
    dispatch(action).catch((err: unknown) => onFail(errorMessage(err)))
  }

  return (
    <div className="border-b border-border py-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          Connection <span className="font-mono">{name}</span>
        </span>
        <span className="text-muted-foreground">{connection.transport === 'http' ? 'Streamable HTTP' : 'stdio'}</span>
        <span className={STATUS_COLOR[status]}>{STATUS[status]}</span>
        <div className="ml-auto flex gap-2">
          {status === 'needs-auth' && (
            <button type="button" onClick={() => act({ type: 'connection.authorize', id })} className={BUTTON}>
              Authorize
            </button>
          )}
          {status === 'needs-sign-in' && (
            <button type="button" onClick={() => act({ type: 'jaspers.signIn' })} className={BUTTON}>
              Sign in with Jaspers
            </button>
          )}
          <button type="button" onClick={() => act({ type: 'connection.reconnect', id })} className={BUTTON}>
            Reconnect
          </button>
        </div>
      </div>
      {connection.error && <p className="mt-1 break-words text-destructive">{connection.error}</p>}
      <p className="mt-1 text-muted-foreground">
        {tools.length} tool{tools.length === 1 ? '' : 's'}
        {tools.length > 0 && <span className="font-mono text-xs">: {tools.map((t) => t.name).join(', ')}</span>}
      </p>
    </div>
  )
}

interface SecretProps {
  plugin: string
  secret: PluginInfo['secrets'][number]
  onFail: (message: string | null) => void
}

function SecretRow({ plugin, secret, onFail }: SecretProps): ReactElement {
  const [value, setValue] = useState('')
  const field = useId()

  function save(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!value) return
    onFail(null)
    // The field is cleared first: nothing keeps the value once it is on its way to main.
    const sending = value
    setValue('')
    dispatch({ type: 'plugin.setSecret', plugin, key: secret.key, value: sending }).catch((err: unknown) =>
      onFail(errorMessage(err)),
    )
  }

  return (
    <Row label={secret.label} htmlFor={field} hint={secret.set ? 'Saved' : 'Not set'}>
      <form onSubmit={save} className="flex gap-2">
        <input
          id={field}
          name={secret.key}
          type="password"
          value={value}
          autoComplete="off"
          placeholder={secret.set ? 'Paste to replace' : 'Paste the value'}
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
