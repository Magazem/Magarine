import { TopBar } from '@/components/top-bar'
import { Fleet } from '@/components/fleet'
import { BoardTable } from '@/components/board-table'
import { ActivityLog } from '@/components/activity-log'
import { AgentActivity } from '@/components/agent-activity'
import { boardFleet, boardRows, boardLog, workerPhrases } from '@/lib/data'

export default function FleetAndBoardPage() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the board
      </a>

      <div className="app">
        <TopBar spend="$0.37" />

        <Fleet items={boardFleet} otherProjects={[{ name: 'SQLite reference', id: 'proj_396d8ad0' }]} />

        <main className="centre" id="main">
          <section className="panel">
            <div className="panel-head">
              <h2>Board</h2>
              <span className="count">5 tickets</span>
              <span className="spacer" />
              <AgentActivity phrases={workerPhrases} />
              <span className="pill in_progress">
                <span className="dot" aria-hidden="true" />1 running
              </span>
            </div>

            <div className="panel-body" style={{ paddingTop: 'var(--s2)', paddingBottom: 0 }}>
              <details className="note">
                <summary>Equivalent API cost: $0.37 (no cap set)</summary>
                <div className="note-body">
                  On a subscription, the real constraint is session limits, not dollars. The figure is what the tool
                  would have billed at metered rates; it is not money leaving your account.
                </div>
              </details>
            </div>

            <BoardTable rows={boardRows} />
          </section>
        </main>

        <aside className="rail" aria-label="Needs you and activity">
          <section className="panel">
            <div className="panel-head">
              <h2>Needs you</h2>
              <span className="count">1</span>
            </div>
            <div className="panel-body">
              <article className="inbox-item">
                <div className="inbox-head">
                  <span className="pill blocked">
                    <span className="dot" aria-hidden="true" />Decision
                  </span>
                  <span className="mono meta-faint">tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f</span>
                </div>
                <p className="inbox-reason">
                  The scope says one file per journal mode, but it does not say whether{' '}
                  <span className="mono">memory.md</span> should cover the in-memory journal or the in-memory
                  database, and those are two different features. I have written <span className="mono">delete.md</span>{' '}
                  and <span className="mono">wal.md</span> already and can finish either way in about the same time.
                  Tell me which you meant and I will write it.
                  <span className="cmd">{'magarine decide --ticket tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f --answer "..."'}</span>
                </p>
                <div className="answer-row">
                  <label className="sr-only" htmlFor="answer1">
                    Your answer
                  </label>
                  <input className="field" id="answer1" type="text" placeholder="your answer" />
                  <button className="btn btn-primary" type="button">
                    Answer
                  </button>
                </div>
              </article>
            </div>
          </section>

          <ActivityLog rows={boardLog} />
        </aside>
      </div>
    </>
  )
}
