/*
 * Team Battle Sim — Decision tree data structure
 *
 * Generic polymorphic tree where each non-leaf node is a "decision" with a
 * set of possible actions, and each leaf carries an outcome. Action kinds
 * are kept as plain string identifiers so analysis.js can interpret them
 * without coupling the tree shape to specific mechanics.
 *
 * Decision kinds used by the orchestrator (extensible):
 *   "lead"             - root-level lead pick; options pick a (leadA, leadB) pair
 *   "shield"           - defender decides Y/N on an incoming charged move
 *   "forced_swap"      - player picks which bench pokemon to bring in after a KO
 *   "voluntary_swap"   - player decides to swap mid-leg or stay
 *   "swap_timing"      - on ≥2-alive forced swap, choose "press immediately" or "wait full 12s"
 *   "throw_power"      - attacker picks charged-move power tier (1.0 / 0.75 / 0.5)
 *   "throw_or_hold"    - attacker picks "throw charged move now" vs "hold and keep fast-attacking"
 *   "skip_turn"        - attacker picks "skip this turn" vs "fast move"
 *
 * Action shape (free-form within a kind):
 *   {label: "shield_y", actor: 0|1, payload: {...}}
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};

(function(ns) {

    /**
     * Construct a new tree node.
     *
     * @param {object} opts
     *   - type: "decision" | "leaf"
     *   - decisionContext: { kind, actor, options:[Action] } (if type=decision)
     *   - state: TeamState before this node's decision/leg
     *   - edge: Action that produced this node from its parent (null for root)
     *   - parent: parent node (null for root)
     *   - outcome / battleRatings / approximated: leaf fields
     */
    ns.makeNode = function(opts) {
        var node = {
            id: opts.id || '',
            type: opts.type,
            state: opts.state || null,
            edge: opts.edge || null,
            parent: opts.parent || null,
            children: [],
            weight: opts.weight !== undefined ? opts.weight : 1.0
        };

        if (opts.type === 'decision') {
            node.decisionContext = opts.decisionContext || { kind: 'unknown', actor: 0, options: [] };
        } else if (opts.type === 'leaf') {
            node.outcome = opts.outcome || null;
            node.battleRatings = opts.battleRatings || null;
            node.approximated = !!opts.approximated;
        }

        return node;
    };

    /**
     * Append a child to a parent node, setting parent / id linkage.
     */
    ns.addChild = function(parent, child) {
        child.parent = parent;
        if (!child.id) {
            child.id = parent.id ? (parent.id + '/' + (parent.children.length)) : ('' + parent.children.length);
        }
        parent.children.push(child);
        return child;
    };

    /**
     * Iterate all leaves of a tree (depth-first). Returns an array.
     */
    ns.collectLeaves = function(root) {
        var leaves = [];
        function walk(node) {
            if (node.type === 'leaf') {
                leaves.push(node);
                return;
            }
            for (var i = 0; i < node.children.length; i++) {
                walk(node.children[i]);
            }
        }
        walk(root);
        return leaves;
    };

    /**
     * Iterate all decision nodes (depth-first). Returns an array.
     */
    ns.collectDecisions = function(root) {
        var decisions = [];
        function walk(node) {
            if (node.type === 'decision') {
                decisions.push(node);
            }
            for (var i = 0; i < node.children.length; i++) {
                walk(node.children[i]);
            }
        }
        walk(root);
        return decisions;
    };

    /**
     * Compute the decision-path from root to a node (excluding root edge).
     * Skips placeholder/wrapper nodes (those without a real decisionContext) so
     * the path contains only meaningful decisions.
     *
     * Each entry: { kind, actor, action }.
     */
    ns.pathFromRoot = function(node) {
        var path = [];
        var cur = node;
        while (cur && cur.parent) {
            var parent = cur.parent;
            // Skip parents that aren't real decision nodes (placeholders inside
            // nested binary trees like the shield-decision recursion).
            var isRealDecision = parent.decisionContext &&
                                 parent.decisionContext.kind &&
                                 parent.decisionContext.kind !== 'unknown';
            if (isRealDecision) {
                path.unshift({
                    kind: parent.decisionContext.kind,
                    actor: parent.decisionContext.actor,
                    action: cur.edge
                });
            }
            cur = parent;
        }
        return path;
    };

    /**
     * Count total nodes in the tree.
     */
    ns.countNodes = function(root) {
        var n = 0;
        function walk(node) {
            n++;
            for (var i = 0; i < node.children.length; i++) walk(node.children[i]);
        }
        walk(root);
        return n;
    };

    /**
     * Depth of the tree (longest root-to-leaf path).
     */
    ns.depth = function(root) {
        if (!root) return 0;
        if (root.children.length === 0) return 1;
        var max = 0;
        for (var i = 0; i < root.children.length; i++) {
            var d = ns.depth(root.children[i]);
            if (d > max) max = d;
        }
        return max + 1;
    };

})(PvPIV.teamsim);
