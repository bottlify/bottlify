/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStringTableFunctions } from './stringtable.js';

function build(){
    const bytes = new Uint8Array(0x40000);
    const view = new DataView(bytes.buffer);
    let heap = 0x10000;
    const host = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
            bytes.set(data, at),
        readWideString: (/** @type {number} */ at)=>{
            let text = '';
            for (let index = at; view.getUint16(index, true) !== 0; index += 2)
            {
                text += String.fromCharCode(view.getUint16(index, true));
            }
            return text;
        },
        allocate: (/** @type {number} */ size)=>{
            const at = heap;
            heap += (size + 15) & ~15;
            return at;
        },
        free: ()=>{},
    };
    const fns = /** @type {Record<string, any>} */ (createStringTableFunctions(host));
    let argAt = 0x100;
    /** @param {string} text */
    const wstr = text=>{
        const at = argAt;
        [...text, '\0'].forEach((c, index)=>view.setUint16(at + index * 2, c.charCodeAt(0), true));
        argAt += text.length * 2 + 16;
        return at;
    };
    return { fns, view, wstr, host };
}

test('a string table finds a string by its case, or its case aside, and keeps its first id',
    ()=>{
        // Wine's setupapi stringtable tests.
        const { fns, wstr, host } = build();
        const table = fns.StringTableInitialize.handler([]);
        const id = fns.StringTableAddString.handler([table, wstr('string'), 0]);
        assert.equal(fns.StringTableAddString.handler([table, wstr('String'), 0]), id,
            'the same string, case aside');
        const sensitive = fns.StringTableAddString.handler([table, wstr('String'), 1]);
        assert.notEqual(sensitive, id, 'case compared: another string');
        assert.equal(fns.StringTableLookUpString.handler([table, wstr('String'), 1]), sensitive);
        assert.equal(fns.StringTableLookUpString.handler([table, wstr('foo'), 0]), 0xffffffff);
        assert.equal(host.readWideString(fns.StringTableStringFromId.handler([table, id])),
            'string', 'the string is in the table\'s own data');
        assert.equal(fns.pSetupStringTableAddString, fns.StringTableAddString,
            'under its later name too');
        const copy = fns.StringTableDuplicate.handler([table]);
        assert.equal(fns.StringTableLookUpString.handler([copy, wstr('STRING'), 0]), id,
            'a duplicate has the same ids');
    });

test('a table is laid out as Windows lays it out, and a string\'s extra data is its first',
    ()=>{
        const { fns, view, wstr } = build();
        const table = fns.StringTableInitializeEx.handler([4, 0]);
        assert.equal(view.getUint32(table + 4, true), 509 * 4, 'after the buckets');
        assert.equal(view.getUint32(table + 20, true), 4, 'the extra data each string carries');
        assert.equal(view.getUint32(table + 24, true), 0x409, 'the thread\'s locale');
        const extra = 0x200;
        view.setUint32(extra, 10, true);
        const id = fns.StringTableAddStringEx.handler([table, wstr('string'), 0, extra, 4]);
        view.setUint32(extra, 11, true);
        assert.equal(fns.StringTableAddStringEx.handler([table, wstr('string'), 0, extra, 4]), id);
        const out = 0x300;
        assert.equal(fns.StringTableGetExtraData.handler([table, id, out, 4]), 1);
        assert.equal(view.getUint32(out, true), 10, 'the data it was added with');
        assert.equal(fns.StringTableGetExtraData.handler([table, id, out, 8]), 0,
            'more than it carries');
        view.setUint32(out, 0x55555555, true);
        fns.StringTableLookUpStringEx.handler([table, wstr('string'), 0, out, 2]);
        assert.equal(view.getUint32(out, true), 0x5555000a, 'as much as asked for');
    });
