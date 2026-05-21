/**
 * Cliente da ponte FastPark — gravação automática na rede sem seletor de ficheiros.
 * Requer fp-local-bridge-server.mjs em execução (Iniciar Ponte Rede.bat).
 */
(function (g) {
    'use strict';

    var BRIDGE_HOST = g.FP_BRIDGE_HOST || '192.168.0.64';
    var BRIDGE_PORT = g.FP_BRIDGE_PORT || 8765;
    var BRIDGE_BASE = (g.FP_BRIDGE_URL || ('http://' + BRIDGE_HOST + ':' + BRIDGE_PORT)).replace(/\/$/, '');
    var bridgeTimer = null;
    var bridgeXlsxTimer = null;
    var bridgeWriting = false;
    var bridgeXlsxWriting = false;

    function bridgeUrl(path) {
        return BRIDGE_BASE + path;
    }

    g.fpBridgeGetUrl = function () {
        return BRIDGE_BASE;
    };

    async function bridgeFetch(path, opts) {
        opts = opts || {};
        var ctrl = new AbortController();
        var t = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 60000);
        try {
            return await fetch(bridgeUrl(path), Object.assign({}, opts, { signal: ctrl.signal }));
        } finally {
            clearTimeout(t);
        }
    }

    g.fpBridgeProbe = async function () {
        if (g.FP_BRIDGE_ENABLED === false) {
            g.__fpBridgeActive = false;
            return false;
        }
        try {
            var r = await bridgeFetch('/health', { method: 'GET', timeoutMs: 3000 });
            if (!r.ok) return false;
            var j = await r.json();
            g.__fpBridgeActive = !!(j && j.ok);
            g.__fpBridgeHealth = j;
            return g.__fpBridgeActive;
        } catch (e) {
            g.__fpBridgeActive = false;
            g.__fpBridgeHealth = null;
            return false;
        }
    };

    g.fpBridgeUpdateUi = function () {
        var el = g.document.getElementById('fpBridgeBanner');
        if (!el) return;
        if (g.__fpBridgeActive) {
            el.style.color = '#0f6b4a';
            el.textContent = 'Ponte de rede: ligada.';
        } else {
            el.style.color = '#6b7280';
            el.textContent = '';
        }
        if (typeof g.fpRefreshXlsxDbBanner === 'function') g.fpRefreshXlsxDbBanner();
        if (typeof g.fpRefreshAutosaveBanner === 'function') g.fpRefreshAutosaveBanner();
        if (typeof g.fpRefreshAttDirBanner === 'function') g.fpRefreshAttDirBanner();
    };

    g.fpBridgeWriteXlsxBytes = async function (uint8) {
        if (!g.__fpBridgeActive) return false;
        var r = await bridgeFetch('/xlsx', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            body: uint8
        });
        if (!r.ok) {
            var err = await r.json().catch(function () { return {}; });
            throw new Error((err && err.error) || ('HTTP ' + r.status));
        }
        return true;
    };

    g.fpBridgeWriteHtml = async function (htmlText) {
        if (!g.__fpBridgeActive) return false;
        var r = await bridgeFetch('/html', {
            method: 'PUT',
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
            body: htmlText
        });
        if (!r.ok) {
            var err = await r.json().catch(function () { return {}; });
            throw new Error((err && err.error) || ('HTTP ' + r.status));
        }
        return true;
    };

    g.fpBridgeWriteAttachment = async function (relPath, blob) {
        if (!g.__fpBridgeActive) return false;
        var q = '/attachment?path=' + encodeURIComponent(String(relPath).replace(/\\/g, '/'));
        var r = await bridgeFetch(q, { method: 'PUT', body: blob });
        if (!r.ok) {
            var err = await r.json().catch(function () { return {}; });
            throw new Error((err && err.error) || ('HTTP ' + r.status));
        }
        return true;
    };

    g.fpBridgeReadAttachmentAsDataUrl = async function (relPath) {
        if (!g.__fpBridgeActive) return null;
        var q = '/attachment?path=' + encodeURIComponent(String(relPath).replace(/\\/g, '/'));
        var r = await bridgeFetch(q, { method: 'GET', timeoutMs: 120000 });
        if (!r.ok) return null;
        var buf = await r.arrayBuffer();
        var mime = r.headers.get('Content-Type') || 'application/octet-stream';
        var bin = '';
        var bytes = new Uint8Array(buf);
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + chunk, bytes.length)));
        }
        return 'data:' + mime + ';base64,' + btoa(bin);
    };

    g.fpBridgeTryLoadXlsx = async function () {
        if (!g.__fpBridgeActive) return false;
        if (typeof g.fpIsEmbeddedActive === 'function' && g.fpIsEmbeddedActive()) return false;
        if (typeof g.loadWorkbook !== 'function' || typeof g.XLSX === 'undefined') return false;
        var hasEmp = g.state && g.state.employees && g.state.employees.length;
        var hasQ = g.state && g.state.quadroGeral && g.state.quadroGeral.length;
        if (hasEmp || hasQ) return false;
        try {
            var ls = g.localStorage.getItem('fp_employees_json');
            if (ls && ls.length > 4 && ls !== '[]') return false;
        } catch (_ls) {}
        try {
            var r = await bridgeFetch('/xlsx', { method: 'GET', timeoutMs: 120000 });
            if (!r.ok) return false;
            var buf = new Uint8Array(await r.arrayBuffer());
            g.loadWorkbook(buf);
            if (typeof g.propagateWorkbookToEmbeddedDashboardIframes === 'function') {
                g.propagateWorkbookToEmbeddedDashboardIframes(buf);
            }
            if (typeof g.fpSetXlsxDbStatusLine === 'function') {
                g.fpSetXlsxDbStatusLine('Planilha carregada automaticamente da rede — ' + new Date().toLocaleString('pt-BR'));
            }
            return true;
        } catch (e) {
            console.warn('[fp-bridge] load xlsx', e);
            return false;
        }
    };

    g.fpBridgeExecuteWriteXlsx = async function () {
        if (!g.__fpBridgeActive || bridgeXlsxWriting) return;
        if (typeof g.fpIsEmbeddedActive === 'function' && g.fpIsEmbeddedActive()) return;
        if (typeof g.fpMergeWorkbookForWrite !== 'function' || typeof g.XLSX === 'undefined') return;
        bridgeXlsxWriting = true;
        try {
            var wb = await g.fpMergeWorkbookForWrite();
            var out = g.XLSX.write(wb, { bookType: 'xlsx', type: 'array', cellDates: true });
            await g.fpBridgeWriteXlsxBytes(new Uint8Array(out));
            if (typeof g.fpSetXlsxDbStatusLine === 'function') {
                g.fpSetXlsxDbStatusLine('Planilha na rede actualizada — ' + new Date().toLocaleString('pt-BR'));
            }
        } catch (e) {
            console.error('[fp-bridge] write xlsx', e);
            if (typeof g.fpSetXlsxDbStatusLine === 'function') {
                g.fpSetXlsxDbStatusLine('Erro ponte (Excel): ' + (e && e.message));
            }
        } finally {
            bridgeXlsxWriting = false;
        }
    };

    g.fpBridgeScheduleXlsxSync = function () {
        if (!g.__fpBridgeActive) return;
        clearTimeout(bridgeXlsxTimer);
        bridgeXlsxTimer = setTimeout(function () {
            g.fpBridgeExecuteWriteXlsx().catch(function (e) { console.error(e); });
        }, 4000);
    };

    g.fpBridgeScheduleHtmlSync = function () {
        if (!g.__fpBridgeActive) return;
        clearTimeout(bridgeTimer);
        bridgeTimer = setTimeout(function () {
            g.fpBridgePersistHtmlFromDom().catch(function (e) { console.error(e); });
        }, 2200);
    };

    g.fpBridgePersistHtmlFromDom = async function () {
        if (!g.__fpBridgeActive || bridgeWriting) return;
        if (typeof g.fpIntranetHasDataForSnapshot !== 'function' || !g.fpIntranetHasDataForSnapshot()) return;
        if (typeof g.fpBuildEmbeddedJsonString !== 'function') return;
        bridgeWriting = true;
        var prevPause = g.window.__fpLsHookPause;
        g.window.__fpLsHookPause = true;
        try {
            var jsonStr = await g.fpBuildEmbeddedJsonString();
            var el = g.document.getElementById('fp-embedded-intranet-db');
            if (el) el.textContent = jsonStr;
            if (g.FP_BRIDGE_WRITE_HTML !== true) return;
            var htmlOut = '<!DOCTYPE html>\n' + g.document.documentElement.outerHTML;
            await g.fpBridgeWriteHtml(htmlOut);
            if (typeof g.fpSetEmbeddedStatusLine === 'function') {
                g.fpSetEmbeddedStatusLine('HTML gravado na rede (ponte) — ' + new Date().toLocaleString('pt-BR'));
            }
        } catch (e) {
            console.error('[fp-bridge] write html', e);
            if (typeof g.fpSetEmbeddedStatusLine === 'function') {
                g.fpSetEmbeddedStatusLine('Erro ponte (HTML): ' + (e && e.message));
            }
        } finally {
            g.window.__fpLsHookPause = prevPause;
            bridgeWriting = false;
        }
    };

    g.fpBridgeInit = async function () {
        if (g.FP_BRIDGE_ENABLED === false) {
            g.__fpBridgeActive = false;
            g.fpBridgeUpdateUi();
            return false;
        }
        await g.fpBridgeProbe();
        g.fpBridgeUpdateUi();
        if (!g.__fpBridgeActive) return false;
        await g.fpBridgeTryLoadXlsx();
        if (!g.__fpBridgeAutosaveHooked) {
            g.__fpBridgeAutosaveHooked = true;
            g.document.addEventListener('fp-intranet-changed', function () {
                g.fpBridgeScheduleXlsxSync();
            });
        }
        g.fpBridgeUpdateUi();
        return true;
    };

    if (!g.__fpBridgeProbeInterval && g.FP_BRIDGE_ENABLED !== false) {
        g.__fpBridgeProbeInterval = setInterval(function () {
            if (g.__fpBridgeActive) return;
            g.fpBridgeProbe().then(function (ok) {
                if (ok) g.fpBridgeInit().catch(function (e) { console.warn(e); });
            });
        }, 20000);
    }
})(typeof window !== 'undefined' ? window : globalThis);
