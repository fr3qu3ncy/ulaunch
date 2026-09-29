/** BT screen: pick adapter -> live BLE scan (bleak/BlueZ, poll every 5s) ->
 *  results: one card per device with everything the advertisement carries
 *  (name, MAC, RSSI, TX power, SIG manufacturer, GATT services).
 *  Renders into the given container; owns its own state + polling timer. */
import { askSudo } from './sudo'

export interface BleAdapter {
  name: string
  address: string
  powered: boolean
  path: string
}

export interface BleDevice {
  address: string
  name: string
  rssi: number | null
  tx_power: number | null
  manufacturer: string | null
  manufacturer_raw: { cid: number; hex: string; data: string }[]
  services: string[]
  service_data: Record<string, string>
}

export interface BleStatus {
  status: 'idle' | 'running' | 'stopped' | 'error'
  error: string
  started: number
  updated: number
  devices: BleDevice[]
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
  return (s || '').replace(/[&<>\"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[ch]!))
}

/* RSSI as a 10-block bar. BLE signal levels live in roughly -90 (faint)
   to -40 (point-blank) dBm; clamp outside that window. */
function rssiBar(dbm: number | null): string {
  if (dbm === null) return ''
  const n = Math.max(0, Math.min(10, Math.round((dbm + 90) / 5)))
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

/* strongest first — the natural order for "what's around me" */
function sortDevices(devs: BleDevice[]): BleDevice[] {
  return [...devs].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
}

export interface BleHandle {
  destroy(): void
}

export function mountBle(container: HTMLElement): BleHandle {
  let destroyed = false
  let phase: 'pick' | 'results' = 'pick'
  let adapters: BleAdapter[] = []
  let selIndex = 0
  let bluezOk: boolean | null = null
  let status: BleStatus = {
    status: 'idle', error: '', started: 0, updated: 0, devices: [],
  }
  let restored = false
  let timer: number | null = null
  /* fingerprint of the last rendered device list — a poll that returns an
     unchanged list skips the DOM rebuild entirely (no flicker, stable
     scroll/focus) */
  let lastFingerprint = ''
  let resultsRendered = false

  const root = el('div', 'ble-root')
  container.appendChild(root)

  function stopPoll() {
    if (timer !== null) { clearInterval(timer); timer = null }
  }
  function fingerprint(s: BleStatus): string {
    return [s.status, s.error, s.updated,
      ...s.devices.map(d => d.address + d.rssi + d.name + d.manufacturer)]
      .join('|')
  }
  function startPoll() {
    stopPoll()
    timer = window.setInterval(async () => {
      if (destroyed) return
      try {
        const st = await getJSON<BleStatus>('/api/ble/status')
        const changed = fingerprint(st) !== lastFingerprint
        status = st
        if (st.status !== 'running') { stopPoll(); render(); return }
        if (changed) render()
      } catch { /* keep last state */ }
    }, 5000)
  }

  /* ── actions ───────────────────────────────────────────────── */
  async function startScan() {
    const opt = adapters[selIndex]
    if (status.status === 'running') return
    for (;;) {
      let r: Response
      try {
        r = await fetch('/api/ble/scan/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ adapter: opt ? opt.name : null }),
        })
      } catch (e: any) {
        alert(String(e.message || e)); return
      }
      if (r.status === 401) {
        if (!(await askSudo({
          sub: 'Enter your sudo password to scan for bluetooth devices.',
        }))) return
        continue
      }
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail
          || `scan failed (${r.status})`
        if (/bluez|bluetooth daemon/i.test(detail) && bluezOk) {
          bluezOk = false; render()
        }
        return
      }
      status = (await r.json()) as BleStatus
      restored = false
      phase = 'results'
      startPoll()
      render()
      return
    }
  }

  async function stopScan() {
    try {
      status = (await (await fetch('/api/ble/scan/stop', { method: 'POST' }))
        .json()) as BleStatus
    } catch { /* ignore */ }
    stopPoll()
    render()
  }

  /* Install bluez (the bluetooth daemon). Mirrors the nmap install flow:
     on 401 pop the in-app sudo modal and retry. */
  async function installBluez(btn: HTMLButtonElement) {
    const label = btn.textContent
    btn.disabled = true
    btn.textContent = 'installing…'
    const restore = () => { btn.disabled = false; btn.textContent = label }
    for (;;) {
      let r: Response
      try {
        r = await fetch('/api/tools/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: 'bluez' }),
        })
      } catch (e: any) {
        restore(); alert(String(e.message || e)); return
      }
      if (r.status === 401) {
        if (!(await askSudo({
          sub: 'Enter your sudo password to install bluez bluetooth.',
        }))) { restore(); return }
        continue
      }
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail
          || `install failed (${r.status})`
        restore(); alert(detail); return
      }
      bluezOk = true
      render()
      return
    }
  }

  function actionButton(fk: string): HTMLButtonElement {
    const running = status.status === 'running'
    const b = el('button', `btn ${running ? 'danger' : 'active'}`,
      running ? '■ STOP SCAN' : '▶ SCAN AGAIN')
    b.tabIndex = 0
    b.dataset.fk = fk
    b.addEventListener('click', () => {
      if (running) void stopScan()
      else void startScan()
    })
    return b
  }

  function actionRow(fk: string): HTMLElement {
    const row = el('div', 'btn-row')
    row.appendChild(actionButton(fk))
    return row
  }

  /* ── views ─────────────────────────────────────────────────── */
  function renderPick() {
    const ae = document.activeElement as HTMLElement | null
    const fk = (ae && root.contains(ae) ? ae.dataset.fk : undefined)

    root.innerHTML = ''
    const c = el('div', 'ble-content')
    c.appendChild(el('div', 'section-title', 'SELECT ADAPTER'))

    if (adapters.length === 0) {
      c.appendChild(el('div', 'empty',
        'no bluetooth adapters found — check `hciconfig` for an hci* adapter'))
    } else {
      const list = el('div', 'scan-opt-list')
      adapters.forEach((a, i) => {
        const b = el('button', `scan-opt ble-opt ${i === selIndex ? 'active' : ''}`)
        b.tabIndex = 0
        b.dataset.fk = `bleopt:${i}`
        const head = el('span', 'scan-opt-head')
        head.innerHTML =
          `<span class="dot ${a.powered ? 'on' : 'warn'}"></span><b>${esc(a.name)}</b>`
        b.appendChild(head)
        b.appendChild(el('span', 'scan-opt-sub',
          a.address || (a.powered ? 'powered on' : 'powered off')))
        b.addEventListener('click', () => { selIndex = i; render() })
        list.appendChild(b)
      })
      c.appendChild(list)
    }

    /* last in the DOM on purpose: with bluez missing the START button is
       disabled (excluded from the focus cycle), so the install banner is
       the final keyboard stop (same trap as the nmap + wifi screens). */
    if (bluezOk === false) {
      const tb = el('div', 'tool-banner')
      tb.innerHTML = '<span>⚠ bluez bluetooth not installed — scanning unavailable</span>'
      const inst = el('button', 'btn active', 'INSTALL BLUETOOTH')
      inst.tabIndex = 0
      inst.dataset.fk = 'bleinstall'
      inst.addEventListener('click', () => installBluez(inst))
      tb.appendChild(inst)
      c.appendChild(tb)
    }

    if (adapters.length > 0) {
      const row = el('div', 'btn-row')
      const start = el('button', 'btn active big', '▶ START SCAN')
      start.tabIndex = 0
      start.dataset.fk = 'blestart'
      if (bluezOk === false) {
        start.disabled = true; start.title = 'install bluez first'
      }
      start.addEventListener('click', startScan)
      row.appendChild(start)
      c.appendChild(row)
    }
    root.appendChild(c)

    if (fk) {
      const prev = root.querySelector<HTMLElement>(`[data-fk="${fk}"]`)
      if (prev && !(prev as HTMLButtonElement).disabled) { prev.focus(); return }
    }
    const ae2 = document.activeElement as HTMLElement | null
    if (adapters.length > 0 && (!ae2 || !root.contains(ae2))) {
      root.querySelector<HTMLElement>('.ble-opt, .btn, [tabindex="0"]')?.focus()
    }
  }

  function renderResults() {
    root.innerHTML = ''
    const c = el('div', 'ble-content')

    const head = el('div', 'scan-head')
    head.appendChild(el('span', 'ble-target',
      status.updated ? 'BLE' : (restored ? 'bluetooth' : '')))
    const running = status.status === 'running'
    head.appendChild(el('span', `scan-status ${status.status}`,
      (restored && !running ? 'LAST SCAN · ' : '') + status.status.toUpperCase()))
    c.appendChild(head)

    const count = el('div', 'scan-live')
    const stamp = status.updated
      ? new Date(status.updated * 1000).toLocaleTimeString() : '—'
    count.innerHTML = `<b class="scan-live-n">${status.devices.length}</b> DEVICE(S)` +
      (running ? ` · SCANNING · updated ${stamp}` : ` · updated ${stamp}`)
    c.appendChild(count)

    c.appendChild(actionRow('ble:action-top'))

    if (status.status === 'error') {
      c.appendChild(el('div', 'form-err',
        `scan error: ${status.error || 'unknown'}`))
    }

    const devs = sortDevices(status.devices)
    devs.forEach((d, i) => {
      const card = el('div', 'ble-cell')
      card.tabIndex = 0
      card.dataset.fk = `blecell:${i}`
      const headRow = el('div', 'ble-cell-head')
      if (d.name) {
        headRow.appendChild(el('b', 'ble-name', d.name))
      } else {
        headRow.appendChild(el('span', 'ble-name ble-name-hidden', 'unnamed device'))
      }
      if (d.manufacturer) {
        headRow.appendChild(el('span', 'ble-maker', d.manufacturer))
      }
      headRow.appendChild(el('span', 'ble-addr', d.address))
      card.appendChild(headRow)

      const meta = el('div', 'ble-cell-meta')
      const bits: string[] = []
      bits.push(`SIG <b>${esc(String(d.rssi ?? '?'))}</b> dBm [${rssiBar(d.rssi)}]`)
      if (d.tx_power !== null) bits.push(`TX ${esc(String(d.tx_power))} dBm`)
      if (d.services.length) {
        const shown = d.services.slice(0, 3).map(esc).join(' ')
        bits.push(`SVC ${shown}${d.services.length > 3 ? ` +${d.services.length - 3}` : ''}`)
      }
      if (d.manufacturer_raw.length) {
        const mfr = d.manufacturer_raw.map(m =>
          m.hex ? `0x${m.hex}${m.data ? ' ' + esc(m.data.slice(0, 16)) : ''}` : '')
          .filter(Boolean).join(' ')
        bits.push(`MFR ${mfr}`)
      }
      if (d.service_data) {
        const sd = Object.entries(d.service_data).slice(0, 2)
          .map(([u, v]) => `${esc(u)} ${esc(String(v).slice(0, 12))}`).join(' ')
        bits.push(`SD ${sd}`)
      }
      meta.innerHTML = bits.join(' · ')
      card.appendChild(meta)
      c.appendChild(card)
    })
    if (!devs.length && !running) {
      c.appendChild(el('div', 'empty', 'no devices found'))
    }

    c.appendChild(actionRow('ble:action-bottom'))
    root.appendChild(c)

    /* first results render: pin the pane to the top (heading stays
       visible) and drop focus on the first cell. Live re-renders skip
       BOTH — the user may have scrolled down and the focused cell is
       restored by address in render(). */
    if (!resultsRendered) {
      resultsRendered = true
      container.scrollTop = 0
      const ae = document.activeElement as HTMLElement | null
      if (!ae || !root.contains(ae)) {
        root.querySelector<HTMLElement>('.ble-cell')
          ?.focus({ preventScroll: true })
      }
    }
  }

  function render() {
    if (destroyed) return
    if (phase === 'results') {
      /* preserve the focused card across the 5s re-render — the fk index
         follows the RENDER (RSSI-sorted) order, so restore by address:
         read the focused card's MAC from the live DOM, re-render, then
         focus the card that carries the same MAC */
      const ae = document.activeElement as HTMLElement | null
      const fk = (ae && root.contains(ae) ? ae.dataset.fk : undefined)
      let focusedAddr: string | null = null
      if (fk && fk.startsWith('blecell:')) {
        const card = root.querySelector<HTMLElement>(`[data-fk="${fk}"]`)
        focusedAddr = card?.querySelector<HTMLElement>('.ble-addr')?.textContent || null
      }
      renderResults()
      lastFingerprint = fingerprint(status)
      if (fk === 'ble:action-bottom' || fk === 'ble:action-top') {
        root.querySelector<HTMLElement>(`[data-fk="${fk}"]`)?.focus()
        return
      }
      if (focusedAddr) {
        const cards = Array.from(root.querySelectorAll<HTMLElement>('.ble-cell'))
        const idx = cards.findIndex(c =>
          c.querySelector('.ble-addr')?.textContent === focusedAddr)
        if (idx >= 0) {
          cards[idx].focus({ preventScroll: true })
          return
        }
        /* the device dropped out of this scan — park on the first card so
           the keyboard isn't stranded on a body element */
        root.querySelector<HTMLElement>('.ble-cell')?.focus({ preventScroll: true })
        return
      } else if (fk) {
        root.querySelector<HTMLElement>(`[data-fk="${fk}"]`)?.focus()
      }
      return
    }
    renderPick()
  }

  /* initial data: adapters + bluez availability, and whether a session is
     already live (a tool switch must restore the live view) */
  getJSON<{ adapters: BleAdapter[]; bluez: { installed: boolean; running: boolean } }>(
    '/api/ble/adapters')
    .then(a => {
      if (destroyed) return
      adapters = a.adapters
      bluezOk = a.bluez.installed
      const onIdx = adapters.findIndex(x => x.powered)
      if (onIdx >= 0) selIndex = onIdx
      if (phase === 'pick') render()
    })
    .catch(() => { if (phase === 'pick') render() })

  getJSON<BleStatus>('/api/ble/status').then(st => {
    if (destroyed) return
    status = st
    if (st.status === 'running') {
      phase = 'results'
      restored = true
      startPoll()
      render()
      return
    }
    if ((st.status === 'stopped' || st.status === 'error') && st.devices.length) {
      phase = 'results'
      restored = true
      render()
    }
  }).catch(() => {})

  return {
    destroy() {
      destroyed = true
      stopPoll()
      root.remove()
    },
  }
}
