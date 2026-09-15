import { useState } from 'react'
import type { Theme, Screen } from '../App'
import {
  StatusPill, MagarineGlyph, Panel, PanelHead, PanelTitle, Count,
  Spacer, MonoId, Tag, Btn, type StatusVariant, type AgentState
} from '../App'

interface Ticket {
  id: string
  shortId: string
  title: string
  status: StatusVariant
  attempts: string
  cost: string
  costLive?: boolean
  mgr?: boolean
  blockedBy?: string
  failReason?: string
  model?: string
  artifacts?: { kind: string; name: string }[]
  action?: 'answer' | 'retry' | 'cancel'
}

const TICKETS: Ticket[] = [
  {
    id: 'tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f',
    shortId: 'tkt_ed46cad3',
    title: 'Needs a decision from the owner',
    status: 'blocked',
    attempts: '0/3',
    cost: '$0.00',
    action: 'answer',
  },
  {
    id: 'tkt_98f609d3-c704-4936-a96b-8591536a3990',
    shortId: 'tkt_98f609d3',
    title: '# Scope: a small reference on SQLite journal modes',
    status: 'failed',
    attempts: '3/3',
    cost: '$0.25',
    mgr: true,
    failReason: 'proposal must be a JSON object — magarine retry --ticket tkt_98f609d3 once the reason above is addressed',
    action: 'retry',
  },
  {
    id: 'tkt_9ef76af6-5d02-43c2-96b6-34ee19aa8b2d',
    shortId: 'tkt_9ef76af6',
    title: 'Write wal.md covering write-ahead logging',
    status: 'in_progress',
    attempts: '1/3',
    cost: 'at least $0.12',
    costLive: true,
    model: 'claude-haiku-4-5-20251001',
    action: 'cancel',
  },
  {
    id: 'tkt_94c9ca9e-4ee6-4e5f-a087-d738ea645e46',
    shortId: 'tkt_94c9ca9e',
    title: 'Manager: discuss: Typed from a real browser: please keep it short.',
    status: 'ready',
    attempts: '2/3',
    cost: '$0.00',
    mgr: true,
    blockedBy: 'tkt_9ef76af6-5d02-43c2-96b6-34ee19aa8b2d',
  },
  {
    id: 'tkt_72f34caf-f94c-489f-ab8a-4a4c30ee24af',
    shortId: 'tkt_72f34caf',
    title: 'Write the introduction section',
    status: 'done',
    attempts: '0/3',
    cost: '$0.00',
    artifacts: [
      { kind: 'file', name: 'introduction.md' },
      { kind: 'file', name: 'index.md' },
    ],
  },
]

const STATUS_TO_AGENT: Record<StatusVariant, AgentState> = {
  blocked: 'blocked',
  failed: 'failed',
  in_progress: 'working',
  review: 'thinking',
  ready: 'waiting',
  done: 'done',
  open: 'waiting',
  cancelled: 'done',
}

const STATUS_LABEL: Record<StatusVariant, string> = {
  blocked: 'Blocked',
  failed: 'Failed',
  in_progress: 'Working',
  review: 'Review',
  ready: 'Queued',
  done: 'Done',
  open: 'Open',
  cancelled: 'Cancelled',
}

export default function FleetBoard({ theme, setScreen }: { theme: Theme; setScreen: (s: Screen) => void }) {
  const [expandedNote, setExpandedNote] = useState<string | null>(null)
  const dark = theme === 'dark'
  const borderColor = dark ? '#2D3B55' : '#C8C0B4'
  const bgMain = dark ? '#080C14' : '#F0EDE6'
  const bgSurface = dark ? '#0F172A' : '#E8E4DC'
  const mutedColor = dark ? '#7A8BA8' : '#6A7080'
  const faintColor = dark ? '#4A5A72' : '#8A9AB5'

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
        {/* Fleet header */}
        <div style={{
          padding: '10px 16px',
          borderBottom: `1px solid ${borderColor}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: faintColor,
          }}>Fleet</span>
          <Spacer />
          <span style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            color: faintColor,
          }}>2 projects</span>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          {/* Section label */}
          <div style={{
            padding: '8px 16px 4px',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: faintColor,
          }}>
            Projects
          </div>

          {/* Active project */}
          <button style={{
            display: 'block',
            width: '100%',
            padding: '10px 16px',
            border: 'none',
            borderLeft: `3px solid #22C55E`,
            borderBottom: `1px solid ${borderColor}`,
            background: dark ? '#1B2336' : '#DDD8CE',
            textAlign: 'left',
            cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <MagarineGlyph size={20} state="working" theme={theme} />
              <span style={{
                fontFamily: '"Inter", sans-serif',
                fontSize: 13,
                fontWeight: 600,
                color: dark ? '#E8EDF5' : '#1A1F2E',
              }}>UI Walk</span>
              <StatusPill variant="in_progress" theme={theme} style={{ fontSize: 9, padding: '1px 6px' }}>
                Working
              </StatusPill>
            </div>
            <div style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
              color: faintColor,
            }}>proj_393c405c</div>
          </button>

          {/* Ticket children */}
          <div style={{ borderBottom: `1px solid ${borderColor}` }}>
            {TICKETS.map(tkt => (
              <button
                key={tkt.id}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '8px 16px 8px 28px',
                  border: 'none',
                  borderBottom: `1px solid ${dark ? '#1B2336' : '#D0CBC0'}`,
                  background: 'transparent',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={e => e.currentTarget.style.background = dark ? '#1B2336' : '#DDD8CE'}
                onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <StatusPill variant={tkt.status} theme={theme} style={{ fontSize: 9, padding: '1px 5px' }} />
                  {tkt.mgr && <Tag theme={theme}>MGR</Tag>}
                </div>
                <div style={{
                  fontFamily: '"Inter", sans-serif',
                  fontSize: 11,
                  color: dark ? '#CBD5E1' : '#2A3040',
                  lineHeight: 1.4,
                  marginBottom: 4,
                }}>
                  {tkt.title.replace(/^# /, '')}
                </div>
                <MonoId theme={theme}>{tkt.shortId}</MonoId>
              </button>
            ))}
          </div>

          {/* Other project */}
          <div style={{ padding: '8px 16px 4px', fontFamily: '"JetBrains Mono", monospace', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: faintColor }}>
            Other projects
          </div>
          <button style={{
            display: 'block',
            width: '100%',
            padding: '10px 16px',
            border: 'none',
            borderLeft: `3px solid transparent`,
            borderBottom: `1px solid ${borderColor}`,
            background: 'transparent',
            textAlign: 'left',
            cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <MagarineGlyph size={20} state="waiting" theme={theme} />
              <span style={{ fontFamily: '"Inter", sans-serif', fontSize: 13, fontWeight: 600, color: dark ? '#E8EDF5' : '#1A1F2E' }}>
                SQLite reference
              </span>
            </div>
            <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor }}>proj_396d8ad0</div>
          </button>
        </div>
      </nav>

      {/* Board */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
        {/* Cost note */}
        <div style={{
          padding: '8px 14px',
          border: `1px solid ${dark ? '#2D3B55' : '#C8C0B4'}`,
          background: dark ? '#0F172A' : '#E8E4DC',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}>
          <span style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            color: faintColor,
          }}>
            ↳ Equivalent API cost: <strong style={{ color: dark ? '#E8EDF5' : '#1A1F2E' }}>$0.37</strong> (no cap set) — subscription session limits apply, not dollars
          </span>
        </div>

        <Panel theme={theme} style={{ flex: 1, overflow: 'hidden' }}>
          <PanelHead theme={theme}>
            <PanelTitle theme={theme}>Board</PanelTitle>
            <Count theme={theme}>5 tickets</Count>
            <Spacer />
            <StatusPill variant="in_progress" theme={theme} style={{ fontSize: 9 }}>1 running</StatusPill>
          </PanelHead>

          {/* Table */}
          <div style={{ overflowY: 'auto', flex: 1 }}>
            <table style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
            }}>
              <colgroup>
                <col style={{ width: '36%' }} />
                <col style={{ width: '18%' }} />
                <col style={{ width: '10%' }} />
                <col style={{ width: '16%' }} />
                <col style={{ width: '12%' }} />
                <col style={{ width: '8%' }} />
              </colgroup>
              <thead>
                <tr style={{ borderBottom: `2px solid ${borderColor}` }}>
                  {['', 'Ticket', 'Status', 'Att.', 'Cost', 'Action'].map((h, i) => (
                    <th key={i} style={{
                      padding: '8px 12px',
                      textAlign: i >= 3 ? 'right' : 'left',
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      textTransform: 'uppercase',
                      color: faintColor,
                      background: dark ? '#0C1422' : '#E0DBCF',
                      whiteSpace: 'nowrap',
                    }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {TICKETS.map((tkt, i) => (
                  <tr
                    key={tkt.id}
                    style={{
                      borderBottom: `1px solid ${dark ? '#1B2336' : '#D0CBC0'}`,
                      background: tkt.status === 'in_progress'
                        ? (dark ? '#0F1E1A' : '#E0F0E8')
                        : i % 2 === 1 ? (dark ? '#0C1422' : '#EAE6DE') : 'transparent',
                      transition: 'background 0.1s',
                    }}
                    onMouseEnter={e => {
                      if (tkt.status !== 'in_progress')
                        e.currentTarget.style.background = dark ? '#1B2336' : '#DDD8CE'
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = tkt.status === 'in_progress'
                        ? (dark ? '#0F1E1A' : '#E0F0E8')
                        : i % 2 === 1 ? (dark ? '#0C1422' : '#EAE6DE') : 'transparent'
                    }}
                  >
                    {/* Agent glyph */}
                    <td style={{ padding: '10px 8px 10px 12px', width: 28 }}>
                      <MagarineGlyph
                        size={20}
                        state={STATUS_TO_AGENT[tkt.status]}
                        theme={theme}
                      />
                    </td>

                    {/* Title */}
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        {tkt.mgr && <Tag theme={theme}>MGR</Tag>}
                        <span style={{
                          fontFamily: '"Inter", sans-serif',
                          fontSize: 12,
                          color: dark ? '#CBD5E1' : '#2A3040',
                          lineHeight: 1.4,
                        }}>
                          {tkt.title.replace(/^# /, '')}
                        </span>
                      </div>
                      <MonoId theme={theme}>{tkt.id}</MonoId>

                      {tkt.blockedBy && (
                        <div style={{ marginTop: 4, fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor }}>
                          blocked by <span style={{ color: mutedColor }}>{tkt.blockedBy}</span>
                        </div>
                      )}

                      {tkt.model && (
                        <div
                          style={{
                            marginTop: 4,
                            fontFamily: '"JetBrains Mono", monospace',
                            fontSize: 10,
                            color: faintColor,
                            cursor: 'pointer',
                          }}
                          onClick={() => setExpandedNote(expandedNote === tkt.id ? null : tkt.id)}
                        >
                          ▸ model {tkt.model}
                          {expandedNote === tkt.id && (
                            <div style={{
                              marginTop: 4,
                              padding: '6px 10px',
                              background: dark ? '#0C1422' : '#E0DBCF',
                              border: `1px solid ${borderColor}`,
                              color: mutedColor,
                              animation: 'new-entry 0.15s ease',
                            }}>
                              Mechanical writing task with a fully fixed spec — no design judgment required.
                            </div>
                          )}
                        </div>
                      )}

                      {tkt.failReason && (
                        <div
                          style={{
                            marginTop: 4,
                            fontFamily: '"JetBrains Mono", monospace',
                            fontSize: 10,
                            color: faintColor,
                            cursor: 'pointer',
                          }}
                          onClick={() => setExpandedNote(expandedNote === tkt.id ? null : tkt.id)}
                        >
                          ▸ why it failed
                          {expandedNote === tkt.id && (
                            <div style={{
                              marginTop: 4,
                              padding: '6px 10px',
                              background: dark ? '#1A0A0A' : '#F0E0E0',
                              border: `1px solid #EF444444`,
                              color: '#EF4444',
                              animation: 'new-entry 0.15s ease',
                            }}>
                              {tkt.failReason}
                            </div>
                          )}
                        </div>
                      )}

                      {tkt.artifacts && (
                        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
                          {tkt.artifacts.map(a => (
                            <span key={a.name} style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '1px 7px',
                              border: `1px solid ${dark ? '#3D4F6E' : '#AAAAAA'}`,
                              fontFamily: '"JetBrains Mono", monospace',
                              fontSize: 10,
                              color: mutedColor,
                            }}>
                              <span style={{ color: faintColor }}>{a.kind}</span> {a.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>

                    {/* Status */}
                    <td style={{ padding: '10px 12px' }}>
                      <StatusPill variant={tkt.status} theme={theme} />
                    </td>

                    {/* Attempts */}
                    <td style={{
                      padding: '10px 12px',
                      textAlign: 'right',
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 11,
                      color: tkt.attempts.startsWith('3') ? '#EF4444' : mutedColor,
                    }}>
                      {tkt.attempts}
                    </td>

                    {/* Cost */}
                    <td style={{
                      padding: '10px 12px',
                      textAlign: 'right',
                      fontFamily: '"JetBrains Mono", monospace',
                      fontSize: 11,
                      color: tkt.cost !== '$0.00' ? (dark ? '#E8EDF5' : '#1A1F2E') : faintColor,
                    }}>
                      {tkt.cost}
                      {tkt.costLive && (
                        <div style={{ fontSize: 10, color: faintColor }}>live est.</div>
                      )}
                    </td>

                    {/* Action */}
                    <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                      {tkt.action === 'answer' && (
                        <Btn theme={theme} variant="default" onClick={() => {}}>Answer</Btn>
                      )}
                      {tkt.action === 'retry' && (
                        <Btn theme={theme} variant="default" onClick={() => {}}>Retry</Btn>
                      )}
                      {tkt.action === 'cancel' && (
                        <Btn theme={theme} variant="ghost" onClick={() => {}}>Cancel</Btn>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Activity strip */}
        <div style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          padding: '6px 12px',
          border: `1px solid ${borderColor}`,
          background: dark ? '#0F172A' : '#E8E4DC',
          overflow: 'hidden',
        }}>
          <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor, flexShrink: 0 }}>
            ACTIVITY
          </span>
          {[
            { time: '08:45:10', msg: 'tkt_9ef76af6 → writing wal.md', color: '#22C55E' },
            { time: '08:44:58', msg: 'tkt_98f609d3 → failed: invalid JSON proposal', color: '#EF4444' },
            { time: '08:44:21', msg: 'tkt_ed46cad3 → blocked: awaiting decision', color: '#F59E0B' },
            { time: '08:44:01', msg: 'tkt_72f34caf → done', color: '#4A5A72' },
          ].map((evt, i) => (
            <span key={i} style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
              color: evt.color,
              flexShrink: 0,
              animation: i === 0 ? 'new-entry 0.3s ease' : undefined,
            }}>
              <span style={{ color: faintColor }}>{evt.time}</span> {evt.msg}
            </span>
          ))}
        </div>
      </main>
    </div>
  )
}
