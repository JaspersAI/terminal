import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { settled, type Citation } from '../../../shared/agent/citations'
import { citedIds, parseMarkdown, type Block, type Inline, type List } from './markdown'

/** Space above a block; none above the first, so the box's padding is the only space at its top. */
const FLOW = 'mt-3 first:mt-0'
/** Markdown's first three heading levels, in the prose face a step or two up; deeper ones read as the third. */
const HEADINGS = [
  { Tag: 'h3', size: 'text-[1.25em]' },
  { Tag: 'h4', size: 'text-[1.12em]' },
  { Tag: 'h5', size: 'text-[1em]' },
] as const
/** Tables are data, so they take the interface face with figures of one width, and rules between rows. */
const CELL = 'border-b border-border px-3 py-1.5 align-top whitespace-pre-line first:pl-0 last:pr-0'

const NONE: Citation[] = []

/** What a mark needs from the reply around it: its source's number and title, and how to show the source. */
interface Marks {
  sources: Map<string, { n: number; title: string }>
  show: (id: string) => void
}

/**
 * A reply's Markdown as React elements. Nothing here becomes HTML from a string: `parseMarkdown` reads
 * the text into a tree and each node is an element, so a reply cannot inject markup. A link opens in
 * the browser through main, which takes https links only; main also keeps the window from following
 * one itself, clicked with a modifier key or dragged onto the page.
 *
 * A `[^id]` in the reply is the mark of a source, numbered in the order the reply first cites each,
 * and the sources are listed under it, closed until asked for: a mark opens the list at its source.
 * Only an id among `citations` is one, which main found among what the tools gave; any other shows
 * as nothing, and so does a marker a reply still being written has not finished.
 */
export function MarkdownText({ source, citations = NONE }: { source: string; citations?: Citation[] }): ReactElement {
  const blocks = useMemo(() => parseMarkdown(settled(source)), [source])
  const listed = useMemo(() => {
    const given = new Map(citations.map((one) => [one.id, one]))
    return citedIds(blocks).flatMap((id) => given.get(id) ?? [])
  }, [blocks, citations])
  // Which reply the list is open under, and the source a mark asked for: another reply in this place starts closed.
  const [opened, setOpened] = useState<{ source: string; shown: string | null } | null>(null)
  const open = opened?.source === source
  const shown = open ? opened.shown : null
  const rows = useRef(new Map<string, HTMLLIElement>())
  // Every time a mark asks, not only the first: the reader may have scrolled away from its source since.
  useEffect(() => {
    if (opened?.shown) rows.current.get(opened.shown)?.scrollIntoView({ block: 'nearest' })
  }, [opened])

  const marks: Marks = {
    sources: new Map(listed.map((one, i) => [one.id, { n: i + 1, title: one.title }])),
    show: (id) => setOpened({ source, shown: id }),
  }
  return (
    <>
      {blocks.map((block, i) => renderBlock(block, i, marks))}
      {listed.length > 0 && (
        <details
          open={open}
          onToggle={(event) => {
            const now = event.currentTarget.open
            if (now !== open) setOpened(now ? { source, shown: null } : null)
          }}
          className="mt-3 font-sans text-xs"
        >
          <summary className="cursor-pointer text-muted-foreground select-none">
            {listed.length === 1 ? '1 source' : `${listed.length} sources`}
          </summary>
          <ol className="mt-2 flex flex-col gap-2">
            {listed.map((one, i) => (
              <li
                key={one.id}
                ref={(row) => {
                  if (row) rows.current.set(one.id, row)
                  else rows.current.delete(one.id)
                }}
                className={`flex gap-2 px-1 py-0.5 ${shown === one.id ? 'bg-muted' : ''}`}
              >
                <span className="shrink-0 text-muted-foreground tabular-nums">[{i + 1}]</span>
                <div className="min-w-0">
                  {one.url ? <ExternalLink href={one.url}>{one.title}</ExternalLink> : one.title}
                  {one.quote && <p className="mt-0.5 text-muted-foreground">“{one.quote}”</p>}
                </div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  )
}

function renderBlock(block: Block, key: number, marks: Marks): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const { Tag, size } = HEADINGS[Math.min(block.level, HEADINGS.length) - 1]
      return (
        <Tag key={key} className={`mt-5 font-semibold leading-snug first:mt-0 ${size}`}>
          {renderInline(block.children, marks)}
        </Tag>
      )
    }
    case 'paragraph':
      return (
        <p key={key} className={`${FLOW} whitespace-pre-line`}>
          {renderInline(block.children, marks)}
        </p>
      )
    case 'list':
      return renderList(block, key, FLOW, marks)
    case 'code':
      return (
        <pre key={key} className={`${FLOW} overflow-x-auto bg-muted px-3 py-2 font-mono text-[13px]`}>
          <code>{block.text}</code>
        </pre>
      )
    case 'table':
      return (
        <div key={key} className={`${FLOW} overflow-x-auto`}>
          <table className="border-collapse font-sans text-sm tabular-nums">
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i} className={`${CELL} font-semibold`} style={{ textAlign: block.align[i] ?? 'left' }}>
                    {renderInline(cell, marks)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} className={CELL} style={{ textAlign: block.align[i] ?? undefined }}>
                      {renderInline(cell, marks)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return (
        <blockquote key={key} className={`${FLOW} border-l-2 border-border pl-3 text-muted-foreground`}>
          {block.children.map((child, i) => renderBlock(child, i, marks))}
        </blockquote>
      )
    case 'rule':
      return <hr key={key} className="my-4 border-border first:mt-0" />
  }
}

/** Square bullets, the house shape, and numbers from where the list starts; markers in the muted color. */
function renderList(list: List, key: number, className: string, marks: Marks): ReactNode {
  const items = list.items.map((item, i) => (
    <li key={i} className="mt-1 first:mt-0">
      {renderInline(item.children, marks)}
      {item.lists.map((nested, j) => renderList(nested, j, 'mt-1', marks))}
    </li>
  ))
  const shared = `${className} whitespace-pre-line marker:text-muted-foreground`
  return list.ordered ? (
    <ol key={key} start={list.start} className={`${shared} list-decimal pl-6`}>
      {items}
    </ol>
  ) : (
    <ul key={key} className={`${shared} list-[square] pl-5`}>
      {items}
    </ul>
  )
}

function renderInline(nodes: Inline[], marks: Marks): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case 'text':
        return node.text
      case 'code':
        return (
          <code key={i} className="bg-muted px-1 font-mono text-[0.85em]">
            {node.text}
          </code>
        )
      case 'strong':
        return <strong key={i}>{renderInline(node.children, marks)}</strong>
      case 'em':
        return <em key={i}>{renderInline(node.children, marks)}</em>
      case 'del':
        return <del key={i}>{renderInline(node.children, marks)}</del>
      case 'link':
        return (
          <ExternalLink key={i} href={node.href}>
            {renderInline(node.children, marks)}
          </ExternalLink>
        )
      case 'cite': {
        // An id nothing gave is the model's own: it points at no source, so it shows as nothing.
        const cited = marks.sources.get(node.id)
        if (!cited) return null
        return (
          <sup key={i} className="font-sans font-normal not-italic">
            <button
              type="button"
              data-cite={node.id}
              title={cited.title}
              aria-label={`Source ${cited.n}: ${cited.title}`}
              onClick={() => marks.show(node.id)}
              className="cursor-pointer text-muted-foreground hover:text-foreground"
            >
              [{cited.n}]
            </button>
          </sup>
        )
      }
    }
  })
}

/** A link out of the app. Main opens it in the browser, https only, and the window never follows it itself. */
function ExternalLink({ href, children }: { href: string; children: ReactNode }): ReactElement {
  return (
    <a
      href={href}
      title={href}
      onClick={(event) => {
        event.preventDefault()
        void window.app.openExternal(href).catch(() => undefined)
      }}
      className="underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground"
    >
      {children}
    </a>
  )
}
