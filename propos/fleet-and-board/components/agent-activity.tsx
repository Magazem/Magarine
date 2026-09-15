'use client'

import { useEffect, useState } from 'react'
import { AgentGlyph } from './agent-glyph'

// The running worker's live status line: the pixel glyph plus a rotating
// phrase naming what it is doing right now. Honours reduced-motion by holding
// on the first phrase.
export function AgentActivity({ phrases }: { phrases: string[] }) {
  const [i, setI] = useState(0)

  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return
    }
    const id = setInterval(() => setI((n) => (n + 1) % phrases.length), 2200)
    return () => clearInterval(id)
  }, [phrases.length])

  return (
    <span className="agent-strip">
      <AgentGlyph state="working" label="worker running" />
      <span className="phrase" aria-live="polite">
        {phrases[i]}
      </span>
    </span>
  )
}
