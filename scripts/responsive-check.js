// Prueba responsive: abre la interfaz (con datos de ejemplo en una carpeta temporal) en 14 tamaños de pantalla —móviles, tablets, portátiles,
// FullHD, 2K y 4K— y en las 4 vistas, y falla (código 1) si hay desbordes horizontales, elementos fuera de pantalla,
// objetivos táctiles menores de 44 px o errores de JavaScript.
// Uso: npm run check:responsive [carpeta-de-capturas]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
const root = path.join(__dirname, '..');
const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'az-responsive-'));
fs.mkdirSync(out, { recursive: true });
const { chromium } = require(path.join(root, 'node_modules/playwright'));

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'az-matrix-'));
fs.mkdirSync(path.join(dataRoot, 'data'), { recursive: true });
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
const mk = (i, status, days, type, pages) => ({
    id: i, veevaApprovalId: `CC-${14800 + i}`, type, region: 'CAMCAR', country: 'CR', status,
    approvedDate: '2025-01-10', expirationDate: days === null ? null : iso(days), daysRemaining: days, note: '',
    location: `https://www.azmed.cr/es/productos/una-ruta-bastante-larga-para-probar-el-ajuste-de-texto/producto-${i}`,
    assetUrl: '', pagesCount: pages, pages: [`https://www.azmed.cr/es/productos/producto-${i}`], snippet: `Material CC-${14800 + i}`, screenshot: null
});
const assets = []; let n = 1;
[-40, -12, -3].forEach(d => assets.push(mk(n++, 'VENCIDO', d, 'Texto', 3)));
[5, 18, 33, 47, 58].forEach(d => assets.push(mk(n++, 'PROXIMO A VENCER', d, 'Imagen', 2)));
[75, 90, 120, 150, 200, 240, 300, 330, 400, 500, 520, 600].forEach(d => assets.push(mk(n++, 'VIGENTE', d, 'PDF', 1)));
assets.push(mk(n++, 'RETIRADO', -100, 'Video', 1));
assets.push(mk(n++, 'SIN FECHA FIABLE', null, 'Texto', 1));
const scan = { scanId: 'demo1', targetUrl: 'https://www.azmed.cr', region: 'CAMCAR', country: 'CR', date: new Date().toISOString(),
    totalAnalyzed: assets.length, vencidos: 3, proximosAVencer: 5, vigentes: 12, retirados: 1, sinFechaFiable: 1, pagesScanned: 214,
    imagesAnalyzed: 340, durationSeconds: 1500, outcome: 'PARCIAL', assets,
    coverage: { pagesRead: 214, pagesFailed: 3, brokenLinks: 2, pagesNeedingLogin: 0, imagesOcr: 120, imagesByNameOnly: 220, pdfsFull: 14, pdfsByNameOnly: 1, videosChecked: 6, partialReasons: ['3 páginas no se pudieron leer'] } };
// Datos extremos: textos largos sin espacios, muchas áreas, motivos largos y listas con URLs enormes (lo que suele desbordar)
const LONG = 'https://www.azmed.cr/es/home/' + 'segmento-muy-largo-sin-espacios-'.repeat(8) + 'fin.html';
assets.push({ ...mk(n++, 'VIGENTE', 400, 'Imagen + Video + PDF', 40), location: LONG, assetUrl: LONG, snippet: 'x'.repeat(260), note: 'Nota larga '.repeat(40) + 'y'.repeat(120), pages: Array.from({ length: 30 }, (_, i) => LONG + i) });
assets.push({ ...mk(n++, 'NO VERIFICADO', null, 'Video', 1), veevaApprovalId: 'SIN VERIFICAR', note: 'No se pudieron leer los metadatos del video en Kaltura (apiRequestContext.get: Timeout 25000ms exceeded.' + ' detalle'.repeat(30) + ')' });
scan.assets = assets; scan.totalAnalyzed = assets.length;
scan.sections = ['ONCOLOGÍA', 'CVRM', 'PSP (Programa para Pacientes) con un nombre larguísimo para probar el ajuste'];
scan.coverage = { ...scan.coverage,
    scope: { mode: 'areas', sections: scan.sections },
    areas: scan.sections.map((label, i) => ({ label, status: i === 2 ? 'error' : 'completo', attempts: 2, pagesRead: 120 + i, idsFound: 30 + i, error: i === 2 ? 'Error: ' + 'timeout '.repeat(30) : null })),
    partialReasons: ['PromoMats no devolvió fecha para 17 de 17 Approval IDs. Motivos: 15 × No se encontró el cuadro de búsqueda de PromoMats (el portal tardó en cargar o cambió su diseño); 2 × PromoMats no respondió a la búsqueda en 25 s (red lenta o portal ocupado). Pantalla: «' + 'x'.repeat(140) + '».', 'Kaltura: no se pudieron leer los metadatos de 9 video(s) (tiempo agotado o servicio no disponible); 9 quedan como «No verificado». Reintenta o sube KALTURA_TIMEOUT_SECONDS en .env.', 'Se alcanzó el límite de 800 páginas (MAX_PAGES); quedaron 120 URLs sin visitar.'],
    outOfScope: Array.from({ length: 40 }, (_, i) => i % 3 === 0 ? LONG + i : 'https://www.azmed.cr/es/home/pagina-fuera-de-area-' + i + '.html'),
    failures: Array.from({ length: 8 }, (_, i) => ({ url: LONG + i, reason: 'Bloqueado por el WAF del sitio (403 CloudFront) ' + 'detalle '.repeat(12) })),
    brokenLinkList: Array.from({ length: 12 }, (_, i) => LONG + 'b' + i), loginPages: [LONG, LONG + 'l'], sitemapStaleList: [LONG],
    videosUnverified: 3, kalturaFailures: 3, sitemapDiscarded: 120, sitemapUrls: 378, sitemapStale: 339, wafBlocked: 8, duplicatesSkipped: 4, hiddenTextIds: 9 };
fs.writeFileSync(path.join(dataRoot, 'data', 'history.json'), JSON.stringify([scan, { ...scan, scanId: 'demo2', date: new Date(Date.now() - 864e5).toISOString() }]));

const PORT = 38200 + Math.floor(Math.random() * 300);
const srv = spawn(process.execPath, [path.join(root, 'server/index.js')], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });

const DEVICES = [
    ['móvil 320x568', 320, 568, true], ['móvil 360x740', 360, 740, true], ['móvil 390x844', 390, 844, true], ['móvil 430x932', 430, 932, true],
    ['móvil horizontal 844x390', 844, 390, true], ['tablet vertical 768x1024', 768, 1024, true], ['tablet horizontal 1024x768', 1024, 768, true],
    ['tablet pro horizontal 1180x820', 1180, 820, true], ['portátil 1280x720', 1280, 720, false], ['portátil 1366x768', 1366, 768, false],
    ['escritorio 1440x900', 1440, 900, false], ['FullHD 1920x1080', 1920, 1080, false], ['2K 2560x1440', 2560, 1440, false], ['4K 3840x2160', 3840, 2160, false]
];
const VIEWS = ['dashboard', 'scan', 'history', 'accounts'];
const MOCK_SECTIONS = { success: true, site: 'https://www.azmed.cr', sitemapTotal: 640, source: 'header nav', sections: [
    { id: 's1', label: 'HOME', url: 'https://www.azmed.cr/es/home.html', exact: true, home: true, estimatedPages: 1, children: [] },
    { id: 's2', label: 'AZEVENTOS', url: 'https://www.azmed.cr/es/home/azeventos.html', exact: false, estimatedPages: 48, children: [] },
    { id: 's3', label: 'ONCOLOGÍA', url: 'https://www.azmed.cr/es/home/oncologia.html', exact: false, estimatedPages: 120,
      children: [{ id: 's3.1', label: 'Cáncer de mama', url: 'https://www.azmed.cr/es/home/oncologia/mama.html', estimatedPages: 30 }, { id: 's3.2', label: 'Cáncer de pulmón', url: 'https://www.azmed.cr/es/home/oncologia/pulmon.html', estimatedPages: 22 }] },
    { id: 's4', label: 'CVRM', url: 'https://www.azmed.cr/es/home/cvrm.html', exact: false, estimatedPages: 96, children: [] },
    { id: 's5', label: 'INMUNOLOGÍA', url: 'https://www.azmed.cr/es/home/inmunologia.html', exact: false, estimatedPages: 64, children: [] },
    { id: 's6', label: 'RARAS', url: 'https://www.azmed.cr/es/home/raras.html', exact: false, estimatedPages: 40, children: [] },
    { id: 's7', label: 'IPP', url: 'https://www.azmed.cr/es/home/ipp.html', exact: false, estimatedPages: 12, children: [] },
    { id: 's8', label: 'PSP (Programa de pacientes)', url: null, exact: false, estimatedPages: 25,
      children: [{ id: 's8.1', label: 'Programa A', url: 'https://www.azmed.cr/es/psp/a.html', estimatedPages: 10 }, { id: 's8.2', label: 'Programa B', url: 'https://www.azmed.cr/es/psp/b.html', estimatedPages: 15 }] }
] };
const SHOT = new Set(['móvil 360x740', 'tablet vertical 768x1024', 'tablet horizontal 1024x768', 'FullHD 1920x1080', '4K 3840x2160', 'móvil horizontal 844x390']);

async function audit(page, touch) {
    return page.evaluate((touch) => {
        const vw = document.documentElement.clientWidth;
        const res = { docOverflow: document.documentElement.scrollWidth > vw + 1, offscreen: [], smallTargets: [] };
        const scrollable = (el) => { for (let p = el; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
        for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]') || el.closest('svg') ) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            if (cs.position === 'absolute' && r.width <= 1) continue; // sr-only
            if ((r.right > vw + 1 || r.left < -1) && !scrollable(el) && cs.position !== 'fixed') {
                res.offscreen.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : ''} (${Math.round(r.left)}..${Math.round(r.right)} de ${vw})`);
            }
            if (touch && /^(BUTTON|A|INPUT|SELECT|SUMMARY)$/.test(el.tagName) && !el.closest('.modal') ) {
                const hit = (el.type === 'checkbox' && el.closest('label')) ? el.closest('label').getBoundingClientRect() : r;
                if (el.tagName === 'A' && !el.closest('.sb-nav, .tb-actions, .dot-row')) continue;
                if (hit.height < 43.5 || hit.width < 43.5) res.smallTargets.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 20)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
            }
        }
        // Contenido que se sale de SU tarjeta (aunque siga dentro de la pantalla) y texto recortado sin puntos suspensivos
        const CONT = '.card, .kpi, .modal-box, .sess, .gate-row, .coverage-grid > div, .detail-grid > div, .live-stats div, .sec-row, .banner, .disclaimer, .score, .insight, .full-toggle, .notice, details';
        res.clipped = [];
        for (const el of document.querySelectorAll('body *')) {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || el.closest('[hidden]') || el.closest('svg') || cs.position === 'fixed') continue;
            if (cs.position === 'absolute' && el.getBoundingClientRect().width <= 1) continue;
            const r = el.getBoundingClientRect();
            if (r.width === 0 || r.height === 0) continue;
            // Fuera por la izquierda de un contenedor con scroll: ni siquiera se puede llegar desplazando
            for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
                const o = getComputedStyle(p).overflowX;
                if (o === 'hidden' || o === 'clip') break;   // recorte intencionado (p. ej. la barra de carga animada)
                if (o === 'auto' || o === 'scroll') {
                    if (r.left < p.getBoundingClientRect().left - 1.5) res.clipped.push(`${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''} queda fuera por la izquierda de ${p.className ? '.' + String(p.className).split(' ')[0] : p.tagName.toLowerCase()} (inalcanzable)`);
                    break;
                }
            }
            const holder = el.parentElement && el.parentElement.closest(CONT);
            const name = () => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.split(' ')[0] : ''}`;
            if (holder && !scrollable(el)) {
                const hr = holder.getBoundingClientRect();
                if (r.right > hr.right + 1.5 || r.left < hr.left - 1.5) res.clipped.push(`${name()} sale de ${holder.className ? '.' + String(holder.className).split(' ')[0] : holder.tagName.toLowerCase()} (+${Math.round(Math.max(r.right - hr.right, hr.left - r.left))}px)`);
            }
            // Scroll horizontal interno no deseado (listas de URLs, textos): solo se admite en tablas y en la barra de iconos
            if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 2 && !el.matches('.table-wrap, .sb-nav, .stepper, .modal, .main, .view, html, body') && !el.closest('.table-wrap')) {
                res.clipped.push(`${name()} tiene scroll horizontal interno (${el.scrollWidth}>${el.clientWidth})`);
            }
            // Texto que desborda su PROPIA caja (cadenas largas sin espacios, URLs): la tarjeta o la pantalla lo recorta
            if (cs.overflowX === 'visible' && cs.display !== 'inline' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 2 && !scrollable(el) && !el.closest('svg')) {
                res.clipped.push(`${name()}${el.dataset && el.dataset.label ? '[' + el.dataset.label + ']' : ''} el texto desborda su caja (${el.scrollWidth}>${el.clientWidth}) «${(el.textContent || '').trim().slice(0, 40)}»`);
            }
            // Solo cuenta si un HIJO real (texto/elementos) queda recortado; los resplandores decorativos (::before/::after) no
            const childOverflow = (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && Array.from(el.children).some(ch => {
                const c = getComputedStyle(ch);
                if (c.display === 'none' || c.position === 'absolute') return false;
                const cr = ch.getBoundingClientRect();
                return cr.width > 0 && (cr.right > r.right + 1.5 || cr.left < r.left - 1.5);
            });
            if (childOverflow && cs.textOverflow !== 'ellipsis' && el.clientWidth > 0 && !/^(HTML|BODY)$/.test(el.tagName) && !el.matches('.main, .view')) {
                res.clipped.push(`${name()} recorta contenido sin puntos suspensivos (${el.scrollWidth}>${el.clientWidth})`);
            }
        }
        res.clipped = [...new Set(res.clipped)].slice(0, 8);
        res.offscreen = [...new Set(res.offscreen)].slice(0, 6);
        res.smallTargets = [...new Set(res.smallTargets)].slice(0, 6);
        return res;
    }, touch);
}

(async () => {
    const start = Date.now();
    while (!/activo en/.test(log)) { if (Date.now() - start > 20000) throw new Error('server\n' + log); await new Promise(r => setTimeout(r, 100)); }
    const browser = await chromium.launch();
    const report = []; const jsErrors = [];
    for (const [name, w, h, touch] of DEVICES) {
        const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch && w < 900 });
        const page = await ctx.newPage();
        page.on('pageerror', e => jsErrors.push(`${name}: ${e.message}`));
        const base = `http://127.0.0.1:${PORT}/`;
        for (const v of VIEWS) {
            await page.goto(base + '#/' + v); await page.waitForTimeout(v === 'dashboard' ? 900 : 500);
            if (v === 'scan') {
                // Simula la detección de áreas (sin red) y marca dos, para auditar también la lista de áreas ya desplegada
                await page.route('**/api/scan/sections', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(MOCK_SECTIONS) }));
                await page.click('#btn-detect'); await page.waitForSelector('#sections-list .sec-row');
                await page.check('#sections-list input[data-id="s3"]'); await page.check('#sections-list input[data-id="s4"]');
                await page.waitForTimeout(200);
                if (SHOT.has(name)) await page.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_escaneo.png`), fullPage: w < 1000 });
            }
            const a = await audit(page, touch);
            const layout = await page.evaluate(() => { const sb = document.querySelector('.sidebar'); const r = sb.getBoundingClientRect(); return r.width < 120 && r.height > 300 ? 'rail' : (r.width > 200 && r.height > 300 ? 'lateral' : 'barra superior'); });
            report.push({ name, view: v, layout, ...a });
            if (v === 'dashboard' && (name === 'móvil 360x740' || name === 'tablet horizontal 1024x768')) {
                await page.evaluate(() => document.getElementById('results').scrollIntoView());
                await page.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_tabla.png`) });
                await page.evaluate(() => window.scrollTo(0, 0));
            }
            if (SHOT.has(name) && (v === 'dashboard' || (v === 'history' && w < 700))) await page.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_${v}.png`), fullPage: v === 'dashboard' && w < 1000 });
        }
        // Panel con TODOS los desplegables de cobertura abiertos (listas largas de URLs, motivos, áreas)
        await page.goto(base + '#/dashboard'); await page.waitForTimeout(800);
        await page.evaluate(() => document.querySelectorAll('#coverage-box details').forEach(d => { d.open = true; }));
        await page.waitForTimeout(200);
        report.push({ name, view: 'cobertura abierta', layout: null, ...(await audit(page, touch)) });
        if (SHOT.has(name) && w < 900) await page.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_cobertura.png`), fullPage: true });

        // Ventana de conexión de cuentas
        await page.goto(base + '#/scan'); await page.waitForTimeout(500);
        await page.evaluate(() => { openSessionGate(); document.getElementById('gate-debug') && 0; });
        await page.waitForTimeout(500);
        report.push({ name, view: 'ventana de cuentas', layout: null, ...(await audit(page, touch)),
            modal: await page.evaluate(() => { const b = document.querySelector('#session-modal .modal-box').getBoundingClientRect(); return { inViewport: b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1, h: Math.round(b.height) }; }) });
        if (SHOT.has(name) && w < 900) await page.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_cuentas.png`) });
        await page.evaluate(() => closeSessionGate(true));

        // Escaneo en curso (progreso + indicadores en vivo), simulado sin red
        const live = await ctx.newPage();
        live.on('pageerror', e => jsErrors.push(`${name} (en curso): ${e.message}`));
        await live.route('**/api/scan/status', r => r.fulfill({ json: { busy: 'scanning', seconds: 40, progress: null } }));
        await live.route('**/api/scan-stream', r => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' },
            body: 'data: ' + JSON.stringify({ status: '[2/3 · ' + 'ONCOLOGÍA '.repeat(6) + '] Analizando (120/800): ' + LONG, progress: 41, step: 3, pagesRead: 1234, idsFound: 4321, elapsed: 3725,
                live: { vencidos: 123, proximos: 45, vigentes: 678, retirados: 9, sinFecha: 210, total: 1065 } }) + '\n\n' }));
        await live.goto(base + '#/dashboard'); await live.waitForTimeout(1500);
        report.push({ name, view: 'escaneo en curso', layout: null, ...(await audit(live, touch)) });
        if (SHOT.has(name) && w < 900) await live.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_encurso.png`), fullPage: true });
        await live.close();

        // Modal de detalle
        await page.goto(base + '#/dashboard'); await page.waitForTimeout(700);
        await page.click('#results-table-body tr:first-child button'); await page.waitForTimeout(400);
        const modal = await page.evaluate(() => { const b = document.querySelector('.modal-box').getBoundingClientRect(); return { inViewport: b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1, w: Math.round(b.width), h: Math.round(b.height) }; });
        report.push({ name, view: 'modal', modal });
        if (SHOT.has(name) && w < 900) await page.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_modal.png`) });
        await ctx.close();
    }
    const bad = report.filter(r => r.docOverflow || (r.clipped && r.clipped.length) || (r.offscreen && r.offscreen.length) || (r.smallTargets && r.smallTargets.length) || (r.modal && !r.modal.inViewport));
    console.log(JSON.stringify({ revisados: report.length, conProblemas: bad.length, jsErrors, problemas: bad }, null, 1));
    console.log('LAYOUTS:', [...new Set(report.filter(r => r.layout).map(r => `${r.name} => ${r.layout}`))].join(' | '));
    await browser.close(); srv.kill(); fs.rmSync(dataRoot, { recursive: true, force: true });
    console.log('Capturas en:', out);
    process.exit(bad.length || jsErrors.length ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
