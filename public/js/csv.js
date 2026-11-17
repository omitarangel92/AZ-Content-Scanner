// Generación de CSV segura. Funciona en el navegador (window.AZCsv) y en Node (tests).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.AZCsv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    // El contenido rastreado (snippets, notas) no es de confianza: una celda que empiece por = + - @ (o tab/CR)
    // la interpretaría Excel como fórmula. Se antepone una comilla para neutralizarla.
    function csvEscape(v) {
        let s = String(v ?? '');
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    // ';' como separador (Excel en español) y BOM UTF-8 para que respete tildes
    function buildCsv(header, rows) {
        return '﻿' + [header, ...rows].map(r => r.map(csvEscape).join(';')).join('\r\n');
    }

    return { csvEscape, buildCsv };
});
