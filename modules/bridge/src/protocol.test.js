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
    assert.deepEqual(readRequest({ to: TO, id: 1, op: 'download',
        args: { store: 'steam', game: '70', extra: 'x' } }),
    { id: 1, op: 'download', args: { store: 'steam', game: '70' } });
    const ask = (/** @type {string} */ op, /** @type {any} */ args)=>
        /** @type {any} */ (readRequest({ to: TO, id: 2, op, args })).error;
    assert.match(ask('download', { store: 'Steam', game: '70' }), /store is not a valid store/);
    assert.match(ask('download', { store: 'steam', game: 70 }), /game is not a valid game/);
    assert.match(ask('download', { store: 'steam', game: 'a/b' }), /game/);
    assert.match(ask('cover', { store: 'steam', game: '70', kind: 'logo' }), /kind/);
    assert.match(ask('list', { store: 'steam', fresh: 'yes' }), /fresh/);
    assert.equal(ask('list', { store: 'steam' }), undefined, 'fresh is optional');
});

test('no op names a store\'s protocol', ()=>{
    for (const op of ['steam.depotKey', 'depotKey', 'manifestCode', 'productInfo', 'contentServers',
        'appOwnershipTicket'])
    {
        assert.match(/** @type {any} */ (readRequest({ to: TO, id: 3, op })).error, /no op/, op);
    }
});
