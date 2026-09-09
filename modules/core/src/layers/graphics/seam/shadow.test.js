/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    FLAG_SLOW_PATH, SHADOW, createShadow, setRenderStateCode, setTransformCode,
    transformSlot, transformType,
} from './shadow.js';

/** A device that remembers what it was told and refuses one state and one type. */
function fakeDevice(){
    /** @type {Map<number, number>} */
    const states = new Map([[7, 1], [8, 3], [14, 0]]);
    /** @type {Map<number, Float32Array>} */
    const transforms = new Map([[2, Float32Array.from({ length: 16 }, (unused, i)=>i)]]);
    /** @type {string[]} */
    const calls = [];
    return {
        states, transforms, calls,
        /** @param {number} state @param {number} value */
        SetRenderState(state, value){
            calls.push(`rs ${state}=${value}`);
            if (!states.has(state))
            {
                return -1;
            }
            states.set(state, value);
            return 0;
        },
        /** @param {number} state @param {{ value?: number }} out */
        GetRenderState(state, out){
            if (!states.has(state))
            {
                return -1;
            }
            out.value = states.get(state);
            return 0;
        },
        /** @param {number} type @param {ArrayLike<number>} matrix */
        SetTransform(type, matrix){
            calls.push(`tr ${type}=${Array.from(matrix).slice(0, 2).join(',')}`);
            if (type === 5)
            {
                return -1;
            }
            transforms.set(type, Float32Array.from(matrix));
            return 0;
        },
        /** @param {number} type @param {{ matrix?: ArrayLike<number> }} out */
        GetTransform(type, out){
            out.matrix = transforms.get(type) ?? new Float32Array(16);
            return 0;
        },
    };
}

function machine(){
    const memory = new Uint8Array(0x10000);
    let free = 0x1008;
    const device = fakeDevice();
    /** @type {string[]} */
    const divergences = [];
    const shadow = createShadow({
        allocate: bytes=>{
            const at = free;
            free += bytes;
            return at;
        },
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        device,
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    });
    const view = new DataView(memory.buffer);
    return {
        memory, device, shadow, divergences,
        /** @param {number} at */
        u32: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        put32: (at, value)=>view.setUint32(at, value >>> 0, true),
        /** @param {number} at @param {number} value */
        putF32: (at, value)=>view.setFloat32(at, value, true),
    };
}

test('the transform slots cover the types a device holds and refuse the rest', ()=>{
    assert.equal(transformSlot(2), 2, 'VIEW');
    assert.equal(transformSlot(23), 23, 'TEXTURE7');
    assert.equal(transformSlot(256), 24, 'WORLD');
    assert.equal(transformSlot(259), 27, 'WORLD3');
    assert.equal(transformSlot(24), -1);
    assert.equal(transformSlot(260), -1);
    for (let slot = 0; slot < SHADOW.TRANSFORM_SLOTS; slot++)
    {
        assert.equal(transformSlot(transformType(slot)), slot);
    }
});

test('the routines end in a jump to their own trap, and check the flag first', ()=>{
    const rs = setRenderStateCode(0x20000, 0x105000);
    assert.deepEqual([...rs.slice(0, 7)], [0x8b, 0x4c, 0x24, 0x04, 0x8b, 0x49, 0x04],
        'this, then the block one word past it');
    assert.deepEqual([...rs.slice(7, 9)], [0x85, 0xc9], 'a block at all');
    assert.equal(rs[9], 0x74, 'jz to the slow path');
    assert.deepEqual([...rs.slice(11, 17)], [0xf7, 0x01, FLAG_SLOW_PATH, 0, 0, 0], 'the flag');
    assert.equal(rs[17], 0x75, 'jnz to the slow path');
    assert.equal(rs[rs.length - 5], 0xe9);
    const rel = new DataView(rs.buffer).getInt32(rs.length - 4, true);
    assert.equal(0x20000 + rs.length + rel, 0x105000, 'the jump lands on the trap');
    // Every short branch lands inside the routine, at an instruction boundary
    // the assembler laid out: the slow label is the jump at the end.
    const slow = rs.length - 5;
    assert.equal(9 + 2 + rs[10], slow, 'jz reaches the slow path');
    assert.equal(17 + 2 + rs[18], slow, 'jnz reaches the slow path');

    const tr = setTransformCode(0x20100, 0x105010);
    assert.equal(tr[tr.length - 5], 0xe9);
    const relTr = new DataView(tr.buffer).getInt32(tr.length - 4, true);
    assert.equal(0x20100 + tr.length + relTr, 0x105010);
    assert.deepEqual([...tr.slice(tr.length - 12, tr.length - 5)],
        [0x5f, 0x5e, 0x31, 0xc0, 0xc2, 0x0c, 0x00],
        'pops what it pushed, answers D3D_OK, and pops its three arguments');
});

test('the block is made on first use and mirrors what the device holds', ()=>{
    const m = machine();
    assert.equal(m.shadow.diagnostics().placed, 0);

    const at = m.shadow.address();

    assert.notEqual(at, 0);
    assert.equal(m.shadow.address(), at, 'once');
    assert.equal(at & 0xfff, 0, 'on a page boundary, whatever the heap handed out');
    assert.ok(at + 0x1000 <= 0x1008 + 0x2000, 'the whole page is inside what was taken');
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 8 * 4), 3, 'state 8 as the device holds it');
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 7 * 4), 1);
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 9 * 4), 0, 'a state the device has not got');
    const view = new DataView(m.memory.buffer);
    assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 2 * 64 + 4, true), 1, 'VIEW[1]');
    assert.equal(m.u32(at + SHADOW.FLAGS), 0);
    assert.deepEqual(m.device.calls, [], 'mirroring is reading the device, not setting it');
});

test('what the guest wrote is adopted on entry, through the device\'s own setters', ()=>{
    const m = machine();
    const at = m.shadow.address();

    m.put32(at + SHADOW.RENDER_STATES + 8 * 4, 5);
    m.put32(at + SHADOW.RENDER_STATE_CALLS, 1);
    m.putF32(at + SHADOW.TRANSFORMS + 24 * 64, 42);   // WORLD[0]
    m.put32(at + SHADOW.TRANSFORM_CALLS, 1);
    m.shadow.sync();

    assert.deepEqual(m.device.calls, ['rs 8=5', 'tr 256=42,0']);
    assert.equal(m.device.states.get(8), 5);
    assert.equal(m.device.transforms.get(256)?.[0], 42);
    assert.equal(m.shadow.diagnostics().renderStateCalls, 1);
    assert.equal(m.shadow.diagnostics().transformCalls, 1);

    m.shadow.sync();
    assert.equal(m.device.calls.length, 2, 'nothing changed, nothing set again');
});

test('a value the device refuses is reported once and not set again', ()=>{
    const m = machine();
    const at = m.shadow.address();

    m.put32(at + SHADOW.RENDER_STATES + 9 * 4, 1);    // state 9: not the device's
    m.putF32(at + SHADOW.TRANSFORMS + 5 * 64, 1);     // type 5: refused
    m.shadow.sync();
    m.shadow.sync();

    assert.equal(m.device.calls.length, 2, 'each tried once');
    assert.equal(m.divergences.length, 2);
    assert.match(m.divergences[0], /SetRenderState.*state 9 set to 1/);
    assert.match(m.divergences[1], /SetTransform.*type 5/);
    assert.equal(m.shadow.diagnostics().refused, 2);
});

test('the slow-path flag is the host\'s, and a re-mirror brings the block to the device', ()=>{
    const m = machine();
    const at = m.shadow.address();

    m.shadow.slowPath(true);
    assert.equal(m.u32(at + SHADOW.FLAGS), FLAG_SLOW_PATH);
    assert.equal(m.shadow.diagnostics().slowPath, 1);
    m.shadow.slowPath(false);
    assert.equal(m.u32(at + SHADOW.FLAGS), 0);

    // The host changed state on its own: a state block applied, a reset.
    m.device.states.set(8, 77);
    m.device.transforms.set(3, Float32Array.from({ length: 16 }, ()=>9));
    m.shadow.remirror();

    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 8 * 4), 77);
    const view = new DataView(m.memory.buffer);
    assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 3 * 64, true), 9);
    m.shadow.sync();
    assert.deepEqual(m.device.calls, [], 'and the block agrees with the device again');
});

test('a sync before the block exists is nothing', ()=>{
    const m = machine();
    m.shadow.sync();
    m.shadow.remirror();
    m.shadow.slowPath(true);
    assert.deepEqual(m.device.calls, []);
    assert.equal(m.shadow.diagnostics().placed, 0);
});
