# Pokemon GO PvP Battle Mechanics

This document captures the full understanding of Pokemon GO PvP battle mechanics that the team-battle-sim engine in `js/teamsim/` is built on. It exists so context isn't lost across sessions.

## Overview

Pokemon GO PvP (commonly played in GBL — Go Battle League — or in tournament formats like Silph) is a 3v3, turn-based competitive mode. Each player brings 3 pokemon; battles play out in 500ms turns until one team is reduced to 0 or the match timer expires. The current implementation uses PvPoke's published battle engine to simulate matchups; this document captures both the in-game mechanics and how they map onto the simulator.

## Core Timing

- One **turn** = 500ms of game time
- Match timer (standard): 4 minutes (worth verifying)
- No "speed stat" — turn ordering is deterministic except for **CMP** (Charge Move Priority) at simultaneous charged moves

## Per-Pokemon State

| Field | Behavior across swaps |
|---|---|
| HP | **Preserved** |
| Energy (0–100) | **Preserved** |
| Stat stages (-4 to +4, Attack & Defense) | **Reset to 0 on swap-out AND swap-in** |
| Fast-move cooldown counter | Resets on swap-in |
| Active form (Aegislash, Mimikyu) | Reset to base form on swap-out per PvPoke |

## Per-Player State

| Field | Notes |
|---|---|
| Shields | 2 total, **shared team-wide** (not per pokemon) |
| Switch timer | **45 seconds** (since 2025; was 60s previously). =90 ticks at 500ms/turn |
| Active pokemon index | Which pokemon is currently in battle |
| Bench | The 2 inactive pokemon |

## Fast Moves

- Variable cooldown: 1–5 turns depending on move (Lock-On = 1t, Counter = 2t, Charm = 3t, Incinerate = 5t)
- The pokemon is **locked** into the animation for the full cooldown
- Damage resolves on a specific tick within the cooldown window (PvPoke's `damageWindow`) — not gradually
- Energy is generated on damage resolution
- **Implication for catching**: swapping before the damage tick routes the damage to the swap-in, not the original target. This is "fast-move catching" — used e.g. to throw 2 short fast moves under a long opponent fast move, then swap to dump the long-move damage on a sacrifice

## Charged Moves

- Cost energy (35–100 typically); attacker must have ≥ cost to throw
- Take 1 turn for game-state purposes
- **Animation is 5 seconds = 10 turns of real time**; switch timers tick for **both** players during the animation
- Subject to defender shield decision at resolve time
- Defender's shield decision is made by **whichever pokemon is active at resolve time**, including a freshly swapped-in catcher
- Power minigame: bubble-popping; deliberately easy at 100%, but enables strategic undercharging
- Side effects (when present):
  - **Self-buff** (e.g., Power-Up Punch +1 Attack, Ancient Power +1/+1)
  - **Self-debuff** (e.g., Wild Charge -1/-1, Close Combat -1/-1, Superpower)
  - **Target-debuff** (e.g., Acid Spray -2 Def, Shadow Bone -1 Def)
- Side effects in PvP are **deterministic** (100% apply) — not probabilistic like main-series

### Shielding

- 2 per player, team-wide
- Shielded move: 1 damage through (NOT 0)
- Attacker still pays **full energy**
- **All side effects still apply even on shielded hits**: self-buff, self-debuff, and target-debuff all fire regardless

### Charged-Move Stalling

A pokemon stuck in a bad matchup can spam charged moves to burn switch timer. Each charged move animation ticks ~10 turns off both players' switch timers, effectively trading energy for clock progress.

## Swap / Switch Mechanics

### Voluntary Swap

- 1 turn cost
- **Resets own stat stages to 0** (so a self-debuffed attacker can swap to clear the debuff)
- Starts the player's 45s switch timer (if not already running)
- Cannot swap again until timer expires (45s)

### Forced Swap (on KO)

- Does **NOT** consume switch timer (it's free)
- If the player has **≥2 remaining**: 12-second switch menu appears
  - Both players' switch timers **tick during the 12s window**
  - Pressing a pokemon early reveals the choice to opp, who can react
  - Strategy: wait out the clock to sync switch timers and hide your read
- If the player has **1 remaining**: instant auto-swap, no menu

### Mutual Faint

- Both pokemon faint same turn (e.g., simultaneous CMP-tied throws)
- Both players hit the forced-swap mechanic above

### Emergent Catch Plays

"Catching" is not a built-in mechanic — it's emergent strategy from voluntary swap timing:

| Play | Description |
|---|---|
| **Defensive catch** | Swap in a resistant/bulky pokemon to absorb an incoming charged move better |
| **Sacrifice catch** | Swap in a low-HP / low-energy / spent pokemon to eat the move and preserve your active |
| **Swap combo** | Throw your charged move, immediately swap to a benched pokemon with energy, throw theirs — forces back-to-back shield decisions on the defender |
| **Debuff-and-swap** | Throw self-debuffing move (Wild Charge, Close Combat) then immediately swap to clear the debuff |
| **Throw-during-fast-move** | Use the skip-turn primitive to time your charged move while opp is locked into a long fast move, reducing their reaction window |
| **Stall via charged moves** | Spam throws in a bad matchup to burn switch-clock via the 5s animations |

## CMP (Charge Move Priority)

- When both players throw charged moves on the same turn, **higher Attack stat resolves first**
- The "loser" of CMP's move still fires — unless they faint from the first move's damage
- Affects shield-decision math: if you have CMP advantage, your throw goes first and the opp must shield before getting a chance to throw themselves

## Charged-Move Power Minigame / Undercharging

- A bubble-popping minigame after committing a charged move scales damage from ~25% to 100%
- Skilled players hit 100% reliably
- **Strategic undercharging**: deliberately do less damage to leave opp at survivable HP for "farming" — fast-attacking them down to generate more of your own energy before they faint
- PvPoke models undercharging in discrete increments (claim: ~5%; verify during implementation)

## Information Model

- **Pre-match (GBL)**: each player sees opp's **lead only** when the match starts; bench is hidden
- **Mid-match**: bench pokemon revealed on switch-in
- **Movesets**: revealed per-use (first throw of each move). Players generally **assume opp runs the PvPoke-recommended moveset** as a working hypothesis; off-meta sets (Forretress, Lickilicky, Giratina-Altered, Mew) create info-asymmetry
- **Energy tracking**: both players track their own and opp's energy mentally; skilled players use this to anticipate charged-move availability

## Team Role Heuristics (not enforced, useful for analysis)

Common team-building roles:

- **Lead**: opener; often anti-meta or broadly neutral typing; sets early tempo
- **Safe switch**: middle slot; neutral typing, resistant to common threats; the pokemon you bring in when lead matchup goes bad
- **Closer**: end-game cleaner; high-DPS attacker that benefits from shield-stripped opponents

Many teams flex these roles dynamically — they're heuristics, not rigid slots.

## Optimal Move Timing

A hallmark of decent play: throw charged moves at fast-move counts that minimize opp's "extra" energy turns.

Example: you have a 2-turn fast move, opp has a 5-turn fast move.
- Optimal throws: your 2nd or 7th fast move (turn 4 or 14) — opp gets at most 1 extra fast move of energy and avoids CMP-tie risk
- Suboptimal: turn 3 or 4 throw lets opp gain multiple extra fast-move energy ticks
- CMP-tie turn (turn 5): risky because opp can elect to throw a fast move instead of CMP-ing, gaining 5 turns of extra energy

Notation convention: optimal-timing windows often written as "2/7/12 for the 2-turn into 5-turn matchup" (your 2nd/7th/12th fast move).

**Important for our engine**: do NOT enforce optimal timing in the AI. The whole point of the scenario tree is to surface win conditions that may include suboptimal timing. Tag branches as "optimal-timing-adherent" in the analysis layer rather than pruning non-adherent branches.

## Battle End Conditions

- One team reduced to 0 pokemon → that team loses
- Timer expires → higher remaining HP% wins; tiebreak by remaining pokemon count

## Behaviors NOT Modeled (intentional)

| Behavior | Reason |
|---|---|
| 1-turn bring-in lag | Inconsistent network glitch; not a mechanic |
| DRE (Damage Registration Error) | Rare bug; was patched early 2026 but may still occur; not a mechanic |
| CMP sac-swapping | Very advanced; mechanism not fully understood; only seen at elite level |
| IV-edge case matchup search | Phase 2+ — Phase 1 assumes given IVs |
| Off-meta moveset variants | Phase 2+ — Phase 1 assumes PvPoke-recommended movesets |
| Imperfect-info modeling | Engine has perfect info; imperfect-info layer is Phase 2+ |
| Damage-minigame variance | Assumed 100% scaling unless an explicit undercharge tier is invoked |

## Relation to PvPoke Implementation

This codebase reuses PvPoke's 1v1 battle engine verbatim (per `CLAUDE.md` parity guarantee).

**PvPoke models correctly:**
- Turn-by-turn simulation via `Battle.step()` at 500ms intervals
- Fast-move `damageWindow` for damage resolution timing
- CMP via `usePriority` flag
- Side effects via `selfBuffing` / `selfDebuffing` / `buffApplyChance` flags
- Sandbox mode + `setActions()` for forced decisions (the seam the team-sim engine exploits)
- Snapshot resumption via `startHp` / `startEnergy` / `startStatBuffs` / `startingShields` / `startFormId`

**PvPoke does NOT natively model (the team-sim engine adds):**
- Multi-pokemon team orchestration (only 1v1 in current codebase)
- The 12-second forced-swap menu and its switch-timer tick
- 45-second switch timer (PvPoke value may still be 60s; override locally)
- Charged-move animation as 10 turns of switch-timer tick (verify; compensate if absent)
- Lead/safe-switch/closer team-role tagging
- The "skip turn" primitive (PvPoke AI always fast-moves when not charging)
- Voluntary mid-battle swaps as branch points
- The catch primitive (emergent from swap, but the engine must allow swap during opp's charged-move turn)
- Charged-move power tiers as a branch point (PvPoke uses default 100%)

## Quick Reference: Action Space Summary

**Attacker per turn** (one chosen):
1. Fast move (lock for cooldown turns, generate energy)
2. Charged move at power tier T ∈ {1.0, 0.75, 0.5} (energy ≥ cost; trigger defender shield decision; 10-turn animation tick)
3. Voluntary swap (1 turn; reset own stat stages; start 45s switch timer)
4. Skip turn (no action; used for timing throws into opp's fast-move animation)

**Defender per charged-move resolve**:
- Shield Y/N (applied by current active, may be a freshly-swapped-in catcher)

**Forced-swap decision** (on KO with ≥2 alive):
- Press immediately (leak info, save 12s of timer tick)
- Wait out 12s window (sync timers, hide read)
- Pick bench[i] for i in remaining indices
