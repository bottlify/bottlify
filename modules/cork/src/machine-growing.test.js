/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A growing memory (`ownLayout`'s `ramFloor`): RAM at 0 with the tables inside
 * it, the memory holding only its floor's RAM until it grows. Translated code
 * never reaches past the memory: a read it leaves untested is wrapped by the
 * mask the host keeps in the wrap word, and every access it tests -- a store, a
 * window of reads off one register -- finds the pages past the RAM held closed
 * and faults at the instruction, as on a page nobody mapped. Once the memory
 * grows and the word says so, the same translated code reads the address itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from './machine.js';

const MIB = 1 << 20;
const LOOP = 0x20000;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** A machine of 64 MiB at most, holding 8 MiB of it, its tables at 4 MiB. */
const growing = ()=>createMachine({ ramSize: 64 * MIB, config: { hashSlots: 1 << 10 },
    growing: { floor: 8 * MIB, tablesAt: 4 * MIB } });

/**
 * Runs the loop at L with `ebx` at `address` for `turns` turns.
 *
 * @param {ReturnType<typeof growing>} m @param {number} address @param {number} turns
 */
async function readLoop(m, address, turns){
    m.setReg('ebx', address);
    m.setReg('ecx', turns);
    m.setReg('eax', 0);
    m.setReg('eip', LOOP);
    return m.run();
}

test('a translated read past the RAM held wraps by the word, and reads the address once grown',
    async()=>{
        const m = growing();
        // L: mov eax, [ebx]; dec ecx; jnz L; hlt
        m.load(LOOP, [0x8b, 0x03, 0x49, 0x75, 0xfb, 0xf4]);
        m.load(0x100000, u32(0x11111111));
        // Translated, reading inside the RAM held.
        let stop = await readLoop(m, 0x100000, 100_000);
        assert.equal(stop.reason, 'halt');
        assert.ok(stop.translated > 0, 'the loop was translated');
        assert.equal(m.reg('eax'), 0x11111111);

        // Past the 8 MiB held: the address by the mask, 0x2180000 & 0x7fffff.
        m.load(0x180000, u32(0x22222222));
        stop = await readLoop(m, 0x2180000, 10);
        assert.equal(stop.reason, 'halt');
        assert.equal(stop.retired, stop.translated, 'all of it translated code');
        assert.equal(m.reg('eax'), 0x22222222);

        // Grown to the whole 64 MiB: the same code reads the address itself.
        m.grow(64 * MIB);
        m.load(0x2180000, u32(0x33333333));
        stop = await readLoop(m, 0x2180000, 10);
        assert.equal(stop.reason, 'halt');
        assert.equal(m.reg('eax'), 0x33333333);
        await m.dispose();
    });

test('reads tested as one window fault past the RAM held, and read the address once grown',
    async()=>{
        const m = growing();
        // L: mov eax, [ebx]; add eax, [ebx + 4]; dec ecx; jnz L; hlt
        m.load(LOOP, [0x8b, 0x03, 0x03, 0x43, 0x04, 0x49, 0x75, 0xf8, 0xf4]);
        m.load(0x100000, [...u32(0x11111111), ...u32(1)]);
        let stop = await readLoop(m, 0x100000, 100_000);
        assert.equal(stop.reason, 'halt');
        assert.ok(stop.translated > 0, 'the loop was translated');
        assert.equal(m.reg('eax'), 0x11111112);

        stop = await readLoop(m, 0x2180000, 10);
        assert.equal(stop.reason, 'fault');
        assert.equal(m.reg('eip'), LOOP, 'at the first read');

        m.grow(64 * MIB);
        m.load(0x2180000, [...u32(0x33333333), ...u32(3)]);
        stop = await readLoop(m, 0x2180000, 10);
        assert.equal(stop.reason, 'halt');
        assert.equal(m.reg('eax'), 0x33333336);
        await m.dispose();
    });

test('a store past the RAM held faults at the instruction, and lands once grown', async()=>{
    const m = growing();
    // mov [ebx], eax; hlt
    m.load(LOOP, [0x89, 0x03, 0xf4]);
    m.setReg('eax', 0x44444444);
    m.setReg('ebx', 0x2180000);
    m.setReg('eip', LOOP);
    let stop = await m.run();
    assert.equal(stop.reason, 'fault');
    assert.equal(m.reg('eip'), LOOP, 'at the store');
    m.grow(64 * MIB);
    stop = await m.run();
    assert.equal(stop.reason, 'halt');
    assert.deepEqual([...m.read(0x2180000, 4)], u32(0x44444444));
    await m.dispose();
});
