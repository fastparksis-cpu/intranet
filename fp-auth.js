/**
 * Cliente Supabase + helpers de sessão para a intranet FastPark.
 * Depende de: fp-supabase-config.js, CDN @supabase/supabase-js
 */
(function (g) {
    'use strict';

    var url = g.FP_SUPABASE_URL;
    var key = g.FP_SUPABASE_ANON_KEY;

    var configOk = typeof g.fpSupabaseConfigIsReady === 'function' ? g.fpSupabaseConfigIsReady() : !!(url && key);
    if (!configOk) {
        console.error('[fp-auth] Defina FP_SUPABASE_URL e FP_SUPABASE_ANON_KEY em fp-supabase-config.js');
        g.fpAuthReady = Promise.reject(new Error('Supabase não configurado'));
        return;
    }

    if (!g.supabase || typeof g.supabase.createClient !== 'function') {
        console.error('[fp-auth] Carregue @supabase/supabase-js antes de fp-auth.js');
        g.fpAuthReady = Promise.reject(new Error('Biblioteca Supabase ausente'));
        return;
    }

    var client = g.supabase.createClient(url, key, {
        auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true,
            storage: g.localStorage
        }
    });
    g.fpSupabase = client;

    function fpIsLocalFileOpen() {
        try {
            return g.location && g.location.protocol === 'file:';
        } catch (e) {
            return false;
        }
    }

    g.fpLoginUrl = function () {
        if (fpIsLocalFileOpen()) return 'index.html';
        return String(g.FP_LOGIN_URL || '/').trim() || '/';
    };

    g.fpAppUrl = function () {
        if (fpIsLocalFileOpen()) return 'Intranet_FastPark_Integrada.html';
        var u = String(g.FP_APP_URL || '/intranet-fastpark').trim() || '/intranet-fastpark';
        if (u.endsWith('/')) u = u.replace(/\/+$/, '');
        return u;
    };

    function fpIsLoginPath() {
        try {
            var p = (g.location.pathname || '/').replace(/\/$/, '') || '/';
            return p === '/' || p === '/index.html' || /index\.html$/i.test(p);
        } catch (e) {
            return true;
        }
    }

    /** Sempre lê a sessão actual (não usar cache do primeiro carregamento). */
    g.fpGetAuthContext = function () {
        return client.auth.getSession().then(function (res) {
            return { client: client, session: res.data.session };
        });
    };

    g.fpAuthReady = g.fpGetAuthContext();

    g.fpGoToApp = function (appPage) {
        appPage = appPage || g.fpAppUrl();
        return g.fpGetAuthContext().then(function (ctx) {
            if (ctx.session) {
                g.location.replace(appPage);
                return true;
            }
            return false;
        });
    };

    g.fpRequireSession = function (loginPage) {
        loginPage = loginPage || g.fpLoginUrl();
        if (g.FP_AUTH_REQUIRED === false) {
            return Promise.resolve(null);
        }
        return g.fpGetAuthContext().then(function (ctx) {
            if (!ctx.session) {
                g.location.replace(loginPage);
                return null;
            }
            return ctx.session;
        }).catch(function (err) {
            console.warn('[fp-auth] sessão indisponível:', err);
            g.location.replace(loginPage);
            return null;
        });
    };

    g.fpRedirectIfSession = function (appPage) {
        return g.fpGoToApp(appPage);
    };

    g.fpSignIn = function (email, password) {
        return client.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
            if (res.error) return res;
            if (res.data && res.data.session) return res;
            return client.auth.getSession().then(function (sr) {
                return {
                    data: { user: sr.data.session && sr.data.session.user, session: sr.data.session },
                    error: sr.data.session ? null : { message: 'Sessão não gravada no navegador.' }
                };
            });
        });
    };

    g.fpSignOut = function () {
        return client.auth.signOut();
    };

    g.fpLogout = function (loginPage) {
        loginPage = loginPage || g.fpLoginUrl();
        return client.auth.signOut().then(function () {
            g.location.replace(loginPage);
        }).catch(function () {
            g.location.replace(loginPage);
        });
    };

    client.auth.onAuthStateChange(function (event, session) {
        if (!session) return;
        if (!fpIsLoginPath()) return;
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
            g.location.replace(g.fpAppUrl());
        }
    });
})(typeof window !== 'undefined' ? window : globalThis);
