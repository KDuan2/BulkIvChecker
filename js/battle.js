/*
 * PvP IV Comparison Tool — Battle Simulation
 * Battle logic derived from PvPoke (https://github.com/pvpoke/pvpoke), MIT License
 */

var PvPIV = PvPIV || {};

(function(ns) {

    function cloneForBattle(poke) {
        return {
            speciesId: poke.speciesId, speciesName: poke.speciesName,
            baseStats: { atk: poke.baseStats.atk, def: poke.baseStats.def, hp: poke.baseStats.hp },
            types: poke.types.slice(), ivs: { atk: poke.ivs.atk, def: poke.ivs.def, hp: poke.ivs.hp },
            level: poke.level, cpm: poke.cpm, cp: poke.cp,
            stats: { atk: poke.stats.atk, def: poke.stats.def, hp: poke.stats.hp },
            statProduct: poke.statProduct,
            shadowType: poke.shadowType, shadowAtkMult: poke.shadowAtkMult, shadowDefMult: poke.shadowDefMult,
            typeEffectiveness: Object.assign({}, poke.typeEffectiveness),
            fastMovePool: poke.fastMovePool.map(function(m) { return Object.assign({}, m); }),
            chargedMovePool: poke.chargedMovePool.map(function(m) { return Object.assign({}, m); }),
            eliteMoves: poke.eliteMoves, tags: poke.tags,
            hp: poke.stats.hp, energy: 0, shields: 0, cooldown: 0,
            statBuffs: [0, 0], fastMove: null, chargedMoves: [], activeChargedMoves: [],
            fastestChargedMove: null, bestChargedMove: null,
            baitShields: poke.baitShields || 1, hasActed: false, priority: 0,
            farmEnergy: false, optimizeMoveTiming: true, index: 0,
            _preferredMoves: poke._preferredMoves ? Object.assign({}, poke._preferredMoves) : undefined,
        };
    }

    function getBattleRating(self, opponent) {
        return Math.floor(
            500 * ((opponent.stats.hp - opponent.hp) / opponent.stats.hp) +
            500 * (self.hp / self.stats.hp)
        );
    }

    ns.simulateBattle = function(poke1, poke2, shields1, shields2, moveOverride) {
        shields1 = shields1 !== undefined ? shields1 : 1;
        shields2 = shields2 !== undefined ? shields2 : 1;
        moveOverride = moveOverride || null;

        var p1 = cloneForBattle(poke1);
        var p2 = cloneForBattle(poke2);
        p1.index = 0;
        p2.index = 1;

        // Set moves for p1
        if (moveOverride && moveOverride.fastMove) {
            ns.setMoves(p1, moveOverride.fastMove, moveOverride.chargedMove1, moveOverride.chargedMove2, p2);
        } else {
            ns.autoSelectMoves(p1, p2);
        }

        // Set moves for p2
        if (p2._preferredMoves && p2._preferredMoves.fastMove) {
            ns.setMoves(p2, p2._preferredMoves.fastMove, p2._preferredMoves.chargedMove1, p2._preferredMoves.chargedMove2, p1);
        } else {
            ns.autoSelectMoves(p2, p1);
        }

        // Re-initialize with correct opponents
        if (p1.fastMove) ns.initializeMove(p1, p1.fastMove, p2);
        for (var i = 0; i < p1.chargedMoves.length; i++) ns.initializeMove(p1, p1.chargedMoves[i], p2);
        if (p2.fastMove) ns.initializeMove(p2, p2.fastMove, p1);
        for (var i = 0; i < p2.chargedMoves.length; i++) ns.initializeMove(p2, p2.chargedMoves[i], p1);

        ns.resetBattleState(p1, shields1);
        ns.resetBattleState(p2, shields2);

        if (!p1.fastMove || !p2.fastMove) {
            return { battleRating: 500, winner: -1, ratings: [500, 500] };
        }

        var turns = 0;
        while (p1.hp > 0 && p2.hp > 0 && turns < 480) {
            turns++;
            step(p1, p2, turns);
        }

        var br1 = getBattleRating(p1, p2);
        var br2 = getBattleRating(p2, p1);
        var winner = -1;
        if (br1 > br2) winner = 0;
        else if (br2 > br1) winner = 1;

        return { battleRating: br1, winner: winner, ratings: [br1, br2] };
    };

    ns.simulateAllShields = function(poke1, poke2, moveOverride) {
        return {
            "0v0": ns.simulateBattle(poke1, poke2, 0, 0, moveOverride),
            "1v1": ns.simulateBattle(poke1, poke2, 1, 1, moveOverride),
            "2v2": ns.simulateBattle(poke1, poke2, 2, 2, moveOverride),
        };
    };

    function step(p1, p2, turns) {
        p1.cooldown = Math.max(0, p1.cooldown - 500);
        p2.cooldown = Math.max(0, p2.cooldown - 500);
        p1.hasActed = false;
        p2.hasActed = false;

        var action1 = (p1.cooldown === 0) ? decideAction(p1, p2, turns) : null;
        var action2 = (p2.cooldown === 0) ? decideAction(p2, p1, turns) : null;

        if (action1 && action1.type === "charged" && action2 && action2.type === "charged") {
            if (p1.stats.atk >= p2.stats.atk) {
                processAction(action1, p1, p2);
                if (p2.hp > 0) processAction(action2, p2, p1);
            } else {
                processAction(action2, p2, p1);
                if (p1.hp > 0) processAction(action1, p1, p2);
            }
        } else if (action1 && action1.type === "charged") {
            processAction(action1, p1, p2);
            if (p2.hp > 0 && action2) processAction(action2, p2, p1);
        } else if (action2 && action2.type === "charged") {
            processAction(action2, p2, p1);
            if (p1.hp > 0 && action1) processAction(action1, p1, p2);
        } else {
            if (action1) processAction(action1, p1, p2);
            if (action2) processAction(action2, p2, p1);
        }
    }

    function processAction(action, poke, opponent) {
        if (action.type === "fast") {
            var dmg = ns.calcMoveDamage(poke, opponent, poke.fastMove).damage;
            opponent.hp = Math.max(0, opponent.hp - dmg);
            poke.energy = Math.min(100, poke.energy + poke.fastMove.energyGain);
            poke.cooldown = poke.fastMove.cooldown;
        } else if (action.type === "charged") {
            var move = poke.chargedMoves[action.value];
            if (poke.energy >= move.energy) {
                poke.energy -= move.energy;
                var dmg = ns.calcMoveDamage(poke, opponent, move).damage;

                if (opponent.shields > 0 && shouldShield(poke, opponent, move)) {
                    opponent.shields--;
                    opponent.hp = Math.max(0, opponent.hp - 1);
                } else {
                    opponent.hp = Math.max(0, opponent.hp - dmg);
                }
                applyBuffs(poke, opponent, move);
            }
        }
    }

    function decideAction(poke, opponent, turns) {
        if (!poke.activeChargedMoves || poke.activeChargedMoves.length === 0) {
            return { type: "fast", value: 0 };
        }
        if (!poke.fastestChargedMove || poke.energy < poke.fastestChargedMove.energy) {
            return { type: "fast", value: 0 };
        }

        var fastDamage = ns.calcMoveDamage(poke, opponent, poke.fastMove).damage;
        var oppFastDamage = ns.calcMoveDamage(opponent, poke, opponent.fastMove).damage;

        // Calculate turns to live
        var turnsToLive = Infinity;

        if (opponent.shields === 0) {
            for (var i = 0; i < opponent.activeChargedMoves.length; i++) {
                var oppMove = opponent.activeChargedMoves[i];
                if (opponent.energy >= oppMove.energy) {
                    var oppDmg = ns.calcMoveDamage(opponent, poke, oppMove).damage;
                    if (oppDmg >= poke.hp) {
                        var t = opponent.cooldown > 0 ? opponent.cooldown / 500 : 0;
                        turnsToLive = Math.min(turnsToLive, t);
                    }
                }
            }
        } else {
            if (opponent.energy >= (opponent.fastestChargedMove ? opponent.fastestChargedMove.energy : Infinity)) {
                var t = opponent.cooldown > 0 ? opponent.cooldown / 500 + 1 : 1;
                if (poke.hp <= 1) turnsToLive = Math.min(turnsToLive, t);
            }
        }

        if (poke.hp <= oppFastDamage) {
            var t = opponent.cooldown > 0 ? opponent.cooldown / 500 : opponent.fastMove.turns;
            turnsToLive = Math.min(turnsToLive, t);
        }

        // About to die — throw highest damage move
        if (turnsToLive !== Infinity && turnsToLive * 500 <= poke.fastMove.cooldown) {
            var bestIdx = -1, bestDmg = -1;
            for (var n = 0; n < poke.activeChargedMoves.length; n++) {
                if (poke.energy >= poke.activeChargedMoves[n].energy) {
                    var dmg = ns.calcMoveDamage(poke, opponent, poke.activeChargedMoves[n]).damage;
                    if (dmg > bestDmg) { bestDmg = dmg; bestIdx = poke.chargedMoves.indexOf(poke.activeChargedMoves[n]); }
                }
            }
            if (bestIdx >= 0) return { type: "charged", value: bestIdx };
        }

        // Throw lethal charged move if no shields
        if (opponent.shields === 0) {
            for (var n = 0; n < poke.activeChargedMoves.length; n++) {
                var move = poke.activeChargedMoves[n];
                if (poke.energy >= move.energy) {
                    var dmg = ns.calcMoveDamage(poke, opponent, move).damage;
                    if (dmg >= opponent.hp && !move.selfDebuffing && opponent.hp > fastDamage) {
                        return { type: "charged", value: poke.chargedMoves.indexOf(move) };
                    }
                }
            }
        }

        // Long fight evaluation
        var bestChargedDamage = ns.calcMoveDamage(poke, opponent, poke.bestChargedMove).damage;
        var bestCycleDamage = bestChargedDamage + (fastDamage * Math.ceil(poke.bestChargedMove.energy / poke.fastMove.energyGain));

        if (opponent.hp / bestCycleDamage > 2) {
            var selectedMove = poke.bestChargedMove;
            if (poke.activeChargedMoves.length > 1 && poke.baitShields && opponent.shields > 0) {
                if (!poke.activeChargedMoves[0].selfDebuffing) selectedMove = poke.activeChargedMoves[0];
            }
            if (poke.bestChargedMove.selfDebuffing) {
                for (var i = 0; i < poke.activeChargedMoves.length; i++) {
                    if (!poke.activeChargedMoves[i].selfDebuffing && (selectedMove.dpe / poke.activeChargedMoves[i].dpe < 2)) {
                        selectedMove = poke.activeChargedMoves[i];
                    }
                }
            }
            if (poke.energy < selectedMove.energy) return { type: "fast", value: 0 };
            return { type: "charged", value: poke.chargedMoves.indexOf(selectedMove) };
        }

        // Simplified DP move selection
        var bestMoveIdx = 0, bestScore = -Infinity;
        for (var n = 0; n < poke.activeChargedMoves.length; n++) {
            if (poke.energy >= poke.activeChargedMoves[n].energy) {
                var move = poke.activeChargedMoves[n];
                var dmg = ns.calcMoveDamage(poke, opponent, move).damage;
                var score = dmg;
                if (move.selfDebuffing) score *= 0.8;
                if (opponent.shields === 0 && dmg >= opponent.hp) score *= 2;
                if (opponent.shields > 0 && poke.baitShields && n === 0 && !move.selfDebuffing) score *= 1.5;
                if (score > bestScore) { bestScore = score; bestMoveIdx = poke.chargedMoves.indexOf(move); }
            }
        }

        if (bestScore > 0) return { type: "charged", value: bestMoveIdx };
        return { type: "fast", value: 0 };
    }

    function shouldShield(attacker, defender, move) {
        var dmg = ns.calcMoveDamage(attacker, defender, move).damage;
        var postMoveHP = defender.hp - dmg;
        var fastDmg = ns.calcMoveDamage(attacker, defender, attacker.fastMove).damage;

        var fastAttacks = Math.ceil((move.energy - Math.max(attacker.energy - move.energy, 0)) / attacker.fastMove.energyGain) + 1;
        var cycleDamage = (fastAttacks * fastDmg + 1) * defender.shields;

        if (postMoveHP <= cycleDamage) return true;
        if (dmg >= defender.hp) return true;
        if (postMoveHP > defender.stats.hp * 0.5) return false;
        if (dmg > defender.stats.hp * 0.25) return true;
        return false;
    }

    function applyBuffs(attacker, defender, move) {
        if (!move.buffs) return;
        var settings = ns.getSettings();
        var maxBuffStages = settings.maxBuffStages || 4;
        var chance = parseFloat(move.buffApplyChance) || 0;

        var apply = false;
        if (chance >= 1) { apply = true; }
        else if (chance > 0) {
            if (move.buffApplyMeter === undefined) move.buffApplyMeter = 0;
            var startCount = Math.floor(move.buffApplyMeter);
            move.buffApplyMeter += chance;
            if (startCount < Math.floor(move.buffApplyMeter)) apply = true;
        }
        if (!apply) return;

        var target = move.buffTarget === "self" ? attacker : defender;
        target.statBuffs[0] = Math.max(-maxBuffStages, Math.min(maxBuffStages, target.statBuffs[0] + move.buffs[0]));
        target.statBuffs[1] = Math.max(-maxBuffStages, Math.min(maxBuffStages, target.statBuffs[1] + move.buffs[1]));
    }

})(PvPIV);
