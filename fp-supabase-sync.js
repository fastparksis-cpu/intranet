/**
 * Sincronização FastPark ↔ Supabase (snapshot JSON + Storage).
 * Requer: fp-auth.js, collectFpIntranetSnapshot, applyFpEmbeddedIntranetDb
 */
(function (g) {
    'use strict';

    var BUCKET = g.FP_STORAGE_BUCKET || 'intranet-files';
    var ROW_ID = g.FP_SNAPSHOT_ROW_ID || 'main';
    var cloudTimer = null;
    var mediaTimer = null;
    var cloudUnpauseTimer = null;
    var cloudRunning = false;
    var cloudPending = false;
    var mediaUploadRunning = false;

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

    var signedUrlCache = {};

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

    /** URL para exibir ficheiro na nuvem (signed URL; evita base64 gigante no browser). */
    async function cloudMediaDisplayUrl(path) {
        path = sanitizeStoragePath(path);
        var cached = signedUrlCache[path];
        if (cached && cached.exp > Date.now()) return cached.url;
        var supa = clientOrThrow();
        var signed = await supa.storage.from(BUCKET).createSignedUrl(path, 3600);
        if (signed.error) throw signed.error;
        if (!signed.data || !signed.data.signedUrl) throw new Error('URL assinada indisponível: ' + path);
        signedUrlCache[path] = { url: signed.data.signedUrl, exp: Date.now() + 3500000 };
        return signed.data.signedUrl;
    }

    async function resolveCloudPathToDisplayUrl(path) {
        path = sanitizeStoragePath(path);
        try {
            return await cloudMediaDisplayUrl(path);
        } catch (signedErr) {
            console.warn('[fp-cloud] signedUrl', path, signedErr);
            try {
                return await downloadDataUrl(path);
            } catch (dlErr) {
                console.warn('[fp-cloud] download', path, dlErr);
                throw dlErr;
            }
        }
    }

    g.fpResolveCloudMediaUrl = resolveCloudPathToDisplayUrl;

    /** Lista recursivamente ficheiros no bucket (pastas no Storage não têm metadata). */
    async function listStorageFilesRecursive(prefix) {
        var supa = clientOrThrow();
        prefix = prefix ? String(prefix).replace(/\/+$/, '') + '/' : '';
        var out = [];

        async function walk(folder) {
            var offset = 0;
            var pageSize = 200;
            while (true) {
                var res = await supa.storage.from(BUCKET).list(folder, {
                    limit: pageSize,
                    offset: offset,
                    sortBy: { column: 'name', order: 'asc' }
                });
                if (res.error) {
                    console.warn('[fp-cloud] list ' + folder, res.error);
                    return;
                }
                var items = res.data || [];
                if (!items.length) break;
                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    var itemPath = (folder + item.name).replace(/\/+/g, '/');
                    if (item.metadata != null) {
                        out.push(itemPath.replace(/^\//, ''));
                    } else {
                        await walk(itemPath + '/');
                    }
                }
                if (items.length < pageSize) break;
                offset += pageSize;
            }
        }

        await walk(prefix);
        return out;
    }

    async function fpCloudSignPathsToDisplayMap(paths) {
        var disp = g.window.__FP_CLOUD_DISPLAY_URLS__ || (g.window.__FP_CLOUD_DISPLAY_URLS__ = {});
        var ok = 0;
        var fail = 0;
        for (var i = 0; i < paths.length; i++) {
            var raw = paths[i];
            var p = sanitizeStoragePath(raw);
            if (disp[p] || disp[raw]) {
                ok++;
                continue;
            }
            try {
                var url = await resolveCloudPathToDisplayUrl(p);
                disp[p] = url;
                disp[raw] = url;
                ok++;
            } catch (e) {
                fail++;
            }
            if (i % 10 === 0) {
                fpCloudSetStatus('A ligar ficheiros do Storage… ' + (i + 1) + '/' + paths.length);
            }
        }
        g.window.__FP_CLOUD_DISPLAY_URLS__ = disp;
        return { ok: ok, fail: fail, total: paths.length };
    }

    /** Indexa o bucket e preenche URLs de exibição (quando snapshot e Storage divergem). */
    async function fpCloudIndexStorageBucket() {
        fpCloudSetStatus('A listar ficheiros no Storage…');
        var prefixes = ['colaboradores', 'faltas', 'unidades', 'pagas'];
        var paths = [];
        for (var pi = 0; pi < prefixes.length; pi++) {
            try {
                var sub = await listStorageFilesRecursive(prefixes[pi]);
                paths = paths.concat(sub);
            } catch (e) {
                console.warn('[fp-cloud] list prefix', prefixes[pi], e);
            }
        }
        console.log('[fp-cloud] ficheiros no Storage:', paths.length);
        return fpCloudSignPathsToDisplayMap(paths);
    }

    g.fpCloudIndexStorageBucket = fpCloudIndexStorageBucket;

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
        Object.keys(snap.attachments || {}).forEach(function (k) {
            add(k);
            var v = snap.attachments[k];
            if (v && typeof v === 'object' && v.__cloud === true && v.path) add(v.path);
        });
        var bag = g.window.__FP_EMBEDDED_ATTACHMENTS__ || {};
        Object.keys(bag).forEach(function (k) { add(k); });
        var empBag = g.window.__FP_EMPLOYEE_ATT_BAG__ || {};
        Object.keys(empBag).forEach(function (k) {
            if (typeof empBag[k] === 'string') add(k);
        });
        return keys;
    }

    function fpEmployeeAttBagFlat() {
        var flat = {};
        var bag = g.window.__FP_EMPLOYEE_ATT_BAG__ || {};
        Object.keys(bag).forEach(function (k) {
            var v = bag[k];
            if (typeof v === 'string' && v.indexOf('data:') === 0) {
                flat[sanitizeStoragePath(k)] = v;
            }
        });
        return flat;
    }

    async function resolveAttachmentToDataUrl(key, att, embBag, empBagFlat) {
        key = sanitizeStoragePath(key);
        var v = att[key];
        if (typeof v === 'string' && v.indexOf('data:') === 0) return v;
        if (empBagFlat && empBagFlat[key]) return empBagFlat[key];
        v = embBag[key];
        if (typeof v === 'string' && v.indexOf('data:') === 0) return v;
        if (typeof g.fpResolveEmployeeMediaRef === 'function' && g.state && Array.isArray(g.state.employees)) {
            for (var ei = 0; ei < g.state.employees.length; ei++) {
                var emp = g.state.employees[ei];
                if (emp.fotoRef === key || key.indexOf('colaboradores/') === 0) {
                    var u = g.fpResolveEmployeeMediaRef(key, emp, att, g.window.__FP_EMPLOYEE_ATT_BAG__ || {});
                    if (u && String(u).indexOf('data:') === 0) return u;
                }
            }
        }
        return await readDiskAttachmentAsDataUrl(key);
    }

    async function hydrateAttachmentsForCloud(snap) {
        var att = snap.attachments || {};
        var embBag = g.window.__FP_EMBEDDED_ATTACHMENTS__ || {};
        var empBagFlat = fpEmployeeAttBagFlat();
        var keys = collectAttachmentRefKeys(snap);
        var hydrated = 0;
        var failed = 0;
        for (var key of keys) {
            key = sanitizeStoragePath(key);
            var cur = att[key];
            if (typeof cur === 'string' && cur.indexOf('data:') === 0) continue;
            if (cur && typeof cur === 'object' && cur.__cloud === true) continue;
            var dataUrl = await resolveAttachmentToDataUrl(key, att, embBag, empBagFlat);
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

    function fpHarvestDataUrlsFromJsonTree(obj, att, prefix) {
        if (!obj || typeof obj !== 'object') return;
        prefix = prefix || 'misc';
        if (typeof obj === 'string' && obj.indexOf('data:') === 0) return;
        if (Array.isArray(obj)) {
            obj.forEach(function (item, i) {
                fpHarvestDataUrlsFromJsonTree(item, att, prefix + '/' + i);
            });
            return;
        }
        Object.keys(obj).forEach(function (k) {
            var v = obj[k];
            if (typeof v === 'string' && v.indexOf('data:') === 0) {
                var path = sanitizeStoragePath(prefix + '/' + k);
                if (!att[path] || (typeof att[path] === 'string' && att[path].indexOf('data:') === 0)) {
                    att[path] = v;
                }
            } else if (v && typeof v === 'object') {
                fpHarvestDataUrlsFromJsonTree(v, att, prefix + '/' + k);
            }
        });
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
        var empFlat = fpEmployeeAttBagFlat();
        Object.keys(empFlat).forEach(function (k) {
            put(k, empFlat[k]);
        });
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
        if (snap.localStrings && typeof snap.localStrings === 'object') {
            Object.keys(snap.localStrings).forEach(function (lsKey) {
                try {
                    var parsed = JSON.parse(snap.localStrings[lsKey]);
                    fpHarvestDataUrlsFromJsonTree(parsed, att, 'local/' + sanitizeStoragePath(lsKey).slice(0, 48));
                } catch (parseErr) { /* não-JSON */ }
            });
        }
    }

    async function prepareSnapshotForCloud(snap) {
        harvestInlineDataUrlsIntoAttachments(snap);
        var hydrate = await hydrateAttachmentsForCloud(snap);
        var att = snap.attachments || {};
        var diskSkipped = hydrate.failed || 0;
        var uploaded = 0;
        var alreadyCloud = 0;
        var uploadErrors = [];
        var queue = [];
        var keys = Object.keys(att);
        for (var i = 0; i < keys.length; i++) {
            var key = sanitizeStoragePath(keys[i]);
            var v = att[keys[i]];
            var dataUrl = null;
            if (typeof v === 'string' && v.indexOf('data:') === 0) {
                dataUrl = v;
            } else if (v && typeof v === 'object' && v.__disk === true) {
                try {
                    dataUrl = await readDiskAttachmentAsDataUrl(key);
                } catch (diskErr) {
                    console.warn('[fp-cloud] disco', key, diskErr);
                }
                if (!dataUrl) {
                    diskSkipped++;
                    att[keys[i]] = v;
                    continue;
                }
            } else if (v && typeof v === 'object' && v.__cloud === true) {
                alreadyCloud++;
                continue;
            } else if (typeof v === 'string' && v.indexOf('http') === 0) {
                alreadyCloud++;
                continue;
            }
            if (!dataUrl) continue;
            queue.push({ key: key, dataUrl: dataUrl });
        }
        var conc = g.FP_CLOUD_UPLOAD_CONCURRENCY || 12;
        var qi = 0;
        async function uploadWorker() {
            while (true) {
                var ix = qi++;
                if (ix >= queue.length) break;
                var job = queue[ix];
                try {
                    await uploadDataUrl(job.key, job.dataUrl);
                    att[job.key] = { __cloud: true, path: job.key };
                    uploaded++;
                } catch (upErr) {
                    console.error('[fp-cloud] upload', job.key, upErr);
                    uploadErrors.push(job.key + ': ' + (upErr && upErr.message ? upErr.message : upErr));
                    att[job.key] = job.dataUrl;
                }
            }
        }
        if (queue.length) {
            fpCloudSetStatus('A enviar ' + queue.length + ' ficheiro(s) em paralelo…');
            await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, uploadWorker));
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

    function fpNormalizeCloudMarkersOnly(db) {
        if (!db.attachments || typeof db.attachments !== 'object') db.attachments = {};
        var att = db.attachments;
        collectAttachmentRefKeys(db).forEach(function (key) {
            key = sanitizeStoragePath(key);
            var v = att[key];
            if (v && typeof v === 'object' && v.__cloud === true) {
                att[key] = { __cloud: true, path: sanitizeStoragePath(v.path || key) };
            } else if (typeof v === 'string' && v.indexOf('http') === 0) {
                var disp = g.window.__FP_CLOUD_DISPLAY_URLS__ || (g.window.__FP_CLOUD_DISPLAY_URLS__ = {});
                disp[key] = v;
            }
        });
        db.attachments = att;
        g.window.__FP_EMBEDDED_ATTACHMENTS__ = att;
    }

    g.fpScheduleCloudMediaPrefetch = function (db) {
        if (g.__fpCloudPrefetchRunning) return;
        g.__fpCloudPrefetchRunning = true;
        queueMicrotask(async function () {
            try {
                var keys = collectAttachmentRefKeys(db || {});
                var list = Array.from(keys);
                var foto = list.filter(function (k) { return k.indexOf('/foto/') >= 0; });
                var rest = list.filter(function (k) { return k.indexOf('/foto/') < 0; });
                list = foto.concat(rest);
                var conc = g.FP_CLOUD_MEDIA_PREFETCH_CONCURRENCY || 16;
                var pi = 0;
                var ok = 0;
                async function worker() {
                    while (true) {
                        var i = pi++;
                        if (i >= list.length) break;
                        var key = sanitizeStoragePath(list[i]);
                        var disp = g.window.__FP_CLOUD_DISPLAY_URLS__ || (g.window.__FP_CLOUD_DISPLAY_URLS__ = {});
                        if (disp[key]) { ok++; continue; }
                        try {
                            var url = await resolveCloudPathToDisplayUrl(key);
                            disp[key] = url;
                            ok++;
                            g.document.dispatchEvent(new CustomEvent('fp-cloud-media-ready', { detail: { path: key, url: url } }));
                        } catch (e) { /* próximo */ }
                    }
                }
                if (list.length) {
                    await Promise.all(Array.from({ length: Math.min(conc, list.length) }, worker));
                }
                if (typeof g.fpMatchEmployeeMediaFromStorageIndex === 'function' && db && db.state) {
                    g.fpMatchEmployeeMediaFromStorageIndex(db);
                }
                g.document.dispatchEvent(new CustomEvent('fp-cloud-media-batch-ready'));
            } catch (e) {
                console.warn('[fp-cloud] prefetch', e);
            } finally {
                g.__fpCloudPrefetchRunning = false;
            }
        });
    };

    g.fpEnsureCloudDisplayUrl = function (path) {
        path = sanitizeStoragePath(path);
        if (!path) return Promise.resolve(null);
        var disp = g.window.__FP_CLOUD_DISPLAY_URLS__ || (g.window.__FP_CLOUD_DISPLAY_URLS__ = {});
        if (disp[path]) return Promise.resolve(disp[path]);
        if (g.__fpCloudUrlPending && g.__fpCloudUrlPending[path]) {
            return g.__fpCloudUrlPending[path];
        }
        g.__fpCloudUrlPending = g.__fpCloudUrlPending || {};
        g.__fpCloudUrlPending[path] = resolveCloudPathToDisplayUrl(path).then(function (url) {
            disp[path] = url;
            delete g.__fpCloudUrlPending[path];
            g.document.dispatchEvent(new CustomEvent('fp-cloud-media-ready', { detail: { path: path, url: url } }));
            return url;
        }).catch(function (err) {
            delete g.__fpCloudUrlPending[path];
            throw err;
        });
        return g.__fpCloudUrlPending[path];
    };

    g.fpResolveCloudAttachmentMarkers = async function (db, opts) {
        opts = opts || {};
        if (!db) return { ok: 0, fail: 0, total: 0 };
        var useFast = opts.full !== true && opts.fast !== false && g.FP_CLOUD_FAST_SYNC !== false;
        if (useFast) {
            fpNormalizeCloudMarkersOnly(db);
            if (typeof g.fpScheduleCloudMediaPrefetch === 'function') {
                g.fpScheduleCloudMediaPrefetch(db);
            }
            var nKeys = collectAttachmentRefKeys(db).size;
            return { ok: 0, fail: 0, total: nKeys, fast: true, pending: true };
        }
        if (!db.attachments || typeof db.attachments !== 'object') db.attachments = {};
        var att = db.attachments;
        var keys = collectAttachmentRefKeys(db);
        var list = Array.from(keys);
        var total = list.length;
        var ok = 0;
        var fail = 0;
        var idx = 0;
        var workers = Math.min(4, Math.max(1, total));

        async function downloadKey(key) {
            key = sanitizeStoragePath(key);
            var v = att[key];
            var disp = g.window.__FP_CLOUD_DISPLAY_URLS__ || (g.window.__FP_CLOUD_DISPLAY_URLS__ = {});
            if (typeof v === 'string' && (v.indexOf('data:') === 0 || v.indexOf('http') === 0)) {
                disp[key] = v;
                ok++;
                return;
            }
            var cloudPath = key;
            if (v && typeof v === 'object' && v.__cloud === true) {
                cloudPath = sanitizeStoragePath(v.path || key);
            } else if (!(v === undefined || v === null || v === '')) {
                return;
            }
            var pathsToTry = [cloudPath, key];
            if (v && typeof v === 'object' && v.__cloud === true && v.path) {
                pathsToTry.push(sanitizeStoragePath(v.path));
            }
            var resolved = false;
            for (var ti = 0; ti < pathsToTry.length; ti++) {
                var tryP = sanitizeStoragePath(pathsToTry[ti]);
                if (!tryP) continue;
                try {
                    var url = await resolveCloudPathToDisplayUrl(tryP);
                    disp[key] = url;
                    disp[tryP] = url;
                    disp[cloudPath] = url;
                    att[key] = { __cloud: true, path: tryP };
                    ok++;
                    resolved = true;
                    break;
                } catch (e1) { /* tenta próximo caminho */ }
            }
            if (!resolved) fail++;
        }

        async function runWorker() {
            while (true) {
                var i = idx++;
                if (i >= total) break;
                if (i % 5 === 0 || i === total - 1) {
                    fpCloudSetStatus('A transferir documentos… ' + (i + 1) + '/' + total);
                }
                await downloadKey(list[i]);
            }
        }

        await Promise.all(Array.from({ length: workers }, runWorker));

        var indexStats = { ok: 0, fail: 0, total: 0 };
        if (opts.indexBucket === true) {
            try {
                indexStats = await fpCloudIndexStorageBucket();
                ok += indexStats.ok;
            } catch (idxErr) {
                console.warn('[fp-cloud] index bucket', idxErr);
            }
        }

        if (typeof g.fpMatchEmployeeMediaFromStorageIndex === 'function' && db.state) {
            g.fpMatchEmployeeMediaFromStorageIndex(db);
        }

        db.attachments = att;
        g.window.__FP_EMBEDDED_ATTACHMENTS__ = att;
        g.window.__FP_CLOUD_DISPLAY_URLS__ = g.window.__FP_CLOUD_DISPLAY_URLS__ || {};
        return { ok: ok, fail: fail, total: total, storageFiles: indexStats.total || 0 };
    };

    /** Reúne planilha + todas as abas + documentos antes de gravar na nuvem. */
    g.fpPrepareDataForCloudSave = async function (opts) {
        opts = opts || {};
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
        if (typeof g.fpPersistEmployeeAttBagFromState === 'function') {
            try { await g.fpPersistEmployeeAttBagFromState(); } catch (bagPrep) { console.warn('[fp-cloud] bag prepare', bagPrep); }
        }
        var quick = opts.quick !== false && opts.autosave && g.FP_CLOUD_QUICK_SAVE !== false && g.FP_CLOUD_FAST_SYNC !== false;
        await g.fpPullStateFromDashboardIframes(quick ? (opts.iframeMs || 1200) : (opts.iframeMs || 4000));
        if (typeof g.syncBeneficiosFuncionariosFromEmployees === 'function') {
            g.syncBeneficiosFuncionariosFromEmployees();
        }
        if (typeof g.fpFlushAllTabsToLocalStorage === 'function') {
            await g.fpFlushAllTabsToLocalStorage();
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
            fpCloudSetStatus('A reunir dados de todas as abas (DP, Financeiro, Unidades, Sinistros, Estoque, Postos, Pagas)…');
        } else {
            fpCloudSetStatus('A guardar automaticamente todas as abas (dados + documentos)…');
        }
        await g.fpPrepareDataForCloudSave({ autosave: !!opts.autosave, quick: !!opts.autosave });
        if (typeof g.fpHydrateEmployeesMediaForSnapshot === 'function' && g.state && Array.isArray(g.state.employees)) {
            g.state.employees = g.fpHydrateEmployeesMediaForSnapshot(g.state.employees, g.window.__FP_EMBEDDED_ATTACHMENTS__ || {});
        }
        var preview = g.fpCloudSavePreview();
        if (typeof g.fpIntranetHasDataForSnapshot === 'function') {
            if (!g.fpIntranetHasDataForSnapshot()) {
                throw new Error('Nenhum dado para gravar. Registe informações em qualquer aba (Unidades, Pagas, Sinistros, etc.) ou importe o Excel.');
            }
        } else if (!preview.employees) {
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

    function fpQueueCloudSaveRetry() {
        g.__fpCloudSavePending = true;
        if (cloudUnpauseTimer) return;
        cloudUnpauseTimer = setInterval(function () {
            if (fpCloudAutosavePaused()) return;
            clearInterval(cloudUnpauseTimer);
            cloudUnpauseTimer = null;
            if (g.__fpCloudSavePending) {
                g.__fpCloudSavePending = false;
                g.fpScheduleCloudSave();
            }
        }, 400);
    }

    g.fpExecuteCloudAutosave = async function () {
        if (g.FP_CLOUD_AUTOSAVE === false) return;
        if (fpCloudAutosavePaused()) {
            fpQueueCloudSaveRetry();
            return;
        }
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

    g.fpCloudUploadMediaNow = async function (path, dataUrl) {
        path = sanitizeStoragePath(path);
        if (!path || !dataUrl || String(dataUrl).indexOf('data:') !== 0) return null;
        if (typeof g.fpGetAuthContext === 'function') await g.fpGetAuthContext();
        else if (g.fpAuthReady) await g.fpAuthReady;
        var emb = g.window.__FP_EMBEDDED_ATTACHMENTS__ || (g.window.__FP_EMBEDDED_ATTACHMENTS__ = {});
        var cur = emb[path];
        if (cur && typeof cur === 'object' && cur.__cloud === true) return path;
        await uploadDataUrl(path, dataUrl);
        emb[path] = { __cloud: true, path: path };
        return path;
    };

    g.fpCloudUploadAllPendingMedia = async function () {
        if (g.FP_CLOUD_IMMEDIATE_MEDIA_UPLOAD === false) return { uploaded: 0, skipped: 0 };
        if (fpCloudAutosavePaused() && g.__fpCloudLoadRunning) return { uploaded: 0, skipped: 0 };
        if (mediaUploadRunning) return { uploaded: 0, skipped: 0, busy: true };
        mediaUploadRunning = true;
        var uploaded = 0;
        var skipped = 0;
        try {
            if (typeof g.fpGetAuthContext === 'function') await g.fpGetAuthContext();
            else if (g.fpAuthReady) await g.fpAuthReady;
            var ur = await clientOrThrow().auth.getUser();
            if (!ur.data || !ur.data.user) return { uploaded: 0, skipped: 0, reason: 'not-logged' };
            if (typeof g.fpPersistEmployeeAttBagFromState === 'function') {
                try { await g.fpPersistEmployeeAttBagFromState(); } catch (bagErr) {
                    console.warn('[fp-cloud] bag persist', bagErr);
                }
            } else if (typeof g.fpPrimeEmployeeAttBagFromDb === 'function' && g.state) {
                g.fpPrimeEmployeeAttBagFromDb(g.state.employees || [], g.window.__FP_EMBEDDED_ATTACHMENTS__ || {});
            }
            var emb = g.window.__FP_EMBEDDED_ATTACHMENTS__ || (g.window.__FP_EMBEDDED_ATTACHMENTS__ = {});
            var bag = g.window.__FP_EMPLOYEE_ATT_BAG__ || {};
            var queue = [];
            function consider(key, dataUrl) {
                key = sanitizeStoragePath(key);
                if (!key || !dataUrl || String(dataUrl).indexOf('data:') !== 0) return;
                var cur = emb[key];
                if (cur && typeof cur === 'object' && cur.__cloud === true) {
                    skipped++;
                    return;
                }
                if (typeof cur === 'string' && cur.indexOf('http') === 0) {
                    skipped++;
                    return;
                }
                queue.push({ key: key, dataUrl: dataUrl });
            }
            Object.keys(bag).forEach(function (k) {
                consider(k, bag[k]);
            });
            Object.keys(emb).forEach(function (k) {
                if (typeof emb[k] === 'string' && emb[k].indexOf('data:') === 0) consider(k, emb[k]);
            });
            if (!queue.length) return { uploaded: 0, skipped: skipped };
            fpCloudSetStatus('A enviar ' + queue.length + ' anexo(s) para a nuvem…');
            var conc = g.FP_CLOUD_UPLOAD_CONCURRENCY || 12;
            var qi = 0;
            async function worker() {
                while (true) {
                    var ix = qi++;
                    if (ix >= queue.length) break;
                    var job = queue[ix];
                    try {
                        await g.fpCloudUploadMediaNow(job.key, job.dataUrl);
                        uploaded++;
                    } catch (upErr) {
                        console.warn('[fp-cloud] media now', job.key, upErr);
                    }
                }
            }
            await Promise.all(Array.from({ length: Math.min(conc, queue.length) }, worker));
            if (uploaded) {
                fpCloudSetStatus(uploaded + ' anexo(s) guardado(s) na nuvem. A sincronizar dados…', false);
            }
            return { uploaded: uploaded, skipped: skipped };
        } finally {
            mediaUploadRunning = false;
        }
    };

    g.fpScheduleCloudMediaSave = function () {
        if (g.FP_CLOUD_IMMEDIATE_MEDIA_UPLOAD === false) {
            g.fpScheduleCloudSave();
            return;
        }
        clearTimeout(mediaTimer);
        var ms = g.FP_CLOUD_MEDIA_SAVE_DEBOUNCE_MS || 400;
        mediaTimer = setTimeout(function () {
            (async function () {
                try {
                    await g.fpCloudUploadAllPendingMedia();
                } catch (e) {
                    console.warn('[fp-cloud] media upload', e);
                }
                g.fpScheduleCloudSave();
            })().catch(function (e) { console.warn('[fp-cloud] media save', e); });
        }, ms);
    };

    g.fpScheduleCloudSave = function () {
        if (g.FP_CLOUD_AUTOSAVE === false) return;
        g.__fpCloudUserEditedAt = Date.now();
        if (fpCloudAutosavePaused()) {
            fpQueueCloudSaveRetry();
            return;
        }
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
            g.__fpCloudUserEditedAt = Date.now();
            if (g.__fpCloudLoadRunning) {
                fpQueueCloudSaveRetry();
                return;
            }
            if (g.__fpCloudSkipAutosaveUntil && Date.now() < g.__fpCloudSkipAutosaveUntil) {
                if (g.__fpCloudUserEditedAt > (g.__fpCloudLoadedAt || 0)) {
                    g.__fpCloudSkipAutosaveUntil = 0;
                }
            }
            if (typeof g.fpScheduleCloudMediaSave === 'function') {
                g.fpScheduleCloudMediaSave();
            } else {
                g.fpScheduleCloudSave();
            }
        });
        var sec = Math.round((g.FP_CLOUD_AUTOSAVE_DEBOUNCE_MS || 8000) / 1000);
        var loadHint = g.FP_CLOUD_AUTOLOAD !== false ? ' Carregamento automático ao abrir.' : '';
        fpCloudSetStatus('Auto-gravação ligada (~' + sec + ' s após alterações).' + loadHint, false);
    };

    /** Carrega da nuvem ao iniciar (repete se ainda não houver sessão). */
    g.fpTryCloudAutoload = function (opts) {
        if (g.FP_CLOUD_AUTOLOAD === false) {
            return Promise.resolve({ loaded: false, reason: 'disabled' });
        }
        if (g.__fpCloudAutoloadDone && !opts.force) {
            var prev = g.__fpCloudAutoloadResult || { loaded: false, reason: 'already-done' };
            var nEmp = (g.state && Array.isArray(g.state.employees)) ? g.state.employees.length : 0;
            if (prev.loaded && nEmp > 0) return Promise.resolve(prev);
            if (!opts.boot && !opts.afterLogin) return Promise.resolve(prev);
            g.fpResetCloudAutoloadForRetry();
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
                if (!ur.data || !ur.data.user) {
                    fpCloudSetStatus('Entre com login para carregar os dados da nuvem (☁️).', false);
                    return { loaded: false, reason: 'not-logged' };
                }
                var peek = await supa.from('intranet_snapshots')
                    .select('id, updated_at')
                    .eq('id', ROW_ID)
                    .maybeSingle();
                if (peek.error) throw peek.error;
                if (!peek.data) {
                    fpCloudSetStatus('Sem dados na nuvem — importe o Excel e use ☁️ Salvar.', false);
                    return { loaded: false, reason: 'no-snapshot' };
                }
                await g.fpCloudLoadSnapshot({ autoload: true, skipIframeSync: true });
                var result = { loaded: true, updatedAt: peek.data.updated_at || null };
                g.__fpCloudAutoloadDone = true;
                g.__fpCloudAutoloadResult = result;
                return result;
            } catch (err) {
                var msg = err && err.message ? err.message : String(err);
                if (/ainda não há dados/i.test(msg)) {
                    fpCloudSetStatus('Sem dados na nuvem — importe o Excel e use ☁️ Salvar.', false);
                    return { loaded: false, reason: 'no-snapshot' };
                }
                console.warn('[fp-cloud] autoload', err);
                fpCloudSetStatus('Erro ao carregar da nuvem: ' + msg, true);
                return { loaded: false, reason: 'error', error: err };
            } finally {
                g.__fpCloudAutoloadPromise = null;
            }
        })();
        return g.__fpCloudAutoloadPromise;
    };

    g.fpResetCloudAutoloadForRetry = function () {
        g.__fpCloudAutoloadDone = false;
        g.__fpCloudAutoloadResult = null;
        g.__fpCloudAutoloadPromise = null;
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
            var attStats = { ok: 0, fail: 0, total: 0 };
            var useFast = g.FP_CLOUD_FAST_SYNC !== false;
            if (useFast) {
                fpCloudSetStatus(opts.autoload ? 'A carregar dados da nuvem…' : 'A carregar dados…');
                fpNormalizeCloudMarkersOnly(db);
                attStats = { ok: 0, fail: 0, total: collectAttachmentRefKeys(db).size, fast: true };
            } else if (typeof g.fpResolveCloudAttachmentMarkers === 'function') {
                fpCloudSetStatus('A transferir documentos da nuvem…');
                attStats = await g.fpResolveCloudAttachmentMarkers(db, { full: true }) || attStats;
            }
            if (typeof g.fpResolveDiskAttachmentMarkers === 'function') {
                await g.fpResolveDiskAttachmentMarkers(db);
            }
            if (typeof g.applyFpEmbeddedIntranetDb !== 'function') {
                throw new Error('Função applyFpEmbeddedIntranetDb não encontrada.');
            }
            await g.applyFpEmbeddedIntranetDb(db, { fromCloud: true });
            if (useFast && typeof g.fpScheduleCloudMediaPrefetch === 'function') {
                g.fpScheduleCloudMediaPrefetch(db);
            }
            if (typeof g.fpPersistEmployeeAttBagFromState === 'function') {
                await g.fpPersistEmployeeAttBagFromState();
            }
            if (!opts.skipIframeSync) {
                if (typeof g.fpOnCloudDataReady === 'function') {
                    g.fpOnCloudDataReady();
                } else if (typeof g.propagateStateToDashboardIframes === 'function') {
                    g.propagateStateToDashboardIframes();
                }
            }
            var when = res.data.updated_at || res.data.exported_at || '';
            var pauseMs = g.FP_CLOUD_AUTOLOAD_AUTOSAVE_PAUSE_MS || 20000;
            g.__fpCloudLoadedAt = Date.now();
            g.__fpCloudSkipAutosaveUntil = Date.now() + pauseMs;
            var nEmp = (g.state && g.state.employees) ? g.state.employees.length : 0;
            var msg = (opts.autoload ? 'Carregado automaticamente' : 'Carregado da nuvem') +
                ': ' + nEmp + ' colaborador(es)' +
                (when ? ' (' + new Date(when).toLocaleString('pt-BR') + ')' : '') + '.';
            if (attStats.fast && attStats.total) {
                msg += ' Fotos/docs a carregar em segundo plano (' + attStats.total + ').';
            } else if (attStats.total || attStats.storageFiles) {
                msg += ' Anexos: ' + attStats.ok + '/' + (attStats.total || attStats.storageFiles);
                if (attStats.storageFiles) msg += ' (' + attStats.storageFiles + ' ficheiros no Storage)';
                if (attStats.fail) msg += ' (' + attStats.fail + ' falha(s))';
            }
            fpCloudSetStatus(msg, attStats.fail > 0 && nEmp === 0);
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

    /** Autoload após boot da intranet (iframes prontos). Não chamar no fpAuthReady do head. */
    g.fpScheduleCloudAutoload = function (opts) {
        opts = opts || {};
        if (g.FP_CLOUD_AUTOLOAD === false) {
            return Promise.resolve({ loaded: false, reason: 'disabled' });
        }
        if (opts.force || opts.boot) {
            if (typeof g.fpResetCloudAutoloadForRetry === 'function') {
                g.fpResetCloudAutoloadForRetry();
            }
        }
        opts.force = true;
        return g.fpTryCloudAutoload(opts);
    };

    function fpApplyCloudAutosaveSession(session) {
        if (session) {
            if (g.FP_CLOUD_AUTOSAVE !== false) g.fpInitCloudAutosave();
            if (g.__fpIntranetBootComplete && g.FP_CLOUD_AUTOLOAD !== false && typeof g.fpScheduleCloudAutoload === 'function') {
                g.fpScheduleCloudAutoload({ afterLogin: true }).catch(function (e) {
                    console.warn('[fp-cloud] autoload pós-login', e);
                });
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
            if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
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
