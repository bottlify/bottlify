/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The buffer routines and the getters that run in the guest, run by the real
 * processor.
 *
 * The unit test pins the bytes and the layout; this is the check that the
 * bytes are x86 that reads and writes the blocks the way the host does, pops
 * exactly its arguments, and leaves for the trap in every case it does not
 * take -- the host's flag, an object without a block, a lock already held, a
 * range past the buffer, a full ring, a state or a level the block does not
 * answer for, nowhere to put the answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import {
    BUFFER, FLAG_SLOW_PATH, HELD_GUEST, LOCK_IN_PLACE, SHADOW, TEXTURE, getRenderStateCode,
    getSurfaceLevelCode, getTargetCode, getTextureStageStateCode, getTransformCode, lockCode,
    unlockCode,
} from './shadow.js';
import { D3DERR_INVALIDCALL, D3DTSS } from '../d3d8/constants.js';

/** Direct3D 8's stage state types, a bit each: what the stage-state getter answers. */
const STAGE_STATE_TYPES = Object.values(D3DTSS).reduce((mask, type)=>mask | (1 << type), 0) >>> 0;

const PROGRAM = 0x8000;
/** Past the program, which is a few hundred bytes of pushes and calls; lockCode is the longest. */
const ROUTINES = {
    lock: 0x8800, unlock: 0x8c00, surfaceLevel: 0x8980, getState: 0x8a00, getStage: 0x8a80,
    getTransform: 0x8b00,
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
const VBLOCK = 0xc400;
const VBASE = 0xd000;
const VLENGTH = 0x100;
const OUT = 0xc800;
/** A texture object and its block: three levels, the middle one published. */
const TEX = 0x9c00;
const TBLOCK = 0xd400;
/** Where the texture's count is kept, at one: the program holds it. */
const TCOUNT = 0xd500;
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
    step(ROUTINES.lock, VBUF, [16, 32, OUT, 0x2000]),    // 0: a lock, DISCARD
    step(ROUTINES.lock, VBUF, [0, 0, OUT, 0]),           // 1: locked already: the trap
    step(ROUTINES.unlock, VBUF, []),                     // 2: onto the ring
    step(ROUTINES.unlock, VBUF, []),                     // 3: not locked: the trap
    step(ROUTINES.lock, VBUF, [0xf0, 0x20, OUT, 0]),     // 4: past the end: the trap
    step(ROUTINES.lock, VBUF, [0, 0, OUT, 0]),           // 5: the whole buffer, widening
    step(ROUTINES.unlock, VBUF, []),                     // 6: with the ring full: the trap
    step(ROUTINES.lock, VBUF, [0, 0, OUT, 0x10]),        // 7: READONLY: the trap
    step(ROUTINES.surfaceLevel, TEX, [1, OUT]),          // 8: the published level
    step(ROUTINES.surfaceLevel, TEX, [0, OUT]),          // 9: not published yet: the trap
    step(ROUTINES.surfaceLevel, TEX, [3, OUT]),          // 10: no such level: refused here
    step(ROUTINES.surfaceLevel, TEX, [1, 0]),            // 11: nowhere to put it: the trap
    step(ROUTINES.getState, OBJECT, [8, OUT]),           // 12: a state the device answers for
    step(ROUTINES.getState, OBJECT, [9, OUT]),           // 13: one it refuses: the trap
    step(ROUTINES.getState, OBJECT, [300, OUT]),         // 14: past the block: the trap
    step(ROUTINES.getState, OBJECT, [8, 0]),             // 15: nowhere to put it: the trap
    step(ROUTINES.getState, OBJECT, [8, OUT]),           // 16: with the flag up: the trap
    step(ROUTINES.getState, BARE, [8, OUT]),             // 17: no block: the trap
    step(ROUTINES.getStage, OBJECT, [2, D3DTSS.COLOROP, OUT]),   // 18: from the block
    step(ROUTINES.getStage, OBJECT, [2, 12, OUT]),       // 19: not a type of this version: the trap
    step(ROUTINES.getStage, OBJECT, [8, D3DTSS.COLOROP, OUT]),   // 20: no such stage: the trap
    step(ROUTINES.getStage, OBJECT, [2, D3DTSS.COLOROP, 0]),     // 21: nowhere to put it: the trap
    step(ROUTINES.getTransform, OBJECT, [256, OUT]),     // 22: WORLD, slot 24
    step(ROUTINES.getTransform, OBJECT, [23, OUT]),      // 23: TEXTURE7, slot 23
    step(ROUTINES.getTransform, OBJECT, [1, OUT]),       // 24: no such type: the trap
    step(ROUTINES.getTransform, OBJECT, [260, OUT]),     // 25: past WORLD3: the trap
    step(ROUTINES.getTransform, OBJECT, [256, 0]),       // 26: nowhere to put it: the trap
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
 * The processor, as the one thing the test needs of it: run a step from its
 * first byte on a fresh stack until the halt after it.
 */
function processor(){
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    return {
        host,
        /** @param {number} at */
        run(at){
            host.writeReg32('eip', at);
            host.writeReg32('esp', STACK);
            runToHalt(host, 1000);
        },
        eip: ()=>host.readReg32('eip'),
        esp: ()=>host.readReg32('esp'),
        eax: ()=>host.readReg32('eax'),
    };
}

test('the guest routines read and write the blocks and leave what they cannot take to the trap',
    async()=>{
        await routines();
    });

async function routines(){
    const machine = processor();
    const { host } = machine;

    const { bytes: image, starts, end } = program();
    assert.ok(PROGRAM + image.length <= ROUTINES.lock, 'the program ends before the routines');
    /** @type {[number, Uint8Array][]} */
    const placed = [
        [ROUTINES.lock, lockCode(ROUTINES.lock, TRAP)],
        [ROUTINES.unlock, unlockCode(ROUTINES.unlock, TRAP)],
        [ROUTINES.surfaceLevel, getSurfaceLevelCode(ROUTINES.surfaceLevel, TRAP)],
        [ROUTINES.getState, getRenderStateCode(ROUTINES.getState, TRAP)],
        [ROUTINES.getStage, getTextureStageStateCode(ROUTINES.getStage, TRAP, STAGE_STATE_TYPES)],
        [ROUTINES.getTransform, getTransformCode(ROUTINES.getTransform, TRAP)],
        [TRAP, new Uint8Array([0xf4])],
    ];
    placed.sort(([a], [b])=>a - b);
    placed.forEach(([at, code], i)=>{
        const next = placed[i + 1]?.[0] ?? OBJECT;
        assert.ok(at + code.length <= next,
            `the routine at 0x${at.toString(16)} ends before the next`);
        host.writePhysical(at, code);
    });
    host.writePhysical(TEX + 4, new Uint8Array(u32(TBLOCK)));
    host.writePhysical(TBLOCK, new Uint8Array(TEXTURE.SIZE));
    host.writePhysical(TBLOCK + TEXTURE.LEVEL_COUNT, new Uint8Array(u32(3)));
    host.writePhysical(TBLOCK + TEXTURE.LEVELS + 4, new Uint8Array(u32(LEVEL1)));
    host.writePhysical(TBLOCK + TEXTURE.COUNT, new Uint8Array(u32(TCOUNT)));
    host.writePhysical(TCOUNT, new Uint8Array(u32(1)));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(VBUF + 4, new Uint8Array(u32(VBLOCK)));
    host.writePhysical(BARE, new Uint8Array(8));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(VBLOCK, new Uint8Array([
        ...u32(0), ...u32(VBASE), ...u32(VLENGTH), ...u32(0),
        ...u32(0), ...u32(0), ...u32(0), ...u32(BLOCK),
    ]));
    // What the host mirrors and the setters' command routines keep: state 8,
    // which the device answers for, a stage state, and two matrices.
    host.writePhysical(BLOCK + SHADOW.RENDER_STATES + 8 * 4, new Uint8Array(u32(7)));
    host.writePhysical(BLOCK + SHADOW.RENDER_STATE_VALID, new Uint8Array(u32(1 << 8)));
    host.writePhysical(BLOCK + SHADOW.STAGE_STATES + (2 * 32 + D3DTSS.COLOROP) * 4,
        new Uint8Array(u32(5)));
    const matrix = new Float32Array(16).map((unused, i)=>i * 1.5);
    const reversed = matrix.slice().reverse();
    host.writePhysical(BLOCK + SHADOW.TRANSFORMS + 24 * 64, new Uint8Array(matrix.buffer));
    host.writePhysical(BLOCK + SHADOW.TRANSFORMS + 23 * 64, new Uint8Array(reversed.buffer));

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

    assert.equal(run(0), 'ok');
    assert.equal(read(OUT), VBASE + 16, 'the address handed back is inside the buffer');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 1);
    assert.equal(read(VBLOCK + BUFFER.FROM), 16);
    assert.equal(read(VBLOCK + BUFFER.TO), 48);
    assert.equal(read(VBLOCK + BUFFER.LOCK_FLAGS), (0x2000 | LOCK_IN_PLACE) >>> 0,
        'the flags, and that the host replays the lock before the ring\'s draws');
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 1);

    assert.equal(run(1), 'trap', 'a second lock is the host\'s to refuse');
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 1);

    assert.equal(run(2), 'ok');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 0);
    assert.equal(read(BLOCK + SHADOW.RING_HEAD), 1);
    assert.equal(read(BLOCK + SHADOW.RING), VBLOCK, 'the buffer\'s block is on the ring');
    assert.equal(read(VBLOCK + BUFFER.QUEUED), 1, 'and says so');
    assert.equal(read(BLOCK + SHADOW.UNLOCK_CALLS), 1);

    assert.equal(run(3), 'trap', 'an unlock with no lock held');
    assert.equal(read(BLOCK + SHADOW.UNLOCK_CALLS), 1);

    assert.equal(run(4), 'trap', 'a range past the end of the buffer');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 0);

    assert.equal(run(5), 'ok');
    assert.equal(read(OUT), VBASE);
    assert.equal(read(VBLOCK + BUFFER.FROM), 0, 'the range widened to take the new lock');
    assert.equal(read(VBLOCK + BUFFER.TO), VLENGTH);
    assert.equal(read(VBLOCK + BUFFER.LOCK_FLAGS), (0x2000 | LOCK_IN_PLACE) >>> 0,
        'and kept the earlier flags');
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 2);

    write(BLOCK + SHADOW.RING_HEAD, SHADOW.RING_CAPACITY);
    assert.equal(run(6), 'ok', 'a buffer the ring names already needs no room on it');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 0);
    assert.equal(read(BLOCK + SHADOW.UNLOCK_CALLS), 2);
    assert.equal(run(5), 'ok');
    write(VBLOCK + BUFFER.QUEUED, 0);
    assert.equal(run(6), 'trap', 'with the ring full of others, an unlock is the host\'s');
    assert.equal(read(VBLOCK + BUFFER.LOCKED), 1, 'and the lock is still held');
    write(VBLOCK + BUFFER.LOCKED, 0);
    assert.equal(run(7), 'trap', 'a lock for reading is the host\'s');
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 3);

    write(OUT, 0);
    assert.equal(run(8), 'ok');
    assert.equal(read(OUT), LEVEL1, 'the pointer the host published for that level');
    assert.equal(read(TCOUNT), 2, 'and the reference it owes is taken');

    write(OUT, 0);
    assert.equal(run(9), 'trap', 'a level the host has not published yet');
    assert.equal(read(TCOUNT), 2, 'and none taken for it');
    assert.equal(read(OUT), 0);

    assert.equal(run(10), 'invalid', 'a level the texture has not got, refused without the trap');
    assert.equal(read(TCOUNT), 2);
    assert.equal(run(11), 'trap', 'a null out-pointer is refused by the host');
    assert.equal(read(TCOUNT), 2);

    // The getter answers from the block for a state the host marked as one
    // the device answers for.
    write(OUT, 0xdead);
    assert.equal(run(12), 'ok');
    assert.equal(read(OUT), 7, 'state 8 as the block holds it');
    write(OUT, 0xdead);
    assert.equal(run(13), 'trap', 'a state the device refuses');
    assert.equal(run(14), 'trap', 'a state past the block');
    assert.equal(run(15), 'trap', 'a null out-pointer');
    write(BLOCK + SHADOW.FLAGS, FLAG_SLOW_PATH);
    assert.equal(run(16), 'trap', 'with the flag up, a state the block answers for too');
    write(BLOCK + SHADOW.FLAGS, 0);
    assert.equal(run(17), 'trap', 'an object without a block');
    assert.equal(read(OUT), 0xdead, 'nothing written by those the host answers');

    write(OUT, 0);
    assert.equal(run(18), 'ok', 'a stage state read from the block');
    assert.equal(read(OUT), 5);
    assert.equal(run(19), 'trap', 'a type the version has not got');
    assert.equal(run(20), 'trap', 'a stage past the block');
    assert.equal(run(21), 'trap', 'a null pointer');

    /** @returns {number[]} the sixteen floats at OUT */
    const outMatrix = ()=>[...new Float32Array(host.readPhysical(OUT, 64).slice().buffer)];
    host.writePhysical(OUT, new Uint8Array(64));
    assert.equal(run(22), 'ok', 'WORLD copied out of its slot');
    assert.deepEqual(outMatrix(), [...matrix]);
    host.writePhysical(OUT, new Uint8Array(64));
    assert.equal(run(23), 'ok', 'TEXTURE7 copied out of slot 23');
    assert.deepEqual(outMatrix(), [...reversed]);
    assert.equal(run(24), 'trap', 'a type the device refuses');
    assert.equal(run(25), 'trap', 'a type past WORLD3');
    assert.equal(run(26), 'trap', 'a null pointer');

    // The getters wrote nothing the host reads: the counts are the buffers'.
    assert.deepEqual([read(BLOCK + SHADOW.LOCK_CALLS), read(BLOCK + SHADOW.UNLOCK_CALLS)], [3, 2]);
}

test('the target getters hand out the block\'s pair with the reference it owes, and leave a'
    + ' count at zero, another index, a null pointer and a taken lock to the trap', ()=>{
    const machine = processor();
    const { host } = machine;
    /** Direct3D 9's GetRenderTarget, its GetDepthStencilSurface, and Direct3D 8's GetRenderTarget. */
    const NINE = 0x30000;
    const DEPTH = 0x30200;
    const EIGHT = 0x30400;
    const TRAPPED = 0x30600;
    const CELLS = 0x31000;
    const TARGET = 0x4711;
    const SURFACE = 0x4722;
    const NOTFOUND = 0x88760866;
    host.writePhysical(NINE, getTargetCode(NINE, TRAPPED, { depth: false, indexed: true }));
    host.writePhysical(DEPTH, getTargetCode(DEPTH, TRAPPED, { depth: true, indexed: false }));
    host.writePhysical(EIGHT, getTargetCode(EIGHT, TRAPPED, { depth: false, indexed: false }));
    host.writePhysical(TRAPPED, new Uint8Array([0xf4]));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    /** @param {number} at @param {number} value */
    const write = (at, value)=>host.writePhysical(at, new Uint8Array(u32(value)));
    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /**
     * @param {number[]} pairs  pointer and count word, the target's and the depth surface's
     * @param {number} valid
     */
    const mirror = (pairs, valid)=>{
        pairs.forEach((value, index)=>write(BLOCK + SHADOW.TARGETS + index * 4, value));
        write(BLOCK + SHADOW.TARGETS_VALID, valid);
    };
    /**
     * Calls `routine` on the device with `args` from a fresh stack: 'trap',
     * or what it answered, the stack checked to be where it was.
     *
     * @param {number} routine @param {number[]} args
     */
    const call = (routine, args)=>{
        const code = bytesOf({ target: routine, object: OBJECT, args }, PROGRAM);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        machine.run(PROGRAM);
        if (machine.eip() === TRAPPED + 1)
        {
            return 'trap';
        }
        assert.equal(machine.eip(), PROGRAM + code.length, 'halted after its call');
        assert.equal(machine.esp(), STACK, 'the routine popped its arguments');
        assert.equal(read(BLOCK + SHADOW.HELD), 0, 'and let the device\'s lock go');
        return machine.eax();
    };

    mirror([TARGET, CELLS, SURFACE, CELLS + 4], 3);
    write(CELLS, 1);
    write(CELLS + 4, 2);
    write(OUT, 0);
    assert.equal(call(NINE, [0, OUT]), 0);
    assert.equal(read(OUT), TARGET, 'the target\'s pointer');
    assert.equal(read(CELLS), 2, 'and its reference taken');
    assert.equal(call(EIGHT, [OUT]), 0, 'Direct3D 8\'s, with no index');
    assert.equal(read(CELLS), 3);
    assert.equal(call(DEPTH, [OUT]), 0);
    assert.equal(read(OUT), SURFACE);
    assert.equal(read(CELLS + 4), 3);

    assert.equal(call(NINE, [1, OUT]), 'trap', 'another index is the host\'s');
    assert.equal(call(NINE, [0, 0]), 'trap', 'and a null pointer');
    assert.equal(call(DEPTH, [0]), 'trap');
    write(CELLS, 0);
    assert.equal(call(NINE, [0, OUT]), 'trap', 'a count at zero: a first reference is the host\'s');
    assert.equal(read(CELLS), 0);
    assert.equal(read(BLOCK + SHADOW.HELD), 0, 'the lock let go on the way');
    write(CELLS, 1);
    mirror([TARGET, 0, SURFACE, CELLS + 4], 3);
    assert.equal(call(NINE, [0, OUT]), 'trap', 'a count the host keeps');
    mirror([TARGET, CELLS, SURFACE, CELLS + 4], 2);
    assert.equal(call(NINE, [0, OUT]), 'trap', 'a target the host has not said is the device\'s');
    assert.equal(call(DEPTH, [OUT]), 0, 'while the depth pair is');
    write(BLOCK + SHADOW.HELD, HELD_GUEST);
    assert.equal(call(DEPTH, [OUT]), 'trap', 'the device\'s lock held elsewhere');
    write(BLOCK + SHADOW.HELD, 0);

    mirror([TARGET, CELLS, 0, 0], 3);
    write(OUT, 0xdeadbeef);
    assert.equal(call(DEPTH, [OUT]), NOTFOUND, 'no depth surface');
    assert.equal(read(OUT), 0, 'and the pointer cleared, as the host clears it');
    mirror([0, 0, 0, 0], 3);
    assert.equal(call(NINE, [0, OUT]), 'trap', 'no target is the host\'s to answer');
});
