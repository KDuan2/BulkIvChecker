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

    // Mega forms are separate species entries (e.g. "venusaur_mega", "charizard_mega_x").
    // Returns the mega gmEntries for a base species, in gamemaster order.
    ns.getMegaForms = function(baseId) {
        if (!baseId || baseId.indexOf('_mega') > -1) return [];
        var re = new RegExp('^' + baseId + '_mega(_[a-z]+)?$');
        return ns.getAllPokemon().filter(function(p) { return re.test(p.speciesId); });
    };

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

    // Get a cup definition by name (checks gamemaster, then archived cups)
    ns.getCup = function(cupName) {
        if (gmData && gmData.cups) {
            for (var i = 0; i < gmData.cups.length; i++) {
                if (gmData.cups[i].name === cupName) return gmData.cups[i];
            }
        }
        // Fallback to archived cups
        if (typeof ARCHIVED_CUPS !== 'undefined' && ARCHIVED_CUPS[cupName]) {
            return ARCHIVED_CUPS[cupName];
        }
        return null;
    };

    // Get all cup definitions
    ns.getAllCups = function() {
        return gmData && gmData.cups ? gmData.cups : [];
    };

    // Check if a Pokemon matches a single filter
    function matchesFilter(poke, filter) {
        var values = filter.values || [];
        switch (filter.filterType) {
            case 'type':
                for (var i = 0; i < values.length; i++) {
                    if (poke.types && (poke.types[0] === values[i] || poke.types[1] === values[i])) return true;
                }
                return false;

            case 'id':
                var baseId = poke.speciesId.replace('_shadow', '').replace('_xs', '');
                for (var i = 0; i < values.length; i++) {
                    if (baseId === values[i] || poke.speciesId === values[i]) return true;
                }
                return false;

            case 'tag':
                if (!poke.tags) return false;
                for (var i = 0; i < values.length; i++) {
                    if (poke.tags.indexOf(values[i]) > -1) return true;
                }
                return false;

            case 'dex':
                if (values.length >= 2 && poke.dex >= values[0] && poke.dex <= values[1]) return true;
                return false;

            case 'move':
                var allMoves = (poke.fastMoves || []).concat(poke.chargedMoves || []);
                for (var i = 0; i < values.length; i++) {
                    if (allMoves.indexOf(values[i]) > -1) return true;
                }
                return false;

            case 'moveType':
                var allMoveIds = (poke.fastMoves || []).concat(poke.chargedMoves || []);
                for (var mi = 0; mi < allMoveIds.length; mi++) {
                    var move = moveMap[allMoveIds[mi]];
                    if (move) {
                        for (var vi = 0; vi < values.length; vi++) {
                            if (move.type === values[vi]) return true;
                        }
                    }
                }
                return false;

            case 'cost':
                for (var i = 0; i < values.length; i++) {
                    if (poke.thirdMoveCost === values[i]) return true;
                }
                return false;

            case 'distance':
                for (var i = 0; i < values.length; i++) {
                    if (poke.buddyDistance === values[i]) return true;
                }
                return false;

            case 'evolution':
                // Check evolution stage based on family data
                var stage = 1;
                if (poke.family && poke.family.parent) stage = 2;
                if (poke.family && poke.family.parent) {
                    var parent = pokemonMap[poke.family.parent];
                    if (parent && parent.family && parent.family.parent) stage = 3;
                }
                for (var i = 0; i < values.length; i++) {
                    if (stage === values[i]) return true;
                }
                return false;
        }
        return false;
    }

    // Generate a threat list from a cup definition, limited to top threats by ranking score
    var MAX_GENERATED_THREATS = 55;

    ns.generateThreatsFromCup = function(cupName, cpCap) {
        var cup = ns.getCup(cupName);
        if (!cup) return [];

        var includes = cup.include || [];
        var excludes = cup.exclude || [];
        var results = [];
        var seen = {};

        // Load ranking scores for sorting
        var scores = (typeof RANKING_SCORES !== 'undefined' && RANKING_SCORES[cpCap]) ? RANKING_SCORES[cpCap] : {};

        for (var pi = 0; pi < gmData.pokemon.length; pi++) {
            var poke = gmData.pokemon[pi];

            // Skip unreleased, mega, and shadow entries (we'll add shadows separately)
            if (!poke.released) continue;
            if (poke.speciesId.indexOf('_mega') > -1) continue;
            if (poke.speciesId.indexOf('_shadow') > -1) continue;

            // Check include filters — must match ALL
            var included = true;
            var idIncluded = false;
            if (includes.length > 0) {
                for (var fi = 0; fi < includes.length; fi++) {
                    if (includes[fi].filterType === 'id' && matchesFilter(poke, includes[fi])) {
                        idIncluded = true;
                    }
                    if (!matchesFilter(poke, includes[fi])) {
                        included = false;
                        break;
                    }
                }
            }

            // If not included by regular filters, check if ID-included
            if (!included && !idIncluded) continue;

            // Check exclude filters — rejected if matches ANY (unless ID-included)
            if (!idIncluded) {
                var excluded = false;
                for (var fi = 0; fi < excludes.length; fi++) {
                    if (matchesFilter(poke, excludes[fi])) {
                        excluded = true;
                        break;
                    }
                }
                if (excluded) continue;
            }

            // Check CP eligibility — skip if Pokemon can't reach a meaningful CP
            var defaultIVs = poke.defaultIVs ? poke.defaultIVs['cp' + cpCap] : null;
            if (!defaultIVs && cpCap < 10000) continue;

            // Look up ranking moveset
            var rankingMoves = (typeof RANKING_MOVESETS !== 'undefined' && RANKING_MOVESETS[cpCap])
                ? RANKING_MOVESETS[cpCap][poke.speciesId] : null;

            var fastMove = rankingMoves ? rankingMoves[0] : (poke.fastMoves && poke.fastMoves[0]) || '';
            var chargedMoves = rankingMoves ? rankingMoves.slice(1) : (poke.chargedMoves || []).slice(0, 2);

            if (!seen[poke.speciesId]) {
                results.push({
                    speciesId: poke.speciesId,
                    fastMove: fastMove,
                    chargedMoves: chargedMoves,
                    shadowType: 'normal',
                    _score: scores[poke.speciesId] || 0,
                });
                seen[poke.speciesId] = true;
            }

            // Add shadow variant if eligible
            if (poke.tags && (poke.tags.indexOf('shadoweligible') > -1 || poke.tags.indexOf('shadow') > -1)) {
                var shadowId = poke.speciesId + '_shadow';
                var shadowPoke = pokemonMap[shadowId];
                if (shadowPoke) {
                    // Check shadow against exclude filters too
                    var shadowExcluded = false;
                    if (!idIncluded) {
                        for (var fi = 0; fi < excludes.length; fi++) {
                            if (matchesFilter(shadowPoke, excludes[fi])) {
                                shadowExcluded = true;
                                break;
                            }
                        }
                    }
                    if (!shadowExcluded && !seen[shadowId]) {
                        var shadowRanking = (typeof RANKING_MOVESETS !== 'undefined' && RANKING_MOVESETS[cpCap])
                            ? RANKING_MOVESETS[cpCap][shadowId] : null;
                        results.push({ _score: scores[shadowId] || 0,
                            speciesId: shadowId,
                            fastMove: shadowRanking ? shadowRanking[0] : fastMove,
                            chargedMoves: shadowRanking ? shadowRanking.slice(1) : chargedMoves,
                            shadowType: 'shadow',
                        });
                        seen[shadowId] = true;
                    }
                }
            }
        }

        // Sort by ranking score descending, take top N
        results.sort(function(a, b) { return b._score - a._score; });
        if (results.length > MAX_GENERATED_THREATS) {
            results = results.slice(0, MAX_GENERATED_THREATS);
        }

        // Clean up temp score property and sort alphabetically
        for (var ri = 0; ri < results.length; ri++) { delete results[ri]._score; }
        results.sort(function(a, b) {
            return (a.speciesId > b.speciesId) ? 1 : ((b.speciesId > a.speciesId) ? -1 : 0);
        });

        return results;
    };

})(PvPIV);
