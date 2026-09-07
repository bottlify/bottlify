/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IID_IUNKNOWN, IUNKNOWN_METHODS, createComRegistry } from './objects.js';

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
        // Zero argBytes forgets `this`, which every thiscall method has.
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
