/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IUnknown's AddRef and Release in the guest in a 64-bit process
 * (`COUNT_CODE_64`), laid out by `createVtables` and run on cork's long-mode
 * machine as the x64 convention calls them: a count that is no zero crossing
 * changes only its word, and every other case - the first reference, the
 * last, no word at all - reaches the method's trap with RCX and RSP as the
 * call made them, so the bridge's 64-bit trap finds `this`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_64, KEPT_64, STACK_64, callLong, longMachine }
    from '../../../../scripts/guest-code/long.mjs';
import { createVtables } from './vtable.js';
import { withPointers } from '../../memory/pointers.fixture.js';

const IID = '{00000000-0000-0000-c000-000000000046}';
const RETURN = 0x0f00;
const HEAP = 0x200000;
const CELL = 0x280000;
const TRAPS = 0x0c00;

/**
 * An object published in a 64-bit process with its count in the word at
 * CELL (or in none), every trap a `hlt` of its own.
 *
 * @param {number} cell
 */
const world = (cell, owner = 0)=>{
    const m = longMachine();
    m.write(RETURN, [0xf4]);
    let next = HEAP;
    let code = CODE_64;
    let traps = 0;
    const table = createVtables({
        memory: withPointers({
            /** @param {number} at */
            readU32: at=>new DataView(m.bytes().buffer).getUint32(at, true),
            /** @param {number} at @param {number} value */
            writeU32: (at, value)=>new DataView(m.bytes().buffer).setUint32(at, value, true),
            /** @param {number} at @param {number} length */
            readBytes: (at, length)=>m.read(at, length),
            /** @param {number} at @param {Uint8Array} bytes */
            writeBytes: (at, bytes)=>m.write(at, bytes),
        }),
        register: ()=>{
            const at = TRAPS + traps++ * 0x10;
            m.write(at, [0xf4]);
            return at;
        },
        heap: {
            allocate: bytes=>{
                const at = next;
                next += (bytes + 15) & ~15;
                return at;
            },
            allocateCode: bytes=>{
                const at = code;
                code += (bytes + 15) & ~15;
                return at;
            },
        },
        long: ()=>true,
    });
    const object = {
        interfaceFor: (/** @type {string} */ id)=>(id === IID
            ? { id, methods: [
                { name: 'QueryInterface', argBytes: 12, builtin: 'queryInterface' },
                { name: 'AddRef', argBytes: 4, builtin: 'addRef' },
                { name: 'Release', argBytes: 4, builtin: 'release' },
            ] }
            : null),
        addRef: ()=>2,
        release: ()=>1,
        countCell: ()=>cell,
        ownerCell: ()=>owner,
    };
    const pointer = table.publish(object, IID);
    const vtable = Number(m.quad(pointer));
    const slot = (/** @type {number} */ index)=>Number(m.quad(vtable + index * 8));
    return { m, pointer, addRef: slot(1), release: slot(2),
        trapOf: (/** @type {number} */ index)=>TRAPS + index * 0x10 + 1 };
};

/** @param {ReturnType<typeof longMachine>} m @param {number} value */
const setCell = (m, value)=>m.write(CELL, [value & 0xff, value >>> 8 & 0xff, 0, 0]);
/** @param {ReturnType<typeof longMachine>} m */
const cellOf = m=>new DataView(m.read(CELL, 4).buffer).getUint32(0, true);
const OWNER = 0x280040;
/** @param {ReturnType<typeof longMachine>} m @param {number} value */
const setOwner = (m, value)=>m.write(OWNER, [value & 0xff, value >>> 8 & 0xff, 0, 0]);
/** @param {ReturnType<typeof longMachine>} m */
const ownerOf = m=>new DataView(m.read(OWNER, 4).buffer).getUint32(0, true);

test('a 64-bit interface keeps its count\'s word at [this+16], and both counts are code', ()=>{
    const { m, pointer, addRef, release } = world(CELL);
    assert.equal(m.quad(pointer + 16), BigInt(CELL));
    assert.ok(addRef >= CODE_64 && release >= CODE_64, 'AddRef and Release are guest code');
});

for (const [name, from, to] of /** @type {[string, number, number][]} */ ([
    ['AddRef', 1, 2], ['AddRef', 41, 42], ['Release', 2, 1], ['Release', 42, 41],
]))
{
    test(`${name} at 64 bits takes ${from} to ${to} in the guest, keeping what it keeps`, ()=>{
        const { m, pointer, addRef, release } = world(CELL);
        setCell(m, from);
        const call = callLong(m, name === 'AddRef' ? addRef : release,
            { args: [BigInt(pointer)], returnTo: RETURN });
        assert.equal(m.rip(), RETURN + 1);
        assert.equal(cellOf(m), to);
        assert.equal(m.reg('rax') & 0xffffffffn, BigInt(to));
        assert.equal(m.reg('rsp'), BigInt(STACK_64 + 8));
        for (const kept of KEPT_64.filter(n=>n !== 'rsp'))
        {
            assert.equal(m.reg(kept), call.entry[kept], kept);
        }
    });
}

for (const [why, name, value, cell] of /** @type {[string, string, number, number][]} */ ([
    ['the first reference', 'AddRef', 0, CELL],
    ['the last reference', 'Release', 1, CELL],
    ['a count with no word', 'AddRef', 5, 0],
    ['a count with no word', 'Release', 5, 0],
]))
{
    test(`${name} at 64 bits leaves ${why} to its trap with the call as it came`, ()=>{
        const { m, pointer, addRef, release, trapOf } = world(cell);
        setCell(m, value);
        const call = callLong(m, name === 'AddRef' ? addRef : release,
            { args: [BigInt(pointer)], returnTo: RETURN });
        assert.equal(m.rip(), trapOf(name === 'AddRef' ? 1 : 2));
        assert.equal(m.reg('rcx'), call.entry.rcx);
        assert.equal(m.reg('rsp'), call.entry.rsp);
        assert.equal(cellOf(m), value, 'the word untouched');
    });
}

for (const [name, from, to, owner, after] of /** @type {[string, number, number, number, number][]} */ ([
    ['AddRef', 0, 1, 3, 4], ['Release', 1, 0, 3, 2],
]))
{
    test(`${name} at 64 bits takes an owned count from ${from} to ${to} in the guest, and the`
        + ` owner's from ${owner} to ${after}`, ()=>{
        const { m, pointer, addRef, release } = world(CELL, OWNER);
        assert.equal(m.quad(pointer + 24), BigInt(OWNER));
        setCell(m, from);
        setOwner(m, owner);
        const call = callLong(m, name === 'AddRef' ? addRef : release,
            { args: [BigInt(pointer)], returnTo: RETURN });
        assert.equal(m.rip(), RETURN + 1);
        assert.equal(cellOf(m), to);
        assert.equal(ownerOf(m), after);
        assert.equal(m.reg('rax') & 0xffffffffn, BigInt(to));
        assert.equal(m.reg('rcx'), call.entry.rcx);
        assert.equal(m.reg('rsp'), BigInt(STACK_64 + 8));
    });
}

for (const [why, name, value, owner] of /** @type {[string, string, number, number][]} */ ([
    ['the owner\'s last reference', 'Release', 1, 1],
    ['an owner at none', 'AddRef', 0, 0],
    ['a count at none', 'Release', 0, 3],
]))
{
    test(`${name} at 64 bits leaves ${why} to its trap, both words untouched`, ()=>{
        const { m, pointer, addRef, release, trapOf } = world(CELL, OWNER);
        setCell(m, value);
        setOwner(m, owner);
        const call = callLong(m, name === 'AddRef' ? addRef : release,
            { args: [BigInt(pointer)], returnTo: RETURN });
        assert.equal(m.rip(), trapOf(name === 'AddRef' ? 1 : 2));
        assert.equal(m.reg('rcx'), call.entry.rcx);
        assert.equal(m.reg('rsp'), call.entry.rsp);
        assert.equal(cellOf(m), value);
        assert.equal(ownerOf(m), owner);
    });
}
