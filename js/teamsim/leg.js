/*
 * Team Battle Sim — Single 1v1 leg
 *
 * One "leg" is a 1v1 segment within a 3v3 battle: from when both actives
 * are in play until one or both faint (or the orchestrator interrupts for
 * a voluntary swap / skip-turn).
 *
 * Implementation strategy:
 *   - Two-pass per leg. Pass A runs default AI (probe) to harvest the
 *     charged-move schedule. Pass B replays in PvPoke sandbox mode with our
 *     scripted shield decisions and power tiers.
 *   - Replaces PvPoke's monolithic Battle.simulate() with a manual step
 *     loop so the orchestrator can interrupt per-turn for voluntary swaps,
 *     skip-turn primitives, etc. All PvPoke files remain verbatim.
 *
 * The shield/throw "script" is a list of TimelineAction objects matching
 * PvPoke's expected setActions() input shape. PvPoke's getTurnAction()
 * picks up scripted actions in sandbox mode by matching (actor, turn).
 *
 * See docs/pvp_mechanics.md for the mechanics this preserves.
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};

(function(ns) {

    /**
     * Build a Pokemon instance attached to a battle, with the given spec.
     *
     * @param {object} spec
     *   - speciesId
     *   - ivs: {atk, def, hp}
     *   - shadowType: "normal" | "shadow" | "purified" (default normal)
     *   - moves: [fastId, charged1Id, charged2Id] | null (null → ranking lookup)
     *   - snapshot: optional state snapshot from a prior leg
     *   - isSwapIn: when applying snapshot, whether to treat as a fresh swap-in
     * @param {Battle} battle
     * @param {number} cpCap
     * @param {number} levelCap
     */
    function buildPokemon(spec, battle, cpCap, levelCap) {
        var poke = new Pokemon(spec.speciesId, 0, battle);
        if (!poke || !poke.speciesId) return null;

        if (spec.shadowType === 'shadow') {
            poke.setShadowType('shadow');
        }

        poke.ivs.atk = spec.ivs.atk;
        poke.ivs.def = spec.ivs.def;
        poke.ivs.hp = spec.ivs.hp;

        // Find optimal level under CP cap (same pattern as js/battle.js createPokemon)
        var level = levelCap;
        poke.cp = 100000;
        while (poke.cp > cpCap) {
            poke.setLevel(level, false);
            poke.cp = poke.calculateCP();
            level -= 0.5;
        }

        poke.isCustom = true;
        poke.initialize(false);

        // Set moves from spec or ranking lookup
        var moves = spec.moves;
        if (!moves) {
            if (typeof RANKING_MOVESETS !== 'undefined' && RANKING_MOVESETS[cpCap]) {
                moves = RANKING_MOVESETS[cpCap][spec.speciesId] || null;
            }
        }
        if (moves) {
            if (moves[0]) poke.selectMove('fast', moves[0]);
            if (moves[1]) poke.selectMove('charged', moves[1], 0);
            if (moves[2]) poke.selectMove('charged', moves[2], 1);
        } else {
            poke.autoSelectMoves(2);
        }

        // Apply snapshot if present (mid-battle resume)
        if (spec.snapshot) {
            ns.applySnapshot(poke, spec.snapshot, { isSwapIn: !!spec.isSwapIn });
        } else {
            // Default to a fresh state — full HP, 0 energy, default shields handled by caller
            poke.startHp = poke.stats.hp;
            poke.hp = poke.stats.hp;
            poke.startEnergy = 0;
            poke.energy = 0;
        }

        return poke;
    }

    /**
     * Extract the charged-throw schedule from a completed battle's timeline.
     * Returns an array of TimelineAction objects ready for re-injection via
     * setActions() (after optionally mutating shielded/charge per branch).
     *
     * Leverages PvPoke's existing convertTimelineToActions() which already
     * does the timeline-event-to-action mapping.
     */
    function extractChargedSchedule(battle) {
        return battle.convertTimelineToActions();
    }

    /**
     * Run a single 1v1 leg.
     *
     * @param {object} spec
     *   - specA, specB: { speciesId, ivs, shadowType, moves, snapshot, isSwapIn }
     *   - cpCap, levelCap
     *   - shieldsA, shieldsB: per-player team shield budget (passed to the active pokemon)
     *   - shieldScript: array of TimelineAction | null (null = probe pass)
     *   - maxTime: ms; default 240000 (4 minutes match timer)
     *   - onTurn: optional callback (turn, state) => null | { action, ... }
     *       returning { action: 'break_for_swap', actor: 0|1, target: benchIdx } breaks
     *       returning { action: 'inject_wait', actor: 0|1 } makes that pokemon skip its turn
     *   - debug: optional bool, logs turn-by-turn to console
     *
     * @returns {object}
     *   - outcome: 'A_faints' | 'B_faints' | 'both_faint' | 'timeout' | 'voluntary_break'
     *   - battleRatings: [a, b]
     *   - finalSnapshots: [snapA, snapB]
     *   - chargedSchedule: TimelineAction[] (from probe pass; consumable for scripted re-run)
     *   - turnsElapsed
     *   - voluntaryBreakInfo: present if outcome === 'voluntary_break'
     */
    ns.runLeg = function(spec) {
        var battle = new Battle();
        battle.setCP(spec.cpCap);
        battle.setLevelCap(spec.levelCap);

        var pokeA = buildPokemon(spec.specA, battle, spec.cpCap, spec.levelCap);
        var pokeB = buildPokemon(spec.specB, battle, spec.cpCap, spec.levelCap);

        if (!pokeA || !pokeB) {
            return { error: 'pokemon_construction_failed' };
        }

        // Shield budget: snapshot.shields already preserves, but if no snapshot
        // and shields explicitly set, override.
        if (spec.shieldsA !== undefined && !spec.specA.snapshot) {
            pokeA.shields = spec.shieldsA;
            pokeA.startingShields = spec.shieldsA;
        }
        if (spec.shieldsB !== undefined && !spec.specB.snapshot) {
            pokeB.shields = spec.shieldsB;
            pokeB.startingShields = spec.shieldsB;
        }

        battle.setNewPokemon(pokeA, 0, false);
        battle.setNewPokemon(pokeB, 1, false);

        // Mode setup — mirror simulate()'s prelude without entering its loop.
        battle.setBattleMode('simulate');

        if (spec.shieldScript) {
            // Enter sandbox mode then override actions with our script. Order
            // matters: setSandboxMode calls convertTimelineToActions() which would
            // wipe our actions if called after setActions.
            battle.setSandboxMode(true);
            battle.setActions(spec.shieldScript);
        }

        battle.start();

        var maxTurns = Math.floor((spec.maxTime || 240000) / 500);
        var turn = 0;
        var voluntaryBreakInfo = null;
        var continueBattle = true;

        while (continueBattle && turn < maxTurns) {
            // Orchestrator interrupt check — runs BEFORE the step so interrupts
            // can preempt the per-turn action determination.
            if (spec.onTurn) {
                var interrupt = spec.onTurn(turn, {
                    pokeA: pokeA,
                    pokeB: pokeB,
                    turn: turn
                });
                if (interrupt) {
                    if (interrupt.action === 'break_for_swap') {
                        voluntaryBreakInfo = interrupt;
                        break;
                    }
                    if (interrupt.action === 'inject_wait') {
                        // Queue a "wait" action for the specified actor this turn.
                        // PvPoke's getTurnAction sees the queued action and uses it
                        // instead of computing a fast move.
                        battle.queueAction(interrupt.actor, 'wait', 0);
                    }
                }
            }

            battle.step();
            turn++;

            if (pokeA.hp <= 0 || pokeB.hp <= 0) {
                continueBattle = false;
            }
        }

        // Determine outcome
        var outcome;
        if (voluntaryBreakInfo) {
            outcome = 'voluntary_break';
        } else if (pokeA.hp <= 0 && pokeB.hp <= 0) {
            outcome = 'both_faint';
        } else if (pokeA.hp <= 0) {
            outcome = 'A_faints';
        } else if (pokeB.hp <= 0) {
            outcome = 'B_faints';
        } else {
            outcome = 'timeout';
        }

        var battleRatings = [pokeA.getBattleRating(), pokeB.getBattleRating()];

        var finalSnapshots = [
            ns.snapshotPokemon(pokeA),
            ns.snapshotPokemon(pokeB)
        ];

        // Probe pass: extract charged schedule for scripted re-runs.
        // (Sandbox runs already have a script; re-extracting is a no-op cost.)
        var chargedSchedule = extractChargedSchedule(battle);

        var result = {
            outcome: outcome,
            battleRatings: battleRatings,
            finalSnapshots: finalSnapshots,
            chargedSchedule: chargedSchedule,
            turnsElapsed: turn,
            pokemonRef: [pokeA, pokeB]
        };

        if (voluntaryBreakInfo) {
            result.voluntaryBreakInfo = voluntaryBreakInfo;
        }

        return result;
    };

    /**
     * Build a scripted shield array from a probe pass's chargedSchedule plus a
     * shield decision vector. The decision vector is indexed by charged-throw
     * ordinal (0, 1, 2, ...) — one Y/N per charged move in the probe.
     *
     * @param {Array} probeSchedule - TimelineAction[] from runLeg probe pass
     * @param {Array<boolean>} shieldDecisions - one entry per charged throw
     * @param {Array<number>} chargeTiers - optional power tier per throw (default all 1.0)
     */
    ns.buildScriptFromProbe = function(probeSchedule, shieldDecisions, chargeTiers) {
        var script = [];
        for (var i = 0; i < probeSchedule.length; i++) {
            var probe = probeSchedule[i];
            // Construct a fresh TimelineAction (avoid mutating probe — it might
            // be reused across branches).
            var settings = {
                shielded: shieldDecisions ? !!shieldDecisions[i] : !!probe.settings.shielded,
                buffs: probe.settings.buffs || false,
                charge: chargeTiers && chargeTiers[i] !== undefined ? chargeTiers[i] : 1,
                priority: probe.settings.priority || 0
            };
            var action = new TimelineAction(
                probe.type,
                probe.actor,
                probe.turn,
                probe.value,
                settings
            );
            script.push(action);
        }
        return script;
    };

    /**
     * Enumerate all 2^N shield decision combinations for a charged schedule.
     * For N charged moves, returns 2^N decision vectors.
     *
     * Used by the orchestrator to fan out shield-decision branches per leg.
     */
    ns.enumerateShieldDecisions = function(scheduleLength) {
        var combos = [];
        var total = 1 << scheduleLength;
        for (var i = 0; i < total; i++) {
            var vec = [];
            for (var j = 0; j < scheduleLength; j++) {
                vec.push(!!(i & (1 << j)));
            }
            combos.push(vec);
        }
        return combos;
    };

})(PvPIV.teamsim);
