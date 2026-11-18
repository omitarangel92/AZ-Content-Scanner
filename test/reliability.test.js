// Fiabilidad: segunda pasada y caché de PromoMats, reintentos de Kaltura y sonda de sesión de AzMed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-reliab-test-'));
process.env.DATA_DIR = dataDir;
process.env.KALTURA_RETRIES = '2';
process.env.VAULT_HOST = 'astrazeneca-promomats.veevavault.com';

const vaultClient = require('../server/vaultClient');
const kalturaClient = require('../server/kalturaClient');
const authManager = require('../server/authManager');
const storage = require('../server/storage');

test.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

const ok = (expiration) => ({ status: 'VIGENTE', approvedDate: '2024-01-01', expirationDate: expiration, daysRemaining: 999, note: '' });
const transientFail = () => ({ status: 'SIN FECHA FIABLE', approvedDate: null, expirationDate: null, daysRemaining: null, note: 'tiempo agotado', transient: true });

function stubVault(fake) {
    vaultClient.available = true;
    vaultClient.sessionDead = false;
    vaultClient.pages = [{}];
    vaultClient.cache.clear();
    vaultClient.lookupOne = fake;
}

test('segunda pasada: un ID que falla por causa transitoria se recupera; la caché evita repetir la consulta', async () => {
    try { fs.unlinkSync(vaultClient.cacheFile); } catch (e) {}
    vaultClient.loadDiskCache();
    const calls = {};
    stubVault(async (page, id) => {
        calls[id] = (calls[id] || 0) + 1;
        if (id === 'CC-1' && calls[id] === 1) return transientFail();   // falla la primera vez
        return ok('2099-12-31');
    });

    const s1 = vaultClient.createStream(null, null);
    s1.push('CC-1'); s1.push('CC-2');
    const r1 = await s1.finish();
    assert.equal(r1.get('CC-1').status, 'VIGENTE', 'se recuperó en la segunda pasada');
    assert.equal(calls['CC-1'], 2);
    assert.equal(calls['CC-2'], 1);
    assert.ok(fs.existsSync(vaultClient.cacheFile), 'la caché se guardó en disco');

    // Segundo escaneo (nuevo cliente en memoria): no consulta PromoMats
    vaultClient.loadDiskCache();
    stubVault(async () => { throw new Error('no debería consultarse: está en caché'); });
    const s2 = vaultClient.createStream(null, null);
    s2.push('CC-1'); s2.push('CC-2');
    const r2 = await s2.finish();
    assert.equal(r2.get('CC-2').status, 'VIGENTE');
    assert.match(r2.get('CC-2').note, /caché/);
});

test('la caché reclasifica con la fecha de hoy (un vigente guardado puede estar ya vencido)', () => {
    vaultClient.diskCache = new Map([['CC-9', { at: Date.now(), r: { status: 'VIGENTE', approvedDate: '2020-01-01', expirationDate: '2020-06-01', daysRemaining: 10, note: '' } }]]);
    const r = vaultClient.fromDiskCache('CC-9');
    assert.equal(r.status, 'VENCIDO');
});

test('segunda pasada: si los primeros reintentos fallan también, no se insiste con todos los IDs', async () => {
    try { fs.unlinkSync(vaultClient.cacheFile); } catch (e) {}
    vaultClient.loadDiskCache();
    let calls = 0;
    stubVault(async () => { calls++; return transientFail(); });
    const s = vaultClient.createStream(null, null);
    for (let i = 1; i <= 20; i++) s.push(`CC-${100 + i}`);
    const r = await s.finish();
    assert.equal(r.size, 20);
    assert.ok(calls <= 20 + 6, `demasiados reintentos: ${calls}`);
});

test('Kaltura: reintenta ante fallos de red y reutiliza la sesión de widget', async () => {
    kalturaClient.ksCache = new Map();
    let widgetCalls = 0, entryCalls = 0, failuresLeft = 1;
    const request = {
        get: async (url) => {
            if (url.includes('startWidgetSession')) {
                widgetCalls++;
                if (failuresLeft-- > 0) throw new Error('Timeout 25000ms exceeded');   // primer intento falla
                return { json: async () => ({ ks: 'KS1' }) };
            }
            entryCalls++;
            return { json: async () => ({ name: `Video CC-12345`, tags: '', description: '' }) };
        }
    };
    const m1 = await kalturaClient.getEntryMetadata('https://cdnapisec.kaltura.com/p/432521/sp/43252100/embedIframeJs/uiconf_id/1/partner_id/432521?entry_id=1_abcd1234', request);
    assert.equal(m1.ok, true);
    assert.deepEqual(m1.ids, ['CC-12345']);
    assert.equal(widgetCalls, 2, 'un fallo + un reintento correcto');
    const m2 = await kalturaClient.getEntryMetadata('https://cdnapisec.kaltura.com/p/432521/sp/43252100/embedIframeJs/uiconf_id/1/partner_id/432521?entry_id=1_wxyz5678', request);
    assert.equal(m2.ok, true);
    assert.equal(widgetCalls, 2, 'la sesión de widget se reutiliza');
    assert.equal(entryCalls, 2);
});

test('Kaltura: si todos los reintentos fallan devuelve ok:false (no lanza)', async () => {
    kalturaClient.ksCache = new Map();
    const request = { get: async () => { throw new Error('Timeout'); } };
    const m = await kalturaClient.getEntryMetadata('https://x.kaltura.com/p/432521/entry_id/1_abcd1234', request);
    assert.equal(m.ok, false);
    assert.match(m.reason, /Timeout/);
});

test('sonda de AzMed: solo vale una página "Mi cuenta"; una página con permisos propios se ignora', () => {
    storage.saveMeta({ azmedProbe: { 'azmed.cr': 'https://www.azmed.cr/es/home/rare-disease/ultomiris.html' } });
    assert.equal(authManager.azmedProbeFor('https://www.azmed.cr'), 'https://www.azmed.cr', 'ignora la sonda aprendida mala');
    authManager.rememberProtectedUrl('azmed.cr', 'https://www.azmed.cr/es/home/rare-disease/ultomiris.html');
    assert.equal(authManager.azmedProbeFor('https://www.azmed.cr'), 'https://www.azmed.cr', 'no aprende páginas que no son de cuenta');
    authManager.rememberProtectedUrl('azmed.cr', 'https://www.azmed.cr/es/home/my-account.html');
    assert.equal(authManager.azmedProbeFor('https://www.azmed.cr'), 'https://www.azmed.cr/es/home/my-account.html');
});
