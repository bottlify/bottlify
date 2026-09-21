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
 */
const INDEFINITE = [0x7ff8000000000000n, 0xfff8000000000000n];
/** The same as the high dword of a stored qword; the low one is zero. */
const INDEFINITE_HIGH = [0x7ff80000, 0xfff80000];
/** The condition codes of the status word: C0, C1, C2 and C3. */
const CONDITION = 0x100 | 0x200 | 0x400 | 0x4000;
/** @param {number} address */
const word = address=>`mem[0x${address.toString(16)}]`;
/** The qword the pool's store writes, and the environment's own fields. */
const STORED_HIGH = word(DATA + 4);
const ENVIRONMENT_STATUS = word(DATA + 0x24);
const ENVIRONMENT_TAG = word(DATA + 0x28);
const POINTERS = [0x2c, 0x30, 0x34].map(at=>word(DATA + at));

const bitView = new DataView(new ArrayBuffer(8));
/** @param {number} value @returns {bigint} the value's bit pattern */
const bitsOf = value=>{
    bitView.setFloat64(0, value, true);
    return bitView.getBigUint64(0, true);
};
/** @param {bigint} bits */
const indefinite = bits=>INDEFINITE.includes(bits);

/**
 * Whether a held register of either snapshot is one of the two indefinites:
 * the two runs are then in the family a masked fault made, and what a compare
 * read out of them is not a finding about the translator.
 *
 * @param {import('../testing/snapshot.js').MachineState} oracle
 * @param {import('../testing/snapshot.js').MachineState} subject
 */
function indefiniteBetween(oracle, subject){
    for (let at = 0; at < 8; at++)
    {
        const free = (oracle.x87.empty >>> at & 1) === 1
            || (subject.x87.empty >>> at & 1) === 1;
        if (!free && (indefinite(bitsOf(oracle.x87.registers[at]))
            || indefinite(bitsOf(subject.x87.registers[at]))))
        {
            return true;
        }
    }
    return false;
}

/**
 * Whether a divergence is the emulator's own rather than the translator's.
 *
 * @param {import('../testing/snapshot.js').Divergence} one
 * @param {import('../testing/snapshot.js').MachineState} oracle
 * @param {import('../testing/snapshot.js').MachineState} subject
 * @param {Set<string>} forms  the sequence's own: a condition code is only
 *     the emulator's own where a form that can leave one there ran
 */
function theEmulatorsOwn(one, oracle, subject, forms){
    const { expected, actual } = one;
    if (POINTERS.includes(one.name))
    {
        return true;
    }
    if (typeof expected !== 'number' || typeof actual !== 'number')
    {
        return false;
    }
    if (one.name === STORED_HIGH)
    {
        return INDEFINITE_HIGH.includes(expected) || INDEFINITE_HIGH.includes(actual);
    }
    if (one.name === ENVIRONMENT_TAG)
    {
        // The reserved half is the same on both, so what differs is the tag
        // the two derived from registers they left differently.
        return expected >>> 16 === 0xffff && actual >>> 16 === 0xffff;
    }
    // The status word, and the copies of it the sequence may have left: the
    // environment's own, sixteen bits up in its dword, and ax after `fnstsw`.
    const copy = one.name === 'x87.status' ? 0
        : one.name === 'eax' && forms.has('fnstsw ax') ? 0
            : one.name === ENVIRONMENT_STATUS ? 0 : -1;
    if (copy >= 0)
    {
        const differs = expected ^ actual;
        // Nothing outside the copy, and nothing inside it but a condition
        // code -- and one only where a form that can leave it there ran.
        return (differs & ~(0xffff << copy)) === 0
            && (differs & ~(CONDITION << copy)) === 0
            && (forms.has('fnclex') || indefiniteBetween(oracle, subject));
    }
    const register = /^st(\d)$/.exec(one.name);
    if (register === null)
    {
        return false;
    }
    // Read out of the snapshots rather than out of the divergence: a NaN's
    // sign is not in its value.
    const at = Number(register[1]);
    return indefinite(bitsOf(oracle.x87.registers[at]))
        || indefinite(bitsOf(subject.x87.registers[at]));
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
