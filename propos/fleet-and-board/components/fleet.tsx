import type { FleetItem, Status } from '@/lib/data'
import { AgentGlyph } from './agent-glyph'

function glyphFor(status: Status): 'working' | 'done' | 'failed' | null {
  if (status === 'in_progress') return 'working'
  if (status === 'done') return 'done'
  if (status === 'failed') return 'failed'
  return null
}

export function Fleet({
  items,
  projectState,
  otherProjects,
}: {
  items: FleetItem[]
  projectState?: { status: Status; label: string }
  otherProjects?: { name: string; id: string }[]
}) {
  return (
    <nav className="fleet" aria-label="Fleet">
      <p className="fleet-label">Projects</p>

      <button className="fleet-project" type="button" aria-current="true">
        <span className="fleet-head-row">
          <span className="name">UI Walk</span>
          {projectState ? (
            <span className={`pill ${projectState.status}`}>
              <span className="dot" aria-hidden="true" />
              {projectState.label}
            </span>
          ) : null}
        </span>
        <br />
        <span className="sub mono">proj_393c405c</span>
      </button>

      <ul className="fleet-children">
        {items.map((it) => {
          const g = glyphFor(it.status)
          return (
            <li className="fleet-child" key={it.shortid + it.status}>
              <button type="button" aria-current={it.current ? 'true' : undefined}>
                <span className="fleet-head-row">
                  <span className={`pill ${it.status}`}>
                    <span className="dot" aria-hidden="true" />
                    {it.label}
                  </span>
                  {it.mgr ? <span className="tag">MGR</span> : null}
                  {g ? <AgentGlyph state={g} label={`worker ${it.label}`} /> : null}
                </span>
                <div className="title">{it.title}</div>
                <span className="shortid">{it.shortid}</span>
              </button>
            </li>
          )
        })}
      </ul>

      {otherProjects && otherProjects.length ? (
        <>
          <p className="fleet-label">Other projects</p>
          {otherProjects.map((p) => (
            <button className="fleet-project" type="button" key={p.id}>
              <span className="name">{p.name}</span>
              <br />
              <span className="sub mono">{p.id}</span>
            </button>
          ))}
        </>
      ) : null}
    </nav>
  )
}
