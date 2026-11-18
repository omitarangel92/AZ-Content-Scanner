const fs = require('fs');
const path = require('path');
const authManager = require('./authManager');
const config = require('./config');
const { atomicWriteSync } = require('./fsutil');

const { parseDate, toIso, todayUtc, daysRemaining, classify, lifecycleState, isRetired } = require('./vaultParse');

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

const VAULT_CLIENT_VERSION = 'v9-fast-waits';

const unknownResult = (note) => ({
    status: 'SIN FECHA FIABLE', approvedDate: null, expirationDate: null, daysRemaining: null, note
});

// Etiqueta "Expiration Date" exacta (no "Expiration Notes"); misma regla dentro y fuera del navegador
const EXPIRATION_LABEL_SRC = '(^|\\n)\\s*(Expiration Date|Fecha de (Vencimiento|Expiraci[oó]n))\\s*(\\n|$)';

class VaultClient {
    constructor() {
        this.cache = new Map();
        this.diskCache = new Map();   // id → { at, r } (resultados con fecha, persistentes entre escaneos)
        this.diskDirty = false;
        this.browser = null;
        this.context = null;
        this.pages = [];
        this.available = false;
        this.lastError = null;
    }

    get cfg() { return config.services.promomats; }

    get cacheFile() { return path.join(config.dataDir, 'vault-cache.json'); }

    loadDiskCache() {
        this.diskCache = new Map();
        this.diskDirty = false;
        if (!config.vaultCacheHours) return;
        try {
            const raw = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
            const ttl = config.vaultCacheHours * 3600 * 1000;
            for (const [id, e] of Object.entries(raw)) if (e && e.at && Date.now() - e.at < ttl && e.r) this.diskCache.set(id, e);
        } catch (e) { /* sin caché previa */ }
    }

    saveDiskCache() {
        if (!config.vaultCacheHours || !this.diskDirty) return;
        try {
            if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true });
            const obj = {};
            this.diskCache.forEach((e, id) => { obj[id] = e; });
            atomicWriteSync(this.cacheFile, JSON.stringify(obj), 'utf8');
            this.diskDirty = false;
        } catch (e) { /* la caché nunca debe romper el escaneo */ }
    }

    // Resultado con fecha guardado: se reclasifica con la fecha de HOY (un "vigente" de ayer puede estar "por vencer")
    fromDiskCache(id) {
        const e = this.diskCache.get(id);
        if (!e) return null;
        const r = { ...e.r };
        if (r.status !== 'RETIRADO' && r.expirationDate) {
            r.status = this.classify(r.expirationDate);
            r.daysRemaining = this.daysRemaining(r.expirationDate);
        }
        const hours = Math.max(1, Math.round((Date.now() - e.at) / 3600000));
        r.note = `Resultado de PromoMats guardado hace ${hours} h (caché de ${config.vaultCacheHours} h)`;
        return r;
    }

    rememberResult(id, r) {
        if (!config.vaultCacheHours || !r || !r.expirationDate) return;
        if (!['VENCIDO', 'PROXIMO A VENCER', 'VIGENTE', 'RETIRADO'].includes(r.status)) return;
        this.diskCache.set(id, { at: Date.now(), r: { status: r.status, approvedDate: r.approvedDate, expirationDate: r.expirationDate, daysRemaining: r.daysRemaining, note: '' } });
        this.diskDirty = true;
    }

    async init() {
        this.cache.clear();
        this.lastError = null;
        this.available = false;
        this.sessionDead = false;
        this.pages = [];
        this.loadDiskCache();

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
            await first.goto(`https://${this.cfg.host}/ui/`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            // Espera a que el acceso se resuelva (SSO silencioso incluido) en vez de decidir a los 6 s
            const verdict = await authManager.settleAccess(first, 'promomats', config.sessionSettleMs);
            if (verdict !== 'active') {
                this.lastError = verdict === 'expired'
                    ? 'La sesión de PromoMats expiró (pide iniciar sesión)'
                    : 'PromoMats no respondió a tiempo (red lenta o portal ocupado). Reintenta en unos minutos.';
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

    // Lógica pura delegada en vaultParse.js (probada sin navegador)
    daysRemaining(expiration) { return daysRemaining(expiration); }
    classify(expiration) { return classify(expiration); }
    lifecycleState(text) { return lifecycleState(text); }
    isRetired(value) { return isRetired(value); }

    async pageText(page) {
        return page.evaluate(() => document.body.innerText || '');
    }

    // "Expiration Date" como etiqueta exacta (no "Expiration Notes")
    hasExpirationDateLabel(text) {
        return new RegExp(EXPIRATION_LABEL_SRC, 'i').test(text);
    }

    // Espera (hasta maxMs) a que aparezca la etiqueta de vencimiento; sale en cuanto aparece,
    // en lugar de dormir un tiempo fijo en cada intento.
    async waitForExpirationLabel(page, maxMs) {
        try {
            await page.waitForFunction(
                (src) => new RegExp(src, 'i').test(document.body.innerText || ''),
                EXPIRATION_LABEL_SRC, { timeout: maxMs, polling: 150 }
            );
            return true;
        } catch (e) { return false; }
    }

    // Despliega la seccion "Key Dates". Prueba varias estrategias.
    async expandKeyDates(page) {
        try {
            if (this.hasExpirationDateLabel(await this.pageText(page))) return true;

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
            if (await this.waitForExpirationLabel(page, 1800)) return true;

            await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('a, button, span, div'));
                const el = all.find(n => (n.innerText || '').trim() === 'See more details');
                if (el) el.click();
            });
            if (await this.waitForExpirationLabel(page, 2500)) return true;

            await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('*'));
                const matches = all.filter(el => (el.innerText || '').trim() === 'Key Dates');
                if (matches.length) matches[matches.length - 1].click();
            });
            return await this.waitForExpirationLabel(page, 1800);
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
        await page.goto(`https://${this.cfg.host}/ui/#library`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForSelector(SEARCH_INPUT_SELECTORS.join(','), { state: 'visible', timeout: config.vaultStepTimeoutMs }).catch(() => {});

        // Si el portal redirigió al login, la sesión caducó: no tiene sentido seguir buscando
        const here = page.url().toLowerCase();
        if (!here.includes(this.cfg.host.toLowerCase()) || /\/auth\/login|login\./.test(here)) {
            trace.sessionExpired = true;
            return false;
        }

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

        // Esperar los resultados de ESTE codigo. Se acepta (a) el encabezado "Search for:"/"Buscar:" con el codigo o
        // (b) una fila de resultados con enlace a un documento que contiene exactamente el codigo (no depende del idioma
        // ni del texto del encabezado). "Sin resultados" solo se declara si el portal lo dice; si no responde a tiempo
        // se marca timedOut (antes ese caso se confundia con "ID no encontrado").
        const upper = safe.toUpperCase();
        const start = Date.now();
        let text = '';
        while (Date.now() - start < config.vaultSearchTimeoutMs) {
            await page.waitForTimeout(800);
            text = await this.pageText(page);
            const up = text.toUpperCase();
            if (new RegExp(`(Search for|Buscar|Resultados[^\\n]{0,20}):?\\s*"?${safe}"?`, 'i').test(text) && up.includes(upper)) {
                trace.resultsListed = true;
                return true;
            }
            const rowListed = await page.evaluate((id) => {
                const re = new RegExp(`(^|[^A-Z0-9])${id.replace(/[-]/g, '\\-')}(?![0-9])`);
                return Array.from(document.querySelectorAll('a[href*="doc_info"]')).some((a) => {
                    let node = a;
                    for (let i = 0; i < 12 && node && node !== document.body; i++, node = node.parentElement) {
                        if (re.test((node.innerText || '').toUpperCase())) return true;
                    }
                    return false;
                });
            }, safe).catch(() => false);
            if (rowListed) { trace.resultsListed = true; return true; }
            if (/no results|no se encontraron|0 of 0|sin resultados|no hay resultados|no matches/i.test(text) && up.includes(upper)) {
                trace.noResults = true;
                return true;
            }
            const url = page.url().toLowerCase();
            if (!url.includes(this.cfg.host.toLowerCase()) || /\/auth\/login|login\./.test(url)) { trace.sessionExpired = true; return false; }
        }
        trace.timedOut = true;
        trace.viewSample = text.replace(/\s+/g, ' ').trim().slice(0, 140);
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
            trace.noResults = false;
            trace.timedOut = false;

            const ok = await this.runSearch(page, safe, trace);
            if (trace.sessionExpired) return { found: false, trace };
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

            await page.waitForFunction(() => /Document Number/i.test(document.body.innerText || ''), null,
                { timeout: 5500, polling: 200 }).catch(() => {});
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
        try {
            const res = await this.openDocument(page, approvalId);
            if (!res.found) {
                const t = res.trace;
                // La sesión caducó a mitad del escaneo: se corta aquí; el resto de consultas no se intenta (antes se
                // seguía media hora marcando todo como "no encontrado" / "sin fecha")
                if (t.sessionExpired) {
                    this.sessionDead = true;
                    return unknownResult('La sesión de PromoMats caducó durante el escaneo. Renueva la sesión en «Cuentas» y repite el escaneo.');
                }
                let why;
                let status = 'SIN FECHA FIABLE';
                // transient: causa que puede no repetirse (red lenta, portal ocupado): se reintenta en una segunda pasada
                const transient = !t.noResults && !res.notFoundPage;
                if (!t.searchBox) why = 'No se encontró el cuadro de búsqueda de PromoMats (el portal tardó en cargar o cambió su diseño)';
                else if (t.noResults) { status = 'ID NO ENCONTRADO'; why = 'PromoMats no devolvió resultados para este código'; }
                else if (t.timedOut) why = `PromoMats no respondió a la búsqueda en ${Math.round(config.vaultSearchTimeoutMs / 1000)} s (red lenta o portal ocupado)${t.viewSample ? `. Pantalla: «${t.viewSample}»` : ''}`;
                else if (res.notFoundPage) why = 'PromoMats mostró "Document Not Found" (sin permiso o documento inexistente)';
                else if (t.docNumberMismatch) why = `La ficha abierta es ${t.docNumberMismatch}, no ${approvalId} (tras ${t.attempts} intentos)`;
                else why = 'No se pudo abrir la ficha del documento';

                return { status, approvedDate: null, expirationDate: null, daysRemaining: null, note: why, transient };
            }

            const { approved, expiration, text } = await this.readDates(page);
            if (this.isRetired(this.lifecycleState(text))) {
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
                        : 'No se pudo desplegar la sección Key Dates',
                    transient: !res.trace.keyDatesOpen
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
            return { ...unknownResult(`Error consultando PromoMats: ${e.message.split('\n')[0]}`), transient: true };
        }
    }

    // Segunda pasada: los IDs que fallaron por causas transitorias (red lenta, portal ocupado) se reintentan una vez,
    // repartidos entre las pestañas. Si los primeros reintentos fallan también, se abandona (PromoMats no responde).
    async retryTransient(results, shouldStop) {
        if (!this.available || this.sessionDead || !this.pages.length) return;
        const ids = [...results].filter(([, r]) => r && r.transient && r.status === 'SIN FECHA FIABLE').map(([id]) => id).slice(0, 80);
        if (!ids.length) return;
        let tried = 0, recovered = 0;
        const next = () => ids.shift();
        const run = async (page) => {
            for (let id = next(); id; id = next()) {
                if ((shouldStop && shouldStop()) || this.sessionDead) return;
                if (tried >= 6 && recovered === 0) return;   // los primeros reintentos fallan: PromoMats no responde, no insistir
                tried++;
                const r = await this.lookupOne(page, id);
                if (!r.transient) {
                    if (r.status !== 'SIN FECHA FIABLE' || r.expirationDate) recovered++;
                    results.set(id, r);
                    this.cache.set(id, r);
                    this.rememberResult(id, r);
                }
            }
        };
        await Promise.all(this.pages.map(run));
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
        // Varios workers pueden esperar a la vez: una sola variable despertaba solo al último
        const wakers = [];
        const wakeAll = () => { while (wakers.length) wakers.pop()(); };
        const unknown = unknownResult;

        const worker = async (page) => {
            while (true) {
                if (shouldStop && shouldStop()) return;
                if (queue.length === 0) {
                    if (closing) return;
                    await new Promise(resolve => { wakers.push(resolve); setTimeout(resolve, 1500); });
                    continue;
                }
                const id = queue.shift();
                let r;
                if (self.cache.has(id)) r = self.cache.get(id);
                else if (self.fromDiskCache(id)) { r = self.fromDiskCache(id); self.cache.set(id, r); }
                else if (self.sessionDead) r = unknown('La sesión de PromoMats caducó durante el escaneo. Renueva la sesión en «Cuentas» y repite el escaneo.');
                else {
                    r = await self.lookupOne(page, id);
                    self.cache.set(id, r);
                    self.rememberResult(id, r);
                }
                results.set(id, r);
                done++;
                if (onProgress) onProgress(done, total);
            }
        };

        const workers = self.available ? self.pages.map(p => worker(p)) : [];

        return {
            // Resultados obtenidos hasta ahora (para el panel en vivo)
            peek() { return results; },
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
                wakeAll();
            },
            async finish() {
                closing = true;
                wakeAll();
                await Promise.all(workers);
                await self.retryTransient(results, shouldStop);
                self.saveDiskCache();
                seen.forEach(id => {
                    if (!results.has(id)) results.set(id, unknown('No se consultó en PromoMats (escaneo cancelado)'));
                });
                return results;
            }
        };
    }

    async close() {
        // Al terminar con la sesión viva se guardan las cookies renovadas (alarga la sesión para el siguiente uso)
        if (this.available && !this.sessionDead && this.context) await authManager.persistState('promomats', this.context);
        if (this.browser) await this.browser.close().catch(() => {});
        this.browser = null; this.context = null; this.pages = []; this.available = false;
    }
}

module.exports = new VaultClient();