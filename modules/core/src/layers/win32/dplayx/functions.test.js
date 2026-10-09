/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DPERR_INVALIDPARAMS, DPERR_NOTLOBBIED, DPERR_UNAVAILABLE, DPLAYX_ORDINALS, DP_OK,
    LOBBY_INTERFACES, createDplayFunctions,
} from './functions.js';

const make = ()=>{
    const memory = new Uint8Array(64).fill(0xcc);
    /** @type {{ object: any, id: string }[]} */
    const published = [];
    const fns = /** @type {Record<string, any>} */ (createDplayFunctions({
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        vtables: { publish: (object, id)=>(published.push({ object, id }), 0x1000) },
    }));
    const u32 = (/** @type {number} */ at)=>new DataView(memory.buffer).getUint32(at, true);
    return { fns, memory, published, u32 };
};

test('every ordinal names an export the library provides', ()=>{
    const { fns } = make();
    for (const name of Object.values(DPLAYX_ORDINALS))
    {
        assert.ok(fns[name], name);
    }
    assert.equal(DPLAYX_ORDINALS[4], 'DirectPlayLobbyCreateA');
});

test('no service provider: enumeration calls nothing, a session cannot be made', ()=>{
    const { fns, u32 } = make();
    assert.equal(fns.DirectPlayEnumerateA.handler([0x400000, 0]), DP_OK);
    assert.equal(fns.DirectPlayEnumerateA.handler([0, 0]), DPERR_INVALIDPARAMS);
    assert.equal(fns.DirectPlayCreate.handler([0x20, 8, 0]), DPERR_UNAVAILABLE);
    assert.equal(u32(8), 0, 'the out pointer is cleared');
    assert.equal(fns.DirectPlayCreate.argBytes, 12);
});

test('the lobby is made and says the program was not launched by one', ()=>{
    const { fns, published, u32 } = make();
    assert.equal(fns.DirectPlayLobbyCreateA.handler([0, 8, 0, 0, 0]), DP_OK);
    assert.equal(u32(8), 0x1000);
    assert.equal(published[0].id, LOBBY_INTERFACES[1], 'the ANSI interface');
    const object = published[0].object;
    for (const [index, id] of LOBBY_INTERFACES.entries())
    {
        const methods = object.interfaceFor(id).methods;
        assert.equal(methods.length, 3 + [11, 12, 16][index >> 1], id);
    }
    const lobby3 = object.interfaceFor(LOBBY_INTERFACES[5]).methods;
    const settings = lobby3.find((/** @type {any} */ m)=>m.name === 'GetConnectionSettings');
    assert.equal(lobby3.indexOf(settings), 3 + 5);
    assert.equal(settings.invoke(object, [0, 0, 0]), DPERR_NOTLOBBIED);
    assert.equal(fns.DirectPlayLobbyCreateA.handler([0, 0, 0, 0, 0]), DPERR_INVALIDPARAMS);
    assert.equal(fns.DirectPlayLobbyCreateA.handler([0, 16, 4, 0, 0]), DPERR_INVALIDPARAMS);
    assert.equal(u32(16), 0, 'an aggregated lobby is refused with nothing written');
});
