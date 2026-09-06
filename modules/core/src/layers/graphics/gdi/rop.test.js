/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BLACKNESS,
    DSTINVERT,
    MERGECOPY,
    MERGEPAINT,
    NOTSRCCOPY,
    NOTSRCERASE,
    PATCOPY,
    PATINVERT,
    PATPAINT,
    R2_COPYPEN,
    R2_NOT,
    R2_NOP,
    R2_WHITE,
    R2_XORPEN,
    SRCAND,
    SRCCOPY,
    SRCERASE,
    SRCINVERT,
    SRCPAINT,
    WHITENESS,
    applyRop,
    applyRop2,
    rop2Table,
    ropTable,
    ropUsesPattern,
    ropUsesSource,
} from './rop.js';

/** @param {number} rop @param {number} p @param {number} s @param {number} d */
const rop3 = (rop, p, s, d)=>applyRop(ropTable(rop), p, s, d);

test('the fifteen named operations are the formulas their names claim', ()=>{
    // The whole point of decoding rather than enumerating: these are checked
    // against the boolean expression, not against a table someone typed twice.
    const p = 0xf0f0f0f0;
    const s = 0xcccccccc;
    const d = 0xaaaaaaaa;
    /** @param {number} value */
    const u = value=>value >>> 0;

    assert.equal(rop3(SRCCOPY, p, s, d), u(s));
    assert.equal(rop3(SRCPAINT, p, s, d), u(s | d));
    assert.equal(rop3(SRCAND, p, s, d), u(s & d));
    assert.equal(rop3(SRCINVERT, p, s, d), u(s ^ d));
    assert.equal(rop3(SRCERASE, p, s, d), u(s & ~d));
    assert.equal(rop3(NOTSRCCOPY, p, s, d), u(~s));
    assert.equal(rop3(NOTSRCERASE, p, s, d), u(~s & ~d));
    assert.equal(rop3(MERGECOPY, p, s, d), u(s & p));
    assert.equal(rop3(MERGEPAINT, p, s, d), u(~s | d));
    assert.equal(rop3(PATCOPY, p, s, d), u(p));
    assert.equal(rop3(PATPAINT, p, s, d), u(p | ~s | d));
    assert.equal(rop3(PATINVERT, p, s, d), u(p ^ d));
    assert.equal(rop3(DSTINVERT, p, s, d), u(~d));
    assert.equal(rop3(BLACKNESS, p, s, d), 0);
    assert.equal(rop3(WHITENESS, p, s, d), 0xffffffff);
});

test('every one of the 256 tables agrees with its own truth table', ()=>{
    // The other 241 operations have no names and no dedicated code, so the only
    // thing that can be checked is that the decoder is the definition.
    for (let table = 0; table < 256; table++)
    {
        for (let inputs = 0; inputs < 8; inputs++)
        {
            const p = (inputs & 4) !== 0 ? 0xffffffff : 0;
            const s = (inputs & 2) !== 0 ? 0xffffffff : 0;
            const d = (inputs & 1) !== 0 ? 0xffffffff : 0;
            const expected = ((table >>> inputs) & 1) !== 0 ? 0xffffffff : 0;
            assert.equal(applyRop(table, p, s, d), expected,
                `table ${table} inputs ${inputs}`);
        }
    }
});

test('the operation runs on every bit plane independently', ()=>{
    // One bit set in each operand, in three different places: a decoder that
    // collapsed the word to a boolean would give 0xffffffff or 0 here.
    assert.equal(rop3(SRCINVERT, 0, 0x00000001, 0x80000000), 0x80000001);
    assert.equal(rop3(SRCAND, 0, 0x00ff00ff, 0x0000ffff), 0x000000ff);
});

test('the index carries the table and nothing else in the high byte matters', ()=>{
    assert.equal(ropTable(SRCCOPY), 0xcc);
    assert.equal(ropTable(WHITENESS), 0xff);
    assert.equal(ropTable(BLACKNESS), 0x00);
    // The low three bytes are an internal encoding of the same function; two
    // indices with the same high byte are the same operation.
    assert.equal(ropTable(0x00cc1234), ropTable(SRCCOPY));
});

test('an operation reports which operands it actually reads', ()=>{
    assert.equal(ropUsesSource(ropTable(SRCCOPY)), true);
    assert.equal(ropUsesPattern(ropTable(SRCCOPY)), false);
    assert.equal(ropUsesSource(ropTable(PATCOPY)), false);
    assert.equal(ropUsesPattern(ropTable(PATCOPY)), true);
    assert.equal(ropUsesSource(ropTable(DSTINVERT)), false);
    assert.equal(ropUsesPattern(ropTable(DSTINVERT)), false);
    assert.equal(ropUsesSource(ropTable(BLACKNESS)), false);
    assert.equal(ropUsesPattern(ropTable(MERGECOPY)), true);
});

test('a binary raster operation is its code minus one', ()=>{
    const pen = 0xff00ff00;
    const dest = 0xffff0000;
    /** @param {number} code */
    const rop2 = code=>applyRop2(rop2Table(code), pen, dest);
    assert.equal(rop2(R2_COPYPEN), pen >>> 0);
    assert.equal(rop2(R2_NOT), (~dest) >>> 0);
    assert.equal(rop2(R2_XORPEN), (pen ^ dest) >>> 0);
    assert.equal(rop2(R2_NOP), dest >>> 0);
    assert.equal(rop2(R2_WHITE), 0xffffffff);
});
