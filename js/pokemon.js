/*
 * PvP IV Comparison Tool — Pokemon Stats & IV Calculation
 * Battle logic derived from PvPoke (https://github.com/pvpoke/pvpoke), MIT License
 */

var PvPIV = PvPIV || {};

(function(ns) {

    // CPM table from PvPoke — indexed as CPMS[(level - 1) * 2]
    var CPMS = [
        0.0939999967813491, 0.135137430784308, 0.166397869586944, 0.192650914456886,
        0.215732470154762, 0.236572655026622, 0.255720049142837, 0.273530381100769,
        0.290249884128570, 0.306057381335773, 0.321087598800659, 0.335445032295077,
        0.349212676286697, 0.362457748778790, 0.375235587358474, 0.387592411085168,
        0.399567276239395, 0.411193549517250, 0.422500014305114, 0.432926413410414,
        0.443107545375824, 0.453059953871985, 0.462798386812210, 0.472336077786704,
        0.481684952974319, 0.490855810259008, 0.499858438968658, 0.508701756943992,
        0.517393946647644, 0.525942508771329, 0.534354329109191, 0.542635762230353,
        0.550792694091796, 0.558830599438087, 0.566754519939422, 0.574569148039264,
        0.582278907299041, 0.589887911977272, 0.597400009632110, 0.604823657502073,
        0.612157285213470, 0.619404110566050, 0.626567125320434, 0.633649181622743,
        0.640652954578399, 0.647580963301656, 0.654435634613037, 0.661219263506722,
        0.667934000492096, 0.674581899290818, 0.681164920330047, 0.687684905887771,
        0.694143652915954, 0.700542893277978, 0.706884205341339, 0.713169102333341,
        0.719399094581604, 0.725575616972598, 0.731700003147125, 0.734741011137376,
        0.737769484519958, 0.740785574597326, 0.743789434432983, 0.746781208702482,
        0.749761044979095, 0.752729105305821, 0.755685508251190, 0.758630366519684,
        0.761563837528228, 0.764486065255226, 0.767397165298461, 0.770297273971590,
        0.773186504840850, 0.776064945942412, 0.778932750225067, 0.781790064808426,
        0.784636974334716, 0.787473583646825, 0.790300011634826, 0.792803950958807,
        0.795300006866455, 0.797803921486970, 0.800300002098083, 0.802803892322847,
        0.805299997329711, 0.807803863460723, 0.810299992561340, 0.812803834895026,
        0.815299987792968, 0.817803806620319, 0.820299983024597, 0.822803778631297,
        0.825299978256225, 0.827803750922782, 0.830299973487854, 0.832803753381377,
        0.835300028324127, 0.837803755931569, 0.840300023555755, 0.842803729034748,
        0.845300018787384, 0.847803702398935, 0.850300014019012, 0.852803676019539,
        0.855300009250640, 0.857803649892077, 0.860300004482269, 0.862803624012168,
        0.865299999713897
    ];

    var SHADOW_ATK_MULT = 1.2;
    var SHADOW_DEF_MULT = 0.83333331;
    var STAB_MULT = 1.2000000476837158203125;
    var BONUS_MULT = 1.2999999523162841796875;

    ns.SHADOW_ATK_MULT = SHADOW_ATK_MULT;
    ns.SHADOW_DEF_MULT = SHADOW_DEF_MULT;

    ns.getCPM = function(level) {
        var index = (level - 1) * 2;
        if (index < 0 || index >= CPMS.length) return CPMS[CPMS.length - 1];
        return CPMS[index];
    };

    ns.calculateCP = function(baseAtk, baseDef, baseHP, atkIV, defIV, hpIV, cpm) {
        return Math.max(10, Math.floor(
            (baseAtk + atkIV) *
            Math.pow(baseDef + defIV, 0.5) *
            Math.pow(baseHP + hpIV, 0.5) *
            Math.pow(cpm, 2) / 10
        ));
    };

    ns.calculateStats = function(baseAtk, baseDef, baseHP, atkIV, defIV, hpIV, cpm) {
        return {
            atk: cpm * (baseAtk + atkIV),
            def: cpm * (baseDef + defIV),
            hp: Math.max(Math.floor(cpm * (baseHP + hpIV)), 10),
        };
    };

    ns.findOptimalLevel = function(baseStats, atkIV, defIV, hpIV, cpCap, levelCap) {
        levelCap = levelCap || 50;
        var bestLevel = 1, bestCPM = CPMS[0], bestCP = 10;

        for (var level = 1; level <= levelCap; level += 0.5) {
            var cpm = ns.getCPM(level);
            var cp = ns.calculateCP(baseStats.atk, baseStats.def, baseStats.hp, atkIV, defIV, hpIV, cpm);
            if (cp <= cpCap) {
                bestLevel = level;
                bestCPM = cpm;
                bestCP = cp;
            } else {
                break;
            }
        }

        var stats = ns.calculateStats(baseStats.atk, baseStats.def, baseStats.hp, atkIV, defIV, hpIV, bestCPM);
        return {
            level: bestLevel, cpm: bestCPM, cp: bestCP, stats: stats,
            statProduct: stats.atk * stats.def * stats.hp,
        };
    };

    ns.getIVRank = function(baseStats, atkIV, defIV, hpIV, cpCap, levelCap, ivFloor) {
        levelCap = levelCap || 50;
        ivFloor = ivFloor || 0;
        var target = ns.findOptimalLevel(baseStats, atkIV, defIV, hpIV, cpCap, levelCap);
        var rank = 1;

        for (var hp = 15; hp >= ivFloor; hp--) {
            for (var def = 15; def >= ivFloor; def--) {
                for (var atk = 15; atk >= ivFloor; atk--) {
                    var result = ns.findOptimalLevel(baseStats, atk, def, hp, cpCap, levelCap);
                    if (result.statProduct > target.statProduct) rank++;
                }
            }
        }
        return rank;
    };

    ns.createBattlePokemon = function(speciesId, atkIV, defIV, hpIV, cpCap, levelCap, shadowType) {
        levelCap = levelCap || 50;
        shadowType = shadowType || "normal";
        var data = ns.getPokemonById(speciesId);
        if (!data) {
            var baseId = speciesId.replace("_shadow", "");
            data = ns.getPokemonById(baseId);
            if (!data) throw new Error("Pokemon not found: " + speciesId);
            shadowType = "shadow";
        }

        var optimal = ns.findOptimalLevel(data.baseStats, atkIV, defIV, hpIV, cpCap, levelCap);
        var shadowAtkMult = shadowType === "shadow" ? SHADOW_ATK_MULT : 1;
        var shadowDefMult = shadowType === "shadow" ? SHADOW_DEF_MULT : 1;
        var typeEffectiveness = ns.buildTypeEffectivenessMap(data.types);

        var fastMovePool = (data.fastMoves || []).map(function(id) { return ns.getMoveById(id); }).filter(Boolean);
        var chargedMovePool = (data.chargedMoves || []).map(function(id) { return ns.getMoveById(id); }).filter(Boolean);

        return {
            speciesId: data.speciesId, speciesName: data.speciesName,
            baseStats: { atk: data.baseStats.atk, def: data.baseStats.def, hp: data.baseStats.hp },
            types: data.types.slice(), ivs: { atk: atkIV, def: defIV, hp: hpIV },
            level: optimal.level, cpm: optimal.cpm, cp: optimal.cp,
            stats: { atk: optimal.stats.atk, def: optimal.stats.def, hp: optimal.stats.hp },
            statProduct: optimal.statProduct,
            shadowType: shadowType, shadowAtkMult: shadowAtkMult, shadowDefMult: shadowDefMult,
            typeEffectiveness: typeEffectiveness,
            fastMovePool: fastMovePool, chargedMovePool: chargedMovePool,
            eliteMoves: data.eliteMoves || [], tags: data.tags || [],
            hp: optimal.stats.hp, energy: 0, shields: 0, cooldown: 0,
            statBuffs: [0, 0], fastMove: null, chargedMoves: [], activeChargedMoves: [],
            fastestChargedMove: null, bestChargedMove: null,
            baitShields: 1, hasActed: false, priority: 0,
            farmEnergy: false, optimizeMoveTiming: true, index: 0,
        };
    };

    ns.getEffectiveStat = function(poke, statIndex) {
        var settings = ns.getSettings();
        var buffDivisor = settings.buffDivisor || 4;
        var buff = poke.statBuffs[statIndex];
        var multiplier;
        if (buff > 0) { multiplier = (buffDivisor + buff) / buffDivisor; }
        else { multiplier = buffDivisor / (buffDivisor - buff); }

        if (poke.shadowType === "shadow") {
            if (statIndex === 0) multiplier *= poke.shadowAtkMult;
            else if (statIndex === 1) multiplier *= poke.shadowDefMult;
        }
        return statIndex === 0 ? poke.stats.atk * multiplier : poke.stats.def * multiplier;
    };

    ns.getStab = function(poke, move) {
        if (move.type === poke.types[0] || move.type === poke.types[1]) return STAB_MULT;
        return 1;
    };

    ns.initializeMove = function(poke, move, opponent) {
        move.stab = ns.getStab(poke, move);

        if (opponent) {
            move.damage = ns.calcMoveDamage(poke, opponent, move).damage;
        } else {
            move.damage = Math.floor(move.power * move.stab);
        }

        move.dps = move.damage / (move.cooldown / 500);

        if (move.energy > 0) {
            move.dpe = move.damage / move.energy;
            if (move.buffs) {
                var buffEffect = 0;
                var settings = ns.getSettings();
                if (move.buffTarget === "self" && move.buffs[0] > 0) {
                    buffEffect = move.buffs[0] * (80 / move.energy);
                } else if (move.buffTarget === "opponent" && move.buffs[1] < 0) {
                    buffEffect = Math.abs(move.buffs[1]) * (80 / move.energy);
                }
                if (buffEffect > 0) {
                    var mult = (settings.buffDivisor + buffEffect * (parseFloat(move.buffApplyChance) || 1)) / settings.buffDivisor;
                    move.dpe *= mult;
                }
            }
            move.selfBuffing = move.buffs && move.buffTarget === "self" && (move.buffs[0] > 0 || move.buffs[1] > 0);
            move.selfDebuffing = move.buffs && move.buffTarget === "self" && (move.buffs[0] < 0 || move.buffs[1] < 0);
            move.selfAttackDebuffing = move.buffs && move.buffTarget === "self" && move.buffs[0] < 0;
        } else {
            move.eps = move.energyGain / (move.cooldown / 500);
            move.deps = move.dps * move.eps;
        }

        if (move.buffs && move.buffApplyMeter === undefined) move.buffApplyMeter = 0;
    };

    ns.calcMoveDamage = function(attacker, defender, move, charge) {
        charge = charge || 1;
        var effectiveness = defender.typeEffectiveness[move.type] || 1;
        var stab = move.stab !== undefined ? move.stab : ns.getStab(attacker, move);
        var atkStat = ns.getEffectiveStat(attacker, 0);
        var defStat = ns.getEffectiveStat(defender, 1);
        var damage = Math.floor(move.power * stab * (atkStat / defStat) * effectiveness * charge * 0.5 * BONUS_MULT) + 1;
        return { damage: damage, effectiveness: effectiveness };
    };

    ns.autoSelectMoves = function(poke, opponent) {
        var fastScores = poke.fastMovePool.map(function(m) {
            var mc = Object.assign({}, m);
            ns.initializeMove(poke, mc, opponent);
            return { move: mc, score: mc.deps || mc.dps };
        });
        fastScores.sort(function(a, b) { return b.score - a.score; });
        if (fastScores.length > 0) poke.fastMove = Object.assign({}, fastScores[0].move);

        var chargedScores = poke.chargedMovePool.map(function(m) {
            var mc = Object.assign({}, m);
            ns.initializeMove(poke, mc, opponent);
            return { move: mc, score: mc.dpe || 0 };
        });
        chargedScores.sort(function(a, b) { return b.score - a.score; });
        poke.chargedMoves = [];
        for (var i = 0; i < Math.min(2, chargedScores.length); i++) {
            poke.chargedMoves.push(Object.assign({}, chargedScores[i].move));
        }
        setupActiveChargedMoves(poke);
    };

    ns.setMoves = function(poke, fastMoveId, chargedMove1Id, chargedMove2Id, opponent) {
        var fm = ns.getMoveById(fastMoveId);
        if (fm) { poke.fastMove = Object.assign({}, fm); ns.initializeMove(poke, poke.fastMove, opponent); }

        poke.chargedMoves = [];
        var ids = [chargedMove1Id, chargedMove2Id];
        for (var i = 0; i < ids.length; i++) {
            if (!ids[i] || ids[i] === "none") continue;
            var cm = ns.getMoveById(ids[i]);
            if (cm) {
                var mc = Object.assign({}, cm);
                ns.initializeMove(poke, mc, opponent);
                poke.chargedMoves.push(mc);
            }
        }
        setupActiveChargedMoves(poke);
    };

    function setupActiveChargedMoves(poke) {
        poke.activeChargedMoves = poke.chargedMoves.slice().filter(function(m) {
            return m.moveId !== "FRUSTRATION" && m.moveId !== "RETURN_PURIFIED";
        });
        poke.activeChargedMoves.sort(function(a, b) { return a.energy - b.energy; });
        poke.fastestChargedMove = poke.activeChargedMoves[0] || null;

        var best = poke.activeChargedMoves[0] || null;
        for (var i = 0; i < poke.activeChargedMoves.length; i++) {
            if (poke.activeChargedMoves[i].dpe > (best ? best.dpe : 0)) best = poke.activeChargedMoves[i];
        }
        poke.bestChargedMove = best;

        if (poke.activeChargedMoves.length > 1) {
            var a = poke.activeChargedMoves[0], b = poke.activeChargedMoves[1];
            if (b.energy === a.energy && !b.selfDebuffing) {
                if (b.buffs || b.damage > a.damage) {
                    poke.activeChargedMoves[0] = b;
                    poke.activeChargedMoves[1] = a;
                }
            }
        }
    }

    ns.resetBattleState = function(poke, shields) {
        poke.hp = poke.stats.hp;
        poke.energy = 0;
        poke.shields = shields || 0;
        poke.cooldown = 0;
        poke.statBuffs = [0, 0];
        poke.hasActed = false;
        poke.priority = 0;
    };

})(PvPIV);
