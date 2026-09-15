// A small pixel "worker". 16 cells in a 4-wide grid. While a ticket is
// genuinely running the cells scan left-to-right (each column offset by its
// index); in every other state the grid is static — so motion here always
// means real, live computation, never decoration.
type GlyphState = 'working' | 'done' | 'failed' | 'idle'

export function AgentGlyph({
  state = 'idle',
  label,
}: {
  state?: GlyphState
  label?: string
}) {
  const cls = state === 'working' ? 'working' : state === 'done' ? 'done' : state === 'failed' ? 'failed' : ''
  return (
    <span
      className={`agent-glyph ${cls}`}
      role="img"
      aria-label={label ?? `agent ${state}`}
    >
      {Array.from({ length: 16 }).map((_, i) => (
        <span
          key={i}
          className="agent-cell"
          style={{ ['--d' as string]: `${(i % 4) * 0.14}s` }}
        />
      ))}
    </span>
  )
}
