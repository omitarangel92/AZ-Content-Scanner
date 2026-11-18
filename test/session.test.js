// Persistencia de sesiones: cookies + localStorage + sessionStorage (antes sessionStorage se perdía y el portal pedía
// login en cada uso) y espera real a que el portal resuelva el acceso antes de declarar una sesión expirada.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-session-test-'));
process.env.DATA_DIR = dataDir;
const authManager = require('../server/authManager');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* sin playwright */ }

const html = (body) => `<html><body>${body}</body></html>`;
async function mock(context, routes) {
    await context.route('**/*', (route) => {
        const u = new URL(route.request().url());
        const body = routes[u.origin + u.pathname] || routes[u.origin] || html('');
        route.fulfill({ contentType: 'text/html; charset=utf-8', body });
    });
}

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

test('persistState guarda cookies, localStorage y sessionStorage y restoreSessionStorage los recupera', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const browser = await chromium.launch();
    try {
        const a = await browser.newContext();
        await mock(a, {});
        const pa = await a.newPage();
        await pa.goto('https://kmc.test/app');
        await pa.evaluate(() => { sessionStorage.setItem('ks', 'token-abc'); localStorage.setItem('pref', '1'); });
        await a.addCookies([{ name: 'sid', value: 'S1', url: 'https://kmc.test/' }]);

        assert.equal(await authManager.persistState('promomats', a), true);
        const saved = JSON.parse(fs.readFileSync(authManager.sessionPath('promomats'), 'utf8'));
        assert.deepEqual(saved.sessionStorage[0].items, [{ name: 'ks', value: 'token-abc' }]);
        assert.equal(saved.origins[0].localStorage[0].name, 'pref');
        assert.equal(saved.cookies.find(c => c.name === 'sid').value, 'S1');

        // Un navegador nuevo con la sesión guardada recupera TODO
        const b = await browser.newContext({ storageState: authManager.sessionPath('promomats') });
        await authManager.restoreSessionStorage(b, 'promomats');
        await mock(b, {});
        const pb = await b.newPage();
        await pb.goto('https://kmc.test/app');
        assert.equal(await pb.evaluate(() => sessionStorage.getItem('ks')), 'token-abc');
        assert.equal(await pb.evaluate(() => localStorage.getItem('pref')), '1');
        assert.equal((await b.cookies()).find(c => c.name === 'sid').value, 'S1');

        // Guardar desde un contexto sin ese origen abierto NO borra el almacenamiento previo
        const c = await browser.newContext({ storageState: authManager.sessionPath('promomats') });
        await c.newPage();
        await authManager.persistState('promomats', c);
        const merged = JSON.parse(fs.readFileSync(authManager.sessionPath('promomats'), 'utf8'));
        assert.equal(merged.sessionStorage[0].items[0].value, 'token-abc');
    } finally { await browser.close(); }
});

test('settleAccess: portal sin pantalla de login → activa; pantalla con contraseña → expirada', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const browser = await chromium.launch();
    try {
        const ctx = await browser.newContext();
        await mock(ctx, {
            'https://www.azmed.cr/es/home/my-account': html('<h1>Mi cuenta</h1>'),
            'https://identity.astrazeneca.com/login': html('<input type="password">')
        });
        const ok = await ctx.newPage();
        await ok.goto('https://www.azmed.cr/es/home/my-account.html');
        assert.equal(await authManager.settleAccess(ok, 'azmed', 15000), 'active');

        const bad = await ctx.newPage();
        await bad.goto('https://identity.astrazeneca.com/login');
        assert.equal(await authManager.settleAccess(bad, 'azmed', 15000), 'expired');
    } finally { await browser.close(); }
});

test('settleAccess: un portal que no termina de cargar NO se declara expirado (queda "unknown")', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const browser = await chromium.launch();
    try {
        const ctx = await browser.newContext();
        await mock(ctx, { 'https://login.veevavault.com/auth/login': html('') });   // en blanco: lento, no pide credenciales
        const p = await ctx.newPage();
        await p.goto('https://login.veevavault.com/auth/login');
        assert.equal(await authManager.settleAccess(p, 'promomats', 4000), 'unknown');
    } finally { await browser.close(); }
});
