/** WIFI screen: pick adapter -> live scan (iwlist, refresh every 5s) ->
 *  results grouped by frequency band, channel, quality.
 *  Renders into the given container; owns its own state + polling timer. */
import { askSudo } from './sudo'

export interface WifiAdapter {
  name: string
  up: boolean
  channel: number | null
}

export interface WifiCell {
  bssid: string
  channel: number | null
  frequency: number | null
  band: string
  quality: number | null
  quality_max: number | null
  signal_dbm: number | null
  encryption: string
  essid: string
  mode: string
}

export interface WifiStatus {
  status: 'idle' | 'running' | 'stopped' | 'error'
  scanning: boolean
  iface: string | null
  error: string
  started: number
  updated: number
  cells: WifiCell[]
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
  return (s || '').replace(/[&<>"]/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))
}

/* quality as a 10-block bar — terminal style, monochrome */
function qbar(q: number | null, max: number | null): string {
  if (q === null || max === null || max <= 0) return ''
  const n = Math.max(0, Math.min(10, Math.round((q / max) * 10)))
  return '█'.repeat(n) + '░'.repeat(10 - n)
}

/* group key: frequency band -> channel -> quality (desc) */
function sortCells(cells: WifiCell[]): WifiCell[][] {
  const groups = new Map<string, WifiCell[]>()
  const key = (c: WifiCell) =>
    `${c.band}::${c.channel === null ? 9999 : c.channel}`
  for (const c of cells) {
    const k = key(c)
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(c)
  }
  const bandOrder: Record<string, number> = { '2.4': 0, '5': 1, '6': 2, other: 3 }
  const keys = [...groups.keys()].sort((a, b) => {
    const [ba, ca] = a.split('::')
    const [bb, cb] = b.split('::')
    const bo = (bandOrder[ba] ?? 9) - (bandOrder[bb] ?? 9)
    if (bo !== 0) return bo
    return (Number(ca) - Number(cb)) || 0
  })
  return keys.map(k => {
    const list = groups.get(k)!
    list.sort((x, y) => (y.quality ?? -1) - (x.quality ?? -1))
    return list
  })
}

export interface WifiHandle {
  destroy(): void
}

export function mountWifi(container: HTMLElement): WifiHandle {
  let destroyed = false
  /* phases: pick (adapter select) | results (live or finished) */
  let phase: 'pick' | 'results' = 'pick'
  let adapters: WifiAdapter[] = []
  let selIndex = 0
  let iwlistOk: boolean | null = null
  let status: WifiStatus = {
    status: 'idle', scanning: false, iface: null, error: '',
    started: 0, updated: 0, cells: [],
  }
  let restored = false /* results came from a live/finished session, not this mount's start */
  let timer: number | null = null
  /* fingerprint of the last rendered cell list — a 5s poll that returns
     an unchanged list (or only re-sorted it) skips the DOM rebuild
     entirely, so the list doesn't flicker and scroll/focus are stable */
  let lastFingerprint = ''
  let resultsRendered = false /* the first results render pins scrollTop;
     live re-renders must NOT (that would fight the user's scroll) */

  const root = el('div', 'wifi-root')
  container.appendChild(root)

  function stopPoll() {
    if (timer !== null) { clearInterval(timer); timer = null }
  }
  function fingerprint(s: WifiStatus): string {
    return [s.status, s.scanning, s.iface, s.error, s.updated,
      ...s.cells.map(c2 => c2.bssid + c2.quality + c2.signal_dbm + c2.mode)]
      .join('|')
  }
  /* poll the live session every 5 s — the same rhythm as the server's
     scan refresh, so each poll lands on a fresh scan's results */
  function startPoll() {
    stopPoll()
    timer = window.setInterval(async () => {
      if (destroyed) return
      try {
        const st = await getJSON<WifiStatus>('/api/wifi/status')
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
    if (!opt || status.status === 'running') return
    for (;;) {
      let r: Response
      try {
        r = await fetch('/api/wifi/scan/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ interface: opt.name }),
        })
      } catch (e: any) {
        alert(String(e.message || e)); return
      }
      if (r.status === 401) {
        /* sudo password required (stock accounts) — the in-app modal,
           no OpenVPN grant checkbox (that's a VPN thing) */
        if (!(await askSudo({
          sub: 'Enter your sudo password to scan with this wifi adapter.',
        }))) return
        continue /* retry — the password is now cached server-side */
      }
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail
          || `scan failed (${r.status})`
        alert(detail)
        if (/wireless-tools/i.test(detail) && iwlistOk) {
          iwlistOk = false; render()
        }
        return
      }
      status = (await r.json()) as WifiStatus
      restored = false
      phase = 'results'
      startPoll()
      render()
      return
    }
  }

  async function stopScan() {
    try {
      status = (await (await fetch('/api/wifi/scan/stop', { method: 'POST' }))
        .json()) as WifiStatus
    } catch { /* ignore */ }
    stopPoll()
    render()
  }

  /* Install wireless-tools (provides iwlist). Mirrors the nmap install
     flow: on 401 pop the in-app sudo modal and retry. */
  async function installIwlist(btn: HTMLButtonElement) {
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
          body: JSON.stringify({ tool: 'wireless-tools' }),
        })
      } catch (e: any) {
        restore(); alert(String(e.message || e)); return
      }
      if (r.status === 401) {
        if (!(await askSudo({
          sub: 'Enter your sudo password to install wireless-tools.',
        }))) { restore(); return }
        continue
      }
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).detail
          || `install failed (${r.status})`
        restore(); alert(detail); return
      }
      iwlistOk = true
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

  /* the action button appears TWICE — at the TOP of the results list (so a
     tool switch back into the tool finds STOP without scrolling, like the
     nmap results' top NEW SCAN) and at the bottom (where ↓ from the last
     cell lands). Both run the same start/stop. */
  function actionRow(): HTMLElement {
    const row = el('div', 'btn-row')
    row.appendChild(actionButton('wifi:action-top'))
    return row
  }

  /* ── views ─────────────────────────────────────────────────── */
  function renderPick() {
    /* remember the focused control (stable data-fk) across re-renders */
    const ae = document.activeElement as HTMLElement | null
    const fk = (ae && root.contains(ae) ? ae.dataset.fk : undefined)

    root.innerHTML = ''
    const c = el('div', 'wifi-content')
    c.appendChild(el('div', 'section-title', 'SELECT ADAPTER'))

    if (adapters.length === 0) {
      c.appendChild(el('div', 'empty',
        'no wireless adapters found — check `ip link` for a wlan* interface'))
    } else {
      const list = el('div', 'scan-opt-list')
      adapters.forEach((a, i) => {
        const b = el('button', `scan-opt wifi-opt ${i === selIndex ? 'active' : ''}`)
        b.tabIndex = 0
        b.dataset.fk = `wifiopt:${i}`
        const head = el('span', 'scan-opt-head')
        head.innerHTML =
          `<span class="dot ${a.up ? 'on' : ''}"></span><b>${esc(a.name)}</b>`
        head.appendChild(el('span', 'c-type wifi', 'wifi'))
        b.appendChild(head)
        b.appendChild(el('span', 'scan-opt-sub',
          a.channel !== null ? `channel ${a.channel}` : (a.up ? 'up' : 'down')))
        b.addEventListener('click', () => { selIndex = i; render() })
        list.appendChild(b)
      })
      c.appendChild(list)
    }

    /* last in the DOM on purpose: with iwlist missing the START button is
       disabled (excluded from the focus cycle), so the install banner is
       the final keyboard stop — arrows/Tab from the last option land on
       INSTALL instead of wrapping back. (Same trap as the nmap screen.) */
    if (iwlistOk === false) {
      const tb = el('div', 'tool-banner')
      tb.innerHTML = '<span>⚠ wireless-tools not installed — scanning unavailable</span>'
      const inst = el('button', 'btn active', 'INSTALL WIRELESS-TOOLS')
      inst.tabIndex = 0
      inst.dataset.fk = 'wifiinstall'
      inst.addEventListener('click', () => installIwlist(inst))
      tb.appendChild(inst)
      c.appendChild(tb)
    }

    if (adapters.length > 0) {
      const row = el('div', 'btn-row')
      const start = el('button', 'btn active big', '▶ START SCAN')
      start.tabIndex = 0
      start.dataset.fk = 'wifistart'
      if (iwlistOk === false) {
        start.disabled = true; start.title = 'install wireless-tools first'
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
      root.querySelector<HTMLElement>('.wifi-opt, .btn, [tabindex="0"]')?.focus()
    }
  }

  function renderResults() {
    root.innerHTML = ''
    const c = el('div', 'wifi-content')

    const head = el('div', 'scan-head')
    head.appendChild(el('span', 'wifi-target',
      status.iface ?? (restored ? 'wifi' : '')))
    const running = status.status === 'running'
    head.appendChild(el('span', `scan-status ${status.status}`,
      (restored && !running ? 'LAST SCAN · ' : '') + status.status.toUpperCase()))
    c.appendChild(head)

    const count = el('div', 'scan-live')
    const stamp = status.updated
      ? new Date(status.updated * 1000).toLocaleTimeString() : '—'
    count.innerHTML = `<b class="scan-live-n">${status.cells.length}</b> NETWORK(S)` +
      (running ? ` · SCANNING · updated ${stamp}` : ` · updated ${stamp}`)
    c.appendChild(count)

    /* top action button — reachable without scrolling after a tool switch
       (the nmap results' top NEW SCAN, same idea) */
    c.appendChild(actionRow())

    if (status.status === 'error') {
      c.appendChild(el('div', 'form-err',
        `scan error: ${status.error || 'unknown'}`))
    }

    const groups = sortCells(status.cells)
    if (groups.length) {
      let ci = 0
      for (const g of groups) {
        const c0 = g[0]
        const gtitle = el('div', 'wifi-group')
        gtitle.innerHTML =
          `<b>${esc(c0.band)} GHz</b> · CH ${c0.channel ?? '?'} ` +
          `<span class="wifi-group-n">(${g.length})</span>`
        c.appendChild(gtitle)
        for (const cell of g) {
          ci++
          const d = el('div', 'wifi-cell')
          d.tabIndex = 0
          d.dataset.fk = `wificell:${ci - 1}`
          const hidden = !cell.essid
          const headRow = el('div', 'wifi-cell-head')
          headRow.appendChild(el(
            hidden ? 'span' : 'b', hidden ? 'wifi-ssid wifi-ssid-hidden' : 'wifi-ssid',
            hidden ? 'hidden network' : cell.essid))
          const lock = el('span', cell.encryption === 'off' ? 'wifi-lock open' : 'wifi-lock',
            cell.encryption === 'off' ? 'open' : '🔒 encrypted')
          headRow.appendChild(lock)
          if (cell.mode) headRow.appendChild(el('span', 'wifi-mode', cell.mode.toUpperCase()))
          d.appendChild(headRow)
          const meta = el('div', 'wifi-cell-meta')
          const bits: string[] = []
          bits.push(`CH <b>${esc(String(cell.channel ?? '?'))}</b>`)
          if (cell.frequency) bits.push(`${esc(String(cell.frequency))} GHz`)
          if (cell.signal_dbm !== null) bits.push(`SIG <b>${cell.signal_dbm}</b> dBm`)
          if (cell.quality !== null && cell.quality_max !== null) {
            bits.push(`QUAL ${cell.quality}/${cell.quality_max} [${qbar(cell.quality, cell.quality_max)}]`)
          }
          bits.push(`BSSID ${esc(cell.bssid)}`)
          meta.innerHTML = bits.join(' · ')
          d.appendChild(meta)
          c.appendChild(d)
        }
      }
    } else if (!running) {
      c.appendChild(el('div', 'empty', 'no networks found'))
    }

    const row = el('div', 'btn-row')
    row.appendChild(actionButton('wifi:action-bottom'))
    c.appendChild(row)
    root.appendChild(c)

    /* first results render: pin the pane to the top (heading stays
       visible) and drop focus on the first cell. Live re-renders skip
       BOTH — the user may have scrolled down the list and the focused
       cell is restored by BSSID in render(). */
    if (!resultsRendered) {
      resultsRendered = true
      container.scrollTop = 0
      const ae = document.activeElement as HTMLElement | null
      if (!ae || !root.contains(ae)) {
        root.querySelector<HTMLElement>('.wifi-cell')
          ?.focus({ preventScroll: true })
      }
    }
  }

  function render() {
    if (destroyed) return
    if (phase === 'results') {
      /* preserve the focused cell across the 5s re-render — a cell's fk
         index shifts when the list re-sorts, so restore by BSSID */
      const ae = document.activeElement as HTMLElement | null
      const fk = (ae && root.contains(ae) ? ae.dataset.fk : undefined)
      const focusedBssid = fk && fk.startsWith('wificell:')
        ? (status.cells[Number(fk.slice('wificell:'.length))]?.bssid ?? null)
        : null
      renderResults()
      lastFingerprint = fingerprint(status)
      if (fk === 'wifi:action-bottom' || fk === 'wifi:action-top') {
        root.querySelector<HTMLElement>(`[data-fk="${fk}"]`)?.focus()
        return
      }
      if (focusedBssid) {
        /* find the cell with the same BSSID and focus it (preventScroll —
           a 5s re-render must not scroll the list under the user). The fk
           index is pre-sort: if the bssid dropped out, fall through to the
           first cell (never restore a stale index — it points elsewhere) */
        const idx = status.cells.findIndex(c2 => c2.bssid === focusedBssid)
        if (idx >= 0) {
          root.querySelector<HTMLElement>(`[data-fk="wificell:${idx}"]`)
            ?.focus({ preventScroll: true })
          return
        }
        /* the bssid dropped out of this scan — park on the first cell so
           the keyboard isn't stranded on a body element */
        root.querySelector<HTMLElement>('.wifi-cell')?.focus({ preventScroll: true })
        return
      } else if (fk) {
        /* a non-cell control (the action button is handled above) */
        root.querySelector<HTMLElement>(`[data-fk="${fk}"]`)?.focus()
      }
      return
    }
    renderPick()
  }

  /* initial data: adapters + iwlist availability, and whether a session
     is already live (a tool switch must restore the live view) */
  getJSON<{ adapters: WifiAdapter[]; iwlist: boolean }>('/api/wifi/adapters')
    .then(a => {
      if (destroyed) return
      adapters = a.adapters
      iwlistOk = a.iwlist
      /* prefer an adapter that is UP if one exists */
      const upIdx = adapters.findIndex(x => x.up)
      if (upIdx >= 0) selIndex = upIdx
      if (phase === 'pick') render()
    })
    .catch(() => { if (phase === 'pick') render() })

  getJSON<WifiStatus>('/api/wifi/status').then(st => {
    if (destroyed) return
    status = st
    if (st.status === 'running') {
      phase = 'results'
      restored = true
      startPoll()
      render()
      return
    }
    if ((st.status === 'stopped' || st.status === 'error') && st.cells.length) {
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
