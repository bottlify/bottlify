/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The state setters that run in the guest, run by the real processor.
 *
 * The unit test pins the bytes and the layout; this is the check that the
 * bytes are x86 that writes the block the way the host reads it, and that the
 * cases the routines do not take -- a state past the block, the host's flag --
 * really do leave for the trap.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV86Host } from '../../cpu/internal/v86-host.js';
import { FLAG_SLOW_PATH, SHADOW, setRenderStateCode, setTransformCode } from './shadow.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);

const PROGRAM = 0x8000;
const SET_RENDER_STATE = 0x8100;
const SET_TRANSFORM = 0x8200;
/** Where the routines jump when they leave the case to the host: a halt here. */
const TRAP = 0x8400;
const OBJECT = 0x9000;
/** An object whose state word is zero: one published before it had a block. */
const BARE = 0x9800;
const BLOCK = 0xa000;
const MATRIX = 0xb000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * `push args... ; push this ; call target ; hlt`, stdcall order.
 *
 * @param {number} at @param {number} target @param {number[]} args
 * @param {number} [object]
 */
const call = (at, target, args, object = OBJECT)=>{
    /** @type {number[]} */
    const code = [];
    for (const value of [...args].reverse())
    {
        code.push(0x68, ...u32(value));
    }
    code.push(0x68, ...u32(object));
    const from = at + code.length;
    code.push(0xe8, ...u32((target - (from + 5)) | 0));
    code.push(0xf4);
    return code;
};

function program(){
    /** @type {number[]} */
    const code = [];
    const at = ()=>PROGRAM + code.length;
    code.push(...call(at(), SET_RENDER_STATE, [8, 7]));        // state 8 = 7
    code.push(...call(at(), SET_TRANSFORM, [256, MATRIX]));    // WORLD = the matrix
    code.push(...call(at(), SET_RENDER_STATE, [300, 1]));      // past the block: the trap
    code.push(...call(at(), SET_RENDER_STATE, [8, 9]));        // with the flag up: the trap
    code.push(...call(at(), SET_RENDER_STATE, [8, 9], BARE)); // no block: the trap
    return new Uint8Array(code);
}

test('the guest setters write the block and leave what they cannot take to the trap', async()=>{
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const host = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: 0x300000,
    });

    host.writePhysical(SET_RENDER_STATE, setRenderStateCode(SET_RENDER_STATE, TRAP));
    host.writePhysical(SET_TRANSFORM, setTransformCode(SET_TRANSFORM, TRAP));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(BARE, new Uint8Array(8));
    const matrix = new Float32Array(16).map((unused, i)=>i * 1.5);
    host.writePhysical(MATRIX, new Uint8Array(matrix.buffer));

    host.writePhysical(PROGRAM, program());
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    host.cpu().main_loop();

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    const eip = ()=>host.cpu().instruction_pointer[0] >>> 0;
    const run = ()=>{
        host.cpu().in_hlt[0] = 0;
        return host.cpu().run_slice(1000);
    };

    // Phase 1 ran in the boot's own pass: state 8 is 7, counted once, D3D_OK.
    assert.equal(read(BLOCK + SHADOW.RENDER_STATES + 8 * 4), 7);
    assert.equal(read(BLOCK + SHADOW.RENDER_STATE_CALLS), 1);
    assert.equal(host.cpu().reg32[0] >>> 0, 0, 'EAX is D3D_OK');
    assert.ok(eip() > PROGRAM && eip() < TRAP, 'answered to the program, not the trap');
    // The one thing a halt after the call cannot show by itself: the routine
    // popped exactly its arguments. A routine that pops too few leaves the
    // caller to return into a matrix element, a long way from here.
    assert.equal(host.cpu().reg32[4] >>> 0, 0x300000, 'the stack is where it was');

    run();
    const slot = BLOCK + SHADOW.TRANSFORMS + 24 * 64;
    const written = new Float32Array(host.readPhysical(slot, 64).slice().buffer);
    assert.deepEqual([...written], [...matrix], 'WORLD copied into its slot');
    assert.equal(read(BLOCK + SHADOW.TRANSFORM_CALLS), 1);
    assert.equal(read(BLOCK + SHADOW.RENDER_STATE_CALLS), 1, 'the other counter untouched');
    assert.equal(host.cpu().reg32[4] >>> 0, 0x300000, 'three arguments popped, not two');

    run();
    assert.equal(eip(), TRAP + 1, 'a state past the block went to the trap');
    assert.equal(read(BLOCK + SHADOW.RENDER_STATE_CALLS), 1, 'and was not counted');

    host.writePhysical(BLOCK + SHADOW.FLAGS, new Uint8Array(u32(FLAG_SLOW_PATH)));
    // The trap's halt ended the phase inside the trap; the next phase starts
    // where the program left off, which is the trap's own halt again unless
    // the program is resumed past it. Point the processor at the next call.
    const one = call(0, SET_RENDER_STATE, [8, 9]).length;
    /** @param {number} fromEnd */
    const resume = fromEnd=>{
        host.cpu().instruction_pointer[0] = PROGRAM + program().length - fromEnd * one;
        host.cpu().reg32[4] = 0x300000; // ESP: a fresh stack, the trap's frame abandoned
        run();
    };
    resume(2);
    assert.equal(eip(), TRAP + 1, 'with the flag up, a valid state went to the trap too');
    assert.equal(read(BLOCK + SHADOW.RENDER_STATES + 8 * 4), 7, 'and the block was not written');

    host.writePhysical(BLOCK + SHADOW.FLAGS, new Uint8Array(4));
    resume(1);
    assert.equal(eip(), TRAP + 1, 'an object without a block went to the trap');
    assert.equal(read(SHADOW.RENDER_STATES + 8 * 4), 0, 'and nothing was written at address zero');

    host.stop();
});
