/**

 * Caminhos no servidor de rede — FastPark

 * Intranet (HTML) e planilha Excel podem estar em pastas diferentes.

 */

(function (g) {

    'use strict';

    var INTRANET = '\\\\192.168.0.64\\Servidor\\DP\\GESTÃO RH\\Intranet - Fast';

    var BANK_DIR = '\\\\192.168.0.64\\Servidor\\DP\\GESTÃO RH\\GESTÃO DE FUNCIONARIOS';

    var BANK = 'BANCO DE DADOS.xlsx';

    g.FP_INTRANET_BASE_UNC = INTRANET;

    g.FP_BANK_XLSX_DIR = BANK_DIR;

    g.FP_BANK_XLSX_NAME = BANK;

    g.FP_BANK_XLSX_PATH_HINT = BANK_DIR + '\\' + BANK;

    g.FP_INTRANET_FOLDERS = {

        anexos: INTRANET + '\\anexos',

        pagas: INTRANET + '\\anexos\\pagas',

        unidades: INTRANET + '\\anexos\\unidades',

        faltas: INTRANET + '\\anexos\\faltas',

        sinistros: INTRANET + '\\anexos\\sinistros',

        geral: INTRANET + '\\anexos\\geral'

    };

    g.FP_BRIDGE_HOST = '192.168.0.64';

    g.FP_BRIDGE_PORT = 8765;

    g.FP_BRIDGE_ENABLED = false;

    g.FP_BRIDGE_WRITE_HTML = false;

    /** Login Supabase sempre obrigatório. */
    g.FP_AUTH_REQUIRED = true;

    g.FP_PROPOSTA_MODELO_PATH = '\\\\192.168.0.64\\Servidor\\Propostas\\00-Modelo\\Modelo proposta Fast.pptx';

})(typeof window !== 'undefined' ? window : globalThis);

