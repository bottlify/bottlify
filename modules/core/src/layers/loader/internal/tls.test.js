/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePe } from './pe.js';
import { readTls } from './tls.js';

const IMAGE_BASE = 0x400000;
const SECTION_RVA = 0x1000;
const HEADERS = 0x200;

/**
 * The smallest PE `parsePe` will accept: one section, and whichever data
 * directories a test wants pointed at it.
 *
 * Built here rather than with the fixture builder in tools, which knows about
 * imports and data and nothing about the directories these tests are for.
 *
 * @param {Uint8Array} section
 * @param {Record<number, { address: number, size: number }>} directories
 * @param {number} [imageBase]  Given, the image is a PE32+ (x86-64) one based there.
 * @returns {Uint8Array}
 */
function fixture(section, directories, imageBase){
    const file = new Uint8Array(HEADERS + section.length);
    const view = new DataView(file.buffer);
    const pe = 0x80;
    const optional = pe + 24;
    const wide = imageBase !== undefined;
    // PE32+ widens the image base and the four stack and heap sizes, which
    // moves the directories 16 bytes on.
    const tail = wide ? 16 : 0;

    view.setUint16(0, 0x5a4d, true); //             "MZ"
    view.setUint32(0x3c, pe, true); //              e_lfanew
    view.setUint32(pe, 0x00004550, true); //        "PE\0\0"
    view.setUint16(pe + 4, wide ? 0x8664 : 0x014c, true); // x86-64 or i386
    view.setUint16(pe + 6, 1, true); //             one section
    view.setUint16(pe + 20, 0xe0 + tail, true); //  optional header size
    view.setUint16(optional, wide ? 0x020b : 0x010b, true); // PE32+ or PE32
    view.setUint32(optional + 16, SECTION_RVA, true); // entry point
    if (wide)
    {
        view.setBigUint64(optional + 24, BigInt(imageBase), true);
    }
    else
    {
        view.setUint32(optional + 28, IMAGE_BASE, true);
    }
    view.setUint32(optional + 32, 0x1000, true); // section alignment
    view.setUint32(optional + 56, SECTION_RVA + section.length, true); // sizeOfImage
    view.setUint32(optional + 60, HEADERS, true); // sizeOfHeaders
    view.setUint32(optional + 92 + tail, 16, true); // directory count

    for (const [index, { address, size }] of Object.entries(directories))
    {
        const at = optional + 96 + tail + Number(index) * 8;
        view.setUint32(at, address, true);
        view.setUint32(at + 4, size, true);
    }

    const header = optional + 0xe0 + tail;
    file.set(new TextEncoder().encode('.data'), header);
    view.setUint32(header + 8, section.length, true); //  virtualSize
    view.setUint32(header + 12, SECTION_RVA, true); //    virtualAddress
    view.setUint32(header + 16, section.length, true); // rawSize
    view.setUint32(header + 20, HEADERS, true); //        rawOffset
    view.setUint32(header + 36, 0xc0000040, true); //     initialised data, r/w

    file.set(section, HEADERS);
    return file;
}

/**
 * Lays a TLS directory out at the start of the section. The offsets inside it
 * are far enough apart that a reader confusing two of them reads zeroes rather
 * than arriving at the right answer by luck.
 *
 * @param {Object} options
 * @param {number} [options.templateSize]
 * @param {number} [options.zeroFill]
 * @param {number[]} [options.callbacks]  Section offsets to call, in order.
 * @param {boolean} [options.emptyCallbacks]  Point the array at a lone terminator.
 */
function withTls({ templateSize = 8, zeroFill = 32, callbacks = [], emptyCallbacks = false } = {}){
    const section = new Uint8Array(0x1000);
    const view = new DataView(section.buffer);
    const va = (/** @type {number} */ offset)=>IMAGE_BASE + SECTION_RVA + offset;

    const TEMPLATE = 0x100;
    const INDEX = 0x200;
    const CALLBACKS = 0x300;

    view.setUint32(0, va(TEMPLATE), true);
    view.setUint32(4, va(TEMPLATE + templateSize), true);
    view.setUint32(8, va(INDEX), true);
    view.setUint32(12, callbacks.length > 0 || emptyCallbacks ? va(CALLBACKS) : 0, true);
    view.setUint32(16, zeroFill, true);
    view.setUint32(20, 0x00100000, true);

    for (let at = 0; at < templateSize; at++)
    {
        section[TEMPLATE + at] = 0xa0 + at;
    }
    callbacks.forEach((offset, index)=>view.setUint32(CALLBACKS + index * 4, va(offset), true));
    // Something real just past the terminator. Without it, a reader that skips
    // zeroes instead of stopping at them gives the same answer as one that
    // stops, and the test cannot tell the two apart -- which is exactly what a
    // second structure laid out after this array would expose in a real image.
    view.setUint32(CALLBACKS + (callbacks.length + 1) * 4, va(0x700), true);

    const bytes = fixture(section, { 9: { address: SECTION_RVA, size: 24 } });
    return { bytes, image: parsePe(bytes) };
}

test('the four addresses are virtual, and come back as offsets into the image', ()=>{
    // The defect this catches is silent: read as RVAs they are each too large by
    // the image base, and every one of them then points somewhere plausible.
    const { bytes, image } = withTls({ callbacks: [0x400, 0x500] });
    const tls = readTls(bytes, image);

    assert.ok(tls);
    assert.equal(tls.indexRva, SECTION_RVA + 0x200);
    assert.deepEqual(tls.callbackRvas, [SECTION_RVA + 0x400, SECTION_RVA + 0x500]);
    assert.ok(tls.indexRva < IMAGE_BASE, 'an image base left in would dwarf any real RVA');
});

test('the template is the bytes a thread starts with, and the zero fill follows', ()=>{
    const { bytes, image } = withTls({ templateSize: 8, zeroFill: 32 });
    const tls = readTls(bytes, image);

    assert.ok(tls);
    assert.equal(tls.templateSize, 8);
    assert.equal(tls.zeroFillSize, 32);
    assert.deepEqual([...tls.template], [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7]);
});

test('callbacks are reported in order, and end at their terminator', ()=>{
    const { bytes, image } = withTls({ callbacks: [0x400, 0x500, 0x600] });
    const tls = readTls(bytes, image);

    assert.ok(tls);
    assert.deepEqual(tls.callbackRvas,
        [SECTION_RVA + 0x400, SECTION_RVA + 0x500, SECTION_RVA + 0x600]);
});

test('an image with no callbacks is ordinary, whichever way it says so', ()=>{
    // Two spellings mean the same thing and both appear: a null pointer, and a
    // pointer to an array whose first entry is the terminator.
    const absent = withTls({ callbacks: [] });
    assert.deepEqual(readTls(absent.bytes, absent.image)?.callbackRvas, []);

    const empty = withTls({ callbacks: [], emptyCallbacks: true });
    assert.deepEqual(readTls(empty.bytes, empty.image)?.callbackRvas, []);
});

test('an image that declares no thread-local storage answers null', ()=>{
    const none = fixture(new Uint8Array(0x1000), {});
    assert.equal(readTls(none, parsePe(none)), null);

    // Present but empty means the same thing, and is what a linker writes when
    // it reserved the slot and put nothing in it.
    const empty = fixture(new Uint8Array(0x1000), { 9: { address: 0, size: 0 } });
    assert.equal(readTls(empty, parsePe(empty)), null);
});

test('a template with no initialised bytes is still a block to allocate', ()=>{
    // Start equal to End: nothing to copy, but the zero fill and the index still
    // matter, and answering null here would lose both.
    const { bytes, image } = withTls({ templateSize: 0, zeroFill: 64 });
    const tls = readTls(bytes, image);

    assert.ok(tls);
    assert.equal(tls.templateSize, 0);
    assert.equal(tls.template.length, 0);
    assert.equal(tls.zeroFillSize, 64);
    assert.equal(tls.indexRva, SECTION_RVA + 0x200);
});

test('a template past its section\'s raw data is zeroes, whatever the file holds there', ()=>{
    // A .tls section with no raw data shares its file pointer with the next
    // section; the bytes there are that section's, and a mapped image has
    // zeroes in their place, which is what each thread's block starts as.
    const { bytes } = withTls({ templateSize: 8, callbacks: [0x400], zeroFill: 32 });
    const header = 0x80 + 24 + 0xe0;
    new DataView(bytes.buffer).setUint32(header + 16, 0x100, true); // rawSize: up to the template
    const tls = /** @type {import('./tls.js').TlsDirectory} */ (readTls(bytes, parsePe(bytes)));
    assert.deepEqual([...tls.template], new Array(8).fill(0), 'the block starts as zeroes');
    assert.deepEqual(tls.callbackRvas, [], 'and a table past the raw data is empty');
    assert.equal(tls.indexRva, SECTION_RVA + 0x200, 'the directory itself is read as it was');
});

test('a PE32+ directory holds quadword addresses, its callbacks a quadword each', ()=>{
    // IMAGE_TLS_DIRECTORY64: the four addresses are eight bytes, so the zero
    // fill and the characteristics sit at 32 and 36. Read as the 32-bit one,
    // the end address would be the start's high half -- zero -- and the
    // index the end; and a base above 4 GiB would leave every RVA wrong.
    const base = 0x140000000;
    const section = new Uint8Array(0x1000);
    const view = new DataView(section.buffer);
    /** @param {number} offset */
    const va = offset=>BigInt(base + SECTION_RVA + offset);
    view.setBigUint64(0, va(0x100), true);
    view.setBigUint64(8, va(0x108), true);
    view.setBigUint64(16, va(0x200), true);
    view.setBigUint64(24, va(0x300), true);
    view.setUint32(32, 48, true);
    view.setUint32(36, 0x00500000, true);
    for (let at = 0; at < 8; at++)
    {
        section[0x100 + at] = 0xb0 + at;
    }
    view.setBigUint64(0x300, va(0x400), true);
    view.setBigUint64(0x308, va(0x500), true);
    view.setBigUint64(0x318, va(0x700), true);
    const bytes = fixture(section, { 9: { address: SECTION_RVA, size: 40 } }, base);
    const tls = readTls(bytes, parsePe(bytes, { wide: true }));

    assert.ok(tls);
    assert.equal(tls.templateSize, 8);
    assert.deepEqual([...tls.template], [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7]);
    assert.equal(tls.indexRva, SECTION_RVA + 0x200);
    assert.equal(tls.zeroFillSize, 48);
    assert.equal(tls.characteristics, 0x00500000);
    assert.deepEqual(tls.callbackRvas, [SECTION_RVA + 0x400, SECTION_RVA + 0x500]);
});
