/*
 * Team Battle Sim — Pruning
 *
 * Branch pruning and dedup utilities used by the orchestrator to keep the
 * scenario tree browser-tractable. Combination of exact (lossless) and
 * heuristic (lossy, threshold-gated) techniques per the design in
 * ~/.claude/plans/battle-sim-expansion-i-m-hazy-fern.md.
 *
 * Configuration lives in PvPIV.teamsim.config so it's tunable from the
 * browser console without code edits.
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};

(function(ns) {

    /**
     * Tunable pruning constants. Adjust from console for verification:
     *   PvPIV.teamsim.config.MAX_BRANCHES = 10000;
     */
    ns.config = {
        // Hard cap on total expanded leaves. Past this, expansion switches to
        // greedy (default-AI) mode and leaves are marked approximated:true.
        MAX_BRANCHES: 5000,

        // Threshold for lead pruning: lead pairs where the lead loses with
        // battle rating below this at 1-1 shields are pruned. Set to 0 to
        // disable.
        LEAD_PRUNE_RATING: 100,

        // Skip lead pruning entirely (for verification runs).
        FORCE_LEAD_PRUNE: false,  // when true, prune; when false, keep all leads

        // Threshold for "decision matters" detection in analysis.js — surface
        // decisions where win-rate variance across children exceeds this.
        CRITICAL_DECISION_VARIANCE: 0.2,

        // Skip shield branch if move damage as % of defender max HP is below
        // this AND the move has no side effects. (Future use; orchestrator may
        // implement this when scripting shield decisions.)
        SHIELD_MIN_DAMAGE_PCT: 0.05,

        // Maximum win-condition clusters to surface in analysis output.
        MAX_WIN_CLUSTERS: 8,

        // Maximum critical decisions to surface in analysis output.
        MAX_CRITICAL_DECISIONS: 5,

        // Cap on shield-decision binary-tree depth per leg. After this many
        // throws have been branched Y/N, remaining throws use the AI's default
        // shielded value (no more branching). 4 → at most 2^4 = 16 branches per
        // leg. Trade-off: lossy on late-leg shield exploration but bounded.
        SHIELD_BRANCH_MAX_DEPTH: 4,

        // Cooperative yield cadence: orchestrator awaits a setTimeout-0 every
        // N consumed branches so the browser can repaint and stay responsive
        // during long runs.
        YIELD_EVERY_N_BRANCHES: 50
    };

    /**
     * Branch budget tracker. Pass through orchestration to throttle expansion.
     * Also tracks last-yield count so the orchestrator's maybeYield() helper
     * can fire on a fixed cadence regardless of recursion shape.
     */
    ns.makeBudget = function(maxBranches) {
        var max = maxBranches !== undefined ? maxBranches : ns.config.MAX_BRANCHES;
        return {
            max: max,
            used: 0,
            lastYieldAt: 0,
            consume: function(n) {
                this.used += (n || 1);
                return this.used <= this.max;
            },
            exceeded: function() {
                return this.used >= this.max;
            },
            remaining: function() {
                return Math.max(0, this.max - this.used);
            }
        };
    };

    /**
     * Filter shield actions: skip "shield" branch when defender has 0 shields.
     * @param {Array} options - array of action descriptors
     * @param {object} state - team state
     * @param {number} defenderIdx - which player is defending (0 or 1)
     * @returns {Array} filtered options
     */
    ns.filterShieldOptions = function(options, state, defenderIdx) {
        if (state.shields[defenderIdx] > 0) return options;
        // No shields available — only allow no-shield options
        return options.filter(function(opt) {
            return opt.label !== 'shield_y';
        });
    };

    /**
     * Filter voluntary-swap options: skip if switch timer is still ticking down,
     * or if no bench pokemon are alive to swap to.
     */
    ns.filterSwapOptions = function(options, state, actorIdx) {
        var timer = state.switchTimers[actorIdx];
        var teamSnap = state.teams[actorIdx];

        var aliveBench = 0;
        for (var i = 0; i < teamSnap.pokemon.length; i++) {
            if (i !== state.active[actorIdx] && teamSnap.pokemon[i].hp > 0) {
                aliveBench++;
            }
        }

        return options.filter(function(opt) {
            if (opt.label && opt.label.indexOf('voluntary_swap') === 0) {
                if (timer > 0) return false;
                if (aliveBench === 0) return false;
            }
            return true;
        });
    };

    /**
     * Dominance check between two same-decision-point actions, given outcome
     * snapshots from probe simulations. Returns:
     *   1 if A strictly dominates B (drop B)
     *  -1 if B strictly dominates A (drop A)
     *   0 if neither dominates (keep both)
     *
     * Strict dominance: A's state >= B's state in every measurable axis with
     * at least one strict improvement.
     */
    ns.dominanceCompare = function(stateA, stateB, actorIdx) {
        // We compare from actorIdx's perspective: higher own HP/energy/shields
        // good; lower opponent's HP good.
        var oppIdx = 1 - actorIdx;

        var ownPokesA = stateA.teams[actorIdx].pokemon;
        var ownPokesB = stateB.teams[actorIdx].pokemon;
        var oppPokesA = stateA.teams[oppIdx].pokemon;
        var oppPokesB = stateB.teams[oppIdx].pokemon;

        var aDominates = true;
        var bDominates = true;
        var aStrictlyBetter = false;
        var bStrictlyBetter = false;

        // Own pokemon: more HP and energy is better
        for (var i = 0; i < ownPokesA.length; i++) {
            if (ownPokesA[i].hp > ownPokesB[i].hp) {
                bDominates = false;
                aStrictlyBetter = true;
            } else if (ownPokesA[i].hp < ownPokesB[i].hp) {
                aDominates = false;
                bStrictlyBetter = true;
            }
            if (ownPokesA[i].energy > ownPokesB[i].energy) {
                bDominates = false;
                aStrictlyBetter = true;
            } else if (ownPokesA[i].energy < ownPokesB[i].energy) {
                aDominates = false;
                bStrictlyBetter = true;
            }
        }

        // Opponent pokemon: less HP is better for us
        for (var i = 0; i < oppPokesA.length; i++) {
            if (oppPokesA[i].hp < oppPokesB[i].hp) {
                bDominates = false;
                aStrictlyBetter = true;
            } else if (oppPokesA[i].hp > oppPokesB[i].hp) {
                aDominates = false;
                bStrictlyBetter = true;
            }
        }

        // Shields: more own shields is better
        if (stateA.shields[actorIdx] > stateB.shields[actorIdx]) {
            bDominates = false;
            aStrictlyBetter = true;
        } else if (stateA.shields[actorIdx] < stateB.shields[actorIdx]) {
            aDominates = false;
            bStrictlyBetter = true;
        }

        if (aDominates && aStrictlyBetter) return 1;
        if (bDominates && bStrictlyBetter) return -1;
        return 0;
    };

    /**
     * State-hash transposition table. Use to dedup equivalent states across
     * different decision paths.
     */
    ns.makeTransposition = function() {
        var table = {};
        return {
            seen: function(hash) {
                return Object.prototype.hasOwnProperty.call(table, hash);
            },
            record: function(hash, node) {
                table[hash] = node;
            },
            get: function(hash) {
                return table[hash];
            },
            size: function() {
                return Object.keys(table).length;
            }
        };
    };

})(PvPIV.teamsim);
