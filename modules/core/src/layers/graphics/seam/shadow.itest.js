/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The state setters that run in the guest, run by the real processor.
 *
 * The unit test pins the bytes and the layout; this is the check that the
 * bytes are x86 that writes the blocks the way the host reads them, pops
 * exactly its arguments, and leaves for the trap in every case it does not
 * take -- a state past the block, the host's flag, a lock already held, a
 * range past the buffer, a full ring -- and that the marks it leaves name the
 * words it wrote. On both engines: the marks are `bts` into a string of bits,
 * an addressing form each executes on its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createV86Host } from '../../cpu/internal/v86-host.js';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import {
    BUFFER, FLAG_SLOW_PATH, SHADOW, TEXTURE, getRenderStateCode, getSurfaceLevelCode, lockCode,
    setIndicesCode, setSamplerStateCode,
    setMaterialCode, setRenderStateCode, setStreamSourceCode, setTextureCode,
    setTextureStageStateCode, setTransformCode, setVertexShaderCode, unlockCode,
    getTextureStageStateCode, getTransformCode, setStreamSource9Code, setBindingCode,
} from './shadow.js';
import { D3DERR_INVALIDCALL, D3DTSS } from '../d3d8/constants.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);

const PROGRAM = 0x8000;
/** Past the program, which is a few hundred bytes of pushes and calls. */
const ROUTINES = {
    renderState: 0x8800, transform: 0x8880, lock: 0x8900, unlock: 0x89a0,
    stream: 0x8a00, indices: 0x8a80, shader: 0x8b00, texture: 0x8b80, stageState: 0x8c00,
    material: 0x8c80, surfaceLevel: 0x8d80, getState: 0x8e00, sampler: 0x8e80, texture9: 0x8f00,
    getStage: 0x8f80, getTransform: 0x9100, stream9: 0x9200, declaration: 0x9300,
    indices9: 0x9380,
};
/** Where the routines jump when they leave the case to the host: a halt here. */
const TRAP = 0x8d00;
const OBJECT = 0x9000;
/** A buffer object, whose block names its bytes and the device's block. */
const VBUF = 0x9400;
/** An object whose state word is zero: one published before it had a block. */
const BARE = 0x9800;
/** Two pages, as the device's block is. */
const BLOCK = 0xa000;
const MATRIX = 0xc000;
const VBLOCK = 0xc400;
const VBASE = 0xd000;
const VLENGTH = 0x100;
const OUT = 0xc800;
const MATERIAL = 0xcc00;
/** A texture object and its block: three levels, the middle one published. */
const TEX = 0x9c00;
const TBLOCK = 0xd400;
const LEVEL1 = 0x4711;
const STACK = 0x300000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * One step of the program: `push args... ; push this ; call target ; hlt`,
 * stdcall order.
 *
 * @param {number} target @param {number} object @param {number[]} args
 */
const step = (target, object, args)=>({ target, object, args });

/** The program, as the steps a test runs one by one from a fresh stack. */
const STEPS = [
    step(ROUTINES.renderState, OBJECT, [8, 7]),          // 0: state 8 = 7
    step(ROUTINES.transform, OBJECT, [256, MATRIX]),     // 1: WORLD = the matrix
    step(ROUTINES.renderState, OBJECT, [300, 1]),        // 2: past the block: the trap
    step(ROUTINES.renderState, OBJECT, [8, 9]),          // 3: with the flag up: the trap
    step(ROUTINES.renderState, BARE, [8, 9]),            // 4: no block: the trap
    step(ROUTINES.lock, VBUF, [16, 32, OUT, 0x2000]),    // 5: a lock, DISCARD
    step(ROUTINES.lock, VBUF, [0, 0, OUT, 0]),           // 6: locked already: the trap
    step(ROUTINES.unlock, VBUF, []),                     // 7: onto the ring
    step(ROUTINES.unlock, VBUF, []),                     // 8: not locked: the trap
    step(ROUTINES.lock, VBUF, [0xf0, 0x20, OUT, 0]),     // 9: past the end: the trap
    step(ROUTINES.lock, VBUF, [0, 0, OUT, 0]),           // 10: the whole buffer, widening
    step(ROUTINES.stream, OBJECT, [2, 0x1234, 20]),      // 11: stream 2
    step(ROUTINES.stream, OBJECT, [2, 0, 99]),           // 12: unbinding: the trap
    step(ROUTINES.stream, OBJECT, [16, 1, 1]),           // 13: no such stream: the trap
    step(ROUTINES.indices, OBJECT, [0x5678, 3]),         // 14
    step(ROUTINES.shader, OBJECT, [0x102]),              // 15: a vertex format
    step(ROUTINES.shader, OBJECT, [0x3]),                // 16: a shader handle: the trap
    step(ROUTINES.unlock, VBUF, []),                     // 17: with the ring full: the trap
    step(ROUTINES.texture, OBJECT, [1, 0x4242]),         // 18: stage 1
    step(ROUTINES.texture, OBJECT, [8, 0x4242]),         // 19: no such stage: refused here
    step(ROUTINES.stageState, OBJECT, [2, D3DTSS.COLOROP, 5]),   // 20
    step(ROUTINES.stageState, OBJECT, [2, 12, 5]),       // 21: not a type of this version: the trap
    step(ROUTINES.stageState, OBJECT, [2, 40, 5]),       // 22: past the table: the trap
    step(ROUTINES.stageState, OBJECT, [8, D3DTSS.COLOROP, 5]),   // 23: no such stage: refused here
    step(ROUTINES.material, OBJECT, [MATERIAL]),         // 24: copied in
    step(ROUTINES.material, OBJECT, [0]),                // 25: null: the trap
    step(ROUTINES.surfaceLevel, TEX, [1, OUT]),          // 26: the published level
    step(ROUTINES.surfaceLevel, TEX, [0, OUT]),          // 27: not published yet: the trap
    step(ROUTINES.surfaceLevel, TEX, [3, OUT]),          // 28: no such level: refused here
    step(ROUTINES.surfaceLevel, TEX, [1, 0]),            // 29: nowhere to put it: the trap
    step(ROUTINES.renderState, OBJECT, [255, 3]),        // 30: the last state: bit 31 of row 7
    step(ROUTINES.renderState, OBJECT, [40, 4]),         // 31: row 1
    step(ROUTINES.transform, OBJECT, [23, MATRIX]),      // 32: TEXTURE7, slot 23
    step(ROUTINES.transform, OBJECT, [259, MATRIX]),     // 33: WORLD3, slot 27
    step(ROUTINES.stageState, OBJECT, [7, D3DTSS.TEXTURETRANSFORMFLAGS, 2]),  // 34: the last stage
    step(ROUTINES.getState, OBJECT, [8, OUT]),           // 35: a state the device answers for
    step(ROUTINES.getState, OBJECT, [9, OUT]),           // 36: one it refuses: the trap
    step(ROUTINES.getState, OBJECT, [300, OUT]),         // 37: past the block: the trap
    step(ROUTINES.getState, OBJECT, [8, 0]),             // 38: nowhere to put it: the trap
    step(ROUTINES.sampler, OBJECT, [1, 5, 2]),           // 39: sampler 1, MAGFILTER
    step(ROUTINES.sampler, OBJECT, [1, 11, 1]),          // 40: a type with no slot: the trap
    step(ROUTINES.sampler, OBJECT, [8, 5, 2]),           // 41: a sampler past the block: the trap
    step(ROUTINES.sampler, OBJECT, [1, 16, 2]),          // 42: past the table: the trap
    step(ROUTINES.texture9, OBJECT, [8, 0x4242]),        // 43: Direct3D 9's stage 8: the trap
    step(ROUTINES.getStage, OBJECT, [2, D3DTSS.COLOROP, OUT]),   // 44: what step 20 wrote
    step(ROUTINES.getStage, OBJECT, [2, 12, OUT]),       // 45: not a type of this version: the trap
    step(ROUTINES.getStage, OBJECT, [8, D3DTSS.COLOROP, OUT]),   // 46: no such stage: the trap
    step(ROUTINES.getStage, OBJECT, [2, D3DTSS.COLOROP, 0]),     // 47: nowhere to put it: the trap
    step(ROUTINES.getTransform, OBJECT, [256, OUT]),     // 48: WORLD, as step 1 set it
    step(ROUTINES.getTransform, OBJECT, [23, OUT]),      // 49: TEXTURE7, as step 32 set it
    step(ROUTINES.getTransform, OBJECT, [1, OUT]),       // 50: no such type: the trap
    step(ROUTINES.getTransform, OBJECT, [260, OUT]),     // 51: past WORLD3: the trap
    step(ROUTINES.getTransform, OBJECT, [256, 0]),       // 52: nowhere to put it: the trap
    step(ROUTINES.stream9, OBJECT, [3, 0x2345, 64, 28]), // 53: Direct3D 9's stream 3, at an offset
    step(ROUTINES.stream9, OBJECT, [3, 0, 8, 99]),       // 54: unbinding: the trap
    step(ROUTINES.stream9, OBJECT, [16, 1, 0, 1]),       // 55: no such stream: the trap
    step(ROUTINES.declaration, OBJECT, [0x3456]),        // 56: a declaration
    step(ROUTINES.declaration, BARE, [0x3456]),          // 57: no block: the trap
    step(ROUTINES.indices9, OBJECT, [0x4567]),           // 58: Direct3D 9's indices
    step(ROUTINES.indices9, OBJECT, [0]),                // 59: none, in the guest too
];

/** @param {typeof STEPS[number]} entry @param {number} at */
const bytesOf = (entry, at)=>{
    /** @type {number[]} */
    const code = [];
    for (const value of [...entry.args].reverse())
    {
        code.push(0x68, ...u32(value));
    }
    code.push(0x68, ...u32(entry.object));
    const from = at + code.length;
    code.push(0xe8, ...u32((entry.target - (from + 5)) | 0));
    code.push(0xf4);
    return code;
};

/** The program's bytes and where each step starts; a halt first, for the boot to stop on. */
function program(){
    /** @type {number[]} */
    const code = [0xf4];
    /** @type {number[]} */
    const starts = [];
    for (const entry of STEPS)
    {
        starts.push(PROGRAM + code.length);
        code.push(...bytesOf(entry, PROGRAM + code.length));
    }
    return { bytes: new Uint8Array(code), starts, end: PROGRAM + code.length };
}

/**
 * A processor of either engine, as the one thing the test needs of it: run a
 * step from its first byte on a fresh stack until the halt after it.
 *
 * @param {'emulator' | 'cork'} engine
 */
async function processor(engine){
    const config = {
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK,
    };
    if (engine === 'cork')
    {
        const host = createCorkHost({ ...config, engine: cork, cork: {} });
        return {
            host,
            /** @param {number} at */
            run(at){
                host.writeReg32('eip', at);
                host.writeReg32('esp', STACK);
                host.runSlice(1000);
            },
            eip: ()=>host.readReg32('eip'),
            esp: ()=>host.readReg32('esp'),
            eax: ()=>host.readReg32('eax'),
            stop: ()=>{},
        };
    }
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const host = await createV86Host({
        ...config,
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    });
    let booted = false;
    return {
        host,
        /** @param {number} at */
        run(at){
            if (!booted)
            {
                host.cpu().main_loop();
                booted = true;
            }
            host.cpu().instruction_pointer[0] = at;
            host.cpu().reg32[4] = STACK;
            host.cpu().in_hlt[0] = 0;
            host.cpu().run_slice(1000);
        },
        eip: ()=>host.cpu().instruction_pointer[0] >>> 0,
        esp: ()=>host.cpu().reg32[4] >>> 0,
        eax: ()=>host.cpu().reg32[0] >>> 0,
        stop: ()=>host.stop(),
    };
}

for (const engine of /** @type {const} */ (['emulator', 'cork']))
{
    test(`the guest routines write the blocks and leave what they cannot take to the trap, under ${
        engine}`, async()=>{
        await routines(engine);
    });
}

/** @param {'emulator' | 'cork'} engine */
async function routines(engine){
    const machine = await processor(engine);
    const { host } = machine;

    host.writePhysical(ROUTINES.renderState, setRenderStateCode(ROUTINES.renderState, TRAP));
    host.writePhysical(ROUTINES.transform, setTransformCode(ROUTINES.transform, TRAP));
    host.writePhysical(ROUTINES.lock, lockCode(ROUTINES.lock, TRAP));
    host.writePhysical(ROUTINES.unlock, unlockCode(ROUTINES.unlock, TRAP));
    host.writePhysical(ROUTINES.stream, setStreamSourceCode(ROUTINES.stream, TRAP));
    host.writePhysical(ROUTINES.indices, setIndicesCode(ROUTINES.indices, TRAP));
    host.writePhysical(ROUTINES.shader, setVertexShaderCode(ROUTINES.shader, TRAP));
    host.writePhysical(ROUTINES.texture, setTextureCode(ROUTINES.texture, TRAP));
    host.writePhysical(ROUTINES.stageState, setTextureStageStateCode(ROUTINES.stageState, TRAP));
    host.writePhysical(ROUTINES.material, setMaterialCode(ROUTINES.material, TRAP));
    host.writePhysical(ROUTINES.surfaceLevel,
        getSurfaceLevelCode(ROUTINES.surfaceLevel, TRAP));
    host.writePhysical(ROUTINES.getState, getRenderStateCode(ROUTINES.getState, TRAP));
    host.writePhysical(ROUTINES.sampler, setSamplerStateCode(ROUTINES.sampler, TRAP));
    host.writePhysical(ROUTINES.texture9, setTextureCode(ROUTINES.texture9, TRAP, 'slow'));
    host.writePhysical(ROUTINES.getStage, getTextureStageStateCode(ROUTINES.getStage, TRAP));
    host.writePhysical(ROUTINES.getTransform, getTransformCode(ROUTINES.getTransform, TRAP));
    host.writePhysical(ROUTINES.stream9, setStreamSource9Code(ROUTINES.stream9, TRAP));
    host.writePhysical(ROUTINES.declaration,
        setBindingCode(ROUTINES.declaration, TRAP, SHADOW.DECLARATION));
    host.writePhysical(ROUTINES.indices9, setBindingCode(ROUTINES.indices9, TRAP, SHADOW.INDICES));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(TEX + 4, new Uint8Array(u32(TBLOCK)));
    host.writePhysical(TBLOCK, new Uint8Array(TEXTURE.SIZE));
    host.writePhysical(TBLOCK + TEXTURE.LEVEL_COUNT, new Uint8Array(u32(3)));
    host.writePhysical(TBLOCK + TEXTURE.LEVELS + 4, new Uint8Array(u32(LEVEL1)));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(VBUF + 4, new Uint8Array(u32(VBLOCK)));
    host.writePhysical(BARE, new Uint8Array(8));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(VBLOCK, new Uint8Array([
        ...u32(0), ...u32(VBASE), ...u32(VLENGTH), ...u32(0),
        ...u32(0), ...u32(0), ...u32(0), ...u32(BLOCK),
    ]));
    const matrix = new Float32Array(16).map((unused, i)=>i * 1.5);
    host.writePhysical(MATRIX, new Uint8Array(matrix.buffer));
    const material = new Float32Array(17).map((unused, i)=>i + 0.25);
    host.writePhysical(MATERIAL, new Uint8Array(material.buffer));

    const { bytes: image, starts, end } = program();
    host.writePhysical(PROGRAM, image);
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} at @param {number} value */
    const write = (at, value)=>host.writePhysical(at, new Uint8Array(u32(value)));
    const { eip } = machine;
    /**
     * Runs one step from a fresh stack, and says whether it answered to the
     * program or left for the trap. An answer must also have left the stack
     * where it was: a routine that pops too few leaves the caller to return
     * into an argument, a long way from here.
     *
     * @param {number} index
     */
    const run = index=>{
        machine.run(starts[index]);
        if (eip() === TRAP + 1)
        {
            return 'trap';
        }
        const after = index + 1 < starts.length ? starts[index + 1] : end;
        assert.equal(eip(), after, `step ${index} halted after its call`);
        assert.equal(machine.esp(), STACK, `step ${index} left the stack as it was`);
        const answer = machine.eax();
        if (answer === D3DERR_INVALIDCALL)
        {
            return 'invalid';
        }
        assert.equal(answer, 0, `step ${index} answered D3D_OK`);
        return 'ok';
    };

    /** The block's marks, as the host would find them. */
    const marks = ()=>({
        states: Array.from({ length: 8 }, (unused, row)=>
            read(BLOCK + SHADOW.RENDER_STATE_MARKS + row * 4)),
        stages: Array.from({ length: 8 }, (unused, stage)=>
            read(BLOCK + SHADOW.STAGE_STATE_MARKS + stage * 4)),
        transforms: read(BLOCK + SHADOW.TRANSFORM_MARKS),
    });
    const unmarked = marks();
    /** Every call a routine took is counted once more, where an entry looks first. */
    const calls = ()=>read(BLOCK + SHADOW.CALLS);

    assert.equal(run(0), 'ok');
    assert.equal(read(BLOCK + SHADOW.RENDER_STATES + 8 * 4), 7);
    assert.equal(read(BLOCK + SHADOW.RENDER_STATE_CALLS), 1);
    assert.equal(calls(), 1);
    assert.deepEqual(marks(), { ...unmarked, states: [1 << 8, 0, 0, 0, 0, 0, 0, 0] },
        'state 8 marked, and nothing else');

    assert.equal(run(1), 'ok');
    const slot = BLOCK + SHADOW.TRANSFORMS + 24 * 64;
    const written = new Float32Array(host.readPhysical(slot, 64).slice().buffer);
    assert.deepEqual([...written], [...matrix], 'WORLD copied into its slot');
    assert.equal(read(BLOCK + SHADOW.TRANSFORM_CALLS), 1);
    assert.equal(read(BLOCK + SHADOW.RENDER_STATE_CALLS), 1, 'the other counter untouched');
    assert.equal(marks().transforms, 1 << 24, 'slot 24 marked');
    assert.equal(read(BLOCK + SHADOW.TRANSFORMS + 25 * 64), 0, 'and the slot after untouched');
    assert.equal(calls(), 2);

    const before = marks();
    assert.equal(run(2), 'trap', 'a state past the block');
    assert.equal(read(BLOCK + SHADOW.RENDER_STATE_CALLS), 1, 'and not counted');
    assert.deepEqual(marks(), before, 'nor marked');
    assert.equal(calls(), 2);

    write(BLOCK + SHADOW.FLAGS, FLAG_SLOW_PATH);
    assert.equal(run(3), 'trap', 'with the flag up, a valid state too');
    assert.equal(read(BLOCK + SHADOW.RENDER_STATES + 8 * 4), 7, 'and the block was not written');
    write(BLOCK + SHADOW.FLAGS, 0);

    assert.equal(run(4), 'trap', 'an object without a block');
    assert.equal(read(SHADOW.RENDER_STATES + 8 * 4), 0, 'and nothing was written at address zero');

    assert.equal(run(5), 'ok');
    assert.equal(read(OUT), VBASE + 16, 'the address handed back is inside the buffer');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 1);
    assert.equal(read(VBLOCK + BUFFER.FROM), 16);
    assert.equal(read(VBLOCK + BUFFER.TO), 48);
    assert.equal(read(VBLOCK + BUFFER.LOCK_FLAGS), 0x2000);
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 1);

    assert.equal(run(6), 'trap', 'a second lock is the host\'s to refuse');
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 1);

    assert.equal(run(7), 'ok');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 0);
    assert.equal(read(BLOCK + SHADOW.RING_HEAD), 1);
    assert.equal(read(BLOCK + SHADOW.RING), VBLOCK, 'the buffer\'s block is on the ring');
    assert.equal(read(BLOCK + SHADOW.UNLOCK_CALLS), 1);

    assert.equal(run(8), 'trap', 'an unlock with no lock held');

    assert.equal(run(9), 'trap', 'a range past the end of the buffer');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 0);

    assert.equal(run(10), 'ok');
    assert.equal(read(OUT), VBASE);
    assert.equal(read(VBLOCK + BUFFER.FROM), 0, 'the range widened to take the new lock');
    assert.equal(read(VBLOCK + BUFFER.TO), VLENGTH);
    assert.equal(read(VBLOCK + BUFFER.LOCK_FLAGS), 0x2000, 'and kept the earlier flags');
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 2);

    assert.equal(run(11), 'ok');
    assert.equal(read(BLOCK + SHADOW.STREAMS + 2 * 8), 0x1234);
    assert.equal(read(BLOCK + SHADOW.STREAMS + 2 * 8 + 4), 20);
    // The bind before it is still in the block for the host to adopt first.
    assert.equal(run(12), 'trap', 'an unbinding');
    assert.equal(read(BLOCK + SHADOW.STREAMS + 2 * 8), 0x1234, 'the block untouched');
    assert.equal(read(BLOCK + SHADOW.STREAMS + 2 * 8 + 4), 20);
    assert.equal(run(13), 'trap', 'a stream the block has no slot for');
    assert.equal(read(BLOCK + SHADOW.BINDING_CALLS), 1);

    assert.equal(run(14), 'ok');
    assert.equal(read(BLOCK + SHADOW.INDICES), 0x5678);
    assert.equal(read(BLOCK + SHADOW.BASE_VERTEX), 3);

    assert.equal(run(15), 'ok');
    assert.equal(read(BLOCK + SHADOW.VERTEX_SHADER), 0x102);
    assert.equal(read(BLOCK + SHADOW.BINDING_CALLS), 3);
    assert.equal(run(16), 'trap', 'a shader handle is the host\'s to check');
    assert.equal(read(BLOCK + SHADOW.VERTEX_SHADER), 0x102);

    write(BLOCK + SHADOW.RING_HEAD, SHADOW.RING_CAPACITY);
    assert.equal(run(17), 'trap', 'with the ring full, an unlock is the host\'s');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 1, 'and the lock is still held');

    assert.equal(run(18), 'ok');
    assert.equal(read(BLOCK + SHADOW.TEXTURES + 4), 0x4242);
    assert.equal(read(BLOCK + SHADOW.TEXTURE_CALLS), 1);
    assert.equal(run(19), 'invalid', 'a stage past the last is refused without the trap');
    assert.equal(read(BLOCK + SHADOW.TEXTURE_CALLS), 1, 'and not counted');

    assert.equal(run(20), 'ok');
    assert.equal(read(BLOCK + SHADOW.STAGE_STATES + (2 * 32 + D3DTSS.COLOROP) * 4), 5);
    assert.equal(read(BLOCK + SHADOW.STAGE_STATE_CALLS), 1);
    assert.deepEqual(marks().stages, [0, 0, 1 << D3DTSS.COLOROP, 0, 0, 0, 0, 0],
        'the type\'s bit in stage 2\'s marks');
    const staged = marks();
    assert.equal(run(21), 'trap', 'a type this version has not got is the host\'s');
    assert.equal(run(22), 'trap', 'a type past the table is the host\'s');
    assert.equal(run(23), 'invalid');
    assert.equal(read(BLOCK + SHADOW.STAGE_STATE_CALLS), 1);
    assert.deepEqual(marks(), staged, 'none of those marked');

    assert.equal(run(24), 'ok');
    const copied = new Float32Array(host.readPhysical(BLOCK + SHADOW.MATERIAL, 68).slice().buffer);
    assert.deepEqual([...copied], [...material], 'the material copied into the block');
    assert.equal(read(BLOCK + SHADOW.MATERIAL_CALLS), 1);
    assert.equal(run(25), 'trap', 'a null material is the host\'s to refuse');
    assert.equal(read(BLOCK + SHADOW.MATERIAL_CALLS), 1);

    write(OUT, 0);
    assert.equal(run(26), 'ok');
    assert.equal(read(OUT), LEVEL1, 'the pointer the host published for that level');
    assert.equal(read(TBLOCK + TEXTURE.REFS), 1, 'and the reference it owes is counted');

    write(OUT, 0);
    assert.equal(run(27), 'trap', 'a level the host has not published yet');
    assert.equal(read(TBLOCK + TEXTURE.REFS), 1, 'and nothing owed for it');
    assert.equal(read(OUT), 0);

    assert.equal(run(28), 'invalid', 'a level the texture has not got, refused without the trap');
    assert.equal(read(TBLOCK + TEXTURE.REFS), 1);
    assert.equal(run(29), 'trap', 'a null out-pointer is refused by the host');
    assert.equal(read(TBLOCK + TEXTURE.REFS), 1);

    // The far ends of each string of marks: the sign bit of the last row,
    // the last stage, the last slot.
    assert.equal(run(30), 'ok');
    assert.equal(run(31), 'ok');
    assert.equal(read(BLOCK + SHADOW.RENDER_STATES + 255 * 4), 3);
    assert.equal(read(BLOCK + SHADOW.RENDER_STATES + 40 * 4), 4);
    assert.deepEqual(marks().states, [1 << 8, 1 << 8, 0, 0, 0, 0, 0, 0x80000000]);
    assert.equal(run(32), 'ok');
    assert.equal(run(33), 'ok');
    assert.equal(marks().transforms, (1 << 23 | 1 << 24 | 1 << 27) >>> 0);
    assert.equal(read(BLOCK + SHADOW.TRANSFORM_CALLS), 3);
    assert.equal(run(34), 'ok');
    assert.equal(read(BLOCK + SHADOW.STAGE_STATES
        + (7 * 32 + D3DTSS.TEXTURETRANSFORMFLAGS) * 4), 2);
    assert.equal(marks().stages[7], 1 << D3DTSS.TEXTURETRANSFORMFLAGS);
    // One for every call a routine answered on the device's behalf: steps 0,
    // 1, 5, 7, 10, 11, 12, 14, 15, 18, 20, 24 and 30 to 34. A refusal made
    // in the guest is not one, and a level handed out is the texture's.
    assert.equal(calls(), 16);

    // The getter answers from the block for a state the host marked as one
    // the device answers for, and changes nothing the host counts.
    write(BLOCK + SHADOW.RENDER_STATE_VALID, 1 << 8);
    write(OUT, 0xdead);
    assert.equal(run(35), 'ok');
    assert.equal(read(OUT), 7, 'state 8 as the guest set it');
    write(OUT, 0xdead);
    assert.equal(run(36), 'trap', 'a state the device refuses');
    assert.equal(run(37), 'trap', 'a state past the block');
    assert.equal(run(38), 'trap', 'a null out-pointer');
    assert.equal(read(OUT), 0xdead, 'nothing written by the three the host answers');
    assert.equal(calls(), 16, 'a read is no call the host has to adopt');

    // A sampler state goes to the stage state slot the block's table names
    // for its type -- MAGFILTER's is 16 -- marked as a stage state is.
    host.writePhysical(BLOCK + SHADOW.SAMPLER_KEYS + 5, new Uint8Array([16]));
    const sampled = marks().stages;
    assert.equal(run(39), 'ok');
    assert.equal(read(BLOCK + SHADOW.STAGE_STATES + (1 * 32 + 16) * 4), 2);
    assert.equal(marks().stages[1], (sampled[1] | 1 << 16) >>> 0);
    assert.equal(calls(), 17);
    assert.equal(run(40), 'trap', 'a type the table has no slot for');
    assert.equal(run(41), 'trap', 'a sampler past the stages the block holds');
    assert.equal(run(42), 'trap', 'a type past the table');
    assert.equal(run(43), 'trap', 'Direct3D 9 leaves a stage past the block to the host');
    assert.equal(calls(), 17);

    write(OUT, 0);
    assert.equal(run(44), 'ok', 'a stage state read from the block');
    assert.equal(read(OUT), 5, 'what step 20 set');
    assert.equal(calls(), 17, 'a read is not a call the host must adopt');
    assert.equal(run(45), 'trap', 'a type the setter leaves to the host');
    assert.equal(run(46), 'trap', 'a stage past the block');
    assert.equal(run(47), 'trap', 'a null pointer');

    /** @returns {number[]} the sixteen floats at OUT */
    const outMatrix = ()=>[...new Float32Array(host.readPhysical(OUT, 64).slice().buffer)];
    host.writePhysical(OUT, new Uint8Array(64));
    assert.equal(run(48), 'ok', 'WORLD copied out of its slot');
    assert.deepEqual(outMatrix(), [...matrix]);
    host.writePhysical(OUT, new Uint8Array(64));
    assert.equal(run(49), 'ok', 'TEXTURE7 copied out of slot 23');
    assert.deepEqual(outMatrix(), [...matrix]);
    assert.equal(run(50), 'trap', 'a type the device refuses');
    assert.equal(run(51), 'trap', 'a type past WORLD3');
    assert.equal(run(52), 'trap', 'a null pointer');
    assert.equal(calls(), 17, 'reads are not calls the host must adopt');

    // Direct3D 9's stream, with its offset in a slot of its own, and its
    // declaration: binding calls the host adopts like Direct3D 8's.
    const bindings = read(BLOCK + SHADOW.BINDING_CALLS);
    assert.equal(run(53), 'ok');
    assert.equal(read(BLOCK + SHADOW.STREAMS + 3 * 8), 0x2345);
    assert.equal(read(BLOCK + SHADOW.STREAMS + 3 * 8 + 4), 28);
    assert.equal(read(BLOCK + SHADOW.STREAM_OFFSETS + 3 * 4), 64);
    assert.equal(run(54), 'trap', 'an unbinding');
    assert.equal(read(BLOCK + SHADOW.STREAMS + 3 * 8), 0x2345, 'the block untouched');
    assert.equal(read(BLOCK + SHADOW.STREAMS + 3 * 8 + 4), 28);
    assert.equal(read(BLOCK + SHADOW.STREAM_OFFSETS + 3 * 4), 64);
    assert.equal(run(55), 'trap', 'a stream the block has no slot for');
    assert.equal(run(56), 'ok');
    assert.equal(read(BLOCK + SHADOW.DECLARATION), 0x3456);
    assert.equal(run(57), 'trap', 'an object with no block');
    assert.equal(run(58), 'ok');
    assert.equal(read(BLOCK + SHADOW.INDICES), 0x4567);
    assert.equal(run(59), 'ok');
    assert.equal(read(BLOCK + SHADOW.INDICES), 0);
    assert.equal(read(BLOCK + SHADOW.BINDING_CALLS), bindings + 4);
    assert.equal(calls(), 21);

    machine.stop();
}
