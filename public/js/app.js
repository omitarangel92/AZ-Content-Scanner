let CONFIG = null;
let currentScan = null;
let viewedScan = null;
let activeEventSource = null;
let analysisContext = { scan: null, index: 0 };
let sessionStates = {};
let starting = false;
let progressPoll = null;
let scanFinished = false;
let assetFilter = { status: '', q: '' };

const $ = (id) => document.getElementById(id);

function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function badgeClass(status) {
    return {
        'VENCIDO': 'badge-danger',
        'PROXIMO A VENCER': 'badge-warning',
        'VIGENTE': 'badge-success'
    }[status] || 'badge-info';
}

function shortStatus(status) {
    return {
        'SIN FECHA FIABLE': 'Sin fecha',
        'PROXIMO A VENCER': 'Próx. a vencer',
        'ID NO ENCONTRADO': 'No encontrado',
        'SIN ID': 'Sin ID'
    }[status] || (status.charAt(0) + status.slice(1).toLowerCase());
}

function fmtDate(d) { return d || 'N/D'; }
function fmtDays(d) { return d === null || d === undefined ? 'N/D' : d; }

// Cuenta desde la misma lista: tarjetas y detalle siempre coinciden
function breakdown(assets) {
    const b = { vencidos: 0, proximos: 0, vigentes: 0, sinFecha: 0, total: 0 };
    (assets || []).forEach(a => {
        if (a.status === 'VENCIDO') b.vencidos++;
        else if (a.status === 'PROXIMO A VENCER') b.proximos++;
        else if (a.status === 'VIGENTE') b.vigentes++;
        else b.sinFecha++;
        b.total++;
    });
    return b;
}

window.addEventListener('DOMContentLoaded', async () => {
    try {
        await loadConfig();
        await refreshSessions(false);
        await fetchResults();
        await loadScanHistory();
        const busyState = await checkBusy();
        // Si se recarga la pagina durante un escaneo, se recupera el progreso
        if (busyState && busyState.busy === 'scanning') attachProgress(busyState.progress);
        // Comprobacion real de sesiones al abrir la aplicacion y cada 10 minutos
        validateSessions(true);
        setInterval(() => validateSessions(true), 10 * 60 * 1000);
    } catch (e) {
        console.error('Error de inicialización:', e);
    }
});

// ---------- Config y selectores ----------
async function loadConfig() {
    const res = await fetch('/api/config');
    CONFIG = await res.json();
    $('region-select').innerHTML = Object.entries(CONFIG.regions)
        .map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    onRegionChange();
}

function onRegionChange() {
    const region = $('region-select').value;
    const { countries, blocked = {} } = CONFIG.regions[region];
    // Paises cuyo dominio no esta en ALLOWED_DOMAINS: visibles pero deshabilitados
    $('country-select').innerHTML = Object.keys(countries).map(c =>
        `<option value="${c}" ${blocked[c] ? 'disabled' : ''}>${c}${blocked[c] ? ' (dominio no autorizado en .env)' : ''}</option>`).join('');
    const firstOk = Object.keys(countries).find(c => !blocked[c]);
    if (firstOk) $('country-select').value = firstOk;
    onCountryChange();
}

function onCountryChange() {
    const region = $('region-select').value;
    const country = $('country-select').value;
    $('target-url').value = CONFIG.regions[region].countries[country] || '';
}

// ---------- Estado del servidor (ocupado / libre) ----------
async function checkBusy() {
    try {
        const res = await fetch('/api/scan/status');
        const s = await res.json();
        const box = $('busy-box');
        if (!box) return s;
        if (s.busy) {
            const scanning = s.busy === 'scanning';
            const txt = scanning ? 'Hay un escaneo en curso en el servidor' : 'El servidor está comprobando sesiones';
            box.style.display = 'flex';
            box.innerHTML = `<span>${esc(txt)} (${s.seconds}s).</span>
                ${scanning ? '<button class="mat-btn mat-btn-secondary mat-btn-sm" onclick="attachProgress()">Ver progreso</button>' : ''}
                <button class="mat-btn mat-btn-secondary mat-btn-sm" onclick="resetBusy()">${scanning ? 'Cancelar escaneo' : 'Liberar servidor'}</button>`;
        } else {
            box.style.display = 'none';
            box.innerHTML = '';
        }
        return s;
    } catch (e) { return { busy: null }; }
}

async function resetBusy() {
    try {
        const res = await fetch('/api/scan/reset', { method: 'POST' });
        const json = await res.json();
        $('scan-status-text').innerText = json.message || 'Servidor liberado.';
    } catch (e) {
        $('scan-status-text').innerText = 'No se pudo contactar con el servidor.';
    }
    checkBusy();
}

// ---------- Sesiones ----------
const SERVICE_LABEL = { azmed: 'AzMed', promomats: 'PromoMats', kaltura: 'Kaltura' };

function stateView(st) {
    switch (st && st.state) {
        case 'active': return { cls: 'badge-success', text: 'Sesión activa' };
        case 'expired': return { cls: 'badge-danger', text: 'Sesión expirada' };
        case 'error': return { cls: 'badge-warning', text: 'No se pudo validar' };
        case 'unknown': return { cls: 'badge-info', text: 'Guardada (sin validar)' };
        default: return { cls: 'badge-warning', text: 'Sin sesión' };
    }
}

function renderSessionStates(states) {
    sessionStates = states || {};
    const expired = [];

    ['azmed', 'promomats', 'kaltura'].forEach(svc => {
        const st = sessionStates[svc] || { state: 'none' };
        const v = stateView(st);

        const badge = $(`sess-${svc}`);
        if (badge) { badge.className = `mat-badge ${v.cls}`; badge.innerText = v.text; }

        const detail = $(`sess-detail-${svc}`);
        if (detail) {
            const when = st.checkedAt ? ` · comprobada ${new Date(st.checkedAt).toLocaleTimeString()}` : '';
            detail.innerText = (st.detail || '') + when;
        }

        const chip = $(`chip-${svc}`);
        if (chip) {
            chip.className = `sess-chip chip-${st.state || 'none'}`;
            chip.title = `${SERVICE_LABEL[svc]}: ${v.text}`;
        }

        if (st.state === 'expired') expired.push(SERVICE_LABEL[svc]);
    });

    const alertBox = $('session-alert');
    if (alertBox) {
        if (expired.length) {
            alertBox.style.display = 'flex';
            alertBox.innerHTML = `<span><b>Sesión expirada:</b> ${esc(expired.join(', '))}. Pulsa "Iniciar sesión" y guarda la sesión de nuevo antes de escanear.</span>
                <button class="mat-btn mat-btn-sm" onclick="openSessionModal()">Iniciar sesión</button>`;
        } else {
            alertBox.style.display = 'none';
            alertBox.innerHTML = '';
        }
    }
}

async function validateSessions(silent) {
    const btn = $('btn-validate');
    const msg = $('validate-msg');
    if (!silent && btn) btn.disabled = true;
    if (!silent && msg) msg.innerText = 'Comprobando (puede tardar unos segundos)...';
    try {
        const res = await fetch('/api/session/validate', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetUrl: $('target-url') ? $('target-url').value : undefined })
        });
        const json = await res.json();
        if (json.states) renderSessionStates(json.states);
        if (!silent && msg) msg.innerText = res.ok ? 'Comprobación terminada.' : (json.error || 'No se pudo comprobar.');
    } catch (e) {
        if (!silent && msg) msg.innerText = 'No se pudo contactar con el servidor.';
    } finally {
        if (!silent && btn) btn.disabled = false;
    }
}

async function refreshSessions(real) {
    if (real) return validateSessions(false);
    const res = await fetch('/api/session/status');
    renderSessionStates(await res.json());
}

function openSessionModal() { $('session-modal').style.display = 'flex'; refreshSessions(false); }
function closeSessionModal() { $('session-modal').style.display = 'none'; }

// Mensaje visible arriba del modal (antes quedaba al final, fuera de la vista)
function sessionMsg(text, ok) {
    const el = $('session-msg');
    el.innerText = text;
    el.className = `session-msg ${ok ? 'ok' : 'err'}`;
    el.style.display = text ? 'block' : 'none';
}

async function startSession(service) {
    sessionMsg(`Abriendo navegador para ${SERVICE_LABEL[service]}...`, true);
    try {
        const res = await fetch('/api/session/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ service, url: $('target-url').value })
        });
        const json = await res.json();
        sessionMsg(json.success ? `${SERVICE_LABEL[service]}: ${json.message}` : (json.error || 'No se pudo abrir el navegador.'), json.success);
    } catch (e) {
        sessionMsg('No se pudo contactar con el servidor. ¿Está corriendo "npm start"?', false);
    }
}

async function finishSession(service) {
    try {
        const res = await fetch('/api/session/finish', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service })
        });
        const json = await res.json();
        sessionMsg(json.success ? `${SERVICE_LABEL[service]}: ${json.message || 'Sesión guardada correctamente.'}`
            : `${SERVICE_LABEL[service]}: ${json.error || 'Error al guardar la sesión.'}`, json.success);
    } catch (e) {
        sessionMsg('No se pudo contactar con el servidor. ¿Está corriendo "npm start"?', false);
    }
    refreshSessions(false);
}

async function clearSession(service) {
    const res = await fetch('/api/session/clear', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ service })
    });
    const json = await res.json();
    if (json.states) renderSessionStates(json.states);
}

// ---------- Escaneo ----------
async function startScan() {
    if (starting) return;
    starting = true;
    const btn = $('btn-start-scan');
    if (btn) btn.disabled = true;

    const region = $('region-select').value;
    const country = $('country-select').value;
    const targetUrl = $('target-url').value.trim();

    $('scan-status-text').innerText = 'Comprobando sesiones guardadas...';

    try {
        // 1) Pedir al servidor que valide sesiones y arranque. Si lo rechaza, se muestra el motivo.
        const res = await fetch('/api/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                targetUrl, region, country,
                extraUrls: ($('extra-urls') ? $('extra-urls').value : '').split(/\s+/).map(s => s.trim()).filter(Boolean)
            })
        });
        const json = await res.json().catch(() => ({}));

        if (!res.ok || !json.success) {
            if (json.states) renderSessionStates(json.states);
            const msg = json.error || `El servidor rechazó el escaneo (HTTP ${res.status}).`;
            $('scan-status-text').innerText = msg;
            await checkBusy();
            if (json.sessionExpired) openSessionModal();
            return;
        }

        if (json.states) renderSessionStates(json.states);

        // 2) Escaneo aceptado: conectar al flujo de progreso
        attachProgress();
        if (json.warning) $('modal-status-detail').innerText = json.warning;
    } catch (e) {
        $('scan-status-text').innerText = 'Error de conexión con el servidor.';
    } finally {
        starting = false;
        if (btn) btn.disabled = false;
    }
}

// Conecta (o reconecta) el modal de progreso al escaneo en curso.
// Si la conexion SSE se corta, el navegador reintenta solo; ademas se consulta el estado cada 5 s
// para no quedarse esperando si el escaneo termino mientras no habia conexion.
function attachProgress(initial) {
    scanFinished = false;
    $('progress-modal').style.display = 'flex';
    resetProgress();
    if (initial) updateProgressUI(initial);

    if (activeEventSource) activeEventSource.close();
    activeEventSource = new EventSource('/api/scan-stream');

    activeEventSource.onmessage = (ev) => {
        let d;
        try { d = JSON.parse(ev.data); } catch (e) { return; }
        if (d.idle) return; // no hay escaneo en curso: lo resolvera el sondeo de estado
        updateProgressUI(d);
        if (d.progress === 100 && (d.done || d.error)) finishProgress(d);
    };

    activeEventSource.onerror = () => {
        if (scanFinished) return;
        $('modal-status-detail').innerText = 'Conexión interrumpida, reconectando... (el escaneo sigue en el servidor)';
    };

    clearInterval(progressPoll);
    progressPoll = setInterval(async () => {
        try {
            const res = await fetch('/api/scan/status');
            const s = await res.json();
            if (s.busy !== 'scanning' && !scanFinished) finishProgress(null);
        } catch (e) {
            $('modal-status-detail').innerText = 'No hay respuesta del servidor. Si se cerró, reinícialo con "npm start".';
        }
    }, 5000);
}

function finishProgress(d) {
    if (scanFinished) return;
    scanFinished = true;
    clearInterval(progressPoll);
    if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
    setTimeout(async () => {
        $('progress-modal').style.display = 'none';
        await fetchResults();
        await loadScanHistory();
        await checkBusy();
        await refreshSessions(false);
        if (d && d.error) $('scan-status-text').innerText = d.status;
        else if (!d) $('scan-status-text').innerText = 'El escaneo terminó. Resultados actualizados.';
    }, 1200);
}

async function cancelCurrentScan() {
    try {
        await fetch('/api/cancel-scan', { method: 'POST' });
        $('modal-status-detail').innerText = 'Cancelando... se conservará lo detectado hasta ahora.';
    } catch (e) {
        $('modal-status-detail').innerText = 'No se pudo contactar al servidor.';
    }
}

function resetProgress() {
    for (let i = 1; i <= 4; i++) {
        const item = $(`step-${i}`);
        item.className = 'step-item pending';
        item.querySelector('.step-icon').innerText = i;
    }
    $('modal-progress-bar').style.width = '0%';
    $('prog-elapsed').innerText = '0s';
    $('prog-pages').innerText = '0';
    $('prog-ids').innerText = '0';
    $('modal-status-detail').innerText = 'Iniciando...';
}

function updateProgressUI(d) {
    if (typeof d.progress === 'number') {
        $('modal-progress-bar').style.width = `${d.progress}%`;
        $('progress-bar').style.width = `${d.progress}%`;
    }
    if (d.status) {
        $('modal-status-detail').innerText = d.status;
        $('scan-status-text').innerText = d.status;
    }
    if (d.elapsed !== undefined) $('prog-elapsed').innerText = `${d.elapsed}s`;
    if (d.pagesRead !== undefined) $('prog-pages').innerText = d.pagesRead;
    if (d.idsFound !== undefined) $('prog-ids').innerText = d.idsFound;

    if (d.step) {
        for (let i = 1; i < d.step; i++) {
            const done = $(`step-${i}`);
            done.className = 'step-item completed';
            done.querySelector('.step-icon').innerText = '✓';
        }
        const active = $(`step-${d.step}`);
        if (active) {
            if (d.done || d.error) {
                active.className = 'step-item ' + (d.error ? 'pending' : 'completed');
                active.querySelector('.step-icon').innerText = d.error ? '✕' : '✓';
            } else {
                active.className = 'step-item active';
            }
        }
    }
}

// ---------- Resultados ----------
async function fetchResults() {
    const res = await fetch('/api/results');
    const data = await res.json();
    if (data.lastScan) renderScan(data.lastScan);
}

function renderScan(scan) {
    currentScan = scan;
    const b = breakdown(scan.assets);
    $('metric-vencido').innerText = b.vencidos;
    $('metric-prox').innerText = b.proximos;
    $('metric-vigente').innerText = b.vigentes;
    $('metric-sinfecha').innerText = b.sinFecha;
    $('metric-total').innerText = b.total;

    renderCoverage(scan, 'coverage-box');
    renderAssetsTable(scan.assets, 'results-table-body', false, assetFilter);
    $('assets-count').innerText = `(${b.total} registros)`;
}

function renderCoverage(scan, targetId) {
    const c = scan.coverage;
    if (!c) { $(targetId).innerHTML = ''; return; }
    const reasons = (c.partialReasons || []).map(r => `<li>${esc(r)}</li>`).join('');
    const login = (c.loginPages || []).slice(0, 30).map(u => `<li><code>${esc(u)}</code></li>`).join('');
    const stale = (c.sitemapStaleList || []).slice(0, 50).map(u => `<li><code>${esc(u)}</code></li>`).join('');
    const fails = (c.failures || []).slice(0, 30)
        .map(f => `<li><code>${esc(f.url)}</code> — ${esc(f.reason)}</li>`).join('');
    const broken = (c.brokenLinkList || []).slice(0, 50)
        .map(u => `<li><code>${esc(u)}</code></li>`).join('');
    $(targetId).innerHTML = `
        <div class="coverage-head">
            <strong>Cobertura del escaneo</strong>
            <span class="mat-badge ${scan.outcome === 'COMPLETO' ? 'badge-success' : 'badge-warning'}">${esc(scan.outcome)}</span>
        </div>
        <div class="coverage-grid">
            <div><b>${c.pagesRead}</b><small>Páginas leídas</small></div>
            <div><b>${c.pagesFailed}</b><small>Con error</small></div>
            <div><b>${c.brokenLinks || 0}</b><small>Enlaces rotos (404)</small></div>
            <div><b>${c.pagesNeedingLogin}</b><small>Exigen sesión</small></div>
            <div><b>${c.imagesOcr}</b><small>Imágenes con OCR</small></div>
            <div><b>${c.imagesByNameOnly}</b><small>Imágenes por nombre</small></div>
            <div><b>${c.pdfsFull}</b><small>PDF completos</small></div>
            <div><b>${c.pdfsByNameOnly}</b><small>PDF por nombre</small></div>
            <div><b>${c.videosChecked}</b><small>Videos revisados</small></div>
            ${c.sitemapUrls !== undefined ? `
            <div><b>${c.sitemapUrls}</b><small>URLs en sitemaps</small></div>
            <div><b>${c.sitemapStale || 0}</b><small>Sitemap obsoletas (404)</small></div>
            <div><b>${c.duplicatesSkipped || 0}</b><small>Duplicadas omitidas</small></div>
            <div><b>${c.hiddenTextIds || 0}</b><small>IDs en contenido oculto</small></div>
            <div><b>${c.wafBlocked || 0}</b><small>Bloqueadas por WAF</small></div>` : ''}
        </div>
        ${reasons ? `<p class="coverage-warn">Limitaciones:</p><ul>${reasons}</ul>` : ''}
        ${fails ? `<details><summary>Páginas con error (${c.pagesFailed})</summary><ul>${fails}</ul></details>` : ''}
        ${broken ? `<details><summary>Enlaces rotos del sitio (${c.brokenLinks})</summary><ul>${broken}</ul></details>` : ''}
        ${login ? `<details><summary>Páginas que pidieron inicio de sesión (${c.pagesNeedingLogin})</summary><ul>${login}</ul></details>` : ''}
        ${stale ? `<details><summary>URLs del sitemap que ya no existen (${c.sitemapStale})</summary><ul>${stale}</ul></details>` : ''}`;
}

function matchesFilter(a, f) {
    if (!f) return true;
    if (f.status === 'SIN FECHA') {
        if (['VENCIDO', 'PROXIMO A VENCER', 'VIGENTE'].includes(a.status)) return false;
    } else if (f.status && a.status !== f.status) return false;
    if (f.q) {
        const hay = `${a.veevaApprovalId} ${a.location} ${a.type} ${a.assetUrl || ''} ${(a.pages || []).join(' ')}`.toLowerCase();
        if (!hay.includes(f.q.toLowerCase())) return false;
    }
    return true;
}

function onAssetFilter() {
    assetFilter = { status: $('filter-status').value, q: $('filter-q').value.trim() };
    if (currentScan) renderAssetsTable(currentScan.assets, 'results-table-body', false, assetFilter);
}

function renderAssetsTable(assets, tbodyId, fromHistory, filter) {
    const tbody = $(tbodyId);
    if (!assets || assets.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-row">El escaneo no encontró Approval IDs.</td></tr>`;
        return;
    }
    // Se conserva el indice original para que "Detalle" abra el activo correcto
    const rows = assets.map((a, i) => ({ a, i })).filter(({ a }) => matchesFilter(a, filter));
    if (!rows.length) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-row">Ningún activo coincide con el filtro.</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(({ a, i }) => `
        <tr>
            <td><span class="mat-badge ${badgeClass(a.status)} badge-sm" title="${esc(a.status)}">${esc(shortStatus(a.status))}</span></td>
            <td class="mono magenta nowrap">${esc(a.veevaApprovalId)}</td>
            <td class="nowrap">${esc(a.country)}</td>
            <td class="mono nowrap">${fmtDate(a.approvedDate)}</td>
            <td class="mono nowrap">${fmtDate(a.expirationDate)}</td>
            <td class="mono center">${fmtDays(a.daysRemaining)}</td>
            <td class="url-cell" title="${esc(a.location)}">${esc(a.location)}</td>
            <td class="mono center">${a.pagesCount}</td>
            <td class="right"><button onclick="viewAnalysis(${i}, ${fromHistory})" class="mat-btn mat-btn-secondary mat-btn-sm">Detalle</button></td>
        </tr>`).join('');
}

function toggleAssets() {
    const body = $('assets-body');
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    $('assets-toggle').innerText = open ? 'Mostrar ▾' : 'Ocultar ▴';
}

// ---------- Detalle + revisión manual ----------
async function viewAnalysis(index, fromHistory) {
    const scan = fromHistory ? viewedScan : currentScan;
    const a = scan.assets[index];
    if (!a) return;
    analysisContext = { scan, index };

    $('ana-veeva-id').innerText = a.veevaApprovalId;
    $('ana-type').innerText = a.type;
    $('ana-approved').innerText = fmtDate(a.approvedDate);
    $('ana-date').innerText = fmtDate(a.expirationDate);
    $('ana-days').innerText = fmtDays(a.daysRemaining);
    $('ana-note').innerText = a.note || '';
    $('ana-url').innerText = a.location;
    $('ana-url').href = a.location;
    $('ana-asset').innerText = a.assetUrl || '—';
    const st = $('ana-status');
    st.innerText = a.status;
    st.className = 'mat-badge ' + badgeClass(a.status);

    $('ana-pages').innerHTML = (a.pages || []).map(p => `<li><code>${esc(p)}</code></li>`).join('');
    $('ana-snippet').innerText = a.snippet || '';

    const c = $('ana-preview-container');
    c.innerHTML = '';
    if (a.screenshot) {
        const img = document.createElement('img');
        img.src = a.screenshot; img.className = 'asset-preview-img'; img.alt = 'Evidencia';
        c.appendChild(img);
    } else {
        c.innerText = 'Sin captura disponible';
    }

    $('rev-corrected-id').value = '';
    $('rev-corrected-date').value = '';
    $('rev-notes').value = '';
    $('rev-msg').innerText = '';

    try {
        const res = await fetch(`/api/reviews/${scan.scanId}`);
        const json = await res.json();
        const prev = json.reviews[`${a.veevaApprovalId}|${a.location}`];
        if (prev) $('rev-msg').innerText = `Revisión previa: ${prev.verdict}`;
    } catch (e) {}

    $('analysis-modal').style.display = 'flex';
}

async function submitReview(verdict) {
    const { scan, index } = analysisContext;
    const a = scan.assets[index];
    const body = {
        assetKey: `${a.veevaApprovalId}|${a.location}`,
        verdict,
        correctedId: $('rev-corrected-id').value.trim(),
        correctedDate: $('rev-corrected-date').value,
        notes: $('rev-notes').value.trim()
    };
    const res = await fetch(`/api/reviews/${scan.scanId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const json = await res.json();
    $('rev-msg').innerText = json.success ? `Marcada como ${verdict}.` : 'No se pudo guardar.';
    loadPrecision(scan.scanId);
}

async function registerMissed() {
    const scan = analysisContext.scan || currentScan;
    if (!scan) return alert('No hay escaneo seleccionado.');
    const id = prompt('Approval ID que el escáner no detectó (ej. CC-14803):');
    if (!id) return;
    const pageUrl = prompt('URL de la página donde aparece:') || '';
    await fetch(`/api/reviews/${scan.scanId}/missed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: id.trim(), pageUrl })
    });
    alert('Registrado.');
    loadPrecision(scan.scanId);
}

async function loadPrecision(scanId) {
    const res = await fetch(`/api/reviews/${scanId}/precision`);
    const p = await res.json();
    const el = $('precision-box');
    if (el) {
        el.innerText = `Revisadas: ${p.reviewed} | Correctas: ${p.correct} | Incorrectas: ${p.incorrect} | No detectadas: ${p.missed} | Precisión: ${p.precision ?? 'N/D'}% | Recall: ${p.recall ?? 'N/D'}%`;
    }
}

function closeAnalysisModal() { $('analysis-modal').style.display = 'none'; }

// ---------- Historial ----------
async function loadScanHistory() {
    const res = await fetch('/api/history');
    const { history } = await res.json();
    const tbody = $('history-table-body');
    if (!history.length) {
        tbody.innerHTML = `<tr><td colspan="10" class="empty-row">No hay registros en el historial todavía.</td></tr>`;
        return;
    }
    tbody.innerHTML = history.map(s => `
        <tr>
            <td class="mono nowrap" style="font-size:0.74rem;">${esc(new Date(s.date).toLocaleString())}</td>
            <td class="url-cell" title="${esc(s.targetUrl)}">${esc(s.targetUrl)}</td>
            <td><span class="mat-badge badge-sm ${s.outcome === 'COMPLETO' ? 'badge-success' : 'badge-warning'}">${esc(s.outcome || '')}</span></td>
            <td class="mono center">${s.pagesScanned}</td>
            <td class="mono center">${s.imagesAnalyzed}</td>
            <td class="mono center" style="color:var(--status-vencido);font-weight:700;">${s.vencidos}</td>
            <td class="mono center" style="color:var(--status-warning);font-weight:700;">${s.proximosAVencer}</td>
            <td class="mono center" style="color:var(--status-vigente);font-weight:700;">${s.vigentes}</td>
            <td class="mono center">${s.sinFechaFiable}</td>
            <td class="right"><button onclick="openHistoryScan('${s.scanId}')" class="mat-btn mat-btn-secondary mat-btn-sm">Abrir (${s.totalAnalyzed})</button></td>
        </tr>`).join('');
}

async function openHistoryScan(scanId) {
    const res = await fetch(`/api/history/${scanId}`);
    const { scan } = await res.json();
    viewedScan = scan;
    $('history-modal-title').innerText = `Escaneo: ${scan.targetUrl} (${new Date(scan.date).toLocaleString()})`;
    renderCoverage(scan, 'history-coverage');
    renderAssetsTable(scan.assets, 'history-detail-tbody', true);
    loadPrecision(scanId);
    $('history-modal').style.display = 'flex';
}

function closeHistoryModal() { $('history-modal').style.display = 'none'; }

// ---------- Exportación ----------
function csvEscape(v) {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCSV(source) {
    const scan = source === 'history' ? viewedScan : currentScan;
    if (!scan) return alert('No hay datos para exportar.');
    const header = ['Estado', 'Región', 'País', 'Approval ID', 'Tipo', 'Aprobación', 'Vencimiento', 'Días restantes', 'URL página', 'URL activo', 'Páginas que lo muestran', 'Todas las páginas', 'Nota', 'Evidencia textual'];
    const rows = scan.assets.map(a => [
        a.status, a.region, a.country, a.veevaApprovalId, a.type, a.approvedDate || '', a.expirationDate || '',
        a.daysRemaining ?? '', a.location, a.assetUrl || '', a.pagesCount, (a.pages || []).join(' | '), a.note || '', a.snippet || ''
    ]);
    const csv = '\uFEFF' + [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `scan_${scan.scanId}.csv`;
    link.click();
}

function exportPDF(source) {
    const scan = source === 'history' ? viewedScan : currentScan;
    if (!scan) return alert('No hay datos para exportar.');
    const b = breakdown(scan.assets);
    const rows = scan.assets.map(a => `
        <tr><td>${esc(a.status)}</td><td>${esc(a.veevaApprovalId)}</td><td>${esc(a.country)}</td>
        <td>${esc(a.approvedDate || 'N/D')}</td><td>${esc(a.expirationDate || 'N/D')}</td><td>${esc(a.daysRemaining ?? 'N/D')}</td>
        <td style="word-break:break-all">${esc(a.location)}</td><td>${a.pagesCount}</td></tr>`).join('');
    const c = scan.coverage || {};
    const w = window.open('', '_blank');
    w.document.write(`<html><head><title>Informe ${esc(scan.targetUrl)}</title>
        <style>body{font-family:Arial;font-size:11px;padding:20px}h1{color:#830051;font-size:18px}
        table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:4px;text-align:left}th{background:#f3e5ee}
        .kpi{display:inline-block;margin-right:18px}</style></head><body>
        <h1>AstraZeneca | Informe de Compliance Web</h1>
        <p><b>Sitio:</b> ${esc(scan.targetUrl)} | <b>Fecha:</b> ${esc(new Date(scan.date).toLocaleString())} | <b>Resultado:</b> ${esc(scan.outcome)}</p>
        <p><span class="kpi"><b>Vencidos:</b> ${b.vencidos}</span><span class="kpi"><b>Próximos:</b> ${b.proximos}</span>
        <span class="kpi"><b>Vigentes:</b> ${b.vigentes}</span><span class="kpi"><b>Sin fecha fiable:</b> ${b.sinFecha}</span>
        <span class="kpi"><b>Total:</b> ${b.total}</span></p>
        <p><b>Cobertura:</b> ${c.pagesRead} páginas leídas, ${c.pagesFailed} con error, ${c.brokenLinks || 0} enlaces rotos, ${c.pagesNeedingLogin} exigen sesión;
        ${c.imagesOcr} imágenes con OCR, ${c.imagesByNameOnly} solo por nombre; ${c.pdfsFull} PDF completos, ${c.pdfsByNameOnly} solo por nombre.</p>
        ${(c.partialReasons || []).length ? `<p><b>Limitaciones:</b> ${c.partialReasons.map(esc).join(' · ')}</p>` : ''}
        <table><thead><tr><th>Estado</th><th>Approval ID</th><th>País</th><th>Aprobación</th><th>Vencimiento</th><th>Días</th><th>URL</th><th>Páginas</th></tr></thead>
        <tbody>${rows}</tbody></table></body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
}