/** In-app Wi-Fi passphrase prompt. Mirrors vpnCreds.ts: a styled in-app
 *  modal that owns the keyboard (Enter connects, Esc cancels, arrows move
 *  between the field and the buttons). Resolves the passphrase string on
 *  connect, or null on cancel. The passphrase is stored on this device
 *  only (see backend/wificonnect.py) and reused on future connects.
 */
import * as overlay from './overlay'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

let resolver: ((pass: string | null) => void) | null = null
let open = false

export function isWifiPassModalOpen(): boolean {
  return open
}

/** Prompt for a Wi-Fi passphrase. Resolves the passphrase on connect,
 *  null when the user cancels. `essid` and `hint` shape the wording. */
export function askPassphrase(essid: string, hint?: string): Promise<string | null> {
  return new Promise<string | null>(res => {
    resolver = res
    renderModal(essid, hint)
  })
}

export function renderModal(essid: string, hint?: string) {
  document.getElementById('wifi-pass-modal')?.remove()
  open = true
  const app = document.getElementById('app')!
  const m = el('div', 'esc-menu open')
  m.id = 'wifi-pass-modal'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', `WIFI PASS · ${essid.toUpperCase()}`))
  const p = el('p', 'sub')
  p.textContent = hint
    || `Enter the passphrase for ${essid}. It is stored on this device only `
       + 'and reused on future connects.'
  box.appendChild(p)

  const pw = el('input', 'text-input')
  pw.type = 'password'
  pw.autocomplete = 'off'
  pw.placeholder = 'passphrase'
  box.appendChild(pw)

  const err = el('div', 'form-err')
  box.appendChild(err)
  const row = el('div', 'btn-row')
  const ok = el('button', 'btn active', 'CONNECT')
  const cancel = el('button', 'btn', 'CANCEL')

  const done = (pass: string | null) => {
    open = false
    resolver?.(pass)
    resolver = null
    m.remove()
  }
  const connect = () => {
    if (!pw.value) { err.textContent = 'enter the passphrase'; pw.focus(); return }
    done(pw.value)
  }
  cancel.addEventListener('click', () => done(null))
  ok.addEventListener('click', connect)

  /* One keyboard chain over the WHOLE modal:
       passphrase → CONNECT → CANCEL → passphrase → …
     Tab AND Shift+Tab wrap the full cycle; arrows follow the same cycle. */
  const chain: HTMLElement[] = [pw, ok, cancel]
  const focusAt = (i: number) => chain[(i + chain.length) % chain.length].focus()
  const idxOf = (t: EventTarget | null) => chain.indexOf(t as HTMLElement)

  const onCyclic = (t: HTMLElement) => (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      focusAt(idxOf(t) + (e.shiftKey ? -1 : 1))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' ||
               e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusAt(idxOf(t) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter') {
      if (t === ok) { e.preventDefault(); connect() }
      else if (t === cancel) { e.preventDefault(); done(null) }
    } else if (e.key === 'Escape') {
      done(null)
    }
    e.stopPropagation()
  }
  pw.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); connect(); e.stopPropagation(); return }
    onCyclic(pw)(e)
  })
  ok.addEventListener('keydown', onCyclic(ok))
  cancel.addEventListener('keydown', onCyclic(cancel))

  row.appendChild(ok); row.appendChild(cancel)
  box.appendChild(row)
  m.appendChild(box)
  app.appendChild(m)
  overlay.wake()
  setTimeout(() => pw.focus(), 30)
}

/* ── in-app confirm (replaces the banned browser confirm()) ──
   A styled .esc-menu overlay that owns the keyboard: Enter confirms,
   Esc cancels. Used for FORGET (removes a stored passphrase). */
let confirmResolver: ((ok: boolean) => void) | null = null

/** Prompt a yes/no confirm. Resolves true on confirm, false on cancel. */
export function askConfirm(title: string, sub: string): Promise<boolean> {
  return new Promise<boolean>(res => {
    confirmResolver = res
    renderConfirm(title, sub)
  })
}

function renderConfirm(title: string, sub: string) {
  document.getElementById('wifi-confirm-modal')?.remove()
  const app = document.getElementById('app')!
  const m = el('div', 'esc-menu open')
  m.id = 'wifi-confirm-modal'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', title))
  box.appendChild(el('p', 'sub', sub))
  const row = el('div', 'btn-row')
  const okb = el('button', 'btn active', 'FORGET')
  const cancel = el('button', 'btn', 'CANCEL')
  const done = (v: boolean) => {
    confirmResolver?.(v)
    confirmResolver = null
    m.remove()
  }
  okb.addEventListener('click', () => done(true))
  cancel.addEventListener('click', () => done(false))
  okb.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); e.stopPropagation() }
    else if (e.key === 'Escape') { done(false); e.stopPropagation() }
  })
  cancel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); done(false); e.stopPropagation() }
    else if (e.key === 'Escape') { done(false); e.stopPropagation() }
  })
  row.appendChild(okb); row.appendChild(cancel)
  box.appendChild(row)
  m.appendChild(box)
  app.appendChild(m)
  overlay.wake()
  setTimeout(() => okb.focus(), 30)
}
