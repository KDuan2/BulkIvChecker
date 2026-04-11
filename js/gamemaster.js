/*
 * PvP IV Comparison Tool — Game Master Data Layer
 * Battle logic derived from PvPoke (https://github.com/pvpoke/pvpoke), MIT License
 */

var PvPIV = PvPIV || {};

(function(ns) {

    var gmData = null;
    var pokemonMap = {};
    var moveMap = {};

    function buildMaps() {
        pokemonMap = {};
        moveMap = {};
        for (var i = 0; i < gmData.pokemon.length; i++) {
            pokemonMap[gmData.pokemon[i].speciesId] = gmData.pokemon[i];
        }
        for (var i = 0; i < gmData.moves.length; i++) {
            moveMap[gmData.moves[i].moveId] = gmData.moves[i];
        }
    }

    ns.loadGameMaster = function() {
        return new Promise(function(resolve) {
            // Use the embedded GAMEMASTER_DATA global (loaded via <script> tag)
            if (typeof GAMEMASTER_DATA !== 'undefined') {
                gmData = GAMEMASTER_DATA;
                buildMaps();
                resolve(gmData);
                return;
            }

            // Fallback: try fetching (works when served over HTTP)
            fetch("gamemaster_cache.json").then(function(resp) {
                return resp.json();
            }).then(function(data) {
                gmData = data;
                buildMaps();
                resolve(gmData);
            }).catch(function(e) {
                console.error("Failed to load gamemaster data:", e);
                resolve(null);
            });
        });
    };

    ns.getGameMaster = function() { return gmData; };
    ns.getPokemonById = function(id) { return pokemonMap[id] || null; };
    ns.getMoveById = function(id) { return moveMap[id] || null; };
    ns.getAllPokemon = function() { return gmData ? gmData.pokemon : []; };
    ns.getSettings = function() { return gmData ? gmData.settings : { buffDivisor: 4, maxBuffStages: 4 }; };

    ns.loadMetaGroup = function(league) {
        // Use the embedded META_GROUPS global (loaded via <script> tag)
        if (typeof META_GROUPS !== 'undefined' && META_GROUPS[league]) {
            return Promise.resolve(META_GROUPS[league]);
        }

        // Fallback: try fetching
        return fetch("data/groups/" + league + ".json").then(function(resp) {
            if (resp.ok) return resp.json();
            return [];
        }).catch(function() { return []; });
    };

})(PvPIV);
