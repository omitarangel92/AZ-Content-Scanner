// Protecciones del servidor local. La API maneja sesiones corporativas guardadas, y cualquier página web
// abierta en el navegador del usuario puede enviar peticiones a http://localhost:<puerto>:
//   - CSRF: un sitio cualquiera podía lanzar POST /api/scan, /api/cancel-scan, /api/session/clear…
//   - DNS rebinding: un dominio atacante que resuelve a 127.0.0.1 leería respuestas como si fueran suyas.
// Defensas: validar Host y Origin, exigir un token por proceso en las peticiones que modifican estado,
// cabeceras de seguridad y un limitador de peticiones.
const crypto = require('crypto');
const config = require('./config');

const TOKEN = crypto.randomBytes(24).toString('hex');
const TOKEN_HEADER = 'x-az-token';

const allowedHostnames = new Set(['localhost', '127.0.0.1', '[::1]']);
if (config.host && !['0.0.0.0', '::'].includes(config.host)) allowedHostnames.add(config.host.toLowerCase());
config.extraHosts.forEach(h => allowedHostnames.add(h));

const hostnameOf = (hostHeader) => String(hostHeader || '').toLowerCase().replace(/:\d+$/, '');

// 1) Host: bloquea DNS rebinding
function hostGuard(req, res, next) {
    if (!allowedHostnames.has(hostnameOf(req.headers.host))) {
        return res.status(421).json({ error: 'Host no permitido.' });
    }
    next();
}

// 2) Origin / Sec-Fetch-Site: la interfaz se sirve desde este mismo origen, así que cualquier otro origen sobra
function originGuard(req, res, next) {
    const origin = req.headers.origin;
    if (origin) {
        let ok = false;
        try { ok = new URL(origin).host.toLowerCase() === String(req.headers.host || '').toLowerCase(); } catch (e) { /* inválido */ }
        if (!ok) return res.status(403).json({ error: 'Origen no permitido.' });
    }
    const site = req.headers['sec-fetch-site'];
    if (site === 'cross-site' || site === 'same-site') return res.status(403).json({ error: 'Petición de otro sitio bloqueada.' });
    next();
}

// 3) Token por proceso en POST/PUT/DELETE (la interfaz lo obtiene con GET /api/token, que otro sitio no puede leer)
function tokenGuard(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const got = Buffer.from(String(req.headers[TOKEN_HEADER] || ''));
    const want = Buffer.from(TOKEN);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
        return res.status(403).json({ error: 'Token de sesión inválido. Recarga la página.' });
    }
    next();
}

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Los manejadores onclick="" de la interfaz requieren script-src-attr; los scripts externos/en línea siguen bloqueados
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'", "script-src 'self'", "script-src-attr 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'",
        "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"
    ].join('; '));
    next();
}

// Limitador en memoria por ventana fija (suficiente para un servidor local de un solo usuario)
function rateLimit(name, limit, windowMs = 60000) {
    const hits = new Map();
    return (req, res, next) => {
        const now = Date.now();
        const key = req.ip || 'local';
        const e = hits.get(key);
        if (!e || now > e.reset) { hits.set(key, { count: 1, reset: now + windowMs }); return next(); }
        if (++e.count > limit) {
            res.setHeader('Retry-After', Math.ceil((e.reset - now) / 1000));
            return res.status(429).json({ error: `Demasiadas peticiones a ${name}. Espera un momento.` });
        }
        next();
    };
}

module.exports = { TOKEN, TOKEN_HEADER, hostGuard, originGuard, tokenGuard, securityHeaders, rateLimit };
