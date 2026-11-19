'use strict';
// Regresión: el motor avisa «terminado» (100 %) varios segundos ANTES de guardar el resultado. La pantalla debe esperar
// al guardado y mostrar el resultado en «Nuevo escaneo» y en el Panel (antes salía todo vacío).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* sin playwright */ }

const mk = (i, st) => ({ id: i, veevaApprovalId: 'CC-' + (100 + i), type: 'Texto', status: st, approvedDate: null, expirationDate: null, daysRemaining: null, note: '', location: 'https://www.azmed.cr/x' + i, pages: ['https://www.azmed.cr/x' + i], pagesCount: 1, assetUrl: '', snippet: '', screenshot: null });
const scan = { scanId: 'zz1', targetUrl: 'https://www.azmed.cr', date: new Date().toISOString(), outcome: 'COMPLETO', assets: [mk(1, 'VIGENTE'), mk(2, 'VENCIDO'), mk(3, 'VIGENTE')], totalAnalyzed: 3, coverage: { pagesRead: 5 } };

test('al terminar, la pantalla espera a que el resultado esté guardado y lo muestra (Nuevo escaneo y Panel)', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'az-finish-'));
    const port = 39200 + Math.floor(Math.random() * 500);
    const srv = spawn(process.execPath, [path.join(__dirname, '../server/index.js')],
        { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; srv.stdout.on('data', d => { log += d; }); srv.stderr.on('data', d => { log += d; });
    let browser;
    try {
        const t0 = Date.now();
        while (!/activo en/.test(log)) { if (Date.now() - t0 > 20000) throw new Error('el servidor no arrancó\n' + log); await new Promise(r => setTimeout(r, 100)); }
        browser = await chromium.launch();
        const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const errs = []; p.on('pageerror', e => errs.push(e.message));
        let saved = false; setTimeout(() => { saved = true; }, 3500);   // guardado 3,5 s DESPUÉS del aviso «terminado»
        await p.route('**/api/scan/status', r => r.fulfill({ json: { busy: saved ? null : 'scanning', seconds: 9, progress: null } }));
        await p.route('**/api/scan-stream', r => r.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: ' + JSON.stringify({ status: 'Escaneo finalizado.', progress: 100, step: 4, done: true, pagesRead: 5, idsFound: 3 }) + '\n\n' }));
        await p.route('**/api/results', r => r.fulfill({ json: { lastScan: saved ? scan : null, currentScan: saved ? scan : null } }));
        await p.route('**/api/overview', r => r.fulfill({ json: saved ? { overview: { ...scan, aggregate: true, scansCount: 1 }, scans: 1 } : { overview: { assets: [], scansCount: 0, aggregate: true }, scans: 0 } }));
        await p.goto(`http://127.0.0.1:${port}/#/scan`); await p.waitForTimeout(600);
        await p.evaluate(() => attachProgress());
        await p.waitForTimeout(1500);
        assert.equal(await p.evaluate(() => !document.getElementById('progress-card').hidden), true, 'el progreso sigue visible mientras no se guarda');
        await p.waitForFunction(() => document.getElementById('progress-card').hidden, null, { timeout: 12000 });
        assert.equal(await p.evaluate(() => document.getElementById('metric-total').textContent), '3');
        assert.equal(await p.evaluate(() => !document.getElementById('results-block').hidden), true);
        await p.goto(`http://127.0.0.1:${port}/#/dashboard`); await p.waitForTimeout(1000);
        assert.equal(await p.evaluate(() => document.getElementById('metric-total').textContent), '3');
        assert.deepEqual(errs, []);
    } finally {
        if (browser) await browser.close();
        srv.kill();
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
});
