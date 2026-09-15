import { TopBar } from '@/components/top-bar'
import { Fleet } from '@/components/fleet'
import { BoardTable } from '@/components/board-table'
import { ActivityLog } from '@/components/activity-log'
import { needsFleet, needsBoardRows, needsLog } from '@/lib/data'

export default function NeedsYouPage() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to what needs you
      </a>

      <div className="app">
        <TopBar spend="$12.00" cap="$12.00" />

        <Fleet items={needsFleet} projectState={{ status: 'failed', label: 'Paused' }} />

        <main className="centre" id="main">
          <div className="banner" role="status">
            <div className="head">
              <span aria-hidden="true">[!]</span>Paused — spend cap reached
            </div>
            <div className="body">
              Starting <span className="mono">tkt_1b70e2a4-3fd1-49b7-b2c9-0e42a4f7c188</span> would bring the project
              to <strong>$12.40</strong> (cap $12.00). Raise it to continue.
              <span className="cmd">
                magarine project set --project proj_393c405c-25ac-4220-a95d-21cf66838c6a --max-spend &lt;usd&gt;
              </span>
            </div>
            <div className="row" style={{ marginTop: 'var(--s3)' }}>
              <label className="sr-only" htmlFor="newcap">
                New maximum spend, in US dollars
              </label>
              <input
                className="field"
                id="newcap"
                type="number"
                step="0.01"
                placeholder="new max spend (usd)"
                style={{ width: '12rem' }}
              />
              <button className="btn btn-primary" type="button">
                Raise cap
              </button>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <h2>Needs you</h2>
              <span className="count">3 items</span>
            </div>
            <div className="panel-body">
              <article className="inbox-item">
                <div className="inbox-head">
                  <span className="pill blocked">
                    <span className="dot" aria-hidden="true" />Decision
                  </span>
                  <span className="mono meta-faint">tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f</span>
                  <span className="spacer" />
                  <span className="meta-faint">06:44:21 UTC</span>
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
                  <label className="sr-only" htmlFor="answer2">
                    Your answer
                  </label>
                  <input className="field" id="answer2" type="text" placeholder="your answer" />
                  <button className="btn btn-primary" type="button">
                    Answer
                  </button>
                </div>
              </article>

              <article className="inbox-item kind-review">
                <div className="inbox-head">
                  <span className="pill review">
                    <span className="dot" aria-hidden="true" />Review
                  </span>
                  <span className="mono meta-faint">tkt_9ef76af6-5d02-43c2-96b6-34ee19aa8b2d</span>
                  <span className="spacer" />
                  <span className="meta-faint">06:44:18 UTC</span>
                </div>
                <p className="inbox-reason">
                  Wrote <span className="mono">wal.md</span> covering write-ahead logging, the checkpoint modes and the
                  recovery behaviour after an unclean shutdown. I could not verify the claim about{' '}
                  <span className="mono">synchronous=NORMAL</span> being safe under WAL without testing it, so I have
                  stated it as documented behaviour rather than as fact. Approve it, or reject it with what you want
                  changed.
                </p>
                <div className="artifacts" style={{ marginBottom: 'var(--s3)' }}>
                  <span className="artifact">
                    <span className="kind">file</span> wal.md
                  </span>
                </div>
                <div className="answer-row">
                  <button className="btn btn-primary" type="button">
                    Approve
                  </button>
                  <label className="sr-only" htmlFor="reject2">
                    Reject reason
                  </label>
                  <input className="field" id="reject2" type="text" placeholder="reject reason" />
                  <button className="btn" type="button">
                    Reject
                  </button>
                </div>
              </article>

              <article className="inbox-item kind-failed">
                <div className="inbox-head">
                  <span className="pill failed">
                    <span className="dot" aria-hidden="true" />Failed
                  </span>
                  <span className="mono meta-faint">tkt_98f609d3-c704-4936-a96b-8591536a3990</span>
                  <span className="spacer" />
                  <span className="meta-faint">06:43:40 UTC</span>
                </div>
                <p className="inbox-reason">
                  proposal must be a JSON object
                  <span className="cmd">magarine retry --ticket tkt_98f609d3-c704-4936-a96b-8591536a3990</span>
                  <span className="meta-faint">once the reason above is addressed</span>
                </p>
                <div className="answer-row">
                  <button className="btn" type="button">
                    Retry
                  </button>
                </div>
              </article>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Board</h2>
              <span className="count">6 tickets</span>
              <span className="spacer" />
              <span className="meta-faint">nothing can start while paused</span>
            </div>
            <BoardTable rows={needsBoardRows} />
          </section>
        </main>

        <aside className="rail" aria-label="Activity">
          <ActivityLog rows={needsLog} />
        </aside>
      </div>
    </>
  )
}
