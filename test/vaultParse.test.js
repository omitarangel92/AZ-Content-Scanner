const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, toIso, daysRemaining, classify, lifecycleState, isRetired, isApproved } = require('../server/vaultParse');

const iso = (s, fmt) => toIso(parseDate(s, fmt));

test('parseDate: formatos ISO, dd/mm/yyyy y con mes escrito', () => {
    assert.equal(iso('2026-03-15'), '2026-03-15');
    assert.equal(iso('15/03/2026'), '2026-03-15');
    assert.equal(iso('8 Oct 2025'), '2025-10-08');
    assert.equal(iso('8 Oct 2025 12:00'), '2025-10-08');
});

test('parseDate: meses en portugués y español', () => {
    assert.equal(iso('10 fev 2026'), '2026-02-10');
    assert.equal(iso('3 mai 2026'), '2026-05-03');
    assert.equal(iso('7 out 2026'), '2026-10-07');
    assert.equal(iso('1 dez 2026'), '2026-12-01');
    assert.equal(iso('5 ene 2026'), '2026-01-05');
});

test('parseDate: orden día/mes ambiguo según formato configurado', () => {
    assert.equal(iso('03/04/2026', 'dmy'), '2026-04-03');
    assert.equal(iso('03/04/2026', 'mdy'), '2026-03-04');
});

test('parseDate: deduce el orden cuando un componente es > 12, sea cual sea el formato', () => {
    assert.equal(iso('25/03/2026', 'mdy'), '2026-03-25');
    assert.equal(iso('03/25/2026', 'dmy'), '2026-03-25');
});

test('parseDate: entradas inválidas', () => {
    assert.equal(parseDate(''), null);
    assert.equal(parseDate(null), null);
    assert.equal(parseDate('sin fecha'), null);
    assert.equal(parseDate('31/31/2026'), null);
    assert.equal(parseDate('8 Xyz 2025'), null);
});

const TODAY = new Date(Date.UTC(2026, 5, 1)); // 2026-06-01

test('daysRemaining y classify respetan el límite de aviso', () => {
    assert.equal(daysRemaining('2026-06-01', TODAY), 0);
    assert.equal(daysRemaining('2026-05-31', TODAY), -1);
    assert.equal(daysRemaining(null, TODAY), null);
    assert.equal(daysRemaining('no-fecha', TODAY), null);

    assert.equal(classify('2026-05-31', 60, TODAY), 'VENCIDO');
    assert.equal(classify('2026-06-01', 60, TODAY), 'PROXIMO A VENCER');   // vence hoy
    assert.equal(classify('2026-07-31', 60, TODAY), 'PROXIMO A VENCER');   // 60 días exactos
    assert.equal(classify('2026-08-01', 60, TODAY), 'VIGENTE');            // 61 días
    assert.equal(classify(null, 60, TODAY), 'SIN FECHA FIABLE');
});

test('lifecycleState: lee el valor junto a la etiqueta, no cualquier "status" de la ficha', () => {
    assert.equal(lifecycleState('Document Number\nCC-14803\nStatus\nRetired\nOther'), 'Retired');
    assert.equal(lifecycleState('Status: Approved for Distribution'), 'Approved for Distribution');
    assert.equal(lifecycleState('Estado del ciclo de vida\nObsoleto'), 'Obsoleto');
    // "status" dentro de una frase no es una etiqueta
    assert.equal(lifecycleState('Filter by status to see retired documents'), '');
    assert.equal(lifecycleState(''), '');
});

test('isRetired: solo valores de ciclo de vida retirados', () => {
    assert.equal(isRetired('Retired'), true);
    assert.equal(isRetired('retirado'), true);
    assert.equal(isRetired('Obsolete (v2)'), true);
    assert.equal(isRetired('Approved for Distribution'), false);
    assert.equal(isRetired('Not retired yet'), false);
    assert.equal(isRetired(''), false);
});

test('isApproved: estados «aprobado» (con variantes), no borradores ni retirados', () => {
    assert.equal(isApproved('Approved'), true);
    assert.equal(isApproved('Approved for Distribution'), true);
    assert.equal(isApproved('Aprobado'), true);
    assert.equal(isApproved('Draft'), false);
    assert.equal(isApproved('In Review'), false);
    assert.equal(isApproved('Retired'), false);
    assert.equal(isApproved(''), false);
});
