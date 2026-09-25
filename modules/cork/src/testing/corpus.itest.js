/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every case of the nasm corpus, run on the emulator through this project's
 * own machine (its ROM, its trap port, its snapshot) and compared with the
 * recording real hardware made -- the same result the fork's own CI gets for
 * the pinned build, reached through the harness the translator will be
 * accepted by.
 *
 * Needs the prebuilt emulator (`npm run fetch:v86`) and the corpus
 * (`npm run fetch:corpus`). The emulator is the oracle here and is reached
 * by a relative path into the core's cpu layer, which tests alone may do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createV86Host } from '../../../core/src/layers/cpu/internal/v86-host.js';
import { readFault } from '../../../core/src/layers/cpu/internal/faults.js';
import { FAULT_TRAP_BASE } from '../../../core/src/layers/cpu/internal/boot-rom.js';
import { restore, snapshot } from './snapshot.js';
import { features } from '../wasm/features.js';
import {
    BSS, BSS_SIZE, HEADER, HEADER_SIZE, TEXT, TEXT_SIZE, diffFixture, loadCorpus, runCase,
} from './corpus.js';

const PREBUILT = new URL('../../../core/vendor/prebuilt/', import.meta.url);
const CORPUS = new URL('../../vendor/nasm-corpus.json.gz', import.meta.url);
const TRAP_PORT = 0xb077;
const ENTRY_VECTOR = 0x7000;
const INITIAL_STACK = 0x200000;

/** Which cases to run, by name, for a single case's investigation. */
const ONLY = new RegExp(process.env.CORPUS_ONLY ?? '', 'i');

/**
 * Where the pinned emulator itself differs from the hardware recording.
 *
 * The corpus is the hardware's word, and the emulator is not perfect: these
 * are its own divergences, found by this very run, each named with what it
 * is. A case listed here may diverge on the field named and on nothing else;
 * a case not listed may not diverge at all. A fixed emulator makes an entry
 * here obsolete, which the run reports so the entry can go; `seen` says
 * whether this host shows it at all.
 */
const EMULATOR_KNOWN = [
    // sqrtps/sqrtpd/sqrtss/sqrtsd of a negative: the hardware answers the
    // negative "real indefinite" NaN (0xffc00000 / 0xfff80000…), the
    // emulator the host's default NaN -- positive where the host's is (arm64),
    // the hardware's own where it is not (x86-64). Same value, other sign bit.
    { cases: /^(gen_(0f|660f|f30f|f20f)51_0_\d+|sse-packed-edge)$/, fields: /^xmm\d\.int32\[\d\]$/,
        reason: 'sqrt of a negative: the NaN\'s sign', seen: !features().defaultNaNNegative },
    // fild qword of an integer beyond 53 bits: the hardware holds it to 64
    // bits, the emulator's x87 is an f64 and rounds it.
    { cases: /^gen_df_5_(40|42|43)$/, fields: /^st0$/,
        reason: 'fild m64 past 53 bits: f64 x87', seen: true },
];

const missing = [PREBUILT.href + 'v86.wasm', CORPUS.href]
    .filter(url=>!existsSync(new URL(url)));

test('the corpus passes on the emulator through the harness',
    { skip: missing.length > 0 && `missing ${missing.join(', ')}`, timeout: 30 * 60 * 1000 },
    async()=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const host = await createV86Host({
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            memorySize: 64 * 1024 * 1024,
            trapPort: TRAP_PORT,
            entryVector: ENTRY_VECTOR,
            initialStack: INITIAL_STACK,
        });
        const { commit, cases } = loadCorpus(await readFile(CORPUS));
        const selected = cases.filter(one=>ONLY.test(one.name));

        // The machine as it stands after boot: on the ROM's jump into guest
        // code, registers clear, the FPU at reset, and the spans a case
        // touches -- its code, its header, its data and stack -- all zero.
        const spans = [
            { address: HEADER, length: HEADER_SIZE },
            { address: TEXT, length: TEXT_SIZE },
            { address: BSS, length: BSS_SIZE },
        ];
        const pristine = snapshot(host, spans);
        const caseHost = {
            ...host,
            /** @param {number} instructions */
            step: instructions=>host.cpu().run_slice(instructions) >>> 0,
        };

        /** @type {{ name: string, divergences: import('./snapshot.js').Divergence[] }[]} */
        const failures = [];
        /** @type {string[]} */
        const known = [];
        let exceptions = 0;
        const started = Date.now();
        for (const one of selected)
        {
            restore(host, pristine);
            const outcome = runCase(caseHost, one, {
                entryVector: ENTRY_VECTOR,
                faultTrapBase: FAULT_TRAP_BASE,
                faultEip: (vector, esp)=>readFault(vector, esp, host.readU32).eip,
            });
            exceptions += outcome.exception ? 1 : 0;
            const divergences = diffFixture(one.expected, outcome);
            if (divergences.length === 0)
            {
                continue;
            }
            const expectedOf = EMULATOR_KNOWN.find(entry=>entry.cases.test(one.name));
            if (expectedOf && divergences.every(d=>expectedOf.fields.test(d.name)))
            {
                known.push(one.name);
                continue;
            }
            failures.push({ name: one.name, divergences: divergences.slice(0, 6) });
        }
        host.stop();

        console.log(`corpus ${commit.slice(0, 8)}: ${selected.length} cases, ${exceptions} died as`
            + ` recorded, ${known.length} diverged as the emulator is known to, ${failures.length}`
            + ` diverged otherwise, ${((Date.now() - started) / 1000).toFixed(1)} s`);
        const report = failures.slice(0, 40).map(({ name, divergences })=>`${name}: ${divergences
            .map(d=>`${d.name} expected ${String(d.expected)} got ${String(d.actual)}`)
            .join('; ')}`);
        assert.equal(failures.length, 0,
            `${failures.length} cases diverged:\n${report.join('\n')}`);
        assert.ok(selected.length > 0, 'the selection ran something');
        if (ONLY.source === '(?:)')
        {
            // Every known divergence is still there; one that has gone is an
            // entry to remove, not a pass to enjoy quietly.
            for (const entry of EMULATOR_KNOWN.filter(one=>one.seen))
            {
                assert.ok(known.some(name=>entry.cases.test(name)),
                    `no case diverged as "${entry.reason}" any more: remove the entry`);
            }
        }
    });
