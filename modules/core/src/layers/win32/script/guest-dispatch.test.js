/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGuest } from './guest.fixture.js';
import {
    DISPATCH_METHOD, DISPATCH_PROPERTYGET, DISPATCH_PROPERTYPUT, GuestDispatch, createGuestBridge,
} from './guest-dispatch.js';
import { DISP_E_UNKNOWNNAME, ExternalError } from './external.js';

/** A bridge over a fake guest; script objects export as a fixed pointer. */
function setup(){
    const guest = createFakeGuest();
    const bridge = createGuestBridge(guest.com, { exportObject: ()=>0 });
    return { guest, bridge };
}

test('get, put and call go through GetIDsOfNames and Invoke with IDispatch\'s flags',
    async()=>{
        const { guest, bridge } = setup();
        /** @type {Map<string, any>} */
        const store = new Map();
        const object = guest.dispatchObject({
            Property: { get: ([name])=>store.get(name) ?? '', put: (value, [name])=>{
                store.set(name, value);
            } },
            Add: { call: ([a, b])=>a + b },
            Count: { get: ()=>3 },
        });
        const proxy = await bridge.importInterface(object.pointer, 'dispatch', false);
        assert.ok(proxy instanceof GuestDispatch);
        await proxy.put('property', 'value', ['X']);
        assert.equal(await proxy.get('PROPERTY', ['X']), 'value');
        assert.equal(await proxy.call('Add', [2, 3.5]), 5.5);
        assert.equal(await proxy.get('Count', []), 3);
        assert.deepEqual(object.invokes.map(({ name, flags, args })=>[name, flags, args]), [
            ['Property', DISPATCH_PROPERTYPUT, ['X', 'value']],
            ['Property', DISPATCH_PROPERTYGET, ['X']],
            ['Add', DISPATCH_METHOD | DISPATCH_PROPERTYGET, [2, 3.5]],
            ['Count', DISPATCH_PROPERTYGET, []],
        ]);
        assert.equal(await proxy.has('add'), true);
        assert.equal(await proxy.has('Nope'), false);
        await assert.rejects(proxy.call('Nope', []), e=>e instanceof ExternalError
            && e.number === DISP_E_UNKNOWNNAME);
    });

test('an exception the object describes comes back with its description', async()=>{
    const { guest, bridge } = setup();
    const object = guest.dispatchObject({ Fail: { call: ()=>{
        throw new Error('broken');
    } } });
    const proxy = await bridge.importInterface(object.pointer, 'dispatch', false);
    const before = guest.live.size;
    await assert.rejects(proxy.call('Fail', ['arg']), e=>e instanceof ExternalError
        && e.number === (0x800a0001 | 0) && e.description === 'broken' && e.source === 'Fixture');
    assert.equal(guest.live.size, before, 'the arguments and the EXCEPINFO strings are freed');
});

test('one proxy per pointer, holding one reference until the engine lets go', async()=>{
    const { guest, bridge } = setup();
    const object = guest.dispatchObject({ Me: { get: ()=>({ pointer: object.pointer }) } });
    const first = await bridge.importInterface(object.pointer, 'dispatch', false);
    assert.equal(object.refs, 2);
    const again = await first.get('Me', []);
    assert.equal(again, first, 'the same pointer is the same object');
    assert.equal(object.refs, 2, 'the answer\'s reference was given back');
    await bridge.releaseAll();
    assert.equal(object.refs, 1);
});

test('an object passed as an argument carries a reference for the callee', async()=>{
    const { guest, bridge } = setup();
    /** @type {any} */
    let received;
    const target = guest.dispatchObject({ Take: { call: ([value])=>{
        received = value;
        return 0;
    } } });
    const argument = guest.dispatchObject({});
    const proxy = await bridge.importInterface(target.pointer, 'dispatch', false);
    const passed = await bridge.importInterface(argument.pointer, 'dispatch', false);
    await proxy.call('Take', [passed]);
    assert.deepEqual(received, { pointer: argument.pointer });
    assert.equal(argument.refs, 2, 'the call\'s reference was released after it');
});

test('a collection is walked through DISPID_NEWENUM\'s IEnumVARIANT', async()=>{
    const { guest, bridge } = setup();
    const object = guest.dispatchObject({}, { items: ['a', 2, 'c'] });
    const proxy = await bridge.importInterface(object.pointer, 'dispatch', false);
    const enumerator = await proxy.enumerate();
    const seen = [];
    for (let step = await enumerator.next(); !step.done; step = await enumerator.next())
    {
        seen.push(step.value);
    }
    assert.deepEqual(seen, ['a', 2, 'c']);
    await enumerator.reset();
    assert.deepEqual(await enumerator.next(), { done: false, value: 'a' });
});

test('the default member is DISPID_VALUE', async()=>{
    const { guest, bridge } = setup();
    const object = guest.dispatchObject({}, { value: ()=>'default' });
    const proxy = await bridge.importInterface(object.pointer, 'dispatch', false);
    assert.equal(await proxy.get(null, []), 'default');
});
