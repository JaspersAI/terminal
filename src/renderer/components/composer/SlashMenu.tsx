import type { ReactElement } from 'react'
import type { SkillInfo } from '../../../shared/state'

interface Props {
  skills: SkillInfo[]
  active: number
  onPick: (skill: SkillInfo) => void
}

/**
 * The skills a / draft could mean, over the text field. The field keeps the keyboard: arrows move,
 * Tab or Enter picks, Escape closes, and a press picks without taking focus from it.
 */
export function SlashMenu({ skills, active, onPick }: Props): ReactElement {
  return (
    <ul
      id="slash-menu"
      role="listbox"
      aria-label="Skills"
      className="absolute inset-x-0 bottom-full mb-2 border border-border bg-background py-1 shadow-lg"
    >
      {skills.map((skill, i) => (
        <li key={skill.id} id={`slash-option-${i}`} role="option" aria-selected={i === active}>
          <button
            type="button"
            tabIndex={-1}
            onPointerDown={(event) => {
              event.preventDefault()
              onPick(skill)
            }}
            className={`block w-full px-3 py-1.5 text-left ${i === active ? 'bg-muted' : 'hover:bg-muted'}`}
          >
            <span className="font-mono text-sm">/{skill.id}</span>
            {skill.argumentHint && (
              <span className="ml-2 font-mono text-xs text-muted-foreground">{skill.argumentHint}</span>
            )}
            {skill.description && (
              <span className="block truncate text-xs text-muted-foreground">{skill.description}</span>
            )}
          </button>
        </li>
      ))}
    </ul>
  )
}
