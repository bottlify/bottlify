/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The command routines, run by the real processor: each call they take is a
 * record in the ring -- the slot, the length, the arguments with a pointer
 * made to point at the copy after them, and the copy -- and the head moves
 * past it; the stack is left as the caller's convention wants it; and every
 * case they do not take reaches the trap with the stack as it came, the ring
 * untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { COMMAND, FLAG_SLOW_PATH, SHADOW, commandCode } from './shadow.js';
import { runCommands } from '../d3d9/commands.js';

const PROGRAM = 0x8000;
const VIEWPORT = 0x8800;
const CONSTANTS = 0x8a00;
const ENABLE = 0x8c00;
const TRAP = 0x8e00;
const OBJECT = 0x9000;
const BLOCK = 0xa000;
const RING = 0xc000;
const RING_BYTES = 0x1000;
const DATA = 0xe000;
const STACK = 0x300000;

/** The three shapes, as `d3d9/commands.js` names them. */
const SLOTS = { SetViewport: 47, SetVertexShaderConstantF: 94, LightEnable: 53 };

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * `push args... ; push this ; call target ; hlt`, stdcall order.
 *
 * @param {number} at @param {number} target @param {number[]} args
 */
const call = (at, target, args)=>{
    /** @type {number[]} */
    const code = [];
    for (const value of [...args].reverse())
    {
        code.push(0x68, ...u32(value));
    }
    code.push(0x68, ...u32(OBJECT));
    code.push(0xe8, ...u32((target - (at + code.length + 5)) | 0), 0xf4);
    return code;
};

test('a command routine writes the call into the ring and leaves the rest to the trap', ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(VIEWPORT, commandCode(VIEWPORT, TRAP,
        { slot: SLOTS.SetViewport, args: 1, pointer: 0, bytes: 24 }));
    host.writePhysical(CONSTANTS, commandCode(CONSTANTS, TRAP, {
        slot: SLOTS.SetVertexShaderConstantF,
        args: 3, pointer: 1, count: { arg: 2, shift: 4, most: 256 } }));
    host.writePhysical(ENABLE, commandCode(ENABLE, TRAP, { slot: SLOTS.LightEnable, args: 2 }));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(BLOCK + SHADOW.COMMANDS, new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    const viewport = [0, 0, 640, 480, ...new Uint32Array(new Float32Array([0, 1]).buffer)];
    host.writePhysical(DATA, new Uint8Array(new Uint32Array(viewport).buffer));
    const floats = new Float32Array(1024).map((unused, i)=>i + 0.5);
    host.writePhysical(DATA + 0x100, new Uint8Array(floats.buffer));

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    const head = ()=>read(BLOCK + SHADOW.COMMAND_HEAD);
    /**
     * Calls `target` from a fresh stack: 'ok' when it answered D3D_OK with
     * the stack where it was, 'trap' when it left for the trap with the stack
     * as the call made it.
     *
     * @param {number} target @param {number[]} args
     */
    const run = (target, args)=>{
        const code = call(PROGRAM, target, args);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(1000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(host.readReg32('esp'), STACK - 4 * (args.length + 2),
                'the trap meets the arguments, `this` and the return as the call left them');
            return 'trap';
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length);
        assert.equal(host.readReg32('esp'), STACK, 'the routine popped its arguments');
        assert.equal(host.readReg32('eax'), 0);
        return 'ok';
    };

    assert.equal(run(VIEWPORT, [DATA]), 'ok');
    assert.equal(head(), COMMAND.ARGS + 4 + 24);
    assert.equal(read(RING + COMMAND.SLOT), SLOTS.SetViewport);
    assert.equal(read(RING + COMMAND.BYTES), 36);
    assert.equal(read(RING + COMMAND.ARGS), RING + 12, 'the pointer names the copy');
    assert.deepEqual(Array.from({ length: 6 }, (unused, i)=>read(RING + 12 + 4 * i)), viewport);

    assert.equal(run(CONSTANTS, [5, DATA + 0x100, 2]), 'ok');
    const second = RING + 36;
    assert.equal(read(second + COMMAND.SLOT), SLOTS.SetVertexShaderConstantF);
    assert.equal(read(second + COMMAND.BYTES), 8 + 12 + 32);
    assert.deepEqual([read(second + 8), read(second + 12), read(second + 16)],
        [5, second + 20, 2]);
    assert.deepEqual(new Float32Array(host.readPhysical(second + 20, 32).slice().buffer),
        floats.slice(0, 8));
    assert.equal(head(), 36 + 52);

    assert.equal(run(ENABLE, [3, 1]), 'ok');
    assert.deepEqual([read(RING + 88), read(RING + 92), read(RING + 96), read(RING + 100)],
        [SLOTS.LightEnable, 16, 3, 1]);
    assert.equal(head(), 104);
    assert.equal(read(BLOCK + SHADOW.COMMAND_CALLS), 3);
    assert.equal(read(BLOCK + SHADOW.CALLS), 3, 'counted where an entry looks first');

    // What the host makes of them: the calls, in order, with what was copied.
    /** @type {any[]} */
    const made = [];
    const device = {
        /** @param {any} v */
        SetViewport: v=>made.push(['SetViewport', v]) && 0,
        /** @param {number} start @param {Float32Array} values @param {number} count */
        SetVertexShaderConstantF: (start, values, count)=>made.push(
            ['SetVertexShaderConstantF', start, [...values], count]) && 0,
        /** @param {number} index @param {boolean} on */
        LightEnable: (index, on)=>made.push(['LightEnable', index, on]) && 0,
    };
    assert.equal(runCommands(device, host.readPhysical(RING, head()).slice(), ()=>{
        assert.fail('nothing refused');
    }), 3);
    assert.deepEqual(made, [
        ['SetViewport', { X: 0, Y: 0, Width: 640, Height: 480, MinZ: 0, MaxZ: 1 }],
        ['SetVertexShaderConstantF', 5, [...floats.slice(0, 8)], 2],
        ['LightEnable', 3, true],
    ]);

    // Each case the routines do not take, the ring as it was.
    assert.equal(run(VIEWPORT, [0]), 'trap', 'a null pointer');
    assert.equal(run(CONSTANTS, [0, DATA + 0x100, 0]), 'trap', 'no registers');
    assert.equal(run(CONSTANTS, [0, DATA + 0x100, 257]), 'trap', 'more than a device has');
    host.writePhysical(BLOCK, new Uint8Array(u32(FLAG_SLOW_PATH)));
    assert.equal(run(ENABLE, [0, 1]), 'trap', 'the host\'s flag');
    host.writePhysical(BLOCK, new Uint8Array(u32(0)));
    host.writePhysical(BLOCK + SHADOW.COMMAND_BYTES, new Uint8Array(u32(head() + 35)));
    assert.equal(run(VIEWPORT, [DATA]), 'trap', 'a ring with no room for the record');
    assert.equal(run(ENABLE, [0, 1]), 'ok', 'and room for a smaller one');
    host.writePhysical(BLOCK + SHADOW.COMMANDS, new Uint8Array(u32(0)));
    assert.equal(run(ENABLE, [0, 1]), 'trap', 'a device with no ring');
    assert.equal(head(), 104 + 16);
    assert.equal(read(BLOCK + SHADOW.COMMAND_CALLS), 4);
});
