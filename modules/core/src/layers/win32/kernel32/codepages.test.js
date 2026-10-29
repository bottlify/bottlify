/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePage } from './codepages.js';

/** @param {number} id */
const page = id=>{
    const found = codePage(id);
    assert.ok(found !== null, `page ${id} is carried`);
    return found;
};

test('the double-byte pages know their lead bytes', ()=>{
    assert.deepEqual(page(932).leadRanges, [0x81, 0x9f, 0xe0, 0xfc]);
    assert.equal(page(936).isLead(0xa0), true);
    assert.equal(page(936).isLead(0x7f), false);
    assert.equal(page(932).isLead(0xa0), false);
    assert.equal(page(932).maxCharSize, 2);
    assert.equal(page(1251).maxCharSize, 1);
    assert.deepEqual(page(1251).leadRanges, []);
    assert.equal(codePage(1234), null, 'a page Windows does not have');
});

test('a lead byte with no trail is the default character, and the next byte is read again', ()=>{
    const bytes = new Uint8Array([0xbf, 0xb4, 0xc7, 0, 0x78]);
    assert.equal(page(936).decode(bytes.subarray(0, 2), false), '看');
    assert.equal(page(936).decode(bytes.subarray(0, 3), false), '看?');
    assert.equal(page(936).decode(bytes, false), '看?\0x');
    assert.equal(page(936).decode(bytes.subarray(0, 3), true), null, 'MB_ERR_INVALID_CHARS');
});

test('a byte a page leaves undefined fails a strict conversion; a C1 hole is its control', ()=>{
    for (const [id, byte] of [[874, 0xdd], [932, 0xfe], [936, 0xff], [949, 0xff], [950, 0xff],
        [1253, 0xaa], [1255, 0xff], [1257, 0xa5]])
    {
        assert.equal(page(id).decode(new Uint8Array([byte]), true), null, `${id} ${byte}`);
        assert.equal(page(id).decode(new Uint8Array([byte]), false), '?', `${id} ${byte}`);
    }
    assert.equal(page(932).decode(new Uint8Array([0x80]), true), '\x80');
    assert.equal(page(932).decode(new Uint8Array([0x81, 0x45]), true), '・');
    assert.equal(page(1253).decode(new Uint8Array([0x81]), true), '\x81');
});

test('a character the page lacks is its best fit, unless forbidden, else the default', ()=>{
    const WC_NO_BEST_FIT_CHARS = 0x400;
    assert.deepEqual([...page(1251).encode('рä', 0, null).bytes], [0xf0, 0x61]);
    const strict = page(1251).encode('ä', WC_NO_BEST_FIT_CHARS, null);
    assert.deepEqual([...strict.bytes], [0x3f]);
    assert.equal(strict.usedDefault(1), true);
    assert.equal(page(1251).encode('ä', 0, null).usedDefault(1), false);
});

test('a default given by the caller may be two bytes, and no buffer takes half a character', ()=>{
    const encoded = page(936).encode('箸=젓가', 0, [0xa3, 0xbf]);
    assert.deepEqual([...encoded.bytes], [0xf3, 0xe7, 0x3d, 0xa3, 0xbf, 0xa3, 0xbf]);
    assert.equal(encoded.fit(1), 0);
    assert.equal(encoded.fit(2), 2);
    assert.equal(encoded.fit(4), 3);
    assert.equal(encoded.usedDefault(3), false);
    assert.equal(encoded.usedDefault(5), true);
});
