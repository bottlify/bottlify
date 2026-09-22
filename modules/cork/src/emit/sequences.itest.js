/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The sequence corpus: interactions between instructions, judged live against
 * the emulator.
 *
 * `corpus.itest.js` judges one instruction at a time against the hardware
 * recording and finds nothing left, so what a real program met under the
 * hybrid engine -- its own check that the x87 stack is empty at the end of a
 * frame failing, the tag word read by `fnstenv` held and a stack fault in the
 * status word -- is an interaction: MMX, x87 and SSE across several
 * instructions, and across the two executors. This file generates sequences of
 * two to eight instructions from a pool of hand-encoded forms
 * (`../testing/sequences.js`), runs each on the emulator and on the translator
 * from one state, and compares everything a program can read: every register,
 * the flags, the x87 block with its top, its empty mask and its status word,
 * the SSE registers and MXCSR, and the memory the sequence wrote.
 *
 * A sequence is entered with the x87 stack in the shape a preamble left it in,
 * so a region is compiled for tops and permutations other than the empty stack
 * a fresh processor has -- the entry key is part of where a defect hides. A
 * run is repeatable from its seed and a diverging sequence is named by the seed
 * and its index; the divergences are grouped by the shortest sequence that
 * still reproduces each, found by dropping instructions while the divergence
 * stays.
 *
 * Needs the prebuilt emulator (`npm run fetch:v86`). `SEQUENCES` raises the
 * count, `SEQUENCE_SEED` names another run, `SEQUENCE_SHRINK` how many of the
 * diverging sequences are minimised.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createV86Host } from '../../../core/src/layers/cpu/internal/v86-host.js';
import { createHybridHost } from '../../../core/src/layers/cpu/internal/hybrid-host.js';
import { TABLES_RESERVE } from '../../../core/src/layers/cpu/engine.js';
import { createCorkRuntime } from '../runtime/runtime.js';
import { PageFlag } from '../runtime/pages.js';
import { restore, snapshot } from '../testing/snapshot.js';
import { replaySlice, retireExactly } from '../testing/differential.js';
import {
    CODE, DATA, DATA_BYTES, HALT, POOL, REGISTERS, SETUP, SPANS, XMM, bodyOf, minimise, namesOf,
    preambleOf, programBytes, random,
} from '../testing/sequences.js';
import { theEmulatorsOwn } from '../testing/excuses.js';

const PREBUILT = new URL('../../../core/vendor/prebuilt/', import.meta.url);
const ENTRY_VECTOR = 0x7000;
const SEED = Number(process.env.SEQUENCE_SEED ?? 0xc05eed);
const COUNT = Number(process.env.SEQUENCES ?? 20_000);
/** Diverging sequences shortened to their minimal pair; each costs a run per drop. */
const SHRINK = Number(process.env.SEQUENCE_SHRINK ?? 48);
/** Instructions a sequence may retire before it is one this corpus does not judge. */
const LIMIT = 256;
/** The state every sequence starts from is a fresh FPU: `fninit; hlt`. */
const RESET = new Uint8Array([0xdb, 0xe3, HALT]);

const missing = ['v86.wasm', 'libv86.mjs'].filter(name=>!existsSync(new URL(name, PREBUILT)));

/** @param {number} value */
const u32 = value=>Uint8Array.from([value & 0xff, value >>> 8 & 0xff,
    value >>> 16 & 0xff, value >>> 24 & 0xff]);

/**
 * The ways the pinned emulator leaves what the hardware recording holds, or
 * what the manual says, named here so that this corpus does not ask the
 * translator to match them. `testing/corpus.itest.js` keeps the same kind of
 * list for the single instructions, and `emit/corpus.itest.js` the same for
 * the translator against the recording; in every class below the translator
 * is the side the recording agrees with.
 *
 * - **The indefinite a masked fault leaves.** An x87 instruction whose source
 *   register is empty raises IE and SF on both engines and then leaves the
 *   register itself a value they do not agree on: the processor exchanges or
 *   computes anyway, which the 80 `gen_d9_1_*` recordings of a faulting
 *   `fxch` say and the translator does, and the emulator leaves the QNaN
 *   indefinite -- of the other sign to the processor's, as `arith_76`'s
 *   recording of a stored one says. Everything derived from that register
 *   differs with it: the tag word an environment form writes, the condition
 *   codes a compare sets from it, and a qword stored from it later.
 * - **The environment's pointers.** `fnstenv` writes the instruction and data
 *   pointer fields; the processor the recording was made on leaves all of them
 *   zero (`fstenv`'s and `fsave_frstor`'s recordings do, after FPU
 *   instructions of their own), and the emulator writes its own idea of them,
 *   which is a function of which instructions it ran rather than of the
 *   sequence -- under hybrid the two runs are not the same in that respect.
 * - **`fnclex` and the condition codes.** FNCLER clears the exception flags,
 *   the exception summary, the stack fault and the busy bit, and leaves C0 to
 *   C3 alone; the emulator clears a condition code with them, so a compare
 *   before it reads back as though it had not been made -- in the status word,
 *   in the copy `fnstenv` writes and in the one `fnstsw ax` leaves in ax. The
 *   six corpus cases that run one have no condition code set at it, so the
 *   recording does not decide this -- the manual does.
 * - **The x87/MMX crossover's NaN, in its bits and its flags.** A region now
 *   translates both classes, so an MMX write and an x87 read of the same
 *   register meet inside one run: mm<i> is the mantissa of R<i>, and an MMX
 *   write leaves its exponent and sign all ones, which the x87 side then reads
 *   as the indefinite (a zero mantissa as the negative infinity). The two
 *   engines agree that the register is a NaN -- the value compares equal, or
 *   is one of the two indefinites -- but not on the bits behind it, and the
 *   difference shows wherever the mantissa itself is read rather than the
 *   value: a qword stored from it (`cvtps2pi mm0, xmm0; fstp qword [m]`), an
 *   SSE lane converted from it (`fstp st0; cvtpi2ps xmm0, mm0`), and the
 *   invalid exception and condition codes an x87 arithmetic or compare sets
 *   from it (`cvttps2pi mm1, xmm1; faddp`, `pshufw mm0, mm1, 0x1b; fmul st0,
 *   st1`, `fxch st1; pxor mm1, mm1; fcomp`). The translator holds the value as
 *   a double, as `docs/core/cpu.md` says it does, and the emulator holds the
 *   80-bit encoding the MMX write left; a double cannot carry that encoding's
 *   payload, and its arithmetic raises the invalid exception by the f64 rule
 *   where the emulator raises it by the 80-bit one (an unsupported encoding)
 *   or, for an infinity times a zero, does not raise it at all. These are the
 *   `x87.precision` and indefinite families the plan already names, met at the
 *   crossover; the structural half of the crossover -- the top, the empty
 *   mask, the control word, and every finite value either class leaves -- is
 *   still judged, and a divergence there fails.
 */

/**
 * Boots the emulator with the translator attached over one register file, and
 * answers a judge that runs one sequence on both executors from one state.
 */
async function createJudge(){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const emulator = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: ENTRY_VECTOR,
        initialStack: 0x300000,
        // The compiler off: a slice then stops on the instruction asked.
        jit: { 0: 1 },
    });
    const cork = createCorkRuntime({
        memory: emulator.wasmMemory(),
        layout: emulator.stateLayout(TABLES_RESERVE),
        // The runtime finds candidates of its own by counting its
        // untranslated exits, and a batch holds only so many: one it queued
        // inside a sequence would be formed for the bytes a later sequence
        // put at the same address, or crowd that sequence's own out. This
        // corpus translates every sequence itself, through `noteHot`, and a
        // run is only repeatable from its seed with that feed alone.
        config: { missThreshold: Number.POSITIVE_INFINITY },
        read: emulator.readByte,
        imports: {
            trap: ()=>0, getEflags: emulator.getEflags, x87Read: ()=>0, rdtsc: ()=>0n,
            handoffPage: emulator.handoffPage, handoffHash: emulator.handoffHash,
            dirtyCode: emulator.dirtyCode,
        },
    });
    const host = createHybridHost({ emulator, cork });
    // A fault stub halts after reporting; nothing here traps.
    emulator.onTrap(()=>{});

    host.writePhysical(SETUP, RESET);
    host.writePhysical(ENTRY_VECTOR, u32(SETUP));
    host.runSlice(100);
    assert.ok(emulator.halted(), 'the reset ran to its halt');
    // The x87 registers zeroed rather than left as the boot found them: an MMX
    // read of one is then a known pair of words, and a conversion of them
    // raises no engine's exception flags.
    emulator.cpu().fpu_st.set(new Int32Array(32));
    XMM.forEach((words, index)=>emulator.writeXmm(index, Uint32Array.from(words)));
    emulator.writeMxcsr(0x1f80);
    host.writePhysical(DATA, DATA_BYTES);
    for (const [name, value] of Object.entries(REGISTERS))
    {
        emulator.writeReg32(name, value);
    }
    // IF clear, so the halt at the end of a sequence halts.
    emulator.writeReg32('eflags', 2);
    const pristine = snapshot(emulator, SPANS);

    const step = (/** @type {number} */ instructions)=>
        emulator.cpu().run_slice(instructions) >>> 0;
    const oracle = { ...emulator, step, halted: emulator.halted, wake: emulator.wake };
    const subject = {
        step: (/** @type {number} */ instructions)=>host.runSlice(instructions),
        halted: emulator.halted,
        wake: emulator.wake,
    };

    /** The preamble standing at SETUP; written again only when it moves. */
    let written = '-';
    let published = 0;
    // The share of the subject's own instructions the translator ran: the
    // runtime's figure is over every run this judge made, the oracle's two
    // included, and would say a third of what the subject did.
    let bySubject = 0;
    let byCork = 0;
    let excused = 0;

    return {
        /** Sequences the translator published an entry for. */
        published: ()=>published,
        /** Instructions the translator ran, over the instructions the subject ran. */
        share: ()=>(bySubject > 0 ? byCork / bySubject : 0),
        /** Divergences that are the emulator's own, and so not judged. */
        excused: ()=>excused,
        diagnostics: ()=>cork.diagnostics(),
        stop: ()=>emulator.stop(),
        /**
         * Runs one sequence on the emulator and on the translator, from one
         * state, and answers what differs; null when the sequence is not one
         * this corpus judges (it did not reach its halt inside the limit).
         *
         * @param {number[]} body   the judged sequence, as pool indices
         * @param {number[]} setup  the x87 shape it is entered with
         * @returns {Promise<ReturnType<typeof replaySlice> | null>}
         */
        async judge(body, setup){
            restore(emulator, pristine);
            emulator.wake();
            const key = setup.join(',');
            if (key !== written)
            {
                host.writePhysical(SETUP, programBytes(setup));
                written = key;
            }
            if (setup.length > 0)
            {
                emulator.cpu().instruction_pointer[0] = SETUP;
                retireExactly(step, emulator.halted, LIMIT);
            }
            host.writePhysical(CODE, programBytes(body));
            // One code page serves every sequence, so it is overwritten far
            // more often than any program overwrites its own code: the
            // volatility that would leave it untranslated -- and the corpus
            // silently judging nothing -- is cleared each time.
            cork.pages.clear(CODE >>> 12, PageFlag.VOLATILE);
            emulator.cpu().instruction_pointer[0] = CODE;
            emulator.wake();
            cork.noteHot(CODE, emulator.x87Top());
            const made = await cork.translatePending();
            published += made > 0 ? 1 : 0;
            const state = snapshot(emulator, SPANS);
            const instructions = retireExactly(step, emulator.halted, LIMIT);
            if (instructions === 0 || instructions >= LIMIT)
            {
                return null;
            }
            const before = cork.diagnostics().retired;
            const result = replaySlice({ oracle, subject, state, instructions, spans: SPANS });
            const forms = new Set(body.map(index=>POOL[index].name));
            byCork += cork.diagnostics().retired - before;
            bySubject += result.retiredSubject;
            const judged = result.divergences.filter(
                one=>!theEmulatorsOwn(one, result.oracleState, result.subjectState, forms));
            excused += result.divergences.length - judged.length;
            return { ...result, divergences: judged };
        },
    };
}

test('sequences of x87, MMX and SSE leave what the emulator leaves',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 30 * 60 * 1000 },
    async()=>{
        const machine = await createJudge();
        const started = Date.now();
        const next = random(SEED);
        /** @type {Map<string, { count: number, at: string, what: string }>} */
        const groups = new Map();
        /** @type {string[]} */
        const failures = [];
        /** @param {import('../testing/snapshot.js').Divergence[]} divergences */
        const what = divergences=>divergences.slice(0, 5)
            .map(one=>`${one.name} ${String(one.expected)} != ${String(one.actual)}`).join('; ');
        /**
         * @param {number} index @param {number[]} body @param {number[]} setup
         * @param {import('../testing/snapshot.js').Divergence[]} divergences
         */
        const render = (index, body, setup, divergences)=>`seed ${SEED} #${index}`
            + `${setup.length > 0 ? ` [${namesOf(setup)}]` : ''} ${namesOf(body)}: `
            + what(divergences);
        let judged = 0;
        let diverged = 0;
        let shrunk = 0;
        let unrun = 0;
        try
        {
            for (let index = 0; index < COUNT; index++)
            {
                const body = bodyOf(next);
                const setup = preambleOf(next);
                const result = await machine.judge(body, setup);
                if (result === null)
                {
                    unrun++;
                    continue;
                }
                judged++;
                const { divergences } = result;
                if (divergences.length === 0)
                {
                    continue;
                }
                diverged++;
                if (failures.length < 40)
                {
                    failures.push(render(index, body, setup, divergences));
                }
                if (shrunk >= SHRINK)
                {
                    continue;
                }
                shrunk++;
                const minimal = await minimise(body, async trial=>{
                    const again = await machine.judge(trial, setup);
                    return again !== null && again.divergences.length > 0;
                });
                // Judged again on its own: the group is named by what the
                // shortest sequence reproducing the divergence actually shows,
                // not by what the longer one it was found in showed.
                const own = await machine.judge(minimal, setup);
                const least = own === null ? divergences : own.divergences;
                const key = namesOf(minimal);
                const found = groups.get(key);
                if (found)
                {
                    found.count++;
                }
                else
                {
                    groups.set(key, {
                        count: 1,
                        at: render(index, minimal, setup, least),
                        what: what(least),
                    });
                }
            }
            const report = machine.diagnostics();
            const leftOut = Object.entries(report.refused).sort((a, b)=>b[1] - a[1])
                .slice(0, 8).map(([opcode, count])=>`${opcode}x${count}`).join(' ');
            const ranked = [...groups].sort((a, b)=>b[1].count - a[1].count);
            const share = machine.share();
            console.log(`sequences: ${judged} judged, ${diverged} diverged, ${unrun} not run, `
                + `${machine.published()} translated, ${share.toFixed(2)} of the subject's `
                + `instructions the translator's, ${machine.excused()} findings the `
                + `emulator's own, ${shrunk} minimised into ${groups.size} groups, `
                + `seed ${SEED}, ${((Date.now() - started) / 1000).toFixed(1)} s`
                + `${ranked.length > 0 ? '; ' : ''}`
                + ranked.slice(0, 10).map(([key, one])=>`${key} x${one.count}`).join(' | ')
                + `${leftOut === '' ? '' : `; left out: ${leftOut}`}`);
            assert.ok(judged > COUNT * 0.9, `only ${judged} of ${COUNT} sequences ran`);
            // Every sequence translates whole now: a region with both classes
            // is no longer cut at its first x87 instruction, so the translator
            // publishes an entry for all of them and runs almost every
            // instruction (was a half and a fifth when the crossover was left
            // out). A regression that cuts the crossover again drops both.
            assert.ok(machine.published() > judged * 0.98,
                `the translator published an entry for ${machine.published()} of ${judged}`);
            assert.ok(share > 0.85, `the translator ran ${share} of the subject's instructions`);
            assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}\n`
                + [...groups].map(([key, one])=>`  ${key} x${one.count}\n    ${one.at}`)
                    .join('\n'));
        }
        finally
        {
            machine.stop();
        }
    });
