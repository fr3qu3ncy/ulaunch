export interface Ipv4 {
  addr: string
  prefix: number
  subnet: string
}

export interface NetInfo {
  hostname: string
  uptime_s: number
  battery: { percent: number; charging: boolean } | null
  vpn: {
    active: boolean
    interfaces: string[]
    processes: string[]
  }
  interfaces: {
    name: string
    type: 'eth' | 'wifi' | 'vpn' | 'virtual' | string
    up: boolean
    state: string
    ipv4: Ipv4 | null
    ipv6_count: number
    ssid: string | null
    signal: number | null
  }[]
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path, { cache: 'no-store' })
  if (!r.ok) throw new Error(`${path} -> ${r.status}`)
  return (await r.json()) as T
}

export function fetchNet(): Promise<NetInfo> {
  return getJSON<NetInfo>('/api/net')
}

export type ExitAction = 'desktop' | 'hide' | 'exit'

export interface Preset {
  name: string
  server: string | null
  proto: string | null
  created: string | null
  last_connected: string | null
  size: number
}

export interface VpnStatus {
  connected: boolean
  preset: string | null
  pid?: number
  note?: string
}

async function postJSON(path: string, body: unknown): Promise<any> {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data: any = null
  try { data = await r.json() } catch { /* empty body */ }
  if (!r.ok) {
    const err: any = new Error(data?.detail || `${path} -> ${r.status}`)
    err.status = r.status
    throw err
  }
  return data
}

export function vpnPresets(): Promise<Preset[]> {
  return getJSON<Preset[]>('/api/vpn/presets')
}

export function vpnAddPreset(name: string, config: string) {
  return postJSON('/api/vpn/presets', { name, config })
}

export function vpnDeletePreset(name: string): Promise<any> {
  return fetch(`/api/vpn/presets/${encodeURIComponent(name)}`, {
    method: 'DELETE',
  }).then(r => r.ok ? { ok: true } : Promise.reject(new Error(r.statusText)))
}

export function vpnStatus(): Promise<VpnStatus> {
  return getJSON<VpnStatus>('/api/vpn/status')
}

export function vpnConnect(name: string) {
  return postJSON('/api/vpn/connect', { name })
}

export function vpnDisconnect() {
  return postJSON('/api/vpn/disconnect', {})
}

export function vpnLog(name: string, lines = 80): Promise<string> {
  return getJSON<{ name: string; log: string }>(
    `/api/vpn/log?name=${encodeURIComponent(name)}&lines=${lines}`,
  ).then(d => d.log)
}

export function toolsCheck(): Promise<any> {
  return getJSON<any>('/api/tools')
}

export function toolsInstall(tool: string) {
  return postJSON('/api/tools/install', { tool })
}

export function sudoStatus(): Promise<{ available: boolean; ttl_remaining: number }> {
  return getJSON<{ available: boolean; ttl_remaining: number }>('/api/sudo/status')
}

export function sudoVerify(password: string): Promise<any> {
  return postJSON('/api/sudo/verify', { password })
}

export async function exitApp(action: ExitAction): Promise<void> {
  await fetch('/api/exit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }).catch(() => {
    /* server may already be gone */
  })
}

export interface SystemStatus {
  has_systemd: boolean
  actions: string[]
}

export function systemStatus(): Promise<SystemStatus> {
  return getJSON<SystemStatus>('/api/system/status')
}

export function systemAction(action: string) {
  return postJSON(`/api/system/${action}`, {})
}

export interface Settings {
  idle_timeout: number
  scan_flags: Record<string, unknown>
}

export function getSettings(): Promise<Settings> {
  return getJSON<Settings>('/api/settings')
}

export function putSettings(payload: Partial<Settings>): Promise<Settings> {
  const r = fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(async resp => {
      const data = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(data?.detail || `settings -> ${resp.status}`)
      return data as Settings
    })
  return r
}

export function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
