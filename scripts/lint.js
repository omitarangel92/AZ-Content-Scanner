// Lint sin dependencias:
//  1) sintaxis de todos los .js (server, public/js, test, scripts)
//  2) coherencia HTML <-> JS: cada $('id') de app.js existe en index.html y cada onclick/onchange/oninput
//     del HTML llama a una función definida (el frontend llegó a romperse por no cumplir esto)
//  3) variables CSS usadas (var(--x)) que no están definidas
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const errors = [];

function listJs(dir) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) return [];
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap(e => {
        const rel = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === 'node_modules' ? [] : listJs(rel);
        return e.name.endsWith('.js') ? [rel] : [];
    });
}

// 1) Sintaxis
const files = ['server', 'public/js', 'test', 'scripts'].flatMap(listJs);
for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', path.join(root, f)], { encoding: 'utf8' });
    if (r.status !== 0) errors.push(`Sintaxis en ${f}:\n${r.stderr.trim()}`);
}

// 2) HTML <-> JS
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/index.html');
const app = read('public/js/app.js');
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
for (const m of app.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) {
    if (!htmlIds.has(m[1])) errors.push(`app.js usa $('${m[1]}') pero index.html no tiene id="${m[1]}"`);
}
const definedFns = new Set([...app.matchAll(/(?:async\s+)?function\s+([A-Za-z0-9_]+)/g)].map(m => m[1]));
const handlers = [...html.matchAll(/\bon(?:click|change|input)="\s*([A-Za-z0-9_]+)\s*\(/g)].map(m => m[1]);
for (const fn of new Set(handlers)) {
    if (!definedFns.has(fn) && fn !== 'if') errors.push(`index.html llama a ${fn}() y app.js no la define`);
}
// Funciones llamadas desde las plantillas JS (onclick="..." dentro de template literals)
for (const m of app.matchAll(/onclick="\s*([A-Za-z0-9_]+)\s*\(/g)) {
    if (!definedFns.has(m[1])) errors.push(`app.js genera onclick="${m[1]}()" sin definirla`);
}

// 3) Variables CSS
const css = ['public/css/tokens.css', 'public/css/styles.css'].map(read).join('\n');
const declared = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]));
const used = new Set([...(css + app + html).matchAll(/var\((--[a-z0-9-]+)/gi)].map(m => m[1]));
for (const v of used) if (!declared.has(v)) errors.push(`Variable CSS ${v} usada pero no definida`);

if (errors.length) {
    console.error(errors.map(e => '✖ ' + e).join('\n'));
    console.error(`\n${errors.length} problema(s).`);
    process.exit(1);
}
console.log(`✔ Lint correcto (${files.length} archivos JS, ${htmlIds.size} ids HTML, ${used.size} variables CSS).`);
