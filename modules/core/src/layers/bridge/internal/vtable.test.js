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

test('objects whose lists are made afresh share the stubs of their shape, each its own method',
    ()=>{
        // An object model that builds its method list for every object -- a
        // stream per file an installer logs -- took a table of stubs per
        // object, and the stubs are never given back: the thousandth stream
        // was refused as out of memory.
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
                handlers.set(`${name}#${handlers.size}`, fn);
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
        /** @param {string} name */
        const make = name=>{
            const methods = [
                ...METHODS.slice(0, 3),
                { name: 'Draw', argBytes: 8,
                    /** @param {any} _self @param {number[]} args */
                    invoke: (_self, args)=>{
                        drawn.push(`${name}:${args[0]}`);
                        return 0;
                    } },
            ];
            return {
                /** @param {string} id */
                interfaceFor: id=>(id === IID ? { id, methods } : null),
                addRef: ()=>2,
                release: ()=>1,
            };
        };
        const pointers = ['a', 'b', 'c'].map(name=>table.publish(make(name), IID));
        assert.equal(handlers.size, 4, 'one set of stubs, whoever built the list');
        const draw = [...handlers].find(([name])=>name.includes('::Draw'))?.[1].handler;
        draw([pointers[2], 1]);
        draw([pointers[0], 2]);
        assert.deepEqual(drawn, ['c:1', 'a:2'], 'each call runs its own object\'s method');

        // Another shape is another table: a slot popping a different count
        // cannot share a stub with it.
        const wider = {
            /** @param {string} id */
            interfaceFor: id=>(id === IID
                ? { id, methods: [...METHODS.slice(0, 3), { name: 'Draw', argBytes: 12 }] }
                : null),
            addRef: ()=>2,
            release: ()=>1,
        };
        table.publish(wider, IID);
        assert.equal(handlers.size, 8);
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

test('an object still reachable at a count of zero keeps its pointer until it is not', ()=>{
    // A DirectSound device keeps its primary buffer: a program may release every
    // reference and call it again through the same pointer, and Wine's dsound
    // test does exactly that. Forgetting the pointer at zero answered E_POINTER,
    // and the words behind it could by then be another object's.
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
    let owned = true;
    let count = 1;
    const kept = {
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods: METHODS } : null),
        addRef: ()=>++count,
        release: ()=>(count = Math.max(0, count - 1)),
        reachable: ()=>count > 0 || owned,
    };
    const other = {
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods: METHODS } : null),
        addRef: ()=>2,
        release: ()=>1,
    };
    const pointer = table.publish(kept, IID);
    const elsewhere = table.publish(other, IID);
    const addRef = handlers.get(`${IID}::AddRef`).handler;
    const release = handlers.get(`${IID}::Release`).handler;

    assert.equal(release([pointer]), 0);
    assert.equal(addRef([pointer]), 1, 'still the same object behind the same pointer');
    assert.equal(release([pointer]), 0);
    assert.equal(release([pointer]), 0);
    assert.equal(table.publish(kept, IID), pointer, 'asked for again, the same pointer');
    assert.equal(table.diagnostics().comInterfaces, 2);

    // Its owner goes; the next release anywhere finds it unreachable.
    owned = false;
    release([elsewhere]);
    assert.equal(addRef([pointer]), 0, 'now it is forgotten');
    assert.equal(table.diagnostics().comInterfaces, 1);
});

/** @param {string} guid  Braced, as the object models key interfaces. */
function guidBytes(guid){
    const hex = guid.replace(/[{}-]/g, '');
    const at = (/** @type {number} */ from, /** @type {number} */ count)=>Array.from(
        { length: count }, (_, i)=>parseInt(hex.slice(from + i * 2, from + i * 2 + 2), 16));
    return new Uint8Array([
        ...at(0, 4).reverse(), ...at(8, 2).reverse(), ...at(12, 2).reverse(), ...at(16, 8),
    ]);
}

const IID_B = '{00000002-0000-0000-C000-000000000046}';
const IID_C = '{00000003-0000-0000-C000-000000000046}';

/**
 * A publisher over memory that keeps what is written to it, so that a
 * QueryInterface finds the GUID it was asked for and a test can call any
 * interface pointer through the shared stubs as a guest would.
 */
function interfaces(){
    /** @type {Map<string, any>} */
    const handlers = new Map();
    /** @type {Map<number, number>} */
    const words = new Map();
    /** @type {Map<number, Uint8Array>} */
    const guids = new Map();
    /** @type {number[]} */
    const freed = [];
    let next = 0x2000;
    const table = createVtables({
        memory: {
            /** @param {number} address @param {number} value */
            writeU32: (address, value)=>words.set(address, value),
            /** @param {number} address @param {number} length */
            readBytes: (address, length)=>guids.get(address) ?? new Uint8Array(length),
        },
        /** @param {string} name @param {any} fn */
        register: (name, fn)=>{
            handlers.set(name, fn);
            return 0x1000 + handlers.size * 0x10;
        },
        heap: {
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += bytes;
                return at;
            },
            free: (/** @type {number} */ address)=>freed.push(address),
        },
    });
    /** @param {string} name @param {number} pointer @param {number[]} [args] */
    const call = (name, pointer, args = [])=>handlers.get(`${IID}::${name}`).handler(
        [pointer, ...args]) >>> 0;
    return {
        table,
        freed,
        call,
        /** @param {number} pointer @param {string} iid @returns {number} the pointer answered */
        query(pointer, iid){
            const riid = 0x9000 + guids.size * 0x10;
            guids.set(riid, guidBytes(iid));
            assert.equal(call('QueryInterface', pointer, [riid, 0x8000]), 0);
            return /** @type {number} */ (words.get(0x8000));
        },
    };
}

/** Every interface an object has, sharing one method list as a real vtable would. */
const EVERY = [IID, IID_B, IID_C];

test('the last reference to an object forgets every interface it was published as', ()=>{
    // A pointer from an earlier QueryInterface must not outlive the object:
    // through it the stub would find the released object, and its words
    // would never go back to the heap.
    const f = interfaces();
    let count = 1;
    const methods = [...METHODS.slice(0, 3),
        { name: 'Draw', argBytes: 8, invoke: ()=>0 }];
    const counted = {
        /** @param {string} id */
        interfaceFor: id=>(EVERY.includes(id) ? { id, methods } : null),
        addRef: ()=>++count,
        release: ()=>--count,
        get destroyed(){
            return count === 0;
        },
    };
    const first = f.table.publish(counted, IID);
    const second = f.query(first, IID_B);
    assert.notEqual(second, first);
    assert.equal(f.call('Release', first), 1);
    assert.equal(f.call('Draw', second, [1]), 0, 'the object lives while the second is held');
    assert.equal(f.call('Release', second), 0);

    assert.equal(f.call('Draw', first, [1]), 0x80004003, 'the first interface went with it');
    assert.equal(f.call('Draw', second, [1]), 0x80004003);
    assert.deepEqual(f.freed.sort(), [first, second].sort(), 'and both blocks went back');
    assert.equal(f.table.diagnostics().comInterfaces, 0);
});

test('an object counting per interface loses only the interface whose count went', ()=>{
    // DirectDraw's generations each keep a count, and one reaching zero says
    // nothing about the others: their pointers are still the program's. An
    // older Direct3D interface shares a generation's count, and goes when it
    // does -- with everything else, once the object says it is over.
    const f = interfaces();
    /** @type {Map<string, number>} */
    const counts = new Map([[IID, 1]]);
    /** @param {string} id */
    const generation = id=>(id === IID_C ? IID_B : id);
    const methods = [...METHODS.slice(0, 3),
        { name: 'Draw', argBytes: 8, invoke: ()=>0 }];
    const counted = {
        /** @param {string} id */
        interfaceFor: id=>(EVERY.includes(id) ? { id, methods } : null),
        /** @param {string} id */
        addRef: id=>{
            counts.set(generation(id), (counts.get(generation(id)) ?? 0) + 1);
            return counts.get(generation(id));
        },
        /** @param {string} id */
        release: id=>{
            counts.set(generation(id), (counts.get(generation(id)) ?? 0) - 1);
            return counts.get(generation(id));
        },
        get destroyed(){
            return [...counts.values()].every(count=>count === 0);
        },
    };
    const first = f.table.publish(counted, IID);
    const second = f.query(first, IID_B);
    const shared = f.query(second, IID_C);

    assert.equal(f.call('Release', first), 0);
    assert.equal(f.call('Draw', first, [1]), 0x80004003, 'its own generation went');
    assert.equal(f.call('Draw', second, [1]), 0, 'another generation is still held');
    assert.equal(f.call('Draw', shared, [1]), 0);

    assert.equal(f.call('Release', second), 1);
    assert.equal(f.call('Release', shared), 0);
    assert.equal(f.call('Draw', second, [1]), 0x80004003,
        'the object is over, and so is the generation that shared the count');
    assert.equal(f.call('Draw', shared, [1]), 0x80004003);
    assert.equal(f.table.diagnostics().comInterfaces, 0);
});

test('an object that does not say it is over loses only the interface released through', ()=>{
    // Without the word, a zero is the end of the interface it came through,
    // which is true of every way of counting.
    const f = interfaces();
    const counted = {
        /** @param {string} id */
        interfaceFor: id=>(EVERY.includes(id) ? { id, methods: METHODS } : null),
        addRef: ()=>1,
        release: ()=>0,
    };
    const first = f.table.publish(counted, IID);
    const second = f.query(first, IID_B);
    assert.equal(f.call('Release', second), 0);
    assert.equal(f.call('AddRef', second), 0);
    assert.equal(f.call('AddRef', first), 1);
});

test('an object that is over keeps each interface still reachable, and only those', ()=>{
    const f = interfaces();
    let count = 1;
    let kept = true;
    const counted = {
        /** @param {string} id */
        interfaceFor: id=>(EVERY.includes(id) ? { id, methods: METHODS } : null),
        addRef: ()=>++count,
        release: ()=>(count = Math.max(0, count - 1)),
        get destroyed(){
            return count === 0;
        },
        /** @param {string} id */
        reachable: id=>count > 0 || (kept && id === IID_B),
    };
    const other = {
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods: METHODS } : null),
        addRef: ()=>2,
        release: ()=>1,
    };
    const first = f.table.publish(counted, IID);
    const second = f.query(first, IID_B);
    const third = f.query(first, IID_C);
    const elsewhere = f.table.publish(other, IID);
    assert.equal(f.call('Release', second), 2);
    assert.equal(f.call('Release', third), 1);
    assert.equal(f.call('Release', first), 0);

    assert.equal(f.call('AddRef', first), 0, 'nothing keeps the first');
    assert.equal(f.call('AddRef', third), 0, 'nor the third');
    assert.equal(f.call('Release', second), 0, 'the second is kept, and answers');
    kept = false;
    f.call('Release', elsewhere);
    assert.equal(f.call('Release', second), 0, 'until nothing keeps it either');
    assert.equal(f.table.diagnostics().comInterfaces, 1);
});

test('an object is told each pointer of its that the bridge forgets, as it forgets it', ()=>{
    // A map an object model keeps from pointers back to objects has to drop
    // the entry then: the words go back to the heap, and the next interface
    // laid there is another object's.
    const f = interfaces();
    let count = 1;
    let kept = true;
    /** @type {[number, string][]} */
    const told = [];
    const counted = {
        /** @param {string} id */
        interfaceFor: id=>(EVERY.includes(id) ? { id, methods: METHODS } : null),
        addRef: ()=>++count,
        release: ()=>(count = Math.max(0, count - 1)),
        get destroyed(){
            return count === 0;
        },
        /** @param {string} id */
        reachable: id=>kept && id === IID_B,
        /** @param {number} pointer @param {string} id */
        forgotten: (pointer, id)=>told.push([pointer, id]),
    };
    const first = f.table.publish(counted, IID);
    const second = f.query(first, IID_B);
    assert.equal(f.call('Release', second), 1);
    assert.deepEqual(told, [], 'nothing is forgotten while the object is held');
    assert.equal(f.call('Release', first), 0);
    assert.deepEqual(told, [[first, IID]], 'the one nothing keeps goes at once');

    kept = false;
    f.call('Release', f.table.publish({
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods: METHODS } : null),
        addRef: ()=>2,
        release: ()=>1,
    }, IID));
    assert.deepEqual(told, [[first, IID], [second, IID_B]], 'and the kept one once it is not');
});

test('an interface nothing can release is given back when whoever made it says so', ()=>{
    // A table without IUnknown -- a shader reflection's constant buffer, an
    // effect's technique -- has no Release for the program to call. The
    // object that handed it out ends it, when that object itself ends.
    const f = interfaces();
    /** @type {[number, string][]} */
    const told = [];
    const bare = {
        /** @param {string} id */
        interfaceFor: id=>(id === IID
            ? { id, methods: [{ name: 'Draw', argBytes: 8, invoke: ()=>7 }] }
            : null),
        /** @param {number} pointer @param {string} id */
        forgotten: (pointer, id)=>told.push([pointer, id]),
    };
    const pointer = f.table.publish(bare, IID);
    assert.equal(f.call('Draw', pointer, [1]), 7);
    assert.equal(f.table.diagnostics().comInterfaces, 1);

    assert.equal(f.table.unpublish(bare, IID), true);
    assert.equal(f.call('Draw', pointer, [1]), 0x80004003, 'the pointer finds nothing');
    assert.deepEqual(f.freed, [pointer], 'and its words went back');
    assert.deepEqual(told, [[pointer, IID]], 'the object was told, as for a release');
    assert.equal(f.table.diagnostics().comInterfaces, 0);
    assert.equal(f.table.unpublish(bare, IID), false, 'once');
    assert.equal(f.table.unpublish({}, IID), false, 'and never for what was not published');
    assert.notEqual(f.table.publish(bare, IID), 0, 'published again, it is a new interface');
});

test('QueryInterface naming no interface is refused, reading nothing at address zero', ()=>{
    const f = interfaces();
    const methods = METHODS.slice(0, 3);
    const single = {
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods } : null),
        addRef: ()=>2,
        release: ()=>1,
    };
    const pointer = f.table.publish(single, IID);
    assert.equal(f.call('QueryInterface', pointer, [0, 0x8000]), 0x80070057, 'E_INVALIDARG');
    assert.equal(f.call('QueryInterface', pointer, [0x9000, 0]), 0x80004003, 'E_POINTER');
});

test('an interface answered with another\'s pointer is that pointer, and counts as it', ()=>{
    // COM identity: an object whose table for one interface holds another's
    // and more may answer both with one pointer, and a program compares them.
    const f = interfaces();
    const methods = METHODS.slice(0, 3);
    /** @type {string[]} */
    const references = [];
    const shared = {
        /** @param {string} id */
        interfaceFor: id=>(id === IID ? { id, methods }
            : id === IID_B ? { id, methods, sharedWith: IID } : null),
        /** @param {string} id */
        addRef: id=>{
            references.push(id);
            return 2;
        },
        release: ()=>1,
    };
    const pointer = f.table.publish(shared, IID);
    assert.equal(f.query(pointer, IID_B), pointer);
    assert.deepEqual(references, [IID]);
    assert.equal(f.table.publish(shared, IID_B), pointer, 'and published directly as well');
});
