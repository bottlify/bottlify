/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `engine: 'cork'` runs with nothing of the emulator loaded: the cork host's
 * own memory and the translator loaded by URL. In step 5.1 the interpreter
 * tier is a stub that refuses, so the first instruction the translator has no
 * entry for must fail loudly with the tier's message rather than run silently.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../../../app.js';

const FIXTURE = new URL('../../../../test/fixtures/hello.exe', import.meta.url);

test('a program under engine "cork" fails loudly where nothing is translated yet',
    { timeout: 30000 }, async t=>{
        const exe = new Uint8Array(await readFile(FIXTURE));
        const app = await createApp({
            executable: exe,
            engine: 'cork',
            cork: { config: { hotThreshold: 100, feed: 'slice' } },
        });
        t.after(()=>app.dispose());
        let rejected = null;
        try
        {
            await app.run({ timeoutMs: 20000 });
        }
        catch (e){
            rejected = e;
        }
        assert.ok(rejected, 'the run did not end silently');
        assert.match(String(/** @type {any} */ (rejected).message ?? rejected),
            /cpu: cork has no tier for 0x/,
            'the interpreter tier refuses what it cannot run');
    });
