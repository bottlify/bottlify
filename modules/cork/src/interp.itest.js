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
import { skipWithout } from './testing/fetched.js';
import { readFile } from 'node:fs/promises';
import { createV86Host } from '../../core/src/layers/cpu/internal/v86-host.js';
import { createCorkHost } from '../../core/src/layers/cpu/internal/cork-host.js';
import { Fault, Unsupported, createState } from './ir.js';
import { interpret } from './interp.js';
import * as engine from './index.js';
import { BSS, BSS_SIZE, VECTOR_NAMES, diffFixture, loadCorpus } from './testing/corpus.js';
import { compare, restore, snapshot } from './testing/snapshot.js';
import { retireExactly } from './testing/differential.js';
import { theEmulatorsOwn } from './testing/excuses.js';
import {
    CODE, DATA, DATA_BYTES, POOL, REGISTERS, SETUP, SPANS, XMM, bodyOf, preambleOf, programBytes,
    random,
} from './testing/sequences.js';

const CORPUS = new URL('../vendor/nasm-corpus.json.gz', import.meta.url);
const PREBUILT = new URL('../../core/vendor/prebuilt/', import.meta.url);
const ENTRY_VECTOR = 0x7000;
const RAM = 2 << 20;
const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');
/** Cases whose divergence is the 80-bit-versus-double design's own (plan 3.1). */
const X87_PRECISION = new Set(['x87-int-binop', 'fscale-wide']);

test('the interpreter leaves what the hardware left, on every case it models',
    { skip: skipWithout(CORPUS) },
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
            // The run being interpreted, so a store into it ends the run as
            // `blockState`'s memory does: the cases run a run at a time.
            let watchStart = 0;
            let watchEnd = 0;
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
                    if (address < watchEnd && address + size > watchStart)
                    {
                        memory.hit = true;
                    }
                },
                /** @param {number} start @param {number} end */
                watch: (start, end)=>{
                    watchStart = start;
                    watchEnd = end;
                    memory.hit = false;
                },
                hit: false,
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
                    // A decoder refusal at the address the hardware raised #UD
                    // is that same invalid encoding, not a gap in the model --
                    // the emitter's corpus counts it the same way.
                    if (one.expected.exception === 'UD' && e.eip === one.expected.eip)
                    {
                        invalid++;
                        continue;
                    }
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
        assert.equal(precision, X87_PRECISION.size,
            'every named precision case still diverges, and no other');
    });

/** @param {number} value */
const u32 = value=>Uint8Array.from(
    [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff]);

/**
 * The cork host as a snapshot host, with the fields this test reaches.
 *
 * @typedef {import('./testing/snapshot.js').SnapshotHost & {
 *     blockLayout: () => Record<string, number>,
 *     block: () => Uint8Array,
 *     runSlice: (instructions: number) => number,
 *     halted: () => boolean,
 *     wake: () => void,
 * }} CorkHostForSnapshots
 */

/**
 * The sequence corpus with the interpreter as the subject: the same generated
 * chains `testing/sequences-judge.js` judges on translated code, run here on the
 * interpreter tier alone. The oracle is the emulator, over a host of its own
 * (cork-alone has no emulator to share), so the two machines start from one
 * snapshot: the interpreter's state block is restored from the emulator's
 * decoded registers, and every field a program can read is compared. The
 * divergences that are the pinned emulator's own -- the crossover's NaN, the
 * environment's pointers, `fnclex` -- are the same named classes the emitter's
 * corpus excuses.
 *
 * Needs the prebuilt emulator (`npm run fetch:v86`). `SEQUENCES` raises the
 * count, `SEQUENCE_SEED` names another run.
 */
test('sequences of x87, MMX and SSE leave what the emulator leaves, on the interpreter',
    { skip: skipWithout(new URL('v86.wasm', PREBUILT)) },
    async()=>{
        const seed = Number(process.env.SEQUENCE_SEED ?? 0xc05eed);
        const count = Number(process.env.SEQUENCES ?? 2000);
        const limit = 256;
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const emulator = await createV86Host({
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            memorySize: 64 * 1024 * 1024,
            trapPort: 0xb077,
            entryVector: ENTRY_VECTOR,
            initialStack: 0x300000,
            jit: { 0: 1 },
        });
        const cork = /** @type {CorkHostForSnapshots} */ (createCorkHost({
            engine,
            memorySize: 64 * 1024 * 1024,
            trapPort: 0xb077,
            entryVector: ENTRY_VECTOR,
            initialStack: 0x300000,
            cork: { translate: false },
        }));
        emulator.onTrap(()=>{});
        // The reset `fninit; hlt`, a fresh FPU, the known XMM/MXCSR and the
        // registers, exactly as `testing/sequences-judge.js` sets the oracle up.
        emulator.writePhysical(SETUP, new Uint8Array([0xdb, 0xe3, 0xf4]));
        emulator.writePhysical(ENTRY_VECTOR, u32(SETUP));
        emulator.cpu().run_slice(100);
        assert.ok(emulator.halted(), 'the reset ran to its halt');
        emulator.cpu().fpu_st.set(new Int32Array(32));
        XMM.forEach((words, index)=>emulator.writeXmm(index, Uint32Array.from(words)));
        emulator.writeMxcsr(0x1f80);
        emulator.writePhysical(DATA, DATA_BYTES);
        for (const [name, value] of Object.entries(REGISTERS))
        {
            emulator.writeReg32(name, value);
        }
        emulator.writeReg32('eflags', 2);
        const pristine = snapshot(emulator, SPANS);
        // The interpreter's block is f64 where the emulator's raw is tagged80:
        // `restore` copies the raw into the wrong slots, so the decoded values
        // are written over them.
        const layout = cork.blockLayout();
        const block = cork.block();
        const blockView = new DataView(block.buffer, block.byteOffset, block.byteLength);
        /** @param {import('./testing/snapshot.js').MachineState} state */
        const restoreCork = state=>{
            restore(cork, state);
            for (let index = 0; index < 8; index++)
            {
                blockView.setFloat64(layout.x87 + index * 16, state.x87.registers[index], true);
            }
        };
        const oracleStep = (/** @type {number} */ n)=>emulator.cpu().run_slice(n) >>> 0;
        const started = Date.now();
        /** @type {string[]} */
        const failures = [];
        const next = random(seed);
        let judged = 0;
        let unrun = 0;
        let excused = 0;
        let diverged = 0;
        for (let index = 0; index < count; index++)
        {
            const body = bodyOf(next);
            const setup = preambleOf(next);
            restore(emulator, pristine);
            emulator.wake();
            emulator.writePhysical(SETUP, programBytes(setup));
            emulator.writePhysical(CODE, programBytes(body));
            cork.writePhysical(CODE, programBytes(body));
            if (setup.length > 0)
            {
                emulator.cpu().instruction_pointer[0] = SETUP;
                retireExactly(oracleStep, emulator.halted, limit);
            }
            emulator.cpu().instruction_pointer[0] = CODE;
            emulator.wake();
            const state = snapshot(emulator, SPANS);
            restore(emulator, state);
            const instructions = retireExactly(oracleStep, emulator.halted, limit);
            if (instructions === 0 || instructions >= limit)
            {
                unrun++;
                continue;
            }
            // The oracle's run, from the common start.
            restore(emulator, state);
            emulator.wake();
            const retiredOracle = retireExactly(oracleStep, emulator.halted, instructions);
            const oracleState = snapshot(emulator, SPANS);
            // And the interpreter's.
            restoreCork(state);
            cork.wake();
            const retiredSubject = retireExactly(cork.runSlice, cork.halted, instructions);
            const subjectState = snapshot(cork, SPANS);
            judged++;
            const forms = new Set(body.map(one=>POOL[one].name));
            const hasMmx = [...forms].some(name=>name.includes('mm'));
            const findings = compare(oracleState, subjectState);
            const divergences = findings.filter(one=>{
                if (theEmulatorsOwn(one, oracleState, subjectState, forms))
                {
                    return false;
                }
                // The interpreter runs cork's own f64 x87 view: an MMX write
                // leaves the mantissa's bits read straight as a double, where
                // the emulator's tagged form reads them with the exponent and
                // sign all ones -- a zero mantissa as the negative infinity.
                // The emitter's corpus never meets this class because it runs
                // in the emulator's own form; it is named here, not matched.
                const register = /^st(\d)$/.exec(one.name);
                return !(register !== null && hasMmx
                    && (Math.abs(oracleState.x87.registers[Number(register[1])]) === Infinity
                        || Math.abs(subjectState.x87.registers[Number(register[1])]) === Infinity));
            });
            excused += findings.length - divergences.length;
            if (retiredOracle !== retiredSubject)
            {
                divergences.unshift({ name: 'retired', expected: retiredOracle,
                    actual: retiredSubject });
            }
            if (divergences.length > 0)
            {
                diverged++;
                if (failures.length < 40)
                {
                    failures.push(`seed ${seed} #${index} `
                        + `[${setup.map(i=>POOL[i].name).join('; ')}]`
                        + ` ${body.map(i=>POOL[i].name).join('; ')}: ${divergences.slice(0, 5)
                            .map(one=>`${one.name} ${String(one.expected)}`
                                + ` != ${String(one.actual)}`).join('; ')}`);
                }
            }
        }
        console.log(`interpreter sequences: ${judged} judged, ${diverged} diverged,`
            + ` ${unrun} not run, ${excused} findings the emulator's own, seed ${seed},`
            + ` ${((Date.now() - started) / 1000).toFixed(1)} s`);
        assert.ok(judged > count * 0.9, `only ${judged} of ${count} sequences ran`);
        assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}`);
        emulator.stop();
    });
