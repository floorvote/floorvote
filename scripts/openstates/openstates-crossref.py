#!/usr/bin/env python3
"""
Cross-reference central D1 bills with OpenStates bulk data.
Uses CSV downloads for NJ/WI/WY and JSON downloads for RI.

Run: python3 scripts/openstates-crossref.py
"""

import json
import csv
import os
import re
import subprocess
import zipfile
import io
from pathlib import Path
from collections import defaultdict
from urllib.request import urlopen, Request

SCRIPT_DIR = Path(__file__).parent
EVAL_DIR = Path("/tmp/openstates-eval")

with open(SCRIPT_DIR / ".env.openstates") as f:
    API_KEY = f.read().strip().split("=", 1)[1]

# Election officials preset keywords (from central keyword_registry)
KEYWORDS = [
    'absentee', 'ballot', 'campaign finance', 'candidate filing', 'canvass',
    'election', 'election official', 'elective office', 'elective public office',
    'electoral college', 'nominating petition', 'poll worker', 'polling',
    'popular vote', 'precinct', 'recall election', 'recount', 'redistrict',
    'voter', 'voting',
]
WORD_BOUNDARY = {'election'}

# LegiScan session ID → OpenStates session identifier mapping
# Built from comparing session names between the two systems
SESSION_MAP = {
    # NJ
    (2250, 'NJ'): '222',   # 2026-2027 Regular Session
    # RI
    (2128, 'RI'): '2024',  # 2024 Regular Session
    (2193, 'RI'): '2025',  # 2025 Regular Session
    (2253, 'RI'): '2026',  # 2026 Regular Session
    # WI
    (2197, 'WI'): '2025',  # 2025-2026 Regular Session
    # WY
    (1999, 'WY'): '2023',  # 2023 General Session
    (2096, 'WY'): '2024',  # 2024 Budget Session
    (2157, 'WY'): '2025',  # 2025 General Session
    (2213, 'WY'): '2026',  # 2026 Budget Session
}

# Bill number normalization: LegiScan uses 'H7070', OpenStates uses 'HB 7070' etc.
# Need per-state normalization
def normalize_bill_number(number: str, state: str) -> list:
    """Normalize to canonical form(s) for comparison. Returns a list of possible forms.
    RI is ambiguous: LegiScan 'H' could be OpenStates 'HB' or 'HR'."""
    n = number.strip().upper()
    match = re.match(r'^([A-Z]+)\s*0*(\d+)$', n)
    if not match:
        return [n]

    prefix, num = match.group(1), match.group(2)

    if state == 'RI' and prefix == 'H':
        return [f"HB {num}", f"HR {num}"]
    elif state == 'RI' and prefix == 'S':
        return [f"SB {num}", f"SR {num}"]
    else:
        return [f"{prefix} {num}"]


def matches_keywords(text: str) -> tuple:
    lower = text.lower()
    for kw in KEYWORDS:
        if kw in WORD_BOUNDARY:
            if re.search(rf'(?<![a-zA-Z]){re.escape(kw)}', lower, re.IGNORECASE):
                return True, kw
        else:
            if kw in lower:
                return True, kw
    return False, ''


def load_central_bills():
    """Load central central bills from the cached JSON."""
    with open(EVAL_DIR / "central_bpc_bills.json") as f:
        return json.load(f)


def load_os_json(state: str, session: str):
    """Load OpenStates bills from local JSON bulk download."""
    dirs = list(SCRIPT_DIR.glob(f"{state.upper()}_*_json_*"))
    for d in dirs:
        bill_file = d / state.upper() / session / f"{state.upper()}_{session}_bills.json"
        if bill_file.exists():
            with open(bill_file) as f:
                return json.load(f)
    return None


def load_os_csv(state: str, session: str):
    """Load OpenStates bills from CSV bulk download."""
    csv_dir = EVAL_DIR / f"{state}_{session}" / state.upper() / session
    bills_csv = csv_dir / f"{state.upper()}_{session}_bills.csv"
    if not bills_csv.exists():
        return None

    bills = []
    # Load bills
    with open(bills_csv, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        for row in reader:
            bills.append(row)

    # Try to load abstracts
    abstracts_csv = csv_dir / f"{state.upper()}_{session}_bill_abstracts.csv"
    abstracts_by_id = {}
    if abstracts_csv.exists():
        with open(abstracts_csv, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                abstracts_by_id[row['bill_id']] = row.get('abstract', '')

    # Merge abstracts into bills
    for bill in bills:
        bill['abstract'] = abstracts_by_id.get(bill['id'], '')

    return bills


def download_os_bulk(state: str, session_id: str):
    """Download OpenStates bulk data if not already cached."""
    zip_path = EVAL_DIR / f"{state}_{session_id}.zip"
    extract_dir = EVAL_DIR / f"{state}_{session_id}"

    if extract_dir.exists():
        return True

    # Need to find the download URL from API
    url = f"https://v3.openstates.org/jurisdictions/ocd-jurisdiction/country:us/state:{state}/government?include=legislative_sessions&apikey={API_KEY}"
    try:
        req = Request(url)
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f"  Failed to get jurisdiction for {state}: {e}")
        return False

    sessions = data.get('legislative_sessions', [])
    target = next((s for s in sessions if s['identifier'] == session_id), None)
    if not target:
        print(f"  Session {session_id} not found for {state}")
        return False

    downloads = target.get('downloads', [])
    download = next((d for d in downloads if d['data_type'] == 'json'), None) or \
               next((d for d in downloads if d['data_type'] == 'csv'), None)

    if not download:
        print(f"  No download available for {state} {session_id}")
        return False

    print(f"  Downloading {state} {session_id} ({download['data_type']})...")
    try:
        with urlopen(download['url'], timeout=120) as resp:
            data = resp.read()
        with open(zip_path, 'wb') as f:
            f.write(data)
        print(f"  Saved: {zip_path} ({len(data)//1024}KB)")

        # Extract
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(extract_dir)
        return True
    except Exception as e:
        print(f"  Download failed: {e}")
        return False


def cross_reference(state, session_id, os_session, central_bills):
    """Cross-reference central bills with OpenStates data."""
    print(f"\n{'='*70}")
    print(f"{state} — LegiScan session {session_id} ↔ OpenStates session '{os_session}'")
    print(f"{'='*70}")

    # Get central bills for this state+session
    cb = [b for b in central_bills if b['state'] == state and b['session_id'] == session_id]
    print(f"Central (central): {len(cb)} bills")

    # Try to load OpenStates data — JSON first, then CSV
    os_bills = load_os_json(state, os_session)
    data_format = 'json'
    if os_bills is None:
        os_bills = load_os_csv(state, os_session)
        data_format = 'csv'
    if os_bills is None:
        print(f"  No OpenStates data available for {state} {os_session}")
        return

    print(f"OpenStates ({data_format}): {len(os_bills)} total bills")

    # Run keyword filter on OpenStates bills
    os_matched = []
    for b in os_bills:
        if data_format == 'json':
            abstract = ' '.join(a.get('abstract', '') for a in b.get('abstracts', []))
            text = f"{b['title']} {abstract}"
            identifier = b['identifier']
        else:
            text = f"{b.get('title', '')} {b.get('abstract', '')}"
            identifier = b.get('identifier', '')
        hit, kw = matches_keywords(text)
        if hit:
            os_matched.append({'identifier': identifier, 'keyword': kw, 'title': b.get('title', '')})

    print(f"OpenStates keyword matches: {len(os_matched)} / {len(os_bills)} ({len(os_matched)/len(os_bills)*100:.1f}%)")

    # Build OS lookups (OpenStates identifiers are already canonical — single value)
    os_numbers = {}
    for b in os_matched:
        norms = normalize_bill_number(b['identifier'], state)
        os_numbers[norms[0]] = b

    os_all_numbers = {}
    for b in os_bills:
        ident = b.get('identifier', '')
        norms = normalize_bill_number(ident, state)
        os_all_numbers[norms[0]] = b

    # For central bills, try all possible normalizations and find matches
    in_both_bills = []
    only_central_bills = []
    matched_os_norms = set()

    for b in cb:
        norms = normalize_bill_number(b['number'], state)
        found = False
        for norm in norms:
            if norm in os_numbers:
                in_both_bills.append((b, norm))
                matched_os_norms.add(norm)
                found = True
                break
        if not found:
            only_central_bills.append(b)

    only_os = set(os_numbers.keys()) - matched_os_norms

    print(f"\nCross-reference results:")
    print(f"  In both (central & OS keyword match):  {len(in_both_bills)}")
    print(f"  Only in central (missing from OS):      {len(only_central_bills)}")
    print(f"  Only in OS matches (not in central):    {len(only_os)}")

    if len(cb) > 0:
        recall = len(in_both_bills) / len(cb) * 100
        print(f"\n  Recall (OS finds what central has): {recall:.1f}%")

    if only_central_bills:
        print(f"\n  Bills in central but NOT matched by OS keywords ({len(only_central_bills)}):")
        for b in sorted(only_central_bills, key=lambda x: x['number']):
            norms = normalize_bill_number(b['number'], state)
            found_in_os = False
            for norm in norms:
                if norm in os_all_numbers:
                    os_b = os_all_numbers[norm]
                    title = os_b.get('title', '')[:60]
                    print(f"    {b['number']:12s} EXISTS in OS as {norm}, keyword miss — {title}")
                    found_in_os = True
                    break
            if not found_in_os:
                print(f"    {b['number']:12s} NOT FOUND in OpenStates at all — {b['title'][:60]}")

    if only_os and len(only_os) <= 30:
        print(f"\n  Bills in OS keyword matches but NOT in central ({len(only_os)}):")
        for norm in sorted(only_os)[:20]:
            b = os_numbers[norm]
            print(f"    {b['identifier']:12s} [{b['keyword']:15s}] {b['title'][:60]}")

    # Data quality for matched bills
    if data_format == 'json' and in_both_bills:
        matched_norms = [n for _, n in in_both_bills]
        with_text = sum(1 for n in matched_norms if os_all_numbers.get(n, {}).get('raw_text'))
        with_votes = sum(1 for n in matched_norms if os_all_numbers.get(n, {}).get('votes'))
        with_sponsors = sum(1 for n in matched_norms if os_all_numbers.get(n, {}).get('sponsors'))
        print(f"\n  Data quality for matched bills ({len(in_both_bills)}):")
        print(f"    with raw_text: {with_text}")
        print(f"    with votes:    {with_votes}")
        print(f"    with sponsors: {with_sponsors}")


def main():
    print("# OpenStates Cross-Reference: Central vs OpenStates")
    print(f"# Generated: {__import__('datetime').datetime.now().isoformat()}\n")

    central_bills = load_central_bills()
    print(f"Loaded {len(central_bills)} bills from central (central tenant)\n")

    # Ensure bulk data is downloaded
    needed_downloads = set()
    for (sid, state), os_session in SESSION_MAP.items():
        # Check if we already have data
        if not load_os_json(state, os_session) and not load_os_csv(state.lower(), os_session):
            needed_downloads.add((state.lower(), os_session))

    if needed_downloads:
        print("Downloading missing OpenStates bulk data...")
        import time
        for state, session in sorted(needed_downloads):
            download_os_bulk(state, session)
            time.sleep(8)  # rate limit

    # Cross-reference each state/session
    for (sid, state), os_session in sorted(SESSION_MAP.items(), key=lambda x: (x[0][1], x[0][0])):
        cross_reference(state, sid, os_session, central_bills)

    # Summary
    print(f"\n\n{'='*70}")
    print("SUMMARY")
    print(f"{'='*70}")
    total_central = len(central_bills)
    total_matched = 0
    total_missed = 0
    for (sid, state), os_session in sorted(SESSION_MAP.items()):
        cb = [b for b in central_bills if b['state'] == state and b['session_id'] == sid]
        if not cb:
            continue
        os_bills = load_os_json(state, os_session) or load_os_csv(state.lower(), os_session)
        if not os_bills:
            total_missed += len(cb)
            continue
        os_matched_norms = set()
        for b in os_bills:
            if isinstance(b.get('abstracts'), list):
                abstract = ' '.join(a.get('abstract', '') for a in b.get('abstracts', []))
            else:
                abstract = b.get('abstract', '')
            text = f"{b.get('title', '')} {abstract}"
            hit, _ = matches_keywords(text)
            if hit:
                norms = normalize_bill_number(b.get('identifier', ''), state)
                os_matched_norms.add(norms[0])
        matched = 0
        for b in cb:
            norms = normalize_bill_number(b['number'], state)
            if any(n in os_matched_norms for n in norms):
                matched += 1
        total_matched += matched
        total_missed += len(cb) - matched

    print(f"\nTotal central bills (central): {total_central}")
    print(f"Matched by OpenStates keywords:      {total_matched} ({total_matched/total_central*100:.1f}%)")
    print(f"Missed:                              {total_missed} ({total_missed/total_central*100:.1f}%)")


if __name__ == '__main__':
    main()
