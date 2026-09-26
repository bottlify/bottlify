/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skipWithout } from './fetched.js';

test('a suite without its fetched data skips, except under CI, where it runs and fails', ()=>{
    const here = new URL(import.meta.url);
    const absent = new URL('./no-such-corpus.json.gz', import.meta.url);
    const ci = process.env.CI;
    try
    {
        delete process.env.CI;
        assert.equal(skipWithout(here), false);
        assert.match(String(skipWithout(here, absent)), /missing .*no-such-corpus/);
        process.env.CI = 'true';
        assert.equal(skipWithout(here, absent), false, 'CI runs it, to fail on the file');
    }
    finally
    {
        if (ci === undefined)
        {
            delete process.env.CI;
        }
        else
        {
            process.env.CI = ci;
        }
    }
});
