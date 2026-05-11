/*
 * Team Battle Sim — Orchestrator
 *
 * Drives the 3v3 scenario tree. Enumerates leads (3x3), shield decisions per
 * charged move (nested binary tree), and forced swaps on KO. Tracks team
 * state (HP, energy, shield budget, switch timer) across legs via snapshots.
 *
 * Phase 1 scope:
 *   - Lead enumeration (3x3 at root)
 *   - Per-throw shield Y/N branching (nested binary tree of decisions)
 *   - Forced swap on KO with bench enumeration
 *   - Branch budget cap with greedy fallback past the cap
 *
 * Deferred to Phase 1.5:
 *   - Voluntary mid-leg swap branching
 *   - Skip-turn primitive branching
 *   - Charged-move power-tier branching
 *   - 12s switch-menu timing branches
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};

(function(ns) {

    // 45-second switch timer (since 2025); =90 ticks at 500ms/turn
    var SWITCH_TIMER_TICKS = 90;

    /**
     * Build the full scenario tree for a 3v3 matchup.
     *
     * @param {Array} teamA - [spec, spec, spec], each = {speciesId, ivs, shadowType?, moves?}
     * @param {Array} teamB - same shape
     * @param {object} options
     *   - cpCap, levelCap
     *   - shields (per-player, default 2)
     *   - maxBranches (default config.MAX_BRANCHES)
     *   - onProgress(info) — periodic callback
     * @returns {object} root TreeNode
     */
    ns.buildTree = async function(teamA, teamB, options) {
        options = options || {};
        options.cpCap = options.cpCap || 1500;
        options.levelCap = options.levelCap || 50;
        options.shields = options.shields !== undefined ? options.shields : 2;
        // exploreLeads default false: only enumerate slot-0 vs slot-0 lead pair.
        // Set to true for the full 3x3 enumeration.
        var exploreLeads = options.exploreLeads === true;

        // Build initial Pokemon set per spec to snapshot starting HP. We do this
        // once up-front; per-branch we'll reconstruct from the snapshot.
        var initialSnaps = buildInitialSnapshots(teamA, teamB, options);

        var initState = {
            teams: initialSnaps,
            active: [0, 0],
            shields: [options.shields, options.shields],
            switchTimers: [0, 0],
            turn: 0
        };

        var budget = PvPIV.teamsim.makeBudget(options.maxBranches);

        var progress = {
            exploredBranches: 0,
            estimatedTotal: 9 * 4 * 2, // rough — refined as we go
            lastReportedPct: 0
        };

        function reportProgress() {
            if (!options.onProgress) return;
            var pct = Math.min(99, Math.floor(100 * progress.exploredBranches / Math.max(progress.estimatedTotal, 1)));
            if (pct > progress.lastReportedPct + 1) {
                progress.lastReportedPct = pct;
                options.onProgress({
                    exploredBranches: progress.exploredBranches,
                    estimatedTotal: progress.estimatedTotal,
                    percent: pct
                });
            }
        }

        // Root: lead-pair decision. Default: only the slot-0 lead pair (most
        // teams have a designated lead). exploreLeads:true enumerates 3x3.
        var leadOptions = [];
        var aRange = exploreLeads ? [0, 1, 2] : [0];
        var bRange = exploreLeads ? [0, 1, 2] : [0];
        for (var ai = 0; ai < aRange.length; ai++) {
            for (var bi = 0; bi < bRange.length; bi++) {
                var a = aRange[ai], b = bRange[bi];
                leadOptions.push({
                    label: 'lead_' + a + '_' + b,
                    payload: {
                        leadA: a, leadB: b,
                        leadSpecA: teamA[a], leadSpecB: teamB[b],
                        leadAName: lookupName(teamA[a].speciesId),
                        leadBName: lookupName(teamB[b].speciesId)
                    }
                });
            }
        }

        var root = PvPIV.teamsim.makeNode({
            type: 'decision',
            id: 'root',
            state: initState,
            decisionContext: { kind: 'lead', actor: 0, options: leadOptions }
        });

        // Expand each lead branch
        for (var i = 0; i < leadOptions.length; i++) {
            var opt = leadOptions[i];
            var leadState = cloneState(initState);
            leadState.active = [opt.payload.leadA, opt.payload.leadB];

            var leadChild = PvPIV.teamsim.makeNode({
                type: 'decision', // will be elaborated by expansion
                state: leadState,
                edge: opt
            });
            PvPIV.teamsim.addChild(root, leadChild);

            await expandFromState(leadChild, leadState, teamA, teamB, options, budget, progress, reportProgress);
        }

        if (options.onProgress) {
            options.onProgress({
                exploredBranches: progress.exploredBranches,
                estimatedTotal: progress.exploredBranches,
                percent: 100
            });
        }

        return root;
    };

    /**
     * Build snapshots for the initial state: each pokemon at full HP, 0 energy,
     * default shields. We construct throwaway Pokemon instances on a dummy
     * battle to read out the computed stats.
     */
    function buildInitialSnapshots(teamA, teamB, options) {
        function snapsForTeam(team) {
            var dummyBattle = new Battle();
            dummyBattle.setCP(options.cpCap);
            dummyBattle.setLevelCap(options.levelCap);
            var snaps = [];
            for (var i = 0; i < team.length; i++) {
                var spec = team[i];
                var poke = constructPokemon(spec, dummyBattle, options.cpCap, options.levelCap);
                if (!poke) {
                    snaps.push({ hp: 0, energy: 0, cooldown: 0, damageWindow: 0, shields: 0, statBuffs: [0,0], formId: null, faintSource: '' });
                } else {
                    snaps.push(PvPIV.teamsim.snapshotPokemon(poke));
                }
            }
            return { pokemon: snaps };
        }
        return [snapsForTeam(teamA), snapsForTeam(teamB)];
    }

    /**
     * Construct a Pokemon instance per spec (mirrors leg.js's buildPokemon
     * but without snapshot application — used for initial state extraction).
     */
    function constructPokemon(spec, battle, cpCap, levelCap) {
        var poke = new Pokemon(spec.speciesId, 0, battle);
        if (!poke || !poke.speciesId) return null;
        if (spec.shadowType === 'shadow') poke.setShadowType('shadow');
        poke.ivs.atk = spec.ivs.atk;
        poke.ivs.def = spec.ivs.def;
        poke.ivs.hp = spec.ivs.hp;
        var level = levelCap;
        poke.cp = 100000;
        while (poke.cp > cpCap) {
            poke.setLevel(level, false);
            poke.cp = poke.calculateCP();
            level -= 0.5;
        }
        poke.isCustom = true;
        poke.initialize(false);
        var moves = spec.moves;
        if (!moves && typeof RANKING_MOVESETS !== 'undefined' && RANKING_MOVESETS[cpCap]) {
            moves = RANKING_MOVESETS[cpCap][spec.speciesId] || null;
        }
        if (moves) {
            if (moves[0]) poke.selectMove('fast', moves[0]);
            if (moves[1]) poke.selectMove('charged', moves[1], 0);
            if (moves[2]) poke.selectMove('charged', moves[2], 1);
        } else {
            poke.autoSelectMoves(2);
        }
        poke.startHp = poke.stats.hp;
        poke.hp = poke.stats.hp;
        return poke;
    }

    /**
     * Expand the tree from a given state. Runs a probe leg, then branches on
     * every shield decision produced by that probe. On KO, recurses with
     * forced swap. Game-over states become leaves.
     */
    async function expandFromState(parentNode, state, teamA, teamB, options, budget, progress, reportProgress) {
        // Check for game over
        var aliveA = countAlive(state.teams[0]);
        var aliveB = countAlive(state.teams[1]);

        if (aliveA === 0 || aliveB === 0) {
            attachOutcomeLeaf(parentNode, state);
            return;
        }

        // Branch budget check
        if (budget.exceeded()) {
            attachGreedyLeaf(parentNode, state, teamA, teamB, options);
            progress.exploredBranches++;
            return;
        }

        // Probe leg
        var specA = specForActive(teamA, state, 0);
        var specB = specForActive(teamB, state, 1);

        var probeResult = PvPIV.teamsim.runLeg({
            specA: specA,
            specB: specB,
            cpCap: options.cpCap,
            levelCap: options.levelCap
        });

        if (probeResult.error) {
            attachOutcomeLeaf(parentNode, state, 'tie');
            return;
        }

        // No charged throws: just one branch (the probe result IS the outcome)
        if (probeResult.chargedSchedule.length === 0) {
            await applyAndRecurse(parentNode, state, probeResult, [], teamA, teamB, options, budget, progress, reportProgress);
            return;
        }

        // Build nested binary tree of shield decisions
        await expandShieldDecisions(
            parentNode, state, probeResult, [], 0,
            teamA, teamB, options, budget, progress, reportProgress
        );
    }

    /**
     * Recursively expand the nested binary tree of shield decisions, one per
     * charged move in the probe schedule. Stops branching when:
     *   - All charged throws in the probe have been decided
     *   - Branch budget is exceeded
     *   - Shield-decision depth cap is hit (remaining throws use AI default)
     * At the leaf of this tree, runs the scripted leg and continues into the
     * game state that follows.
     */
    async function expandShieldDecisions(parentNode, state, probeResult, decisionsSoFar, idx,
                                         teamA, teamB, options, budget, progress, reportProgress) {

        var maxDepth = (PvPIV.teamsim.config && PvPIV.teamsim.config.SHIELD_BRANCH_MAX_DEPTH) || 4;

        // Stop branching: either all throws are decided, depth cap is hit,
        // or branch budget exceeded. Fill out remaining throws with the AI's
        // default shielded decision (from the probe), then run the scripted
        // leg as a single branch.
        if (idx >= probeResult.chargedSchedule.length ||
            idx >= maxDepth ||
            budget.exceeded()) {
            var fullDecisions = decisionsSoFar.slice();
            for (var i = idx; i < probeResult.chargedSchedule.length; i++) {
                var defaultShielded = !!(probeResult.chargedSchedule[i].settings &&
                                         probeResult.chargedSchedule[i].settings.shielded);
                fullDecisions.push(defaultShielded);
            }
            await applyAndRecurse(parentNode, state, probeResult, fullDecisions,
                                  teamA, teamB, options, budget, progress, reportProgress);
            return;
        }

        var throwAction = probeResult.chargedSchedule[idx];
        var defenderIdx = 1 - throwAction.actor;

        // Enrich with attacker / defender names and the charged-move name +
        // turn so analysis.js can produce human-readable strings.
        var throwerSpec = (throwAction.actor === 0)
            ? teamA[state.active[0]]
            : teamB[state.active[1]];
        var defenderSpec = (defenderIdx === 0)
            ? teamA[state.active[0]]
            : teamB[state.active[1]];
        var throwerName = lookupName(throwerSpec.speciesId);
        var defenderName = lookupName(defenderSpec.speciesId);
        var moveName = lookupMoveName(probeResult.pokemonRef, throwAction);
        var throwTurn = throwAction.turn;

        var shieldPayload = {
            idx: idx,
            throwActor: throwAction.actor,
            throwerName: throwerName,
            defenderName: defenderName,
            throwMoveName: moveName,
            throwTurn: throwTurn
        };

        // Decision node for this shield Y/N
        var shieldOptions = [
            { label: 'shield_y', payload: Object.assign({}, shieldPayload, { shielded: true }) },
            { label: 'shield_n', payload: Object.assign({}, shieldPayload, { shielded: false }) }
        ];

        // Filter "shield_y" if defender has no shields available
        if (state.shields[defenderIdx] <= 0) {
            shieldOptions = [shieldOptions[1]]; // only no-shield available
        }

        var decisionNode = PvPIV.teamsim.makeNode({
            type: 'decision',
            state: cloneState(state),
            decisionContext: {
                kind: 'shield',
                actor: defenderIdx,
                options: shieldOptions
            }
        });
        PvPIV.teamsim.addChild(parentNode, decisionNode);

        // Y branch (only if shield available)
        if (shieldOptions.some(function(o) { return o.label === 'shield_y'; })) {
            var yChild = PvPIV.teamsim.makeNode({
                type: 'placeholder',
                state: cloneState(state),
                edge: shieldOptions.filter(function(o) { return o.label === 'shield_y'; })[0]
            });
            PvPIV.teamsim.addChild(decisionNode, yChild);
            await expandShieldDecisions(yChild, state, probeResult, decisionsSoFar.concat([true]), idx + 1,
                                        teamA, teamB, options, budget, progress, reportProgress);
        }

        // N branch (always available)
        var nChild = PvPIV.teamsim.makeNode({
            type: 'placeholder',
            state: cloneState(state),
            edge: shieldOptions.filter(function(o) { return o.label === 'shield_n'; })[0]
        });
        PvPIV.teamsim.addChild(decisionNode, nChild);
        await expandShieldDecisions(nChild, state, probeResult, decisionsSoFar.concat([false]), idx + 1,
                                    teamA, teamB, options, budget, progress, reportProgress);
    }

    /**
     * Re-run the leg under the chosen shield script, then either attach a
     * leaf (game over) or continue into a forced-swap decision (KO).
     */
    async function applyAndRecurse(parentNode, state, probeResult, shieldDecisions,
                                   teamA, teamB, options, budget, progress, reportProgress) {

        var specA = specForActive(teamA, state, 0);
        var specB = specForActive(teamB, state, 1);

        var script = PvPIV.teamsim.buildScriptFromProbe(probeResult.chargedSchedule, shieldDecisions);

        var legResult = PvPIV.teamsim.runLeg({
            specA: specA,
            specB: specB,
            shieldScript: script,
            cpCap: options.cpCap,
            levelCap: options.levelCap
        });

        budget.consume(1);
        progress.exploredBranches++;
        reportProgress();
        await maybeYield(budget);

        // Update state from leg result
        var newState = applyLegResult(state, legResult, probeResult.chargedSchedule, shieldDecisions);

        // Handle KO / game over
        if (legResult.outcome === 'A_faints' || legResult.outcome === 'B_faints' || legResult.outcome === 'both_faint') {
            await handleForcedSwap(parentNode, newState, legResult, teamA, teamB, options, budget, progress, reportProgress);
        } else {
            // Timeout / both alive at end
            attachOutcomeLeaf(parentNode, newState, null, legResult.battleRatings);
        }
    }

    /**
     * Handle a KO: enumerate which bench pokemon each forced-swap player can
     * bring in. Recurse with the new active state.
     */
    async function handleForcedSwap(parentNode, state, legResult, teamA, teamB, options, budget, progress, reportProgress) {
        var aliveA = countAlive(state.teams[0]);
        var aliveB = countAlive(state.teams[1]);

        // Game over check
        if (aliveA === 0 || aliveB === 0) {
            attachOutcomeLeaf(parentNode, state, null, legResult.battleRatings);
            return;
        }

        // Who needs to forced-swap?
        var swappersNeeded = [];
        if (legResult.outcome === 'A_faints' || legResult.outcome === 'both_faint') swappersNeeded.push(0);
        if (legResult.outcome === 'B_faints' || legResult.outcome === 'both_faint') swappersNeeded.push(1);

        if (swappersNeeded.length === 0) {
            // Shouldn't happen given outer call site, but defensive
            attachOutcomeLeaf(parentNode, state, null, legResult.battleRatings);
            return;
        }

        // For each swapper, enumerate alive bench options. Combine across players.
        var benchOptions = [];
        for (var s = 0; s < swappersNeeded.length; s++) {
            var actor = swappersNeeded[s];
            var alive = PvPIV.teamsim.aliveIndices(state.teams[actor]);
            benchOptions.push({ actor: actor, options: alive });
        }

        // Cartesian product of swap picks
        var combos = cartesianSwapPicks(benchOptions);

        // If both players forced-swap, model as a single combined decision node
        // (otherwise nested decision nodes). For Phase 1 simplicity, combined:
        var swapDecisionOptions = combos.map(function(c) {
            var labelParts = [];
            var descriptions = [];
            for (var i = 0; i < c.length; i++) {
                var pick = c[i];
                labelParts.push('p' + pick.actor + '→' + pick.pickIdx);
                var team = pick.actor === 0 ? teamA : teamB;
                var faintedIdx = state.active[pick.actor];
                var faintedName = lookupName(team[faintedIdx].speciesId);
                var incomingName = lookupName(team[pick.pickIdx].speciesId);
                descriptions.push({
                    actor: pick.actor,
                    faintedName: faintedName,
                    incomingName: incomingName,
                    pickIdx: pick.pickIdx
                });
            }
            return {
                label: 'swap:' + labelParts.join(','),
                payload: { picks: c, swapDescriptions: descriptions }
            };
        });

        var swapNode = PvPIV.teamsim.makeNode({
            type: 'decision',
            state: cloneState(state),
            decisionContext: {
                kind: 'forced_swap',
                actor: swappersNeeded[0], // primary actor; secondary handled within payload
                options: swapDecisionOptions
            }
        });
        PvPIV.teamsim.addChild(parentNode, swapNode);

        for (var k = 0; k < swapDecisionOptions.length; k++) {
            var opt = swapDecisionOptions[k];
            var newState = cloneState(state);
            for (var p = 0; p < opt.payload.picks.length; p++) {
                var pick = opt.payload.picks[p];
                newState.active[pick.actor] = pick.pickIdx;
                // Forced swap does NOT consume switch timer (in-game mechanic)
            }

            var swapChild = PvPIV.teamsim.makeNode({
                type: 'placeholder',
                state: newState,
                edge: opt
            });
            PvPIV.teamsim.addChild(swapNode, swapChild);

            // Recurse — new active matchup
            await expandFromState(swapChild, newState, teamA, teamB, options, budget, progress, reportProgress);
        }
    }

    function cartesianSwapPicks(benchOptions) {
        var result = [[]];
        for (var i = 0; i < benchOptions.length; i++) {
            var next = [];
            for (var j = 0; j < result.length; j++) {
                for (var k = 0; k < benchOptions[i].options.length; k++) {
                    next.push(result[j].concat([{ actor: benchOptions[i].actor, pickIdx: benchOptions[i].options[k] }]));
                }
            }
            result = next;
        }
        return result;
    }

    /**
     * Apply a leg result to the team state: update active-pokemon snapshots,
     * decrement team shield budget by what was used, advance switch timer.
     */
    function applyLegResult(state, legResult, schedule, shieldDecisions) {
        var newState = cloneState(state);

        // Update active pokemon snapshots
        newState.teams[0].pokemon[newState.active[0]] = legResult.finalSnapshots[0];
        newState.teams[1].pokemon[newState.active[1]] = legResult.finalSnapshots[1];

        // Shield budget: count shields used by each defender (i.e., shielded=true
        // on charged moves thrown by the OTHER actor).
        if (schedule && shieldDecisions) {
            for (var i = 0; i < schedule.length; i++) {
                if (shieldDecisions[i]) {
                    var defender = 1 - schedule[i].actor;
                    newState.shields[defender] = Math.max(0, newState.shields[defender] - 1);
                }
            }
        }
        // Also update from final snapshot in case PvPoke decremented its pokemon's shields
        // The snapshot's shields field reflects the active pokemon's remaining shields.
        // For team-wide tracking, we trust our decrement count above.

        // Decrement switch timers by turns elapsed
        var turnsElapsed = legResult.turnsElapsed || 0;
        for (var p = 0; p < 2; p++) {
            newState.switchTimers[p] = Math.max(0, newState.switchTimers[p] - turnsElapsed);
        }

        newState.turn = (newState.turn || 0) + turnsElapsed;

        return newState;
    }

    /**
     * Build a spec to feed runLeg() for the current active pokemon. Uses
     * the team-level spec but injects the current snapshot.
     */
    function specForActive(team, state, actorIdx) {
        var idx = state.active[actorIdx];
        var teamSpec = team[idx];
        var snap = state.teams[actorIdx].pokemon[idx];

        // Allocate this player's full team shield budget to the active pokemon
        // (PvPoke models shields per-pokemon; we track per-player and re-assign).
        var snapWithShields = Object.assign({}, snap, { shields: state.shields[actorIdx] });

        return {
            speciesId: teamSpec.speciesId,
            ivs: teamSpec.ivs,
            shadowType: teamSpec.shadowType || 'normal',
            moves: teamSpec.moves || null,
            snapshot: snapWithShields,
            isSwapIn: false // we're resuming an existing active; not a fresh swap-in
        };
    }

    function countAlive(teamSnap) {
        var n = 0;
        for (var i = 0; i < teamSnap.pokemon.length; i++) {
            if (teamSnap.pokemon[i].hp > 0) n++;
        }
        return n;
    }

    /**
     * Attach a leaf to the parent with an outcome determined by the state.
     */
    function attachOutcomeLeaf(parentNode, state, forcedOutcome, ratings) {
        var aliveA = countAlive(state.teams[0]);
        var aliveB = countAlive(state.teams[1]);

        var outcome;
        if (forcedOutcome) {
            outcome = forcedOutcome;
        } else if (aliveA > aliveB) outcome = 'A_wins';
        else if (aliveB > aliveA) outcome = 'B_wins';
        else outcome = 'tie';

        var leaf = PvPIV.teamsim.makeNode({
            type: 'leaf',
            state: state,
            outcome: outcome,
            battleRatings: ratings || null
        });
        PvPIV.teamsim.addChild(parentNode, leaf);
    }

    /**
     * Attach a greedy-expansion leaf when branch budget is exhausted.
     * Runs a single probe-only leg (default AI) and treats the result as the
     * outcome. Marked approximated:true.
     */
    function attachGreedyLeaf(parentNode, state, teamA, teamB, options) {
        var aliveA = countAlive(state.teams[0]);
        var aliveB = countAlive(state.teams[1]);

        if (aliveA === 0 || aliveB === 0) {
            attachOutcomeLeaf(parentNode, state);
            return;
        }

        var specA = specForActive(teamA, state, 0);
        var specB = specForActive(teamB, state, 1);
        var legResult = PvPIV.teamsim.runLeg({
            specA: specA,
            specB: specB,
            cpCap: options.cpCap,
            levelCap: options.levelCap
        });
        if (legResult.error) {
            attachOutcomeLeaf(parentNode, state, 'tie');
            return;
        }
        var newState = applyLegResult(state, legResult, null, null);

        var outcome;
        if (legResult.outcome === 'A_faints' && countAlive(newState.teams[0]) === 0) outcome = 'B_wins';
        else if (legResult.outcome === 'B_faints' && countAlive(newState.teams[1]) === 0) outcome = 'A_wins';
        else if (legResult.outcome === 'timeout') {
            // Compare ratings
            outcome = legResult.battleRatings[0] > legResult.battleRatings[1] ? 'A_wins'
                    : legResult.battleRatings[1] > legResult.battleRatings[0] ? 'B_wins' : 'tie';
        } else {
            // Recurse one more time greedily — keep going until exhaustion or limit
            // For Phase 1 simplicity, just take outcome from leg
            outcome = countAlive(newState.teams[0]) > countAlive(newState.teams[1]) ? 'A_wins'
                    : countAlive(newState.teams[1]) > countAlive(newState.teams[0]) ? 'B_wins' : 'tie';
        }

        var leaf = PvPIV.teamsim.makeNode({
            type: 'leaf',
            state: newState,
            outcome: outcome,
            battleRatings: legResult.battleRatings,
            approximated: true
        });
        PvPIV.teamsim.addChild(parentNode, leaf);
    }

    /**
     * Deep-clone a TeamState. Snapshots are plain objects; JSON round-trip
     * is sufficient (and cheap enough for Phase 1 — flagged for optimization
     * to object pooling at Phase 3 scale).
     */
    function cloneState(state) {
        return JSON.parse(JSON.stringify(state));
    }

    /**
     * Cooperative yield to the event loop on a fixed cadence so the browser
     * can repaint and stay responsive during long expansions. Uses
     * budget.lastYieldAt to track when we last yielded.
     */
    async function maybeYield(budget) {
        var cadence = (PvPIV.teamsim.config && PvPIV.teamsim.config.YIELD_EVERY_N_BRANCHES) || 50;
        if (budget.used - budget.lastYieldAt >= cadence) {
            budget.lastYieldAt = budget.used;
            await new Promise(function(r) { setTimeout(r, 0); });
        }
    }

    /**
     * Resolve a speciesId to a human-readable name via the gamemaster, with
     * a safe fallback (capitalized speciesId) when the lookup misses.
     */
    function lookupName(speciesId) {
        if (typeof PvPIV !== 'undefined' && typeof PvPIV.getPokemonById === 'function') {
            var p = PvPIV.getPokemonById(speciesId);
            if (p && p.speciesName) return p.speciesName;
        }
        if (!speciesId) return '?';
        return speciesId.replace(/_/g, ' ').replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }

    /**
     * Resolve a charged move's display name from a leg's pokemonRef array
     * given a TimelineAction. Falls back to a slot label on failure.
     */
    function lookupMoveName(pokemonRef, action) {
        if (pokemonRef && pokemonRef[action.actor] && pokemonRef[action.actor].chargedMoves) {
            var move = pokemonRef[action.actor].chargedMoves[action.value];
            if (move && move.name) return move.name;
        }
        return 'Charged Move ' + (action.value + 1);
    }

    /**
     * Validate every species in both teams resolves in the gamemaster. Returns
     * an array of {team, slot, speciesId, message} for any failures; empty
     * array means all good.
     *
     * Exposed for use by engine.js so we can refuse to run with a clear error
     * message instead of silently rendering 0%/0%/1-branch rows.
     */
    ns.validateSpecies = function(teamA, teamB) {
        var errors = [];
        function check(team, label) {
            for (var i = 0; i < team.length; i++) {
                var id = team[i] && team[i].speciesId;
                if (!id) {
                    errors.push({ team: label, slot: i, speciesId: id || '(missing)',
                                  message: 'No species ID at slot ' + (i + 1) });
                    continue;
                }
                var p = (typeof PvPIV !== 'undefined' && typeof PvPIV.getPokemonById === 'function')
                    ? PvPIV.getPokemonById(id) : null;
                if (!p) {
                    errors.push({
                        team: label, slot: i, speciesId: id,
                        message: 'Unknown species: "' + id + '". Did you mean a different ID? ' +
                                 '(check spelling; alt forms use suffix style, e.g. stunfisk_galarian)'
                    });
                }
            }
        }
        check(teamA, 'A');
        check(teamB, 'B');
        return errors;
    };

})(PvPIV.teamsim);
