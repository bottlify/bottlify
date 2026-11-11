/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An older framework's string exports, which a program built against it
 * imports (Half-Life's chromehtml.dll): the wide form is UTF-16 on Windows, and
 * a list's copy is a list of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCefStrings } from './strings.js';

/** A guest memory of 64 KiB with a bump allocator. */
function hostOver(){
    const bytes = new Uint8Array(1 << 16);
    let next = 0x1000;
    return {
        bytes,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
        free: ()=>{},
        register: ()=>0x9000,
    };
}

test('utf8 to wide writes the UTF-16 string, and wide_clear empties it', ()=>{
    const host = hostOver();
    const { exports } = createCefStrings(host);
    host.bytes.set(new TextEncoder().encode('Steam'), 0x100);
    const out = 0x200;
    assert.equal(exports.cef_string_utf8_to_wide.handler([0x100, 5, out]), 1);
    const view = new DataView(host.bytes.buffer);
    const [chars, length] = [view.getUint32(out, true), view.getUint32(out + 4, true)];
    assert.equal(length, 5);
    const text = new Uint16Array(host.bytes.slice(chars, chars + 10).buffer);
    assert.equal(String.fromCharCode(...text),
        'Steam');
    exports.cef_string_wide_clear.handler([out]);
    assert.equal(view.getUint32(out + 4, true), 0, 'cleared');
});

test('a list copied is a list of its own with the same strings', ()=>{
    const host = hostOver();
    const { exports } = createCefStrings(host);
    host.bytes.set(new TextEncoder().encode('a'), 0x100);
    exports.cef_string_utf8_to_wide.handler([0x100, 1, 0x200]);
    const list = exports.cef_string_list_alloc.handler([]);
    exports.cef_string_list_append.handler([list, 0x200]);
    const copy = exports.cef_string_list_copy.handler([list]);
    assert.notEqual(copy, list);
    assert.equal(exports.cef_string_list_size.handler([copy]), 1);
    exports.cef_string_list_append.handler([list, 0x200]);
    assert.equal(exports.cef_string_list_size.handler([copy]), 1, 'the copy keeps its own');
});
