require('dotenv').config();
const path = require('path');

const list = (v) => (v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

module.exports = {
    port: process.env.PORT || 3000,
    // Solo accesible desde este equipo: la API maneja sesiones corporativas guardadas
    host: process.env.HOST || '127.0.0.1',
    allowInsecureTls: process.env.ALLOW_INSECURE_TLS === 'true',
    allowedDomains: list(process.env.ALLOWED_DOMAINS),
    warningDays: parseInt(process.env.WARNING_DAYS || '60', 10),
    maxPages: parseInt(process.env.MAX_PAGES || '800', 10),
    maxDepth: parseInt(process.env.MAX_DEPTH || '6', 10),
    pageTimeout: parseInt(process.env.PAGE_TIMEOUT_MS || '25000', 10),
    maxOcrImagesPerPage: parseInt(process.env.MAX_OCR_IMAGES_PER_PAGE || '8', 10),
    ocrEnabled: process.env.OCR_ENABLED === 'true',
    vaultConcurrency: Math.max(1, Math.min(5, parseInt(process.env.VAULT_CONCURRENCY || '3', 10))),
    // Pestañas que rastrean el sitio en paralelo (valores altos pueden activar el WAF del sitio)
    crawlConcurrency: Math.max(1, Math.min(6, parseInt(process.env.CRAWL_CONCURRENCY || '3', 10))),
    pageRetries: Math.max(0, Math.min(3, parseInt(process.env.PAGE_RETRIES || '1', 10))),
    // URL protegida de AzMed para comprobar si la sesion sigue activa (la home publica siempre carga)
    azmedProbeUrl: process.env.AZMED_PROBE_URL || '',

    sessionsDir: path.join(__dirname, '../.sessions'),
    dataDir: path.join(__dirname, '../data'),
    ocrDataDir: path.join(__dirname, '../ocr-data'),
    shotsDir: path.join(__dirname, '../data/shots'),

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
            label: 'Kaltura KMC',
            loginUrl: 'https://kmc.kaltura.com/index.php/kmcng/login',
            partnerId: process.env.KALTURA_PARTNER_ID || '',
            serviceUrl: process.env.KALTURA_SERVICE_URL || 'https://www.kaltura.com'
        }
    },

    approvalIdRegex: '\\b(?:MX|CC|CO|EC|PE|BR|AR|CL|UY|XC)-\\d{4,6}\\b',

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
        retiredValues: ['retired', 'obsolete', 'superseded', 'withdrawn', 'retirado', 'obsoleto']
    }
};