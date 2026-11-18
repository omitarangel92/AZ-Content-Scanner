// Búsqueda en PromoMats contra un portal simulado (sin red): distingue "sin resultados" de "no respondió" y de
// "sesión caducada". Antes un portal lento o con otro idioma marcaba TODO como "ID NO ENCONTRADO".
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.VAULT_HOST = 'astrazeneca-promomats.veevavault.com';
process.env.VAULT_SEARCH_TIMEOUT_SECONDS = '8';
process.env.VAULT_STEP_TIMEOUT_SECONDS = '3';
process.env.DATA_DIR = require('node:path').join(require('node:os').tmpdir(), 'az-vault-test');

const vaultClient = require('../server/vaultClient');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* sin playwright */ }

const APP = (mode) => `<html><body><input type="search" placeholder="Search"><div id="out"></div><script>
const MODE = ${JSON.stringify(mode)};
let LAST = '';
const inp = document.querySelector('input');
inp.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  LAST = inp.value.replace(/"/g, '');
  const out = document.getElementById('out');
  if (MODE === 'results') out.innerHTML = '<h3>Resultados: "' + LAST + '"</h3><div class="row"><a href="#doc_info/1/2/3">Documento (v1.0)</a> ' + LAST + '</div>';
  else if (MODE === 'none') out.innerHTML = '<p>No results for "' + LAST + '"</p>';
});
function show() {
  if (location.hash.indexOf('#doc_info') === 0) {
    document.body.innerHTML = '<div>Document Number</div><div>' + LAST + '</div><div>Key Dates</div><div>Expiration Date</div><div>15/03/2099</div>';
  }
}
window.addEventListener('hashchange', show);
</script></body></html>`;

async function withVault(mode, fn) {
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext();
        await context.route('**/*', (route) => {
            const u = new URL(route.request().url());
            if (mode === 'login' && u.hostname === process.env.VAULT_HOST) {
                // Redirección al login en el MISMO host (evita depender de la resolución DNS de otro dominio)
                if (u.pathname === '/auth/login') return route.fulfill({ contentType: 'text/html', body: '<html><body>Login</body></html>' });
                return route.fulfill({ status: 302, headers: { location: `https://${process.env.VAULT_HOST}/auth/login` }, body: '' });
            }
            if (u.hostname === 'login.veevavault.com') return route.fulfill({ contentType: 'text/html', body: '<html><body>Login</body></html>' });
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: APP(mode) });
        });
        const page = await context.newPage();
        return await fn(page);
    } finally { await browser.close(); }
}

test('resultados encontrados (encabezado en español): lee la fecha y clasifica', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const r = await withVault('results', (page) => vaultClient.lookupOne(page, 'CC-12345'));
    assert.equal(r.status, 'VIGENTE');
    assert.equal(r.expirationDate, '2099-03-15');
});

test('PromoMats dice "no results": ID NO ENCONTRADO', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const r = await withVault('none', (page) => vaultClient.lookupOne(page, 'CC-12345'));
    assert.equal(r.status, 'ID NO ENCONTRADO');
    assert.match(r.note, /no devolvió resultados/);
});

test('PromoMats no responde: NO se marca como "no encontrado" (sin fecha + motivo de tiempo agotado)', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const r = await withVault('hang', (page) => vaultClient.lookupOne(page, 'CC-12345'));
    assert.equal(r.status, 'SIN FECHA FIABLE');
    assert.match(r.note, /no respondió a la búsqueda/);
});

test('sesión caducada (redirige al login): se corta y las consultas siguientes no se intentan', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    vaultClient.sessionDead = false;
    const r = await withVault('login', (page) => vaultClient.lookupOne(page, 'CC-12345'));
    assert.equal(r.status, 'SIN FECHA FIABLE');
    assert.match(r.note, /caducó/);
    assert.equal(vaultClient.sessionDead, true);
});
