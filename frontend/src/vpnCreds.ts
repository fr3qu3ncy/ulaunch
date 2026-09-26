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

  /* one keyboard chain: username → password → SAVE → CANCEL. */
  const chain = [user, pw, ok, cancel]
  const move = (i: number, d: number) => {
    const j = (i + d + chain.length) % chain.length
    chain[j].focus()
  }
  user.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); pw.focus() }
    else if (e.key === 'Escape') done(null)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(0, 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(0, -1) }
    e.stopPropagation()
  })
  pw.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); save() }
    else if (e.key === 'Escape') done(null)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1, 1) }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(1, -1) }
    e.stopPropagation()
  })
  ;[ok, cancel].forEach((b, i, arr) => {
    b.addEventListener('keydown', e => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); arr[(i + 1) % arr.length].focus()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); arr[(i + arr.length - 1) % arr.length].focus()
      } else if (e.key === 'Tab') {
        e.preventDefault(); arr[(i + (e.shiftKey ? arr.length - 1 : 1)) % arr.length].focus()
      } else if (e.key === 'Enter') {
        e.preventDefault(); (b === ok ? save : () => done(null))()
      } else if (e.key === 'Escape') {
        done(null)
      }
    })
  })
  row.appendChild(ok); row.appendChild(cancel)
  box.appendChild(row)
  m.appendChild(box)
  app.appendChild(m)
  overlay.wake()
  setTimeout(() => user.focus(), 30)
}
