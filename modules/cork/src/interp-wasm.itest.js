/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The whole single-instruction corpus on the interpreter tier in wasm, against
 * the hardware recording: each case runs on the tier over cork's own layout,
 * the JavaScript interpreter taking every instruction the tier leaves, as the
 * cork host runs them, the tier `precise` as the recording is judged. What the
 * JavaScript interpreter has no model for is
 * counted by its opcode and not judged, as `interp.itest.js` counts it; every
 * case that runs must leave what the recording holds.
 *
 * Needs the corpus (`npm run fetch:corpus`); no emulator.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Fault, Unsupported, blockState, interpret } from './interp.js';
import { WASM_INTERPRETER_AREA, WasmExit, createWasmInterpreter } from './interp-wasm.js';
import { eflagsOf } from './emit/flags.js';
import { ownLayout, pagesFor, Tables } from './runtime/layout.js';
import { createPageTable } from './runtime/pages.js';
import { BSS, BSS_SIZE, VECTOR_NAMES, diffFixture, loadCorpus } from './testing/corpus.js';

const CORPUS = new URL('../vendor/nasm-corpus.json.gz', import.meta.url);
const RAM = 2 << 20;
const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');
/** Cases whose divergence is the 80-bit-versus-double design's own (plan 3.1). */
const X87_PRECISION = new Set(['x87-int-binop', 'fscale-wide']);

test('the wasm tier leaves what the hardware left, on every case the interpreters model',
    { skip: !existsSync(CORPUS) && `missing ${CORPUS.href}` },
    async()=>{
        const { cases } = loadCorpus(await readFile(CORPUS));
        const selected = cases.filter(one=>ONLY.test(one.name));
        const layout = ownLayout({ ramSize: RAM });
        const area = layout.tables + Tables.SIZE;
        const pages = pagesFor(layout, Tables.SIZE + WASM_INTERPRETER_AREA);
        const memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
        createPageTable(memory, layout);
        const bytes = new Uint8Array(memory.buffer);
        const view = new DataView(memory.buffer);
        const tier = createWasmInterpreter({ memory, layout, area, hotThreshold: 2,
            trapPort: 0xb077, parkBase: 0x100000, precise: true });
        assert.ok(tier);
        /** @type {string[]} */
        const failures = [];
        /** @type {Map<string, number>} */
        const leftOut = new Map();
        let judged = 0;
        let precision = 0;
        let invalid = 0;
        let died = 0;
        let byTier = 0;
        let byJs = 0;
        const started = Date.now();
        for (const one of selected)
        {
            // The state block and RAM as a fresh machine has them; the tier's own
            // page below RAM and the tables' flags stay.
            bytes.fill(0, 0, 512);
            bytes.fill(0, layout.ramBase, layout.ramBase + RAM);
            bytes.fill(0, area, area + WASM_INTERPRETER_AREA);
            for (const { address, bytes: segment } of one.segments)
            {
                bytes.set(segment, layout.ramBase + address);
            }
            view.setUint32(layout.eflags, 2, true);
            view.setUint16(layout.x87Control, 0x37f, true);
            view.setUint8(layout.x87Empty, 0xff);
            view.setUint32(layout.mxcsr, 0x1f80, true);
            view.setUint32(layout.eip, one.entry, true);
            const state = blockState({ memory, layout });
            /** @type {{ name: string, eip: number } | null} */
            let exception = null;
            let halted = false;
            let left = 2_000_000;
            try
            {
                while (left > 0 && !halted)
                {
                    const code = tier.run(Math.min(left, 100_000));
                    left -= tier.retired();
                    byTier += tier.retired();
                    if (code === WasmExit.HALT)
                    {
                        halted = true;
                    }
                    else if (code === WasmExit.FAULT)
                    {
                        const vector = tier.exitValue();
                        exception = {
                            name: /** @type {Record<number, string>} */ (VECTOR_NAMES)[vector]
                                ?? `#${vector}`,
                            eip: view.getUint32(layout.eip, true),
                        };
                        break;
                    }
                    else if (code === WasmExit.UNSUPPORTED)
                    {
                        state.syncIn();
                        state.eip = view.getUint32(layout.eip, true);
                        state.halted = false;
                        const ran = interpret(state, 1);
                        left -= Math.max(ran, 1);
                        byJs += ran;
                        state.trapped.length = 0;
                        state.syncOut();
                        halted = state.halted;
                    }
                }
            }
            catch (e){
                if (e instanceof Unsupported)
                {
                    if (one.expected.exception === 'UD' && e.eip === one.expected.eip)
                    {
                        invalid++;
                        continue;
                    }
                    leftOut.set(e.op, (leftOut.get(e.op) ?? 0) + 1);
                    continue;
                }
                if (!(e instanceof Fault))
                {
                    throw e;
                }
                exception = {
                    name: /** @type {Record<number, string>} */ (VECTOR_NAMES)[e.vector]
                        ?? `#${e.vector}`,
                    eip: e.eip >>> 0,
                };
            }
            if (exception !== null && exception.name.startsWith('#'))
            {
                invalid++;
                continue;
            }
            judged++;
            died += exception ? 1 : 0;
            state.syncIn();
            const top = state.top;
            const outcome = {
                exception,
                halted,
                reg32: Int32Array.from({ length: 8 },
                    (_, r)=>view.getInt32(layout.regs + r * 4, true)),
                eip: view.getUint32(layout.eip, true),
                st: Array.from({ length: 8 }, (_, i)=>state.f80[(top + i) & 7]),
                fstat: (state.status & ~0x3800 | top << 11) & 0xffff,
                mm: Int32Array.from({ length: 16 }, (_, word)=>Number(
                    state.f80bits[word >> 1] >> BigInt((word & 1) * 32) & 0xffffffffn) | 0),
                xmm: Int32Array.from(state.xmm, word=>word | 0),
                memory: new Int32Array(memory.buffer.slice(layout.ramBase + BSS,
                    layout.ramBase + BSS + BSS_SIZE)),
                eflags: eflagsOf(view, layout) >>> 0,
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
        console.log(`wasm tier: ${judged} cases judged (${died} died as recorded),`
            + ` ${invalid} invalid encodings, ${leftOut.size} opcodes left out,`
            + ` ${failures.length} diverged, ${precision} x87.precision;`
            + ` ${byTier} instructions on the tier, ${byJs} left to the JavaScript tier,`
            + ` ${((Date.now() - started) / 1000).toFixed(1)} s; left out: ${top}`);
        assert.equal(failures.length, 0,
            `${failures.length} diverged:\n${failures.slice(0, 40).join('\n')}`);
        assert.ok(judged > 0);
        assert.ok(byTier > byJs, 'the tier ran most of the corpus');
        assert.equal(precision, X87_PRECISION.size,
            'every named precision case still diverges, and no other');
    });
