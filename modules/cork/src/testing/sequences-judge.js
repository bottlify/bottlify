/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The sequence corpus: interactions between instructions, translated code
 * judged live against cork's own model of each instruction.
 *
 * The single-instruction corpus judges one instruction at a time; what
 * translated code carries from one instruction to the next -- the x87 stack
 * held in a region's locals, the MMX registers over the x87 ones, MXCSR and
 * the SSE lanes beside them -- shows only across several. This file generates
 * sequences of two to eight instructions from a pool of hand-encoded forms
 * (`sequences.js`) and runs each from one state twice: on the model, the
 * interpreter running `ir.js`, `ir-x87.js` and `ir-simd.js` and nothing else,
 * and on the translator over a host of its own. It compares everything a
 * program can read: every register, the flags, the x87 block with its top,
 * its empty mask and its status word, the SSE registers and MXCSR, and the
 * memory the sequence wrote. Both sides hold the x87 registers in cork's one
 * f64 form, so every field is judged bit for bit and nothing is excused.
 *
 * A sequence is entered with the x87 stack in the shape a preamble left it in,
 * so a region is compiled for tops and permutations other than the empty stack
 * a fresh processor has -- the entry key is part of where a defect hides. A
 * run is repeatable from its seed and a diverging sequence is named by the seed
 * and its index; the divergences are grouped by the shortest sequence that
 * still reproduces each, found by dropping instructions while the divergence
 * stays.
 *
 * Run in parts, `emit/sequences-N.itest.js`: every part generates the whole
 * run from the seed and judges the sequences whose index is its own modulo the
 * number of parts, so the sequences and their names are those of one run, and
 * a part stays inside the minute the runner gives a file.
 *
 * `SEQUENCES` raises the count, `SEQUENCE_SEED` names another run,
 * `SEQUENCE_SHRINK` how many of the diverging sequences are minimised.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../../core/src/layers/cpu/internal/cork-host.js';
import * as engine from '../index.js';
import { PageFlag } from '../runtime/pages.js';
import { restore, snapshot } from './snapshot.js';
import { replaySlice, retireExactly } from './differential.js';
import {
    CODE, DATA, DATA_BYTES, REGISTERS, SETUP, SPANS, XMM, bodyOf, minimise, namesOf, preambleOf,
    programBytes, random,
} from './sequences.js';

const SEED = Number(process.env.SEQUENCE_SEED ?? 0xc05eed);
const COUNT = Number(process.env.SEQUENCES ?? 20_000);
/** Diverging sequences shortened to their minimal pair; each costs a run per drop. */
const SHRINK = Number(process.env.SEQUENCE_SHRINK ?? 48);
/** Instructions a sequence may retire before it is one this corpus does not judge. */
const LIMIT = 256;
/** Guest RAM: the code, the preamble, the data and the stack all lie below 4 MiB. */
const MEMORY = 4 << 20;

/**
 * The cork host, with the fields this judge reaches.
 *
 * @typedef {import('./snapshot.js').SnapshotHost & {
 *     runSlice: (instructions: number) => number,
 *     halted: () => boolean,
 *     wake: () => void,
 *     cork: () => ReturnType<typeof import('../runtime/runtime.js').createCorkRuntime>,
 *     wasmRetired?: () => number,
 * }} CorkHost
 */

/**
 * @param {import('../../../core/src/layers/cpu/engine.js').EngineConfig} cork
 * @param {{ executors?: number, executor?: number }} [where]  which executor of a memory
 *     shared by several the host is (the first by default)
 * @param {import('../../../core/src/layers/cpu/engine.js').EngineEnv['features']} [features]
 *     another host's, the translation made as there
 * @returns {CorkHost}
 */
const hostOf = (cork, where = {}, features = undefined)=>/** @type {CorkHost} */ (
    createCorkHost({
        engine, memorySize: MEMORY, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: REGISTERS.esp, cork, ...where, ...(features ? { features } : {}),
    }));

/**
 * Makes the model and the translator, each over a host of its own, and answers
 * a judge that runs one sequence on both from one state.
 *
 * @param {{ pool?: import('./sequences.js').Form[], cork?: Record<string, unknown>,
 *     executor?: { executors: number, executor: number },
 *     features?: import('../../../core/src/layers/cpu/engine.js').EngineEnv['features'] }}
 *     [given]  pool: the forms the sequences index (`POOL` by default); cork: the
 *     translator's settings besides the judge's own (the atomic variant's judge sets
 *     `atomic`); executor: which executor of a shared memory the translator's host is (the
 *     executors' judge); features: the host the translator makes code for, another than
 *     this one (an arm64 one's default NaN is positive)
 */
export function createJudge({ pool = undefined, cork = {}, executor = undefined,
    features = undefined } = {})
{
    // The model is the JavaScript interpreter alone: the wasm tier is an
    // implementation of the instructions of its own, not their description.
    const model = hostOf({ translate: false, wasmInterpreter: false });
    // The translator with nothing relaxed, and fed by `noteHot` alone: a
    // candidate the runtime or the host's interpreter noted of its own --
    // an untranslated exit counted, a hot start -- would be formed for the
    // bytes a later sequence put at the same address, or crowd that
    // sequence's own out of a batch, and a run is only repeatable from its
    // seed with the one feed. What a region leaves runs on the same
    // interpreter as the model, so a divergence is the translator's.
    const translator = hostOf({
        precise: true,
        missThreshold: Number.POSITIVE_INFINITY,
        hotThreshold: Number.POSITIVE_INFINITY,
        wasmInterpreter: false,
        ...cork,
    }, executor, features);
    const runtime = translator.cork();

    // A fresh FPU with its registers zeros, so an MMX read of one is a known
    // pair of words; the SSE registers, the data and the integer registers
    // the pool's operands read.
    model.restoreX87State({
        top: 0, empty: 0xff, control: 0x37f, status: 0,
        registers: new Float64Array(8), raw: new Uint8Array(128),
    });
    XMM.forEach((words, index)=>model.writeXmm(index, Uint32Array.from(words)));
    model.writeMxcsr(0x1f80);
    model.writePhysical(DATA, DATA_BYTES);
    for (const [name, value] of Object.entries(REGISTERS))
    {
        model.writeReg32(name, value);
    }
    model.writeReg32('eflags', 2);
    const pristine = snapshot(model, SPANS);

    const oracle = { ...model, step: model.runSlice };
    const subject = { ...translator, step: translator.runSlice };

    /** The preamble standing at SETUP; written again only when it changes. */
    let written = '';
    let published = 0;
    let bySubject = 0;
    let byTranslator = 0;
    let byTier = 0;

    return {
        /** Sequences the translator published an entry for. */
        published: ()=>published,
        /** Instructions the translator ran, over the instructions the subject ran. */
        share: ()=>(bySubject > 0 ? byTranslator / bySubject : 0),
        /** Instructions the interpreter tier in wasm ran, over the instructions the subject ran. */
        tierShare: ()=>(bySubject > 0 ? byTier / bySubject : 0),
        diagnostics: ()=>runtime.diagnostics(),
        /**
         * Runs one sequence on the model and on the translator, from one
         * state, and answers what differs; null when the sequence is not one
         * this corpus judges (it did not reach its halt inside the limit).
         *
         * @param {number[]} body   the judged sequence, as pool indices
         * @param {number[]} setup  the x87 shape it is entered with
         * @returns {Promise<ReturnType<typeof replaySlice> | null>}
         */
        async judge(body, setup){
            restore(model, pristine);
            if (setup.length > 0)
            {
                const key = setup.join(',');
                if (key !== written)
                {
                    model.writePhysical(SETUP, programBytes(setup, pool));
                    written = key;
                }
                model.writeReg32('eip', SETUP);
                model.wake();
                retireExactly(model.runSlice, model.halted, LIMIT);
            }
            const code = programBytes(body, pool);
            model.writePhysical(CODE, code);
            model.writeReg32('eip', CODE);
            const state = snapshot(model, SPANS);
            model.wake();
            const instructions = retireExactly(model.runSlice, model.halted, LIMIT);
            if (instructions === 0 || instructions >= LIMIT)
            {
                return null;
            }
            translator.writePhysical(CODE, code);
            // One code page serves every sequence, so it is overwritten far
            // more often than any program overwrites its own code: the
            // volatility that would leave it untranslated -- and the corpus
            // silently judging nothing -- is cleared each time.
            runtime.pages.clear(CODE >>> 12, PageFlag.VOLATILE);
            runtime.noteHot(CODE, state.x87.top);
            const made = await runtime.translatePending();
            published += made > 0 ? 1 : 0;
            const before = runtime.diagnostics().retired;
            const tierBefore = translator.wasmRetired?.() ?? 0;
            const result = replaySlice({ oracle, subject, state, instructions, spans: SPANS });
            byTranslator += runtime.diagnostics().retired - before;
            byTier += (translator.wasmRetired?.() ?? 0) - tierBefore;
            bySubject += result.retiredSubject;
            return result;
        },
    };
}

/**
 * One part of the run: the sequences whose index is `part` modulo `of`.
 *
 * @param {number} part @param {number} of
 * @param {import('../../../core/src/layers/cpu/engine.js').EngineEnv['features']} [features]
 *     the host the translator makes code for, another than this one (`createJudge`)
 */
export function testSequences(part, of, features = undefined){
    test(`translated sequences of x87, MMX and SSE leave what the instruction model leaves`
        + `${features ? ' as another host translates them' : ''} (part ${part + 1} of ${of})`,
    async()=>{
        const machine = createJudge({ features });
        const started = Date.now();
        const next = random(SEED);
        /** @type {Map<string, { count: number, at: string, what: string }>} */
        const groups = new Map();
        /** @type {string[]} */
        const failures = [];
        /** @param {import('./snapshot.js').Divergence[]} divergences */
        const what = divergences=>divergences.slice(0, 5)
            .map(one=>`${one.name} ${String(one.expected)} != ${String(one.actual)}`)
            .join('; ');
        /**
         * @param {number} index @param {number[]} body @param {number[]} setup
         * @param {import('./snapshot.js').Divergence[]} divergences
         */
        const render = (index, body, setup, divergences)=>`seed ${SEED} #${index}`
            + `${setup.length > 0 ? ` [${namesOf(setup)}]` : ''} ${namesOf(body)}: `
            + what(divergences);
        let judged = 0;
        let diverged = 0;
        let shrunk = 0;
        let unrun = 0;
        for (let index = 0; index < COUNT; index++)
        {
            const body = bodyOf(next);
            const setup = preambleOf(next);
            if (index % of !== part)
            {
                continue;
            }
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
            // Judged again on its own: the group is named by what the shortest
            // sequence reproducing the divergence actually shows, not by what
            // the longer one it was found in showed.
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
            + `instructions the translator's, ${shrunk} minimised into ${groups.size} groups, `
            + `seed ${SEED}, ${((Date.now() - started) / 1000).toFixed(1)} s`
            + `${ranked.length > 0 ? '; ' : ''}`
            + ranked.slice(0, 10).map(([key, one])=>`${key} x${one.count}`).join(' | ')
            + `${leftOut === '' ? '' : `; left out: ${leftOut}`}`);
        assert.ok(judged > COUNT / of * 0.9, `only ${judged} of ${COUNT / of} sequences ran`);
        // Every sequence translates whole, x87, MMX and SSE in one region: a
        // regression that cuts a region where the classes meet drops both of
        // these.
        assert.ok(machine.published() > judged * 0.98,
            `the translator published an entry for ${machine.published()} of ${judged}`);
        assert.ok(share > 0.85, `the translator ran ${share} of the subject's instructions`);
        assert.equal(diverged, 0, `${diverged} diverged:\n${failures.join('\n')}\n`
            + [...groups].map(([key, one])=>`  ${key} x${one.count}\n    ${one.at}`)
                .join('\n'));
    });
}
