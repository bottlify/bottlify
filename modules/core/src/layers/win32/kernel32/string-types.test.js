/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTables } from '../common/run-tables.js';
import { CT_CTYPE1, CT_CTYPE2, CT_CTYPE3, stringTypes } from './string-types.js';

const types = stringTypes(runTables(null));
/** The word for one unit, or null for an info type not taken. @param {number} type @param {number} code */
const stringType = (type, code)=>types(type, String.fromCharCode(code))?.[0] ?? null;

/** @param {number[]} codes @param {number} type */
const typesOf = (codes, type = CT_CTYPE1)=>codes.map(code=>stringType(type, code));

test('CT_CTYPE1 is the category Windows\' table follows, defined characters marked so', ()=>{
    // Wine's locale.c test_GetStringTypeW, the answers of Windows 7 on.
    assert.deepEqual(typesOf([0x9, 0x20, 0xa0, 0x3000, 0xfeff]),
        [0x268, 0x248, 0x248, 0x248, 0x260], 'the blanks');
    assert.deepEqual(typesOf([0x47, 0x67, 0x1c5]), [0x301, 0x302, 0x303], 'Lu, Ll, Lt');
    assert.deepEqual(typesOf([0x378, 0x379, 0xfff8, 0xfffe]), [0, 0, 0, 0], 'undefined');
    assert.deepEqual(typesOf([0x2c2, 0x2e5, 0x322, 0x482, 0x6de, 0xffe0, 0xffe9, 0x2153]),
        Array(8).fill(0x200), 'symbols and marks past the first 256: defined, nothing more');
    assert.deepEqual(typesOf([0x2b0, 0x2160, 0x600, 0xad, 0x1f88, 0x294, 0x903]),
        [0x300, 0x300, 0x220, 0x230, 0x303, 0x300, 0x200],
        'Lm, Nl, Cf, the soft hyphen, Lt, Lo, Mc');
    assert.deepEqual(typesOf([0x5f, 0x2d, 0x28, 0x29, 0xab, 0xbb, 0x21]), Array(7).fill(0x210));
    for (const code of [0x24, 0x2b, 0x3c, 0x3e, 0x5e, 0x60, 0x7c, 0x7e, 0xa2, 0xbe, 0xd7, 0xf7])
    {
        assert.ok(/** @type {number} */ (stringType(CT_CTYPE1, code)) & 0x10, `${code} punctuation`);
    }
    for (const code of [0xb2, 0xb3, 0xb9])
    {
        assert.ok(/** @type {number} */ (stringType(CT_CTYPE1, code)) & 0x4, `${code} a digit`);
    }
    assert.ok(/** @type {number} */ (stringType(CT_CTYPE1, 0x2071)) & 0x2, 'superscript i lower');
    assert.ok(/** @type {number} */ (stringType(CT_CTYPE1, 0x85)) & 0x8, 'NEL a space');
    assert.deepEqual(typesOf([0x2028, 0x2029]), [0x208, 0x208], 'Zl and Zp: spaces, not blanks');
    assert.deepEqual(typesOf([0xe31, 0xe34, 0xe4e, 0x1885]), Array(4).fill(0x300),
        'Thai and Mongolian marks are letters');
    assert.equal(Number(stringType(CT_CTYPE1, 0x41)) & 0x80, 0x80, 'A is a hex digit');
});

test('CT_CTYPE3 marks surrogates and the one kashida', ()=>{
    assert.equal(stringType(CT_CTYPE3, 0xd800), 0x800);
    assert.equal(stringType(CT_CTYPE3, 0xdc00), 0x1000);
    for (let code = 0x600; code <= 0x6ff; code++)
    {
        assert.equal(/** @type {number} */ (stringType(CT_CTYPE3, code)) & 0x200,
            code === 0x640 ? 0x200 : 0, `${code.toString(16)}`);
    }
    assert.equal(stringType(CT_CTYPE3, 0x41), 0x8040, 'A: alphabetic, half width');
    assert.equal(Number(stringType(CT_CTYPE3, 0x4e00)) & 0x180, 0x180, 'an ideograph, full');
    assert.equal(Number(stringType(CT_CTYPE3, 0x30a2)) & 0x10, 0x10, 'katakana');
});

test('CT_CTYPE2 is the bidirectional class', ()=>{
    assert.deepEqual(typesOf([0x41, 0x5d0, 0x627, 0x31, 0x661, 0x2b, 0x24, 0x2c, 0xa, 0x9, 0x20,
        0x21], CT_CTYPE2), [1, 2, 2, 3, 6, 4, 5, 7, 8, 9, 10, 11]);
});

test('an info type that is none of the three is refused', ()=>{
    assert.equal(stringType(3, 0x41), null);
    assert.equal(stringType(8, 0x41), null);
});
