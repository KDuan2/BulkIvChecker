/*
 * Team Battle Sim — Pokemon state snapshot / restore
 *
 * Captures and restores a PvPoke Pokemon's mid-battle state so we can pass
 * residual state between 1v1 legs in a 3v3 scenario tree. Uses PvPoke's
 * existing emulate-mode resumption API (start* fields + reset()) — no
 * modifications to PvPoke's verbatim code.
 *
 * See docs/pvp_mechanics.md for the in-game mechanics this preserves
 * (HP/Energy persist on swap; stat stages reset; etc.).
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};

(function(ns) {

    /**
     * Snapshot a PvPoke Pokemon's current state. Returns a plain object
     * suitable for passing to applySnapshot() later (possibly on a fresh
     * Pokemon instance constructed from the same species + IVs).
     *
     * Captures everything needed for mid-battle resumption: HP, energy,
     * cooldown, damageWindow (pending fast-move resolution tick), shields,
     * stat stages, and form (for form-changing species).
     */
    ns.snapshotPokemon = function(poke) {
        return {
            hp: poke.hp,
            energy: poke.energy,
            cooldown: poke.cooldown,
            damageWindow: poke.damageWindow || 0,
            shields: poke.shields,
            statBuffs: [poke.statBuffs[0], poke.statBuffs[1]],
            // activeFormId is set by PvPoke on form-change; fall back to start/original
            formId: poke.activeFormId || poke.startFormId || poke.originalFormId || null,
            faintSource: poke.faintSource || ''
        };
    };

    /**
     * Apply a snapshot to a Pokemon instance so the next reset() call resumes
     * it at this state. Uses PvPoke's start* fields directly (the same fields
     * PvPoke's emulate mode uses for state restoration).
     *
     * @param {object} opts
     *   - isSwapIn: true if this pokemon is being swapped IN (stat stages reset
     *     to 0 per the in-game mechanic — see docs/pvp_mechanics.md). false if
     *     this is a same-active resume (preserve stat stages).
     */
    ns.applySnapshot = function(poke, snap, opts) {
        opts = opts || {};

        poke.setStartHp(snap.hp);
        poke.setStartEnergy(snap.energy);
        poke.startCooldown = snap.cooldown;
        poke.setShields(snap.shields);

        if (opts.isSwapIn) {
            // Stat stages reset to 0 on swap-in per in-game behavior
            poke.setStartBuffs([0, 0]);
        } else {
            poke.setStartBuffs([snap.statBuffs[0], snap.statBuffs[1]]);
        }

        if (snap.formId) {
            poke.startFormId = snap.formId;
        }

        // reset() restores start* into live fields. Pass isSwitch=true for swap-ins
        // so form-changers that resetOnSwitch (Aegislash) handle correctly.
        poke.reset(!!opts.isSwapIn);

        // damageWindow is reset to 0 by reset(); if non-zero in snapshot, restore.
        // Relevant when snapshotting mid-fast-move-cooldown for fast-move catching.
        // Only meaningful for same-active resume — swap-ins start with damageWindow = 0.
        if (!opts.isSwapIn && snap.damageWindow) {
            poke.damageWindow = snap.damageWindow;
        }
    };

    /**
     * Build a state hash for deduplication / transposition table use.
     * Two states with the same hash are functionally equivalent for branching
     * purposes (same HP/energy/shields/stat-stages/active-idx/timers).
     *
     * @param {object} teamState
     *   - teams: [{pokemon: [snap, snap, snap]}, {pokemon: [snap, snap, snap]}]
     *   - active: [activeIdxA, activeIdxB]
     *   - shields: [shieldsA, shieldsB]  (per-player team-wide shield budget)
     *   - switchTimers: [timerA, timerB] (per-player switch timer in turns)
     *   - turn: T (excluded from hash — dedup is turn-agnostic)
     */
    ns.hashState = function(teamState) {
        var parts = [];

        for (var t = 0; t < 2; t++) {
            var team = teamState.teams[t];
            for (var i = 0; i < team.pokemon.length; i++) {
                var p = team.pokemon[i];
                parts.push(
                    p.hp + ',' +
                    p.energy + ',' +
                    p.statBuffs[0] + ',' +
                    p.statBuffs[1]
                );
            }
        }

        parts.push('act=' + teamState.active[0] + ',' + teamState.active[1]);
        parts.push('sh=' + teamState.shields[0] + ',' + teamState.shields[1]);
        parts.push('st=' + teamState.switchTimers[0] + ',' + teamState.switchTimers[1]);

        return parts.join('|');
    };

    /**
     * Construct an initial TeamState for a fresh 3v3 with both leads at slot 0.
     * Pokemon snapshots are taken at full HP / 0 energy / 2 shields each player.
     *
     * @param {Array} teamA - [{poke: Pokemon, ...}, ...] length 3 (or just Pokemon[])
     * @param {Array} teamB - same shape
     * @param {object} opts - { shieldsPerPlayer: 2 }
     */
    ns.buildInitialTeamState = function(teamA, teamB, opts) {
        opts = opts || {};
        var shields = opts.shieldsPerPlayer !== undefined ? opts.shieldsPerPlayer : 2;

        function snapTeam(team) {
            var snaps = [];
            for (var i = 0; i < team.length; i++) {
                var p = team[i].poke || team[i];
                snaps.push(ns.snapshotPokemon(p));
            }
            return { pokemon: snaps };
        }

        return {
            teams: [snapTeam(teamA), snapTeam(teamB)],
            active: [0, 0],
            shields: [shields, shields],
            switchTimers: [0, 0],
            turn: 0
        };
    };

    /**
     * Count alive pokemon on a team (hp > 0 in the team snapshot).
     */
    ns.countAlive = function(teamSnap) {
        var count = 0;
        for (var i = 0; i < teamSnap.pokemon.length; i++) {
            if (teamSnap.pokemon[i].hp > 0) count++;
        }
        return count;
    };

    /**
     * Get the indices of alive pokemon on a team (sorted ascending).
     */
    ns.aliveIndices = function(teamSnap) {
        var indices = [];
        for (var i = 0; i < teamSnap.pokemon.length; i++) {
            if (teamSnap.pokemon[i].hp > 0) indices.push(i);
        }
        return indices;
    };

})(PvPIV.teamsim);
