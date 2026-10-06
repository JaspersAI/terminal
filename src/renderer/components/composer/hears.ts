/**
 * Whether a key pressed there is a field's to hear. A tile's field hears the keys pressed in its own
 * tile's box; the global box's hears every key not pressed in a tile's box. So Escape in one tile
 * closes nothing anywhere else.
 */
export function hears(on: string | undefined, target: EventTarget | null): boolean {
  const box = target instanceof HTMLElement ? target.closest('[data-loop-box]') : null
  return on === undefined ? box === null : box?.id === `loop-box-${on}`
}
