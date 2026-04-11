/*
 * PvP IV Comparison Tool — Application Logic
 * Battle logic derived from PvPoke (https://github.com/pvpoke/pvpoke), MIT License
 */

(function() {
    var ns = PvPIV;

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
        nextCandidateId: 1,
    };

    var STORAGE_KEY = "pvp_iv_tool_state";

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
            nextCandidateId: state.nextCandidateId,
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
            state.nextCandidateId = s.nextCandidateId || state.candidates.length + 1;
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

            if (hadState) {
                if (state.species) {
                    document.getElementById('speciesSearch').value = state.species.speciesName;
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
                return p.released && p.speciesId.indexOf('_mega') === -1 &&
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
        var data = ns.getPokemonById(speciesId);
        if (!data) return;
        state.species = data;
        document.getElementById('speciesSearch').value = data.speciesName;
        populateMoveSelects();
        updateAllCandidateComputedFields();
        saveState();
    }

    // ============ MOVE SELECTS ============

    // Compute what auto-select would pick for a species (general, no specific opponent).
    // Fast: best DPS*EPS (damage-per-turn * energy-per-turn). Charged: best DPE (damage / energy).
    function getAutoMoves(speciesData) {
        var types = speciesData.types || [];
        var stabMult = 1.2000000476837158203125;

        // Score fast moves
        var bestFast = null, bestFastScore = -1;
        (speciesData.fastMoves || []).forEach(function(moveId) {
            var m = ns.getMoveById(moveId);
            if (!m) return;
            var stab = (m.type === types[0] || m.type === types[1]) ? stabMult : 1;
            var turns = m.cooldown / 500;
            var dps = (m.power * stab) / turns;
            var eps = m.energyGain / turns;
            var score = dps * eps;
            if (score > bestFastScore) { bestFastScore = score; bestFast = m; }
        });

        // Score charged moves — pick top 2
        var chargedScored = [];
        (speciesData.chargedMoves || []).forEach(function(moveId) {
            var m = ns.getMoveById(moveId);
            if (!m) return;
            var stab = (m.type === types[0] || m.type === types[1]) ? stabMult : 1;
            var dpe = (m.power * stab) / m.energy;
            // Buff bonus (same as initializeMove)
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
        var fm = document.getElementById('fastMoveSelect');
        var cm1 = document.getElementById('chargedMove1Select');
        var cm2 = document.getElementById('chargedMove2Select');

        // Compute auto-selected moves
        var auto = getAutoMoves(state.species);
        var autoFastName = auto.fast ? auto.fast.name : 'Auto';
        var autoCharged1Name = auto.charged1 ? auto.charged1.name : 'Auto';
        var autoCharged2Name = auto.charged2 ? auto.charged2.name : 'Auto';

        fm.innerHTML = '<option value="">' + autoFastName + ' (Auto)</option>';
        cm1.innerHTML = '<option value="">' + autoCharged1Name + ' (Auto)</option>';
        cm2.innerHTML = '<option value="">' + autoCharged2Name + ' (Auto)</option>';

        (state.species.fastMoves || []).forEach(function(moveId) {
            var move = ns.getMoveById(moveId);
            if (move) {
                var elite = (state.species.eliteMoves || []).indexOf(moveId) > -1 ? ' *' : '';
                fm.innerHTML += '<option value="' + moveId + '">' + move.name + elite + '</option>';
            }
        });

        (state.species.chargedMoves || []).forEach(function(moveId) {
            var move = ns.getMoveById(moveId);
            if (move) {
                var elite = (state.species.eliteMoves || []).indexOf(moveId) > -1 ? ' *' : '';
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

    function setupMoveSelects() {
        var handler = function() {
            var fm = document.getElementById('fastMoveSelect').value;
            var cm1 = document.getElementById('chargedMove1Select').value;
            var cm2 = document.getElementById('chargedMove2Select').value;
            state.moveOverride = (fm || cm1 || cm2) ? { fastMove: fm || null, chargedMove1: cm1 || null, chargedMove2: cm2 || null } : null;
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
            saveState();
        });
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
                document.getElementById('statusBar').textContent = 'League changed \u2014 run simulation to update results.';
                updateAllCandidateComputedFields();
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
            sta: sta === '' ? '' : Number(sta), form: form || '',
        });
        renderCandidates();
        saveState();
        var row = document.querySelector('tr[data-id="' + id + '"]');
        if (row) { var atkInput = row.querySelector('.iv-atk'); if (atkInput) atkInput.focus(); }
    }

    function renderCandidates() {
        var body = document.getElementById('candidateBody');
        body.innerHTML = '';
        state.candidates.forEach(function(c, idx) {
            var tr = document.createElement('tr');
            tr.dataset.id = c.id;
            if (idx === state.referenceIdx) tr.classList.add('reference');
            var computed = computeCandidate(c);

            tr.innerHTML =
                '<td style="text-align:center; color:var(--text-dim); font-size:0.8rem">' + (idx + 1) + '</td>' +
                '<td><input type="text" class="nickname-input" value="' + escHtml(c.nickname) + '" data-field="nickname"></td>' +
                '<td><input type="number" class="iv-input iv-atk" min="0" max="15" value="' + (c.atk === '' ? '' : c.atk) + '" data-field="atk" placeholder="0-15"></td>' +
                '<td><input type="number" class="iv-input iv-def" min="0" max="15" value="' + (c.def === '' ? '' : c.def) + '" data-field="def" placeholder="0-15"></td>' +
                '<td><input type="number" class="iv-input iv-sta" min="0" max="15" value="' + (c.sta === '' ? '' : c.sta) + '" data-field="sta" placeholder="0-15"></td>' +
                '<td><select class="form-override" data-field="form">' +
                    '<option value=""' + (c.form === '' ? ' selected' : '') + '>Inherit</option>' +
                    '<option value="normal"' + (c.form === 'normal' ? ' selected' : '') + '>Normal</option>' +
                    '<option value="shadow"' + (c.form === 'shadow' ? ' selected' : '') + '>Shadow</option>' +
                    '<option value="purified"' + (c.form === 'purified' ? ' selected' : '') + '>Purified</option>' +
                '</select></td>' +
                '<td class="computed">' + computed + '</td>' +
                '<td class="row-actions">' +
                    (getEffectiveForm(c) === 'shadow' ? '<button class="btn-purify" title="Create purified copy">Purify</button>' : '') +
                    '<button class="btn-del" title="Remove">&#x2715;</button>' +
                '</td>';
            body.appendChild(tr);
        });

        // Events
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

        // Purify buttons
        var purBtns = body.querySelectorAll('.btn-purify');
        for (var i = 0; i < purBtns.length; i++) {
            purBtns[i].addEventListener('click', function() {
                var tr = this.closest('tr');
                var id = Number(tr.dataset.id);
                var c = state.candidates.find(function(c) { return c.id === id; });
                if (c) {
                    addCandidateRow(Math.min(15, (c.atk || 0) + 2), Math.min(15, (c.def || 0) + 2),
                        Math.min(15, (c.sta || 0) + 2), 'purified', c.nickname + ' (Purified)');
                }
            });
        }

        // Click row number to set reference
        var firstCells = body.querySelectorAll('td:first-child');
        for (var i = 0; i < firstCells.length; i++) {
            firstCells[i].style.cursor = 'pointer';
            firstCells[i].addEventListener('click', function() {
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
        var data = state.species;
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
                return p.released && p.speciesId.indexOf('_mega') === -1 &&
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

    function loadMetaThreats() {
        var leagueMap = { 1500: 'great', 2500: 'ultra', 10000: 'master' };
        var league = leagueMap[state.league] || 'great';
        ns.loadMetaGroup(league).then(function(meta) {
            state.threats = meta.map(function(t) {
                return {
                    speciesId: t.speciesId, fastMove: t.fastMove, chargedMoves: t.chargedMoves || [],
                    shadowType: t.shadowType || (t.speciesId.indexOf('_shadow') > -1 ? 'shadow' : 'normal'),
                    priority: false, excluded: false,
                };
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
        document.getElementById('btnLoadMeta').addEventListener('click', loadMetaThreats);
        document.getElementById('btnClearSession').addEventListener('click', clearSession);
        document.getElementById('diffPriorityOnly').addEventListener('change', function() {
            if (state.results) renderDifferences();
        });
    }

    function runSimulation() {
        if (!state.species) { alert('Select a species first.'); return; }
        var validCandidates = state.candidates.filter(function(c) { return c.atk !== '' && c.def !== '' && c.sta !== ''; });
        if (validCandidates.length === 0) { alert('Enter at least one candidate with IVs.'); return; }
        if (state.threats.length === 0) { alert('Add threats or load meta first.'); return; }

        var statusBar = document.getElementById('statusBar');
        statusBar.textContent = 'Simulating...';
        var startTime = performance.now();
        var levelCap = getLevelCap();

        // Build candidate display info using lightweight stat calc
        var candidatePokemon = validCandidates.map(function(c) {
            var form = getEffectiveForm(c);
            var result = ns.findOptimalLevel(state.species.baseStats, c.atk, c.def, c.sta, state.league, levelCap);
            return {
                speciesId: state.species.speciesId,
                speciesName: state.species.speciesName,
                ivs: { atk: c.atk, def: c.def, hp: c.sta },
                shadowType: form,
                cp: result.cp, level: result.level, stats: result.stats,
            };
        });

        // Build threat display info
        var threatPokemon = state.threats.map(function(t) {
            var baseId = t.speciesId.replace('_shadow', '');
            var shadowType = t.shadowType || (t.speciesId.indexOf('_shadow') > -1 ? 'shadow' : 'normal');
            var data = ns.getPokemonById(baseId);
            if (!data) return null;

            // Use default IVs from gamemaster (prefer shadow-specific entry)
            var gmEntry = ns.getPokemonById(t.speciesId) || data;
            var ivs = { atk: 0, def: 0, hp: 0 };
            var key = 'cp' + state.league;
            if (gmEntry.defaultIVs && gmEntry.defaultIVs[key]) {
                var combo = gmEntry.defaultIVs[key];
                ivs = { atk: combo[1], def: combo[2], hp: combo[3] };
            }
            var result = ns.findOptimalLevel(data.baseStats, ivs.atk, ivs.def, ivs.hp, state.league, levelCap);

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

        // Run simulations using PvPoke's engine
        var matrix = [];
        var totalSims = candidatePokemon.length * threatPokemon.length * 3;

        for (var ci = 0; ci < candidatePokemon.length; ci++) {
            var row = [];
            for (var ti = 0; ti < threatPokemon.length; ti++) {
                var cand = candidatePokemon[ci];
                var threat = threatPokemon[ti];

                // Build move arrays
                var movesA = null;
                if (state.moveOverride && state.moveOverride.fastMove) {
                    movesA = [state.moveOverride.fastMove, state.moveOverride.chargedMove1, state.moveOverride.chargedMove2];
                }
                var movesB = null;
                if (threat.preferredFastMove) {
                    movesB = [threat.preferredFastMove,
                        (threat.preferredChargedMoves || [])[0] || null,
                        (threat.preferredChargedMoves || [])[1] || null];
                }

                var results = {};
                var scenarios = [[0,0],[1,1],[2,2]];
                for (var s = 0; s < scenarios.length; s++) {
                    var sKey = scenarios[s][0] + 'v' + scenarios[s][1];
                    results[sKey] = ns.simulateBattle(
                        cand.speciesId, [cand.ivs.atk, cand.ivs.def, cand.ivs.hp],
                        threat.speciesId, [threat.ivs.atk, threat.ivs.def, threat.ivs.hp],
                        scenarios[s][0], scenarios[s][1],
                        state.league, levelCap,
                        cand.shadowType, threat.shadowType,
                        movesA, movesB
                    );
                }
                row.push(results);
            }
            matrix.push(row);
        }

        state.results = { matrix: matrix, candidates: validCandidates, candidatePokemon: candidatePokemon, threatPokemon: threatPokemon };

        var elapsed = ((performance.now() - startTime) / 1000).toFixed(2);
        statusBar.textContent = totalSims + ' simulations completed in ' + elapsed + 's';

        renderMatrix();
        renderDifferences();
        document.getElementById('matrixSection').style.display = '';
        document.getElementById('diffSection').style.display = '';
    }

    // ============ MATRIX ============
    function renderMatrix() {
        if (!state.results) return;
        var matrix = state.results.matrix, candidates = state.results.candidates,
            candidatePokemon = state.results.candidatePokemon, threatPokemon = state.results.threatPokemon;

        var thead = document.getElementById('matrixHead');
        var tbody = document.getElementById('matrixBody');

        var headerHtml = '<tr><th></th><th>Wins</th>';
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

        tbody.innerHTML = '';
        for (var ci = 0; ci < candidatePokemon.length; ci++) {
            var cp = candidatePokemon[ci], c = candidates[ci];
            var tr = document.createElement('tr');
            if (ci === state.referenceIdx) tr.classList.add('reference');

            var form = getEffectiveForm(c);
            var formLabel = form === 'shadow' ? ' (S)' : form === 'purified' ? ' (P)' : '';
            var label = escHtml(c.nickname) + formLabel + '<br><span style="font-size:0.7rem;color:var(--text-dim)">' + c.atk + '/' + c.def + '/' + c.sta + ' CP' + cp.cp + ' L' + cp.level + '</span>';

            var html = '<th>' + label + '</th>';

            var wins = 0, total = 0;
            for (var ti = 0; ti < matrix[ci].length; ti++) {
                if (!state.excludedThreats[threatPokemon[ti].threatData.speciesId]) {
                    if (matrix[ci][ti]["1v1"].battleRating >= 500) wins++;
                    total++;
                }
            }
            html += '<td class="win-count">' + wins + '/' + total + '</td>';

            for (var ti = 0; ti < matrix[ci].length; ti++) {
                var results = matrix[ci][ti];
                var excluded = !!state.excludedThreats[threatPokemon[ti].threatData.speciesId];
                var br = results["1v1"].battleRating;
                var colorClass = getBRColorClass(br);
                var w0 = results["0v0"].battleRating >= 500, w1 = br >= 500, w2 = results["2v2"].battleRating >= 500;
                var differs = !(w0 === w1 && w1 === w2);

                var cellContent = '<span class="br-main">' + br + '</span>';
                if (differs) {
                    cellContent += '<span class="shield-indicator">';
                    cellContent += '<span class="shield-dot ' + (w0 ? 'win' : 'loss') + '"></span>';
                    cellContent += '<span class="shield-dot ' + (w1 ? 'win' : 'loss') + '"></span>';
                    cellContent += '<span class="shield-dot ' + (w2 ? 'win' : 'loss') + '"></span>';
                    cellContent += '</span>';
                    cellContent += '<span class="shield-expanded">0v0:' + results["0v0"].battleRating + ' 1v1:' + br + ' 2v2:' + results["2v2"].battleRating + '</span>';
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

        // Row header click to set reference
        var rowHeaders = tbody.querySelectorAll('th');
        for (var i = 0; i < rowHeaders.length; i++) {
            rowHeaders[i].addEventListener('click', (function(idx) {
                return function() {
                    state.referenceIdx = idx;
                    renderMatrix(); renderDifferences(); saveState();
                };
            })(i));
        }
    }

    function getBRColorClass(br) {
        if (br >= 700) return 'win-strong';
        if (br >= 500) return 'win';
        if (br >= 480) return 'tie';
        if (br >= 400) return 'loss';
        return 'loss-strong';
    }

    // ============ DIFFERENCES ============
    function renderDifferences() {
        if (!state.results) return;
        var matrix = state.results.matrix, candidates = state.results.candidates,
            candidatePokemon = state.results.candidatePokemon, threatPokemon = state.results.threatPokemon;
        var container = document.getElementById('diffContent');
        var priorityOnly = document.getElementById('diffPriorityOnly').checked;
        var refIdx = Math.min(state.referenceIdx, candidatePokemon.length - 1);
        document.getElementById('diffRefLabel').textContent = '(vs ' + (candidates[refIdx] ? candidates[refIdx].nickname : 'Candidate 1') + ')';
        container.innerHTML = '';

        for (var ci = 0; ci < candidatePokemon.length; ci++) {
            if (ci === refIdx) continue;
            var gains = [], losses = [];

            for (var ti = 0; ti < matrix[ci].length; ti++) {
                var speciesId = threatPokemon[ti].threatData.speciesId;
                var excluded = !!state.excludedThreats[speciesId];
                var priority = false;
                for (var j = 0; j < state.threats.length; j++) {
                    if (state.threats[j].speciesId === speciesId) { priority = state.threats[j].priority || false; break; }
                }
                if (priorityOnly && !priority) continue;

                var candWins = matrix[ci][ti]["1v1"].battleRating >= 500;
                var refWins = matrix[refIdx][ti]["1v1"].battleRating >= 500;
                if (candWins && !refWins) {
                    var data = ns.getPokemonById(speciesId.replace('_shadow', ''));
                    gains.push({ name: data ? data.speciesName : speciesId, speciesId: speciesId, excluded: excluded, priority: priority });
                } else if (!candWins && refWins) {
                    var data = ns.getPokemonById(speciesId.replace('_shadow', ''));
                    losses.push({ name: data ? data.speciesName : speciesId, speciesId: speciesId, excluded: excluded, priority: priority });
                }
            }

            if (gains.length === 0 && losses.length === 0) continue;

            var div = document.createElement('div');
            div.className = 'diff-candidate';
            var c = candidates[ci];
            div.innerHTML = '<div class="diff-candidate-label">' + escHtml(c.nickname) + ' (' + c.atk + '/' + c.def + '/' + c.sta + ')</div>';
            var pillsDiv = document.createElement('div');
            pillsDiv.className = 'diff-pills';

            gains.forEach(function(g) {
                var pill = document.createElement('span');
                pill.className = 'diff-pill gain' + (g.excluded ? ' excluded' : '') + (g.priority ? ' priority' : '');
                pill.textContent = '+ ' + g.name;
                pill.addEventListener('click', function() { toggleThreatExclusion(g.speciesId); });
                pillsDiv.appendChild(pill);
            });
            losses.forEach(function(l) {
                var pill = document.createElement('span');
                pill.className = 'diff-pill loss-pill' + (l.excluded ? ' excluded' : '') + (l.priority ? ' priority' : '');
                pill.textContent = '- ' + l.name;
                pill.addEventListener('click', function() { toggleThreatExclusion(l.speciesId); });
                pillsDiv.appendChild(pill);
            });
            div.appendChild(pillsDiv);
            container.appendChild(div);
        }

        if (container.children.length === 0) {
            container.innerHTML = '<div style="color:var(--text-dim); font-size:0.85rem">No differences found between candidates.</div>';
        }
    }

    // ============ SESSION / UTILS ============
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
