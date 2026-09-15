import { useState, useEffect, useRef } from 'react'
import FleetBoard from './screens/FleetBoard'
import NeedsYou from './screens/NeedsYou'
import ScopeConversation from './screens/ScopeConversation'

export type Screen = 'fleet-board' | 'needs-you' | 'scope'
export type Theme = 'dark' | 'light'

export default function App() {
  const [screen, setScreen] = useState<Screen>('fleet-board')
  const [theme, setTheme] = useState<Theme>('dark')

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  return (
    <div className="flex flex-col h-screen overflow-hidden" style={{
      background: theme === 'dark' ? '#080C14' : '#F0EDE6',
      color: theme === 'dark' ? '#E8EDF5' : '#1A1F2E',
    }}>
      <Topbar
        screen={screen}
        setScreen={setScreen}
        theme={theme}
        setTheme={setTheme}
      />
      <div className="flex flex-1 overflow-hidden">
        {screen === 'fleet-board' && <FleetBoard theme={theme} setScreen={setScreen} />}
        {screen === 'needs-you' && <NeedsYou theme={theme} setScreen={setScreen} />}
        {screen === 'scope' && <ScopeConversation theme={theme} setScreen={setScreen} />}
      </div>
    </div>
  )
}

function Topbar({ screen, setScreen, theme, setTheme }: {
  screen: Screen
  setScreen: (s: Screen) => void
  theme: Theme
  setTheme: (t: Theme) => void
}) {
  const dark = theme === 'dark'
  const borderColor = dark ? '#2D3B55' : '#C8C0B4'
  const bgColor = dark ? '#0F172A' : '#E8E4DC'
  const faintColor = dark ? '#4A5A72' : '#8A8070'
  const mutedColor = dark ? '#7A8BA8' : '#6A7080'

  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      gap: 0,
      height: 40,
      borderBottom: `2px solid ${borderColor}`,
      background: bgColor,
      flexShrink: 0,
      paddingLeft: 0,
    }}>
      {/* Brand */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        height: '100%',
        borderRight: `1px solid ${borderColor}`,
        flexShrink: 0,
      }}>
        <MagarineGlyph size={16} active={true} state="working" theme={theme} />
        <span style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontWeight: 700,
          fontSize: 13,
          letterSpacing: '-0.02em',
          color: dark ? '#E8EDF5' : '#1A1F2E',
        }}>Magarine</span>
      </div>

      {/* Project */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        height: '100%',
        borderRight: `1px solid ${borderColor}`,
        flexShrink: 0,
      }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>UI Walk</span>
        <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, color: faintColor }}>
          proj_393c405c
        </span>
      </div>

      {/* Nav tabs */}
      <nav style={{ display: 'flex', alignItems: 'stretch', height: '100%', flexShrink: 0 }}>
        {([
          ['fleet-board', 'Fleet & Board'],
          ['needs-you', 'Needs You'],
          ['scope', 'Scope'],
        ] as [Screen, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setScreen(id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 16px',
              border: 'none',
              borderRight: `1px solid ${borderColor}`,
              borderBottom: screen === id ? `2px solid ${dark ? '#22C55E' : '#16A34A'}` : '2px solid transparent',
              background: screen === id
                ? (dark ? '#1B2336' : '#DDD8CE')
                : 'transparent',
              color: screen === id
                ? (dark ? '#E8EDF5' : '#1A1F2E')
                : mutedColor,
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11,
              fontWeight: screen === id ? 600 : 400,
              cursor: 'pointer',
              letterSpacing: '0.02em',
              transition: 'background 0.1s, color 0.1s',
            }}
          >
            {id === 'needs-you' && (
              <span style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: '#F59E0B',
                marginRight: 6,
                animation: 'blocked-flash 2s ease-in-out infinite',
              }} />
            )}
            {label}
          </button>
        ))}
      </nav>

      <div style={{ flex: 1 }} />

      {/* Meta */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '0 16px',
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 11,
          color: mutedColor,
        }}>last refreshed 8:45:17 AM</span>

        <StatusPill variant="done" theme={theme} style={{ fontSize: 10 }}>$0.37 equiv</StatusPill>

        <button
          style={{
            padding: '3px 10px',
            border: `1px solid ${borderColor}`,
            background: 'transparent',
            color: mutedColor,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 11,
            cursor: 'pointer',
            letterSpacing: '0.02em',
          }}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </div>
    </header>
  )
}

// ─── Shared primitives ──────────────────────────────────────────────────────

export type StatusVariant = 'blocked' | 'failed' | 'in_progress' | 'review' | 'ready' | 'done' | 'open' | 'cancelled'

const STATUS_CONFIG: Record<StatusVariant, { label: string; color: string; filled: boolean }> = {
  blocked:     { label: 'Blocked',     color: '#F59E0B', filled: true },
  failed:      { label: 'Failed',      color: '#EF4444', filled: true },
  in_progress: { label: 'In progress', color: '#22C55E', filled: true },
  review:      { label: 'Review',      color: '#A855F7', filled: true },
  ready:       { label: 'Ready',       color: '#38BDF8', filled: true },
  done:        { label: 'Done',        color: '#4A5A72', filled: false },
  open:        { label: 'Open',        color: '#4A5A72', filled: false },
  cancelled:   { label: 'Cancelled',   color: '#4A5A72', filled: false },
}

export function StatusPill({ variant, theme, children, style }: {
  variant: StatusVariant
  theme: Theme
  children?: React.ReactNode
  style?: React.CSSProperties
}) {
  const cfg = STATUS_CONFIG[variant]
  const dark = theme === 'dark'

  if (cfg.filled) {
    return (
      <span style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        background: cfg.color,
        color: '#080C14',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        userSelect: 'none',
        ...(variant === 'in_progress' && {
          animation: 'status-pulse 2s ease-in-out infinite',
        }),
        ...style,
      }}>
        <span style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: '#080C14',
          opacity: 0.6,
          flexShrink: 0,
        }} />
        {children ?? cfg.label}
      </span>
    )
  }

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      padding: '2px 8px',
      border: `1px solid ${cfg.color}`,
      color: cfg.color,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 11,
      fontWeight: 500,
      letterSpacing: '0.04em',
      textTransform: 'uppercase',
      userSelect: 'none',
      ...style,
    }}>
      <span style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        border: `1px solid ${cfg.color}`,
        flexShrink: 0,
      }} />
      {children ?? cfg.label}
    </span>
  )
}

export type AgentState = 'thinking' | 'reading' | 'planning' | 'working' | 'writing' | 'testing' | 'waiting' | 'blocked' | 'done' | 'failed'

// Pixel-grid agent presence — 8×8 computational entity
export function MagarineGlyph({ size = 24, state = 'waiting', active = false, theme }: {
  size?: number
  state?: AgentState
  active?: boolean
  theme: Theme
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef(0)
  const tickRef = useRef(0)
  const dark = theme === 'dark'

  const GRID = 8
  const CELL = size / GRID

  const stateColor: Record<AgentState, string> = {
    thinking:  '#38BDF8',
    reading:   '#22C55E',
    planning:  '#A855F7',
    working:   '#22C55E',
    writing:   '#F59E0B',
    testing:   '#EF4444',
    waiting:   dark ? '#4A5A72' : '#8A9AB5',
    blocked:   '#F59E0B',
    done:      '#22C55E',
    failed:    '#EF4444',
  }

  const color = stateColor[state]
  const dimColor = dark ? '#2D3B55' : '#C8D0DC'

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!

    // Pixel patterns per state
    const patterns: Record<AgentState, (t: number) => number[][]> = {
      thinking: (t) => {
        const base = [
          [0,1,1,1,1,1,1,0],
          [1,0,0,0,0,0,0,1],
          [1,0,1,0,0,1,0,1],
          [1,0,0,0,0,0,0,1],
          [1,0,0,1,1,0,0,1],
          [1,0,1,0,0,1,0,1],
          [1,0,0,0,0,0,0,1],
          [0,1,1,1,1,1,1,0],
        ]
        // Animate inner pixels
        const phase = Math.floor(t / 8) % 4
        return base.map((row, r) => row.map((v, c) => {
          if (r > 0 && r < 7 && c > 0 && c < 7 && v === 1) {
            return ((r + c + phase) % 3 === 0) ? 0.4 : 1
          }
          return v
        }))
      },
      reading: (t) => {
        const scanLine = Math.floor(t / 3) % GRID
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            if (r === scanLine) return 1
            if (c === 0 || c === GRID - 1) return 0.3
            return 0.15
          })
        )
      },
      planning: (t) => {
        const step = Math.floor(t / 10) % 5
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            // Branching tree structure builds up
            if (r === 0 && c === 3) return 1
            if (r === 1 && (c === 2 || c === 4)) return step >= 1 ? 1 : 0
            if (r === 2 && (c === 1 || c === 3 || c === 5)) return step >= 2 ? 1 : 0
            if (r === 3 && (c === 0 || c === 2 || c === 4 || c === 6)) return step >= 3 ? 1 : 0
            if (r > 4) return step >= 4 ? 0.3 : 0
            return 0
          })
        )
      },
      working: (t) => {
        const phase = t % 16
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            const dist = Math.abs(phase / 2 - c)
            if (r % 2 === 0 && dist < 2) return 1
            if (r % 2 === 1 && dist > 2) return 0.3
            return 0.1
          })
        )
      },
      writing: (t) => {
        const col = Math.floor(t / 2) % GRID
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            if (c === col) return 1
            if (c < col) return 0.5
            return 0.1
          })
        )
      },
      testing: (t) => {
        const phase = t % 4
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            return ((r + c + phase) % 2 === 0) ? 1 : 0.1
          })
        )
      },
      waiting: (t) => {
        const alpha = 0.3 + 0.7 * (Math.sin(t * 0.05) + 1) / 2
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            if (r === 0 || r === 7 || c === 0 || c === 7) return alpha * 0.5
            if ((r + c) % 3 === 0) return alpha
            return 0
          })
        )
      },
      blocked: (t) => {
        const flash = Math.floor(t / 8) % 2 === 0
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            // X pattern
            if (r === c || r === GRID - 1 - c) return flash ? 1 : 0.3
            if (r === 3 || r === 4) return 0.2
            return 0
          })
        )
      },
      done: (_t) => {
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            // Checkmark-ish stable pattern
            if (r >= 4 && c >= 1 && c <= 2) return 1
            if (r === 3 && c === 3) return 1
            if (r === 2 && c === 4) return 1
            if (r === 1 && c === 5) return 1
            if (r === 0 && c === 6) return 1
            return 0.1
          })
        )
      },
      failed: (t) => {
        const flash = Math.floor(t / 6) % 3 < 2
        return Array.from({ length: GRID }, (_, r) =>
          Array.from({ length: GRID }, (_, c) => {
            if ((r === c || r === GRID - 1 - c) && flash) return 1
            return 0
          })
        )
      },
    }

    let raf: number

    const draw = () => {
      tickRef.current++
      const t = tickRef.current
      const grid = patterns[state](t)

      canvas.width = size
      canvas.height = size
      ctx.clearRect(0, 0, size, size)

      for (let r = 0; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          const alpha = grid[r][c]
          if (alpha > 0) {
            ctx.fillStyle = color + Math.round(alpha * 255).toString(16).padStart(2, '0')
            ctx.fillRect(c * CELL, r * CELL, CELL - 1, CELL - 1)
          } else {
            ctx.fillStyle = dimColor + '22'
            ctx.fillRect(c * CELL, r * CELL, CELL - 1, CELL - 1)
          }
        }
      }

      frameRef.current = raf = requestAnimationFrame(draw)
    }

    draw()
    return () => cancelAnimationFrame(raf)
  }, [state, size, theme])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      style={{ imageRendering: 'pixelated', display: 'block', flexShrink: 0 }}
    />
  )
}

// Shared panel wrapper
export function Panel({ children, theme, style }: {
  children: React.ReactNode
  theme: Theme
  style?: React.CSSProperties
}) {
  const dark = theme === 'dark'
  return (
    <div style={{
      border: `1px solid ${dark ? '#2D3B55' : '#C8C0B4'}`,
      background: dark ? '#0F172A' : '#E8E4DC',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
      ...style,
    }}>
      {children}
    </div>
  )
}

export function PanelHead({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  const dark = theme === 'dark'
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 16px',
      borderBottom: `1px solid ${dark ? '#2D3B55' : '#C8C0B4'}`,
      background: dark ? '#0C1422' : '#E0DBCF',
      flexShrink: 0,
    }}>
      {children}
    </div>
  )
}

export function PanelTitle({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  const dark = theme === 'dark'
  return (
    <h2 style={{
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 11,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: dark ? '#7A8BA8' : '#6A7080',
    }}>
      {children}
    </h2>
  )
}

export function Count({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  const dark = theme === 'dark'
  return (
    <span style={{
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 11,
      color: dark ? '#4A5A72' : '#8A9AB5',
    }}>
      {children}
    </span>
  )
}

export function Spacer() {
  return <span style={{ flex: 1 }} />
}

export function MonoId({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  const dark = theme === 'dark'
  return (
    <span style={{
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 10,
      color: dark ? '#4A5A72' : '#8A9AB5',
      letterSpacing: '-0.01em',
    }}>
      {children}
    </span>
  )
}

export function Tag({ children, theme }: { children: React.ReactNode; theme: Theme }) {
  const dark = theme === 'dark'
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '1px 5px',
      border: `1px solid ${dark ? '#3D4F6E' : '#AAAAAA'}`,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: 10,
      fontWeight: 600,
      color: dark ? '#7A8BA8' : '#6A7080',
      letterSpacing: '0.04em',
    }}>
      {children}
    </span>
  )
}

export function Btn({ children, variant = 'default', onClick, theme }: {
  children: React.ReactNode
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  onClick?: () => void
  theme: Theme
}) {
  const dark = theme === 'dark'
  const styles: Record<string, React.CSSProperties> = {
    default: {
      border: `1px solid ${dark ? '#3D4F6E' : '#AAAAAA'}`,
      background: dark ? '#1B2336' : '#DDD8CE',
      color: dark ? '#E8EDF5' : '#1A1F2E',
    },
    primary: {
      border: '1px solid #22C55E',
      background: '#22C55E',
      color: '#080C14',
    },
    ghost: {
      border: `1px solid transparent`,
      background: 'transparent',
      color: dark ? '#7A8BA8' : '#6A7080',
    },
    danger: {
      border: '1px solid #EF4444',
      background: 'transparent',
      color: '#EF4444',
    },
  }

  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 12px',
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
        letterSpacing: '0.02em',
        transition: 'opacity 0.1s',
        ...styles[variant],
      }}
      onMouseEnter={e => (e.currentTarget.style.opacity = '0.8')}
      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
    >
      {children}
    </button>
  )
}
