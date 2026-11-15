/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IID_IUNKNOWN, IUNKNOWN_METHODS, createComObject, createComRegistry } from './objects.js';

const CLSID_TEST = '{11111111-2222-3333-4444-555555555555}';
const IID_FIRST = '{AAAAAAAA-0001-0000-C000-000000000046}';
const IID_SECOND = '{AAAAAAAA-0002-0000-C000-000000000046}';
const IID_ABSENT = '{AAAAAAAA-0003-0000-C000-000000000046}';

/**
 * Two interfaces on one object, which is the shape COM identity is about.
 * `Draw` takes `this` plus one argument, so its argBytes is 8.
 *
 * @param {{ destroyed?: number }} [log]
 */
function definition(log = {}){
    return {
        interfaces: [
            {
                id: IID_FIRST,
                methods: [
                    { name: 'Draw', argBytes: 8 },
                    { name: 'Flush', argBytes: 4 },
                ],
            },
            { id: IID_SECOND, methods: [{ name: 'Resize', argBytes: 12 }] },
        ],
        state: { pixels: 1 },
        destroy: ()=>{
            log.destroyed = (log.destroyed ?? 0) + 1;
        },
    };
}

/** @param {{ destroyed?: number }} [log] */
function setup(log){
    const registry = createComRegistry();
    registry.registerClass(CLSID_TEST, ()=>definition(log));
    return registry;
}

test('a class is found under either case of its GUID', ()=>{
    const registry = createComRegistry();
    registry.registerClass(CLSID_TEST.toLowerCase(), ()=>definition());
    assert.equal(registry.isRegistered(CLSID_TEST), true);
    assert.equal(registry.isRegistered(CLSID_TEST.toLowerCase()), true);
    assert.ok(registry.create(CLSID_TEST));
});

test('an unregistered class produces nothing', ()=>{
    const registry = setup();
    assert.equal(registry.isRegistered(IID_ABSENT), false);
    assert.equal(registry.create(IID_ABSENT), null);
    assert.equal(registry.isRegistered('not a guid'), false);
    assert.equal(registry.create('not a guid'), null);
});

test('a registered class whose factory declines is registered but produces nothing', ()=>{
    const registry = createComRegistry();
    registry.registerClass(CLSID_TEST, ()=>null);
    assert.equal(registry.isRegistered(CLSID_TEST), true);
    assert.equal(registry.create(CLSID_TEST), null);
});

test('registration refuses a malformed GUID and a miscounted argument list', ()=>{
    const registry = createComRegistry();
    assert.throws(()=>registry.registerClass('{oops}', ()=>definition()), /not a GUID/);

    registry.registerClass(CLSID_TEST, ()=>({
        // Zero argBytes forgets the interface pointer, which every COM
        // method is passed as its first argument.
        interfaces: [{ id: IID_FIRST, methods: [{ name: 'Draw', argBytes: 0 }] }],
    }));
    assert.throws(()=>registry.create(CLSID_TEST), /argBytes must count/);
});

test('a new object arrives with exactly one reference', ()=>{
    const object = setup().create(CLSID_TEST);
    assert.ok(object);
    assert.equal(object.refCount, 1);
    assert.equal(object.destroyed, false);
});

test('an object something else owns counts only its callers, from zero, and outlives zero', ()=>{
    /** @type {{ destroyed?: number }} */
    const log = {};
    const registry = createComRegistry();
    registry.registerClass(CLSID_TEST, ()=>({ ...definition(log), owned: true }));
    const object = /** @type {any} */ (registry.create(CLSID_TEST));
    assert.equal(object.refCount, 0);
    assert.equal(object.addRef(), 1);
    assert.equal(object.release(), 0);
    assert.equal(object.release(), 0, 'no count below zero');
    assert.equal(object.destroyed, false);
    assert.equal(log.destroyed, undefined);
    assert.ok(object.queryInterface(IID_FIRST));
    assert.equal(object.refCount, 1);
});

test('AddRef and Release report the count they produced', ()=>{
    const object = /** @type {any} */ (setup().create(CLSID_TEST));
    assert.equal(object.addRef(), 2);
    assert.equal(object.addRef(), 3);
    assert.equal(object.release(), 2);
    assert.equal(object.release(), 1);
});

test('the last Release destroys the object exactly once', ()=>{
    /** @type {{ destroyed?: number }} */
    const log = {};
    const object = /** @type {any} */ (setup(log).create(CLSID_TEST));
    object.addRef();
    assert.equal(object.release(), 1);
    assert.equal(log.destroyed, undefined);

    assert.equal(object.release(), 0);
    assert.equal(object.destroyed, true);
    assert.equal(log.destroyed, 1);

    // An over-release is a guest bug, not a reason to run the destructor twice.
    assert.equal(object.release(), 0);
    assert.equal(log.destroyed, 1);
    assert.throws(()=>object.addRef(), /released object/);
    assert.equal(object.interfaceFor(IID_FIRST), null);
});

test('QueryInterface takes a reference and a failed one does not', ()=>{
    const object = /** @type {any} */ (setup().create(CLSID_TEST));
    assert.ok(object.queryInterface(IID_FIRST));
    assert.equal(object.refCount, 2);

    assert.equal(object.queryInterface(IID_ABSENT), null);
    assert.equal(object.refCount, 2);

    // Publishing a vtable needs the record, not a reference to it.
    assert.ok(object.interfaceFor(IID_FIRST));
    assert.equal(object.refCount, 2);
});

test('every object answers to IID_IUnknown with the same record', ()=>{
    const object = /** @type {any} */ (setup().create(CLSID_TEST));
    const first = object.queryInterface(IID_FIRST);
    const second = object.queryInterface(IID_SECOND);
    assert.notEqual(first, second);

    const throughFirst = first.object.queryInterface(IID_IUNKNOWN);
    const throughSecond = second.object.queryInterface(IID_IUNKNOWN);
    assert.ok(throughFirst);
    // The pointer a program compares comes from this record, so the two roads to
    // IUnknown have to arrive at one object.
    assert.equal(throughFirst, throughSecond);
    assert.equal(throughFirst.id, IID_IUNKNOWN);
    assert.equal(throughFirst.methods.length, IUNKNOWN_METHODS.length);
});

test('asking twice for one interface answers with one record', ()=>{
    const object = /** @type {any} */ (setup().create(CLSID_TEST));
    assert.equal(object.queryInterface(IID_FIRST), object.queryInterface(IID_FIRST));
    assert.equal(object.interfaceFor(IID_FIRST.toLowerCase()),
        object.interfaceFor(IID_FIRST));
});

test('a vtable begins with IUnknown and continues in declaration order', ()=>{
    const object = /** @type {any} */ (setup().create(CLSID_TEST));
    const record = object.interfaceFor(IID_FIRST);
    assert.deepEqual(record.methods.map(/** @param {any} m */ m=>m.name),
        ['QueryInterface', 'AddRef', 'Release', 'Draw', 'Flush']);
    assert.deepEqual(record.methods.map(/** @param {any} m */ m=>m.argBytes),
        [12, 4, 4, 8, 4]);
    assert.deepEqual(record.methods.slice(0, 3).map(/** @param {any} m */ m=>m.builtin),
        ['queryInterface', 'addRef', 'release']);
    assert.equal(record.object, object);
    assert.deepEqual(object.state, { pixels: 1 });
});

test('objects of one interface description hand the bridge one method list', ()=>{
    // The bridge builds a table -- a stub per method, and guest code for a
    // method that has some -- once per list it is given. A list per object
    // built it again for every object: the effects a program recreated on
    // each change of its settings ran the stub table out.
    const descriptor = { id: '{11111111-2222-3333-4444-555555555555}',
        methods: [{ name: 'Draw', argBytes: 8 }] };
    const clsid = '{11111111-2222-3333-4444-666666666666}';
    const one = createComObject(clsid, { interfaces: [descriptor] });
    const two = createComObject(clsid, { interfaces: [descriptor] });
    const first = one.interfaceFor(descriptor.id);
    const second = two.interfaceFor(descriptor.id);
    assert.notEqual(first, second, 'each object has its own interface record');
    assert.equal(first?.methods, second?.methods);
    assert.deepEqual(first?.methods.map((/** @type {any} */ method)=>method.name),
        ['QueryInterface', 'AddRef', 'Release', 'Draw']);
});

test('an object counting in a word of guest memory sees the guest\'s references there', ()=>{
    const word = new Uint32Array(1);
    let destroyed = 0;
    const object = createComObject('{00000000-0000-0000-0000-0000000000AA}', {
        interfaces: [], destroy: ()=>{
            destroyed++;
        },
        count: { address: 0x4000, read: ()=>word[0], write: value=>{
            word[0] = value;
        } },
    });
    assert.equal(word[0], 1, 'the caller\'s reference, in the word');
    assert.equal(object.countCell?.(), 0x4000);
    object.addRef();
    assert.equal(word[0], 2);
    // The guest's AddRef and Release change the word alone.
    word[0] = 5;
    assert.equal(object.refCount, 5);
    word[0] = 1;
    assert.equal(object.release(), 0, 'the last reference comes to the host');
    assert.equal(destroyed, 1);
    assert.equal(object.countCell?.(), 0, 'a destroyed object names no word');
});

test('an aggregated object counts its own IUnknown and hands its other faces to the outer one',
    async()=>{
        const registry = createComRegistry();
        registry.registerClass(CLSID_TEST, ()=>({ ...definition(), aggregatable: true }));
        /** @type {[number, number[]][]} */
        const calls = [];
        const aggregation = {
            outer: 0x5000,
            call: async(/** @type {number} */ slot, /** @type {number[]} */ args)=>{
                calls.push([slot, args]);
                return slot === 0 ? 0 : 7;
            },
        };

        const object = /** @type {import('./objects.js').ComObject} */ (
            registry.createAggregated(CLSID_TEST, aggregation));
        assert.equal(object.aggregation, aggregation);
        assert.equal(object.interfaceFor(IID_IUNKNOWN)?.methods[0].builtin, 'queryInterface',
            'its own IUnknown is the non-delegating one');
        const first = /** @type {any} */ (object.interfaceFor(IID_FIRST));
        assert.equal(first.methods[0].builtin, undefined, 'another face delegates');
        assert.equal(first.methods[3].name, 'Draw', 'its own methods follow');

        assert.equal(object.addRef(IID_IUNKNOWN), 2, 'a reference on IUnknown is the inner one\'s');
        assert.equal(await object.addRef(IID_FIRST), 7, 'one on another face is the outer\'s');
        assert.deepEqual(calls, [[1, []]]);
        await first.methods[0].invoke(object, [0x10, 0x20]);
        assert.deepEqual(calls[1], [0, [0x10, 0x20]], 'QueryInterface through it goes outward');
    });

test('a class that may not be aggregated says so rather than making an object', ()=>{
    /** @type {{ destroyed?: number }} */
    const log = {};
    const registry = setup(log);
    assert.equal(registry.createAggregated(CLSID_TEST, { outer: 1, call: async()=>0 }), false);
    assert.equal(log.destroyed, 1, 'what the factory made is let go');
});
