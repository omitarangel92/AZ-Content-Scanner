// Escaneo por áreas: lectura del menú (header) de la página principal y reglas de alcance por ruta.
// Lógica pura + una función que se ejecuta DENTRO del navegador (extractHeaderNav), por eso es autocontenida.

// ---------------------------------------------------------------------------
// Se ejecuta dentro de la página (page.evaluate). Devuelve el menú principal como árbol de 2 niveles:
// { source, items: [{ label, url|null, children: [{ label, url }] }] }
// Lee también los submenús ocultos (display:none hasta el hover) porque usa el DOM, no lo visible.
// ---------------------------------------------------------------------------
function extractHeaderNav() {
    const host = location.hostname.replace(/^www\./, '');
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    const sameSite = (u) => {
        try { const h = new URL(u, location.href).hostname.replace(/^www\./, ''); return h === host || h.endsWith('.' + host); }
        catch (e) { return false; }
    };
    const SKIP_HREF = /^(javascript:|mailto:|tel:|#)/i;
    const SKIP_LABEL = /^(buscar|search|iniciar sesi[oó]n|login|log in|cerrar sesi[oó]n|logout|mi cuenta|idioma|language|es|en|pt|men[uú]|carrito|cart|cerrar|close)$/i;
    const SKIP_URL = /(log[-_]?out|sign[-_]?out|cerrar[-_]?sesi)/i;

    const abs = (a) => {
        const raw = a.getAttribute('href');
        if (!raw || SKIP_HREF.test(raw.trim())) return null;
        try {
            const u = new URL(raw, location.href);
            if (!/^https?:$/.test(u.protocol) || !sameSite(u.href) || SKIP_URL.test(u.pathname)) return null;
            u.hash = '';
            return u.href;
        } catch (e) { return null; }
    };
    const labelOf = (a) => clean(a.textContent) || clean(a.getAttribute('aria-label')) || clean(a.getAttribute('title'));
    const valid = (label) => label && label.length <= 60 && !SKIP_LABEL.test(label);

    // ¿El enlace se ve en la parte alta de la página (zona de cabecera)? Los submenús ocultos no cuentan aquí.
    const TOP_LIMIT = 600;
    const visibleTop = (a) => {
        const r = a.getBoundingClientRect();
        return (r.width > 0 || r.height > 0) && (r.top + window.scrollY) < TOP_LIMIT;
    };
    const countLinks = (el, onlyVisible) => {
        const urls = new Set();
        for (const a of el.querySelectorAll('a[href]')) {
            if (onlyVisible && !visibleTop(a)) continue;
            const u = abs(a);
            if (u && valid(labelOf(a))) urls.add(u);
        }
        return urls.size;
    };

    // Contenedor del menú: se evalúan todos los candidatos (la página puede tener varias barras: utilidades + menú
    // principal, o menús sin <nav>) y se elige el que reúne más enlaces visibles de cabecera, el más pequeño posible.
    const cands = Array.from(document.querySelectorAll('nav, [role="navigation"], header, ul, ol, [class*="menu" i], [class*="nav" i]'))
        .filter(el => !el.closest('footer, [role="contentinfo"]')).slice(0, 600);
    let root = null, source = null;
    for (const onlyVisible of [true, false]) {
        const scored = cands.map(el => ({ el, n: countLinks(el, onlyVisible) })).filter(c => c.n >= 2);
        if (!scored.length) continue;
        const max = Math.max(...scored.map(c => c.n));
        const min = Math.max(2, Math.ceil(max * 0.85));
        let pick = null, pickSize = Infinity;
        for (const c of scored) {
            if (c.n < min) continue;
            const size = c.el.querySelectorAll('a[href]').length;
            if (size < pickSize) { pick = c.el; pickSize = size; }
        }
        if (pick) { root = pick; source = pick.tagName.toLowerCase() + (pick.id ? '#' + pick.id : ''); break; }
    }
    const debug = {
        title: clean(document.title).slice(0, 80), url: location.href,
        anchors: document.querySelectorAll('a[href]').length,
        topAnchors: Array.from(document.querySelectorAll('a[href]')).filter(visibleTop).length,
        frames: window.frames.length, bodyChars: clean(document.body && document.body.innerText).length
    };

    // Respaldo geométrico: enlaces visibles en la zona alta (incluye shadow DOM abierto), agrupados por fila; el menú es
    // la fila con más enlaces distintos. No depende de etiquetas <nav>/<ul> ni de clases CSS.
    const geometric = () => {
        const all = [];
        const walk = (rootNode) => {
            for (const a of rootNode.querySelectorAll('a[href]')) all.push(a);
            for (const el of rootNode.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
        };
        walk(document);
        const rows = new Map();
        for (const a of all) {
            if (!visibleTop(a) || a.closest('footer, [role="contentinfo"]')) continue;
            const u = abs(a), l = labelOf(a);
            if (!u || !valid(l)) continue;
            const r = a.getBoundingClientRect();
            const key = Math.round((r.top + window.scrollY) / 24);
            if (!rows.has(key)) rows.set(key, []);
            rows.get(key).push({ label: l, url: u, left: r.left });
        }
        let bestRow = [];
        for (const row of rows.values()) {
            const distinct = new Set(row.map(x => x.url)).size;
            if (distinct > new Set(bestRow.map(x => x.url)).size) bestRow = row;
        }
        return bestRow.sort((x, y) => x.left - y.left).map(x => ({ label: x.label, url: x.url, children: [] }));
    };
    if (!root) {
        const g = geometric();
        return { source: g.length >= 2 ? 'geometria' : null, items: g.length >= 2 ? g : [], debug };
    }

    // La lista del menú principal es la <ul> con más <li> directos que contienen un enlace (los submenús tienen menos)
    let best = null, bestScore = 0, bestDepth = 99;
    const lists = /^(UL|OL)$/.test(root.tagName) ? [root, ...root.querySelectorAll('ul, ol')] : root.querySelectorAll('ul, ol');
    for (const ul of lists) {
        const lis = Array.from(ul.children).filter(li => li.tagName === 'LI' && li.querySelector('a[href]'));
        let depth = 0; for (let p = ul.parentElement; p && p !== root; p = p.parentElement) depth++;
        if (lis.length > bestScore || (lis.length === bestScore && depth < bestDepth)) { best = ul; bestScore = lis.length; bestDepth = depth; }
    }

    const items = [];
    const seen = new Set();
    const push = (item) => {
        const key = item.url || `group:${item.label}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push(item);
    };

    if (best && bestScore >= 2) {
        for (const li of Array.from(best.children).filter(li => li.tagName === 'LI')) {
            const nested = Array.from(li.querySelectorAll('ul, ol'));
            const inNested = (a) => nested.some(n => n.contains(a));
            const anchors = Array.from(li.querySelectorAll('a[href]'));
            const own = anchors.find(a => !inNested(a) && abs(a)) || null;
            // Etiqueta del elemento: su enlace propio o, si es solo un botón desplegable, el texto directo del <li>
            let label = own ? labelOf(own) : '';
            if (!label) {
                const toggle = li.querySelector(':scope > button, :scope > span, :scope > div > button, :scope > a:not([href])');
                label = toggle ? clean(toggle.textContent) : '';
            }
            const url = own ? abs(own) : null;
            const children = [];
            const childSeen = new Set(url ? [url] : []);
            for (const a of anchors) {
                if (a === own) continue;
                const u = abs(a); const l = labelOf(a);
                if (!u || !valid(l) || childSeen.has(u)) continue;
                childSeen.add(u);
                children.push({ label: l, url: u });
            }
            if (!valid(label)) continue;
            if (!url && !children.length) continue;
            push({ label, url, children });
        }
    } else {
        // Respaldo: menú sin <ul> (enlaces sueltos o <div>): se toman los enlaces visibles de la cabecera
        const all = Array.from(root.querySelectorAll('a[href]'));
        const vis = all.filter(visibleTop);
        for (const a of (vis.length >= 2 ? vis : all)) {
            const u = abs(a); const l = labelOf(a);
            if (u && valid(l)) push({ label: l, url: u, children: [] });
        }
    }
    if (items.length < 2) {
        const g = geometric();
        if (g.length >= 2) return { source: 'geometria', items: g, debug };
    }
    return { source, items, debug };
}

// ---------------------------------------------------------------------------
// Lógica pura (Node)
// ---------------------------------------------------------------------------

// Ruta normalizada para comparar: sin barra final, sin extensión .html y sin el prefijo de repositorio AEM
// (/content/<sitio>/es/x.html ≡ /es/x). Se ignoran query y hash.
function normPath(url) {
    let p;
    try { p = new URL(url).pathname; } catch (e) { return null; }
    try { p = decodeURIComponent(p); } catch (e) { /* se deja tal cual */ }
    p = p.replace(/^\/content\/[^/]+(?=\/)/i, '');
    p = p.replace(/\.(html?|php|aspx?)$/i, '');
    p = p.replace(/\/+$/, '');
    return (p || '/').toLowerCase();
}

const HOME_LABEL = /^(home|inicio|início|principal|portada)$/i;

// ¿La sección debe tratarse como UNA sola página? (HOME o la raíz). Si no, su prefijo abarcaría todo el sitio.
function isHomeLike(section, siteUrl) {
    const prefix = normPath(section.url);
    if (!prefix) return false;
    if (prefix === '/') return true;
    if (HOME_LABEL.test(String(section.label || '').trim())) return true;
    return siteUrl ? normPath(siteUrl) === prefix : false;
}

// ¿La URL pertenece a alguna de las secciones? Coincidencia por SEGMENTO completo:
// /es/oncologia ⊂ /es/oncologia/mama, pero /es/oncologia-x no.
function inSections(url, sections) {
    const path = normPath(url);
    if (path === null) return false;
    return sections.some(s => {
        const prefix = normPath(s.scope || s.url);
        if (prefix === null) return false;
        if (s.exact) return path === prefix;
        return prefix === '/' ? true : (path === prefix || path.startsWith(prefix + '/'));
    });
}

// Construye el árbol de áreas para la interfaz: ids estables, marca HOME / contenedores como "solo esa página"
// y estima las páginas de cada área con las URLs del sitemap.
// Si la ruta del enlace del menú no coincide con ninguna página del sitemap (p. ej. el menú apunta a la portada
// /es/oncologia/home.html y las páginas cuelgan de /es/oncologia/), se prueba con la carpeta padre. Se descarta si esa
// carpeta es solo el idioma o contiene a otros elementos del menú (abarcaría media web).
function parentScope(url, prefixes, index) {
    const p = prefixes[index];
    if (!p) return null;
    const segs = p.split('/').filter(Boolean);
    if (segs.length < 2) return null;
    const parent = '/' + segs.slice(0, -1).join('/');
    if (segs.length - 1 === 1 && /^[a-z]{2}([-_][a-z]{2})?$/i.test(segs[0])) return null;
    if (prefixes.some((q, j) => j !== index && q && (q === parent || q.startsWith(parent + '/')))) return null;
    try { return new URL(url).origin + parent; } catch (e) { return null; }
}

function buildSections(items, siteUrl, sitemapUrls = []) {
    const tops = items.map((it, i) => ({ ...it, id: `s${i + 1}` }));
    // Un elemento cuya ruta es ancestro de otros elementos del menú es un contenedor (típico de HOME): solo esa página
    const prefixes = tops.map(t => (t.url ? normPath(t.url) : null));
    const isAncestorOfOthers = (i) => prefixes[i] && prefixes[i] !== '/' &&
        prefixes.some((p, j) => j !== i && p && p.startsWith(prefixes[i] + '/'));

    return tops.map((t, i) => {
        const section = { id: t.id, label: t.label, url: t.url, exact: false, home: false, children: [] };
        if (t.url) {
            section.home = isHomeLike(t, siteUrl);
            section.exact = section.home || isAncestorOfOthers(i);
            section.estimatedPages = sitemapUrls.length ? sitemapUrls.filter(u => inSections(u, [section])).length : null;
            if (section.estimatedPages <= 1 && !section.exact) {   // 0, o solo la propia portada
                const scope = parentScope(t.url, prefixes, i);
                const n = scope ? sitemapUrls.filter(u => inSections(u, [{ url: scope }])).length : 0;
                if (n > section.estimatedPages) { section.scope = scope; section.estimatedPages = n; }
            }
            if (section.estimatedPages === 0) section.estimatedPages = null;   // sin coincidencias: dato desconocido, no "0"
        } else {
            section.estimatedPages = null;
        }
        section.children = (t.children || []).map((c, k) => {
            const child = { id: `${t.id}.${k + 1}`, label: c.label, url: c.url, exact: false };
            child.estimatedPages = sitemapUrls.length ? sitemapUrls.filter(u => inSections(u, [child])).length : null;
            return child;
        });
        if (!t.url) {
            section.estimatedPages = sitemapUrls.length
                ? sitemapUrls.filter(u => section.children.some(ch => inSections(u, [ch]))).length : null;
        }
        return section;
    });
}

// Último recurso: si no se pudo leer el menú, se proponen áreas con el primer segmento de ruta del sitemap
// (/es/oncologia/... → «Oncologia»). Devuelve items con el mismo formato que extractHeaderNav.
const LANG_SEG = /^[a-z]{2}([-_][a-z]{2})?$/i;
const SKIP_SEG = /^(login|logout|search|buscar|404|error|sitemap|content|etc|libs|apps|conf|home|index|inicio)$/i;
function sectionsFromSitemap(urls, limit = 20) {
    const groups = new Map();
    for (const raw of urls) {
        const p = normPath(raw);
        if (!p || p === '/') continue;
        const segs = p.split('/').filter(Boolean);
        const lang = LANG_SEG.test(segs[0]) ? segs[0] : null;
        const rest = lang ? segs.slice(1) : segs;
        if (!rest.length || SKIP_SEG.test(rest[0])) continue;
        const key = (lang ? lang + '/' : '') + rest[0];
        if (!groups.has(key)) groups.set(key, { key, name: rest[0], urls: [], depth: [] });
        const g = groups.get(key);
        g.urls.push(raw);
        g.depth.push(rest.length);
    }
    return [...groups.values()]
        .sort((a, b) => b.urls.length - a.urls.length).slice(0, limit)
        .map(g => {
            // URL de entrada del área: la página que coincide exactamente con el prefijo; si no, la más corta
            const exact = g.urls.find(u => normPath(u) === '/' + g.key);
            const entry = exact || g.urls.slice().sort((a, b) => a.length - b.length)[0];
            const label = decodeURIComponent(g.name).replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());
            return { label, url: entry, children: [] };
        });
}

// Rutas que pertenecen a un área aunque no cuelguen de su carpeta (azmed.cr): se escanean siempre al elegir el área.
// `match` se compara con el último segmento de la ruta del área (o su etiqueta); `paths` son prefijos relativos a /es/home;
// `seeds` son páginas concretas que se siembran en la cola.
const AREA_ALIASES = [
    { name: 'Raras', match: /rare-?disease|enfermedades[-_ ]?raras|raras/i,
      paths: ['enfermedades_raras'],
      seeds: ['enfermedades_raras/micrositio_ultomiris', 'enfermedades_raras/micrositio_calculadoras', 'enfermedades_raras/Micrositio_Recursos',
          'enfermedades_raras/dosingtesting', 'enfermedades_raras/Patologia_hnp', 'enfermedades_raras/Patologia_SHUa',
          'enfermedades_raras/Patologia_MGg', 'enfermedades_raras/plasmic-score-calculator'] },
    { name: 'Respiratorio', match: /respirator/i,
      paths: ['epoc-bajo-control', 'azeventos/respiratorio', 'respiratorio/PulmON_Healthy_Lungs', 'contenido/respiratorio'],
      seeds: ['epoc-bajo-control/test-puma', 'contenido/respiratorio'] },
    { name: 'Oncología', match: /oncolog/i,
      paths: ['mismo-cancer', 'azeventos/oncologia', 'contenido/oncologia'], seeds: ['mismo-cancer', 'contenido/oncologia'] },
    { name: 'Inmunología', match: /inmunolog/i,
      paths: ['Synagis', 'saphnelo-home'], seeds: ['Synagis', 'saphnelo-home'] },
    { name: 'CVRM', match: /^cvrm$|cardio/i,
      paths: ['falla-cardiaca', 'contenido/cvrm'], seeds: ['contenido/cvrm'] }
];

// Devuelve, para las áreas elegidas, los prefijos extra ({url}) y las páginas semilla ({url}) que les corresponden.
function aliasSectionsFor(sections) {
    const prefixes = [], seeds = [], used = new Set();
    for (const s of sections) {
        if (!s.url || s.exact) continue;
        const p = normPath(s.scope || s.url);
        if (!p) continue;
        const last = p.split('/').filter(Boolean).pop() || '';
        let origin; try { origin = new URL(s.url).origin; } catch (e) { continue; }
        for (const a of AREA_ALIASES) {
            if (used.has(a.name + origin) || !(a.match.test(last) || a.match.test(String(s.label || '').trim()))) continue;
            used.add(a.name + origin);
            a.paths.forEach(x => prefixes.push({ url: `${origin}/es/home/${x}.html` }));
            a.seeds.forEach(x => seeds.push(`${origin}/es/home/${x}.html`));
        }
    }
    return { prefixes, seeds };
}

module.exports = { aliasSectionsFor, AREA_ALIASES, sectionsFromSitemap, extractHeaderNav, normPath, isHomeLike, inSections, buildSections, HOME_LABEL };
