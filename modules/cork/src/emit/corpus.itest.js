/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every corpus case on translated code, against the hardware recording.
 *
 * A case whose instructions the emitter translates in full must leave the
 * state the recording holds: registers, memory, the arithmetic flags, or
 * the faulting address where the hardware died. A case that reaches an
 * instruction the emitter leaves out (x87, SIMD, the forms still to come)
 * is counted by that instruction's opcode and not judged -- the list of
 * opcodes is the emitter's work list, printed with the count.
 *
 * Needs the corpus (`npm run fetch:corpus`); no emulator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithout } from '../testing/fetched.js';
import { readFile } from 'node:fs/promises';
import { createTestMachine } from '../testing/machine.js';
import { BSS, BSS_SIZE, diffFixture, loadCorpus } from '../testing/corpus.js';

const CORPUS = new URL('../../vendor/nasm-corpus.json.gz', import.meta.url);
const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');
const VECTOR_NAMES = new Map([[0, 'DE'], [6, 'UD'], [13, 'GP']]);
/**
 * Cases whose divergence is the design's own: every x87 value is a double,
 * and these compute something only an 80-bit register holds (a product or a
 * scaling past the double's range, stored as a tword). Counted under `x87.precision`,
 * not failed; the list is the acceptance, and a case leaving or joining it is
 * a change to be looked at (`roadmap/cork-plan.md` 3.1).
 */
const X87_PRECISION = new Set(['x87-int-binop', 'fscale-wide']);

test('translated code leaves what the hardware left, on every case it translates in full',
    { skip: skipWithout(CORPUS), timeout: 30 * 60 * 1000 },
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
        let skipped = 0;
        const started = Date.now();
        for (const one of selected)
        {
            // Judged against the hardware, so exact where the fast default is not.
            const m = createTestMachine({ ramSize: 2 << 20, precise: true });
            for (const { address, bytes } of one.segments)
            {
                m.write(address, bytes);
            }
            const exit = m.runProgram(one.entry, { budget: 2_000_000 });
            if (exit.kind === -2 || exit.kind === -1)
            {
                // Nothing left out by the emitter: the decoder refused the
                // entry itself, an invalid encoding the hardware raised #UD
                // at, which the other executor raises for this one.
                if (exit.unsupported.size === 0)
                {
                    invalid++;
                    continue;
                }
                skipped++;
                for (const [opcode, count] of exit.unsupported)
                {
                    leftOut.set(opcode, (leftOut.get(opcode) ?? 0) + count);
                }
                continue;
            }
            const reg32 = new Int32Array(8);
            ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'].forEach((name, i)=>{
                reg32[i] = m.reg(name) | 0;
            });
            const bss = m.read(BSS, BSS_SIZE);
            const state = new DataView(m.memory.buffer);
            const top = state.getUint8(m.layout.x87Top) & 7;
            const outcome = {
                exception: exit.kind === 4
                    ? { name: VECTOR_NAMES.get(exit.vector) ?? `#${exit.vector}`, eip: exit.eip }
                    : null,
                halted: exit.kind === 3,
                reg32,
                eip: exit.eip,
                // ST(i) relative to the top, as f64 in cork's own layout; the status
                // word with the top folded into bits 11..13, as fnstsw gives it.
                st: /** @type {(number | 'invalid')[]} */ (Array.from({ length: 8 }, (_, i)=>state
                    .getFloat64(m.layout.x87 + ((top + i) & 7) * 16, true))),
                fstat: (state.getUint16(m.layout.x87Status, true) & ~0x3800 | top << 11) & 0xffff,
                mm: Int32Array.from({ length: 16 }, (_, word)=>state.getInt32(
                    m.layout.x87 + (word >> 1) * 16 + (word & 1) * 4, true)),
                xmm: Int32Array.from({ length: 32 }, (_, word)=>state.getInt32(
                    m.layout.xmm + word * 4, true)),
                memory: new Int32Array(bss.buffer, bss.byteOffset, BSS_SIZE / 4),
                eflags: m.eflags(),
            };
            // int3 and int n are recorded by the hardware as signals the runner
            // does not map; the emitter leaves with the vector, which is right,
            // and the case is not one the corpus judges.
            if (outcome.exception && outcome.exception.name.startsWith('#'))
            {
                skipped++;
                continue;
            }
            judged++;
            died += outcome.exception ? 1 : 0;
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
        console.log(`translated: ${judged} cases judged (${died} died as recorded),`
            + ` ${invalid} invalid encodings, ${skipped} left out`
            + ` at ${leftOut.size} opcodes, ${failures.length} diverged,`
            + ` ${precision} x87.precision, `
            + `${((Date.now() - started) / 1000).toFixed(1)} s; left out: ${top}`);
        assert.equal(failures.length, 0,
            `${failures.length} diverged:\n${failures.slice(0, 40).join('\n')}`);
        assert.ok(judged > 0);
        assert.equal(precision, X87_PRECISION.size,
            'every named precision case still diverges, and no other');
    });
