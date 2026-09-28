"""Staged nmap engine:
  stage 1  -sn  host discovery on the chosen subnet
  stage 2  top ports on live hosts (-F fast, top-100)
  stage 3  deep scan on open ports (-sV -sC) or user-chosen flags
Progress streams to subscribers as (stage, line) tuples. Results are
collected from nmap's machine-readable output (-oX) parsed as XML.
"""
import ipaddress
import queue
import re
import shutil
import subprocess
import threading
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field

STAGES = ("discovery", "ports", "deep")


@dataclass
class ScanJob:
    id: str
    subnet: str
    interface: str
    flags: dict
    status: str = "pending"          # pending|running|done|error|cancelled
    stage: str = ""
    stage_index: int = -1
    hosts: list = field(default_factory=list)   # stage-1 results
    live_hosts: list = field(default_factory=list)
    ports: dict = field(default_factory=dict)   # ip -> list of port dicts
    detail: dict = field(default_factory=dict)  # ip -> list of port dicts (deep)
    log: list = field(default_factory=list)
    started: float = 0
    finished: float = 0
    error: str = ""
    _subscribers: list = field(default_factory=list, repr=False)
    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _cancel: bool = False

    def publish(self, stage: str, line: str):
        self.log.append(line)
        if len(self.log) > 2000:
            self.log = self.log[-2000:]
        for q in list(self._subscribers):
            try:
                q.put_nowait((stage, line))
            except queue.Full:
                pass

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=500)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: queue.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    def cancel(self):
        self._cancel = True
        if self._proc and self._proc.poll() is None:
            try:
                import os
                import signal
                os.killpg(os.getpgid(self._proc.pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                try:
                    self._proc.kill()
                except Exception:
                    pass


def parse_nmap_xml(path: str) -> dict:
    """Parse -oX output -> {ip: {hostnames: [...], ports: [port dicts]}}"""
    out: dict = {}
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return out
    for host in tree.getroot().iter("host"):
        ip_el = host.find("address")
        if ip_el is None:
            continue
        ip = ip_el.get("addr", "")
        if not ip or not ipaddress.ip_address(ip).version == 4:
            continue
        names = [n.get("name", "") for n in host.iter("hostname")]
        ports = []
        for p in host.iter("port"):
            svc = p.find("service")
            state_el = p.find("state")
            ports.append({
                "port": p.get("portid", ""),
                "protocol": p.get("prot", "tcp"),
                "state": state_el.get("state", "") if state_el is not None else "",
                "state_reason": state_el.get("reason", "") if state_el is not None else "",
                "service": svc.get("name", "") if svc is not None else "",
                "product": svc.get("product", "") if svc is not None else "",
                "version": svc.get("version", "") if svc is not None else "",
                "extrainfo": svc.get("extrainfo", "") if svc is not None else "",
                "scripts": _scripts(p),
            })
        out[ip] = {"hostnames": names, "ports": ports}
    return out


def _scripts(port_el) -> list:
    """Nmap XML: each script is a SIBLING <script id=".." output=".."/>
    element under <port> (output is an ATTRIBUTE, not nested text)."""
    res = []
    for s in port_el.findall("script"):
        res.append({"id": s.get("id", ""), "output": s.get("output", "")})
    return res


class Scanner:
    def __init__(self):
        self._jobs: dict[str, ScanJob] = {}
        self._lock = threading.Lock()

    def jobs(self) -> list[dict]:
        with self._lock:
            return [self._public(j) for j in
                    sorted(self._jobs.values(), key=lambda j: j.started, reverse=True)]

    def get(self, job_id: str) -> ScanJob | None:
        with self._lock:
            return self._jobs.get(job_id)

    def clear(self) -> int:
        """Cancel any live jobs and drop the whole store. Returns count."""
        with self._lock:
            for j in list(self._jobs.values()):
                if j.status in ("pending", "running"):
                    j.cancel()
            n = len(self._jobs)
            self._jobs.clear()
            return n

    def _public(self, j: ScanJob) -> dict:
        return {
            "id": j.id, "subnet": j.subnet, "interface": j.interface,
            "status": j.status, "stage": j.stage, "stage_index": j.stage_index,
            "hosts": j.hosts, "live_hosts": j.live_hosts,
            "ports": j.ports, "detail": j.detail,
            "error": j.error,
            "started": j.started, "finished": j.finished,
            "log_tail": j.log[-60:],
        }

    def start(self, subnet: str, interface: str, flags: dict) -> ScanJob:
        job = ScanJob(
            id=time.strftime("%H%M%S") + "-" + re.sub(r"[^a-z0-9]", "", subnet)[:8],
            subnet=subnet, interface=interface, flags=flags,
        )
        job.started = time.time()
        with self._lock:
            self._jobs[job.id] = job
        t = threading.Thread(target=self._run, args=(job,), daemon=True)
        t.start()
        return job

    def _nmap(self, job: ScanJob, args: list[str]) -> str | None:
        """Run nmap; stream output lines; return XML path on success."""
        if shutil.which("nmap") is None:
            job.status = "error"
            job.error = "nmap is not installed — use the INSTALL button on the SCAN screen"
            job.publish(job.stage or "discovery",
                        "ERROR: nmap not installed (press INSTALL on the SCAN screen)")
            return None
        import tempfile
        xml = tempfile.NamedTemporaryFile(prefix="ulaunch-nmap-", suffix=".xml",
                                          delete=False).name
        full = ["nmap"] + args + ["-oX", xml]
        job.publish(job.stage, "$ " + " ".join(full))
        job._proc = subprocess.Popen(
            full, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, bufsize=1, start_new_session=True,
        )
        rc = None
        try:
            for line in iter(job._proc.stdout.readline, ""):
                if job._cancel:
                    break
                line = line.rstrip()
                if not line:
                    continue
                job.publish(job.stage, line)
                if re.search(r"hosts up|host up", line, re.I):
                    m = re.search(r"(\d+\.\d+\.\d+\.\d+)", line)
                    if m and m.group(1) not in job.live_hosts:
                        job.live_hosts.append(m.group(1))
            rc = job._proc.wait(timeout=60)
        except Exception as e:  # noqa: BLE001
            job.publish(job.stage, f"nmap failed: {e}")
        finally:
            job._proc = None
        if job._cancel:
            job.status = "cancelled"
            return None
        if rc not in (0, None):
            job.publish(job.stage, f"nmap exited with code {rc}")
        return xml

    def _run(self, job: ScanJob):
        job.status = "running"
        try:
            self._discovery(job)
            if job._cancel:
                job.status = "cancelled"
                return
            self._ports(job)
            if job._cancel:
                job.status = "cancelled"
                return
            if job.flags.get("deep", True):
                self._deep(job)
            if job._cancel:
                job.status = "cancelled"
            else:
                job.status = "done"
        except Exception as e:  # noqa: BLE001
            job.status = "error"
            job.error = str(e)
            job.publish(job.stage, f"ERROR: {e}")
        job.finished = time.time()
        job.publish(job.stage, "─── finished " + job.status + " ───")

    def _discovery(self, job: ScanJob):
        job.stage = "discovery"
        job.stage_index = 0
        job.publish("discovery", f"stage 1/3 — host discovery on {job.subnet}")
        xml = self._nmap(job, ["-sn", job.subnet])
        if xml is None:
            return
        data = parse_nmap_xml(xml)
        job.hosts = [{"ip": ip, "names": v["hostnames"]}
                     for ip, v in data.items()]

    def _ports(self, job: ScanJob):
        job.stage = "ports"
        job.stage_index = 1
        if not job.hosts:
            job.publish("ports", "no live hosts found — skipping")
            return
        job.publish("ports", f"stage 2/3 — top ports on {len(job.hosts)} live host(s)")
        args = ["-F", "-Pn"]
        args += [h["ip"] for h in job.hosts]
        xml = self._nmap(job, args)
        if xml is None:
            return
        data = parse_nmap_xml(xml)
        for ip, v in data.items():
            open_ports = [p for p in v["ports"] if p["state"] == "open"]
            if open_ports:
                job.ports[ip] = open_ports

    def _deep(self, job: ScanJob):
        job.stage = "deep"
        job.stage_index = 2
        targets = [ip for ip, ports in job.ports.items() if ports]
        if not targets:
            job.publish("deep", "no open ports found — skipping deep scan")
            return
        job.publish("deep", f"stage 3/3 — deep scan of {len(targets)} host(s) with open ports")
        args = ["-Pn"]
        f = job.flags
        if f.get("service_version", True):
            args.append("-sV")
        if f.get("scripts", True):
            args.append("-sC")
        if f.get("udp"):
            args.append("-sU")
            args += ["--top-ports", str(int(f.get("udp_top", 100)))]
        if f.get("full_tcp"):
            args += ["-p", "1-65535"]
        else:
            # restrict to ports we already found open (fast + meaningful)
            portsets = sorted(
                {p["port"] for ip in targets for p in job.ports.get(ip, [])}
            )
            if portsets:
                args += ["-p", ",".join(portsets)]
        args += targets
        xml = self._nmap(job, args)
        if xml is None:
            return
        data = parse_nmap_xml(xml)
        for ip, v in data.items():
            job.detail[ip] = v["ports"]

    def cancel(self, job_id: str) -> bool:
        job = self.get(job_id)
        if job and job.status == "running":
            job.cancel()
            return True
        return False


scanner = Scanner()
