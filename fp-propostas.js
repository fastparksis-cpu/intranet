/**
 * Módulo Propostas — cadastro de local + PDF/PPTX a partir do modelo FastPark.
 * No PowerPoint, use marcadores: {{NUMERO}} {{DATA}} {{CLIENTE}} {{LOCAL}} {{ENDERECO}}
 * {{BAIRRO}} {{CIDADE}} {{UF}} {{CEP}} {{CONTATO}} {{EMAIL}} {{TELEFONE}}
 * {{VAGAS_CARRO}} {{VAGAS_MOTO}} {{VALOR_MENSAL}} {{VALOR_IMPLANTACAO}} {{PRAZO}}
 * {{VALIDADE}} {{OBSERVACOES}} {{CONSULTOR}}
 */
(function (g) {
    'use strict';

    const PROPOSTAS_KEY = 'fp_propostas_v1';
    const PROPOSTA_MODELO_IDB_KEY = 'fp_proposta_modelo_pptx_v1';
    const PROPOSTA_MODELO_HINT = (g.FP_PROPOSTA_MODELO_PATH || '\\\\192.168.0.64\\Servidor\\Propostas\\00-Modelo\\Modelo proposta Fast.pptx');

    let propostaEditId = '';

    function esc(s) {
        if (typeof g.esc === 'function') return g.esc(s);
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function fmoney(n) {
        if (typeof g.fmoney === 'function') return g.fmoney(n);
        return 'R$ ' + Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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

    function propostaEscapeXml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function getPropostas() {
        try {
            const arr = JSON.parse(g.localStorage.getItem(PROPOSTAS_KEY) || '[]');
            return Array.isArray(arr) ? arr : [];
        } catch {
            return [];
        }
    }

    function setPropostas(arr) {
        g.localStorage.setItem(PROPOSTAS_KEY, JSON.stringify(Array.isArray(arr) ? arr : []));
        if (typeof g.fpAfterPersistentStorageWrite === 'function') g.fpAfterPersistentStorageWrite();
    }

    function propostaNextNumero() {
        const y = new Date().getFullYear();
        const n = getPropostas().filter(p => String(p.numero || '').startsWith(String(y))).length + 1;
        return y + '-' + String(n).padStart(4, '0');
    }

    function propostaField(id) {
        const el = g.document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
    }

    function propostaSet(id, val) {
        const el = g.document.getElementById(id);
        if (el) el.value = val == null ? '' : val;
    }

    function propostaCollectForm() {
        return {
            numero: propostaField('propNumero'),
            dataEmissao: propostaField('propData') || todayIso(),
            cliente: propostaField('propCliente'),
            local: propostaField('propLocal'),
            endereco: propostaField('propEndereco'),
            bairro: propostaField('propBairro'),
            cidade: propostaField('propCidade'),
            uf: propostaField('propUf'),
            cep: propostaField('propCep'),
            contatoNome: propostaField('propContato'),
            contatoEmail: propostaField('propEmail'),
            contatoTelefone: propostaField('propTelefone'),
            vagasCarro: propostaField('propVagasCarro'),
            vagasMoto: propostaField('propVagasMoto'),
            valorMensal: propostaField('propValorMensal'),
            valorImplantacao: propostaField('propValorImplantacao'),
            prazoContrato: propostaField('propPrazo'),
            validadeDias: propostaField('propValidade'),
            observacoes: propostaField('propObs'),
            consultor: propostaField('propConsultor')
        };
    }

    function propostaFillForm(p) {
        if (!p) return;
        propostaSet('propNumero', p.numero || '');
        propostaSet('propData', (p.dataEmissao || '').slice(0, 10));
        propostaSet('propCliente', p.cliente || '');
        propostaSet('propLocal', p.local || '');
        propostaSet('propEndereco', p.endereco || '');
        propostaSet('propBairro', p.bairro || '');
        propostaSet('propCidade', p.cidade || '');
        propostaSet('propUf', p.uf || '');
        propostaSet('propCep', p.cep || '');
        propostaSet('propContato', p.contatoNome || '');
        propostaSet('propEmail', p.contatoEmail || '');
        propostaSet('propTelefone', p.contatoTelefone || '');
        propostaSet('propVagasCarro', p.vagasCarro || '');
        propostaSet('propVagasMoto', p.vagasMoto || '');
        propostaSet('propValorMensal', p.valorMensal || '');
        propostaSet('propValorImplantacao', p.valorImplantacao || '');
        propostaSet('propPrazo', p.prazoContrato || '');
        propostaSet('propValidade', p.validadeDias || '');
        propostaSet('propObs', p.observacoes || '');
        propostaSet('propConsultor', p.consultor || '');
    }

    function propostaPlaceholderMap(p) {
        const enderecoLinha = [p.endereco, p.bairro].filter(Boolean).join(' — ');
        const cidadeUf = [p.cidade, p.uf].filter(Boolean).join(' / ');
        const enderecoCompleto = [enderecoLinha, cidadeUf, p.cep ? 'CEP ' + p.cep : ''].filter(Boolean).join(' · ');
        return {
            '{{NUMERO}}': p.numero || '',
            '{{DATA}}': fdateIsoToBr(p.dataEmissao),
            '{{CLIENTE}}': p.cliente || '',
            '{{LOCAL}}': p.local || '',
            '{{ENDERECO}}': p.endereco || '',
            '{{BAIRRO}}': p.bairro || '',
            '{{CIDADE}}': p.cidade || '',
            '{{UF}}': p.uf || '',
            '{{CEP}}': p.cep || '',
            '{{ENDERECO_COMPLETO}}': enderecoCompleto,
            '{{CONTATO}}': p.contatoNome || '',
            '{{EMAIL}}': p.contatoEmail || '',
            '{{TELEFONE}}': p.contatoTelefone || '',
            '{{VAGAS_CARRO}}': String(p.vagasCarro || ''),
            '{{VAGAS_MOTO}}': String(p.vagasMoto || ''),
            '{{VAGAS}}': [p.vagasCarro ? p.vagasCarro + ' carro(s)' : '', p.vagasMoto ? p.vagasMoto + ' moto(s)' : ''].filter(Boolean).join(' · '),
            '{{VALOR_MENSAL}}': fmoney(Number(String(p.valorMensal || '').replace(/\./g, '').replace(',', '.')) || 0),
            '{{VALOR_IMPLANTACAO}}': fmoney(Number(String(p.valorImplantacao || '').replace(/\./g, '').replace(',', '.')) || 0),
            '{{PRAZO}}': p.prazoContrato ? p.prazoContrato + ' meses' : '',
            '{{VALIDADE}}': p.validadeDias ? p.validadeDias + ' dias' : '',
            '{{OBSERVACOES}}': p.observacoes || '',
            '{{CONSULTOR}}': p.consultor || ''
        };
    }

    g.propostaLimparForm = function () {
        propostaEditId = '';
        const hint = g.document.getElementById('propEditHint');
        if (hint) hint.style.display = 'none';
        propostaSet('propNumero', propostaNextNumero());
        propostaSet('propData', todayIso());
        ['propCliente', 'propLocal', 'propEndereco', 'propBairro', 'propCidade', 'propUf', 'propCep',
            'propContato', 'propEmail', 'propTelefone', 'propVagasCarro', 'propVagasMoto',
            'propValorMensal', 'propValorImplantacao', 'propPrazo', 'propValidade', 'propObs', 'propConsultor'
        ].forEach(id => propostaSet(id, ''));
    };

    g.salvarProposta = function () {
        const p = propostaCollectForm();
        if (!p.local && !p.cliente) {
            g.alert('Informe pelo menos o nome do local ou do cliente.');
            return;
        }
        if (!p.numero) p.numero = propostaNextNumero();
        const arr = getPropostas();
        const now = new Date().toISOString();
        if (propostaEditId) {
            const ix = arr.findIndex(x => x.id === propostaEditId);
            if (ix >= 0) arr[ix] = { ...arr[ix], ...p, updatedAt: now };
        } else {
            arr.unshift({
                id: 'PROP-' + Date.now(),
                ...p,
                createdAt: now,
                updatedAt: now
            });
        }
        setPropostas(arr);
        propostaEditId = '';
        const hint = g.document.getElementById('propEditHint');
        if (hint) hint.style.display = 'none';
        g.renderPropostasLista();
        if (typeof g.addAudit === 'function') g.addAudit('Proposta salva: ' + (p.local || p.cliente), 'action');
    };

    g.editarProposta = function (id) {
        const p = getPropostas().find(x => x.id === id);
        if (!p) return;
        propostaEditId = id;
        propostaFillForm(p);
        const hint = g.document.getElementById('propEditHint');
        if (hint) hint.style.display = '';
    };

    g.excluirProposta = function (id) {
        if (!g.confirm('Excluir esta proposta do histórico?')) return;
        setPropostas(getPropostas().filter(x => x.id !== id));
        if (propostaEditId === id) g.propostaLimparForm();
        g.renderPropostasLista();
    };

    g.renderPropostasLista = function () {
        const el = g.document.getElementById('propLista');
        if (!el) return;
        const arr = getPropostas();
        if (!arr.length) {
            el.innerHTML = '<div class="empty">Nenhuma proposta cadastrada.</div>';
            return;
        }
        el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><thead><tr style="background:var(--fp-dark,#5A5A5A);color:#fff;">' +
            '<th style="padding:8px;text-align:left;">Nº</th><th style="padding:8px;text-align:left;">Data</th><th style="padding:8px;text-align:left;">Local / Cliente</th>' +
            '<th style="padding:8px;text-align:left;">Cidade</th><th style="padding:8px;text-align:right;">Mensal</th><th style="padding:8px;text-align:center;">Ações</th></tr></thead><tbody>' +
            arr.map(p => `<tr>
                <td style="padding:6px;">${esc(p.numero)}</td>
                <td style="padding:6px;">${esc(fdateIsoToBr(p.dataEmissao))}</td>
                <td style="padding:6px;">${esc(p.local || p.cliente)}</td>
                <td style="padding:6px;">${esc(p.cidade || '')}</td>
                <td style="padding:6px;text-align:right;">${esc(fmoney(Number(String(p.valorMensal||'').replace(/\./g,'').replace(',','.'))||0))}</td>
                <td style="padding:6px;text-align:center;white-space:nowrap;">
                    <button type="button" class="btn btn-info" style="padding:2px 8px;font-size:11px;" onclick="gerarPropostaPdfId('${esc(p.id)}')">PDF</button>
                    <button type="button" class="btn" style="padding:2px 8px;font-size:11px;" onclick="gerarPropostaPptxId('${esc(p.id)}')">PPTX</button>
                    <button type="button" class="btn" style="padding:2px 8px;font-size:11px;" onclick="editarProposta('${esc(p.id)}')">Editar</button>
                    <button type="button" class="btn btn-danger" style="padding:2px 8px;font-size:11px;" onclick="excluirProposta('${esc(p.id)}')">Excluir</button>
                </td>
            </tr>`).join('') +
            '</tbody></table>';
    };

    g.renderPropostasTab = function () {
        const st = g.document.getElementById('propModeloStatus');
        if (st) {
            const has = !!g.__fpPropostaModeloLoaded;
            st.textContent = has
                ? 'Modelo PPTX carregado neste navegador.'
                : 'Modelo PPTX ainda não importado. Use o botão abaixo (arquivo: ' + PROPOSTA_MODELO_HINT + ').';
        }
        if (!propostaField('propNumero')) {
            propostaSet('propNumero', propostaNextNumero());
            propostaSet('propData', todayIso());
        }
        g.renderPropostasLista();
    };

    g.propostaImportarModeloPptx = function (input) {
        const file = input && input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async function (ev) {
            try {
                const buf = ev.target.result;
                if (typeof g.fpIdbPut === 'function') {
                    await g.fpIdbPut(PROPOSTA_MODELO_IDB_KEY, buf);
                } else {
                    g.__fpPropostaModeloBuffer = buf;
                }
                g.__fpPropostaModeloLoaded = true;
                g.renderPropostasTab();
                g.alert('Modelo PPTX importado com sucesso.');
            } catch (e) {
                console.error(e);
                g.alert('Erro ao guardar modelo: ' + (e.message || e));
            }
            input.value = '';
        };
        reader.readAsArrayBuffer(file);
    };

    async function propostaGetModeloBuffer() {
        if (g.__fpPropostaModeloBuffer) return g.__fpPropostaModeloBuffer;
        if (typeof g.fpIdbGet === 'function') {
            const b = await g.fpIdbGet(PROPOSTA_MODELO_IDB_KEY);
            if (b) {
                g.__fpPropostaModeloBuffer = b;
                g.__fpPropostaModeloLoaded = true;
                return b;
            }
        }
        return null;
    }

    async function propostaFillPptxTemplate(buffer, p) {
        const JSZip = g.JSZip;
        if (!JSZip) throw new Error('Biblioteca JSZip não carregada.');
        const map = propostaPlaceholderMap(p);
        const zip = await JSZip.loadAsync(buffer);
        const paths = Object.keys(zip.files);
        for (let i = 0; i < paths.length; i++) {
            const path = paths[i];
            if (!/\.xml$/i.test(path)) continue;
            let xml = await zip.file(path).async('string');
            let changed = false;
            Object.keys(map).forEach(ph => {
                if (xml.indexOf(ph) >= 0) {
                    xml = xml.split(ph).join(propostaEscapeXml(map[ph]));
                    changed = true;
                }
            });
            if (changed) zip.file(path, xml);
        }
        return zip.generateAsync({
            type: 'blob',
            mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        });
    }

    function propostaDownloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = g.document.createElement('a');
        a.href = url;
        a.download = filename;
        g.document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    function propostaResolve(pOrNull) {
        if (pOrNull && typeof pOrNull === 'object') return pOrNull;
        if (typeof pOrNull === 'string') {
            const found = getPropostas().find(x => x.id === pOrNull);
            if (found) return found;
        }
        return propostaCollectForm();
    }

    g.gerarPropostaPdfId = function (id) {
        const p = getPropostas().find(x => x.id === id);
        if (p) g.gerarPropostaPdf(p);
    };

    g.gerarPropostaPptxId = function (id) {
        const p = getPropostas().find(x => x.id === id);
        if (p) g.gerarPropostaPptx(p);
    };

    g.gerarPropostaPdf = function (pIn) {
        const p = propostaResolve(pIn);
        if (!p.local && !p.cliente) {
            g.alert('Preencha os dados da proposta antes de gerar o PDF.');
            return;
        }
        const { jsPDF } = g.jspdf || {};
        if (!jsPDF) {
            g.alert('Biblioteca jsPDF indisponível.');
            return;
        }
        const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        const W = 297;
        const H = 210;
        const margin = 14;

        doc.setFillColor(90, 90, 90);
        doc.rect(0, 0, W, 28, 'F');
        doc.setFillColor(255, 140, 0);
        doc.rect(0, 28, W, 3, 'F');
        doc.setTextColor(255, 255, 255);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(22);
        doc.text('FastPark', margin, 14);
        doc.setFontSize(11);
        doc.setFont('helvetica', 'normal');
        doc.text('Serviços de Estacionamento e Valet', margin, 21);
        doc.setFontSize(10);
        doc.text('PROPOSTA COMERCIAL', W - margin, 14, { align: 'right' });
        doc.text('Nº ' + (p.numero || '—') + '  ·  ' + fdateIsoToBr(p.dataEmissao), W - margin, 21, { align: 'right' });

        let y = 40;
        doc.setTextColor(45, 45, 45);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('Dados do local', margin, y);
        y += 7;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        const localLines = [
            ['Cliente', p.cliente || '—'],
            ['Local / Empreendimento', p.local || '—'],
            ['Endereço', [p.endereco, p.bairro].filter(Boolean).join(' — ') || '—'],
            ['Cidade / UF', [p.cidade, p.uf].filter(Boolean).join(' / ') || '—'],
            ['CEP', p.cep || '—'],
            ['Contato', [p.contatoNome, p.contatoTelefone, p.contatoEmail].filter(Boolean).join(' · ') || '—']
        ];
        localLines.forEach(row => {
            doc.setFont('helvetica', 'bold');
            doc.text(row[0] + ':', margin, y);
            doc.setFont('helvetica', 'normal');
            const lines = doc.splitTextToSize(String(row[1]), W - margin * 2 - 45);
            doc.text(lines, margin + 42, y);
            y += Math.max(6, lines.length * 5.2);
        });

        y += 4;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13);
        doc.text('Proposta comercial', margin, y);
        y += 7;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(11);
        const valM = Number(String(p.valorMensal || '').replace(/\./g, '').replace(',', '.')) || 0;
        const valI = Number(String(p.valorImplantacao || '').replace(/\./g, '').replace(',', '.')) || 0;
        const comLines = [
            ['Vagas carro', p.vagasCarro || '—'],
            ['Vagas moto', p.vagasMoto || '—'],
            ['Valor mensal', fmoney(valM)],
            ['Valor implantação', valI > 0 ? fmoney(valI) : '—'],
            ['Prazo contratual', p.prazoContrato ? p.prazoContrato + ' meses' : '—'],
            ['Validade da proposta', p.validadeDias ? p.validadeDias + ' dias' : '—'],
            ['Consultor FastPark', p.consultor || '—']
        ];
        comLines.forEach(row => {
            doc.setFont('helvetica', 'bold');
            doc.text(row[0] + ':', margin, y);
            doc.setFont('helvetica', 'normal');
            doc.text(String(row[1]), margin + 42, y);
            y += 6;
        });

        if (p.observacoes) {
            y += 4;
            doc.setFont('helvetica', 'bold');
            doc.text('Observações', margin, y);
            y += 5;
            doc.setFont('helvetica', 'normal');
            const obs = doc.splitTextToSize(p.observacoes, W - margin * 2);
            doc.text(obs, margin, y);
            y += obs.length * 5;
        }

        doc.setDrawColor(200, 200, 200);
        doc.line(margin, H - 22, W - margin, H - 22);
        doc.setFontSize(9);
        doc.setTextColor(100, 100, 100);
        doc.text('PARKX SERVIÇOS DE VALET LTDA · CNPJ 06.152.627/0001-44 · São Paulo', margin, H - 14);
        doc.text('Documento gerado em ' + new Date().toLocaleString('pt-BR'), W - margin, H - 14, { align: 'right' });

        const slug = String(p.local || p.cliente || 'proposta').replace(/[^\w\-]+/g, '_').slice(0, 40);
        doc.save('Proposta_FastPark_' + slug + '_' + String(p.numero || '').replace(/\//g, '-') + '.pdf');
        if (typeof g.addAudit === 'function') g.addAudit('PDF proposta: ' + (p.local || p.cliente), 'export');
    };

    g.gerarPropostaPptx = async function (pIn) {
        const p = propostaResolve(pIn);
        try {
            const buf = await propostaGetModeloBuffer();
            if (!buf) {
                g.alert('Importe primeiro o modelo PPTX:\n\n' + PROPOSTA_MODELO_HINT);
                return;
            }
            const blob = await propostaFillPptxTemplate(buf, p);
            const slug = String(p.local || p.cliente || 'proposta').replace(/[^\w\-]+/g, '_').slice(0, 40);
            propostaDownloadBlob(blob, 'Proposta_FastPark_' + slug + '.pptx');
            g.alert('PPTX gerado. Se o modelo não tiver os marcadores {{...}}, abra o PowerPoint e insira os campos listados na aba (texto de ajuda). Para PDF direto, use o botão Gerar PDF.');
            if (typeof g.addAudit === 'function') g.addAudit('PPTX proposta: ' + (p.local || p.cliente), 'export');
        } catch (e) {
            console.error(e);
            g.alert('Erro ao gerar PPTX: ' + (e.message || e));
        }
    };

    g.document.addEventListener('DOMContentLoaded', function () {
        propostaGetModeloBuffer().then(b => {
            if (b) g.__fpPropostaModeloLoaded = true;
        }).catch(() => {});
    });

})(typeof window !== 'undefined' ? window : globalThis);
