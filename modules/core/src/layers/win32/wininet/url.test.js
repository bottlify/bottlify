/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheme, createUrl, schemeName, schemeNumber } from './url.js';

/** @param {Partial<import('./url.js').UrlParts>} parts */
const build = parts=>createUrl({ scheme: null, nScheme: 0, host: null, port: 0, user: null,
    password: null, path: null, extra: null, ...parts });

const FULL = { scheme: 'http', nScheme: Scheme.HTTP, host: 'www.winehq.org', port: 80,
    user: 'username', password: 'password', path: '/site/about', extra: '' };

test('a URL is assembled from its parts, leaving out what is absent and the default port', ()=>{
    // Windows' answers, as Wine's tests record them.
    assert.equal(build(FULL), 'http://username:password@www.winehq.org/site/about');
    assert.equal(build({ ...FULL, scheme: null }),
        'http://username:password@www.winehq.org/site/about', 'nScheme names it');
    assert.equal(build({ ...FULL, password: null }), 'http://username@www.winehq.org/site/about');
    assert.equal(build({ ...FULL, password: '' }), 'http://username:@www.winehq.org/site/about');
    assert.equal(build({ ...FULL, user: null, password: null }),
        'http://www.winehq.org/site/about');
    assert.equal(build({ ...FULL, scheme: 'nhttp' }),
        'nhttp://username:password@www.winehq.org:80/site/about', 'the port follows the name');
    assert.equal(build({ ...FULL, port: 42 }),
        'http://username:password@www.winehq.org:42/site/about');
    assert.equal(build({ ...FULL, scheme: 'https', port: 443 }),
        'https://username:password@www.winehq.org/site/about');
    assert.equal(build({ scheme: 'about', path: 'blank' }), 'about:blank');
    assert.equal(build({ scheme: 'about', host: 'host', path: 'blank' }), 'about://host/blank');
    assert.equal(build({ scheme: 'about', port: 8080 }), 'about:');
    assert.equal(build({ scheme: 'http', host: 'www.winehq.org', port: 65535 }),
        'http://www.winehq.org:65535');
    assert.equal(build({ scheme: 'http', host: 'localhost', port: 80, path: '/',
        extra: '?test=123' }), 'http://localhost/?test=123');
    assert.equal(build({ scheme: 'http', host: 'h', path: '/a b' }), 'http://h/a b');
    assert.equal(createUrl({ ...FULL, path: '/a b' }, text=>text.replace(' ', '%20')),
        'http://username:password@www.winehq.org/a%20b', 'the escape sees the path only');
});

test('no scheme, or a password with no user, makes no URL', ()=>{
    assert.equal(build({ ...FULL, scheme: null, nScheme: Scheme.UNKNOWN }), null);
    assert.equal(build({ ...FULL, user: null }), null);
});

test('scheme names and numbers map both ways, and an unknown one is -1', ()=>{
    assert.equal(schemeNumber('HtTp'), Scheme.HTTP);
    assert.equal(schemeNumber('gopher'), Scheme.GOPHER);
    assert.equal(schemeNumber('res'), Scheme.RES);
    assert.equal(schemeNumber('fide'), -1);
    assert.equal(schemeNumber('unknown'), -1);
    assert.equal(schemeName(Scheme.HTTPS), 'https');
    assert.equal(schemeName(-3), null);
    assert.equal(schemeName(Scheme.UNKNOWN), null);
});
