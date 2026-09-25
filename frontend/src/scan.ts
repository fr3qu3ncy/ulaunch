/** SCAN screen: pick interface -> flags -> staged live scan -> results.
 *  Renders into the given container; owns its own state + WebSocket. */

export interface ScanState {
  id: string
  subnet: string
  interface: string
  status: 'pending' | 'running' | 'done' | 'error' | 'cancelled'
  stage: string
  stage_index: number
  hosts: { ip: string; names: string[] }[]
  live_hosts: string[]
  ports: Record<string, PortInfo[]>
  detail: Record<string, PortInfo[]>
  error: string
  started: number
  finished: number
  log_tail: string[]
}

export interface PortInfo {
  port: string
  protocol: string
  state: string
  state_reason?: string
  service: string
  product: string
  version: string
  extrainfo: string
  scripts: { id: string; output: string }[]
}

export interface SubnetOption {
  name: string
  type: string
  subnet: string
  ipv4: string
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return r.json() as Promise<T>
}

export async function scanSubnets(): Promise<SubnetOption[]> {
  return (await getJSON<{ options: SubnetOption[] }>('/api/scan/subnets')).options
}

export async function scanJobs(): Promise<ScanState[]> {
  return getJSON<ScanState[]>('/api/scan/jobs')
}

export async function scanJob(id: string): Promise<ScanState> {
  return getJSON<ScanState>(`/api/scan/jobs/${encodeURIComponent(id)}`)
}

export interface ScanFlags {
  deep: boolean
  service_version: boolean
  scripts: boolean
  udp: boolean
  full_tcp: boolean
  udp_top: number
  custom?: string
}

const DEFAULT_FLAGS: ScanFlags = {
  deep: true, service_version: true, scripts: true,
  udp: false, full_tcp: false, udp_top: 100,
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/* ── component ─────────────────────────────────────────────── */
export interface ScanHandle {
  destroy(): void
}

export function mountScan(container: HTMLElement): ScanHandle {
  let ws: WebSocket | null = null
  let destroyed = false
  let currentJob: ScanState | null = null
  let lastState: ScanState | null = null
  let liveLog: string[] = []

  /* phases: pick -> scan | results */
  let phase: 'pick' | 'scan' | 'results' = 'pick'
  let options: SubnetOption[] = []
  let selIndex = 0
  let flags: ScanFlags = { ...DEFAULT_FLAGS }
  let jobStarted = false

  const root = el('div', 'scan-root')
  container.appendChild(root)

  function renderPick() {
    root.innerHTML = ''
    const c = el('div', 'scan-content')
    c.appendChild(el('div', 'section-title', 'SELECT NETWORK'))

    const list = el('div', 'scan-opt-list')
    options.forEach((o, i) => {
      const b = el('button', `scan-opt ${i === selIndex ? 'active' : ''}`)
      b.tabIndex = 0
      const head = el('span', 'scan-opt-head')
      head.innerHTML = `<span class="dot on"></span><b>${o.name}</b>`
      head.appendChild(el('span', `c-type ${o.type}`, o.type))
      b.appendChild(head)
      b.appendChild(el('span', 'scan-opt-sub', `${o.subnet}  ·  ${o.ipv4}`))
      b.addEventListener('click', () => { selIndex = i; render() })
      list.appendChild(b)
    })
    c.appendChild(list)

    c.appendChild(el('div', 'section-title', 'SCAN OPTIONS'))
    const optsRow = el('div', 'scan-opts')
    const toggles: [keyof ScanFlags, string, string][] = [
      ['deep', 'DEEP SCAN', 'stage 3: service details on open ports'],
      ['service_version', 'VERSIONS (-sV)', 'probe service versions'],
      ['scripts', 'SCRIPTS (-sC)', 'run default nmap scripts'],
      ['udp', 'UDP TOP 100', 'also scan top UDP ports (slower)'],
      ['full_tcp', 'FULL TCP 1-65535', 'sweep every TCP port (very slow)'],
    ]
    for (const [key, label, title] of toggles) {
      const t = el('button', `toggle ${flags[key] ? 'on' : ''}`)
      t.tabIndex = 0
      t.title = title
      t.textContent = label
      t.addEventListener('click', () => {
        flags = { ...flags, [key]: !flags[key] }
        render()
      })
      optsRow.appendChild(t)
    }
    c.appendChild(optsRow)

    if (options.length === 0) {
      c.appendChild(el('div', 'empty', 'no scannable interfaces found'))
    } else {
      const row = el('div', 'btn-row')
      const start = el('button', 'btn active big', '▶  START SCAN')
      start.tabIndex = 0
      start.addEventListener('click', startScan)
      row.appendChild(start)
      c.appendChild(row)
    }
    root.appendChild(c)
  }

  async function startScan() {
    if (jobStarted) return
    const opt = options[selIndex]
    if (!opt) return
    try {
      const r = await fetch('/api/scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subnet: opt.subnet, interface: opt.name, flags,
        }),
      })
      if (!r.ok) throw new Error((await r.json()).detail || 'start failed')
      currentJob = await r.json() as ScanState
      jobStarted = true
      phase = 'scan'
      liveLog = []
      connectWs(currentJob.id)
      render()
    } catch (e: any) {
      alert(String(e.message || e))
    }
  }

  function connectWs(id: string) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws/scan/${id}`)
    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      if (msg.type === 'line') {
        liveLog.push(`[${msg.stage}] ${msg.line}`)
        if (liveLog.length > 400) liveLog = liveLog.slice(-400)
        const box = root.querySelector('.scan-log')
        if (box) {
          box.textContent = liveLog.slice(-120).join('\n')
          box.scrollTop = box.scrollHeight
        }
      } else if (msg.type === 'state') {
        lastState = msg.state
        currentJob = msg.state
        if (msg.state.status === 'done' || msg.state.status === 'error'
            || msg.state.status === 'cancelled') {
          phase = 'results'
          jobStarted = false
          ws?.close()
          render()
        }
      }
    }
    ws.onclose = () => {
      /* poll once to catch state if the socket dropped */
      const jid = currentJob?.id
      if (jid && currentJob &&
          (currentJob.status === 'running' || currentJob.status === 'pending')) {
        setTimeout(async () => {
          if (destroyed) return
          try {
            const st = await scanJob(jid)
            lastState = st
            currentJob = st
            if (st.status !== 'running' && st.status !== 'pending') {
              phase = 'results'
              jobStarted = false
              render()
            }
          } catch { /* ignore */ }
        }, 2000)
      }
    }
  }

  function renderScan() {
    root.innerHTML = ''
    const c = el('div', 'scan-content')
    const st = lastState
    const head = el('div', 'scan-head')
    head.innerHTML = `<span class="scan-target">${st?.subnet ?? ''}</span>`
    head.appendChild(el('span', `scan-status ${st?.status ?? ''}`,
      (st?.status ?? '…').toUpperCase()))
    c.appendChild(head)

    if (st) {
      const prog = el('div', 'scan-progress')
      for (let i = 0; i < 3; i++) {
        const p = el('div', 'prog-step')
        const label = ['DISCOVERY', 'PORTS', 'DEEP'][i]
        p.className = 'prog-step ' +
          (i < st.stage_index ? 'done' : i === st.stage_index ? 'active' : '')
        p.innerHTML = `<span class="prog-dot">${i < st.stage_index ? '✓' : ''}</span>${label}`
        prog.appendChild(p)
      }
      c.appendChild(prog)

      if (st.live_hosts.length) {
        const lh = el('div', 'scan-live')
        lh.innerHTML = `<b class="scan-live-n">${st.live_hosts.length}</b> LIVE HOST(S): ` +
          st.live_hosts.slice(0, 12).join('  ')
        c.appendChild(lh)
      }
    }

    c.appendChild(el('div', 'section-title', 'LIVE OUTPUT'))
    const log = el('pre', 'scan-log')
    log.textContent = liveLog.slice(-120).join('\n') || 'starting…'
    c.appendChild(log)

    const row = el('div', 'btn-row')
    const cancel = el('button', 'btn danger', '■ CANCEL')
    cancel.tabIndex = 0
    cancel.addEventListener('click', async () => {
      if (!currentJob) return
      cancel.disabled = true
      cancel.textContent = 'cancelling…'
      await fetch(`/api/scan/jobs/${currentJob.id}/cancel`, { method: 'POST' })
        .catch(() => {})
    })
    row.appendChild(cancel)
    c.appendChild(row)
    root.appendChild(c)
  }

  function renderResults() {
    root.innerHTML = ''
    const st = lastState
    const c = el('div', 'scan-content')
    if (!st) { c.appendChild(el('div', 'empty', 'no scan')); root.appendChild(c); return }

    const head = el('div', 'scan-head')
    head.innerHTML = `<span class="scan-target">${st.subnet}</span>`
    const dur = st.finished - st.started
    head.appendChild(el('span', `scan-status ${st.status}`,
      `${st.status.toUpperCase()} · ${dur.toFixed(0)}s`))
    c.appendChild(head)

    if (st.error) c.appendChild(el('div', 'form-err', st.error))

    if (st.detail && Object.keys(st.detail).length) {
      c.appendChild(el('div', 'section-title', 'HOSTS · OPEN PORTS'))
      renderHostGrid(c, st.detail)
    } else if (st.ports && Object.keys(st.ports).length) {
      c.appendChild(el('div', 'section-title', 'OPEN PORTS'))
      renderHostGrid(c, Object.fromEntries(
        Object.entries(st.ports).map(([ip, ports]) => [ip, ports])))
    } else if (st.hosts.length) {
      c.appendChild(el('div', 'section-title', 'HOSTS'))
      const g = el('div', 'scan-hosts')
      for (const h of st.hosts) {
        const d = el('div', 'scan-host')
        d.innerHTML = `<b>${h.ip}</b>${h.names.length ? `  ${h.names.join(', ')}` : ''}`
        g.appendChild(d)
      }
      c.appendChild(g)
      c.appendChild(el('div', 'empty', 'no open ports found'))
    } else {
      c.appendChild(el('div', 'empty', 'no hosts found on this network'))
    }

    const row = el('div', 'btn-row')
    const again = el('button', 'btn active', '↻ NEW SCAN')
    again.tabIndex = 0
    again.addEventListener('click', () => {
      phase = 'pick'
      lastState = null
      liveLog = []
      ws?.close()
      render()
    })
    row.appendChild(again)
    c.appendChild(row)
    root.appendChild(c)
  }

  function renderHostGrid(c: HTMLElement, detail: Record<string, PortInfo[]>) {
    const g = el('div', 'scan-hosts')
    for (const [ip, portList] of Object.entries(detail)) {
      const card = el('div', 'scan-host-card')
      const names = lastState?.hosts.find(h => h.ip === ip)?.names ?? []
      card.innerHTML = `<div class="scan-host-card-ip"><b>${ip}</b>${names.length ? ` <span class="dim">${names.join(', ')}</span>` : ''}</div>`
      const tbl = el('div', 'port-table')
      const rows = el('div', 'port-row port-row-head')
      rows.innerHTML = '<span>PORT</span><span>SVC</span><span>DETAIL</span>'
      tbl.appendChild(rows)
      for (const p of portList) {
        const r = el('div', 'port-row ' + (p.state === 'open' ? 'open' : 'filtered'))
        const svc = [p.service, p.product, p.version].filter(Boolean).join(' ')
        const detail = p.scripts.map(s => s.output.trim()).filter(Boolean).slice(0, 2).join(' | ')
          || p.extrainfo
        r.innerHTML = `<span class="p-port">${p.port}/${p.protocol}</span>` +
          `<span class="p-svc">${esc(svc) || '—'}</span>` +
          `<span class="p-detail" title="${esc(detail)}">${esc(detail) || ''}</span>`
        tbl.appendChild(r)
      }
      card.appendChild(tbl)
      g.appendChild(card)
    }
    c.appendChild(g)
  }

  function esc(s: string): string {
    return (s || '').replace(/[&<>"]/g, ch =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!))
  }

  function render() {
    if (destroyed) return
    if (phase === 'pick') renderPick()
    else if (phase === 'scan') renderScan()
    else renderResults()
  }

  /* initial data */
  scanSubnets()
    .then(o => { options = o; if (phase === 'pick') render() })
    .catch(() => { if (phase === 'pick') render() })

  return {
    destroy() {
      destroyed = true
      ws?.close()
      root.remove()
    },
  }
}
