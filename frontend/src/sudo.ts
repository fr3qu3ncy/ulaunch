/** In-app sudo prompt. Shared by main.ts (api() 401 handler) and scan.ts
 *  (INSTALL NMAP) so a "sudo password required" 401 is handled with the
 *  styled in-app modal instead of a browser alert.
 *
 *  When opened for an OpenVPN action (opts.grantCheckbox) the modal also
 *  offers "Add OpenVPN to sudoers" — on UNLOCK, using the password just
 *  verified, it writes a dedicated openvpn-only NOPASSWD drop-in so VPN
 *  connects never need the password again.
 *
 *  PASSWORDLESS mode: if the user already has a NOPASSWD sudoers rule
 *  (Raspberry Pi's 010_pi-nopasswd, a fresh distro account, …) there is
 *  no password field at all — just the grant checkbox (optional) and
 *  UNLOCK. The backend never feeds a password to `sudo -S` in that case
 *  (a fed password would leak into the child's stdin). */
import { sudoVerify, sudoStatus, sudoOpenvpnNopasswd } from './api'
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

export interface SudoOpts {
  /* show the "add OpenVPN to sudoers (no password)" checkbox — only for
     the OpenVPN actions, never for installs like nmap */
  grantCheckbox?: boolean
  /* extra line under the title, e.g. what the password unlocks */
  sub?: string
}

export function isSudoModalOpen(): boolean {
  return open
}

/* Prompt for the sudo password. Resolves true when unlocked (or, in
   passwordless mode, when the user confirms), false when the user
   cancels. The password is held in memory only and auto-expires. */
export function askSudo(opts: SudoOpts = {}): Promise<boolean> {
  return new Promise<boolean>(res => {
    sudoResolver = res
    open = true /* in flight — the async status probe runs before the
                    modal renders; done() clears it on cancel/complete */
    // probe the server for an existing NOPASSWD rule BEFORE rendering so
    // passwordless users never see (or need) the password field
    sudoStatus()
      .then(st => {
        if (!open || sudoResolver !== res) return /* cancelled meanwhile */
        renderSudoModal(opts, !!st.passwordless)
      })
      .catch(() => { if (open) renderSudoModal(opts, false) })
  })
}

export function renderSudoModal(opts: SudoOpts = {}, passwordless = false) {
  document.getElementById('sudo-modal')?.remove()
  open = true
  const app = document.getElementById('app')!
  const m = el('div', 'esc-menu open')
  m.id = 'sudo-modal'
  const box = el('div', 'box')
  box.appendChild(el('div', 'title', 'ROOT ACCESS'))
  const p = el('p', 'sub')
  p.textContent = passwordless
    ? (opts.grantCheckbox
      ? 'This account already has passwordless sudo — no password needed.'
      : opts.sub || 'Passwordless sudo — nothing to enter, just unlock.')
    : opts.sub ||
      'Enter your sudo password to continue. It is held in memory only and auto-expires.'
  box.appendChild(p)

  let inp: HTMLInputElement | null = null
  if (!passwordless) {
    inp = el('input', 'text-input')
    inp.type = 'password'
    inp.autocomplete = 'off'
    inp.placeholder = 'password'
    box.appendChild(inp)
  }

  /* OpenVPN only: opt in to the one-time sudoers grant. */
  let grant: HTMLInputElement | null = null
  if (opts.grantCheckbox) {
    const crow = el('label', 'check-row')
    grant = el('input', 'check-input')
    grant.type = 'checkbox'
    grant.dataset.fk = 'sudo:grant'
    grant.tabIndex = 0
    const cl = el('span', 'check-label',
      passwordless
        ? 'Add OpenVPN to sudoers — keep passwordless openvpn'
        : 'Add OpenVPN to sudoers — never ask for this password again')
    crow.appendChild(grant)
    crow.appendChild(cl)
    box.appendChild(crow)
  }

  const err = el('div', 'form-err')
  box.appendChild(err)
  const row = el('div', 'btn-row')
  const cancel = el('button', 'btn', passwordless ? 'SKIP' : 'CANCEL')
  const ok = el('button', 'btn', 'UNLOCK')
  ok.classList.add('active')

  const doUnlock = () => {
    err.textContent = ''
    const chain = passwordless
      ? Promise.resolve()
      : sudoVerify(inp!.value)
    chain
      .then(() => {
        if (grant && grant.checked) {
          return sudoOpenvpnNopasswd()
            .catch((e: any) => {
              err.textContent =
                `unlocked — but the sudoers rule failed: ${e.message || e}`
            })
        }
      })
      .then(() => {
        const g = grant?.checked
        if (g && err.textContent) {
          /* keep the modal up so the error is visible; UNLOCK again to
             close it (the grant is idempotent — it just re-applies) */
          inp!.value = ''
          return
        }
        done(true)
      })
      .catch(() => { err.textContent = 'wrong password — try again' })
  }
  const done = (okb: boolean) => {
    open = false
    sudoResolver?.(okb)
    sudoResolver = null
    m.remove()
  }
  cancel.addEventListener('click', () => done(false))
  ok.addEventListener('click', doUnlock)

  /* One keyboard cycle over the whole modal:
       [password] → (checkbox) → UNLOCK → CANCEL/SKIP → [password] → …
     Tab AND Shift+Tab wrap; arrows follow the same cycle. Space AND
     Enter toggle the checkbox when it is focused. */
  const cycle: HTMLElement[] = [
    ...(inp ? [inp] : []),
    ...(grant ? [grant] : []),
    ok, cancel,
  ]
  const focusAt = (i: number) =>
    cycle[(i + cycle.length) % cycle.length].focus()
  const idxOf = (t: EventTarget | null) =>
    cycle.indexOf(t as HTMLElement)

  const onCyclic = (t: HTMLElement) => (e: KeyboardEvent) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      focusAt(idxOf(t) + (e.shiftKey ? -1 : 1))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' ||
               e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      focusAt(idxOf(t) + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter') {
      if (t === ok) { e.preventDefault(); doUnlock() }
      else if (t === cancel) { e.preventDefault(); done(false) }
      else if (t === grant) { e.preventDefault(); grant!.checked = !grant!.checked }
    } else if (e.key === ' ' && t === grant) {
      /* Space toggles natively; prevent the page from scrolling */
      e.preventDefault()
      grant!.checked = !grant!.checked
    } else if (e.key === 'Escape') {
      e.preventDefault()
      done(false)
    }
    e.stopPropagation()
  }
  /* the password field additionally keeps Enter = unlock */
  if (inp) {
    const onPw = (e: KeyboardEvent) => {
      if (e.key === 'Enter') { e.preventDefault(); doUnlock(); e.stopPropagation(); return }
      onCyclic(inp)(e)
    }
    inp.addEventListener('keydown', onPw)
  }
  if (grant) grant.addEventListener('keydown', onCyclic(grant))
  ok.addEventListener('keydown', onCyclic(ok))
  cancel.addEventListener('keydown', onCyclic(cancel))

  row.appendChild(ok); row.appendChild(cancel)
  box.appendChild(row)
  m.appendChild(box)
  app.appendChild(m)
  overlay.wake()
  setTimeout(() => cycle[0].focus(), 30)
}
