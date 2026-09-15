import { useState } from 'react'
import type { Theme, Screen } from '../App'
import {
  StatusPill, MagarineGlyph, Panel, PanelHead, PanelTitle, Count,
  Spacer, MonoId, Btn, Tag
} from '../App'

interface InboxItem {
  id: string
  shortId: string
  type: 'decision' | 'review' | 'approval'
  status: 'blocked' | 'review'
  timestamp: string
  agentName: string
  agentState: 'blocked' | 'thinking' | 'waiting'
  context: string
  question: string
  inputLabel: string
}

const INBOX_ITEMS: InboxItem[] = [
  {
    id: 'tkt_ed46cad3-6810-4de4-a54e-7f913acdd19f',
    shortId: 'tkt_ed46cad3',
    type: 'decision',
    status: 'blocked',
    timestamp: '06:44:21 UTC',
    agentName: 'Agent',
    agentState: 'blocked',
    context: 'Writing SQLite journal mode reference documents. Completed delete.md and wal.md.',
    question: 'The scope says one file per journal mode, but it does not say whether memory.md should cover the in-memory journal or the in-memory database, and those are two different features. I have written delete.md and wal.md already and can finish either way in about the same time. Tell me which you meant and I will write it.',
    inputLabel: 'Your decision',
  },
  {
    id: 'tkt_9ef76af6-5d02-43c2-96b6-34ee19aa8b2d',
    shortId: 'tkt_9ef76af6',
    type: 'review',
    status: 'review',
    timestamp: '08:12:44 UTC',
    agentName: 'Agent',
    agentState: 'thinking',
    context: 'Write-ahead logging documentation. Completed draft at 380 words.',
    question: 'wal.md is complete and ready for your review. The file covers commit behaviour, fsync cost, reader/writer concurrency, and the network-filesystem failure mode. It came in at 380 words, within the scope limit.',
    inputLabel: 'Feedback or approval',
  },
  {
    id: 'spend-cap',
    shortId: 'proj_393c405c',
    type: 'approval',
    status: 'blocked',
    timestamp: '08:45:00 UTC',
    agentName: 'Orchestrator',
    agentState: 'waiting',
    context: 'Starting tkt_1b70e2a4 would bring the project to $12.40 (cap $12.00).',
    question: 'Spend cap reached. Starting the next ticket would exceed the project limit. Raise the cap to continue, or leave it as-is to pause here.',
    inputLabel: 'New maximum spend (USD)',
  },
]

export default function NeedsYou({ theme, setScreen }: { theme: Theme; setScreen: (s: Screen) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const dark = theme === 'dark'
  const borderColor = dark ? '#2D3B55' : '#C8C0B4'
  const bgMain = dark ? '#080C14' : '#F0EDE6'
  const bgSurface = dark ? '#0F172A' : '#E8E4DC'
  const faintColor = dark ? '#4A5A72' : '#8A9AB5'
  const mutedColor = dark ? '#7A8BA8' : '#6A7080'

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', background: bgMain }}>
      {/* Fleet sidebar (minimal version) */}
      <nav aria-label="Fleet" style={{
        width: 268,
        flexShrink: 0,
        borderRight: `2px solid ${borderColor}`,
        background: bgSurface,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        <div style={{
          padding: '10px 16px',
          borderBottom: `1px solid ${borderColor}`,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: faintColor }}>Fleet</span>
        </div>

        <div style={{ overflowY: 'auto', flex: 1 }}>
          <div style={{ padding: '8px 16px 4px', fontFamily: '"JetBrains Mono", monospace', fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: faintColor }}>Projects</div>

          <button style={{
            display: 'block', width: '100%', padding: '10px 16px',
            border: 'none', borderLeft: `3px solid #F59E0B`,
            borderBottom: `1px solid ${borderColor}`,
            background: dark ? '#1B1810' : '#E8DED0',
            textAlign: 'left', cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <MagarineGlyph size={20} state="waiting" theme={theme} />
              <span style={{ fontFamily: '"Inter", sans-serif', fontSize: 13, fontWeight: 600, color: dark ? '#E8EDF5' : '#1A1F2E' }}>UI Walk</span>
              <StatusPill variant="blocked" theme={theme} style={{ fontSize: 9, padding: '1px 6px' }}>Paused</StatusPill>
            </div>
            <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor }}>proj_393c405c</div>
          </button>

          {/* Tickets */}
          {[
            { id: 'tkt_ed46cad3', title: 'Needs a decision from the owner', status: 'blocked' as const, current: true },
            { id: 'tkt_98f609d3', title: '# Scope: SQLite journal modes', status: 'failed' as const, mgr: true },
            { id: 'tkt_9ef76af6', title: 'Write wal.md — write-ahead logging', status: 'review' as const },
            { id: 'tkt_1b70e2a4', title: 'Write index.md linking all three modes', status: 'open' as const },
            { id: 'tkt_72f34caf', title: 'Write the introduction section', status: 'done' as const },
            { id: 'tkt_5c0a91de', title: 'Write memory.md — in-memory journal', status: 'cancelled' as const },
          ].map(tkt => (
            <button
              key={tkt.id}
              style={{
                display: 'block', width: '100%', padding: '8px 16px 8px 28px',
                border: 'none',
                borderLeft: tkt.current ? `3px solid #F59E0B` : '3px solid transparent',
                borderBottom: `1px solid ${dark ? '#1B2336' : '#D0CBC0'}`,
                background: tkt.current ? (dark ? '#1B1810' : '#E8DED0') : 'transparent',
                textAlign: 'left', cursor: 'pointer',
              }}
              onMouseEnter={e => { if (!tkt.current) e.currentTarget.style.background = dark ? '#1B2336' : '#DDD8CE' }}
              onMouseLeave={e => { if (!tkt.current) e.currentTarget.style.background = 'transparent' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                <StatusPill variant={tkt.status} theme={theme} style={{ fontSize: 9, padding: '1px 5px' }} />
                {(tkt as any).mgr && <Tag theme={theme}>MGR</Tag>}
              </div>
              <div style={{ fontFamily: '"Inter", sans-serif', fontSize: 11, color: dark ? '#CBD5E1' : '#2A3040', lineHeight: 1.4 }}>
                {tkt.title.replace(/^# /, '')}
              </div>
              <MonoId theme={theme}>{tkt.id}</MonoId>
            </button>
          ))}
        </div>
      </nav>

      {/* Needs You main area */}
      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', padding: 16, gap: 12 }}>
        {/* Paused banner */}
        <div style={{
          padding: '12px 16px',
          border: `1px solid #F59E0B`,
          borderLeft: `4px solid #F59E0B`,
          background: dark ? '#1A140A' : '#FEF3C7',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          flexShrink: 0,
          animation: 'new-entry 0.3s ease',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            fontWeight: 700,
            color: '#F59E0B',
            letterSpacing: '0.02em',
          }}>
            <span>[!]</span>
            <span>Paused — spend cap reached</span>
          </div>
          <div style={{
            fontFamily: '"Inter", sans-serif',
            fontSize: 12,
            color: dark ? '#CBD5E1' : '#2A3040',
            lineHeight: 1.6,
          }}>
            Starting <code style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: '#F59E0B' }}>tkt_1b70e2a4-3fd1-49b7-b2c9-0e42a4f7c188</code> would bring the project to{' '}
            <strong>$12.40</strong> (cap $12.00). Raise it to continue.
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="number"
              step="0.01"
              placeholder="new max spend (usd)"
              style={{
                padding: '5px 10px',
                border: `1px solid #F59E0B44`,
                background: dark ? '#0F0A00' : '#FFFBEB',
                color: dark ? '#E8EDF5' : '#1A1F2E',
                fontFamily: '"JetBrains Mono", monospace',
                fontSize: 11,
                width: 180,
                outline: 'none',
              }}
            />
            <Btn theme={theme} variant="primary">Raise cap</Btn>
          </div>
        </div>

        <Panel theme={theme} style={{ flex: 1, overflow: 'hidden' }}>
          <PanelHead theme={theme}>
            <PanelTitle theme={theme}>Needs You</PanelTitle>
            <Count theme={theme}>{INBOX_ITEMS.length} items</Count>
            <Spacer />
            <span style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 10,
              color: faintColor,
              animation: 'blocked-flash 3s ease-in-out infinite',
            }}>
              ● system paused
            </span>
          </PanelHead>

          <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column' }}>
            {INBOX_ITEMS.map((item, idx) => (
              <InboxCard
                key={item.id}
                item={item}
                theme={theme}
                answer={answers[item.id] ?? ''}
                setAnswer={v => setAnswers(a => ({ ...a, [item.id]: v }))}
                isLast={idx === INBOX_ITEMS.length - 1}
              />
            ))}
          </div>
        </Panel>
      </main>
    </div>
  )
}

function InboxCard({ item, theme, answer, setAnswer, isLast }: {
  item: InboxItem
  theme: Theme
  answer: string
  setAnswer: (v: string) => void
  isLast: boolean
}) {
  const dark = theme === 'dark'
  const borderColor = dark ? '#2D3B55' : '#C8C0B4'
  const faintColor = dark ? '#4A5A72' : '#8A9AB5'

  const accentColor = item.status === 'blocked' ? '#F59E0B'
    : item.status === 'review' ? '#A855F7'
    : '#38BDF8'

  return (
    <article style={{
      padding: '16px 20px',
      borderBottom: isLast ? 'none' : `1px solid ${borderColor}`,
      borderLeft: `4px solid ${accentColor}`,
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <MagarineGlyph size={28} state={item.agentState} theme={theme} />
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <StatusPill variant={item.status} theme={theme} />
            <span style={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              fontWeight: 600,
              color: dark ? '#E8EDF5' : '#1A1F2E',
            }}>
              {item.agentName}
            </span>
            <MonoId theme={theme}>{item.shortId}</MonoId>
            <Spacer />
            <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10, color: faintColor }}>
              {item.timestamp}
            </span>
          </div>
          <div style={{
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 10,
            color: faintColor,
            letterSpacing: '0.02em',
          }}>
            {item.context}
          </div>
        </div>
      </div>

      {/* Message */}
      <div style={{
        fontFamily: '"Inter", sans-serif',
        fontSize: 13,
        color: dark ? '#CBD5E1' : '#2A3040',
        lineHeight: 1.7,
        padding: '10px 14px',
        background: dark ? '#0C1422' : '#E0DBCF',
        borderLeft: `2px solid ${accentColor}44`,
      }}>
        {item.question}
      </div>

      {/* Answer row */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          type={item.type === 'approval' ? 'number' : 'text'}
          step={item.type === 'approval' ? '0.01' : undefined}
          placeholder={item.inputLabel}
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          style={{
            flex: 1,
            padding: '6px 10px',
            border: `1px solid ${dark ? '#3D4F6E' : '#AAAAAA'}`,
            background: dark ? '#0C1422' : '#E0DBCF',
            color: dark ? '#E8EDF5' : '#1A1F2E',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            outline: 'none',
          }}
          onFocus={e => e.target.style.borderColor = accentColor}
          onBlur={e => e.target.style.borderColor = dark ? '#3D4F6E' : '#AAAAAA'}
        />
        <Btn theme={theme} variant="primary">
          {item.type === 'decision' ? 'Answer' : item.type === 'review' ? 'Approve' : 'Raise cap'}
        </Btn>
        {item.type === 'review' && (
          <Btn theme={theme} variant="ghost">Request changes</Btn>
        )}
      </div>
    </article>
  )
}
