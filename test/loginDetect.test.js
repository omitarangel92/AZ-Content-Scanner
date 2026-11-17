const test = require('node:test');
const assert = require('node:assert/strict');
const { isLoginUrl, isIdpHost } = require('../server/loginDetect');

test('detecta pantallas de login por ruta o proveedor de identidad', () => {
    assert.equal(isLoginUrl('https://www.azmed.cr/es/login.html'), true);
    assert.equal(isLoginUrl('https://www.azmed.cr/sso/callback'), true);
    assert.equal(isLoginUrl('https://identity.astrazeneca.com/authorize'), true);
    assert.equal(isLoginUrl('https://login.veevavault.com/'), true);
    assert.equal(isLoginUrl('https://kmc.kaltura.com/index.php/kmcng/login'), true);
});

test('no confunde rutas legítimas que contienen "sso" o "login" dentro de otra palabra', () => {
    assert.equal(isLoginUrl('https://www.azmed.cr/es/association-events'), false);
    assert.equal(isLoginUrl('https://www.azmed.cr/sso-news'), false);
    assert.equal(isLoginUrl('https://www.azmed.cr/es/home?next=/login'), false);
    assert.equal(isLoginUrl('https://www.azmed.cr/'), false);
});

test('URLs inválidas no rompen', () => {
    assert.equal(isLoginUrl('no es una url'), false);
    assert.equal(isIdpHost(''), false);
});
