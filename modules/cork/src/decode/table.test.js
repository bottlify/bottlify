/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CF, FLAG_CLASSES, Group, ONE_BYTE, OF, PF, Prefixed, SF, SYS, TWO_BYTE, X87, ZF,
    conditionReads, formsInUse,
} from './table.js';

/** The operand forms the decoder's resolver knows, by their first letter or whole name. */
const KNOWN_FORMS = /^(E[bwvdqy]?|G[bwvdy]|M(b|w|d|q|dq|a|v)?|S[w]|Z[bvd]|I(b|bs|w|z|v)|J[bz]|O[bv]|X[bv]|Y[bv]|P[q]|Q[q]|N[q]|V(ps|pd|ss|sd|dq|q|d)|W(ps|pd|ss|sd|dq|q|d)|U(ps|pd|dq|q)|AL|CL|AX|DX|eAX|1|ES|CS|SS|DS|FS|GS|Xlat|ST0?|STi|m(16int|32int|64int|32fp|64fp|80fp|80bcd)|Menv|Msave)$/;

test('every operand form the tables use is one the resolver knows', ()=>{
    const unknown = [...formsInUse()].filter(form=>!KNOWN_FORMS.test(form));
    assert.deepEqual(unknown, []);
});

test('an undefined flag is always one the instruction writes, in every class', ()=>{
    for (const [name, flags] of Object.entries(FLAG_CLASSES))
    {
        assert.equal(flags.u & ~flags.w, 0, `${name}: undefined flags outside the written set`);
    }
});

test('the maps have the shape the decoder expects', ()=>{
    assert.equal(ONE_BYTE.length, 256);
    assert.equal(TWO_BYTE.length, 256);
    assert.equal(X87.length, 8);
    for (const map of X87)
    {
        assert.equal(map.mem.length, 8);
        for (const key of Object.keys(map.reg))
        {
            assert.ok(Number(key) >= 0xc0 && Number(key) <= 0xff, `x87 register form ${key}`);
        }
    }
    // The prefixes and the x87 escapes are not entries of the one-byte map.
    for (const prefix of [0x26, 0x2e, 0x36, 0x3e, 0x64, 0x65, 0x66, 0x67, 0xf0, 0xf2, 0xf3, 0x0f])
    {
        assert.equal(ONE_BYTE[prefix], null, `0x${prefix.toString(16)} is a prefix, not an entry`);
    }
    for (let escape = 0xd8; escape <= 0xdf; escape++)
    {
        assert.equal(ONE_BYTE[escape], null);
    }
    /** @param {any} entry */
    const groupsHaveEight = entry=>{
        if (entry instanceof Group)
        {
            assert.equal(entry.entries.length, 8);
        }
        if (entry instanceof Prefixed)
        {
            Object.values(entry.variants).forEach(groupsHaveEight);
        }
    };
    ONE_BYTE.forEach(groupsHaveEight);
    TWO_BYTE.forEach(groupsHaveEight);
});

test('the condition codes read the flags the manual says', ()=>{
    assert.equal(conditionReads(0), OF);
    assert.equal(conditionReads(1), OF);
    assert.equal(conditionReads(2), CF);
    assert.equal(conditionReads(4), ZF);
    assert.equal(conditionReads(7), CF | ZF);
    assert.equal(conditionReads(8), SF);
    assert.equal(conditionReads(11), PF);
    assert.equal(conditionReads(12), SF | OF);
    assert.equal(conditionReads(15), ZF | SF | OF);
});

test('what the table leaves out is named as such: system forms are SYS, gaps are null', ()=>{
    assert.equal(ONE_BYTE[0xea], SYS, 'far jump');
    assert.equal(ONE_BYTE[0xcf], SYS, 'iret');
    // 0F 01 stores the tables' places in user mode, and loads them only in the kernel.
    assert.equal(/** @type {any} */ (TWO_BYTE[0x01]).entries[2], SYS, 'lgdt and friends');
    assert.equal(/** @type {any} */ (TWO_BYTE[0x01]).entries[1].op, 'sidt');
    assert.equal(TWO_BYTE[0x38], null, 'SSSE3: added on measured need');
    assert.equal(TWO_BYTE[0x3a], null);
    let entries = 0;
    for (const map of [ONE_BYTE, TWO_BYTE])
    {
        for (const entry of map)
        {
            entries += entry !== null && entry !== SYS ? 1 : 0;
        }
    }
    assert.ok(entries > 350, `${entries} entries between the two maps`);
});
