/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of forming callees into their callers: seeded programs of functions
 * calling one another, directly and through a register -- leaves and not,
 * `ret imm` with an argument pushed, a return moved past two bytes of its
 * caller, a thunk jumping on through a register, a store into another
 * function's code, a branch to a cold path far away that calls on -- run interpreted
 * alone, then translated with nothing formed in, with leaves alone, with one, two and
 * three levels of callees formed in (`formDepth`), with the cold paths followed into
 * (`coldReach` 0), and with the callees of calls through a register sampled and
 * formed in behind a compare (`callTargets`). Everything a program observes
 * must come out the same: the registers, the flags, its data and its code.
 *
 * And a loop whose one call through a table goes to a different small function
 * each turn, nine to forty of them (`spread`): those formed in behind their
 * compares, the rest still wasm calls, against the interpreter.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const MAIN = 0x1000;
const FUNCTIONS = 0x2000;
const SPAN = 0x100;
const DATA = 0x80000;
/** Each function's cold path, `SPAN` apart, far past every reach (`coldReach`). */
const COLD = 0x40000;
const STACK = 0xf0000;
const PROGRAMS = 120;

/** A small seeded generator (mulberry32). @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** @param {number} value */
const le32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];

/**
 * A program: `count` functions at `FUNCTIONS`, each `SPAN` bytes apart, each
 * opening with `add eax, imm8` (the byte another function may rewrite), and a
 * main loop at `MAIN` calling the first one `turns` times.
 *
 * @param {number} seed
 * @returns {{ code: [number, number[]][], turns: number }}
 */
function program(seed){
    const next = random(seed);
    const pick = (/** @type {number} */ n)=>Math.floor(next() * n);
    const count = 3 + pick(6);
    // How each returns: 0 `ret`, 1 `ret 4` (its callers push an argument), 2
    // past two bytes after its call (its callers leave `inc eax; inc eax` there).
    const returns = Array.from({ length: count }, ()=>[0, 0, 1, 2][pick(4)]);
    /** @type {[number, number[]][]} */
    const code = [];
    /** Each function's cold paths, by its index. @type {Map<number, number[]>} */
    const colds = new Map();
    for (let index = 0; index < count; index++)
    {
        const at = FUNCTIONS + index * SPAN;
        const body = [0x83, 0xc0, pick(256)];
        const ops = 2 + pick(7);
        for (let op = 0; op < ops; op++)
        {
            const callee = index + 1 + pick(count - index - 1);
            const kind = pick(13);
            if (kind < 3 && callee < count)
            {
                if (returns[callee] === 1)
                {
                    body.push(0x50);
                }
                if (pick(2) === 0)
                {
                    const after = at + body.length + 5;
                    body.push(0xe8, ...le32(FUNCTIONS + callee * SPAN - after));
                }
                else
                {
                    // mov edx, f; call edx -- a virtual call's shape; and when a later
                    // function returns as f does, test cl, 1; jz +5; mov edx, g before
                    // the call: the loop's count picks one of two callees, so a site
                    // predicted to one also misses.
                    body.push(0xba, ...le32(FUNCTIONS + callee * SPAN));
                    const other = returns.findIndex((how, which)=>which > callee
                        && how === returns[callee]);
                    if (other > 0)
                    {
                        body.push(0xf6, 0xc1, 0x01, 0x74, 0x05,
                            0xba, ...le32(FUNCTIONS + other * SPAN));
                    }
                    body.push(0xff, 0xd2);
                }
                if (returns[callee] === 2)
                {
                    body.push(0x40, 0x40);
                }
                continue;
            }
            switch (kind)
            {
                case 3: body.push(0x83, 0xc3, pick(256)); break;
                case 4: body.push(0x31, 0xd8); break;
                case 5: body.push(0x0f, 0xaf, 0xc3); break;
                case 6: body.push(0x46, 0x8d, 0x3c, 0x18); break;
                case 7: body.push(0xa3, ...le32(DATA + 4 * pick(16))); break;
                case 8: body.push(0x03, 0x1d, ...le32(DATA + 4 * pick(16))); break;
                case 9: body.push(0x50, 0x5a); break;
                case 10: body.push(0x83, 0xf8, pick(256), 0x7c, 0x01, 0x43); break;
                case 11:
                {
                    // test cl, 7; jz COLD -- a branch to the function's cold path, far
                    // away, taken one turn of the loop's eight (ecx is its count); the
                    // path adds to ebx, may call a later function that returns plainly,
                    // and jumps back after the branch.
                    const path = COLD + index * SPAN + (colds.get(index)?.length ?? 0);
                    body.push(0xf6, 0xc1, 0x07, 0x0f, 0x84);
                    const back = at + body.length + 4;
                    body.push(...le32(path - back));
                    const out = [0x83, 0xc3, pick(256)];
                    const plain = returns.findIndex((how, which)=>which > index && how === 0);
                    if (plain > 0 && pick(2) === 0)
                    {
                        out.push(0xe8, ...le32(FUNCTIONS + plain * SPAN - (path + out.length + 5)));
                    }
                    out.push(0xe9, ...le32(back - (path + out.length + 5)));
                    colds.set(index, [...colds.get(index) ?? [], ...out]);
                    break;
                }
                default:
                    // mov byte [f + 2], imm8: another function's first add, rewritten.
                    body.push(0xc6, 0x05, ...le32(FUNCTIONS + pick(count) * SPAN + 2), pick(4));
            }
        }
        const last = count - 1;
        if (returns[index] === 0 && index < last && returns[last] === 0 && pick(4) === 0)
        {
            // mov edx, f; jmp edx -- a thunk forwarding to the last function,
            // whose `ret` returns past this one's call.
            body.push(0xba, ...le32(FUNCTIONS + last * SPAN), 0xff, 0xe2);
        }
        else
        {
            body.push(...[[0xc3], [0xc2, 4, 0], [0x83, 0x04, 0x24, 0x02, 0xc3]][returns[index]]);
        }
        assert.ok(body.length <= SPAN, 'a function fits its span');
        code.push([at, body]);
        const cold = colds.get(index);
        if (cold !== undefined)
        {
            assert.ok(cold.length <= SPAN, 'its cold paths fit theirs');
            code.push([COLD + index * SPAN, cold]);
        }
    }
    // mov ecx, turns; L: push ecx; [push eax;] call f0; [inc eax; inc eax;] pop ecx;
    // dec ecx; jnz L; hlt
    const turns = 20 + pick(80);
    const loop = [0x51];
    if (returns[0] === 1)
    {
        loop.push(0x50);
    }
    const callAt = MAIN + 5 + loop.length;
    loop.push(0xe8, ...le32(FUNCTIONS - (callAt + 5)));
    if (returns[0] === 2)
    {
        loop.push(0x40, 0x40);
    }
    loop.push(0x59, 0x49);
    const main = [0xb9, ...le32(turns), ...loop];
    main.push(0x75, (-(loop.length + 2)) & 0xff, 0xf4);
    code.push([MAIN, main]);
    return { code, turns };
}

/**
 * What a program observes, run on a machine of `config`.
 *
 * @param {[number, number[]][]} code @param {Record<string, unknown>} config
 * @param {(diagnostics: any) => void} [told]  the machine's diagnostics once it has run
 */
async function run(code, config, told){
    const m = createMachine({ ramSize: 1 << 20, config: { hashSlots: 1 << 12, ...config } });
    try
    {
        for (const [at, bytes] of code)
        {
            m.load(at, bytes);
        }
        m.setReg('esp', STACK);
        m.setReg('eip', MAIN);
        const stop = await m.run({ maxInstructions: 5_000_000 });
        told?.(m.diagnostics());
        return {
            stop: stop.reason,
            registers: ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip']
                .map(name=>m.reg(name)),
            flags: m.reg('eflags') & 0x8d5,
            data: [...m.read(DATA, 64)],
            code: code.map(([at, bytes])=>[...m.read(at, bytes.length)]),
            translated: stop.translated,
            reforms: m.diagnostics().reforms ?? 0,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('callees formed in, to any depth, run as the interpreter runs them', async()=>{
    const paths = {
        'nothing formed in': { leafCalls: false, hotThreshold: 2 },
        'leaves alone': { formDepth: 0, hotThreshold: 2 },
        'one level': { formDepth: 1, hotThreshold: 2 },
        'two levels': { formDepth: 2, hotThreshold: 2 },
        'three levels': { formDepth: 3, hotThreshold: 2 },
        // Every callee's branch followed, its cold paths formed in with it.
        'cold paths followed': { formDepth: 1, hotThreshold: 2, coldReach: 0 },
        // Calls through a register sampled and their callees formed in behind a
        // compare (`callTargets`), a site due at its first sample.
        'predicted calls': { formDepth: 1, hotThreshold: 2, callTargets: true, predictAfter: 1 },
        // And with regions their own functions fill, the callees in the room past the caps.
        'predicted, full': { formDepth: 1, hotThreshold: 2, callTargets: true, predictAfter: 1,
            maxRegionBlocks: 4 },
    };
    let translated = 0;
    let reforms = 0;
    for (let seed = 1; seed <= PROGRAMS; seed++)
    {
        const { code } = program(seed);
        const { translated: none, reforms: reformedNone, ...expected } = await run(code,
            { hotThreshold: 1e9 });
        assert.equal(none + reformedNone, 0, 'the reference ran interpreted');
        assert.equal(expected.stop, 'halt', `seed ${seed}: the program ends`);
        for (const [name, config] of Object.entries(paths))
        {
            const { translated: ran, reforms: formed, ...got } = await run(code, config);
            assert.deepEqual(got, expected, `seed ${seed}, ${name}`);
            translated += ran;
            reforms += formed;
        }
    }
    assert.ok(translated > 0, 'the translated paths ran translated code');
    assert.ok(reforms > 0, 'the predicted path formed regions again with their callees');
});

const TABLE = DATA + 0x400;
const SPREADS = 24;

/**
 * A loop calling one of `count` small functions through a table of 64 slots, the
 * slot the turn's count times an odd number, so the callees take turns evenly:
 *
 *     mov ecx, turns; L: mov ebx, ecx; imul ebx, ebx, odd; and ebx, 63; push ecx;
 *     call [TABLE + ebx*4]; pop ecx; dec ecx; jnz L; hlt
 *
 * Each callee a few of: `add eax, imm8`, `xor [DATA + 4j], eax`, `add [DATA + 4j], edx`,
 * `adc edx, imm8` (the carry the caller or the callee before left), `rol eax, n`,
 * `test al, 1; jz +1; inc edx`; then `ret`.
 *
 * @param {number} seed
 * @returns {{ code: [number, number[]][], count: number }}
 */
function spread(seed){
    const next = random(seed);
    const pick = (/** @type {number} */ n)=>Math.floor(next() * n);
    const count = 9 + pick(32);
    /** @type {[number, number[]][]} */
    const code = [];
    const callee = (/** @type {number} */ k)=>FUNCTIONS + k * 0x40;
    for (let k = 0; k < count; k++)
    {
        const body = [];
        for (let op = 2 + pick(4); op > 0; op--)
        {
            const slot = le32(DATA + 4 * pick(16));
            body.push(...[
                [0x83, 0xc0, pick(256)],
                [0x31, 0x05, ...slot],
                [0x01, 0x15, ...slot],
                [0x83, 0xd2, pick(256)],
                [0xc1, 0xc0, 1 + pick(7)],
                [0xa8, 0x01, 0x74, 0x01, 0x42],
            ][pick(6)]);
        }
        code.push([callee(k), [...body, 0xc3]]);
    }
    code.push([TABLE, Array.from({ length: 64 }, (_, slot)=>le32(callee(slot % count))).flat()]);
    const turns = 40000 + pick(20000);
    code.push([MAIN, [0xb9, ...le32(turns), 0x89, 0xcb, 0x6b, 0xdb, 1 + 2 * pick(32),
        0x83, 0xe3, 0x3f, 0x51, 0xff, 0x14, 0x9d, ...le32(TABLE), 0x59, 0x49, 0x75, -20 & 0xff,
        0xf4]]);
    return { code, count };
}

test('a call spread over many small callees has those that pay formed in, and runs as the'
    + ' interpreter runs it', async()=>{
    const paths = {
        // Due once there are four samples for each callee seen.
        predicted: { hotThreshold: 2, callTargets: true, predictAfter: 4 },
        'predicted, returns through the hash': { hotThreshold: 2, callTargets: true,
            predictAfter: 4, callReturn: false },
    };
    let most = 0;
    for (let seed = 1; seed <= SPREADS; seed++)
    {
        const { code, count } = spread(seed);
        const { translated: ran, reforms: formed, ...expected } = await run(code,
            { hotThreshold: 1e9 });
        assert.equal(ran + formed, 0, 'the reference ran interpreted');
        assert.equal(expected.stop, 'halt', `seed ${seed}: the program ends`);
        for (const [name, config] of Object.entries(paths))
        {
            // The most callees one call had formed in.
            let callees = 0;
            const { translated, reforms, ...got } = await run(code, config, diagnostics=>{
                callees = diagnostics.prediction?.callees ?? 0;
            });
            assert.deepEqual(got, expected, `seed ${seed}, ${name}: ${count} callees`);
            assert.ok(translated > 0 && reforms > 0, `seed ${seed}, ${name}: formed again`);
            assert.ok(callees <= 32, 'no more formed in than a call may have');
            most = Math.max(most, callees);
        }
    }
    assert.ok(most > 16, `a call had more than sixteen callees formed in (${most})`);
});
