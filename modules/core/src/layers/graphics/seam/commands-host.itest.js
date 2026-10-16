/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the host's own writing of a command (`appendCommand`): for every
 * setter of Direct3D 9 and 8 the host writes into the ring in place of the
 * guest's routine, random blocks -- the slow path's flags, a ring nearly full,
 * the draw bits, the render states the device answers for, the values it has
 * seen validated -- and random arguments go through the routine on cork and
 * through the host's writer; each must go to the host where the other does,
 * and otherwise leave the block, the ring and the record the same, byte for
 * byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { SHADOW, SURFACE, appendCommand, commandCode } from './shadow.js';
import { COMMANDS, commandSlot } from '../d3d9/commands.js';
import { D3D8_COMMANDS } from '../d3d8/commands.js';
import { COMMAND_MIRRORS as MIRRORS_9, HOST_COMMAND_MIRRORS as HOST_9 } from './d3d9.js';
import { COMMAND_MIRRORS as MIRRORS_8, HOST_COMMAND_MIRRORS as HOST_8 } from './d3d8.js';

const LOW = 0x8000;
const PROGRAM = 0x8000;
const TRAP = 0x8e00;
const OBJECT = 0x9000;
const BLOCK = 0xa000;
const RING = 0xc000;
const RING_BYTES = 0x1000;
const DATA = 0xd000;
const HIGH = 0xe000;
/** A surface's interface and its block, in the data. */
const SURFACE_OBJECT = DATA + 0xf00;
const SURFACE_BLOCK = DATA + 0xf10;
const ROUTINES = 0x20000;
const STACK = 0x300000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** @param {number} seed */
const random = seed=>()=>{
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
};

/**
 * The setters a version's host writes itself, with the routine's shape and both mirrors.
 *
 * @param {Record<string, any>} commands @param {(name: string) => number} slotOf
 * @param {Record<string, any>} mirrors @param {Record<string, any>} hostMirrors
 */
const setters = (commands, slotOf, mirrors, hostMirrors)=>Object.entries(commands)
    .filter(([name, shape])=>!shape.draws && !shape.self
        && (!(name in mirrors) || name in hostMirrors))
    .map(([name, shape])=>({ name, shape: { ...shape, slot: slotOf(name) },
        mirror: mirrors[name], host: hostMirrors[name] }));

/**
 * @param {string} version
 * @param {{ name: string, shape: any, mirror: any, host: any }[]} list
 */
function gate(version, list){
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(TRAP, Uint8Array.of(0xf4));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    const routines = list.map((entry, i)=>{
        const at = ROUTINES + i * 0x800;
        const code = commandCode(at, TRAP, { ...entry.shape, mirror: entry.mirror });
        assert.ok(code.length < 0x800, `${entry.name}'s routine fits`);
        host.writePhysical(at, code);
        return at;
    });
    const next = random(version === '9' ? 91 : 81);
    /**
     * A word an argument takes: small, about the bounds the routines check (a
     * sampler's sixteen, a stage's eight, a type's thirty-two), a pointer into
     * the data, zero, a transform's world types, or anything.
     */
    const argument = ()=>{
        const pick = next() % 10;
        return pick < 4 ? next() % 36 : pick === 4 ? next() % 300 : pick === 5
            ? DATA + 4 * (next() % 512) : pick === 6 ? 0 : pick === 7 ? 248 + next() % 24
                : pick === 8 ? [7, 8, 15, 16, 31, 32, 255, 256][next() % 8] : next();
    };
    let written = 0;
    let handed = 0;
    // Four hundred rounds for every setter, each its own.
    for (let round = 0; round < 400 * list.length; round++)
    {
        const which = round % list.length;
        const entry = list[which];
        // The low memory as the round starts: the object, its block, the ring and the data.
        const memory = new Uint8Array(HIGH - LOW);
        const view = new DataView(memory.buffer);
        const put = (/** @type {number} */ at, /** @type {number} */ value)=>
            view.setUint32(at - LOW, value >>> 0, true);
        put(OBJECT + 4, BLOCK);
        for (let at = BLOCK; at < BLOCK + SHADOW.SIZE; at += 4)
        {
            put(at, next() % 4 === 0 ? next() : 0);
        }
        const flagPick = next() % 10;
        put(BLOCK + SHADOW.FLAGS, flagPick < 7 ? 0 : [1, 2, 4][flagPick - 7]);
        put(BLOCK + SHADOW.COMMANDS, next() % 30 === 0 ? 0 : RING);
        put(BLOCK + SHADOW.COMMAND_BYTES, RING_BYTES);
        put(BLOCK + SHADOW.COMMAND_HEAD, next() % 6 === 0 ? RING_BYTES - next() % 300
            : 4 * (next() % 256));
        put(BLOCK + SHADOW.DRAWABLE, next() % 16);
        for (let at = BLOCK + SHADOW.RENDER_STATE_VALID; at < BLOCK + SHADOW.RENDER_STATE_VALID
            + 32; at += 4)
        {
            put(at, next());
        }
        // What the method reads through a pointer is in the data, or nowhere: an
        // address past it is a program's fault on Windows too.
        const args = Array.from({ length: entry.shape.args }, (_, i)=>(i === entry.shape.pointer
            ? (next() % 8 === 0 ? 0 : DATA + 4 * (next() % 256)) : argument()));
        for (let i = 0; i < SHADOW.VALIDATED_TABLES * SHADOW.VALIDATED_SLOTS; i++)
        {
            put(BLOCK + SHADOW.VALIDATED + 4 * i, next() % 3 === 0 ? args[next() % Math.max(1,
                args.length)] ?? 0 : next() % 2 === 0 ? 0 : next());
        }
        for (let at = DATA; at < HIGH; at += 4)
        {
            put(at, next());
        }
        const usage = entry.shape.surfaceUsage;
        if (usage)
        {
            // A surface: its interface in the data, the word after it its block
            // (`SURFACE`) of a usage and a size at random -- or a surface with no
            // block, or none.
            const pick = next() % 6;
            put(SURFACE_OBJECT + 4, pick === 0 ? 0 : SURFACE_BLOCK);
            put(SURFACE_BLOCK + SURFACE.DESC + 8, [0, 1, 2, 3, 0x200][next() % 5]);
            put(SURFACE_BLOCK + SURFACE.DESC + 24, 1 + next() % 2048);
            put(SURFACE_BLOCK + SURFACE.DESC + 28, 1 + next() % 2048);
            args[usage.arg] = pick === 1 ? 0 : SURFACE_OBJECT;
        }

        const headBefore = view.getUint32(BLOCK + SHADOW.COMMAND_HEAD - LOW, true);
        // The routine, on cork.
        host.writePhysical(LOW, memory);
        host.writePhysical(TRAP, Uint8Array.of(0xf4));
        /** @type {number[]} */
        const code = [];
        for (const value of [...args].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        code.push(0x68, ...u32(OBJECT));
        code.push(0xe8, ...u32((routines[which] - (PROGRAM + code.length + 5)) | 0), 0xf4);
        host.writePhysical(PROGRAM, Uint8Array.from(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        // Run to a halt: the call's return, or the trap. A slice may end sooner,
        // at the first entry into code not yet translated.
        const end = PROGRAM + code.length;
        let stopped = 0;
        for (let slice = 0; slice < 50; slice++)
        {
            host.runSlice(10000);
            stopped = host.readReg32('eip');
            if (stopped === TRAP || stopped === TRAP + 1 || stopped === end - 1 || stopped === end)
            {
                break;
            }
        }
        const trapped = stopped === TRAP || stopped === TRAP + 1;
        const guest = host.readPhysical(BLOCK, HIGH - BLOCK).slice();

        // The host's writer, over a copy of the same memory.
        const words = {
            u32: (/** @type {number} */ at)=>view.getUint32(at - LOW, true),
            setU32: (/** @type {number} */ at, /** @type {number} */ value)=>
                view.setUint32(at - LOW, value >>> 0, true),
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                memory.subarray(at - LOW, at - LOW + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
                memory.set(bytes, at - LOW),
        };
        // The program's copy of its data before the routine wrote nothing of it.
        const answer = appendCommand(words, entry.shape, entry.host, [OBJECT, ...args]);
        const label = `Direct3D ${version} round ${round}: ${entry.name}(${args.map(word=>
            `0x${(word >>> 0).toString(16)}`).join(', ')})`
            + ` flags ${view.getUint32(BLOCK - LOW, true)} head 0x${headBefore.toString(16)}`
            + ` ring ${view.getUint32(BLOCK + SHADOW.COMMANDS - LOW, true).toString(16)}`
            + ` eip 0x${stopped.toString(16)} eax 0x${host.readReg32('eax').toString(16)}`;
        assert.equal(answer === undefined, trapped, `${label}: to the host on both or neither`);
        if (trapped)
        {
            handed++;
            continue;
        }
        written++;
        assert.equal(host.readReg32('eax'), 0, `${label}: D3D_OK`);
        assert.equal(answer, 0);
        const mine = memory.subarray(BLOCK - LOW);
        const at = mine.findIndex((byte, i)=>byte !== guest[i]);
        assert.equal(at, -1, `${label}: the same block, ring and record (first difference at`
            + ` 0x${(BLOCK + at).toString(16)})`);
    }
    assert.ok(written > 1000 && handed > 500,
        `${version}: ${written} written, ${handed} handed over`);
}

test('the host writes a setter\'s record as the guest\'s routine does, or goes to the host where'
    + ' it does: Direct3D 9', ()=>{
    gate('9', setters(COMMANDS, commandSlot, MIRRORS_9, HOST_9));
});

test('the host writes a setter\'s record as the guest\'s routine does, or goes to the host where'
    + ' it does: Direct3D 8', ()=>{
    gate('8', setters(D3D8_COMMANDS.COMMANDS, D3D8_COMMANDS.commandSlot, MIRRORS_8, HOST_8));
});
