/*
 * PvP IV Comparison Tool — Application Logic
 * Battle logic derived from PvPoke (https://github.com/pvpoke/pvpoke), MIT License
 */

(function() {
    var ns = PvPIV;

    // A flip whose resulting battle rating lands within this many points of the
    // 500 win/loss boundary is "fragile" (an IV knife-edge); beyond it, "robust".
    var FRAGILE_MARGIN = 25;

    // ============ STATE ============
    var state = {
        species: null,
        form: "normal",
        league: 1500,
        bestBuddy: false,
        moveOverride: null,
        candidates: [],
        threats: [],
        referenceIdx: 0,
        results: null,
        excludedThreats: {},
        activeScenarios: {
            '0v0': true, '0v1': true, '0v2': true,
            '1v0': true, '1v1': true, '1v2': true,
            '2v0': true, '2v1': true, '2v2': true,
        },
        nextCandidateId: 1,
        mode: 'compare',                       // 'compare' (matrix) | 'bulk' (one mon vs meta)
        bulkIVs: { atk: 15, def: 15, sta: 15 }, // IVs for the single mon in bulk mode
        bulkSort: 'overall',                   // 'overall' | '1v1' | 'name'
        bulkResults: null,
    };

    var STORAGE_KEY = "pvp_iv_tool_state";

    // The 9 shield scenarios (candidate-shields × opponent-shields).
    var SCENARIO_KEYS = ['0v0','0v1','0v2','1v0','1v1','1v2','2v0','2v1','2v2'];

    // ============ PERSISTENCE ============
    function saveState() {
        var excludedArr = [];
        for (var k in state.excludedThreats) { if (state.excludedThreats[k]) excludedArr.push(k); }
        var s = {
            species: state.species ? state.species.speciesId : null,
            form: state.form, league: state.league, bestBuddy: state.bestBuddy,
            moveOverride: state.moveOverride, candidates: state.candidates,
            threats: state.threats.map(function(t) {
                return { speciesId: t.speciesId, fastMove: t.fastMove, chargedMoves: t.chargedMoves,
                    shadowType: t.shadowType, priority: t.priority || false };
            }),
            referenceIdx: state.referenceIdx, excludedThreats: excludedArr,
            activeScenarios: SCENARIO_KEYS.filter(function(k) { return state.activeScenarios[k]; }),
            nextCandidateId: state.nextCandidateId,
            mode: state.mode, bulkIVs: state.bulkIVs, bulkSort: state.bulkSort,
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
    }

    function loadState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return false;
            var s = JSON.parse(raw);
            if (s.species) state.species = ns.getPokemonById(s.species);
            if (s.form) state.form = s.form;
            if (s.league) state.league = s.league;
            if (s.bestBuddy !== undefined) state.bestBuddy = s.bestBuddy;
            state.moveOverride = s.moveOverride || null;
            state.candidates = s.candidates || [];
            state.threats = (s.threats || []).map(function(t) {
                return Object.assign({}, t, { excluded: false, priority: t.priority || false });
            });
            state.referenceIdx = s.referenceIdx || 0;
            state.excludedThreats = {};
            (s.excludedThreats || []).forEach(function(id) { state.excludedThreats[id] = true; });
            var savedScen = (s.activeScenarios && s.activeScenarios.length) ? s.activeScenarios : SCENARIO_KEYS;
            state.activeScenarios = {};
            SCENARIO_KEYS.forEach(function(k) { state.activeScenarios[k] = savedScen.indexOf(k) > -1; });
            state.nextCandidateId = s.nextCandidateId || state.candidates.length + 1;
            if (s.mode === 'bulk' || s.mode === 'compare') state.mode = s.mode;
            if (s.bulkIVs) state.bulkIVs = s.bulkIVs;
            if (s.bulkSort) state.bulkSort = s.bulkSort;
            return true;
        } catch(e) { console.warn("Failed to load state:", e); return false; }
    }

    // ============ INIT ============
    function init() {
        ns.loadGameMaster().then(function() {
            var hadState = loadState();

            setupSpeciesSearch();
            setupThreatSearch();
            setupLeagueTabs();
            setupBestBuddy();
            setupFormSelect();
            setupMoveSelects();
            setupButtons();
            setupShieldFilter();
            setupModeTabs();
            setupBulk();
            renderShieldFilter();
            populateMetaSelect();

            if (hadState) {
                if (state.species) {
                    document.getElementById('speciesSearch').value = state.species.speciesName;
                    updateFormOptions(); // build mega/shadow options before restoring the saved form
                    populateMoveSelects();
                }
                document.getElementById('formSelect').value = state.form;
                var btns = document.querySelectorAll('.league-btn');
                for (var i = 0; i < btns.length; i++) {
                    btns[i].classList.toggle('active', Number(btns[i].dataset.league) === state.league);
                }
                if (state.bestBuddy) document.getElementById('bestBuddyToggle').classList.add('active');
                restoreMoveOverrideUI();
            }

            renderCandidates();
            renderThreats();
            if (state.candidates.length === 0) addCandidateRow();
            applyMode();
            // Convert vertical mouse wheel to horizontal scroll on the matrix
            var matrixScroll = document.getElementById('matrixScroll');
            matrixScroll.addEventListener('wheel', function(e) {
                if (matrixScroll.scrollWidth > matrixScroll.clientWidth) {
                    e.preventDefault();
                    matrixScroll.scrollLeft += e.deltaY;
                }
            }, { passive: false });

            document.getElementById('loadingOverlay').classList.add('hidden');
        });
    }

    // ============ SPECIES SEARCH ============
    function setupSpeciesSearch() {
        var input = document.getElementById('speciesSearch');
        var dropdown = document.getElementById('speciesDropdown');
        var selectedIdx = -1;

        input.addEventListener('input', function() {
            var q = input.value.toLowerCase().trim();
            if (q.length < 2) { dropdown.classList.remove('visible'); return; }
            var all = ns.getAllPokemon().filter(function(p) {
                return p.released &&
                    (p.speciesName.toLowerCase().indexOf(q) > -1 ||
                     p.speciesId.toLowerCase().indexOf(q) > -1 ||
                     (p.nicknames && p.nicknames.some(function(n) { return n.toLowerCase().indexOf(q) > -1; })));
            }).slice(0, 20);

            dropdown.innerHTML = all.map(function(p) {
                return '<div class="search-item" data-id="' + p.speciesId + '">' + p.speciesName + '</div>';
            }).join('');
            dropdown.classList.toggle('visible', all.length > 0);
            selectedIdx = -1;
        });

        input.addEventListener('keydown', function(e) {
            var items = dropdown.querySelectorAll('.search-item');
            if (e.key === 'ArrowDown') { selectedIdx = Math.min(selectedIdx + 1, items.length - 1); updateSelected(items); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { selectedIdx = Math.max(selectedIdx - 1, 0); updateSelected(items); e.preventDefault(); }
            else if (e.key === 'Enter' && selectedIdx >= 0 && items[selectedIdx]) { selectSpecies(items[selectedIdx].dataset.id); dropdown.classList.remove('visible'); }
            else if (e.key === 'Escape') { dropdown.classList.remove('visible'); }
        });

        dropdown.addEventListener('click', function(e) {
            var item = e.target.closest('.search-item');
            if (item) { selectSpecies(item.dataset.id); dropdown.classList.remove('visible'); }
        });

        document.addEventListener('click', function(e) {
            if (!e.target.closest('.species-search-wrapper')) dropdown.classList.remove('visible');
        });

        function updateSelected(items) {
            for (var i = 0; i < items.length; i++) items[i].classList.toggle('selected', i === selectedIdx);
            if (items[selectedIdx]) items[selectedIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    function selectSpecies(speciesId) {
        // If a mega entry was selected, strip to base and set form to the mega variant
        // token (e.g. "charizard_mega_x" -> base "charizard", form "mega_x").
        var megaIdx = speciesId.indexOf('_mega');
        if (megaIdx > -1) {
            var megaBaseId = speciesId.slice(0, megaIdx);
            var megaBaseData = ns.getPokemonById(megaBaseId);
            if (megaBaseData) {
                state.species = megaBaseData;
                state.form = speciesId.slice(megaBaseId.length + 1); // "mega" | "mega_x" | "mega_y"
            } else {
                state.species = ns.getPokemonById(speciesId);
                if (!state.species) return;
                state.form = 'normal';
            }
            document.getElementById('speciesSearch').value = state.species.speciesName;
            updateFormOptions();
            document.getElementById('formSelect').value = state.form;
            populateMoveSelects();
            updateAllCandidateComputedFields();
            saveState();
            return;
        }
        // If a shadow entry was selected, strip to base and set form to shadow
        if (speciesId.indexOf('_shadow') > -1) {
            var baseId = speciesId.replace('_shadow', '');
            var baseData = ns.getPokemonById(baseId);
            if (baseData) {
                state.species = baseData;
                state.form = 'shadow';
            } else {
                // No base entry found, use shadow entry directly
                state.species = ns.getPokemonById(speciesId);
                if (!state.species) return;
                state.form = 'shadow';
            }
        } else {
            var data = ns.getPokemonById(speciesId);
            if (!data) return;
            state.species = data;
            state.form = 'normal';
        }

        document.getElementById('speciesSearch').value = state.species.speciesName;
        document.getElementById('formSelect').value = state.form;
        updateFormOptions();
        populateMoveSelects();
        updateAllCandidateComputedFields();
        saveState();
    }

    // Human label for a form token: "mega" -> "Mega", "mega_x" -> "Mega X".
    function formLabel(form) {
        if (!form || form === 'normal') return 'Normal';
        if (form === 'shadow') return 'Shadow';
        if (form === 'purified') return 'Purified';
        if (form === 'mega') return 'Mega';
        if (form.indexOf('mega_') === 0) return 'Mega ' + form.slice(5).toUpperCase();
        return form;
    }

    // Mega form tokens available for a base species (e.g. ["mega"] or ["mega_x","mega_y"]).
    function megaFormsForSpecies(species) {
        if (!species) return [];
        return ns.getMegaForms(species.speciesId).map(function(m) {
            return m.speciesId.slice(species.speciesId.length + 1);
        });
    }

    function updateFormOptions() {
        var formSelect = document.getElementById('formSelect');

        // Rebuild dynamic mega options for the current species.
        Array.prototype.slice.call(formSelect.querySelectorAll('option[data-mega]'))
            .forEach(function(o) { o.remove(); });
        var megaForms = megaFormsForSpecies(state.species);
        megaForms.forEach(function(tok) {
            var opt = document.createElement('option');
            opt.value = tok;
            opt.textContent = formLabel(tok);
            opt.setAttribute('data-mega', '1');
            formSelect.appendChild(opt);
        });

        var isMegaForm = state.form && state.form.indexOf('mega') === 0;

        var shadowOption = formSelect.querySelector('option[value="shadow"]');
        if (shadowOption) {
            var isShadowEligible = state.species && state.species.tags &&
                (state.species.tags.indexOf('shadoweligible') > -1 || state.species.tags.indexOf('shadow') > -1);
            // Shadow and mega are mutually exclusive in GO — disable shadow while a mega form is active.
            shadowOption.disabled = !isShadowEligible || isMegaForm;
            if (shadowOption.disabled && state.form === 'shadow') {
                state.form = 'normal';
                formSelect.value = 'normal';
            }
        }

        // If the current form is a mega variant the new species doesn't have, reset to normal.
        if (isMegaForm && megaForms.indexOf(state.form) === -1) {
            state.form = 'normal';
            formSelect.value = 'normal';
        }
    }

    // Resolve a (base species, form) pair to the actual gamemaster entry + shadow flag.
    // Mega forms are separate species entries; shadow/purified ride on the base entry.
    function resolveFormSpecies(baseSpecies, form) {
        if (baseSpecies && form && form.indexOf('mega') === 0) {
            var megaData = ns.getPokemonById(baseSpecies.speciesId + '_' + form);
            if (megaData) return { species: megaData, shadowType: 'normal' };
        }
        return { species: baseSpecies, shadowType: form === 'shadow' ? 'shadow' : 'normal' };
    }

    // The effective candidate species entry for a given form (mega-aware).
    function getCandidateSpecies(form) {
        return resolveFormSpecies(state.species, form || state.form).species;
    }

    // ============ MOVE SELECTS ============

    // Get the recommended moveset for a species: ranking data first, then DPE-based fallback.
    function getAutoMoves(speciesData) {
        // Check ranking data first
        if (typeof RANKING_MOVESETS !== 'undefined') {
            var league = RANKING_MOVESETS[state.league];
            if (league && league[speciesData.speciesId]) {
                var ranked = league[speciesData.speciesId];
                return {
                    fast: ns.getMoveById(ranked[0]),
                    charged1: ns.getMoveById(ranked[1]),
                    charged2: ranked[2] ? ns.getMoveById(ranked[2]) : null,
                };
            }
        }

        // Fallback: score by DPE
        var types = speciesData.types || [];
        var stabMult = 1.2000000476837158203125;

        var bestFast = null, bestFastScore = -1;
        (speciesData.fastMoves || []).forEach(function(moveId) {
            var m = ns.getMoveById(moveId);
            if (!m) return;
            var stab = (m.type === types[0] || m.type === types[1]) ? stabMult : 1;
            var turns = m.cooldown / 500;
            var score = (m.power * stab / turns) * (m.energyGain / turns);
            if (score > bestFastScore) { bestFastScore = score; bestFast = m; }
        });

        var chargedScored = [];
        (speciesData.chargedMoves || []).forEach(function(moveId) {
            var m = ns.getMoveById(moveId);
            if (!m) return;
            var stab = (m.type === types[0] || m.type === types[1]) ? stabMult : 1;
            var dpe = (m.power * stab) / m.energy;
            if (m.buffs) {
                var buffEffect = 0;
                if (m.buffTarget === "self" && m.buffs[0] > 0) buffEffect = m.buffs[0] * (80 / m.energy);
                else if (m.buffTarget === "opponent" && m.buffs[1] < 0) buffEffect = Math.abs(m.buffs[1]) * (80 / m.energy);
                if (buffEffect > 0) dpe *= (4 + buffEffect * (parseFloat(m.buffApplyChance) || 1)) / 4;
            }
            chargedScored.push({ move: m, score: dpe });
        });
        chargedScored.sort(function(a, b) { return b.score - a.score; });

        return {
            fast: bestFast,
            charged1: chargedScored[0] ? chargedScored[0].move : null,
            charged2: chargedScored[1] ? chargedScored[1].move : null,
        };
    }

    function populateMoveSelects() {
        if (!state.species) return;
        // Use the effective (mega-aware) species so mega-specific move pools populate.
        var sp = getCandidateSpecies(state.form) || state.species;
        var fm = document.getElementById('fastMoveSelect');
        var cm1 = document.getElementById('chargedMove1Select');
        var cm2 = document.getElementById('chargedMove2Select');

        // Compute auto-selected moves
        var auto = getAutoMoves(sp);
        var autoFastName = auto.fast ? auto.fast.name : 'Auto';
        var autoCharged1Name = auto.charged1 ? auto.charged1.name : 'Auto';
        var autoCharged2Name = auto.charged2 ? auto.charged2.name : 'Auto';

        fm.innerHTML = '<option value="">' + autoFastName + ' (Auto)</option>';
        cm1.innerHTML = '<option value="">' + autoCharged1Name + ' (Auto)</option>';
        cm2.innerHTML = '<option value="">' + autoCharged2Name + ' (Auto)</option>';

        (sp.fastMoves || []).forEach(function(moveId) {
            var move = ns.getMoveById(moveId);
            if (move) {
                var elite = (sp.eliteMoves || []).indexOf(moveId) > -1 ? ' *' : '';
                fm.innerHTML += '<option value="' + moveId + '">' + move.name + elite + '</option>';
            }
        });

        (sp.chargedMoves || []).forEach(function(moveId) {
            var move = ns.getMoveById(moveId);
            if (move) {
                var elite = (sp.eliteMoves || []).indexOf(moveId) > -1 ? ' *' : '';
                cm1.innerHTML += '<option value="' + moveId + '">' + move.name + elite + '</option>';
                cm2.innerHTML += '<option value="' + moveId + '">' + move.name + elite + '</option>';
            }
        });
    }

    function restoreMoveOverrideUI() {
        if (state.moveOverride) {
            if (state.moveOverride.fastMove) document.getElementById('fastMoveSelect').value = state.moveOverride.fastMove;
            if (state.moveOverride.chargedMove1) document.getElementById('chargedMove1Select').value = state.moveOverride.chargedMove1;
            if (state.moveOverride.chargedMove2) document.getElementById('chargedMove2Select').value = state.moveOverride.chargedMove2;
        }
    }

    function invalidateForMoveChange(message) {
        state.results = null;
        document.getElementById('matrixSection').style.display = 'none';
        document.getElementById('diffSection').style.display = 'none';
        document.getElementById('statusBar').textContent = message;
    }

    function setupMoveSelects() {
        var handler = function() {
            var fm = document.getElementById('fastMoveSelect').value;
            var cm1 = document.getElementById('chargedMove1Select').value;
            var cm2 = document.getElementById('chargedMove2Select').value;
            state.moveOverride = (fm || cm1 || cm2) ? { fastMove: fm || null, chargedMove1: cm1 || null, chargedMove2: cm2 || null } : null;
            invalidateForMoveChange('Moveset changed — click Apply Moves (or Run Simulation) to update results.');
            saveState();
        };
        document.getElementById('fastMoveSelect').addEventListener('change', handler);
        document.getElementById('chargedMove1Select').addEventListener('change', handler);
        document.getElementById('chargedMove2Select').addEventListener('change', handler);
        document.getElementById('btnResetMoves').addEventListener('click', function() {
            state.moveOverride = null;
            populateMoveSelects(); // Refresh to show auto move names
            document.getElementById('fastMoveSelect').value = '';
            document.getElementById('chargedMove1Select').value = '';
            document.getElementById('chargedMove2Select').value = '';
            invalidateForMoveChange('Moveset reset to Auto — click Apply Moves (or Run Simulation) to update results.');
            saveState();
        });
        document.getElementById('btnApplyMoves').addEventListener('click', runSimulation);
    }

    // ============ LEAGUE / BUDDY / FORM ============
    function setupLeagueTabs() {
        var btns = document.querySelectorAll('.league-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', function() {
                var allBtns = document.querySelectorAll('.league-btn');
                for (var j = 0; j < allBtns.length; j++) allBtns[j].classList.remove('active');
                this.classList.add('active');
                state.league = Number(this.dataset.league);
                state.results = null;
                document.getElementById('matrixSection').style.display = 'none';
                document.getElementById('diffSection').style.display = 'none';
                updateAllCandidateComputedFields();

                // Refresh the move-selector "(Auto)" labels for the new league and
                // re-apply any active override, then indicate the change.
                if (state.species) {
                    populateMoveSelects();
                    restoreMoveOverrideUI();
                    var leagueNames = { 500: 'Little', 1500: 'Great', 2500: 'Ultra', 10000: 'Master' };
                    var auto = getAutoMoves(getCandidateSpecies(state.form) || state.species);
                    var moveNames = [auto.fast, auto.charged1, auto.charged2]
                        .filter(Boolean).map(function(m) { return m.name; });
                    var msg = (leagueNames[state.league] || '') + ' League';
                    msg += moveNames.length ? ' \u2014 recommended moves: ' + moveNames.join(' / ') + '. ' : ' \u2014 ';
                    document.getElementById('statusBar').textContent = msg + 'Run simulation to update results.';
                    // Flash the moveset row so the label change is noticeable
                    var row = document.getElementById('movesetRow');
                    row.classList.remove('flash');
                    void row.offsetWidth; // reflow so the animation can replay on rapid switches
                    row.classList.add('flash');
                } else {
                    document.getElementById('statusBar').textContent = 'League changed \u2014 run simulation to update results.';
                }

                // Set meta dropdown to default for the new league
                var defaultMap = { 500: 'little', 1500: 'great', 2500: 'ultra', 10000: 'master' };
                var metaSel = document.getElementById('metaSelect');
                if (defaultMap[state.league]) metaSel.value = defaultMap[state.league];
                saveState();
            });
        }
    }

    function setupBestBuddy() {
        var toggle = document.getElementById('bestBuddyToggle');
        toggle.addEventListener('click', function() {
            state.bestBuddy = !state.bestBuddy;
            toggle.classList.toggle('active', state.bestBuddy);
            state.results = null;
            document.getElementById('matrixSection').style.display = 'none';
            document.getElementById('diffSection').style.display = 'none';
            updateAllCandidateComputedFields();
            saveState();
        });
    }

    function setupFormSelect() {
        document.getElementById('formSelect').addEventListener('change', function(e) {
            state.form = e.target.value;
            updateFormOptions();          // keep shadow/mega option enablement in sync
            populateMoveSelects();        // mega forms have their own move pools
            restoreMoveOverrideUI();
            updateAllCandidateComputedFields();
            saveState();
        });
    }

    function getLevelCap() { return state.bestBuddy ? 51 : 50; }
    function getEffectiveForm(candidate) { return candidate.form || state.form; }

    // ============ CANDIDATES ============
    function addCandidateRow(atk, def, sta, form, nickname) {
        if (atk === undefined) atk = '';
        if (def === undefined) def = '';
        if (sta === undefined) sta = '';
        var id = state.nextCandidateId++;
        state.candidates.push({
            id: id, nickname: nickname || ('Candidate ' + (state.candidates.length + 1)),
            atk: atk === '' ? '' : Number(atk), def: def === '' ? '' : Number(def),
            sta: sta === '' ? '' : Number(sta), form: form || '', excluded: false,
        });
        renderCandidates();
        saveState();
        var row = document.querySelector('tr[data-id="' + id + '"]');
        if (row) { var atkInput = row.querySelector('.iv-atk'); if (atkInput) atkInput.focus(); }
    }

    var dragSrcIdx = null; // Track which row is being dragged

    function renderCandidates() {
        var body = document.getElementById('candidateBody');
        body.innerHTML = '';
        // Track reference by candidate ID so reordering preserves it
        var refId = state.candidates[state.referenceIdx] ? state.candidates[state.referenceIdx].id : null;

        // Mega override options apply to the shared candidate species (same for every row).
        var megaTokens = megaFormsForSpecies(state.species);

        state.candidates.forEach(function(c, idx) {
            var tr = document.createElement('tr');
            tr.dataset.id = c.id;
            tr.draggable = true;
            var isRef = c.id === refId;
            if (isRef) tr.classList.add('reference');
            if (c.excluded) tr.classList.add('candidate-excluded');
            var computed = computeCandidate(c);

            tr.innerHTML =
                '<td class="drag-handle" title="Drag to reorder">&#x2630;</td>' +
                '<td class="ref-pin' + (isRef ? ' active' : '') + '" title="Click to set as reference">' +
                    (isRef ? '&#9733;' : '&#9734;') +
                '</td>' +
                '<td class="exclude-cell"><button class="btn-exclude ' + (c.excluded ? 'excluded' : 'included') + '" title="' + (c.excluded ? 'Include in simulation' : 'Exclude from simulation') + '"></button></td>' +
                '<td><input type="text" class="nickname-input" value="' + escHtml(c.nickname) + '" data-field="nickname"></td>' +
                '<td><input type="number" class="iv-input iv-atk" min="0" max="15" value="' + (c.atk === '' ? '' : c.atk) + '" data-field="atk" placeholder="0-15"></td>' +
                '<td><input type="number" class="iv-input iv-def" min="0" max="15" value="' + (c.def === '' ? '' : c.def) + '" data-field="def" placeholder="0-15"></td>' +
                '<td><input type="number" class="iv-input iv-sta" min="0" max="15" value="' + (c.sta === '' ? '' : c.sta) + '" data-field="sta" placeholder="0-15"></td>' +
                '<td><select class="form-override" data-field="form">' +
                    '<option value=""' + (c.form === '' ? ' selected' : '') + '>Inherit</option>' +
                    '<option value="normal"' + (c.form === 'normal' ? ' selected' : '') + '>Normal</option>' +
                    '<option value="shadow"' + (c.form === 'shadow' ? ' selected' : '') + '>Shadow</option>' +
                    '<option value="purified"' + (c.form === 'purified' ? ' selected' : '') + '>Purified</option>' +
                    megaTokens.map(function(tok) {
                        return '<option value="' + tok + '"' + (c.form === tok ? ' selected' : '') + '>' + formLabel(tok) + '</option>';
                    }).join('') +
                '</select></td>' +
                '<td class="computed">' + computed + '</td>' +
                '<td class="row-actions">' +
                    (getEffectiveForm(c) === 'shadow' ? '<button class="btn-purify" title="Purify (adds +2 to each IV)">Purify</button>' : '') +
                    (getEffectiveForm(c) === 'purified' && c._shadowIVs ? '<button class="btn-unpurify" title="Revert to shadow IVs">Shadow</button>' : '') +
                    '<button class="btn-del" title="Remove">&#x2715;</button>' +
                '</td>';
            body.appendChild(tr);
        });

        // Events: inputs
        var inputs = body.querySelectorAll('input, select');
        for (var i = 0; i < inputs.length; i++) {
            inputs[i].addEventListener('change', onCandidateFieldChange);
            inputs[i].addEventListener('input', onCandidateFieldChange);
        }

        // Tab-through on STA
        var staInputs = body.querySelectorAll('.iv-sta');
        for (var i = 0; i < staInputs.length; i++) {
            staInputs[i].addEventListener('keydown', function(e) {
                if (e.key === 'Tab' && !e.shiftKey) {
                    var tr = this.closest('tr');
                    var idx = state.candidates.findIndex(function(c) { return c.id === Number(tr.dataset.id); });
                    if (idx === state.candidates.length - 1) { e.preventDefault(); addCandidateRow(); }
                }
            });
        }

        // Delete buttons
        var delBtns = body.querySelectorAll('.btn-del');
        for (var i = 0; i < delBtns.length; i++) {
            delBtns[i].addEventListener('click', function() {
                var tr = this.closest('tr');
                var id = Number(tr.dataset.id);
                state.candidates = state.candidates.filter(function(c) { return c.id !== id; });
                if (state.referenceIdx >= state.candidates.length) state.referenceIdx = 0;
                renderCandidates(); saveState();
            });
        }

        // Purify toggle — shadow → purified (adds +2 IVs, stores originals)
        var purBtns = body.querySelectorAll('.btn-purify');
        for (var i = 0; i < purBtns.length; i++) {
            purBtns[i].addEventListener('click', function() {
                var tr = this.closest('tr');
                var id = Number(tr.dataset.id);
                var c = state.candidates.find(function(c) { return c.id === id; });
                if (c && c.atk !== '' && c.def !== '' && c.sta !== '') {
                    c._shadowIVs = { atk: c.atk, def: c.def, sta: c.sta };
                    c.atk = Math.min(15, c.atk + 2);
                    c.def = Math.min(15, c.def + 2);
                    c.sta = Math.min(15, c.sta + 2);
                    c.form = 'purified';
                    renderCandidates(); saveState();
                }
            });
        }

        // Unpurify toggle — purified → shadow (restores original IVs)
        var unpurBtns = body.querySelectorAll('.btn-unpurify');
        for (var i = 0; i < unpurBtns.length; i++) {
            unpurBtns[i].addEventListener('click', function() {
                var tr = this.closest('tr');
                var id = Number(tr.dataset.id);
                var c = state.candidates.find(function(c) { return c.id === id; });
                if (c && c._shadowIVs) {
                    c.atk = c._shadowIVs.atk;
                    c.def = c._shadowIVs.def;
                    c.sta = c._shadowIVs.sta;
                    delete c._shadowIVs;
                    c.form = 'shadow';
                    renderCandidates(); saveState();
                }
            });
        }

        // Exclude toggle buttons
        var exBtns = body.querySelectorAll('.btn-exclude');
        for (var i = 0; i < exBtns.length; i++) {
            exBtns[i].addEventListener('click', function() {
                var tr = this.closest('tr');
                var id = Number(tr.dataset.id);
                var c = state.candidates.find(function(c) { return c.id === id; });
                if (c) {
                    if (state.candidates.indexOf(c) === state.referenceIdx) return;
                    c.excluded = !c.excluded;
                    renderCandidates();
                    saveState();
                }
            });
        }

        // Reference pin click
        var pins = body.querySelectorAll('.ref-pin');
        for (var i = 0; i < pins.length; i++) {
            pins[i].addEventListener('click', function() {
                var tr = this.closest('tr');
                var id = Number(tr.dataset.id);
                var idx = state.candidates.findIndex(function(c) { return c.id === id; });
                if (idx >= 0) {
                    state.referenceIdx = idx;
                    renderCandidates();
                    if (state.results) renderDifferences();
                    saveState();
                }
            });
        }

        // Drag-to-reorder handlers
        var rows = body.querySelectorAll('tr');
        for (var i = 0; i < rows.length; i++) {
            rows[i].addEventListener('dragstart', function(e) {
                var tr = this;
                dragSrcIdx = state.candidates.findIndex(function(c) { return c.id === Number(tr.dataset.id); });
                tr.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
            });

            rows[i].addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                // Highlight drop position
                var allRows = body.querySelectorAll('tr');
                for (var j = 0; j < allRows.length; j++) allRows[j].classList.remove('drag-over');
                this.classList.add('drag-over');
            });

            rows[i].addEventListener('dragleave', function() {
                this.classList.remove('drag-over');
            });

            rows[i].addEventListener('drop', function(e) {
                e.preventDefault();
                var tr = this;
                var dropIdx = state.candidates.findIndex(function(c) { return c.id === Number(tr.dataset.id); });
                if (dragSrcIdx !== null && dragSrcIdx !== dropIdx) {
                    // Move candidate in array
                    var moved = state.candidates.splice(dragSrcIdx, 1)[0];
                    state.candidates.splice(dropIdx, 0, moved);
                    // Update referenceIdx to follow the reference candidate by ID
                    var refCandidate = state.candidates.find(function(c) { return c.id === refId; });
                    if (refCandidate) {
                        state.referenceIdx = state.candidates.indexOf(refCandidate);
                    }
                    renderCandidates();
                    saveState();
                }
            });

            rows[i].addEventListener('dragend', function() {
                this.classList.remove('dragging');
                var allRows = body.querySelectorAll('tr');
                for (var j = 0; j < allRows.length; j++) allRows[j].classList.remove('drag-over');
                dragSrcIdx = null;
            });
        }
    }

    function onCandidateFieldChange(e) {
        var tr = e.target.closest('tr');
        var id = Number(tr.dataset.id);
        var field = e.target.dataset.field;
        var c = state.candidates.find(function(c) { return c.id === id; });
        if (!c) return;

        if (field === 'nickname') { c.nickname = e.target.value; }
        else if (field === 'atk' || field === 'def' || field === 'sta') {
            c[field] = e.target.value === '' ? '' : Math.max(0, Math.min(15, Number(e.target.value)));
            updateCandidateComputed(tr, c);
        } else if (field === 'form') {
            c.form = e.target.value;
            updateCandidateComputed(tr, c);
            renderCandidates();
        }
        saveState();
    }

    function computeCandidate(c) {
        if (!state.species || c.atk === '' || c.def === '' || c.sta === '') {
            return '<span style="color:var(--text-dim)">Enter IVs</span>';
        }
        var data = getCandidateSpecies(getEffectiveForm(c)) || state.species;
        var levelCap = getLevelCap();
        var result = ns.findOptimalLevel(data.baseStats, c.atk, c.def, c.sta, state.league, levelCap);
        var rank = ns.getIVRank(data.baseStats, c.atk, c.def, c.sta, state.league, levelCap, 0);
        var leagueLabel = state.league === 1500 ? 'GL' : state.league === 2500 ? 'UL' : 'ML';
        return '<span class="cp">CP ' + result.cp + '</span> &middot; L' + result.level +
            ' &middot; <span class="rank">R' + rank + ' ' + leagueLabel + '</span>';
    }

    function updateCandidateComputed(tr, c) {
        var td = tr.querySelector('.computed');
        if (td) td.innerHTML = computeCandidate(c);
    }

    function updateAllCandidateComputedFields() {
        var rows = document.querySelectorAll('#candidateBody tr');
        for (var i = 0; i < rows.length; i++) {
            var id = Number(rows[i].dataset.id);
            var c = state.candidates.find(function(c) { return c.id === id; });
            if (c) updateCandidateComputed(rows[i], c);
        }
    }

    // ============ THREATS ============
    function setupThreatSearch() {
        var input = document.getElementById('threatSearch');
        var dropdown = document.getElementById('threatDropdown');
        var selectedIdx = -1;

        input.addEventListener('input', function() {
            var q = input.value.toLowerCase().trim();
            if (q.length < 2) { dropdown.classList.remove('visible'); return; }
            var all = ns.getAllPokemon().filter(function(p) {
                return p.released &&
                    (p.speciesName.toLowerCase().indexOf(q) > -1 || p.speciesId.toLowerCase().indexOf(q) > -1);
            }).slice(0, 15);

            dropdown.innerHTML = all.map(function(p) {
                return '<div class="search-item" data-id="' + p.speciesId + '">' + p.speciesName + '</div>';
            }).join('');
            dropdown.classList.toggle('visible', all.length > 0);
            selectedIdx = -1;
        });

        input.addEventListener('keydown', function(e) {
            var items = dropdown.querySelectorAll('.search-item');
            if (e.key === 'ArrowDown') { selectedIdx = Math.min(selectedIdx + 1, items.length - 1); highlightItem(items, selectedIdx); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { selectedIdx = Math.max(selectedIdx - 1, 0); highlightItem(items, selectedIdx); e.preventDefault(); }
            else if (e.key === 'Enter' && selectedIdx >= 0 && items[selectedIdx]) { addThreatBySearch(items[selectedIdx].dataset.id); dropdown.classList.remove('visible'); input.value = ''; }
            else if (e.key === 'Escape') { dropdown.classList.remove('visible'); }
        });

        dropdown.addEventListener('click', function(e) {
            var item = e.target.closest('.search-item');
            if (item) { addThreatBySearch(item.dataset.id); dropdown.classList.remove('visible'); input.value = ''; }
        });

        document.addEventListener('click', function(e) {
            if (!e.target.closest('#threatSearch') && !e.target.closest('#threatDropdown')) dropdown.classList.remove('visible');
        });

        function highlightItem(items, idx) {
            for (var i = 0; i < items.length; i++) items[i].classList.toggle('selected', i === idx);
        }
    }

    function addThreatBySearch(speciesId) {
        if (state.threats.some(function(t) { return t.speciesId === speciesId; })) return;
        var data = ns.getPokemonById(speciesId);
        if (!data) return;
        state.threats.push({
            speciesId: speciesId, fastMove: (data.fastMoves || [])[0] || '',
            chargedMoves: (data.chargedMoves || []).slice(0, 2),
            shadowType: speciesId.indexOf('_shadow') > -1 ? 'shadow' : 'normal',
            priority: false, excluded: false,
        });
        renderThreats(); saveState();
    }

    function populateMetaSelect() {
        var select = document.getElementById('metaSelect');
        select.innerHTML = '';

        // Build format list from gamemaster, grouped by CP
        var formats = GAMEMASTER_DATA.formats || [];
        var cpGroups = { 500: [], 1500: [], 2500: [], 10000: [] };
        var addedMetas = {};

        for (var i = 0; i < formats.length; i++) {
            var f = formats[i];
            if (!f.meta || !f.showMeta) continue;
            // Only include formats that have a pre-built group file
            var hasGroup = typeof META_GROUPS !== 'undefined' && META_GROUPS[f.meta];
            if (!hasGroup) continue;
            var cp = f.cp || 1500;
            if (!cpGroups[cp]) cpGroups[cp] = [];
            cpGroups[cp].push({ title: f.title, meta: f.meta, cp: cp });
            addedMetas[f.meta] = true;
        }

        // Also add base leagues if not already present
        var baseMetas = [
            { title: 'Great League', meta: 'great', cp: 1500 },
            { title: 'Ultra League', meta: 'ultra', cp: 2500 },
            { title: 'Master League', meta: 'master', cp: 10000 }
        ];
        for (var i = 0; i < baseMetas.length; i++) {
            var bm = baseMetas[i];
            var exists = cpGroups[bm.cp].some(function(f) { return f.meta === bm.meta; });
            if (!exists) cpGroups[bm.cp].unshift(bm);
        }

        var cpLabels = { 500: 'Little League (500)', 1500: 'Great League (1500)', 2500: 'Ultra League (2500)', 10000: 'Master League (10000)' };
        var cpOrder = [500, 1500, 2500, 10000];

        for (var ci = 0; ci < cpOrder.length; ci++) {
            var cp = cpOrder[ci];
            var group = cpGroups[cp];
            if (!group || group.length === 0) continue;

            var optgroup = document.createElement('optgroup');
            optgroup.label = cpLabels[cp] || ('CP ' + cp);

            for (var fi = 0; fi < group.length; fi++) {
                var opt = document.createElement('option');
                opt.value = group[fi].meta;
                opt.textContent = group[fi].title;
                opt.dataset.cp = group[fi].cp;
                optgroup.appendChild(opt);
            }
            select.appendChild(optgroup);
        }

        // Default selection based on current league
        var defaultMap = { 1500: 'great', 2500: 'ultra', 10000: 'master' };
        select.value = defaultMap[state.league] || 'great';
    }

    function loadMetaThreats() {
        var select = document.getElementById('metaSelect');
        var metaKey = select.value;
        var selectedOption = select.options[select.selectedIndex];
        var metaCp = selectedOption ? Number(selectedOption.dataset.cp) : state.league;

        // Auto-switch league if the format's CP cap differs
        if (metaCp && metaCp !== state.league) {
            state.league = metaCp;
            var btns = document.querySelectorAll('.league-btn');
            for (var i = 0; i < btns.length; i++) {
                btns[i].classList.toggle('active', Number(btns[i].dataset.league) === state.league);
            }
            state.results = null;
            document.getElementById('matrixSection').style.display = 'none';
            document.getElementById('diffSection').style.display = 'none';
            updateAllCandidateComputedFields();
        }

        ns.loadMetaGroup(metaKey).then(function(meta) {
            state.threats = meta.map(function(t) {
                return {
                    speciesId: t.speciesId, fastMove: t.fastMove, chargedMoves: t.chargedMoves || [],
                    shadowType: t.shadowType || (t.speciesId.indexOf('_shadow') > -1 ? 'shadow' : 'normal'),
                    priority: false, excluded: false,
                };
            });
            state.threats.sort(function(a, b) {
                return (a.speciesId > b.speciesId) ? 1 : ((b.speciesId > a.speciesId) ? -1 : 0);
            });
            state.excludedThreats = {};
            renderThreats(); saveState();
        });
    }

    function renderThreats() {
        var container = document.getElementById('threatList');
        container.innerHTML = '';
        state.threats.forEach(function(t, idx) {
            var data = ns.getPokemonById(t.speciesId.replace('_shadow', ''));
            var name = data ? data.speciesName : t.speciesId;
            var shadow = t.shadowType === 'shadow' ? ' (S)' : '';
            var excluded = !!state.excludedThreats[t.speciesId];

            var tag = document.createElement('span');
            tag.className = 'threat-tag' + (t.priority ? ' priority' : '') + (excluded ? ' excluded' : '');
            tag.innerHTML = escHtml(name) + shadow + ' <span class="remove">&times;</span>';

            tag.addEventListener('click', function(e) {
                if (e.target.classList.contains('remove')) return;
                t.priority = !t.priority; renderThreats(); saveState();
            });
            tag.addEventListener('contextmenu', function(e) {
                e.preventDefault(); toggleThreatExclusion(t.speciesId);
            });
            tag.querySelector('.remove').addEventListener('click', function() {
                state.threats.splice(idx, 1);
                delete state.excludedThreats[t.speciesId];
                renderThreats(); saveState();
            });
            container.appendChild(tag);
        });
    }

    function toggleThreatExclusion(speciesId) {
        if (state.excludedThreats[speciesId]) { delete state.excludedThreats[speciesId]; }
        else { state.excludedThreats[speciesId] = true; }
        renderThreats();
        if (state.results) { renderMatrix(); renderDifferences(); }
        saveState();
    }

    // ============ SIMULATION ============
    function setupButtons() {
        document.getElementById('btnAddRow').addEventListener('click', function() { addCandidateRow(); });
        document.getElementById('btnRunSim').addEventListener('click', runSimulation);
        document.getElementById('btnRunSimDiff').addEventListener('click', runSimulation);
        document.getElementById('btnLoadMeta').addEventListener('click', loadMetaThreats);
        document.getElementById('btnClearSession').addEventListener('click', clearSession);
        document.getElementById('btnClearCandidates').addEventListener('click', clearCandidates);
        document.getElementById('btnResetCandidateExclusions').addEventListener('click', function() {
            for (var i = 0; i < state.candidates.length; i++) {
                state.candidates[i].excluded = false;
            }
            renderCandidates();
            saveState();
        });
        document.getElementById('btnExportCSV').addEventListener('click', exportCSV);
        document.getElementById('btnExportCSV0v0').addEventListener('click', function() { exportCSV('0v0'); });
        document.getElementById('btnExportCSV1v1').addEventListener('click', function() { exportCSV('1v1'); });
        document.getElementById('diffPriorityOnly').addEventListener('change', function() {
            if (state.results) renderDifferences();
        });
        document.getElementById('diffHideExcluded').addEventListener('change', function() {
            if (state.results) renderDifferences();
        });
        document.getElementById('btnResetExclusions').addEventListener('click', function() {
            state.excludedThreats = {};
            for (var i = 0; i < state.threats.length; i++) {
                state.threats[i].priority = false;
            }
            renderThreats();
            if (state.results) { renderMatrix(); renderDifferences(); }
            saveState();
        });
    }

    function exportCSV(singleScenario) {
        if (!state.results) { alert('Run a simulation first.'); return; }
        var matrix = state.results.matrix, candidates = state.results.candidates,
            candidatePokemon = state.results.candidatePokemon, threatPokemon = state.results.threatPokemon;

        var rows = [];

        // Header row
        var header = ['Candidate', 'IVs', 'CP', 'Level'];
        for (var ti = 0; ti < threatPokemon.length; ti++) {
            var t = threatPokemon[ti];
            var shadow = t.shadowType === 'shadow' ? ' (Shadow)' : '';
            header.push(t.speciesName + shadow);
        }
        rows.push(header);

        var scenarios = singleScenario ? [singleScenario] : ['0v0','0v1','0v2','1v0','1v1','1v2','2v0','2v1','2v2'];
        for (var ci = 0; ci < candidatePokemon.length; ci++) {
            var c = candidates[ci];
            var cp = candidatePokemon[ci];
            for (var si = 0; si < scenarios.length; si++) {
                var row = [
                    singleScenario ? c.nickname : c.nickname + ' (' + scenarios[si] + ')',
                    c.atk + '/' + c.def + '/' + c.sta,
                    cp.cp,
                    cp.level
                ];
                for (var ti = 0; ti < threatPokemon.length; ti++) {
                    row.push(matrix[ci][ti][scenarios[si]].battleRating);
                }
                rows.push(row);
            }
        }

        // Build CSV string
        var csv = rows.map(function(row) {
            return row.map(function(cell) {
                var s = String(cell);
                if (s.indexOf(',') > -1 || s.indexOf('"') > -1) {
                    return '"' + s.replace(/"/g, '""') + '"';
                }
                return s;
            }).join(',');
        }).join('\n');

        // Download
        var blob = new Blob([csv], { type: 'text/csv' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = (state.species ? state.species.speciesName : 'battle') + '_matrix.csv';
        a.click();
        URL.revokeObjectURL(url);
    }

    // Resolve a list of threats into display+sim Pokemon objects with per-league
    // default IVs and recommended moves. Shared by the matrix (runSimulation) and
    // the bulk matchups view so default-IV logic stays identical.
    function resolveThreatPokemon(threats, league, levelCap) {
        return threats.map(function(t) {
            var baseId = t.speciesId.replace('_shadow', '');
            var shadowType = t.shadowType || (t.speciesId.indexOf('_shadow') > -1 ? 'shadow' : 'normal');
            var data = ns.getPokemonById(baseId);
            if (!data) return null;

            // Use default IVs from gamemaster (prefer shadow-specific entry)
            var gmEntry = ns.getPokemonById(t.speciesId) || data;
            var ivs = { atk: 0, def: 0, hp: 0 };
            var key = 'cp' + league;
            if (gmEntry.defaultIVs && gmEntry.defaultIVs[key]) {
                var combo = gmEntry.defaultIVs[key];
                ivs = { atk: combo[1], def: combo[2], hp: combo[3] };
            }
            var result = ns.findOptimalLevel(data.baseStats, ivs.atk, ivs.def, ivs.hp, league, levelCap);

            return {
                speciesId: baseId,
                speciesName: data.speciesName,
                ivs: ivs,
                shadowType: shadowType,
                cp: result.cp, level: result.level, stats: result.stats,
                threatData: t,
                preferredFastMove: t.fastMove || null,
                preferredChargedMoves: t.chargedMoves || [],
            };
        }).filter(Boolean);
    }

    function runSimulation() {
        if (!state.species) { alert('Select a species first.'); return; }
        var validCandidates = state.candidates.filter(function(c) { return c.atk !== '' && c.def !== '' && c.sta !== '' && !c.excluded; });
        if (validCandidates.length === 0) { alert('Enter at least one candidate with IVs.'); return; }
        if (state.threats.length === 0) { alert('Add threats or load meta first.'); return; }

        var statusBar = document.getElementById('statusBar');
        statusBar.textContent = 'Simulating...';
        var startTime = performance.now();
        var levelCap = getLevelCap();

        // Build candidate display info using lightweight stat calc
        var candidatePokemon = validCandidates.map(function(c) {
            var form = getEffectiveForm(c);
            // Mega forms resolve to their own species entry (own stats/types/moves);
            // shadow/purified ride on the base entry via shadowType.
            var resolved = resolveFormSpecies(state.species, form);
            var sp = resolved.species || state.species;
            var result = ns.findOptimalLevel(sp.baseStats, c.atk, c.def, c.sta, state.league, levelCap);
            return {
                speciesId: sp.speciesId,
                speciesName: sp.speciesName,
                ivs: { atk: c.atk, def: c.def, hp: c.sta },
                shadowType: resolved.shadowType,
                form: form,
                cp: result.cp, level: result.level, stats: result.stats,
            };
        });

        // Build threat display info (shared with the bulk matchups view)
        var threatPokemon = resolveThreatPokemon(state.threats, state.league, levelCap);

        // Run simulations using PvPoke's engine
        var matrix = [];
        var ALL_SCENARIOS = [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]];
        var totalSims = candidatePokemon.length * threatPokemon.length * ALL_SCENARIOS.length;

        for (var ci = 0; ci < candidatePokemon.length; ci++) {
            var row = [];
            for (var ti = 0; ti < threatPokemon.length; ti++) {
                var cand = candidatePokemon[ci];
                var threat = threatPokemon[ti];

                // Build move arrays (null slots fall back to auto per-slot)
                var movesA = null;
                if (state.moveOverride) {
                    movesA = [state.moveOverride.fastMove, state.moveOverride.chargedMove1, state.moveOverride.chargedMove2];
                }
                var movesB = null;
                if (threat.preferredFastMove) {
                    movesB = [threat.preferredFastMove,
                        (threat.preferredChargedMoves || [])[0] || null,
                        (threat.preferredChargedMoves || [])[1] || null];
                }

                var results = {};
                for (var s = 0; s < ALL_SCENARIOS.length; s++) {
                    var sKey = ALL_SCENARIOS[s][0] + 'v' + ALL_SCENARIOS[s][1];
                    results[sKey] = ns.simulateBattle(
                        cand.speciesId, [cand.ivs.atk, cand.ivs.def, cand.ivs.hp],
                        threat.speciesId, [threat.ivs.atk, threat.ivs.def, threat.ivs.hp],
                        ALL_SCENARIOS[s][0], ALL_SCENARIOS[s][1],
                        state.league, levelCap,
                        cand.shadowType, threat.shadowType,
                        movesA, movesB
                    );
                }
                row.push(results);
            }
            matrix.push(row);
        }

        // Store the reference candidate's ID so we can find it in the filtered list
        var refCandidate = state.candidates[state.referenceIdx];
        var refId = refCandidate ? refCandidate.id : null;

        state.results = { matrix: matrix, candidates: validCandidates, candidatePokemon: candidatePokemon, threatPokemon: threatPokemon, refId: refId };

        var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        statusBar.textContent = totalSims + ' simulations completed in ' + elapsed + 's';

        renderMatrix();
        renderDifferences();
        document.getElementById('matrixSection').style.display = '';
        document.getElementById('diffSection').style.display = '';
    }

    // ============ MODE TABS ============
    function setupModeTabs() {
        var btns = document.querySelectorAll('.mode-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].addEventListener('click', function() { setMode(this.dataset.mode); });
        }
    }

    function setMode(mode) {
        if (mode !== 'compare' && mode !== 'bulk') return;
        state.mode = mode;
        applyMode();
        saveState();
    }

    // Toggle section visibility for the current mode. Controls + threat list are shared.
    function applyMode() {
        var bulk = state.mode === 'bulk';
        var btns = document.querySelectorAll('.mode-btn');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', btns[i].dataset.mode === state.mode);
        }
        document.getElementById('candidatesSection').style.display = bulk ? 'none' : '';
        document.getElementById('matrixSection').style.display = (!bulk && state.results) ? '' : 'none';
        document.getElementById('diffSection').style.display = (!bulk && state.results) ? '' : 'none';
        document.getElementById('bulkSection').style.display = bulk ? '' : 'none';
        if (bulk) renderBulkMatchups();
    }

    // ============ BULK MATCHUPS (one mon vs the meta, all shields) ============
    function setupBulk() {
        document.getElementById('bulkAtk').value = state.bulkIVs.atk;
        document.getElementById('bulkDef').value = state.bulkIVs.def;
        document.getElementById('bulkSta').value = state.bulkIVs.sta;
        var sortBtns = document.querySelectorAll('.bulk-sort-btn');
        for (var i = 0; i < sortBtns.length; i++) {
            sortBtns[i].classList.toggle('active', sortBtns[i].dataset.sort === state.bulkSort);
            sortBtns[i].addEventListener('click', function() {
                state.bulkSort = this.dataset.sort;
                var all = document.querySelectorAll('.bulk-sort-btn');
                for (var j = 0; j < all.length; j++) all[j].classList.toggle('active', all[j].dataset.sort === state.bulkSort);
                renderBulkMatchups();
                saveState();
            });
        }
        document.getElementById('btnRunBulk').addEventListener('click', runBulkMatchups);
    }

    function readBulkIVs() {
        function clamp(v) { v = parseInt(v, 10); if (isNaN(v)) v = 0; return Math.max(0, Math.min(15, v)); }
        state.bulkIVs = {
            atk: clamp(document.getElementById('bulkAtk').value),
            def: clamp(document.getElementById('bulkDef').value),
            sta: clamp(document.getElementById('bulkSta').value),
        };
        return state.bulkIVs;
    }

    // Mean battle rating across all 9 shield scenarios — a true "across all shields"
    // summary, distinct from the 1v1 figure (used for the Overall column + sort).
    function bulkOverall(results) {
        var sum = 0;
        for (var i = 0; i < SCENARIO_KEYS.length; i++) sum += results[SCENARIO_KEYS[i]].battleRating;
        return Math.round(sum / SCENARIO_KEYS.length);
    }

    function runBulkMatchups() {
        if (!state.species) { alert('Select a species first.'); return; }
        if (state.threats.length === 0) { alert('Add threats or load meta first.'); return; }

        var statusBar = document.getElementById('statusBar');
        statusBar.textContent = 'Simulating...';
        var startTime = performance.now();
        var levelCap = getLevelCap();
        var ivs = readBulkIVs();
        var form = state.form;

        var threatPokemon = resolveThreatPokemon(state.threats, state.league, levelCap);

        var movesA = null;
        if (state.moveOverride) {
            movesA = [state.moveOverride.fastMove, state.moveOverride.chargedMove1, state.moveOverride.chargedMove2];
        }

        var ALL_SCENARIOS = [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]];
        var rows = [];
        for (var ti = 0; ti < threatPokemon.length; ti++) {
            var threat = threatPokemon[ti];
            var movesB = null;
            if (threat.preferredFastMove) {
                movesB = [threat.preferredFastMove,
                    (threat.preferredChargedMoves || [])[0] || null,
                    (threat.preferredChargedMoves || [])[1] || null];
            }
            var results = {};
            for (var s = 0; s < ALL_SCENARIOS.length; s++) {
                var sKey = ALL_SCENARIOS[s][0] + 'v' + ALL_SCENARIOS[s][1];
                results[sKey] = ns.simulateBattle(
                    state.species.speciesId, [ivs.atk, ivs.def, ivs.sta],
                    threat.speciesId, [threat.ivs.atk, threat.ivs.def, threat.ivs.hp],
                    ALL_SCENARIOS[s][0], ALL_SCENARIOS[s][1],
                    state.league, levelCap,
                    form, threat.shadowType,
                    movesA, movesB
                );
            }
            rows.push({ threat: threat, results: results });
        }

        state.bulkResults = {
            mon: { speciesId: state.species.speciesId, speciesName: state.species.speciesName, ivs: ivs, form: form },
            rows: rows,
        };

        var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        statusBar.textContent = (threatPokemon.length * ALL_SCENARIOS.length) + ' simulations completed in ' + elapsed + 's';

        renderBulkMatchups();
        saveState();
    }

    function renderBulkMatchups() {
        var container = document.getElementById('bulkContent');
        if (!container) return;
        var label = document.getElementById('bulkMonLabel');

        if (!state.bulkResults) {
            if (label) label.textContent = '';
            container.innerHTML = '<div class="bulk-empty">Pick a species, load a meta, then press Run.</div>';
            return;
        }

        var mon = state.bulkResults.mon;
        var formLabel = mon.form === 'shadow' ? ' (Shadow)' : (mon.form === 'purified' ? ' (Purified)' : '');
        if (label) label.textContent = mon.speciesName + formLabel + ' · ' + mon.ivs.atk + '/' + mon.ivs.def + '/' + mon.ivs.sta;

        // Sort a copy of the rows by the active preset.
        var rows = state.bulkResults.rows.slice();
        var sort = state.bulkSort;
        rows.sort(function(a, b) {
            if (sort === 'name') {
                return a.threat.speciesName > b.threat.speciesName ? 1 : (b.threat.speciesName > a.threat.speciesName ? -1 : 0);
            }
            var av = sort === '1v1' ? a.results['1v1'].battleRating : bulkOverall(a.results);
            var bv = sort === '1v1' ? b.results['1v1'].battleRating : bulkOverall(b.results);
            return bv - av; // best matchups first
        });

        var html = '<table class="bulk-table"><thead><tr>' +
            '<th class="bulk-opp-head">Opponent</th>' +
            '<th>Overall</th>' +
            '<th class="bulk-grid-head">Matchups <span class="bulk-axis">(your▾ / opp▸ shields)</span></th>' +
            '</tr></thead><tbody>';

        for (var r = 0; r < rows.length; r++) {
            var row = rows[r];
            var tp = row.threat;
            var name = tp.speciesName + (tp.shadowType === 'shadow' ? ' (S)' : '');

            var moveStr = '';
            var fmData = ns.getMoveById(tp.preferredFastMove || '');
            if (fmData) {
                moveStr = abbreviateMove(fmData.name);
                var cmParts = [];
                var cms = tp.preferredChargedMoves || [];
                for (var mi = 0; mi < cms.length; mi++) {
                    var cmData = ns.getMoveById(cms[mi]);
                    if (cmData) cmParts.push(abbreviateMove(cmData.name));
                }
                if (cmParts.length) moveStr += '+' + cmParts.join('/');
            }
            var ivStr = tp.ivs.atk + '/' + tp.ivs.def + '/' + tp.ivs.hp;

            var ov = bulkOverall(row.results);
            var ovClass = getBRColorClass(ov);

            // 3x3 grid: rows = your shields (0s/1s/2s), cols = opponent shields.
            // Reuse the matrix's expanded-grid layout + seg-* colors.
            var grid = '<span class="shield-expanded-grid bulk-grid">';
            grid += '<span class="seg-header"></span><span class="seg-header">0s</span><span class="seg-header">1s</span><span class="seg-header">2s</span>';
            for (var ys = 0; ys < 3; ys++) {
                grid += '<span class="seg-header">' + ys + 's</span>';
                for (var os = 0; os < 3; os++) {
                    var key = ys + 'v' + os;
                    var sBR = row.results[key].battleRating;
                    var sClass = sBR === 500 ? 'seg-tie' : (sBR > 500 ? 'seg-win' : 'seg-loss');
                    grid += '<span class="' + sClass + '">' + sBR + '</span>';
                }
            }
            grid += '</span>';

            var pvp = '';
            var r1 = row.results['1v1'];
            if (r1 && r1.pokemon && r1.pokemon.length === 2) {
                var link = buildPvpokeLink(r1.pokemon[0], r1.pokemon[1], 1, 1, state.league);
                pvp = '<a class="pvpoke-link bulk-pvp" href="' + link + '" target="_blank" rel="noopener" title="Open 1v1 in PvPoke">↗</a>';
            }

            html += '<tr class="bulk-row">' +
                '<td class="bulk-opp">' +
                    '<span class="threat-name">' + name + '</span>' +
                    '<span class="threat-moves">' + moveStr + '</span>' +
                    '<span class="threat-ivs">' + ivStr + '</span>' + pvp +
                '</td>' +
                '<td class="br-cell ' + ovClass + ' bulk-overall">' + ov + '</td>' +
                '<td class="bulk-grid-cell">' + grid + '</td>' +
            '</tr>';
        }
        html += '</tbody></table>';
        container.innerHTML = html;
    }

    // ============ SHIELD-SCENARIO FILTER ============
    // Interactive 3x3 grid (You shields × Opponent shields) controlling which shield
    // scenarios the matrix, Overall column, and Differences view consider. All on by default.
    function renderShieldFilter() {
        var el = document.getElementById('shieldFilter');
        if (!el) return;
        var html = '<span class="shield-legend-vertical-label">You</span>';
        html += '<span class="shield-legend-grid">';
        html += '<span class="shield-legend-top-label">Opponent</span>';
        html += '<span class="shield-legend-col-headers"><span></span><span>0</span><span>1</span><span>2</span></span>';
        for (var row = 0; row < 3; row++) {
            html += '<span class="shield-legend-row"><span>' + row + '</span>';
            for (var col = 0; col < 3; col++) {
                var key = row + 'v' + col;
                var on = state.activeScenarios[key] ? ' active' : '';
                html += '<button class="shield-toggle' + on + '" data-key="' + key + '" title="' + key + '"></button>';
            }
            html += '</span>';
        }
        html += '</span>';
        html += '<span class="shield-presets">' +
            '<button data-preset="1v1">1v1 only</button>' +
            '<button data-preset="all">All</button></span>';
        el.innerHTML = html;
    }

    function setupShieldFilter() {
        var el = document.getElementById('shieldFilter');
        if (!el) return;
        el.addEventListener('click', function(e) {
            var btn = e.target.closest('button');
            if (!btn) return;
            if (btn.dataset.preset === 'all') {
                SCENARIO_KEYS.forEach(function(k) { state.activeScenarios[k] = true; });
            } else if (btn.dataset.preset === '1v1') {
                SCENARIO_KEYS.forEach(function(k) { state.activeScenarios[k] = (k === '1v1'); });
            } else if (btn.dataset.key) {
                var k = btn.dataset.key;
                // Keep at least one scenario active.
                if (state.activeScenarios[k] && activeScenarioKeys().length === 1) return;
                state.activeScenarios[k] = !state.activeScenarios[k];
            } else {
                return;
            }
            renderShieldFilter();
            renderMatrix();
            renderDifferences();
            saveState();
        });
    }

    // ============ MATRIX ============
    function renderMatrix() {
        if (!state.results) return;
        var matrix = state.results.matrix, candidates = state.results.candidates,
            candidatePokemon = state.results.candidatePokemon, threatPokemon = state.results.threatPokemon;

        var thead = document.getElementById('matrixHead');
        var tbody = document.getElementById('matrixBody');

        var headerHtml = '<tr><th></th><th>Wins</th><th>Overall</th>';
        for (var ti = 0; ti < threatPokemon.length; ti++) {
            var tp = threatPokemon[ti];
            var data = ns.getPokemonById(tp.speciesId);
            var name = data ? data.speciesName : tp.speciesId;
            var shadow = tp.shadowType === 'shadow' ? ' (S)' : '';
            var excluded = state.excludedThreats[tp.threatData.speciesId] ? ' excluded' : '';

            // Build move abbreviation string like PvPoke: "FM+CM1/CM2"
            var moveStr = '';
            var fmData = ns.getMoveById(tp.preferredFastMove || '');
            if (fmData) {
                moveStr = abbreviateMove(fmData.name);
                var cms = tp.preferredChargedMoves || [];
                var cmParts = [];
                for (var mi = 0; mi < cms.length; mi++) {
                    var cmData = ns.getMoveById(cms[mi]);
                    if (cmData) cmParts.push(abbreviateMove(cmData.name));
                }
                if (cmParts.length > 0) moveStr += '+' + cmParts.join('/');
            }

            // IVs and level
            var ivStr = tp.ivs.atk + '/' + tp.ivs.def + '/' + tp.ivs.hp;

            headerHtml += '<th class="' + excluded + '" data-threat-idx="' + ti + '" title="' + name + shadow + '\n' + moveStr + '\n' + ivStr + '">' +
                '<span class="threat-name">' + name + shadow + '</span>' +
                '<span class="threat-moves">' + moveStr + '</span>' +
                '<span class="threat-ivs">' + ivStr + '</span>' +
                '</th>';
        }
        headerHtml += '</tr>';
        thead.innerHTML = headerHtml;

        var thHeaders = thead.querySelectorAll('th[data-threat-idx]');
        for (var i = 0; i < thHeaders.length; i++) {
            thHeaders[i].addEventListener('click', (function(ti) {
                return function() { toggleThreatExclusion(threatPokemon[ti].threatData.speciesId); };
            })(i));
        }

        // Find reference index within the filtered candidates
        var matrixRefIdx = 0;
        if (state.results.refId != null) {
            for (var ri = 0; ri < candidates.length; ri++) {
                if (candidates[ri].id === state.results.refId) { matrixRefIdx = ri; break; }
            }
        }

        tbody.innerHTML = '';
        for (var ci = 0; ci < candidatePokemon.length; ci++) {
            var cp = candidatePokemon[ci], c = candidates[ci];
            var tr = document.createElement('tr');
            if (ci === matrixRefIdx) tr.classList.add('reference');

            var form = getEffectiveForm(c);
            var formTag = form === 'shadow' ? ' (S)' : form === 'purified' ? ' (P)' :
                form === 'mega' ? ' (M)' : form.indexOf('mega_') === 0 ? ' (M' + form.slice(5).toUpperCase() + ')' : '';
            var label = escHtml(c.nickname) + formTag + '<br><span style="font-size:0.7rem;color:var(--text-dim)">' + c.atk + '/' + c.def + '/' + c.sta + ' CP' + cp.cp + ' L' + cp.level + '</span>';

            var html = '<th>' + label + '</th>';

            var wins = 0, total = 0;
            for (var ti = 0; ti < matrix[ci].length; ti++) {
                if (!state.excludedThreats[threatPokemon[ti].threatData.speciesId]) {
                    if (headlineBR(matrix[ci][ti]) >= 500) wins++;
                    total++;
                }
            }
            html += '<td class="win-count">' + wins + '/' + total + '</td>';

            // Overall rating cell — aggregate across threats, styled like a matchup cell
            var ov = computeOverall(matrix[ci], threatPokemon);
            if (ov.headline == null) {
                html += '<td class="br-cell overall-cell">&mdash;</td>';
            } else {
                var ovColor = getBRColorClass(ov.headline);
                var ovContent = '<span class="br-main">' + ov.headline + '</span>';
                ovContent += '<span class="shield-expanded"><span class="shield-expanded-grid">';
                ovContent += '<span class="seg-header"></span><span class="seg-header">0s</span><span class="seg-header">1s</span><span class="seg-header">2s</span>';
                for (var orow = 0; orow < 3; orow++) {
                    ovContent += '<span class="seg-header">' + orow + 's</span>';
                    for (var ocol = 0; ocol < 3; ocol++) {
                        var oKey = orow + 'v' + ocol;
                        var oBR = ov.byScenario[oKey];
                        var oClass = oBR === 500 ? 'seg-tie' : (oBR > 500 ? 'seg-win' : 'seg-loss');
                        if (!state.activeScenarios[oKey]) oClass += ' inactive';
                        ovContent += '<span class="' + oClass + '">' + oBR + '</span>';
                    }
                }
                ovContent += '</span></span>';
                html += '<td class="br-cell ' + ovColor + ' overall-cell">' + ovContent + '</td>';
            }

            for (var ti = 0; ti < matrix[ci].length; ti++) {
                var results = matrix[ci][ti];
                var excluded = !!state.excludedThreats[threatPokemon[ti].threatData.speciesId];
                var br = headlineBR(results);
                var colorClass = getBRColorClass(br);

                // Among active scenarios, does any outcome differ from the headline?
                var activeKeys = activeScenarioKeys();
                var headOutcome = brOutcome(br);
                var differs = false;
                for (var sk = 0; sk < activeKeys.length; sk++) {
                    if (brOutcome(results[activeKeys[sk]].battleRating) !== headOutcome) { differs = true; break; }
                }

                var cellContent = '<span class="br-main">' + br + '</span>';
                if (differs) {
                    cellContent += '<span class="shield-grid">';
                    for (var row = 0; row < 3; row++) {
                        for (var col = 0; col < 3; col++) {
                            var key = row + 'v' + col;
                            var sBR = results[key].battleRating;
                            var dotClass = sBR === 500 ? 'tie' : (sBR > 500 ? 'win' : 'loss');
                            if (!state.activeScenarios[key]) dotClass += ' inactive';
                            cellContent += '<span class="shield-dot ' + dotClass + '" title="' + key + ': ' + sBR + '"></span>';
                        }
                    }
                    cellContent += '</span>';
                }

                // Expanded view: 3x3 table with all BRs
                cellContent += '<span class="shield-expanded">';
                cellContent += '<span class="shield-expanded-grid">';
                cellContent += '<span class="seg-header"></span><span class="seg-header">0s</span><span class="seg-header">1s</span><span class="seg-header">2s</span>';
                for (var row = 0; row < 3; row++) {
                    cellContent += '<span class="seg-header">' + row + 's</span>';
                    for (var col = 0; col < 3; col++) {
                        var key = row + 'v' + col;
                        var sBR = results[key].battleRating;
                        var sClass = sBR === 500 ? 'seg-tie' : (sBR > 500 ? 'seg-win' : 'seg-loss');
                        if (!state.activeScenarios[key]) sClass += ' inactive';
                        cellContent += '<span class="' + sClass + '">' + sBR + '</span>';
                    }
                }
                cellContent += '</span></span>';

                // Corner link into PvPoke's sim. With exactly one active scenario, use its
                // shield counts; otherwise default to 1v1.
                var linkKey = activeKeys.length === 1 ? activeKeys[0] : '1v1';
                var linkRes = results[linkKey];
                if (linkRes && linkRes.pokemon && linkRes.pokemon.length === 2) {
                    var pvpLink = buildPvpokeLink(linkRes.pokemon[0], linkRes.pokemon[1], Number(linkKey[0]), Number(linkKey[2]), state.league);
                    cellContent += '<a class="pvpoke-link" href="' + pvpLink + '" target="_blank" rel="noopener" title="Open ' + linkKey + ' in PvPoke">↗</a>';
                }

                html += '<td class="br-cell ' + colorClass + (excluded ? ' excluded' : '') + '">' + cellContent + '</td>';
            }
            tr.innerHTML = html;
            tbody.appendChild(tr);
        }

        // Cell click to expand
        var cells = tbody.querySelectorAll('.br-cell');
        for (var i = 0; i < cells.length; i++) {
            cells[i].addEventListener('click', function() { this.classList.toggle('expanded'); });
        }

        // PvPoke links open in a new tab without toggling the cell's expand state
        var pvpLinks = tbody.querySelectorAll('.pvpoke-link');
        for (var i = 0; i < pvpLinks.length; i++) {
            pvpLinks[i].addEventListener('click', function(e) { e.stopPropagation(); });
        }

        // Row header click to set reference — map filtered index back to state.candidates index
        var rowHeaders = tbody.querySelectorAll('th');
        for (var i = 0; i < rowHeaders.length; i++) {
            rowHeaders[i].addEventListener('click', (function(filteredIdx) {
                return function() {
                    var candId = candidates[filteredIdx].id;
                    var fullIdx = state.candidates.findIndex(function(c) { return c.id === candId; });
                    if (fullIdx >= 0) {
                        state.referenceIdx = fullIdx;
                        state.results.refId = candId;
                        renderMatrix(); renderDifferences(); saveState();
                    }
                };
            })(i));
        }
    }

    // The active shield scenarios the user is currently focusing on (default: all 9).
    function activeScenarioKeys() {
        var keys = SCENARIO_KEYS.filter(function(k) { return state.activeScenarios[k]; });
        return keys.length ? keys : SCENARIO_KEYS.slice();
    }

    function brOutcome(v) { return v === 500 ? 0 : (v > 500 ? 1 : -1); }

    // Which scenario(s) define the headline number: 1v1 whenever it's active (so the
    // default all-on view stays the familiar 1v1), the single active scenario when only
    // one is on, else the mean of the active set (1v1 specifically filtered out).
    function headlineKeys() {
        var keys = activeScenarioKeys();
        if (keys.length === 1) return keys;
        if (state.activeScenarios['1v1']) return ['1v1'];
        return keys;
    }

    // Representative BR for one matchup cell over the headline scenario set.
    function headlineBR(cellResults) {
        var keys = headlineKeys();
        var sum = 0;
        for (var i = 0; i < keys.length; i++) sum += cellResults[keys[i]].battleRating;
        return Math.round(sum / keys.length);
    }

    // Reduce a precomputed per-scenario map (Overall column) over the headline set.
    function reduceByScenario(byScenario) {
        var keys = headlineKeys();
        var sum = 0, n = 0;
        for (var i = 0; i < keys.length; i++) {
            if (byScenario[keys[i]] != null) { sum += byScenario[keys[i]]; n++; }
        }
        return n ? Math.round(sum / n) : null;
    }

    // Aggregate a candidate's matchups into a single "Overall" rating.
    // For each shield scenario, average the raw battle rating across non-excluded
    // threats. Headline reduces those over the active scenario set.
    function computeOverall(matrixRow, threatPokemon) {
        var byScenario = {};
        for (var sk = 0; sk < SCENARIO_KEYS.length; sk++) {
            var key = SCENARIO_KEYS[sk];
            var sum = 0, n = 0;
            for (var ti = 0; ti < matrixRow.length; ti++) {
                if (state.excludedThreats[threatPokemon[ti].threatData.speciesId]) continue;
                sum += matrixRow[ti][key].battleRating;
                n++;
            }
            byScenario[key] = n > 0 ? Math.round(sum / n) : null;
        }
        return { byScenario: byScenario, headline: reduceByScenario(byScenario) };
    }

    function getBRColorClass(br) {
        if (br >= 700) return 'win-strong';
        if (br === 500) return 'tie';
        if (br > 500) return 'win';
        if (br >= 480) return 'loss';
        if (br >= 400) return 'loss';
        return 'loss-strong';
    }

    // ============ PVPOKE DEEP LINK ============
    // Build a link into PvPoke's own 1v1 battle sim, pre-loaded with the exact
    // matchup we simulated (species, level, IVs, the moveset the sim actually used,
    // and shields). Format verified against PvPoke's generateURLPokeStr/MoveStr and
    // loadGetData parser. The "4-4-1-0" tail = neutral atk/def buffs, default bait,
    // default move timing — matching PvPoke's own defaults.
    function pvpokePokeStr(p) {
        // PvPoke keys shadows as a separate "<base>_shadow" species id — that's what
        // its own battle links use — so encode shadow into the id, not a "-shadow"
        // suffix (which the battle page doesn't reliably honor).
        var id = p.speciesId;
        if (p.shadowType === 'shadow' && id.indexOf('_shadow') === -1) {
            id += '_shadow';
        }
        return id + '-' + p.level + '-' + p.ivs.atk + '-' + p.ivs.def + '-' + p.ivs.hp + '-4-4-1-0';
    }

    function pvpokeMoveStr(p) {
        // Literal move IDs; PvPoke loads any [A-Z_]+ slot as a custom move, so we
        // don't need its per-species move-pool order. Missing 2nd charged move = "0".
        var cm = p.chargedMoves || [];
        return p.fastMove.moveId + '-' + (cm[0] ? cm[0].moveId : '0') + '-' + (cm[1] ? cm[1].moveId : '0');
    }

    function buildPvpokeLink(pa, pb, shieldsA, shieldsB, cp) {
        return 'https://pvpoke.com/battle/' + cp + '/' + pvpokePokeStr(pa) + '/' + pvpokePokeStr(pb) +
            '/' + shieldsA + shieldsB + '/' + pvpokeMoveStr(pa) + '/' + pvpokeMoveStr(pb) + '/';
    }

    // ============ DIFFERENCES ============

    // Create a diff pill with 3x3 shield scenario grid
    function createDiffPill(prefix, entry, isGain) {
        var pill = document.createElement('span');
        pill.className = 'diff-pill ' + (isGain ? 'gain' : 'loss-pill') +
            (entry.excluded ? ' excluded' : '') + (entry.priority ? ' priority' : '');

        var text = document.createElement('span');
        text.textContent = prefix + ' ' + entry.name;
        pill.appendChild(text);

        // Add 3x3 shield grid showing candidate's win/loss per scenario
        var grid = document.createElement('span');
        grid.className = 'shield-grid';
        for (var i = 0; i < 9; i++) {
            var dot = document.createElement('span');
            var cBR = entry.candResults[i];
            var dotClass = cBR === 500 ? 'tie' : (cBR > 500 ? 'win' : 'loss');
            dot.className = 'shield-dot ' + dotClass;
            if (!state.activeScenarios[SCENARIO_KEYS[i]]) dot.classList.add('inactive');
            var isFlipped = entry.flipped.indexOf(i) > -1;
            var fragile = false;
            if (isFlipped) {
                dot.classList.add('flipped');
                // Robustness of the flip: how far the resulting BR sits from the
                // 500 boundary. Near it = an IV knife-edge (hollow ring); far = solid.
                fragile = Math.abs(cBR - 500) < FRAGILE_MARGIN;
                dot.classList.add(fragile ? 'fragile' : 'robust');
            }
            var row = Math.floor(i / 3), col = i % 3;
            var outcomeLabel = cBR === 500 ? 'Tie' : (cBR > 500 ? 'Win' : 'Loss');
            dot.title = row + 'v' + col + ': ' + outcomeLabel + ' (' + cBR + ')' +
                (isFlipped ? ' (flipped' + (fragile ? ' · knife-edge' : ' · solid') + ')' : '');
            grid.appendChild(dot);
        }
        pill.appendChild(grid);

        pill.addEventListener('click', function() { toggleThreatExclusion(entry.speciesId); });
        return pill;
    }

    function renderDifferences() {
        if (!state.results) return;
        var matrix = state.results.matrix, candidates = state.results.candidates,
            candidatePokemon = state.results.candidatePokemon, threatPokemon = state.results.threatPokemon;
        var container = document.getElementById('diffContent');
        var priorityOnly = document.getElementById('diffPriorityOnly').checked;
        var hideExcluded = document.getElementById('diffHideExcluded').checked;
        // Find reference index within the filtered candidates by ID
        var refIdx = 0;
        if (state.results.refId != null) {
            for (var ri = 0; ri < candidates.length; ri++) {
                if (candidates[ri].id === state.results.refId) { refIdx = ri; break; }
            }
        }
        document.getElementById('diffRefLabel').textContent = '(vs ' + (candidates[refIdx] ? candidates[refIdx].nickname : 'Candidate 1') + ')';
        container.innerHTML = '';

        var allScenarios = SCENARIO_KEYS;

        for (var ci = 0; ci < candidatePokemon.length; ci++) {
            if (ci === refIdx) continue;
            var gains = [], losses = [];
            // Tiebreaker: mean BR delta vs reference across all scored scenarios/threats
            var sumCand = 0, sumRef = 0, cnt = 0;

            for (var ti = 0; ti < matrix[ci].length; ti++) {
                var speciesId = threatPokemon[ti].threatData.speciesId;
                var excluded = !!state.excludedThreats[speciesId];
                var priority = false;
                for (var j = 0; j < state.threats.length; j++) {
                    if (state.threats[j].speciesId === speciesId) { priority = state.threats[j].priority || false; break; }
                }
                if (priorityOnly && !priority) continue;
                if (hideExcluded && excluded) continue;

                // Check all 9 shield scenarios for flips
                var hasGain = false, hasLoss = false;
                var candResults = [];
                var refResults = [];
                var flipped = [];

                for (var si = 0; si < allScenarios.length; si++) {
                    var s = allScenarios[si];
                    var cBR = matrix[ci][ti][s].battleRating;
                    var rBR = matrix[refIdx][ti][s].battleRating;
                    // The pill grid always shows all 9 dots...
                    candResults.push(cBR);
                    refResults.push(rBR);
                    // ...but only active scenarios count as a difference / tiebreak.
                    if (!state.activeScenarios[s]) continue;
                    var cOutcome = cBR === 500 ? 0 : (cBR > 500 ? 1 : -1);
                    var rOutcome = rBR === 500 ? 0 : (rBR > 500 ? 1 : -1);
                    sumCand += cBR; sumRef += rBR; cnt++;
                    if (cOutcome > rOutcome) { hasGain = true; flipped.push(si); }
                    if (cOutcome < rOutcome) { hasLoss = true; flipped.push(si); }
                }

                if (!hasGain && !hasLoss) continue;

                var data = ns.getPokemonById(speciesId.replace('_shadow', ''));
                var shadowLabel = speciesId.indexOf('_shadow') > -1 ? ' (S)' : '';
                var entry = {
                    name: (data ? data.speciesName : speciesId) + shadowLabel,
                    speciesId: speciesId, excluded: excluded, priority: priority,
                    candResults: candResults, refResults: refResults, flipped: flipped
                };

                if (hasGain) gains.push(entry);
                if (hasLoss) losses.push(entry);
            }

            var div = document.createElement('div');
            div.className = 'diff-candidate';
            var c = candidates[ci];
            // Find the full candidate to check excluded state
            var fullCand = state.candidates.find(function(fc) { return fc.id === c.id; });
            var isExcluded = fullCand ? fullCand.excluded : false;
            if (isExcluded) div.classList.add('diff-excluded');
            var labelHtml = '<div class="diff-candidate-label">' +
                '<button class="btn-exclude diff-exclude ' + (isExcluded ? 'excluded' : 'included') + '" data-cand-id="' + c.id + '" title="' + (isExcluded ? 'Include in simulation' : 'Exclude from simulation') + '"></button> ' +
                escHtml(c.nickname) + ' (' + c.atk + '/' + c.def + '/' + c.sta + ')</div>';
            div.innerHTML = labelHtml;
            var pillsDiv = document.createElement('div');
            pillsDiv.className = 'diff-pills';

            if (gains.length === 0 && losses.length === 0) {
                var nd = '<span style="color:var(--text-dim); font-size:0.8rem">No differences</span>';
                if (cnt > 0) {
                    var delta = Math.round((sumCand - sumRef) / cnt);
                    if (delta !== 0) {
                        var refName = candidates[refIdx] ? candidates[refIdx].nickname : 'reference';
                        nd += ' <span class="diff-tiebreak ' + (delta > 0 ? 'gain' : 'loss-pill') + '">≈ ' +
                            (delta > 0 ? '+' : '') + delta + ' vs ' + escHtml(refName) + '</span>';
                    }
                }
                pillsDiv.innerHTML = nd;
                div.appendChild(pillsDiv);
                container.appendChild(div);
                continue;
            }

            gains.forEach(function(g) {
                var pill = createDiffPill('+', g, true);
                pillsDiv.appendChild(pill);
            });
            losses.forEach(function(l) {
                var pill = createDiffPill('-', l, false);
                pillsDiv.appendChild(pill);
            });
            div.appendChild(pillsDiv);
            container.appendChild(div);
        }

        if (container.children.length === 0) {
            container.innerHTML = '<div style="color:var(--text-dim); font-size:0.85rem">No differences found between candidates.</div>';
        }

        // Exclude toggle handlers in differences section
        var diffExBtns = container.querySelectorAll('.diff-exclude');
        for (var i = 0; i < diffExBtns.length; i++) {
            diffExBtns[i].addEventListener('click', function() {
                var candId = Number(this.dataset.candId);
                var cand = state.candidates.find(function(c) { return c.id === candId; });
                if (cand) {
                    // Don't allow excluding the reference
                    if (state.candidates.indexOf(cand) === state.referenceIdx) return;
                    cand.excluded = !cand.excluded;
                    renderCandidates();
                    renderDifferences();
                    saveState();
                }
            });
        }
    }

    // ============ SESSION / UTILS ============
    function clearCandidates() {
        state.candidates = [];
        state.referenceIdx = 0;
        state.nextCandidateId = 1;
        state.results = null;
        document.getElementById('matrixSection').style.display = 'none';
        document.getElementById('diffSection').style.display = 'none';
        document.getElementById('statusBar').textContent = '';
        addCandidateRow();
        saveState();
    }

    function clearSession() {
        if (!confirm('Clear all data and start fresh?')) return;
        localStorage.removeItem(STORAGE_KEY);
        location.reload();
    }

    function escHtml(s) {
        var div = document.createElement('div');
        div.textContent = s;
        return div.innerHTML;
    }

    // Abbreviate a move name like PvPoke does — take first letters of each word.
    // "Dragon Claw" -> "DrC", "Ice Beam" -> "IB", "Blast Burn" -> "BlB"
    function abbreviateMove(name) {
        if (!name) return '?';
        var words = name.split(/[\s\-]+/);
        if (words.length === 1) {
            // Single word: take first 2-3 chars
            return words[0].substring(0, 3);
        }
        // Multi-word: first 2 chars of first word + first char of remaining words
        var abbr = words[0].substring(0, 2);
        for (var i = 1; i < words.length; i++) {
            abbr += words[i].charAt(0).toUpperCase();
        }
        return abbr;
    }

    // ============ BOOT ============
    init();

})();
