/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDynamicVerify } from './verify-dynamic.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** D3DUSAGE_DYNAMIC. */
const DYNAMIC = 0x200;

/** Guest memory of 64 KiB, a buffer in it, and its backend copy with a GPU buffer behind. */
const setup = ()=>{
    const memory = new Uint8Array(65536);
    const source = { base: 0x1000, length: 4096, usage: DYNAMIC };
    const shadow = new Uint8Array(4096);
    const gpu = { bytes: new Uint8Array(4096), descriptor: { label: 'vb#0' } };
    const wrapper = { gpu, bytes: (/** @type {number} */ at, /** @type {number} */ n)=>
        shadow.subarray(at, at + n), renames: 0 };
    const verify = createDynamicVerify((address, length)=>
        memory.subarray(address, address + length));
    return { memory, source, shadow, gpu, wrapper, verify };
};

test('a draw whose copy and GPU buffer hold what it reads finds nothing', ()=>{
    const { memory, source, shadow, gpu, wrapper, verify } = setup();
    memory.fill(7, 0x1000, 0x1100);
    shadow.fill(7, 0, 0x100);
    gpu.bytes.fill(7, 0, 0x100);
    verify.draw(1, 0);
    verify.range('vb0', source, wrapper, 0, 0x100, { from: 0, to: 0x100 }, true);
    const recording = {};
    verify.attach(recording);
    verify.submitted(recording);
    const found = verify.figures();
    assert.equal(found.ranges, 1);
    assert.equal(found.copyStale + found.gpuStale + found.beyond, 0);
});

test('a copy behind what was sent, a GPU buffer behind its copy and indices past the declared'
    + ' range are each told apart', ()=>{
    const { memory, source, shadow, gpu, wrapper, verify } = setup();
    memory.fill(9, 0x1000, 0x1200);
    shadow.fill(9, 0, 0x200);
    shadow[0x40] = 1;
    gpu.bytes.fill(9, 0, 0x200);
    verify.draw(2, 5);
    verify.range('vb0', source, wrapper, 0, 0x100, { from: 0, to: 0x80 }, true);
    const recording = {};
    verify.attach(recording);
    // What the frame's flush wrote is not what the draw was sent.
    gpu.bytes[0x90] = 3;
    verify.submitted(recording);
    const found = verify.figures();
    assert.equal(found.copyStale, 1);
    assert.equal(found.gpuStale, 1);
    assert.equal(found.beyond, 1);
    assert.equal(found.copySamples[0].first, 0x40);
    assert.equal(found.gpuSamples[0].first, 0x90);
    assert.equal(found.gpuSamples[0].frame, 2);
});

test('a range of a buffer that is not dynamic, and a draw left unrecorded, are not looked at', ()=>{
    const { source, wrapper, verify } = setup();
    verify.draw(1, 0);
    verify.range('vb0', { ...source, usage: 0 }, wrapper, 0, 0x100, null, true);
    verify.range('vb0', source, wrapper, 0, 0x100, null, true);
    // The draw is skipped: its checks never reach a frame.
    verify.draw(1, 1);
    const recording = {};
    verify.attach(recording);
    verify.submitted(recording);
    assert.equal(verify.figures().ranges, 1);
    assert.equal(/** @type {any} */ (recording).verifyChecks, undefined);
});

test('a GPU buffer that keeps no bytes is copied out after the draws and compared when read'
    + ' back, within a budget a frame', async()=>{
    const { memory, shadow, verify } = setup();
    memory.fill(5, 0x1000, 0x1000 + 0x100);
    shadow.fill(5, 0, 0x100);
    // A real device's buffer: nothing to read in place.
    const real = { descriptor: { label: 'vb#3' } };
    const source = { base: 0x1000, length: 0x100, usage: DYNAMIC };
    const wrapper = { gpu: real, bytes: (/** @type {number} */ at, /** @type {number} */ n)=>
        shadow.subarray(at, at + n), renames: 0 };
    verify.draw(3, 0);
    verify.range('vb0', source, wrapper, 0, 0x40, null, true);
    verify.range('vb0', source, wrapper, 0x40, 0x80, null, true);
    const recording = {};
    verify.attach(recording);
    /** @type {{ buffer: any, offset: number, size: number }[]} */
    const asked = [];
    const frame = { copyOut: (/** @type {typeof asked} */ ranges)=>{
        asked.push(...ranges);
        // What the GPU held: the second range has a byte the draw did not read.
        return async()=>ranges.map(range=>{
            const bytes = new Uint8Array(range.size).fill(5);
            if (range.offset === 0x40)
            {
                bytes[2] = 9;
            }
            return bytes;
        });
    } };
    verify.readBack(recording, frame);
    assert.deepEqual(asked.map(range=>[range.buffer, range.offset, range.size]),
        [[real, 0, 0x40], [real, 0x40, 0x40]]);
    verify.submitted(recording);
    assert.equal(verify.figures().readsPending, 1);
    await new Promise(resolve=>setImmediate(resolve));
    const found = verify.figures();
    assert.equal(found.readsPending, 0);
    assert.equal(found.gpuChecked, 2);
    assert.equal(found.gpuStale, 1);
    assert.equal(found.gpuUnknown, 0);
    assert.equal(found.gpuSamples[0].from, 0x40);
    assert.equal(found.gpuSamples[0].first, 2);
    // Shown from the first byte that differs.
    assert.equal(found.gpuSamples[0].have.slice(0, 2), '09');
    assert.equal(found.gpuSamples[0].want.slice(0, 2), '05');
});

test('a frame reads back no more than its budget, and a device with no read back is counted'
    + ' as unknown', ()=>{
    const { verify } = setup();
    const big = new Uint8Array(3 * 1024 * 1024);
    const real = { descriptor: { label: 'vb#4' } };
    const source = { base: 0, length: big.length, usage: DYNAMIC };
    const verifyBig = createDynamicVerify((address, length)=>
        big.subarray(address, address + length));
    const wrapper = { gpu: real, bytes: (/** @type {number} */ at, /** @type {number} */ n)=>
        big.subarray(at, at + n), renames: 0 };
    verifyBig.draw(1, 0);
    verifyBig.range('vb0', source, wrapper, 0, big.length, null, true);
    verifyBig.range('vb0', source, wrapper, 0, big.length, null, true);
    const recording = {};
    verifyBig.attach(recording);
    /** @type {number[]} */
    const sizes = [];
    verifyBig.readBack(recording, { copyOut: ranges=>{
        sizes.push(...ranges.map(range=>range.size));
        return async()=>ranges.map(range=>new Uint8Array(range.size));
    } });
    verifyBig.submitted(recording);
    assert.deepEqual(sizes, [big.length]);
    assert.equal(verifyBig.figures().gpuSkipped, 1);
    // No copy out at all: the frame's ranges are unknown.
    verify.draw(1, 0);
    verify.range('vb0', { base: 0x1000, length: 0x100, usage: DYNAMIC },
        { gpu: real, bytes: ()=>new Uint8Array(0x40), renames: 0 }, 0, 0x40, null, true);
    const other = {};
    verify.attach(other);
    verify.readBack(other, {});
    verify.submitted(other);
    assert.equal(verify.figures().gpuUnknown, 1);
});

test('through a backend: what a frame binds is copied out after its draws and read back once it'
    + ' is submitted, and a copy rewritten before the frame\'s end is found', async()=>{
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const memory = new Uint8Array(0x3000);
    const verify = createDynamicVerify((address, length)=>
        memory.subarray(address, address + length));
    const source = { base: 0x1000, length: 0x200, usage: DYNAMIC };
    const vertices = backend.createDynamicBuffer({ size: 0x200, usage: 0, label: 'vertices' });
    /** @param {number} fill @param {boolean} overwrite */
    const frameOf = async(fill, overwrite)=>{
        memory.fill(fill, 0x1000, 0x1200);
        const lock = vertices.lock(0, 0x200, backend.LockFlags.DISCARD);
        lock.data.fill(fill);
        vertices.unlock(lock);
        const frame = backend.beginFrame();
        verify.draw(1, 0);
        // An odd range: the copy out takes whole words around it.
        verify.range('vb0', source, vertices, 0x13, 0x51, null, true);
        const recording = {};
        verify.attach(recording);
        verify.readBack(recording, frame);
        if (overwrite)
        {
            // The copy rewritten after the draw was recorded, before the
            // frame's end uploads it: the draw reads bytes it was not made with.
            vertices.rewrite(0x20, new Uint8Array(4).fill(0xee));
        }
        frame.end();
        verify.submitted(recording);
        await new Promise(resolve=>setImmediate(resolve));
    };
    await frameOf(7, false);
    assert.deepEqual([verify.figures().gpuChecked, verify.figures().gpuStale], [1, 0]);
    await frameOf(8, true);
    const found = verify.figures();
    assert.deepEqual([found.gpuChecked, found.gpuStale, found.readsFailed, found.readsPending],
        [2, 1, 0, 0]);
    assert.equal(found.gpuSamples[0].first, 0x20 - 0x13);
    assert.equal(found.gpuSamples[0].have.slice(0, 2), 'ee');
});
