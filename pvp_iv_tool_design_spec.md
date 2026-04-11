# PvP IV Comparison Tool — Design Specification

## Overview

A standalone local web app (single HTML file + JS modules, no server required) for bulk comparison of multiple IV spreads of the same Pokémon in Pokémon GO PvP. It replicates and extends PvPoke's matrix battle mode, optimized specifically for the workflow of evaluating N candidates of the same species across leagues, shield scenarios, and level caps — without re-entering data.

The tool pulls game data (Pokémon stats, moves, meta threat lists) directly from PvPoke's public `gamemaster.json`. It is intended to be clean and self-contained enough to potentially contribute back to the PvPoke project.

---

## Core Problem

PvPoke's matrix battle mode is excellent for comparing different Pokémon against each other, but painful for bulk IV evaluation of the same species. The specific friction points it solves:

- Re-entering or re-leveling the same candidates every time you switch leagues
- Manually cycling through shield scenarios one at a time
- No diff view — all matchups shown equally even when most don't change between candidates
- No way to see GL and UL results side by side
- Shadow/purified comparison requires manual IV math

---

## Data Source

- **Game data:** `https://pvpoke.com/data/gamemaster.json`
- **Meta threat lists:** PvPoke's quickfill meta data, keyed by league
- Cache `gamemaster.json` locally (localStorage or IndexedDB) and refresh after 24 hours
- No backend, no API keys, no build step required

---

## Technology

- Single HTML file entry point
- Vanilla JS modules (no framework required, keep dependencies minimal — in the spirit of PvPoke's own codebase)
- localStorage for session persistence
- Battle simulation logic ported/adapted from PvPoke's published formulas (MIT license)

---

## Feature List

### 1. Species & Form Selection

- Search/select species at the top of the tool (same as PvPoke's Pokémon search)
- **Form dropdown:** Normal / Shadow / Purified
  - Shadow applies 1.2× attack, 0.833× defense multipliers
  - Purified applies standard stats
- Form selection applies globally to all candidates by default
- Individual candidates can override their form (see Candidate Entry)

### 2. Candidate Entry

A batch input table. Each row = one IV spread candidate.

**Columns per row:**
- Nickname / label (optional, auto-generated as "Candidate 1", "Candidate 2" etc. if blank)
- ATK IV (0–15)
- DEF IV (0–15)
- STA IV (0–15)
- Form override (Normal / Shadow / Purified) — inherits global form by default
- Computed display (read-only, updates live): CP, Level, IV Rank (e.g. "Rank 4 GL")

**Input behavior:**
- Tab through ATK → DEF → STA → auto-creates new row and focuses its ATK field
- Add Row button as fallback
- Rows are reorderable (drag handle) and deletable

**Purify helper:**
- Shadow candidate rows show a "Purify" button
- Clicking it auto-creates a new candidate row with IVs +2 (capped at 15) and form set to Purified
- Allows direct shadow vs purified comparison without manual math

**Persistence:** Candidate list saves to localStorage and restores on next session open.

### 3. League & Level Controls

Located prominently near the top of the UI, above the results.

**League selector:** Great League (1500) / Ultra League (2500) / Master League (10000)

**Best Buddy toggle:**
- Off (default): all Pokémon capped at Level 50
- On: each Pokémon is leveled to its optimal stat product, up to Level 51
- "Optimal" means highest stat product at or under the CP cap, whether that's Level 18, 40, 50, 50.5, or 51
- Applies to both candidates and threats

Switching league or toggling Best Buddy updates all results instantly without re-entry.

### 4. Moveset Controls

**Default behavior:** Auto-select optimal moveset per matchup (same algorithm as PvPoke — best fast move by TDO, best charged moves by DPE).

**Global moveset override:**
- Fast move dropdown + two charged move dropdowns, populated from the species' available moves
- Changing any move applies to all candidates simultaneously
- "Reset to Auto" button restores auto-select behavior
- Can be changed at any time, including after candidates are entered

**Note:** Per-candidate moveset overrides are out of scope for v1. The global override covers the primary use case of evaluating all candidates with a specific moveset in mind.

### 5. Threat List

**Auto-fill:** On league selection, automatically populate threats from PvPoke's meta quickfill list for that league. Threats are auto-leveled to their optimal stat product under the cap (same logic as candidate leveling).

**Manual editing:**
- Add individual threats by species name search
- Remove threats individually
- Threats persist to localStorage per league

**Threat priority:**
- Each threat can be marked as High Priority or standard (click to toggle, or right-click context menu)
- High-priority threats are visually emphasized in the matrix
- Priority setting affects diff highlighting (see Section 7)

**Exclusion:** Threats can be excluded (greyed out) without being removed — see Section 7.

### 6. Results Matrix

The main output view. Candidates as rows, threats as columns.

**Cell value:** Battle Rating (0–1000, PvPoke's formula). Wins ≥ 500, losses < 500.

**Cell color:**
- Strong win (BR 700+): deep green
- Win (500–699): light green
- Tie (BR ~500): yellow
- Close loss (400–499): light red
- Loss (<400): deep red

**Shield scenario display (Option C):**
- Default cell shows the 1v1 (1 shield each) result
- If the outcome (win/loss) changes across any shield scenario, the cell shows a small indicator (e.g. three dots, colored by their respective outcomes: 0v0 / 1v1 / 2v2)
- Clicking the indicator expands to show all three Battle Ratings inline
- Cells where outcome is consistent across all shield scenarios show no indicator (clean)

**Threat column headers:**
- Show species name, moveset abbreviation, IVs, level (same format as PvPoke)
- Clicking a column header toggles it as excluded (greyed out)
- Greyed-out columns remain visible but move to the right end of the matrix
- Excluded threats are removed from win counts and diff highlighting

**Candidate row headers:**
- Show nickname, moveset, IVs, level, CP, IV Rank
- Same format as PvPoke's row labels

**Sorting:**
- Candidates sortable by: total wins (default), IV rank, stat product
- Threats sortable by: name, win rate against the field

### 7. Differences Section

Lives below the matrix. Shows what changed between candidates relative to Candidate 1 (the reference row, or whichever row is pinned as reference).

**Format:** Pill-based, same as PvPoke's differences view.
- Green pills: matchups the candidate wins that the reference loses (gains)
- Pink/red pills: matchups the candidate loses that the reference wins (losses)
- Each pill shows species name + moveset abbreviation

**Interaction:**
- Clicking a pill in the Differences section excludes that threat (same effect as clicking its column header in the matrix — bidirectional)
- Excluded threats move to the end of the pill list and are greyed out
- High-priority threat pills are visually distinguished (bold border or icon)

**Reference row:** Candidate 1 by default. Click any candidate row header to pin it as the reference.

**Filtering:**
- Option to show only High Priority threat differences (hides noise from fringe matchups)

### 8. Additional Display Modes

Accessible as tabs or a toggle above the matrix (same pattern as PvPoke's Battle Rating / Breakpoints / Bulkpoints / Attack tabs):

- **Battle Rating** (default) — as described above
- **Breakpoints** — for each candidate vs each threat, show whether a fast move damage breakpoint is reached. Separate tab, lower priority, v2 candidate.
- **Bulkpoints** — same but for defense. Separate tab, lower priority, v2 candidate.

GL vs UL comparison is handled by switching the league selector (instant, no re-entry) rather than as a split view — the tool is optimized for depth on one league at a time.

### 9. Persistence & Sessions

All of the following save to localStorage and restore automatically:

- Candidate list (species, form, IVs, nicknames)
- Threat list per league (including exclusions and priority flags)
- League selection
- Best Buddy toggle state
- Moveset overrides
- Reference row selection

A "Clear Session" button resets everything.

---

## UI Layout (Rough)

```
┌─────────────────────────────────────────────────────┐
│  [Species Search]  [Form: Normal▾]   [Clear Session] │
├─────────────────────────────────────────────────────┤
│  League: [GL] [UL] [ML]    Best Buddy: [toggle]     │
│  Moveset: [Fast Move▾] [Charged 1▾] [Charged 2▾]   │
│           [Reset to Auto]                            │
├─────────────────────────────────────────────────────┤
│  CANDIDATES                                          │
│  ┌──────────┬─────┬─────┬─────┬──────┬──────────┐  │
│  │ Nickname │ ATK │ DEF │ STA │ Form │ CP/Rank  │  │
│  ├──────────┼─────┼─────┼─────┼──────┼──────────┤  │
│  │ Cand. 1  │  0  │ 14  │ 15  │ Nrml │ 1492 R4  │  │
│  │ Cand. 2  │  1  │ 15  │ 14  │ Nrml │ 1498 R7  │  │
│  │ ...      │     │     │     │      │          │  │
│  └──────────┴─────┴─────┴─────┴──────┴──────────┘  │
│  [+ Add Row]                                         │
├─────────────────────────────────────────────────────┤
│  MATCHUPS  [Battle Rating] [Breakpoints] [Bulkpoints]│
│                                                      │
│  (Matrix grid — candidates × threats)                │
│                                                      │
├─────────────────────────────────────────────────────┤
│  DIFFERENCES (relative to Candidate 1)               │
│                                                      │
│  Cand. 2:  [+ Corsola (Gal.)]  [- Annihilape]  ...  │
│                                                      │
└─────────────────────────────────────────────────────┘
```

---

## Battle Simulation Notes

- Simulation follows PvPoke's published algorithm (MIT license, open source)
- Turn-based, 0.5s per turn
- Fast move → energy gain, damage per turn
- Charged move → energy cost, burst damage; shielded = 1 damage
- All 3 shield scenarios (0v0, 1v1, 2v2) computed per matchup
- Battle Rating formula: `(500 × damageDealt / opponentHP) + (500 × hpRemaining / ownHP)`
- CP formula, CPM table, and stat product calculations follow PvPoke's exact values
- Shadow multipliers: ATK × 1.2, DEF × 0.833 (standard Pokémon GO values)
- Purified IVs: each stat +2, capped at 15 (applied at candidate entry time)

---

## Out of Scope (v1)

- Per-candidate moveset overrides (global override only)
- Cross-species comparison (use PvPoke's matrix for this)
- Breakpoints/Bulkpoints (tab stub only, implementation deferred)
- Any server-side component
- Mobile optimization (desktop-first for v1)
- Exporting results to CSV (nice to have, low priority)

---

## Open Questions / Future Considerations

- **Breakpoint/Bulkpoint evaluator** — identified as a separate tool/project. Would take a species + target threat and output every IV threshold that changes fast move damage by ±1. Requires scanning all 4096 IV combos.
- **CSV export** of matrix results — low priority but straightforward to add
- **Multiple species in one session** — partially addressed by shadow/purified handling; full cross-species comparison deferred to PvPoke's existing matrix
- **PvPoke contribution** — codebase should be kept clean, dependency-free, and consistent with PvPoke's conventions (vanilla JS, no frameworks) to make contribution feasible

---

## Reference

- PvPoke repo: https://github.com/pvpoke/pvpoke (MIT license)
- Gamemaster data: https://pvpoke.com/data/gamemaster.json
- Battle algorithm documented at: https://pvpoke.com/battle/ (see "About the Battle Simulator" section)
