/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TO, readRequest } from './protocol.js';

test('a message not addressed to the bridge is not read', ()=>{
    for (const data of [null, 'hello', 7, {}, { to: 'other', id: 1, op: 'hello' },
        { to: TO, op: 'hello' }, { to: TO, id: 1.5, op: 'hello' }])
    {
        assert.equal(readRequest(data), null);
    }
});

test('an unknown op is refused with its id', ()=>{
    assert.deepEqual(readRequest({ to: TO, id: 3, op: 'refreshToken' }),
        { id: 3, error: 'no op refreshToken' });
    // An op named by what every object has is not an op.
    assert.equal('error' in /** @type {any} */ (readRequest({ to: TO, id: 4, op: 'toString' })), true);
});

test('arguments are checked and only those the op takes are passed on', ()=>{
    assert.deepEqual(readRequest({ to: TO, id: 1, op: 'steam.depotKey',
        args: { app: 228980, depot: 228990, extra: 'x' } }),
    { id: 1, op: 'steam.depotKey', args: { app: 228980, depot: 228990 } });
    assert.match(/** @type {any} */ (readRequest({ to: TO, id: 2, op: 'steam.depotKey',
        args: { app: -1, depot: 1 } })).error, /app is not a valid uint/);
    assert.match(/** @type {any} */ (readRequest({ to: TO, id: 2, op: 'steam.depotKey',
        args: { app: 2 ** 32, depot: 1 } })).error, /app/);
});

test('a manifest id is a decimal string within 64 bits; the branch is optional', ()=>{
    const ask = (/** @type {any} */ args)=>readRequest({ to: TO, id: 9, op: 'steam.manifestCode', args });
    assert.deepEqual(ask({ app: 1, depot: 2, gid: '18446744073709551615' }),
        { id: 9, op: 'steam.manifestCode', args: { app: 1, depot: 2, gid: '18446744073709551615',
            branch: undefined } });
    assert.match(/** @type {any} */ (ask({ app: 1, depot: 2, gid: '18446744073709551616' })).error, /gid/);
    assert.match(/** @type {any} */ (ask({ app: 1, depot: 2, gid: 5 })).error, /gid/);
    assert.match(/** @type {any} */ (ask({ app: 1, depot: 2, gid: '5', branch: 7 })).error, /branch/);
});

test('product info is asked for a list of app ids, at least one and at most 20000', ()=>{
    const ask = (/** @type {any} */ apps)=>readRequest({ to: TO, id: 5, op: 'steam.productInfo',
        args: { apps } });
    assert.deepEqual(ask([70, 228980]),
        { id: 5, op: 'steam.productInfo', args: { apps: [70, 228980] } });
    for (const apps of [[], 70, ['70'], [70, -1], [1.5], Array.from({ length: 20001 }, (_, i)=>i)])
    {
        assert.match(/** @type {any} */ (ask(apps)).error, /apps is not a valid uints/,
            JSON.stringify(apps).slice(0, 40));
    }
});
