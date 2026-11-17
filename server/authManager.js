const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const storage = require('./storage');

// El WAF (CloudFront) del sitio bloquea el user-agent "HeadlessChrome" en peticiones directas
// (sitemaps, PDF, imagenes). Se usa el user-agent de un Chrome normal con la misma version.
function browserUserAgent(browser) {
    const os = process.platform === 'win32' ? 'Windows NT 10.0; Win64; x64'
        : process.platform === 'darwin' ? 'Macintosh; Intel Mac OS X 10_15_7' : 'X11; Linux x86_64';
    return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
}

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
            promomats: this.hasSession('promomats'),
            kaltura: this.hasSession('kaltura')
        };
    }

    // Estado combinado: login en curso > archivo + ultima validacion real
    getSessionStates() {
        const out = {};
        for (const svc of ['azmed', 'promomats', 'kaltura']) {
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
        if (service === 'kaltura') return 'kmc.kaltura.com';
        try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
    }

    // Abre un navegador visible para que el usuario inicie sesion (incluido MFA). Se detecta
    // automaticamente cuando el login termino (vuelve al servicio sin pedir contraseña):
    // entonces se guarda la sesion, se cierra la ventana y el estado pasa a "activa".
    // protectedStart: la URL inicial exige login (si carga sin pedirlo, la sesion ya era valida).
    async startLogin(service, url, protectedStart = true) {
        if (!fs.existsSync(config.sessionsDir)) fs.mkdirSync(config.sessionsDir, { recursive: true });
        await this.cancelLogin(service);

        const browser = await chromium.launch({
            headless: false,
            args: config.allowInsecureTls ? ['--ignore-certificate-errors'] : []
        });
        const context = await browser.newContext({
            ignoreHTTPSErrors: config.allowInsecureTls,
            storageState: this.hasSession(service) ? this.sessionPath(service) : undefined
        });
        const page = await context.newPage();
        const pending = {
            browser, context, host: this.serviceHost(service, url), protectedStart,
            sawLogin: false, stable: 0, busy: false, timer: null, expireTimer: null
        };
        this.pending[service] = pending;

        browser.on('disconnected', () => {
            clearInterval(pending.timer);
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

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        // Comprobacion ligera cada 2 s (solo lee la URL y busca el campo de contraseña: no abre pestañas)
        pending.timer = setInterval(() => this.checkLogin(service, pending).catch(() => {}), 2000);
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
            const onLogin = /login|signin|sign-in|sso|saml|oauth|okta|b2clogin|microsoftonline|identity\.astrazeneca|csdcidentity|\/auth\//.test(u);
            const pwd = await page.$('input[type="password"]').catch(() => null);
            const pwdVisible = pwd ? await pwd.isVisible().catch(() => false) : false;
            if (onLogin || pwdVisible) { pending.sawLogin = true; pending.stable = 0; return; }

            let h = '';
            try { h = new URL(u).hostname; } catch (e) {}
            const base = pending.host.replace(/^www\./, '');
            const onService = !!base && (h === base || h.endsWith('.' + base));
            if (!onService || (service === 'kaltura' && !/\/kmcng\//.test(u))) { pending.stable = 0; return; }

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
    async lightState(context) {
        const cookies = await context.cookies();
        const byOrigin = new Map();
        for (const page of context.pages()) {
            for (const frame of page.frames()) {
                try {
                    const data = await frame.evaluate(() => ({
                        origin: location.origin,
                        items: Object.keys(localStorage).map(k => ({ name: k, value: localStorage.getItem(k) }))
                    }));
                    if (data.origin && data.origin !== 'null' && data.items.length) byOrigin.set(data.origin, data.items);
                } catch (e) {}
            }
        }
        return { cookies, origins: [...byOrigin].map(([origin, localStorage]) => ({ origin, localStorage })) };
    }

    async completeLogin(service, pending) {
        if (this.pending[service] !== pending) return;
        clearInterval(pending.timer);
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
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
        fs.renameSync(tmp, file);
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
        clearInterval(p.timer);
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

    async cancelLogin(service) {
        const p = this.pending[service];
        if (p) {
            clearInterval(p.timer);
            clearTimeout(p.expireTimer);
            delete this.pending[service];
            await p.browser.close().catch(() => {});
        }
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
                args: config.allowInsecureTls ? ['--ignore-certificate-errors'] : []
            });
            const context = await browser.newContext({
                ignoreHTTPSErrors: config.allowInsecureTls,
                userAgent: browserUserAgent(browser),
                storageState: this.sessionPath(service)
            });
            const page = await context.newPage();
            await page.goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await page.waitForTimeout(5000);

            const finalUrl = page.url().toLowerCase();
            let expired = false;
            let detail = 'Sesión activa';

            if (service === 'promomats') {
                const host = (config.services.promomats.host || '').toLowerCase();
                // Si termina fuera del host de Vault o en una pantalla de login, la sesion caduco
                if (!host || !finalUrl.includes(host) || /login|sso|saml|signin|okta/.test(finalUrl)) expired = true;
                else {
                    const hasPwd = await page.$('input[type="password"]').catch(() => null);
                    if (hasPwd) expired = true;
                }
            } else if (service === 'azmed') {
                if (/identity\.astrazeneca|login|signin|saml|sso|oauth|okta|b2clogin/.test(finalUrl)) expired = true;
                else {
                    const hasPwd = await page.$('input[type="password"]').catch(() => null);
                    if (hasPwd) expired = true;
                }
            } else if (service === 'kaltura') {
                // Se abre la lista de contenidos de KMC: si la sesion caduco, KMC redirige a /login
                const pwd = await page.$('input[type="password"]').catch(() => null);
                const pwdVisible = pwd ? await pwd.isVisible().catch(() => false) : false;
                if (/\/login(\b|\/|\?|$)/.test(finalUrl) || pwdVisible) expired = true;
            }

            if (expired) detail = 'La sesión expiró: vuelve a iniciar sesión';
            const r = { state: expired ? 'expired' : 'active', detail, checkedAt: now() };
            this.validation[service] = r;
            return r;
        } catch (e) {
            const r = { state: 'error', detail: `No se pudo validar: ${e.message.split('\n')[0]}`, checkedAt: now() };
            this.validation[service] = r;
            return r;
        } finally {
            if (browser) await browser.close().catch(() => {});
        }
    }

    // URL protegida para comprobar AzMed: AZMED_PROBE_URL, o una pagina que pidio login en un escaneo
    // anterior del mismo dominio. La home publica no sirve: carga aunque la sesion haya caducado.
    azmedProbeFor(targetUrl) {
        if (config.azmedProbeUrl) return config.azmedProbeUrl;
        try {
            const host = new URL(targetUrl).hostname.replace(/^www\./, '');
            const learned = (storage.loadMeta().azmedProbe || {})[host];
            if (learned) return learned;
        } catch (e) {}
        return targetUrl || null;
    }

    rememberProtectedUrl(baseDomain, url) {
        if (!baseDomain || !url || /\.pdf(\?|$)/i.test(url)) return;
        const meta = storage.loadMeta();
        meta.azmedProbe = meta.azmedProbe || {};
        const current = meta.azmedProbe[baseDomain];
        if (current === url) return;
        // Se prefiere "Mi cuenta" (exige solo estar logueado) a paginas de eventos con permisos propios
        const isAccount = (u) => /my-account|mi-cuenta|minha-conta|account/i.test(u || '');
        if (current && (isAccount(current) || !isAccount(url))) return;
        meta.azmedProbe[baseDomain] = url;
        try { storage.saveMeta(meta); } catch (e) {}
    }

    // Valida los servicios indicados en paralelo
    async validateAll(services, targetUrl) {
        const probes = {
            promomats: config.services.promomats.host ? `https://${config.services.promomats.host}/ui/` : null,
            azmed: this.azmedProbeFor(targetUrl),
            // No la pagina de login: esa contiene "login" en la URL aunque la sesion este activa
            kaltura: 'https://kmc.kaltura.com/index.php/kmcng/content/entries/list'
        };
        const list = services && services.length ? services : ['azmed', 'promomats', 'kaltura'];
        await Promise.all(list.map(svc => {
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
            args: config.allowInsecureTls ? ['--ignore-certificate-errors'] : []
        });
        const context = await browser.newContext({
            ignoreHTTPSErrors: config.allowInsecureTls,
            viewport: { width: 1440, height: 900 },
            userAgent: browserUserAgent(browser),
            acceptDownloads: false,
            storageState: this.hasSession(service) ? this.sessionPath(service) : undefined
        });
        return { browser, context };
    }
}

module.exports = new AuthManager();