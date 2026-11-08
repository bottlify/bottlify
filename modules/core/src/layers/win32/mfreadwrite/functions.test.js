/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mfreadwrite's refusals: no reader is made, and each refusal says why --
 * a file that is there and cannot be decoded is a loss named by its file.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MF_E_UNSUPPORTED_BYTESTREAM_TYPE, MF_E_UNSUPPORTED_SCHEME, createMfReadWriteFunctions,
    fileOfUrl } from './functions.js';

const FILE_NOT_FOUND = 0x80070002 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const SOURCE_READER = [0x1777133c, 0x411b0881, 0x54ad77a5, 0xc414075f];

function machine(){
    const memory = new Uint8Array(0x4000);
    const view = new DataView(memory.buffer);
    /** @type {{ api: string, detail: string, kind?: string }[]} */
    const said = [];
    const fns = createMfReadWriteFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        exists: path=>Promise.resolve(path === 'C:\\Content\\song.wma'),
        divergence: (api, detail, kind)=>said.push({ api, detail, kind }),
    });
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        [...text].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
        view.setUint16(at + text.length * 2, 0, true);
        return at;
    };
    return { memory, view, said, fns, wide };
}

test('a URL is a file: a plain path, or file: decoded', ()=>{
    assert.equal(fileOfUrl('C:\\Content\\a.wma'), 'C:\\Content\\a.wma');
    assert.equal(fileOfUrl('file:///C:/Content/a%20b.wmv'), 'C:\\Content\\a b.wmv');
    assert.equal(fileOfUrl('Content/a.wma'), 'Content/a.wma', 'a path is taken as it is');
    assert.equal(fileOfUrl('http://example.com/a.wma'), null);
});

test('a reader for a file that is there is refused as an unsupported type, the loss said',
    async()=>{
        const { fns, wide, view, said } = machine();
        view.setUint32(0x100, 0xdeadbeef, true);
        const hr = await fns.table.MFCreateSourceReaderFromURL.handler(
            [wide(0x200, 'C:\\Content\\song.wma'), 0, 0x100]);
        assert.equal(hr, MF_E_UNSUPPORTED_BYTESTREAM_TYPE);
        assert.equal(view.getUint32(0x100, true), 0);
        assert.equal(said[0].kind, 'loss');
        assert.match(said[0].detail, /song\.wma/);
    });

test('a file that is not there is not found, and nothing lost is said', async()=>{
    const { fns, wide, said } = machine();
    const hr = await fns.table.MFCreateSourceReaderFromURL.handler(
        [wide(0x200, 'C:\\Content\\missing.wma'), 0, 0x100]);
    assert.equal(hr, FILE_NOT_FOUND);
    assert.equal(said.length, 0);
});

test('another scheme is unsupported; the class factory refuses as the functions do', async()=>{
    const { fns, wide, view, said } = machine();
    assert.equal(await fns.table.MFCreateSourceReaderFromURL.handler(
        [wide(0x200, 'http://example.com/a.wma'), 0, 0x100]), MF_E_UNSUPPORTED_SCHEME);
    const factory = fns.factory().interfaces[0];
    SOURCE_READER.forEach((word, i)=>view.setUint32(0x300 + i * 4, word >>> 0, true));
    const fromUrl = factory.methods[0].invoke(null,
        [0x300, wide(0x400, 'C:\\Content\\song.wma'), 0, 0, 0x100]);
    assert.equal(await fromUrl, MF_E_UNSUPPORTED_BYTESTREAM_TYPE);
    view.setUint32(0x300, 0, true);
    assert.equal(factory.methods[0].invoke(null, [0x300, 0x400, 0, 0, 0x100]), E_NOTIMPL,
        'a sink writer');
    assert.ok(said.every(entry=>entry.kind === 'loss'));
});
