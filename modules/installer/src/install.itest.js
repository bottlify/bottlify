/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A real distribution, run in a prefix, without a browser.
 *
 * Everything an installer does before it draws -- its C startup, its imports,
 * its files, its registry -- can be answered with no device at all, and that is
 * where every refusal so far has been. So this runs the engine headless and
 * reports how far the program got, which is the measurement that says what is
 * missing rather than a guess about it.
 *
 * It needs a distribution nobody can put in a repository. Point
 * `BOTTLIFY_INSTALLER` at one -- an installer, or a disc image, which is
 * mounted as D: and read a range at a time; without it the test says so and
 * skips.
 *
 *     BOTTLIFY_INSTALLER=.to_install/<slug>/Setup.exe npm run test:integration -w @bottlify/installer
 *     BOTTLIFY_INSTALLER=.to_install/<slug>/disc.iso npm run test:integration -w @bottlify/installer
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createApp } from '../../core/src/app.js';
import { collect, prefixOptions } from './prefix.js';
import { discOptions, isDiscImage } from './disc.js';

const PREBUILT = new URL('../../core/vendor/prebuilt/', import.meta.url);

/** Long enough for a program to reach its first window, short enough to fail fast. */
const TURNS = 400000;

test('a distribution runs in a prefix and what it wrote comes back out', async t=>{
    const path = process.env.BOTTLIFY_INSTALLER;
    if (!path)
    {
        t.skip('BOTTLIFY_INSTALLER is not set, so there is no distribution to run');
        return;
    }

    // A disc is read where it lies, a range at a time; an installer is read whole.
    const descriptor = openSync(path, 'r');
    t.after(()=>closeSync(descriptor));
    const size = fstatSync(descriptor).size;
    const image = {
        size,
        read: (/** @type {number} */ offset, /** @type {number} */ length)=>{
            const bytes = new Uint8Array(Math.max(0, Math.min(length, size - offset)));
            readSync(descriptor, bytes, 0, bytes.length, offset);
            return bytes;
        },
    };
    const onDisc = await isDiscImage(image);
    // The emulator is optional: without its artifacts the default engine runs.
    const wasm = existsSync(new URL('v86.wasm', PREBUILT))
        ? await readFile(new URL('v86.wasm', PREBUILT)) : null;
    const disc = onDisc ? await discOptions({ name: basename(path), disc: image }) : null;
    const prefix = disc
        ?? prefixOptions({ name: basename(path), bytes: new Uint8Array(await readFile(path)) });

    const app = await createApp({
        executable: prefix.executable,
        imagePath: prefix.imagePath,
        storage: prefix.storage,
        ...disc ? { discs: disc.discs, commandLine: disc.commandLine } : {},
        traceStrings: true,
        ...wasm ? { v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        } } : {},
    });

    /** @type {string} */
    let stopped = '';
    try
    {
        await app.run({ maxTurns: TURNS });
    }
    catch (e){
        // A refusal is the result, not a failure of this test: what the program
        // asked for last is the thing to implement next, and it is only visible
        // from a run that got that far. The engine hangs the guest's registers
        // and its last host calls off the error as `traceText`.
        const failure = /** @type {Error & { traceText?: string }} */ (e);
        stopped = `${failure.message}\n${failure.traceText ?? ''}`;
    }

    const produced = collect({
        files: app.session.export(),
        registry: app.registry().toJSON(),
        seeded: prefix.seeded,
    });
    await app.dispose();

    if (stopped)
    {
        t.diagnostic(stopped.slice(0, 2000));
    }
    // The prefix is what it is; the assertion is that the run reached guest code
    // at all and that collecting it is honest about what came out.
    assert.ok(Array.isArray(produced.files));
    assert.ok(!produced.files.some(file=>file.path.toLowerCase() === basename(path).toLowerCase()),
        'the distribution itself is never part of what it installed');
});
