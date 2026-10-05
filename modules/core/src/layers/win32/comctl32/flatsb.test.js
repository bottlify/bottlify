/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFlatScrollBarFunctions } from './flatsb.js';

test('flat scroll bars are the standard ones: each call is user32\'s, as it came', ()=>{
    /** @type {[string, number[]][]} */
    const calls = [];
    const fns = /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */ (
        createFlatScrollBarFunctions({
            user32: name=>({ handler: args=>{
                calls.push([name, args]);
                return 7;
            } }),
        }));
    assert.equal(fns.InitializeFlatSB.handler([0x40]), 1);
    assert.equal(fns.FlatSB_SetScrollProp.handler([0x40, 1, 2, 1]), 0, 'no flat property is kept');
    assert.equal(fns.FlatSB_GetScrollProp.handler([0x40, 1, 0x100]), 0);
    assert.equal(fns.FlatSB_SetScrollInfo.handler([0x40, 1, 0x200, 1]), 7);
    assert.equal(fns.FlatSB_GetScrollPos.handler([0x40, 0]), 7);
    assert.equal(fns.FlatSB_SetScrollRange.handler([0x40, 1, 0, 100, 0]), 7);
    assert.deepEqual(calls, [
        ['SetScrollInfo', [0x40, 1, 0x200, 1]],
        ['GetScrollPos', [0x40, 0]],
        ['SetScrollRange', [0x40, 1, 0, 100, 0]],
    ]);
    assert.deepEqual(
        Object.fromEntries(Object.entries(fns).map(([name, { argBytes }])=>[name, argBytes])),
        {
            InitializeFlatSB: 4, UninitializeFlatSB: 4, FlatSB_GetScrollProp: 12,
            FlatSB_SetScrollProp: 16, FlatSB_EnableScrollBar: 12, FlatSB_ShowScrollBar: 12,
            FlatSB_GetScrollRange: 16, FlatSB_GetScrollInfo: 12, FlatSB_GetScrollPos: 8,
            FlatSB_SetScrollPos: 16, FlatSB_SetScrollInfo: 16, FlatSB_SetScrollRange: 20,
        }, 'stdcall: each pops what it was pushed');
});
