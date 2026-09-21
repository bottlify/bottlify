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
    CODE, DATA, DATA_BYTES, HALT, REGISTERS, SETUP, SPANS, XMM, bodyOf, minimise, namesOf,
    preambleOf, programBytes, random,
} from '../testing/sequences.js';

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
 * The two ways the emulator leaves what the hardware recording holds, named
 * here so that this corpus does not ask the translator to match them -- the
 * single-instruction corpus carries the first of them as its own list of
 * known cases, and the translator is the side the recording agrees with:
 *
 * - **The indefinite NaN's sign.** A store from an empty register, or an
 *   operation whose source is empty, leaves the QNaN indefinite. The processor
 *   makes it negative (`arith_76`'s recording holds `0xfff8000000000000` in
 *   its data area) and the pinned emulator positive.
 * - **The environment's pointers.** `fnstenv` writes the instruction and data
 *   pointer fields; the processor the recording was made on leaves all of them
 *   zero (`fstenv`'s and `fsave_frstor`'s recordings do, after FPU
 *   instructions of their own), and the emulator writes its own idea of them
 *   or nothing at all.
 */
const INDEFINITE = [0x7ff8000000000000n, 0xfff8000000000000n];
/** The same as the high dword of a stored qword; the low one is zero. */
const INDEFINITE_HIGH = [0x7ff80000, 0xfff80000];
/** The three pointer dwords of the environment, where this corpus puts it. */
const POINTERS = [0x0c, 0x10, 0x14].map(at=>`mem[0x${(DATA + 0x20 + at).toString(16)}]`);

const bitView = new DataView(new ArrayBuffer(8));
/** @param {number} value @returns {bigint} the value's bit pattern */
const bitsOf = value=>{
    bitView.setFloat64(0, value, true);
    return bitView.getBigUint64(0, true);
};

/**
 * Whether a divergence is the emulator's own rather than the translator's.
 *
 * @param {import('../testing/snapshot.js').Divergence} one
 * @param {import('../testing/snapshot.js').MachineState} oracle
 * @param {import('../testing/snapshot.js').MachineState} subject
 */
function theEmulatorsOwn(one, oracle, subject){
    if (POINTERS.includes(one.name))
    {
        // The translator wrote the zero the recording holds.
        return one.actual === 0;
    }
    if (typeof one.expected === 'number' && typeof one.actual === 'number'
        && INDEFINITE_HIGH.includes(one.expected) && INDEFINITE_HIGH.includes(one.actual))
    {
        return true;
    }
    const register = /^st(\d)$/.exec(one.name);
    if (register === null)
    {
        return false;
    }
    // Read out of the snapshots rather than out of the divergence: a NaN's
    // sign is not in its value.
    const at = Number(register[1]);
    return INDEFINITE.includes(bitsOf(oracle.x87.registers[at]))
        && INDEFINITE.includes(bitsOf(subject.x87.registers[at]));
}

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
        config: {},
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
            byCork += cork.diagnostics().retired - before;
            bySubject += result.retiredSubject;
            const judged = result.divergences.filter(
                one=>!theEmulatorsOwn(one, result.oracleState, result.subjectState));
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
            assert.ok(judged > COUNT / 2, `only ${judged} of ${COUNT} sequences ran`);
            assert.ok(machine.published() > judged / 2,
                `the translator published an entry for ${machine.published()} of ${judged}`);
            assert.ok(share > 0.2, `the translator ran ${share} of the subject's instructions`);
            assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}\n`
                + [...groups].map(([key, one])=>`  ${key} x${one.count}\n    ${one.at}`)
                    .join('\n'));
        }
        finally
        {
            machine.stop();
        }
    });
