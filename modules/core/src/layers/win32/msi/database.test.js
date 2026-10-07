/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, createRoot, serializeCompoundFile } from '../ole32/cfb.js';
import { bytesSource, openCompound } from './compound.js';
import {
    MSITYPE, decodeStreamName, encodeStreamName, openDatabase, readStringPool, readTableRows,
} from './database.js';

test('a stream name packs two characters of its alphabet to a code point', ()=>{
    for (const [name, table] of /** @type {const} */ ([['File', true], ['_StringPool', true],
        ['Binary.ISScriptBridge.dll', false], ['Data1.cab', false], ['A', true]]))
    {
        const packed = /** @type {string} */ (encodeStreamName(name, table));
        assert.ok(packed.length <= 31, name);
        assert.deepEqual(decodeStreamName(packed), { name, table });
    }
    assert.equal(encodeStreamName('File', true), '\u4840\u430f\u422f', 'the table marker first');
    assert.equal(decodeStreamName('a b').name, 'a b', 'outside the alphabet, as it is');
    assert.equal(encodeStreamName('x'.repeat(70), false), null, 'too long for an entry');
});

/** @param {number[]} words */
const wordsOf = words=>new Uint8Array(Uint16Array.from(words).buffer);

test('the pool numbers strings from one, an empty entry still counting', ()=>{
    // Code page 1252 with two-byte references, then "ab", nothing, "cde".
    const pool = wordsOf([1252, 0, 2, 1, 0, 0, 3, 1]);
    const data = new TextEncoder().encode('abcde');
    const { strings, codepage, longRefs } = readStringPool(pool, data);
    assert.deepEqual(strings, [null, 'ab', null, 'cde']);
    assert.equal(codepage, 1252);
    assert.equal(longRefs, false);
});

test('a string longer than a word can say takes two entries and one number', ()=>{
    const long = 'x'.repeat(0x10002);
    const pool = wordsOf([65001, 0x8000, 0, 1, 0x0002, 0x0001, 1, 1]);
    const data = new TextEncoder().encode(`${long}y`);
    const { strings, codepage, longRefs } = readStringPool(pool, data);
    assert.equal(strings.length, 3);
    assert.equal(strings[1]?.length, 0x10002);
    assert.equal(strings[2], 'y');
    assert.equal(codepage, 65001);
    assert.equal(longRefs, true, 'the top bit of the code page says three-byte references');
});

test('rows are stored a column at a time; integers biased, zero null', ()=>{
    const columns = [
        { type: MSITYPE.VALID | MSITYPE.STRING | MSITYPE.KEY | 72 },
        { type: MSITYPE.VALID | MSITYPE.NULLABLE | 2 },
        { type: MSITYPE.VALID | 4 },
        { type: MSITYPE.VALID | MSITYPE.STRING | MSITYPE.NULLABLE },
    ];
    const strings = [null, 'one', 'two'];
    const bytes = new Uint8Array([
        1, 0, 2, 0, //                      the string column: "one", "two"
        0x05, 0x80, 0, 0, //                0x8005 is 5, zero is null
        0xff, 0xff, 0xff, 0x7f, 1, 0, 0, 0x80, // 0x7fffffff is -1, 0x80000001 is 1
        1, 0, 0, 0, //                      a stream for the first row only
    ]);
    assert.deepEqual(readTableRows(bytes, columns, strings, false, 'Binary'), [
        ['one', 5, -1, 'Binary.one'],
        ['two', null, 1, null],
    ]);
});

test('a database is its tables, read through the system tables', async()=>{
    // _Tables names "T"; _Columns gives it a key string and a short.
    const strings = ['T', 'K', 'N', 'a', 'b'];
    const pool = wordsOf([1252, 0, ...strings.flatMap(text=>[text.length, 1])]);
    const data = new TextEncoder().encode(strings.join(''));
    /** @param {number[]} values */
    const table = values=>wordsOf(values);
    const root = createRoot();
    /** @param {string} name @param {boolean} isTable @param {Uint8Array} bytes */
    const put = (name, isTable, bytes)=>{
        const packed = /** @type {string} */ (encodeStreamName(name, isTable));
        const entry = createEntry(packed, 'stream');
        entry.data = bytes;
        root.children.set(packed.toUpperCase(), entry);
    };
    put('_StringPool', true, pool);
    put('_StringData', true, data);
    put('_Tables', true, table([1]));
    put('_Columns', true, table([1, 1, 0x8001, 0x8002, 2, 3,
        MSITYPE.VALID | MSITYPE.STRING | MSITYPE.KEY | 8 | 0x8000, MSITYPE.VALID | 2 | 0x8000]));
    put('T', true, table([4, 5, 0x8007, 0x7fff]));
    put('Other', false, new Uint8Array([9, 9]));
    const db = await openDatabase(await openCompound(bytesSource(serializeCompoundFile(root))));
    const t = /** @type {import('./database.js').Table} */ (db.table('T'));
    assert.deepEqual(t.columns.map(column=>column.name), ['K', 'N']);
    assert.deepEqual(t.rows, [['a', 7], ['b', -1]]);
    assert.deepEqual(db.streamNames(), ['Other']);
    assert.deepEqual(await db.readStream('Other'), new Uint8Array([9, 9]));
    assert.equal(db.stringId('b'), 5, 'a string the pool holds keeps its number');
    assert.equal(db.stringId('new'), 6, 'one it does not comes after the last');
});
