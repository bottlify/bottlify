/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrtdllFunctions } from './crtdll.js';

test('CRTDLL is msvcrt\'s entries under its own older names', ()=>{
    /** @type {number[][]} */
    const asked = [];
    const crt = {
        strlen: { convention: 'cdecl', argBytes: 4, handler: ()=>3 },
        _acmdln: { data: ()=>new Uint8Array([1, 2, 3, 4]) },
        __getmainargs: { convention: 'cdecl', argBytes: 20,
            handler: (/** @type {number[]} */ args)=>{
                asked.push(args);
                return 0;
            } },
    };
    const table = createCrtdllFunctions(crt);
    assert.equal(table.strlen, crt.strlen, 'the same entry, not a copy');
    assert.equal(table._acmdln_dll, crt._acmdln);
    assert.deepEqual([...table._fmode_dll.data()], [0, 0, 0, 0]);

    // Four arguments, the caller cleaning up: the fifth msvcrt reads is none.
    assert.equal(table.__GetMainArgs.argBytes, 16);
    table.__GetMainArgs.handler([0x100, 0x104, 0x108, 1]);
    assert.deepEqual(asked, [[0x100, 0x104, 0x108, 1, 0]]);
});
