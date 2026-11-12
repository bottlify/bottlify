/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of what the runtimes sharing a store share (`run-shared.js`): a
 * process started again takes the regions an earlier one formed and the
 * modules it compiled, where one that shares nothing forms and compiles them
 * from the store's records. Seeded programs of functions calling one another,
 * directly and through a register, one storing into another's code, are run
 * as a first process and then as a second over the same store, the second
 * with some of its bytes other than the first's -- every path down both: the
 * second process must observe the same registers, flags, data and code whether
 * it shares or not, and the same as the interpreter alone.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';
import { memoryTranslationStore } from './cache.js';

const MAIN = 0x1000;
const FUNCTIONS = 0x2000;
const SPAN = 0x80;
const DATA = 0x80000;
const STACK = 0xf0000;
const PROGRAMS = 48;

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
 * A program: functions at `FUNCTIONS`, each opening with `add eax, imm8`,
 * calling later ones directly or through edx, one program in four storing a
 * byte into another's first add, and a main loop calling the first. Its second process
 * has one of the functions' first adds other, two programs in three.
 *
 * @param {number} seed
 * @returns {{ first: [number, number[]][], second: [number, number[]][] }}
 */
function program(seed){
    const next = random(seed);
    const pick = (/** @type {number} */ n)=>Math.floor(next() * n);
    const count = 3 + pick(6);
    // One program in four stores into its code as it runs.
    const writes = pick(4) === 0;
    /** @type {[number, number[]][]} */
    const code = [];
    for (let index = 0; index < count; index++)
    {
        const at = FUNCTIONS + index * SPAN;
        const body = [0x83, 0xc0, pick(256)];
        for (let op = 2 + pick(6); op > 0; op--)
        {
            const callee = index + 1 + pick(count - index);
            const kind = pick(writes ? 10 : 9);
            if (kind < 3 && callee < count)
            {
                if (pick(2) === 0)
                {
                    body.push(0xe8, ...le32(FUNCTIONS + callee * SPAN - (at + body.length + 5)));
                }
                else
                {
                    // mov edx, f; call edx
                    body.push(0xba, ...le32(FUNCTIONS + callee * SPAN), 0xff, 0xd2);
                }
                continue;
            }
            switch (kind)
            {
                case 3: body.push(0x83, 0xc3, pick(256)); break;
                case 4: body.push(0x31, 0xd8); break;
                case 5: body.push(0x0f, 0xaf, 0xc3); break;
                case 6: body.push(0xa3, ...le32(DATA + 4 * pick(16))); break;
                case 7: body.push(0x03, 0x1d, ...le32(DATA + 4 * pick(16))); break;
                case 8: body.push(0x83, 0xf8, pick(256), 0x7c, 0x01, 0x43); break;
                default:
                    // mov byte [f + 2], imm8: another function's first add, rewritten.
                    body.push(0xc6, 0x05, ...le32(FUNCTIONS + pick(count) * SPAN + 2), pick(4));
            }
        }
        body.push(0xc3);
        assert.ok(body.length <= SPAN, 'a function fits its span');
        code.push([at, body]);
    }
    // mov ecx, turns; L: push ecx; call f0; pop ecx; dec ecx; jnz L; hlt
    const turns = 200 + pick(400);
    const main = [0xb9, ...le32(turns), 0x51, 0xe8, ...le32(FUNCTIONS - (MAIN + 11)),
        0x59, 0x49, 0x75, 0xf6, 0xf4];
    code.push([MAIN, main]);
    // The second process: the same, or with one function's first add other.
    const changed = pick(3) === 0 ? -1 : pick(count);
    const second = code.map(([at, bytes], index)=>/** @type {[number, number[]]} */ ([at,
        index === changed ? [bytes[0], bytes[1], (bytes[2] + 1) & 0xff, ...bytes.slice(3)]
            : bytes]));
    return { first: code, second };
}

/**
 * A store that answers at once (`getNow`), as a directory store in the engine's
 * thread does, or only a turn later.
 *
 * @param {boolean} now
 */
function storeOf(now){
    if (!now)
    {
        return memoryTranslationStore();
    }
    /** @type {Map<string, Uint8Array>} */
    const records = new Map();
    return {
        get: async(/** @type {string} */ key)=>records.get(key) ?? null,
        getNow: (/** @type {string} */ key)=>records.get(key) ?? null,
        put: async(/** @type {string} */ key, /** @type {Uint8Array} */ bytes)=>{
            records.set(key, bytes);
        },
    };
}

/**
 * What a program observes, run on a machine of `config`.
 *
 * @param {[number, number[]][]} code @param {Record<string, unknown>} config
 */
async function run(code, config){
    const m = createMachine({ ramSize: 1 << 20,
        config: { hashSlots: 1 << 12, hotThreshold: 2, bundleId: 'gate', ...config } });
    try
    {
        for (const [at, bytes] of code)
        {
            m.load(at, bytes);
        }
        m.setReg('esp', STACK);
        m.setReg('eip', MAIN);
        const stop = await m.run({ maxInstructions: 5_000_000 });
        const d = /** @type {any} */ (m.diagnostics());
        return {
            seen: {
                stop: stop.reason,
                registers: ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip']
                    .map(name=>m.reg(name)),
                flags: m.reg('eflags') & 0x8d5,
                data: [...m.read(DATA, 64)],
                code: code.map(([at, bytes])=>[...m.read(at, bytes.length)]),
            },
            remembered: d.formedRemembered ?? 0,
            shared: d.sharedModules ?? 0,
            hits: d.cacheHits ?? 0,
            misses: d.cacheMisses ?? 0,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('a process started again observes the same whether it shares the earlier one\'s '
    + 'regions and modules or not', async()=>{
    const interpreted = { translate: false };
    const apart = { sharedFormed: 0, sharedModuleBytes: 0 };
    let remembered = 0;
    let shared = 0;
    let hits = 0;
    for (let seed = 1; seed <= PROGRAMS; seed++)
    {
        const { first, second } = program(seed);
        const expected = (await run(second, interpreted)).seen;
        for (const now of [false, true])
        {
            /** @type {Record<string, any>} */
            const seen = {};
            for (const [path, config] of /** @type {[string, Record<string, unknown>][]} */ (
                [['apart', apart], ['shared', {}]]))
            {
                const store = storeOf(now);
                await run(first, { store, ...config });
                const again = await run(second, { store, ...config });
                seen[path] = again.seen;
                if (path === 'shared')
                {
                    remembered += again.remembered;
                    shared += again.shared;
                    hits += again.hits;
                }
                else
                {
                    assert.deepEqual([again.remembered, again.shared], [0, 0],
                        'nothing shared with sharing off');
                }
            }
            const name = `seed ${seed}, a store that answers ${now ? 'at once' : 'later'}`;
            assert.deepEqual(seen.shared, seen.apart, `${name}: shared as apart`);
            assert.deepEqual(seen.shared, expected, `${name}: as interpreted`);
        }
    }
    // The gate runs the paths it is for.
    assert.ok(hits > PROGRAMS, `store hits (${hits})`);
    assert.ok(remembered > PROGRAMS, `regions taken as formed earlier (${remembered})`);
    assert.ok(shared > PROGRAMS / 2, `modules taken as compiled earlier (${shared})`);
});
