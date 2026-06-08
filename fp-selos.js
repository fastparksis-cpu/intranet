/**
 * Módulo Selos — geração de selos em PDF (layout tipo Itaú) com marca d'água FastPark.
 */
(function (g) {
    'use strict';

    const SELOS_KEY = 'fp_selos_lotes_v1';
    const SELOS_SERIAL_KEY = 'fp_selos_serial_counter_v1';
    const SELO_CHECK_ALPHABET = 'TMCYPSWDIUXNJBFGRZQAHOKVEL';
    const SELO_DEFAULT_SERIAL = 11136224;

    const SELO_VALIDADE_OPTS = [
        'Meia hora',
        '1 Hora',
        '12 Horas',
        '24 Horas',
        'Evento 12 Horas',
        'Convênio 12 Horas',
        'Hóspede 24 Horas',
        'Preço único'
    ];

    let seloEditId = '';
    let seloLogoCache = null;
    let seloPendingSelos = null;

    function esc(s) {
        if (typeof g.esc === 'function') return g.esc(s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fdateIsoToBr(iso) {
        if (!iso) return '';
        const p = String(iso).slice(0, 10).split('-');
        if (p.length !== 3) return String(iso);
        return p[2] + '/' + p[1] + '/' + p[0];
    }

    function todayIso() {
        return new Date().toISOString().slice(0, 10);
    }

    function seloField(id) {
        const el = g.document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    }

    function seloSet(id, val) {
        const el = g.document.getElementById(id);
        if (el) el.value = val == null ? '' : val;
    }

    function getSelosLotes() {
        try {
            const arr = JSON.parse(g.localStorage.getItem(SELOS_KEY) || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    function setSelosLotes(arr) {
        g.localStorage.setItem(SELOS_KEY, JSON.stringify(Array.isArray(arr) ? arr : []));
        if (typeof g.fpAfterPersistentStorageWrite === 'function') g.fpAfterPersistentStorageWrite();
    }

    function getSelosSerialCounter() {
        try {
            const n = parseInt(g.localStorage.getItem(SELOS_SERIAL_KEY) || '', 10);
            return Number.isFinite(n) && n > 0 ? n : SELO_DEFAULT_SERIAL;
        } catch {
            return SELO_DEFAULT_SERIAL;
        }
    }

    function setSelosSerialCounter(n) {
        g.localStorage.setItem(SELOS_SERIAL_KEY, String(Math.max(1, Math.floor(n))));
        if (typeof g.fpAfterPersistentStorageWrite === 'function') g.fpAfterPersistentStorageWrite();
    }

    function seloCheckLetter(serial) {
        const last2 = Math.abs(parseInt(String(serial), 10) || 0) % 100;
        const idx = ((last2 - 24) % 26 + 26) % 26;
        return SELO_CHECK_ALPHABET[idx] || 'T';
    }

    function encodeSeloMiddle(counter) {
        let n = Math.max(0, Math.floor(counter));
        let s = '';
        for (let i = 0; i < 6; i++) {
            s = String.fromCharCode(97 + (n % 26)) + s;
            n = Math.floor(n / 26);
        }
        return s;
    }

    function normalizeUnitCode(cod) {
        const digits = String(cod || '').replace(/\D/g, '');
        if (digits.length >= 6) return digits.slice(-6);
        if (digits.length) return digits.padStart(6, '0');
        return '000111';
    }

    function buildSeloCodigo(unitCod, serial, middleCounter) {
        const unit = normalizeUnitCode(unitCod);
        const mid = encodeSeloMiddle(middleCounter);
        const ser = String(serial).padStart(8, '0');
        const chk = seloCheckLetter(serial);
        return '#!' + unit + '-' + mid + '!' + ser + chk;
    }

    function getUnidadesList() {
        if (typeof g.getUnidades === 'function') return g.getUnidades() || [];
        try {
            const arr = JSON.parse(g.localStorage.getItem('fp_unidades') || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    function resolveUnidadeFromForm() {
        const idx = parseInt(seloField('seloUnidadeIdx'), 10);
        const arr = getUnidadesList();
        if (Number.isFinite(idx) && idx >= 0 && arr[idx]) return arr[idx];
        const nome = seloField('seloUnidadeNome');
        if (nome) return arr.find(u => String(u.nome || '').trim() === nome) || { nome: nome, cod: '' };
        return null;
    }

    function seloCollectForm() {
        const u = resolveUnidadeFromForm();
        return {
            empresa: seloField('seloEmpresa'),
            validade: seloField('seloValidade') || '1 Hora',
            quantidade: Math.max(1, parseInt(seloField('seloQuantidade'), 10) || 1),
            unidadeIdx: seloField('seloUnidadeIdx'),
            unidadeNome: u ? String(u.nome || '').trim() : seloField('seloUnidadeNome'),
            unidadeCod: u ? String(u.cod || '').trim() : '',
            observacoes: seloField('seloObs'),
            dataEmissao: seloField('seloData') || todayIso()
        };
    }

    function generateSelosForLote(lote) {
        const qty = Math.max(1, parseInt(lote.quantidade, 10) || 1);
        let serial = getSelosSerialCounter();
        const unitCod = lote.unidadeCod || normalizeUnitCode(lote.unidadeNome);
        const selos = [];
        for (let i = 0; i < qty; i++) {
            const codigo = buildSeloCodigo(unitCod, serial, serial);
            selos.push({
                codigo: codigo,
                serial: serial,
                empresa: lote.empresa,
                validade: lote.validade,
                unidadeNome: lote.unidadeNome,
                unidadeCod: unitCod
            });
            serial += 1;
        }
        setSelosSerialCounter(serial);
        return selos;
    }

    function loadFpLogoForPdf() {
        if (seloLogoCache) return Promise.resolve(seloLogoCache);
        const url = typeof g.fpLogoUrl === 'function' ? g.fpLogoUrl() : 'Design sem nome.png';
        return new Promise(function (resolve) {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () {
                try {
                    const c = g.document.createElement('canvas');
                    c.width = img.naturalWidth || img.width || 400;
                    c.height = img.naturalHeight || img.height || 120;
                    const ctx = c.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    seloLogoCache = c.toDataURL('image/png');
                    resolve(seloLogoCache);
                } catch (e) {
                    console.warn('[FP Selos] logo canvas', e);
                    resolve(null);
                }
            };
            img.onerror = function () {
                console.warn('[FP Selos] logo não carregada:', url);
                resolve(null);
            };
            img.src = url;
        });
    }

    function seloBarcodeDataUrl(codigo) {
        if (!g.JsBarcode) return null;
        const text = String(codigo || '').trim();
        if (!text) return null;
        try {
            const canvas = g.document.createElement('canvas');
            g.JsBarcode(canvas, text, {
                format: 'CODE128',
                width: 1,
                height: 36,
                displayValue: false,
                margin: 1,
                background: '#ffffff',
                lineColor: '#000000'
            });
            return canvas.toDataURL('image/png');
        } catch (e) {
            console.warn('[FP Selos] barcode', text, e);
            return null;
        }
    }

    function preloadSelosBarcodes(selos) {
        const map = new Map();
        (selos || []).forEach(function (selo) {
            const k = String(selo.codigo || '');
            if (!k || map.has(k)) return;
            const img = seloBarcodeDataUrl(k);
            if (img) map.set(k, img);
        });
        return map;
    }

    function drawSeloWatermark(doc, logoData, cx, cy, w, h) {
        if (!logoData) return;
        const lw = w * 0.72;
        const lh = h * 0.55;
        const lx = cx - lw / 2;
        const ly = cy - lh / 2;
        try {
            if (typeof doc.saveGraphicsState === 'function' && typeof doc.GState === 'function') {
                doc.saveGraphicsState();
                doc.setGState(new doc.GState({ opacity: 0.1 }));
                doc.addImage(logoData, 'PNG', lx, ly, lw, lh, undefined, 'FAST');
                doc.restoreGraphicsState();
            } else {
                doc.addImage(logoData, 'PNG', lx, ly, lw, lh);
            }
        } catch (e) {
            console.warn('[FP Selos] watermark', e);
        }
    }

    function drawSeloCell(doc, x, y, w, h, selo, logoData, barcodeData) {
        doc.setDrawColor(180, 180, 180);
        doc.setLineWidth(0.15);
        doc.setLineDashPattern([1.2, 1.2], 0);
        doc.rect(x, y, w, h);
        doc.setLineDashPattern([], 0);

        const cx = x + w / 2;
        drawSeloWatermark(doc, logoData, cx, y + h * 0.52, w, h);

        const pad = 1;
        let ty = y + pad + 2.2;
        const maxW = w - pad * 2;
        const bottom = y + h - pad;

        doc.setTextColor(20, 20, 20);

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(5.8);
        const empLines = doc.splitTextToSize(String(selo.empresa || '—').toUpperCase(), maxW).slice(0, 2);
        empLines.forEach(function (ln) {
            doc.text(ln, cx, ty, { align: 'center' });
            ty += 2.3;
        });

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(4.8);
        ty += 0.2;
        doc.text('Válido por', cx, ty, { align: 'center' });
        ty += 2.1;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(5.4);
        doc.text(String(selo.validade || '1 Hora'), cx, ty, { align: 'center' });
        ty += 2.4;

        const barH = 6.8;
        const barW = maxW * 0.92;
        const barX = cx - barW / 2;
        if (barcodeData) {
            try {
                doc.addImage(barcodeData, 'PNG', barX, ty, barW, barH, undefined, 'FAST');
            } catch (e) {
                console.warn('[FP Selos] addImage barcode', e);
            }
            ty += barH + 0.8;
        } else {
            ty += 0.5;
        }

        doc.setFont('courier', 'bold');
        doc.setFontSize(4.6);
        const codText = String(selo.codigo || '');
        const codLines = doc.splitTextToSize(codText, maxW).slice(0, 2);
        codLines.forEach(function (ln) {
            if (ty > bottom - 7) return;
            doc.text(ln, cx, ty, { align: 'center' });
            ty += 2.1;
        });

        ty = Math.max(ty + 0.4, bottom - 6.2);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(5.8);
        doc.text('FAST PARK', cx, ty, { align: 'center' });
        ty += 2.4;

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(5);
        const uniLines = doc.splitTextToSize(String(selo.unidadeNome || '—'), maxW).slice(0, 2);
        uniLines.forEach(function (ln) {
            if (ty > bottom - 0.5) return;
            doc.text(ln, cx, ty, { align: 'center' });
            ty += 2.1;
        });
    }

    async function gerarPdfSelosInternal(lote, download) {
        if (!lote || !String(lote.empresa || '').trim()) {
            g.alert('Informe a empresa compradora dos selos.');
            return null;
        }
        if (!String(lote.unidadeNome || '').trim()) {
            g.alert('Selecione a unidade FastPark.');
            return null;
        }
        const { jsPDF } = g.jspdf || {};
        if (!jsPDF) {
            g.alert('Biblioteca jsPDF indisponível.');
            return null;
        }

        const selos = Array.isArray(lote.selos) && lote.selos.length
            ? lote.selos
            : generateSelosForLote(lote);

        const logoData = await loadFpLogoForPdf();
        const barcodeMap = preloadSelosBarcodes(selos);
        if (!g.JsBarcode) {
            g.alert('Biblioteca de código de barras não carregada. Verifique a ligação à internet e atualize a página (Ctrl+F5).');
        } else if (barcodeMap.size === 0 && selos.length) {
            console.warn('[FP Selos] nenhum código de barras gerado');
        }
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageW = 210;
        const pageH = 297;
        const marginX = 5;
        const marginY = 5;
        const cols = 4;
        const rows = 14;
        const gapX = 1.5;
        const gapY = 1.2;
        const cellW = (pageW - marginX * 2 - gapX * (cols - 1)) / cols;
        const cellH = (pageH - marginY * 2 - gapY * (rows - 1)) / rows;
        const perPage = cols * rows;

        selos.forEach(function (selo, i) {
            if (i > 0 && i % perPage === 0) doc.addPage();
            const pageIdx = i % perPage;
            const col = pageIdx % cols;
            const row = Math.floor(pageIdx / cols);
            const x = marginX + col * (cellW + gapX);
            const y = marginY + row * (cellH + gapY);
            drawSeloCell(doc, x, y, cellW, cellH, selo, logoData, barcodeMap.get(String(selo.codigo || '')) || null);
        });

        const fname = 'Selos_' + String(lote.empresa || 'cliente').replace(/\W+/g, '_').slice(0, 40) +
            '_' + String(lote.unidadeNome || '').replace(/\W+/g, '_').slice(0, 30) +
            '_' + new Date().toISOString().slice(0, 10) + '.pdf';

        if (download !== false) doc.save(fname);

        if (typeof g.addAudit === 'function') {
            g.addAudit('PDF selos — ' + (lote.empresa || '') + ' (' + selos.length + ')', 'action');
        }

        return { doc: doc, selos: selos, filename: fname };
    }

    function fillSeloUnidadeSelect() {
        const sel = g.document.getElementById('seloUnidadeIdx');
        if (!sel) return;
        const cur = sel.value;
        const arr = getUnidadesList();
        let html = '<option value="">— Selecione a unidade —</option>';
        arr.forEach(function (u, i) {
            const nome = String(u.nome || '').trim();
            if (!nome) return;
            html += '<option value="' + i + '">' + esc(nome) + (u.cod ? ' (' + esc(u.cod) + ')' : '') + '</option>';
        });
        sel.innerHTML = html;
        if (cur && [...sel.options].some(function (o) { return o.value === cur; })) sel.value = cur;
    }

    function fillSeloValidadeSelect() {
        const sel = g.document.getElementById('seloValidade');
        if (!sel || sel.options.length > 1) return;
        sel.innerHTML = SELO_VALIDADE_OPTS.map(function (v) {
            return '<option value="' + esc(v) + '">' + esc(v) + '</option>';
        }).join('');
        if (!sel.value) sel.value = '1 Hora';
    }

    g.seloLimparForm = function () {
        seloEditId = '';
        seloPendingSelos = null;
        ['seloEmpresa', 'seloObs'].forEach(function (id) { seloSet(id, ''); });
        seloSet('seloQuantidade', '50');
        seloSet('seloData', todayIso());
        seloSet('seloValidade', '1 Hora');
        seloSet('seloUnidadeIdx', '');
        const hint = g.document.getElementById('seloEditHint');
        if (hint) hint.style.display = 'none';
        const serialEl = g.document.getElementById('seloProximoSerial');
        if (serialEl) serialEl.textContent = String(getSelosSerialCounter());
    };

    g.salvarLoteSelos = function () {
        const form = seloCollectForm();
        if (!form.empresa) {
            g.alert('Informe a empresa compradora.');
            return;
        }
        if (!form.unidadeNome) {
            g.alert('Selecione a unidade.');
            return;
        }
        let selos = seloPendingSelos;
        const prev = seloEditId ? getSelosLotes().find(function (x) { return x.id === seloEditId; }) : null;
        const prevQty = prev ? (prev.selos?.length || prev.quantidade || 0) : 0;
        if (selos && selos.length === form.quantidade && String(selos[0]?.empresa || '') === form.empresa) {
            /* reutiliza códigos gerados pelo PDF nesta sessão */
        } else if (prev && prev.selos && prev.selos.length === form.quantidade &&
            prev.empresa === form.empresa && prev.validade === form.validade &&
            prev.unidadeNome === form.unidadeNome) {
            selos = prev.selos;
        } else {
            selos = generateSelosForLote(form);
        }
        seloPendingSelos = selos;
        const lote = Object.assign({}, form, {
            id: seloEditId || ('selo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)),
            criadoEm: new Date().toISOString(),
            selos: selos,
            pdfGeradoEm: null
        });
        const arr = getSelosLotes();
        const ix = arr.findIndex(function (x) { return x.id === lote.id; });
        if (ix >= 0) arr[ix] = lote;
        else arr.unshift(lote);
        setSelosLotes(arr);
        seloEditId = lote.id;
        const hint = g.document.getElementById('seloEditHint');
        if (hint) hint.style.display = '';
        g.renderSelosLista();
        g.alert('Lote salvo com ' + selos.length + ' selo(s). Próximo serial: ' + getSelosSerialCounter() + '.');
        const serialEl = g.document.getElementById('seloProximoSerial');
        if (serialEl) serialEl.textContent = String(getSelosSerialCounter());
    };

    g.gerarPdfSelos = async function (loteIn) {
        let lote = loteIn;
        if (!lote || typeof lote !== 'object') {
            lote = seloCollectForm();
            if (seloEditId) {
                const saved = getSelosLotes().find(function (x) { return x.id === seloEditId; });
                if (saved && saved.selos && saved.selos.length) lote.selos = saved.selos;
            }
        }
        const result = await gerarPdfSelosInternal(lote, true);
        if (!result) return;
        seloPendingSelos = result.selos;
        if (seloEditId || lote.id) {
            const id = lote.id || seloEditId;
            const arr = getSelosLotes();
            const ix = arr.findIndex(function (x) { return x.id === id; });
            if (ix >= 0) {
                arr[ix].selos = result.selos;
                arr[ix].pdfGeradoEm = new Date().toISOString();
                setSelosLotes(arr);
                g.renderSelosLista();
            }
        }
    };

    g.gerarPdfSelosId = function (id) {
        const lote = getSelosLotes().find(function (x) { return x.id === id; });
        if (!lote) {
            g.alert('Lote não encontrado.');
            return;
        }
        g.gerarPdfSelos(lote);
    };

    g.editarLoteSelos = function (id) {
        const lote = getSelosLotes().find(function (x) { return x.id === id; });
        if (!lote) return;
        seloEditId = id;
        seloSet('seloEmpresa', lote.empresa);
        seloSet('seloValidade', lote.validade || '1 Hora');
        seloSet('seloQuantidade', String(lote.quantidade || lote.selos?.length || 1));
        seloSet('seloObs', lote.observacoes || '');
        seloSet('seloData', lote.dataEmissao || todayIso());
        fillSeloUnidadeSelect();
        const arr = getUnidadesList();
        const idx = arr.findIndex(function (u) {
            return String(u.nome || '').trim() === String(lote.unidadeNome || '').trim();
        });
        seloSet('seloUnidadeIdx', idx >= 0 ? String(idx) : '');
        const hint = g.document.getElementById('seloEditHint');
        if (hint) hint.style.display = '';
        try { g.document.getElementById('selos')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
    };

    g.excluirLoteSelos = function (id) {
        if (!g.confirm('Excluir este lote do histórico?')) return;
        setSelosLotes(getSelosLotes().filter(function (x) { return x.id !== id; }));
        if (seloEditId === id) g.seloLimparForm();
        g.renderSelosLista();
    };

    g.renderSelosLista = function () {
        const el = g.document.getElementById('seloLista');
        if (!el) return;
        const arr = getSelosLotes();
        if (!arr.length) {
            el.innerHTML = '<div class="empty">Nenhum lote de selos gerado.</div>';
            return;
        }
        el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--fp-dark,#5A5A5A);color:#fff;">' +
            '<th style="padding:8px;text-align:left;">Data</th><th style="padding:8px;text-align:left;">Empresa</th>' +
            '<th style="padding:8px;text-align:left;">Unidade</th><th style="padding:8px;text-align:left;">Validade</th>' +
            '<th style="padding:8px;text-align:center;">Qtd</th><th style="padding:8px;text-align:center;">Ações</th></tr></thead><tbody>' +
            arr.map(function (l) {
                const qtd = l.selos?.length || l.quantidade || 0;
                return '<tr>' +
                    '<td style="padding:6px;">' + esc(fdateIsoToBr(String(l.criadoEm || l.dataEmissao || '').slice(0, 10))) + '</td>' +
                    '<td style="padding:6px;">' + esc(l.empresa) + '</td>' +
                    '<td style="padding:6px;">' + esc(l.unidadeNome) + '</td>' +
                    '<td style="padding:6px;">' + esc(l.validade) + '</td>' +
                    '<td style="padding:6px;text-align:center;">' + esc(qtd) + '</td>' +
                    '<td style="padding:6px;text-align:center;white-space:nowrap;">' +
                    '<button type="button" class="btn btn-fp-dark" style="padding:2px 8px;font-size:11px;" onclick="gerarPdfSelosId(\'' + esc(l.id) + '\')">PDF</button> ' +
                    '<button type="button" class="btn" style="padding:2px 8px;font-size:11px;" onclick="editarLoteSelos(\'' + esc(l.id) + '\')">Editar</button> ' +
                    '<button type="button" class="btn btn-danger" style="padding:2px 8px;font-size:11px;" onclick="excluirLoteSelos(\'' + esc(l.id) + '\')">Excluir</button>' +
                    '</td></tr>';
            }).join('') +
            '</tbody></table>';
    };

    g.renderSelosTab = function () {
        fillSeloUnidadeSelect();
        fillSeloValidadeSelect();
        if (!seloField('seloData')) seloSet('seloData', todayIso());
        if (!seloField('seloQuantidade')) seloSet('seloQuantidade', '50');
        const serialEl = g.document.getElementById('seloProximoSerial');
        if (serialEl) serialEl.textContent = String(getSelosSerialCounter());
        g.renderSelosLista();
    };

    g.FP_SELOS_KEY = SELOS_KEY;
    g.FP_SELOS_SERIAL_KEY = SELOS_SERIAL_KEY;
})(typeof window !== 'undefined' ? window : globalThis);
