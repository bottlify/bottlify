/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The publisher's side of an object's lifetime: what it remembers about an
 * interface pointer, and for how long.
 *
 * The vtable publisher underneath is stood in for, because what is being
 * checked here is the map back from a pointer -- the only thing this file owns
 * that outlives a call.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPublisher } from './com.js';
import { createVtables } from '../../bridge/internal/vtable.js';

const IID_ONE = '{00000001-0000-0000-C000-000000000046}';
const IID_TWO = '{00000002-0000-0000-C000-000000000046}';

/** A publisher over a stand-in for the bridge, which memoises the way it does. */
function publisher(){
    /** @type {WeakMap<any, Map<string, number>>} */
    const laid = new WeakMap();
    let next = 0x1000;
    return createPublisher({
        /** @param {any} object @param {string} id */
        publishInterface: (object, id)=>{
            let byInterface = laid.get(object);
            if (!byInterface)
            {
                byInterface = new Map();
                laid.set(object, byInterface);
            }
            const already = byInterface.get(id);
            if (already !== undefined)
            {
                return already;
            }
            next += 0x100;
            byInterface.set(id, next);
            return next;
        },
    });
}

/** An object that counts references the way the drawing APIs do. */
function counted(start = 1){
    let count = start;
    return {
        get refCount(){
            return count;
        },
        addRef: ()=>++count,
        release: ()=>(count > 0 ? --count : 0),
    };
}

const DESCRIPTORS = [{ id: IID_ONE, methods: [] }, { id: IID_TWO, methods: [] }];

test('an object released to nothing is not reachable through its pointer any more', ()=>{
    const seam = publisher();
    const api = counted();
    const pointer = seam.publish(api, DESCRIPTORS, IID_ONE);

    assert.equal(seam.objectAt(pointer), api);
    assert.equal(seam.count(), 1);

    assert.equal(seam.adapterFor(api).release(IID_ONE), 0);
    // Held for ever, this is what keeps a texture's vtable, its stubs and its
    // storage alive for the life of the process, and what makes the renderer's
    // weak accounting of textures say nothing at all.
    assert.equal(seam.objectAt(pointer), null,
        'a pointer the program has released resolves to nothing');
    assert.equal(seam.count(), 0);
});

test('a pointer QueryInterface laid out names its object once the reference is taken', ()=>{
    // The bridge answers a query from the object's own interfaces: it lays
    // the pointer out and takes the reference, and never calls `publish`. A
    // program hands such a pointer back -- SetTexture with an
    // IDirect3DTexture2, which exists only as a query's answer.
    /** @type {WeakMap<any, Map<string, number>>} */
    const laid = new WeakMap();
    let next = 0x1000;
    /** @param {any} object @param {string} id */
    const publishInterface = (object, id)=>{
        const byInterface = laid.get(object) ?? new Map();
        laid.set(object, byInterface);
        if (!byInterface.has(id))
        {
            next += 0x100;
            byInterface.set(id, next);
        }
        return /** @type {number} */ (byInterface.get(id));
    };
    const seam = createPublisher({ publishInterface });
    const api = counted();
    seam.publish(api, DESCRIPTORS, IID_ONE);
    const adapter = seam.adapterFor(api);

    const queried = publishInterface(adapter, IID_TWO);
    assert.equal(seam.objectAt(queried), null, 'laid out, and not yet known');
    adapter.addRef(IID_TWO);
    assert.equal(seam.objectAt(queried), api);
    assert.equal(seam.count(), 2);

    adapter.release(IID_TWO);
    assert.equal(adapter.release(IID_ONE), 0);
    assert.equal(seam.objectAt(queried), null, 'and it is given up with the others');
});

test('a pointer that was released and handed back again resolves once more', ()=>{
    // A device keeps its own surfaces: a program releases the back buffer and
    // asks for it again, and what it gets is the pointer it had before, which
    // has to work.
    const seam = publisher();
    const api = counted();
    const pointer = seam.publish(api, DESCRIPTORS, IID_ONE);
    seam.adapterFor(api).release(IID_ONE);

    api.addRef();
    assert.equal(seam.publish(api, DESCRIPTORS, IID_ONE), pointer, 'the same identity');
    assert.equal(seam.objectAt(pointer), api);
});

test('every interface an object was published as is given up together', ()=>{
    const seam = publisher();
    const api = counted();
    const one = seam.publish(api, DESCRIPTORS, IID_ONE);
    const two = seam.publish(api, DESCRIPTORS, IID_TWO);
    assert.notEqual(one, two);

    seam.adapterFor(api).release(IID_ONE);
    assert.equal(seam.objectAt(one), null);
    assert.equal(seam.objectAt(two), null, 'the second pointer named the same dead object');
});

test('an object whose generations count separately is kept until it says it is gone', ()=>{
    // DirectDraw: four QueryInterface calls leave four counts of one, and one
    // of them reaching zero says nothing about the object. The program is still
    // holding the other pointers and still calling through them.
    const counts = new Map([[IID_ONE, 1], [IID_TWO, 1]]);
    const api = {
        get destroyed(){
            return [...counts.values()].every(value=>value === 0);
        },
        /** @param {string} id */
        addRef: id=>counts.set(id, (counts.get(id) ?? 0) + 1).get(id),
        /** @param {string} id */
        release: id=>{
            counts.set(id, Math.max((counts.get(id) ?? 0) - 1, 0));
            return counts.get(id) ?? 0;
        },
    };
    const seam = publisher();
    const one = seam.publish(api, DESCRIPTORS, IID_ONE);
    const two = seam.publish(api, DESCRIPTORS, IID_TWO);

    assert.equal(seam.adapterFor(api).release(IID_ONE), 0);
    assert.equal(seam.objectAt(two), api, 'the generation still held is still callable');
    assert.equal(seam.objectAt(one), api);

    assert.equal(seam.adapterFor(api).release(IID_TWO), 0);
    assert.equal(seam.objectAt(one), null, 'and now the object itself is over');
    assert.equal(seam.objectAt(two), null);
});

test('an object that does not count references is never forgotten', ()=>{
    // Nothing it answers means "gone", so reading its Release as a zero would
    // drop a live object the first time a program let go of one of its own
    // references.
    const seam = publisher();
    const api = { name: 'counts nothing' };
    const pointer = seam.publish(api, DESCRIPTORS, IID_ONE);

    assert.equal(seam.adapterFor(api).release(IID_ONE), 0);
    assert.equal(seam.objectAt(pointer), api);
});

test('a null pointer, and one that was never published, are answered rather than refused', ()=>{
    const seam = publisher();
    assert.equal(seam.objectAt(0), null, 'unbinding a texture is SetTexture with a null');
    assert.equal(seam.objectAt(0x4000), null);
});

test('objects of one interface share one method list, and a call reaches its own object', ()=>{
    // The bridge keys its table of stubs by the method list's identity, so a
    // list built afresh per object was a table of stubs per object -- out of
    // sixteen thousand, which a program making a thousand textures used up.
    const p = publisher();
    /** @type {string[]} */
    const seen = [];
    const descriptor = { id: IID_ONE, methods: [
        { name: 'Draw', argBytes: 8,
            /** @param {any} api @param {number[]} args */
            invoke: (api, args)=>{ seen.push(`${api.name}:${args[0]}`); return 0; } },
    ] };
    const a = { name: 'a', ...counted() };
    const b = { name: 'b', ...counted() };
    p.publish(a, [descriptor], IID_ONE);
    p.publish(b, [descriptor], IID_ONE);
    const listA = p.adapterFor(a).interfaceFor(IID_ONE).methods;
    const listB = p.adapterFor(b).interfaceFor(IID_ONE).methods;
    assert.equal(listA, listB, 'one list for the interface, not one per object');
    assert.equal(p.adapterFor(a).interfaceFor(IID_ONE).methods, listA,
        'and the same list every time');

    const draw = listA[listA.length - 1];
    draw.invoke?.(p.adapterFor(b), [7]);
    draw.invoke?.(p.adapterFor(a), [9]);
    assert.deepEqual(seen, ['b:7', 'a:9'], 'the adapter the call arrived on names the object');
});

test('a descriptor is told of the last release while the pointers still resolve', ()=>{
    // State the guest set by pointer and the host has not read yet is
    // adopted then or never: after this the pointer names nothing.
    const seam = publisher();
    const api = counted(2);
    /** @type {string[]} */
    const seen = [];
    const descriptors = [{
        id: IID_ONE,
        methods: [],
        /** @param {any} target @param {Iterable<number>} pointers */
        released: (target, pointers)=>{
            seen.push(`${target === api} ${[...pointers].map(one=>one.toString(16)).join(',')}`
                + ` ${seam.objectAt(pointer) === api}`);
        },
    }];
    const pointer = seam.publish(api, descriptors, IID_ONE);

    assert.equal(seam.adapterFor(api).release(IID_ONE), 1);
    assert.deepEqual(seen, [], 'a reference remains');
    assert.equal(seam.adapterFor(api).release(IID_ONE), 0);
    assert.deepEqual(seen, [`true ${pointer.toString(16)} true`]);
    assert.equal(seam.objectAt(pointer), null, 'and then it is gone');
});

test('an interface without IUnknown lists its own methods from the first slot', ()=>{
    // A reflection's constant buffer and an effect's technique are such
    // interfaces: their first slot is their own first method, and a table
    // that began with QueryInterface would shift every call by three.
    const p = publisher();
    const methods = [
        { name: 'GetDesc', argBytes: 8, invoke: ()=>0 },
        { name: 'GetType', argBytes: 4, invoke: ()=>0 },
    ];
    const bare = { id: IID_ONE, bare: true, methods };
    const full = { id: IID_TWO, methods };
    const api = counted();
    p.publish(api, [bare, full], IID_ONE);
    const adapter = p.adapterFor(api);
    /** @param {string} id */
    const names = id=>adapter.interfaceFor(id).methods.map((/** @type {any} */ m)=>m.name);
    assert.deepEqual(names(IID_ONE), ['GetDesc', 'GetType']);
    assert.deepEqual(names(IID_TWO), ['QueryInterface', 'AddRef', 'Release', 'GetDesc', 'GetType']);
});

/**
 * The publisher over the bridge's own vtables, called through the stubs as a
 * guest calls them: what the bridge forgets is decided by the code that
 * decides it in a running program.
 */
function overTheBridge(){
    /** @type {Map<string, any>} */
    const handlers = new Map();
    let next = 0x2000;
    const vtables = createVtables({
        memory: { writeU32: ()=>{}, readBytes: (/** @type {number} */ at,
            /** @type {number} */ length)=>new Uint8Array(length) },
        register: (/** @type {string} */ name, /** @type {any} */ fn)=>{
            handlers.set(name, fn);
            return 0x1000 + handlers.size * 0x10;
        },
        heap: { allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        } },
    });
    return {
        seam: createPublisher({ publishInterface: (object, id)=>vtables.publish(object, id) }),
        /** @param {string} id @param {string} name @param {number} pointer */
        call: (id, name, pointer)=>handlers.get(`${id}::${name}`).handler([pointer]) >>> 0,
    };
}

const E_POINTER = 0x80004003;

test('an object whose last reference goes loses every interface pointer at the bridge', ()=>{
    // Released through one interface, the object is over: the pointer it was
    // published as through another must not go on reaching it.
    const { seam, call } = overTheBridge();
    const api = counted();
    const one = seam.publish(api, DESCRIPTORS, IID_ONE);
    const two = seam.publish(api, DESCRIPTORS, IID_TWO);

    assert.equal(call(IID_TWO, 'Release', two), 0);
    assert.equal(call(IID_ONE, 'AddRef', one), E_POINTER);
    assert.equal(call(IID_TWO, 'AddRef', two), E_POINTER);
});

test('a generation reaching zero at the bridge leaves the others the program holds', ()=>{
    // DirectDraw counts each generation apart: only the one whose count went
    // is forgotten, until the object says it is over.
    const counts = new Map([[IID_ONE, 1], [IID_TWO, 1]]);
    const api = {
        get destroyed(){
            return [...counts.values()].every(value=>value === 0);
        },
        /** @param {string} id */
        addRef: id=>counts.set(id, (counts.get(id) ?? 0) + 1).get(id),
        /** @param {string} id */
        release: id=>{
            counts.set(id, Math.max((counts.get(id) ?? 0) - 1, 0));
            return counts.get(id) ?? 0;
        },
    };
    const { seam, call } = overTheBridge();
    const one = seam.publish(api, DESCRIPTORS, IID_ONE);
    const two = seam.publish(api, DESCRIPTORS, IID_TWO);

    assert.equal(call(IID_ONE, 'Release', one), 0);
    assert.equal(call(IID_ONE, 'AddRef', one), E_POINTER, 'its own generation went');
    assert.equal(call(IID_TWO, 'AddRef', two), 2, 'the other is still the program\'s');
    assert.equal(call(IID_TWO, 'Release', two), 1);
    assert.equal(call(IID_TWO, 'Release', two), 0);
    assert.equal(call(IID_TWO, 'AddRef', two), E_POINTER);
});

test('an object that says it outlives its count is not ended by reaching zero', ()=>{
    // Only the interface released through is let go of: the object is still
    // there behind the others.
    const { seam, call } = overTheBridge();
    let count = 1;
    const api = {
        destroyed: false,
        addRef: ()=>++count,
        release: ()=>(count = Math.max(0, count - 1)),
    };
    const one = seam.publish(api, DESCRIPTORS, IID_ONE);
    const two = seam.publish(api, DESCRIPTORS, IID_TWO);
    assert.equal(call(IID_ONE, 'Release', one), 0);
    assert.equal(seam.adapterFor(api).destroyed, false);
    assert.equal(call(IID_TWO, 'AddRef', two), 1, 'the other pointer still reaches it');
});
