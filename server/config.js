require('dotenv').config();
const path = require('path');
const os = require('os');

// Dónde se guardan sesiones (cookies/tokens de AstraZeneca y PromoMats), historial y capturas.
// Dentro de una carpeta de OneDrive se sincronizarían a la nube (chmod 0600 no protege en Windows),
// así que en ese caso se usan datos locales del usuario. DATA_DIR permite elegir otra ruta.
function resolveDataRoot() {
    if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
    const projectRoot = path.join(__dirname, '..');
    if (/onedrive/i.test(projectRoot)) {
        const base = process.env.LOCALAPPDATA || path.join(os.homedir(), '.local', 'share');
        return path.join(base, 'AZ-Content-Scanner');
    }
    return projectRoot;
}
const dataRoot = resolveDataRoot();

const list = (v) => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

module.exports = {
    port: process.env.PORT || 3000,
    // Solo accesible desde este equipo: la API maneja sesiones corporativas guardadas
    host: process.env.HOST || '127.0.0.1',
    allowInsecureTls: process.env.ALLOW_INSECURE_TLS === 'true',
    // Proxy para los navegadores de la app (login y escaneos). Vacío = conexión directa. Ej.: http://proxy.empresa.com:8080
    proxy: process.env.PROXY_SERVER ? {
        server: process.env.PROXY_SERVER.trim(),
        ...(process.env.PROXY_USERNAME ? { username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD || '' } : {}),
        ...(process.env.PROXY_BYPASS ? { bypass: process.env.PROXY_BYPASS.trim() } : {})
    } : undefined,
    allowedDomains: list(process.env.ALLOWED_DOMAINS),
    // Nombres de host adicionales aceptados en la cabecera Host (solo si se publica el servidor con HOST/proxy)
    extraHosts: list(process.env.ALLOWED_HOSTS),
    // Endpoints de diagnóstico (/api/vault/inspect, /api/capture-test): desactivados salvo que se pidan
    enableDiagnostics: process.env.ENABLE_DIAGNOSTICS === 'true',
    warningDays: parseInt(process.env.WARNING_DAYS || '30', 10),
    // Orden de día/mes en fechas ambiguas de PromoMats (03/04/2026): 'dmy' (por defecto) o 'mdy'
    vaultDateFormat: process.env.VAULT_DATE_FORMAT === 'mdy' ? 'mdy' : 'dmy',
    maxPages: parseInt(process.env.MAX_PAGES || '800', 10),
    // Cola de áreas: pausa entre áreas (segundos) para no saturar el WAF; se duplica si una área sufre bloqueos
    // Tiempo máximo (ms) para que un portal resuelva el acceso al validar una sesión (el login corporativo es lento)
    sessionSettleMs: Math.max(10, Math.min(180, parseInt(process.env.SESSION_SETTLE_SECONDS || '60', 10))) * 1000,
    // Cada cuántos minutos se "toca" cada sesión guardada para que no caduque por inactividad (0 = desactivado)
    sessionKeepAliveMinutes: Math.max(0, Math.min(240, parseInt(process.env.SESSION_KEEPALIVE_MINUTES || '20', 10))),
    // PromoMats: espera máxima del campo de búsqueda y de los resultados (ms). Con red lenta, subir estos valores.
    vaultStepTimeoutMs: Math.max(3, Math.min(60, parseInt(process.env.VAULT_STEP_TIMEOUT_SECONDS || '10', 10))) * 1000,
    vaultSearchTimeoutMs: Math.max(8, Math.min(120, parseInt(process.env.VAULT_SEARCH_TIMEOUT_SECONDS || '25', 10))) * 1000,
    // Kaltura (metadatos anónimos de videos): espera por petición y reintentos. La red corporativa suele ser lenta.
    kalturaTimeoutMs: Math.max(5, Math.min(90, parseInt(process.env.KALTURA_TIMEOUT_SECONDS || '25', 10))) * 1000,
    kalturaRetries: Math.max(0, Math.min(4, parseInt(process.env.KALTURA_RETRIES || '2', 10))),
    // Caché de resultados de PromoMats con fecha entre escaneos (horas; 0 = desactivada). El ID del pie de página se
    // repite en cientos de páginas y en cada área: se consulta una vez y los resultados son coherentes entre escaneos.
    vaultCacheHours: Math.max(0, Math.min(168, parseInt(process.env.VAULT_CACHE_HOURS || '12', 10))),
    queuePauseSeconds: Math.max(0, Math.min(600, parseInt(process.env.QUEUE_PAUSE_SECONDS || '45', 10))),
    maxDepth: parseInt(process.env.MAX_DEPTH || '6', 10),
    pageTimeout: parseInt(process.env.PAGE_TIMEOUT_MS || '25000', 10),
    maxOcrImagesPerPage: parseInt(process.env.MAX_OCR_IMAGES_PER_PAGE || '8', 10),
    ocrEnabled: process.env.OCR_ENABLED === 'true',
    // Workers de OCR en paralelo (cada uno ocupa ~100 MB)
    ocrWorkers: Math.max(1, Math.min(4, parseInt(process.env.OCR_WORKERS || '2', 10))),
    vaultConcurrency: Math.max(1, Math.min(5, parseInt(process.env.VAULT_CONCURRENCY || '3', 10))),
    // Pestañas que rastrean el sitio en paralelo (valores altos pueden activar el WAF del sitio)
    crawlConcurrency: Math.max(1, Math.min(6, parseInt(process.env.CRAWL_CONCURRENCY || '3', 10))),
    pageRetries: Math.max(0, Math.min(3, parseInt(process.env.PAGE_RETRIES || '2', 10))),
    // URL protegida de AzMed para comprobar si la sesion sigue activa (la home publica siempre carga)
    azmedProbeUrl: process.env.AZMED_PROBE_URL || '',

    dataRoot,
    sessionsDir: path.join(dataRoot, '.sessions'),
    dataDir: path.join(dataRoot, 'data'),
    ocrDataDir: path.join(__dirname, '../ocr-data'),
    shotsDir: path.join(dataRoot, 'data', 'shots'),

    services: {
        azmed: { label: 'AzMed / Identity', loginUrl: null },
        promomats: {
            label: 'PromoMats',
            loginUrl: process.env.VAULT_HOST
                ? `https://${process.env.VAULT_HOST}/ui/`
                : 'https://login.veevavault.com/',
            host: process.env.VAULT_HOST || ''
        },
        kaltura: {
            partnerId: process.env.KALTURA_PARTNER_ID || '',
            serviceUrl: process.env.KALTURA_SERVICE_URL || 'https://www.kaltura.com'
        }
    },

    // Lookarounds en lugar de \b: \b no separa "_" de letras, así que "banner_CC-14803.jpg" no coincidía.
    // Se descartan años de 4 dígitos (CO-2024, UY-2023) que no son Approval IDs.
    approvalIdRegex: '(?<![A-Za-z0-9])(?:MX|CC|CO|EC|PE|BR|AR|CL|UY|XC)-(?!(?:19|20)\\d{2}(?!\\d))\\d{4,6}(?!\\d)',

    // Nueva instancia global de la regex de IDs (las regex con /g guardan estado, no se comparten)
    idRe() { return new RegExp(this.approvalIdRegex, 'g'); },

    regions: {
        CAMCAR: { label: 'CAMCAR', countries: { CR: 'https://www.azmed.cr' } },
        MEXICO: { label: 'México', countries: { MX: 'https://www.azmed.com.mx' } },
        // ANDEAN retirado: azmed.ec / azmed.pe no existen y www.azmed.co NO es de AstraZeneca
        // (es "AZmed", empresa de radiologia con IA). Añadir cuando se conozcan las URLs reales.
        BRASIL: { label: 'Brasil', countries: { BR: 'https://www.azmed.com.br' } },
        CONO_SUR: { label: 'Cono Sur', countries: { AR: 'https://www.azmed.com.ar', CL: 'https://www.azmed.cl', UY: 'https://www.azmed.uy' } }
    },

    trackingParams: [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'source', 'gclid', 'fbclid', 'mc_cid', 'mc_eid', 'ref',
        'ucampaign', 'umedium', 'usource', 'ucontent', 'uterm',
        'cid', 'campaign', 'medium'
    ],

    logoutPattern: /(log[-_]?out|sign[-_]?out|signoff|cerrar[-_]?sesi|salir|desconectar|logoff|\/logout)/i,

    // Etiquetas de la seccion "Key Dates" de la ficha de PromoMats
    vaultLabels: {
        approved: ['Approved for Distribution Date', 'Fecha de Aprobación para Distribución'],
        expiration: ['Expiration Date', 'Fecha de Vencimiento', 'Fecha de Expiración'],
        retiredValues: ['retired', 'obsolete', 'superseded', 'withdrawn', 'retirado', 'obsoleto'],
        // Estados que significan «aprobado y en uso»: sin fecha de vencimiento cuentan como vigentes (material que no caduca)
        approvedValues: ['approved', 'approved for distribution', 'approved for use', 'final', 'effective', 'steady state', 'aprobado', 'aprovado', 'vigente']
    }
};