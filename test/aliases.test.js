'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { aliasSectionsFor, inSections } = require('../server/sections');

test('Raras incluye /enfermedades_raras y Respiratorio /epoc-bajo-control', () => {
    const secs = [
        { label: 'Raras', url: 'https://www.azmed.cr/es/home/rare-disease.html' },
        { label: 'Respiratorio', url: 'https://www.azmed.cr/es/home/respiratorio.html' }
    ];
    const a = aliasSectionsFor(secs);
    assert.ok(inSections('https://www.azmed.cr/es/home/enfermedades_raras/Patologia_hnp.html', a.prefixes));
    assert.ok(inSections('https://www.azmed.cr/es/home/epoc-bajo-control/test-puma.html', a.prefixes));
    assert.ok(inSections('https://www.azmed.cr/es/home/azeventos/respiratorio/la-voz-pulmonar.html', a.prefixes));
    assert.ok(!inSections('https://www.azmed.cr/es/home/mismo-cancer.html', a.prefixes));
    assert.ok(!inSections('https://www.azmed.cr/es/home/azeventos/oncologia/deshemascarando.html', a.prefixes));
    assert.ok(a.seeds.length > 5);
});
