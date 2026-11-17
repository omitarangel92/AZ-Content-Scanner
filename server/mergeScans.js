// Cola de áreas: une los resúmenes de varios escaneos (uno por área) en un único informe consolidado.
// Lógica pura, sin dependencias del motor.

const UNRESOLVED = new Set(['SIN FECHA FIABLE', 'ID NO ENCONTRADO']);
const CAP = 300;
const SUM_FIELDS = ['pagesRead', 'pagesFailed', 'brokenLinks', 'pagesNeedingLogin', 'wafBlocked', 'duplicatesSkipped',
    'sitemapUrls', 'sitemapStale', 'imagesOcr', 'imagesByNameOnly', 'pdfsFull', 'pdfsByNameOnly',
    'videosChecked', 'videosWithoutId', 'hiddenTextIds'];
const LIST_FIELDS = ['failures', 'brokenLinkList', 'loginPages', 'sitemapStaleList'];

// parts: [{ label, summary|null, error|null, attempts }]  (summary es el resultado de runScan para esa área)
function mergeSummaries(parts, { scanId, durationSeconds } = {}) {
    const done = parts.filter(p => p.summary);
    const byKey = new Map();     // ID de aprobación → fila consolidada
    const noId = new Map();      // assetUrl → fila "SIN ID"

    for (const p of done) {
        for (const a of p.summary.assets || []) {
            if (a.veevaApprovalId === 'SIN ID') {
                if (!noId.has(a.assetUrl) && noId.size < 200) noId.set(a.assetUrl, { ...a });
                continue;
            }
            const cur = byKey.get(a.veevaApprovalId);
            if (!cur) { byKey.set(a.veevaApprovalId, { ...a, pages: [...(a.pages || [])], _areas: [p.label] }); continue; }
            cur.pages = [...new Set([...cur.pages, ...(a.pages || [])])];
            cur.type = [...new Set(`${cur.type} + ${a.type}`.split(' + '))].join(' + ');
            if (!cur.assetUrl && a.assetUrl) cur.assetUrl = a.assetUrl;
            if (!cur.screenshot && a.screenshot) cur.screenshot = a.screenshot;
            // Si en un área PromoMats no dio fecha y en otra sí, gana la que tiene fecha
            if (UNRESOLVED.has(cur.status) && !UNRESOLVED.has(a.status)) {
                Object.assign(cur, { status: a.status, approvedDate: a.approvedDate, expirationDate: a.expirationDate, daysRemaining: a.daysRemaining, note: a.note });
            }
            if (!cur._areas.includes(p.label)) cur._areas.push(p.label);
        }
    }

    const assets = [...byKey.values(), ...noId.values()].map((a, i) => {
        const { _areas, ...row } = a;
        return { ...row, id: i + 1, pagesCount: (row.pages || []).length || row.pagesCount || 1, areas: _areas || undefined };
    });
    const count = (s) => assets.filter(a => a.status === s).length;
    const vencidos = count('VENCIDO'), proximos = count('PROXIMO A VENCER'), vigentes = count('VIGENTE'), retirados = count('RETIRADO');

    const coverage = {
        scope: { mode: 'areas', sections: parts.map(p => p.label) },
        astrazenecaSeen: done.some(p => p.summary.coverage.astrazenecaSeen),
        ocrAvailable: done.every(p => p.summary.coverage.ocrAvailable !== false),
        ocrNote: (done.find(p => p.summary.coverage.ocrNote) || { summary: { coverage: {} } }).summary.coverage.ocrNote || '',
        partial: false, partialReasons: [], acceptedOverlays: []
    };
    SUM_FIELDS.forEach(f => { coverage[f] = done.reduce((n, p) => n + (p.summary.coverage[f] || 0), 0); });
    LIST_FIELDS.forEach(f => { coverage[f] = done.flatMap(p => p.summary.coverage[f] || []).slice(0, CAP); });

    const overlays = new Map();
    for (const p of done) for (const o of p.summary.coverage.acceptedOverlays || []) overlays.set(o.text, (overlays.get(o.text) || 0) + o.times);
    coverage.acceptedOverlays = [...overlays].map(([text, times]) => ({ text, times }));

    for (const p of parts) {
        if (!p.summary) {
            coverage.partial = true;
            coverage.partialReasons.push(`Área «${p.label}» no se pudo analizar${p.error ? `: ${p.error}` : ''}. Vuelve a escanearla sola.`);
            continue;
        }
        if (p.summary.coverage.partial) {
            coverage.partial = true;
            for (const r of p.summary.coverage.partialReasons || []) coverage.partialReasons.push(`[${p.label}] ${r}`);
        }
    }

    coverage.areas = parts.map(p => ({
        label: p.label,
        status: !p.summary ? 'error' : p.summary.coverage.partial ? 'parcial' : 'completo',
        attempts: p.attempts || 1,
        pagesRead: p.summary ? p.summary.coverage.pagesRead : 0,
        idsFound: p.summary ? (p.summary.totalAnalyzed || 0) : 0,
        error: p.error || null
    }));

    return {
        scanId,
        totalAnalyzed: assets.length,
        vencidos, proximosAVencer: proximos, vigentes, retirados,
        sinFechaFiable: assets.length - vencidos - proximos - vigentes - retirados,
        pagesScanned: coverage.pagesRead,
        imagesAnalyzed: coverage.imagesOcr + coverage.imagesByNameOnly,
        durationSeconds: durationSeconds || done.reduce((n, p) => n + (p.summary.durationSeconds || 0), 0),
        outcome: coverage.partial ? 'PARCIAL' : 'COMPLETO',
        sections: parts.map(p => p.label),
        queue: true,
        coverage,
        assets
    };
}

module.exports = { mergeSummaries };
