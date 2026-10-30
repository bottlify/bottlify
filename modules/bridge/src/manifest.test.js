/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { HOSTS, manifestFor } from './manifest.js';

test('the public build reaches Bottlify\'s own sites and the platforms, nothing local', ()=>{
    const manifest = manifestFor('public', '1.2.3');
    const pages = ['https://bottlify.app/*', 'https://play.bottlify.app/*'];
    assert.deepEqual(manifest.content_scripts[0].matches, pages);
    assert.deepEqual(manifest.web_accessible_resources[0].matches, pages);
    assert.doesNotMatch(JSON.stringify(manifest), /localhost|127\.0\.0\.1/);
    assert.equal(manifest.version, '1.2.3');
});

test('the dev build runs on any page, to the permissions too', ()=>{
    // A launcher on localhost, 127.0.0.1 or a LAN address: patterns take no
    // wildcard inside an address, so the dev build takes every page.
    const manifest = manifestFor('dev', '1.2.3');
    assert.deepEqual(manifest.content_scripts[0].matches, ['<all_urls>']);
    // A page the extension may not reach is a page the rules leave alone.
    assert.ok(manifest.host_permissions.includes('<all_urls>'));
});

test('every page is a host permission, and the CM socket is listed as wss', ()=>{
    for (const build of /** @type {const} */ (['public', 'dev']))
    {
        const manifest = manifestFor(build, '1.0.0');
        for (const page of manifest.content_scripts[0].matches)
        {
            assert.ok(manifest.host_permissions.includes(page), page);
        }
        assert.ok(manifest.host_permissions.includes('wss://*.steamserver.net/*'));
        for (const ruleset of manifest.declarative_net_request.rule_resources)
        {
            assert.ok(existsSync(new URL(`../${ruleset.path}`, import.meta.url)), ruleset.path);
        }
    }
});

test('the dev bridge answers on a local launcher and Bottlify\'s sites alone', ()=>{
    const hosts = new RegExp(/** @type {string} */ (HOSTS.dev));
    for (const host of ['localhost', 'bottlify.localhost', '127.0.0.1', '192.168.100.22',
        '192.168.0.5', 'bottlify.app', 'play.bottlify.app'])
    {
        assert.ok(hosts.test(host), host);
    }
    for (const host of ['example.com', '10.0.0.5', '192.169.1.1', 'evilbottlify.app',
        'bottlify.app.example.com', 'localhost.example.com', '1192.168.1.1'])
    {
        assert.ok(!hosts.test(host), host);
    }
    assert.equal(HOSTS.public, null, 'the public build is matched on its sites alone');
});
