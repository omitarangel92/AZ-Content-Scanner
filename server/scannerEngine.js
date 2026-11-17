const authManager = require('./authManager');
const vaultClient = require('./vaultClient');
const kalturaClient = require('./kalturaClient');
const ocr = require('./ocrService');
const storage = require('./storage');
const config = require('./config');

const ID_RE = () => new RegExp(config.approvalIdRegex, 'g');
const PDF_EXT = /\.pdf$/i;
// Archivos que NO se visitan como paginas (los PDF se descargan y se leen aparte)
const SKIP_EXT = /\.(pdf|zip|rar|7z|exe|dmg|mp3|mp4|m4v|mov|avi|webm|css|js|json|xml|woff2?|ttf|eot|ico|svg|jpe?g|png|gif|webp|docx?|xlsx?|pptx?|csv|txt|ics|vcf)$/i;
const SVG_EXT = /\.svg(\?.*)?$/i;
const CAMPAIGN_PARAM = /^(utm_|ucampaign|umedium|usource|ucontent|uterm)/i;
const MAX_IMG_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 25 * 1024 * 1024;
const OCR_TIMEOUT_MS = 20000;
const MAX_SITEMAP_URLS = 5000;
const RETRYABLE_NAV = /Timeout|ERR_TIMED_OUT|ERR_CONNECTION|ERR_NETWORK|ERR_HTTP2|ERR_EMPTY_RESPONSE|ERR_SOCKET|ERR_NAME_NOT_RESOLVED|Target closed|Navigation failed because page crashed|interrupted by another navigation/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Subdominios de crt.sh que son infraestructura, no sitios de contenido: no se visitan
const INFRA_HOST = /(^|\.)(grafana|prometheus|prom|argocd|jenkins|gitlab|jira|confluence|kibana|elastic|otel|otel-http|telemetry|uptrace|uptime|monitoring|mlops|finops|vpn|mail|smtp|imap|pop|autodiscover|mx|ns\d*|api|login|sso|auth|admin|pypi|pip|registry|nexus|sonar|vault|proxy|nginx-proxy-manager|dashboard|incident-handler|status)(\.|-|$)/i;

// Textos de botones que aceptan cookies o confirman que el visitante es profesional de la salud.
// Se comparan sin tildes y en minusculas. Solo se pulsan dentro de avisos/capas (ver dismissOverlays).
const ACCEPT_PHRASES = [
    // Cookies
    'permitir todas las cookies', 'permitir todas', 'aceptar todas las cookies', 'aceptar todas',
    'aceptar cookies', 'aceptar y continuar', 'acepto', 'aceptar',
    'accept all cookies', 'accept all', 'accept cookies', 'i accept', 'allow all',
    'aceitar todos', 'aceitar', 'concordo',
    // Aviso de profesional de la salud
    'soy profesional de la salud', 'soy un profesional de la salud', 'si, soy profesional', 'si soy profesional',
    'soy profesional', 'profesional de la salud', 'ingresar', 'entrar', 'continuar', 'confirmar',
    'i am a healthcare professional', 'i am a health care professional', 'yes, i am', 'yes i am', 'enter site', 'continue',
    'sou profissional de saude', 'sou profissional', 'sim, sou'
];

// Textos que NO deben pulsarse (rechazo o preferencias)
const REJECT_PHRASES = [
    'no soy', 'no, no soy', 'rechazar', 'solo necesarias', 'solo las necesarias', 'preferencias',
    'configurar', 'personalizar', 'reject', 'decline', 'necessary only', 'manage', 'settings',
    'i am not', 'no, i am not', 'nao sou', 'recusar'
];

// Oculta capas superpuestas conocidas antes de capturar
const HIDE_OVERLAYS_CSS = `
    #onetrust-consent-sdk, #onetrust-banner-sdk, .onetrust-pc-dark-filter, #onetrust-pc-sdk,
    [id*="cookie" i][class*="banner" i], [class*="cookie-banner" i], [class*="cookie-consent" i],
    [class*="cookies" i][role="dialog"], [aria-label*="cookie" i][role="dialog"],
    [id*="cookie-law" i], [class*="cc-window" i], [class*="gdpr" i][role="dialog"],
    .overlay-cookies {
        display: none !important; visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
    }
    html, body { overflow: auto !important; position: static !important; }
`;

// Se ejecuta DENTRO de cada frame. Extrae texto (visible y oculto), IDs con su contexto,
// imagenes (img, picture, srcset, fondos CSS), enlaces, PDF, videos, metas y canonical.
// Recorre tambien Shadow DOM.
function extractInFrame({ reSource, maxBgEls }) {
    const out = { text: '', hits: [], images: [], pdfs: [], videos: [], links: [], metas: [], canonical: null };
    if (!document.body) return out;

    const roots = [document];
    const collectShadow = (root) => {
        root.querySelectorAll('*').forEach(el => {
            if (el.shadowRoot) { roots.push(el.shadowRoot); collectShadow(el.shadowRoot); }
        });
    };
    try { collectShadow(document); } catch (e) {}
    const qsa = (sel) => roots.flatMap(r => { try { return Array.from(r.querySelectorAll(sel)); } catch (e) { return []; } });
    const abs = (u) => { try { return new URL(u, location.href).href; } catch (e) { return null; } };
    const isVisible = (el) => {
        if (!el) return false;
        if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    };

    // ---- Texto: visible + nodos ocultos (acordeones, pestanas, carruseles, modales) ----
    const visibleText = document.body.innerText || '';
    const parts = [];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    for (const root of roots) {
        const start = root === document ? document.body : root;
        const walker = document.createTreeWalker(start, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent || SKIP_TAGS.has(parent.tagName)) continue;
            const value = node.nodeValue;
            if (!value || !value.trim()) continue;
            parts.push(value);
            const re = new RegExp(reSource, 'g');
            let m;
            while ((m = re.exec(value))) {
                const ctx = (parent.textContent || value).replace(/\s+/g, ' ').trim();
                const i = ctx.indexOf(m[0]);
                out.hits.push({
                    id: m[0],
                    snippet: ctx.substring(Math.max(0, i - 70), i + 100),
                    hidden: !isVisible(parent)
                });
            }
        }
    }
    out.text = visibleText + '\n' + parts.join(' ');

    // ---- Imagenes ----
    const seenImg = new Set();
    const addImg = (src, alt, w, h) => {
        if (!src || /^(data:|blob:|about:)/i.test(src)) return;
        const a = abs(src);
        if (!a || seenImg.has(a)) return;
        seenImg.add(a);
        out.images.push({ src: a, alt: alt || '', w: w || 0, h: h || 0 });
    };
    const fromSrcset = (ss) => {
        if (!ss) return null;
        const cands = ss.split(',').map(s => s.trim().split(/\s+/)).filter(p => p[0]);
        if (!cands.length) return null;
        cands.sort((a, b) => (parseFloat(b[1]) || 0) - (parseFloat(a[1]) || 0));
        return cands[0][0];
    };
    qsa('img').forEach(img => {
        const r = img.getBoundingClientRect();
        const w = img.naturalWidth || r.width, h = img.naturalHeight || r.height;
        const alt = `${img.alt || ''} ${img.title || ''}`;
        addImg(img.currentSrc || img.src, alt, w, h);
        ['data-src', 'data-lazy-src', 'data-original'].forEach(at => addImg(img.getAttribute(at), alt, w, h));
        addImg(fromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset')), alt, w, h);
    });
    qsa('picture source, source[data-srcset]').forEach(s => {
        const pic = s.closest('picture');
        const img = pic && pic.querySelector('img');
        const r = (img || s.parentElement || s).getBoundingClientRect();
        addImg(fromSrcset(s.getAttribute('srcset') || s.getAttribute('data-srcset')), img ? img.alt : '', r.width, r.height);
    });
    qsa('input[type="image"]').forEach(i => addImg(i.src, i.alt, i.width, i.height));
    // Fondos CSS (banners) y fondos diferidos en atributos data-*
    const bgRe = /url\((['"]?)(.*?)\1\)/g;
    let bgCount = 0;
    for (const el of qsa('body *')) {
        if (bgCount >= maxBgEls) break;
        const lazy = el.getAttribute('data-bg') || el.getAttribute('data-background') || el.getAttribute('data-background-image');
        if (lazy) addImg(lazy.replace(/^url\((['"]?)(.*?)\1\)$/, '$2'), el.getAttribute('aria-label') || '', 0, 0);
        const r = el.getBoundingClientRect();
        if (r.width < 200 || r.height < 80) continue;
        bgCount++;
        const bg = getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') continue;
        let m;
        while ((m = bgRe.exec(bg))) addImg(m[2], el.getAttribute('aria-label') || el.getAttribute('title') || '', r.width, r.height);
        bgRe.lastIndex = 0;
    }

    // ---- Enlaces y PDF ----
    const isPdf = (u) => { try { return /\.pdf$/i.test(new URL(u).pathname); } catch (e) { return false; } };
    const addLink = (u, text) => {
        const a = abs(u);
        if (!a) return;
        out.links.push(a);
        if (isPdf(a)) out.pdfs.push({ href: a, text: text || '' });
    };
    qsa('a[href], area[href]').forEach(a => addLink(a.href || a.getAttribute('href'), `${a.innerText || ''} ${a.title || ''}`));
    qsa('[data-href], [data-url], [data-link]').forEach(el =>
        addLink(el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link'), el.innerText || ''));
    const onclickRe = /(?:location(?:\.href)?\s*=|window\.open\(|location\.assign\()\s*['"]([^'"]+)['"]/;
    qsa('[onclick]').forEach(el => {
        const m = (el.getAttribute('onclick') || '').match(onclickRe);
        if (m) addLink(m[1], el.innerText || '');
    });

    // ---- Videos ----
    const ctxOf = (v) => ((v.closest('section,article,div') || v.parentElement || {}).innerText || '').substring(0, 400);
    qsa('iframe, video, video source, embed, object').forEach(v => {
        const raw = v.src || v.getAttribute('src') || v.getAttribute('data') || v.getAttribute('data-src') || '';
        const src = raw ? abs(raw) : null;
        if (src && isPdf(src)) { out.pdfs.push({ href: src, text: '' }); return; }
        if (!src || /^(blob:|data:|about:)/i.test(src)) return;
        if (/kaltura|youtube|vimeo|player|video/i.test(src) || v.tagName === 'VIDEO' || v.tagName === 'SOURCE') {
            out.videos.push({ src, title: v.title || '', context: ctxOf(v) });
        }
    });
    qsa('[data-entry-id], [data-entryid], [data-kaltura-entry-id]').forEach(el => {
        const eid = el.getAttribute('data-entry-id') || el.getAttribute('data-entryid') || el.getAttribute('data-kaltura-entry-id');
        const pid = el.getAttribute('data-partner-id') || el.getAttribute('data-partnerid') || '';
        if (eid) out.videos.push({ src: `kaltura:${pid ? `/p/${pid}/` : '/'}entry_id/${eid}`, title: el.title || '', context: ctxOf(el) });
    });

    document.querySelectorAll('meta[content]').forEach(m => {
        out.metas.push(`${m.name || m.getAttribute('property') || ''}: ${m.content}`);
    });
    const can = document.querySelector('link[rel="canonical"]');
    out.canonical = can ? can.href : null;
    return out;
}

class ScannerEngine {
    constructor() {
        this.isCancelled = false;
        this.vaultPhase = false;
        this.running = false;
        // Host preferido para unificar www.dominio y dominio (evita escanear todo dos veces)
        this.hostCanon = null;
    }

    cancelScan() { this.isCancelled = true; }
    isRunning() { return this.running; }

    // ---------- Dominios y URLs ----------
    isAllowedHost(hostname) {
        const h = hostname.toLowerCase();
        if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/.test(h)) return false;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
        return config.allowedDomains.some(d => h === d || h.endsWith('.' + d));
    }

    isInScope(url, baseDomain) {
        try {
            const h = new URL(url).hostname.toLowerCase();
            return this.isAllowedHost(h) && (h === baseDomain || h.endsWith('.' + baseDomain));
        } catch (e) { return false; }
    }

    // Normaliza una URL sin filtrar por extension: quita hash, parametros de campaña y barra final,
    // y unifica www.dominio / dominio.
    canonicalize(raw) {
        try {
            const u = new URL(raw);
            if (!/^https?:$/.test(u.protocol)) return null;
            if (config.logoutPattern.test(u.pathname + u.search)) return null;
            u.hash = '';
            config.trackingParams.forEach(p => u.searchParams.delete(p));
            [...u.searchParams.keys()].forEach(k => { if (CAMPAIGN_PARAM.test(k)) u.searchParams.delete(k); });
            u.searchParams.sort();
            if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
            if (this.hostCanon) {
                const h = u.hostname.toLowerCase();
                if (h === this.hostCanon.base || h === `www.${this.hostCanon.base}`) u.hostname = this.hostCanon.preferred;
            }
            return u.href;
        } catch (e) { return null; }
    }

    // URL de pagina HTML visitable (descarta archivos)
    normalizeUrl(raw) {
        const c = this.canonicalize(raw);
        if (!c) return null;
        return SKIP_EXT.test(new URL(c).pathname) ? null : c;
    }

    // Subdominios desde crt.sh. Se consulta con una pestaña del navegador: el fetch de Node falla
    // con el proxy corporativo (UNABLE_TO_GET_ISSUER_CERT_LOCALLY) y Chromium usa los certificados del sistema.
    async fetchSubdomains(domain, page) {
        const fallback = [`https://${domain}`, `https://www.${domain}`];
        try {
            // crt.sh es publico y a veces responde una pagina de error HTML: se reintenta una vez
            let json = null;
            for (let attempt = 0; attempt < 2 && !json; attempt++) {
                if (attempt) await sleep(3000);
                const res = await page.goto(`https://crt.sh/?q=%25.${domain}&output=json`, { waitUntil: 'commit', timeout: 30000 }).catch(() => null);
                if (!res || !res.ok()) continue;
                try { json = JSON.parse(await res.text()); } catch (e) {}
            }
            if (!Array.isArray(json)) return fallback;
            const subs = new Set(fallback);
            json.forEach(item => (item.name_value || '').split('\n').forEach(n => {
                const c = n.trim().replace(/^\*\./, '').toLowerCase();
                if (c && !c.includes('*') && (c === domain || c.endsWith('.' + domain))) subs.add(`https://${c}`);
            }));
            return Array.from(subs);
        } catch (e) { return fallback; }
    }

    // Descarga texto con el contexto del navegador (mismo user-agent y cookies: el WAF lo acepta)
    async fetchText(request, url, timeout = 15000) {
        try {
            const res = await request.get(url, { timeout, maxRedirects: 5 });
            if (!res.ok()) return null;
            return await res.text();
        } catch (e) { return null; }
    }

    // Sitemaps: robots.txt (lineas "Sitemap:"), /sitemap.xml, /sitemap_index.xml y sitemaps anidados
    async fetchSitemapUrls(request, origin, baseDomain, extraSitemaps = []) {
        const found = new Set();
        const seenMaps = new Set();
        const toVisit = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, ...extraSitemaps];

        const robots = await this.fetchText(request, `${origin}/robots.txt`, 8000);
        if (robots) {
            for (const m of robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)) toVisit.unshift(m[1]);
        }

        while (toVisit.length && seenMaps.size < 50 && found.size < MAX_SITEMAP_URLS) {
            if (this.isCancelled) break;
            const sm = toVisit.shift();
            if (seenMaps.has(sm)) continue;
            seenMaps.add(sm);
            const xml = await this.fetchText(request, sm, 12000);
            if (!xml || !/<(urlset|sitemapindex)/i.test(xml)) continue;
            for (const m of xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)) {
                const loc = m[1].replace(/&amp;/g, '&');
                if (/\.xml(\.gz)?(\?.*)?$/i.test(loc)) { if (this.isInScope(loc, baseDomain)) toVisit.push(loc); }
                else if (this.isInScope(loc, baseDomain)) found.add(loc);
                if (found.size >= MAX_SITEMAP_URLS) break;
            }
        }
        return Array.from(found);
    }

    // ---------- Cookies y avisos de acceso ----------
    // Pulsa botones de aceptacion (cookies y aviso de profesional de la salud) SOLO si estan dentro de
    // un aviso/capa (dialogo, banner fijo, contenedor de cookies). Asi no se pulsan enlaces normales
    // del sitio como "Ingresar al evento" o "Continuar leyendo".
    async dismissOverlays(page) {
        let clicks = 0;

        const tryFrame = async (frame) => {
            try {
                return await frame.evaluate(({ accept, reject }) => {
                    const norm = (s) => String(s || '').toLowerCase()
                        .normalize('NFD').replace(/[̀-ͯ]/g, '')
                        .replace(/\s+/g, ' ').trim();
                    const acc = accept.map(norm), rej = reject.map(norm);
                    const OVERLAY_RE = /cookie|consent|onetrust|modal|overlay|popup|pop-up|gdpr|dialog|lightbox|hcp|profesional|professional|disclaimer|gate|interstitial|aviso|cc-window|cc-banner|truste|didomi|cookiebot/i;

                    const visible = (el) => {
                        const r = el.getBoundingClientRect();
                        const st = getComputedStyle(el);
                        return r.width > 8 && r.height > 8 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
                    };

                    // true si el elemento esta dentro de un aviso/capa y no en la navegacion normal
                    const inOverlay = (el) => {
                        let fixedSeen = false;
                        for (let n = el, i = 0; n && n !== document.body && i < 20; n = n.parentElement, i++) {
                            const role = (n.getAttribute && n.getAttribute('role')) || '';
                            const cls = typeof n.className === 'string' ? n.className : '';
                            if (n.tagName === 'DIALOG' || role === 'dialog' || role === 'alertdialog' ||
                                (n.getAttribute && n.getAttribute('aria-modal') === 'true')) return true;
                            if (OVERLAY_RE.test(`${n.id || ''} ${cls}`)) return true;
                            if (n.tagName === 'HEADER' || n.tagName === 'NAV' || n.tagName === 'FOOTER' || role === 'navigation') return false;
                            const pos = getComputedStyle(n).position;
                            if (pos === 'fixed' || pos === 'sticky') fixedSeen = true;
                        }
                        return fixedSeen;
                    };

                    const cands = Array.from(document.querySelectorAll(
                        'button, a, [role="button"], input[type="button"], input[type="submit"], div[onclick], span[onclick], [tabindex]'
                    )).filter(visible);

                    let clicked = 0;
                    for (const el of cands) {
                        const text = norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
                        if (!text || text.length > 80) continue;
                        if (rej.some(r => text.includes(r))) continue;
                        const hit = acc.some(a => text === a || (a.length >= 8 && text.includes(a)));
                        if (hit && inOverlay(el)) {
                            try { el.click(); clicked++; } catch (e) {}
                            if (clicked >= 2) break;
                        }
                    }
                    return clicked;
                }, { accept: ACCEPT_PHRASES, reject: REJECT_PHRASES });
            } catch (e) { return 0; }
        };

        for (const frame of page.frames()) {
            clicks += await tryFrame(frame);
        }

        // Selectores especificos por si el texto no coincide
        for (const sel of ['#onetrust-accept-btn-handler', '#accept-recommended-btn-handler', 'button#acceptAll', '.cc-allow', '.cc-dismiss']) {
            try {
                const el = await page.$(sel);
                if (el && await el.isVisible().catch(() => false)) {
                    await el.click({ timeout: 1500 }).catch(() => {});
                    clicks++;
                }
            } catch (e) {}
        }

        if (clicks > 0) await page.waitForTimeout(1000);
        return clicks;
    }

    // Elimina cualquier capa fija que siga tapando la pagina (modal, banner, fondo oscuro)
    async removeBlockingLayers(page) {
        try { await page.addStyleTag({ content: HIDE_OVERLAYS_CSS }); } catch (e) {}
        try {
            await page.evaluate(() => {
                const vw = window.innerWidth, vh = window.innerHeight;
                const all = Array.from(document.querySelectorAll('body *'));
                for (const el of all) {
                    const st = getComputedStyle(el);
                    if (st.position !== 'fixed' && st.position !== 'sticky') continue;
                    const r = el.getBoundingClientRect();
                    const z = parseInt(st.zIndex, 10) || 0;
                    const coversMuch = (r.width * r.height) > (vw * vh * 0.18);
                    const isHeader = r.top <= 2 && r.height < 130 && r.width >= vw * 0.9 && /nav|header|menu/i.test((el.tagName + ' ' + el.className + ' ' + el.id));
                    const looksLikeOverlay = /cookie|consent|modal|overlay|popup|gdpr|banner|dialog|hcp|profesional|age|gate/i
                        .test(`${el.id} ${el.className} ${el.getAttribute('role') || ''}`);
                    if (!isHeader && (looksLikeOverlay || (z >= 1000 && coversMuch))) {
                        el.style.setProperty('display', 'none', 'important');
                    }
                }
                document.documentElement.style.setProperty('overflow', 'auto', 'important');
                document.body.style.setProperty('overflow', 'auto', 'important');
            });
        } catch (e) {}
    }

    samePage(a, b) {
        const ca = this.canonicalize(a), cb = this.canonicalize(b);
        return !!ca && ca === cb;
    }

    // Prepara la pagina: acepta avisos y quita capas. Se repite porque algunos avisos aparecen tarde.
    // Si un clic saca al navegador de la pagina, se vuelve a ella (el aviso ya quedo aceptado por cookie).
    async preparePage(page) {
        const expected = page.url();
        let returns = 0;
        for (let round = 0; round < 3; round++) {
            const clicks = await this.dismissOverlays(page);
            if (!this.samePage(page.url(), expected) && returns < 2) {
                returns++;
                await page.goto(expected, { waitUntil: 'domcontentloaded', timeout: config.pageTimeout }).catch(() => {});
                await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                continue;
            }
            await this.removeBlockingLayers(page);
            if (clicks === 0 && round >= 1) break;
            await page.waitForTimeout(500);
        }
    }

    async autoScroll(page) {
        try {
            await page.evaluate(async () => {
                await new Promise(resolve => {
                    let t = 0;
                    const timer = setInterval(() => {
                        window.scrollBy(0, 700); t += 700;
                        if (t >= document.body.scrollHeight || t > 15000) {
                            clearInterval(timer); window.scrollTo(0, 0); resolve();
                        }
                    }, 100);
                });
            });
        } catch (e) {}
    }

    // Captura la zona de la pagina donde aparece el codigo (o la cabecera si no se localiza).
    // Si el codigo esta dentro de un acordeon/pestana cerrada, intenta desplegarlo antes.
    async captureEvidence(page, id) {
        try {
            await this.preparePage(page);

            const located = id ? await page.evaluate((code) => {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let node;
                while ((node = walker.nextNode())) {
                    if (!node.nodeValue || !node.nodeValue.includes(code)) continue;
                    const el = node.parentElement;
                    if (!el) continue;
                    // Desplegar contenedores ocultos (details, acordeones/pestanas Bootstrap o ARIA)
                    for (let n = el; n && n !== document.body; n = n.parentElement) {
                        if (n.tagName === 'DETAILS') n.open = true;
                        if (n.id) {
                            const sel = `[aria-controls="${CSS.escape(n.id)}"], [data-target="#${CSS.escape(n.id)}"], [data-bs-target="#${CSS.escape(n.id)}"], a[href="#${CSS.escape(n.id)}"]`;
                            const ctl = document.querySelector(sel);
                            if (ctl && ctl.getAttribute('aria-expanded') !== 'true') { try { ctl.click(); } catch (e) {} }
                        }
                    }
                    el.scrollIntoView({ block: 'center', inline: 'nearest' });
                    el.style.outline = '3px solid #830051';
                    el.style.outlineOffset = '2px';
                    return true;
                }
                return false;
            }, id) : false;

            if (!located) await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
            await page.waitForTimeout(500);
            await this.removeBlockingLayers(page);

            return await page.screenshot({ type: 'jpeg', quality: 55, scale: 'css' });
        } catch (e) {
            return null;
        }
    }

    async looksLikeLogin(page, response) {
        const url = page.url().toLowerCase();
        if (/identity\.astrazeneca|login|signin|sso|saml|oauth|okta|b2clogin/.test(url)) {
            const hasPwd = await page.$('input[type="password"], input[type="email"]').catch(() => null);
            if (hasPwd) return true;
            if (!this.hostCanon || !url.includes(this.hostCanon.base)) return true; // redirigio fuera del sitio a un login
        }
        if (response && response.status() === 401) return true;
        if (response && response.status() === 403 && !(await this.isWafBlock(response))) return true;
        return false;
    }

    // 403 generado por el WAF de CloudFront (no es una pagina protegida por login)
    async isWafBlock(response) {
        if (!response || response.status() !== 403) return false;
        const h = response.headers();
        if (/cloudfront/i.test(h['server'] || '') || /error from cloudfront/i.test(h['x-cache'] || '')) return true;
        try { return /request blocked|could not be satisfied/i.test(await response.text()); } catch (e) { return false; }
    }

    // Abre la URL con reintentos. Devuelve { response } | { download: true } | { error, waf }
    async navigate(page, url, waitWaf) {
        let lastErr = 'Sin respuesta', waf = false;
        for (let attempt = 0; attempt <= config.pageRetries; attempt++) {
            if (this.isCancelled) break;
            await waitWaf();
            try {
                // Descarga el documento anterior: cancela recargas/redirecciones programadas por su JS
                // (p. ej. tras aceptar el aviso de profesional) que interrumpirian esta navegacion.
                await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
                const response = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: Math.round(config.pageTimeout * (attempt ? 1.8 : 1))
                });
                if (response && await this.isWafBlock(response)) {
                    waf = true;
                    lastErr = 'Bloqueado por el WAF del sitio (403 CloudFront)';
                    await waitWaf(6000 * (attempt + 1));
                    continue;
                }
                return { response };
            } catch (e) {
                const msg = (e.message || String(e)).split('\n')[0];
                if (/Download is starting|net::ERR_ABORTED/i.test(msg)) return { download: true };
                lastErr = msg;
                if (!RETRYABLE_NAV.test(msg)) break;
                await sleep(1500);
            }
        }
        return { error: lastErr, waf };
    }

    async extractPageData(page, baseDomain) {
        const merged = { text: '', hits: [], images: [], pdfs: [], videos: [], links: [], metas: [], canonical: null };
        const args = { reSource: config.approvalIdRegex, maxBgEls: 4000 };
        for (const frame of page.frames()) {
            const isMain = frame === page.mainFrame();
            const furl = frame.url();
            // Frames hijos: solo los del mismo sitio o en linea (srcdoc/about:blank)
            if (!isMain && !(this.isInScope(furl, baseDomain) || /^about:(blank|srcdoc)/.test(furl))) continue;
            try {
                const d = await frame.evaluate(extractInFrame, args);
                merged.text += '\n' + d.text;
                merged.hits.push(...d.hits);
                merged.images.push(...d.images);
                merged.pdfs.push(...d.pdfs);
                merged.videos.push(...d.videos);
                merged.links.push(...d.links);
                merged.metas.push(...d.metas);
                if (isMain) merged.canonical = d.canonical;
            } catch (e) {
                if (isMain) throw e;
            }
        }
        return merged;
    }

    // ---------- Escaneo ----------
    async runScan(params, sendSSE) {
        const { region, country, targetUrl } = params;
        const extraUrls = Array.isArray(params.extraUrls) ? params.extraUrls : [];
        const scanId = params.scanId || Date.now().toString(36);
        this.isCancelled = false;
        this.vaultPhase = false;
        this.running = true;

        const startedAt = Date.now();
        const coverage = {
            pagesRead: 0, pagesFailed: 0, failures: [],
            brokenLinks: 0, brokenLinkList: [],
            pagesNeedingLogin: 0, loginPages: [],
            wafBlocked: 0, duplicatesSkipped: 0, sitemapUrls: 0, astrazenecaSeen: false,
            sitemapStale: 0, sitemapStaleList: [],
            imagesOcr: 0, imagesByNameOnly: 0, pdfsFull: 0, pdfsByNameOnly: 0,
            videosChecked: 0, videosWithoutId: 0, hiddenTextIds: 0,
            ocrAvailable: true, ocrNote: '',
            partial: false, partialReasons: []
        };
        const findings = new Map();
        const noIdFindings = [];
        let browser = null, context = null;
        const pages = [];
        let vaultStream = null;
        let shotSeq = 0;

        const saveShot = async (buf) => {
            if (!buf) return null;
            try { return await storage.saveShot(scanId, `s${++shotSeq}`, buf); } catch (e) { return null; }
        };

        const register = (id, type, pageUrl, assetUrl, snippet, screenshotRef) => {
            if (!findings.has(id)) {
                findings.set(id, { id, types: new Set(), pages: new Map(), assets: new Set(), snippet, screenshotRef });
            }
            const f = findings.get(id);
            f.types.add(type);
            if (!f.pages.has(pageUrl)) f.pages.set(pageUrl, true);
            if (assetUrl) f.assets.add(assetUrl);
            if (!f.screenshotRef && screenshotRef) f.screenshotRef = screenshotRef;
        };

        const emit = (step, status, progress, extra = {}) => sendSSE({
            scanId, step, status, progress,
            elapsed: Math.floor((Date.now() - startedAt) / 1000),
            pagesRead: coverage.pagesRead, idsFound: findings.size, ...extra
        });

        const fail = (url, reason) => {
            coverage.pagesFailed++;
            if (coverage.failures.length < 300) coverage.failures.push({ url, reason });
        };

        try {
            let parsed;
            try { parsed = new URL(targetUrl); } catch (e) { throw new Error('URL objetivo inválida.'); }
            if (!this.isAllowedHost(parsed.hostname)) {
                throw new Error(`Dominio no autorizado: ${parsed.hostname}. Revisa ALLOWED_DOMAINS en .env.`);
            }
            const baseDomain = parsed.hostname.toLowerCase().replace(/^www\./, '');
            this.hostCanon = { base: baseDomain, preferred: parsed.hostname.toLowerCase() };

            // PASO 1: sesiones
            emit(1, 'Verificando sesiones guardadas...', 3);
            const sessions = authManager.sessionStatus();
            if (!sessions.azmed) coverage.partialReasons.push('Sin sesión AzMed: no se auditaron páginas protegidas.');
            if (!sessions.promomats) coverage.partialReasons.push('Sin sesión PromoMats: no hay fechas fiables.');

            const vaultInit = await vaultClient.init();
            if (!vaultInit.success) coverage.partialReasons.push(`PromoMats no disponible: ${vaultInit.error}`);

            const ctx = await authManager.createScanContext();
            browser = ctx.browser;
            context = ctx.context;
            // Ventanas emergentes abiertas por clics: se cierran
            context.on('page', async (p) => { try { if (await p.opener()) await p.close(); } catch (e) {} });
            for (let i = 0; i < config.crawlConcurrency; i++) {
                const p = await context.newPage();
                p.on('dialog', d => d.dismiss().catch(() => {}));
                pages.push(p);
            }
            emit(1, `Sesiones: AzMed ${sessions.azmed ? 'OK' : 'NO'}, PromoMats ${vaultInit.success ? 'OK' : 'NO'}, Kaltura ${sessions.kaltura ? 'OK' : 'NO'}.`, 10);

            // PASO 2: descubrimiento
            emit(2, `Descubriendo subdominios de ${baseDomain}...`, 12);
            const subs = (await this.fetchSubdomains(baseDomain, pages[0])).filter(s => this.isAllowedHost(new URL(s).hostname));
            if (subs.length > 2) emit(2, `${subs.length - 2} subdominio(s) adicionales encontrados.`, 13);

            // Dos colas: primero lo enlazado desde las paginas (navegacion real del sitio) y despues lo que
            // solo aparece en sitemaps, que pueden estar desactualizados (azmed.cr lista rutas que dan 404).
            const queue = [], sitemapQueue = [], queued = new Set();
            const pendingPdfs = new Map(); // url -> pagina que lo enlaza
            const enqueue = (raw, depth, referrer, fromSitemap) => {
                const c = this.canonicalize(raw);
                if (!c || !this.isInScope(c, baseDomain)) return;
                const path = new URL(c).pathname;
                if (PDF_EXT.test(path)) { if (!pendingPdfs.has(c)) pendingPdfs.set(c, referrer || null); return; }
                if (SKIP_EXT.test(path) || queued.has(c)) return;
                queued.add(c);
                (fromSitemap ? sitemapQueue : queue).push({ url: c, depth, fromSitemap: !!fromSitemap });
            };
            enqueue(targetUrl, 0);
            // Subdominios de crt.sh: baja prioridad (como los sitemaps) y sin hosts de infraestructura
            subs.filter(s => !INFRA_HOST.test(new URL(s).hostname.replace(new RegExp(`\\.?${baseDomain.replace(/\./g, '\\.')}$`), '')))
                .forEach(s => enqueue(s, 0, null, true));
            // URLs indicadas por el usuario (micrositios o campañas sin enlace desde el sitio)
            extraUrls.forEach(u => enqueue(u, 0));

            // Sitemap AEM de la pagina de inicio (ej. /es/home.html -> /es/home.sitemap.xml)
            const extraMaps = /\.html$/i.test(parsed.pathname)
                ? [`${parsed.origin}${parsed.pathname.replace(/\.html$/i, '.sitemap.xml')}`] : [];
            const origins = [...new Set(subs.map(s => this.canonicalize(s)).filter(Boolean).map(s => new URL(s).origin))];
            if (!origins.includes(parsed.origin)) origins.unshift(parsed.origin);
            for (const origin of origins.slice(0, 25)) {
                if (this.isCancelled) break;
                emit(2, `Leyendo sitemap de ${origin}...`, 15);
                const urls = await this.fetchSitemapUrls(context.request, origin, baseDomain, origin === parsed.origin ? extraMaps : []);
                coverage.sitemapUrls += urls.length;
                urls.forEach(u => enqueue(u, 1, null, true));
            }
            emit(2, `${queue.length + sitemapQueue.length} URLs en cola (${sitemapQueue.length} solo desde sitemaps).`, 20);

            // Consulta de PromoMats en segundo plano mientras se rastrea
            vaultStream = vaultClient.createStream(
                (done, total) => {
                    if (this.vaultPhase) {
                        emit(4, `PromoMats (${done}/${total})...`,
                            75 + Math.floor((done / Math.max(total, 1)) * 22));
                    }
                },
                () => this.isCancelled
            );

            // PASO 3: rastreo en paralelo
            const visited = new Set();
            const seenAssets = new Set();
            const seenPdfs = new Set();
            let wafPauseUntil = 0;
            const waitWaf = async (extraMs) => {
                if (extraMs) wafPauseUntil = Math.max(wafPauseUntil, Date.now() + extraMs);
                while (Date.now() < wafPauseUntil && !this.isCancelled) await sleep(500);
            };

            // Registra un ID y, si es nuevo, lo manda a consultar a PromoMats
            const registerAndQueue = async (id, type, pageUrl, assetUrl, snippet, getShot) => {
                const isNew = !findings.has(id);
                const needsShot = getShot && (isNew || !findings.get(id).screenshotRef);
                const shot = needsShot ? await getShot(id) : null;
                register(id, type, pageUrl, assetUrl, snippet, shot);
                if (isNew) vaultStream.push(id);
            };

            const processPdf = async (absPdf, pageUrl, linkText, getShot) => {
                let decoded = absPdf;
                try { decoded = decodeURIComponent(absPdf); } catch (e) {}
                const name = decoded.split('/').pop();
                for (const id of new Set(`${decoded} ${linkText || ''}`.match(ID_RE()) || [])) {
                    await registerAndQueue(id, 'PDF', pageUrl, absPdf, `Nombre: ${name}`, getShot);
                }
                if (seenPdfs.has(absPdf) || !this.isInScope(absPdf, baseDomain)) return;
                seenPdfs.add(absPdf);
                try {
                    const res = await context.request.get(absPdf, { timeout: 30000 });
                    if (!res.ok()) { coverage.pdfsByNameOnly++; return; }
                    const body = await res.body();
                    if (body.length > MAX_PDF_BYTES) { coverage.pdfsByNameOnly++; return; }
                    const { text, method } = await ocr.readPdf(body);
                    if (method !== 'texto') { coverage.pdfsByNameOnly++; return; }
                    coverage.pdfsFull++;
                    for (const id of new Set(text.match(ID_RE()) || [])) {
                        const i = text.indexOf(id);
                        await registerAndQueue(id, 'PDF', pageUrl, absPdf,
                            `Contenido PDF (${name}): ${text.substring(Math.max(0, i - 50), i + 70).replace(/\s+/g, ' ')}`, getShot);
                    }
                } catch (e) { coverage.pdfsByNameOnly++; }
            };

            const processUrl = async (page, currentUrl, depth, fromSitemap) => {
                const nav = await this.navigate(page, currentUrl, waitWaf);
                if (nav.download) {
                    // El enlace descarga un archivo (o la navegacion se aborto): si es PDF se lee como documento
                    const head = await context.request.fetch(currentUrl, { method: 'HEAD', timeout: 15000 }).catch(() => null);
                    const ct = head ? (head.headers()['content-type'] || '').toLowerCase() : '';
                    if (ct.includes('pdf') || PDF_EXT.test(new URL(currentUrl).pathname)) {
                        pendingPdfs.delete(currentUrl);
                        await processPdf(currentUrl, currentUrl, '', null);
                    } else if (!ct || ct.includes('html')) {
                        fail(currentUrl, 'La navegación se interrumpió (net::ERR_ABORTED)');
                    }
                    return;
                }
                if (nav.error) {
                    if (nav.waf) coverage.wafBlocked++;
                    fail(currentUrl, nav.error);
                    return;
                }
                const response = nav.response;
                if (!response) { fail(currentUrl, 'Sin respuesta'); return; }

                if (await this.looksLikeLogin(page, response)) {
                    coverage.pagesNeedingLogin++;
                    if (coverage.loginPages.length < 300) coverage.loginPages.push(currentUrl);
                    return;
                }
                const status = response.status();
                if ((status === 404 || status === 410) && fromSitemap) {
                    // URL listada en el sitemap pero inexistente: problema del sitemap, no un enlace roto visible
                    coverage.sitemapStale++;
                    if (coverage.sitemapStaleList.length < 300) coverage.sitemapStaleList.push(currentUrl);
                    return;
                }
                if (status === 404 || status === 410) {
                    coverage.brokenLinks++;
                    if (coverage.brokenLinkList.length < 300) coverage.brokenLinkList.push(currentUrl);
                    return;
                }
                if (status >= 400) { fail(currentUrl, `HTTP ${status}`); return; }

                const ctype = (response.headers()['content-type'] || '').toLowerCase();
                if (ctype.includes('application/pdf')) { await processPdf(currentUrl, currentUrl, '', null); return; }
                if (!ctype.includes('text/html') && !ctype.includes('xhtml')) return;

                // Redirecciones: si la URL final ya se analizo, es la misma pagina
                const finalUrl = this.canonicalize(page.url()) || currentUrl;
                if (finalUrl !== currentUrl) {
                    if (!this.isInScope(finalUrl, baseDomain)) return;
                    if (visited.has(finalUrl)) { coverage.duplicatesSkipped++; return; }
                    visited.add(finalUrl);
                }

                await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
                await this.preparePage(page);
                await this.autoScroll(page);
                await this.preparePage(page);

                const data = await this.extractPageData(page, baseDomain);

                // Misma pagina publicada con dos rutas (AEM: /content/<sitio>/es/home/x.html y /es/home/x.html).
                // Solo se confia en la canonical si una ruta termina en la otra (evita canonicals mal configuradas).
                const canon = data.canonical ? this.canonicalize(data.canonical) : null;
                if (canon && canon !== finalUrl && this.isInScope(canon, baseDomain)) {
                    const pa = new URL(canon).pathname, pb = new URL(finalUrl).pathname;
                    if (pa.endsWith(pb) || pb.endsWith(pa)) {
                        if (visited.has(canon)) { coverage.duplicatesSkipped++; return; }
                        visited.add(canon);
                    }
                }

                coverage.pagesRead++;
                if (!coverage.astrazenecaSeen && /astrazeneca/i.test(data.text)) coverage.astrazenecaSeen = true;
                const total = Math.min(config.maxPages, coverage.pagesRead + queue.length + sitemapQueue.length);
                emit(3, `Analizando (${coverage.pagesRead}/${total}): ${finalUrl}`,
                    Math.min(20 + Math.floor((coverage.pagesRead / Math.max(total, 1)) * 50), 70));

                if (depth < config.maxDepth) data.links.forEach(l => enqueue(l, depth + 1, finalUrl));

                // La captura se toma por ID, centrada en donde aparece el codigo
                const shotCache = new Map();
                const getShot = async (id) => {
                    if (shotCache.has(id)) return shotCache.get(id);
                    const s = await saveShot(await this.captureEvidence(page, id));
                    shotCache.set(id, s);
                    return s;
                };

                // TEXTO (visible y oculto)
                const byId = new Map();
                for (const h of data.hits) {
                    const prev = byId.get(h.id);
                    if (!prev || (prev.hidden && !h.hidden)) byId.set(h.id, h);
                }
                for (const id of new Set(data.text.match(ID_RE()) || [])) {
                    if (!byId.has(id)) {
                        const idx = data.text.indexOf(id);
                        byId.set(id, { id, hidden: false, snippet: data.text.substring(Math.max(0, idx - 60), idx + 90).replace(/\s+/g, ' ') });
                    }
                }
                for (const [id, h] of byId) {
                    if (h.hidden) coverage.hiddenTextIds++;
                    await registerAndQueue(id, 'Texto', finalUrl, null,
                        h.hidden ? `[Contenido oculto: acordeón/pestaña/modal] ${h.snippet}` : h.snippet, getShot);
                }
                for (const m of data.metas) {
                    for (const id of (m.match(ID_RE()) || [])) await registerAndQueue(id, 'Texto', finalUrl, null, m, getShot);
                }

                // IMAGENES
                let ocrCount = 0;
                for (const img of data.images) {
                    if (this.isCancelled) break;
                    const absSrc = img.src;
                    let decoded = absSrc;
                    try { decoded = decodeURIComponent(absSrc); } catch (e) {}
                    for (const id of new Set(`${decoded} ${img.alt}`.match(ID_RE()) || [])) {
                        await registerAndQueue(id, 'Imagen', finalUrl, absSrc, `Nombre/alt: ${decoded}`, getShot);
                    }

                    if (seenAssets.has(absSrc)) continue;
                    seenAssets.add(absSrc);

                    let readByOcr = false;
                    const bigEnough = (img.w >= 250 || img.h >= 150) || (!img.w && !img.h);
                    if (ocr.isAvailable() && !SVG_EXT.test(absSrc) && bigEnough && ocrCount < config.maxOcrImagesPerPage) {
                        try {
                            const res = await context.request.get(absSrc, { timeout: 15000 });
                            const itype = (res.headers()['content-type'] || '').toLowerCase();
                            if (res.ok() && itype.startsWith('image/') && !itype.includes('svg')) {
                                const body = await res.body();
                                if (body.length < MAX_IMG_BYTES && body.length > 2000) {
                                    const text = await Promise.race([
                                        ocr.recognizeImage(body),
                                        new Promise(resolve => setTimeout(() => resolve(null), OCR_TIMEOUT_MS))
                                    ]);
                                    if (text !== null) {
                                        coverage.imagesOcr++; ocrCount++; readByOcr = true;
                                        for (const id of new Set(text.match(ID_RE()) || [])) {
                                            await registerAndQueue(id, 'Imagen', finalUrl, absSrc,
                                                `OCR: ${text.replace(/\s+/g, ' ').substring(0, 120)}`, getShot);
                                        }
                                    }
                                }
                            }
                        } catch (e) {}
                    }
                    if (!readByOcr) coverage.imagesByNameOnly++;
                }

                // PDF enlazados: se descargan con la API de peticiones (no se navega a ellos)
                for (const pdf of data.pdfs) {
                    const absPdf = this.canonicalize(pdf.href);
                    if (!absPdf) continue;
                    pendingPdfs.delete(absPdf);
                    await processPdf(absPdf, finalUrl, pdf.text, getShot);
                }

                // VIDEOS
                const seenVideo = new Set();
                for (const v of data.videos) {
                    if (seenVideo.has(v.src)) continue;
                    seenVideo.add(v.src);
                    coverage.videosChecked++;
                    let ids = [];
                    let snippet = v.src;

                    if (/kaltura/i.test(v.src)) {
                        const meta = await kalturaClient.getEntryMetadata(v.src);
                        if (meta.ok) { ids = meta.ids; snippet = `Kaltura "${meta.name}" (${meta.entryId})`; }
                    }
                    if (ids.length === 0) ids = [...new Set(`${v.src} ${v.title} ${v.context}`.match(ID_RE()) || [])];

                    if (ids.length) {
                        for (const id of ids) await registerAndQueue(id, 'Video', finalUrl, v.src, snippet, getShot);
                    } else {
                        coverage.videosWithoutId++;
                        noIdFindings.push({ type: 'Video', pageUrl: finalUrl, assetUrl: v.src, screenshot: await saveShot(await this.captureEvidence(page, '')) });
                    }
                }
            };

            // MAX_PAGES cuenta paginas leidas; el tope de intentos evita bucles con sitios llenos de 404
            const limitReached = () => coverage.pagesRead >= config.maxPages ||
                (visited.size - coverage.sitemapStale) >= config.maxPages * 3;
            let active = 0;
            const worker = async (index) => {
                while (!this.isCancelled) {
                    if (limitReached()) break;
                    // Las URLs solo-sitemap se toman cuando ya se leyo alguna pagina (o no queda otra cosa)
                    const sitemapAllowed = coverage.pagesRead > 0 || active === 0;
                    const item = queue.shift() || (sitemapAllowed ? sitemapQueue.shift() : null);
                    if (!item) {
                        if (active === 0) break;
                        await sleep(300);
                        continue;
                    }
                    if (visited.has(item.url)) continue;
                    visited.add(item.url);
                    active++;
                    try {
                        if (pages[index].isClosed()) {
                            pages[index] = await context.newPage();
                            pages[index].on('dialog', d => d.dismiss().catch(() => {}));
                        }
                        await processUrl(pages[index], item.url, item.depth, item.fromSitemap);
                    } catch (e) {
                        fail(item.url, (e.message || String(e)).split('\n')[0]);
                    } finally {
                        active--;
                    }
                }
            };
            await Promise.all(pages.map((_, i) => worker(i)));

            if (this.isCancelled) {
                coverage.partial = true;
                coverage.partialReasons.push('Escaneo cancelado por el usuario; se conserva lo detectado.');
            }

            // PDF descubiertos (sitemap/enlaces) que no se procesaron desde ninguna pagina
            if (!this.isCancelled && pendingPdfs.size) {
                let n = 0;
                for (const [pdfUrl, referrer] of pendingPdfs) {
                    if (this.isCancelled) break;
                    if (seenPdfs.has(pdfUrl)) continue;
                    emit(3, `Leyendo PDF (${++n}/${pendingPdfs.size}): ${pdfUrl}`, 72);
                    await processPdf(pdfUrl, referrer || pdfUrl, '', null);
                }
            }

            // Estado del OCR
            const ocrStatus = ocr.getStatus();
            coverage.ocrAvailable = ocrStatus.available;
            coverage.ocrNote = ocrStatus.reason;
            if (!ocrStatus.available) {
                coverage.partial = true;
                coverage.partialReasons.push(`OCR no disponible (${ocrStatus.reason}); las imágenes solo se leyeron por nombre y texto alternativo.`);
            }

            const leftover = queue.length + sitemapQueue.length;
            if (!this.isCancelled && leftover > 0 && limitReached()) {
                coverage.partial = true;
                coverage.partialReasons.push(`Se alcanzó el límite de ${config.maxPages} páginas (MAX_PAGES); quedaron ${leftover} URLs sin visitar.`);
            }
            if (coverage.wafBlocked > 0) {
                coverage.partial = true;
                coverage.partialReasons.push(`${coverage.wafBlocked} página(s) bloqueadas por el WAF del sitio incluso tras reintentar. Baja CRAWL_CONCURRENCY en .env.`);
            }
            if (coverage.pagesFailed > 0) {
                coverage.partial = true;
                coverage.partialReasons.push(`${coverage.pagesFailed} página(s) no se pudieron leer (ver "Páginas con error").`);
            }

            if (coverage.pagesRead === 0) {
                if (this.isCancelled) throw new Error('Escaneo cancelado antes de leer ninguna página.');
                let reason = 'No se pudo leer ninguna página.';
                if (coverage.pagesNeedingLogin > 0) reason += ' Las páginas exigen sesión válida de AzMed.';
                else if (coverage.failures.length) reason += ` Último error: ${coverage.failures[0].reason}.`;
                else reason += ' Verifica red y que el sitio no esté bloqueando el acceso.';
                throw new Error(reason);
            }

            if (!coverage.astrazenecaSeen) {
                coverage.partial = true;
                coverage.partialReasons.unshift('ATENCIÓN: ninguna página leída menciona "AstraZeneca". Verifica que el dominio escaneado sea el sitio correcto.');
            }

            if (coverage.pagesNeedingLogin > 0) {
                coverage.partial = true;
                // Se guarda una pagina protegida para validar la sesion de AzMed de forma fiable en adelante
                authManager.rememberProtectedUrl(baseDomain, coverage.loginPages[0]);
                if (sessions.azmed) {
                    authManager.validation.azmed = {
                        state: 'expired',
                        detail: `Durante el escaneo ${coverage.pagesNeedingLogin} página(s) pidieron inicio de sesión`,
                        checkedAt: new Date().toISOString()
                    };
                    coverage.partialReasons.push(`${coverage.pagesNeedingLogin} página(s) pidieron inicio de sesión: la sesión de AzMed expiró o no tiene permisos. Vuelve a iniciar sesión y repite el escaneo.`);
                } else {
                    coverage.partialReasons.push(`${coverage.pagesNeedingLogin} página(s) exigen sesión de AzMed y no se auditaron.`);
                }
            }

            // PASO 4: esperar a que terminen las consultas pendientes a PromoMats
            this.vaultPhase = true;
            const ids = [...findings.keys()];
            emit(4, `Verificando ${ids.length} Approval IDs en PromoMats...`, 75);
            const vaultResults = await vaultStream.finish();
            vaultStream = null;

            const assets = [];
            for (const id of ids) {
                const f = findings.get(id);
                const v = vaultResults.get(id) || {
                    status: 'SIN FECHA FIABLE', approvedDate: null, expirationDate: null,
                    daysRemaining: null, note: 'No se consultó en PromoMats'
                };
                const pageList = [...f.pages.keys()];
                assets.push({
                    id: assets.length + 1,
                    veevaApprovalId: id,
                    type: [...f.types].join(' + '),
                    region, country,
                    status: v.status,
                    approvedDate: v.approvedDate,
                    expirationDate: v.expirationDate,
                    daysRemaining: v.daysRemaining,
                    note: v.note,
                    location: pageList[0],
                    assetUrl: [...f.assets][0] || '',
                    pagesCount: pageList.length,
                    pages: pageList,
                    snippet: f.snippet,
                    screenshot: f.screenshotRef
                });
            }

            // Materiales sin ID (videos con URL propia y sin codigo)
            const seenNoId = new Set();
            noIdFindings.forEach(nf => {
                if (seenNoId.has(nf.assetUrl) || seenNoId.size >= 200) return;
                seenNoId.add(nf.assetUrl);
                assets.push({
                    id: assets.length + 1, veevaApprovalId: 'SIN ID', type: nf.type, region, country,
                    status: 'SIN ID', approvedDate: null, expirationDate: null, daysRemaining: null,
                    note: 'Material sin Approval ID visible (hallazgo de cumplimiento)',
                    location: nf.pageUrl, assetUrl: nf.assetUrl, pagesCount: 1, pages: [nf.pageUrl],
                    snippet: nf.assetUrl, screenshot: nf.screenshot
                });
            });

            // Cada fila cae en exactamente una categoria
            const count = (s) => assets.filter(a => a.status === s).length;
            const vencidos = count('VENCIDO');
            const proximos = count('PROXIMO A VENCER');
            const vigentes = count('VIGENTE');
            const sinFecha = assets.length - vencidos - proximos - vigentes;

            const summary = {
                scanId,
                totalAnalyzed: assets.length,
                vencidos,
                proximosAVencer: proximos,
                vigentes,
                sinFechaFiable: sinFecha,
                pagesScanned: coverage.pagesRead,
                imagesAnalyzed: coverage.imagesOcr + coverage.imagesByNameOnly,
                durationSeconds: Math.floor((Date.now() - startedAt) / 1000),
                outcome: coverage.partial ? 'PARCIAL' : 'COMPLETO',
                coverage,
                assets
            };

            emit(4, coverage.partial ? 'Escaneo finalizado de forma PARCIAL.' : 'Escaneo finalizado.', 100, { done: true });
            return summary;
        } catch (error) {
            emit(4, `Error: ${error.message}`, 100, { error: true });
            throw error;
        } finally {
            if (vaultStream) { try { await vaultStream.finish(); } catch (e) {} }
            if (browser) await browser.close().catch(() => {});
            await vaultClient.close();
            await ocr.close();
            this.hostCanon = null;
            this.running = false;
        }
    }

    // Diagnostico de PromoMats (usado por /api/vault/inspect/:id)
    async inspectVault(approvalId) {
        const init = await vaultClient.init();
        if (!init.success) return { error: init.error };
        try {
            return await vaultClient.inspect(approvalId);
        } finally {
            await vaultClient.close();
        }
    }

    // Diagnostico de captura: abre una URL, acepta avisos y devuelve la imagen (usado por /api/capture-test)
    async captureTest(url) {
        const ctx = await authManager.createScanContext();
        try {
            const page = await ctx.context.newPage();
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.pageTimeout });
            await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});
            const clicks = await this.dismissOverlays(page);
            await this.preparePage(page);
            const buf = await page.screenshot({ type: 'jpeg', quality: 60 });
            return { clicks, image: `data:image/jpeg;base64,${buf.toString('base64')}` };
        } finally {
            await ctx.browser.close().catch(() => {});
        }
    }
}

module.exports = new ScannerEngine();
