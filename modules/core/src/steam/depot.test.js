/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { downloadChunk, manifest } from './depot.js';

const KEY = Uint8Array.from({ length: 32 }, (_, i)=>i * 7 + 1);
const ACCESS = [
    { depot: 228990, gid: 1829726630299308803n, key: KEY, code: 18446744073709551615n },
];

test('a manifest the content server refuses is named without its request code', async t=>{
    t.mock.method(globalThis, 'fetch', async()=>new Response(null, { status: 401 }));
    const server = { host: 'cache1.example', vhost: 'cache1.example', type: 'CDN' };
    await assert.rejects(manifest(server, ACCESS[0]), error=>{
        const message = /** @type {Error} */ (error).message;
        assert.match(message, /depot\/228990\/manifest\/1829726630299308803 answered 401/);
        assert.doesNotMatch(message, /18446744073709551615/);
        return true;
    });
});

test('a server asked through the fetch a page hands in, for a manifest and a chunk', async t=>{
    const platform = t.mock.method(globalThis, 'fetch',
        async()=>new Response(null, { status: 500 }));
    /** @type {string[]} */
    const asked = [];
    /** @param {string} url */
    const get = async url=>{
        asked.push(url);
        return new Response(null, { status: 403 });
    };
    const server = { host: 'cache1.example', vhost: 'cache1.example', type: 'CDN' };
    await assert.rejects(manifest(server, ACCESS[0], get), /answered 403/);
    const chunk = { sha: new Uint8Array(20).fill(0xab), crc: 0, offset: 0n, size: 1,
        compressed: 1 };
    await assert.rejects(downloadChunk(server, 228990, /** @type {any} */ (chunk), KEY, get),
        /answered 403/);
    assert.deepEqual(asked.map(url=>new URL(url).pathname.split('/').slice(0, 4).join('/')),
        ['/depot/228990/manifest', '/depot/228990/chunk']);
    assert.equal(platform.mock.callCount(), 0, 'the platform\'s fetch is not asked');
});
