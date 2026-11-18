'use strict';

// ============================================================
// AZ Content Scanner — frontend
// ============================================================

let CONFIG = null;
let shownScan = null;          // escaneo que se está mostrando (último o del historial)
let latestScan = null;         // último escaneo guardado en el servidor
let currentScan = null;        // escaneo hecho desde que se abrió la app (se muestra en «Nuevo escaneo» hasta que se lance otro)
let historyScan = null;        // escaneo abierto desde el Historial
let activeEventSource = null;
let sessionStates = {};
let pendingLogin = new Set();  // servicios con ventana de login abierta
let starting = false;
let progressPoll = null;
let scanFinished = false;
let currentIndex = -1;         // índice del activo abierto en el detalle
let lastFocus = null;

// En móvil se pintan menos tarjetas por vez (cada fila ocupa más alto que en la tabla)
const PAGE_SIZE = window.matchMedia('(max-width: 640px)').matches ? 25 : 100;
const SERVICES = ['azmed', 'promomats'];
const SERVICE_LABEL = { azmed: 'AzMed', promomats: 'PromoMats' };
const MAIN_STATUSES = ['VENCIDO', 'PROXIMO A VENCER', 'VIGENTE', 'RETIRADO'];
const STATUS_ORDER = { 'VENCIDO': 0, 'PROXIMO A VENCER': 1, 'RETIRADO': 2, 'VIGENTE': 4 };

const view = { status: '', q: '', type: '', sortKey: '', sortDir: 1, limit: PAGE_SIZE };

const $ = (id) => document.getElementById(id);

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Token anti-CSRF: el servidor lo genera al arrancar y lo exige en las peticiones que modifican estado.
// Otro sitio web no puede leerlo (la API no tiene CORS), así que no puede lanzar escaneos ni borrar sesiones.
let apiToken = null;
async function getToken(force) {
    if (apiToken && !force) return apiToken;
    const res = await fetch('/api/token');
    apiToken = (await res.json()).token;
    return apiToken;
}

async function api(url, opts = {}) {
    const mutating = opts.method && opts.method !== 'GET';
    const headers = { ...(opts.headers || {}) };
    if (mutating) headers['X-AZ-Token'] = await getToken();
    let res = await fetch(url, { ...opts, headers });
    // Si el servidor se reinició, el token cambió: se renueva una vez y se reintenta
    if (res.status === 403 && mutating) {
        headers['X-AZ-Token'] = await getToken(true);
        res = await fetch(url, { ...opts, headers });
    }
    const json = await res.json().catch(() => ({}));
    return { res, json };
}
function post(url, body) {
    return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

// ---------- UI helpers ----------
let toastTimer = null;
function toast(msg, kind) {
    const el = $('toast');
    el.className = `toast ${kind || ''}`;
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

function setNotice(msg, isErr) {
    const el = $('scan-notice');
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.className = `notice ${isErr ? 'err' : ''}`;
    el.textContent = msg;
    el.hidden = false;
}

function badgeClass(status) {
    return {
        'VENCIDO': 'badge-danger', 'PROXIMO A VENCER': 'badge-warning',
        'VIGENTE': 'badge-success', 'RETIRADO': 'badge-retired'
    }[status] || 'badge-info';
}

function shortStatus(status) {
    return {
        'SIN FECHA FIABLE': 'Sin fecha', 'PROXIMO A VENCER': 'Por vencer',
        'ID NO ENCONTRADO': 'No encontrado', 'SIN ID': 'Sin ID'
    }[status] || (status.charAt(0) + status.slice(1).toLowerCase());
}

const fmtDate = (d) => d || 'N/D';
const fmtDays = (d) => (d === null || d === undefined ? 'N/D' : d);
function fmtElapsed(s) {
    s = Math.max(0, Number(s) || 0);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function breakdown(assets) {
    const b = { vencidos: 0, proximos: 0, vigentes: 0, retirados: 0, sinFecha: 0, total: 0 };
    (assets || []).forEach(a => {
        if (a.status === 'VENCIDO') b.vencidos++;
        else if (a.status === 'PROXIMO A VENCER') b.proximos++;
        else if (a.status === 'VIGENTE') b.vigentes++;
        else if (a.status === 'RETIRADO') b.retirados++;
        else b.sinFecha++;
        b.total++;
    });
    return b;
}

// ---------- Vistas (Panel · Nuevo escaneo · Historial · Cuentas) ----------
const VIEWS = {
    dashboard: 'Panel de cumplimiento',
    scan: 'Nuevo escaneo',
    history: 'Historial de escaneos',
    accounts: 'Cuentas conectadas'
};

function currentView() {
    const name = (location.hash.match(/^#\/([a-z]+)/) || [])[1];
    return VIEWS[name] ? name : 'dashboard';
}

function showView() {
    const name = currentView();
    document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== name; });
    document.querySelectorAll('[data-nav]').forEach(a => {
        const on = a.dataset.nav === name;
        a.classList.toggle('active', on);
        if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    $('view-title').textContent = VIEWS[name];
    document.title = `${VIEWS[name]} · AZ Content Scanner`;
    window.scrollTo({ top: 0 });
    if (name === 'history') loadScanHistory();
    mountAndRender();
}

// El mismo bloque de resultados (indicadores, gráficos, cobertura y tabla) se reubica en la vista activa:
// Panel = acumulado de todo lo escaneado · Nuevo escaneo = el escaneo actual · Historial = el escaneo abierto
let renderToken = 0;
async function mountAndRender() {
    const name = currentView();
    const block = $('results-block');
    const host = document.querySelector(`.results-host[data-host="${name}"]`);
    if (!host) return;
    if (block.parentElement !== host) host.appendChild(block);
    const token = ++renderToken;
    const empty = $('scan-empty');
    if (name === 'dashboard') {
        block.hidden = false;
        try {
            const { json } = await api('/api/overview');
            if (token !== renderToken) return;
            renderScan(json.overview || { assets: [], scansCount: 0, aggregate: true }, 'overview');
        } catch (e) { toast('No se pudo cargar el resumen del Panel.', 'err'); }
    } else if (name === 'scan') {
        const show = scanRunning || !!currentScan;
        block.hidden = !show;
        empty.hidden = show;
        if (scanRunning) { if (!shownScan || !shownScan.live) renderLiveEmpty(); }
        else if (currentScan) renderScan(currentScan, 'scan');
    } else if (name === 'history') {
        block.hidden = !historyScan;
        if (historyScan) renderScan(historyScan, 'history');
    }
}
function goTo(name) { location.hash = `#/${name}`; }

// ---------- Arranque ----------
window.addEventListener('hashchange', showView);
window.addEventListener('DOMContentLoaded', async () => {
    showView();
    document.addEventListener('keydown', onGlobalKey);
    // Si el usuario edita la URL a mano, las áreas detectadas ya no corresponden a ese sitio
    $('target-url').addEventListener('input', resetSections);
    try {
        await loadConfig();
        await refreshSessions();
        await fetchResults();
        await loadScanHistory();
        const s = await checkBusy();
        if (s && s.busy === 'scanning') attachProgress();
    } catch (e) {
        console.error('Error de inicialización:', e);
        setServerPill('err', 'Sin conexión');
    }
    // Si el servidor está escaneando y esta pantalla no lo sabe (escaneo lanzado desde otra pestaña, recarga…), se engancha
    setInterval(async () => {
        if (scanRunning || document.hidden || Date.now() - finishedAt < 15000) return;
        const s = await checkBusy();
        if (s && s.busy === 'scanning' && !scanRunning) attachProgress();
    }, 6000);
});

// ---------- Config y selectores ----------
async function loadConfig() {
    const { json } = await api('/api/config');
    CONFIG = json;
    $('region-select').innerHTML = Object.entries(CONFIG.regions)
        .map(([k, v]) => `<option value="${esc(k)}">${esc(v.label)}</option>`).join('');
    onRegionChange();
}

function onRegionChange() {
    const region = $('region-select').value;
    const { countries, blocked = {} } = CONFIG.regions[region];
    $('country-select').innerHTML = Object.keys(countries).map(c =>
        `<option value="${esc(c)}" ${blocked[c] ? 'disabled' : ''}>${esc(c)}${blocked[c] ? ' (dominio no autorizado en .env)' : ''}</option>`).join('');
    const firstOk = Object.keys(countries).find(c => !blocked[c]);
    if (firstOk) $('country-select').value = firstOk;
    onCountryChange();
}

function onCountryChange() {
    const region = $('region-select').value;
    const country = $('country-select').value;
    $('target-url').value = CONFIG.regions[region].countries[country] || '';
    resetSections();
}

// ---------- Estado del servidor ----------
function setServerPill(kind, text) {
    const p = $('server-pill');
    p.className = `pill pill-${kind}`;
    p.textContent = text;
}

async function checkBusy() {
    try {
        const { json: s } = await api('/api/scan/status');
        if (s.busy === 'scanning') setServerPill('busy', 'Escaneando…');
        else if (s.busy) setServerPill('busy', 'Validando sesiones…');
        else setServerPill('ok', 'Servidor listo');
        return s;
    } catch (e) {
        setServerPill('err', 'Sin conexión');
        return { busy: null };
    }
}

// ---------- Sesiones ----------
function stateView(st) {
    switch (st && st.state) {
        case 'active': return { cls: 'badge-success', text: 'Sesión activa' };
        case 'expired': return { cls: 'badge-danger', text: 'Expirada' };
        case 'error': return { cls: 'badge-warning', text: 'No se pudo validar' };
        case 'unknown': return { cls: 'badge-info', text: 'Guardada (sin validar)' };
        default: return { cls: 'badge-warning', text: 'Sin sesión' };
    }
}

function renderSessionStates(states) {
    sessionStates = states || {};
    $('sessions-list').innerHTML = SERVICES.map(svc => {
        const st = sessionStates[svc] || { state: 'none' };
        const v = stateView(st);
        const when = st.checkedAt ? ` · comprobada ${new Date(st.checkedAt).toLocaleTimeString()}` : '';
        const waiting = pendingLogin.has(svc);
        return `<div class="sess">
            <div class="sess-top">
                <span class="sess-name">${SERVICE_LABEL[svc]}</span>
                <span class="badge ${v.cls}">${v.text}</span>
            </div>
            <div class="sess-detail">${esc((st.detail || '') + when)}</div>
            <div class="sess-actions">
                <button class="btn btn-ghost btn-sm" onclick="startSession('${svc}')">${st.state === 'active' ? 'Renovar' : 'Iniciar sesión'}</button>
                ${waiting ? `<button class="btn btn-success btn-sm" onclick="finishSession('${svc}')">✔ Terminé</button>` : ''}
                ${st.state && st.state !== 'none' ? `<button class="btn btn-danger-ghost btn-sm" onclick="clearSession('${svc}')">Borrar</button>` : ''}
            </div>
        </div>`;
    }).join('');

    // Resumen de conexiones en la barra lateral
    $('session-dots').innerHTML = SERVICES.map(svc => {
        const st = (sessionStates[svc] || {}).state || 'none';
        const text = { active: 'Activa', expired: 'Expirada', error: 'Error', unknown: 'Sin validar' }[st] || 'Sin sesión';
        return `<a class="dot-row" href="#/accounts" title="${SERVICE_LABEL[svc]}: ${stateView(sessionStates[svc]).text}">
            <span class="dot-chip s-${st}"></span>${SERVICE_LABEL[svc]}<span class="dot-state">${text}</span></a>`;
    }).join('');

    renderReadiness();
    updateStartState();
}

// Las 2 cuentas son obligatorias: sin PromoMats no hay fechas con las que comparar los Approval IDs,
// y AzMed da acceso a las páginas protegidas. (Kaltura ya no necesita sesión.)
const SESSION_WHY = {
    azmed: 'páginas protegidas del sitio',
    promomats: 'fechas de vencimiento de los Approval IDs'
};

function missingSessions() {
    return SERVICES.filter(s => {
        const st = (sessionStates[s] || {}).state;
        return !st || st === 'none' || st === 'expired';
    });
}

function renderReadiness() {
    const items = SERVICES.map(svc => {
        const st = (sessionStates[svc] || {}).state || 'none';
        const name = SERVICE_LABEL[svc];
        if (st === 'active') return ['ok', `${name} conectada · ${SESSION_WHY[svc]}.`];
        if (st === 'unknown' || st === 'error') return ['warn', `${name} guardada; se comprobará al iniciar · ${SESSION_WHY[svc]}.`];
        if (st === 'expired') return ['bad', `${name} expirada: vuelve a iniciar sesión en Cuentas.`];
        return ['bad', `${name} sin conectar: es obligatoria (${SESSION_WHY[svc]}).`];
    });
    $('readiness').innerHTML = items.map(([k, t]) => `<div class="ready-item ready-${k}">${esc(t)}</div>`).join('');
}

async function validateSessions() {
    const btn = $('btn-validate');
    const msg = $('validate-msg');
    btn.disabled = true;
    msg.textContent = 'Comprobando (puede tardar unos segundos)…';
    try {
        const { res, json } = await post('/api/session/validate', { targetUrl: $('target-url').value });
        if (json.states) renderSessionStates(json.states);
        msg.textContent = res.ok ? 'Comprobación terminada.' : (json.error || 'No se pudo comprobar.');
    } catch (e) {
        msg.textContent = 'No se pudo contactar con el servidor.';
    } finally {
        btn.disabled = false;
    }
}

async function refreshSessions() {
    const { json } = await api('/api/session/status');
    renderSessionStates(json);
}

async function startSession(service) {
    try {
        const { json } = await post('/api/session/start', { service, url: $('target-url').value });
        if (json.success) {
            pendingLogin.add(service);
            renderSessionStates(sessionStates);
            toast(`${SERVICE_LABEL[service]}: inicia sesión en la ventana y luego pulsa "Terminé".`, 'ok');
        } else {
            toast(json.error || 'No se pudo abrir el navegador.', 'err');
        }
    } catch (e) {
        toast('No se pudo contactar con el servidor. ¿Está corriendo "npm start"?', 'err');
    }
}

async function finishSession(service) {
    try {
        const { json } = await post('/api/session/finish', { service });
        if (json.success) { pendingLogin.delete(service); toast(`${SERVICE_LABEL[service]}: sesión guardada.`, 'ok'); }
        else toast(`${SERVICE_LABEL[service]}: ${json.error || 'No se pudo guardar la sesión.'}`, 'err');
    } catch (e) {
        toast('No se pudo contactar con el servidor.', 'err');
    }
    refreshSessions();
}

async function clearSession(service) {
    if (!confirm(`¿Borrar la sesión guardada de ${SERVICE_LABEL[service]}?`)) return;
    const { json } = await post('/api/session/clear', { service });
    pendingLogin.delete(service);
    if (json.states) renderSessionStates(json.states); else refreshSessions();
}

// ---------- Ventana de conexión de cuentas ----------
// Se abre al pulsar «Iniciar escaneo» si falta alguna cuenta o está expirada. Cada cuenta se conecta en su ventana de
// navegador (el servidor detecta solo cuando el login termina); aquí se vigila el estado, se validan las cuentas y,
// cuando están las 2 activas, el escaneo arranca automáticamente.
let gateTimer = null;
let gateBusy = false;
let gateValidated = false;
let gateErrRetries = 0;

function gateState(svc) { return (sessionStates[svc] || {}).state || 'none'; }
const GATE_LOGIN = ['none', 'expired'];   // «error» es un fallo al comprobar (no falta el login): se reintenta sola
// El botón «Iniciar sesión» está disponible SIEMPRE que la cuenta no esté conectada ni esperando login: nunca hay que
// esperar a que termine una validación lenta para poder iniciar sesión a mano.
const gateCanLogin = (st) => st !== 'active' && st !== 'waiting';

function renderSessionGate(msg) {
    const label = { active: ['badge-success', 'Conectada'], waiting: ['badge-info', 'Esperando tu inicio de sesión…'],
        expired: ['badge-danger', 'Expirada'], none: ['badge-warning', 'Sin sesión'],
        unknown: ['badge-info', 'Guardada, validando…'], error: ['badge-warning', 'No se pudo validar'] };
    $('gate-list').innerHTML = SERVICES.map(svc => {
        const st = gateState(svc);
        const [cls, text] = label[st] || label.none;
        return '<div class="gate-row">' +
            '<div class="gate-info"><strong>' + SERVICE_LABEL[svc] + '</strong><small>' + esc(SESSION_WHY[svc]) + '</small></div>' +
            '<span class="badge ' + cls + '">' + text + '</span>' +
            '<div class="gate-actions">' +
            (gateCanLogin(st) ? '<button class="btn btn-primary btn-sm" onclick="startSession(\'' + svc + '\')">Iniciar sesión</button>' : '') +
            (st === 'waiting' ? '<button class="btn btn-success btn-sm" onclick="finishSession(\'' + svc + '\')">✔ Terminé</button>' : '') +
            '</div></div>';
    }).join('');
    if (msg !== undefined) $('gate-status').textContent = msg;
    $('gate-loader').hidden = !(gateBusy || SERVICES.some(s => ['waiting', 'unknown'].includes(gateState(s))));
    $('gate-connect').hidden = !SERVICES.some(s => gateCanLogin(gateState(s)));
}

async function gateTick() {
    if (gateBusy || $('session-modal').hidden) return;
    gateBusy = true;
    try {
        const { json } = await api('/api/session/status');
        sessionStates = json || {};
        // Guardadas pero sin comprobar: se validan solas en cuanto no queda ninguna por iniciar sesión
        const toValidate = SERVICES.filter(s => gateState(s) === 'unknown' || (gateState(s) === 'error' && gateErrRetries < 2));
        const loginLeft = SERVICES.some(s => ['none', 'expired', 'waiting'].includes(gateState(s)));
        if (toValidate.length && !loginLeft && !gateValidated) {
            gateValidated = true;
            if (SERVICES.some(s => gateState(s) === 'error')) gateErrRetries++;
            renderSessionGate('Validando las cuentas… (puede tardar unos segundos)');
            $('gate-loader').hidden = false;
            const { json: v } = await post('/api/session/validate', { services: toValidate, targetUrl: $('target-url').value });
            if (v && v.states) sessionStates = v.states;
        }
        renderSessionGate();
        renderSessionStates(sessionStates);
        if (SERVICES.every(s => gateState(s) === 'active')) {
            closeSessionGate(false);
            toast('Las 2 cuentas están validadas. Iniciando el escaneo…', 'ok');
            requestScan();
            return;
        }
        const waiting = SERVICES.filter(s => gateState(s) === 'waiting').map(s => SERVICE_LABEL[s]);
        if (waiting.length) $('gate-status').textContent = 'Inicia sesión en la ventana del navegador: ' + waiting.join(', ') + '. Se guardará sola al terminar. El portal de PromoMats puede tardar hasta 1 minuto en mostrar el login: no cierres ni recargues la ventana; si queda en blanco, espera.';
        else if (SERVICES.some(s => GATE_LOGIN.includes(gateState(s)))) $('gate-status').textContent = 'Pulsa «Iniciar sesión» en las cuentas que faltan.';
        if (SERVICES.some(s => gateState(s) === 'waiting' || (gateState(s) === 'error' && gateErrRetries < 2))) gateValidated = false;
        if (SERVICES.some(s => gateState(s) === 'error') && gateErrRetries >= 2) $('gate-status').textContent = 'No se pudo comprobar alguna cuenta (el portal tardó en responder). Pulsa «Iniciar sesión» en ella para renovarla.';
    } catch (e) {
        $('gate-status').textContent = 'No se pudo contactar con el servidor.';
    } finally {
        gateBusy = false;
    }
}

function openSessionGate() {
    gateValidated = false;
    gateErrRetries = 0;
    renderSessionGate('Conecta las cuentas marcadas; el escaneo empezará solo cuando estén las 2 activas.');
    $('session-modal').hidden = false;
    clearInterval(gateTimer);
    gateTimer = setInterval(gateTick, 2000);
    gateTick();
}

function closeSessionGate(cancelPending) {
    clearInterval(gateTimer);
    gateTimer = null;
    $('session-modal').hidden = true;
    if (cancelPending) {
        SERVICES.filter(s => gateState(s) === 'waiting').forEach(s => { post('/api/session/cancel', { service: s }).catch(() => {}); pendingLogin.delete(s); });
    }
    refreshSessions().catch(() => {});
}

// Abre la ventana de login de todas las cuentas que faltan (una tras otra, con una breve pausa)
async function gateConnectAll() {
    for (const svc of SERVICES.filter(s => gateCanLogin(gateState(s)))) {
        await startSession(svc);
        await new Promise(r => setTimeout(r, 700));
    }
    gateTick();
}

// ---------- Áreas del sitio (escaneo por áreas) ----------
// Se lee el menú (header) de la página principal y el usuario elige qué ramas analizar: menos peticiones seguidas
// contra el WAF y resultados más rápidos. "Sitio completo" sigue disponible, con confirmación.
let sectionsData = null;        // respuesta de /api/scan/sections
const selectedAreas = new Set(); // ids marcados (áreas y subáreas)
let fullSite = false;
let detecting = false;
let scanRunning = false;
let progressAreasText = '';

function setDetectMsg(text, isErr) {
    const el = $('detect-msg');
    el.textContent = text || '';
    el.classList.toggle('is-err', !!isErr);
}

function resetSections() {
    sectionsData = null;
    selectedAreas.clear();
    fullSite = false;
    $('mode-full').checked = false;
    setDetectMsg('');
    renderSections();
    updateStartState();
}

async function detectSections() {
    if (detecting) return;
    const url = $('target-url').value.trim();
    if (!url) { setDetectMsg('Escribe la URL del sitio.', true); return; }
    detecting = true;
    const btn = $('btn-detect');
    btn.disabled = true;
    btn.classList.add('is-loading');
    $('detect-loader').hidden = false;
    setDetectMsg('Leyendo el menú de la página principal… (unos segundos)');
    try {
        const { res, json } = await post('/api/scan/sections', { targetUrl: url });
        if (!res.ok || !json.success) {
            sectionsData = null;
            setDetectMsg(json.error || `No se pudo leer el menú (HTTP ${res.status}).`, true);
        } else {
            sectionsData = { ...json, forUrl: url };
            selectedAreas.clear();
            fullSite = false;
            $('mode-full').checked = false;
            const d = json.debug;
            const diag = d ? ` (la página tiene ${d.anchors} enlaces, ${d.topAnchors} en la zona del header, título «${d.title}»)` : '';
            setDetectMsg(!json.sections.length
                ? `No se pudo leer el menú del header${diag}. Puedes analizar el sitio completo o añadir URLs adicionales.`
                : json.source === 'sitemap'
                    ? `No se pudo leer el menú del header, así que se proponen ${json.sections.length} áreas a partir del sitemap. Revisa que coincidan con tu menú.`
                    : `Se detectaron ${json.sections.length} áreas${json.sitemapTotal ? ` · ${json.sitemapTotal} páginas en el sitemap` : ''}.${
                        json.sitemapTotal && json.sections.filter(x => x.url && !x.home).every(x => !x.estimatedPages)
                            ? ` El sitemap de este sitio no usa las mismas rutas que el menú, así que no hay estimación de páginas por área. El escaneo funciona igual: sigue los enlaces dentro de la ruta de cada área.` : ''}`,
                !json.sections.length);
        }
    } catch (e) {
        sectionsData = null;
        setDetectMsg('No se pudo contactar con el servidor.', true);
    } finally {
        detecting = false;
        btn.disabled = false;
        btn.classList.remove('is-loading');
        $('detect-loader').hidden = true;
        renderSections();
        updateStartState();
    }
}

function findArea(id) {
    for (const top of (sectionsData ? sectionsData.sections : [])) {
        if (top.id === id) return { node: top, parent: null };
        const child = top.children.find(c => c.id === id);
        if (child) return { node: child, parent: top };
    }
    return null;
}

// Marcar un área con enlace propio cubre sus subáreas (su ruta las incluye); un grupo sin enlace marca todas sus subáreas
function toggleArea(id, checked) {
    const found = findArea(id);
    if (!found) return;
    const { node, parent } = found;
    if (!parent && node.url) {
        if (checked) { selectedAreas.add(id); node.children.forEach(c => selectedAreas.delete(c.id)); }
        else selectedAreas.delete(id);
    } else if (!parent) {                       // grupo sin enlace propio
        node.children.forEach(c => (checked ? selectedAreas.add(c.id) : selectedAreas.delete(c.id)));
    } else if (checked) selectedAreas.add(id); else selectedAreas.delete(id);
    renderSections();
    updateStartState();
}

function selectAllSections(on) {
    selectedAreas.clear();
    if (on && sectionsData) sectionsData.sections.forEach(t => { if (t.url) selectedAreas.add(t.id); else t.children.forEach(c => selectedAreas.add(c.id)); });
    renderSections();
    updateStartState();
}

// Áreas efectivas a enviar al servidor (una subárea marcada bajo un área ya marcada no se repite)
function selectedSections() {
    const out = [];
    for (const top of (sectionsData ? sectionsData.sections : [])) {
        if (top.url && selectedAreas.has(top.id)) {
            out.push({ label: top.label, url: top.url, scope: top.scope, exact: top.exact, estimatedPages: top.estimatedPages });
        } else {
            for (const c of top.children) {
                if (selectedAreas.has(c.id)) out.push({ label: top.url || top.children.length > 1 ? `${top.label} › ${c.label}` : c.label, url: c.url, exact: false, estimatedPages: c.estimatedPages });
            }
        }
    }
    return out;
}

function renderSections() {
    const empty = $('sections-empty'), panel = $('sections-panel');
    if (!sectionsData || !sectionsData.sections.length) {
        empty.hidden = false;
        empty.textContent = sectionsData ? 'No se encontró un menú en el header de este sitio.' : 'Pulsa «Detectar áreas del sitio» para leer el menú de la página principal.';
        panel.hidden = true;
        return;
    }
    empty.hidden = true;
    panel.hidden = false;
    const off = fullSite ? 'disabled' : '';
    const count = (n) => (n === null || n === undefined ? '' : `<span class="sec-count">~${esc(n)} págs.</span>`);
    const row = (n, { checked, disabled, tag, cls }) => `
        <label class="sec-row ${cls || ''}">
            <input type="checkbox" data-id="${esc(n.id)}" ${checked ? 'checked' : ''} ${disabled || off ? 'disabled' : ''} onchange="toggleArea(this.dataset.id, this.checked)">
            <span class="sec-label">${esc(n.label)}</span>${tag ? `<span class="sec-tag">${esc(tag)}</span>` : ''}${count(n.estimatedPages)}
        </label>`;

    $('sections-list').className = `sections-list${fullSite ? ' is-off' : ''}`;
    $('sections-list').innerHTML = sectionsData.sections.map(top => {
        const parentOn = !!top.url && selectedAreas.has(top.id);
        const allKids = top.children.length && top.children.every(c => selectedAreas.has(c.id));
        const topChecked = top.url ? parentOn : allKids;
        const kids = top.children.map(c => row(c, { checked: parentOn || selectedAreas.has(c.id), disabled: parentOn, cls: 'sec-child' })).join('');
        return `<div class="sec-group">${row(top, { checked: topChecked, tag: top.exact ? 'solo esta página' : '', cls: 'sec-top' })}${kids ? `<div class="sec-children">${kids}</div>` : ''}</div>`;
    }).join('');

    // Estado intermedio de un grupo sin enlace con solo algunas subáreas marcadas
    sectionsData.sections.forEach(top => {
        if (top.url || !top.children.length) return;
        const n = top.children.filter(c => selectedAreas.has(c.id)).length;
        const box = $('sections-list').querySelector(`input[data-id="${top.id}"]`);
        if (box) box.indeterminate = n > 0 && n < top.children.length;
    });

    const sel = selectedSections();
    const est = sel.reduce((a, s) => a + (s.estimatedPages || 0), 0);
    const unknown = sel.some(s => s.estimatedPages === null || s.estimatedPages === undefined);
    const max = CONFIG && CONFIG.maxPages;
    let text = sel.length ? `${sel.length} área${sel.length > 1 ? 's' : ''} · ${unknown && !est ? 'páginas sin estimar' : `~${est} páginas${unknown ? '+' : ''}`}` : 'Ninguna área marcada';
    if (max && est > max) text += ` · supera el límite de ${max} páginas: el escaneo quedaría PARCIAL, elige menos áreas`;
    $('sections-summary').textContent = fullSite ? 'Se analizará el sitio completo' : text;
}

function onFullToggle() {
    fullSite = $('mode-full').checked;
    renderSections();
    updateStartState();
}

function queueOn(sel) { return !fullSite && sel.length > 1 && $('mode-queue').checked; }

function extraUrlList() { return $('extra-urls').value.split(/\s+/).map(s => s.trim()).filter(Boolean); }
function onlyUrlsOn() { return $('only-urls').checked; }

function updateStartState() {
    if (onlyUrlsOn()) {
        const n = extraUrlList().length;
        $('queue-toggle').hidden = true;
        $('btn-start-scan').disabled = scanRunning || !n;
        $('start-hint').textContent = scanRunning ? 'Hay un escaneo en curso.'
            : !n ? 'Pega al menos una URL en «Opciones avanzadas → URLs adicionales».'
            : `Se analizará solo ${n === 1 ? 'esa URL' : `esas ${n} URLs`}, sin rastrear el resto del sitio.`;
        return;
    }
    const sel = fullSite ? [] : selectedSections();
    $('queue-toggle').hidden = fullSite || sel.length < 2;
    const missing = missingSessions();
    const ok = !scanRunning && (fullSite || sel.length > 0);
    $('btn-start-scan').disabled = !ok;
    $('start-hint').textContent = scanRunning ? 'Hay un escaneo en curso.'
        : (fullSite || sel.length) && missing.length ? `Faltan cuentas (${missing.map(s => SERVICE_LABEL[s]).join(', ')}): al pulsar «Iniciar escaneo» se abrirá una ventana para conectarlas.`
        : fullSite ? 'Se analizará el sitio completo.'
        : sel.length ? `Se analizará${queueOn(sel) ? ' en cola' : ''}: ${sel.map(s => s.label).join(', ')}.`
        : 'Detecta las áreas y marca al menos una, o elige el sitio completo.';
}

// ---------- Escaneo ----------
async function requestScan() {
    if (starting) return;
    const onlyUrls = onlyUrlsOn();
    const sections = fullSite || onlyUrls ? [] : selectedSections();
    if (onlyUrls && !extraUrlList().length) { setNotice('Pega al menos una URL para analizar solo esas páginas.', true); return; }
    if (!onlyUrls && !fullSite && !sections.length) { setNotice('Marca al menos un área o elige el sitio completo.', true); return; }
    if (!onlyUrls && fullSite && !confirm('Vas a analizar el sitio completo.\n\nUn rastreo completo hace cientos de peticiones seguidas y puede activar el firewall (WAF) del sitio, dejando el escaneo incompleto. Se recomienda analizar 1–2 áreas por escaneo.\n\n¿Continuar con el sitio completo?')) return;
    if (missingSessions().length) { openSessionGate(); return; }
    starting = true;
    progressAreasText = onlyUrls ? `URLs indicadas (${extraUrlList().length})` : sections.length ? `${queueOn(sections) ? 'Cola de áreas' : 'Áreas'}: ${sections.map(s => s.label).join(', ')}` : 'Sitio completo';
    const btn = $('btn-start-scan');
    btn.disabled = true;
    btn.classList.add('is-loading');
    $('start-loader').hidden = false;
    setNotice('Comprobando sesiones guardadas… (puede tardar unos segundos)', false);

    try {
        const { res, json } = await post('/api/scan', {
            targetUrl: $('target-url').value.trim(),
            region: $('region-select').value,
            country: $('country-select').value,
            extraUrls: extraUrlList(),
            onlyUrls,
            sections: sections.map(({ label, url, exact, scope }) => ({ label, url, exact, scope })),
            queue: queueOn(sections)
        });
        if (json.states) renderSessionStates(json.states);
        if (res.status === 409 && json.sessionExpired) { openSessionGate(); setNotice('', false); return; }
        if (!res.ok || !json.success) {
            setNotice(json.error || `El servidor rechazó el escaneo (HTTP ${res.status}).`, true);
            checkBusy();
            return;
        }
        setNotice(json.warning || '', false);
        attachProgress();   // el progreso y, al terminar, el resultado se ven en esta misma vista (debajo del paso 3)
        mountAndRender();
        setTimeout(() => { const h = $('progress-card'); if (h && !h.hidden) h.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 100);
    } catch (e) {
        setNotice('Error de conexión con el servidor.', true);
    } finally {
        starting = false;
        $('btn-start-scan').classList.remove('is-loading');
        $('start-loader').hidden = true;
        updateStartState();
    }
}

// Panel "en vivo": mientras hay un escaneo en curso, el panel muestra ESE escaneo (todo en ceros hasta que termine) y no
// el anterior. Los escaneos anteriores siguen disponibles en la pestaña Historial.
function renderLiveEmpty() {
    const url = $('target-url').value;
    renderScan({ scanId: '_live', live: true, assets: [], targetUrl: url, date: new Date().toISOString(), sections: null, outcome: '' }, 'live');
    $('last-scan-meta').textContent = 'Escaneo en curso';
    $('results-subtitle').textContent = `${url}${progressAreasText ? ` · ${progressAreasText}` : ''} · los resultados aparecen al terminar`;
    $('results-badge').innerHTML = '<span class="badge badge-info">EN CURSO</span>';
    $('coverage-box').innerHTML = '';
}

// Sumatoria en vivo: los indicadores del panel suben a medida que se escanea (solo si se está viendo el escaneo en curso)
function applyLive(l) {
    if (!shownScan || !shownScan.live) return;
    const b = { vencidos: l.vencidos || 0, proximos: l.proximos || 0, vigentes: l.vigentes || 0, retirados: l.retirados || 0, sinFecha: l.sinFecha || 0, total: l.total || 0 };
    $('metric-vencido').textContent = b.vencidos;
    $('metric-prox').textContent = b.proximos;
    $('metric-vigente').textContent = b.vigentes;
$('metric-sinfecha').textContent = b.sinFecha;
    $('metric-total').textContent = b.total;
    renderInsights(b, []);
}

let scanClockStart = null, scanClockTimer = null;   // reloj del escaneo: avanza cada segundo, no solo cuando llega un evento
function tickClock() { if (scanClockStart) $('prog-elapsed').textContent = fmtElapsed(Math.floor((Date.now() - scanClockStart) / 1000)); }
function startClock() { clearInterval(scanClockTimer); scanClockTimer = setInterval(tickClock, 1000); }
function stopClock() { clearInterval(scanClockTimer); scanClockTimer = null; }

let pendingFinish = null;   // último aviso de fin del motor, a la espera de que el resultado esté guardado
let finishedAt = 0;   // cuándo terminó el último escaneo (evita re-enganchar el progreso mientras el servidor guarda)

function attachProgress() {
    scanFinished = false;
    pendingFinish = null;
    $('progress-card').hidden = false;
    scanRunning = true;
    shownScan = null;   // fuerza a pintar el escaneo en curso si se está en «Nuevo escaneo»
    $('progress-site').textContent = progressAreasText ? `${$('target-url').value} · ${progressAreasText}` : $('target-url').value;
    resetProgress();
    startClock();
    setServerPill('busy', 'Escaneando…');
    updateStartState();
    if (currentView() === 'scan') mountAndRender();

    if (activeEventSource) activeEventSource.close();
    activeEventSource = new EventSource('/api/scan-stream');
    activeEventSource.onmessage = (ev) => {
        let d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.idle) return;
        updateProgressUI(d);
        // Con progress 100 el motor aún está cerrando: se espera el evento `saved` (resultado ya guardado) o a que el servidor quede libre
        if (d.saved) finishProgress(d);
        else if (d.progress === 100 && (d.done || d.error)) { pendingFinish = d; pollIdle(); }
    };
    activeEventSource.onerror = () => {
        if (!scanFinished) $('progress-detail').textContent = 'Conexión interrumpida, reconectando… (el escaneo sigue en el servidor)';
    };

    clearInterval(progressPoll);
    progressPoll = setInterval(async () => {
        try {
            const { json: s } = await api('/api/scan/status');
            if (s.busy !== 'scanning' && !scanFinished) finishProgress(pendingFinish);
        } catch (e) {
            $('progress-detail').textContent = 'No hay respuesta del servidor. Si se cerró, reinícialo con "npm start".';
        }
    }, 2000);
}

// Consulta rápida del estado cuando el motor ya dijo «terminado»: sale en cuanto el servidor queda libre (resultado guardado)
async function pollIdle() {
    for (let i = 0; i < 120 && !scanFinished; i++) {
        try {
            const { json: s } = await api('/api/scan/status');
            if (s.busy !== 'scanning') { finishProgress(pendingFinish); return; }
        } catch (e) { /* el sondeo normal sigue */ }
        await new Promise(r => setTimeout(r, 1000));
    }
}

function finishProgress(d) {
    if (scanFinished) return;
    scanFinished = true;
    pendingFinish = null;
    finishedAt = Date.now();
    tickClock(); stopClock();
    clearInterval(progressPoll);
    if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
    setTimeout(async () => {
        $('progress-card').hidden = true;
        scanRunning = false;
        progressAreasText = '';
        updateStartState();
        await fetchResults(true);
        await loadScanHistory();
        await checkBusy();
        await refreshSessions();
        shownScan = null;
        await mountAndRender();
        if (d && d.error) toast(d.status || 'El escaneo terminó con error.', 'err');
        else toast('Escaneo terminado. El resultado queda en «Nuevo escaneo» y el Panel ya lo suma.', 'ok');
    }, 1000);
}

async function cancelCurrentScan() {
    if (!confirm('¿Detener el escaneo? Se conservará lo detectado hasta ahora.')) return;
    try {
        await post('/api/cancel-scan');
        $('progress-detail').textContent = 'Cancelando… se conservará lo detectado hasta ahora.';
    } catch (e) {
        toast('No se pudo contactar con el servidor.', 'err');
    }
}

function resetProgress() {
    document.querySelectorAll('#stepper li').forEach(li => { li.className = ''; li.querySelector('.dot').textContent = li.dataset.step; });
    $('progress-bar').style.width = '0%';
    $('progress-track').setAttribute('aria-valuenow', '0');
    scanClockStart = null;
    $('prog-elapsed').textContent = '0:00';
    $('prog-pages').textContent = '0';
    $('prog-ids').textContent = '0';
    $('prog-percent').textContent = '0%';
    $('progress-detail').textContent = 'Iniciando…';
}

function updateProgressUI(d) {
    if (typeof d.progress === 'number') {
        $('progress-bar').style.width = `${d.progress}%`;
        $('progress-track').setAttribute('aria-valuenow', String(d.progress));
        $('prog-percent').textContent = `${d.progress}%`;
    }
    if (d.status) $('progress-detail').textContent = d.status;
    if (d.elapsed !== undefined) {
        // El servidor da el tiempo transcurrido; se conserva el inicio más antiguo (en cola cada área reinicia su cuenta)
        const start = Date.now() - d.elapsed * 1000;
        if (!scanClockStart || start < scanClockStart) scanClockStart = start;
        tickClock();
    }
    if (d.pagesRead !== undefined) $('prog-pages').textContent = d.pagesRead;
    if (d.idsFound !== undefined) $('prog-ids').textContent = d.idsFound;
    if (d.live) applyLive(d.live);

    if (d.step) {
        document.querySelectorAll('#stepper li').forEach(li => {
            const n = Number(li.dataset.step);
            const dot = li.querySelector('.dot');
            if (n < d.step || (n === d.step && d.done && !d.error)) { li.className = 'done'; dot.textContent = '✓'; }
            else if (n === d.step) { li.className = d.error ? '' : 'active'; dot.textContent = d.error ? '✕' : n; }
            else { li.className = ''; dot.textContent = n; }
        });
    }
}

// ---------- Resultados ----------
async function fetchResults(force) {
    try {
        const { json } = await api('/api/results');
        latestScan = json.lastScan || null;
        if (json.currentScan) currentScan = json.currentScan;
        else if (force) currentScan = null;
        if (currentView() === 'scan') mountAndRender();
    } catch (e) {
        toast('No se pudieron cargar los resultados.', 'err');
    }
}

function renderScan(scan, mode) {
    shownScan = scan;
    view.limit = PAGE_SIZE;
    const b = breakdown(scan.assets);
    $('metric-vencido').textContent = b.vencidos;
    $('metric-prox').textContent = b.proximos;
    $('metric-vigente').textContent = b.vigentes;
$('metric-sinfecha').textContent = b.sinFecha;
    $('metric-total').textContent = b.total;

    if (mode === 'overview') {
        $('results-subtitle').textContent = scan.scansCount
            ? `Resumen de todo lo consultado: ${scan.scansCount} escaneo(s) guardado(s). Cada Approval ID cuenta una vez, con su resultado más reciente.`
            : 'Aún no hay escaneos guardados. Lanza uno en «Nuevo escaneo».';
        $('last-scan-meta').textContent = scan.scansCount ? `Acumulado de ${scan.scansCount} escaneo(s)` : 'Aún no hay escaneos en este equipo';
    } else {
        $('results-subtitle').textContent = `${scan.targetUrl} · ${new Date(scan.date).toLocaleString()}${scan.sections && scan.sections.length ? ` · Áreas: ${scan.sections.join(', ')}` : ''}`;
        $('last-scan-meta').textContent = `${mode === 'history' ? 'Escaneo del historial' : 'Escaneo actual'}: ${new Date(scan.date).toLocaleString()}`;
    }
    $('results-badge').innerHTML = scan.outcome
        ? `<span class="badge ${scan.outcome === 'COMPLETO' ? 'badge-success' : 'badge-warning'}">${esc(scan.outcome)}</span>` : '';

    const banner = $('history-banner');
    if (mode === 'history') {
        banner.hidden = false;
        banner.innerHTML = `<span>Detalle del escaneo del historial.</span>
            <button class="btn btn-ghost btn-sm" onclick="closeHistoryDetail()">Cerrar detalle</button>`;
    } else if (mode === 'overview' && scan.scansCount) {
        banner.hidden = false;
        banner.innerHTML = '<span>Resumen acumulado de todos los escaneos guardados. El resultado de cada escaneo está en «Nuevo escaneo» y en el Historial.</span>';
    } else { banner.hidden = true; banner.innerHTML = ''; }

    const types = [...new Set((scan.assets || []).map(a => a.type).filter(Boolean))].sort();
    const sel = $('filter-type');
    sel.innerHTML = '<option value="">Todos los tipos</option>' + types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
    sel.value = types.includes(view.type) ? view.type : '';
    view.type = sel.value;

    renderInsights(b, scan.assets);
    if (mode === 'overview') $('coverage-box').innerHTML = ''; else renderCoverage(scan);   // la cobertura es de cada escaneo
    renderAssetsTable();
}

function closeHistoryDetail() { historyScan = null; mountAndRender(); }

// Indicadores del panel: índice de cumplimiento, distribución por estado y calendario de vencimientos
function renderInsights(b, assets) {
    const box = $('insights');
    // Cuota de cada KPI sobre el total (barra inferior de la tarjeta)
    document.querySelectorAll('.kpi[data-filter]').forEach(k => {
        const n = { 'VENCIDO': b.vencidos, 'PROXIMO A VENCER': b.proximos, 'VIGENTE': b.vigentes, 'RETIRADO': b.retirados, 'SIN FECHA': b.sinFecha }[k.dataset.filter];
        if (n !== undefined) k.style.setProperty('--share', b.total ? Math.round(n / b.total * 100) : 0);
    });
    if (!b.total) { box.hidden = true; return; }
    box.hidden = false;

    // 1) Índice de cumplimiento: materiales aún válidos hoy (vigentes + por vencer) sobre los que tienen una
    //    situación conocida (se excluyen los "por revisar", que no se pueden evaluar)
    const valid = b.vigentes + b.proximos;
    const known = valid + b.vencidos + b.retirados;
    const pct = known ? Math.round(valid / known * 100) : null;
    $('insight-score').innerHTML = `<div class="score">
        <div class="ring" style="--p:${pct ?? 0}" role="img" aria-label="Índice de cumplimiento: ${pct ?? 'sin datos'}${pct !== null ? '%' : ''}"><b>${pct === null ? '—' : pct + '%'}</b></div>
        <div>
            <h3>Índice de cumplimiento</h3>
            <p>${pct === null ? 'Aún no hay materiales con fecha para evaluar.'
                : `${valid} de ${known} materiales con situación conocida siguen vigentes.${b.vencidos + b.retirados ? ` ${b.vencidos + b.retirados} requieren acción.` : ''}`}</p>
        </div>
    </div>`;

    // 2) Distribución por estado
    const parts = [
        ['Vencidos', b.vencidos, 'var(--magenta)'], ['Por vencer', b.proximos, 'var(--gold)'],
        ['Vigentes', b.vigentes, 'var(--navy)'], ['Retirados', b.retirados, 'var(--purple)'],
        ['Por revisar', b.sinFecha, '#9aa3a3']   // tinte de Graphite: los tintes se permiten solo en gráficos
    ].filter(p => p[1] > 0);
    let acc = 0;
    const stops = parts.map(([, n, c]) => { const s = acc; acc += (n / b.total) * 100; return `${c} ${s}% ${acc}%`; }).join(', ');
    $('insight-dist').innerHTML = `
        <div class="donut" data-total="${b.total}" style="background:conic-gradient(${stops})" role="img"
             aria-label="Distribución: ${parts.map(p => `${p[0]} ${p[1]}`).join(', ')}"></div>
        <div class="legend">${parts.map(([l, n, c]) => `<div><i style="background:${c}"></i>${l}: <b>${n}</b></div>`).join('')}</div>`;

    // 3) Calendario: vencimientos por mes (mes actual + 5 siguientes) y los ya vencidos
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() + i, 1));
    const counts = months.map(() => 0);
    let overdue = 0;
    (assets || []).forEach(a => {
        if (!a.expirationDate || a.status === 'RETIRADO') return;
        const d = new Date(`${a.expirationDate}T00:00:00`);
        if (isNaN(d)) return;
        if (a.status === 'VENCIDO') { overdue++; return; }
        const idx = (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth();
        if (idx >= 0 && idx < 6) counts[idx]++;
    });
    const cols = [{ label: 'Vencidos', n: overdue, past: true },
        ...months.map((m, i) => ({ label: m.toLocaleDateString('es', { month: 'short' }), n: counts[i], past: false }))];
    const max = Math.max(1, ...cols.map(c => c.n));
    $('insight-timeline').innerHTML = cols.some(c => c.n)
        ? `<div class="timeline" role="img" aria-label="Vencimientos: ${cols.map(c => `${c.label} ${c.n}`).join(', ')}">${cols.map(c =>
            `<div class="tl-col ${c.past ? 'past' : ''}"><div class="tl-bar" style="--h:${Math.round(c.n / max * 100)}"></div><span class="tl-n">${c.n}</span><span class="tl-l">${esc(c.label)}</span></div>`).join('')}</div>`
        : '<p class="empty-chart">No hay vencimientos con fecha en los próximos 6 meses.</p>';
}

let coverageOutOfScope = [];
async function copyOutOfScope() {
    try { await navigator.clipboard.writeText(coverageOutOfScope.join('\n')); toast('Lista copiada. Pégala en «URLs adicionales».', 'ok'); }
    catch (e) { toast('No se pudo copiar; selecciona la lista manualmente.', 'err'); }
}

function renderCoverage(scan) {
    const c = scan.coverage;
    const box = $('coverage-box');
    if (!c) { box.innerHTML = ''; return; }
    coverageOutOfScope = c.outOfScope || [];
    const list = (arr, fmt, n) => (arr || []).slice(0, n).map(fmt).join('');
    const code = (u) => `<li><code>${esc(u)}</code></li>`;
    const reasons = list(c.partialReasons, r => `<li>${esc(r)}</li>`, 50);
    const login = list(c.loginPages, code, 30);
    const stale = list(c.sitemapStaleList, code, 50);
    const fails = list(c.failures, f => `<li><code>${esc(f.url)}</code> — ${esc(f.reason)}</li>`, 30);
    const broken = list(c.brokenLinkList, code, 50);
    const cell = (n, l) => `<div><b>${n ?? 0}</b><small>${l}</small></div>`;
    box.innerHTML = `
        <details>
            <summary>Cobertura del escaneo (${esc(scan.outcome || '')})</summary>
            <div class="coverage-grid">
                ${cell(c.pagesRead, 'Páginas leídas')}${cell(c.pagesFailed, 'Con error')}${cell(c.brokenLinks, 'Enlaces rotos (404)')}
                ${cell(c.pagesNeedingLogin, 'Exigen sesión')}${cell(c.imagesOcr, 'Imágenes con OCR')}${cell(c.imagesByNameOnly, 'Imágenes por nombre')}
                ${cell(c.pdfsFull, 'PDF completos')}${cell(c.pdfsByNameOnly, 'PDF por nombre')}${cell(c.videosChecked, 'Videos revisados')}
                ${c.videosUnverified ? cell(c.videosUnverified, 'Videos sin verificar (Kaltura)') : ''}
                ${c.sitemapUrls !== undefined ? cell(c.sitemapUrls, 'URLs en sitemaps') + cell(c.sitemapStale, 'Sitemap obsoletas') +
                    cell(c.duplicatesSkipped, 'Duplicadas omitidas') + cell(c.hiddenTextIds, 'IDs en contenido oculto') + cell(c.wafBlocked, 'Bloqueadas por WAF') : ''}
            </div>
            ${c.sitemapDiscarded ? `<p class="hint">Se descartaron ${esc(c.sitemapDiscarded)} URLs del sitemap porque estaba obsoleto (todas daban 404): menos peticiones contra el WAF.</p>` : ''}
            ${c.scope && c.scope.mode === 'areas' ? `<p class="hint">Áreas analizadas: ${esc(c.scope.sections.join(', '))}</p>` : ''}
            ${(c.areas || []).length ? `<details open><summary>Resultado por área (${c.areas.length})</summary><ul>${c.areas.map(x => `<li><strong>${esc(x.label)}</strong>: ${esc(x.status)} · ${esc(x.pagesRead)} páginas · ${esc(x.idsFound)} IDs${x.attempts > 1 ? ' · reintentada' : ''}${x.error ? ` · ${esc(x.error)}` : ''}</li>`).join('')}</ul></details>` : ''}
            ${(c.acceptedOverlays || []).length ? `<p class="hint">Botones pulsados automáticamente: ${c.acceptedOverlays.map(o => `"${esc(o.text)}" ×${esc(o.times)}`).join(', ')}</p>` : ''}
            ${reasons ? `<p class="coverage-warn">Limitaciones:</p><ul>${reasons}</ul>` : ''}
            ${fails ? `<details><summary>Páginas con error (${c.pagesFailed})</summary><ul>${fails}</ul></details>` : ''}
            ${broken ? `<details><summary>Enlaces rotos (${c.brokenLinks})</summary><ul>${broken}</ul></details>` : ''}
            ${login ? `<details><summary>Páginas que pidieron sesión (${c.pagesNeedingLogin})</summary><ul>${login}</ul></details>` : ''}
            ${(c.outOfScope || []).length ? `<details><summary>Páginas fuera de las áreas elegidas (${c.outOfScope.length})</summary>
                <p class="hint">Se encontraron enlaces a estas páginas pero no se analizaron. Cópialas y pégalas en «Opciones avanzadas → URLs adicionales» (Nuevo escaneo) para incluirlas.</p>
                <button class="btn btn-ghost btn-sm" onclick="copyOutOfScope()">Copiar lista</button><ul>${list(c.outOfScope, code, 300)}</ul></details>` : ''}
            ${stale ? `<details><summary>URLs de sitemap que ya no existen (${c.sitemapStale})</summary><ul>${stale}</ul></details>` : ''}
        </details>`;
}

// ---------- Filtros, orden y tabla ----------
function matchesFilter(a) {
    if (view.status === 'SIN FECHA') { if (MAIN_STATUSES.includes(a.status)) return false; }
    else if (view.status && a.status !== view.status) return false;
    if (view.type && a.type !== view.type) return false;
    if (view.q) {
        const hay = `${a.veevaApprovalId} ${a.location} ${a.type} ${a.assetUrl || ''} ${(a.pages || []).join(' ')}`.toLowerCase();
        if (!hay.includes(view.q.toLowerCase())) return false;
    }
    return true;
}

function sortValue(a, key) {
    switch (key) {
        case 'status': return STATUS_ORDER[a.status] ?? 3;
        case 'id': return a.veevaApprovalId || '';
        case 'type': return a.type || '';
        case 'expiration': return a.expirationDate || '';
        case 'days': return a.daysRemaining ?? Infinity;
        case 'pages': return a.pagesCount ?? 0;
        default: return 0;
    }
}

function setStatusFilter(status) {
    view.status = view.status === status ? '' : status;
    view.limit = PAGE_SIZE;
    renderAssetsTable();
}
function onSearch() { view.q = $('filter-q').value.trim(); view.limit = PAGE_SIZE; renderAssetsTable(); }
function onTypeFilter() { view.type = $('filter-type').value; view.limit = PAGE_SIZE; renderAssetsTable(); }
function clearFilters() {
    view.status = ''; view.q = ''; view.type = '';
    $('filter-q').value = ''; $('filter-type').value = '';
    view.limit = PAGE_SIZE; renderAssetsTable();
}
function onSortSelect() {
    const [key, dir] = ($('filter-sort').value || ':').split(':');
    view.sortKey = key || '';
    view.sortDir = Number(dir) || 1;
    renderAssetsTable();
}
function setSort(key) {
    if (view.sortKey === key) view.sortDir = -view.sortDir; else { view.sortKey = key; view.sortDir = 1; }
    renderAssetsTable();
}
function showMore() { view.limit += PAGE_SIZE; renderAssetsTable(); }

function renderAssetsTable() {
    const tbody = $('results-table-body');
    const assets = shownScan ? shownScan.assets : null;

    document.querySelectorAll('#results-table th[data-sort]').forEach(th => {
        th.setAttribute('aria-sort', th.dataset.sort === view.sortKey ? (view.sortDir === 1 ? 'ascending' : 'descending') : 'none');
    });
    document.querySelectorAll('.kpi').forEach(k => k.classList.toggle('is-active', k.dataset.filter === view.status && view.status !== ''));
    const filtering = !!(view.status || view.q || view.type);
    $('clear-filter').hidden = !filtering;

    if (!assets || !assets.length) {
        const msg = shownScan && shownScan.live ? 'El escaneo en curso mostrará aquí sus resultados al terminar.'
            : shownScan ? 'El escaneo no encontró Approval IDs.' : 'Los activos encontrados aparecerán aquí.';
        tbody.innerHTML = `<tr><td colspan="8" class="empty-row">${msg}</td></tr>`;
        $('assets-count').textContent = '';
        $('btn-more').hidden = true;
        return;
    }

    // Se conserva el índice original para que "Detalle" abra el activo correcto
    let rows = assets.map((a, i) => ({ a, i })).filter(({ a }) => matchesFilter(a));
    if (view.sortKey) {
        rows.sort((x, y) => {
            const vx = sortValue(x.a, view.sortKey), vy = sortValue(y.a, view.sortKey);
            return (vx < vy ? -1 : vx > vy ? 1 : 0) * view.sortDir;
        });
    }
    $('assets-count').textContent = `${rows.length} de ${assets.length} registros`;

    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-row">Ningún activo coincide con el filtro.</td></tr>`;
        $('btn-more').hidden = true;
        return;
    }
    const visible = rows.slice(0, view.limit);
    tbody.innerHTML = visible.map(({ a, i }) => `
        <tr>
            <td data-label="Estado"><span class="badge ${badgeClass(a.status)}" title="${esc(a.status)}">${esc(shortStatus(a.status))}</span></td>
            <td data-label="Approval ID" class="mono id nowrap">${esc(a.veevaApprovalId)}</td>
            <td data-label="Tipo" class="nowrap">${esc(a.type)}</td>
            <td data-label="Vence" class="mono nowrap">${esc(fmtDate(a.expirationDate))}</td>
            <td data-label="Días" class="mono center">${esc(fmtDays(a.daysRemaining))}</td>
            <td data-label="Dónde aparece" class="url-cell" title="${esc(a.location)}">${esc(a.location)}</td>
            <td data-label="Páginas" class="mono center">${esc(a.pagesCount)}</td>
            <td class="right"><button class="btn btn-ghost btn-sm" onclick="viewAnalysis(${i}, this)" aria-label="Ver detalle de ${esc(a.veevaApprovalId)}">Detalle</button></td>
        </tr>`).join('');
    const more = $('btn-more');
    more.hidden = rows.length <= visible.length;
    more.textContent = `Mostrar más (${rows.length - visible.length} restantes)`;
}

// ---------- Detalle + revisión manual ----------
async function viewAnalysis(index, opener) {
    const scan = shownScan;
    const a = scan && scan.assets[index];
    if (!a) return;
    currentIndex = index;
    lastFocus = opener || document.activeElement;

    $('ana-veeva-id').textContent = a.veevaApprovalId;
    $('ana-type').textContent = a.type || '';
    $('ana-approved').textContent = fmtDate(a.approvedDate);
    $('ana-date').textContent = fmtDate(a.expirationDate);
    $('ana-days').textContent = fmtDays(a.daysRemaining);
    const note = $('ana-note');
    note.textContent = a.note || '';
    note.hidden = !a.note;
    const url = $('ana-url');
    url.textContent = a.location;
    url.href = /^https?:\/\//i.test(a.location) ? a.location : '#';
    $('ana-asset').textContent = a.assetUrl || '—';
    $('ana-snippet').textContent = a.snippet || '';
    const st = $('ana-status');
    st.textContent = a.status;
    st.className = `badge ${badgeClass(a.status)}`;

    const pages = a.pages || [];
    $('ana-pages-summary').textContent = `Todas las páginas donde aparece (${pages.length || a.pagesCount || 0})`;
    $('ana-pages').innerHTML = pages.map(p => `<li><code>${esc(p)}</code></li>`).join('');

    const c = $('ana-preview-container');
    c.textContent = '';
    if (a.screenshot) {
        const img = document.createElement('img');
        img.src = a.screenshot; img.alt = `Captura de evidencia de ${a.veevaApprovalId}`; img.loading = 'lazy';
        c.appendChild(img);
    } else c.textContent = 'Sin captura disponible';

    ['rev-corrected-id', 'rev-corrected-date', 'rev-notes'].forEach(id => { $(id).value = ''; });
    $('rev-msg').textContent = '';
    $('precision-box').textContent = '';

    const modal = $('analysis-modal');
    modal.hidden = false;
    modal.querySelector('.modal-box').focus?.();
    modal.querySelector('button').focus();

    try {
        const sid = a.fromScanId || scan.scanId;
        const { json } = await api(`/api/reviews/${encodeURIComponent(sid)}`);
        const prev = json.reviews && json.reviews[`${a.veevaApprovalId}|${a.location}`];
        if (prev) $('rev-msg').textContent = `Revisión previa: ${prev.verdict}`;
        loadPrecision(sid);
    } catch (e) { /* sin revisiones */ }
}

function closeAnalysisModal() {
    $('analysis-modal').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
}

function onGlobalKey(e) {
    const modal = $('analysis-modal');
    if (modal.hidden) return;
    if (e.key === 'Escape') { closeAnalysisModal(); return; }
    if (e.key === 'Tab') {
        const f = [...modal.querySelectorAll('button, input, a[href], summary, select, textarea')].filter(el => !el.disabled && el.offsetParent !== null);
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
}

async function submitReview(verdict) {
    const scan = shownScan;
    const a = scan && scan.assets[currentIndex];
    if (!a) return;
    try {
        const sid = a.fromScanId || scan.scanId;
        const { json } = await post(`/api/reviews/${encodeURIComponent(sid)}`, {
            assetKey: `${a.veevaApprovalId}|${a.location}`, verdict,
            correctedId: $('rev-corrected-id').value.trim(),
            correctedDate: $('rev-corrected-date').value,
            notes: $('rev-notes').value.trim()
        });
        $('rev-msg').textContent = json.success ? `Marcada como ${verdict}.` : 'No se pudo guardar.';
        loadPrecision(sid);
    } catch (e) { $('rev-msg').textContent = 'No se pudo contactar con el servidor.'; }
}

async function registerMissed() {
    const scan = shownScan;
    const id = $('missed-id').value.trim();
    if (!scan || !id) { toast('Escribe el Approval ID que no se detectó.', 'err'); return; }
    if (scan.aggregate) { toast('Abre el escaneo desde el Historial para registrar un ID no detectado.', 'err'); return; }
    try {
        await post(`/api/reviews/${encodeURIComponent(scan.scanId)}/missed`, { id, pageUrl: $('missed-url').value.trim() });
        $('missed-id').value = ''; $('missed-url').value = '';
        toast('ID no detectado registrado.', 'ok');
        loadPrecision(scan.scanId);
    } catch (e) { toast('No se pudo registrar.', 'err'); }
}

async function loadPrecision(scanId) {
    try {
        const { json: p } = await api(`/api/reviews/${encodeURIComponent(scanId)}/precision`);
        $('precision-box').textContent = `Revisadas: ${p.reviewed} | Correctas: ${p.correct} | Incorrectas: ${p.incorrect} | No detectadas: ${p.missed} | Precisión: ${p.precision ?? 'N/D'}% | Recall: ${p.recall ?? 'N/D'}%`;
    } catch (e) { /* opcional */ }
}

// ---------- Historial ----------
async function loadScanHistory() {
    const tbody = $('history-table-body');
    tbody.innerHTML = `<tr><td colspan="9"><div class="skeleton"></div></td></tr>`;
    try {
        const { json } = await api('/api/history');
        const history = json.history || [];
        $('history-meta').textContent = history.length
            ? `${history.length} escaneo(s) guardado(s) en este equipo · ${fmtBytes(json.storageBytes || 0)} de almacenamiento.`
            : 'Escaneos guardados en este equipo.';
        $('btn-clear-history').disabled = !history.length;
        if (!history.length) {
            tbody.innerHTML = `<tr><td colspan="9" class="empty-row">No hay registros en el historial todavía.</td></tr>`;
            return;
        }
        tbody.innerHTML = history.map(s => `
            <tr>
                <td data-label="Fecha" class="mono nowrap">${esc(new Date(s.date).toLocaleString())}</td>
                <td data-label="Sitio" class="url-cell" title="${esc(s.targetUrl)}">${esc(s.targetUrl)}${s.sections && s.sections.length ? `<br><small>Áreas: ${esc(s.sections.join(', '))}</small>` : ''}</td>
                <td data-label="Resultado"><span class="badge ${s.outcome === 'COMPLETO' ? 'badge-success' : 'badge-warning'}">${esc(s.outcome || '')}</span></td>
                <td data-label="Páginas" class="mono center">${esc(s.pagesScanned)}</td>
                <td data-label="Vencidos" class="mono center" style="color:var(--magenta);font-weight:700">${esc(s.vencidos)}</td>
                <td data-label="Por vencer" class="mono center" style="color:var(--graphite);font-weight:700">${esc(s.proximosAVencer)}</td>
                <td data-label="Vigentes" class="mono center" style="color:var(--navy);font-weight:700">${esc(s.vigentes)}</td>
                <td data-label="Por revisar" class="mono center">${esc(s.sinFechaFiable)}</td>
                <td class="right row-actions"><button class="btn btn-ghost btn-sm" data-scan="${esc(s.scanId)}" onclick="openHistoryScan(this.dataset.scan)">Abrir (${esc(s.totalAnalyzed)})</button>
                    <button class="btn btn-danger-ghost btn-sm" data-scan="${esc(s.scanId)}" onclick="deleteHistoryScan(this.dataset.scan)" aria-label="Borrar este escaneo">Borrar</button></td>
            </tr>`).join('');
    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-row">No se pudo cargar el historial. <button class="btn btn-ghost btn-sm" onclick="loadScanHistory()">Reintentar</button></td></tr>`;
    }
}

async function openHistoryScan(scanId) {
    try {
        const { res, json } = await api(`/api/history/${encodeURIComponent(scanId)}`);
        if (!res.ok || !json.scan) throw new Error('not found');
        historyScan = json.scan;
        await mountAndRender();
        $('results-block').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) { toast('No se pudo abrir el escaneo.', 'err'); }
}

function fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1048576).toFixed(1)} MB`;
}

async function afterHistoryDelete(removedId) {
    if (!removedId || (historyScan && historyScan.scanId === removedId)) historyScan = null;
    await loadScanHistory();
    await fetchResults();
    await mountAndRender();
}

async function deleteHistoryScan(scanId) {
    if (!confirm('¿Borrar este escaneo del historial? También se borran sus capturas de evidencia. No se puede deshacer.')) return;
    try {
        const { res, json } = await post(`/api/history/${encodeURIComponent(scanId)}/delete`, {});
        if (!res.ok || !json.success) { toast(json.error || 'No se pudo borrar el escaneo.', 'err'); return; }
        toast('Escaneo borrado.', 'ok');
        await afterHistoryDelete(scanId);
    } catch (e) { toast('No se pudo contactar con el servidor.', 'err'); }
}

async function clearHistory() {
    const meta = $('history-meta').textContent;
    if (!confirm(`¿Borrar TODO el historial?\n\n${meta}\n\nSe eliminan los escaneos guardados y sus capturas de evidencia; el Panel quedará en ceros. Las sesiones de AzMed y PromoMats no se tocan. No se puede deshacer.`)) return;
    try {
        const { res, json } = await post('/api/history/clear', {});
        if (!res.ok || !json.success) { toast(json.error || 'No se pudo borrar el historial.', 'err'); return; }
        toast(`Historial borrado (${json.removed} escaneo(s), ${fmtBytes(json.freedBytes || 0)} liberados).`, 'ok');
        await afterHistoryDelete(null);
    } catch (e) { toast('No se pudo contactar con el servidor.', 'err'); }
}

// ---------- Exportación ----------
// La generación del CSV (separador ';', BOM y neutralización de fórmulas) vive en js/csv.js
function exportCSV() {
    const scan = shownScan;
    if (!scan || !scan.assets.length) { toast('No hay datos para exportar.', 'err'); return; }
    const header = ['Estado', 'Región', 'País', 'Approval ID', 'Tipo', 'Aprobación', 'Vencimiento', 'Días restantes', 'URL página', 'URL activo', 'Páginas que lo muestran', 'Todas las páginas', 'Nota', 'Evidencia textual'];
    const rows = scan.assets.map(a => [
        a.status, a.region, a.country, a.veevaApprovalId, a.type, a.approvedDate || '', a.expirationDate || '',
        a.daysRemaining ?? '', a.location, a.assetUrl || '', a.pagesCount, (a.pages || []).join(' | '), a.note || '', a.snippet || ''
    ]);
    const csv = AZCsv.buildCsv(header, rows);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    link.download = `scan_${scan.scanId}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// Informe: imprime la propia página (la hoja @media print oculta controles) con todas las filas
function exportPDF() {
    if (!shownScan || !shownScan.assets.length) { toast('No hay datos para exportar.', 'err'); return; }
    const prev = view.limit;
    view.limit = Infinity;
    renderAssetsTable();
    const restore = () => { view.limit = prev; renderAssetsTable(); window.removeEventListener('afterprint', restore); };
    window.addEventListener('afterprint', restore);
    window.print();
}
