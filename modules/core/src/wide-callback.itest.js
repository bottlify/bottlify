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

const FIXTURE = new URL('../test/fixtures/window64.exe', import.meta.url);

/** What fails today: the program's checks by name, or 'ran' for a run that did not end. */
const FAILING = new Map();

/**
 * The fixture as a game ships: no relocations, its base fixed past 4 GiB.
 *
 * @param {Uint8Array} bytes
 */
function stripRelocations(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const pe = view.getUint32(0x3c, true);
    const optional = pe + 24;
    assert.ok(view.getBigUint64(optional + 24, true) >= 2n ** 32n, 'linked past 4 GiB');
    view.setUint16(pe + 22, view.getUint16(pe + 22, true) | 1, true); // RELOCS_STRIPPED
    view.setBigUint64(optional + 112 + 5 * 8, 0n, true); // no base relocation directory
    view.setUint16(optional + 70, view.getUint16(optional + 70, true) & ~0x40, true);
    return bytes;
}

test('a window procedure in an image past 4 GiB is called where it is', { timeout: 150000 },
    async t=>{
        allowMemory64();
        const bytes = stripRelocations(new Uint8Array(await readFile(FIXTURE)));
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
