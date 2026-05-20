/**
 * Supabase — preencha URL e chave anon do projeto (Settings → API).
 * Incluir antes de @supabase/supabase-js e de fp-auth-guard.js / login.
 */
(function (g) {
    'use strict';
    g.FP_SUPABASE_URL = 'https://rybkvfxyccbxlahhfcji.supabase.co';
    g.FP_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5Ymt2Znh5Y2NieGxhaGhmY2ppIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NjExOTEsImV4cCI6MjA5NDMzNzE5MX0.0pQz49q2tCdXD_SQtATsgSc1ToR6n18KHznyA8RwH4Q';
    g.FP_STORAGE_BUCKET = 'intranet-files';
    g.FP_SNAPSHOT_ROW_ID = 'main';
    /** Grava na nuvem automaticamente após alterações (debounce em ms). */
    g.FP_CLOUD_AUTOSAVE = true;
    g.FP_CLOUD_AUTOSAVE_DEBOUNCE_MS = 12000;
})(typeof window !== 'undefined' ? window : globalThis);
