/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `windows: 'auto'`: the run is the Windows the program was made for
 * (`windowsFor`), chosen once from its image, and says which and why.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/**
 * A program that imports one function of `library` and exits with 7.
 *
 * @param {string} library @param {string} name
 */
const importing = (library, name)=>buildExe({
    imports: { [library]: [name], 'KERNEL32.dll': ['ExitProcess'] },
    code: ({ iat })=>[0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
});

test('a program importing the Windows Runtime runs on Windows 10, and the run says why',
    { timeout: 60_000 }, async t=>{
        // A Unity player imports the Windows Runtime's API sets statically: on
        // the default Windows (XP) it would not start.
        const app = await createApp({
            executable: importing('api-ms-win-core-winrt-l1-1-0.dll', 'RoInitialize'),
            windows: 'auto' });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        const said = [];
        app.on('windows', (/** @type {any} */ chosen)=>said.push(chosen));
        assert.equal(await app.run({ timeoutMs: 30_000 }), 7, 'it started and ran to its exit');
        assert.deepEqual(said, [{ windows: 'win10',
            because: 'it imports api-ms-win-core-winrt-l1-1-0.dll' }]);
    });

test('a program that names no newer Windows runs on the one its header names', { timeout: 60_000 },
    async t=>{
        const app = await createApp({ executable: importing('USER32.dll', 'MessageBeep'),
            windows: 'auto' });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        const said = [];
        app.on('windows', (/** @type {any} */ chosen)=>said.push(chosen));
        assert.equal(await app.run({ timeoutMs: 30_000 }), 7);
        assert.equal(said.length, 1);
        assert.match(said[0].because, /^its header names Windows \d+\.\d+$/);
    });
