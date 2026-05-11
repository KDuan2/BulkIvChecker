# Project Context for Claude

This is a standalone web app for bulk Pokemon GO PvP IV comparison. It opens from `file://` (no server) and uses PvPoke's verbatim battle engine for 100% accuracy against PvPoke's matrix output.

## Architecture — read this before changing battle logic

The battle simulation engine is **PvPoke's actual source code, copied verbatim**. We did NOT reimplement it. Battle accuracy was verified at 100% match against PvPoke's matrix output in GL/UL/ML.

```
┌───────────────────────────────────────────────┐
│  js/app.js  (our UI — most original code)     │
├───────────────────────────────────────────────┤
│  js/battle.js  (our bridge)                   │
├───────────────────────────────────────────────┤
│  js/pvpoke/*.js  (PvPoke's verbatim engine)   │
├───────────────────────────────────────────────┤
│  js/pvpoke/GameMasterShim.js  (our adapter)   │
├───────────────────────────────────────────────┤
│  data/*.js  (PvPoke's data, wrapped)          │
└───────────────────────────────────────────────┘
```

### PvPoke verbatim files (DO NOT MODIFY)

These 7 files in `js/pvpoke/` are copied directly from the PvPoke repo. If you find a battle logic bug, the fix belongs upstream in PvPoke, not here. Modifying these files will diverge our results from PvPoke's reference output and break the accuracy guarantee.

| File | PvPoke source |
|---|---|
| `js/pvpoke/Battle.js` | `src/js/battle/Battle.js` |
| `js/pvpoke/Pokemon.js` | `src/js/pokemon/Pokemon.js` |
| `js/pvpoke/ActionLogic.js` | `src/js/battle/actions/ActionLogic.js` |
| `js/pvpoke/DamageCalculator.js` | `src/js/battle/DamageCalculator.js` |
| `js/pvpoke/TimelineAction.js` | `src/js/battle/timeline/TimelineAction.js` |
| `js/pvpoke/TimelineEvent.js` | `src/js/battle/timeline/TimelineEvent.js` |
| `js/pvpoke/DecisionOption.js` | `src/js/training/DecisionOption.js` |

### Our layer (this is where changes go)

| File | Purpose |
|---|---|
| `js/pvpoke/GameMasterShim.js` | Provides the `GameMaster` singleton interface PvPoke expects, backed by `GAMEMASTER_DATA`. Also derives move properties (`selfDebuffing`, `selfBuffing`, `selfAttackDebuffing`) that PvPoke's real `GameMaster.js` sets at load time — these are critical for correct AI behavior. |
| `js/battle.js` | Bridge layer. Wraps PvPoke's `Battle` and `Pokemon` classes into the `PvPIV` namespace. Exposes `simulateBattle()` and `debugBattle()`. |
| `js/gamemaster.js` | Data accessors (`getPokemonById`, `getMoveById`, `getCup`, `loadMetaGroup`, etc.). Includes `generateThreatsFromCup()` for filter-based threat generation (not wired into UI). |
| `js/types.js` | Type effectiveness chart. |
| `js/app.js` | All UI logic: candidates, threats, matrix, differences, exports, persistence. This is the largest original file. |

### Data files (all from PvPoke)

| File | Origin |
|---|---|
| `gamemaster_cache.json` | `pvpoke.com/data/gamemaster.json` |
| `data/gamemaster-data.js` | Same JSON wrapped as `var GAMEMASTER_DATA = {...};` so it loads via `<script>` from `file://` |
| `data/groups/*.json` | `pvpoke/src/data/groups/*.json` — 24 pre-built meta threat lists |
| `data/meta-groups.js` | The 24 group files combined into `META_GROUPS` global |
| `data/ranking-movesets.js` | Recommended movesets from `pvpoke/src/data/rankings/all/overall/rankings-{1500,2500,10000}.json` |
| `data/ranking-scores.js` | Overall scores from the same ranking files |
| `data/archived-cups.js` | Historical cup filter definitions from `pvpoke/src/data/gamemaster/cups/archive/*.json` |

## Debugging battle accuracy

If a battle rating doesn't match PvPoke's matrix:

1. **First verify input data is identical** — same IVs, level, moves, shadow status. Most discrepancies are setup bugs in `js/app.js` or `js/battle.js`, not engine bugs. (Past example: a missing `selfDebuffing` derivation in the GameMaster shim caused widespread mismatches — fix was in the shim, not the engine.)
2. **Use `PvPIV.debugBattle(speciesA, ivsA, speciesB, ivsB, shields, cpCap, movesA, movesB)`** in the browser console for turn-by-turn output.
3. **Use `compare_csv.py`** to bulk-compare CSV exports against PvPoke's matrix export.
4. **Do not modify `js/pvpoke/*.js`.**

## Updating from PvPoke

To re-sync with a newer PvPoke release:

1. Copy the 7 verbatim source files from your local PvPoke clone into `js/pvpoke/`.
2. Copy `pvpoke/src/data/gamemaster.json` → wrap as `data/gamemaster-data.js` (prefix `var GAMEMASTER_DATA = ` and suffix `;`).
3. Copy all `pvpoke/src/data/groups/*.json` → regenerate `data/meta-groups.js` (combined object keyed by filename).
4. Regenerate `data/ranking-movesets.js` and `data/ranking-scores.js` from the ranking JSON files.
5. Run `compare_csv.py` against PvPoke's matrix to verify no regressions.

## Tech constraints

- **No server required** — runs from `file://` by double-clicking `index.html`. All data is loaded via `<script>` tags (not `fetch()`).
- **Vanilla JS only** — no frameworks, no build step. Consistent with PvPoke's own codebase.
- **`PvPIV` namespace** — our code attaches to `var PvPIV = PvPIV || {};` to avoid polluting globals. PvPoke's verbatim code uses its own globals (`Battle`, `Pokemon`, `GameMaster`, etc.).

## License

PvPoke is MIT-licensed. See `ATTRIBUTION.md` for credit and the license terms we comply with.
