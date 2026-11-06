// Agent Flare's container control: a chip in Hermes's status bar. A plain Hermes desktop plugin, installed into
// HERMES_HOME at boot. It only talks to the Worker's /__af/lease routes, where the lease and its expiry live.
// Any failure means no chip, and Hermes carries on.
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'
import { host } from '@hermes/plugin-sdk'

const POLL_MS = 60_000
const REPORT_MS = 60_000
const TICK_MS = 15_000
const BUSY_CHECK_MS = 15_000
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

// Idle is led by this chip. A person is here (a tap, a key, a page load) or an agent is mid-turn. At most once a minute.
// A tab's own traffic isn't reported, which is the point.
let lastReport = 0
let lastInput = Date.now()
function report(busy = false) {
  lastInput = Date.now()
  if (Date.now() - lastReport < REPORT_MS) return
  lastReport = Date.now()
  fetch('/__af/activity', {
    body: JSON.stringify({ busy }),
    headers: { 'content-type': 'application/json' },
    method: 'POST'
  }).catch(() => {})
}
const onInput = () => report()

function agentBusy() {
  try {
    return Object.values(host.state.busyBySession.get()).some(Boolean)
  } catch {
    return false
  }
}

const GREEN = '#22c55e'
const ORANGE = '#f6821f'
const RED = '#ef4444'
const ACTIVE_MS = 5 * 60_000

// Minutes until the next planned stop: the lease's end, or when idle runs out.
function stopTime(status) {
  return status.reason === 'lease' ? status.stopsAt : status.idleAt ?? (status.warn ? status.stopsAt : null)
}

function countdown(at, now) {
  const minutes = Math.ceil((at - now) / 60_000)
  if (minutes <= 0) return 'now'
  return minutes > 90 ? `${Math.round(minutes / 60)}h` : `${minutes}m`
}

// Colour is never the only signal: the text and the screen-reader label say the same thing.
function view(status, now) {
  if (status.state !== 'awake') return { color: RED, name: 'Stopped', text: 'Stopped, tap to restart' }
  const at = stopTime(status)
  const leased = status.reason === 'lease'
  const active = (leased && !status.warn) || (!status.warn && now - lastInput < ACTIVE_MS)
  return { color: active ? GREEN : ORANGE, name: active ? 'Active' : 'Idle', text: at ? countdown(at, now) : '\u2013' }
}

function detail(status) {
  if (status.reason === 'lease') return `Stays on until ${time(status.stopsAt)}, then saves and stops.`
  if (status.warn) return `Saves and stops at ${time(status.stopsAt)} unless you keep it awake.`
  return status.idleAt ? `Sleeps at ${time(status.idleAt)} unless you tap or type, or an agent is working.` : 'Sleeps when idle.'
}

const ROW = { background: 'none', border: 0, color: 'inherit', cursor: 'pointer', display: 'block', font: 'inherit',
  minHeight: 44, padding: '0 14px', textAlign: 'left', width: '100%' }

function Control() {
  const [status, setStatus] = useState(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())

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
    const busyTimer = setInterval(() => agentBusy() && report(true), BUSY_CHECK_MS)
    const ticker = setInterval(() => setNow(Date.now()), TICK_MS)
    document.addEventListener('pointerdown', onInput, { capture: true, passive: true })
    document.addEventListener('keydown', onInput, { capture: true, passive: true })
    const onVisible = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      clearInterval(busyTimer)
      clearInterval(ticker)
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('pointerdown', onInput, { capture: true })
      document.removeEventListener('keydown', onInput, { capture: true })
    }
  }, [])

  if (!status) return null

  const shown = view(status, now)

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
        'aria-label': `${shown.name}: ${shown.text}`,
        // The bar is 20px tall, so an invisible extension makes the tap target taller than the row.
        children: [
          jsx('span', { 'aria-hidden': true, children: '\u25cf ', style: { color: shown.color } }),
          shown.text,
          jsx('span', { 'aria-hidden': true, style: { bottom: 0, left: 0, position: 'absolute', right: 0, top: -16 } })
        ],
        onClick: () => (status.state === 'awake' ? setOpen(!open) : restart(status.state)),
        style: { background: 'none', border: 0, color: 'inherit', cursor: 'pointer', font: 'inherit', fontSize: '0.6875rem',
          padding: '0 12px', position: 'relative', touchAction: 'manipulation', whiteSpace: 'nowrap' },
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
