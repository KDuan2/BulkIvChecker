#!/usr/bin/env python3
"""
Sync BulkIvChecker's bundled data files with PvPoke's source data.

Fetches gamemaster, meta groups, and overall rankings from the PvPoke GitHub
repo at a pinned commit and regenerates the static JS/JSON data files this app
loads via <script> tags. Stdlib only (no dependencies), mirroring compare_csv.py.

Usage:
    python3 tools/sync_pvpoke.py [--sha <commit>] [--no-fetch]

  --sha       PvPoke commit to pin to (default: master). Recorded in output.
  --no-fetch  Skip re-downloading; reuse files already in tools/.cache/.

Outputs (relative to repo root):
    gamemaster_cache.json
    data/gamemaster-data.js        var GAMEMASTER_DATA = {...};
    data/groups/<name>.json        20 upstream group files (verbatim)
    data/meta-groups.js            var META_GROUPS = {"<name>": [...], ...};
    data/ranking-movesets.js       var RANKING_MOVESETS = {"500": {...}, ...};
    data/ranking-scores.js         var RANKING_SCORES = {"500": {...}, ...};

It does NOT touch data/archived-cups.js (a fallback list, intentionally left
alone) or the verbatim engine in js/pvpoke/.
"""

import argparse
import json
import os
import sys
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(REPO_ROOT, "tools", ".cache")
RAW = "https://raw.githubusercontent.com/pvpoke/pvpoke/{sha}/{path}"
API = "https://api.github.com/repos/pvpoke/pvpoke/contents/{path}?ref={sha}"

# Ranking CP brackets we ship (500 = Little, 1500 = Great, 2500 = Ultra, 10000 = Master).
RANKING_BRACKETS = ["500", "1500", "2500", "10000"]


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "BulkIvChecker-sync"})
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def cached_fetch(path, sha, do_fetch):
    """Fetch a repo file, caching the raw bytes under tools/.cache/."""
    local = os.path.join(CACHE_DIR, path.replace("/", "__"))
    if do_fetch:
        os.makedirs(CACHE_DIR, exist_ok=True)
        data = fetch(RAW.format(sha=sha, path=path))
        with open(local, "wb") as f:
            f.write(data)
        return data
    with open(local, "rb") as f:
        return f.read()


def list_dir(path, sha):
    """List file names in a repo directory via the GitHub contents API."""
    data = json.loads(fetch(API.format(path=path, sha=sha)).decode("utf-8"))
    return [e["name"] for e in data if e["type"] == "file"]


def write(rel_path, text):
    full = os.path.join(REPO_ROOT, rel_path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as f:
        f.write(text)
    print("  wrote %s (%d bytes)" % (rel_path, len(text.encode("utf-8"))))


# ---- formatting helpers -----------------------------------------------------

def fmt_group_entry(entry):
    """Format one group entry: keys on their own line, string arrays inline.
    Matches the existing data/meta-groups.js style."""
    parts = []
    for k, v in entry.items():
        if isinstance(v, list):
            vs = "[" + ",".join(json.dumps(x) for x in v) + "]"
        else:
            vs = json.dumps(v)
        parts.append('    "%s": %s' % (k, vs))
    return "  {\n" + ",\n".join(parts) + "\n  }"


def fmt_group_array(entries):
    return "[\n" + ",\n".join(fmt_group_entry(e) for e in entries) + "\n]"


def trim_score(s):
    """Emit integral scores as ints (93 not 93.0), matching the existing file."""
    if isinstance(s, float) and s.is_integer():
        return int(s)
    return s


# ---- generation -------------------------------------------------------------

def sync_gamemaster(sha, do_fetch):
    print("GameMaster:")
    raw = cached_fetch("src/data/gamemaster.json", sha, do_fetch)
    gm = json.loads(raw.decode("utf-8"))
    print("    pokemon=%d moves=%d cups=%d formats=%d"
          % (len(gm.get("pokemon", [])), len(gm.get("moves", [])),
             len(gm.get("cups", [])), len(gm.get("formats", []))))
    text = raw.decode("utf-8")
    write("gamemaster_cache.json", text)
    write("data/gamemaster-data.js", "var GAMEMASTER_DATA = " + text + ";")


def sync_groups(sha, do_fetch):
    print("Groups:")
    names = sorted(n for n in list_dir("src/data/groups", sha) if n.endswith(".json"))
    print("    upstream groups: %d" % len(names))

    # Refresh data/groups/ to mirror upstream exactly: write upstream files,
    # delete any local .json that upstream no longer has.
    groups_dir = os.path.join(REPO_ROOT, "data", "groups")
    upstream = set(names)
    for existing in os.listdir(groups_dir):
        if existing.endswith(".json") and existing not in upstream:
            os.remove(os.path.join(groups_dir, existing))
            print("    deleted stale data/groups/%s" % existing)

    combined = []
    for name in names:
        raw = cached_fetch("src/data/groups/" + name, sha, do_fetch)
        entries = json.loads(raw.decode("utf-8"))
        write("data/groups/" + name, raw.decode("utf-8"))
        key = name[:-5]  # strip .json
        combined.append('"%s":%s' % (key, fmt_group_array(entries)))

    write("data/meta-groups.js", "var META_GROUPS = {" + ",".join(combined) + "};")


def sync_rankings(sha, do_fetch):
    print("Rankings:")
    movesets = {}
    scores = {}
    for cp in RANKING_BRACKETS:
        raw = cached_fetch(
            "src/data/rankings/all/overall/rankings-%s.json" % cp, sha, do_fetch)
        entries = json.loads(raw.decode("utf-8"))
        # Sort by score descending to match the existing file convention.
        entries = sorted(entries, key=lambda e: e.get("score", 0), reverse=True)
        movesets[cp] = {e["speciesId"]: e["moveset"] for e in entries}
        scores[cp] = {e["speciesId"]: trim_score(e.get("score", 0)) for e in entries}
        print("    %s: %d pokemon" % (cp, len(entries)))

    write("data/ranking-movesets.js",
          "var RANKING_MOVESETS = "
          + json.dumps(movesets, separators=(",", ":")) + ";")
    write("data/ranking-scores.js",
          "var RANKING_SCORES = "
          + json.dumps(scores, separators=(",", ":")) + ";")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sha", default="master")
    ap.add_argument("--no-fetch", action="store_true")
    args = ap.parse_args()
    do_fetch = not args.no_fetch

    print("Syncing from PvPoke @ %s\n" % args.sha)
    sync_gamemaster(args.sha, do_fetch)
    sync_groups(args.sha, do_fetch)
    sync_rankings(args.sha, do_fetch)
    print("\nDone. Remember to update CLAUDE.md 'Last synced' and run compare_csv.py.")


if __name__ == "__main__":
    main()
