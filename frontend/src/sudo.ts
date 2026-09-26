/** In-app sudo prompt. Shared by main.ts (api() 401 handler) and scan.ts
 *  (INSTALL NMAP) so a "sudo password required" 401 is handled with the
 *  styled in-app modal instead of a browser alert. */
import { sudoVerify } from './api'
import * as overlay from './overlay'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

let sudoResolver: ((ok: boolean) => void) | null = null
let open = false

export function isSudoModalOpen(): boolean {
  return open
}

/* Prompt for the sudo password. Resolves true when unlocked, false when the
   user cancels. The password is held in memory only and auto-expires. */
export function askSudo(): Promise<boolean> {
  return new Promise<boolean>(res => {
    sudoResolver = res
    renderSudoModal()
  })
}

export function renderSudoModal() {
  document.getElementById('sudo-modal')?.remove()
  open = true
  const app = document.getElementById('app')!
  const m = el('div', 'esc-menu open')
  m.id = 'sudo-modal'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', 'ROOT ACCESS'))
  const p = el('p', 'sub')
  p.textContent = 'Enter your sudo password to continue. It is held in memory only and auto-expires.'
  box.appendChild(p)
  const inp = el('input', 'text-input')
  inp.type = 'password'
  inp.autocomplete = 'off'
  inp.placeholder = 'password'
  box.appendChild(inp)
  const err = el('div', 'form-err')
  box.appendChild(err)
  const row = el('div', 'btn-row')
  const cancel = el('button', 'btn', 'CANCEL')
  const ok = el('button', 'btn', 'UNLOCK')
  ok.classList.add('active')
  const done = (okb: boolean) => {
    open = false
    sudoResolver?.(okb)
    sudoResolver = null
    m.remove()
  }
  cancel.addEventListener('click', () => done(false))
  ok.addEventListener('click', () => {
    sudoVerify(inp.value)
      .then(() => done(true))
      .catch(() => { err.textContent = 'wrong password — try again' })
  })
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ok.click()
    else if (e.key === 'Escape') done(false)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); ok.focus() }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); cancel.focus() }
    e.stopPropagation()
  })
  /* Arrow keys: navigate CANCEL/UNLOCK like the standby menu. */
  ;[ok, cancel].forEach((b, i, arr) => {
    b.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); arr[(i + 1) % arr.length].focus()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); arr[(i + arr.length - 1) % arr.length].focus()
      } else if (e.key === 'Tab') {
        e.preventDefault(); arr[(i + (e.shiftKey ? arr.length - 1 : 1)) % arr.length].focus()
      }
    })
  })
  row.appendChild(ok); row.appendChild(cancel)
  box.appendChild(row)
  m.appendChild(box)
  app.appendChild(m)
  overlay.wake()
  setTimeout(() => inp.focus(), 30)
}
