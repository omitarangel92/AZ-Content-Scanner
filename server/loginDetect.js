// Detección unificada de pantallas de login. Antes había cuatro regex distintas que buscaban
// "login", "sso" o "signin" en CUALQUIER parte de la URL: rutas legítimas como /association-events
// (contiene "sso") se tomaban por un login y se omitían del escaneo.
// Aquí solo cuenta el HOST (proveedores de identidad) o un SEGMENTO COMPLETO de la ruta.

const IDP_HOST = /(identity\.astrazeneca|csdcidentity|okta(preview)?\.com|b2clogin\.com|microsoftonline\.com|login\.veevavault\.com)/i;
const IDP_HOST_PREFIX = /^(login|sso|signin|auth|idp|identity)\./i;
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|sso|saml2?|oauth2?|authenticate|auth|openid-connect)(\/|\.|$)/i;

function parse(url) {
    try { return new URL(url); } catch (e) { return null; }
}

// ¿La URL pertenece a un proveedor de identidad (aunque no muestre aún el formulario)?
function isIdpHost(url) {
    const u = parse(url);
    return !!u && (IDP_HOST.test(u.hostname) || IDP_HOST_PREFIX.test(u.hostname));
}

// ¿La URL parece una pantalla de login? (host de identidad o ruta cuyo segmento es login/sso/saml/…)
function isLoginUrl(url) {
    const u = parse(url);
    if (!u) return false;
    return isIdpHost(url) || LOGIN_PATH.test(u.pathname);
}

module.exports = { isLoginUrl, isIdpHost };
