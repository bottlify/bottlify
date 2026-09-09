/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What publishing an interface does when it cannot finish: the two resources it
 * spends -- guest memory for the table, a stub per method -- both run out, and
 * an interface half in memory is worse than none.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVtables } from './vtable.js';

const IID = '{00000001-0000-0000-C000-000000000046}';

/** An object with two methods of its own, after the three of IUnknown. */
const METHODS = [
    { name: 'QueryInterface', argBytes: 12, builtin: 'queryInterface' },
    { name: 'AddRef', argBytes: 4, builtin: 'addRef' },
    { name: 'Release', argBytes: 4, builtin: 'release' },
    { name: 'Draw', argBytes: 8 },
    { name: 'Present', argBytes: 4 },
];

const object = {
    /** @param {string} id */
    interfaceFor: id=>(id === IID ? { id, methods: METHODS } : null),
    addRef: ()=>1,
    release: ()=>0,
};

/**
 * @param {Object} limits
 * @param {number} [limits.stubs]  How many stubs there are left to take.
 * @param {boolean} [limits.heap]  Whether the arena has room.
 */
function vtables({ stubs = Infinity, heap = true }){
    /** @type {Map<number, string>} */
    const memory = new Map();
    let left = stubs;
    let next = 0x2000;
    return createVtables({
        memory: {
            /** @param {number} address @param {number} value */
            writeU32: (address, value)=>memory.set(address, String(value)),
            /** @param {number} address @param {number} length */
            readBytes: (address, length)=>new Uint8Array(length),
        },
        /** @param {string} name */
        register: name=>{
            if (left-- <= 0)
            {
                throw new Error(`cpu: the stub table is full at ${stubs} slots;`
                    + ` no room to register ${name}`);
            }
            next += 0x10;
            return next;
        },
        heap: {
            /** @param {number} size */
            allocate: size=>{
                if (!heap)
                {
                    return 0;
                }
                next += size;
                return next;
            },
        },
    });
}

test('an interface whose stubs cannot be taken is refused rather than half published', ()=>{
    // Five methods, four slots left. Answering a pointer here would hand the
    // guest a table whose last entries were never written -- addresses outside
    // the region the stubs live in, which is the guest's own stack.
    const table = vtables({ stubs: 4 });
    assert.equal(table.publish(object, IID), 0);

    const seen = table.diagnostics();
    assert.equal(seen.comInterfaces, 0, 'nothing was counted as published');
    assert.match(String(seen.comRefusedBecause), /stub table is full/,
        'and a run says why it started refusing interfaces');
    assert.equal(seen.comInterfacesRefused, 1);
});

test('an interface with nowhere to lay its table is refused as well', ()=>{
    const table = vtables({ heap: false });
    assert.equal(table.publish(object, IID), 0);
    assert.equal(table.diagnostics().comInterfaces, 0);
});

test('an interface that fits is published once and answers the same pointer after', ()=>{
    const table = vtables({ stubs: 5 });
    const pointer = table.publish(object, IID);
    assert.notEqual(pointer, 0);
    assert.equal(table.publish(object, IID), pointer, 'one interface is one identity');
    assert.equal(table.diagnostics().comInterfaces, 1);
    assert.equal(table.diagnostics().comMethods, 5, 'IUnknown\'s three and its own two');
    assert.equal(table.diagnostics().comInterfacesRefused, 0);
});

test('a method that runs in the guest takes its slot, and keeps its trap to fall back to', ()=>{
    // The object's state word sits one word past the vtable pointer, which is
    // where such a method finds the memory it works on.
    /** @type {string[]} */
    const registered = [];
    /** @type {Map<number, string>} */
    const memory = new Map();
    let next = 0x2000;
    const table = createVtables({
        memory: {
            /** @param {number} address @param {number} value */
            writeU32: (address, value)=>memory.set(address, String(value)),
            /** @param {number} address @param {number} length */
            readBytes: (address, length)=>new Uint8Array(length),
        },
        /** @param {string} name */
        register: name=>{
            registered.push(name);
            return 0x1000 + registered.length * 0x10;
        },
        heap: { allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        } },
    });
    /** @type {any} */
    let given = null;
    const guestObject = {
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods: [
            ...METHODS.slice(0, 3),
            { name: 'Draw', argBytes: 8, guest: (/** @type {any} */ builder)=>{
                given = builder;
                return 0x7000;
            } },
            { name: 'Present', argBytes: 4 },
        ] } : null),
        addRef: ()=>1,
        release: ()=>0,
        guestState: ()=>0x9abc,
    };

    const pointer = table.publish(guestObject, IID);

    assert.equal(memory.get(pointer), String(pointer + 8), 'the vtable follows the two words');
    assert.equal(memory.get(pointer + 4), '39612', 'the state word, 0x9abc');
    assert.equal(memory.get(pointer + 8 + 3 * 4), '28672', 'the slot holds the code, 0x7000');
    assert.equal(given.trap, 0x1000 + 4 * 0x10, 'built with Draw\'s own trap to fall back to');
    assert.equal(registered.filter(name=>name.endsWith('::Draw')).length, 1, 'which is registered');
    assert.equal(memory.get(pointer + 8 + 4 * 4), String(0x1000 + 5 * 0x10),
        'Present is a trap');
});
