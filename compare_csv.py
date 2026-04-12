"""
Compare battle rating CSVs from our tool vs PvPoke.
Usage: python compare_csv.py ours.csv pvpoke.csv

Expects both CSVs to have threat names as column headers and battle ratings as values.
PvPoke's CSV format has a single row per Pokemon (1v1 only).
Our CSV has 3 rows per candidate (0v0, 1v1, 2v2).

The script compares 1v1 values and reports differences.
"""

import csv
import sys
import os
import glob

DOWNLOADS = os.path.join(os.path.expanduser("~"), "Downloads")

def find_latest(pattern):
    """Find the most recently modified file matching a glob pattern in Downloads."""
    matches = glob.glob(os.path.join(DOWNLOADS, pattern))
    if not matches:
        return None
    return max(matches, key=os.path.getmtime)

def load_csv(path):
    """Load CSV and return header + rows."""
    with open(path, newline='', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        rows = list(reader)
    return rows[0], rows[1:]

def normalize_name(name):
    """Normalize Pokemon names for matching.
    PvPoke format: 'Altaria_DB+SA/FT_4/12/13' or 'Annihilape (Shadow)_C+RF/IP_4/13/13'
    Our format: 'Altaria' or 'Annihilape (Shadow)'
    Extract just the species name + shadow indicator."""
    name = name.strip()

    # Handle PvPoke's format: split on underscore, but preserve _shadow/_galarian/etc.
    # PvPoke uses: species_moves_ivs  e.g. "altaria_db+sa/ft_4/12/13"
    # Moves section always contains + or /, IVs section is digits with /
    # Strategy: find the first segment that looks like moves (contains +) and cut there
    lower = name.lower().replace("'", '')
    # Normalize form suffixes: "(Shadow)" -> "_shadow", "(Galarian)" -> "_galarian", etc.
    import re
    lower = re.sub(r'\s*\((\w+)\)', lambda m: '_' + m.group(1), lower)
    lower = lower.replace(' ', '_')

    # Split by underscore and rebuild species name, stopping at move abbreviations
    parts = lower.split('_')
    species_parts = []
    for p in parts:
        # Move abbreviations contain + or are pure digits with /
        if '+' in p or (len(p) <= 3 and '/' in p):
            break
        # IV patterns like "4/12/13"
        if '/' in p and all(c.isdigit() or c == '/' for c in p):
            break
        species_parts.append(p)

    return '_'.join(species_parts)

def main():
    if len(sys.argv) >= 3 and not sys.argv[1].startswith("-"):
        # Full paths provided
        our_file = sys.argv[1]
        pvp_file = sys.argv[2]
        threshold = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    elif len(sys.argv) >= 3 and sys.argv[1] == "-n":
        # Filenames only — look in Downloads folder
        our_file = os.path.join(DOWNLOADS, sys.argv[2])
        pvp_file = os.path.join(DOWNLOADS, sys.argv[3]) if len(sys.argv) > 3 else None
        threshold = int(sys.argv[4]) if len(sys.argv) > 4 else 0
        if not pvp_file or not os.path.exists(pvp_file):
            print(f"File not found: {pvp_file}")
            sys.exit(1)
        if not os.path.exists(our_file):
            print(f"File not found: {our_file}")
            sys.exit(1)
    else:
        # Auto-find latest CSVs in Downloads
        our_file = find_latest("*_matrix.csv")
        pvp_file = find_latest("*pokemon_battle_results*.csv") or find_latest("*matrix*.csv")
        threshold = int(sys.argv[1]) if len(sys.argv) > 1 else 0

        if not our_file or not pvp_file:
            print("Could not auto-find CSVs in " + DOWNLOADS)
            print("Looking for: *_matrix.csv (ours) and *pokemon_battle_results*.csv (PvPoke)")
            print("\nOr pass paths explicitly: python compare_csv.py <our_csv> <pvpoke_csv>")
            sys.exit(1)

        # Make sure they're different files
        if os.path.abspath(our_file) == os.path.abspath(pvp_file):
            print("Both files resolved to the same path. Make sure both CSVs are in Downloads.")
            sys.exit(1)

        print(f"Ours:   {os.path.basename(our_file)}")
        print(f"PvPoke: {os.path.basename(pvp_file)}")
        print()

    our_header, our_rows = load_csv(our_file)
    pvp_header, pvp_rows = load_csv(pvp_file)

    # Build column index lists for threats
    # Our CSV: columns 0-3 are Candidate/IVs/CP/Level, then threats
    our_threat_cols = []  # list of (normalized_name, raw_name, col_index)
    for i in range(4, len(our_header)):
        our_threat_cols.append((normalize_name(our_header[i]), our_header[i], i))

    # PvPoke CSV: first column is Pokemon name, then threats
    pvp_threat_cols = []
    for i in range(1, len(pvp_header)):
        pvp_threat_cols.append((normalize_name(pvp_header[i]), pvp_header[i], i))

    # Filter our rows to 1v1 only
    # If rows have scenario suffixes like "(1v1)", filter for those; otherwise use all rows
    our_1v1_rows = [r for r in our_rows if '(1v1)' in r[0]]
    if not our_1v1_rows:
        our_1v1_rows = our_rows  # Single-scenario export, use all rows

    # Match columns by position — both CSVs should have threats in the same order
    # First try positional matching, falling back to name matching for non-duplicates
    matched_cols = []  # list of (display_name, our_col, pvp_col)

    # Track which names appear multiple times
    our_name_counts = {}
    for norm, raw, col in our_threat_cols:
        our_name_counts[norm] = our_name_counts.get(norm, 0) + 1
    pvp_name_counts = {}
    for norm, raw, col in pvp_threat_cols:
        pvp_name_counts[norm] = pvp_name_counts.get(norm, 0) + 1

    # For unique names: match by name
    # For duplicate names: match by occurrence order (1st with 1st, 2nd with 2nd)
    our_name_seen = {}
    pvp_by_name = {}
    for norm, raw, col in pvp_threat_cols:
        if norm not in pvp_by_name:
            pvp_by_name[norm] = []
        pvp_by_name[norm].append(col)

    for norm, raw, col in our_threat_cols:
        if norm not in pvp_by_name or not pvp_by_name[norm]:
            continue
        occurrence = our_name_seen.get(norm, 0)
        our_name_seen[norm] = occurrence + 1

        if occurrence < len(pvp_by_name[norm]):
            pvp_col = pvp_by_name[norm][occurrence]
            suffix = f" #{occurrence+1}" if our_name_counts.get(norm, 1) > 1 else ""
            matched_cols.append((norm + suffix, col, pvp_col))

    # Report matching stats
    our_names = set(n for n, r, c in our_threat_cols)
    pvp_names = set(n for n, r, c in pvp_threat_cols)
    common = our_names & pvp_names
    our_only = our_names - pvp_names
    pvp_only = pvp_names - our_names

    print(f"Common threats: {len(matched_cols)}")
    if our_only:
        print(f"Only in ours ({len(our_only)}): {sorted(our_only)[:10]}...")
    if pvp_only:
        print(f"Only in PvPoke ({len(pvp_only)}): {sorted(pvp_only)[:10]}...")
    print()

    # Compare ratings
    total = 0
    matches = 0
    diffs = []

    for our_row in our_1v1_rows:
        candidate_name = our_row[0].replace(' (1v1)', '')

        # Find matching PvPoke row (by candidate name or index)
        pvp_row = None
        for pr in pvp_rows:
            if pr[0].strip() and candidate_name.lower().startswith(pr[0].strip().lower()):
                pvp_row = pr
                break

        if not pvp_row:
            # Try matching by row index
            idx = our_1v1_rows.index(our_row)
            if idx < len(pvp_rows):
                pvp_row = pvp_rows[idx]

        if not pvp_row:
            print(f"No PvPoke match for: {candidate_name}")
            continue

        for display_name, our_col, pvp_col in matched_cols:
            try:
                our_br = int(our_row[our_col])
                pvp_br = int(pvp_row[pvp_col])
            except (ValueError, IndexError):
                continue

            total += 1
            diff = abs(our_br - pvp_br)

            if diff <= threshold:
                matches += 1
            else:
                diffs.append({
                    'candidate': candidate_name,
                    'threat': display_name,
                    'ours': our_br,
                    'pvpoke': pvp_br,
                    'diff': our_br - pvp_br,
                })

    # Sort diffs by magnitude
    diffs.sort(key=lambda d: abs(d['diff']), reverse=True)

    print(f"Total comparisons: {total}")
    print(f"Exact matches: {matches} ({matches/total*100:.1f}%)" if total > 0 else "No comparisons")
    print(f"Differences: {len(diffs)}")
    print()

    if diffs:
        print(f"{'Candidate':<25} {'Threat':<25} {'Ours':>5} {'PvPoke':>6} {'Diff':>6}")
        print("-" * 70)
        for d in diffs[:50]:  # Show top 50
            print(f"{d['candidate']:<25} {d['threat']:<25} {d['ours']:>5} {d['pvpoke']:>6} {d['diff']:>+6}")

        if len(diffs) > 50:
            print(f"... and {len(diffs) - 50} more")

        # Summary stats
        abs_diffs = [abs(d['diff']) for d in diffs]
        print(f"\nDiff stats: avg={sum(abs_diffs)/len(abs_diffs):.1f} max={max(abs_diffs)} median={sorted(abs_diffs)[len(abs_diffs)//2]}")

if __name__ == '__main__':
    main()
