/*
 * Team Battle Sim — Public Entrypoint
 *
 * Exposes simulateTeamBattle() to the rest of the app and the browser
 * console. Composes orchestrator (tree build) + analysis (output panels).
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};

(function(ns) {

    /**
     * Run a full 3v3 scenario-tree simulation.
     *
     * Returns a Promise that resolves to the result object. The engine
     * cooperatively yields to the event loop during expansion (see
     * orchestrator.maybeYield) so the browser stays responsive.
     *
     * @param {Array} teamA - [spec, spec, spec], each = {speciesId, ivs:{atk,def,hp}, shadowType?, moves?}
     * @param {Array} teamB - same shape
     * @param {object} options
     *   - cpCap: 1500 / 2500 / 10000 (default 1500)
     *   - levelCap: default 50
     *   - shields: per-player budget, default 2
     *   - maxBranches: default config.MAX_BRANCHES
     *   - exploreLeads: bool, default false. false → only slot-0 lead pair.
     *                   true → full 3x3 lead enumeration.
     *   - onProgress(info): optional callback during expansion
     *   - includeTree: bool; if true, returns the full tree under .tree (default true)
     *
     * @returns {Promise<object>}
     *   - errors, summary, leadAnalysis, winConditions, criticalDecisions, tree, timing
     */
    ns.simulateTeamBattle = async function(teamA, teamB, options) {
        options = options || {};

        if (!validateTeam(teamA) || !validateTeam(teamB)) {
            throw new Error('teamA and teamB must each be arrays of 3 specs with speciesId and ivs');
        }

        // Species ID validation against the gamemaster. We return errors in the
        // result rather than throwing so the UI can render them gracefully and
        // doesn't have to wrap in try/catch.
        var speciesErrors = ns.validateSpecies(teamA, teamB);
        if (speciesErrors.length > 0) {
            return {
                errors: speciesErrors,
                summary: null,
                leadAnalysis: [],
                winConditions: { A: [], B: [] },
                criticalDecisions: [],
                tree: null,
                timing: { elapsedMs: 0, totalNodes: 0, treeDepth: 0 }
            };
        }

        var startTs = Date.now();

        var root = await ns.buildTree(teamA, teamB, options);

        var leaves = PvPIV.teamsim.collectLeaves(root);

        var summary = PvPIV.teamsim.computeSummary(leaves);
        var leadAnalysis = PvPIV.teamsim.computeLeadAnalysis(root);
        var winConditionsA = PvPIV.teamsim.computeWinConditions(root, 'A');
        var winConditionsB = PvPIV.teamsim.computeWinConditions(root, 'B');
        var criticalDecisions = PvPIV.teamsim.computeCriticalDecisions(root);

        var elapsed = Date.now() - startTs;

        return {
            errors: [],
            summary: summary,
            leadAnalysis: leadAnalysis,
            winConditions: {
                A: winConditionsA,
                B: winConditionsB
            },
            criticalDecisions: criticalDecisions,
            tree: options.includeTree === false ? null : root,
            timing: {
                elapsedMs: elapsed,
                totalNodes: PvPIV.teamsim.countNodes(root),
                treeDepth: PvPIV.teamsim.depth(root)
            }
        };
    };

    function validateTeam(team) {
        if (!Array.isArray(team)) return false;
        if (team.length !== 3) return false;
        for (var i = 0; i < team.length; i++) {
            if (!team[i] || !team[i].speciesId || !team[i].ivs) return false;
            var ivs = team[i].ivs;
            if (typeof ivs.atk !== 'number' || typeof ivs.def !== 'number' || typeof ivs.hp !== 'number') return false;
        }
        return true;
    }

    /**
     * Quick helper for building a team spec from species ID list, defaulting
     * IVs to PvP-friendly values and pulling movesets from rankings.
     *
     * @param {Array<string>} speciesIds
     * @param {object} options - { ivs?: {atk,def,hp}, shadowType?, cpCap? }
     */
    ns.makeTeamFromSpecies = function(speciesIds, options) {
        options = options || {};
        var ivs = options.ivs || { atk: 0, def: 15, hp: 15 };
        var team = [];
        for (var i = 0; i < speciesIds.length; i++) {
            team.push({
                speciesId: speciesIds[i],
                ivs: { atk: ivs.atk, def: ivs.def, hp: ivs.hp },
                shadowType: options.shadowType || 'normal'
                // moves omitted — leg.js will use ranking lookup
            });
        }
        return team;
    };

})(PvPIV.teamsim);
