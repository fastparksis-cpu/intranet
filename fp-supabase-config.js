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
    g.FP_CLOUD_AUTOSAVE_DEBOUNCE_MS = 12000;

    /** Rotas (local: ficheiros .html | Vercel: vercel.json rewrites) */
    g.FP_LOGIN_URL = '/';
    g.FP_APP_URL = '/intranet-fastpark';

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
