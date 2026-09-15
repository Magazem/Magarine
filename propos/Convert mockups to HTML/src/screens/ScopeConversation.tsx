import { useState, useRef, useEffect } from 'react'
import type { Theme, Screen } from '../App'
import {
  StatusPill, MagarineGlyph, Panel, PanelHead, PanelTitle, Count,
  Spacer, MonoId, Btn, type AgentState
} from '../App'

interface ConversationEntry {
  id: string
  type: 'scope_updated' | 'owner_message' | 'manager_reply' | 'manager_assessment'
  who: string
  timestamp: string
  text: string
  agentState?: AgentState
}

const SCOPE_TEXT = `# Scope: a small reference on SQLite journal modes

Write delete.md, wal.md and memory.md, one per mode, then index.md last
linking all three.

## Audience

Someone who has used SQLite through a library, has never set
journal_mode deliberately, and has just been told by someone that they
should be using WAL. They do not need the file format; they need to know
what changes for them.

## Per-mode file

Each of the three mode files covers, in this order:

1. What the mode actually does on COMMIT, in two or three sentences.
2. What it costs -- fsyncs, extra files on disk, reader/writer blocking.
3. When it is the right choice, stated as a situation rather than a rule.
4. The one failure mode people hit with it in practice.

Keep each file under roughly 400 words. Prose, not bullet soup: the
bullets above are the checklist for writing it, not the shape of the
output.

## index.md

Written last, once the other three exist. One paragraph of orientation,
then a short table comparing the three on durability, concurrency and
disk cost, then links. Do not summarise the three files -- link them.

## Constraints

- No benchmarks. Any number would be made up.
- Do not recommend WAL unconditionally; it is wrong over a network
  filesystem, and that belongs in wal.md's failure mode section.
- British or American spelling, but the same one throughout.`

const ENTRIES: ConversationEntry[] = [
  {
    id: '1',
    type: 'scope_updated',
    who: 'Scope updated',
    timestamp: '2026-09-14T17:55:23.756Z',
    text: 'seeded from --mission',
  },
  {
    id: '2',
    type: 'owner_message',
    who: 'You',
    timestamp: '2026-09-14T17:55:34.910Z',
    text: 'Please also cover the TRUNCATE mode.',
  },
  {
    id: '3',
    type: 'manager_reply',
    who: 'Manager',
    timestamp: '2026-09-14T17:55:41.220Z',
    text: 'Added truncate.md as a fourth ticket and made index.md depend on it, so the index is still written last and will link all four. I did not touch the three files already in flight.',
    agentState: 'planning',
  },
  {
    id: '4',
    type: 'owner_message',
    who: 'You',
    timestamp: '2026-09-14T17:56:11.732Z',
    text: 'Typed from a real browser: please keep it short.',
  },
  {
    id: '5',
    type: 'manager_assessment',
    who: 'Manager · assessment',
    timestamp: '2026-09-14T17:56:19.058Z',
    text: 'Four of six tickets are done and the remaining two are blocked on one decision from you. The word limit in the scope is being met; wal.md came back at 380 words. Nothing here needs a bigger model — the haiku has handled all of the mechanical writing cleanly.',
    agentState: 'thinking',
  },
  {
    id: '6',
    type: 'manager_reply',
    who: 'Manager',
    timestamp: '2026-09-14T17:56:55.123Z',
    text: 'Agent is currently reading the wal.md draft and running a final check against the scope constraints before marking complete.',
    agentState: 'reading',
  },
]

const ENTRY_STYLE: Record<string, { borderColor: string; label: string }> = {
  scope_updated:     { borderColor: '#4A5A72', label: 'system' },
  owner_message:     { borderColor: '#38BDF8', label: 'you' },
  manager_reply:     { borderColor: '#A855F7', label: 'manager' },
  manager_assessment: { borderColor: '#22C55E', label: 'assessment' },
}

export default function ScopeConversation({ theme, setScreen }: { theme: Theme; setScreen: (s: Screen) => void }) {
  const [message, setMessage] = useState('')
  const [entries, setEntries] = useState(ENTRIES)
  const conversationRef = useRef<HTMLDivElement>(null)
  const dark = theme === 'dark'
  const borderColor = dark ? '#2D3B55' : '#C8C0B4'
  const bgMain = dark ? '#080C14' : '#F0EDE6'
  const bgSurface = dark ? '#0F172A' : '#E8E4DC'
  const faintColor = dark ? '#4A5A72' : '#8A9AB5'
  const mutedColor = dark ? '#7A8BA8' : '#6A7080'

  useEffect(() => {
    if (conversationRef.current) {
      conversationRef.current.scrollTop = conversationRef.current.scrollHeight
    }
  }, [entries])

  const sendMessage = () => {
    if (!message.trim()) return
    const newEntry: ConversationEntry = {
      id: String(Date.now()),
      type: 'owner_message',
      who: 'You',
      timestamp: new Date().toISOString(),
      text: message,
    }
    setEntries(e => [...e, newEntry])
    setMessage('')
  }

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', background: bgMain }}>
      {/* Fleet sidebar */}
      <nav aria-label="Fleet" style={{
        width: 268,
        flexShrink: 0,
        borderRight: `2px solid ${borderColor}`,
        background: bgSurface,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{ padding: '10px 16px', borderBottom: `1px solid ${borderColor}`, display: 'flex', alignItems: 'center' }}>
          <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: faintColor }}>Fleet</span>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <div style={{ padding: '8px 16px 4px', fontFamily: '"JetBrains Mono", monospace', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: faintColor }}>Projects</div>

          <button style={{
            display: 'block', width: '100%', padding: '10px 16px',
            border: 'none', borderLeft: `3px solid #22C55E`,
            borderBottom: `1px solid ${borderColor}`,
            background: dark ? '#1B2336' : '#DDD8CE',
            textAlign: 'left', cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <MagarineGlyph size={20} state="working" theme={theme} />
              <span style={{ fontFamily: '"Inter", sans-serif', fontSize: 13, fontWeight: 600, color: dark ? '#E8EDF5' : '#1A1F2E' }}>UI Walk</span>
              <StatusPill variant="in_progress" theme={theme} style={{ fontSize: 9, padding: '1px 6px' }}>Working</StatusPill>
            </div>
            <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor }}>proj_393c405c</div>
          </button>

          {[
            { id: 'tkt_ed46cad3', title: 'Needs a decision from the owner', status: 'blocked' as const },
            { id: 'tkt_9ef76af6', title: 'Write wal.md covering write-ahead logging', status: 'in_progress' as const },
            { id: 'tkt_72f34caf', title: 'Write the introduction section', status: 'done' as const },
          ].map(tkt => (
            <button
              key={tkt.id}
              style={{
                display: 'block', width: '100%', padding: '8px 16px 8px 28px',
                border: 'none', borderLeft: '3px solid transparent',
                borderBottom: `1px solid ${dark ? '#1B2336' : '#D0CBC0'}`,
                background: 'transparent', textAlign: 'left', cursor: 'pointer',
              }}
              onMouseEnter={e => e.currentTarget.style.background = dark ? '#1B2336' : '#DDD8CE'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <StatusPill variant={tkt.status} theme={theme} style={{ fontSize: 9, padding: '1px 5px' }} />
              </div>
              <div style={{ fontFamily: '"Inter", sans-serif', fontSize: 11, color: dark ? '#CBD5E1' : '#2A3040', lineHeight: 1.4 }}>{tkt.title}</div>
              <MonoId theme={theme}>{tkt.id}</MonoId>
            </button>
          ))}
        </div>
      </nav>

      {/* Right area: Scope + Conversation */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', gap: 0 }}>
        {/* Scope document */}
        <div style={{
          width: 420,
          flexShrink: 0,
          borderRight: `1px solid ${borderColor}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}>
          <Panel theme={theme} style={{ flex: 1, overflow: 'hidden', border: 'none' }}>
            <PanelHead theme={theme}>
              <PanelTitle theme={theme}>Scope document</PanelTitle>
              <Count theme={theme}>SCOPE.md</Count>
              <Spacer />
              <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor }}>
                read-only · edited on disk
              </span>
            </PanelHead>
            <div style={{ overflowY: 'auto', flex: 1, padding: '16px 20px' }}>
              <pre style={{
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                lineHeight: 1.8,
                color: dark ? '#CBD5E1' : '#2A3040',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}>
                {SCOPE_TEXT}
              </pre>
            </div>
          </Panel>
        </div>

        {/* Conversation */}
        <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <Panel theme={theme} style={{ flex: 1, overflow: 'hidden', border: 'none' }}>
            <PanelHead theme={theme}>
              <PanelTitle theme={theme}>Conversation</PanelTitle>
              <Count theme={theme}>{entries.length} entries</Count>
              <Spacer />
              <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor }}>newest last</span>
            </PanelHead>

            {/* Messages */}
            <div
              ref={conversationRef}
              style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column' }}
            >
              {entries.map((entry, idx) => {
                const cfg = ENTRY_STYLE[entry.type] ?? ENTRY_STYLE.scope_updated
                const isOwner = entry.type === 'owner_message'
                const isSystem = entry.type === 'scope_updated'

                return (
                  <article
                    key={entry.id}
                    style={{
                      padding: '14px 20px',
                      borderBottom: `1px solid ${dark ? '#1B2336' : '#D0CBC0'}`,
                      borderLeft: `3px solid ${cfg.borderColor}`,
                      background: isOwner
                        ? (dark ? '#0C1A2E' : '#E4EDF8')
                        : isSystem
                        ? (dark ? '#0C1020' : '#E8E4DC')
                        : 'transparent',
                      display: 'flex',
                      gap: 12,
                      animation: idx === entries.length - 1 ? 'new-entry 0.3s ease' : undefined,
                    }}
                  >
                    {/* Agent glyph for non-owner, non-system entries */}
                    {!isOwner && !isSystem && entry.agentState && (
                      <div style={{ flexShrink: 0, paddingTop: 2 }}>
                        <MagarineGlyph size={24} state={entry.agentState} theme={theme} />
                      </div>
                    )}

                    <div style={{ flex: 1 }}>
                      {/* Who + timestamp */}
                      <div style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 10,
                        marginBottom: 6,
                      }}>
                        <span style={{
                          fontFamily: '"JetBrains Mono", monospace',
                          fontSize: 11,
                          fontWeight: 700,
                          color: cfg.borderColor,
                          letterSpacing: '0.02em',
                        }}>
                          {entry.who}
                        </span>
                        <span style={{
                          fontFamily: '"JetBrains Mono", monospace',
                          fontSize: 10,
                          color: faintColor,
                        }}>
                          {entry.timestamp.replace('T', ' ').replace('.', '').slice(0, 23)}
                        </span>
                        <Spacer />
                        <span style={{
                          fontFamily: '"JetBrains Mono", monospace',
                          fontSize: 9,
                          color: faintColor,
                          letterSpacing: '0.06em',
                          textTransform: 'uppercase',
                          border: `1px solid ${dark ? '#2D3B55' : '#C8C0B4'}`,
                          padding: '1px 5px',
                        }}>
                          {cfg.label}
                        </span>
                      </div>

                      {/* Text */}
                      <div style={{
                        fontFamily: isSystem ? '"JetBrains Mono", monospace' : '"Inter", sans-serif',
                        fontSize: isSystem ? 11 : 13,
                        color: isSystem ? faintColor : (dark ? '#CBD5E1' : '#2A3040'),
                        lineHeight: 1.7,
                      }}>
                        {/* Highlight mono refs */}
                        {entry.text.split(/(`[^`]+`)/).map((part, i) =>
                          part.startsWith('`') && part.endsWith('`') ? (
                            <code key={i} style={{
                              fontFamily: '"JetBrains Mono", monospace',
                              fontSize: 11,
                              color: cfg.borderColor,
                              background: dark ? '#0C1422' : '#E0DBCF',
                              padding: '1px 4px',
                            }}>{part.slice(1, -1)}</code>
                          ) : (
                            <span key={i}>{part}</span>
                          )
                        )}
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>

            {/* Input */}
            <div style={{
              padding: '12px 16px',
              borderTop: `2px solid ${borderColor}`,
              background: dark ? '#0C1422' : '#E0DBCF',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-end',
              flexShrink: 0,
            }}>
              <div style={{ flex: 1, position: 'relative' }}>
                <div style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 10,
                  color: faintColor,
                  marginBottom: 4,
                  letterSpacing: '0.04em',
                }}>
                  → to Manager
                </div>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      sendMessage()
                    }
                  }}
                  placeholder="Instruct the Manager, ask a question, change the scope..."
                  rows={2}
                  style={{
                    width: '100%',
                    padding: '8px 10px',
                    border: `1px solid ${dark ? '#3D4F6E' : '#AAAAAA'}`,
                    background: dark ? '#080C14' : '#F0EDE6',
                    color: dark ? '#E8EDF5' : '#1A1F2E',
                    fontFamily: '"Inter", sans-serif',
                    fontSize: 13,
                    resize: 'none',
                    outline: 'none',
                    lineHeight: 1.5,
                  }}
                  onFocus={e => e.target.style.borderColor = '#22C55E'}
                  onBlur={e => e.target.style.borderColor = dark ? '#3D4F6E' : '#AAAAAA'}
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 0 }}>
                <Btn theme={theme} variant="primary" onClick={sendMessage}>Send</Btn>
                <span style={{
                  fontFamily: '"JetBrains Mono", monospace',
                  fontSize: 9,
                  color: faintColor,
                  textAlign: 'center',
                }}>⏎ send</span>
              </div>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  )
}
