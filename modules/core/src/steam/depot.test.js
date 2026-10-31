/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifest } from './depot.js';

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
