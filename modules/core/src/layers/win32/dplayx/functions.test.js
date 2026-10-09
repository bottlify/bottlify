/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DPERR_INVALIDPARAMS, DPERR_NOTLOBBIED, DPERR_UNAVAILABLE, DPERR_UNINITIALIZED,
    DPLAYX_ORDINALS, DP_OK, LOBBY_INTERFACES, PLAY_INTERFACES, createDplayFunctions,
} from './functions.js';

const make = ()=>{
    const memory = new Uint8Array(64).fill(0xcc);
    /** @type {{ object: any, id: string }[]} */
    const published = [];
    const fns = /** @type {Record<string, any>} */ (createDplayFunctions({
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readMemory: (at, length)=>memory.slice(at, at + length),
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
    const { fns, memory, u32 } = make();
    memory.fill(0x11, 32, 48);
    assert.equal(fns.DirectPlayEnumerateA.handler([0x400000, 0]), DP_OK);
    assert.equal(fns.DirectPlayEnumerateA.handler([0, 0]), DPERR_INVALIDPARAMS);
    assert.equal(DPERR_UNAVAILABLE, 0x887700fa, 'MAKE_DPHRESULT(250)');
    assert.equal(DPERR_NOTLOBBIED, 0x8877042e, 'MAKE_DPHRESULT(1070)');
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

test('GUID_NULL makes an unbound session object with every revision of IDirectPlay', ()=>{
    const { fns, memory, published, u32 } = make();
    memory.fill(0, 32, 48);
    assert.equal(fns.DirectPlayCreate.handler([32, 8, 0]), DP_OK);
    assert.equal(u32(8), 0x1000);
    const object = published[0].object;
    assert.equal(published[0].id, PLAY_INTERFACES[0].id, 'IDirectPlay is handed out');
    const counts = PLAY_INTERFACES.map(({ id })=>object.interfaceFor(id).methods.length - 3);
    assert.deepEqual(counts, [22, 29, 29, 39, 39, 50, 50]);
    const play4 = object.interfaceFor(PLAY_INTERFACES[6].id).methods;
    assert.equal(play4[49].name, 'SendEx');
    assert.equal(play4[49].argBytes, 40);
    assert.equal(play4[49].invoke(object, []), DPERR_UNINITIALIZED);
    assert.equal(play4.find((/** @type {any} */ m)=>m.name === 'EnumConnections')
        .invoke(object, []), DP_OK);
});
