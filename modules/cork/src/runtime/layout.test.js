/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** Long mode's windows: 4 GiB in one memory, 8 and 16 GiB with RAM in a memory64 of its own. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLayout, pagesFor, pageFlagsAt, codeRangesAt, sharedLayout, windowBits, PAGE, LOW_STATE,
    tablesSize } from './layout.js';

const GiB = 2 ** 30;

test('4 GiB stays the one-memory layout it was', ()=>{
    const layout = ownLayout({ ramSize: GiB, ramBase: 0, bits: 64 });
    assert.equal(layout.window, undefined);
    assert.equal(layout.ramMemory, undefined);
    assert.equal(layout.tables, GiB);
    assert.equal(windowBits(layout), 32);
});

for (const window of [8 * GiB, 16 * GiB])
{
    test(`a ${window / GiB} GiB window: RAM in memory 1, state and tables in memory 0`, ()=>{
        const layout = ownLayout({ ramSize: window - 4096, ramBase: 0, bits: 64, window });
        const long = ownLayout({ ramSize: GiB, ramBase: 0, bits: 64 });
        assert.equal(layout.ramMemory, 1);
        assert.equal(layout.ramBase, 0);
        assert.equal(layout.window, window);
        assert.equal(windowBits(layout), Math.log2(window));
        assert.equal(layout.regs, LOW_STATE, 'the state block where the long layout has it');
        for (const field of ['eip', 'eflags', 'xmm', 'fsBase', 'gsBase', 'flagRecord', 'nanFirst'])
        {
            assert.equal(/** @type {any} */ (layout)[field], /** @type {any} */ (long)[field], field);
        }
        assert.equal(pageFlagsAt(layout), PAGE);
        assert.equal(codeRangesAt(layout), PAGE + window / 4096, 'a flag byte per page');
        assert.equal(layout.staleSpan, PAGE + window / 4096 * 3, 'two granule bytes per page');
        assert.equal(layout.tables, layout.staleSpan + PAGE);
        assert.equal(pagesFor(layout, tablesSize(layout)),
            Math.ceil((layout.tables + tablesSize(layout)) / PAGE), 'memory 0 holds no RAM');
        assert.equal(sharedLayout(layout).pageFlags, PAGE, 'the process\'s flags shared');
        assert.notEqual(layout.id, ownLayout({ ramSize: GiB, ramBase: 0, bits: 64,
            window: window === 8 * GiB ? 16 * GiB : 8 * GiB }).id);
    });
}

test('a wide window is long mode\'s, of 8 or 16 GiB, its last page never RAM', ()=>{
    assert.throws(()=>ownLayout({ ramSize: GiB, window: 8 * GiB }), /long mode's 4, 8 or 16/);
    assert.throws(()=>ownLayout({ ramSize: GiB, bits: 64, window: 12 * GiB }), /4, 8 or 16/);
    assert.throws(()=>ownLayout({ ramSize: 8 * GiB, ramBase: 0, bits: 64, window: 8 * GiB }),
        RangeError);
});
