import type { LogRow } from '@/lib/data'

export function ActivityLog({ rows }: { rows: LogRow[] }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Activity</h2>
        <span className="live-dot" aria-hidden="true" />
        <span className="count">2026-09-14 &middot; UTC</span>
      </div>
      <table className="log">
        <colgroup>
          <col style={{ width: '23%' }} />
          <col style={{ width: '50%' }} />
          <col style={{ width: '27%' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col">Time</th>
            <th scope="col">Event</th>
            <th scope="col">Ticket</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.t + r.kind} className={i === 0 ? 'is-newest' : undefined}>
              <td className="t">{r.t}</td>
              <td className={`kind${r.cls ? ' ' + r.cls : ''}`}>{r.kind}</td>
              <td>{r.ticket}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
