const test = require('node:test');
const assert = require('node:assert/strict');
const sec = require('../server/security');

// Ejecuta un middleware con req/res simulados y devuelve el código HTTP resultante (200 si llama a next)
function run(mw, req) {
    return new Promise(resolve => {
        const res = {
            statusCode: 200, headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            status(c) { this.statusCode = c; return this; },
            json() { resolve(this.statusCode); }
        };
        mw(req, res, () => resolve(200));
    });
}

test('hostGuard: solo localhost (bloquea DNS rebinding)', async () => {
    assert.equal(await run(sec.hostGuard, { headers: { host: 'localhost:3000' } }), 200);
    assert.equal(await run(sec.hostGuard, { headers: { host: '127.0.0.1:3000' } }), 200);
    assert.equal(await run(sec.hostGuard, { headers: { host: 'evil.example.com:3000' } }), 421);
});

test('originGuard: solo el mismo origen', async () => {
    const h = { host: 'localhost:3000' };
    assert.equal(await run(sec.originGuard, { headers: h }), 200);
    assert.equal(await run(sec.originGuard, { headers: { ...h, origin: 'http://localhost:3000' } }), 200);
    assert.equal(await run(sec.originGuard, { headers: { ...h, origin: 'http://localhost:4000' } }), 403);
    assert.equal(await run(sec.originGuard, { headers: { ...h, origin: 'https://evil.com' } }), 403);
    assert.equal(await run(sec.originGuard, { headers: { ...h, 'sec-fetch-site': 'cross-site' } }), 403);
    assert.equal(await run(sec.originGuard, { headers: { ...h, 'sec-fetch-site': 'same-origin' } }), 200);
});

test('tokenGuard: exige el token en métodos que modifican estado', async () => {
    assert.equal(await run(sec.tokenGuard, { method: 'POST', headers: {} }), 403);
    assert.equal(await run(sec.tokenGuard, { method: 'POST', headers: { 'x-az-token': 'x' } }), 403);
    assert.equal(await run(sec.tokenGuard, { method: 'POST', headers: { 'x-az-token': sec.TOKEN } }), 200);
    assert.equal(await run(sec.tokenGuard, { method: 'GET', headers: {} }), 200);
});

test('rateLimit: corta al superar el límite', async () => {
    const rl = sec.rateLimit('prueba', 3);
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push(await run(rl, { ip: '1' }));
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

test('securityHeaders: CSP sin scripts externos ni en línea', async () => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
    sec.securityHeaders({}, res, () => {});
    assert.match(res.headers['Content-Security-Policy'], /script-src 'self'/);
    // La directiva script-src NO permite unsafe-inline (script-src-attr sí, solo para los onclick="" de la interfaz)
    assert.doesNotMatch(res.headers['Content-Security-Policy'], /(^|;\s*)script-src\s[^;]*unsafe-inline/);
    assert.match(res.headers['Content-Security-Policy'], /script-src-attr 'unsafe-inline'/);
    assert.equal(res.headers['X-Frame-Options'], 'DENY');
});
