/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The buffer locks' contract, as a gate: a draw reads the vertices its buffer
 * held when the program made it. A lock and an unlock taken in the guest are
 * remembered and replayed at the host's next entry, and a draw goes into the
 * command ring and is made then too -- so the guest path is right only if,
 * whatever the program locked, wrote and drew in between, every draw still
 * reads what it would have read with each call made on the host as it came.
 *
 * The program here is generated: locks of every kind a program takes --
 * plain, DISCARD, NOOVERWRITE, both -- each written whole and unlocked, and
 * draws between them, honouring the promise NOOVERWRITE makes (nothing a draw
 * since the last lock without it reads is written) and nothing else. It runs
 * twice: through the guest routines on the processor, with the host's entries
 * made as the seam makes them; and with every call made on the device. What
 * each draw read is the gate's answer, and the two runs must give the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { commandCode, createShadow, lockCode, settledAfter, unlockCode } from './shadow.js';
import { COMMAND_MIRRORS as MIRRORS_8 } from './d3d8.js';
import { COMMAND_MIRRORS as MIRRORS_9 } from './d3d9.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';
import * as D3D9_COMMANDS from '../d3d9/commands.js';
import { createDirect3D8 } from '../d3d8/device.js';
import { createDirect3D9 } from '../d3d9/device.js';

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
const HEAP = 0x200000;
const STACK = 0x100000;

const D3D_OK = 0;
const D3DFMT_X8R8G8B8 = 22;
const D3DFMT_D24S8 = 75;
const D3DPOOL_DEFAULT = 0;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DUSAGE_WRITEONLY = 0x8;
const D3DSWAPEFFECT_DISCARD = 1;
const D3DLOCK_DISCARD = 0x2000;
const D3DLOCK_NOOVERWRITE = 0x1000;
const D3DPT_TRIANGLELIST = 4;
/** Position and colour: sixteen bytes a vertex. */
const FVF = 0x042;
const STRIDE = 16;
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
 * @typedef {{ kind: 'lock', offset: number, length: number, flags: number, fill: number }
 *     | { kind: 'draw', start: number, triangles: number }
 *     | { kind: 'entry' }} Step
 */

/**
 * A program that keeps the promises a lock's flags make: a NOOVERWRITE lock
 * writes nothing a draw since the last lock without it reads, and a draw
 * reads only what was written since the last DISCARD -- the rest of the
 * buffer is undefined after one. An entry is a call that reaches the host for
 * some other reason, as any device call may.
 *
 * @param {number} seed @param {number} count @returns {Step[]}
 */
function generate(seed, count){
    const next = random(seed);
    /** Bytes the draws since the last lock without NOOVERWRITE read. */
    let read = new Uint8Array(LENGTH);
    /** Bytes written since the last DISCARD. */
    let defined = new Uint8Array(LENGTH);
    /** @type {Step[]} */
    const steps = [];
    while (steps.length < count)
    {
        const roll = next(10);
        if (roll < 4)
        {
            const flags = [0, D3DLOCK_DISCARD, D3DLOCK_NOOVERWRITE,
                D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE][next(4)];
            const first = next(VERTICES);
            const span = 1 + next(Math.min(24, VERTICES - first));
            const offset = first * STRIDE;
            const length = span * STRIDE;
            if (flags === D3DLOCK_NOOVERWRITE && read.subarray(offset, offset + length).includes(1))
            {
                continue;
            }
            if (flags !== D3DLOCK_NOOVERWRITE)
            {
                read = new Uint8Array(LENGTH);
            }
            if ((flags & D3DLOCK_DISCARD) !== 0)
            {
                defined = new Uint8Array(LENGTH);
            }
            defined.fill(1, offset, offset + length);
            steps.push({ kind: 'lock', offset, length, flags, fill: 1 + next(250) });
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
 * What tells the two versions apart here: how a device is made, how its
 * stream and format are set, and its ring's commands and mirrors.
 *
 * @typedef {{ name: string, create: (services: object) => any,
 *     bind: (device: any, buffer: any) => void, commands: any,
 *     mirrors: Record<string, any[]> }} Version
 */

/** @type {Version[]} */
const VERSIONS = [
    {
        name: 'Direct3D 8',
        create: services=>createDirect3D8(services),
        bind: (device, buffer)=>{
            assert.equal(device.SetStreamSource(0, buffer, STRIDE), D3D_OK);
            assert.equal(device.SetVertexShader(FVF), D3D_OK);
        },
        commands: D3D8_COMMANDS,
        mirrors: MIRRORS_8,
    },
    {
        name: 'Direct3D 9',
        create: services=>createDirect3D9(services),
        bind: (device, buffer)=>{
            assert.equal(device.SetStreamSource(0, buffer, 0, STRIDE), D3D_OK);
            assert.equal(device.SetFVF(FVF), D3D_OK);
        },
        commands: D3D9_COMMANDS,
        mirrors: MIRRORS_9,
    },
];

/**
 * A device over the processor's memory, its buffer, and what each draw read:
 * the bytes of its vertices as the renderer would have them -- the buffer's
 * unlocked ranges, copied out of guest memory at each unlock.
 *
 * Lent, the ranges are read as the graphics worker reads lent memory
 * (`remote/lending.js`): as late as it may -- an unlocked range is lent at
 * the next draw, and its bytes are taken when a host lock claims it or, at
 * the end, out of what guest memory holds then.
 *
 * @param {Version} version @param {boolean} [lent]
 */
function machine(version, lent = false){
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
    const d3d = version.create({ allocate, free: ()=>{}, readMemory, writeMemory,
        windowMemory: readMemory });
    /** @type {{ device?: any }} */
    const made = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT_DISCARD, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT_X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT_D24S8,
    }, made, 0), D3D_OK);
    const device = made.device;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(LENGTH, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, FVF,
        D3DPOOL_DEFAULT, out), D3D_OK);
    const buffer = out.buffer;
    device.lendsMemory = lent;

    // What the renderer holds of the buffer: each unlock copies the range its
    // lock named, as `unlockBuffer` reads it out of guest memory.
    const held = new Uint8Array(LENGTH);
    /** @type {{ offset: number, length: number } | null} */
    let locking = null;
    /** Unlocked ranges a draw has yet to lend. @type {{ offset: number, length: number }[]} */
    let unlent = [];
    /**
     * What the worker plays, in order: lends (their bytes once claimed) and draws.
     *
     * @type {({ offset: number, length: number, bytes: Uint8Array | null }
     *     | { start: number, count: number })[]}
     */
    const played = [];
    const lock = buffer.Lock.bind(buffer);
    const unlock = buffer.Unlock.bind(buffer);
    /** @param {number} offset @param {number} size @param {any} result @param {number} flags */
    buffer.Lock = (offset, size, result, flags)=>{
        const hr = lock(offset, size, result, flags);
        if (hr === D3D_OK)
        {
            locking = { offset, length: size === 0 ? LENGTH - offset : size };
            // Claimed as the recorder claims (`remote/replay.js`): a lock
            // but NOOVERWRITE alone all of the buffer, one with it its range.
            const [from, to] = flags !== D3DLOCK_NOOVERWRITE ? [0, LENGTH]
                : [offset, offset + locking.length];
            for (const entry of played)
            {
                if ('offset' in entry && !entry.bytes && entry.offset < to
                    && from < entry.offset + entry.length)
                {
                    entry.bytes = readMemory(buffer.base + entry.offset, entry.length).slice();
                }
            }
        }
        return hr;
    };
    buffer.Unlock = ()=>{
        const hr = unlock();
        if (hr === D3D_OK && locking)
        {
            if (lent)
            {
                unlent.push(locking);
            }
            else
            {
                held.set(readMemory(buffer.base + locking.offset, locking.length),
                    locking.offset);
            }
            locking = null;
        }
        return hr;
    };
    /** @type {number[][]} */
    const reads = [];
    const draw = device.DrawPrimitive.bind(device);
    /** @param {number} type @param {number} start @param {number} count */
    device.DrawPrimitive = (type, start, count)=>{
        const hr = draw(type, start, count);
        if (hr === D3D_OK && lent)
        {
            played.push(...unlent.map(range=>({ ...range, bytes: null })), { start, count });
            unlent = [];
        }
        else if (hr === D3D_OK)
        {
            reads.push([...held.subarray(start * STRIDE, (start + count * 3) * STRIDE)]);
        }
        return hr;
    };
    /** The worker plays what was lent and drawn: what each draw read. */
    const drained = ()=>{
        for (const entry of played)
        {
            if ('offset' in entry)
            {
                held.set(entry.bytes ?? readMemory(buffer.base + entry.offset, entry.length),
                    entry.offset);
            }
            else
            {
                reads.push([...held.subarray(entry.start * STRIDE,
                    (entry.start + entry.count * 3) * STRIDE)]);
            }
        }
        played.length = 0;
        return reads;
    };
    version.bind(device, buffer);
    assert.equal(device.BeginScene(), D3D_OK);
    return { host, allocate, readMemory, writeMemory, readU32, device, buffer, drained };
}

/**
 * The program's writes into what a lock handed back: the whole range, each
 * byte a function of the fill and its place, so a stale byte differs.
 *
 * @param {(at: number, bytes: Uint8Array) => void} writeMemory
 * @param {number} at @param {number} length @param {number} fill
 */
const write = (writeMemory, at, length, fill)=>writeMemory(at,
    Uint8Array.from({ length }, (unused, i)=>(fill + i * 7) & 0xff));

/**
 * Every call made on the device as it comes.
 *
 * @param {Version} version @param {Step[]} steps @param {boolean} [lent]
 */
function direct(version, steps, lent = false){
    const { writeMemory, device, buffer, drained } = machine(version, lent);
    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(buffer.Lock(step.offset, step.length, locked, step.flags), D3D_OK);
            write(writeMemory, /** @type {number} */ (locked.pBits), step.length, step.fill);
            assert.equal(buffer.Unlock(), D3D_OK);
        }
        else if (step.kind === 'draw')
        {
            assert.equal(device.DrawPrimitive(D3DPT_TRIANGLELIST, step.start, step.triangles),
                D3D_OK);
        }
    }
    return drained();
}

/**
 * The same calls through the guest routines, with the host's entries made as
 * the seam makes them: a buffer's lock or unlock on the host first plays what
 * the guest did (`describeResource`), then settles the buffer, then takes or
 * gives back the lock and says so in the block; a device call plays it all
 * and brings the block to the device after (`settledAfter`).
 *
 * @param {Version} version @param {Step[]} steps @param {boolean} [lent]
 */
function guest(version, steps, lent = false){
    const { host, allocate, readMemory, writeMemory, readU32, device, buffer, drained } =
        machine(version, lent);
    const shadow = createShadow({
        allocate, readMemory, readU32, writeMemory, device,
        commands: { take: records=>device.commands(records,
            version.commands.commandObjects(records, ()=>null)) },
    });
    host.writePhysical(DEVICE + 4, new Uint8Array(u32(shadow.address())));
    host.writePhysical(BUFFER_IF + 4, new Uint8Array(u32(shadow.attachBuffer(buffer))));
    host.writePhysical(LOCK, lockCode(LOCK, LOCK_TRAP));
    host.writePhysical(UNLOCK, unlockCode(UNLOCK, UNLOCK_TRAP));
    host.writePhysical(DRAW, commandCode(DRAW, DRAW_TRAP, {
        ...version.commands.COMMANDS.DrawPrimitive,
        slot: version.commands.commandSlot('DrawPrimitive'),
        mirror: version.mirrors.DrawPrimitive,
    }));
    for (const trap of [LOCK_TRAP, UNLOCK_TRAP, DRAW_TRAP])
    {
        host.writePhysical(trap, new Uint8Array([0xf4]));
    }

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
        // A slice may end before the halt -- at a block the processor has yet
        // to translate -- and the next one goes on from there.
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
        return { hr: host.readReg32('eax') | 0 };
    };

    const hostLock = (/** @type {Step & { kind: 'lock' }} */ step)=>{
        shadow.sync();
        shadow.settleBuffer(buffer);
        /** @type {{ pBits?: number }} */
        const locked = {};
        const hr = buffer.Lock(step.offset, step.length, locked, step.flags);
        if (hr === D3D_OK)
        {
            shadow.noteLocked(buffer, true);
            writeMemory(OUT, new Uint8Array(u32(locked.pBits ?? 0)));
        }
        return hr;
    };
    const hostUnlock = ()=>{
        shadow.sync();
        shadow.settleBuffer(buffer);
        const hr = buffer.Unlock();
        if (hr === D3D_OK)
        {
            shadow.noteLocked(buffer, false);
        }
        return hr;
    };

    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            const locked = run(LOCK, BUFFER_IF, [step.offset, step.length, OUT, step.flags]);
            if ('trap' in locked)
            {
                assert.equal(locked.trap, LOCK_TRAP);
                assert.equal(hostLock(step), D3D_OK);
            }
            else
            {
                assert.equal(locked.hr, D3D_OK);
            }
            write(writeMemory, readU32(OUT), step.length, step.fill);
            const unlocked = run(UNLOCK, BUFFER_IF, []);
            if ('trap' in unlocked)
            {
                assert.equal(unlocked.trap, UNLOCK_TRAP);
                assert.equal(hostUnlock(), D3D_OK);
            }
            else
            {
                assert.equal(unlocked.hr, D3D_OK);
            }
        }
        else if (step.kind === 'draw')
        {
            const drawn = run(DRAW, DEVICE, [D3DPT_TRIANGLELIST, step.start, step.triangles]);
            if ('trap' in drawn)
            {
                assert.equal(drawn.trap, DRAW_TRAP);
                assert.equal(settledAfter(shadow, ()=>device.DrawPrimitive(D3DPT_TRIANGLELIST,
                    step.start, step.triangles)), D3D_OK);
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
    // A present, or any call at the end of the frame, plays what is left.
    shadow.sync();
    return drained();
}

test('a draw reads the vertices its buffer held when the program made it, however the locks'
    + ' around it were taken and whenever the worker reads what was lent', ()=>{
    for (const version of VERSIONS)
    {
        for (let seed = 1; seed <= 40; seed++)
        {
            const steps = generate(seed, 300);
            const expected = direct(version, steps);
            for (const [arm, actual] of [['guest', guest(version, steps)],
                ['lent', direct(version, steps, true)],
                ['guest, lent', guest(version, steps, true)]])
            {
                const label = `${version.name}, seed ${seed}, ${arm}`;
                assert.equal(actual.length, expected.length, `${label}: every draw is made`);
                const first = expected.findIndex((bytes, i)=>
                    bytes.some((byte, j)=>byte !== actual[i][j]));
                assert.equal(first, -1, `${label}: draw ${first} reads what it would on the host`);
            }
        }
    }
});
