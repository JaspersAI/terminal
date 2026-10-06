import type { HubItemInfo } from '../../shared/hub/hub.ts'
import type { Staged } from './install-stage.ts'

// What a Jaspers sign-up comes with, the Jaspers Screener and Jaspers Research: setup's Sign in with
// Jaspers says they come with it, so once the sign-in lands, each is installed from Hub with no
// second prompt. They are the installs nobody is asked about, so each is held to more than one that
// is asked: only Jaspers' own, a version Hub reviewed, an archive with the hash Hub sent, and only
// where no plugin of its id is installed from anywhere. They install one after the other in the
// background and nothing waits on them; one that fails is a notice, and the other still installs.
// What this reaches comes in through `deps` (install.ts hands it the app's), which is what lets a
// test drive it.

/** One plugin a Jaspers sign-up comes with: where it is on Hub, and what a notice calls it. */
interface Default {
  handle: string
  name: string
  called: string
}

/** What a Jaspers sign-up comes with, in the order it installs. */
const DEFAULTS: Default[] = [
  { handle: 'jaspers', name: 'screener-mcp', called: 'The Jaspers Screener' },
  { handle: 'jaspers', name: 'research', called: 'Jaspers Research' },
]
const NOT_REVIEWED = 'its version on Hub is not reviewed.'

export interface DefaultInstallDeps {
  /** Whether a plugin of this id is here already, from wherever it came. */
  installed(id: string): boolean
  item(handle: string, name: string): Promise<HubItemInfo | null>
  /** Fetches and checks the item's archive, its hash against the one Hub sent. */
  stage(handle: string, name: string): Promise<Staged>
  commit(staged: Staged): Promise<void>
  discard(staged: Staged): Promise<void>
  notice(text: string): void
  /** Marks what is being installed, for the plugin step to say so; null once it is done, either way. */
  setInstalling(id: string | null): void
}

export async function installDefaults(deps: DefaultInstallDeps): Promise<void> {
  for (const one of DEFAULTS) await installDefault(one, deps)
}

async function installDefault({ handle, name, called }: Default, deps: DefaultInstallDeps): Promise<void> {
  // One here already, from Hub, GitHub, or a folder of the user's own, stays as it is.
  if (deps.installed(name)) return
  deps.setInstalling(name)
  const refuse = (reason: string): void =>
    deps.notice(`${called} could not be installed: ${reason} Install it from the list.`)
  try {
    const item = await deps.item(handle, name)
    if (!item) return refuse('it is not on Jaspers Hub.')
    if (!item.official) return refuse("it is not Jaspers' own on Hub.")
    if (item.shown?.state !== 'approved') return refuse(NOT_REVIEWED)
    const staged = await deps.stage(handle, name)
    // What Hub said of the very archive it served: an answer that changed since the item was read wins.
    if (!staged.hub?.official || !staged.hub.reviewed) {
      await deps.discard(staged)
      return refuse(staged.hub?.official ? NOT_REVIEWED : "it is not Jaspers' own on Hub.")
    }
    // One installed another way while this was staged is the user's choice, and stays.
    if (deps.installed(name)) return await deps.discard(staged)
    await deps.commit(staged)
  } catch (err) {
    refuse(sentence(err instanceof Error ? err.message : String(err)))
  } finally {
    deps.setInstalling(null)
  }
}

/** Words as one sentence of a longer notice: ended with one period, however they ended. */
function sentence(words: string): string {
  return `${words.replace(/[.\s]+$/, '')}.`
}
