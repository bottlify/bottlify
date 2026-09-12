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

    // The table is the interface's, shared, and the pointer's first word names it.
    const vtable = Number(memory.get(pointer));
    assert.notEqual(vtable, pointer + 8, 'the table is not part of the object');
    assert.equal(memory.get(pointer + 4), '39612', 'the state word, 0x9abc');
    assert.equal(memory.get(vtable + 3 * 4), '28672', 'the slot holds the code, 0x7000');
    assert.equal(given.trap, 0x1000 + 4 * 0x10, 'built with Draw\'s own trap to fall back to');
    assert.equal(registered.filter(name=>name.endsWith('::Draw')).length, 1, 'which is registered');
    assert.equal(memory.get(vtable + 4 * 4), String(0x1000 + 5 * 0x10),
        'Present is a trap');
});

test('objects of one interface share its stubs, and a call still finds its own object', ()=>{
    // A table of stubs per object was a stub per method per object, and the
    // stub table holds sixteen thousand: a program that made a thousand
    // textures had used them all, and every later one was refused.
    /** @type {Map<string, any>} */
    const handlers = new Map();
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
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            handlers.set(name, fn);
            return 0x1000 + handlers.size * 0x10;
        },
        heap: { allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        } },
    });
    /** @type {string[]} */
    const drawn = [];
    const methods = [
        ...METHODS.slice(0, 3),
        { name: 'Draw', argBytes: 8,
            /** @param {any} self @param {number[]} args */
            invoke: (self, args)=>{ drawn.push(`${self.name}:${args[0]}`); return 0; } },
    ];
    /** @param {string} name */
    const make = name=>({
        name,
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods } : null),
        addRef: ()=>2,
        release: ()=>0,
    });
    const a = make('a');
    const b = make('b');
    const pointerA = table.publish(a, IID);
    const pointerB = table.publish(b, IID);
    assert.notEqual(pointerA, pointerB, 'two objects, two identities');
    assert.equal(handlers.size, 4, 'one set of stubs for the interface, not one per object');
    assert.equal(table.diagnostics().comMethods, 4);
    assert.equal(table.diagnostics().comInterfaces, 2);
    assert.equal(memory.get(pointerA), memory.get(pointerB), 'both point at the shared table');

    const draw = handlers.get(`${IID}::Draw`).handler;
    draw([pointerB, 7]);
    draw([pointerA, 9]);
    assert.deepEqual(drawn, ['b:7', 'a:9']);
    assert.equal(handlers.get(`${IID}::Draw`).lastError, false,
        'an HRESULT is the whole answer; the trace has no error to read after it');
    assert.equal(draw([0x9999, 1]) >>> 0, 0x80004003, 'a pointer nobody published is E_POINTER');

    // The last release forgets the pointer: the same words can be another
    // object's later without the stub finding the old one.
    const release = handlers.get(`${IID}::Release`).handler;
    assert.equal(release([pointerA]), 0);
    assert.equal(draw([pointerA, 1]) >>> 0, 0x80004003);
    assert.equal(table.diagnostics().comInterfaces, 1);
    assert.notEqual(table.publish(a, IID), pointerA, 'published again, it is a new pointer');
});

test('a method hands its implementation one argument array, until a call answers late', ()=>{
    // The arguments after the interface pointer are copied into an array the
    // method keeps: one allocation at registration, none per call. An
    // implementation that returns a promise still holds that array when the
    // next call comes, so the next call is given a new one.
    /** @type {Map<string, any>} */
    const handlers = new Map();
    let next = 0x2000;
    const table = createVtables({
        memory: {
            writeU32: ()=>{},
            /** @param {number} address @param {number} length */
            readBytes: (address, length)=>new Uint8Array(length),
        },
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            handlers.set(name, fn);
            return 0x1000 + handlers.size * 0x10;
        },
        heap: { allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        } },
    });
    /** @type {number[][]} */
    const given = [];
    let slow = false;
    const methods = [
        ...METHODS.slice(0, 3),
        { name: 'Draw', argBytes: 12,
            /** @param {any} self @param {number[]} args */
            invoke: (self, args)=>{
                given.push(args);
                return slow ? Promise.resolve(0) : 0;
            } },
    ];
    const pointer = table.publish({
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods } : null),
        addRef: ()=>2,
        release: ()=>1,
    }, IID);
    const draw = handlers.get(`${IID}::Draw`).handler;
    draw([pointer, 1, 2]);
    draw([pointer, 3, 4]);
    assert.equal(given[0], given[1], 'the same array for two prompt calls');
    assert.deepEqual(given[1], [3, 4], 'holding the latest arguments, without the pointer');
    slow = true;
    draw([pointer, 5, 6]);
    draw([pointer, 7, 8]);
    assert.equal(given[1], given[2], 'the call that answers late was given the shared array');
    assert.notEqual(given[2], given[3], 'and keeps it: the next call gets another');
    assert.deepEqual(given[2], [5, 6]);
});
