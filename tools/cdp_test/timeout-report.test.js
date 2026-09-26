/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportTimeout } from './timeout-report.mjs';

test('a screenshot that fails does not replace why the run timed out', async()=>{
    // A page that stopped answering is the usual reason for the timeout, and
    // the same dead page is what makes the screenshot fail next.
    /** @type {string[]} */
    const done = [];
    const reason = await reportTimeout({
        reason: 'page did not answer within 90000ms',
        save: ()=>done.push('profiles'),
        capture: async()=>{
            throw new Error('CDP command timed out: Page.captureScreenshot');
        },
        write: ()=>done.push('png'),
    });
    assert.match(reason, /^page did not answer within 90000ms/);
    assert.match(reason, /no screenshot: CDP command timed out/);
    assert.deepEqual(done, ['profiles'], 'the profiles were saved; no picture was written');
});

test('a screenshot that works is written after the profiles', async()=>{
    /** @type {string[]} */
    const done = [];
    const reason = await reportTimeout({
        reason: 'page did not answer',
        save: ()=>done.push('profiles'),
        capture: async()=>'aGVsbG8=',
        write: data=>done.push(`png ${data}`),
    });
    assert.equal(reason, 'page did not answer');
    assert.deepEqual(done, ['profiles', 'png aGVsbG8=']);
});
