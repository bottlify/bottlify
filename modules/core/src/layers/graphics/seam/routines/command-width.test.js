/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 9's command routines built for a 64-bit process (`X64`) against
 * the same routines built for a 32-bit one: each call made both ways - the
 * i386 on cork's test machine as stdcall, the x86-64 on its long-mode machine
 * as the x64 convention calls - over the same block, ring and memory, and
 * everything the routine leaves compared: its answer, the device's block (the
 * mirrors, the lock let go, the counts), the ring's bytes. Every case either
 * leaves for the host must reach the trap with the call as it came: the
 * stack where it was, and in a 64-bit process RCX, RDX, R8 and R9 too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../../cork/src/testing/machine.js';
import { CODE_64, HIGH_64, STACK_64, argumentOf, callLong, longMachine }
    from '../../../../../scripts/guest-code/long.mjs';
import { ifRoom } from '../../../../../../cork/src/testing/memory64.js';
import { X64 } from './assemble.js';
import { commandCode } from './command.js';
import { COMMANDS, commandSlot } from '../../d3d9/commands.js';
import { DRAW, FLAG_SLOW_PATH, HELD_HOST, SHADOW } from '../block.js';
import {
    DRAWABLE_MIRRORS, RENDER_STATE_MIRROR, TRANSFORM_MIRROR, VIEWPORT_GUARD_9, VIEWPORT_MIRROR,
} from './command.js';

const TRAP = 0x180000;
const RETURN = 0x180010;
const THIS = 0x200000;
const BLOCK = 0x210000;
const BLOCK_BYTES = 0x2000;
const RING = 0x220000;
const RING_BYTES = 0x1000;
const DATA = 0x230000;
const OBJECT = 0x240000;
const STACK_32 = 0x3f0000;

/** The routines Crysis calls most, each with the mirror Direct3D 9 gives it. */
/** @type {Record<string, readonly import('./assemble.js').Part[]>} */
const MIRRORS = {
    SetRenderState: RENDER_STATE_MIRROR,
    SetStreamSource: DRAWABLE_MIRRORS.SetStreamSource9,
    SetIndices: DRAWABLE_MIRRORS.SetIndices,
    SetTransform: TRANSFORM_MIRROR,
    SetViewport: [...VIEWPORT_GUARD_9, ...VIEWPORT_MIRROR],
};

/** @param {string} name @param {import('./assemble.js').Width} [width] */
const codeOf = (name, width)=>commandCode(CODE_64, TRAP, { ...COMMANDS[name],
    slot: commandSlot(name), mirror: [...MIRRORS[name] ?? []] }, width);

/** @param {number} value */
const le = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * The device's block and its ring, and the memory a call points at, as both
 * machines get them.
 *
 * @param {(address: number, bytes: number[]) => void} write
 * @param {{ flags?: number, held?: number, ringBytes?: number, drawable?: number }} [state]
 */
const lay = (write, { flags = 0, held = 0, ringBytes = RING_BYTES,
    drawable = DRAW.SCENE | DRAW.DECLARED | DRAW.STREAM | DRAW.INDEXED } = {})=>
{
    write(BLOCK, new Array(BLOCK_BYTES).fill(0));
    write(BLOCK + SHADOW.FLAGS, le(flags));
    write(BLOCK + SHADOW.COMMANDS, le(RING));
    write(BLOCK + SHADOW.COMMAND_BYTES, le(ringBytes));
    write(BLOCK + SHADOW.HELD, le(held));
    write(BLOCK + SHADOW.DRAWABLE, le(drawable));
    // Render state 7 is one the device answers for; 9 is not.
    write(BLOCK + SHADOW.RENDER_STATE_VALID, [1 << 7]);
    write(RING, new Array(RING_BYTES).fill(0xee));
    write(DATA, Array.from({ length: 256 }, (_, i)=>(i * 37 + 11) & 0xff));
};

/**
 * A call made on both machines; what each left.
 *
 * @param {string} name @param {number[]} args  without `this`, each a dword
 * @param {{ state?: Parameters<typeof lay>[1], high?: number }} [given]
 *     high: an argument the 64-bit call passes with its upper half set
 */
const both = (name, args, { state, high = -1, far = -1 } = {})=>{
    const m32 = createTestMachine({ ramSize: 1 << 22 });
    m32.write(CODE_64, Array.from(codeOf(name)));
    m32.write(TRAP, [0xf4]);
    m32.write(RETURN, [0xf4]);
    m32.write(THIS, [...le(0x7000), ...le(BLOCK)]);
    lay((at, bytes)=>m32.write(at, bytes), state);
    m32.writeU32(STACK_32, RETURN);
    [THIS, ...args].forEach((word, i)=>m32.writeU32(STACK_32 + 4 + 4 * i, word >>> 0));
    for (const [reg, value] of Object.entries({ eax: 0xa5a5a5a5, ecx: 0xc5c5c5c5,
        edx: 0xd5d5d5d5, ebx: 0x11111111, esi: 0x22222222, edi: 0x33333333, ebp: 0x44444444 }))
    {
        m32.setReg(reg, value);
    }
    m32.setReg('esp', STACK_32);
    m32.setEflags(2);
    m32.runProgram(CODE_64);

    // `far`: a pointer argument moved past 4 GiB, what it points at with it, on a
    // machine whose window reaches there - on the interpreter: the translator's
    // wide window has its own gate.
    const m64 = longMachine(far >= 0 ? { window: 2 ** 33, config: { translate: false } } : {});
    m64.write(CODE_64, codeOf(name, X64));
    m64.write(TRAP, [0xf4]);
    m64.write(RETURN, [0xf4]);
    m64.setQuad(THIS, 0x7000n);
    m64.setQuad(THIS + 8, BigInt(BLOCK));
    lay((at, bytes)=>m64.write(at, bytes), state);
    if (far >= 0)
    {
        m64.write(HIGH_64 + args[far - 1], m64.read(args[far - 1], 256));
    }
    // A pointer comes whole, its upper half zero; any other argument's upper
    // half is the convention's to leave undefined, a pattern here.
    const shape = COMMANDS[name];
    const pointers = new Set([...shape.objects ?? [], shape.pointer ?? -1]);
    const call = callLong(m64, CODE_64, { returnTo: RETURN, args: [BigInt(THIS), ...args.map(
        (word, i)=>(i + 1 === high ? BigInt(word >>> 0) | 1n << 32n
            : i + 1 === far ? BigInt(HIGH_64 + word)
                : pointers.has(i) ? BigInt(word >>> 0) : argumentOf(word, i + 1)))] });
    return {
        m32, m64, call,
        returned32: m32.eip() === RETURN + 1, returned64: m64.rip() === RETURN + 1,
        trapped32: m32.eip() === TRAP + 1, trapped64: m64.rip() === TRAP + 1,
    };
};

/** @param {ReturnType<typeof both>} run */
const sameAfter = run=>{
    const { m32, m64 } = run;
    assert.equal(m64.reg('rax') & 0xffffffffn, BigInt(m32.reg('eax') >>> 0), 'answer');
    assert.deepEqual([...m64.read(BLOCK, BLOCK_BYTES)], [...m32.read(BLOCK, BLOCK_BYTES)], 'block');
    assert.deepEqual([...m64.read(RING, RING_BYTES)], [...m32.read(RING, RING_BYTES)], 'ring');
};

/** @param {ReturnType<typeof both>} run @param {number} args  without `this` */
const tookCall = (run, args)=>{
    assert.ok(run.returned32 && run.returned64, 'answered in the guest');
    assert.equal(run.m32.reg('esp') >>> 0, STACK_32 + 4 + 4 * (1 + args));
    assert.equal(run.m64.reg('rsp'), BigInt(STACK_64 + 8));
    for (const reg of ['rbx', 'rbp', 'rsi', 'rdi', 'r12', 'r13', 'r14', 'r15'])
    {
        assert.equal(run.m64.reg(reg), run.call.entry[reg], reg);
    }
    assert.notDeepEqual([...run.m64.read(RING, 8)], new Array(8).fill(0xee), 'a record');
    sameAfter(run);
};

/** @param {ReturnType<typeof both>} run */
const leftForHost = run=>{
    assert.ok(run.trapped32 && run.trapped64, 'left for the trap');
    assert.equal(run.m32.reg('esp') >>> 0, STACK_32);
    for (const reg of ['rcx', 'rdx', 'r8', 'r9', 'rsp'])
    {
        assert.equal(run.m64.reg(reg), run.call.entry[reg], reg);
    }
    assert.deepEqual([...run.m64.read(RING, RING_BYTES)], new Array(RING_BYTES).fill(0xee));
};

/** @type {[string, number[]][]} */
const TAKEN = [
    ['SetRenderState', [7, 0x1234]],
    ['SetVertexShaderConstantF', [4, DATA, 3]],
    ['SetPixelShaderConstantF', [0, DATA + 16, 1]],
    ['SetStreamSource', [0, OBJECT, 64, 32]],
    ['SetIndices', [OBJECT]],
    ['SetTexture', [3, OBJECT]],
    ['SetSamplerState', [2, 5, 1]],
    ['DrawIndexedPrimitive', [4, -2, 0, 300, 0, 100]],
    ['SetVertexShader', [OBJECT]],
    ['SetTransform', [2, DATA]],
    ['SetViewport', [DATA]],
];

for (const [name, args] of TAKEN)
{
    test(`${name} at 64 bits records what it records at 32`, ()=>{
        tookCall(both(name, args), COMMANDS[name].args);
    });
}

test('SetRenderState of the value the block holds records nothing at either width', ()=>{
    const first = both('SetRenderState', [7, 0]);
    assert.ok(first.returned32 && first.returned64);
    assert.deepEqual([...first.m64.read(RING, 8)], new Array(8).fill(0xee));
    sameAfter(first);
});

/** @type {[string, string, number[], Parameters<typeof both>[2]][]} */
const LEFT = [
    ['the host wants the slow path', 'SetRenderState', [7, 1],
        { state: { flags: FLAG_SLOW_PATH } }],
    ['the device held by the host', 'SetTexture', [3, OBJECT], { state: { held: HELD_HOST } }],
    ['a state the device refuses', 'SetRenderState', [9, 1], {}],
    ['a stage out of range', 'SetTexture', [99, OBJECT], {}],
    ['a full ring', 'SetVertexShaderConstantF', [0, DATA, 8], { state: { ringBytes: 16 } }],
    ['constants past the last', 'SetVertexShaderConstantF', [250, DATA, 8], {}],
    ['a null pointer', 'SetVertexShaderConstantF', [0, 0, 1], {}],
    ['a draw out of a scene', 'DrawIndexedPrimitive', [4, 0, 0, 3, 0, 1],
        { state: { drawable: DRAW.DECLARED | DRAW.STREAM | DRAW.INDEXED } }],
];

for (const [why, name, args, given] of LEFT)
{
    test(`${name} leaves ${why} to the trap at both widths, the call as it came`, ()=>{
        const run = both(name, args, given);
        leftForHost(run);
        assert.deepEqual([...run.m64.read(BLOCK, BLOCK_BYTES)],
            [...run.m32.read(BLOCK, BLOCK_BYTES)], 'block');
    });
}

for (const [name, args, object] of /** @type {[string, number[], number][]} */ ([
    ['SetTexture', [3, OBJECT], 2],
    ['SetStreamSource', [0, OBJECT, 0, 32], 2],
]))
{
    test(`${name} at 64 bits leaves an interface above 4 GiB, none of the engine's, to the trap`,
        ()=>{
            const run = both(name, args, { high: object });
            assert.ok(run.trapped64, 'left for the trap');
            for (const reg of ['rcx', 'rdx', 'r8', 'r9', 'rsp'])
            {
                assert.equal(run.m64.reg(reg), run.call.entry[reg], reg);
            }
            assert.deepEqual([...run.m64.read(RING, RING_BYTES)], new Array(RING_BYTES).fill(0xee));
            assert.equal(run.m64.read(BLOCK + SHADOW.HELD, 4)[0], 0, 'the lock let go');
        });
}

for (const [name, args, pointer] of /** @type {[string, number[], number][]} */ ([
    ['SetVertexShaderConstantF', [4, DATA, 3], 2],
    ['SetPixelShaderConstantF', [0, DATA + 16, 1], 2],
    ['SetTransform', [2, DATA], 2],
    ['SetViewport', [DATA], 1],
]))
{
    test(`${name} at 64 bits copies what a pointer past 4 GiB points at`, ifRoom(()=>{
        tookCall(both(name, args, { far: pointer }), COMMANDS[name].args);
    }));
}
