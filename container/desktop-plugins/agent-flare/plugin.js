// Agent Flare's container control: a chip in Hermes's status bar. A plain Hermes desktop plugin, installed into
// HERMES_HOME at boot. It only talks to the Worker's /__af/lease routes, where the lease and its expiry live.
// Any failure means no chip, and Hermes carries on.
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const POLL_MS = 60_000
const REPORT_MS = 60_000
// A full reload goes through the Worker's starting page to the new backend. Nothing here runs without a tap.
const restart = async state => {
  if (state === 'parked') await fetch('/__af/wake', { method: 'POST' }).catch(() => {})
  location.reload()
}
const time = at => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

async function send(path, body) {
  const response = await fetch(path, {
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  })
  if (!response.ok) throw new Error(String(response.status))
}

// A person is here: a tap or a key, at most once a minute. A tab's own traffic isn't reported, which is the point.
let lastReport = 0
function report() {
  if (Date.now() - lastReport < REPORT_MS) return
  lastReport = Date.now()
  fetch('/__af/activity', { method: 'POST' }).catch(() => {})
}

function label(status) {
  if (status.state !== 'awake') return 'Stopped, tap to restart'
  if (status.warn) return `Stops ${time(status.stopsAt)}`
  if (status.reason === 'lease') return `Awake to ${time(status.stopsAt)}`
  return status.idleAt ? `Idle ${time(status.idleAt)}` : 'Awake'
}

function detail(status) {
  if (status.reason === 'lease') return `Stays on until ${time(status.stopsAt)}, then saves and stops.`
  if (status.warn) return `Saves and stops at ${time(status.stopsAt)} unless you keep it awake.`
  return status.idleAt ? `Sleeps at ${time(status.idleAt)} unless you tap or type.` : 'Sleeps when idle.'
}

const ROW = { background: 'none', border: 0, color: 'inherit', cursor: 'pointer', display: 'block', font: 'inherit',
  minHeight: 44, padding: '0 14px', textAlign: 'left', width: '100%' }

function Control() {
  const [status, setStatus] = useState(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')

  const refresh = async () => {
    try {
      const response = await fetch('/__af/lease', { cache: 'no-store' })
      setStatus(response.ok ? await response.json() : null)
    } catch {
      setStatus(null)
    }
  }

  useEffect(() => {
    report()
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    document.addEventListener('pointerdown', report, { capture: true, passive: true })
    document.addEventListener('keydown', report, { capture: true, passive: true })
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('pointerdown', report, { capture: true })
      document.removeEventListener('keydown', report, { capture: true })
    }
  }, [])

  if (!status) return null

  const act = (path, body, after) => async () => {
    setError('')
    try {
      await send(path, body)
      setOpen(false)
      after ? after() : refresh()
    } catch {
      setError("That didn't work. Your agent is still running.")
    }
  }

  const row = (text, onClick) => jsx('button', { children: text, onClick, style: ROW, type: 'button' })

  return jsxs('span', {
    style: { alignItems: 'stretch', display: 'inline-flex', flexShrink: 0 },
    children: [
      jsxs('button', {
        // The bar is 20px tall, so an invisible extension makes the tap target taller than the row.
        children: [label(status), jsx('span', { 'aria-hidden': true, style: { bottom: 0, left: 0, position: 'absolute', right: 0, top: -16 } })],
        onClick: () => (status.state === 'awake' ? setOpen(!open) : restart(status.state)),
        style: { background: 'none', border: 0, color: status.warn || status.state !== 'awake' ? '#f6821f' : 'inherit', cursor: 'pointer',
          font: 'inherit', fontSize: '0.6875rem', padding: '0 12px', position: 'relative', touchAction: 'manipulation', whiteSpace: 'nowrap' },
        type: 'button'
      }),
      // A tap anywhere else closes the menu.
      open && jsx('div', { onClick: () => setOpen(false), style: { inset: 0, position: 'fixed', zIndex: 999 } }),
      open && jsxs('div', {
        style: { background: 'var(--ui-sidebar-surface-background, #111)', border: '1px solid rgba(128,128,128,.4)',
          borderRadius: 8, bottom: 28, color: 'var(--ui-text-primary, inherit)', fontSize: 14, maxWidth: 'calc(100vw - 16px)',
          padding: '6px 0', position: 'fixed', right: 8, width: 240, zIndex: 1000 },
        children: [
          jsx('div', { children: error || detail(status), style: { fontSize: 12, opacity: 0.75, padding: '6px 14px' } }),
          row('Keep awake 1 hour', act('/__af/lease', { hours: 1 })),
          row('Keep awake 2 hours', act('/__af/lease', { hours: 2 })),
          row('Stop', act('/__af/lease/stop', null))
        ]
      })
    ]
  })
}

export default {
  id: 'agent-flare',
  name: 'Agent Flare',
  register(ctx) {
    ctx.register({ area: 'statusBar.right', id: 'container', order: -100, render: () => jsx(Control, {}) })
  }
}
