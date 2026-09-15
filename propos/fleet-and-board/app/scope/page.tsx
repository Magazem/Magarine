import { TopBar } from '@/components/top-bar'
import { Fleet } from '@/components/fleet'
import { ActivityLog } from '@/components/activity-log'
import { scopeFleet, scopeLog, scopeText } from '@/lib/data'

export default function ScopeAndConversationPage() {
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to the scope
      </a>

      <div className="app">
        <TopBar spend="$0.37" />

        <Fleet items={scopeFleet} projectState={{ status: 'in_progress', label: 'Working' }} />

        <main className="centre" id="main">
          <section className="panel">
            <div className="panel-head">
              <h2>Scope document</h2>
              <span className="count">SCOPE.md</span>
              <span className="spacer" />
              <span className="meta-faint">read-only here &middot; edited on disk or by asking the Manager</span>
            </div>
            <div className="panel-body">
              <div className="scope-wrap">
                <pre className="scope">{scopeText}</pre>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Conversation</h2>
              <span className="count">6 entries</span>
              <span className="spacer" />
              <span className="meta-faint">newest last</span>
            </div>
            <div className="panel-body">
              <article className="entry scope_updated">
                <div className="who">
                  <span className="name">Scope updated</span>
                  <span className="mono">2026-09-14T17:55:23.756Z</span>
                </div>
                <div className="text">seeded from --mission</div>
              </article>

              <article className="entry owner_message">
                <div className="who">
                  <span className="name">You</span>
                  <span className="mono">2026-09-14T17:55:34.910Z</span>
                </div>
                <div className="text">Please also cover the TRUNCATE mode.</div>
              </article>

              <article className="entry manager_reply">
                <div className="who">
                  <span className="name">Manager</span>
                  <span className="mono">2026-09-14T17:55:41.220Z</span>
                </div>
                <div className="text">
                  Added <span className="mono">truncate.md</span> as a fourth ticket and made{' '}
                  <span className="mono">index.md</span> depend on it, so the index is still written last and will link
                  all four. I did not touch the three files already in flight.
                </div>
              </article>

              <article className="entry owner_message">
                <div className="who">
                  <span className="name">You</span>
                  <span className="mono">2026-09-14T17:56:11.732Z</span>
                </div>
                <div className="text">Typed from a real browser: please keep it short.</div>
              </article>

              <article className="entry manager_assessment">
                <div className="who">
                  <span className="name">Manager &middot; assessment</span>
                  <span className="mono">2026-09-14T17:56:19.058Z</span>
                </div>
                <div className="text">
                  Four of six tickets are done and the remaining two are blocked on one decision from you. The word
                  limit in the scope is being met; <span className="mono">wal.md</span> came back at 380 words. Nothing
                  here needs a bigger model — the spec is fixed and the writing is mechanical.
                  <details className="note">
                    <summary>model claude-haiku-4-5-20251001</summary>
                    <div className="note-body">
                      Mechanical writing task with a fully fixed spec — no design judgment required.
                    </div>
                  </details>
                </div>
              </article>

              <article className="entry question">
                <div className="who">
                  <span className="name">Manager &middot; question</span>
                  <span className="mono">2026-09-14T17:56:44.301Z</span>
                </div>
                <div className="text">
                  The scope says one file per journal mode, but it does not say whether{' '}
                  <span className="mono">memory.md</span> should cover the in-memory journal or the in-memory database,
                  and those are two different features. I have written <span className="mono">delete.md</span> and{' '}
                  <span className="mono">wal.md</span> already and can finish either way in about the same time. Tell me
                  which you meant and I will write it.
                  <span className="cmd">{'magarine decide --ticket tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f --answer "..."'}</span>
                </div>
                <div className="answer-row" style={{ marginTop: 'var(--s3)' }}>
                  <label className="sr-only" htmlFor="answer3">
                    Your answer
                  </label>
                  <input className="field" id="answer3" type="text" placeholder="your answer" />
                  <button className="btn btn-primary" type="button">
                    Answer
                  </button>
                </div>
              </article>

              <div className="composer">
                <label className="sr-only" htmlFor="say">
                  Message to the Manager
                </label>
                <textarea
                  className="field"
                  id="say"
                  rows={3}
                  placeholder="Talk to the Manager -- answer a question, or ask it to change something."
                />
                <button className="btn btn-primary" type="button">
                  Send
                </button>
              </div>
            </div>
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
                  <label className="sr-only" htmlFor="answer4">
                    Your answer
                  </label>
                  <input className="field" id="answer4" type="text" placeholder="your answer" />
                  <button className="btn btn-primary" type="button">
                    Answer
                  </button>
                </div>
              </article>
            </div>
          </section>

          <ActivityLog rows={scopeLog} />
        </aside>
      </div>
    </>
  )
}
