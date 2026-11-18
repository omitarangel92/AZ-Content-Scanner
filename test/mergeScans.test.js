const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSummaries, aggregateHistory } = require('../server/mergeScans');

const cov = (o = {}) => ({ pagesRead: 10, imagesOcr: 2, imagesByNameOnly: 1, wafBlocked: 0, partial: false, partialReasons: [], ocrAvailable: true, ocrNote: '', acceptedOverlays: [], failures: [], ...o });
const asset = (id, status, pages, extra = {}) => ({ veevaApprovalId: id, type: 'texto', status, approvedDate: null, expirationDate: null, daysRemaining: null, note: '', assetUrl: '', pages, pagesCount: pages.length, ...extra });
const summary = (assets, c) => ({ coverage: cov(c), assets, totalAnalyzed: assets.length, durationSeconds: 5 });

test('mergeSummaries: une áreas, deduplica IDs y suma la cobertura', () => {
    const m = mergeSummaries([
        { label: 'Oncología', summary: summary([asset('CC-10001', 'VIGENTE', ['http://a/1']), asset('CC-10002', 'VENCIDO', ['http://a/2'])]) },
        { label: 'CVRM', summary: summary([asset('CC-10001', 'VIGENTE', ['http://b/1'], { type: 'imagen' }), asset('SIN ID', 'SIN ID', ['http://b/2'], { assetUrl: 'v1' })], { pagesRead: 5 }) }
    ], { scanId: 'x1' });
    assert.equal(m.totalAnalyzed, 3);
    assert.equal(m.vencidos, 1);
    assert.equal(m.vigentes, 1);
    const shared = m.assets.find(a => a.veevaApprovalId === 'CC-10001');
    assert.deepEqual(shared.pages, ['http://a/1', 'http://b/1']);
    assert.equal(shared.type, 'texto + imagen');
    assert.deepEqual(shared.areas, ['Oncología', 'CVRM']);
    assert.equal(m.pagesScanned, 15);
    assert.equal(m.outcome, 'COMPLETO');
    assert.deepEqual(m.assets.map(a => a.id), [1, 2, 3]);
});

test('mergeSummaries: gana la fecha de PromoMats cuando un área no la obtuvo', () => {
    const m = mergeSummaries([
        { label: 'A', summary: summary([asset('CC-10001', 'SIN FECHA FIABLE', ['http://a'])]) },
        { label: 'B', summary: summary([asset('CC-10001', 'VENCIDO', ['http://b'], { expirationDate: '2020-01-01' })]) }
    ], { scanId: 'x2' });
    assert.equal(m.assets[0].status, 'VENCIDO');
    assert.equal(m.sinFechaFiable, 0);
});

test('mergeSummaries: un área fallida deja el informe PARCIAL con el motivo', () => {
    const m = mergeSummaries([
        { label: 'A', summary: summary([asset('CC-10001', 'VIGENTE', ['http://a'])]) },
        { label: 'B', summary: null, error: 'WAF', attempts: 2 }
    ], { scanId: 'x3' });
    assert.equal(m.outcome, 'PARCIAL');
    assert.match(m.coverage.partialReasons.join(' '), /«B»/);
    assert.deepEqual(m.coverage.areas.map(a => a.status), ['completo', 'error']);
    assert.equal(m.coverage.areas[1].attempts, 2);
});

test('mergeSummaries: «fuera de las áreas» une las listas y quita lo que otra área elegida sí cubre', () => {
    const sections = [{ label: 'Oncología', url: 'https://x.cr/es/home/oncologia.html' }, { label: 'CVRM', url: 'https://x.cr/es/home/cvrm.html' }];
    const m = mergeSummaries([
        { label: 'Oncología', summary: summary([asset('CC-10001', 'VIGENTE', ['http://a'])], { outOfScope: ['https://x.cr/es/home/cvrm/cardio.html', 'https://x.cr/es/home/Synagis.html'] }) },
        { label: 'CVRM', summary: summary([asset('CC-10002', 'VIGENTE', ['http://b'])], { outOfScope: ['https://x.cr/es/home/Synagis.html', 'https://x.cr/es/home/otra-pagina.html'] }) }
    ], { scanId: 'x4', sections });
    assert.deepEqual(m.coverage.outOfScope.sort(), ['https://x.cr/es/home/Synagis.html', 'https://x.cr/es/home/otra-pagina.html']);
});

test('mergeSummaries: los videos «NO VERIFICADO» se deduplican y cuentan como por revisar, no como «SIN ID»', () => {
    const unv = (url) => asset('SIN VERIFICAR', 'NO VERIFICADO', ['http://p'], { assetUrl: url });
    const m = mergeSummaries([
        { label: 'A', summary: summary([unv('kaltura:1_aaa')], { videosUnverified: 1, kalturaFailures: 1 }) },
        { label: 'B', summary: summary([unv('kaltura:1_aaa'), unv('kaltura:1_bbb')], { videosUnverified: 2, kalturaFailures: 2 }) }
    ], { scanId: 'x5' });
    assert.equal(m.assets.length, 2);
    assert.equal(m.sinFechaFiable, 2);
    assert.equal(m.coverage.videosUnverified, 3);
    assert.equal(m.coverage.kalturaFailures, 3);
});

test('aggregateHistory: acumulado de todos los escaneos, cada ID una vez y gana el más reciente', () => {
    const newer = { scanId: 'b2', ...summary([asset('CC-10001', 'VENCIDO', ['http://n/1'], { expirationDate: '2025-01-01' }), asset('CC-10003', 'VIGENTE', ['http://n/3'])]) };
    const older = { scanId: 'a1', ...summary([asset('CC-10001', 'VIGENTE', ['http://o/1']), asset('CC-10002', 'PROXIMO A VENCER', ['http://o/2'])]) };
    const m = aggregateHistory([newer, older]);   // del más reciente al más antiguo, como el historial
    assert.equal(m.aggregate, true);
    assert.equal(m.scansCount, 2);
    assert.equal(m.totalAnalyzed, 3);
    const by = Object.fromEntries(m.assets.map(a => [a.veevaApprovalId, a]));
    assert.equal(by['CC-10001'].status, 'VENCIDO');        // el escaneo reciente manda
    assert.equal(by['CC-10001'].fromScanId, 'b2');
    assert.equal(by['CC-10002'].fromScanId, 'a1');
    assert.equal(m.vencidos, 1);
    assert.equal(m.proximosAVencer, 1);
    assert.equal(m.vigentes, 1);
});

test('aggregateHistory: historial vacío → ceros', () => {
    const m = aggregateHistory([]);
    assert.equal(m.scansCount, 0);
    assert.equal(m.totalAnalyzed, 0);
    assert.deepEqual(m.assets, []);
});
