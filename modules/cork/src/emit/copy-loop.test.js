/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which blocks are copy loops (`copyLoopOf` in copy-loop.js); what running
 * one whole leaves is judged in copy-loop.itest.js.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyLoopOf } from './copy-loop.js';

test('only the movs; cmp; jne loop onto itself is a copy loop', ()=>{
    const block = (/** @type {any[]} */ instructions, kind = 'jcc', targets = [0x10, 0x14])=>
        /** @type {any} */ ({ start: 0x10, instructions, exit: { kind, targets } });
    const movs = { op: 'movs', size: 1, prefixes: { rep: false, repne: false, lock: false,
        address: false, segment: -1 } };
    const cmp = (/** @type {number} */ a, /** @type {number} */ c)=>({ op: 'cmp',
        operands: [{ kind: 'reg', reg: a, size: 4 }, { kind: 'reg', reg: c, size: 4 }] });
    const jne = { op: 'jne', cc: 5 };
    assert.deepEqual(copyLoopOf(block([movs, cmp(7, 0), jne])), { size: 1, pointer: 7, end: 0 });
    assert.deepEqual(copyLoopOf(block([movs, cmp(1, 6), jne])), { size: 1, pointer: 6, end: 1 });
    assert.equal(copyLoopOf(block([movs, cmp(7, 6), jne])), null);
    assert.equal(copyLoopOf(block([movs, cmp(7, 4), jne])), null);
    assert.equal(copyLoopOf(block([movs, cmp(7, 0), jne], 'jcc', [0x20, 0x14])), null);
    assert.equal(copyLoopOf(block([{ ...movs, prefixes: { ...movs.prefixes, rep: true } },
        cmp(7, 0), jne])), null);
    assert.equal(copyLoopOf(block([{ ...movs, op: 'stos' }, cmp(7, 0), jne])), null);
    assert.equal(copyLoopOf(block([movs, cmp(7, 0), { op: 'jb', cc: 2 }])), null);
});
