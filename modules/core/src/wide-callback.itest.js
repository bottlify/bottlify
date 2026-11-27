/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Callbacks into an image that stays past 4 GiB: window64.exe (a window
 * procedure the system calls, a WM_CREATE pointer, the window's longs) with
 * its relocations stripped, as a 64-bit game ships at 0x140000000, runs over
 * a wide window - and the system's calls into its procedure must reach the
 * procedure, not the low alias of its address (board tab x64, X10; audit b6:
 * the callback stub starts with `mov eax, eax`).
 *
 * FAILING lists what fails today with why; a check that starts to pass
 * fails the test too, so the list only shrinks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowMemory64 } from '../../cork/src/testing/memory64.js';
import { createApp } from './app.js';
import { fixedPastFourGiB } from './fixed-base.fixture.js';

const FIXTURE = new URL('../test/fixtures/window64.exe', import.meta.url);

/** What fails today: the program's checks by name, or 'ran' for a run that did not end. */
const FAILING = new Map();

test('a window procedure in an image past 4 GiB is called where it is', { timeout: 150000 },
    async t=>{
        allowMemory64();
        const bytes = fixedPastFourGiB(new Uint8Array(await readFile(FIXTURE)));
        const app = await createApp({ executable: bytes });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
        /** @type {number | string} */
        let code;
        try
        {
            code = await app.run({ timeoutMs: 90000 });
        }
        catch (e){
            code = `stopped: ${/** @type {Error} */ (e).message}`;
        }
        const lines = output.join('').split(/\r?\n/).filter(line=>line.length > 0);
        const failed = lines.filter(line=>/^FAIL\b|^not ok\b/i.test(line))
            .map(line=>line.replace(/:.*$/, '').replace(/^(FAIL|not ok)\s*/i, '')).sort();
        const ran = typeof code === 'number';
        const seen = [...(ran ? [] : ['ran']), ...failed].sort();
        assert.deepEqual(seen, [...FAILING.keys()].sort(),
            `what fails differs from FAILING (exit ${code}):\n${lines.join('\n')}`);
    });
