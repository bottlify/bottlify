/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What translating makes of garbage, a byte count an instruction: a game's level load
 * forms and emits thousands of regions, and what each leaves behind is collected on the
 * thread that runs the program or on the translator's. Measured on the benchmark's own
 * images, the 32-bit and the 64-bit build, every function a direct call names formed
 * from its entry, with V8's sampling heap profiler (`tools/fixtures/allocation.mjs`);
 * each bound sits above what the stage makes now with room for the sampler, and below
 * what it made before its records were shared or reused. Decoding: an instruction's
 * record, its operands and prefixes; forming: the regions, sharing what forming found
 * (`formShared`) as a batch's regions do; emitting: their functions, in batches as a
 * translator worker emits them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { allocationPerCall, bytesPerCall, heapPerCall } from '../../../tools/fixtures/allocation.mjs';
import { decode, MODE_64 } from './decode/decoder.js';
import { formRegion, formShared } from './region.js';
import { emitBatch } from './runtime/emit-built.js';
import { ownLayout } from './runtime/layout.js';

const BASE = 0x400000;
/** Features fixed rather than probed, as the emitted-bytes test fixes them. */
const FEATURES = { simd: true, tailCalls: true, defaultNaNNegative: false };
/** A translator worker's batch, at most (`translators.js`), and the regions emitted. */
const BATCH = 32;
const EMITTED = 4 * BATCH;
/** What each stage may make an instruction, by image. */
const BOUNDS = {
    x87: { decode: 260, form: 700, emit: 5300 },
    x64: { decode: 260, form: 800, emit: 4000 },
};

/**
 * A benchmark image loaded at its base: its bytes, its code's span, and the entries of
 * the functions its direct calls name (aligned as its compiler aligns a function).
 *
 * @param {'x87' | 'x64'} variant
 */
function imageOf(variant){
    const file = readFileSync(new URL(`../bench/bin/bench-${variant}.exe`, import.meta.url));
    const header = file.readUInt32LE(0x3c);
    const sections = file.readUInt16LE(header + 6);
    const image = new Uint8Array(0x40000);
    let text = [0, 0];
    for (let at = header + 24 + file.readUInt16LE(header + 20), i = 0; i < sections;
        i++, at += 40)
    {
        const address = file.readUInt32LE(at + 12);
        const raw = file.readUInt32LE(at + 20);
        const size = file.readUInt32LE(at + 16);
        if (address + size <= image.length)
        {
            image.set(file.subarray(raw, raw + size), address);
        }
        if (file.toString('latin1', at, at + 5) === '.text')
        {
            text = [BASE + address, BASE + address + file.readUInt32LE(at + 8)];
        }
    }
    const read = (/** @type {number} */ address)=>image[address - BASE] ?? 0;
    /** @type {Set<number>} */
    const entries = new Set();
    for (let at = text[0]; at < text[1] - 5; at++)
    {
        const target = (at + 5 + (read(at + 1) | read(at + 2) << 8 | read(at + 3) << 16
            | read(at + 4) << 24)) >>> 0;
        if (read(at) === 0xe8 && target >= text[0] && target < text[1] && (target & 15) === 0)
        {
            entries.add(target);
        }
    }
    const translatable = (/** @type {number} */ address)=>address >= text[0] && address < text[1];
    const wide = variant === 'x64';
    const mode = wide ? MODE_64 : undefined;
    const regions = [...entries].sort((a, b)=>a - b)
        .map(entry=>formRegion(read, entry, { translatable, mode }));
    let instructions = 0;
    for (const { blocks } of regions)
    {
        for (const block of blocks)
        {
            instructions += block.instructions.length;
        }
    }
    return { read, translatable, mode, wide, regions, instructions };
}

for (const variant of /** @type {const} */ (['x87', 'x64']))
{
    const { read, translatable, mode, wide, regions, instructions } = imageOf(variant);
    const perInstruction = (/** @type {number} */ perRegion)=>perRegion * regions.length
        / instructions;

    const bound = BOUNDS[variant];

    test(`decoding an instruction of the ${variant} image makes at most ${bound.decode} bytes`,
        async t=>{
            const at = regions.flatMap(({ blocks })=>blocks.flatMap(block=>block.instructions
                .filter(instruction=>instruction.op !== 'crt').map(instruction=>instruction.eip)));
            let next = 0;
            const bytes = await bytesPerCall(()=>{
                decode(read, at[next], mode);
                next = next + 1 === at.length ? 0 : next + 1;
            }, { calls: at.length });
            t.diagnostic(`${bytes.toFixed(0)} bytes an instruction`);
            assert.ok(bytes < bound.decode, `${bytes.toFixed(0)} bytes an instruction`);
        });

    test(`forming the ${variant} image's regions makes at most ${bound.form} bytes an `
        + 'instruction', async t=>{
        let next = 0;
        /** @type {ReturnType<typeof formShared>} */
        let shared = formShared();
        const bytes = await bytesPerCall(()=>{
            if (next === 0)
            {
                shared = formShared();
            }
            formRegion(read, regions[next].entry, { translatable, mode, shared });
            next = next + 1 === regions.length ? 0 : next + 1;
        }, { calls: regions.length });
        t.diagnostic(`${perInstruction(bytes).toFixed(0)} bytes an instruction`);
        assert.ok(perInstruction(bytes) < bound.form,
            `${perInstruction(bytes).toFixed(0)} bytes an instruction`);
    });

    test(`emitting the ${variant} image's regions makes at most ${bound.emit} bytes an `
        + 'instruction', async t=>{
        const layout = ownLayout({ ramSize: 64 << 20,
            ...wide ? { ramBase: 0, bits: 64 } : {} });
            // The first batches alone: emitting is the slow stage, and these are a few
            // hundred functions of every kind the image has.
        const emitted = regions.slice(0, EMITTED);
        const batches = Math.ceil(emitted.length / BATCH);
        let made = 0;
        for (const { blocks } of emitted)
        {
            for (const block of blocks)
            {
                made += block.instructions.length;
            }
        }
        let next = 0;
        // The heap alone: a batch collects garbage within itself, so no call of
        // it runs clear of a collection and its buffers cannot be read here -
        // the next test reads them a region at a time.
        const bytes = await heapPerCall(()=>{
            emitBatch(emitted.slice(next * BATCH, (next + 1) * BATCH)
                .map(region=>({ region, entryTop: 0 })), layout, FEATURES,
            { hash: true, trapPort: 0xb077, resume: true, callReturn: true });
            next = next + 1 === batches ? 0 : next + 1;
        }, { calls: batches });
        const perEmitted = bytes * batches / made;
        t.diagnostic(`${perEmitted.toFixed(0)} bytes an instruction`);
        assert.ok(perEmitted < bound.emit, `${perEmitted.toFixed(0)} bytes an instruction`);
    });

    test(`emitting one of the ${variant} image's regions makes no buffer but its module`,
        async t=>{
            const layout = ownLayout({ ramSize: 64 << 20,
                ...wide ? { ramBase: 0, bits: 64 } : {} });
            const emitted = regions.slice(0, EMITTED);
            /** @param {number} at */
            const emitOne = at=>emitBatch([{ region: emitted[at], entryTop: 0 }], layout, FEATURES,
                { hash: true, trapPort: 0xb077, resume: true, callReturn: true });
            // The module a call answers is what it is for: the buffers it may
            // make are that module's bytes, as they average over these regions.
            let modules = 0;
            for (let at = 0; at < emitted.length; at++)
            {
                modules += emitOne(at).module.buffer.byteLength;
            }
            const modulePerCall = modules / emitted.length;
            let next = 0;
            const { buffers } = await allocationPerCall(()=>{
                emitOne(next);
                next = next + 1 === emitted.length ? 0 : next + 1;
            }, { calls: emitted.length });
            t.diagnostic(`${buffers.toFixed(0)} buffer bytes a region beside its module of`
                + ` ${modulePerCall.toFixed(0)}`);
            assert.ok(buffers <= modulePerCall * 1.25, `${buffers.toFixed(0)} buffer bytes a region`
                + ` beside its module of ${modulePerCall.toFixed(0)}`);
        });
}
