/*
 * GameMaster singleton shim for PvPoke battle code.
 * Wraps our GAMEMASTER_DATA global into the interface PvPoke's Pokemon.js and Battle.js expect.
 */

var GameMaster = (function() {
    var instance;

    function createInstance() {
        var object = {};
        object.data = GAMEMASTER_DATA;

        // Build lookup maps
        var pokemonMap = {};
        var moveMap = {};

        for (var i = 0; i < object.data.pokemon.length; i++) {
            pokemonMap[object.data.pokemon[i].speciesId] = object.data.pokemon[i];
        }
        for (var i = 0; i < object.data.moves.length; i++) {
            moveMap[object.data.moves[i].moveId] = object.data.moves[i];
        }

        object.getPokemonById = function(id) {
            return pokemonMap[id] || null;
        };

        object.getMoveById = function(id) {
            // Return a fresh copy so mutations don't corrupt the master data
            var move = moveMap[id];
            if (!move) return null;
            var copy = {};
            for (var key in move) {
                if (Array.isArray(move[key])) {
                    copy[key] = move[key].slice();
                } else {
                    copy[key] = move[key];
                }
            }

            // Derive buff classification properties (same as PvPoke's GameMaster.js lines 849-876)
            if (copy.buffs) {
                copy.buffApplyChance = parseFloat(copy.buffApplyChance);

                if (copy.buffTarget == "both") {
                    copy.buffsSelf = move.buffsSelf ? move.buffsSelf.slice() : [0, 0];
                    copy.buffsOpponent = move.buffsOpponent ? move.buffsOpponent.slice() : [0, 0];
                }

                if (copy.buffTarget == "self" && copy.buffApplyChance >= 0.5 && copy.moveId != "DRAGON_ASCENT" && (copy.buffs[0] < 0 || copy.buffs[1] < 0)) {
                    copy.selfDebuffing = true;
                    if (copy.buffs[0] < 0) copy.selfAttackDebuffing = true;
                    if (copy.buffs[1] < 0) copy.selfDefenseDebuffing = true;
                }

                if (copy.buffApplyChance == 1 && (copy.buffTarget == "opponent" || (copy.buffTarget == "self" && (copy.buffs[0] > 0 || copy.buffs[1] > 0)) || (copy.buffTarget == "both" && copy.buffsSelf && (copy.buffsSelf[0] > 0 || copy.buffsSelf[1] > 0)))) {
                    copy.selfBuffing = true;
                }
            }

            return copy;
        };

        object.getPokemonList = function() {
            return object.data.pokemon;
        };

        return object;
    }

    return {
        getInstance: function() {
            if (!instance) {
                instance = createInstance();
            }
            return instance;
        }
    };
})();

// InterfaceMaster stub — Battle.js calls this in init() but we never use emulate mode
var InterfaceMaster = {
    getInterface: function() { return null; },
    getInstance: function() { return null; }
};

// Global settings stub — Pokemon.js references this for hardMovesetLinks
var settings = {
    hardMovesetLinks: false,
    gamemaster: "gamemaster"
};

// Global stubs for host/webRoot/siteVersion (used in GameMaster.js original, not needed here)
var host = "";
var webRoot = "";
var siteVersion = "1";
