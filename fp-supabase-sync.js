/**
 * Sincronização FastPark ↔ Supabase (snapshot JSON + Storage).
 * Requer: fp-auth.js, collectFpIntranetSnapshot, applyFpEmbeddedIntranetDb
 */
(function (g) {
    'use strict';

    var BUCKET = g.FP_STORAGE_BUCKET || 'intranet-files';
    var ROW_ID = g.FP_SNAPSHOT_ROW_ID || 'main';
    var cloudTimer = null;
    var cloudRunning = false;
    var cloudPending = false;

    function clientOrThrow() {
        if (!g.fpSupabase) throw new Error('Supabase não inicializado. Faça login novamente.');
        return g.fpSupabase;
    }

    function fpCloudSetStatus(msg, isError) {
        var el = g.document.getElementById('fpCloudStatus');
        var banner = g.document.getElementById('fpCloudBanner');
        var navBar = g.document.getElementById('fpCloudNavBar');
        if (navBar) navBar.style.display = 'block';
        if (banner) {
            banner.classList.remove('fp-cloud-ok', 'fp-cloud-err', 'fp-cloud-busy');
            if (isError) banner.classList.add('fp-cloud-err');
            else if (msg && /gravando|gravar|carregar|transferir|verificar/i.test(msg)) banner.classList.add('fp-cloud-busy');
            else if (msg) banner.classList.add('fp-cloud-ok');
            if (msg) banner.textContent = msg;
        }
        if (el) el.textContent = '';
    }

    function dataUrlToBlob(dataUrl) {
        var parts = String(dataUrl).split(',');
        var header = parts[0] || '';
        var b64 = parts[1] || '';
        var mimeMatch = header.match(/:(.*?);/);
        var mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
        var bin = atob(b64);
        var arr = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        return new Blob([arr], { type: mime });
    }

    function sanitizeStoragePath(p) {
        return String(p || 'file').replace(/[^\w./\-]/g, '_').replace(/_+/g, '_').replace(/^\/+/, '');
    }

    function guessMimeFromPath(path) {
        var low = String(path).toLowerCase();
        if (low.endsWith('.pdf')) return 'application/pdf';
        if (low.endsWith('.png')) return 'image/png';
        if (low.endsWith('.jpg') || low.endsWith('.jpeg')) return 'image/jpeg';
        if (low.endsWith('.webp')) return 'image/webp';
        if (low.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        return 'application/octet-stream';
    }

    async function uploadBlob(path, blob) {
        var supa = clientOrThrow();
        path = sanitizeStoragePath(path);
        var mime = blob.type || guessMimeFromPath(path);
        if (!mime || mime === 'application/octet-stream') mime = guessMimeFromPath(path);
        var file = blob instanceof File ? blob : new File([blob], path.split('/').pop() || 'file', { type: mime });
        var res = await supa.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: mime });
        if (res.error && /mime|type|not allowed/i.test(String(res.error.message || ''))) {
            res = await supa.storage.from(BUCKET).upload(path, file, { upsert: true, contentType: 'application/octet-stream' });
        }
        if (res.error) throw res.error;
        try {
            await supa.from('intranet_files').upsert({
                storage_path: path,
                file_name: file.name,
                mime_type: mime,
                byte_size: file.size,
                uploaded_by: (await supa.auth.getUser()).data.user?.id || null
            }, { onConflict: 'storage_path' });
        } catch (metaErr) {
            console.warn('[fp-cloud] metadados intranet_files', metaErr);
        }
        return path;
    }

    async function uploadDataUrl(path, dataUrl) {
        return uploadBlob(path, dataUrlToBlob(dataUrl));
    }

    async function downloadDataUrl(path) {
        var supa = clientOrThrow();
        path = sanitizeStoragePath(path);
        var res = await supa.storage.from(BUCKET).download(path);
        if (res.error) throw res.error;
        var blob = res.data;
        var mime = blob.type || guessMimeFromPath(path);
        var buf = await blob.arrayBuffer();
        var bin = '';
        var bytes = new Uint8Array(buf);
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return 'data:' + mime + ';base64,' + btoa(bin);
    }

    async function readDiskAttachmentAsDataUrl(path) {
        if (g.__fpBridgeActive && typeof g.fpBridgeReadAttachmentAsDataUrl === 'function') {
            try {
                return await g.fpBridgeReadAttachmentAsDataUrl(path);
            } catch (e) {
                console.warn('[fp-cloud] leitura ponte', path, e);
            }
        }
        if (!g.window.__fpAttachmentsDirHandle || typeof g.fpAttReadPathAsDataUrl !== 'function') {
            return null;
        }
        try {
            return await g.fpAttReadPathAsDataUrl(g.window.__fpAttachmentsDirHandle, path);
        } catch (e) {
            console.warn('[fp-cloud] leitura disco', path, e);
            return null;
        }
    }

    function collectAttachmentRefKeys(snap) {
        var keys = new Set();
        function add(k) {
            if (k) keys.add(String(k));
        }
        (snap.state && snap.state.employees || []).forEach(function (e) {
            add(e.fotoRef);
            (e.documentos || []).forEach(function (d) { add(d && d.dataRef); });
            (e.documentosRescisao || []).forEach(function (d) { add(d && d.dataRef); });
        });
        (snap.faltasResolved || []).forEach(function (f) { add(f.anexoRef); });
        (snap.unidadesResolved || []).forEach(function (u) {
            (u.aditivos || []).forEach(function (a) { add(a.anexoRef); });
        });
        var slim = snap.pagasSignedSlim || {};
        Object.keys(slim).forEach(function (id) {
            var v = slim[id];
            if (v && v.ref) add(v.ref);
        });
        Object.keys(snap.attachments || {}).forEach(function (k) { add(k); });
        var bag = g.window.__FP_EMBEDDED_ATTACHMENTS__ || {};
        Object.keys(bag).forEach(function (k) { add(k); });
        return keys;
    }

    async function resolveAttachmentToDataUrl(key, att, bag) {
        var v = att[key];
        if (typeof v === 'string' && v.indexOf('data:') === 0) return v;
        v = bag[key];
        if (typeof v === 'string' && v.indexOf('data:') === 0) return v;
        return await readDiskAttachmentAsDataUrl(key);
    }

    async function hydrateAttachmentsForCloud(snap) {
        var att = snap.attachments || {};
        var bag = g.window.__FP_EMBEDDED_ATTACHMENTS__ || {};
        var keys = collectAttachmentRefKeys(snap);
        var hydrated = 0;
        var failed = 0;
        for (var key of keys) {
            key = sanitizeStoragePath(key);
            var cur = att[key];
            if (typeof cur === 'string' && cur.indexOf('data:') === 0) continue;
            if (cur && typeof cur === 'object' && cur.__cloud === true) continue;
            var dataUrl = await resolveAttachmentToDataUrl(key, att, bag);
            if (dataUrl) {
                att[key] = dataUrl;
                hydrated++;
            } else if (cur !== undefined) {
                failed++;
            }
        }
        snap.attachments = att;
        return { hydrated: hydrated, failed: failed };
    }

    function harvestInlineDataUrlsIntoAttachments(snap) {
        var att = snap.attachments || {};
        function put(key, dataUrl) {
            if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:') !== 0) return;
            key = sanitizeStoragePath(key);
            var cur = att[key];
            if (cur && typeof cur === 'object' && cur.__cloud === true) return;
            att[key] = dataUrl;
        }
        var emps = (snap.state && snap.state.employees) || [];
        emps.forEach(function (e, ei) {
            if (e.foto) put('colaboradores/foto/inline_' + ei, e.foto);
            (e.documentos || []).forEach(function (d, di) {
                if (d && d.dataUrl) put('colaboradores/docs/inline_' + ei + '_' + di, d.dataUrl);
            });
            (e.documentosRescisao || []).forEach(function (d, di) {
                if (d && d.dataUrl) put('colaboradores/rescisao/inline_' + ei + '_' + di, d.dataUrl);
            });
        });
        (snap.faltasResolved || []).forEach(function (f, i) {
            if (f.anexoData) put('faltas/inline_' + i, f.anexoData);
        });
        (snap.unidadesResolved || []).forEach(function (u, ui) {
            (u.aditivos || []).forEach(function (a, ai) {
                if (a.anexoData) put('unidades/aditivos/inline_' + ui + '_' + ai, a.anexoData);
            });
        });
        snap.attachments = att;
    }

    async function prepareSnapshotForCloud(snap) {
        harvestInlineDataUrlsIntoAttachments(snap);
        var hydrate = await hydrateAttachmentsForCloud(snap);
        var att = snap.attachments || {};
        var diskSkipped = hydrate.failed || 0;
        var uploaded = 0;
        var alreadyCloud = 0;
        var uploadErrors = [];
        var keys = Object.keys(att);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            var v = att[key];
            var dataUrl = null;
            if (typeof v === 'string' && v.indexOf('data:') === 0) {
                dataUrl = v;
            } else if (v && typeof v === 'object' && v.__disk === true) {
                dataUrl = await readDiskAttachmentAsDataUrl(key);
                if (!dataUrl) {
                    diskSkipped++;
                    att[key] = v;
                    continue;
                }
            } else if (v && typeof v === 'object' && v.__cloud === true) {
                alreadyCloud++;
                continue;
            }
            if (!dataUrl) continue;
            try {
                await uploadDataUrl(key, dataUrl);
                att[key] = { __cloud: true, path: key };
                uploaded++;
            } catch (upErr) {
                console.error('[fp-cloud] upload', key, upErr);
                uploadErrors.push(key + ': ' + (upErr && upErr.message ? upErr.message : upErr));
                att[key] = dataUrl;
            }
        }
        snap.attachments = att;
        return {
            uploaded: uploaded,
            diskSkipped: diskSkipped,
            alreadyCloud: alreadyCloud,
            hydrated: hydrate.hydrated,
            uploadErrors: uploadErrors
        };
    }

    g.fpResolveCloudAttachmentMarkers = async function (db) {
        if (!db || !db.attachments || typeof db.attachments !== 'object') return;
        var att = db.attachments;
        for (var key of Object.keys(att)) {
            var v = att[key];
            if (v && typeof v === 'object' && v.__cloud === true) {
                try {
                    att[key] = await downloadDataUrl(v.path || key);
                } catch (e) {
                    console.warn('[fp-cloud] download', key, e);
                    att[key] = '';
                }
            }
        }
    };

    /** Reúne planilha + todas as abas + documentos antes de gravar na nuvem. */
    g.fpPrepareDataForCloudSave = async function () {
        if (typeof g.fpLoadEmployeesFromLocalStorage === 'function') {
            g.fpLoadEmployeesFromLocalStorage();
        }
        if (typeof g.fpHydrateEmployeeAttachmentsFromIdb === 'function') {
            await g.fpHydrateEmployeeAttachmentsFromIdb();
        }
        if (typeof g.fpLoadPagasFromLocalStorage === 'function') {
            g.fpLoadPagasFromLocalStorage();
        }
        if (typeof g.fpLoadQuadroGeralFromLocalStorage === 'function') {
            g.fpLoadQuadroGeralFromLocalStorage();
        }
        await g.fpPullStateFromDashboardIframes(3000);
        if (typeof g.syncBeneficiosFuncionariosFromEmployees === 'function') {
            g.syncBeneficiosFuncionariosFromEmployees();
        }
        if (typeof g.fpFlushAllTabsToLocalStorage === 'function') {
            g.fpFlushAllTabsToLocalStorage();
        } else {
            if (typeof g.fpSaveEmployeesToLocalStorage === 'function') g.fpSaveEmployeesToLocalStorage();
            if (typeof g.fpSavePagasToLocalStorage === 'function') g.fpSavePagasToLocalStorage();
            if (typeof g.fpSaveQuadroGeralToLocalStorage === 'function') g.fpSaveQuadroGeralToLocalStorage();
        }
    };

    g.fpPullStateFromDashboardIframes = function (timeoutMs) {
        timeoutMs = timeoutMs || 3000;
        return new Promise(function (resolve) {
            var done = false;
            function finish() {
                if (!done) {
                    done = true;
                    resolve();
                }
            }
            var frames = g.document.querySelectorAll(
                '#dashboard iframe.external-tab-frame, #inicio iframe.external-tab-frame'
            );
            if (!frames.length) {
                finish();
                return;
            }
            var handler = function (ev) {
                if (ev.data && ev.data.type === 'fastpark-employees-from-iframe') {
                    g.removeEventListener('message', handler);
                    setTimeout(finish, 80);
                }
            };
            g.addEventListener('message', handler);
            frames.forEach(function (fr) {
                try {
                    fr.contentWindow.postMessage({ type: 'fastpark-request-full-state' }, '*');
                } catch (e) {
                    console.warn('[fp-cloud] pedido sync iframe', e);
                }
            });
            setTimeout(function () {
                g.removeEventListener('message', handler);
                finish();
            }, timeoutMs);
        });
    };

    g.fpCloudSavePreview = function () {
        var nEmp = (g.state && Array.isArray(g.state.employees)) ? g.state.employees.length : 0;
        try {
            if (!nEmp) {
                var raw = g.localStorage.getItem('fp_employees_json');
                if (raw) {
                    var arr = JSON.parse(raw);
                    if (Array.isArray(arr)) nEmp = arr.length;
                }
            }
        } catch (e) { /* ignore */ }
        var nPagas = (g.state && Array.isArray(g.state.pagas)) ? g.state.pagas.length : 0;
        var nQuadro = (g.state && Array.isArray(g.state.quadroGeral)) ? g.state.quadroGeral.length : 0;
        return { employees: nEmp, pagas: nPagas, quadroGeral: nQuadro };
    };

    g.fpCloudSaveSnapshot = async function (opts) {
        opts = opts || {};
        if (typeof g.collectFpIntranetSnapshot !== 'function') {
            throw new Error('Função collectFpIntranetSnapshot não encontrada.');
        }
        if (typeof g.fpGetAuthContext === 'function') await g.fpGetAuthContext();
        else await g.fpAuthReady;
        var supa = clientOrThrow();
        if (!opts.autosave) {
            fpCloudSetStatus('A reunir dados de todas as abas…');
        } else {
            fpCloudSetStatus('A guardar automaticamente (dados + documentos)…');
        }
        await g.fpPrepareDataForCloudSave();
        var preview = g.fpCloudSavePreview();
        if (!preview.employees && typeof g.fpIntranetHasDataForSnapshot === 'function' && !g.fpIntranetHasDataForSnapshot()) {
            throw new Error('Nenhum colaborador encontrado. Importe a planilha Excel ou abra a aba Cadastro/Início antes de salvar.');
        }
        if (!opts.autosave) {
            fpCloudSetStatus('A preparar ' + (preview.employees || 0) + ' colaborador(es)…');
        }
        var snap = await g.collectFpIntranetSnapshot();
        fpCloudSetStatus('A enviar documentos de todas as abas…');
        var prep = await prepareSnapshotForCloud(snap);
        var jsonLen = JSON.stringify(snap).length;
        if (jsonLen > 12 * 1024 * 1024) {
            throw new Error('Snapshot muito grande (~' + (jsonLen / (1024 * 1024)).toFixed(1) + ' MB). Ligue a pasta de anexos no PC antes de gravar na nuvem.');
        }
        fpCloudSetStatus('A gravar base de dados na nuvem…');
        var userRes = await supa.auth.getUser();
        var row = {
            id: ROW_ID,
            snapshot: snap,
            version: snap.version || 2,
            exported_at: snap.exportedAt || new Date().toISOString(),
            updated_by: userRes.data.user ? userRes.data.user.id : null,
            updated_at: new Date().toISOString()
        };
        var res = await supa.from('intranet_snapshots').upsert(row, { onConflict: 'id' });
        if (res.error) throw res.error;
        var nSaved = (snap.state && snap.state.employees) ? snap.state.employees.length : 0;
        var msg = (opts.autosave ? 'Auto-gravado' : 'Gravado') + ' na nuvem: ' + nSaved + ' colaborador(es) (' + new Date().toLocaleString('pt-BR') + ').';
        if (prep.uploaded) msg += ' Documentos enviados: ' + prep.uploaded + '.';
        if (prep.alreadyCloud) msg += ' Já na nuvem: ' + prep.alreadyCloud + '.';
        if (prep.diskSkipped) {
            msg += ' Aviso: ' + prep.diskSkipped + ' anexo(s) no disco — ligue a pasta de anexos e grave de novo.';
        }
        fpCloudSetStatus(msg, false);
        g.__fpCloudLastSaveAt = Date.now();
        if (typeof g.addAudit === 'function') {
            g.addAudit(opts.autosave ? 'Auto-gravação Supabase.' : 'Banco gravado no Supabase.', 'action');
        }
        return res.data;
    };

    g.fpExecuteCloudAutosave = async function () {
        if (g.FP_CLOUD_AUTOSAVE === false) return;
        if (fpCloudAutosavePaused()) return;
        if (cloudRunning) {
            cloudPending = true;
            return;
        }
        cloudRunning = true;
        try {
            await g.fpCloudSaveSnapshot({ autosave: true });
        } catch (err) {
            console.warn('[fp-cloud] autosave', err);
            fpCloudSetStatus('Erro ao guardar na nuvem: ' + (err && err.message ? err.message : err), true);
        } finally {
            cloudRunning = false;
            if (cloudPending) {
                cloudPending = false;
                g.fpScheduleCloudSave();
            }
        }
    };

    function fpCloudAutosavePaused() {
        if (g.__fpCloudLoadRunning || g.__fpLsHookPause) return true;
        if (g.__fpCloudSkipAutosaveUntil && Date.now() < g.__fpCloudSkipAutosaveUntil) return true;
        return false;
    }

    g.fpScheduleCloudSave = function () {
        if (g.FP_CLOUD_AUTOSAVE === false) return;
        if (fpCloudAutosavePaused()) return;
        clearTimeout(cloudTimer);
        var ms = g.FP_CLOUD_AUTOSAVE_DEBOUNCE_MS || 8000;
        cloudTimer = setTimeout(function () {
            g.fpExecuteCloudAutosave().catch(function (e) { console.warn('[fp-cloud]', e); });
        }, ms);
    };

    g.fpInitCloudAutosave = function () {
        if (g.__fpCloudAutosaveInit) return;
        g.__fpCloudAutosaveInit = true;
        g.document.addEventListener('fp-intranet-changed', function () {
            g.fpScheduleCloudSave();
        });
        var sec = Math.round((g.FP_CLOUD_AUTOSAVE_DEBOUNCE_MS || 8000) / 1000);
        var loadHint = g.FP_CLOUD_AUTOLOAD !== false ? ' Carregamento automático ao abrir.' : '';
        fpCloudSetStatus('Auto-gravação ligada (~' + sec + ' s após alterações).' + loadHint, false);
    };

    /** Carrega da nuvem ao iniciar (uma vez por sessão de página). */
    g.fpTryCloudAutoload = function (opts) {
        if (g.FP_CLOUD_AUTOLOAD === false) {
            return Promise.resolve({ loaded: false, reason: 'disabled' });
        }
        if (g.__fpCloudAutoloadPromise) return g.__fpCloudAutoloadPromise;
        opts = opts || {};
        g.__fpCloudAutoloadPromise = (async function () {
            try {
                if (typeof g.fpGetAuthContext === 'function') await g.fpGetAuthContext();
                else if (g.fpAuthReady) await g.fpAuthReady;
                var supa = g.fpSupabase;
                if (!supa) return { loaded: false, reason: 'no-client' };
                var ur = await supa.auth.getUser();
                if (!ur.data || !ur.data.user) return { loaded: false, reason: 'not-logged' };
                var peek = await supa.from('intranet_snapshots')
                    .select('id, updated_at')
                    .eq('id', ROW_ID)
                    .maybeSingle();
                if (peek.error) throw peek.error;
                if (!peek.data) {
                    fpCloudSetStatus('Sem dados na nuvem — importe o Excel e use ☁️ Salvar.', false);
                    return { loaded: false, reason: 'no-snapshot' };
                }
                await g.fpCloudLoadSnapshot({ autoload: true });
                return { loaded: true, updatedAt: peek.data.updated_at || null };
            } catch (err) {
                var msg = err && err.message ? err.message : String(err);
                if (/ainda não há dados/i.test(msg)) {
                    fpCloudSetStatus('Sem dados na nuvem — importe o Excel e use ☁️ Salvar.', false);
                    return { loaded: false, reason: 'no-snapshot' };
                }
                console.warn('[fp-cloud] autoload', err);
                fpCloudSetStatus('Erro ao carregar da nuvem: ' + msg, true);
                return { loaded: false, reason: 'error', error: err };
            }
        })();
        return g.__fpCloudAutoloadPromise;
    };

    g.fpCloudLoadSnapshot = async function (opts) {
        opts = opts || {};
        g.__fpCloudLoadRunning = true;
        clearTimeout(cloudTimer);
        try {
            if (typeof g.fpGetAuthContext === 'function') await g.fpGetAuthContext();
        else await g.fpAuthReady;
            var supa = clientOrThrow();
            fpCloudSetStatus(opts.autoload ? 'A carregar automaticamente da nuvem…' : 'A carregar da nuvem…');
            var res = await supa.from('intranet_snapshots').select('snapshot, exported_at, updated_at').eq('id', ROW_ID).maybeSingle();
            if (res.error) throw res.error;
            if (!res.data || !res.data.snapshot) {
                throw new Error('Ainda não há dados gravados na nuvem.');
            }
            var db = res.data.snapshot;
            if (typeof g.fpResolveCloudAttachmentMarkers === 'function') {
                fpCloudSetStatus('A transferir documentos…');
                await g.fpResolveCloudAttachmentMarkers(db);
            }
            if (typeof g.fpResolveDiskAttachmentMarkers === 'function') {
                await g.fpResolveDiskAttachmentMarkers(db);
            }
            if (typeof g.applyFpEmbeddedIntranetDb !== 'function') {
                throw new Error('Função applyFpEmbeddedIntranetDb não encontrada.');
            }
            await g.applyFpEmbeddedIntranetDb(db);
            var when = res.data.updated_at || res.data.exported_at || '';
            var pauseMs = g.FP_CLOUD_AUTOLOAD_AUTOSAVE_PAUSE_MS || 90000;
            g.__fpCloudSkipAutosaveUntil = Date.now() + pauseMs;
            var msg = (opts.autoload ? 'Carregado automaticamente' : 'Carregado da nuvem') +
                (when ? ' (' + new Date(when).toLocaleString('pt-BR') + ')' : '') + '.';
            fpCloudSetStatus(msg, false);
            if (typeof g.addAudit === 'function') {
                g.addAudit(opts.autoload ? 'Auto-carregamento Supabase.' : 'Banco carregado do Supabase.', 'action');
            }
            return db;
        } finally {
            g.__fpCloudLoadRunning = false;
        }
    };

    g.fpEnsureCloudSession = async function () {
        if (typeof g.fpGetAuthContext === 'function') await g.fpGetAuthContext();
        else await g.fpAuthReady;
        var supa = clientOrThrow();
        var userRes = await supa.auth.getUser();
        if (userRes.data && userRes.data.user) return true;
        if (g.confirm('Para salvar ou carregar na nuvem é preciso entrar com e-mail e senha.\n\nAbrir a página de login agora?')) {
            g.location.href = (typeof g.fpLoginUrl === 'function' ? g.fpLoginUrl() : (g.FP_LOGIN_URL || '/'));
        }
        return false;
    };

    g.fpUpdateCloudNavUi = async function () {
        var btnEntrar = g.document.getElementById('fpCloudBtnEntrar');
        var btnSair = g.document.querySelector('.nav-btn-sair');
        var btnSalvar = g.document.querySelector('.nav-btn-cloud[onclick*="fpCloudSaveSnapshotUi"]');
        var btnCarregar = g.document.querySelector('.nav-btn-cloud[onclick*="fpCloudLoadSnapshotUi"]');
        try {
            if (typeof g.fpGetAuthContext === 'function') await g.fpGetAuthContext();
        else await g.fpAuthReady;
            var supa = g.fpSupabase;
            var logged = false;
            if (supa) {
                var ur = await supa.auth.getUser();
                logged = !!(ur.data && ur.data.user);
            }
            if (btnEntrar) btnEntrar.style.display = logged ? 'none' : '';
            if (btnSair) btnSair.style.display = logged ? '' : 'none';
            if (btnSalvar) btnSalvar.disabled = !logged;
            if (btnCarregar) btnCarregar.disabled = !logged;
        } catch (e) { /* ignore */ }
    };

    g.fpCloudSaveSnapshotUi = async function () {
        try {
            fpCloudSetStatus('A verificar dados…');
            await g.fpPrepareDataForCloudSave();
            var preview = g.fpCloudSavePreview();
            if (!preview.employees && typeof g.fpIntranetHasDataForSnapshot === 'function' && !g.fpIntranetHasDataForSnapshot()) {
                alert(
                    'Não foi encontrado cadastro da planilha.\n\n' +
                    '1) Importe o BANCO DE DADOS.xlsx (botão na aba Cadastro ou «Ligar planilha»), ou\n' +
                    '2) Abra a aba Início/Cadastro e aguarde a lista carregar, depois tente de novo.'
                );
                return;
            }
            var linhas = [
                'Colaboradores: ' + (preview.employees || 0),
                'Lançamentos pagas: ' + (preview.pagas || 0),
                'Postos no quadro: ' + (preview.quadroGeral || 0)
            ].join('\n');
            if (!confirm(
                'Gravar na nuvem (Supabase)?\n\n' + linhas + '\n\n' +
                'Inclui dados da planilha já carregada + cestas, férias, unidades, etc.\n' +
                'Substitui a cópia anterior na nuvem.'
            )) return;
            await g.fpCloudSaveSnapshot();
        } catch (err) {
            console.error(err);
            fpCloudSetStatus('Erro: ' + (err && err.message ? err.message : err), true);
            alert('Erro ao gravar na nuvem: ' + (err && err.message ? err.message : err));
        }
    };

    g.fpCloudLoadSnapshotUi = async function () {
        try {
            if (!confirm('Carregar da nuvem? Os dados actuais neste separador serão substituídos.')) return;
            await g.fpCloudLoadSnapshot();
        } catch (err) {
            console.error(err);
            fpCloudSetStatus('Erro: ' + (err && err.message ? err.message : err), true);
            alert('Erro ao carregar da nuvem: ' + (err && err.message ? err.message : err));
        }
    };

    function fpApplyCloudAutosaveSession(session) {
        if (session) {
            if (g.FP_CLOUD_AUTOSAVE !== false) g.fpInitCloudAutosave();
            if (g.FP_CLOUD_AUTOLOAD !== false && typeof g.fpTryCloudAutoload === 'function') {
                g.fpTryCloudAutoload({ afterLogin: true }).then(function (r) {
                    if (!r || !r.loaded) return;
                    if (typeof g.renderAll === 'function') {
                        try { g.renderAll(); } catch (e) { console.warn('[fp-cloud] renderAll', e); }
                    }
                    if (typeof g.propagateStateToDashboardIframes === 'function') {
                        g.propagateStateToDashboardIframes();
                    }
                }).catch(function (e) { console.warn('[fp-cloud] autoload pós-login', e); });
            }
            return;
        }
        if (g.__fpCloudAutosaveInit) return;
        var sec = Math.round((g.FP_CLOUD_AUTOSAVE_DEBOUNCE_MS || 8000) / 1000);
        fpCloudSetStatus(
            'Nuvem Supabase: entre em index.html (login). Depois carrega/grava automaticamente (~' + sec + ' s).',
            false
        );
    }

    if (g.fpAuthReady) {
        g.fpAuthReady.then(function (ctx) {
            fpApplyCloudAutosaveSession(ctx && ctx.session);
        }).catch(function () {});
    }

    if (g.fpSupabase && g.fpSupabase.auth && typeof g.fpSupabase.auth.onAuthStateChange === 'function') {
        g.fpSupabase.auth.onAuthStateChange(function (event, session) {
            if (event === 'SIGNED_IN' && session) {
                fpApplyCloudAutosaveSession(session);
            }
            if (event === 'SIGNED_OUT') {
                g.__fpCloudAutosaveInit = false;
                clearTimeout(cloudTimer);
                fpApplyCloudAutosaveSession(null);
            }
        });
    }
})(typeof window !== 'undefined' ? window : globalThis);
