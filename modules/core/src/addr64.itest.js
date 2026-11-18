/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit program's addresses past 2 GiB and pointer-sized values past
 * 4 GiB (fixture addr64.c), given a 4 GiB memory: memory reserved until a
 * block lies past 2 GiB, VirtualAlloc's and HeapAlloc's answers whole,
 * strchr there, a thread's parameter, a window's lpCreateParams and
 * GWLP_USERDATA. Each check is a line the program prints.
 *
 * FAILING lists the checks that fail today, each with why: a check that
 * starts to pass fails the test too, so the list only shrinks as the 64-bit
 * layout is made whole (board tab x64).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/addr64.exe', import.meta.url);

/**
 * What fails today, by the check's name.
 *
 * @type {Map<string, string>}
 */
const FAILING = new Map([
    ['a thread\'s parameter past 4 GiB', 'the bridge hands a handler an argument\'s low dword'
        + ' and the thread starts with it (callback.js, dispatch.js readLongCall)'],
    ['lpCreateParams past 4 GiB', 'the bridge hands CreateWindowEx the parameter\'s low dword'],
]);

test('a 64-bit program\'s addresses past 2 GiB and values past 4 GiB come back whole',
    { timeout: 300000 }, async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            memorySize: 2 ** 32 });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
        const code = await app.run({ timeoutMs: 240000 });
        const lines = output.join('').split('\n').filter(line=>line.length > 0);
        const verdicts = new Map(lines.flatMap(line=>{
            const ok = /^ok (.*)$/.exec(line);
            const failed = /^FAIL ([^:]*):/.exec(line);
            return ok ? [[ok[1], true]] : failed ? [[failed[1], false]] : [];
        }));
        assert.ok(verdicts.size >= 9, `the program printed its checks:\n${lines.join('\n')}`);
        const failed = [...verdicts].filter(([, ok])=>!ok).map(([name])=>name).sort();
        assert.deepEqual(failed, [...FAILING.keys()].sort(),
            `what fails differs from FAILING:\n${lines.join('\n')}`);
        assert.equal(code, FAILING.size, 'the exit code counts the failures');
    });
