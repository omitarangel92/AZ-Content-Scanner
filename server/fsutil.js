const fs = require('fs');

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Escritura atómica (.tmp + rename). En Windows, OneDrive o el antivirus pueden bloquear el rename
// un instante (EPERM/EBUSY/EACCES): se reintenta unas veces antes de fallar.
function atomicWriteSync(file, content, options) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content, options);
    let lastErr;
    for (let i = 0; i < 6; i++) {
        try { fs.renameSync(tmp, file); return; }
        catch (e) {
            lastErr = e;
            if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) break;
            sleepSync(40 * (i + 1));
        }
    }
    try { fs.unlinkSync(tmp); } catch (e) { /* ya no existe */ }
    throw lastErr;
}

module.exports = { atomicWriteSync };
