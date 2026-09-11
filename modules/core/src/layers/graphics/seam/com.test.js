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
