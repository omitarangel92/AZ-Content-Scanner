const config = require('./config');

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
// Tras una excepción no capturada el proceso queda en un estado indefinido: no se sigue como si nada.
// Si hay un escaneo en curso se cancela (así guarda lo detectado), se espera un poco y se sale.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
    gracefulExit(1);
});

if (config.allowInsecureTls) {
    // Solo afecta a los navegadores de Playwright (ver authManager); ya no se desactiva TLS en todo el proceso Node.
    console.warn('ADVERTENCIA: los navegadores ignoran errores de certificado (ALLOW_INSECURE_TLS=true).');
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const scannerEngine = require('./scannerEngine');
const authManager = require('./authManager');
const storage = require('./storage');
const security = require('./security');
const { mergeSummaries } = require('./mergeScans');

const app = express();
app.disable('x-powered-by');
// Las rutas async deben pasar por wrap(): Express 4 no captura sus rechazos y la petición quedaba colgada
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Sin CORS: la interfaz se sirve desde este mismo origen, así otros sitios no pueden leer la API.
app.use(security.securityHeaders);
app.use(security.hostGuard);
app.use('/api', security.originGuard, security.tokenGuard, security.rateLimit('la API', 300));
app.use(express.json({ limit: '2mb' }));

// El HTML se sirve con ?v=<hash> en CSS/JS calculado desde sus fechas de modificación: al cambiar un archivo el
// navegador lo recarga solo (antes había que subir "?v=NN" a mano en index.html).
const publicDir = path.join(__dirname, '../public');
const VERSIONED = ['css/tokens.css', 'css/styles.css', 'js/csv.js', 'js/app.js'];
function assetVersion() {
    let sum = 0;
    for (const f of VERSIONED) { try { sum += Math.floor(fs.statSync(path.join(publicDir, f)).mtimeMs); } catch (e) { /* ausente */ } }
    return sum.toString(36);
}
app.get(['/', '/index.html'], wrap(async (req, res) => {
    const html = await fs.promises.readFile(path.join(publicDir, 'index.html'), 'utf8');
    res.set('Cache-Control', 'no-cache').type('html').send(html.replace(/\?v=[\w-]+/g, `?v=${assetVersion()}`));
}));
app.use(express.static(publicDir));
// Capturas de evidencia (se guardan como archivos, no dentro del historial)
app.use('/shots', express.static(config.shotsDir, { maxAge: '7d' }));
// Operaciones que abren navegadores: límite bajo
const heavy = security.rateLimit('operaciones pesadas', 20);

app.get('/api/token', (req, res) => res.json({ token: security.TOKEN }));

let sseClients = [];
let lastScanResult = null;
let lastTargetUrl = null;   // última URL escaneada/validada: la usa el mantenimiento de sesiones
let busy = null; // null | 'validating' | 'scanning'
let busySince = 0;
let runningScan = null;   // { scanId, promise } mientras hay un escaneo real
let lastProgress = null;  // ultimo evento SSE: se reenvia a quien se (re)conecta
const scanHistory = storage.loadHistory();
const reviews = storage.loadReviews();

if (scanHistory.length) lastScanResult = scanHistory[0];

function setBusy(state) {
    busy = state;
    busySince = state ? Date.now() : 0;
}

function sendSSE(data) {
    lastProgress = data;
    sseClients.forEach(c => {
        try { c.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) {}
    });
}

// ---------- SSE ----------
app.get('/api/scan-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    // Al reconectar (o al recargar la pagina) se recibe el estado actual del escaneo
    if (runningScan && lastProgress) res.write(`data: ${JSON.stringify(lastProgress)}\n\n`);
    else res.write(`data: ${JSON.stringify({ status: 'Conectado', progress: 0, idle: !runningScan })}\n\n`);
    sseClients.push(res);
    // Latido para que proxies o el navegador no corten la conexion en fases largas (PromoMats, OCR)
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(heartbeat); sseClients = sseClients.filter(c => c !== res); });
});

// ---------- Config ----------
app.get('/api/config', (req, res) => {
    // Cada pais indica si su dominio esta en ALLOWED_DOMAINS (la interfaz deshabilita los que no)
    const regions = {};
    for (const [key, r] of Object.entries(config.regions)) {
        const countries = {}, blocked = {};
        for (const [code, url] of Object.entries(r.countries)) {
            countries[code] = url;
            try { blocked[code] = !scannerEngine.isAllowedHost(new URL(url).hostname); } catch (e) { blocked[code] = true; }
        }
        regions[key] = { label: r.label, countries, blocked };
    }
    res.json({
        regions,
        allowedDomains: config.allowedDomains,
        maxPages: config.maxPages,
        sessions: authManager.sessionStatus()
    });
});

// Estado del servidor: permite saber por que se rechazo un escaneo
app.get('/api/scan/status', (req, res) => {
    res.json({
        busy, busySince, seconds: busy ? Math.floor((Date.now() - busySince) / 1000) : 0,
        scanId: runningScan ? runningScan.scanId : null,
        lastScanId: lastScanResult ? lastScanResult.scanId : null,
        progress: runningScan ? lastProgress : null
    });
});

// Libera el servidor si quedo marcado como ocupado (sin escaneo real en curso)
// Si hay un escaneo real en curso NO se libera (se pide cancelarlo): evita dos escaneos simultaneos
// que compartirian el navegador de PromoMats y el estado del motor.
app.post('/api/scan/reset', (req, res) => {
    if (runningScan || scannerEngine.isRunning()) {
        scannerEngine.cancelScan();
        return res.json({ success: false, cancelling: true, message: 'Hay un escaneo en curso: se pidió cancelarlo. El servidor quedará libre cuando termine de guardar lo detectado.' });
    }
    // Una validación de sesiones activa también ocupa el servidor: liberarlo permitiría lanzar un escaneo
    // en paralelo con Chromium abierto. Solo se libera si lleva demasiado tiempo (probablemente colgada).
    if (busy === 'validating' && Date.now() - busySince < 120000) {
        return res.status(409).json({ success: false, message: 'Se están comprobando las sesiones. Espera unos segundos.' });
    }
    setBusy(null);
    res.json({ success: true, message: 'Servidor liberado. Ya puedes iniciar un escaneo.' });
});

// ---------- Sesiones manuales ----------
app.post('/api/session/start', heavy, wrap(async (req, res) => {
    const { service, url } = req.body || {};
    if (!['azmed', 'promomats'].includes(service)) {
        return res.status(400).json({ success: false, error: 'Servicio inválido.' });
    }

    // AzMed: se abre una pagina protegida ("Mi cuenta") para que el sitio pida el login y, al terminar,
    // se pueda detectar que la sesion quedo activa.
    let loginUrl = url;
    let protectedStart = true;
    if (service === 'azmed') {
        loginUrl = authManager.azmedProbeFor(url) || url;
        protectedStart = loginUrl !== url;
    }
    if (service === 'promomats') loginUrl = config.services.promomats.loginUrl;

    try {
        const u = new URL(loginUrl);
        if (service === 'azmed' && !scannerEngine.isAllowedHost(u.hostname)) {
            return res.status(400).json({ success: false, error: 'Dominio no autorizado para iniciar sesión.' });
        }
    } catch (e) {
        return res.status(400).json({ success: false, error: 'URL inválida.' });
    }

    try {
        res.json(await authManager.startLogin(service, loginUrl, protectedStart));
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}));

app.post('/api/session/finish', wrap(async (req, res) => {
    res.json(await authManager.finishLogin((req.body || {}).service));
}));

app.post('/api/session/cancel', wrap(async (req, res) => {
    await authManager.cancelLogin((req.body || {}).service);
    res.json({ success: true, states: authManager.getSessionStates() });
}));

app.post('/api/session/clear', (req, res) => {
    authManager.clearSession((req.body || {}).service);
    res.json({ success: true, states: authManager.getSessionStates() });
});

// Estado rapido (sin abrir navegador): existe archivo + ultima validacion conocida
app.get('/api/session/status', (req, res) => res.json(authManager.getSessionStates()));

// Validacion real: abre cada servicio con su sesion y comprueba si redirige al login
app.post('/api/session/validate', heavy, wrap(async (req, res) => {
    if (busy === 'scanning') return res.status(409).json({ error: 'Hay un escaneo en curso.', states: authManager.getSessionStates() });
    if (busy === 'validating') return res.status(409).json({ error: 'Ya hay una validación en curso.', states: authManager.getSessionStates() });
    setBusy('validating');
    try {
        const { services, targetUrl } = req.body || {};
        if (typeof targetUrl === 'string' && /^https?:\/\//i.test(targetUrl)) lastTargetUrl = targetUrl;
        const states = await authManager.validateAll(services, targetUrl);
        res.json({ states });
    } catch (e) {
        res.status(500).json({ error: e.message, states: authManager.getSessionStates() });
    } finally {
        setBusy(null);
    }
}));

// ---------- Diagnosticos (desactivados por defecto: ENABLE_DIAGNOSTICS=true en .env) ----------
// /api/vault/inspect devuelve texto de fichas de PromoMats y /api/capture-test abre URLs con el navegador del
// servidor; no deben estar expuestos si no se están usando.
const diagnostics = (req, res, next) => (config.enableDiagnostics ? next()
    : res.status(404).send('Diagnósticos desactivados. Usa ENABLE_DIAGNOSTICS=true en .env.'));

app.get('/api/vault/inspect/:id', diagnostics, heavy, async (req, res) => {
    if (busy) return res.status(409).json({ error: `El servidor está ocupado (${busy}).` });
    setBusy('validating');
    try {
        res.json(await scannerEngine.inspectVault(req.params.id));
    } catch (e) {
        res.status(500).json({ error: e.message });
    } finally {
        setBusy(null);
    }
});

// ---------- Prueba de captura: abre una URL, acepta avisos y muestra la imagen ----------
// Uso: http://localhost:3000/api/capture-test?url=https://www.azmed.cr
app.get('/api/capture-test', diagnostics, heavy, async (req, res) => {
    if (busy) return res.status(409).send(`El servidor está ocupado (${busy}).`);
    let target;
    try {
        target = new URL(String(req.query.url || ''));
        if (!scannerEngine.isAllowedHost(target.hostname)) throw new Error('Dominio no autorizado');
    } catch (e) {
        return res.status(400).send('Parámetro url inválido o dominio no autorizado.');
    }
    setBusy('validating');
    try {
        const { clicks, image } = await scannerEngine.captureTest(target.href);
        res.send(`<html><body style="font-family:Arial;padding:16px">
            <p><b>Botones pulsados:</b> ${clicks}</p>
            <p>Si ves el aviso de cookies o de profesional de la salud en la imagen, copia el HTML de ese botón.</p>
            <img src="${image}" style="max-width:100%;border:1px solid #ccc"></body></html>`);
    } catch (e) {
        res.status(500).send(`Error: ${e.message}`);
    } finally {
        setBusy(null);
    }
});

// ---------- Áreas del sitio (menú del header) ----------
// Lee el header de la página principal y estima cuántas páginas tiene cada área (sitemap). Es ligero a propósito:
// 1 página + 1–3 sitemaps, para poder elegir qué escanear sin disparar el WAF.
app.post('/api/scan/sections', heavy, wrap(async (req, res) => {
    let target;
    try {
        target = new URL(String((req.body || {}).targetUrl || ''));
        if (!/^https?:$/.test(target.protocol)) throw new Error();
    } catch (e) {
        return res.status(400).json({ success: false, error: 'URL del sitio inválida.' });
    }
    if (!scannerEngine.isAllowedHost(target.hostname)) {
        return res.status(400).json({ success: false, error: `Dominio no autorizado: ${target.hostname}` });
    }
    if (busy) return res.status(409).json({ success: false, error: `El servidor está ocupado (${busy}). Espera un momento.` });

    setBusy('validating');
    try {
        res.json({ success: true, ...(await scannerEngine.discoverSections(target.href)) });
    } catch (e) {
        res.status(502).json({ success: false, error: e.message });
    } finally {
        setBusy(null);
    }
}));

// ---------- Escaneo ----------
app.post('/api/scan', heavy, wrap(async (req, res) => {
    const { targetUrl, region, country } = req.body || {};
    // Áreas elegidas (escaneo por áreas): http(s), dominio permitido y del mismo dominio base que el sitio
    const sections = [];
    const badSections = [];
    let baseHost = '';
    try { baseHost = new URL(targetUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { /* se valida más abajo */ }
    for (const s of (Array.isArray((req.body || {}).sections) ? req.body.sections : []).slice(0, 30)) {
        try {
            const u = new URL(String((s && s.url) || ''));
            const h = u.hostname.toLowerCase().replace(/^www\./, '');
            if (/^https?:$/.test(u.protocol) && scannerEngine.isAllowedHost(u.hostname) && baseHost && (h === baseHost || h.endsWith('.' + baseHost))) {
                const sec = { label: clip(s.label, 60) || u.pathname, url: u.href, exact: s.exact === true };
                if (s.scope) {   // carpeta que define el alcance del área (ver parentScope); mismas reglas que la URL
                    const sc = new URL(String(s.scope));
                    const sh = sc.hostname.toLowerCase().replace(/^www./, '');
                    if (/^https?:$/.test(sc.protocol) && (sh === baseHost || sh.endsWith('.' + baseHost))) sec.scope = sc.href;
                }
                sections.push(sec);
            } else badSections.push(String((s && s.label) || u.href));
        } catch (e) { badSections.push(String((s && s.label) || '?')); }
    }
    if (badSections.length) {
        return res.status(400).json({ success: false, error: `Áreas inválidas o fuera del sitio: ${badSections.slice(0, 5).join(', ')}` });
    }
    // URLs adicionales: solo http(s) dentro de los dominios autorizados; maximo 200
    const extraUrls = [];
    const rejectedExtra = [];
    for (const raw of (Array.isArray((req.body || {}).extraUrls) ? req.body.extraUrls : []).slice(0, 200)) {
        try {
            const u = new URL(String(raw).trim());
            if (/^https?:$/.test(u.protocol) && scannerEngine.isAllowedHost(u.hostname)) extraUrls.push(u.href);
            else rejectedExtra.push(String(raw));
        } catch (e) { if (String(raw).trim()) rejectedExtra.push(String(raw)); }
    }
    if (rejectedExtra.length) {
        return res.status(400).json({ success: false, error: `URLs adicionales inválidas o de dominios no autorizados: ${rejectedExtra.slice(0, 5).join(', ')}` });
    }

    const onlyUrls = (req.body || {}).onlyUrls === true;
    if (onlyUrls && !extraUrls.length) {
        return res.status(400).json({ success: false, error: 'Pega al menos una URL para analizar solo esas páginas.' });
    }

    if (busy === 'scanning' || runningScan || scannerEngine.isRunning()) {
        return res.status(409).json({ success: false, busy, error: 'Ya hay un escaneo en curso. Espera a que termine o cancélalo.' });
    }
    if (busy === 'validating') {
        if (Date.now() - busySince < 120000) {
            return res.status(409).json({ success: false, busy, error: 'Se están comprobando las sesiones. Espera unos segundos e inténtalo de nuevo.' });
        }
        setBusy(null);
    }

    try {
        const u = new URL(targetUrl);
        if (!/^https?:$/.test(u.protocol)) throw new Error();
        if (!scannerEngine.isAllowedHost(u.hostname)) {
            return res.status(400).json({ success: false, error: `Dominio no autorizado: ${u.hostname}` });
        }
    } catch (e) {
        return res.status(400).json({ success: false, error: 'URL objetivo inválida.' });
    }

    lastTargetUrl = targetUrl;
    // 1) Las 2 sesiones son OBLIGATORIAS y deben estar activas: sin PromoMats no hay fechas con las que comparar los
    //    Approval IDs (antes se escaneaba igual y todo salía "Sin fecha" tras 30 minutos), y AzMed da acceso a las
    //    páginas protegidas. Kaltura no necesita sesión: sus metadatos se leen con una sesión de widget anónima.
    const REQUIRED = ['azmed', 'promomats'];
    const LABEL = { azmed: 'AzMed', promomats: 'PromoMats' };
    const missing = REQUIRED.filter(s => !authManager.hasSession(s));
    if (missing.length) {
        return res.status(409).json({
            success: false, sessionExpired: true, missing, states: authManager.getSessionStates(),
            error: `Faltan sesiones: ${missing.map(s => LABEL[s]).join(', ')}. Conéctalas en "Cuentas": el escaneo necesita las 2 (AzMed y PromoMats) para comparar los Approval IDs con PromoMats.`
        });
    }

    setBusy('validating');
    let states;
    const warning = null;
    try {
        states = await authManager.validateAll(REQUIRED, targetUrl, 10 * 60 * 1000);
        const bad = REQUIRED.filter(s => !states[s] || states[s].state !== 'active');
        if (bad.length) {
            setBusy(null);
            return res.status(409).json({
                success: false, sessionExpired: true, missing: bad, states,
                error: `Sesión no válida: ${bad.map(s => `${LABEL[s]} (${states[s] && states[s].state === 'expired' ? 'expirada' : 'no se pudo validar'})`).join(', ')}. Vuelve a iniciar sesión en "Cuentas" y guarda la sesión antes de escanear.`
            });
        }
    } catch (e) {
        setBusy(null);
        return res.status(500).json({ success: false, error: `No se pudo validar las sesiones: ${e.message}` });
    }

    // 2) Iniciar el escaneo
    setBusy('scanning');
    const scanId = Date.now().toString(36);
    lastProgress = null;
    res.json({ success: true, states, scanId, warning });

    // Cola de áreas: con 2+ áreas y queue=true se escanean una por una, con pausa, y se consolidan en un informe
    const useQueue = (req.body || {}).queue === true && sections.length > 1 && !onlyUrls;
    const job = useQueue
        ? runQueue({ targetUrl, region, country, scanId, extraUrls, sections })
        : scannerEngine.runScan({ targetUrl, region, country, scanId, extraUrls, sections: onlyUrls ? [] : sections, onlyUrls }, sendSSE);
    const promise = job
        .then(summary => saveScan(scanId, targetUrl, region, country, summary))
        .catch(err => {
            // Llegar aquí significa que no había nada que guardar (ver runScan: con hallazgos se devuelve un
            // resumen PARCIAL en lugar de lanzar el error)
            console.error('Escaneo terminado con error:', err.message);
            storage.deleteShots(scanId);
        })
        .finally(() => { runningScan = null; setBusy(null); });
    runningScan = { scanId, promise };
}));

// ---------- Cola de áreas ----------
let queueCancelled = false;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Escanea cada área por separado (mismo scanId, capturas con prefijo propio), con pausa entre áreas y
// reintento al final de las que fallaron o sufrieron bloqueos del WAF. Devuelve un único resumen consolidado.
async function runQueue({ targetUrl, region, country, scanId, extraUrls, sections }) {
    const startedAt = Date.now();
    queueCancelled = false;
    const total = sections.length;
    const parts = sections.map(section => ({ label: section.label, section, summary: null, error: null, attempts: 0 }));
    let pause = config.queuePauseSeconds;

    // Sumatoria entre áreas: lo ya terminado (deduplicado por ID) + lo que va llevando el área actual
    const CODE = { 'VENCIDO': 'V', 'PROXIMO A VENCER': 'P', 'VIGENTE': 'G', 'RETIRADO': 'R' };
    const baseTotals = () => {
        const ids = new Map(), extra = new Set();
        let pages = 0;
        for (const p of parts) {
            if (!p.summary) continue;
            pages += (p.summary.coverage && p.summary.coverage.pagesRead) || 0;
            for (const a of p.summary.assets || []) {
                if (a.veevaApprovalId === 'SIN ID' || a.veevaApprovalId === 'SIN VERIFICAR') { extra.add(a.assetUrl); continue; }
                const code = CODE[a.status] || 'S';
                if (!ids.has(a.veevaApprovalId) || ids.get(a.veevaApprovalId) === 'S') ids.set(a.veevaApprovalId, code);
            }
        }
        return { ids, extra: extra.size, pages };
    };
    const progressFor = (idx, label) => {
        const base = baseTotals();   // solo cambia al terminar cada área
        return (d) => {
            const { done, error, ...rest } = d;
            const overall = Math.floor(((idx + (d.progress || 0) / 100) / total) * 100);
            const cur = d.live || {};
            const ids = new Map(base.ids);
            Object.entries(cur.ids || {}).forEach(([id, code]) => { if (!ids.has(id) || ids.get(id) === 'S') ids.set(id, code); });
            const live = { vencidos: 0, proximos: 0, vigentes: 0, retirados: 0, sinFecha: 0, total: 0 };
            ids.forEach((code) => {
                if (code === 'V') live.vencidos++; else if (code === 'P') live.proximos++; else if (code === 'G') live.vigentes++;
                else if (code === 'R') live.retirados++; else live.sinFecha++;
            });
            const extra = base.extra + (cur.extra || 0);
            live.sinFecha += extra;
            live.total = ids.size + extra;
            sendSSE({
                ...rest, live, progress: Math.min(overall, 99),
                pagesRead: base.pages + (d.pagesRead || 0), idsFound: ids.size,
                status: `[${idx + 1}/${total} · ${label}] ${d.status}`, queue: { index: idx + 1, total, label }
            });
        };
    };
    const wait = async (seconds, text, idx) => {
        for (let left = seconds; left > 0 && !queueCancelled; left--) {
            if (left === seconds || left % 5 === 0) {
                sendSSE({ scanId, step: 3, progress: Math.min(Math.floor((idx / total) * 100), 99), status: `${text} (${left} s)`, queue: { index: idx, total, paused: true } });
            }
            await sleep(1000);
        }
    };
    const blocked = (p) => !p.summary || (p.summary.coverage && p.summary.coverage.wafBlocked > 0);
    const runArea = async (part, idx) => {
        part.attempts++;
        let summary = null, err = null;
        try {
            summary = await scannerEngine.runScan({
                targetUrl, region, country, scanId, sections: [part.section],
                extraUrls: idx === 0 && part.attempts === 1 ? extraUrls : [],
                shotPrefix: `a${idx}t${part.attempts}s`, liveIds: true
            }, progressFor(idx, part.label));
        } catch (e) { err = e.message; }
        // En un reintento solo se sustituye el resultado si es mejor que el anterior
        const better = summary && (!part.summary || summary.coverage.pagesRead >= part.summary.coverage.pagesRead);
        if (better) { part.summary = summary; part.error = null; }
        else if (!part.summary) part.error = err || 'sin resultado';
    };

    for (let i = 0; i < total && !queueCancelled; i++) {
        if (i > 0) await wait(pause, `Pausa antes de «${parts[i].label}» para no activar el WAF`, i);
        if (queueCancelled) break;
        await runArea(parts[i], i);
        if (blocked(parts[i])) pause = Math.min(Math.max(pause, 15) * 2, 300);   // el WAF reaccionó: se frena el ritmo
    }
    // Reintento único de las áreas bloqueadas o fallidas, con la pausa ya ampliada
    const retry = parts.map((p, i) => ({ p, i })).filter(({ p }) => p.attempts > 0 && blocked(p));
    for (const { p, i } of retry) {
        if (queueCancelled) break;
        await wait(Math.max(pause, 30), `Reintentando «${p.label}» tras un bloqueo`, i);
        if (queueCancelled) break;
        await runArea(p, i);
    }
    for (const p of parts) if (!p.summary && !p.error) p.error = 'cancelada por el usuario';

    if (!parts.some(p => p.summary)) {
        const msg = `Ninguna área se pudo analizar (${parts[0].error}).`;
        sendSSE({ scanId, step: 4, status: `Error: ${msg}`, progress: 100, error: true });
        throw new Error(msg);
    }
    const merged = mergeSummaries(parts, { scanId, durationSeconds: Math.floor((Date.now() - startedAt) / 1000), sections });
    sendSSE({ scanId, step: 4, status: merged.outcome === 'PARCIAL' ? 'Cola finalizada de forma PARCIAL.' : 'Cola finalizada.', progress: 100, done: true });
    return merged;
}

function saveScan(scanId, targetUrl, region, country, summary) {
    lastScanResult = {
        targetUrl, region, country,
        date: new Date().toISOString(),
        ...summary,
        scanId
    };
    scanHistory.unshift(lastScanResult);
    let prunedReviews = false;
    while (scanHistory.length > 10) {
        const old = scanHistory.pop();
        storage.deleteShots(old.scanId);
        // Las revisiones de un escaneo ya eliminado no sirven y reviews.json crecía sin límite
        if (hasOwn(reviews, old.scanId)) { delete reviews[old.scanId]; prunedReviews = true; }
    }
    try { storage.saveHistory(scanHistory); } catch (e) { console.error('No se pudo guardar el historial:', e.message); }
    if (prunedReviews) { try { storage.saveReviews(reviews); } catch (e) { console.error('No se pudo guardar las revisiones:', e.message); } }
}

app.post('/api/cancel-scan', (req, res) => {
    queueCancelled = true;
    scannerEngine.cancelScan();
    res.json({ success: true });
});

// ---------- Resultados e historial ----------
app.get('/api/results', (req, res) => res.json({ lastScan: lastScanResult }));

app.get('/api/history', (req, res) => {
    const light = scanHistory.map(s => ({
        scanId: s.scanId, date: s.date, targetUrl: s.targetUrl, region: s.region, country: s.country,
        outcome: s.outcome, pagesScanned: s.pagesScanned, imagesAnalyzed: s.imagesAnalyzed,
        totalAnalyzed: s.totalAnalyzed, vencidos: s.vencidos, proximosAVencer: s.proximosAVencer,
        vigentes: s.vigentes, retirados: s.retirados || 0, sinFechaFiable: s.sinFechaFiable,
        sections: s.sections || null
    }));
    res.json({ history: light });
});

app.get('/api/history/:scanId', (req, res) => {
    const scan = scanHistory.find(s => s.scanId === req.params.scanId);
    if (!scan) return res.status(404).json({ error: 'No encontrado' });
    res.json({ scan });
});

// ---------- Revision manual ----------
// scanId y assetKey llegan del cliente y se usan como claves de objeto: sin validar, "__proto__"
// o "constructor" contaminarían Object.prototype. Se exige un formato estricto y se usa hasOwn.
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const SCAN_ID_RE = /^[a-z0-9]{1,32}$/i;
const MISSED_KEY = '__missed';
const VERDICTS = new Set(['correcta', 'incorrecta']);
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

app.param('scanId', (req, res, next, value) => {
    if (!SCAN_ID_RE.test(value)) return res.status(400).json({ success: false, error: 'scanId inválido' });
    next();
});

function reviewsFor(scanId, create) {
    if (hasOwn(reviews, scanId)) return reviews[scanId];
    if (!create) return {};
    reviews[scanId] = Object.create(null);
    return reviews[scanId];
}

app.get('/api/reviews/:scanId', (req, res) => res.json({ reviews: reviewsFor(req.params.scanId, false) }));

app.post('/api/reviews/:scanId', (req, res) => {
    const { assetKey, verdict, correctedId, correctedDate, notes } = req.body || {};
    // El separador "|" garantiza el formato "ID|url" y descarta claves como __proto__ o __missed
    if (typeof assetKey !== 'string' || assetKey.length > 2000 || !assetKey.includes('|') || assetKey.startsWith('__')) {
        return res.status(400).json({ success: false, error: 'assetKey inválido' });
    }
    if (!VERDICTS.has(verdict)) return res.status(400).json({ success: false, error: 'verdict inválido' });
    reviewsFor(req.params.scanId, true)[assetKey] = {
        verdict, correctedId: clip(correctedId, 40), correctedDate: clip(correctedDate, 20),
        notes: clip(notes, 1000), at: new Date().toISOString()
    };
    storage.saveReviews(reviews);
    res.json({ success: true });
});

app.post('/api/reviews/:scanId/missed', (req, res) => {
    const { id, pageUrl, notes } = req.body || {};
    if (typeof id !== 'string' || !id.trim()) return res.status(400).json({ success: false });
    const r = reviewsFor(req.params.scanId, true);
    const list = hasOwn(r, MISSED_KEY) && Array.isArray(r[MISSED_KEY]) ? r[MISSED_KEY] : [];
    list.push({ id: clip(id, 40), pageUrl: clip(pageUrl, 2000), notes: clip(notes, 1000), at: new Date().toISOString() });
    r[MISSED_KEY] = list;
    storage.saveReviews(reviews);
    res.json({ success: true });
});

app.get('/api/reviews/:scanId/precision', (req, res) => {
    const r = reviewsFor(req.params.scanId, false);
    const entries = Object.entries(r).filter(([k]) => k !== '__missed');
    const correct = entries.filter(([, v]) => v.verdict === 'correcta').length;
    const incorrect = entries.filter(([, v]) => v.verdict === 'incorrecta').length;
    const missed = (r.__missed || []).length;
    const reviewed = correct + incorrect;
    res.json({
        reviewed, correct, incorrect, missed,
        precision: reviewed ? +(correct / reviewed * 100).toFixed(1) : null,
        recall: (correct + missed) ? +(correct / (correct + missed) * 100).toFixed(1) : null
    });
});

// ---------- Errores ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));
app.use('/shots', (req, res) => res.status(404).json({ error: 'Captura no encontrada.' }));
app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error('[error]', err && err.stack ? err.stack : err);
    // JSON mal formado, cuerpo demasiado grande, etc.: 4xx con mensaje breve; 500 sin detalles internos
    res.status(status).json({ error: status >= 500 ? 'Error interno del servidor.' : String(err.message || 'Petición inválida.') });
});

// Al detener el servidor (Ctrl+C) se cierran las ventanas de login y el escaneo en curso
let shuttingDown = false;
async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Cerrando navegadores abiertos...');
    scannerEngine.cancelScan();
    // Si hay un escaneo en curso se le da tiempo a guardar lo detectado antes de salir
    if (runningScan && runningScan.promise) {
        await Promise.race([runningScan.promise.catch(() => {}), new Promise(r => setTimeout(r, 30000))]);
    }
    await Promise.race([authManager.closeAll(), new Promise(r => setTimeout(r, 4000))]);
    process.exit(code);
}
function gracefulExit(code) {
    shutdown(code).catch(() => process.exit(code));
    setTimeout(() => process.exit(code), 45000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

app.listen(config.port, config.host, () => {
    console.log(`AZ Content Scanner activo en http://localhost:${config.port} (escuchando en ${config.host})`);
    console.log(`Sesiones, historial y capturas en: ${config.dataRoot}`);

    // Mantenimiento de sesiones: cada N minutos se abre cada servicio con su sesión guardada (cuenta como actividad y
    // evita el cierre por inactividad) y se guardan las cookies renovadas. No actúa durante un escaneo.
    if (config.sessionKeepAliveMinutes > 0) {
        console.log(`Mantenimiento de sesiones cada ${config.sessionKeepAliveMinutes} min (SESSION_KEEPALIVE_MINUTES=0 lo desactiva).`);
        const tick = () => {
            if (busy || runningScan || scannerEngine.isRunning()) return;
            const target = lastTargetUrl || (scanHistory[0] && scanHistory[0].targetUrl) || null;
            authManager.keepAlive(target).catch(e => console.error('[mantenimiento de sesiones]', e.message));
        };
        setInterval(tick, config.sessionKeepAliveMinutes * 60 * 1000).unref();
    }
});