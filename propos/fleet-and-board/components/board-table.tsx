import type { BoardRow } from '@/lib/data'

function Cost({ row }: { row: BoardRow }) {
  if (row.liveEstimate) {
    return (
      <td className="num spent phrase">
        at least {row.cost}
        <br />
        <span className="meta-faint">live estimate</span>
      </td>
    )
  }
  if (row.costSpent) return <td className="num spent">{row.cost}</td>
  return <td className="num low">{row.cost}</td>
}

export function BoardTable({ rows }: { rows: BoardRow[] }) {
  return (
    <div className="table-scroll">
      <table className="grid">
        <colgroup>
          <col style={{ width: '35%' }} />
          <col style={{ width: '19%' }} />
          <col style={{ width: '12%' }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '14%' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Ticket</th>
            <th scope="col">Status</th>
            <th scope="col">Attempts</th>
            <th scope="col">Equivalent cost</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.live ? 'is-live' : undefined}>
              <td>
                <div className="cell-title">
                  {row.mgr ? <span className="tag">MGR</span> : null} {row.title}
                </div>
                <div className="cell-id">{row.id}</div>

                {row.blockedBy ? (
                  <div className="meta-faint" style={{ marginTop: 'var(--s1)' }}>
                    blocked by <span className="mono">{row.blockedBy}</span>
                  </div>
                ) : null}

                {row.artifacts && row.artifacts.length ? (
                  <div className="artifacts">
                    {row.artifacts.map((a) => (
                      <span className="artifact" key={a}>
                        <span className="kind">file</span> {a}
                      </span>
                    ))}
                  </div>
                ) : null}

                {row.note ? (
                  <details className="note">
                    <summary>{row.note.summary}</summary>
                    <div className="note-body">
                      {row.note.body}
                      {row.note.mono ? <span className="mono">{row.note.mono}</span> : null}
                      {row.note.tail ?? null}
                    </div>
                  </details>
                ) : null}
              </td>
              <td>
                <span className={`pill ${row.status}`}>
                  <span className="dot" aria-hidden="true" />
                  {row.statusLabel}
                </span>
              </td>
              <td className="num low">{row.attempts}</td>
              <Cost row={row} />
              <td>{row.action ? <button className="btn" type="button">{row.action}</button> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
