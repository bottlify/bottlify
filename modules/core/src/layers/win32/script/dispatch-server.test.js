/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGuest } from './guest.fixture.js';
import { createDispatchServer, externalTarget } from './dispatch-server.js';
import {
    DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, DISPID_PROPERTYPUT,
    DISPID_STARTENUM, IID_IDISPATCHEX, createGuestBridge,
} from './guest-dispatch.js';
import { DISP_E_EXCEPTION, DISP_E_MEMBERNOTFOUND, ExternalError, hostObject } from './external.js';

const S_OK = 0;
const S_FALSE = 1;
const DISP_E_UNKNOWNNAME = 0x80020006 | 0;
/** IDispatch's slots, then IDispatchEx's. */
const GET_IDS_OF_NAMES = 5;
const INVOKE = 6;
const GET_DISP_ID = 7;
const GET_MEMBER_NAME = 12;
const GET_NEXT_DISP_ID = 13;

/** A server over a fake guest, and helpers to call it as the guest would. */
function setup(){
    const guest = createFakeGuest();
    /** @type {import('./dispatch-server.js').DispatchServer} */
    let server;
    const bridge = createGuestBridge(guest.com, {
        exportObject: value=>server.export(value, ()=>externalTarget(value)),
        findExported: pointer=>server.find(pointer),
    });
    server = createDispatchServer({ bridge, publish: guest.publish, clsid:
        '{F414C260-6AC0-11CF-B6D1-00AA00BBBB58}' });
    const { memory } = guest;

    /** @param {number} pointer @param {string} name @returns {Promise<[number, number]>} */
    const idOf = async(pointer, name)=>{
        const text = guest.allocate(name.length * 2 + 2);
        memory.setWide(text, name);
        const names = guest.allocate(8);
        memory.setU32(names, text);
        const hr = await guest.callMethod(pointer, GET_IDS_OF_NAMES, [0, names, 1, 0x409,
            names + 4]);
        return [hr, memory.i32(names + 4)];
    };
    /**
     * Invoke as a guest makes it: the arguments last first.
     *
     * @param {number} pointer @param {number} id @param {number} flags @param {any[]} args
     * @param {{ put?: any }} [options]
     */
    const invoke = async(pointer, id, flags, args, options = {})=>{
        const putting = 'put' in options;
        const count = args.length + (putting ? 1 : 0);
        const variants = guest.allocate(16 * Math.max(count, 1));
        let slot = 0;
        if (putting)
        {
            await guest.writeVariant(variants, options.put);
            slot++;
        }
        for (let i = args.length - 1; i >= 0; i--)
        {
            await guest.writeVariant(variants + 16 * slot++, args[i]);
        }
        const params = guest.allocate(20);
        memory.setU32(params, variants);
        memory.setU32(params + 4, params + 16);
        memory.setU32(params + 8, count);
        memory.setU32(params + 12, putting ? 1 : 0);
        memory.setU32(params + 16, DISPID_PROPERTYPUT);
        const result = guest.allocate(16);
        guest.bytes.fill(0, result, result + 16);
        const excepinfo = guest.allocate(32);
        guest.bytes.fill(0, excepinfo, excepinfo + 32);
        const hr = await guest.callMethod(pointer, INVOKE, [id, 0, 0x409, flags, params, result,
            excepinfo, 0]);
        return {
            hr,
            value: guest.readVariant(result),
            description: guest.readBstr(memory.u32(excepinfo + 8)),
            scode: memory.i32(excepinfo + 28),
        };
    };
    return { guest, bridge, server, idOf, invoke };
}

test('a host object handed to the guest answers IDispatch by name', async()=>{
    const { guest, server, idOf, invoke } = setup();
    /** @type {Map<string, any>} */
    const values = new Map();
    const host = hostObject({ members: {
        Value: { get: ()=>values.get('v') ?? 0, put: value=>{
            values.set('v', value);
        } },
        Twice: { call: ([n])=>n * 2 },
        Fail: { call: ()=>{
            throw new ExternalError(DISP_E_EXCEPTION, 'host failure', 'Host');
        } },
    } });
    const pointer = server.export(host, ()=>externalTarget(host));
    const [found, valueId] = await idOf(pointer, 'value');
    assert.equal(found, S_OK);
    assert.equal((await invoke(pointer, valueId, DISPATCH_PROPERTYPUT, [], { put: 12 })).hr, S_OK);
    assert.deepEqual(await invoke(pointer, valueId, DISPATCH_PROPERTYGET, []),
        { hr: S_OK, value: 12, description: '', scode: 0 });
    const [, twiceId] = await idOf(pointer, 'Twice');
    assert.equal((await invoke(pointer, twiceId, DISPATCH_METHOD, [21])).value, 42);
    const [, failId] = await idOf(pointer, 'Fail');
    const failed = await invoke(pointer, failId, DISPATCH_METHOD, []);
    assert.equal(failed.hr, DISP_E_EXCEPTION);
    assert.equal(failed.description, 'host failure');
    assert.equal(failed.scode, DISP_E_EXCEPTION);
    assert.deepEqual(await idOf(pointer, 'Missing'), [DISP_E_UNKNOWNNAME, -1]);
    assert.equal((await invoke(pointer, 99, DISPATCH_METHOD, [])).hr, DISP_E_MEMBERNOTFOUND);
    void guest;
});

test('one COM object per script object while the guest holds it', async()=>{
    const { guest, server } = setup();
    const key = hostObject({ members: {} });
    const first = server.export(key, ()=>externalTarget(key));
    const second = server.export(key, ()=>externalTarget(key));
    assert.equal(first, second);
    assert.equal(server.find(first), key);
    const object = guest.publishedObjects.get(first);
    assert.equal(object.refCount, 2);
    await guest.callMethod(first, 2, []);
    await guest.callMethod(first, 2, []);
    assert.equal(object.destroyed, true);
    assert.equal(server.find(first), undefined);
    const third = server.export(key, ()=>externalTarget(key));
    assert.notEqual(guest.publishedObjects.get(third), object,
        'a new object after the last release');
});

test('IDispatchEx: names by GetDispID, members walked by GetNextDispID', async()=>{
    const { guest, server } = setup();
    const { memory } = guest;
    /** @type {Map<string, any>} */
    const fields = new Map([['a', 1], ['b', 2]]);
    let next = 0;
    const pointer = server.export(fields, ()=>({
        dispId: name=>(fields.has(name) ? [...fields.keys()].indexOf(name) + 1 : -1),
        nameOf: id=>[...fields.keys()][id - 1] ?? null,
        invoke: ()=>next++,
        next: id=>(id === DISPID_STARTENUM ? 1 : id < fields.size ? id + 1 : -1),
        remove: ()=>false,
    }), IID_IDISPATCHEX);
    const name = guest.sysAllocString('b');
    const out = guest.allocate(8);
    assert.equal(await guest.callMethod(pointer, GET_DISP_ID, [name, 0, out]), S_OK);
    assert.equal(memory.i32(out), 2);
    const names = [];
    let id = DISPID_STARTENUM;
    while (await guest.callMethod(pointer, GET_NEXT_DISP_ID, [1, id, out]) === S_OK)
    {
        id = memory.i32(out);
        await guest.callMethod(pointer, GET_MEMBER_NAME, [id, out + 4]);
        names.push(guest.readBstr(memory.u32(out + 4)));
    }
    assert.deepEqual(names, ['a', 'b']);
    assert.equal(await guest.callMethod(pointer, GET_NEXT_DISP_ID, [1, 2, out]), S_FALSE);
});
