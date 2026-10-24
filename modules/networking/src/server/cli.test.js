/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArguments, permits } from './cli.js';

test('the defaults are a private LAN on a known port', ()=>{
    const parsed = parseArguments([]);

    assert.equal(parsed.port, 8787);
    assert.deepEqual(parsed.allow, [], 'nothing outside the room, unless asked');
    assert.deepEqual(parsed.origins, []);
    assert.equal(parsed.resumeSeconds, 10);
    assert.equal(parsed.addressHeader, '');
});

test('arguments are read, and repeated ones accumulate', ()=>{
    const parsed = parseArguments([
        '--port', '9000', '--host', '127.0.0.1',
        '--allow', 'a.example.com', '--allow', '*.example.net',
        '--origin', 'https://play.example.com',
        '--address-header', 'CF-Connecting-IP', '--resume-seconds', '30',
    ]);

    assert.equal(parsed.port, 9000);
    assert.equal(parsed.host, '127.0.0.1');
    assert.deepEqual(parsed.allow, ['a.example.com', '*.example.net']);
    assert.deepEqual(parsed.origins, ['https://play.example.com']);
    assert.equal(parsed.addressHeader, 'cf-connecting-ip');
    assert.equal(parsed.resumeSeconds, 30);
});

test('a resume window that is not a number is an error', ()=>{
    assert.throws(()=>parseArguments(['--resume-seconds', 'soon']), /wants a number/);
});

test('an argument nobody implements is an error rather than a silent default', ()=>{
    assert.throws(()=>parseArguments(['--proxy-everything']), /unknown argument/);
});

test('an empty allowlist permits nothing', ()=>{
    assert.equal(permits([], 'example.com'), false);
});

test('a rule of a star alone permits every host, and a star in a name does not', ()=>{
    assert.equal(permits(['*'], 'example.com'), true);
    assert.equal(permits(['*'], 'gds1.steampowered.com'), true);
    assert.equal(permits(['*example.com'], 'attacker.net'), false);
    assert.equal(permits(['*example.com'], 'notexample.com'), false);
});

test('an exact rule matches only that host', ()=>{
    assert.equal(permits(['example.com'], 'example.com'), true);
    assert.equal(permits(['example.com'], 'EXAMPLE.COM'), true);
    assert.equal(permits(['example.com'], 'other.com'), false);
    assert.equal(permits(['example.com'], 'sub.example.com'), false);
});

test('a suffix rule matches whole labels and cannot be walked past', ()=>{
    // The footgun this exists to avoid: a plain endsWith on ".example.com"
    // admits "example.com.attacker.net", and a plain endsWith on "example.com"
    // admits "notexample.com". Both hand an attacker the outbound bridge.
    assert.equal(permits(['*.example.com'], 'logon.example.com'), true);
    assert.equal(permits(['*.example.com'], 'a.b.example.com'), true);
    assert.equal(permits(['*.example.com'], 'example.com.attacker.net'), false);
    assert.equal(permits(['*.example.com'], 'notexample.com'), false);
    assert.equal(permits(['*.example.com'], 'example.com'), false,
        'the rule names subdomains, and the bare domain is not one');
});
