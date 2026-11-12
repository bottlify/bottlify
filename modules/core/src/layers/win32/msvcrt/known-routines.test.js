/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The engine's routines a translator forms as their C runtime operations
 * (`known-routines.js`) against their own code: each run on cork's test
 * machine on seeded arguments, through its bytes and as the operation, and
 * everything a caller sees compared -- the answer, the memory, the registers
 * a cdecl callee keeps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../../../../../cork/src/testing/machine.js';
import { routineHelper } from '../../../../../cork/src/helpers.js';
import { CORPUS, load, machine, run as runLong }
    from '../../../../../cork/src/testing/long-machine.js';
import { pageFlagsAt } from '../../../../../cork/src/runtime/layout.js';
import { KNOWN_ROUTINES } from './known-routines.js';

const PROGRAM = 0x8000;
const ROUTINE = 0x9000;
const OUT = 0xa000;
const DATA = 0x20000;
const DATA_BYTES = 0x400;
const STACK = 0x80000;
const RAM = 1 << 20;

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/** A seeded generator (mulberry32). @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

test('the engine\'s routines a translator knows answer as their own code on seeded arguments',
    ()=>{
        const i386 = KNOWN_ROUTINES.filter(routine=>routine.bits === undefined);
        assert.ok(i386.length >= 6, 'memmove, memset, strlen, strcmp, memcmp, strchr');
        for (const routine of i386)
        {
            const next = random(0x5eed + routine.code.length);
            const int = (/** @type {number} */ n)=>Math.floor(next() * n);
            const helpers = [routineHelper(/** @type {any} */ (routine))];
            let formed = 0;
            for (let c = 0; c < 300; c++)
            {
                // Bytes of a small alphabet, zeros among them: strings end, and compare equal
                // for a while.
                const data = Array.from({ length: DATA_BYTES },
                    ()=>(int(5) === 0 ? 0 : 0x61 + int(3)));
                const at = ()=>DATA + int(DATA_BYTES - 0x140);
                const size = ()=>(int(4) === 0 ? int(8) : int(0x130));
                const value = ()=>[0, 0x61, 0x62, 0x161, 0xffffff62, int(256)][int(6)];
                const args = {
                    memmove: ()=>[at(), at(), size()], memset: ()=>[at(), value(), size()],
                    strlen: ()=>[at()], strcmp: ()=>[at(), at()], memcmp: ()=>[at(), at(), size()],
                    strchr: ()=>[at(), value()],
                }[/** @type {'strlen'} */ (routine.does)]();
                /** @type {number[]} */
                const program = [];
                for (const arg of [...args].reverse())
                {
                    program.push(0x68, ...u32(arg));
                }
                program.push(0xe8, ...u32((ROUTINE - (PROGRAM + program.length + 5)) >>> 0));
                program.push(0x83, 0xc4, 4 * args.length, 0xa3, ...u32(OUT), 0xf4);
                /** @param {false | object[]} given */
                const run = given=>{
                    const m = createTestMachine({ ramSize: RAM });
                    m.write(ROUTINE, routine.code);
                    m.write(PROGRAM, program);
                    m.write(DATA, data);
                    ['ebx', 'ebp', 'esi', 'edi'].forEach((r, i)=>m.setReg(r, 0x11111111 * (i + 1)));
                    m.setReg('esp', STACK);
                    let exit = m.runProgram(PROGRAM, { helpers: /** @type {any} */ (given) });
                    const { retired } = exit;
                    const left = exit.kind === -2;
                    if (left)
                    {
                        exit = m.runProgram(exit.eip, { helpers: false });
                    }
                    return { left, retired, seen: { kind: exit.kind, out: [...m.read(OUT, 4)],
                        data: [...m.read(DATA, DATA_BYTES)],
                        regs: ['ebx', 'ebp', 'esi', 'edi', 'esp'].map(r=>m.reg(r)) } };
                };
                const body = run(false);
                const made = run(helpers);
                assert.deepEqual(made.seen, body.seen, `${routine.name}(${args.join(', ')})`);
                // Formed, the call retires as one instruction: fewer than the body's.
                formed += !made.left && made.retired < body.retired ? 1 : 0;
            }
            assert.ok(formed > 200, `${routine.name}: ${formed} of 300 formed`);
        }
    });

test('the x86-64 builds of the routines a translator knows answer as their own code in long mode',
    ()=>{
        const long = KNOWN_ROUTINES.filter(routine=>routine.bits === 64);
        assert.ok(long.length >= 6, 'memmove, memset, strlen, strcmp, memcmp, strchr');
        const area = CORPUS.dataAt + 0x10000;
        const stack = area + 0x800;
        const spans = area + 0x1000;
        const bytes = 0x1000;
        const offset = 0x80;
        /** @param {number} value */
        const quad = value=>[...new Uint8Array(new BigUint64Array([BigInt(value)]).buffer)];
        for (const routine of long)
        {
            const next = random(0x6eed + routine.code.length);
            const int = (/** @type {number} */ n)=>Math.floor(next() * n);
            const helpers = [routineHelper(routine)];
            let formed = 0;
            for (let c = 0; c < 120; c++)
            {
                const data = Array.from({ length: bytes }, ()=>(int(5) === 0 ? 0 : 0x61 + int(3)));
                const at = ()=>spans + int(bytes - 0x140);
                const size = ()=>(int(4) === 0 ? int(8) : int(0x130));
                const value = ()=>[0, 0x61, 0x62, 0x161, 0xffffff62, int(256)][int(6)];
                const args = {
                    memmove: ()=>[at(), at(), size()], memset: ()=>[at(), value(), size()],
                    strlen: ()=>[at()], strcmp: ()=>[at(), at()], memcmp: ()=>[at(), at(), size()],
                    strchr: ()=>[at(), value()],
                }[/** @type {'strlen'} */ (routine.does)]();
                // rcx, rdx, r8; the call; then past the routine to the exit after the code.
                const program = [0x48, 0xb9, ...quad(args[0]), 0x48, 0xba, ...quad(args[1] ?? 0),
                    0x49, 0xb8, ...quad(args[2] ?? 0)];
                program.push(0xe8, ...quad(offset - (program.length + 5)).slice(0, 4));
                program.push(0xe9,
                    ...quad(offset + routine.code.length - (program.length + 5)).slice(0, 4));
                while (program.length < offset)
                {
                    program.push(0x90);
                }
                const code = Buffer.from([...program, ...routine.code]).toString('hex');
                /** @param {false | object[]} given */
                const once = given=>{
                    const m = machine({ config: { helpers: given } });
                    const ram = new Uint8Array((m.ram ?? m.memory).buffer);
                    // The pages past the corpus's data, closed by default, opened.
                    new Uint8Array(m.memory.buffer, pageFlagsAt(m.layout), 2 ** 20)
                        .fill(0, area / 4096, (spans + bytes) / 4096 + 1);
                    ram.set(data, spans);
                    const regs = Array.from({ length: 16 },
                        (unused, i)=>(BigInt(i) * 0x1111111111111n).toString(16));
                    regs[4] = stack.toString(16);
                    load(m, { code, regs, flags: 0, seed: 1, fresh: true });
                    const seen = runLong(m, true, 100000);
                    // An int's answer is eax (the convention's): the routines leave -1
                    // sign-extended through rax, the operations as Microsoft's do, the high
                    // half zero.
                    const answer = ['strcmp', 'memcmp'].includes(routine.does)
                        ? (BigInt(`0x${seen.regs[0]}`) & 0xffffffffn).toString(16) : seen.regs[0];
                    return { retired: Number(seen.retired), seen: { fault: seen.fault,
                        // rax, and the registers a callee keeps.
                        kept: [answer, ...[3, 4, 5, 6, 7, 12, 13, 14, 15].map(i=>seen.regs[i])],
                        bytes: [...ram.subarray(spans, spans + bytes)] } };
                };
                const body = once(false);
                const made = once(helpers);
                assert.deepEqual(made.seen, body.seen, `${routine.name}(${args.join(', ')})`);
                formed += made.retired < body.retired ? 1 : 0;
            }
            assert.ok(formed > 80, `${routine.name}: ${formed} of 120 formed`);
        }
    });
