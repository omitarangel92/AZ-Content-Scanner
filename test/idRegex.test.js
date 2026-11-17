const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../server/config');

const ids = (s) => s.match(config.idRe()) || [];

test('detecta IDs en nombres de archivo con guion bajo (antes fallaba por \\b)', () => {
    assert.deepEqual(ids('banner_CC-14803.jpg'), ['CC-14803']);
    assert.deepEqual(ids('CC-14803_v2.png'), ['CC-14803']);
    assert.deepEqual(ids('/img/AR-1234-foo.png'), ['AR-1234']);
});

test('detecta IDs en texto normal y varios en una cadena', () => {
    assert.deepEqual(ids('Ref MX-12345.'), ['MX-12345']);
    assert.deepEqual(ids('CC-14803 y BR-0123'), ['CC-14803', 'BR-0123']);
    assert.deepEqual(ids('PRE-CC-1234'), ['CC-1234']);
});

test('descarta años de 4 dígitos que no son Approval IDs', () => {
    assert.deepEqual(ids('CO-2024'), []);
    assert.deepEqual(ids('PE-1999'), []);
    assert.deepEqual(ids('UY-2023 y CL-20240'), ['CL-20240']);
});

test('no coincide dentro de palabras ni con demasiados dígitos', () => {
    assert.deepEqual(ids('XCC-12345'), []);
    assert.deepEqual(ids('xMX-12345'), []);
    assert.deepEqual(ids('MX-1234567'), []);
    assert.deepEqual(ids('MX-123'), []);
});

test('idRe() devuelve una instancia nueva cada vez (las regex /g guardan estado)', () => {
    assert.notEqual(config.idRe(), config.idRe());
    const a = config.idRe();
    a.exec('CC-11111');
    assert.equal(config.idRe().lastIndex, 0);
});
