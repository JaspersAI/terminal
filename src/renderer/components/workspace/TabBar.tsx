import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import { WORKSPACE_NAME_MAX, type Workspace } from '../../../shared/state'
import { formatTabLabel, TAB_PALETTE, tabCharLimit, tabSwatchStyle, tabWidthPx } from '../../../shared/tabs/tabs'
import { useColorScheme } from '../../lib/color-scheme'
import { errorMessage } from '../../lib/errors'
import { dispatch } from '../../lib/state'

interface Props {
  workspaces: Workspace[]
  currentId: string
}

interface ContextMenuState {
  tabId: string
  x: number
  showingPalette: boolean
  confirmingDelete: boolean
}

const PLUS_WIDTH_PX = 28
const DETACH_DRAG_Y_PX = 40

/**
 * Bottom Excel-style tab bar. Tabs have smooth rounded bottom corners, 10px column-label typography,
 * fixed standard width (16 chars, stepping down evenly to 12, 8, 6, 4 when many tabs are open, with
 * no horizontal scroll ever), mouse drag-to-reorder and drag-out-to-detach, and a right-click menu
 * (Add, Rename, Color with 32-color palette, Delete, Detach).
 */
export function TabBar({ workspaces, currentId }: Props): ReactElement {
  const scheme = useColorScheme()
  const isDark = scheme === 'dark'
  const barRef = useRef<HTMLDivElement>(null)
  const [barWidth, setBarWidth] = useState(1200)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    tabId: string
    startX: number
    startY: number
    moved: boolean
    detached: boolean
  } | null>(null)

  useEffect(() => {
    const el = barRef.current
    if (!el) return
    const measure = (): void => setBarWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (renamingId) {
      requestAnimationFrame(() => {
        renameInputRef.current?.focus()
        renameInputRef.current?.select()
      })
    }
  }, [renamingId])

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [menu])

  function run(action: () => Promise<unknown>): void {
    action().catch((err: unknown) => console.error('[tab]', errorMessage(err)))
  }

  function startRename(tab: Workspace): void {
    setMenu(null)
    setRenameDraft(tab.name)
    setRenamingId(tab.id)
  }

  function commitRename(tab: Workspace): void {
    const name = renameDraft.trim()
    setRenamingId(null)
    if (!name || name === tab.name) return
    run(() => dispatch({ type: 'tab.rename', id: tab.id, name }))
  }

  const available = Math.max(200, barWidth - PLUS_WIDTH_PX - 16)
  const count = Math.max(1, workspaces.length)
  const charLimit = tabCharLimit(available, count)
  const perTabWidth = Math.min(tabWidthPx(charLimit), Math.floor((available - count * 2) / count))

  function onTabPointerDown(event: ReactPointerEvent<HTMLDivElement>, tab: Workspace): void {
    if (event.button !== 0 || renamingId === tab.id) return
    dragRef.current = {
      tabId: tab.id,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      detached: false,
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events in tests may not support capture.
    }
  }

  function onTabPointerMove(event: ReactPointerEvent<HTMLDivElement>, tab: Workspace): void {
    const drag = dragRef.current
    if (!drag || drag.tabId !== tab.id || drag.detached) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 5) return
    drag.moved = true

    // Dragging vertically out of the bottom bar detaches the tab into Terminal (copy).
    if (workspaces.length > 1 && Math.abs(dy) > DETACH_DRAG_Y_PX && Math.abs(dy) > Math.abs(dx)) {
      drag.detached = true
      dragRef.current = null
      run(() => dispatch({ type: 'tab.detach', id: tab.id }))
      return
    }

    // Dragging horizontally along the bar rearranges tabs.
    const bar = barRef.current
    if (!bar || perTabWidth <= 0) return
    const rect = bar.getBoundingClientRect()
    const targetIndex = Math.max(
      0,
      Math.min(workspaces.length - 1, Math.floor((event.clientX - rect.left) / (perTabWidth + 2))),
    )
    const currentIndex = workspaces.findIndex((w) => w.id === tab.id)
    if (currentIndex >= 0 && targetIndex !== currentIndex) {
      run(() => dispatch({ type: 'tab.reorder', id: tab.id, toIndex: targetIndex }))
    }
  }

  function onTabPointerUp(event: ReactPointerEvent<HTMLDivElement>, tab: Workspace): void {
    const drag = dragRef.current
    dragRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
    } catch {
      // Ignore synthetic pointer capture release errors.
    }
    if (!drag || drag.detached) return
    if (!drag.moved && tab.id !== currentId) {
      run(() => dispatch({ type: 'tab.select', id: tab.id }))
    }
  }

  function onTabContextMenu(event: ReactMouseEvent<HTMLDivElement>, tab: Workspace): void {
    event.preventDefault()
    const barBox = barRef.current?.getBoundingClientRect()
    const x = barBox ? Math.max(8, Math.min(event.clientX - barBox.left, barBox.width - 216)) : 8
    setMenu({
      tabId: tab.id,
      x,
      showingPalette: false,
      confirmingDelete: false,
    })
  }

  const menuTab = menu ? workspaces.find((w) => w.id === menu.tabId) : undefined

  return (
    <div
      ref={barRef}
      id="tab-bar"
      role="tablist"
      aria-label="Tabs"
      className="relative flex h-6 w-full shrink-0 items-start gap-0.5 overflow-hidden border-t border-border bg-background px-2 pb-1 select-none"
    >
      {workspaces.map((tab) => {
        const active = tab.id === currentId
        const isRenaming = renamingId === tab.id
        const swatch = tabSwatchStyle(tab.color, active, isDark)
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            data-tab-id={tab.id}
            data-active={active}
            data-tab-color={tab.color ?? undefined}
            title={tab.name}
            style={{
              width: `${perTabWidth}px`,
              backgroundColor: swatch.backgroundColor,
              color: swatch.color,
              borderColor: swatch.borderColor,
            }}
            onPointerDown={(event) => onTabPointerDown(event, tab)}
            onPointerMove={(event) => onTabPointerMove(event, tab)}
            onPointerUp={(event) => onTabPointerUp(event, tab)}
            onDoubleClick={() => startRename(tab)}
            onContextMenu={(event) => onTabContextMenu(event, tab)}
            className="flex h-5 shrink-0 cursor-pointer items-center justify-center rounded-b-md border-x border-b px-2 text-[10px] leading-none font-medium transition-colors"
          >
            {isRenaming ? (
              <input
                ref={renameInputRef}
                id="workspace-title"
                aria-label="Tab name"
                value={renameDraft}
                maxLength={WORKSPACE_NAME_MAX}
                autoComplete="off"
                spellCheck={false}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => commitRename(tab)}
                onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation()
                    setRenamingId(null)
                  } else if (event.key === 'Enter') {
                    event.stopPropagation()
                    commitRename(tab)
                  }
                }}
                className="w-full min-w-0 bg-transparent text-center text-[10px] leading-none font-medium outline-none"
              />
            ) : (
              <span
                id={active ? 'workspace-title' : undefined}
                className="w-full truncate text-center text-[10px] leading-none"
              >
                {formatTabLabel(tab.name, charLimit)}
              </span>
            )}
          </div>
        )
      })}
      <button
        type="button"
        id="new-tab-button"
        aria-label="New tab"
        title="New tab"
        onClick={() => run(() => dispatch({ type: 'tab.create' }))}
        className="flex h-5 w-6 shrink-0 items-center justify-center rounded-b-md border-x border-b border-border bg-muted/50 text-[10px] leading-none text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        +
      </button>

      {menu && menuTab && (
        <div
          ref={menuRef}
          id="tab-context-menu"
          role="menu"
          aria-label={`Options for ${menuTab.name}`}
          style={{ left: `${menu.x}px` }}
          className="fixed bottom-7 z-50 w-52 border border-border bg-background py-1 text-xs shadow-xl"
        >
          <button
            type="button"
            role="menuitem"
            data-menu-add
            onClick={() => {
              setMenu(null)
              run(() => dispatch({ type: 'tab.create' }))
            }}
            className="flex w-full items-center px-3 py-1.5 text-left hover:bg-muted"
          >
            Add
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-rename
            onClick={() => startRename(menuTab)}
            className="flex w-full items-center px-3 py-1.5 text-left hover:bg-muted"
          >
            Rename
          </button>
          <button
            type="button"
            role="menuitem"
            data-menu-color
            aria-expanded={menu.showingPalette}
            onClick={() => setMenu({ ...menu, showingPalette: !menu.showingPalette, confirmingDelete: false })}
            className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-muted"
          >
            <span>Color</span>
            <span className="text-[10px] text-muted-foreground">{menu.showingPalette ? '▴' : '▾'}</span>
          </button>
          {menu.showingPalette && (
            <div data-color-palette className="border-y border-border px-3 py-2">
              <div className="grid grid-cols-8 gap-1">
                {TAB_PALETTE.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    data-color-swatch={hex}
                    aria-label={`Color ${hex}`}
                    onClick={() => {
                      setMenu(null)
                      run(() => dispatch({ type: 'tab.color', id: menuTab.id, color: hex }))
                    }}
                    style={{ backgroundColor: hex }}
                    className={`h-4 w-4 border ${
                      menuTab.color === hex ? 'border-foreground ring-1 ring-foreground' : 'border-border'
                    }`}
                  />
                ))}
              </div>
              <button
                type="button"
                data-color-reset
                onClick={() => {
                  setMenu(null)
                  run(() => dispatch({ type: 'tab.color', id: menuTab.id, color: null }))
                }}
                className="mt-1.5 w-full border border-border py-0.5 text-center text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Default grayscale
              </button>
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            data-menu-detach
            disabled={workspaces.length <= 1}
            onClick={() => {
              setMenu(null)
              run(() => dispatch({ type: 'tab.detach', id: menuTab.id }))
            }}
            className="flex w-full items-center px-3 py-1.5 text-left hover:bg-muted disabled:opacity-40"
          >
            Detach
          </button>
          {menu.confirmingDelete ? (
            <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
              <span className="text-[10px] text-muted-foreground">Delete tab?</span>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  data-confirm-close-tab={menuTab.id}
                  onClick={() => {
                    setMenu(null)
                    run(() => dispatch({ type: 'tab.delete', id: menuTab.id }))
                  }}
                  className="px-1.5 py-0.5 text-destructive hover:bg-muted"
                >
                  Delete
                </button>
                <button
                  type="button"
                  onClick={() => setMenu({ ...menu, confirmingDelete: false })}
                  className="px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                >
                  Keep
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              role="menuitem"
              data-menu-delete
              disabled={workspaces.length <= 1}
              onClick={() => setMenu({ ...menu, confirmingDelete: true, showingPalette: false })}
              className="flex w-full items-center px-3 py-1.5 text-left text-destructive hover:bg-muted disabled:opacity-40"
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  )
}
