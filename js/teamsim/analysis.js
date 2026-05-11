/*
 * Team Battle Sim — Output Panel Computation
 *
 * Given a fully-expanded scenario tree, produces the four output panels:
 *   - summary stats
 *   - lead-pair breakdown
 *   - win-condition clusters
 *   - critical-decision surfacing
 *
 * Operates purely on tree structure — no PvPoke knowledge required.
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};

(function(ns) {

    /**
     * Top-level reduction over the leaves of a tree.
     *
     * @param {Array} leaves - array of leaf nodes from tree.collectLeaves
     * @returns {object}
     */
    ns.computeSummary = function(leaves) {
        var totalBranches = leaves.length;
        if (totalBranches === 0) {
            return {
                totalBranches: 0, winRateA: 0, winRateB: 0, tieRate: 0,
                avgRemainingA: 0, avgRemainingB: 0, confidence: 'none'
            };
        }

        var winsA = 0, winsB = 0, ties = 0;
        var sumRemainingA = 0, sumRemainingB = 0;
        var approximatedCount = 0;
        var totalWeight = 0;

        for (var i = 0; i < leaves.length; i++) {
            var leaf = leaves[i];
            var w = leaf.weight !== undefined ? leaf.weight : 1.0;
            totalWeight += w;

            if (leaf.outcome === 'A_wins') winsA += w;
            else if (leaf.outcome === 'B_wins') winsB += w;
            else ties += w;

            if (leaf.state && leaf.state.teams) {
                sumRemainingA += w * countAlive(leaf.state.teams[0]);
                sumRemainingB += w * countAlive(leaf.state.teams[1]);
            }

            if (leaf.approximated) approximatedCount++;
        }

        var confidence = 'high';
        if (approximatedCount / totalBranches > 0.5) confidence = 'low';
        else if (approximatedCount / totalBranches > 0.1) confidence = 'medium';

        return {
            totalBranches: totalBranches,
            winRateA: totalWeight > 0 ? winsA / totalWeight : 0,
            winRateB: totalWeight > 0 ? winsB / totalWeight : 0,
            tieRate: totalWeight > 0 ? ties / totalWeight : 0,
            avgRemainingA: totalWeight > 0 ? sumRemainingA / totalWeight : 0,
            avgRemainingB: totalWeight > 0 ? sumRemainingB / totalWeight : 0,
            confidence: confidence,
            approximatedCount: approximatedCount
        };
    };

    function countAlive(teamSnap) {
        var n = 0;
        for (var i = 0; i < teamSnap.pokemon.length; i++) {
            if (teamSnap.pokemon[i].hp > 0) n++;
        }
        return n;
    }

    /**
     * Break down outcomes by lead-pair (root-level decision).
     *
     * Assumes the root node is a "lead" decision whose children are lead-pair
     * branches keyed by edge.payload = {leadA, leadB}.
     *
     * @returns Array of {leadA, leadB, winRateA, winRateB, tieRate, branchCount, keyDecision}
     */
    ns.computeLeadAnalysis = function(rootNode) {
        if (!rootNode || rootNode.type !== 'decision' ||
            !rootNode.decisionContext || rootNode.decisionContext.kind !== 'lead') {
            return [];
        }

        var results = [];
        for (var i = 0; i < rootNode.children.length; i++) {
            var leadChild = rootNode.children[i];
            var leaves = PvPIV.teamsim.collectLeaves(leadChild);
            var summary = ns.computeSummary(leaves);

            var leadInfo = (leadChild.edge && leadChild.edge.payload) || {};
            var keyDecision = findHighestVarianceDecision(leadChild);

            results.push({
                leadA: leadInfo.leadA,
                leadB: leadInfo.leadB,
                leadAName: leadInfo.leadAName,
                leadBName: leadInfo.leadBName,
                winRateA: summary.winRateA,
                winRateB: summary.winRateB,
                tieRate: summary.tieRate,
                branchCount: summary.totalBranches,
                avgRemainingA: summary.avgRemainingA,
                avgRemainingB: summary.avgRemainingB,
                keyDecision: keyDecision
            });
        }
        return results;
    };

    /**
     * Within a subtree, find the decision node with the highest variance of
     * win-rate-for-A across its children. Returns a human-readable summary or
     * null if no impactful decision found.
     */
    function findHighestVarianceDecision(subtreeRoot) {
        var decisions = PvPIV.teamsim.collectDecisions(subtreeRoot);
        var best = null;
        var bestVariance = 0;

        for (var i = 0; i < decisions.length; i++) {
            var d = decisions[i];
            if (d.children.length < 2) continue;

            // Compute winRateA for each child
            var rates = [];
            for (var j = 0; j < d.children.length; j++) {
                var leaves = PvPIV.teamsim.collectLeaves(d.children[j]);
                var s = ns.computeSummary(leaves);
                rates.push(s.winRateA);
            }
            var variance = computeVariance(rates);
            if (variance > bestVariance) {
                bestVariance = variance;
                best = {
                    kind: d.decisionContext.kind,
                    actor: d.decisionContext.actor,
                    variance: variance,
                    rates: rates,
                    description: describeDecision(d, rates)
                };
            }
        }

        return best;
    }

    function computeVariance(values) {
        if (values.length === 0) return 0;
        var mean = 0;
        for (var i = 0; i < values.length; i++) mean += values[i];
        mean /= values.length;
        var sumSq = 0;
        for (var i = 0; i < values.length; i++) {
            var d = values[i] - mean;
            sumSq += d * d;
        }
        return sumSq / values.length;
    }

    /**
     * Cluster winning leaves by their decision-sequence prefix. Two winning
     * branches sharing the same critical-prefix decisions get clustered as
     * the same win condition.
     *
     * Uses a simple heuristic: cluster by (lead-pair, sequence of shield/swap
     * decisions up to first divergence among winners). Surfaces top N clusters.
     *
     * @param {object} rootNode
     * @param {string} winnerSide - 'A' or 'B' (whose wins to cluster)
     */
    ns.computeWinConditions = function(rootNode, winnerSide) {
        winnerSide = winnerSide || 'A';
        var winOutcome = winnerSide === 'A' ? 'A_wins' : 'B_wins';
        var allLeaves = PvPIV.teamsim.collectLeaves(rootNode);
        var winners = allLeaves.filter(function(l) { return l.outcome === winOutcome; });
        if (winners.length === 0) return [];

        // Build a prefix → leaves[] map. Use first 6 decision actions as the
        // clustering key (longer prefixes split too much; shorter not enough).
        var maxPrefix = 6;
        var clusters = {};

        for (var i = 0; i < winners.length; i++) {
            var path = PvPIV.teamsim.pathFromRoot(winners[i]);
            var keyParts = [];
            for (var j = 0; j < Math.min(maxPrefix, path.length); j++) {
                var entry = path[j];
                keyParts.push(
                    (entry.kind || 'k') + ':' +
                    (entry.action && entry.action.label ? entry.action.label : '?')
                );
            }
            var key = keyParts.join('|');
            if (!clusters[key]) clusters[key] = { count: 0, paths: [], pathSample: path };
            clusters[key].count += (winners[i].weight !== undefined ? winners[i].weight : 1);
            clusters[key].paths.push(path);
        }

        // Sort by occurrence desc, take top N
        var clusterArr = [];
        for (var k in clusters) {
            if (Object.prototype.hasOwnProperty.call(clusters, k)) {
                clusterArr.push({ key: k, info: clusters[k] });
            }
        }
        clusterArr.sort(function(a, b) { return b.info.count - a.info.count; });

        var maxClusters = (PvPIV.teamsim.config && PvPIV.teamsim.config.MAX_WIN_CLUSTERS) || 8;
        var top = clusterArr.slice(0, maxClusters);

        var totalWins = winners.length;
        return top.map(function(c) {
            return {
                description: describePath(c.info.pathSample),
                preconditions: extractPreconditions(c.info.pathSample),
                occurrences: c.info.count,
                shareOfWins: c.info.count / totalWins
            };
        });
    };

    /**
     * Walk the tree and surface decision nodes where the win-rate variance
     * across children exceeds a threshold. These are the moments where the
     * choice decisively swings the outcome.
     */
    ns.computeCriticalDecisions = function(rootNode) {
        var threshold = (PvPIV.teamsim.config && PvPIV.teamsim.config.CRITICAL_DECISION_VARIANCE) || 0.2;
        var maxResults = (PvPIV.teamsim.config && PvPIV.teamsim.config.MAX_CRITICAL_DECISIONS) || 5;

        var decisions = PvPIV.teamsim.collectDecisions(rootNode);
        var scored = [];

        for (var i = 0; i < decisions.length; i++) {
            var d = decisions[i];
            if (d.children.length < 2) continue;

            var rates = [];
            for (var j = 0; j < d.children.length; j++) {
                var leaves = PvPIV.teamsim.collectLeaves(d.children[j]);
                rates.push(ns.computeSummary(leaves).winRateA);
            }
            var variance = computeVariance(rates);
            if (variance < threshold) continue;

            // Pick the option that maximizes win rate for the actor making the call
            var bestIdx = 0;
            var bestRate = (d.decisionContext.actor === 0) ? rates[0] : (1 - rates[0]);
            for (var j = 1; j < rates.length; j++) {
                var actorRate = (d.decisionContext.actor === 0) ? rates[j] : (1 - rates[j]);
                if (actorRate > bestRate) {
                    bestRate = actorRate;
                    bestIdx = j;
                }
            }

            scored.push({
                turn: (d.state && d.state.turn) || 0,
                kind: d.decisionContext.kind,
                actor: d.decisionContext.actor,
                context: describeContext(d),
                options: d.decisionContext.options,
                rates: rates,
                bestOption: d.decisionContext.options[bestIdx],
                variance: variance,
                reasoning: describeReasoning(d, rates, bestIdx)
            });
        }

        scored.sort(function(a, b) { return b.variance - a.variance; });
        return scored.slice(0, maxResults);
    };

    // ---- Description helpers ----

    /**
     * Format a single decision edge into a human-readable phrase. Uses the
     * enriched payloads orchestrator.js attaches to each edge (pokemon names,
     * move names, turns).
     */
    function formatEdge(kind, action) {
        if (!action) return '?';
        var p = action.payload || {};

        if (kind === 'lead') {
            return 'Lead ' + (p.leadAName || 'A?') + ' vs ' + (p.leadBName || 'B?');
        }

        if (kind === 'shield') {
            var verb = (action.label === 'shield_y') ? 'shield' : "don't shield";
            var moveName = p.throwMoveName || 'charged move';
            var turn = p.throwTurn !== undefined ? p.throwTurn : null;
            var by = p.throwerName ? ' from ' + p.throwerName : '';
            var turnStr = turn !== null ? ' @ T' + turn : '';
            return verb + ' ' + moveName + by + turnStr;
        }

        if (kind === 'forced_swap') {
            var descs = p.swapDescriptions || [];
            if (descs.length === 0) return 'swap';
            return descs.map(function(d) {
                return 'bring in ' + d.incomingName + ' after ' + d.faintedName + ' faints';
            }).join(' & ');
        }

        if (kind === 'voluntary_swap') {
            return 'voluntary swap';
        }

        if (kind === 'throw_power') {
            return 'power tier ' + (p.tier || '?');
        }

        if (kind === 'skip_turn') {
            return 'skip turn';
        }

        // Fallback for unknown kinds
        return kind + (action.label ? ' (' + action.label + ')' : '');
    }

    function describeDecision(node, rates) {
        var kind = node.decisionContext.kind;
        var actor = node.decisionContext.actor;
        var actorLabel = actor === 0 ? 'A' : 'B';
        var minR = Math.min.apply(Math, rates);
        var maxR = Math.max.apply(Math, rates);
        var spread = maxR - minR;

        // Surface representative move/pokemon context for shield/swap kinds
        var ctxBits = '';
        if (kind === 'shield' && node.decisionContext.options[0]) {
            var sp = node.decisionContext.options[0].payload || {};
            if (sp.throwMoveName) {
                ctxBits = sp.throwMoveName +
                          (sp.throwTurn !== undefined ? ' @ T' + sp.throwTurn : '') + ' — ';
            }
        }
        if (kind === 'forced_swap' && node.decisionContext.options[0]) {
            var sd = (node.decisionContext.options[0].payload || {}).swapDescriptions;
            if (sd && sd[0]) {
                ctxBits = 'after ' + sd[0].faintedName + ' faints — ';
            }
        }

        // Extreme-variance wording when one option leads to 100% / the other to 0%
        if (spread >= 0.99 && (minR <= 0.01 || maxR >= 0.99)) {
            return ctxBits + 'one ' + kind + ' decision determines the outcome (player ' +
                   actorLabel + ': ' + (maxR * 100).toFixed(0) + '% win on best option, ' +
                   (minR * 100).toFixed(0) + '% on worst)';
        }

        return ctxBits + kind + ' (player ' + actorLabel + '): swings win rate from ' +
               (minR * 100).toFixed(0) + '% to ' + (maxR * 100).toFixed(0) + '%';
    }

    function describeContext(node) {
        var kind = node.decisionContext.kind;
        var actor = node.decisionContext.actor === 0 ? 'A' : 'B';
        var options = node.decisionContext.options || [];
        var firstP = (options[0] && options[0].payload) || {};

        switch (kind) {
            case 'lead':
                return 'lead-pair selection';
            case 'shield':
                var moveName = firstP.throwMoveName || 'charged move';
                var fromWho = firstP.throwerName ? ' from ' + firstP.throwerName : '';
                var turnStr = firstP.throwTurn !== undefined ? ' @ T' + firstP.throwTurn : '';
                return 'Player ' + actor + ' decides to shield ' + moveName + fromWho + turnStr;
            case 'forced_swap':
                var descs = firstP.swapDescriptions || [];
                if (descs.length > 0) {
                    return 'Player ' + actor + ' picking next pokemon after ' +
                           descs[0].faintedName + ' faints';
                }
                return 'Player ' + actor + ' picking next pokemon after KO';
            case 'voluntary_swap':
                return 'Player ' + actor + ' considering mid-battle swap';
            case 'throw_power':
                return 'Player ' + actor + ' picking charged-move power tier';
            case 'throw_or_hold':
                return 'Player ' + actor + ' deciding whether to throw charged move now';
            case 'skip_turn':
                return 'Player ' + actor + ' considering skip-turn timing';
            default:
                return kind;
        }
    }

    function describeReasoning(node, rates, bestIdx) {
        var bestRate = rates[bestIdx];
        var worstRate = rates[0];
        for (var i = 0; i < rates.length; i++) {
            if (node.decisionContext.actor === 0 ? rates[i] < worstRate : (1 - rates[i]) < (1 - worstRate)) {
                worstRate = rates[i];
            }
        }
        var bestOption = node.decisionContext.options[bestIdx];
        var bestLabel = formatEdge(node.decisionContext.kind, bestOption);
        return 'Best play: ' + bestLabel + ' (' + (bestRate * 100).toFixed(0) +
               '% Team A win) vs worst at ' + (worstRate * 100).toFixed(0) + '%';
    }

    function describePath(path) {
        var parts = [];
        for (var i = 0; i < path.length; i++) {
            parts.push(formatEdge(path[i].kind, path[i].action));
        }
        return parts.join(' → ');
    }

    function extractPreconditions(path) {
        var pre = [];
        for (var i = 0; i < path.length; i++) {
            var p = path[i];
            if (p.kind === 'shield' || p.kind === 'voluntary_swap' || p.kind === 'forced_swap') {
                pre.push(formatEdge(p.kind, p.action));
            }
        }
        return pre;
    }

})(PvPIV.teamsim);
