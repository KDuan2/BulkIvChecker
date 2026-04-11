/*
 * PvP IV Comparison Tool — Type Effectiveness
 * Battle logic derived from PvPoke (https://github.com/pvpoke/pvpoke), MIT License
 */

var PvPIV = PvPIV || {};

(function(ns) {

    ns.TypeMultiplier = {
        SUPER_EFFECTIVE: 1.60000002384185791015625,
        RESISTED: 0.625,
        DOUBLE_RESISTED: 0.390625,
    };

    var TYPE_TRAITS = {
        normal:   { weaknesses: ["fighting"], resistances: [], immunities: ["ghost"] },
        fighting: { weaknesses: ["flying", "psychic", "fairy"], resistances: ["rock", "bug", "dark"], immunities: [] },
        flying:   { weaknesses: ["rock", "electric", "ice"], resistances: ["fighting", "bug", "grass"], immunities: ["ground"] },
        poison:   { weaknesses: ["ground", "psychic"], resistances: ["fighting", "poison", "bug", "fairy", "grass"], immunities: [] },
        ground:   { weaknesses: ["water", "grass", "ice"], resistances: ["poison", "rock"], immunities: ["electric"] },
        rock:     { weaknesses: ["fighting", "ground", "steel", "water", "grass"], resistances: ["normal", "flying", "poison", "fire"], immunities: [] },
        bug:      { weaknesses: ["flying", "rock", "fire"], resistances: ["fighting", "ground", "grass"], immunities: [] },
        ghost:    { weaknesses: ["ghost", "dark"], resistances: ["poison", "bug"], immunities: ["normal", "fighting"] },
        steel:    { weaknesses: ["fighting", "ground", "fire"], resistances: ["normal", "flying", "rock", "bug", "steel", "grass", "psychic", "ice", "dragon", "fairy"], immunities: ["poison"] },
        fire:     { weaknesses: ["ground", "rock", "water"], resistances: ["bug", "steel", "fire", "grass", "ice", "fairy"], immunities: [] },
        water:    { weaknesses: ["grass", "electric"], resistances: ["steel", "fire", "water", "ice"], immunities: [] },
        grass:    { weaknesses: ["flying", "poison", "bug", "fire", "ice"], resistances: ["ground", "water", "grass", "electric"], immunities: [] },
        electric: { weaknesses: ["ground"], resistances: ["flying", "steel", "electric"], immunities: [] },
        psychic:  { weaknesses: ["bug", "ghost", "dark"], resistances: ["fighting", "psychic"], immunities: [] },
        ice:      { weaknesses: ["fighting", "fire", "steel", "rock"], resistances: ["ice"], immunities: [] },
        dragon:   { weaknesses: ["dragon", "ice", "fairy"], resistances: ["fire", "water", "grass", "electric"], immunities: [] },
        dark:     { weaknesses: ["fighting", "fairy", "bug"], resistances: ["ghost", "dark"], immunities: ["psychic"] },
        fairy:    { weaknesses: ["poison", "steel"], resistances: ["fighting", "bug", "dark"], immunities: ["dragon"] },
    };

    ns.getEffectiveness = function(moveType, defenderTypes) {
        var effectiveness = 1;
        var mt = moveType.toLowerCase();
        for (var i = 0; i < defenderTypes.length; i++) {
            var traits = TYPE_TRAITS[defenderTypes[i].toLowerCase()];
            if (!traits) continue;
            if (traits.weaknesses.indexOf(mt) > -1) {
                effectiveness *= ns.TypeMultiplier.SUPER_EFFECTIVE;
            } else if (traits.resistances.indexOf(mt) > -1) {
                effectiveness *= ns.TypeMultiplier.RESISTED;
            } else if (traits.immunities.indexOf(mt) > -1) {
                effectiveness *= ns.TypeMultiplier.DOUBLE_RESISTED;
            }
        }
        return effectiveness;
    };

    ns.buildTypeEffectivenessMap = function(defenderTypes) {
        var map = {};
        var types = Object.keys(TYPE_TRAITS);
        for (var i = 0; i < types.length; i++) {
            map[types[i]] = ns.getEffectiveness(types[i], defenderTypes);
        }
        return map;
    };

})(PvPIV);
