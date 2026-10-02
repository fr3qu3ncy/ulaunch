"""Unit test for scanner.valid_nmap_spec — run with .venv/bin/python.

Pins the nmap target grammar the CUSTOM RANGE option accepts, cross-checked
against real nmap 7.95 (the uConsole's version) via `nmap -sL <spec>`:
  - each whitespace-separated part is one target expression
  - a target is a CIDR (192.168.1.0/24) or a 4-field address where each
    field is a number, a range (a-b), or a comma list of those
  - short forms nmap accepts (10.10.11) and the legacy /255.255.255.0 netmask
    are deliberately REJECTED (footguns / rejected by 7.95)
and the forms it must reject so a typo never silently scans 0 hosts
(nmap is dangerously lenient: `junk` and `300.1.1.1` "succeed" with 0 hosts).
"""
import sys
sys.path.insert(0, 'backend')
from scanner import valid_nmap_spec, nmap_target_args  # noqa: E402

GOOD = [
    # Martin's examples
    "192.168.1.0/24",
    "192.168.1.0-100",
    "10.10.11,12.1-254",
    "192.168.1.10 10.10.11.10",
    # single hosts
    "10.0.0.1",
    "192.168.1.10",
    # CIDR forms
    "10.10.11.0/24",
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.1.0/30",
    "10.0.0.0/0",
    # last-octet ranges
    "192.168.1.1-100",
    "192.168.1.0-255",
    "10.10.11.5-10",
    # multi-octet ranges
    "192.168.0-29.0-45",
    "192.168.0-0.0-99",
    "192.168.0-29.1",
    # comma lists (last octet)
    "192.168.1.1,3,5",
    "192.168.1.1-3,5-10,11",
    # space-separated target lists
    "192.168.1.0/24 10.0.0.5",
    "192.168.1.1-3 192.168.2.4-6",
]

BAD = [
    "",
    "   ",
    "junk",
    "localhost",
    "10.10.11",               # 3-field short form (nmap reads as 10.10.0.11)
    "10",                     # bare single octet
    "300.1.1.1",
    "192.168.1.256",          # octet out of range
    # CIDR problems
    "192.168.1.0/33",
    "192.168.1.0/",
    "192.168.1.0/255.255.255.0",   # legacy netmask — rejected by 7.95
    "10.10.0.0/255.255.0.0",
    # range problems
    "10.0-100",               # 2-field
    "192.168.1-30",           # 3-field
    "192.168.0-29",           # 3-field
    "192.168.1.100-1",        # lo > hi
    "192.168.1.0-",           # empty range end
    "192.168.1.-100",
    "192.168.1.1,3,-5",       # negative
    # nonsense
    "10.10.11.-100",
    "192.168.1.0/24/",
    "1.2.3.4/5.6.7.8.9",
    "192.168.1.0-100 extra junk",
]

fails = 0
for s in GOOD:
    if not valid_nmap_spec(s):
        print(f"FAIL: should ACCEPT: {s!r}")
        fails += 1
for s in BAD:
    if valid_nmap_spec(s):
        print(f"FAIL: should REJECT: {s!r}")
        fails += 1

# nmap_target_args: whitespace-split, one arg per target
cases = [
    ("192.168.1.10 10.10.11.10", ["192.168.1.10", "10.10.11.10"]),
    ("192.168.1.0/24", ["192.168.1.0/24"]),
    ("  10.0.0.1   10.0.0.2 ", ["10.0.0.1", "10.0.0.2"]),
    ("192.168.1.0/24 10.0.0.5", ["192.168.1.0/24", "10.0.0.5"]),
]
for spec, want in cases:
    got = nmap_target_args(spec)
    if got != want:
        print(f"FAIL: nmap_target_args({spec!r}) = {got}, want {want}")
        fails += 1

total = len(GOOD) + len(BAD) + len(cases)
print(f"{total} cases, {fails} failed")
sys.exit(1 if fails else 0)
