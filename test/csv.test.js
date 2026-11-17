const test = require('node:test');
const assert = require('node:assert/strict');
const { csvEscape, buildCsv } = require('../public/js/csv');

test('neutraliza celdas que Excel interpretaría como fórmula', () => {
    assert.equal(csvEscape('=HYPERLINK("http://x")'), '"\'=HYPERLINK(""http://x"")"');
    assert.equal(csvEscape('+1+1'), "'+1+1");
    assert.equal(csvEscape('-2'), "'-2");
    assert.equal(csvEscape('@SUM(A1)'), "'@SUM(A1)");
});

test('escapa separador, comillas y saltos de línea', () => {
    assert.equal(csvEscape('a;b'), '"a;b"');
    assert.equal(csvEscape('di "hola"'), '"di ""hola"""');
    assert.equal(csvEscape('línea1\nlínea2'), '"línea1\nlínea2"');
});

test('valores nulos y números', () => {
    assert.equal(csvEscape(null), '');
    assert.equal(csvEscape(undefined), '');
    assert.equal(csvEscape(0), '0');
});

test('buildCsv: BOM, separador ";" y CRLF', () => {
    const csv = buildCsv(['A', 'B'], [['1', 'x;y'], ['=2', '']]);
    assert.equal(csv, '﻿A;B\r\n1;"x;y"\r\n\'=2;');
});
