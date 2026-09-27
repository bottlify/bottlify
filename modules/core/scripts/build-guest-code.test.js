/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The committed x86 is what its source compiles to: a source edited without
 * `npm run build:guest-code` would otherwise run one function as its handler
 * and another as its x86, and only the equivalence test's inputs would say so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileGuestCode } from './build-guest-code.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every @guestCode module\'s x86 is its source compiled now', async()=>{
    const modules = await compileGuestCode();
    assert.ok(modules.length > 0, 'the tree has @guestCode functions');
    for (const { target, text } of modules)
    {
        // Line endings are the checkout's (a Windows one writes CRLF), not the compiler's.
        const committed = (await readFile(target, 'utf8').catch(()=>'(missing)'))
            .replace(/\r\n/g, '\n');
        assert.equal(committed, text.replace(/\r\n/g, '\n'),
            `${relative(ROOT, target)} is stale: npm run build:guest-code`);
    }
});
