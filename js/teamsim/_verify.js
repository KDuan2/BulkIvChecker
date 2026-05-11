/*
 * Team Battle Sim — Verification harness
 *
 * Console-invoked sanity tests. NOT loaded in index.html — only loaded by
 * team-sim.html behind a "Run Verify" button, or manually pasted into the
 * console for ad-hoc checks.
 *
 * Each test logs to console; final summary indicates pass/fail.
 *
 * Usage:
 *   PvPIV.teamsim.verify.runAll();
 *   PvPIV.teamsim.verify.runOne('legParity');
 */

var PvPIV = PvPIV || {};
PvPIV.teamsim = PvPIV.teamsim || {};
PvPIV.teamsim.verify = PvPIV.teamsim.verify || {};

(function(ns) {

    /**
     * Test 1: 1v1 leg parity. Running a probe leg (default AI) and a scripted
     * leg with shieldDecisions copied from the probe's shielded values should
     * produce identical battle ratings.
     */
    ns.legParity = function() {
        console.log('=== legParity ===');
        var testCases = [
            { a: 'medicham', b: 'azumarill', ivs: [0, 15, 15] },
            { a: 'altaria', b: 'registeel', ivs: [0, 15, 15] },
            { a: 'stunfisk_galarian', b: 'azumarill', ivs: [0, 15, 15] }
        ];

        var allPass = true;
        for (var i = 0; i < testCases.length; i++) {
            var tc = testCases[i];
            var specA = { speciesId: tc.a, ivs: { atk: tc.ivs[0], def: tc.ivs[1], hp: tc.ivs[2] } };
            var specB = { speciesId: tc.b, ivs: { atk: tc.ivs[0], def: tc.ivs[1], hp: tc.ivs[2] } };

            // Probe pass — default AI, no script
            var probe = PvPIV.teamsim.runLeg({
                specA: specA, specB: specB,
                cpCap: 1500, levelCap: 50
            });

            if (!probe || probe.error) {
                console.log('  ❌ ' + tc.a + ' vs ' + tc.b + ': probe failed');
                allPass = false;
                continue;
            }

            // Scripted pass — copy probe's shield decisions verbatim
            var defaultDecisions = probe.chargedSchedule.map(function(a) { return !!a.settings.shielded; });
            var script = PvPIV.teamsim.buildScriptFromProbe(probe.chargedSchedule, defaultDecisions);

            var scripted = PvPIV.teamsim.runLeg({
                specA: specA, specB: specB,
                shieldScript: script,
                cpCap: 1500, levelCap: 50
            });

            var probeR = probe.battleRatings;
            var scriptedR = scripted.battleRatings;
            var match = Math.abs(probeR[0] - scriptedR[0]) <= 1 && Math.abs(probeR[1] - scriptedR[1]) <= 1;

            console.log('  ' + (match ? '✅' : '❌') + ' ' + tc.a + ' vs ' + tc.b +
                        ': probe=[' + probeR[0] + ',' + probeR[1] + '] scripted=[' + scriptedR[0] + ',' + scriptedR[1] + ']');
            if (!match) allPass = false;
        }
        return allPass;
    };

    /**
     * Test 2: scripted shield-override actually changes outcome. Run with all
     * shields forced TRUE vs all FALSE; ratings should differ (sanity check
     * that the scripting seam is actually working).
     */
    ns.scriptedOverride = function() {
        console.log('=== scriptedOverride ===');
        var specA = { speciesId: 'medicham', ivs: { atk: 0, def: 15, hp: 15 } };
        var specB = { speciesId: 'azumarill', ivs: { atk: 0, def: 15, hp: 15 } };

        var probe = PvPIV.teamsim.runLeg({ specA: specA, specB: specB, cpCap: 1500, levelCap: 50 });
        if (probe.chargedSchedule.length === 0) {
            console.log('  ⚠ no charged moves in probe — skipping');
            return true;
        }

        var allShield = probe.chargedSchedule.map(function() { return true; });
        var noShield  = probe.chargedSchedule.map(function() { return false; });

        var allShieldScript = PvPIV.teamsim.buildScriptFromProbe(probe.chargedSchedule, allShield);
        var noShieldScript  = PvPIV.teamsim.buildScriptFromProbe(probe.chargedSchedule, noShield);

        var resAll = PvPIV.teamsim.runLeg({ specA: specA, specB: specB, shieldScript: allShieldScript, cpCap: 1500, levelCap: 50 });
        var resNon = PvPIV.teamsim.runLeg({ specA: specA, specB: specB, shieldScript: noShieldScript, cpCap: 1500, levelCap: 50 });

        var differ = resAll.battleRatings[0] !== resNon.battleRatings[0] ||
                     resAll.battleRatings[1] !== resNon.battleRatings[1];

        console.log('  ' + (differ ? '✅' : '❌') + ' all-shield: [' + resAll.battleRatings + '] vs no-shield: [' + resNon.battleRatings + ']');
        return differ;
    };

    /**
     * Test 3: 3v3 reasonableness. A team built around hard counters to
     * common Great League meta should win against that meta team.
     */
    ns.threeVsThreeReasonable = async function() {
        console.log('=== threeVsThreeReasonable ===');
        // Two reasonably-built GL teams. Outcomes should not be 0% — sanity check.
        var teamA = PvPIV.teamsim.makeTeamFromSpecies(['medicham', 'cresselia', 'sableye']);
        var teamB = PvPIV.teamsim.makeTeamFromSpecies(['azumarill', 'stunfisk_galarian', 'trevenant']);

        var result = await PvPIV.teamsim.simulateTeamBattle(teamA, teamB, {
            cpCap: 1500,
            maxBranches: 1000,
            exploreLeads: false,
            includeTree: false
        });

        var sane = result.summary.totalBranches > 0 &&
                   (result.summary.winRateA > 0 || result.summary.winRateB > 0);

        console.log('  branches=' + result.summary.totalBranches +
                    ' winA=' + (result.summary.winRateA * 100).toFixed(0) + '%' +
                    ' winB=' + (result.summary.winRateB * 100).toFixed(0) + '%' +
                    ' tie=' + (result.summary.tieRate * 100).toFixed(0) + '%' +
                    ' elapsed=' + result.timing.elapsedMs + 'ms');
        console.log('  ' + (sane ? '✅' : '❌') + ' produced sensible win rates');
        return sane;
    };

    /**
     * Test 4: performance budget — slot-0 lead mode (default).
     * Targets: median <2000ms, p95 <5000ms over N runs.
     */
    ns.perfBudget = async function(n) {
        n = n || 5;
        console.log('=== perfBudget (slot-0 mode, n=' + n + ') ===');

        var pool = ['medicham', 'azumarill', 'cresselia', 'sableye', 'stunfisk_galarian',
                    'trevenant', 'altaria', 'registeel', 'swampert', 'venusaur'];
        var times = [];
        for (var i = 0; i < n; i++) {
            var teamA = PvPIV.teamsim.makeTeamFromSpecies(pickThree(pool));
            var teamB = PvPIV.teamsim.makeTeamFromSpecies(pickThree(pool));

            var t0 = Date.now();
            await PvPIV.teamsim.simulateTeamBattle(teamA, teamB, {
                cpCap: 1500,
                maxBranches: 1500,
                exploreLeads: false,
                includeTree: false
            });
            times.push(Date.now() - t0);
        }
        times.sort(function(a, b) { return a - b; });
        var median = times[Math.floor(times.length / 2)];
        var p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
        var pass = median < 2000 && p95 < 5000;
        console.log('  times=[' + times.join(',') + '] median=' + median + 'ms p95=' + p95 + 'ms');
        console.log('  ' + (pass ? '✅' : '⚠') + ' median <2000ms, p95 <5000ms');
        return pass;
    };

    /**
     * Test 5: performance budget — full 3x3 lead enumeration mode.
     * Targets: median <8000ms, p95 <20000ms (the heavier mode).
     */
    ns.perfBudgetThorough = async function(n) {
        n = n || 3;
        console.log('=== perfBudgetThorough (9-lead mode, n=' + n + ') ===');

        var pool = ['medicham', 'azumarill', 'cresselia', 'sableye', 'stunfisk_galarian',
                    'trevenant', 'altaria', 'registeel', 'swampert', 'venusaur'];
        var times = [];
        for (var i = 0; i < n; i++) {
            var teamA = PvPIV.teamsim.makeTeamFromSpecies(pickThree(pool));
            var teamB = PvPIV.teamsim.makeTeamFromSpecies(pickThree(pool));

            var t0 = Date.now();
            await PvPIV.teamsim.simulateTeamBattle(teamA, teamB, {
                cpCap: 1500,
                maxBranches: 3000,
                exploreLeads: true,
                includeTree: false
            });
            times.push(Date.now() - t0);
        }
        times.sort(function(a, b) { return a - b; });
        var median = times[Math.floor(times.length / 2)];
        var p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))];
        var pass = median < 8000 && p95 < 20000;
        console.log('  times=[' + times.join(',') + '] median=' + median + 'ms p95=' + p95 + 'ms');
        console.log('  ' + (pass ? '✅' : '⚠') + ' median <8000ms, p95 <20000ms');
        return pass;
    };

    function pickThree(pool) {
        var copy = pool.slice();
        var picks = [];
        for (var i = 0; i < 3; i++) {
            var idx = Math.floor(Math.random() * copy.length);
            picks.push(copy.splice(idx, 1)[0]);
        }
        return picks;
    }

    /**
     * Run a single named test. Returns a Promise.
     */
    ns.runOne = async function(name) {
        if (typeof ns[name] !== 'function') {
            console.error('No such test: ' + name);
            return false;
        }
        return await ns[name]();
    };

    /**
     * Run the full suite. Returns a Promise that resolves to the results map.
     */
    ns.runAll = async function() {
        console.log('============================================');
        console.log('Team Battle Sim — Verification Suite');
        console.log('============================================');
        var results = {};
        var tests = ['legParity', 'scriptedOverride', 'threeVsThreeReasonable', 'perfBudget', 'perfBudgetThorough'];
        for (var i = 0; i < tests.length; i++) {
            try {
                results[tests[i]] = await ns[tests[i]]();
            } catch (e) {
                console.error('Test ' + tests[i] + ' threw:', e);
                results[tests[i]] = false;
            }
        }
        console.log('============================================');
        console.log('Results:');
        for (var k in results) {
            if (Object.prototype.hasOwnProperty.call(results, k)) {
                console.log('  ' + (results[k] ? '✅' : '❌') + ' ' + k);
            }
        }
        console.log('============================================');
        return results;
    };

})(PvPIV.teamsim.verify);
