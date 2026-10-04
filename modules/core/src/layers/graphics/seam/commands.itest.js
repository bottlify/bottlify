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
    BUFFER, COMMAND, FLAG_SLOW_PATH, FLAG_STALE, RENDER_STATE_MIRROR, SAMPLER_STATE_MIRROR, SHADOW,
    SURFACE, TRANSFORM_MIRROR, VIEWPORT_MIRROR, commandCode, getRenderStateCode,
    getSamplerStateCode, getSurfaceDescCode, getViewportCode, lockCode,
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
    // A scene open and something to draw from: what a draw's routine checks first.
    host.writePhysical(BLOCK + SHADOW.DRAWABLE, new Uint8Array(u32(0xf)));
    // Render state 7 as one the device answers for, as the host mirrors it.
    host.writePhysical(BLOCK + SHADOW.RENDER_STATE_VALID, new Uint8Array([0x80]));
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
    assert.equal(run(STATE, [5, 1]), 'trap', 'a state the device refuses');
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
    assert.equal(run(LOCK, [16, 16, OUT, 0x3000], VBUF), 'trap',
        'and so does DISCARD with NOOVERWRITE, which promises nothing of what the draw reads');
    assert.equal(run(LOCK, [16, 16, OUT, 0x1000], VBUF), 'ok', 'NOOVERWRITE alone does not');
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
        ['SetViewport', { X: 0, Y: 0, Width: 640, Height: 480, MinZ: 0, MaxZ: 1,
            MinZWord: 0, MaxZWord: 0x3f800000 }],
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

test('a draw from the program\'s memory copies the vertices its primitives span', ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(DRAW, commandCode(DRAW, TRAP, shape('DrawPrimitiveUP')));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(BLOCK + SHADOW.COMMANDS, new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
    // A scene open and something to draw from: what a draw's routine checks first.
    host.writePhysical(BLOCK + SHADOW.DRAWABLE, new Uint8Array(u32(0xf)));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    const vertices = new Uint8Array(0x400).map((unused, i)=>i * 7);
    host.writePhysical(DATA, vertices);

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    const head = ()=>read(BLOCK + SHADOW.COMMAND_HEAD);
    /** @param {number[]} args @returns {'ok' | 'trap'} */
    const run = args=>{
        const code = call(PROGRAM, DRAW, OBJECT, args);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(1000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(host.readReg32('esp'), STACK - 4 * (args.length + 2));
            return 'trap';
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length);
        assert.equal(host.readReg32('esp'), STACK);
        assert.equal(host.readReg32('eax'), 0);
        return 'ok';
    };

    // Each type with three primitives, twelve bytes a vertex: the vertices
    // spanned are 3, 6, 4, 9, 5 and 5.
    const spans = [3, 6, 4, 9, 5, 5];
    let at = 0;
    for (let type = 1; type <= 6; type++)
    {
        assert.equal(run([type, 3, DATA, 12]), 'ok', `type ${type}`);
        const bytes = spans[type - 1] * 12;
        assert.equal(read(RING + at + COMMAND.BYTES), COMMAND.ARGS + 16 + bytes);
        assert.equal(read(RING + at + COMMAND.ARGS + 8), RING + at + COMMAND.ARGS + 16,
            'the pointer names the copy');
        assert.deepEqual([...host.readPhysical(RING + at + COMMAND.ARGS + 16, bytes)],
            [...vertices.subarray(0, bytes)]);
        at += COMMAND.ARGS + 16 + bytes;
    }
    assert.equal(head(), at);
    assert.equal(read(BLOCK + SHADOW.DRAWS_PENDING), 1, 'a draw is waiting');

    /** @type {any[]} */
    const made = [];
    const device = {
        /**
         * @param {number} type @param {number} count @param {Uint8Array} data
         * @param {number} stride
         */
        DrawPrimitiveUP: (type, count, data, stride)=>made.push([type, count, [...data], stride])
            && 0,
    };
    assert.equal(runCommands(device, host.readPhysical(RING, head()).slice(), [], ()=>{
        assert.fail('nothing refused');
    }), 6);
    assert.deepEqual(made, spans.map((span, i)=>[i + 1, 3, [...vertices.subarray(0, span * 12)],
        12]));

    // The draws the routine leaves to the host, the ring as it was.
    assert.equal(run([7, 3, DATA, 12]), 'trap', 'a type there is not');
    assert.equal(run([0, 3, DATA, 12]), 'trap', 'nor type zero');
    assert.equal(run([4, 0, DATA, 12]), 'trap', 'no primitives');
    assert.equal(run([4, 3, 0, 12]), 'trap', 'a null pointer');
    assert.equal(run([4, 3, DATA, 10]), 'trap', 'a stride that is not whole dwords');
    assert.equal(run([4, 3, DATA, 0]), 'trap', 'no stride');
    assert.equal(run([4, 2000, DATA, 32]), 'trap', 'more than a record copies');
    assert.equal(run([4, 0xffffffff, DATA, 32]), 'trap', 'a count past any');
    assert.equal(head(), at);
});

test('the viewport and the sampler states a program sets in the guest are what its getters read',
    ()=>{
        const host = createCorkHost({
            memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
            initialStack: STACK, engine: cork, cork: {},
        });
        const SET_VIEWPORT = VIEWPORT;
        const GET_VIEWPORT = VIEWPORT + 0x100;
        const SET_SAMPLER = CONSTANTS;
        const GET_SAMPLER = CONSTANTS + 0x100;
        for (const [at, code] of /** @type {[number, Uint8Array][]} */ ([
            [SET_VIEWPORT, commandCode(SET_VIEWPORT, TRAP,
                shape('SetViewport', { mirror: VIEWPORT_MIRROR }))],
            [GET_VIEWPORT, getViewportCode(GET_VIEWPORT, TRAP)],
            [SET_SAMPLER, commandCode(SET_SAMPLER, TRAP,
                shape('SetSamplerState', { mirror: SAMPLER_STATE_MIRROR }))],
            [GET_SAMPLER, getSamplerStateCode(GET_SAMPLER, TRAP)],
        ]))
        {
            host.writePhysical(at, code);
        }
        host.writePhysical(TRAP, new Uint8Array([0xf4]));
        host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
        host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
        host.writePhysical(BLOCK + SHADOW.COMMANDS,
            new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
        host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
        const depths = new Uint32Array(new Float32Array([0.25, 0.75]).buffer);
        const viewport = [3, 4, 320, 200, ...depths];
        host.writePhysical(DATA, new Uint8Array(new Uint32Array(viewport).buffer));

        /** @param {number} at */
        const read = at=>{
            const bytes = host.readPhysical(at, 4);
            return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        };
        /** @param {number} target @param {number[]} args @returns {'ok' | 'trap'} */
        const run = (target, args)=>{
            const code = call(PROGRAM, target, OBJECT, args);
            host.writePhysical(PROGRAM, new Uint8Array(code));
            host.writeReg32('eip', PROGRAM);
            host.writeReg32('esp', STACK);
            host.runSlice(1000);
            if (host.readReg32('eip') === TRAP + 1)
            {
                assert.equal(host.readReg32('esp'), STACK - 4 * (args.length + 2));
                return 'trap';
            }
            assert.equal(host.readReg32('eip'), PROGRAM + code.length);
            assert.equal(host.readReg32('esp'), STACK);
            assert.equal(host.readReg32('eax'), 0);
            return 'ok';
        };

        assert.equal(run(SET_VIEWPORT, [DATA]), 'ok');
        host.writePhysical(OUT, new Uint8Array(24));
        assert.equal(run(GET_VIEWPORT, [OUT]), 'ok');
        assert.deepEqual(Array.from({ length: 6 }, (unused, i)=>read(OUT + i * 4)), viewport);
        assert.equal(run(GET_VIEWPORT, [0]), 'trap', 'a null pointer');

        assert.equal(run(SET_SAMPLER, [2, 5, 3]), 'ok', 'MAGFILTER of sampler 2');
        assert.equal(run(SET_SAMPLER, [15, 13, 9]), 'ok', 'DMAPOFFSET of the last');
        assert.equal(run(GET_SAMPLER, [2, 5, OUT]), 'ok');
        assert.equal(read(OUT), 3);
        assert.equal(run(GET_SAMPLER, [15, 13, OUT]), 'ok');
        assert.equal(read(OUT), 9);
        assert.equal(run(GET_SAMPLER, [16, 5, OUT]), 'trap', 'a sampler past the block');
        assert.equal(run(GET_SAMPLER, [256, 5, OUT]), 'trap', 'the displacement sampler');
        assert.equal(run(GET_SAMPLER, [2, 0, OUT]), 'trap', 'type zero');
        assert.equal(run(GET_SAMPLER, [2, 14, OUT]), 'trap', 'a type past DMAPOFFSET');
        assert.equal(run(GET_SAMPLER, [2, 5, 0]), 'trap', 'a null pointer');
        assert.equal(run(SET_SAMPLER, [256, 5, 1]), 'trap',
            'a sampler past the block is set by the host, which mirrors what it keeps');
        host.writePhysical(BLOCK, new Uint8Array(u32(FLAG_SLOW_PATH)));
        assert.equal(run(GET_VIEWPORT, [OUT]), 'trap', 'the host\'s flag');
        assert.equal(run(GET_SAMPLER, [2, 5, OUT]), 'trap');
    });

test('a state block\'s Apply in the ring names the block and sends the getters to the host', ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    const APPLY = VIEWPORT;
    const CAPTURE = VIEWPORT + 0x100;
    const GET = CONSTANTS;
    host.writePhysical(APPLY, commandCode(APPLY, TRAP, shape('StateBlock.Apply')));
    host.writePhysical(CAPTURE, commandCode(CAPTURE, TRAP, shape('StateBlock.Capture')));
    host.writePhysical(GET, getRenderStateCode(GET, TRAP));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    // The state block's interface, whose state word is its device's block.
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(BLOCK + SHADOW.COMMANDS, new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
    host.writePhysical(BLOCK + SHADOW.RENDER_STATE_VALID, new Uint8Array([0xff]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} target @param {number[]} args @returns {'ok' | 'trap'} */
    const run = (target, args)=>{
        const code = call(PROGRAM, target, OBJECT, args);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(1000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            return 'trap';
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length);
        assert.equal(host.readReg32('esp'), STACK, 'the routine popped `this` alone');
        return 'ok';
    };

    assert.equal(run(GET, [3, OUT]), 'ok', 'a getter reads the block');
    assert.equal(run(CAPTURE, []), 'ok');
    assert.deepEqual([read(RING), read(RING + 4), read(RING + 8)],
        [commandSlot('StateBlock.Capture'), 12, OBJECT], 'the record names the state block');
    assert.equal(read(BLOCK + SHADOW.FLAGS), 0, 'a capture changes nothing the block mirrors');
    assert.equal(run(APPLY, []), 'ok');
    assert.deepEqual([read(RING + 12), read(RING + 16), read(RING + 20)],
        [commandSlot('StateBlock.Apply'), 12, OBJECT]);
    assert.equal(read(BLOCK + SHADOW.FLAGS), FLAG_STALE, 'an apply may');
    assert.equal(run(GET, [3, OUT]), 'trap', 'so the getter goes to the host');
    assert.equal(run(APPLY, []), 'ok', 'while setters and applies go on in the ring');
    host.writePhysical(BLOCK, new Uint8Array(u32(FLAG_SLOW_PATH)));
    assert.equal(run(APPLY, []), 'trap', 'the host\'s flag');
});

test('a clear copies its rectangles, or none for the whole target', ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    const CLEAR = VIEWPORT;
    host.writePhysical(CLEAR, commandCode(CLEAR, TRAP, shape('Clear')));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    host.writePhysical(BLOCK, new Uint8Array(SHADOW.SIZE));
    host.writePhysical(BLOCK + SHADOW.COMMANDS, new Uint8Array([...u32(RING), ...u32(RING_BYTES)]));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    const rects = [1, 2, 3, 4, 10, 20, 30, 40];
    host.writePhysical(DATA, new Uint8Array(new Uint32Array(rects).buffer));
    const one = new Uint32Array(new Float32Array([1]).buffer)[0];

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} target @param {number[]} args @returns {'ok' | 'trap'} */
    const run = (target, args)=>{
        const code = call(PROGRAM, target, OBJECT, args);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(1000);
        if (host.readReg32('eip') === TRAP + 1)
        {
            assert.equal(host.readReg32('esp'), STACK - 4 * (args.length + 2));
            return 'trap';
        }
        assert.equal(host.readReg32('eip'), PROGRAM + code.length);
        assert.equal(host.readReg32('esp'), STACK);
        return 'ok';
    };

    assert.equal(run(CLEAR, [0, 0, 1, 0xff00ff00, one, 0]), 'ok', 'the whole target');
    assert.deepEqual(Array.from({ length: 8 }, (unused, i)=>read(RING + i * 4)),
        [commandSlot('Clear'), 32, 0, 0, 1, 0xff00ff00, one, 0], 'no pointer, nothing copied');
    assert.equal(run(CLEAR, [2, DATA, 1, 7, one, 5]), 'ok', 'two rectangles');
    assert.equal(read(RING + 32 + COMMAND.BYTES), 32 + 32);
    assert.equal(read(RING + 32 + COMMAND.ARGS + 4), RING + 64, 'the pointer names the copy');
    assert.equal(run(CLEAR, [1, 0, 1, 7, one, 5]), 'trap', 'a count with no rectangles');
    assert.equal(run(CLEAR, [0, DATA, 1, 7, one, 5]), 'trap', 'rectangles with no count');
    assert.equal(run(CLEAR, [65, DATA, 1, 7, one, 5]), 'trap', 'more than a record copies');
    // Whether a depth or a stencil clear is valid is the depth surface's to say.
    assert.equal(run(CLEAR, [0, 0, 3, 0, one, 0]), 'trap', 'the target and depth');
    assert.equal(run(CLEAR, [0, 0, 7, 0, one, 0]), 'trap', 'and stencil');
    assert.equal(run(CLEAR, [0, 0, 2, 0, one, 0]), 'trap', 'depth alone');

    /** @type {any[]} */
    const made = [];
    const device = {
        /** @param {any[]} args */
        Clear: (...args)=>made.push(args) && 0,
    };
    assert.equal(runCommands(device, host.readPhysical(RING, 96).slice(), [], ()=>{
        assert.fail('nothing refused');
    }), 2);
    assert.deepEqual(made, [
        [0, null, 1, 0xff00ff00, 1, 0],
        [2, [{ x1: 1, y1: 2, x2: 3, y2: 4 }, { x1: 10, y1: 20, x2: 30, y2: 40 }], 1, 7, 1, 5],
    ]);
});

test('a surface\'s GetDesc copies the description out of its block', ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(VIEWPORT, getSurfaceDescCode(VIEWPORT, TRAP));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(OBJECT + 4, new Uint8Array(u32(BLOCK)));
    const desc = [21, 1, 1, 0, 0, 0, 640, 480];
    host.writePhysical(BLOCK, new Uint8Array(SURFACE.SIZE));
    host.writePhysical(BLOCK + SURFACE.DESC, new Uint8Array(new Uint32Array(desc).buffer));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    /** @param {number[]} args */
    const run = args=>{
        const code = call(PROGRAM, VIEWPORT, OBJECT, args);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(1000);
        return host.readReg32('eip') === TRAP + 1 ? 'trap'
            : host.readReg32('esp') === STACK && host.readReg32('eax') === 0 ? 'ok' : 'wrong';
    };
    assert.equal(run([OUT]), 'ok');
    assert.deepEqual([...new Uint32Array(host.readPhysical(OUT, 32).slice().buffer)], desc);
    assert.equal(run([0]), 'trap', 'a null pointer');
    host.writePhysical(BLOCK, new Uint8Array(u32(FLAG_SLOW_PATH)));
    assert.equal(run([OUT]), 'trap', 'the host\'s flag');
});
