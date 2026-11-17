const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const config = require('./config');

class OcrService {
    constructor() {
        this.worker = null;
        this.disabled = !config.ocrEnabled;
        this.disabledReason = config.ocrEnabled ? '' : 'OCR desactivado en .env (OCR_ENABLED=false)';
        this.initPromise = null;
    }

    isAvailable() {
        return !this.disabled;
    }

    getStatus() {
        return { available: !this.disabled, reason: this.disabledReason };
    }

    async init() {
        if (this.disabled) return null;
        if (this.worker) return this.worker;
        if (this.initPromise) return this.initPromise;

        this.initPromise = (async () => {
            try {
                const { createWorker } = require('tesseract.js');
                const hasLocal = fs.existsSync(path.join(config.ocrDataDir, 'eng.traineddata')) ||
                                 fs.existsSync(path.join(config.ocrDataDir, 'eng.traineddata.gz'));

                const options = {
                    // Los errores del worker se capturan aqui y NO matan el proceso
                    errorHandler: (err) => {
                        console.error('[OCR worker]', err && err.message ? err.message : err);
                        this.disable('Error interno del worker de OCR');
                    },
                    logger: () => {}
                };
                if (hasLocal) {
                    // Sin cache: si no, tesseract copia eng.traineddata (5 MB) en la carpeta desde donde se ejecuta
                    options.cacheMethod = 'none';
                    options.langPath = config.ocrDataDir;
                    options.gzip = fs.existsSync(path.join(config.ocrDataDir, 'eng.traineddata.gz'));
                }

                const lang = hasLocal ? 'eng' : 'eng';
                const worker = await Promise.race([
                    createWorker(lang, 1, options),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado cargando datos de OCR')), 30000))
                ]);
                this.worker = worker;
                return worker;
            } catch (e) {
                this.disable(`No se pudieron cargar los datos de OCR: ${e.message.split('\n')[0]}. ` +
                    'Coloca eng.traineddata en la carpeta ocr-data/ o configura NODE_EXTRA_CA_CERTS.');
                return null;
            } finally {
                this.initPromise = null;
            }
        })();
        return this.initPromise;
    }

    disable(reason) {
        if (!this.disabled) {
            this.disabled = true;
            this.disabledReason = reason;
            console.error('[OCR] Desactivado:', reason);
        }
        if (this.worker) {
            this.worker.terminate().catch(() => {});
            this.worker = null;
        }
    }

    async recognizeImage(buffer) {
        if (this.disabled) return null; // null = no se pudo leer
        try {
            const w = await this.init();
            if (!w) return null;
            const { data } = await w.recognize(buffer);
            return data.text || '';
        } catch (e) {
            this.disable(`Fallo de OCR: ${e.message.split('\n')[0]}`);
            return null;
        }
    }

    async readPdf(buffer) {
        try {
            const parsed = await pdfParse(buffer);
            const text = (parsed.text || '').trim();
            if (text.length > 30) return { text, method: 'texto' };
            return { text: '', method: 'escaneado-no-leido' };
        } catch (e) {
            return { text: '', method: 'error' };
        }
    }

    async close() {
        if (this.worker) {
            await this.worker.terminate().catch(() => {});
            this.worker = null;
        }
    }
}

module.exports = new OcrService();