/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * steam-install.mjs's --keys on stdin, as the launcher hands it over: read and
 * checked before Steam is asked anything, a refusal one line that shows no key
 * or code. The download itself needs Steam and is not run here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOL = fileURLToPath(new URL('./steam-install.mjs', import.meta.url));
const KEY = '5a'.repeat(32);
const CODE = '9876543210987654321';
const ENTRY = { depot: 1, gid: '2', key: KEY, code: CODE };

/** @param {string[]} args @param {string} input */
const run = (args, input)=>spawnSync(process.execPath, [TOOL, ...args],
    { input, encoding: 'utf8' });

test('keys that are not a depot access list fail the run at once, naming no key or code', ()=>{
    const inputs = [`[${JSON.stringify(ENTRY)}`, '[]',
        JSON.stringify([{ ...ENTRY, key: KEY.slice(1) }]), JSON.stringify([ENTRY, ENTRY])];
    for (const input of inputs)
    {
        const result = run(['--keys', '-', '--app', '70', '--out', 'unused'], input);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /^failed: [^\n]*\n$/, 'one line');
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${KEY.slice(1)}|${CODE}`));
    }
});

test('a run takes a session or keys, not both and not neither', ()=>{
    const both = ['--session', '-', '--keys', '-'];
    for (const args of [[], both])
    {
        const result = run([...args, '--app', '70', '--out', 'x'], '');
        assert.equal(result.status, 1);
        assert.match(result.stderr, /^failed: usage: .*--session <file> \| --keys <file>/);
    }
});
