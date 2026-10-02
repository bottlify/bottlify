/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClassFunctions } from './classes.js';
import { createCxxFunctions } from './cxx.js';
import { fakeMemory } from './harness.test.js';

/**
 * The classes' table over a fake memory, its variables placed there as the
 * loader places them -- each at its own address, a vtable's entry part way
 * in, every pointer filled in -- and the runtime's casts beside it.
 */
function build(){
    const memory = fakeMemory();
    /** @type {number[]} */
    const freed = [];
    /** @type {Map<string, number>} */
    const addresses = new Map();
    const table = createClassFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        allocate: memory.allocate,
        free: address=>{
            freed.push(address);
            return true;
        },
        addressOf: name=>addresses.get(name) ?? null,
        callGuest: async(_entry, [bytes])=>memory.allocate(bytes),
    });
    const variables = Object.entries(table).filter(([, entry])=>entry.data);
    for (const [name, entry] of variables)
    {
        addresses.set(name, memory.allocate(entry.data().length + 8) + (entry.entry ?? 0));
    }
    // A function's address is any address that names it: these are only compared.
    let next = 0x7000;
    for (const [name] of Object.entries(table).filter(([, entry])=>!entry.data))
    {
        addresses.set(name, next += 16);
    }
    for (const [name, entry] of variables)
    {
        const start = /** @type {number} */ (addresses.get(name)) - (entry.entry ?? 0);
        memory.writeMemory(start, entry.data());
        for (const { at, to } of entry.pointers ?? [])
        {
            memory.setU32(start + at, /** @type {number} */ (addresses.get(to)));
        }
    }
    const cxx = createCxxFunctions({ readMemory: memory.readMemory,
        readCString: memory.readCString });
    /** @param {string} name @param {number[]} args */
    const call = (name, args)=>table[name].handler(args);
    return { memory, table, freed, addresses, cxx, call };
}

test('an exception owns a copy of its message, and its vtable is its class\'s', ()=>{
    // msvcrt's cpp test, test_exception.
    const { memory, call, addresses, freed } = build();
    const message = memory.put('An exception name');
    const reference = memory.allocate(4);
    memory.setU32(reference, message);
    const e = memory.allocate(12);
    assert.equal(call('??0exception@@QAE@ABQBD@Z', [e, reference]), e);
    assert.equal(memory.u32(e), addresses.get('??_7exception@@6B@'));
    assert.notEqual(memory.u32(e + 4), message, 'copied');
    assert.equal(memory.text(memory.u32(e + 4)), 'An exception name');
    assert.equal(memory.u32(e + 8), 1, 'and the copy is its to free');

    const copy = memory.allocate(12);
    call('??0exception@@QAE@ABV0@@Z', [copy, e]);
    assert.notEqual(memory.u32(copy + 4), memory.u32(e + 4));
    assert.equal(memory.text(memory.u32(copy + 4)), 'An exception name');

    const empty = memory.allocate(12);
    memory.bytes.fill(1, empty, empty + 12);
    call('??0exception@@QAE@XZ', [empty]);
    assert.deepEqual([memory.u32(empty + 4), memory.u32(empty + 8)], [0, 0]);
    assert.equal(memory.text(call('?what@exception@@UBEPBDXZ', [empty])), 'Unknown exception');
    assert.equal(call('?what@exception@@UBEPBDXZ', [e]), memory.u32(e + 4));

    // Assignment copies the message and leaves the object what it was.
    const typeid = memory.allocate(12);
    call('??0bad_typeid@@QAE@PBD@Z', [typeid, message]);
    assert.equal(memory.u32(typeid), addresses.get('??_7bad_typeid@@6B@'));
    call('??4bad_typeid@@QAEAAV0@ABV0@@Z', [empty, typeid]);
    assert.equal(memory.u32(empty), addresses.get('??_7exception@@6B@'));
    assert.equal(memory.text(memory.u32(empty + 4)), 'An exception name');

    const owned = memory.u32(copy + 4);
    call('??1exception@@UAE@XZ', [copy]);
    assert.deepEqual(freed, [owned]);
});

test('a message only pointed at is shared by a copy and never freed', ()=>{
    const { memory, call, freed } = build();
    const message = memory.put('static');
    const reference = memory.allocate(4);
    memory.setU32(reference, message);
    const e = memory.allocate(12);
    call('??0exception@@QAE@ABQBDH@Z', [e, reference, 1]);
    assert.deepEqual([memory.u32(e + 4), memory.u32(e + 8)], [message, 0]);
    const copy = memory.allocate(12);
    call('??0exception@@QAE@ABV0@@Z', [copy, e]);
    assert.deepEqual([memory.u32(copy + 4), memory.u32(copy + 8)], [message, 0]);
    call('??1exception@@UAE@XZ', [copy]);
    assert.deepEqual(freed, []);
});

test('the deleting destructors free one object, or an array and the block before it', ()=>{
    const { memory, call, freed } = build();
    const message = memory.put('x');
    const one = memory.allocate(12);
    call('??0bad_cast@@QAE@PBD@Z', [one, message]);
    const owned = memory.u32(one + 4);
    call('??_Gbad_cast@@UAEPAXI@Z', [one, 0]);
    assert.deepEqual(freed, [owned], 'flags 0: destroyed, not freed');
    call('??_Gbad_cast@@UAEPAXI@Z', [one, 1]);
    assert.deepEqual(freed, [owned, one]);

    freed.length = 0;
    const block = memory.allocate(4 + 4 * 12);
    memory.setU32(block, 3);
    const array = block + 4;
    for (let index = 0; index < 3; index++)
    {
        call('??0bad_cast@@QAE@PBD@Z', [array + index * 12, message]);
    }
    // A fourth past the count, which must not be touched.
    memory.setU32(array + 3 * 12 + 4, 0xdead);
    memory.setU32(array + 3 * 12 + 8, 1);
    const names = [2, 1, 0].map(index=>memory.u32(array + index * 12 + 4));
    call('??_Ebad_cast@@UAEPAXI@Z', [array, 3]);
    assert.deepEqual(freed, [...names, block], 'last to first, then the block');
});

test('type_info names itself once, frees the name, and orders by name', ()=>{
    // msvcrt's cpp test, test_type_info.
    const { memory, call, freed } = build();
    /** @param {string} decorated */
    const type = decorated=>{
        const at = memory.allocate(8 + decorated.length + 1);
        memory.writeMemory(at + 8, new Uint8Array([...decorated]
            .map(character=>character.charCodeAt(0)).concat(0)));
        return at;
    };
    const t1 = type('.?AVtest1@@');
    const t2 = type('.?AVtest2@@');
    const t1Again = type('??AVtest1@@');
    const name = call('?name@type_info@@QBEPBDXZ', [t1]);
    assert.equal(memory.text(name), 'class test1');
    assert.equal(memory.u32(t1 + 4), name, 'kept in the object');
    assert.equal(call('?name@type_info@@QBEPBDXZ', [t1]), name, 'and made once');
    call('??1type_info@@UAE@XZ', [t1]);
    assert.deepEqual(freed, [name]);
    assert.equal(call('?before@type_info@@QBEHABV1@@Z', [t1, t2]), 1);
    assert.equal(call('?before@type_info@@QBEHABV1@@Z', [t2, t1]), 0);
    assert.equal(call('?before@type_info@@QBEHABV1@@Z', [t1, t1Again]), 0,
        'the first character is not compared');
    assert.equal(call('??8type_info@@QBEHABV0@@Z', [t1, t1]), 1);
    assert.equal(call('??8type_info@@QBEHABV0@@Z', [t1, t2]), 0);
    assert.equal(call('??9type_info@@QBEHABV0@@Z', [t1, t2]), 1);
});

test('the classes carry the type information typeid and dynamic_cast read', ()=>{
    // msvcrt's cpp test, test_exception's rtti check and test_rtti.
    const { memory, call, cxx, addresses } = build();
    const message = memory.put('name');
    const e = memory.allocate(12);
    const reference = memory.allocate(4);
    memory.setU32(reference, message);
    call('??0exception@@QAE@ABQBD@Z', [e, reference]);
    const b = memory.allocate(12);
    call('??0bad_typeid@@QAE@PBD@Z', [b, message]);
    const n = memory.allocate(12);
    call('??0__non_rtti_object@@QAE@PBD@Z', [n, message]);

    const ti = cxx.__RTtypeid.handler([e]);
    assert.equal(memory.text(ti + 8), '.?AVexception@@');
    assert.equal(memory.text(cxx.__RTtypeid.handler([ti]) + 8), '.?AVtype_info@@',
        'and the type_info it names has its own');
    const bti = cxx.__RTtypeid.handler([b]);
    assert.equal(memory.text(bti + 8), '.?AVbad_typeid@@');
    assert.equal(cxx.__RTCastToVoid.handler([e]), e);
    assert.equal(cxx.__RTDynamicCast.handler([b, 0, 0, ti, 0]), b, 'up');
    assert.equal(cxx.__RTDynamicCast.handler([e, 0, 0, bti, 0]), 0, 'not down');
    assert.equal(cxx.__RTDynamicCast.handler([n, 0, 0, bti, 0]), n, 'through two levels');

    // The vtable's slots are the deleting destructor and what().
    const vtable = /** @type {number} */ (addresses.get('??_7exception@@6B@'));
    assert.equal(memory.u32(vtable), addresses.get('??_Eexception@@UAEPAXI@Z'));
    assert.equal(memory.u32(vtable + 4), addresses.get('?what@exception@@UBEPBDXZ'));
});

test('__unDName undecorates a type into the buffer given, or memory from the allocator', async()=>{
    const { memory, table } = build();
    const mangled = memory.put('?AVbad_alloc@std@@');
    const buffer = memory.allocate(64);
    const run = (/** @type {number[]} */ args)=>table.__unDName.handler(args);
    assert.equal(await run([buffer, mangled, 64, 0, 0, 0]), buffer);
    assert.equal(memory.text(buffer), 'class std::bad_alloc');
    assert.equal(await run([buffer, mangled, 6, 0, 0, 0]), buffer);
    assert.equal(memory.text(buffer), 'class', 'cut to the room given');
    const made = await run([0, mangled, 0, 0x1234, 0, 0]);
    assert.equal(memory.text(made), 'class std::bad_alloc');
    assert.equal(await run([0, memory.put('??0bad_alloc@std@@QAE@ABV01@@Z'), 0, 0x1234, 0, 0]), 0,
        'a function\'s name is not one it reads');
    assert.equal(table.__unDName.argBytes, 24);
});
