/** In-app VPN credential prompt. Mirrors sudo.ts: a styled in-app modal
 *  that owns the keyboard (Enter saves, Esc cancels, arrows move between
 *  the two fields and the buttons). Resolves {username,password} on save,
 *  or null on cancel. Used to (re)set a preset's login before connecting.
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

export interface VpnCreds {
  username: string
  password: string
}

let resolver: ((c: VpnCreds | null) => void) | null = null
let open = false

export function isCredsModalOpen(): boolean {
  return open
}

/** Prompt for a VPN username + password. Resolves the pair on save, null
 *  when the user cancels. `preset` and `hint` shape the wording; pass an
 *  existing `username` to pre-fill it. */
export function askVpnCreds(
  preset: string, hint: string, existing?: string,
): Promise<VpnCreds | null> {
  return new Promise<VpnCreds | null>(res => {
    resolver = res
    renderModal(preset, hint, existing)
  })
}

export function renderModal(
  preset: string, hint: string, existing?: string,
) {
  document.getElementById('creds-modal')?.remove()
  open = true
  const app = document.getElementById('app')!
  const m = el('div', 'esc-menu open')
  m.id = 'creds-modal'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', `VPN LOGIN · ${preset.toUpperCase()}`))
  const p = el('p', 'sub')
  p.textContent = hint
  box.appendChild(p)

  const user = el('input', 'text-input')
  user.type = 'text'
  user.autocomplete = 'off'
  user.placeholder = 'username'
  if (existing) user.value = existing
  box.appendChild(user)
  const pw = el('input', 'text-input')
  pw.type = 'password'
  pw.autocomplete = 'off'
  pw.placeholder = 'password'
  box.appendChild(pw)

  const err = el('div', 'form-err')
  box.appendChild(err)
  const row = el('div', 'btn-row')
  const ok = el('button', 'btn active', 'SAVE')
  const cancel = el('button', 'btn', 'CANCEL')

  const done = (c: VpnCreds | null) => {
    open = false
    resolver?.(c)
    resolver = null
    m.remove()
  }
  const save = () => {
    const u = user.value.trim()
    if (!u) { err.textContent = 'username required'; user.focus(); return }
    if (!pw.value) { err.textContent = 'password required'; pw.focus(); return }
    done({ username: u, password: pw.value })
  }
  cancel.addEventListener('click', () => done(null))
  ok.addEventListener('click', save)

  /* One keyboard chain over the WHOLE modal:
       username → password → SAVE → CANCEL → username → …
     Tab AND Shift+Tab wrap the full cycle (so CANCEL wraps back to the
     password field); arrows follow the same cycle. */
  const chain: HTMLElement[] = [user, pw, ok, cancel]
  const focusAt = (i: number) =>
    chain[(i + chain.length) % chain.length].focus()
  const idxOf = (t: EventTarget | null) =>
    chain.indexOf(t as HTMLElement)

  const onCyclic = (t: HTMLElement) => (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      focusAt(idxOf(t) + (e.shiftKey ? -1 : 1))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' ||
               e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      focusAt(idxOf(t) +
        (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter') {
      if (t === ok) { e.preventDefault(); save() }
      else if (t === cancel) { e.preventDefault(); done(null) }
    } else if (e.key === 'Escape') {
      done(null)
    }
    e.stopPropagation()
  }
  user.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); focusAt(1); e.stopPropagation(); return }
    onCyclic(user)(e)
  })
  pw.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); e.stopPropagation(); return }
    onCyclic(pw)(e)
  })
  ok.addEventListener('keydown', onCyclic(ok))
  cancel.addEventListener('keydown', onCyclic(cancel))
  row.appendChild(ok); row.appendChild(cancel)
  box.appendChild(row)
  m.appendChild(box)
  app.appendChild(m)
  overlay.wake()
  setTimeout(() => user.focus(), 30)
}
