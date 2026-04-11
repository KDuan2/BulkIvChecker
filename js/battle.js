/*
 * PvP IV Comparison Tool — Battle Bridge
 * Wraps PvPoke's Battle.js/Pokemon.js into the PvPIV namespace interface.
 * Battle logic from PvPoke (https://github.com/pvpoke/pvpoke), MIT License
 */

var PvPIV = PvPIV || {};

(function(ns) {

    /**
     * Create a PvPoke Battle instance configured for a given CP cap and level cap.
     */
    function createBattle(cpCap, levelCap) {
        var battle = new Battle();
        battle.setCP(cpCap);
        battle.setLevelCap(levelCap);
        // Buffs are deterministic in sim mode (buffChanceModifier = -1 is the default)
        return battle;
    }

    /**
     * Create a PvPoke Pokemon instance for battle.
     * @param {string} speciesId
     * @param {number} atkIV
     * @param {number} defIV
     * @param {number} hpIV
     * @param {number} cpCap
     * @param {number} levelCap
     * @param {string} shadowType - "normal", "shadow", or "purified"
     * @param {object} battle - Battle instance to bind to
     */
    function createPokemon(speciesId, atkIV, defIV, hpIV, cpCap, levelCap, shadowType, battle) {
        var poke = new Pokemon(speciesId, 0, battle);

        if (!poke || !poke.speciesId) return null;

        // Set IVs and mark as custom so initialize() uses them
        poke.ivs = { atk: atkIV, def: defIV, hp: hpIV };
        poke.isCustom = true;
        poke.autoLevel = true;
        poke.setLevel(levelCap, false);

        // Find optimal level under CP cap
        var bestLevel = 1;
        for (var level = 1; level <= levelCap; level += 0.5) {
            poke.setLevel(level, false);
            var testCP = poke.calculateCP();
            if (testCP <= cpCap) {
                bestLevel = level;
            } else {
                break;
            }
        }
        poke.setLevel(bestLevel, false);

        // Set stats
        poke.stats.atk = poke.cpm * (poke.baseStats.atk + atkIV);
        poke.stats.def = poke.cpm * (poke.baseStats.def + defIV);
        poke.stats.hp = Math.max(Math.floor(poke.cpm * (poke.baseStats.hp + hpIV)), 10);
        poke.hp = poke.stats.hp;
        poke.startHp = poke.hp;
        poke.cp = poke.calculateCP();

        // Set shadow type
        if (shadowType === "shadow") {
            poke.setShadowType("shadow");
        }

        return poke;
    }

    /**
     * Run a single battle simulation using PvPoke's engine.
     */
    ns.simulateBattle = function(speciesA, ivsA, speciesB, ivsB, shields1, shields2, cpCap, levelCap, shadowA, shadowB, movesA, movesB) {
        shields1 = shields1 !== undefined ? shields1 : 1;
        shields2 = shields2 !== undefined ? shields2 : 1;
        cpCap = cpCap || 1500;
        levelCap = levelCap || 50;
        shadowA = shadowA || "normal";
        shadowB = shadowB || "normal";

        var battle = createBattle(cpCap, levelCap);

        var pokeA = createPokemon(speciesA, ivsA[0], ivsA[1], ivsA[2], cpCap, levelCap, shadowA, battle);
        var pokeB = createPokemon(speciesB, ivsB[0], ivsB[1], ivsB[2], cpCap, levelCap, shadowB, battle);

        if (!pokeA || !pokeB) {
            return { battleRating: 500, winner: -1, ratings: [500, 500] };
        }

        // Set shields
        pokeA.shields = shields1;
        pokeA.startingShields = shields1;
        pokeB.shields = shields2;
        pokeB.startingShields = shields2;

        // Set moves if specified, otherwise auto-select
        if (movesA) {
            if (movesA[0]) pokeA.selectMove("fast", movesA[0]);
            if (movesA[1]) pokeA.selectMove("charged", movesA[1], 0);
            if (movesA[2]) pokeA.selectMove("charged", movesA[2], 1);
        } else {
            pokeA.autoSelectMoves(2);
        }

        if (movesB) {
            if (movesB[0]) pokeB.selectMove("fast", movesB[0]);
            if (movesB[1]) pokeB.selectMove("charged", movesB[1], 0);
            if (movesB[2]) pokeB.selectMove("charged", movesB[2], 1);
        } else {
            pokeB.autoSelectMoves(2);
        }

        // Set Pokemon into battle
        battle.setNewPokemon(pokeA, 0, false);
        battle.setNewPokemon(pokeB, 1, false);

        // Run simulation
        battle.simulate();

        var ratings = battle.getBattleRatings();
        var br1 = ratings[0];
        var br2 = ratings[1];
        var winner = -1;
        if (br1 > br2) winner = 0;
        else if (br2 > br1) winner = 1;

        return {
            battleRating: br1,
            winner: winner,
            ratings: [br1, br2],
            pokemon: [pokeA, pokeB],
        };
    };

    /**
     * Convenience wrapper matching the old interface used by app.js.
     * poke1/poke2 are our lightweight candidate/threat objects with speciesId, ivs, etc.
     */
    ns.simulateBattleFromObjects = function(poke1, poke2, shields1, shields2, cpCap, levelCap, moveOverride) {
        var movesA = null;
        if (moveOverride && moveOverride.fastMove) {
            movesA = [moveOverride.fastMove, moveOverride.chargedMove1, moveOverride.chargedMove2];
        }

        var movesB = null;
        if (poke2._preferredMoves && poke2._preferredMoves.fastMove) {
            movesB = [poke2._preferredMoves.fastMove, poke2._preferredMoves.chargedMove1, poke2._preferredMoves.chargedMove2];
        }

        return ns.simulateBattle(
            poke1.speciesId, [poke1.ivs.atk, poke1.ivs.def, poke1.ivs.hp],
            poke2.speciesId, [poke2.ivs.atk, poke2.ivs.def, poke2.ivs.hp],
            shields1, shields2, cpCap, levelCap,
            poke1.shadowType || "normal", poke2.shadowType || "normal",
            movesA, movesB
        );
    };

    /**
     * Debug battle with turn-by-turn console logging.
     */
    ns.debugBattle = function(speciesA, ivsA, speciesB, ivsB, shields, cpCap, movesA, movesB) {
        cpCap = cpCap || 1500;
        shields = shields !== undefined ? shields : 1;

        var result = ns.simulateBattle(speciesA, ivsA, speciesB, ivsB, shields, shields, cpCap, 50, "normal", "normal", movesA, movesB);
        var pokeA = result.pokemon[0];
        var pokeB = result.pokemon[1];

        console.log('========================================');
        console.log('DEBUG BATTLE: ' + pokeA.speciesName + ' vs ' + pokeB.speciesName + ' | ' + shields + 'v' + shields + ' shields | CP cap: ' + cpCap);
        console.log('========================================');

        var pokes = [pokeA, pokeB];
        for (var pi = 0; pi < 2; pi++) {
            var p = pokes[pi];
            console.log('--- ' + p.speciesName + ' ---');
            console.log('  CP: ' + p.cp + ' | Level: ' + p.level + ' | IVs: ' + p.ivs.atk + '/' + p.ivs.def + '/' + p.ivs.hp);
            console.log('  Stats: ATK=' + p.stats.atk.toFixed(4) + ' DEF=' + p.stats.def.toFixed(4) + ' HP=' + p.stats.hp);
            console.log('  Shadow: ' + p.shadowType + ' | AtkMult=' + p.shadowAtkMult + ' DefMult=' + p.shadowDefMult);
            console.log('  Fast: ' + p.fastMove.name + ' (pow=' + p.fastMove.power + ' eg=' + p.fastMove.energyGain + ' turns=' + (p.fastMove.cooldown / 500) + ')');
            for (var ci = 0; ci < p.chargedMoves.length; ci++) {
                var cm = p.chargedMoves[ci];
                console.log('  Charged' + (ci + 1) + ': ' + cm.name + ' (pow=' + cm.power + ' cost=' + cm.energy + (cm.buffs ? ' buffs=' + JSON.stringify(cm.buffs) + ' target=' + cm.buffTarget + ' chance=' + cm.buffApplyChance : '') + ')');
            }
        }

        console.log('----------------------------------------');
        console.log('RESULT: ' + (result.winner === 0 ? pokeA.speciesName : result.winner === 1 ? pokeB.speciesName : 'TIE'));
        console.log('  ' + pokeA.speciesName + ': HP=' + pokeA.hp + '/' + pokeA.stats.hp + ' Energy=' + pokeA.energy + ' BR=' + result.ratings[0]);
        console.log('  ' + pokeB.speciesName + ': HP=' + pokeB.hp + '/' + pokeB.stats.hp + ' Energy=' + pokeB.energy + ' BR=' + result.ratings[1]);
        console.log('========================================');

        return result;
    };

})(PvPIV);
