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
        // Modal de detalle
        await page.goto(base + '#/dashboard'); await page.waitForTimeout(700);
        await page.click('#results-table-body tr:first-child button'); await page.waitForTimeout(400);
        const modal = await page.evaluate(() => { const b = document.querySelector('.modal-box').getBoundingClientRect(); return { inViewport: b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1, w: Math.round(b.width), h: Math.round(b.height) }; });
        report.push({ name, view: 'modal', modal });
        if (SHOT.has(name) && w < 900) await page.screenshot({ path: path.join(out, `${name.replace(/[^a-z0-9]+/gi, '_')}_modal.png`) });
        await ctx.close();
    }
    const bad = report.filter(r => r.docOverflow || (r.offscreen && r.offscreen.length) || (r.smallTargets && r.smallTargets.length) || (r.modal && !r.modal.inViewport));
    console.log(JSON.stringify({ revisados: report.length, conProblemas: bad.length, jsErrors, problemas: bad }, null, 1));
    console.log('LAYOUTS:', [...new Set(report.filter(r => r.layout).map(r => `${r.name} => ${r.layout}`))].join(' | '));
    await browser.close(); srv.kill(); fs.rmSync(dataRoot, { recursive: true, force: true });
    console.log('Capturas en:', out);
    process.exit(bad.length || jsErrors.length ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
