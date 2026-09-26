/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The differential driver proved on the emulator against itself, before any
 * translator exists: every corpus case replayed with the emulator as both
 * oracle and subject must diff to nothing, and a subject that deliberately
 * changes one word must be reported with that word and nothing else. A
 * driver that cannot pass this would blame the translator for its own
 * mistakes.
 *
 * Needs the prebuilt emulator and the corpus, like the corpus itest. The
 * oracle runs with the emulator's compiler off, so a slice is bounded to the
 * instruction rather than to a compiled block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithout } from './fetched.js';
import { readFile } from 'node:fs/promises';
import { createV86Host } from '../../../core/src/layers/cpu/internal/v86-host.js';
import { restore, snapshot } from './snapshot.js';
import { replaySlice, retireExactly } from './differential.js';
import { BSS, BSS_SIZE, HEADER, HEADER_SIZE, TEXT, TEXT_SIZE, loadCorpus } from './corpus.js';

const PREBUILT = new URL('../../../core/vendor/prebuilt/', import.meta.url);
const CORPUS = new URL('../../vendor/nasm-corpus.json.gz', import.meta.url);
const ENTRY_VECTOR = 0x7000;

/** @param {number} value */
const u32 = value=>Uint8Array.from(
    [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff]);

test('the emulator replayed against itself diffs to nothing on every corpus case',
    { skip: skipWithout(new URL('v86.wasm', PREBUILT), CORPUS), timeout: 30 * 60 * 1000 },
    async()=>{
        const wasm = await readFile(new URL('v86.wasm', PREBUILT));
        const host = await createV86Host({
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            memorySize: 64 * 1024 * 1024,
            trapPort: 0xb077,
            entryVector: ENTRY_VECTOR,
            initialStack: 0x200000,
            // The compiler off: a slice then stops on the instruction asked.
            jit: { 0: 1 },
        });
        const { cases } = loadCorpus(await readFile(CORPUS));
        const spans = [
            { address: HEADER, length: HEADER_SIZE },
            { address: TEXT, length: TEXT_SIZE },
            { address: BSS, length: BSS_SIZE },
        ];
        const pristine = snapshot(host, spans);
        const executor = {
            /** @param {number} instructions */
            step: instructions=>host.cpu().run_slice(instructions) >>> 0,
            halted: host.halted,
            wake: host.wake,
        };
        const oracle = { ...host, ...executor };
        // A fault stub halts after reporting; the trap itself needs no answer.
        host.onTrap(()=>{});

        let replayed = 0;
        let instructionsTotal = 0;
        /** @type {string[]} */
        const failures = [];
        const started = Date.now();
        for (const one of cases)
        {
            // The case's start: the pristine machine with the image placed and
            // the ROM pointed at its entry. Taken as a state so both runs
            // begin from exactly it.
            restore(host, pristine);
            for (const { address, bytes } of one.segments)
            {
                host.writePhysical(address, bytes);
            }
            host.writePhysical(ENTRY_VECTOR, u32(one.entry));
            const state = snapshot(host, spans);

            // How long the case is: run it once to its halt.
            host.wake();
            const instructions = retireExactly(executor.step, host.halted, 1_000_000);
            if (instructions === 0 || instructions >= 1_000_000)
            {
                failures.push(`${one.name}: ran ${instructions} instructions`);
                continue;
            }
            const result = replaySlice({ oracle, subject: executor, state, instructions, spans });
            replayed++;
            instructionsTotal += instructions;
            if (result.divergences.length > 0)
            {
                failures.push(`${one.name}: ${result.divergences.slice(0, 4)
                    .map(d=>`${d.name} expected ${String(d.expected)} got ${String(d.actual)}`)
                    .join('; ')}`);
            }
        }
        console.log(`replay ${replayed} cases, ${instructionsTotal} instructions, `
            + `${failures.length} diverged, ${((Date.now() - started) / 1000).toFixed(1)} s`);
        assert.equal(failures.length, 0,
            `${failures.length} diverged:\n${failures.slice(0, 40).join('\n')}`);

        // The one deliberate divergence: a subject that, after the same run,
        // writes a word into the data area, reported as that word alone.
        const one = cases.find(c=>c.name === 'jump') ?? cases[0];
        restore(host, pristine);
        for (const { address, bytes } of one.segments)
        {
            host.writePhysical(address, bytes);
        }
        host.writePhysical(ENTRY_VECTOR, u32(one.entry));
        const state = snapshot(host, spans);
        host.wake();
        const instructions = retireExactly(executor.step, host.halted, 1_000_000);
        const tampering = {
            ...executor,
            /** @param {number} count */
            step: count=>{
                const ran = executor.step(count);
                if (host.halted())
                {
                    host.writePhysical(BSS, u32(0x1234));
                }
                return ran;
            },
        };
        const { divergences } = replaySlice({
            oracle, subject: tampering, state, instructions, spans,
        });
        assert.deepEqual(divergences,
            [{ name: `mem[0x${BSS.toString(16)}]`, expected: 0, actual: 0x1234 }]);
        host.stop();
    });
