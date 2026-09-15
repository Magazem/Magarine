'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'

type Theme = 'oled' | 'dark' | 'light'
const ORDER: Theme[] = ['oled', 'dark', 'light']
const LABEL: Record<Theme, string> = { oled: 'OLED', dark: 'Dark', light: 'Light' }

const SCREENS = [
  { href: '/', label: 'Fleet & Board' },
  { href: '/needs-you', label: 'Needs You' },
  { href: '/scope', label: 'Scope' },
]

export function TopBar({
  projectId = 'proj_393c405c-25ac-4220-a95d-21cf66838c6a',
  spend,
  cap,
  refreshed = '8:45:17\u00A0AM',
}: {
  projectId?: string
  spend: string
  cap?: string
  refreshed?: string
}) {
  const pathname = usePathname()
  const [theme, setTheme] = useState<Theme>('oled')

  useEffect(() => {
    const current = (document.documentElement.getAttribute('data-theme') as Theme) || 'oled'
    setTheme(current)
  }, [])

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]
    document.documentElement.setAttribute('data-theme', next)
    try {
      localStorage.setItem('magarine-theme', next)
    } catch {}
    setTheme(next)
  }

  const nextTheme = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]

  return (
    <header className="topbar">
      <h1 className="brand">Magarine</h1>
      <span className="sep" aria-hidden="true" />
      <span className="project-name">UI Walk</span>
      <span className="mono meta-faint">{projectId}</span>

      <span className="spacer" />

      <nav className="switcher" aria-label="Prototype screens">
        {SCREENS.map((s) => (
          <Link key={s.href} href={s.href} aria-current={pathname === s.href ? 'page' : undefined}>
            {s.label}
          </Link>
        ))}
      </nav>

      <span className="tag">{spend} equivalent</span>
      {cap ? <span className="meta-faint">cap {cap}</span> : null}
      <span className="meta-faint">last refreshed {refreshed}</span>
      <button className="btn btn-ghost" type="button">
        Refresh
      </button>
      <button
        className="btn btn-ghost"
        id="themeToggle"
        type="button"
        onClick={cycle}
        aria-label={`Switch theme to ${LABEL[nextTheme]}`}
      >
        {LABEL[nextTheme]}
      </button>
    </header>
  )
}
