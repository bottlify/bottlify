/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DPERR_INVALIDPARAMS, DPERR_NOTLOBBIED, DPERR_UNAVAILABLE, DPERR_UNINITIALIZED,
    CLSID_DIRECTPLAY, CLSID_DIRECTPLAY_LOBBY, DPLAYX_ORDINALS, DP_OK, LOBBY_INTERFACES,
    PLAY_INTERFACES, createDplayFunctions, registerDplayClasses,
} from './functions.js';
import { createComObject, createComRegistry } from '../ole32/objects.js';
import {
    DPERR_BUFFERTOOSMALL, DPERR_NOMESSAGES, DPERR_NOSESSIONS, DPSPGUID_TCPIP, guidBytes,
    sessionDefinition,
} from './session.js';

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
        .invoke(object, [0, 0, 0, 0]), DPERR_INVALIDPARAMS);
});

test('CoCreateInstance makes the session object unbound and the lobby, as the exports do', ()=>{
    const registry = createComRegistry();
    registerDplayClasses(registry,
        { writeMemory: ()=>{}, readMemory: (_, length)=>new Uint8Array(length) });
    const play = /** @type {any} */ (registry.create(CLSID_DIRECTPLAY.toLowerCase()));
    assert.ok(play);
    const counts = PLAY_INTERFACES.map(({ id })=>play.interfaceFor(id).methods.length - 3);
    assert.deepEqual(counts, [22, 29, 29, 39, 39, 50, 50]);
    const play4 = play.interfaceFor(PLAY_INTERFACES[6].id).methods;
    assert.equal(play4.find((/** @type {any} */ m)=>m.name === 'Open').invoke(play, []),
        DPERR_UNINITIALIZED);
    const lobby = /** @type {any} */ (registry.create(CLSID_DIRECTPLAY_LOBBY));
    assert.ok(lobby);
    for (const id of LOBBY_INTERFACES)
    {
        assert.ok(lobby.interfaceFor(id), id);
    }
    const connect = lobby.interfaceFor(LOBBY_INTERFACES[5]).methods
        .find((/** @type {any} */ m)=>m.name === 'Connect');
    assert.equal(connect.invoke(lobby, []), DPERR_NOTLOBBIED);
});

test('bound to TCP/IP, a session hosted here carries messages between its local players', async()=>{
    const memory = new Uint8Array(0x4000);
    const dv = new DataView(memory.buffer);
    let heapTop = 0x2000;
    /** @type {number[][]} */
    const callbacks = [];
    const play = createComObject(CLSID_DIRECTPLAY, sessionDefinition({
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        readMemory: (at, length)=>memory.slice(at, at + length),
        allocate: bytes=>(heapTop += bytes) - bytes,
        callGuest: async(entry, args)=>(callbacks.push([entry, ...args]), 1),
    }, PLAY_INTERFACES));
    const methods = /** @type {any} */ (play.interfaceFor(PLAY_INTERFACES[6].id)).methods;
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        methods.find((/** @type {any} */ m)=>m.name === name).invoke(play, args);

    assert.equal(await call('EnumConnections', [0, 0x401000, 7, 1]), DP_OK);
    assert.equal(callbacks.length, 1);
    const [entry, spGuid, connection, connectionSize, , , context] = callbacks[0];
    assert.equal(entry, 0x401000);
    assert.equal(context, 7);
    assert.equal(connectionSize, 36);
    assert.deepEqual(memory.slice(spGuid, spGuid + 16), guidBytes(DPSPGUID_TCPIP));
    assert.deepEqual(memory.slice(connection + 20, connection + 36), guidBytes(DPSPGUID_TCPIP));

    assert.equal(call('Open', [0x100, 2]), DPERR_UNINITIALIZED, 'unbound until a connection');
    assert.equal(call('InitializeConnection', [connection, 0]), DP_OK);
    assert.equal(call('Open', [0x100, 1]), DPERR_NOSESSIONS, 'nothing elsewhere to join');
    dv.setUint32(0x100, 80, true);
    assert.equal(call('Open', [0x100, 2]), DP_OK);

    assert.equal(call('CreatePlayer', [0x200, 0, 0, 0, 0, 0]), DP_OK);
    assert.equal(call('CreatePlayer', [0x204, 0, 0, 0, 0, 0]), DP_OK);
    const [one, two] = [dv.getUint32(0x200, true), dv.getUint32(0x204, true)];
    assert.notEqual(one, two);

    memory.set([1, 2, 3], 0x300);
    assert.equal(call('Send', [one, 0, 0, 0x300, 3]), DP_OK, 'to all: the other player');
    dv.setUint32(0x410, 1, true);
    assert.equal(call('Receive', [0x400, 0x404, 1, 0x500, 0x410]), DPERR_BUFFERTOOSMALL);
    assert.equal(dv.getUint32(0x410, true), 3);
    assert.equal(call('Receive', [0x400, 0x404, 1, 0x500, 0x410]), DP_OK);
    assert.deepEqual([...memory.slice(0x500, 0x503)], [1, 2, 3]);
    assert.deepEqual([dv.getUint32(0x400, true), dv.getUint32(0x404, true)], [one, two]);
    assert.equal(call('Receive', [0x400, 0x404, 1, 0x500, 0x410]), DPERR_NOMESSAGES);

    dv.setUint32(0x610, 0, true);
    assert.equal(call('GetSessionDesc', [0, 0x610]), DPERR_BUFFERTOOSMALL);
    assert.equal(call('GetSessionDesc', [0x700, 0x610]), DP_OK);
    assert.equal(dv.getUint32(0x700 + 44, true), 2, 'two players in it');
});
