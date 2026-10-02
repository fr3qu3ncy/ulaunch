/** NETWORK screen: the interface dashboard (cards) + the Wi-Fi connect
 *  section (list visible networks, enter a passphrase, saved networks).
 *  Renders into the given container; owns its own state + polling timer.
 *
 *  The interface cards are display-only; the wifi section is interactive —
 *  each network row is a keyboard stop (Enter = connect), with a DISCONNECT
 *  on the connected card and FORGET on saved rows. A 401 on connect pops the
 *  in-app sudo modal (nmcli is privileged); a missing nmcli shows the install
 *  banner. Passphrases are stored on-device by the backend (never returned).
 *
 *  FOCUS MODEL: the component paints async (load() resolves a tick after
 *  mount). `autoFocus` is true ONLY when the user ENTERED the tool (go()
 *  drops focus into it) — then the first paint claims the first control. At
 *  boot (autoFocus=false) the user is on the icon bar and the first paint
 *  must NOT steal that tile focus. A poll re-render restores the focused
 *  control by fk/ssid; if focus was not in the section it leaves it be.
 */
import {
  type NetInfo, type WifiConnectList, wifiConnectForget,
} from './api'
import { askSudo } from './sudo'
import { askPassphrase, askConfirm } from './wifiPass'

export interface WifiNetHandle {
  destroy(): void
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return r.json() as Promise<T>
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function esc(s: string): string {
  return (s || '').replace(/[&<"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '"': '&quot;' }[ch]!))
}

/* In-app error flash (replaces the banned browser alert()): a small banner
   at the bottom of the screen, NON-modal — it does not take the keyboard,
   does not touch focus, and auto-dismisses after a few seconds. Stacked
   calls replace the previous banner (one message at a time). */
let errTimer: number | null = null
function flashErr(msg: string) {
  document.getElementById('wifinet-err')?.remove()
  const app = document.getElementById('app')
  if (!app) return
  const b = el('div', 'wifinet-err')
  b.id = 'wifinet-err'
  b.textContent = msg
  app.appendChild(b)
  if (errTimer !== null) clearTimeout(errTimer)
  errTimer = window.setTimeout(() => {
    document.getElementById('wifinet-err')?.remove()
    errTimer = null
  }, 6000)
}

/* signal 0-100 as a 10-block bar — terminal style */
function sigbar(v: number | null): string {
  if (v === null) return ''
  const n = Math.max(0, Math.min(10, Math.round(v / 10)))
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

/* ── interface cards (ported from main.ts homeContent) ── */
function ifaceCard(i: NetInfo['interfaces'][number]): HTMLElement {
  const c = el('div', 'card')
  const typeCls = !i.up ? 'down' : i.type
  const head = el('div', 'c-head')
  head.appendChild(el('span', 'dot ' + (i.up ? 'on' : '')))
  head.appendChild(el('span', 'c-name', i.name))
  head.appendChild(el('span', `c-type ${typeCls}`, !i.up ? 'DOWN' : i.type))
  c.appendChild(head)
  if (i.type === 'wifi' && i.up) {
    const sub = el('div', 'c-sub')
    sub.innerHTML = i.ssid
      ? `SSID <b>${esc(i.ssid)}</b>${i.signal !== null ? ` · ${i.signal}%` : ''}`
      : 'connected'
    c.appendChild(sub)
  }
  if (i.ipv4) {
    c.appendChild(el('div', 'c-sub', `IP <b>${esc(i.ipv4.addr)}</b>`))
    c.appendChild(el('div', 'c-sub', `NET <b>${esc(i.ipv4.subnet)}</b>`))
  } else if (i.up) {
    c.appendChild(el('div', 'c-sub', 'no IPv4 address'))
  }
  c.appendChild(el('div', 'c-sub', `STATE ${esc(i.state)}`))
  return c
}

export function mountWifiNet(container: HTMLElement, autoFocus = false): WifiNetHandle {
  let destroyed = false
  const autoFocusFlag = autoFocus
  let net: NetInfo | null = null
  let wifi: WifiConnectList = { cells: [], connected: null, saved: [] }
  let nmcliOk: boolean = true      // false when the backend 400s (nmcli missing)
  let busy: string | null = null   // an ssid currently being connected
  let lastFingerprint = ''
  let firstRender = true           // the component has not painted yet
  let timer: number | null = null

  function stopPoll() { if (timer !== null) { clearInterval(timer); timer = null } }
  /* a modal or the esc-menu is open — the component must NOT steal focus */
  function modalOpen(): boolean {
    return !!(
      document.getElementById('sudo-modal') ||
      document.getElementById('creds-modal') ||
      document.getElementById('wifi-pass-modal') ||
      document.getElementById('wifi-confirm-modal') ||
      document.getElementById('update-overlay') ||
      document.getElementById('esc-menu')?.classList.contains('open')
    )
  }
  function firstControl(): HTMLElement | null {
    /* first FOCUSABLE (non-disabled) control, in priority order — a disabled
       DISCONNECT (mid-action) must not be returned, or .focus() is a no-op
       and focus drops to body */
    const cands = [
      container.querySelector<HTMLElement>('[data-fk="wifinet:disconnect"]'),
      container.querySelector<HTMLElement>('.wifinet-row'),
      container.querySelector<HTMLElement>('[data-fk="wifinet:install"]'),
    ]
    for (const c of cands) if (c && !(c as HTMLButtonElement).disabled) return c
    return null
  }
  /* If focus fell off the section (onto body) after an action re-rendered the
     DOM — the focused control was destroyed, e.g. the clicked DISCONNECT
     button — park it back on the first control so the keyboard stays inside
     the tool. No-op when focus is already in the section (or a modal owns
     it). Call AFTER the action's final render (busy already nulled, so the
     controls are enabled again). */
  function parkFocus() {
    const ae = document.activeElement
    if (ae && container.contains(ae)) return
    if (modalOpen()) return
    firstControl()?.focus({ preventScroll: true })
  }
  function fingerprint(): string {
    return [
      net ? net.hostname : '',
      net ? net.uptime_s : '',
      net ? net.interfaces.map(i => i.name + i.up + i.state + (i.ipv4?.addr || '')).join(',') : '',
      wifi.connected ? wifi.connected.ssid : '',
      ...wifi.cells.map(c => c.ssid + c.signal + c.saved),
      ...wifi.saved.map(s => s.ssid + s.has_pass),
      busy || '',
    ].join('|')
  }

  async function load() {
    /* interface dashboard + the wifi connect list, in parallel */
    const [netRes, wifiRes] = await Promise.allSettled([
      getJSON<NetInfo>('/api/net'),
      getJSON<WifiConnectList>('/api/wifi-connect'),
    ])
    if (destroyed) return
    if (netRes.status === 'fulfilled') net = netRes.value
    if (wifiRes.status === 'fulfilled') {
      wifi = wifiRes.value
      nmcliOk = true
    } else {
      /* 400 = nmcli missing (or the scan failed) — flag the install banner */
      const msg = (wifiRes as PromiseRejectedResult).reason?.message || ''
      if (/nmcli|Network Manager|400/i.test(msg)) nmcliOk = false
    }
    render()
  }

  function startPoll() {
    stopPoll()
    timer = window.setInterval(() => {
      if (destroyed || busy) return   // don't re-render under a connect
      void load()
    }, 10_000)
  }

  /* ── actions ──────────────────────────────────────────── */
  async function connect(ssid: string) {
    if (busy) return
    /* secured + no stored pass -> prompt. An open network (or one with a
       stored pass) goes straight to the backend, which reuses the stored
       passphrase if it has one. */
    const saved = wifi.saved.find(s => s.ssid === ssid)
    const cell = wifi.cells.find(c => c.ssid === ssid)
    const secured = cell ? !cell.open : true
    let pass: string | undefined
    if (secured && !(saved && saved.has_pass)) {
      const p = await askPassphrase(ssid)
      if (p === null) {
        /* cancel — the modal's removal dropped focus to body; park it back
           on the row we were acting on (or the first control if the row
           vanished) so the keyboard is still inside the tool */
        const row = container.querySelector<HTMLElement>(
          `[data-fk="wifinet:avail:${CSS.escape(ssid)}"], [data-fk="wifinet:saved:${CSS.escape(ssid)}"]`)
        ;(row || firstControl())?.focus({ preventScroll: true })
        return
      }
      pass = p
    }
    busy = ssid
    render()
    try {
      let r: Response
      for (;;) {
        try {
          r = await fetch('/api/wifi-connect/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssid, passphrase: pass ?? null }),
          })
        } catch (e: any) {
          busy = null; render(); flashErr(String(e.message || e)); return
        }
        if (r.status === 401) {
          if (!(await askSudo({
            sub: `Enter your sudo password to connect to ${ssid}.`,
          }))) { busy = null; render(); return }
          continue   // password now cached server-side
        }
        break
      }
      const data: any = await r.json().catch(() => ({}))
      if (!r.ok || data.ok === false) {
        flashErr(data.detail || data.error || `connect to ${ssid} failed (${r.status})`)
        busy = null
        render()
        /* the failed row (if it still exists) is where the user was */
        const row = container.querySelector<HTMLElement>(
          `[data-fk="wifinet:avail:${CSS.escape(ssid)}"], [data-fk="wifinet:saved:${CSS.escape(ssid)}"]`)
        ;(row || firstControl())?.focus({ preventScroll: true })
        return
      }
      await load()   // refresh: connected card appears, ssid leaves the list
    } finally {
      busy = null
      if (!destroyed) render()
      /* the clicked/focused control was destroyed by the re-render (or the
         modal's removal dropped focus to body) — park it back inside the
         section (DISCONNECT on the connected card, else the first row) so the
         keyboard is still in the tool */
      if (!destroyed) parkFocus()
    }
  }

  async function disconnect() {
    busy = '__disconnect'
    render()
    try {
      let r: Response
      for (;;) {
        try {
          r = await fetch('/api/wifi-connect/disconnect', { method: 'POST' })
        } catch (e: any) {
          busy = null; render(); flashErr(String(e.message || e)); return
        }
        if (r.status === 401) {
          if (!(await askSudo({ sub: 'Enter your sudo password to disconnect.' }))) {
            busy = null; render(); return
          }
          continue
        }
        break
      }
      const data: any = await r.json().catch(() => ({}))
      if (!r.ok || data.ok === false) {
        flashErr(data.detail || data.error || `disconnect failed (${r.status})`)
      }
      await load()
    } finally {
      busy = null
      if (!destroyed) render()
      /* the clicked DISCONNECT button was destroyed by the re-render → focus
         fell to body; park it back on the first row so the keyboard stays in
         the tool (a stray arrow would otherwise exit to the tile) */
      if (!destroyed) parkFocus()
    }
  }

  async function forget(ssid: string) {
    try {
      await wifiConnectForget(ssid)
    } catch (e: any) {
      flashErr(`could not forget ${ssid}: ${e?.message || e}`); parkFocus(); return
    }
    await load()
    parkFocus()   // the ✕ was destroyed by the re-render → focus was on body
  }

  async function install(btn: HTMLButtonElement) {
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = 'installing…'
    const restore = () => { btn.disabled = false; btn.textContent = label }
    for (;;) {
      let r: Response
      try {
        r = await fetch('/api/tools/install-wifi', { method: 'POST' })
      } catch (e: any) { restore(); flashErr(String(e.message || e)); return }
      if (r.status === 401) {
        if (!(await askSudo({ sub: 'Enter your sudo password to install Network Manager.' }))) {
          restore(); return
        }
        continue
      }
      if (!r.ok) { restore(); flashErr(`install failed (${r.status})`); return }
      nmcliOk = true
      await load()
      return
    }
  }

  /* ── views ────────────────────────────────────────────── */
  function render() {
    if (destroyed) return
    /* capture the focused control (by fk / ssid) + whether focus was in the
       network CONTENT before we clear the DOM */
    const ae = document.activeElement as HTMLElement | null
    const fk = (ae && container.contains(ae) ? ae.dataset.fk : undefined)
    const focusedSsid = (ae && ae.dataset && ae.dataset.ssid) as string | undefined
    const focusWasHere = !!(ae && container.contains(ae))
    const wasFirst = firstRender

    const was = lastFingerprint
    const changed = fingerprint() !== was
    /* skip a no-op poll, but always paint the FIRST render (even if the data
       is momentarily empty) so the section is never blank */
    if (!changed && !busy && !wasFirst) return

    container.innerHTML = ''
    /* INTERFACES */
    container.appendChild(el('div', 'section-title', 'INTERFACES'))
    if (!net) {
      container.appendChild(el('div', 'empty', 'connecting…'))
    } else {
      const cards = el('div', 'cards')
      for (const i of net.interfaces) cards.appendChild(ifaceCard(i))
      container.appendChild(cards)
      if (net.vpn.active) {
        container.appendChild(el('div', 'section-title', 'VPN'))
        const vc = el('div', 'cards')
        const card = el('div', 'card active')
        const head = el('div', 'c-head')
        head.appendChild(el('span', 'dot on'))
        head.appendChild(el('span', 'c-name', 'TUNNEL'))
        head.appendChild(el('span', 'c-type vpn', 'CONNECTED'))
        card.appendChild(head)
        card.appendChild(el('div', 'c-sub', net.vpn.interfaces.join(', ')))
        vc.appendChild(card)
        container.appendChild(vc)
      }
    }

    /* WIFI NETWORKS */
    container.appendChild(el('div', 'section-title', 'WIFI NETWORKS'))
    if (!nmcliOk) {
      const tb = el('div', 'tool-banner')
      tb.innerHTML = '<span>⚠ Network Manager (nmcli) not installed — cannot connect to wifi</span>'
      const inst = el('button', 'btn active', 'INSTALL')
      inst.tabIndex = 0
      inst.dataset.fk = 'wifinet:install'
      inst.addEventListener('click', () => install(inst))
      tb.appendChild(inst)
      container.appendChild(tb)
      finishFocus(fk, focusedSsid, focusWasHere, wasFirst)
      return
    }

    /* connected card */
    if (wifi.connected) {
      const cc = el('div', 'card active wifinet-conn')
      cc.dataset.ssid = wifi.connected.ssid
      const head = el('div', 'c-head')
      head.appendChild(el('span', 'dot on'))
      head.appendChild(el('span', 'c-name', esc(wifi.connected.ssid)))
      head.appendChild(el('span', 'c-type wifi', 'CONNECTED'))
      cc.appendChild(head)
      const meta = el('div', 'c-sub')
      meta.innerHTML = (wifi.connected.signal !== null
        ? `SIGNAL <b>${wifi.connected.signal}%</b> [${sigbar(wifi.connected.signal)}] ` : '')
        + (wifi.connected.open ? '<span class="wifi-lock open">open</span>'
           : `<b>${esc(wifi.connected.security) || 'secure'}</b>`)
        + (wifi.connected.saved ? ' · <span class="wifinet-saved">saved</span>' : '')
      cc.appendChild(meta)
      const row = el('div', 'btn-row')
      const db = el('button', `btn danger ${busy === '__disconnect' ? 'busy' : ''}`,
        busy === '__disconnect' ? 'DISCONNECTING…' : 'DISCONNECT')
      db.tabIndex = 0
      db.dataset.fk = 'wifinet:disconnect'
      if (busy) db.disabled = true
      db.addEventListener('click', () => disconnect())
      row.appendChild(db)
      cc.appendChild(row)
      container.appendChild(cc)
    }

    /* available networks */
    const availTitle = el('div', 'section-title')
    availTitle.textContent = `AVAILABLE (${wifi.cells.length})`
    availTitle.style.marginTop = '0.4em'
    container.appendChild(availTitle)
    if (wifi.cells.length === 0) {
      container.appendChild(el('div', 'empty', 'no networks in range — try SCAN AGAIN from the WIFI tool'))
    } else {
      const list = el('div', 'wifinet-list')
      for (const c of wifi.cells) list.appendChild(availRow(c))
      container.appendChild(list)
    }

    /* saved networks */
    if (wifi.saved.length) {
      container.appendChild(el('div', 'section-title',
        `MY NETWORKS (${wifi.saved.length})`))
      const list = el('div', 'wifinet-list')
      for (const s of wifi.saved) list.appendChild(savedRow(s))
      container.appendChild(list)
    }

    lastFingerprint = fingerprint()
    firstRender = false
    finishFocus(fk, focusedSsid, focusWasHere, wasFirst)
  }

  function availRow(c: WifiConnectList['cells'][number]): HTMLElement {
    const r = el('div', 'wifinet-row')
    r.tabIndex = 0
    r.dataset.fk = `wifinet:avail:${c.ssid}`
    r.dataset.ssid = c.ssid
    r.title = `connect to ${c.ssid}`
    const head = el('div', 'wifinet-row-head')
    head.appendChild(el('b', 'wifinet-ssid', c.ssid))
    if (c.open) head.appendChild(el('span', 'wifi-lock open', 'open'))
    else head.appendChild(el('span', 'wifi-lock', `🔒 ${c.security}`))
    if (c.saved) head.appendChild(el('span', 'wifinet-saved', 'saved'))
    r.appendChild(head)
    const meta = el('div', 'wifinet-row-meta')
    const bits: string[] = []
    if (c.signal !== null) bits.push(`SIG <b>${c.signal}%</b> [${sigbar(c.signal)}]`)
    if (c.channel !== null) bits.push(`CH <b>${c.channel}</b>`)
    bits.push(c.open ? 'open' : esc(c.security || 'secure'))
    meta.innerHTML = bits.join(' · ')
    r.appendChild(meta)
    const hint = el('div', 'wifinet-row-act',
      busy === c.ssid ? 'CONNECTING…' : 'CONNECT ›')
    r.appendChild(hint)
    if (busy === c.ssid) r.classList.add('busy')
    r.addEventListener('click', () => connect(c.ssid))
    return r
  }

  function savedRow(s: WifiConnectList['saved'][number]): HTMLElement {
    const r = el('div', 'wifinet-row wifinet-saved-row')
    r.tabIndex = 0
    r.dataset.fk = `wifinet:saved:${s.ssid}`
    r.dataset.ssid = s.ssid
    r.title = `connect to ${s.ssid} (stored)`
    const head = el('div', 'wifinet-row-head')
    head.appendChild(el('b', 'wifinet-ssid', s.ssid))
    head.appendChild(el('span', 'wifinet-saved', s.has_pass ? 'passphrase stored' : 'saved'))
    r.appendChild(head)
    const meta = el('div', 'wifinet-row-meta')
    meta.innerHTML = (s.last ? `last ${esc(s.last)}` : 'never connected')
    r.appendChild(meta)
    const row = el('div', 'btn-row')
    const cb = el('button', `btn small active ${busy === s.ssid ? 'busy' : ''}`,
      busy === s.ssid ? '…' : 'CONNECT')
    cb.tabIndex = 0
    cb.dataset.fk = `wifinet:savedact:${s.ssid}`
    if (busy) cb.disabled = true
    cb.addEventListener('click', (e) => { e.stopPropagation(); connect(s.ssid) })
    row.appendChild(cb)
    const fb = el('button', 'btn small', '✕')
    fb.tabIndex = 0
    fb.dataset.fk = `wifinet:forget:${s.ssid}`
    fb.title = 'forget this network (and its passphrase)'
    fb.addEventListener('click', async (e) => {
      e.stopPropagation()
      const yes = await askConfirm(
        `FORGET ${s.ssid.toUpperCase()}`,
        'This removes its stored passphrase on this device. Connect to it later will ask for the passphrase again.')
      if (!yes) {
        /* cancel — the modal's removal dropped focus to body; park it back
           on the ✕ we were acting on so the keyboard is still inside the tool */
        container.querySelector<HTMLElement>(`[data-fk="wifinet:forget:${CSS.escape(s.ssid)}"]`)
          ?.focus({ preventScroll: true })
        return
      }
      void forget(s.ssid)
    })
    row.appendChild(fb)
    r.appendChild(row)
    r.addEventListener('click', () => connect(s.ssid))
    return r
  }

  function finishFocus(fk: string | undefined, ssid: string | undefined,
                       focusWasHere: boolean, wasFirst: boolean) {
    /* never steal focus while a modal / the esc-menu owns the keyboard */
    if (modalOpen()) return
    /* FIRST render: claim focus only when the user ENTERED the tool — at
       boot the user is on the icon bar and must keep it */
    if (wasFirst) {
      if (autoFocusFlag) firstControl()?.focus({ preventScroll: true })
      return
    }
    /* poll / action re-render: restore only when the user was in the section
       (otherwise focus is elsewhere and we must not yank it back) */
    if (!focusWasHere) return
    /* restore the focused control by fk, then by ssid (the list re-sorts by
       signal, so an index is not stable) */
    if (fk) {
      const byFk = container.querySelector<HTMLElement>(`[data-fk="${fk}"]`)
      if (byFk && !(byFk as HTMLButtonElement).disabled) { byFk.focus({ preventScroll: true }); return }
    }
    if (ssid) {
      const bySsid = container.querySelector<HTMLElement>(`[data-ssid="${CSS.escape(ssid)}"]`)
      if (bySsid) { bySsid.focus({ preventScroll: true }); return }
    }
    /* the focused row dropped out of range — park on the first control so the
       keyboard isn't stranded on body */
    firstControl()?.focus({ preventScroll: true })
  }

  void load()
  startPoll()

  return {
    destroy() {
      destroyed = true
      stopPoll()
      container.innerHTML = ''
    },
  }
}
