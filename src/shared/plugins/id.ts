// A plugin's id: its folder's name, its package.json's name, and what its views, sources, and
// connections are named under. Hub's handles follow the same rule. Pure.

const ID = /^[a-z0-9][a-z0-9-]*$/
export const ID_MAX = 64

export function isPluginId(id: string): boolean {
  return ID.test(id) && id.length <= ID_MAX
}
