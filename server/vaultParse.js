// Lógica pura (sin navegador) para interpretar fichas de PromoMats: fechas, vigencia y estado del documento.
// Separada de vaultClient.js para poder probarla sin Playwright.
const config = require('./config');

// Español, inglés y portugués (Brasil está en alcance: fev, mai, out, dez)
const MONTHS = {
    jan: 0, ene: 0, feb: 1, fev: 1, mar: 2, apr: 3, abr: 3, may: 4, mai: 4, jun: 5, jul: 6,
    aug: 7, ago: 7, sep: 8, set: 8, oct: 9, out: 9, nov: 10, dec: 11, dic: 11, dez: 11
};

// Interpreta dd/mm/yyyy o mm/dd/yyyy, yyyy-mm-dd y "8 Oct 2025".
// El orden día/mes depende de la configuración regional del usuario de Vault: si un componente es > 12 se
// deduce solo; si es ambiguo (ej. 03/04/2026) se usa `format` (por defecto VAULT_DATE_FORMAT, 'dmy').
function parseDate(str, format = config.vaultDateFormat) {
    if (!str) return null;
    const s = String(str).trim();
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m) {
        const a = +m[1], b = +m[2];
        let day = a, month = b;
        if (a > 12) { day = a; month = b; }
        else if (b > 12) { day = b; month = a; }
        else if (format === 'mdy') { day = b; month = a; }
        if (month < 1 || month > 12 || day < 1 || day > 31) return null;
        return new Date(Date.UTC(+m[3], month - 1, day));
    }
    m = s.match(/(\d{1,2})[\s\-]+([A-Za-z]{3})[a-z]*[\s\-,]+(\d{4})/);
    if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
        return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1]));
    }
    return null;
}

const toIso = (d) => (d ? d.toISOString().slice(0, 10) : null);

function todayUtc() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// Días hasta la fecha de vencimiento (yyyy-mm-dd); negativo si ya venció; null si no hay fecha válida
function daysRemaining(expiration, today = todayUtc()) {
    if (!expiration) return null;
    const exp = new Date(expiration + 'T00:00:00Z');
    if (isNaN(exp.getTime())) return null;
    return Math.floor((exp - today) / 86400000);
}

function classify(expiration, warningDays = config.warningDays, today = todayUtc()) {
    const days = daysRemaining(expiration, today);
    if (days === null) return 'SIN FECHA FIABLE';
    if (days < 0) return 'VENCIDO';
    if (days <= warningDays) return 'PROXIMO A VENCER';
    return 'VIGENTE';
}

// Valor del campo de estado del documento (ej. "Retired"). Se ancla a la ETIQUETA al inicio de línea:
// buscar "status" en cualquier parte de la ficha tomaba textos ajenos (filtros, historial, comentarios).
function lifecycleState(text) {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const label = /^(processing status|lifecycle state|lifecycle|status|state|estado del ciclo de vida|estado|situa[cç][aã]o)\s*:?\s*(.*)$/i;
    for (let i = 0; i < lines.length; i++) {
        const m = label.exec(lines[i]);
        if (!m) continue;
        const value = (m[2] || lines[i + 1] || '').trim();
        if (value && value.length <= 40) return value;
    }
    return '';
}

function isRetired(value, retiredValues = config.vaultLabels.retiredValues) {
    const t = String(value || '').trim().toLowerCase();
    return !!t && retiredValues.some(v => t === v || t.startsWith(v + ' '));
}

// ¿El estado del documento es «aprobado»? Igual que isRetired: coincidencia exacta o por prefijo, sin mayúsculas
function isApproved(value, approvedValues = config.vaultLabels.approvedValues) {
    const t = String(value || '').trim().toLowerCase();
    return !!t && approvedValues.some(v => t === v || t.startsWith(v + ' '));
}

module.exports = { MONTHS, parseDate, toIso, todayUtc, daysRemaining, classify, lifecycleState, isRetired, isApproved };
