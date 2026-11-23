const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const storage = require('./storage');
const { atomicWriteSync } = require('./fsutil');
const { isLoginUrl } = require('./loginDetect');

// El WAF (CloudFront) del sitio bloquea el user-agent "HeadlessChrome" en peticiones directas
// (sitemaps, PDF, imagenes). Se usa el user-agent de un Chrome normal con la misma version.
function browserUserAgent(browser) {
    const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
        : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
    return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
}

// Cuentas que usa el escaneo. Kaltura se retiró: los metadatos de los videos se leen con una sesión de widget anónima
// (kalturaClient) y su login no influía en el resultado.
const SERVICES = ['azmed', 'promomats'];

class AuthManager {
    constructor() {
        this.pending = {};
        // Ultimo resultado de validacion por servicio: { state, checkedAt, detail }
        this.validation = {};
    }

    sessionPath(service) {
        return path.join(config.sessionsDir, `${service}.json`);
    }

    hasSession(service) {
        return fs.existsSync(this.sessionPath(service));
    }

    // Solo indica si existe el archivo de sesion (no si sigue siendo valida)
    sessionStatus() {
        return {
            azmed: this.hasSession('azmed'),
            promomats: this.hasSession('promomats')
        };
    }

    // Estado combinado: login en curso > archivo + ultima validacion real
    getSessionStates() {
        const out = {};
        for (const svc of SERVICES) {
            const exists = this.hasSession(svc);
            const v = this.validation[svc];
            if (this.pending[svc]) out[svc] = { state: 'waiting', detail: 'Esperando a que termines de iniciar sesión en la ventana del navegador…', checkedAt: null };
            else if (!exists) out[svc] = { state: 'none', detail: (v && v.detail) || 'Sin sesión guardada', checkedAt: null };
            else if (!v) out[svc] = { state: 'unknown', detail: 'Sesión guardada, sin comprobar', checkedAt: null };
            else out[svc] = v;
        }
        return out;
    }

    // Host donde termina un login correcto de cada servicio
    serviceHost(service, url) {
        if (service === 'promomats') return (config.services.promomats.host || '').toLowerCase();
        try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
    }

    // Abre un navegador visible para que el usuario inicie sesion (incluido MFA). Se detecta
    // automaticamente cuando el login termino (vuelve al servicio sin pedir contraseña):
    // entonces se guarda la sesion, se cierra la ventana y el estado pasa a "activa".
    // protectedStart: la URL inicial exige login (si carga sin pedirlo, la sesion ya era valida).
    async startLogin(service, url, protectedStart = true) {
        if (!fs.existsSync(config.sessionsDir)) fs.mkdirSync(config.sessionsDir, { recursive: true });
        await this.cancelLogin(service);

        // Ventana de login: se usa el Chrome instalado (si existe) y sin las marcas de automatización: los portales de
        // inicio de sesión (Azure B2C / SAML de PromoMats) se quedaban en blanco con el Chromium de pruebas.
        // Se parte de un perfil limpio: unas cookies caducadas de la sesión anterior rompen el flujo SAML.
        const launchOpts = {
            headless: false,
            ...(config.proxy ? { proxy: config.proxy } : {}),
            ignoreDefaultArgs: ['--enable-automation'],
            // --disable-quic: en redes corporativas el tráfico UDP/QUIC suele bloquearse y las cargas se quedan colgadas
            args: ['--disable-blink-features=AutomationControlled', '--disable-quic', ...(config.allowInsecureTls ? ['--ignore-certificate-errors'] : [])]
        };
        let browser;
        for (const channel of ['chrome', 'msedge', null]) {
            try {
                browser = await chromium.launch(channel ? { ...launchOpts, channel } : launchOpts);
                break;
            } catch (e) {
                if (!channel) throw e;   // ni Chrome, ni Edge, ni el Chromium incluido: se informa del error
            }
        }
        const context = await browser.newContext({
            ignoreHTTPSErrors: config.allowInsecureTls,
            viewport: null
        });
        await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
        const page = await context.newPage();
        const pending = {
            browser, context, host: this.serviceHost(service, url), protectedStart, startUrl: url, retries: 0,
            sawLogin: false, stable: 0, busy: false, timer: null, expireTimer: null
        };
        this.pending[service] = pending;

        browser.on('disconnected', () => {
            clearInterval(pending.timer); clearInterval(pending.blankTimer);
            clearTimeout(pending.expireTimer);
            if (this.pending[service] !== pending) return; // ya se guardo o se cancelo
            delete this.pending[service];
            // Ventana cerrada sin que se detectara el login: NO se guarda (antes se guardaba un login a medias)
            this.validation[service] = {
                state: this.hasSession(service) ? ((this.validation[service] || {}).state || 'unknown') : 'none',
                detail: 'Se cerró la ventana antes de terminar el inicio de sesión. Pulsa "Iniciar sesión" de nuevo.',
                checkedAt: new Date().toISOString()
            };
        });

        // Sin await: la ventana se abre y el panel responde al instante; la carga lenta no bloquea nada
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        // Comprobacion ligera cada 2 s (solo lee la URL y busca el campo de contraseña: no abre pestañas)
        pending.timer = setInterval(() => this.checkLogin(service, pending).catch(() => {}), 2000);
        // El portal de login (Azure B2C) puede tardar de 10 a 60 s en responder: recargar antes de tiempo reinicia esa
        // carga y empeora la espera. Solo se recarga una página que lleve más de 90 s EN BLANCO en la misma URL (máx. 2 veces).
        let reloads = 0;
        let stuck = { url: '', since: Date.now() };
        pending.blankTimer = setInterval(async () => {
            if (this.pending[service] !== pending || reloads >= 2) return;
            const pg = pending.context.pages()[pending.context.pages().length - 1];
            if (!pg) return;
            const blank = await pg.evaluate(() => !document.body || ((document.body.innerText || '').trim().length === 0 && !document.querySelector('input, button, a'))).catch(() => false);
            const url = pg.url();
            if (!blank || url !== stuck.url) { stuck = { url, since: Date.now() }; return; }
            if (Date.now() - stuck.since > 90000) {
                reloads++;
                stuck = { url, since: Date.now() };
                await pg.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            }
        }, 10000);
        // Una ventana olvidada se cierra sola a los 15 minutos
        pending.expireTimer = setTimeout(() => this.cancelLogin(service), 15 * 60 * 1000);
        return { success: true, message: 'Se abrió una ventana del navegador. Inicia sesión (incluido MFA); al terminar se guardará sola y se cerrará.' };
    }

    async checkLogin(service, pending) {
        if (pending.busy || this.pending[service] !== pending) return;
        pending.busy = true;
        try {
            const pages = pending.context.pages();
            if (!pages.length) return;
            const page = pages[pages.length - 1];
            const u = page.url().toLowerCase();
            // Página de error de Chrome (ERR_TIMED_OUT, proxy, DNS…): no se queda esperando, se cierra todo y se avisa
            const errPage = u.startsWith('chrome-error:') || await page.evaluate(() => /\bERR_[A-Z_]{4,}\b/.test((document.body && document.body.innerText) || '')).catch(() => false);
            if (errPage) {
                pending.errSince = pending.errSince || Date.now();
                // Una red lenta o inestable falla a veces y a la siguiente carga: se reintenta la carga hasta 3 veces
                if (Date.now() - pending.errSince > 8000 && (pending.retries || 0) < 3) {
                    pending.retries = (pending.retries || 0) + 1;
                    pending.errSince = 0;
                    console.log(`[sesión] ${service}: el portal no respondió, reintentando la carga (${pending.retries}/3)…`);
                    page.goto(pending.startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
                    return;
                }
                if (Date.now() - pending.errSince > 8000) {
                    await this.abortLogin(service, pending, 'El portal de inicio de sesión no respondió (ERR_TIMED_OUT: suele ser el proxy, la VPN o el firewall de la empresa). Se cerró la ventana. Revisa la red o define PROXY_SERVER en el .env y pulsa "Iniciar sesión" de nuevo.');
                }
                return;
            }
            pending.errSince = 0;
            const onLogin = isLoginUrl(u);
            const pwd = await page.$('input[type="password"]').catch(() => null);
            const pwdVisible = pwd ? await pwd.isVisible().catch(() => false) : false;
            if (onLogin || pwdVisible) { pending.sawLogin = true; pending.stable = 0; return; }

            let h = '';
            try { h = new URL(u).hostname; } catch (e) {}
            const base = pending.host.replace(/^www\./, '');
            const onService = !!base && (h === base || h.endsWith('.' + base));
            if (!onService) { pending.stable = 0; return; }

            pending.stable++;
            const done = (pending.sawLogin && pending.stable >= 2) ||          // volvio del login al servicio
                         (!pending.sawLogin && pending.protectedStart && pending.stable >= 3); // ya estaba dentro
            if (done) await this.completeLogin(service, pending);
        } finally {
            pending.busy = false;
        }
    }

    // Cookies + localStorage de las paginas abiertas. No usa context.storageState(): este abre
    // pestañas ocultas para leer cada origen y, en la ventana visible, hacia parpadear la pantalla.
    // También guarda sessionStorage (Playwright no lo incluye): Algunos portales guardan allí el token de
    // sesión, y sin él cada navegador nuevo pide iniciar sesión otra vez ("no se guarda el login").
    async lightState(context) {
        const cookies = await context.cookies();
        const byOrigin = new Map();
        const bySession = new Map();
        for (const page of context.pages()) {
            for (const frame of page.frames()) {
                try {
                    const data = await frame.evaluate(() => ({
                        origin: location.origin,
                        items: Object.keys(localStorage).map(k => ({ name: k, value: localStorage.getItem(k) })),
                        session: Object.keys(sessionStorage).map(k => ({ name: k, value: sessionStorage.getItem(k) }))
                    }));
                    if (!data.origin || data.origin === 'null') continue;
                    if (data.items.length) byOrigin.set(data.origin, data.items);
                    if (data.session.length) bySession.set(data.origin, data.session);
                } catch (e) {}
            }
        }
        return {
            cookies,
            origins: [...byOrigin].map(([origin, localStorage]) => ({ origin, localStorage })),
            sessionStorage: [...bySession].map(([origin, items]) => ({ origin, items }))
        };
    }

    // Vuelve a guardar la sesión con las cookies renovadas por el propio servicio (las sesiones deslizantes se alargan
    // con cada uso). Solo se llama tras comprobar que el acceso funciona, para no sobrescribir con un estado cerrado.
    // Conserva el almacenamiento de orígenes que no estén abiertos ahora.
    async persistState(service, context) {
        try {
            const state = await this.lightState(context);
            if (!state.cookies.length && !state.origins.length && !state.sessionStorage.length) return false;
            let old = {};
            try { old = JSON.parse(fs.readFileSync(this.sessionPath(service), 'utf8')); } catch (e) {}
            const keep = (oldList, newList, key) => {
                const have = new Set(newList.map(x => x.origin));
                return [...newList, ...(oldList || []).filter(x => !have.has(x.origin))];
            };
            state.origins = keep(old.origins, state.origins);
            state.sessionStorage = keep(old.sessionStorage, state.sessionStorage);
            this.writeSession(service, state);
            return true;
        } catch (e) { return false; }
    }

    // Restaura el sessionStorage guardado en cada página nueva del contexto (storageState de Playwright no lo hace)
    async restoreSessionStorage(context, service) {
        let entries = [];
        try { entries = JSON.parse(fs.readFileSync(this.sessionPath(service), 'utf8')).sessionStorage || []; } catch (e) {}
        if (!entries.length) return;
        await context.addInitScript((list) => {
            try {
                const e = list.find(x => x.origin === location.origin);
                if (e) for (const it of e.items) if (sessionStorage.getItem(it.name) === null) sessionStorage.setItem(it.name, it.value);
            } catch (err) { /* página sin acceso a sessionStorage */ }
        }, entries);
    }

    // Espera a que el servicio termine de resolver el acceso (redirecciones de login, SSO silencioso con las cookies de
    // Microsoft guardadas…) en lugar de decidir a los 5 s: el login corporativo tarda 10–60 s en esta red.
    // Devuelve 'active' | 'expired' (pide credenciales) | 'unknown' (no respondió a tiempo: no es lo mismo que expirada).
    async settleAccess(page, service, maxMs) {
        const vaultHost = (config.services.promomats.host || '').toLowerCase();
        const start = Date.now();
        let clickedSso = false, okSince = 0;
        const visible = async (sel) => {
            const el = await page.$(sel).catch(() => null);
            return el ? await el.isVisible().catch(() => false) : false;
        };
        while (Date.now() - start < maxMs) {
            await page.waitForTimeout(1000);
            const url = page.url().toLowerCase();
            let host = '';
            try { host = new URL(url).hostname; } catch (e) {}
            const pwd = await visible('input[type="password"]');
            const loginUrl = isLoginUrl(url);

            let signedIn = false;
            if (service === 'promomats') signedIn = !!vaultHost && host === vaultHost && !loginUrl && !pwd;
            else signedIn =!loginUrl && !pwd && host !== '' && !/identity\.|login\./.test(host);

            if (signedIn) { okSince = okSince || Date.now(); if (Date.now() - okSince >= 2500) return 'active'; continue; }
            okSince = 0;

            // Pantalla de Veeva con el botón de SSO de AstraZeneca: se pulsa una vez; con las cookies de Microsoft
            // guardadas el acceso es silencioso y no pide credenciales.
            if (service === 'promomats' && !clickedSso && host === 'login.veevavault.com') {
                const btn = page.locator('text=/log in with/i').first();
                if (await btn.count().catch(() => 0)) { clickedSso = true; await btn.click({ timeout: 3000 }).catch(() => {}); continue; }
            }
            // Un formulario de contraseña o de correo visible = pide credenciales: no hay forma silenciosa, expiró
            if (pwd || (await visible('input[name="loginfmt"], input[type="email"]')) ) return 'expired';
        }
        return 'unknown';
    }

    async completeLogin(service, pending) {
        if (this.pending[service] !== pending) return;
        clearInterval(pending.timer); clearInterval(pending.blankTimer);
        clearTimeout(pending.expireTimer);
        let state = null;
        try { state = await this.lightState(pending.context); } catch (e) {}
        delete this.pending[service];
        await pending.browser.close().catch(() => {});
        if (!state) {
            this.validation[service] = { state: 'error', detail: 'No se pudo leer la sesión del navegador. Inténtalo de nuevo.', checkedAt: new Date().toISOString() };
            return;
        }
        this.writeSession(service, state);
        this.validation[service] = { state: 'active', detail: 'Sesión iniciada correctamente', checkedAt: new Date().toISOString() };
        console.log(`[sesión] ${service}: inicio de sesión detectado y guardado (${state.cookies.length} cookies).`);
    }

    writeSession(service, state) {
        if (!fs.existsSync(config.sessionsDir)) fs.mkdirSync(config.sessionsDir, { recursive: true });
        const file = this.sessionPath(service);
        atomicWriteSync(file, JSON.stringify(state), { mode: 0o600 });
        try { fs.chmodSync(file, 0o600); } catch (e) {}
    }

    // "Guardar ahora": para cuando la deteccion automatica no reconoce el final del login
    async finishLogin(service) {
        const p = this.pending[service];
        if (!p) {
            const v = this.validation[service];
            if (v && v.state === 'active' && this.hasSession(service)) return { success: true, message: 'La sesión ya estaba guardada.' };
            return { success: false, error: 'No hay una ventana de inicio de sesión abierta. Pulsa "Iniciar sesión" primero.' };
        }
        // La ventana debe haber vuelto al servicio (no estar en el login, en la verificación de Microsoft ni en blanco)
        const pages = p.context.pages();
        const last = pages[pages.length - 1];
        const curUrl = last ? last.url() : '';
        let curHost = '';
        try { curHost = new URL(curUrl).hostname.toLowerCase(); } catch (e) {}
        const base = (p.host || '').replace(/^www\./, '');
        const onService = !!base && (curHost === base || curHost.endsWith('.' + base));
        const pwd = last ? await last.$('input[type="password"]').catch(() => null) : null;
        const pwdVisible = pwd ? await pwd.isVisible().catch(() => false) : false;
        if (!onService || isLoginUrl(curUrl.toLowerCase()) || pwdVisible) {
            return {
                success: false,
                error: `Todavía no terminó el inicio de sesión: la ventana sigue en ${curHost || 'una página en blanco'}. Completa el login (incluida la verificación de Microsoft: «Ahora no» o «Siguiente») hasta ver el portal de ${service === 'promomats' ? 'PromoMats' : 'AzMed'} y vuelve a pulsar «Terminé».`
            };
        }
        clearInterval(p.timer); clearInterval(p.blankTimer);
        clearTimeout(p.expireTimer);
        let state = null;
        try { state = await this.lightState(p.context); } catch (e) {}
        delete this.pending[service];
        await p.browser.close().catch(() => {});
        if (!state) return { success: false, error: 'No se pudo leer la sesión del navegador. Pulsa "Iniciar sesión" de nuevo.' };
        try {
            this.writeSession(service, state);
        } catch (e) {
            return { success: false, error: `No se pudo escribir el archivo de sesión: ${e.message}` };
        }
        console.log(`[sesión] ${service}: guardada manualmente (${state.cookies.length} cookies).`);
        this.validation[service] = { state: 'active', detail: 'Sesión guardada', checkedAt: new Date().toISOString() };
        return { success: true, message: 'Sesión guardada.' };
    }

    // Cierra el navegador sin quedarse esperando si no responde (a los 5 s se sigue adelante)
    async closeBrowser(browser) {
        await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
    }

    async cancelLogin(service) {
        const p = this.pending[service];
        if (p) {
            clearInterval(p.timer); clearInterval(p.blankTimer);
            clearTimeout(p.expireTimer);
            delete this.pending[service];
            await this.closeBrowser(p.browser);
        }
    }

    // Cierra la ventana de login y deja el estado en error con el motivo (no queda nada colgado)
    async abortLogin(service, pending, detail) {
        if (this.pending[service] !== pending) return;
        clearInterval(pending.timer); clearInterval(pending.blankTimer);
        clearTimeout(pending.expireTimer);
        delete this.pending[service];
        this.validation[service] = { state: 'error', detail, checkedAt: new Date().toISOString() };
        console.log(`[sesión] ${service}: login cancelado: ${detail}`);
        await this.closeBrowser(pending.browser);
    }

    // Cierra todas las ventanas de login (al apagar el servidor)
    async closeAll() {
        await Promise.all(Object.keys(this.pending).map(s => this.cancelLogin(s)));
    }

    clearSession(service) {
        try { fs.unlinkSync(this.sessionPath(service)); } catch (e) {}
        delete this.validation[service];
    }

    // Abre el servicio con la sesion guardada y comprueba si redirige al login.
    // Devuelve { state: 'active' | 'expired' | 'none' | 'error', detail, checkedAt }
    async validateSession(service, probeUrl) {
        const r = await this.validateSessionOnce(service, probeUrl);
        // Solo se reintenta un fallo técnico (excepción); si el portal simplemente tardó, repetir duplicaría la espera
        if (r.state !== 'error' || !r.transient) return r;
        return this.validateSessionOnce(service, probeUrl);   // fallo transitorio (red lenta, portal ocupado): un reintento
    }

    async validateSessionOnce(service, probeUrl) {
        const now = () => new Date().toISOString();

        if (!this.hasSession(service)) {
            const r = { state: 'none', detail: 'Sin sesión guardada', checkedAt: now() };
            this.validation[service] = r;
            return r;
        }

        let browser = null;
        try {
            browser = await chromium.launch({
                headless: true,
                ...(config.proxy ? { proxy: config.proxy } : {}),
                args: config.allowInsecureTls ? ['--ignore-certificate-errors'] : []
            });
            const context = await browser.newContext({
                ignoreHTTPSErrors: config.allowInsecureTls,
                userAgent: browserUserAgent(browser),
                storageState: this.sessionPath(service)
            });
            await this.restoreSessionStorage(context, service);
            const page = await context.newPage();
            await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
            // Se espera a que el portal resuelva el acceso (incluido el SSO silencioso); solo se declara expirada
            // si pide credenciales. Si no responde a tiempo es "no se pudo validar", no "expirada".
            const verdict = await this.settleAccess(page, service, config.sessionSettleMs);

            if (verdict === 'unknown') {
                const r = { state: 'error', detail: 'El portal tardó demasiado en responder (red lenta). Reintenta en un momento.', checkedAt: now() };
                this.validation[service] = r;
                return r;
            }
            if (verdict === 'active') await this.persistState(service, context);   // guarda las cookies renovadas
            const r = {
                state: verdict === 'active' ? 'active' : 'expired',
                detail: verdict === 'active' ? 'Sesión activa' : 'La sesión expiró: vuelve a iniciar sesión',
                checkedAt: now()
            };
            this.validation[service] = r;
            return r;
        } catch (e) {
            const r = { state: 'error', detail: `No se pudo validar: ${e.message.split('\n')[0]}`, checkedAt: now(), transient: true };
            this.validation[service] = r;
            return r;
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }

    // URL protegida para comprobar AzMed: AZMED_PROBE_URL, o una pagina que pidio login en un escaneo
    // anterior del mismo dominio. La home publica no sirve: carga aunque la sesion haya caducado.
    // Solo una página "Mi cuenta" sirve de sonda: exige estar logueado pero no permisos especiales. Antes se aprendía
    // la primera página que pedía login (p. ej. un micrositio con permisos propios) y la sesión válida se declaraba
    // "expirada" en cuanto se comprobaba contra ella. Una sonda aprendida que no sea de cuenta se ignora.
    isAccountUrl(u) { return /my-account|mi-cuenta|minha-conta/i.test(u || ''); }

    azmedProbeFor(targetUrl) {
        if (config.azmedProbeUrl) return config.azmedProbeUrl;
        try {
            const host = new URL(targetUrl).hostname.replace(/^www\./, '');
            const learned = (storage.loadMeta().azmedProbe || {})[host];
            if (learned && this.isAccountUrl(learned)) return learned;
        } catch (e) {}
        return targetUrl || null;
    }

    rememberProtectedUrl(baseDomain, url) {
        if (!baseDomain || !url || !this.isAccountUrl(url)) return;
        const meta = storage.loadMeta();
        meta.azmedProbe = meta.azmedProbe || {};
        if (meta.azmedProbe[baseDomain] === url) return;
        meta.azmedProbe[baseDomain] = url;
        try { storage.saveMeta(meta); } catch (e) {}
    }

    probesFor(targetUrl) {
        return {
            promomats: config.services.promomats.host ? `https://${config.services.promomats.host}/ui/` : null,
            azmed: this.azmedProbeFor(targetUrl)
        };
    }

    // Mantiene vivas las sesiones: abrir el servicio con la sesión guardada cuenta como actividad (evita el cierre por
    // inactividad) y guarda las cookies renovadas. Una a una, para no cargar el equipo. Se salta las ya expiradas.
    async keepAlive(targetUrl) {
        if (this.keepAliveRunning || Object.keys(this.pending).length) return;
        this.keepAliveRunning = true;
        try {
            const probes = this.probesFor(targetUrl);
            for (const svc of ['promomats', 'azmed']) {
                const v = this.validation[svc];
                if (!this.hasSession(svc) || !probes[svc] || (v && v.state === 'expired')) continue;
                await this.validateSession(svc, probes[svc]);
            }
        } finally { this.keepAliveRunning = false; }
    }

    // Valida los servicios indicados en paralelo
    async validateAll(services, targetUrl, maxAgeMs = 0) {
        const probes = this.probesFor(targetUrl);
        const list = (services && services.length ? services : SERVICES).filter(s => SERVICES.includes(s));
        await Promise.all(list.map(svc => {
            // Comprobada hace poco como activa (p. ej. recién iniciada): no se vuelve a abrir el portal
            const v = this.validation[svc];
            if (maxAgeMs && v && v.state === 'active' && this.hasSession(svc) && Date.now() - new Date(v.checkedAt).getTime() < maxAgeMs) return Promise.resolve();
            if (!probes[svc]) {
                this.validation[svc] = { state: this.hasSession(svc) ? 'unknown' : 'none', detail: 'Sin URL de comprobación', checkedAt: new Date().toISOString() };
                return Promise.resolve();
            }
            return this.validateSession(svc, probes[svc]);
        }));
        return this.getSessionStates();
    }

    async createScanContext() {
        return this.createServiceContext('azmed');
    }

    async createServiceContext(service) {
        const browser = await chromium.launch({
            headless: true,
            ...(config.proxy ? { proxy: config.proxy } : {}),
            args: config.allowInsecureTls ? ['--ignore-certificate-errors'] : []
        });
        const context = await browser.newContext({
            ignoreHTTPSErrors: config.allowInsecureTls,
            viewport: { width: 1440, height: 900 },
            userAgent: browserUserAgent(browser),
            acceptDownloads: false,
            storageState: this.hasSession(service) ? this.sessionPath(service) : undefined
        });
        await this.restoreSessionStorage(context, service);
        return { browser, context };
    }
}

module.exports = new AuthManager();