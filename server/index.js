const config = require('./config');

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err && err.stack ? err.stack : err);
});

if (config.allowInsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    console.warn('ADVERTENCIA: validacion TLS desactivada (ALLOW_INSECURE_TLS=true).');
}

const express = require('express');
const cors = require('cors');
const path = require('path');
const scannerEngine = require('./scannerEngine');
const authManager = require('./authManager');
const storage = require('./storage');

const app = express();
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '../public')));
// Capturas de evidencia (se guardan como archivos, no dentro del historial)
app.use('/shots', express.static(config.shotsDir, { maxAge: '7d', fallthrough: false }));

let sseClients = [];
let lastScanResult = null;
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
    setBusy(null);
    res.json({ success: true, message: 'Servidor liberado. Ya puedes iniciar un escaneo.' });
});

// ---------- Sesiones manuales ----------
app.post('/api/session/start', async (req, res) => {
    const { service, url } = req.body || {};
    if (!['azmed', 'promomats', 'kaltura'].includes(service)) {
        return res.status(400).json({ success: false, error: 'Servicio inválido.' });
    }

    // AzMed: se abre una pagina protegida ("Mi cuenta") para que el sitio pida el login y, al terminar,
    // se pueda detectar que la sesion quedo activa. Kaltura: la lista de contenidos (redirige al login).
    let loginUrl = url;
    let protectedStart = true;
    if (service === 'azmed') {
        loginUrl = authManager.azmedProbeFor(url) || url;
        protectedStart = loginUrl !== url;
    }
    if (service === 'promomats') loginUrl = config.services.promomats.loginUrl;
    if (service === 'kaltura') loginUrl = 'https://kmc.kaltura.com/index.php/kmcng/content/entries/list';

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
});

app.post('/api/session/finish', async (req, res) => {
    res.json(await authManager.finishLogin((req.body || {}).service));
});

app.post('/api/session/cancel', async (req, res) => {
    await authManager.cancelLogin((req.body || {}).service);
    res.json({ success: true, states: authManager.getSessionStates() });
});

app.post('/api/session/clear', (req, res) => {
    authManager.clearSession((req.body || {}).service);
    res.json({ success: true, states: authManager.getSessionStates() });
});

// Estado rapido (sin abrir navegador): existe archivo + ultima validacion conocida
app.get('/api/session/status', (req, res) => res.json(authManager.getSessionStates()));

// Validacion real: abre cada servicio con su sesion y comprueba si redirige al login
app.post('/api/session/validate', async (req, res) => {
    if (busy === 'scanning') return res.status(409).json({ error: 'Hay un escaneo en curso.', states: authManager.getSessionStates() });
    if (busy === 'validating') return res.status(409).json({ error: 'Ya hay una validación en curso.', states: authManager.getSessionStates() });
    setBusy('validating');
    try {
        const { services, targetUrl } = req.body || {};
        const states = await authManager.validateAll(services, targetUrl);
        res.json({ states });
    } catch (e) {
        res.status(500).json({ error: e.message, states: authManager.getSessionStates() });
    } finally {
        setBusy(null);
    }
});

// ---------- Diagnostico de PromoMats ----------
app.get('/api/vault/inspect/:id', async (req, res) => {
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
app.get('/api/capture-test', async (req, res) => {
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

// ---------- Escaneo ----------
app.post('/api/scan', async (req, res) => {
    const { targetUrl, region, country } = req.body || {};
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

    // 1) Comprobar sesiones guardadas
    setBusy('validating');
    let states;
    let warning = null;
    try {
        const toCheck = ['promomats', 'azmed'].filter(s => authManager.hasSession(s));
        states = toCheck.length ? await authManager.validateAll(toCheck, targetUrl) : authManager.getSessionStates();

        // PromoMats caducado bloquea (sin el no hay fechas). AzMed caducado solo avisa: las paginas
        // publicas se auditan igual y las protegidas quedan listadas como "pidieron inicio de sesión".
        if (states.promomats && states.promomats.state === 'expired' && authManager.hasSession('promomats')) {
            setBusy(null);
            return res.status(409).json({
                success: false,
                sessionExpired: true,
                states,
                error: 'La sesión de PromoMats expiró. Vuelve a iniciar sesión (botón "Iniciar sesión") y guarda la sesión antes de escanear.'
            });
        }
        if (states.azmed && states.azmed.state === 'expired') {
            warning = 'La sesión de AzMed parece expirada: se escanearán las páginas públicas y las protegidas quedarán listadas aparte.';
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

    const promise = scannerEngine.runScan({ targetUrl, region, country, scanId, extraUrls }, sendSSE)
        .then(summary => saveScan(scanId, targetUrl, region, country, summary))
        .catch(err => {
            console.error('Escaneo terminado con error:', err.message);
            storage.deleteShots(scanId);
        })
        .finally(() => { runningScan = null; setBusy(null); });
    runningScan = { scanId, promise };
});

function saveScan(scanId, targetUrl, region, country, summary) {
    lastScanResult = {
        targetUrl, region, country,
        date: new Date().toISOString(),
        ...summary,
        scanId
    };
    scanHistory.unshift(lastScanResult);
    while (scanHistory.length > 10) storage.deleteShots(scanHistory.pop().scanId);
    try { storage.saveHistory(scanHistory); } catch (e) { console.error('No se pudo guardar el historial:', e.message); }
}

app.post('/api/cancel-scan', (req, res) => {
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
        vigentes: s.vigentes, sinFechaFiable: s.sinFechaFiable
    }));
    res.json({ history: light });
});

app.get('/api/history/:scanId', (req, res) => {
    const scan = scanHistory.find(s => s.scanId === req.params.scanId);
    if (!scan) return res.status(404).json({ error: 'No encontrado' });
    res.json({ scan });
});

// ---------- Revision manual ----------
app.get('/api/reviews/:scanId', (req, res) => res.json({ reviews: reviews[req.params.scanId] || {} }));

app.post('/api/reviews/:scanId', (req, res) => {
    const { assetKey, verdict, correctedId, correctedDate, notes } = req.body || {};
    if (!assetKey) return res.status(400).json({ success: false });
    reviews[req.params.scanId] = reviews[req.params.scanId] || {};
    reviews[req.params.scanId][assetKey] = { verdict, correctedId, correctedDate, notes, at: new Date().toISOString() };
    storage.saveReviews(reviews);
    res.json({ success: true });
});

app.post('/api/reviews/:scanId/missed', (req, res) => {
    const { id, pageUrl, notes } = req.body || {};
    if (!id) return res.status(400).json({ success: false });
    reviews[req.params.scanId] = reviews[req.params.scanId] || {};
    const list = reviews[req.params.scanId].__missed || [];
    list.push({ id, pageUrl, notes, at: new Date().toISOString() });
    reviews[req.params.scanId].__missed = list;
    storage.saveReviews(reviews);
    res.json({ success: true });
});

app.get('/api/reviews/:scanId/precision', (req, res) => {
    const r = reviews[req.params.scanId] || {};
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

// Al detener el servidor (Ctrl+C) se cierran las ventanas de login y el escaneo en curso
let shuttingDown = false;
async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('Cerrando navegadores abiertos...');
    scannerEngine.cancelScan();
    await Promise.race([authManager.closeAll(), new Promise(r => setTimeout(r, 4000))]);
    process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(config.port, config.host, () => console.log(`AZ Content Scanner activo en http://localhost:${config.port} (escuchando en ${config.host})`));