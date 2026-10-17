/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 7's vertex buffer locks, as a gate: what `locks-contract.itest.js`
 * holds Direct3D 8 and 9 to. A lock and an unlock taken in the guest
 * (`lock7Code`, `unlockCode`) are remembered and replayed at the host's next
 * entry, once a device's block has taken the buffer's (`adoptBuffer`); a draw
 * from the buffer goes into the command ring. The guest path is right only if
 * every draw still reads what it would have read with each call made on the
 * host as it came.
 *
 * This version locks a buffer whole and refuses a draw from one locked, so a
 * program writes part of what it locked and draws after the unlock -- plain,
 * DISCARD, NOOVERWRITE (nothing a draw since the last lock without it reads
 * is written) and both -- with other calls reaching the host in between and
 * while a lock is held. It runs twice: through the routines on the processor,
 * the host's entries made as the seam makes them, and with every call made
 * on the device. What each draw read is the answer, and the two must agree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { createDirect3D7 } from '../d3d7/device.js';
import { D3D7_COMMANDS } from '../d3d7/commands.js';
import { DEVICE_IDS } from '../d3d7/constants.js';
import { createDirectDraw } from '../ddraw/objects.js';
import { DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCL_NORMAL, DDSD_CAPS, DDSD_HEIGHT,
    DDSD_WIDTH } from '../ddraw/constants.js';
import { COMMAND_MIRRORS } from './d3d7.js';
import { BUFFER, VERTEX_BUFFER7, commandCode, createShadow, lock7Code, settledAfter,
    unlockCode } from './shadow.js';

const PROGRAM = 0x8000;
const LOCK = 0x9000;
const UNLOCK = 0x9400;
const DRAW = 0x9800;
/** Where each routine leaves for the host: a halt each, so the one it took is known. */
const LOCK_TRAP = 0x9e00;
const UNLOCK_TRAP = 0x9e10;
const DRAW_TRAP = 0x9e20;
/** The interfaces: a pointer, and the block one word on. */
const DEVICE = 0xa000;
const BUFFER_IF = 0xa100;
const OUT = 0xa200;
const SIZE_OUT = 0xa210;
const HEAP = 0x200000;
const STACK = 0x100000;
const HWND = 0x00010044;

const D3D_OK = 0;
const DDLOCK_DISCARDCONTENTS = 0x2000;
const DDLOCK_NOOVERWRITE = 0x1000;
const D3DPT_TRIANGLELIST = 4;
/** Transformed position and colour: twenty bytes a vertex. */
const FVF = 0x044;
const STRIDE = 20;
const VERTICES = 96;
const LENGTH = VERTICES * STRIDE;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** A small seeded generator, so a failure names the seed that makes it. @param {number} seed */
const random = seed=>{
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
};

/**
 * @typedef {{ kind: 'lock', offset: number, length: number, flags: number, fill: number,
 *         entry: boolean }
 *     | { kind: 'draw', start: number, triangles: number }
 *     | { kind: 'entry' }} Step
 *
 * A lock of the whole buffer writes `length` bytes from `offset`; with
 * `entry`, another call reaches the host while it is held.
 */

/**
 * A program that keeps the promises a lock's flags make: a NOOVERWRITE lock
 * writes nothing a draw since the last lock without it reads, and a draw
 * reads only what was written since the last DISCARD.
 *
 * @param {number} seed @param {number} count @returns {Step[]}
 */
function generate(seed, count){
    const next = random(seed);
    let read = new Uint8Array(LENGTH);
    let defined = new Uint8Array(LENGTH);
    /** @type {Step[]} */
    const steps = [];
    while (steps.length < count)
    {
        const roll = next(10);
        if (roll < 4)
        {
            const flags = [0, DDLOCK_DISCARDCONTENTS, DDLOCK_NOOVERWRITE,
                DDLOCK_DISCARDCONTENTS | DDLOCK_NOOVERWRITE][next(4)];
            const first = next(VERTICES);
            const span = 1 + next(Math.min(24, VERTICES - first));
            const offset = first * STRIDE;
            const length = span * STRIDE;
            if (flags === DDLOCK_NOOVERWRITE && read.subarray(offset, offset + length).includes(1))
            {
                continue;
            }
            if (flags !== DDLOCK_NOOVERWRITE)
            {
                read = new Uint8Array(LENGTH);
            }
            if ((flags & DDLOCK_DISCARDCONTENTS) !== 0)
            {
                defined = new Uint8Array(LENGTH);
            }
            defined.fill(1, offset, offset + length);
            steps.push({ kind: 'lock', offset, length, flags, fill: 1 + next(250),
                entry: next(4) === 0 });
        }
        else if (roll < 9)
        {
            const triangles = 1 + next(4);
            const start = next(VERTICES - triangles * 3 + 1);
            if (defined.subarray(start * STRIDE, (start + triangles * 3) * STRIDE).includes(0))
            {
                continue;
            }
            read.fill(1, start * STRIDE, (start + triangles * 3) * STRIDE);
            steps.push({ kind: 'draw', start, triangles });
        }
        else
        {
            steps.push({ kind: 'entry' });
        }
    }
    return steps;
}

/**
 * A device over the processor's memory, its vertex buffer, and what each draw
 * read: the buffer's bytes as the renderer would have them, copied out of
 * guest memory at each unlock -- of the whole buffer, as this version locks.
 */
function machine(){
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    let heap = HEAP;
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = heap;
        heap += (bytes + 0xfff) & ~0xfff;
        host.writePhysical(at, new Uint8Array(bytes));
        return at;
    };
    /** @param {number} at @param {number} length */
    const readMemory = (at, length)=>host.readPhysical(at, length);
    /** @param {number} at @param {Uint8Array} bytes */
    const writeMemory = (at, bytes)=>host.writePhysical(at, bytes);
    /** @param {number} at */
    const readU32 = at=>new DataView(host.readPhysical(at, 4).slice().buffer).getUint32(0, true);
    const root = createDirectDraw({ version: 7, screenWidth: 16, screenHeight: 16, allocate,
        free: ()=>{} });
    root.setCooperativeLevel(HWND, DDSCL_NORMAL);
    const target = root.createSurface({ flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        caps: DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8 }).surface;
    const d3d = createDirect3D7(root);
    const made = d3d.createDevice(DEVICE_IDS.HAL, target);
    assert.equal(made.hr, D3D_OK);
    const device = made.device;
    const created = d3d.createVertexBuffer({ caps: 0, fvf: FVF, numVertices: VERTICES });
    assert.equal(created.hr, D3D_OK);
    const buffer = created.buffer;
    assert.equal(buffer.length, LENGTH);

    const held = new Uint8Array(LENGTH);
    const lock = buffer.Lock.bind(buffer);
    const unlock = buffer.Unlock.bind(buffer);
    buffer.Lock = (/** @type {number} */ flags, /** @type {any} */ out)=>lock(flags, out);
    buffer.Unlock = ()=>{
        const was = buffer.locked;
        const hr = unlock();
        if (hr === D3D_OK && was)
        {
            held.set(readMemory(buffer.base, LENGTH));
        }
        return hr;
    };
    /** @type {number[][]} */
    const reads = [];
    const draw = device.DrawPrimitiveVB.bind(device);
    /** @param {number} type @param {any} vb @param {number} start @param {number} count @param {number} clip */
    device.DrawPrimitiveVB = (type, vb, start, count, clip)=>{
        const hr = draw(type, vb, start, count, clip);
        if (hr === D3D_OK)
        {
            reads.push([...held.subarray(start * STRIDE, (start + count) * STRIDE)]);
        }
        return hr;
    };
    assert.equal(device.BeginScene(), D3D_OK);
    return { host, allocate, readMemory, writeMemory, readU32, device, buffer, reads };
}

/** @param {Step & { kind: 'lock' }} step */
const bytesOf = step=>Uint8Array.from({ length: step.length },
    (unused, i)=>(step.fill + i * 7) & 0xff);

/** Every call made on the device as it comes. @param {Step[]} steps */
function direct(steps){
    const { writeMemory, device, buffer, reads } = machine();
    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            /** @type {{ data?: number }} */
            const locked = {};
            assert.equal(buffer.Lock(step.flags, locked), D3D_OK);
            writeMemory(/** @type {number} */ (locked.data) + step.offset, bytesOf(step));
            assert.equal(buffer.Unlock(), D3D_OK);
        }
        else if (step.kind === 'draw')
        {
            assert.equal(device.DrawPrimitiveVB(D3DPT_TRIANGLELIST, buffer, step.start,
                step.triangles * 3, 0), D3D_OK);
        }
    }
    return reads;
}

/**
 * The same calls through the guest's routines, the host's entries made as
 * the seam makes them: a lock or unlock on the host first replays what the
 * guest did and says what it did in the block; a device call plays it all.
 *
 * @param {Step[]} steps
 */
function guest(steps){
    const { host, allocate, readMemory, writeMemory, readU32, device, buffer, reads } = machine();
    const shadow = createShadow({
        allocate, readMemory, readU32, writeMemory, device,
        commands: { take: records=>device.commands(records,
            D3D7_COMMANDS.commandObjects(records, pointer=>(pointer === BUFFER_IF
                ? buffer : null))) },
    });
    host.writePhysical(DEVICE + 4, new Uint8Array(u32(shadow.address())));
    // The buffer's block, as the seam makes it beside the interface, taken
    // by the device's block (`adoptBuffer`) as its first draw takes it.
    const block = allocate(VERTEX_BUFFER7.SIZE);
    const words = new Uint32Array(VERTEX_BUFFER7.SIZE / 4);
    words[BUFFER.BASE / 4] = buffer.base;
    words[BUFFER.LENGTH / 4] = LENGTH;
    words[VERTEX_BUFFER7.VERTICES / 4] = VERTICES;
    writeMemory(block, new Uint8Array(words.buffer));
    host.writePhysical(BUFFER_IF + 4, new Uint8Array(u32(block)));
    const adapter = {
        base: buffer.base, length: LENGTH, type: 0, usage: 0,
        get refCount(){
            return 1;
        },
        release: ()=>0,
        // As the seam's (`asShadowBuffer`): a replay is a lock let go of at once.
        /** @param {number} offset @param {number} size @param {any} out @param {number} [flags] */
        Lock: (offset, size, out, flags)=>{
            const hr = buffer.Lock(flags ?? 0, out);
            if (hr === D3D_OK)
            {
                buffer.Unlock();
            }
            return hr;
        },
        Unlock: ()=>(buffer.locked ? buffer.Unlock() : D3D_OK),
    };
    assert.equal(shadow.adoptBuffer(adapter, block), true);
    host.writePhysical(LOCK, lock7Code(LOCK, LOCK_TRAP));
    host.writePhysical(UNLOCK, unlockCode(UNLOCK, UNLOCK_TRAP));
    host.writePhysical(DRAW, commandCode(DRAW, DRAW_TRAP, {
        ...D3D7_COMMANDS.COMMANDS.DrawPrimitiveVB,
        slot: D3D7_COMMANDS.commandSlot('DrawPrimitiveVB'),
        mirror: /** @type {Record<string, any>} */ (COMMAND_MIRRORS).DrawPrimitiveVB,
    }));
    for (const trap of [LOCK_TRAP, UNLOCK_TRAP, DRAW_TRAP])
    {
        host.writePhysical(trap, new Uint8Array([0xf4]));
    }
    shadow.settled();

    /**
     * Calls a routine: its answer, or which trap it left for.
     *
     * @param {number} target @param {number} object @param {number[]} args
     * @returns {{ trap: number } | { hr: number }}
     */
    const run = (target, object, args)=>{
        /** @type {number[]} */
        const code = [];
        for (const value of [...args].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        code.push(0x68, ...u32(object));
        code.push(0xe8, ...u32((target - (PROGRAM + code.length + 5)) | 0), 0xf4);
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        const halts = [PROGRAM + code.length, LOCK_TRAP + 1, UNLOCK_TRAP + 1, DRAW_TRAP + 1];
        for (let slices = 0; slices < 16 && !halts.includes(host.readReg32('eip')); slices++)
        {
            host.runSlice(10000);
        }
        const eip = host.readReg32('eip');
        assert.ok(halts.includes(eip), `the routine at ${target.toString(16)} ran to a halt`);
        if (eip !== PROGRAM + code.length)
        {
            return { trap: eip - 1 };
        }
        // A stdcall pops what it was given: the object and every argument.
        assert.equal(host.readReg32('esp') >>> 0, STACK, 'the routine popped its arguments');
        return { hr: host.readReg32('eax') | 0 };
    };

    let inGuest = 0;
    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            const locked = run(LOCK, BUFFER_IF, [step.flags, OUT, SIZE_OUT]);
            if ('trap' in locked)
            {
                assert.equal(locked.trap, LOCK_TRAP);
                shadow.sync();
                shadow.settleBuffer(adapter);
                /** @type {{ data?: number }} */
                const out = {};
                assert.equal(buffer.Lock(step.flags, out), D3D_OK);
                shadow.noteLocked(adapter, true);
                writeMemory(OUT, new Uint8Array(u32(out.data ?? 0)));
            }
            else
            {
                assert.equal(locked.hr, D3D_OK);
                assert.equal(readU32(SIZE_OUT), LENGTH, 'the size written where it points');
                inGuest++;
            }
            writeMemory(readU32(OUT) + step.offset, bytesOf(step));
            if (step.entry)
            {
                settledAfter(shadow, ()=>D3D_OK);
            }
            const unlocked = run(UNLOCK, BUFFER_IF, []);
            if ('trap' in unlocked)
            {
                assert.equal(unlocked.trap, UNLOCK_TRAP);
                shadow.sync();
                shadow.settleBuffer(adapter);
                assert.equal(buffer.Unlock(), D3D_OK);
                shadow.noteLocked(adapter, false);
            }
            else
            {
                assert.equal(unlocked.hr, D3D_OK);
            }
        }
        else if (step.kind === 'draw')
        {
            const args = [D3DPT_TRIANGLELIST, BUFFER_IF, step.start, step.triangles * 3, 0];
            const drawn = run(DRAW, DEVICE, args);
            if ('trap' in drawn)
            {
                assert.equal(drawn.trap, DRAW_TRAP);
                assert.equal(settledAfter(shadow, ()=>device.DrawPrimitiveVB(D3DPT_TRIANGLELIST,
                    buffer, step.start, step.triangles * 3, 0)), D3D_OK);
            }
            else
            {
                assert.equal(drawn.hr, D3D_OK);
            }
        }
        else
        {
            settledAfter(shadow, ()=>D3D_OK);
        }
    }
    shadow.sync();
    return { reads, inGuest };
}

test('Direct3D 7: a draw reads the vertices its buffer held when the program made it, however'
    + ' its locks were taken', ()=>{
    let inGuest = 0;
    for (let seed = 1; seed <= 20; seed++)
    {
        const steps = generate(seed, 300);
        const expected = direct(steps);
        const actual = guest(steps);
        inGuest += actual.inGuest;
        const label = `seed ${seed}`;
        assert.equal(actual.reads.length, expected.length, `${label}: every draw is made`);
        const first = expected.findIndex((bytes, i)=>
            bytes.some((byte, j)=>byte !== actual.reads[i][j]));
        assert.equal(first, -1, `${label}: draw ${first} reads what it would on the host`);
    }
    assert.ok(inGuest > 500, `${inGuest} locks taken in the guest`);
});
