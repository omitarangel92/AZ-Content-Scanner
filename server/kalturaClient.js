const config = require('./config');

const ID_RE = () => config.idRe();

class KalturaClient {
    extractEntryId(src) {
        if (!src) return null;
        let m = src.match(/entry_id[=\/]([0-9]_[a-z0-9]+)/i);
        if (m) return m[1];
        m = src.match(/entryId[=\/]([0-9]_[a-z0-9]+)/i);
        if (m) return m[1];
        m = src.match(/\/([0-9]_[a-z0-9]{8})/i);
        return m ? m[1] : null;
    }

    extractPartnerId(src) {
        const m = (src || '').match(/\/p\/(\d+)/) || (src || '').match(/partner_id[=\/](\d+)/i);
        return m ? m[1] : config.services.kaltura.partnerId || null;
    }

    // Lee nombre, descripcion y tags del entry (funciona con entries publicos)
    // `request` es el APIRequestContext de Playwright del escaneo: usa la misma red/proxy/certificados que el
    // resto del rastreo. El fetch nativo de Node no confía en el certificado del proxy (zScaler) y fallaba
    // en silencio. Sin `request` se usa fetch (compatibilidad).
    async getJson(url, request) {
        if (request) {
            const res = await request.get(url, { timeout: 10000 });
            return res.json();
        }
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        return res.json();
    }

    async getEntryMetadata(src, request) {
        const entryId = this.extractEntryId(src);
        const partnerId = this.extractPartnerId(src);
        if (!entryId || !partnerId) return { ok: false, reason: 'No se pudo determinar entryId/partnerId' };

        try {
            const base = config.services.kaltura.serviceUrl;
            const ksJson = await this.getJson(
                `${base}/api_v3/service/session/action/startWidgetSession?widgetId=_${partnerId}&format=1`, request);
            if (!ksJson.ks) return { ok: false, reason: 'No se obtuvo sesión de widget' };

            const entry = await this.getJson(
                `${base}/api_v3/service/baseEntry/action/get?entryId=${encodeURIComponent(entryId)}&ks=${encodeURIComponent(ksJson.ks)}&format=1`, request);
            if (!entry || entry.objectType === 'KalturaAPIException') {
                return { ok: false, reason: (entry && entry.message) || 'Entry no accesible' };
            }

            // El ID vigente va en el nombre/tags. La descripcion suele citar codigos anteriores
            // ("Reaprobación del CC-9192 por vencimiento"), asi que solo se usa si no hay otro.
            const primary = `${entry.name || ''} ${entry.tags || ''}`;
            let ids = [...new Set(primary.match(ID_RE()) || [])];
            if (!ids.length) ids = [...new Set((entry.description || '').match(ID_RE()) || [])];
            return {
                ok: true, entryId,
                name: entry.name || '', description: entry.description || '', tags: entry.tags || '',
                ids
            };
        } catch (e) {
            return { ok: false, reason: e.message };
        }
    }
}

module.exports = new KalturaClient();