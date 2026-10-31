/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manifest, readDepotAccess, writeDepotAccess } from './depot.js';

const KEY = Uint8Array.from({ length: 32 }, (_, i)=>i * 7 + 1);
const ACCESS = [
    { depot: 228990, gid: 1829726630299308803n, key: KEY, code: 18446744073709551615n },
    { depot: 229020, gid: 5799761707845834510n, key: new Uint8Array(32), code: 1n },
];

test('depot access goes through JSON and comes back the same', ()=>{
    const wire = JSON.parse(JSON.stringify(writeDepotAccess(ACCESS)));
    assert.equal(wire[0].key, Buffer.from(KEY).toString('hex'));
    assert.equal(wire[0].gid, '1829726630299308803');
    assert.equal(wire[0].code, '18446744073709551615');
    assert.deepEqual(readDepotAccess(wire), ACCESS);
    assert.deepEqual(readDepotAccess([{ ...wire[0], key: wire[0].key.toUpperCase() }])[0].key, KEY);
});

test('depot access that is not one is refused, and the refusal shows no key or code', ()=>{
    const [good] = writeDepotAccess(ACCESS);
    const bad = [
        null, {}, [], 'x', [null],
        [{ ...good, depot: 0 }], [{ ...good, depot: 2 ** 32 }], [{ ...good, depot: '228990' }],
        [{ ...good, gid: 1829726630 }], [{ ...good, gid: '18446744073709551616' }],
        [{ ...good, gid: '-1' }], [{ ...good, code: '0' }], [{ ...good, code: '1e5' }],
        [{ ...good, key: good.key.slice(2) }], [{ ...good, key: `${good.key.slice(2)}zz` }],
        [{ ...good, key: Array.from(KEY) }], [good, good],
        Array.from({ length: 1025 }, (_, i)=>({ ...good, depot: i + 1 })),
    ];
    for (const value of bad)
    {
        assert.throws(()=>readDepotAccess(value), error=>{
            const message = /** @type {Error} */ (error).message;
            assert.doesNotMatch(message, new RegExp(`${good.key}|${good.code}`));
            return /depot access/.test(message);
        }, JSON.stringify(value)?.slice(0, 80));
    }
});

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
