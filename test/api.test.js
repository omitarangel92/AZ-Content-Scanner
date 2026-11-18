// Prueba de integración ligera: arranca el servidor real (sin abrir navegadores) con datos en una carpeta temporal.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 39000 + Math.floor(Math.random() * 900);
let server, dataDir, token;
let output = '';

// fetch no permite cambiar la cabecera Host; http.request sí
function request(method, url, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method, headers }, res => {
            let data = '';
            res.on('data', c => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) { /* no es JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, text: data, json });
            });
        });
        req.on('error', reject);
        if (body !== undefined) req.write(JSON.stringify(body));
        req.end();
    });
}
const post = (url, body, extra = {}) =>
    request('POST', url, { headers: { 'Content-Type': 'application/json', 'X-AZ-Token': token, ...extra }, body });

test.before(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'az-scanner-test-'));
    server = spawn(process.execPath, [path.join(__dirname, '../server/index.js')], {
        env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, ALLOWED_DOMAINS: 'azmed.cr' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    server.stdout.on('data', d => { output += d; });
    server.stderr.on('data', d => { output += d; });
    const start = Date.now();
    while (!/activo en/.test(output)) {
        if (Date.now() - start > 20000) throw new Error('El servidor no arrancó:\n' + output);
        await new Promise(r => setTimeout(r, 100));
    }
    token = (await request('GET', '/api/token')).json.token;
});

test.after(() => {
    if (server) server.kill();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('sirve la interfaz con assets versionados y cabeceras de seguridad', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(res.text, /<title>AZ Content Scanner<\/title>/);
    assert.match(res.text, /css\/styles\.css\?v=[a-z0-9]+/);
    assert.doesNotMatch(res.text, /\?v=\d+"/, 'el ?v= manual debe haberse sustituido por el hash');
    assert.match(res.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-powered-by'], undefined);
});

test('los datos se guardan en DATA_DIR, no en el proyecto', () => {
    assert.match(output, new RegExp(dataDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('Host de otro dominio (DNS rebinding) se rechaza', async () => {
    const res = await request('GET', '/api/config', { headers: { Host: 'evil.example.com' } });
    assert.equal(res.status, 421);
});

test('origen ajeno se rechaza', async () => {
    const res = await request('GET', '/api/config', { headers: { Origin: 'https://evil.com' } });
    assert.equal(res.status, 403);
});

test('POST sin token o con token falso se rechaza', async () => {
    const noToken = await request('POST', '/api/cancel-scan', { headers: { 'Content-Type': 'application/json' }, body: {} });
    assert.equal(noToken.status, 403);
    const bad = await request('POST', '/api/cancel-scan', { headers: { 'Content-Type': 'application/json', 'X-AZ-Token': 'falso' }, body: {} });
    assert.equal(bad.status, 403);
    const ok = await post('/api/cancel-scan', {});
    assert.equal(ok.status, 200);
});

test('reviews: scanId "__proto__" y assetKey peligrosos se rechazan (prototype pollution)', async () => {
    assert.equal((await post('/api/reviews/__proto__', { assetKey: 'CC-1|http://x', verdict: 'correcta' })).status, 400);
    assert.equal((await post('/api/reviews/..%2f..', { assetKey: 'CC-1|http://x', verdict: 'correcta' })).status, 400);
    assert.equal((await post('/api/reviews/abc123', { assetKey: '__proto__', verdict: 'correcta' })).status, 400);
    assert.equal((await post('/api/reviews/abc123', { assetKey: '__missed|x', verdict: 'correcta' })).status, 400);
    assert.equal((await post('/api/reviews/abc123', { assetKey: 'CC-1|http://x', verdict: 'otra' })).status, 400);
    const get = await request('GET', '/api/reviews/abc123');
    assert.deepEqual(get.json.reviews, {});
});

test('reviews: flujo válido guarda y calcula precisión', async () => {
    assert.equal((await post('/api/reviews/scan1', { assetKey: 'CC-14803|http://a', verdict: 'correcta' })).status, 200);
    assert.equal((await post('/api/reviews/scan1', { assetKey: 'CC-14804|http://b', verdict: 'incorrecta', notes: 'x'.repeat(5000) })).status, 200);
    assert.equal((await post('/api/reviews/scan1/missed', { id: 'CC-99999', pageUrl: 'http://c' })).status, 200);
    const reviews = (await request('GET', '/api/reviews/scan1')).json.reviews;
    assert.equal(reviews['CC-14804|http://b'].notes.length, 1000, 'las notas se recortan');
    const p = (await request('GET', '/api/reviews/scan1/precision')).json;
    assert.deepEqual([p.reviewed, p.correct, p.incorrect, p.missed], [2, 1, 1, 1]);
    assert.equal(p.precision, 50);
});

test('el escaneo exige las 2 sesiones (AzMed y PromoMats)', async () => {
    // DATA_DIR es una carpeta vacía: no hay ninguna sesión guardada
    const res = await post('/api/scan', { targetUrl: 'https://www.azmed.cr', region: 'CAMCAR', country: 'CR', sections: [] });
    assert.equal(res.status, 409);
    assert.equal(res.json.success, false);
    assert.equal(res.json.sessionExpired, true);
    assert.deepEqual(res.json.missing.sort(), ['azmed', 'promomats']);
    assert.match(res.json.error, /AzMed.*PromoMats|Faltan sesiones/);
});

test('detección de áreas: valida token, URL y dominio permitido', async () => {
    const noToken = await request('POST', '/api/scan/sections', { headers: { 'Content-Type': 'application/json' }, body: { targetUrl: 'https://www.azmed.cr' } });
    assert.equal(noToken.status, 403);
    assert.equal((await post('/api/scan/sections', { targetUrl: 'no es una url' })).status, 400);
    assert.equal((await post('/api/scan/sections', { targetUrl: 'https://www.otro-sitio.com' })).status, 400);
});

test('escaneo por áreas: rechaza áreas de otro dominio o con URL inválida', async () => {
    const base = { targetUrl: 'https://www.azmed.cr', region: 'CAMCAR', country: 'CR' };
    const otherSite = await post('/api/scan', { ...base, sections: [{ label: 'X', url: 'https://www.otro-sitio.com/es/x.html' }] });
    assert.equal(otherSite.status, 400);
    assert.match(otherSite.json.error, /Áreas inválidas/);
    const badUrl = await post('/api/scan', { ...base, sections: [{ label: 'Y', url: 'javascript:alert(1)' }] });
    assert.equal(badUrl.status, 400);
});

test('diagnósticos desactivados por defecto', async () => {
    assert.equal((await request('GET', '/api/vault/inspect/CC-14803')).status, 404);
    assert.equal((await request('GET', '/api/capture-test?url=https://www.azmed.cr')).status, 404);
});

test('rutas inexistentes devuelven JSON 404', async () => {
    const shot = await request('GET', '/shots/no-existe.jpg');
    assert.equal(shot.status, 404);
    assert.ok(shot.json && shot.json.error);
    const api = await request('GET', '/api/no-existe');
    assert.equal(api.status, 404);
});

test('JSON mal formado devuelve 400 sin detalles internos', async () => {
    const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/cancel-scan', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-AZ-Token': token } }, r => {
            let d = ''; r.on('data', c => { d += c; }); r.on('end', () => resolve({ status: r.statusCode, text: d }));
        });
        req.on('error', reject);
        req.end('{esto no es json');
    });
    assert.equal(res.status, 400);
    assert.doesNotMatch(res.text, /at .*node_modules/);
});
