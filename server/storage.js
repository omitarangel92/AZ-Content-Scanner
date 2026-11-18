const fs = require('fs');
const path = require('path');
const { dataDir, shotsDir } = require('./config');
const { atomicWriteSync } = require('./fsutil');

function ensureDir(dir = dataDir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
    ensureDir();
    const p = path.join(dataDir, file);
    if (!fs.existsSync(p)) return fallback;
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return fallback; }
}

// Escritura atomica: si el proceso muere a mitad, no se corrompe el archivo anterior
function writeJson(file, data) {
    ensureDir();
    atomicWriteSync(path.join(dataDir, file), JSON.stringify(data), 'utf8');
}

const safeId = (s) => String(s).replace(/[^a-z0-9_-]/gi, '');

// ---------- Capturas como archivos (antes iban en base64 dentro de history.json) ----------
async function saveShot(scanId, name, buffer) {
    const dir = path.join(shotsDir, safeId(scanId));
    await fs.promises.mkdir(dir, { recursive: true });
    const file = `${safeId(name)}.jpg`;
    await fs.promises.writeFile(path.join(dir, file), buffer);
    return `/shots/${safeId(scanId)}/${file}`;
}

function deleteShots(scanId) {
    if (!scanId) return;
    try { fs.rmSync(path.join(shotsDir, safeId(scanId)), { recursive: true, force: true }); } catch (e) {}
}

// Convierte capturas base64 de escaneos antiguos en archivos para aligerar el historial
function migrateHistory(history) {
    let changed = false;
    for (const scan of history) {
        if (!scan || !Array.isArray(scan.assets)) continue;
        scan.assets.forEach((a, i) => {
            const m = typeof a.screenshot === 'string' && a.screenshot.match(/^data:image\/(jpeg|png);base64,(.+)$/);
            if (!m) return;
            try {
                const dir = path.join(shotsDir, safeId(scan.scanId));
                fs.mkdirSync(dir, { recursive: true });
                const file = `legacy-${i}.jpg`;
                fs.writeFileSync(path.join(dir, file), Buffer.from(m[2], 'base64'));
                a.screenshot = `/shots/${safeId(scan.scanId)}/${file}`;
                changed = true;
            } catch (e) {}
        });
    }
    return changed;
}

function loadHistory() {
    const h = readJson('history.json', []);
    if (migrateHistory(h)) {
        try { writeJson('history.json', h); console.log('Historial migrado: capturas movidas a data/shots/.'); } catch (e) {}
    }
    return h;
}

// Espacio que ocupa el historial (history.json + capturas) y borrado total de capturas
function dirSize(dir) {
    let n = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
        }
    } catch (e) { /* carpeta inexistente */ }
    return n;
}
function usageBytes() {
    let n = dirSize(shotsDir);
    try { n += fs.statSync(path.join(dataDir, 'history.json')).size; } catch (e) { /* sin historial */ }
    return n;
}
function deleteAllShots() {
    try { fs.rmSync(shotsDir, { recursive: true, force: true }); } catch (e) { /* ya no existe */ }
}

module.exports = {
    usageBytes,
    deleteAllShots,
    loadHistory,
    saveHistory: (h) => writeJson('history.json', h),
    loadReviews: () => readJson('reviews.json', {}),
    saveReviews: (r) => writeJson('reviews.json', r),
    loadMeta: () => readJson('meta.json', {}),
    saveMeta: (m) => writeJson('meta.json', m),
    saveShot,
    deleteShots
};
