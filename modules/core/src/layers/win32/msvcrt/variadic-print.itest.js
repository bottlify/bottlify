/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `sprintf` and `_snprintf` as the guest runs them (`variadicEntry`: the
 * instructions that make the arguments after the format a `va_list`, then the
 * `v` form's code), as a gate: the code on the processor against each
 * function's own handler, over seeded formats of every conversion -- those the
 * guest renders and those it hands to the host, a double or a 64-bit integer
 * among them -- the text, the answer, the stack and the registers a caller
 * keeps; and at a hand-over, the frame the `v` form's handler is given.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { createMsvcrtFunctions } from './functions.js';
import { decodeAnsi } from '../kernel32/locale.js';

const PROGRAM = 0x8000;
const TRAPS = 0x8f00;
const CODE = { sprintf: 0x10000, _snprintf: 0x14000 };
const FORMAT = 0x20000;
const STRINGS = 0x20400;
const BUFFER = 0x21000;
const BUFFER_BYTES = 0x400;
const STACK = 0x300000;
const KEPT = /** @type {const} */ (['ebx', 'esi', 'edi', 'ebp']);
const TEXTS = ['', 'a', 'Hello', 'Levels\\island\\terrain', '\xe9t\xe9', 'x'.repeat(40)];

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    const next = ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    /** @param {number} n */
    const int = n=>next() % n;
    return { u32: next, int };
}

/**
 * A format and the argument slots it reads: integers, strings, characters and
 * pointers the guest renders; a double or a 64-bit integer, two slots, the host.
 *
 * @param {ReturnType<typeof random>} rng
 */
function caseOf(rng){
    let format = '';
    /** @type {number[]} */
    const slots = [];
    for (let piece = 1 + rng.int(5); piece > 0; piece--)
    {
        if (rng.int(3) === 0)
        {
            format += ['abc', ' ', '=', '\xc9', '%%', '\\'][rng.int(6)];
            continue;
        }
        const flags = ['', '-', '0', '+', ' ', '#'][rng.int(6)];
        const width = ['', '', '4', '12'][rng.int(4)];
        const kind = rng.int(12);
        if (kind < 6)
        {
            const precision = ['', '', '.3'][rng.int(3)];
            format += `%${flags}${width}${precision}${'diuxXo'[kind]}`;
            slots.push([0, 1, 7, 255, 0x7fffffff, 0x80000000, 0xffffffff, rng.u32()][rng.int(8)]);
        }
        else if (kind === 6)
        {
            format += `%${width}s`;
            slots.push(rng.int(6) === 0 ? 0 : STRINGS + 64 * rng.int(TEXTS.length));
        }
        else if (kind === 7)
        {
            format += '%c';
            slots.push(32 + rng.int(90));
        }
        else if (kind === 8)
        {
            format += '%p';
            slots.push(rng.u32());
        }
        else if (kind < 11)
        {
            format += `%${flags}${width}.${rng.int(7)}${'feg'[rng.int(3)]}`;
            const bits = new DataView(new ArrayBuffer(8));
            bits.setFloat64(0, (rng.u32() - 0x80000000) / (1 + rng.int(1000)), true);
            slots.push(bits.getUint32(0, true), bits.getUint32(4, true));
        }
        else
        {
            format += '%I64d';
            slots.push(rng.u32(), rng.u32());
        }
    }
    return { format, slots };
}

test('sprintf and _snprintf in the guest write and answer as their handlers', ()=>{
    const machine = createCorkHost({
        memorySize: 16 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    machine.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    /** @param {number} at @param {number} length */
    const read = (at, length)=>machine.readPhysical(at, length).slice();
    /** @param {number} at */
    const readU32 = at=>new DataView(read(at, 4).buffer).getUint32(0, true);
    /** @param {number} at @param {string} text */
    const put = (at, text)=>machine.writePhysical(at,
        Uint8Array.from([...text, '\0'], c=>c.charCodeAt(0) & 0xff));
    const fns = /** @type {Record<string, any>} */ (createMsvcrtFunctions(/** @type {any} */ ({
        readMemory: read,
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            machine.writePhysical(at, bytes),
        fillMemory: (/** @type {number} */ at, /** @type {number} */ value,
            /** @type {number} */ length)=>machine.writePhysical(at,
            new Uint8Array(length).fill(value)),
        readCString: (/** @type {number} */ at, /** @type {number} */ limit)=>{
            const bytes = read(at, limit);
            const end = bytes.indexOf(0);
            return decodeAnsi(bytes.subarray(0, end < 0 ? limit : end));
        },
        regionAt: ()=>null,
        write: ()=>{},
        callGuest: ()=>Promise.resolve(0),
    })));
    TEXTS.forEach((text, k)=>put(STRINGS + 64 * k, text));

    // Each function's code where the test places it, its hand-over trap a halt
    // whose handler the test calls.
    /** @type {Map<number, (args: number[]) => number>} */
    const traps = new Map();
    /** @type {Record<string, { at: number, back: number }>} */
    const placed = {};
    for (const [name, base] of Object.entries(CODE))
    {
        /** @type {[number, number][]} */
        const jumps = [];
        const bytes = fns[name].code({
            register: (/** @type {{ handler: (args: number[]) => number }} */ trap)=>{
                const at = TRAPS + 16 * traps.size;
                traps.set(at, trap.handler);
                machine.writePhysical(at, Uint8Array.of(0xf4));
                return at;
            },
            jump: (/** @type {number} */ at, /** @type {number} */ target)=>jumps.push([at, target]),
        });
        for (const [at, target] of jumps)
        {
            new DataView(bytes.buffer).setUint32(at, (target - (base + at + 4)) >>> 0, true);
        }
        machine.writePhysical(base, bytes);
        // The `v` form returns to the `add esp` before the code's `ret`.
        placed[name] = { at: base, back: base + bytes.indexOf(0xe8) + 5 };
    }

    let handed = 0;
    let rendered = 0;
    for (let program = 1; program <= 40; program++)
    {
        const rng = random(program);
        for (let step = 0; step < 25; step++)
        {
            const { format, slots } = caseOf(rng);
            put(FORMAT, format);
            const counted = rng.int(2) === 1;
            const name = counted ? '_snprintf' : 'sprintf';
            const fixed = counted ? [BUFFER, [0, 1, 5, 16, 300][rng.int(5)], FORMAT]
                : [BUFFER, FORMAT];
            const args = [...fixed, ...slots];
            const kept = Object.fromEntries(KEPT.map(reg=>[reg, rng.u32()]));
            const garbage = Uint8Array.from({ length: BUFFER_BYTES }, ()=>rng.int(256));

            // The code: called as a program calls it, the caller popping.
            machine.writePhysical(BUFFER, garbage);
            /** @type {number[]} */
            const code = [];
            for (const value of [...args].reverse())
            {
                code.push(0x68, ...u32(value));
            }
            const site = PROGRAM + code.length;
            code.push(0xe8, ...u32((placed[name].at - (site + 5)) | 0));
            code.push(0x81, 0xc4, ...u32(args.length * 4), 0xf4);
            machine.writePhysical(PROGRAM, new Uint8Array(code));
            for (const [reg, value] of Object.entries(kept))
            {
                machine.writeReg32(reg, value);
            }
            machine.writeReg32('eip', PROGRAM);
            machine.writeReg32('esp', STACK);
            runToHalt(machine, 100000);
            const label = `${name}, program ${program}, step ${step}: ${JSON.stringify(format)}`;
            const stopped = machine.readReg32('eip') - 1;
            if (traps.has(stopped))
            {
                // The v form's handler, given the frame it would be: a list of
                // the slots after the fixed arguments, and a return to the code.
                const esp = machine.readReg32('esp');
                const firstSlot = STACK - args.length * 4 + fixed.length * 4;
                assert.equal(readU32(esp), placed[name].back, `${label}: the return`);
                const frame = Array.from({ length: fixed.length + 1 }, (_, i)=>
                    readU32(esp + 4 + 4 * i));
                assert.deepEqual(frame, [...fixed, firstSlot], `${label}: the v form's arguments`);
                const answer = /** @type {(args: number[]) => number} */ (traps.get(stopped))(frame);
                machine.writeReg32('eax', answer >>> 0);
                machine.writeReg32('esp', esp + 4);
                machine.writeReg32('eip', readU32(esp));
                runToHalt(machine, 100000);
                handed++;
            }
            else
            {
                rendered++;
            }
            assert.equal(machine.readReg32('eip'), PROGRAM + code.length, `${label}: returned`);
            assert.equal(machine.readReg32('esp'), STACK,
                `${label}: the stack as the caller left it`);
            for (const [reg, value] of Object.entries(kept))
            {
                assert.equal(machine.readReg32(reg) >>> 0, value, `${label}: ${reg} kept`);
            }
            const answer = machine.readReg32('eax') | 0;
            const written = read(BUFFER, BUFFER_BYTES);

            // The handler, from the same call.
            machine.writePhysical(BUFFER, garbage);
            assert.equal(answer, fns[name].handler(args) | 0, `${label}: the answer`);
            assert.deepEqual(written, read(BUFFER, BUFFER_BYTES), `${label}: the text`);
        }
    }
    assert.ok(handed >= 200 && rendered >= 200,
        `both ways taken often: ${rendered} in the guest, ${handed} handed to the host`);
});
