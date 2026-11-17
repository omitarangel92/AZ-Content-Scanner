const fs = require('fs');
const path = require('path');
const pdfParse = require('pdf-parse');
const config = require('./config');

const COOLDOWN_MS = 20000;   // tras un fallo, el OCR se pausa este tiempo y se reintenta
const MAX_STRIKES = 3;       // fallos seguidos antes de desactivarlo hasta el final del escaneo

class OcrService {
    constructor() {
        this.configDisabled = !config.ocrEnabled;
        this.reset();
    }

    // Estado limpio al iniciar/terminar cada escaneo (un fallo ya no degrada los escaneos siguientes)
    reset() {
        this.workers = [];        // todos los workers creados
        this.idle = [];           // workers libres
        this.waiters = [];        // peticiones esperando un worker libre
        this.creating = 0;
        this.strikes = 0;
        this.cooldownUntil = 0;
        this.permanent = this.configDisabled;
        this.reason = this.configDisabled ? 'OCR desactivado en .env (OCR_ENABLED=false)' : '';
    }

    isAvailable() {
        return !this.permanent && Date.now() >= this.cooldownUntil;
    }

    getStatus() {
        return { available: !this.permanent, reason: this.reason };
    }

    fail(reason) {
        this.reason = reason;
        this.strikes++;
        this.cooldownUntil = Date.now() + COOLDOWN_MS;
        if (this.strikes >= MAX_STRIKES) {
            this.permanent = true;
            console.error('[OCR] Desactivado hasta el final del escaneo:', reason);
        } else {
            console.error(`[OCR] Fallo ${this.strikes}/${MAX_STRIKES} (se reintenta en ${COOLDOWN_MS / 1000}s):`, reason);
        }
    }

    async createWorker() {
        const { createWorker } = require('tesseract.js');
        const hasGz = fs.existsSync(path.join(config.ocrDataDir, 'eng.traineddata.gz'));
        const hasLocal = hasGz || fs.existsSync(path.join(config.ocrDataDir, 'eng.traineddata'));

        const options = {
            // Los errores del worker se capturan aqui y NO matan el proceso
            errorHandler: (err) => this.fail(`Error interno del worker de OCR: ${err && err.message ? err.message : err}`),
            logger: () => {}
        };
        if (hasLocal) {
            // Sin cache: si no, tesseract copia eng.traineddata (5 MB) en la carpeta desde donde se ejecuta
            options.cacheMethod = 'none';
            options.langPath = config.ocrDataDir;
            options.gzip = hasGz;
        }
        return Promise.race([
            createWorker('eng', 1, options),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo agotado cargando datos de OCR')), 30000))
        ]);
    }

    // Devuelve un worker libre; crea hasta config.ocrWorkers y el resto espera su turno
    async acquire() {
        if (this.idle.length) return this.idle.pop();
        if (this.workers.length + this.creating < config.ocrWorkers) {
            this.creating++;
            try {
                const w = await this.createWorker();
                this.workers.push(w);
                return w;
            } finally { this.creating--; }
        }
        return new Promise(resolve => this.waiters.push(resolve));
    }

    release(worker) {
        if (!this.workers.includes(worker)) return; // fue terminado (timeout) mientras estaba en uso
        const next = this.waiters.shift();
        if (next) next(worker); else this.idle.push(worker);
    }

    // Un worker colgado se termina de verdad (cancela el trabajo) y se descarta del pool
    async discard(worker) {
        this.workers = this.workers.filter(w => w !== worker);
        this.idle = this.idle.filter(w => w !== worker);
        await worker.terminate().catch(() => {});
    }

    // null = no se pudo leer (OCR no disponible, fallo o tiempo agotado)
    async recognizeImage(buffer, timeoutMs = 20000) {
        if (!this.isAvailable()) return null;
        let worker = null;
        try {
            worker = await this.acquire();
            let timer;
            const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); });
            try {
                const { data } = await Promise.race([worker.recognize(buffer), timeout]);
                this.strikes = 0;
                this.release(worker);
                return data.text || '';
            } finally { clearTimeout(timer); }
        } catch (e) {
            if (worker) await this.discard(worker);   // en timeout el worker puede seguir ocupado: se recrea
            if (e.message !== 'timeout') this.fail(`Fallo de OCR: ${String(e.message).split('\n')[0]}`);
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
        const all = this.workers;
        this.reset();
        await Promise.all(all.map(w => w.terminate().catch(() => {})));
    }
}

module.exports = new OcrService();
