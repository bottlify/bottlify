/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Long mode's atomic variant beside its plain one (`emitLockedLong`,
 * `interp64.js`'s locked step): on one thread a locked instruction leaves what
 * its plain form leaves, so the hardware corpus's cases with an instruction
 * `lock` may prefix - each given the prefix here, every lockable operation at
 * its four widths on aligned and misaligned memory - and its `xchg` with
 * memory are run with `atomic` translated, and on the interpreter alone, and
 * compared with the interpreter's plain answers, which the corpus judges
 * against a processor's. What the atomics add for several executors is the
 * executors' gates' to show.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORPUS, compare } from '../testing/long-machine.js';
import { ifRoom } from '../testing/memory64.js';
import { MODE_64, decode } from '../decode/decoder.js';
import { createRuntimeRunner64 } from '../testing/runtime-runner64.js';

const LOCKABLE = new Set(['add', 'adc', 'and', 'btc', 'btr', 'bts', 'cmpxchg', 'cmpxchg8b', 'dec',
    'inc', 'neg', 'not', 'or', 'sbb', 'sub', 'xor', 'xadd']);

/**
 * The corpus's cases that hold a lockable instruction on memory, each such
 * instruction prefixed, and those with an `xchg` with memory as they are. A
 * case that addresses by RIP or branches is left out: a byte more would move
 * what it reaches.
 *
 * @returns {{ cases: any[], forms: Set<string> }}
 */
function lockedCases(){
    /** @type {any[]} */
    const cases = [];
    /** @type {Set<string>} */
    const forms = new Set();
    for (const one of CORPUS.cases)
    {
        const code = Buffer.from(one.code, 'hex');
        /** @type {number[]} */
        const out = [];
        let locked = 0;
        let moved = false;
        /** The register the locked instructions address through, when it is one. */
        let through = -1;
        for (let at = 0; at < code.length;)
        {
            const decoded = decode(address=>code[address] ?? 0xcc, at, MODE_64);
            if ('refused' in decoded || decoded.operands.some(operand=>operand.kind === 'rel'
                || /** @type {any} */ (operand).rip === true))
            {
                locked = -1;
                break;
            }
            const onMemory = decoded.memory === true && decoded.operands[0]?.kind === 'mem';
            const base = decoded.operands.find(operand=>operand.kind === 'mem')?.base;
            if (decoded.memory === true && (LOCKABLE.has(decoded.op) || decoded.op === 'xchg')
                && typeof base === 'number' && base !== 4)
            {
                through = base;
            }
            if (onMemory && LOCKABLE.has(decoded.op) && decoded.prefixes.lock !== true)
            {
                out.push(0xf0);
                moved = true;
                locked++;
                forms.add(`${decoded.op} ${decoded.size}`);
            }
            else if (decoded.memory === true && decoded.op === 'xchg')
            {
                locked++;
                forms.add(`xchg ${decoded.size}`);
            }
            out.push(...code.subarray(at, at + decoded.length));
            at += decoded.length;
        }
        if (locked > 0)
        {
            const made = moved ? { ...one, code: Buffer.from(out).toString('hex') } : one;
            cases.push(made);
            // And off its alignment: inside one qword, and across two.
            const at = through < 0 ? 0n : BigInt(`0x${one.regs[through]}`);
            if (at >= BigInt(CORPUS.dataAt) && at < BigInt(CORPUS.dataAt + CORPUS.dataSize - 64))
            {
                for (const by of [1n, 2n, 3n, 5n, 7n])
                {
                    cases.push({ ...made, text: `${made.text} (+${by})`,
                        regs: made.regs.map((/** @type {string} */ value, /** @type {number} */
                            index)=>(index === through ? (at + by).toString(16) : value)) });
                }
            }
        }
    }
    return { cases, forms };
}

test('long mode\'s locked instructions, atomic, translated leave what the plain ones leave',
    ifRoom(()=>{
        const { cases, forms } = lockedCases();
        assert.ok(cases.length > 250, `${cases.length} cases`);
        for (const op of [...LOCKABLE].filter(name=>name !== 'cmpxchg8b'))
        {
            for (const size of [1, 2, 4, 8].filter(bytes=>!op.startsWith('bt') || bytes > 1))
            {
                assert.ok(forms.has(`${op} ${size}`) || op === 'cmpxchg' && size === 1,
                    `the corpus has ${op} of ${size} bytes`);
            }
        }
        const atomic = (/** @type {WebAssembly.Memory} */ memory, /** @type {any} */ layout)=>
            createRuntimeRunner64({ memory, layout, config: { atomic: true } });
        const { failures, stats } = compare(cases, { budget: 7, makeRunner: atomic,
            config: { atomic: true } });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
    }));

test('long mode\'s locked instructions, atomic, interpreted leave what the plain ones leave',
    ifRoom(()=>{
        const { cases } = lockedCases();
        const interpreted = (/** @type {WebAssembly.Memory} */ memory, /** @type {any} */ layout)=>
            createRuntimeRunner64({ memory, layout, config: { atomic: true, translate: false } });
        const { failures } = compare(cases, { budget: 7, makeRunner: interpreted,
            config: { atomic: true } });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    }));
