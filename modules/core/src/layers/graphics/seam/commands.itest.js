/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The command routines, run by the real processor: each call they take is a
 * record in the ring -- the slot, the arguments with a pointer made to point
 * at the copy after them, the copy, and the length last, which is what makes
 * it whole -- with the head past it; what a getter in the guest reads is kept
 * in the block; a draw raises the flag a buffer's lock looks at; the stack is
 * left as the caller's convention wants it; and every case they do not take
 * reaches the trap with the stack as it came, the ring untouched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import {
    BUFFER, COMMAND, FLAG_SLOW_PATH, RENDER_STATE_MIRROR, SHADOW, TRANSFORM_MIRROR, commandCode,
    lockCode,
} from './shadow.js';
import { COMMANDS, commandSlot, runCommands } from '../d3d9/commands.js';

const PROGRAM = 0x8000;
const VIEWPORT = 0x8800;
const CONSTANTS = 0x8a00;
const ENABLE = 0x8c00;
const STATE = 0x9100;
const TRANSFORM = 0x9a00;
const DRAW = 0x9300;
const LOCK = 0x9400;
const TRAP = 0x8e00;
const OBJECT = 0x9000;
const VBUF = 0x9800;
const BLOCK = 0xa000;
const VBLOCK = 0xc800;
const RING = 0xd000;
const RING_BYTES = 0x1000;
const DATA = 0xe000;
const OUT = 0xf000;
const STACK = 0x300000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * `push args... ; push this ; call target ; hlt`, stdcall order.
 *
 * @param {number} at @param {number} target @param {number} object @param {number[]} args
 */
const call = (at, target, object, args)=>{
    /** @type {number[]} */
    const code = [];
    for (const value of [...args].reverse())
    {
        code.push(0x68, ...u32(value));
    }
    code.push(0x68, ...u32(object));
    code.push(0xe8, ...u32((target - (at + code.length + 5)) | 0), 0xf4);
    return code;
};

/** @param {string} name @param {object} [more] */
const shape = (name, more = {})=>({ ...COMMANDS[name], slot: commandSlot(name), ...more });

test('a command routine writes the call into the ring and leaves the rest to the trap', ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    /** @type {[number, Uint8Array][]} */
    const routines = [
        [VIEWPORT, commandCode(VIEWPORT, TRAP, shape('SetViewport'))],
        [CONSTANTS, commandCode(CONSTANTS, TRAP, shape('SetVertexShaderConstantF'))],
        [ENABLE, commandCode(ENABLE, TRAP, shape('LightEnable'))],
        [STATE, commandCode(STATE, TRAP, shape('SetRenderState', { mirror: RENDER_STATE_MIRROR }))],
        [TRANSFORM, commandCode(TRANSFORM, TRAP,
            shape('SetTransform', { mirror: TRANSFORM_MIRROR }))],
        [DRAW, commandCode(DRAW, TRAP, shape('DrawIndexedPrimitive'))],
        [LOCK, lockCode(LOCK, TRAP)],
    ];
    for (const [at, code] of routines)
    {
        host.writePhysical(at, code);
    }
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(VBUF + 4, new Uint8Array(u32(VBLOCK)));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(BLOCK + SHADOW.COMMANDS, new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
    host.writePhysical(VBLOCK, new Uint8Array([...u32(0), ...u32(DATA + 0x800), ...u32(0x100),
        ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(BLOCK)]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    const viewport = [0, 0, 640, 480, ...new Uint32Array(new Float32Array([0, 1]).buffer)];
    host.writePhysical(DATA, new Uint8Array(new Uint32Array(viewport).buffer));
    const floats = new Float32Array(256).map((unused, i)=>i + 0.5);
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
     * @param {number} target @param {number[]} args @param {number} [object]
     */
    const run = (target, args, object = OBJECT)=>{
        const code = call(PROGRAM, target, object, args);
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
    assert.equal(read(RING + COMMAND.SLOT), commandSlot('SetViewport'));
    assert.equal(read(RING + COMMAND.BYTES), 36, 'whole');
    assert.equal(read(RING + COMMAND.ARGS), RING + 12, 'the pointer names the copy');
    assert.deepEqual(Array.from({ length: 6 }, (unused, i)=>read(RING + 12 + 4 * i)), viewport);

    assert.equal(run(CONSTANTS, [5, DATA + 0x100, 2]), 'ok');
    const second = RING + 36;
    assert.equal(read(second + COMMAND.BYTES), 8 + 12 + 32);
    assert.deepEqual([read(second + 8), read(second + 12), read(second + 16)],
        [5, second + 20, 2]);
    assert.deepEqual(new Float32Array(host.readPhysical(second + 20, 32).slice().buffer),
        floats.slice(0, 8));

    assert.equal(run(ENABLE, [3, 1]), 'ok');
    assert.deepEqual([read(RING + 88), read(RING + 92), read(RING + 96), read(RING + 100)],
        [commandSlot('LightEnable'), 16, 3, 1]);

    // The setters whose getters run in the guest keep the block current too.
    assert.equal(run(STATE, [7, 0x1234]), 'ok');
    assert.equal(read(BLOCK + SHADOW.RENDER_STATES + 7 * 4), 0x1234);
    assert.deepEqual([read(RING + 104), read(RING + 112), read(RING + 116)],
        [commandSlot('SetRenderState'), 7, 0x1234]);
    assert.equal(run(STATE, [300, 1]), 'trap', 'a state past the block');
    assert.equal(run(TRANSFORM, [257, DATA + 0x100]), 'ok', 'WORLD1');
    assert.deepEqual(new Float32Array(host.readPhysical(BLOCK + SHADOW.TRANSFORMS + 25 * 64, 64)
        .slice().buffer), floats.slice(0, 16));
    assert.equal(read(RING + 120 + COMMAND.BYTES), 8 + 8 + 64);
    assert.equal(run(TRANSFORM, [24, DATA + 0x100]), 'trap', 'a type the block has no slot for');
    assert.equal(head(), 200);

    // A buffer locks in the guest while no draw waits; after one, only a lock
    // that promises not to overwrite what it reads does.
    assert.equal(run(LOCK, [0, 16, OUT, 0], VBUF), 'ok');
    host.writePhysical(VBLOCK + BUFFER.LOCKED, new Uint8Array(4));
    assert.equal(run(DRAW, [4, 0, 0, 4, 0, 2]), 'ok');
    assert.equal(read(BLOCK + SHADOW.DRAWS_PENDING), 1, 'a draw is waiting');
    assert.deepEqual(Array.from({ length: 8 }, (unused, i)=>read(RING + 200 + 4 * i)),
        [commandSlot('DrawIndexedPrimitive'), 32, 4, 0, 0, 4, 0, 2]);
    assert.equal(run(LOCK, [0, 16, OUT, 0], VBUF), 'trap', 'a plain lock waits for the host');
    assert.equal(run(LOCK, [0, 16, OUT, 0x2000], VBUF), 'trap', 'and so does DISCARD');
    assert.equal(run(LOCK, [16, 16, OUT, 0x1000], VBUF), 'ok', 'NOOVERWRITE does not');
    assert.equal(read(BLOCK + SHADOW.LOCK_CALLS), 2, 'each lock taken in the guest counted');

    // What the host makes of them: the calls, in order, with what was copied.
    /** @type {any[]} */
    const made = [];
    /** @param {string} name */
    const log = name=>(/** @type {any[]} */ ...args)=>made.push([name, ...args.map(arg=>
        (ArrayBuffer.isView(arg) ? [...(/** @type {any} */ (arg))] : arg))]) && 0;
    const device = Object.fromEntries(['SetViewport', 'SetVertexShaderConstantF', 'LightEnable',
        'SetRenderState', 'SetTransform', 'DrawIndexedPrimitive'].map(name=>[name, log(name)]));
    assert.equal(runCommands(device, host.readPhysical(RING, head()).slice(), [], ()=>{
        assert.fail('nothing refused');
    }), 6);
    assert.deepEqual(made, [
        ['SetViewport', { X: 0, Y: 0, Width: 640, Height: 480, MinZ: 0, MaxZ: 1 }],
        ['SetVertexShaderConstantF', 5, [...floats.slice(0, 8)], 2],
        ['LightEnable', 3, true],
        ['SetRenderState', 7, 0x1234],
        ['SetTransform', 257, [...floats.slice(0, 16)]],
        ['DrawIndexedPrimitive', 4, 0, 0, 4, 0, 2],
    ]);

    // Each case the routines do not take, the ring as it was.
    const before = head();
    assert.equal(run(VIEWPORT, [0]), 'trap', 'a null pointer');
    assert.equal(run(CONSTANTS, [0, DATA + 0x100, 0]), 'trap', 'no registers');
    assert.equal(run(CONSTANTS, [0, DATA + 0x100, 257]), 'trap', 'more than a device has');
    host.writePhysical(BLOCK, new Uint8Array(u32(FLAG_SLOW_PATH)));
    assert.equal(run(ENABLE, [0, 1]), 'trap', 'the host\'s flag');
    host.writePhysical(BLOCK, new Uint8Array(u32(0)));
    host.writePhysical(BLOCK + SHADOW.COMMAND_BYTES, new Uint8Array(u32(before + 35)));
    assert.equal(run(VIEWPORT, [DATA]), 'trap', 'a ring with no room for the record');
    assert.equal(head(), before);
    assert.equal(run(ENABLE, [0, 1]), 'ok', 'and room for a smaller one');
    host.writePhysical(BLOCK + SHADOW.COMMANDS, new Uint8Array(u32(0)));
    assert.equal(run(ENABLE, [0, 1]), 'trap', 'a device with no ring');
    assert.equal(head(), before + 16);
});
