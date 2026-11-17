const test = require('node:test');
const assert = require('node:assert/strict');
const { normPath, isHomeLike, inSections, buildSections, extractHeaderNav } = require('../server/sections');

const S = (url, exact = false) => ({ url, exact });
const U = (p) => `https://www.azmed.cr${p}`;

test('normPath: quita extensión, barra final, query y prefijo AEM', () => {
    assert.equal(normPath(U('/es/oncologia.html')), '/es/oncologia');
    assert.equal(normPath(U('/es/oncologia/')), '/es/oncologia');
    assert.equal(normPath(U('/es/oncologia.html?utm_source=x#a')), '/es/oncologia');
    assert.equal(normPath(U('/content/azmed/es/oncologia.html')), '/es/oncologia');
    assert.equal(normPath(U('/')), '/');
    assert.equal(normPath('no es url'), null);
});

test('inSections: coincidencia por segmento completo', () => {
    const onco = [S(U('/es/oncologia.html'))];
    assert.equal(inSections(U('/es/oncologia.html'), onco), true);
    assert.equal(inSections(U('/es/oncologia/mama.html'), onco), true);
    assert.equal(inSections(U('/es/oncologia-articulos.html'), onco), false);
    assert.equal(inSections(U('/es/cvrm.html'), onco), false);
    assert.equal(inSections(U('/es/oncologia'), onco), true);
});

test('inSections: la ruta AEM duplicada cuenta como la misma página', () => {
    const onco = [S(U('/es/oncologia.html'))];
    assert.equal(inSections(U('/content/azmed/es/oncologia/mama.html'), onco), true);
});

test('inSections: una sección "exact" (HOME) es solo esa página', () => {
    const home = [S(U('/es/home.html'), true)];
    assert.equal(inSections(U('/es/home.html'), home), true);
    assert.equal(inSections(U('/es/home/oncologia.html'), home), false);
});

test('inSections: varias secciones se suman', () => {
    const two = [S(U('/es/oncologia.html')), S(U('/es/cvrm.html'))];
    assert.equal(inSections(U('/es/cvrm/x.html'), two), true);
    assert.equal(inSections(U('/es/raras.html'), two), false);
});

test('isHomeLike: por etiqueta, raíz o ruta del sitio', () => {
    assert.equal(isHomeLike({ label: 'HOME', url: U('/es/inicio.html') }), true);
    assert.equal(isHomeLike({ label: 'Inicio', url: U('/es/x.html') }), true);
    assert.equal(isHomeLike({ label: 'X', url: U('/') }), true);
    assert.equal(isHomeLike({ label: 'X', url: U('/es/home.html') }, U('/es/home.html')), true);
    assert.equal(isHomeLike({ label: 'ONCOLOGÍA', url: U('/es/oncologia.html') }, U('/es/home.html')), false);
});

test('buildSections: ids, HOME exacto, contenedor ancestro exacto y estimaciones', () => {
    const items = [
        { label: 'HOME', url: U('/es/home.html'), children: [] },
        { label: 'ONCOLOGÍA', url: U('/es/home/oncologia.html'), children: [{ label: 'Mama', url: U('/es/home/oncologia/mama.html') }] },
        { label: 'CVRM', url: U('/es/home/cvrm.html'), children: [] },
        { label: 'PSP', url: null, children: [{ label: 'Programa A', url: U('/es/psp/a.html') }, { label: 'Programa B', url: U('/es/psp/b.html') }] }
    ];
    const sitemap = [U('/es/home.html'), U('/es/home/oncologia.html'), U('/es/home/oncologia/mama.html'), U('/es/home/oncologia/pulmon.html'),
        U('/es/home/cvrm.html'), U('/es/psp/a.html'), U('/es/psp/b.html'), U('/es/psp/b/detalle.html')];
    const t = buildSections(items, U('/es/home.html'), sitemap);

    assert.deepEqual(t.map(s => s.id), ['s1', 's2', 's3', 's4']);
    assert.equal(t[0].home, true);
    assert.equal(t[0].exact, true);                      // HOME: una sola página
    assert.equal(t[0].estimatedPages, 1);
    assert.equal(t[1].exact, false);
    assert.equal(t[1].estimatedPages, 3);                // oncologia + mama + pulmon
    assert.equal(t[1].children[0].id, 's2.1');
    assert.equal(t[1].children[0].estimatedPages, 1);
    assert.equal(t[3].url, null);                        // grupo sin enlace propio
    assert.equal(t[3].estimatedPages, 3);                // suma de sus subáreas
});

test('buildSections: sin sitemap las estimaciones son null', () => {
    const t = buildSections([{ label: 'CVRM', url: U('/es/cvrm.html'), children: [] }], U('/es/home.html'), []);
    assert.equal(t[0].estimatedPages, null);
});

// --- extractHeaderNav dentro de Chromium real (sin red: page.setContent) ---
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* sin playwright */ }

async function withPage(html, fn) {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
        await page.goto('https://www.azmed.cr/es/home.html');
        return await fn(page);
    } finally { await browser.close(); }
}

test('extractHeaderNav: menú con desplegables ocultos, externos, # y login', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const html = `<html><body><header>
      <a href="/es/home.html"><img alt="logo"></a>
      <nav><ul>
        <li><a href="/es/home.html">HOME</a></li>
        <li><a href="/es/azeventos.html">AZEVENTOS</a></li>
        <li><a href="/es/oncologia.html">ONCOLOGÍA</a>
          <ul style="display:none"><li><a href="/es/oncologia/mama.html">Mama</a></li><li><a href="/es/oncologia/pulmon.html">Pulmón</a></li></ul></li>
        <li><button>PSP</button><ul style="display:none"><li><a href="/es/psp/a.html">Programa A</a></li></ul></li>
        <li><a href="https://otro-dominio.com/x">EXTERNO</a></li>
        <li><a href="#">VACIO</a></li>
        <li><a href="/es/login.html">Iniciar sesión</a></li>
        <li><a href="/cerrar-sesion">Cerrar sesión</a></li>
      </ul></nav></header><main><a href="/es/otra.html">no es menú</a></main></body></html>`;
    const r = await withPage(html, p => p.evaluate(extractHeaderNav));
    const labels = r.items.map(i => i.label);
    assert.deepEqual(labels, ['HOME', 'AZEVENTOS', 'ONCOLOGÍA', 'PSP']);
    const onco = r.items.find(i => i.label === 'ONCOLOGÍA');
    assert.deepEqual(onco.children.map(c => c.label), ['Mama', 'Pulmón']);   // submenú oculto leído
    const psp = r.items.find(i => i.label === 'PSP');
    assert.equal(psp.url, null);                                              // desplegable sin enlace propio
    assert.deepEqual(psp.children.map(c => c.label), ['Programa A']);
});

test('extractHeaderNav: dos barras (utilidades + menú) y menú hecho con <div>, como azmed.cr', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const item = (href, label) => `<div class="item"><a href="${href}"><svg width="20" height="20"></svg><span>${label}</span></a></div>`;
    const html = `<html><body><header>
      <div class="topbar"><nav class="utility"><a href="/es/home.html">AZMED Medicinas</a>
        <a href="/es/login.html">Iniciar sesión</a><a href="#">Spanish</a><a href="/es/buscar.html">Buscar</a></nav></div>
      <div class="menubar">${item('/es/home.html', 'Inicio')}${item('/es/azeventos.html', 'AZEventos')}${item('/es/oncologia.html', 'Oncología')}
        ${item('/es/cvrm.html', 'CVRM')}${item('/es/respiratorio.html', 'Respiratorio')}${item('/es/inmunologia.html', 'Inmunología')}
        ${item('/es/raras.html', 'Raras')}${item('/es/ipp.html', 'IPP')}${item('/es/programa-pacientes.html', 'Programa para Pacientes')}</div>
      </header><main style="height:2000px"><a href="/es/otra.html">no es menú</a></main>
      <footer><a href="/es/aviso.html">Aviso legal</a><a href="/es/privacidad.html">Privacidad</a><a href="/es/contacto.html">Contacto</a></footer></body></html>`;
    const r = await withPage(html, p => p.evaluate(extractHeaderNav));
    assert.deepEqual(r.items.map(i => i.label),
        ['Inicio', 'AZEventos', 'Oncología', 'CVRM', 'Respiratorio', 'Inmunología', 'Raras', 'IPP', 'Programa para Pacientes']);
});

test('extractHeaderNav: menú sin <ul> (enlaces sueltos) y sin header', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const flat = await withPage('<html><body><nav><a href="/es/a.html">Uno</a><a href="/es/b.html">Dos</a></nav></body></html>', p => p.evaluate(extractHeaderNav));
    assert.deepEqual(flat.items.map(i => i.label), ['Uno', 'Dos']);
    const none = await withPage('<html><body><p>nada</p></body></html>', p => p.evaluate(extractHeaderNav));
    assert.deepEqual(none.items, []);
});

test('extractHeaderNav: respaldo geométrico cuando no hay nav/ul/header (solo enlaces sueltos en una fila)', async (t) => {
    if (!chromium) return t.skip('playwright no disponible');
    const a = (h, l) => `<a href="${h}" style="display:inline-block;margin:4px 12px">${l}</a>`;
    const html = `<html><body><div><div>${a('/es/home.html', 'Inicio')}${a('/es/oncologia.html', 'Oncología')}${a('/es/cvrm.html', 'CVRM')}${a('/es/raras.html', 'Raras')}</div></div>
      <p>texto</p></body></html>`;
    const r = await withPage(html, p => p.evaluate(extractHeaderNav));
    assert.deepEqual(r.items.map(i => i.label), ['Inicio', 'Oncología', 'CVRM', 'Raras']);
    assert.ok(r.debug && r.debug.anchors === 4);
});

test('sectionsFromSitemap: agrupa por primer segmento tras el idioma', () => {
    const { sectionsFromSitemap } = require('../server/sections');
    const urls = ['https://x.cr/es/oncologia.html', 'https://x.cr/es/oncologia/mama.html', 'https://x.cr/es/oncologia/pulmon.html',
        'https://x.cr/es/cvrm/a.html', 'https://x.cr/es/home.html', 'https://x.cr/es/login.html', 'https://x.cr/es/programa-pacientes.html'];
    const items = sectionsFromSitemap(urls);
    assert.deepEqual(items.map(i => i.label), ['Oncologia', 'Cvrm', 'Programa pacientes']);
    assert.equal(items[0].url, 'https://x.cr/es/oncologia.html');
    assert.equal(items[1].url, 'https://x.cr/es/cvrm/a.html');
});

test('buildSections: si el menú apunta a /area/home y las páginas cuelgan de /area/, el alcance es la carpeta', () => {
    const items = [
        { label: 'Inicio', url: 'https://x.cr/es/home.html', children: [] },
        { label: 'Oncología', url: 'https://x.cr/es/oncologia/home.html', children: [] },
        { label: 'CVRM', url: 'https://x.cr/es/cvrm/home.html', children: [] }
    ];
    const sitemap = ['https://x.cr/es/home.html', 'https://x.cr/es/oncologia/home.html', 'https://x.cr/es/oncologia/mama.html',
        'https://x.cr/es/oncologia/pulmon.html', 'https://x.cr/es/cvrm/a.html'];
    const s = buildSections(items, 'https://x.cr/es/home.html', sitemap);
    assert.equal(s[1].scope, 'https://x.cr/es/oncologia');
    assert.equal(s[1].estimatedPages, 3);
    assert.equal(s[2].estimatedPages, 1);
    assert.ok(inSections('https://x.cr/es/oncologia/mama.html', [s[1]]));
    assert.ok(!inSections('https://x.cr/es/cvrm/a.html', [s[1]]));
});

test('buildSections: sin coincidencias en el sitemap la estimación es null (no 0) y no se usa un padre demasiado amplio', () => {
    const items = [{ label: 'Oncología', url: 'https://x.cr/es/oncologia.html', children: [] }, { label: 'CVRM', url: 'https://x.cr/es/cvrm.html', children: [] }];
    const s = buildSections(items, 'https://x.cr/es/home.html', ['https://x.cr/otra/cosa.html']);
    assert.equal(s[0].estimatedPages, null);
    assert.equal(s[0].scope, undefined);
});
