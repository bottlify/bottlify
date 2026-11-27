/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argumentsAt, findCharacterLimits, inBytes } from './check-wide-limits.mjs';

test('a limit passes when it says bytes', ()=>{
    for (const limit of ['MAX_PATH * 2', '(MAX_ATOM_NAME + 1) * 2', 'MAX_WIDE_BYTES', '0x10000',
        '0x7fffffff', 'limit', 'maxLength', 'length * 2'])
    {
        assert.ok(inBytes(limit), limit);
    }
    for (const limit of ['MAX_PATH', '260', 'MAX_NAME', '0x400', 'length', 'MAX_TEXT'])
    {
        assert.ok(!inBytes(limit), limit);
    }
});

test('the arguments of a call are split at its own commas only', ()=>{
    const code = 'host.readWideString(read(at, 4), Math.min(a, b) * 2);';
    assert.deepEqual(argumentsAt(code, code.indexOf('(')), ['read(at, 4)', 'Math.min(a, b) * 2']);
});

test('a read in characters is found with its line; a three-argument helper is not', ()=>{
    const code = [
        'const a = host.readWideString?.(name >>> 0, MAX_PATH) ?? \'\';',
        'const b = host.readWideString(name >>> 0, MAX_PATH * 2);',
        'const c = readWideString(memory, address, MAX_TEXT);',
        'const d = memory.readWideString(at,',
        '    MAX_NAME);',
        'readWideString(address, limit = 8192){',
    ].join('\n');
    assert.deepEqual(findCharacterLimits(code), [
        { line: 1, limit: 'MAX_PATH' }, { line: 4, limit: 'MAX_NAME' },
    ]);
});
