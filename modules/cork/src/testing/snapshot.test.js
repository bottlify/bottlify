/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARITH_MASK, compare, restore, snapshot } from './snapshot.js';

/**
 * A host made of arrays, with the accessors the snapshot needs and nothing
 * else: what it holds is exactly what the snapshot reads and writes.
 */
function fakeHost(){
    /** @type {Record<string, number>} */
    const registers = {
        eax: 1, ecx: 2, edx: 3, ebx: 4, esp: 0x300000, ebp: 6, esi: 7, edi: 8,
        eip: 0x401000, eflags: 0x246,
    };
    const ram = new Uint8Array(0x10000);
    const xmm = new Uint32Array(32).map((_, i)=>i * 0x01010101);
    const x87 = {
        top: 6, empty: 0x3f, control: 0x27f, status: 0x3000,
        registers: new Float64Array([0, 0, 0, 0, 0, 0, 2.5, 1]),
        raw: new Uint8Array(128).map((_, i)=>i),
    };
    let mxcsr = 0x1f80;
    return {
        registers, ram, xmm, x87,
        /** @param {string} name */
        readReg32: name=>registers[name],
        /** @param {string} name @param {number} value */
        writeReg32: (name, value)=>{
            registers[name] = value >>> 0;
        },
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>ram.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writePhysical: (address, bytes)=>ram.set(bytes, address),
        /** @param {number} index */
        readXmm: index=>xmm.slice(index * 4, index * 4 + 4),
        /** @param {number} index @param {Uint32Array} words */
        writeXmm: (index, words)=>xmm.set(words, index * 4),
        readMxcsr: ()=>mxcsr,
        /** @param {number} value */
        writeMxcsr: value=>{
            mxcsr = value;
        },
        x87State: ()=>({
            top: x87.top, empty: x87.empty, control: x87.control, status: x87.status,
            registers: Float64Array.from(x87.registers), raw: Uint8Array.from(x87.raw),
        }),
        /** @param {import('./snapshot.js').X87State} state */
        restoreX87State: state=>{
            x87.top = state.top;
            x87.empty = state.empty;
            x87.control = state.control;
            x87.status = state.status;
            x87.registers.set(state.registers);
            x87.raw.set(state.raw);
        },
    };
}

const SPANS = [{ address: 0x1000, length: 16 }, { address: 0x2000, length: 8 }];

test('a snapshot restored into another host compares equal, memory spans included', ()=>{
    const source = fakeHost();
    source.ram.set([1, 2, 3, 4, 5, 6, 7, 8], 0x1000);
    source.ram.set([9, 9], 0x2004);
    const taken = snapshot(source, SPANS);

    const target = fakeHost();
    target.registers.eax = 99;
    target.xmm.fill(0);
    target.x87.top = 0;
    restore(target, taken);

    assert.deepEqual(compare(taken, snapshot(target, SPANS)), []);
    assert.equal(target.registers.eax, 1);
    assert.deepEqual([...target.ram.subarray(0x1000, 0x1008)], [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('a snapshot is a copy: the host moving on does not move the record', ()=>{
    const host = fakeHost();
    const taken = snapshot(host, SPANS);
    host.registers.ebx = 0xdead;
    host.ram[0x1000] = 0xff;
    host.xmm[0] = 0xffffffff;
    host.x87.registers[7] = 3;
    assert.equal(taken.reg32[3], 4);
    assert.equal(taken.memory[0].bytes[0], 0);
    assert.equal(taken.xmm[0], 0);
    assert.equal(taken.x87.registers[7], 1);
});

test('a changed register is the single divergence, named', ()=>{
    const a = snapshot(fakeHost(), SPANS);
    const b = snapshot(fakeHost(), SPANS);
    b.reg32[3] = 5;
    assert.deepEqual(compare(a, b), [{ name: 'ebx', expected: 4, actual: 5 }]);
});

test('a flag outside the mask is not a divergence; one inside is', ()=>{
    const a = snapshot(fakeHost(), SPANS);
    const b = snapshot(fakeHost(), SPANS);
    b.eflags = a.eflags | 1 << 10; // DF, outside the arithmetic six
    assert.deepEqual(compare(a, b), []);
    b.eflags = a.eflags ^ 1; // CF
    assert.deepEqual(compare(a, b), [{
        name: 'eflags', expected: a.eflags & ARITH_MASK, actual: (a.eflags ^ 1) & ARITH_MASK,
    }]);
    assert.deepEqual(compare(a, b, { flagsMask: 0 }), [], 'a caller may mask everything');
});

test('a memory word inside a span is named by its dword address, once', ()=>{
    const a = snapshot(fakeHost(), SPANS);
    const b = snapshot(fakeHost(), SPANS);
    b.memory[0].bytes[5] = 0x11;
    b.memory[0].bytes[6] = 0x22;
    assert.deepEqual(compare(a, b), [{ name: 'mem[0x1004]', expected: 0, actual: 0x221100 }]);
    b.memory[1] = { address: 0x2000, bytes: new Uint8Array(4) };
    assert.deepEqual(compare(a, b).map(d=>d.name), ['mem[0x1004]', 'memory[1]']);
});

test('an x87 register empty on one side and held on the other is named as such', ()=>{
    const a = snapshot(fakeHost(), SPANS);
    const b = snapshot(fakeHost(), SPANS);
    b.x87.empty |= 1 << 6;
    assert.deepEqual(compare(a, b), [{ name: 'st6.empty', expected: 2.5, actual: 'empty' }]);
    b.x87.empty = a.x87.empty;
    b.x87.registers[6] = 2.5000000000000004; // one ulp up
    assert.deepEqual(compare(a, b), [{ name: 'st6', expected: 2.5, actual: 2.5000000000000004 }]);
    assert.deepEqual(compare(a, b, { x87Ulps: 1 }), [], 'a named tolerance accepts it');
    b.x87.registers[6] = -2.5;
    assert.equal(compare(a, b, { x87Ulps: 1000 }).length, 1, 'never across a sign');
    b.x87.registers[6] = 2.5;
    b.x87.top = 7;
    b.x87.status = a.x87.status | 1 << 9;
    assert.deepEqual(compare(a, b).map(d=>d.name), ['x87.top', 'x87.status']);
    assert.deepEqual(compare(a, b, { statusMask: 0x3800 }).map(d=>d.name), ['x87.top']);
});

test('an xmm lane and mxcsr are compared as bit patterns', ()=>{
    const a = snapshot(fakeHost(), SPANS);
    const b = snapshot(fakeHost(), SPANS);
    b.xmm[9] = 0x7fc00001; // a NaN payload
    b.mxcsr = 0x9f80;
    assert.deepEqual(compare(a, b).map(d=>d.name), ['xmm2[1]', 'mxcsr']);
});
