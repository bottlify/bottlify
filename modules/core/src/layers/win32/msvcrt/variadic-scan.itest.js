/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `sscanf` as the guest runs it (`variadicEntry`: the instructions that make
 * the places after the format a `va_list`, then `inguest-scan.js`'s code), as
 * a gate at both widths: the i386 and the x86-64 on the processor, called as
 * a program calls sscanf, against sscanf's own handler over seeded formats
 * and inputs - those the guest scans and those it hands to the host - the
 * answer, everything stored, the stack and the registers a caller keeps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { createMsvcrtFunctions } from './functions.js';
import { guestThrough } from './guest-window.fixture.js';
import { KEPT_64, QUADS, callLong, longMachine } from '../../../../scripts/guest-code/long.mjs';
import { random } from '../../../../scripts/guest-code/equivalence.mjs';
import { caseOf } from './scan-cases.fixture.js';
import { testAccount } from '../../cpu/testing.fixture.js';

const PROGRAM = 0x8000;
const TRAPS = 0x8f00;
const HALT = 0x8e00;
const INPUT = 0x220000;
const FORMAT = 0x220400;
const PLACES = 0x221000;
const PLACE_BYTES = 0x40;
const SLOTS = 32;
const DATA_BYTES = 0x2000;
const STACK = 0x300000;
const KEPT = /** @type {const} */ (['ebx', 'esi', 'edi', 'ebp']);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** A text's bytes and its terminator. @param {string} text */
const bytesOf = text=>Uint8Array.from([...text, '\0'], c=>c.charCodeAt(0) & 0xff);

/**
 * msvcrt's table over a machine's memory.
 *
 * @param {(at: number, length: number) => Uint8Array} read
 * @param {(at: number, bytes: Uint8Array) => void} write @param {number} pointerSize
 */
const tableOver = (read, write, pointerSize)=>/** @type {Record<string, any>} */ (
    createMsvcrtFunctions(/** @type {any} */ ({
        guest: guestThrough(read, write, pointerSize === 8 ? 8 : 4),
        regionAt: ()=>null,
        write: ()=>{},
        callGuest: ()=>Promise.resolve(0),
        pointerSize,
    })));

/**
 * sscanf's code where a test places it, its hand-over trap a halt whose
 * handler the test calls.
 *
 * @param {(builder: any) => Uint8Array} code @param {number} base
 * @param {(at: number, bytes: ArrayLike<number>) => void} write
 * @returns {Map<number, (args: number[]) => number>} the traps' handlers by address
 */
function place(code, base, write){
    /** @type {Map<number, (args: number[]) => number>} */
    const traps = new Map();
    /** @type {[number, number][]} */
    const jumps = [];
    const bytes = code({
        register: (/** @type {{ handler: (args: number[]) => number }} */ trap)=>{
            const at = TRAPS + 16 * traps.size;
            traps.set(at, trap.handler);
            write(at, Uint8Array.of(0xf4));
            return at;
        },
        jump: (/** @type {number} */ at, /** @type {number} */ target)=>jumps.push([at, target]),
    });
    for (const [at, target] of jumps)
    {
        new DataView(bytes.buffer).setUint32(at, (target - (base + at + 4)) >>> 0, true);
    }
    write(base, bytes);
    return traps;
}

/**
 * A call's places: one for each slot sscanf reads, a few of them over the
 * input, which the guest leaves to the host.
 *
 * @param {() => number} next
 */
const placesOf = next=>Array.from({ length: SLOTS }, (_, i)=>
    (next() % 50 === 0 ? INPUT + next() % 8 : PLACES + PLACE_BYTES * i));

test('sscanf\'s i386 in the guest answers and stores as its handler', ()=>{
    const CODE = 0x10000;
    const machine = createCorkHost({ memoryBudget: testAccount(),
        memorySize: 16 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: { sliceMs: Infinity },
    });
    machine.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    /** @param {number} at @param {number} length */
    const read = (at, length)=>machine.readPhysical(at, length).slice();
    /** @param {number} at */
    const readU32 = at=>new DataView(read(at, 4).buffer).getUint32(0, true);
    const fns = tableOver(read, (at, bytes)=>machine.writePhysical(at, bytes), 4);
    const traps = place(fns.sscanf.code, CODE, (at, bytes)=>
        machine.writePhysical(at, Uint8Array.from(bytes)));

    const next = random(81);
    let handed = 0;
    let scanned = 0;
    for (let round = 0; round < 1500; round++)
    {
        const { format, input } = caseOf(next);
        const places = placesOf(next);
        const args = [INPUT, FORMAT, ...places];
        const kept = Object.fromEntries(KEPT.map(reg=>[reg, next()]));
        const before = new Uint8Array(DATA_BYTES).fill(0xcc);
        before.set(bytesOf(input), 0);
        before.set(bytesOf(format), FORMAT - INPUT);
        const label = `round ${round}: ${JSON.stringify(input)} by ${JSON.stringify(format)}`;

        // The code: called as a program calls it, the caller popping.
        machine.writePhysical(INPUT, before);
        /** @type {number[]} */
        const code = [];
        for (const value of [...args].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        const site = PROGRAM + code.length;
        code.push(0xe8, ...u32((CODE - (site + 5)) | 0));
        code.push(0x81, 0xc4, ...u32(args.length * 4), 0xf4);
        machine.writePhysical(PROGRAM, new Uint8Array(code));
        for (const [reg, value] of Object.entries(kept))
        {
            machine.writeReg32(reg, value);
        }
        machine.writeReg32('eip', PROGRAM);
        machine.writeReg32('esp', STACK);
        runToHalt(machine, 1000000);
        const stopped = machine.readReg32('eip') - 1;
        if (traps.has(stopped))
        {
            // The list form's handler, given the frame it would be: the
            // input, the format and the first place's slot.
            const esp = machine.readReg32('esp');
            const frame = [readU32(esp + 4), readU32(esp + 8), readU32(esp + 12)];
            assert.deepEqual(frame, [INPUT, FORMAT, STACK - args.length * 4 + 8],
                `${label}: the list form's arguments`);
            assert.deepEqual(read(INPUT, DATA_BYTES), before, `${label}: handed over, nothing `
                + 'written');
            const answer = /** @type {(args: number[]) => number} */ (traps.get(stopped))(frame);
            machine.writeReg32('eax', answer >>> 0);
            machine.writeReg32('esp', esp + 4);
            machine.writeReg32('eip', readU32(esp));
            runToHalt(machine, 100000);
            handed++;
        }
        else
        {
            scanned++;
        }
        assert.equal(machine.readReg32('eip'), PROGRAM + code.length, `${label}: returned`);
        assert.equal(machine.readReg32('esp'), STACK, `${label}: the stack as the caller left it`);
        for (const [reg, value] of Object.entries(kept))
        {
            assert.equal(machine.readReg32(reg) >>> 0, value, `${label}: ${reg} kept`);
        }
        const answer = machine.readReg32('eax') | 0;
        const stored = read(INPUT, DATA_BYTES);

        // The handler, from the same call.
        machine.writePhysical(INPUT, before);
        assert.equal(answer, fns.sscanf.handler(args) | 0, `${label}: the answer`);
        assert.deepEqual(stored, read(INPUT, DATA_BYTES), `${label}: what was stored`);
    }
    assert.ok(handed >= 200 && scanned >= 500,
        `both ways taken often: ${scanned} in the guest, ${handed} handed to the host`);
});

test('sscanf\'s x86-64 in the guest answers and stores as its handler: the places in'
    + ' registers, the home space and the slots past it', ()=>{
    const CODE = 0x100000;
    const m = longMachine();
    m.write(HALT, [0xf4]);
    const fns = tableOver((at, length)=>m.read(at, length), (at, bytes)=>m.write(at, bytes), 8);
    assert.ok(fns.sscanf.long, 'sscanf has x86-64 code');
    const traps = place(fns.sscanf.long, CODE, (at, bytes)=>m.write(at, bytes));

    const next = random(82);
    let handed = 0;
    let scanned = 0;
    for (let round = 0; round < 1500; round++)
    {
        const { format, input } = caseOf(next);
        const places = placesOf(next);
        const args = [INPUT, FORMAT, ...places];
        const before = new Uint8Array(DATA_BYTES).fill(0xcc);
        before.set(bytesOf(input), 0);
        before.set(bytesOf(format), FORMAT - INPUT);
        const label = `round ${round}: ${JSON.stringify(input)} by ${JSON.stringify(format)}`;

        m.write(INPUT, before);
        const { entry } = callLong(m, CODE, { args: args.map(BigInt), returnTo: HALT });
        if (traps.has(m.rip() - 1))
        {
            // The list form's handler, given its arguments as its code was:
            // the input, the format and the list, the home slot of the first place.
            const frame = [Number(m.reg('rcx')), Number(m.reg('rdx')), Number(m.reg('r8'))];
            assert.deepEqual(frame, [INPUT, FORMAT, Number(entry.rsp) + 8 + 16],
                `${label}: the list form's arguments`);
            assert.deepEqual(m.read(INPUT, DATA_BYTES), before, `${label}: handed over, nothing `
                + 'written');
            const answer = /** @type {(args: number[]) => number} */ (traps.get(m.rip() - 1))(
                frame);
            const rsp = m.reg('rsp');
            m.call(Number(m.quad(Number(rsp))), { ...Object.fromEntries(QUADS.map(name=>
                [name, m.reg(name)])), rax: BigInt.asUintN(64, BigInt(answer | 0)),
            rsp: rsp + 8n });
            handed++;
        }
        else
        {
            scanned++;
        }
        assert.equal(m.rip(), HALT + 1, `${label}: returned`);
        assert.equal(m.reg('rsp'), entry.rsp + 8n, `${label}: RSP past the return address`);
        for (const name of KEPT_64)
        {
            assert.equal(m.reg(name), entry[name], `${label}: ${name} kept`);
        }
        const answer = Number(BigInt.asIntN(32, m.reg('rax')));
        const stored = m.read(INPUT, DATA_BYTES);

        // The handler, from the same call.
        m.write(INPUT, before);
        assert.equal(answer, fns.sscanf.handler(args) | 0, `${label}: the answer`);
        assert.deepEqual(stored, m.read(INPUT, DATA_BYTES), `${label}: what was stored`);
    }
    assert.ok(handed >= 200 && scanned >= 500,
        `both ways taken often: ${scanned} in the guest, ${handed} handed to the host`);
});
