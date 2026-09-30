/** In-app self-update overlay.
 *
 *  Shown full-screen when the user hits UPDATE on the settings screen. It
 *  kicks the update (git pull + install.sh) and then tails the live log
 *  (polled from /api/update/status) in a terminal panel. Three end states:
 *
 *    running — the log streams; no way to cancel (git pull is already in
 *              flight, and cancelling mid-pull could leave a half-applied
 *              tree). Esc is a no-op here.
 *    done    — pull + install succeeded; the launcher is relaunching the
 *              app, so we show a RESTARTING screen and stop. The kiosk
 *              window is torn down by the launcher ~2.5s later and a fresh
 *              one with the new bundle comes up.
 *    error   — the log shows the reason; BACK (or Esc) dismisses the
 *              overlay and returns to settings, where the UPDATE button is
 *              available again (onDismiss lets main.ts re-render + re-check).
 *
 *  Like the sudo/creds modals it OWNS the keyboard: the document keydown
 *  handler in main.ts bails while #update-overlay exists, and this module
 *  handles Enter/Esc on its own controls.
 */
import { updateRun, updateStatus } from './api'
import * as overlay from './overlay'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

const POLL_MS = 700

let timer: number | null = null
let from = ''
let to = ''
let onDismiss: (() => void) | null = null
let state: 'running' | 'done' | 'error' = 'running'

function overlayEl(): HTMLElement | null {
  return document.getElementById('update-overlay')
}

function stopPoll() {
  if (timer) { clearInterval(timer); timer = null }
}

function renderLog(lines: string[]) {
  const log = overlayEl()?.querySelector<HTMLElement>('.update-log')
  if (!log) return
  log.textContent = lines.length ? lines.join('\n') : 'starting…'
  /* keep the newest lines in view */
  log.scrollTop = log.scrollHeight
}

function setStatusLine(text: string, cls = '') {
  const s = overlayEl()?.querySelector<HTMLElement>('.update-status')
  if (!s) return
  s.textContent = text
  s.className = `update-status ${cls}`.trim()
}

/* ── running ───────────────────────────────────────────────── */
function renderRunning() {
  const box = overlayEl()?.querySelector<HTMLElement>('.box')
  if (!box) return
  const s = el('div', 'update-status', 'UPDATING… pulling the new version')
  s.tabIndex = 0
  s.dataset.fk = 'update:status'
  box.appendChild(s)
  box.appendChild(el('pre', 'update-log'))
  focusStatus()
}

function focusStatus() {
  const s = overlayEl()?.querySelector<HTMLElement>('.update-status')
  s?.focus()
}

/* ── done: RESTARTING ──────────────────────────────────────── */
function renderDone() {
  state = 'done'
  stopPoll()
  const m = overlayEl()
  if (!m) return
  const box = el('div', 'box update-done')
  box.appendChild(el('div', 'title', 'RESTARTING'))
  const sub = el('div', 'sub')
  sub.textContent = `updated ${from} → ${to} — the new version is launching`
  box.appendChild(sub)
  const big = el('div', 'update-restart')
  big.textContent = '↻'
  box.appendChild(big)
  m.replaceChildren(box)
}

/* ── error ─────────────────────────────────────────────────── */
function renderError(detail: string, logLines: string[] = []) {
  state = 'error'
  stopPoll()
  const m = overlayEl()
  if (!m) return
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', 'UPDATE FAILED'))
  const err = el('div', 'form-err')
  err.textContent = detail
  box.appendChild(err)
  const log = el('pre', 'update-log')
  log.textContent = logLines.join('\n') || '(no log)'
  box.appendChild(log)
  const back = el('button', 'btn', 'BACK')
  back.tabIndex = 0
  back.dataset.fk = 'update:back'
  back.addEventListener('click', dismiss)
  box.appendChild(back)
  m.replaceChildren(box)
  back.focus()
  /* attach Esc/Enter once the fresh controls are in place */
  attachKeys()
}

function attachKeys() {
  const m = overlayEl()
  if (!m) return
  m.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      if (state === 'error') dismiss()
      /* running: no-op (can't cancel a pull mid-flight); done: relaunching */
    } else if (e.key === 'Enter') {
      const ae = document.activeElement
      if (ae && ae.id !== 'update-overlay' && (ae as HTMLElement).dataset?.fk === 'update:back') {
        e.preventDefault(); e.stopPropagation()
        dismiss()
      }
    }
  }
}

function dismiss() {
  stopPoll()
  overlayEl()?.remove()
  overlay.wake()
  onDismiss?.()
  onDismiss = null
}

/* ── entry point ───────────────────────────────────────────── */
export function startUpdate(opts: {
  from: string
  to: string
  onDismiss?: () => void
}) {
  from = opts.from
  to = opts.to
  onDismiss = opts.onDismiss ?? null

  document.getElementById('update-overlay')?.remove()
  const host = document.getElementById('app')!
  const m = el('div', 'esc-menu open')
  m.id = 'update-overlay'
  m.appendChild(el('div', 'box'))
  host.appendChild(m)
  overlay.wake()
  attachKeys()

  state = 'running'
  renderRunning()
  renderLog([])

  updateRun()
    .then(() => { poll() })
    .catch(e => renderError(e?.message || String(e)))
}

function poll() {
  if (timer) return
  timer = window.setInterval(async () => {
    let st
    try {
      st = await updateStatus()
    } catch {
      /* the server may be going down right after a successful update —
         that's the happy path; keep waiting (the launcher takes over) */
      return
    }
    renderLog(st.log)
    if (st.outcome === 'done') {
      setStatusLine('update complete — restarting…', 'ok')
      renderDone()
    } else if (st.outcome === 'error') {
      setStatusLine('update failed', 'err')
      renderError('see the log for the reason', st.log)
    } else {
      setStatusLine('UPDATING… ' + (st.log[st.log.length - 1] ? 'working…' : ''))
    }
  }, POLL_MS)
}
