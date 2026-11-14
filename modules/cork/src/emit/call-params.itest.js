/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the region function's two parameter conventions (`carriedOn` in
 * width.js): on an x86-64 host a region takes three registers in its
 * parameters and ebx (long mode's r9) goes through the state block, on any
 * other host it takes four. Both are emitted on this machine -- the second for
 * a host whose default NaN is positive, as an arm64 one's -- and each is held
 * to the interpreter: seeded programs of functions that read and write every
 * register across calls (the uncarried ones most), call one another directly,
 * through a register and as `stdcall` with arguments popped, save and restore
 * ebx, recurse past the module's call depth, return through another `ret`,
 * hand floats back on the x87 stack and leave for the host at a trap port
 * inside a callee, run with a budget that spends inside the callees and with
 * one that does not. Everything a program can observe is compared: registers,
 * flags, memory, the stack, the x87's top and empty mask, the traps and the
 * instructions retired. Long mode runs its `CALLS` programs under both.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';
import { features as probeFeatures } from '../wasm/features.js';
import { carriedOn } from './width.js';
import { CALLS, CORPUS, compare } from '../testing/long-machine.js';
import { createRuntimeRunner64 } from '../testing/runtime-runner64.js';

const CODE = 0x401000;
const FUNCTIONS = 0x402000;
const LANDING = 0x40f000;
const DATA = 0x500000;
const COUNTER = DATA + 0x400;
const LOOPS = DATA + 0x404;
const STACK = 0xf00000;
const TRAP_PORT = 0x77;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
/** The registers a function may write: all but esp. */
const WRITABLE = [0, 1, 2, 3, 5, 6, 7];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program: functions over every register calling one another, a recursive
 * one, one that returns through a landing `ret`, and a loop in main calling
 * them, the registers and flags stored after each call.
 *
 * @param {number} seed
 * @returns {{ at: number, code: number[] }[]}
 */
function generate(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    const reg = ()=>WRITABLE[pick(WRITABLE.length)];
    let slot = 0;
    const at = ()=>DATA + (slot++ % 192) * 4;
    // add, sub, xor, and, or, adc, sbb, cmp: r/m32, r32 (logical ones leave AF undefined,
    // which the flags stored mask out)
    const ALU = [0x01, 0x29, 0x31, 0x21, 0x09, 0x11, 0x19, 0x39];
    const work = ()=>{
        switch (pick(9))
        {
            case 0: return [0xb8 + reg(), ...le(pick(1 << 30) * 3)]; // mov r, imm32
            case 1: return [0x40 + reg()]; // inc r
            case 2: return [0x48 + reg()]; // dec r
            case 3: return [0x89, reg() << 3 | 5, ...le(at())]; // mov [m32], r
            case 4: return [0x8b, reg() << 3 | 5, ...le(DATA + pick(192) * 4)]; // mov r, [m32]
            case 5: return [0x9c, 0x58 + reg()]; // pushfd; pop r
            case 6: // fild dword [m]; fld1; faddp; fstp dword [m]
                return [0xdb, 0x05, ...le(DATA + pick(192) * 4), 0xd9, 0xe8, 0xde, 0xc1,
                    0xd9, 0x1d, ...le(at())];
            default: return [ALU[pick(ALU.length)], 0xc0 | reg() << 3 | reg()];
        }
    };

    /**
     * @type {{ at: number, code: number[], calls: { at: number, to: number }[],
     *     args: number }[]}
     */
    const fns = [];
    let next = FUNCTIONS;
    /**
     * A call from `code` to function `to`: its arguments pushed, direct or through a register.
     *
     * @param {number[]} code @param {{ at: number, to: number }[]} calls @param {number} to
     */
    const call = (code, calls, to)=>{
        for (let k = fns[to].args; k > 0; k--)
        {
            code.push(0x6a, pick(128)); // push imm8
        }
        if (pick(3) === 0)
        {
            // mov r, f; call r -- the function's address patched in after placing
            const r = reg();
            code.push(0xb8 + r, 0, 0, 0, 0, 0xff, 0xd0 + r);
            calls.push({ at: code.length - 6, to: -1 - to });
        }
        else
        {
            code.push(0xe8, 0, 0, 0, 0);
            calls.push({ at: code.length - 4, to });
        }
    };
    for (let k = 4 + pick(5); k > 0; k--)
    {
        /** @type {number[]} */
        const code = [];
        /** @type {{ at: number, to: number }[]} */
        const calls = [];
        const saves = pick(3) === 1;
        if (saves)
        {
            code.push(0x53); // push ebx
        }
        // A function that does nothing now and then: its `ret` done in the transfer.
        for (let part = pick(5) === 0 ? 0 : 1 + pick(6); part > 0; part--)
        {
            code.push(...work());
            if (fns.length > 0 && pick(3) === 0)
            {
                call(code, calls, pick(fns.length));
            }
            if (pick(12) === 0)
            {
                code.push(0xe7, TRAP_PORT); // out TRAP_PORT, eax
            }
        }
        if (pick(4) === 0)
        {
            code.push(0xd9, 0xe8); // fld1: a float handed back on the x87 stack
        }
        if (saves)
        {
            code.push(0x5b); // pop ebx
        }
        const args = pick(3) === 0 ? 1 + pick(3) : 0;
        code.push(...args > 0 ? [0xc2, args * 4, 0] : [0xc3]);
        fns.push({ at: next, code, calls, args });
        next += (code.length + 15) & ~15;
    }
    // R: dec dword [COUNTER]; jz 1f; call R; 1: inc esi; ret -- deeper than the call depth
    const recursive = fns.length;
    fns.push({ at: next, args: 0, calls: [{ at: 9, to: recursive }],
        code: [0xff, 0x0d, ...le(COUNTER), 0x74, 0x05, 0xe8, 0, 0, 0, 0, 0x46, 0xc3] });
    next += 16;
    // E: push LANDING; ret -- LANDING: add edi, 3; ret, back to E's caller
    const elsewhere = fns.length;
    fns.push({ at: next, args: 0, calls: [], code: [0x68, ...le(LANDING), 0xc3] });

    // Every register given a value; the loop count in memory; L: the calls, each
    // followed by what it left stored; dec dword [LOOPS]; jnz L; the registers
    // stored; hlt
    const main = [...[0xb8, 0xbb, 0xb9, 0xba, 0xbd, 0xbe, 0xbf].flatMap(op=>[op,
        ...le(pick(1 << 31))]), 0xc7, 0x05, ...le(LOOPS), ...le(6 + pick(20))];
    const start = main.length;
    /** @type {{ at: number, to: number }[]} */
    const calls = [];
    for (let site = 3 + pick(5); site > 0; site--)
    {
        const which = pick(10);
        if (which === 0)
        {
            // mov dword [COUNTER], n; call R
            main.push(0xc7, 0x05, ...le(COUNTER), ...le(1 + pick(400)));
            main.push(0xe8, 0, 0, 0, 0);
            calls.push({ at: main.length - 4, to: recursive });
        }
        else if (which === 1)
        {
            main.push(0xe8, 0, 0, 0, 0);
            calls.push({ at: main.length - 4, to: elsewhere });
        }
        else
        {
            call(main, calls, pick(recursive));
        }
        // pushfd; pop eax; and eax, ~AF; mov [m], eax; mov [m], ebx; mov [m], ebp
        main.push(0x9c, 0x58, 0x83, 0xe0, 0xef, 0xa3, ...le(at()), 0x89, 0x1d, ...le(at()),
            0x89, 0x2d, ...le(at()));
        if (pick(3) === 0)
        {
            main.push(0xdd, 0xd8); // fstp st0: what a callee left on the x87 stack, if any
        }
        main.push(...work());
    }
    main.push(0xff, 0x0d, ...le(LOOPS), 0x0f, 0x85, ...le(start - (main.length + 6 + 6)));
    main.push(0x89, 0x1d, ...le(DATA + 0x300), 0x89, 0x35, ...le(DATA + 0x304), 0x89, 0x3d,
        ...le(DATA + 0x308), 0x89, 0x2d, ...le(DATA + 0x30c), 0xf4);
    const placed = (/** @type {number} */ to)=>fns[to < 0 ? -1 - to : to].at;
    /** @param {{ at: number, code: number[], calls: { at: number, to: number }[] }} fn */
    const place = fn=>{
        const code = [...fn.code];
        for (const { at: where, to } of fn.calls)
        {
            code.splice(where, 4, ...le(to < 0 ? placed(to) : placed(to) - (fn.at + where + 4)));
        }
        return { at: fn.at, code };
    };
    return [place({ at: CODE, code: main, calls }), ...fns.map(place),
        { at: LANDING, code: [0x83, 0xc7, 0x03, 0xc3] }];
}

/**
 * Runs a program to its `hlt`, going on past every trap, and answers what it
 * left.
 *
 * @param {{ at: number, code: number[] }[]} pieces @param {Record<string, unknown>} config
 * @param {import('../wasm/features.js').Features} [features]
 */
async function runProgram(pieces, config, features){
    const m = createMachine({ ramSize: 16 << 20, trapPort: TRAP_PORT, features,
        config: { hotThreshold: 2, ...config } });
    try
    {
        for (const { at, code } of pieces)
        {
            m.load(at, code);
        }
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        /** @type {number[]} */
        const traps = [];
        let retired = 0;
        let translated = 0;
        for (;;)
        {
            const stop = await m.run({ maxInstructions: 5_000_000 - retired });
            retired += stop.retired;
            translated += stop.translated;
            if (stop.reason !== 'trap')
            {
                assert.equal(stop.reason, 'halt');
                break;
            }
            traps.push(/** @type {number} */ (stop.value));
        }
        const view = new DataView(m.memory.buffer);
        const { mechanisms } = /** @type {{ mechanisms?: Record<string, number> }} */ (
            m.diagnostics());
        return {
            mechanisms,
            observed: {
                retired, traps,
                data: [...m.read(DATA, 0x410)],
                stack: [...m.read(STACK - 0x2000, 0x2000)],
                // AF is left undefined by the logical operations.
                registers: Object.fromEntries(REGISTERS.map(name=>[name,
                    name === 'eflags' ? m.reg(name) & ~0x10 : m.reg(name)])),
                x87: [view.getUint8(m.layout.x87Top), view.getUint8(m.layout.x87Empty)],
            },
            translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

/** This host's features, and those of a host that passes six parameters in registers. */
const HOST = probeFeatures();
const SIX = { ...HOST, defaultNaNNegative: false };

test('the two parameter conventions are the ones the gate runs', ()=>{
    assert.equal(carriedOn(SIX), 4, 'a host with a positive default NaN takes four');
    assert.equal(carriedOn({ ...HOST, defaultNaNNegative: true, armHost: true }), 4,
        'so does an arm64 host emitting with x86\'s NaN');
    assert.equal(carriedOn({ ...HOST, defaultNaNNegative: true }), 3, 'an x86-64 host three');
    if (!HOST.defaultNaNNegative)
    {
        // An arm64 machine runs its own convention as both arms: said, not passed over.
        console.log('call-params: this host takes four; the three-register arm is that one too');
    }
});

test('the seeded calls take every way a call between regions goes', async()=>{
    /** @type {Record<string, number>} */
    const seen = {};
    for (let seed = 1; seed < 41; seed++)
    {
        const { mechanisms = {} } = await runProgram(generate(seed), { blockProfile: true,
            callDepth: 3 + seed % 2 * 253, leafCalls: seed % 3 !== 0 });
        for (const [name, count] of Object.entries(mechanisms))
        {
            seen[name] = (seen[name] ?? 0) + count;
        }
    }
    for (const name of ['CALL_REL', 'CALL_INDIRECT', 'CALL_LINKED', 'CALL_ELSEWHERE', 'RET_TO_CALL',
        'RET_LEFT', 'EMPTY_RETURN', 'TRANSFER'])
    {
        assert.ok((seen[name] ?? 0) > 0, `${name} never ran: ${JSON.stringify(seen)}`);
    }
});

for (const [first, budget] of /** @type {[number, number][]} */ ([
    [1, 10_000], [101, 37], [201, 1_000]]))
{
    test(`seeded calls ${first}..${first + 39}: three registers in parameters and four run as `
        + `interpreted, budget ${budget}`, async()=>{
        let translated = 0;
        for (let seed = first; seed < first + 40; seed++)
        {
            const pieces = generate(seed);
            const reference = await runProgram(pieces, { translate: false });
            for (const [name, features] of /** @type {const} */ ([['three', HOST], ['four', SIX]]))
            {
                for (const callDepth of [256, 3])
                {
                    const run = await runProgram(pieces, { yieldChunk: budget, callDepth,
                        leafCalls: seed % 3 !== 0 }, features);
                    assert.deepEqual(run.observed, reference.observed,
                        `seed ${seed}, ${name} registers in parameters, call depth ${callDepth}`);
                    translated += run.translated;
                }
            }
        }
        assert.ok(translated > 0, 'the programs ran translated');
    });
}

test('long mode\'s calls run as interpreted with three registers in parameters and with four',
    ()=>{
        const cases = Object.entries(CALLS).flatMap(([name, code])=>CORPUS.cases.slice(0, 4)
            .map((/** @type {any} */ one, /** @type {number} */ i)=>{
                const regs = [...one.regs];
                regs[10] = i % 2 === 0 ? '0' : '1';
                return { ...one, text: `${name} ${i}`, code, regs };
            }));
        for (const defaultNaNNegative of [true, false])
        {
            for (const budget of [7, 100000])
            {
                const { failures, exits, stats } = compare(cases, { budget,
                    makeRunner: (memory, layout, tier)=>createRuntimeRunner64({ memory, layout,
                        tier, defaultNaNNegative }) });
                assert.deepEqual(failures.slice(0, 20), [],
                    `${carriedOn({ defaultNaNNegative })} registers, budget ${budget}`);
                assert.equal(exits, cases.length);
                assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
            }
        }
    });
