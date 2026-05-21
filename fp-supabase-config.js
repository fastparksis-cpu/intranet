/**
 * Supabase — FastPark Intranet
 *
 * Onde obter os valores: Supabase → Project Settings → API
 *   - Project URL  → FP_SUPABASE_URL
 *   - anon public  → FP_SUPABASE_ANON_KEY
 *
 * Incluir este ficheiro ANTES de @supabase/supabase-js, fp-auth.js e fp-supabase-sync.js
 */
(function (g) {
    'use strict';

    /** URL do projeto (Settings → API → Project URL) */
    g.FP_SUPABASE_URL = 'https://rybkvfxyccbxlahhfcji.supabase.co';

    /** Chave anon / public (Settings → API → anon public) — segura no browser com RLS activo */
    g.FP_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5Ymt2Znh5Y2NieGxhaGhmY2ppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NjExOTEsImV4cCI6MjA5NDMzNzE5MX0.0pQz49q2tCdXD_SQtATsgSc1ToR6n18KHznyA8RwH4Q';

    /** Bucket Storage (criado pelo SQL supabase/SALVAR_DADOS_E_DOCUMENTOS.sql) */
    g.FP_STORAGE_BUCKET = 'intranet-files';

    /** Linha do snapshot JSON na tabela intranet_snapshots */
    g.FP_SNAPSHOT_ROW_ID = 'main';

    /** Auto-gravação na nuvem após alterações (debounce em ms) */
    g.FP_CLOUD_AUTOSAVE = true;
    g.FP_CLOUD_AUTOSAVE_DEBOUNCE_MS = 500;

    /**
     * Modo rápido: carrega JSON na hora; fotos/docs com URL assinada em segundo plano.
     * Gravação envia ficheiros novos em paralelo (não espera listar o bucket inteiro).
     */
    g.FP_CLOUD_FAST_SYNC = true;
    g.FP_CLOUD_UPLOAD_CONCURRENCY = 12;
    g.FP_CLOUD_MEDIA_PREFETCH_CONCURRENCY = 16;
    /** Em auto-gravação não espera 3s pelos iframes — usa dados já em memória */
    g.FP_CLOUD_QUICK_SAVE = true;

    /** Ao abrir a intranet com login, carrega snapshot + ficheiros do Supabase automaticamente */
    g.FP_CLOUD_AUTOLOAD = true;
    /** Após auto-carregar, não gravar de volta na nuvem durante este tempo (evita sobrescrever com cache local) */
    /** Pausa auto-gravação só logo após carregar da nuvem (evita eco); edições do utilizador ignoram a pausa */
    g.FP_CLOUD_AUTOLOAD_AUTOSAVE_PAUSE_MS = 20000;

    /** Rotas (Vercel: intranet-fastpark.html com cleanUrls, ou Intranet_FastPark_Integrada.html) */
    g.FP_LOGIN_URL = '/';
    g.FP_APP_URL = '/Intranet_FastPark_Integrada.html';
    /** cleanUrls Vercel: sem .html; %20 uma vez só (não usar encodeURI em cima disto) */
    g.FP_CADASTRO_URL = '/DashBoard%20RH';

    g.fpSupabaseConfigIsReady = function () {
        var url = String(g.FP_SUPABASE_URL || '').trim();
        var key = String(g.FP_SUPABASE_ANON_KEY || '').trim();
        if (!url || !key) return false;
        if (/COLOQUE|YOUR_|xxx|example/i.test(url + key)) return false;
        if (!/^https:\/\/.+\.supabase\.co\/?$/i.test(url.replace(/\/$/, '') + '/')) return false;
        if (key.length < 80) return false;
        return true;
    };
})(typeof window !== 'undefined' ? window : globalThis);
