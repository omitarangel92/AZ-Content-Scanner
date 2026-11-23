'use strict';
// Diagnóstico de red del login: mide DNS, conexión y carga real en Chrome de cada portal que usa la app, y dice si un
// cuelgue viene de la red/proxy/firewall (no del código) o de lentitud. Uso: npm run diagnose
const dns = require('node:dns').promises;
const net = require('node:net');
const { chromium } = require('playwright');
const config = require('../server/config');

const vault = config.services.promomats.host || 'astrazeneca-promomats.veevavault.com';
const TARGETS = [
    ['Veeva login', 'login.veevavault.com', 'https://login.veevavault.com/'],
    ['PromoMats', vault, `https://${vault}/ui/`],
    ['Azure B2C (login corporativo)', 'azcollaborationb2cprd.b2clogin.com', 'https://azcollaborationb2cprd.b2clogin.com/'],
    ['Microsoft login', 'login.microsoftonline.com', 'https://login.microsoftonline.com/'],
    ['AzMed', 'www.azmed.cr', 'https://www.azmed.cr/']
];
const SLOW_MS = 8000;

const t0 = () => Date.now();
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

async function nodeProbe(host) {
    const out = { dns: null, tcp: null };
    let s = t0();
    try { await withTimeout(dns.lookup(host), 8000); out.dns = t0() - s; } catch (e) { out.dns = e.message; return out; }
    s = t0();
    try {
        await withTimeout(new Promise((res, rej) => { const c = net.connect(443, host, () => { c.destroy(); res(); }); c.on('error', rej); }), 8000);
        out.tcp = t0() - s;
    } catch (e) { out.tcp = e.message; }
    return out;
}

async function launch(extra) {
    const opts = { headless: true, args: ['--disable-quic', ...(config.allowInsecureTls ? ['--ignore-certificate-errors'] : [])], ...extra };
    for (const channel of ['chrome', 'msedge', null]) {
        try { return await chromium.launch(channel ? { ...opts, channel } : opts); }
        catch (e) { if (!channel) throw e; }
    }
}

async function browserProbe(browser, url) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: config.allowInsecureTls });
    const page = await ctx.newPage();
    const s = t0();
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        const ms = t0() - s;
        const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { ttfb: Math.round(n.responseStart) } : {}; }).catch(() => ({}));
        return { ok: true, ms, ttfb: nav.ttfb, error: null };
    } catch (e) {
        const m = (e.message.match(/net::ERR_[A-Z_]+/) || [e.message.split('\n')[0]])[0];
        return { ok: false, ms: t0() - s, error: m };
    } finally { await ctx.close().catch(() => {}); }
}

function verdict(node, b) {
    if (typeof node.dns === 'string') return 'NO RESUELVE el nombre (DNS): falta VPN/Zscaler o la red lo bloquea. No es el código.';
    if (b.ok && b.ms >= SLOW_MS) return `LENTO (${(b.ms / 1000).toFixed(1)} s): latencia de la red. No es el código.`;
    if (b.ok) return typeof node.tcp === 'string' ? 'OK (sale por el proxy del sistema).' : 'OK';
    if (/TIMED_OUT|CONNECTION_(TIMED_OUT|RESET|REFUSED|CLOSED)|ADDRESS_UNREACHABLE/.test(b.error)) return `BLOQUEADO/SIN RESPUESTA (${b.error}): firewall, proxy o VPN. No es el código.`;
    if (/CERT|SSL/.test(b.error)) return `CERTIFICADO (${b.error}): el proxy rompe el TLS. Prueba ALLOW_INSECURE_TLS=true o NODE_EXTRA_CA_CERTS.`;
    if (/PROXY/.test(b.error)) return `PROXY (${b.error}): revisa PROXY_SERVER y credenciales.`;
    return `FALLO (${b.error})`;
}

(async () => {
    console.log(`Proxy configurado: ${config.proxy ? config.proxy.server : '(ninguno: usa el del sistema)'}  |  TLS inseguro: ${config.allowInsecureTls}\n`);
    let browser;
    try { browser = await launch(config.proxy ? { proxy: config.proxy } : {}); }
    catch (e) { console.log('No se pudo abrir Chrome/Chromium:', e.message.split('\n')[0], '\nEjecuta: npx playwright install chromium'); process.exit(1); }
    console.log(`Navegador: ${browser.version()}\n`);
    let bad = 0, slow = 0;
    for (const [label, host, url] of TARGETS) {
        const node = await nodeProbe(host);
        const b = await browserProbe(browser, url);
        const v = verdict(node, b);
        if (!b.ok) bad++; else if (b.ms >= SLOW_MS) slow++;
        console.log(`• ${label}  (${host})`);
        console.log(`    DNS: ${typeof node.dns === 'number' ? node.dns + ' ms' : node.dns} | TCP directo: ${typeof node.tcp === 'number' ? node.tcp + ' ms' : node.tcp} | Chrome: ${b.ok ? b.ms + ' ms' + (b.ttfb ? ` (1.er byte ${b.ttfb} ms)` : '') : b.error + ' tras ' + b.ms + ' ms'}`);
        console.log(`    → ${v}\n`);
    }
    await browser.close().catch(() => {});
    if (bad) console.log(`RESULTADO: ${bad} portal(es) no responden desde este equipo. El cuelgue del login es de la red (proxy/VPN/firewall), no del código: pide a TI que permitan esos dominios o define PROXY_SERVER en el .env.`);
    else if (slow) console.log(`RESULTADO: todo responde pero ${slow} portal(es) van lentos. El login tardará; es latencia de la red. Puedes subir SESSION_SETTLE_SECONDS en el .env.`);
    else console.log('RESULTADO: la red responde bien a todos los portales. Si el login se cuelga igual, avísame con el mensaje exacto: sería el flujo de la app.');
    process.exit(0);
})();
