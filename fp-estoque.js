/**
 * Gestão de Estoque — grelha no formato da planilha Excel (import/export).
 */
(function (g) {
    'use strict';

    const FORN_KEY = 'fp_est_fornecedores';
    const ESTOQUE_KEY = 'fp_est_estoque';
    const SAIDAS_KEY = 'fp_est_saidas';

    const DEFAULT_COLUMNS = [
        'ITEM', 'CÓDIGO', 'DESCRIÇÃO DO MATERIAL', 'UND',
        'ESTOQUE ATUAL', 'ESTOQUE MÍNIMO', 'LOCAL / SETOR',
        'FORNECEDOR', 'VALOR UNIT.', 'VALOR TOTAL', 'OBSERVAÇÕES'
    ];

    function esc(s) {
        if (typeof g.esc === 'function') return g.esc(s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function normKey(s) {
        return String(s || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    function field(id) {
        const el = g.document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    }

    function setField(id, val) {
        const el = g.document.getElementById(id);
        if (el) el.value = val == null ? '' : val;
    }

    function persist(key, val) {
        g.localStorage.setItem(key, JSON.stringify(val));
        if (typeof g.fpAfterPersistentStorageWrite === 'function') g.fpAfterPersistentStorageWrite();
    }

    function getFornecedores() {
        try {
            const arr = JSON.parse(g.localStorage.getItem(FORN_KEY) || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
    }

    function setFornecedores(arr) {
        persist(FORN_KEY, Array.isArray(arr) ? arr : []);
    }

    function getEstoqueStore() {
        try {
            const raw = JSON.parse(g.localStorage.getItem(ESTOQUE_KEY) || 'null');
            if (raw && Array.isArray(raw.columns) && Array.isArray(raw.rows)) return raw;
            if (Array.isArray(raw)) {
                return { columns: DEFAULT_COLUMNS.slice(), rows: raw, headerRow: 1, sheetName: 'Estoque' };
            }
        } catch (_) { /* ignore */ }
        return { columns: DEFAULT_COLUMNS.slice(), rows: [], headerRow: 1, sheetName: 'Estoque' };
    }

    function setEstoqueStore(store) {
        persist(ESTOQUE_KEY, store);
    }

    function getSaidas() {
        try {
            const arr = JSON.parse(g.localStorage.getItem(SAIDAS_KEY) || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch (_) { return []; }
    }

    function setSaidas(arr) {
        persist(SAIDAS_KEY, Array.isArray(arr) ? arr : []);
    }

    function newId(prefix) {
        return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    function emptyRow(columns) {
        const o = { _id: newId('est') };
        columns.forEach(function (c) { o[c] = ''; });
        return o;
    }

    function detectHeaderRow(matrix) {
        for (let r = 0; r < Math.min(matrix.length, 8); r++) {
            const row = matrix[r] || [];
            const filled = row.filter(function (c) { return String(c || '').trim() !== ''; }).length;
            if (filled >= 3) return r;
        }
        return 0;
    }

    function normalizeColumns(headers) {
        const out = [];
        const seen = {};
        (headers || []).forEach(function (h, i) {
            let label = String(h || '').trim();
            if (!label) label = 'COL_' + (i + 1);
            let key = label;
            let n = 2;
            while (seen[key]) { key = label + ' (' + n + ')'; n++; }
            seen[key] = true;
            out.push(key);
        });
        return out.length ? out : DEFAULT_COLUMNS.slice();
    }

    function parseSheetMatrix(ws) {
        if (!ws || !g.XLSX) return [];
        return g.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    }

    function importMatrixToStore(matrix, sheetName) {
        if (!matrix || !matrix.length) throw new Error('Planilha vazia.');
        const headerIdx = detectHeaderRow(matrix);
        const columns = normalizeColumns(matrix[headerIdx]);
        const rows = [];
        for (let r = headerIdx + 1; r < matrix.length; r++) {
            const line = matrix[r] || [];
            if (!line.some(function (c) { return String(c || '').trim() !== ''; })) continue;
            const row = emptyRow(columns);
            columns.forEach(function (col, ci) {
                row[col] = line[ci] != null ? String(line[ci]).trim() : '';
            });
            rows.push(row);
        }
        return { columns: columns, rows: rows, headerRow: headerIdx + 1, sheetName: sheetName || 'Estoque' };
    }

    function estoqueFindCol(columns, hints) {
        const cols = columns || [];
        for (let i = 0; i < hints.length; i++) {
            const h = normKey(hints[i]);
            const found = cols.find(function (c) {
                const nk = normKey(c);
                return nk === h || nk.indexOf(h) >= 0 || h.indexOf(nk) >= 0;
            });
            if (found) return found;
        }
        return '';
    }

    function parseNum(v) {
        if (v === '' || v == null) return 0;
        const s = String(v).replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
        const n = parseFloat(s);
        return Number.isFinite(n) ? n : 0;
    }

    function renderEstoqueToolbar() {
        const store = getEstoqueStore();
        const meta = store.sheetName ? (' · folha «' + store.sheetName + '»') : '';
        return '<div class="est-toolbar">' +
            '<button type="button" class="btn btn-success" onclick="estoqueAdicionarLinha()">+ Linha</button>' +
            '<button type="button" class="btn btn-info" onclick="estoqueSalvarGrelha()">Salvar</button>' +
            '<label class="btn" style="cursor:pointer;margin:0;">📥 Importar Excel<input type="file" accept=".xlsx,.xls,.csv" style="display:none;" onchange="estoqueImportarExcel(this)"></label>' +
            '<button type="button" class="btn" onclick="estoqueExportarExcel()">📤 Exportar Excel</button>' +
            '<input type="text" id="estFiltroGrelha" placeholder="Filtrar…" oninput="renderEstoqueGrelha()" style="min-width:180px;padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:12px;">' +
            '<span class="est-meta">' + store.rows.length + ' item(ns)' + meta + '</span>' +
            '</div>';
    }

    function renderEstoqueGrelha() {
        const wrap = g.document.getElementById('estoqueGrelhaWrap');
        if (!wrap) return;
        const store = getEstoqueStore();
        const cols = store.columns && store.columns.length ? store.columns : DEFAULT_COLUMNS.slice();
        const filtro = normKey(g.document.getElementById('estFiltroGrelha')?.value || '');
        let rows = store.rows || [];
        if (filtro) {
            rows = rows.filter(function (row) {
                return cols.some(function (c) { return normKey(row[c]).indexOf(filtro) >= 0; });
            });
        }
        const head = cols.map(function (c) {
            return '<th>' + esc(c) + '</th>';
        }).join('') + '<th class="est-col-acoes">Ações</th>';

        const body = rows.map(function (row, ri) {
            const realIdx = store.rows.indexOf(row);
            const idx = realIdx >= 0 ? realIdx : ri;
            const tds = cols.map(function (c) {
                const v = row[c] != null ? row[c] : '';
                const isNum = /estoque|qtd|quant|saldo|valor|mínim|minim/i.test(c);
                return '<td><input class="est-cell-input" data-est-row="' + idx + '" data-est-col="' + esc(c) + '" value="' + esc(v) + '" ' +
                    (isNum ? 'inputmode="decimal"' : '') + '></td>';
            }).join('');
            const alerta = estoqueLinhaAlerta(row, cols) ? ' est-row-alerta' : '';
            return '<tr class="est-data-row' + alerta + '">' + tds +
                '<td class="est-col-acoes"><button type="button" class="btn btn-danger" style="padding:2px 8px;font-size:11px;" onclick="estoqueExcluirLinha(' + idx + ')">Excluir</button></td></tr>';
        }).join('');

        wrap.innerHTML = '<div class="est-sheet-scroll"><table class="est-sheet-table"><thead><tr>' + head + '</tr></thead><tbody>' +
            (body || '<tr><td colspan="' + (cols.length + 1) + '" class="empty">Sem itens. Importe a planilha ou clique em + Linha.</td></tr>') +
            '</tbody></table></div>';
    }

    function estoqueLinhaAlerta(row, cols) {
        const cMin = estoqueFindCol(cols, ['estoque mínimo', 'minimo', 'mínimo', 'qtd minima']);
        const cAtual = estoqueFindCol(cols, ['estoque atual', 'saldo', 'quantidade', 'qtd', 'estoque']);
        if (!cMin || !cAtual) return false;
        const min = parseNum(row[cMin]);
        const atual = parseNum(row[cAtual]);
        return min > 0 && atual <= min;
    }

    function estoqueSalvarGrelha() {
        const store = getEstoqueStore();
        const inputs = g.document.querySelectorAll('#estoqueGrelhaWrap .est-cell-input');
        inputs.forEach(function (inp) {
            const ri = parseInt(inp.getAttribute('data-est-row'), 10);
            const col = inp.getAttribute('data-est-col');
            if (!Number.isFinite(ri) || !col || !store.rows[ri]) return;
            store.rows[ri][col] = inp.value;
        });
        setEstoqueStore(store);
        if (typeof g.fpSetSaveIndicator === 'function') g.fpSetSaveIndicator('Estoque salvo', 'ok');
        renderEstoqueGrelha();
    }

    function estoqueAdicionarLinha() {
        const store = getEstoqueStore();
        store.rows.unshift(emptyRow(store.columns));
        setEstoqueStore(store);
        renderEstoqueGrelha();
    }

    function estoqueExcluirLinha(idx) {
        if (!confirm('Excluir esta linha do estoque?')) return;
        const store = getEstoqueStore();
        store.rows.splice(idx, 1);
        setEstoqueStore(store);
        renderEstoqueGrelha();
    }

    function pickBestSheet(wb) {
        let best = { name: wb.SheetNames[0], rows: 0, store: null };
        (wb.SheetNames || []).forEach(function (name) {
            try {
                const matrix = parseSheetMatrix(wb.Sheets[name]);
                const store = importMatrixToStore(matrix, name);
                if (store.rows.length > best.rows) best = { name: name, rows: store.rows.length, store: store };
            } catch (_) { /* folha ignorada */ }
        });
        if (!best.store) throw new Error('Nenhuma folha com dados válidos.');
        return best;
    }

    function estoqueImportarExcel(input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function (ev) {
            try {
                if (!g.XLSX) throw new Error('Biblioteca XLSX não carregada.');
                const data = new Uint8Array(ev.target.result);
                const wb = g.XLSX.read(data, { type: 'array' });
                const picked = pickBestSheet(wb);
                setEstoqueStore(picked.store);
                alert('Importado: ' + picked.store.rows.length + ' linha(s) da folha «' + picked.name + '».');
                renderEstoqueTab();
            } catch (e) {
                alert('Erro ao importar: ' + (e && e.message ? e.message : e));
            } finally {
                input.value = '';
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function estoqueExportarExcel() {
        if (!g.XLSX) { alert('Biblioteca XLSX não disponível.'); return; }
        const store = getEstoqueStore();
        const cols = store.columns || DEFAULT_COLUMNS;
        const aoa = [cols.slice()];
        (store.rows || []).forEach(function (row) {
            aoa.push(cols.map(function (c) { return row[c] != null ? row[c] : ''; }));
        });
        const ws = g.XLSX.utils.aoa_to_sheet(aoa);
        const wb = g.XLSX.utils.book_new();
        g.XLSX.utils.book_append_sheet(wb, ws, store.sheetName || 'Estoque');
        g.XLSX.writeFile(wb, 'Controle_Estoque_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    }

    function estoquePathHintText() {
        if (g.FP_ESTOQUE_XLSX_PATH_HINT) return g.FP_ESTOQUE_XLSX_PATH_HINT;
        if (g.FP_ESTOQUE_XLSX_DIR && g.FP_ESTOQUE_XLSX_NAME) return g.FP_ESTOQUE_XLSX_DIR + '\\' + g.FP_ESTOQUE_XLSX_NAME;
        return '';
    }

    function renderEstoqueTab() {
        const root = g.document.getElementById('est-estoque');
        if (!root) return;
        const pathEl = g.document.getElementById('estoquePathHint');
        const hint = estoquePathHintText();
        if (pathEl) pathEl.textContent = hint ? ('Planilha na rede: ' + hint) : '';
        const toolbarHost = g.document.getElementById('estoqueToolbarHost');
        const grelhaHost = g.document.getElementById('estoqueGrelhaWrap');
        if (toolbarHost) toolbarHost.innerHTML = renderEstoqueToolbar();
        if (grelhaHost) renderEstoqueGrelha();
    }

    /* ——— Fornecedores ——— */
    function limparFormFornecedor() {
        setField('estFornEditId', '');
        ['estFornRazao', 'estFornFantasia', 'estFornCnpj', 'estFornContato', 'estFornTel', 'estFornEmail', 'estFornObs'].forEach(function (id) { setField(id, ''); });
    }

    function salvarFornecedor() {
        const razao = field('estFornRazao');
        if (!razao) { alert('Informe a razão social.'); return; }
        const item = {
            id: field('estFornEditId') || newId('forn'),
            razao: razao,
            fantasia: field('estFornFantasia'),
            cnpj: field('estFornCnpj'),
            contato: field('estFornContato'),
            telefone: field('estFornTel'),
            email: field('estFornEmail'),
            obs: field('estFornObs'),
            atualizadoEm: new Date().toISOString()
        };
        const arr = getFornecedores();
        const idx = arr.findIndex(function (x) { return x.id === item.id; });
        if (idx >= 0) arr[idx] = item; else arr.unshift(item);
        setFornecedores(arr);
        limparFormFornecedor();
        renderFornecedoresLista();
        refreshEstoqueFornecedorSelects();
    }

    function editarFornecedor(id) {
        const row = getFornecedores().find(function (x) { return x.id === id; });
        if (!row) return;
        setField('estFornEditId', row.id);
        setField('estFornRazao', row.razao);
        setField('estFornFantasia', row.fantasia);
        setField('estFornCnpj', row.cnpj);
        setField('estFornContato', row.contato);
        setField('estFornTel', row.telefone);
        setField('estFornEmail', row.email);
        setField('estFornObs', row.obs);
    }

    function excluirFornecedor(id) {
        if (!confirm('Excluir este fornecedor?')) return;
        setFornecedores(getFornecedores().filter(function (x) { return x.id !== id; }));
        renderFornecedoresLista();
        refreshEstoqueFornecedorSelects();
    }

    function renderFornecedoresLista() {
        const el = g.document.getElementById('estFornecedoresLista');
        if (!el) return;
        const arr = getFornecedores();
        if (!arr.length) { el.innerHTML = '<div class="empty">Nenhum fornecedor cadastrado.</div>'; return; }
        el.innerHTML = '<table><thead><tr><th>Razão social</th><th>CNPJ</th><th>Contato</th><th>Telefone</th><th>E-mail</th><th>Ações</th></tr></thead><tbody>' +
            arr.map(function (f) {
                return '<tr><td>' + esc(f.razao) + '</td><td>' + esc(f.cnpj || '—') + '</td><td>' + esc(f.contato || '—') + '</td>' +
                    '<td>' + esc(f.telefone || '—') + '</td><td>' + esc(f.email || '—') + '</td>' +
                    '<td style="white-space:nowrap;"><button type="button" class="btn" style="padding:2px 8px;font-size:11px;" onclick="editarFornecedor(\'' + esc(f.id) + '\')">Editar</button> ' +
                    '<button type="button" class="btn btn-danger" style="padding:2px 8px;font-size:11px;" onclick="excluirFornecedor(\'' + esc(f.id) + '\')">Excluir</button></td></tr>';
            }).join('') + '</tbody></table>';
    }

    function renderFornecedoresTab() {
        renderFornecedoresLista();
        refreshEstoqueFornecedorSelects();
    }

    function refreshEstoqueFornecedorSelects() {
        const forn = getFornecedores();
        const opts = '<option value="">—</option>' + forn.map(function (f) {
            return '<option value="' + esc(f.razao) + '">' + esc(f.razao) + '</option>';
        }).join('');
        const sel = g.document.getElementById('estSaidaFornecedor');
        if (sel) sel.innerHTML = opts;
    }

    function refreshEstoqueMaterialSelect() {
        const sel = g.document.getElementById('estSaidaMaterial');
        if (!sel) return;
        const store = getEstoqueStore();
        const cols = store.columns || [];
        const cCod = estoqueFindCol(cols, ['código', 'codigo', 'cod']);
        const cDesc = estoqueFindCol(cols, ['descrição', 'descricao', 'material', 'produto', 'item']);
        const cAtual = estoqueFindCol(cols, ['estoque atual', 'saldo', 'quantidade', 'qtd']);
        const opts = ['<option value="">Selecione o material</option>'];
        (store.rows || []).forEach(function (row, i) {
            const cod = cCod ? row[cCod] : '';
            const desc = cDesc ? row[cDesc] : '';
            const label = [cod, desc].filter(Boolean).join(' — ') || ('Linha ' + (i + 1));
            const saldo = cAtual ? row[cAtual] : '';
            opts.push('<option value="' + i + '">' + esc(label) + (saldo ? ' (saldo: ' + saldo + ')' : '') + '</option>');
        });
        sel.innerHTML = opts.join('');
    }

    /* ——— Saídas ——— */
    function limparFormSaida() {
        setField('estSaidaEditId', '');
        setField('estSaidaData', new Date().toISOString().slice(0, 10));
        setField('estSaidaQtd', '');
        setField('estSaidaUnidade', '');
        setField('estSaidaSolicitante', '');
        setField('estSaidaMotivo', '');
        const m = g.document.getElementById('estSaidaMaterial');
        if (m) m.value = '';
    }

    function salvarSaidaMaterial() {
        const rowIdx = parseInt(field('estSaidaMaterial'), 10);
        const qtd = parseNum(field('estSaidaQtd'));
        const data = field('estSaidaData');
        if (!Number.isFinite(rowIdx) || rowIdx < 0) { alert('Selecione o material.'); return; }
        if (qtd <= 0) { alert('Informe a quantidade.'); return; }
        if (!data) { alert('Informe a data.'); return; }

        const store = getEstoqueStore();
        const row = store.rows[rowIdx];
        if (!row) { alert('Material não encontrado.'); return; }
        const cols = store.columns || [];
        const cCod = estoqueFindCol(cols, ['código', 'codigo']);
        const cDesc = estoqueFindCol(cols, ['descrição', 'descricao', 'material']);
        const cAtual = estoqueFindCol(cols, ['estoque atual', 'saldo', 'quantidade', 'qtd', 'estoque']);
        const cSaida = estoqueFindCol(cols, ['saídas', 'saidas', 'saida']);

        const saldoAntes = cAtual ? parseNum(row[cAtual]) : 0;
        if (cAtual && saldoAntes < qtd) {
            if (!confirm('Saldo atual (' + saldoAntes + ') é menor que a saída (' + qtd + '). Continuar mesmo assim?')) return;
        }
        if (cAtual) row[cAtual] = String(Math.max(0, saldoAntes - qtd));
        if (cSaida) row[cSaida] = String(parseNum(row[cSaida]) + qtd);

        const saida = {
            id: field('estSaidaEditId') || newId('sai'),
            data: data,
            rowIdx: rowIdx,
            codigo: cCod ? row[cCod] : '',
            material: cDesc ? row[cDesc] : '',
            qtd: qtd,
            unidade: field('estSaidaUnidade'),
            solicitante: field('estSaidaSolicitante'),
            motivo: field('estSaidaMotivo'),
            criadoEm: new Date().toISOString()
        };
        const arr = getSaidas();
        const editId = field('estSaidaEditId');
        if (editId) {
            const ix = arr.findIndex(function (x) { return x.id === editId; });
            if (ix >= 0) arr[ix] = saida; else arr.unshift(saida);
        } else {
            arr.unshift(saida);
        }
        setEstoqueStore(store);
        setSaidas(arr);
        limparFormSaida();
        renderSaidasLista();
        renderEstoqueGrelha();
        alert('Saída registada e estoque atualizado.');
    }

    function renderSaidasLista() {
        const el = g.document.getElementById('estSaidasLista');
        if (!el) return;
        const arr = getSaidas();
        if (!arr.length) { el.innerHTML = '<div class="empty">Nenhuma saída registada.</div>'; return; }
        el.innerHTML = '<table><thead><tr><th>Data</th><th>Código</th><th>Material</th><th>Qtd</th><th>Unidade</th><th>Solicitante</th><th>Motivo</th></tr></thead><tbody>' +
            arr.map(function (s) {
                return '<tr><td>' + esc(s.data) + '</td><td>' + esc(s.codigo || '—') + '</td><td>' + esc(s.material || '—') + '</td>' +
                    '<td>' + esc(s.qtd) + '</td><td>' + esc(s.unidade || '—') + '</td><td>' + esc(s.solicitante || '—') + '</td><td>' + esc(s.motivo || '—') + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    function renderSaidaTab() {
        if (!field('estSaidaData')) setField('estSaidaData', new Date().toISOString().slice(0, 10));
        refreshEstoqueMaterialSelect();
        refreshUnidadesSaidaSelect();
        renderSaidasLista();
    }

    function refreshUnidadesSaidaSelect() {
        const sel = g.document.getElementById('estSaidaUnidade');
        if (!sel) return;
        let unis = [];
        if (typeof g.getUnidades === 'function') unis = g.getUnidades() || [];
        const cur = sel.value;
        sel.innerHTML = '<option value="">—</option>' + unis.map(function (u) {
            const nome = String(u.nome || u.cod || '').trim();
            return nome ? '<option value="' + esc(nome) + '">' + esc(nome) + '</option>' : '';
        }).join('');
        if (cur) sel.value = cur;
    }

    function estoqueInitModulo() {
        renderFornecedoresTab();
        renderEstoqueTab();
        renderSaidaTab();
    }

    g.estoqueInitModulo = estoqueInitModulo;
    g.renderEstoqueTab = renderEstoqueTab;
    g.renderFornecedoresTab = renderFornecedoresTab;
    g.renderSaidaTab = renderSaidaTab;
    g.renderEstoqueGrelha = renderEstoqueGrelha;
    g.estoqueSalvarGrelha = estoqueSalvarGrelha;
    g.estoqueAdicionarLinha = estoqueAdicionarLinha;
    g.estoqueExcluirLinha = estoqueExcluirLinha;
    g.estoqueImportarExcel = estoqueImportarExcel;
    g.estoqueExportarExcel = estoqueExportarExcel;
    g.salvarFornecedor = salvarFornecedor;
    g.limparFormFornecedor = limparFormFornecedor;
    g.editarFornecedor = editarFornecedor;
    g.excluirFornecedor = excluirFornecedor;
    g.salvarSaidaMaterial = salvarSaidaMaterial;
    g.limparFormSaida = limparFormSaida;
    g.getEstoqueStore = getEstoqueStore;
})(typeof window !== 'undefined' ? window : globalThis);
