/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesPerCall } from '../../../../../../tools/fixtures/allocation.mjs';
import { memoryModule } from '../../memory/module.js';
import { createGuest } from './guest.js';
import { IN_PLACE, externalGrowth, guestOver } from './guest.fixture.js';
import { cpuForMemory } from '../../memory/cpu.fixture.js';
import { testLog } from '../../log/testing.fixture.js';

const SIZE = 0x10000;

/**
 * The memory layer over `ram`, its dword read in place as the cpu layer's
 * is: the view a run's handlers are handed.
 *
 * @param {Uint8Array} ram
 */
async function runMemory(ram){
    const view = new DataView(ram.buffer);
    const cpu = {
        readPhysical: (/** @type {number} */ at, /** @type {number} */ length)=>
            ram.subarray(at, at + length),
        writePhysical: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>ram.set(data, at),
        readU32: (/** @type {number} */ at)=>view.getUint32(at, true),
        writeU32Data: (/** @type {number} */ at, /** @type {number} */ value)=>
            view.setUint32(at, value >>> 0, true),
    };
    const log = await testLog();
    const memory = await memoryModule.create({}, /** @type {any} */ ({
        requireApi: (/** @type {string} */ name)=>(name === 'cpu' ? cpuForMemory(cpu) : log),
    }));
    memory.register({ name: 'ram', base: 0, size: ram.length, kind: memory.RegionKind.STACK,
        access: memory.Access.READ_WRITE });
    return memory;
}

/** Seeded bytes and addresses: the same on every run. */
function seeded(){
    let state = 0x2545f491;
    const next = ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    const ram = new Uint8Array(SIZE);
    for (let at = 0; at < SIZE; at++)
    {
        ram[at] = next() & 0xff;
    }
    const addresses = Array.from({ length: 500 }, ()=>next() % (SIZE - 16));
    return { ram, addresses, next };
}

/**
 * The accessors the libraries made of their own before the view, as they
 * read and wrote: a copy of a copy, and a DataView over it.
 *
 * @param {{ readBytes: (a: number, n: number) => Uint8Array,
 *     writeBytes: (a: number, b: Uint8Array) => void }} memory
 */
function oldAccessors(memory){
    /** @param {number} address @param {number} length */
    const peek = (address, length)=>new DataView(memory.readBytes(address, length).slice().buffer);
    return {
        u8: (/** @type {number} */ a)=>peek(a, 1).getUint8(0),
        u16: (/** @type {number} */ a)=>peek(a, 2).getUint16(0, true),
        i16: (/** @type {number} */ a)=>peek(a, 2).getInt16(0, true),
        u32: (/** @type {number} */ a)=>peek(a, 4).getUint32(0, true),
        i32: (/** @type {number} */ a)=>peek(a, 4).getInt32(0, true),
        u64: (/** @type {number} */ a)=>peek(a, 8).getBigUint64(0, true),
        i64: (/** @type {number} */ a)=>peek(a, 8).getBigInt64(0, true),
        f32: (/** @type {number} */ a)=>peek(a, 4).getFloat32(0, true),
        f64: (/** @type {number} */ a)=>peek(a, 8).getFloat64(0, true),
        ptr64: (/** @type {number} */ a)=>Number(peek(a, 8).getBigUint64(0, true)),
        /** @param {number} a @param {number} v */
        set32: (a, v)=>{
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, v >>> 0, true);
            memory.writeBytes(a, bytes);
        },
    };
}

test('every read answers what the old accessors did, at seeded addresses', async()=>{
    const { ram, addresses } = seeded();
    const memory = await runMemory(ram);
    const guest = createGuest(memory, 4);
    const wide = createGuest(memory, 8);
    const old = oldAccessors(memory);
    for (const at of addresses)
    {
        for (const name of /** @type {const} */ (['u8', 'u16', 'i16', 'u32', 'i32', 'u64', 'i64']))
        {
            assert.equal(guest[name](at), old[name](at), `${name} at 0x${at.toString(16)}`);
        }
        // NaNs differ by payload only in how they print; Object.is holds them alike.
        assert.ok(Object.is(guest.f32(at), old.f32(at)), `f32 at 0x${at.toString(16)}`);
        assert.ok(Object.is(guest.f64(at), old.f64(at)), `f64 at 0x${at.toString(16)}`);
        assert.equal(guest.ptr(at), old.u32(at));
        // Whole to 2^53: past it a number cannot hold the address.
        const high = old.u32(at + 4) & 0x1fffff;
        memory.writeU32(at + 4, high);
        assert.equal(wide.ptr(at), old.ptr64(at));
    }
    await memoryModule.dispose();
});

test('every write lays down the bytes a DataView would', ()=>{
    const { addresses, next } = seeded();
    const ram = new Uint8Array(SIZE);
    const expected = new Uint8Array(SIZE);
    const view = new DataView(expected.buffer);
    const guest = guestOver(ram, 8);
    for (const at of addresses)
    {
        const value = next();
        switch (value % 7)
        {
            case 0: guest.set8(at, value); view.setUint8(at, value & 0xff); break;
            case 1: guest.set16(at, value); view.setUint16(at, value & 0xffff, true); break;
            case 2: guest.set32(at, value | 0); view.setUint32(at, value, true); break;
            case 3: {
                const quad = BigInt(value) << 21n | BigInt(next());
                guest.set64(at, -quad);
                view.setBigInt64(at, -quad, true);
                break;
            }
            case 4: guest.setF32(at, value / 7); view.setFloat32(at, value / 7, true); break;
            case 5: guest.setF64(at, -value / 3); view.setFloat64(at, -value / 3, true); break;
            default: {
                const pointer = value * 2 ** 20 + 0x1234;
                guest.setPtr(at, pointer);
                view.setBigUint64(at, BigInt(pointer), true);
            }
        }
    }
    assert.deepEqual(ram, expected);
    // A dword a bitwise operator made signed names the address above 2 GiB.
    guest.setPtr(0x100, 0x90000000 | 0);
    assert.equal(guest.u64(0x100), 0x90000000n);
    assert.equal(guestOver(ram, 4).ptr(0x100), 0x90000000);
});

test('a dword read and written makes nothing; the old accessor made a copy of a copy', async()=>{
    const { ram } = seeded();
    const memory = await runMemory(ram);
    const guest = createGuest(memory, 4);
    const old = oldAccessors(memory);
    // Folded as an integer: a sum of dwords is a heap number a call.
    let sum = 0;
    const read = await bytesPerCall(()=>{
        sum ^= guest.u32(0x400);
    });
    const write = await bytesPerCall(()=>guest.set32(0x404, 0x12345678));
    const before = await bytesPerCall(()=>{
        sum ^= old.u32(0x400);
    });
    assert.ok(read < 4 && write < 4, `in place: ${read}, ${write} bytes a call`);
    // The measure can see what it is for: the old read made two buffers and a view.
    assert.ok(before > 64, `the old accessor: ${before} bytes a call`);
    assert.ok(Number.isFinite(sum));
    await memoryModule.dispose();
});

test('a string stops at its terminator or at its limit, and is written cut to its room', ()=>{
    const ram = new Uint8Array(0x4000);
    const guest = guestOver(ram);
    assert.equal(guest.writeAnsi(0x10, 'caf\u00e9 au lait'), 12);
    assert.equal(guest.cstr(0x10, 256), 'caf\u00e9 au lait');
    assert.equal(ram[0x13], 0xe9, 'in the ANSI page');
    // A fixed field read to its end, unterminated: cut, never refused.
    assert.equal(guest.cstr(0x10, 4), 'caf\u00e9');
    assert.equal(guest.writeAnsi(0x40, 'truncated', 4), 3);
    assert.deepEqual([...ram.subarray(0x40, 0x45)], [0x74, 0x72, 0x75, 0, 0]);
    assert.equal(guest.writeAnsi(0x50, 'none', 0), 0);
    assert.equal(ram[0x50], 0, 'no room, nothing written');

    // A lone surrogate is a unit of a Windows string and goes back as it came.
    const text = 'W\ud800x€';
    assert.equal(guest.writeWide(0x100, text), 4);
    assert.equal(guest.wstr(0x100, 256), text);
    assert.equal(guest.wstr(0x100, 4), 'W\ud800');
    assert.equal(guest.writeWide(0x200, 'abcdef', 3), 2);
    assert.equal(guest.wstr(0x200, 64), 'ab');
    assert.equal(guest.u16(0x204), 0);
    // A string longer than the units put together at once.
    const long = 'x'.repeat(3000);
    assert.equal(guest.writeWide(0x300, long, 2048), 2047);
    assert.equal(guest.wstr(0x300, 8192), long.slice(0, 2047));
});

test('text is one reader and one writer with the width a modifier, a counted string whole', ()=>{
    const ram = new Uint8Array(0x400);
    const guest = guestOver(ram);
    for (const wide of [false, true])
    {
        const at = wide ? 0x200 : 0x100;
        assert.equal(guest.setText(at, 'abécd', wide, 4), 3, 'cut to the room');
        assert.equal(guest.text(at, wide, 64), 'abé');
        assert.equal(guest.text(at, wide, 64), (wide ? guest.wstr : guest.cstr)(at, 64));
        // A counted string's length decides: its terminator is a character of it.
        assert.equal(guest.text(at, wide, 4 * (wide ? 2 : 1), true), 'abé\0');
        assert.equal(guest.text(at, wide, 0, true), '', 'none read for no length');
    }
    assert.equal(guest.text(0x200, true, 5, true), 'ab', 'a wide length in whole units');
});

test('bytes are one copy, or none into a buffer given; a copy moves as memmove', ()=>{
    const ram = new Uint8Array(0x100);
    ram.set([1, 2, 3, 4, 5, 6, 7, 8], 0x10);
    const guest = guestOver(ram);
    const copy = guest.snapshot(0x10, 4);
    ram[0x10] = 9;
    assert.deepEqual([...copy], [1, 2, 3, 4], 'a copy, not a window');
    const into = new Uint8Array(6);
    assert.equal(guest.snapshot(0x11, 3, into), into);
    assert.deepEqual([...into], [2, 3, 4, 0, 0, 0]);
    guest.copy(0x12, 0x10, 6);
    assert.deepEqual([...ram.subarray(0x10, 0x18)], [9, 2, 9, 2, 3, 4, 5, 6]);
    assert.equal(guest.set32s(0x20, [1, -1]), 0x28, 'where the next would go');
    assert.deepEqual([guest.u32(0x20), guest.u32(0x24)], [1, 0xffffffff]);
    const guid = '{6B29FC40-CA47-1067-B31D-00DD010662DA}';
    assert.equal(guest.setGuid(0x30, guid), true);
    assert.equal(ram[0x30], 0x40, 'its first field little-endian');
    assert.equal(guest.guid(0x30), guid);
    assert.equal(guest.setGuid(0x30, 'no guid'), false);
    assert.equal(guest.guid(0x30), guid, 'nothing written for it');
    guest.fill(0x10, 0xaa, 2);
    guest.setBytes(0x12, Uint8Array.of(7));
    assert.deepEqual([...ram.subarray(0x10, 0x13)], [0xaa, 0xaa, 7]);
    assert.throws(()=>guest.u32(0xfe), /./, 'memory that is not there is a fault');
});

test('bytes made to a length are written a chunk at a time, a fault before the rest is made', ()=>{
    const ram = new Uint8Array(0x30000);
    const guest = guestOver(ram);
    /** @type {number[]} */
    const offsets = [];
    guest.setMade(0x10, 0x20004, (chunk, offset)=>{
        offsets.push(offset);
        for (let at = 0; at < chunk.length; at++)
        {
            chunk[at] = (offset + at) % 251;
        }
    });
    assert.deepEqual(offsets, [0, 0x10000, 0x20000], 'chunks of 64 KiB, the last what is left');
    assert.equal(ram[0x10 + 0x1fffe], 0x1fffe % 251);
    assert.equal(ram[0x10 + 0x20003], 0x20003 % 251);
    assert.equal(ram[0x10 + 0x20004], 0, 'nothing past the length');
    guest.setMade(0x10, 0, ()=>assert.fail('nothing made for no length'));

    offsets.length = 0;
    const { grown, error } = externalGrowth(()=>guest.setMade(0x2fff0, 0xdeadbeef,
        (chunk, offset)=>{
            offsets.push(offset);
            chunk.fill(1);
        }));
    assert.equal(error?.code, 'GUEST_ACCESS', 'past the memory is a fault');
    assert.deepEqual(offsets, [0], 'at the first chunk, the rest never made');
    assert.ok(grown < IN_PLACE, `${grown} bytes grown`);
});

test('a string a call may be passed as NULL reads as null, an empty one as empty', ()=>{
    const bytes = new Uint8Array(0x100);
    bytes.set([0x41, 0, 0x42, 0, 0, 0], 0x10);
    bytes.set([0x61, 0x62, 0], 0x40);
    const guest = guestOver(bytes, 4, [], 0x10);
    assert.equal(guest.optionalText(0, true), null, 'NULL');
    assert.equal(guest.optionalText(0x10, true), 'AB');
    assert.equal(guest.optionalText(0x14, true), '', 'an empty string is no NULL');
    assert.equal(guest.optionalText(0x40, false), 'ab');
    assert.equal(guest.optionalText(0x10, true, 2), 'A', 'its limit is the text\'s');
});

test('a signed pointer-wide value round-trips -1 and a high dword at either width', ()=>{
    for (const width of /** @type {(4 | 8)[]} */ ([4, 8]))
    {
        const bytes = new Uint8Array(0x40);
        const guest = guestOver(bytes, width);
        guest.setIptr(0x10, -1);
        assert.deepEqual([...bytes.subarray(0x10, 0x10 + width)], Array(width).fill(0xff),
            `${width}: -1 is all ones`);
        assert.equal(guest.iptr(0x10), -1, `${width}: all ones reads as -1`);
        guest.setIptr(0x20, -2);
        assert.equal(guest.iptr(0x20), -2);
        guest.setIptr(0x30, 0x7fff_1234);
        assert.equal(guest.iptr(0x30), 0x7fff_1234);
    }
    const bytes = new Uint8Array(0x40);
    const guest = guestOver(bytes, 8);
    guest.setIptr(0x10, 0x1_2345_6789);
    assert.equal(guest.ptr(0x10), 0x1_2345_6789, 'a value past 4 GiB is the pointer');
    assert.equal(guest.iptr(0x10), 0x1_2345_6789);
    guest.setIptr(0x18, -0x1_0000_0001);
    assert.equal(guest.u32(0x18), 0xffff_ffff);
    assert.equal(guest.u32(0x1c), 0xffff_fffe, 'the sign is carried into the upper dword');
    assert.equal(guest.iptr(0x18), -0x1_0000_0001);
    guest.set64(0x20, 0xffff_ffff);
    assert.equal(guest.iptr(0x20), 0xffff_ffff, 'a dword of ones in a 64-bit field is no -1');
});

test('a COM object\'s method is its vtable\'s entry at the slot, at either width', ()=>{
    const bytes = new Uint8Array(0x100);
    const narrow = guestOver(bytes, 4);
    narrow.set32(0x10, 0x40);
    narrow.set32(0x40 + 3 * 4, 0x1234_5678);
    assert.equal(narrow.method(0x10, 3), 0x1234_5678);
    const wide = guestOver(bytes, 8);
    wide.setPtr(0x10, 0x80);
    wide.setPtr(0x80 + 3 * 8, 0x1_2345_6789);
    assert.equal(wide.method(0x10, 3), 0x1_2345_6789, 'a slot of eight, the entry whole');
});
