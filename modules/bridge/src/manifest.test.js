/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { HOSTS, PLATFORMS, manifestFor } from './manifest.js';
import { STEAM_ART } from './stores/steam/apps.js';

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
            assert.ok(existsSync(new URL(`../../${ruleset.path}`, import.meta.url)), ruleset.path);
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

/**
 * Whether a host permission reaches a domain: Chrome applies a rule's header
 * changes only where the extension may reach the request's URL.
 *
 * @param {string[]} permissions @param {string} domain
 */
const reaches = (permissions, domain)=>permissions.some(pattern=>{
    const host = /^[a-z*]+:\/\/([^/]+)\//.exec(pattern)?.[1] ?? '';
    return host === domain || (host.startsWith('*.')
        && (domain === host.slice(2) || domain.endsWith(host.slice(1))));
});

test('every host a platform\'s rules change is a host permission of both builds', ()=>{
    for (const [id, platform] of Object.entries(PLATFORMS))
    {
        const rules = JSON.parse(
            readFileSync(new URL(`../${platform.rules}`, import.meta.url), 'utf8'));
        for (const build of /** @type {const} */ (['public', 'dev']))
        {
            const manifest = manifestFor(build, '1.0.0');
            for (const domain of rules.flatMap((/** @type {any} */ rule)=>rule.condition.requestDomains))
            {
                assert.ok(reaches(manifest.host_permissions, domain), `${build} ${id}: ${domain}`);
            }
        }
    }
});

test('the art a library shows is opened to the page as an image, under Steam\'s art hosts', ()=>{
    const rules = JSON.parse(readFileSync(new URL('../rules/steam.json', import.meta.url), 'utf8'));
    const art = rules.find((/** @type {any} */ rule)=>rule.condition.resourceTypes.includes('image'));
    assert.ok(art, 'a rule for images');
    assert.deepEqual(art.action.responseHeaders.map((/** @type {any} */ one)=>one.header).sort(),
        ['Access-Control-Allow-Origin', 'Cross-Origin-Resource-Policy']);
    assert.ok(art.condition.requestDomains.includes(new URL(STEAM_ART).hostname));
    for (const host of ['cdn.akamai.steamstatic.com', 'shared.cloudflare.steamstatic.com'])
    {
        assert.ok(art.condition.requestDomains.includes(host), `${host}: older bottles' art`);
    }
    const publicBuild = manifestFor('public', '1.0.0');
    assert.deepEqual(publicBuild.content_scripts[0].matches,
        ['https://bottlify.app/*', 'https://play.bottlify.app/*'], 'pages stay Bottlify\'s own');
});

test('a store\'s sign-in page may be framed by Bottlify\'s sites alone, publicly', ()=>{
    for (const build of /** @type {const} */ (['public', 'dev']))
    {
        const manifest = manifestFor(build, '1.0.0');
        const framed = manifest.web_accessible_resources
            .filter((/** @type {any} */ entry)=>entry.resources.some((/** @type {string} */ path)=>
                path.endsWith('/signin.html')));
        assert.equal(framed.length, 1, build);
        assert.deepEqual(framed[0].resources, Object.keys(PLATFORMS).map(id=>`${id}/signin.html`));
        assert.deepEqual(framed[0].matches, build === 'public'
            ? ['https://bottlify.app/*', 'https://play.bottlify.app/*'] : ['<all_urls>'],
        'the dev build\'s page checks the host that frames it (HOSTS)');
    }
});
