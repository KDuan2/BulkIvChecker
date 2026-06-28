#!/usr/bin/env node
'use strict';
/*
 * Headless battle-sim harness for BulkIvChecker.
 *
 * Loads the DOM-free battle layer (verbatim PvPoke engine + our bridge) the same
 * way index.html's <script> tags do, then runs PvPIV.simulateBattle() so a matchup
 * can be reproduced and traced outside the browser — to compare against PvPoke.
 *
 * Usage:
 *   node tools/sim.js --url "https://pvpoke.com/battle/1500/<pokeA>/<pokeB>/11/<movesA>/<movesB>/"
 *   node tools/sim.js --a "azumarill:0/15/15" --b "registeel:15/15/15" --shields 1v1 --cp 1500
 *
 * Options:
 *   --url <pvpoke battle url>     Reproduce a pvpoke.com/battle link 1:1 (easiest).
 *   --a / --b "<id>:<atk>/<def>/<sta>[:shadow]"   Explicit combatants.
 *   --shields <AvB>              e.g. 1v1, 0v0, 2v2, 0v2 (default 1v1).
 *   --cp <500|1500|2500|10000>   CP cap / league (default 1500).
 *   --movesA / --movesB "fast,cm1,cm2"   Pin moves (default: ranking/auto). 0/blank = none.
 *   --bestbuddy                  Use level cap 51 instead of 50.
 *
 * Note: like the app, this auto-levels each Pokemon to the highest level under the
 * CP cap; it does not pin an exact level. When a --url encodes a different level than
 * we resolve, both are printed so the mismatch is visible.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// Browser <script> load order from index.html, minus app.js (the only DOM-bound file).
const FILES = [
    'data/gamemaster-data.js',
    'data/meta-groups.js',
    'data/ranking-movesets.js',
    'data/archived-cups.js',
    'data/ranking-scores.js',
    'js/pvpoke/GameMasterShim.js',
    'js/pvpoke/DamageCalculator.js',
    'js/pvpoke/DecisionOption.js',
    'js/pvpoke/TimelineAction.js',
    'js/pvpoke/TimelineEvent.js',
    'js/pvpoke/Pokemon.js',
    'js/pvpoke/ActionLogic.js',
    'js/pvpoke/Battle.js',
    'js/types.js',
    'js/gamemaster.js',
    'js/pokemon.js',
    'js/battle.js',
];

// Concatenate into ONE script so cross-file `class` declarations share a lexical
// scope (browser <script> tags share the global lexical env; Node's per-eval calls
// do not). Run once in the global context so top-level `var`s reach globalThis.
function loadEngine() {
    let code = '';
    for (const f of FILES) {
        code += '\n;/* ===== ' + f + ' ===== */\n' + fs.readFileSync(path.join(ROOT, f), 'utf8') + '\n';
    }
    code += '\n;globalThis.PvPIV = PvPIV;\n';
    vm.runInThisContext(code, { filename: 'pvpiv-bundle.js' });
    if (!globalThis.PvPIV || typeof globalThis.PvPIV.simulateBattle !== 'function') {
        throw new Error('Engine failed to load: PvPIV.simulateBattle missing');
    }
    return globalThis.PvPIV;
}

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                out[key] = true; // boolean flag
            } else {
                out[key] = next;
                i++;
            }
        }
    }
    return out;
}

// Parse "fast,cm1,cm2" into [fast, cm1, cm2] with blank/0 -> null, or null if none given.
function parseMoves(str) {
    if (!str) return null;
    const parts = str.split(',').map(s => s.trim());
    const norm = parts.map(s => (!s || s === '0' || s.toLowerCase() === 'auto') ? null : s);
    return norm.some(Boolean) ? [norm[0] || null, norm[1] || null, norm[2] || null] : null;
}

// Parse "<id>:<atk>/<def>/<sta>[:shadow]" -> { id, ivs:[a,d,s], shadow }
function parseCombatant(str) {
    const segs = str.split(':');
    const id = segs[0].trim().toLowerCase().replace(/\s+/g, '_');
    let ivs = [0, 15, 15], shadow = 'normal';
    for (let i = 1; i < segs.length; i++) {
        const s = segs[i].trim();
        if (/^\d+\/\d+\/\d+$/.test(s)) {
            ivs = s.split('/').map(Number);
        } else if (s === 'shadow' || s === 'purified') {
            shadow = s;
        }
    }
    return { id, ivs, shadow, level: null };
}

// Parse a pvpoke pokeStr "id-level-atk-def-hp-4-4-1-0" (id may itself contain no '-';
// trailing fields are fixed, so slice from the end). Shadow encoded as "<id>_shadow".
function parsePokeStr(s) {
    const parts = s.split('-');
    // Last 8 fields: level, atk, def, hp, 4, 4, 1, 0
    const tail = parts.slice(parts.length - 8);
    const id = parts.slice(0, parts.length - 8).join('-');
    let speciesId = id, shadow = 'normal';
    if (speciesId.endsWith('_shadow')) { speciesId = speciesId.slice(0, -'_shadow'.length); shadow = 'shadow'; }
    return {
        id: speciesId,
        shadow: shadow,
        level: Number(tail[0]),
        ivs: [Number(tail[1]), Number(tail[2]), Number(tail[3])],
    };
}

// Parse a full pvpoke.com/battle URL into a matchup spec.
function parseUrl(url) {
    const m = url.match(/\/battle\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)/);
    if (!m) throw new Error('Could not parse PvPoke battle URL: ' + url);
    const cp = Number(m[1]);
    const a = parsePokeStr(m[2]);
    const b = parsePokeStr(m[3]);
    const shields = m[4];
    const movesA = m[5].split('-').map(x => x === '0' ? null : x);
    const movesB = m[6].split('-').map(x => x === '0' ? null : x);
    return {
        cp,
        a: Object.assign(a, { moves: movesA.some(Boolean) ? movesA : null }),
        b: Object.assign(b, { moves: movesB.some(Boolean) ? movesB : null }),
        shieldsA: Number(shields[0]),
        shieldsB: Number(shields[1]),
    };
}

function fmtMoves(p) {
    const cm = (p.chargedMoves || []).map(m => m.name).join(' / ');
    return p.fastMove.name + ' + ' + cm;
}

function printPoke(p, urlLevel) {
    console.log('--- ' + p.speciesName + (p.shadowType === 'shadow' ? ' (shadow)' : '') + ' ---');
    let lvl = '  Level: ' + p.level + ' | CP: ' + p.cp;
    if (urlLevel != null && urlLevel !== p.level) lvl += '  (URL pinned level ' + urlLevel + ' — DIFFERS from our auto-level)';
    console.log(lvl);
    console.log('  IVs: ' + p.ivs.atk + '/' + p.ivs.def + '/' + p.ivs.hp +
        ' | Stats: ATK=' + p.stats.atk.toFixed(2) + ' DEF=' + p.stats.def.toFixed(2) + ' HP=' + p.stats.hp);
    console.log('  Moves: ' + fmtMoves(p));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (Object.keys(args).length === 0) {
        console.log('See header of tools/sim.js for usage. Quick start:');
        console.log('  node tools/sim.js --url "<pvpoke battle url>"');
        process.exit(0);
    }

    const ns = loadEngine();
    if (typeof ns.loadGameMaster === 'function') {
        try { await ns.loadGameMaster(); } catch (e) { /* maps also built lazily by the shim */ }
    }

    let spec;
    if (args.url) {
        spec = parseUrl(args.url);
    } else {
        if (!args.a || !args.b) { console.error('Provide --url, or both --a and --b.'); process.exit(1); }
        const a = parseCombatant(args.a), b = parseCombatant(args.b);
        a.moves = parseMoves(args.movesA);
        b.moves = parseMoves(args.movesB);
        const shields = (args.shields || '1v1').replace('v', '');
        spec = { cp: Number(args.cp) || 1500, a, b, shieldsA: Number(shields[0]), shieldsB: Number(shields[1]) };
    }

    const levelCap = args.bestbuddy ? 51 : 50;

    // Validate species ids up front for a clean error.
    if (typeof ns.getPokemonById === 'function') {
        for (const c of [spec.a, spec.b]) {
            if (!ns.getPokemonById(c.id)) {
                console.error('Unknown species id: "' + c.id + '". Use PvPoke\'s exact id (e.g. azumarill, deoxys_defense).');
                process.exit(1);
            }
        }
    }

    const result = ns.simulateBattle(
        spec.a.id, spec.a.ivs, spec.b.id, spec.b.ivs,
        spec.shieldsA, spec.shieldsB, spec.cp, levelCap,
        spec.a.shadow, spec.b.shadow, spec.a.moves, spec.b.moves
    );

    if (!result.pokemon) { console.error('Simulation failed (species/level setup returned null).'); process.exit(1); }
    const [pa, pb] = result.pokemon;

    console.log('========================================');
    console.log(pa.speciesName + ' vs ' + pb.speciesName +
        ' | shields ' + spec.shieldsA + 'v' + spec.shieldsB + ' | CP ' + spec.cp + ' | levelCap ' + levelCap);
    console.log('========================================');
    printPoke(pa, spec.a.level);
    printPoke(pb, spec.b.level);

    if (result.battle && result.battle.getTimeline) {
        console.log('---------------- TIMELINE (turn | actor | event [dmg,energy]) ----------------');
        for (const ev of result.battle.getTimeline()) {
            const who = ev.actor === 0 ? pa.speciesName : ev.actor === 1 ? pb.speciesName : ('#' + ev.actor);
            const vals = (ev.values && ev.values.length) ? ' [' + ev.values.join(',') + ']' : '';
            console.log('  t' + ev.turn + ' | ' + who + ' | ' + ev.type + ': ' + ev.name + vals);
        }
    }

    console.log('---------------- RESULT ----------------');
    console.log('  Winner: ' + (result.winner === 0 ? pa.speciesName : result.winner === 1 ? pb.speciesName : 'TIE'));
    console.log('  ' + pa.speciesName + ': HP ' + pa.hp + '/' + pa.stats.hp + '  Energy ' + pa.energy + '  BattleRating ' + result.ratings[0]);
    console.log('  ' + pb.speciesName + ': HP ' + pb.hp + '/' + pb.stats.hp + '  Energy ' + pb.energy + '  BattleRating ' + result.ratings[1]);
    console.log('========================================');
}

main().catch(e => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
