const authManager = require('./authManager');
const config = require('./config');

const MONTHS = {
    jan: 0, ene: 0, feb: 1, mar: 2, apr: 3, abr: 3, may: 4, jun: 5, jul: 6,
    aug: 7, ago: 7, sep: 8, set: 8, oct: 9, nov: 10, dec: 11, dic: 11
};

// Interpreta dd/mm/yyyy (formato de PromoMats), yyyy-mm-dd y "8 Oct 2025"
function parseDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
    if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
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

const SEARCH_INPUT_SELECTORS = [
    'input[placeholder*="Search" i]',
    'input[placeholder*="Buscar" i]',
    'input[aria-label*="Search" i]',
    'input[aria-label*="Buscar" i]',
    'input[type="search"]',
    'input[name*="search" i]',
    'input[id*="search" i]',
    '.vv_search_input',
    '.search-input input',
    'header input[type="text"]'
];

const VAULT_CLIENT_VERSION = 'v8-row-match';

class VaultClient {
    constructor() {
        this.cache = new Map();
        this.browser = null;
        this.context = null;
        this.pages = [];
        this.available = false;
        this.lastError = null;
    }

    get cfg() { return config.services.promomats; }

    async init() {
        this.cache.clear();
        this.lastError = null;
        this.available = false;
        this.pages = [];

        if (!authManager.hasSession('promomats')) {
            this.lastError = 'Sin sesión de PromoMats';
            return { success: false, error: this.lastError };
        }
        if (!this.cfg.host) {
            this.lastError = 'VAULT_HOST no configurado en .env';
            return { success: false, error: this.lastError };
        }
        try {
            const { browser, context } = await authManager.createServiceContext('promomats');
            this.browser = browser;
            this.context = context;

            const first = await context.newPage();
            await first.goto(`https://${this.cfg.host}/ui/`, { waitUntil: 'domcontentloaded', timeout: 40000 });
            await first.waitForTimeout(6000);

            if (!first.url().includes(this.cfg.host)) {
                this.lastError = 'La sesión de PromoMats expiró (redirigió al login)';
                await this.close();
                return { success: false, error: this.lastError };
            }
            this.pages.push(first);

            // Pestañas adicionales para consultar varios IDs en paralelo
            for (let i = 1; i < config.vaultConcurrency; i++) {
                this.pages.push(await context.newPage());
            }
            this.available = true;
            return { success: true };
        } catch (e) {
            this.lastError = e.message;
            await this.close();
            return { success: false, error: e.message };
        }
    }

    classify(expiration) {
        if (!expiration) return 'SIN FECHA FIABLE';
        const exp = new Date(expiration + 'T00:00:00Z');
        if (isNaN(exp.getTime())) return 'SIN FECHA FIABLE';
        const days = Math.floor((exp - todayUtc()) / 86400000);
        if (days < 0) return 'VENCIDO';
        if (days <= config.warningDays) return 'PROXIMO A VENCER';
        return 'VIGENTE';
    }

    daysRemaining(expiration) {
        if (!expiration) return null;
        const exp = new Date(expiration + 'T00:00:00Z');
        if (isNaN(exp.getTime())) return null;
        return Math.floor((exp - todayUtc()) / 86400000);
    }

    isRetired(text) {
        const t = String(text || '').toLowerCase();
        return config.vaultLabels.retiredValues.some(v => t.includes(v));
    }

    async pageText(page) {
        return page.evaluate(() => document.body.innerText || '');
    }

    // "Expiration Date" como etiqueta exacta (no "Expiration Notes")
    hasExpirationDateLabel(text) {
        return /(^|\n)\s*Expiration Date\s*(\n|$)/i.test(text) ||
               /(^|\n)\s*Fecha de (Vencimiento|Expiraci[oó]n)\s*(\n|$)/i.test(text);
    }

    // Despliega la seccion "Key Dates". Prueba varias estrategias.
    async expandKeyDates(page) {
        try {
            let text = await this.pageText(page);
            if (this.hasExpirationDateLabel(text)) return true;

            await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('*'));
                const matches = all.filter(el => (el.innerText || '').trim() === 'Key Dates');
                if (matches.length) {
                    const el = matches[matches.length - 1];
                    el.scrollIntoView({ block: 'center' });
                    el.click();
                    if (el.parentElement) el.parentElement.click();
                }
            });
            await page.waitForTimeout(1800);
            text = await this.pageText(page);
            if (this.hasExpirationDateLabel(text)) return true;

            await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('a, button, span, div'));
                const el = all.find(n => (n.innerText || '').trim() === 'See more details');
                if (el) el.click();
            });
            await page.waitForTimeout(2500);
            text = await this.pageText(page);
            if (this.hasExpirationDateLabel(text)) return true;

            await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('*'));
                const matches = all.filter(el => (el.innerText || '').trim() === 'Key Dates');
                if (matches.length) matches[matches.length - 1].click();
            });
            await page.waitForTimeout(1800);
            text = await this.pageText(page);
            return this.hasExpirationDateLabel(text);
        } catch (e) {
            return false;
        }
    }

    // Etiqueta y fecha van en lineas consecutivas. Si un campo esta vacio
    // (ej. "Actual Date of First Use"), la siguiente linea es OTRA etiqueta, no su valor.
    extractDates(text) {
        const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

        const readLabel = (labels) => {
            for (let i = 0; i < lines.length; i++) {
                const lower = lines[i].toLowerCase();
                for (const label of labels) {
                    const l = label.toLowerCase();
                    if (lower === l || lower.startsWith(l + ' ')) {
                        let d = parseDate(lines[i].substring(label.length));
                        if (d) return d;
                        for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
                            d = parseDate(lines[j]);
                            if (d) return d;
                            if (/[A-Za-z]{4,}/.test(lines[j])) break;
                        }
                    }
                }
            }
            return null;
        };

        return {
            approved: readLabel(config.vaultLabels.approved),
            expiration: readLabel(config.vaultLabels.expiration)
        };
    }

    async extractDatesFromDom(page) {
        const raw = await page.evaluate((labels) => {
            const out = {};
            const all = Array.from(document.querySelectorAll('*'));
            for (const key of Object.keys(labels)) {
                for (const label of labels[key]) {
                    const el = all.find(n => n.children.length === 0 && (n.innerText || '').trim() === label);
                    if (!el) continue;
                    let cand = el.nextElementSibling;
                    if (!cand && el.parentElement) cand = el.parentElement.nextElementSibling;
                    if (cand) { out[key] = (cand.innerText || '').trim(); break; }
                }
            }
            return out;
        }, { approved: config.vaultLabels.approved, expiration: config.vaultLabels.expiration });

        return {
            approved: parseDate(raw.approved),
            expiration: parseDate(raw.expiration)
        };
    }

    // Numero de documento que muestra la ficha abierta (ej. "CC-14803")
    docNumberOf(text) {
        const m = text.match(/Document Number\s*\n?\s*([A-Z]{2}-\d{4,6})/i);
        return m ? m[1].toUpperCase() : null;
    }

    // Escribe el codigo en el buscador global y devuelve el input usado
    async runSearch(page, safe, trace) {
        // Pagina neutra para que los resultados de la busqueda anterior no se confundan con los nuevos
        await page.goto(`https://${this.cfg.host}/ui/#library`, { waitUntil: 'domcontentloaded', timeout: 40000 });
        await page.waitForTimeout(3500);

        let input = null;
        for (const sel of SEARCH_INPUT_SELECTORS) {
            const el = await page.$(sel);
            if (el && await el.isVisible().catch(() => false)) { input = el; trace.searchBox = sel; break; }
        }
        if (!input) return false;

        await input.click({ clickCount: 3 }).catch(() => {});
        await input.fill('');
        await input.type(`"${safe}"`, { delay: 30 });
        await page.keyboard.press('Enter');
        trace.submitted = true;

        // Esperar a que la lista muestre EXACTAMENTE este codigo en el encabezado "Search for:"
        const start = Date.now();
        while (Date.now() - start < 15000) {
            await page.waitForTimeout(800);
            const text = await this.pageText(page);
            if (new RegExp(`Search for:\\s*"?${safe}"?`, 'i').test(text) && text.toUpperCase().includes(safe.toUpperCase())) {
                trace.resultsListed = true;
                return true;
            }
            if (/no results|no se encontraron|0 of 0/i.test(text) && text.toUpperCase().includes(safe.toUpperCase())) {
                trace.resultsListed = false;
                return true;
            }
        }
        return true;
    }

    // Busca el codigo y abre la ficha del documento. Reintenta una vez si la ficha no coincide.
    async openDocument(page, approvalId) {
        const safe = approvalId.replace(/[^A-Za-z0-9-]/g, '');
        const trace = {
            searchBox: null, submitted: false, resultsListed: false,
            linkFound: null, resultClicked: false, docUrl: null, onDocPage: false,
            keyDatesOpen: false, attempts: 0
        };

        for (let attempt = 1; attempt <= 2; attempt++) {
            trace.attempts = attempt;
            trace.resultsListed = false;
            trace.linkFound = null;
            trace.resultClicked = false;

            const ok = await this.runSearch(page, safe, trace);
            if (!trace.searchBox) return { found: false, trace };
            if (!ok || !trace.resultsListed) {
                if (attempt === 2) return { found: false, trace };
                continue;
            }

            // Enlace "doc_info" que pertenece a la fila que contiene EXACTAMENTE este codigo
            // Se busca la fila mas pequena que contenga el codigo EXACTO (CC-9250 no casa con CC-92501)
            // y enlace a un unico documento. Antes se subia 6 niveles y se llegaba al contenedor de toda
            // la lista, por lo que se abria el primer resultado aunque fuera otro documento.
            const link = await page.evaluate((id) => {
                const esc = id.replace(/[-]/g, '\\-');
                const re = new RegExp(`(^|[^A-Z0-9])${esc}(?![0-9])`);
                const docOf = (h) => ((h || '').match(/doc_info\/(\d+)/) || [])[1] || h;
                const anchors = Array.from(document.querySelectorAll('a[href*="doc_info"]'));
                let best = null;
                for (const a of anchors) {
                    let node = a;
                    for (let i = 0; i < 12 && node && node !== document.body; i++) {
                        const t = (node.innerText || '').toUpperCase();
                        if (re.test(t)) {
                            const docs = new Set(Array.from(node.querySelectorAll('a[href*="doc_info"]'))
                                .map(x => docOf(x.getAttribute('href'))));
                            if (docs.size === 1 && (!best || t.length < best.len)) best = { href: a.getAttribute('href'), len: t.length };
                            break;
                        }
                        node = node.parentElement;
                    }
                }
                return best ? best.href : null;
            }, safe);

            if (link) {
                trace.linkFound = link;
                const m = link.match(/doc_info\/(\d+)\/(\d+)\/(\d+)/);
                const target = m
                    ? `https://${this.cfg.host}/ui/#doc_info/${m[1]}/${m[2]}/${m[3]}`
                    : (link.startsWith('http') ? link : `https://${this.cfg.host}/ui/${link.replace(/^\/?(ui\/)?/, '')}`);
                await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 40000 });
                trace.resultClicked = true;
            } else {
                // Respaldo: clic sobre el titulo del documento dentro de la fila que contiene el codigo
                const clicked = await page.evaluate((id) => {
                    const re = new RegExp(`(^|[^A-Z0-9])${id.replace(/[-]/g, '\\-')}(?![0-9])`);
                    const rows = Array.from(document.querySelectorAll('tr, [role="row"], li, div'))
                        .filter(r => re.test((r.innerText || '').toUpperCase()) && (r.innerText || '').length < 600)
                        .sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
                    for (const row of rows) {
                        const titles = Array.from(row.querySelectorAll('a, [role="link"], h3, h4, span'))
                            .filter(el => el.children.length === 0 && /\(v\d+(\.\d+)?\)/i.test((el.innerText || '').trim()));
                        if (titles.length) { titles[0].click(); return true; }
                    }
                    return false;
                }, safe);
                trace.resultClicked = clicked;
                if (!clicked) {
                    if (attempt === 2) return { found: false, trace };
                    continue;
                }
            }

            await page.waitForTimeout(5500);
            trace.docUrl = page.url();
            trace.onDocPage = /doc_info\//.test(trace.docUrl);

            // Esperar a que aparezca el numero de documento de la ficha abierta
            let text = '';
            for (let i = 0; i < 8; i++) {
                text = await this.pageText(page);
                if (this.docNumberOf(text)) break;
                await page.waitForTimeout(1000);
            }

            if (/document not found|you do not have permission/i.test(text)) {
                if (attempt === 2) return { found: false, trace, notFoundPage: true };
                continue;
            }

            const docNumber = this.docNumberOf(text);
            if (docNumber && docNumber !== safe.toUpperCase()) {
                trace.docNumberMismatch = docNumber;
                if (attempt === 2) return { found: false, trace };
                continue; // reintentar con una busqueda limpia
            }
            delete trace.docNumberMismatch;

            if (!trace.onDocPage) {
                if (attempt === 2) return { found: false, trace };
                continue;
            }

            trace.keyDatesOpen = await this.expandKeyDates(page);
            return { found: true, trace };
        }
        return { found: false, trace };
    }

    async readDates(page) {
        const text = await this.pageText(page);
        let { approved, expiration } = this.extractDates(text);
        if (!approved || !expiration) {
            const dom = await this.extractDatesFromDom(page);
            approved = approved || dom.approved;
            expiration = expiration || dom.expiration;
        }
        return { approved, expiration, text };
    }

    // Diagnostico para validar la lectura con un caso real
    async inspect(approvalId) {
        if (!this.available) return { error: this.lastError || 'PromoMats no disponible', version: VAULT_CLIENT_VERSION };
        const safe = String(approvalId).replace(/[^A-Za-z0-9-]/g, '');
        const page = this.pages[0];
        const out = {
            version: VAULT_CLIENT_VERSION, approvalId: safe, found: false, trace: null, url: null,
            docNumber: null, datesFound: null, keyDatesSample: null, textSample: null, error: null
        };
        try {
            const res = await this.openDocument(page, safe);
            out.found = res.found;
            out.trace = res.trace;
            out.url = page.url();
            const { approved, expiration, text } = await this.readDates(page);
            out.docNumber = this.docNumberOf(text);
            out.datesFound = { approved: toIso(approved), expiration: toIso(expiration) };

            const idx = text.search(/Key Dates/i);
            out.keyDatesSample = idx >= 0 ? text.substring(idx, idx + 700).replace(/\s+/g, ' ') : null;
            out.textSample = text.replace(/\s+/g, ' ').substring(0, 1800);
        } catch (e) {
            out.error = e.message.split('\n')[0];
        }
        return out;
    }

    async lookupOne(page, approvalId) {
        const unknown = {
            status: 'SIN FECHA FIABLE', approvedDate: null, expirationDate: null,
            daysRemaining: null, note: 'No se pudo leer la ficha en PromoMats'
        };
        try {
            const res = await this.openDocument(page, approvalId);
            if (!res.found) {
                let why;
                if (!res.trace.searchBox) why = 'No se encontró el cuadro de búsqueda de PromoMats';
                else if (!res.trace.resultsListed) why = 'El código no apareció en los resultados de PromoMats';
                else if (res.notFoundPage) why = 'PromoMats mostró "Document Not Found"';
                else if (res.trace.docNumberMismatch) why = `La ficha abierta es ${res.trace.docNumberMismatch}, no ${approvalId} (tras ${res.trace.attempts} intentos)`;
                else why = 'No se pudo abrir la ficha del documento';

                return {
                    status: res.trace.searchBox && !res.trace.resultsListed ? 'ID NO ENCONTRADO' : 'SIN FECHA FIABLE',
                    approvedDate: null, expirationDate: null, daysRemaining: null, note: why
                };
            }

            const { approved, expiration, text } = await this.readDates(page);
            const statusLine = (text.match(/(processing status|lifecycle state|status|estado)[^\n]{0,40}/i) || [''])[0];

            if (this.isRetired(statusLine)) {
                return {
                    status: 'RETIRADO', approvedDate: toIso(approved), expirationDate: toIso(expiration),
                    daysRemaining: this.daysRemaining(toIso(expiration)),
                    note: 'Marcado como retirado/obsoleto en PromoMats'
                };
            }
            if (!expiration) {
                return {
                    status: 'SIN FECHA FIABLE', approvedDate: toIso(approved), expirationDate: null,
                    daysRemaining: null,
                    note: res.trace.keyDatesOpen
                        ? 'La ficha no muestra fecha de vencimiento legible'
                        : 'No se pudo desplegar la sección Key Dates'
                };
            }
            return {
                status: this.classify(toIso(expiration)),
                approvedDate: toIso(approved),
                expirationDate: toIso(expiration),
                daysRemaining: this.daysRemaining(toIso(expiration)),
                note: ''
            };
        } catch (e) {
            return { ...unknown, note: `Error consultando PromoMats: ${e.message.split('\n')[0]}` };
        }
    }

    // Cola de consultas en segundo plano: push(id) las encola, finish() espera a que terminen
    createStream(onProgress, shouldStop) {
        const self = this;
        const queue = [];
        const seen = new Set();
        const results = new Map();
        let total = 0;
        let done = 0;
        let closing = false;
        let wake = null;

        const unknown = (note) => ({
            status: 'SIN FECHA FIABLE', approvedDate: null, expirationDate: null,
            daysRemaining: null, note
        });

        const worker = async (page) => {
            while (true) {
                if (shouldStop && shouldStop()) return;
                if (queue.length === 0) {
                    if (closing) return;
                    await new Promise(resolve => { wake = resolve; setTimeout(resolve, 1500); });
                    continue;
                }
                const id = queue.shift();
                let r;
                if (self.cache.has(id)) r = self.cache.get(id);
                else {
                    r = await self.lookupOne(page, id);
                    self.cache.set(id, r);
                }
                results.set(id, r);
                done++;
                if (onProgress) onProgress(done, total);
            }
        };

        const workers = self.available ? self.pages.map(p => worker(p)) : [];

        return {
            push(id) {
                if (seen.has(id)) return;
                seen.add(id);
                total++;
                if (!self.available) {
                    results.set(id, unknown(self.lastError || 'PromoMats no disponible'));
                    done++;
                    return;
                }
                queue.push(id);
                if (wake) { const w = wake; wake = null; w(); }
            },
            async finish() {
                closing = true;
                if (wake) { const w = wake; wake = null; w(); }
                await Promise.all(workers);
                seen.forEach(id => {
                    if (!results.has(id)) results.set(id, unknown('No se consultó en PromoMats (escaneo cancelado)'));
                });
                return results;
            }
        };
    }

    async close() {
        if (this.browser) await this.browser.close().catch(() => {});
        this.browser = null; this.context = null; this.pages = []; this.available = false;
    }
}

module.exports = new VaultClient();