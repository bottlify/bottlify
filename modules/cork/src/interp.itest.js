/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The whole single-instruction corpus on the interpreter alone, against the
 * hardware recording. A case the evaluator has no model for is counted by its
 * opcode and not judged -- the list is the interpreter's work list, printed
 * with the count -- and every case it does run must leave what the recording
 * holds. This is the acceptance harness for step 5.2's families: the left-out
 * count falls commit by commit.
 *
 * Needs the corpus (`npm run fetch:corpus`); no emulator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Fault, Unsupported, createState } from './ir.js';
import { interpret } from './interp.js';
import { BSS, BSS_SIZE, VECTOR_NAMES, diffFixture, loadCorpus } from './testing/corpus.js';

const CORPUS = new URL('../vendor/nasm-corpus.json.gz', import.meta.url);
const RAM = 2 << 20;
const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');
/** Cases whose divergence is the 80-bit-versus-double design's own (plan 3.1). */
const X87_PRECISION = new Set(['x87-int-binop', 'fscale-wide']);

test('the interpreter leaves what the hardware left, on every case it models',
    { skip: !existsSync(CORPUS) && `missing ${CORPUS.href}`, timeout: 30 * 60 * 1000 },
    async()=>{
        const { cases } = loadCorpus(await readFile(CORPUS));
        const selected = cases.filter(one=>ONLY.test(one.name));
        /** @type {string[]} */
        const failures = [];
        /** @type {Map<string, number>} */
        const leftOut = new Map();
        let judged = 0;
        let precision = 0;
        let invalid = 0;
        let died = 0;
        const started = Date.now();
        for (const one of selected)
        {
            const ram = new Uint8Array(RAM);
            const view = new DataView(ram.buffer);
            /** @type {import('./ir.js').EvalState} */
            let state;
            const memory = {
                /** @param {number} address @param {number} size */
                read: (address, size)=>{
                    if (address + size > RAM)
                    {
                        throw new Fault(13, state.eip);
                    }
                    return size === 1 ? ram[address]
                        : size === 2 ? view.getUint16(address, true)
                            : view.getUint32(address, true);
                },
                /** @param {number} address @param {number} size @param {number} value */
                write: (address, size, value)=>{
                    if (address + size > RAM)
                    {
                        throw new Fault(13, state.eip);
                    }
                    if (size === 1)
                    {
                        ram[address] = value;
                    }
                    else if (size === 2)
                    {
                        view.setUint16(address, value, true);
                    }
                    else
                    {
                        view.setUint32(address, value, true);
                    }
                },
            };
            for (const { address, bytes } of one.segments)
            {
                ram.set(bytes, address);
            }
            state = createState(memory, { eip: one.entry });
            /** @type {{ name: string, eip: number } | null} */
            let exception = null;
            let left = 2_000_000;
            try
            {
                while (left > 0 && !state.halted)
                {
                    left -= Math.max(interpret(state, Math.min(left, 100_000)), 1);
                }
            }
            catch (e){
                if (e instanceof Unsupported)
                {
                    leftOut.set(e.op, (leftOut.get(e.op) ?? 0) + 1);
                    continue;
                }
                if (e instanceof Fault)
                {
                    exception = {
                        name: /** @type {Record<number, string>} */ (VECTOR_NAMES)[e.vector]
                            ?? `#${e.vector}`,
                        eip: e.eip >>> 0,
                    };
                }
                else
                {
                    throw e;
                }
            }
            if (exception !== null && exception.name.startsWith('#'))
            {
                invalid++;
                continue;
            }
            judged++;
            died += exception ? 1 : 0;
            const top = state.top;
            const outcome = {
                exception,
                halted: state.halted,
                reg32: Int32Array.from(state.reg, value=>value | 0),
                eip: state.eip,
                st: Array.from({ length: 8 }, (_, i)=>state.f80[(top + i) & 7]),
                fstat: (state.status & ~0x3800 | top << 11) & 0xffff,
                mm: Int32Array.from({ length: 16 }, (_, word)=>Number(
                    state.f80bits[word >> 1] >> BigInt((word & 1) * 32) & 0xffffffffn) | 0),
                xmm: Int32Array.from(state.xmm, word=>word | 0),
                memory: new Int32Array(ram.buffer, BSS, BSS_SIZE / 4),
                eflags: state.eflags >>> 0,
            };
            const divergences = diffFixture(one.expected, outcome);
            if (divergences.length > 0 && X87_PRECISION.has(one.name))
            {
                precision++;
                continue;
            }
            if (divergences.length > 0)
            {
                failures.push(`${one.name}: ${divergences.slice(0, 5)
                    .map(d=>`${d.name} expected ${String(d.expected)} got ${String(d.actual)}`)
                    .join('; ')}`);
            }
        }
        const top = [...leftOut].sort((a, b)=>b[1] - a[1]).slice(0, 24)
            .map(([opcode, count])=>`${opcode}×${count}`).join(' ');
        console.log(`interpreted: ${judged} cases judged (${died} died as recorded),`
            + ` ${invalid} invalid encodings, ${leftOut.size} opcodes left out,`
            + ` ${failures.length} diverged, ${precision} x87.precision,`
            + ` ${((Date.now() - started) / 1000).toFixed(1)} s; left out: ${top}`);
        assert.equal(failures.length, 0,
            `${failures.length} diverged:\n${failures.slice(0, 40).join('\n')}`);
        assert.ok(judged > 0);
    });
