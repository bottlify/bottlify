/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Pixel transfer for the sized formats, both ways. Every expectation comes
 * from OpenGL 4.6: the unpacking of section 8.4.4 (table 8.7's normalised
 * conversions, the packed fields of table 8.8, the row layout of 8.4.4.1),
 * the conversion into the internal format of section 8.5 (2.3.4's small
 * floats, 8.5.2's shared exponent) and the errors of 8.4.4 and 8.5.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { SIZED_FORMATS, TEX, modelTexelBytes } from './formats.js';
import {
    clientBytes, clientLayout, decodeClient, decodeStorage, encodeClient, encodeStorage,
    fromHalf, packFromStorage, storageLayout, toHalf, transferError, unpackToStorage,
} from './texture-transfer.js';

/** @type {import('./texture-transfer.js').TransferState} */
const TIGHT = { alignment: 1, rowLength: 0, skipRows: 0, skipPixels: 0, swapBytes: false };

/** @param {number} internal */
function sized(internal){
    const found = SIZED_FORMATS.get(internal);
    assert.ok(found);
    return found;
}

/**
 * @template T
 * @param {T | null} value
 * @returns {T}
 */
function some(value){
    assert.ok(value !== null);
    return value;
}

/** @param {ArrayBufferView} view */
const bytesOf = view=>new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/**
 * The values of one texel as decoded from a client image of one pixel.
 *
 * @param {ArrayBufferView} data @param {number} format @param {number} type
 */
const texel = (data, format, type)=>Array.from(some(decodeClient(bytesOf(data), 1, 1, 1,
    format, type, TIGHT)));

test('half floats round to the nearest, ties to even (section 2.3.4.1)', ()=>{
    assert.equal(toHalf(1), 0x3c00);
    assert.equal(toHalf(-2), 0xc000);
    assert.equal(toHalf(65504), 0x7bff);
    assert.equal(toHalf(65520), 0x7c00, 'half way past the largest rounds to infinity');
    assert.equal(toHalf(2 ** -24), 0x0001);
    assert.equal(toHalf(2 ** -25), 0x0000, 'a tie rounds to the even zero');
    assert.equal(toHalf(3 * 2 ** -26), 0x0001);
    assert.equal(toHalf(0.1), 0x2e66);
    assert.equal(toHalf(-0), 0x8000);
    assert.equal(toHalf(Infinity), 0x7c00);
    assert.equal(toHalf(NaN) & 0x7c00, 0x7c00);
    assert.notEqual(toHalf(NaN) & 0x3ff, 0);
    for (let bits = 0; bits < 0x10000; bits++)
    {
        if ((bits & 0x7c00) === 0x7c00 && (bits & 0x3ff) !== 0)
        {
            continue;
        }
        assert.equal(toHalf(fromHalf(bits)), bits, `half 0x${bits.toString(16)}`);
    }
});

test('the unsigned and signed normalised types convert as table 8.7 says', ()=>{
    assert.deepEqual(texel(new Uint8Array([255, 0, 51, 128]), GL.RGBA, GL.UNSIGNED_BYTE),
        [1, 0, 0.2, 128 / 255]);
    assert.deepEqual(texel(new Int8Array([127, -127, -128, 0]), GL.RGBA, GL.BYTE),
        [1, -1, -1, 0]);
    assert.deepEqual(texel(new Uint16Array([65535]), GL.RED, GL.UNSIGNED_SHORT), [1, 0, 0, 1]);
    assert.deepEqual(texel(new Int16Array([-32768]), GL.RED, GL.SHORT), [-1, 0, 0, 1]);
    assert.deepEqual(texel(new Uint32Array([0xffffffff]), GL.RED, GL.UNSIGNED_INT),
        [1, 0, 0, 1]);
    assert.deepEqual(texel(new Int32Array([-0x80000000]), GL.RED, GL.INT), [-1, 0, 0, 1]);
    assert.deepEqual(texel(new Float32Array([2.5, -3]), TEX.RG, GL.FLOAT), [2.5, -3, 0, 1]);
    assert.deepEqual(texel(new Uint16Array([0x3c00]), GL.ALPHA, TEX.HALF_FLOAT),
        [0, 0, 0, 1]);
    assert.deepEqual(texel(new Uint16Array([0x3800]), GL.GREEN, TEX.HALF_FLOAT),
        [0, 0.5, 0, 1]);
});

test('the integer formats keep their values unconverted', ()=>{
    assert.deepEqual(texel(new Int8Array([-5, 7]), TEX.RG_INTEGER, GL.BYTE), [-5, 7, 0, 1]);
    assert.deepEqual(texel(new Uint32Array([4000000000]), TEX.RED_INTEGER, GL.UNSIGNED_INT),
        [4000000000, 0, 0, 1]);
    assert.deepEqual(texel(new Uint8Array([1, 2, 3]), TEX.BGR_INTEGER, GL.UNSIGNED_BYTE),
        [3, 2, 1, 1]);
});

test('BGR(A) swaps red and blue; luminance goes into red, green and blue', ()=>{
    assert.deepEqual(texel(new Uint8Array([0, 51, 255, 0]), GL.BGRA, GL.UNSIGNED_BYTE),
        [1, 0.2, 0, 0]);
    assert.deepEqual(texel(new Uint8Array([255, 0]), GL.LUMINANCE_ALPHA, GL.UNSIGNED_BYTE),
        [1, 1, 1, 0]);
    assert.deepEqual(texel(new Uint8Array([51]), GL.LUMINANCE, GL.UNSIGNED_BYTE),
        [0.2, 0.2, 0.2, 1]);
});

test('a packed type gives its fields to the format components in order (table 8.8)', ()=>{
    assert.deepEqual(texel(new Uint16Array([0xf800]), GL.RGB, GL.UNSIGNED_SHORT_5_6_5),
        [1, 0, 0, 1]);
    assert.deepEqual(texel(new Uint16Array([0x001f]), GL.RGB, GL.UNSIGNED_SHORT_5_6_5_REV),
        [1, 0, 0, 1]);
    // In BGRA the first field is blue.
    assert.deepEqual(texel(new Uint16Array([0x1f00]), GL.BGRA, GL.UNSIGNED_SHORT_4_4_4_4),
        [0, 1, 1 / 15, 0]);
    assert.deepEqual(texel(new Uint16Array([0x8000]), GL.RGBA, GL.UNSIGNED_SHORT_1_5_5_5_REV),
        [0, 0, 0, 1]);
    assert.deepEqual(texel(new Uint8Array([0xe0]), GL.RGB, GL.UNSIGNED_BYTE_3_3_2), [1, 0, 0, 1]);
    assert.deepEqual(texel(new Uint8Array([0x07]), GL.RGB, TEX.UNSIGNED_BYTE_2_3_3_REV),
        [1, 0, 0, 1]);
    assert.deepEqual(texel(new Uint32Array([0xc00003ff]), GL.RGBA,
        GL.UNSIGNED_INT_2_10_10_10_REV), [1, 0, 0, 1]);
    assert.deepEqual(texel(new Uint32Array([0x11223344]), GL.RGBA, GL.UNSIGNED_INT_8_8_8_8),
        [0x11 / 255, 0x22 / 255, 0x33 / 255, 0x44 / 255]);
    assert.deepEqual(texel(new Uint32Array([0x11223344]), GL.RGBA,
        GL.UNSIGNED_INT_8_8_8_8_REV), [0x44 / 255, 0x33 / 255, 0x22 / 255, 0x11 / 255]);
    // An integer format reads the fields as integers.
    assert.deepEqual(texel(new Uint32Array([0xc00003ff]), TEX.RGBA_INTEGER,
        GL.UNSIGNED_INT_2_10_10_10_REV), [1023, 0, 0, 3]);
});

test('the packed float types: three small floats, and a shared exponent', ()=>{
    // 1.0 in red (exponent 15), 2.0 in green (16), 0.5 in blue (14).
    const small = (15 << 6) | ((16 << 6) << 11) | ((14 << 5) << 22);
    assert.deepEqual(texel(new Uint32Array([small >>> 0]), GL.RGB,
        TEX.UNSIGNED_INT_10F_11F_11F_REV), [1, 2, 0.5, 1]);
    // Mantissas 256, 128, 0 over exponent 16: 1, 0.5, 0.
    const shared = 256 | (128 << 9) | (16 << 27);
    assert.deepEqual(texel(new Uint32Array([shared >>> 0]), GL.RGB,
        TEX.UNSIGNED_INT_5_9_9_9_REV), [1, 0.5, 0, 1]);
});

test('depth and stencil: fixed point read as a fraction, stencil as an integer', ()=>{
    assert.deepEqual(texel(new Uint32Array([0xffffff7f]), GL.DEPTH_STENCIL,
        GL.UNSIGNED_INT_24_8), [1, 0x7f, 0, 0]);
    const pair = new DataView(new ArrayBuffer(8));
    pair.setFloat32(0, 0.25, true);
    pair.setUint32(4, 0xabcdef12, true);
    assert.deepEqual(texel(pair, GL.DEPTH_STENCIL, TEX.FLOAT_32_UNSIGNED_INT_24_8_REV),
        [0.25, 0x12, 0, 0]);
    assert.deepEqual(texel(new Uint16Array([65535]), GL.DEPTH_COMPONENT, GL.UNSIGNED_SHORT),
        [1, 0, 0, 0]);
    assert.deepEqual(texel(new Uint8Array([200]), GL.STENCIL_INDEX, GL.UNSIGNED_BYTE),
        [0, 200, 0, 0]);
});

test('rows follow UNPACK_ALIGNMENT, ROW_LENGTH and the skips (section 8.4.4.1)', ()=>{
    const four = { ...TIGHT, alignment: 4 };
    assert.equal(some(clientLayout(3, 2, GL.RGB, GL.UNSIGNED_BYTE, four)).rowStride, 12);
    assert.equal(clientBytes(3, 2, 1, GL.RGB, GL.UNSIGNED_BYTE, four), 21);
    // A component as wide as the alignment is never padded.
    assert.equal(some(clientLayout(3, 1, GL.RED, GL.FLOAT, four)).rowStride, 12);
    assert.equal(some(clientLayout(1, 1, GL.RED, GL.FLOAT, { ...TIGHT, alignment: 8 }))
        .rowStride, 8);
    const skips = { ...TIGHT, rowLength: 5, skipRows: 1, skipPixels: 2, imageHeight: 3,
        skipImages: 1 };
    const layout = some(clientLayout(2, 2, GL.RED, GL.UNSIGNED_BYTE, skips));
    assert.deepEqual(layout, { pixelBytes: 1, rowStride: 5, imageStride: 15, first: 22 });
    const source = new Uint8Array(45).map((_, i)=>i);
    const read = some(decodeClient(source, 2, 2, 2, GL.RED, GL.UNSIGNED_BYTE, skips));
    assert.deepEqual(Array.from(read.filter((_, i)=>i % 4 === 0), v=>Math.round(v * 255)),
        [22, 23, 27, 28, 37, 38, 42, 43]);
    assert.equal(decodeClient(source.subarray(0, 43), 2, 2, 2, GL.RED, GL.UNSIGNED_BYTE, skips),
        null, 'too few bytes');
});

test('SWAP_BYTES reverses each component of more than a byte', ()=>{
    const swapped = { ...TIGHT, swapBytes: true };
    const data = new Uint8Array([0x3c, 0x00]);
    assert.deepEqual(Array.from(some(decodeClient(data, 1, 1, 1, GL.RED, TEX.HALF_FLOAT,
        swapped))), [1, 0, 0, 1]);
    const stored = some(unpackToStorage(data, 1, 1, 1, GL.RED, TEX.HALF_FLOAT, swapped,
        sized(TEX.R16F)));
    assert.deepEqual(Array.from(stored), [0x00, 0x3c]);
});

test('the internal format clamps and rounds what it is given (section 8.5)', ()=>{
    const store = (/** @type {number} */ internal, /** @type {number[]} */ values)=>Array.from(
        encodeStorage(Float64Array.from(values), sized(internal)));
    assert.deepEqual(store(TEX.R8, [2, 0, 0, 1]), [255]);
    assert.deepEqual(store(TEX.R8, [-1, 0, 0, 1]), [0]);
    assert.deepEqual(store(TEX.R8_SNORM, [-1, 0, 0, 1]), [0x81]);
    assert.deepEqual(store(TEX.R8_SNORM, [-3, 0, 0, 1]), [0x81]);
    assert.deepEqual(store(TEX.R16, [0.5, 0, 0, 1]), [0x00, 0x80]);
    assert.deepEqual(store(TEX.R8UI, [300, 0, 0, 1]), [255]);
    assert.deepEqual(store(TEX.R8UI, [-3, 0, 0, 1]), [0]);
    assert.deepEqual(store(TEX.R8I, [-300, 0, 0, 1]), [0x80]);
    assert.deepEqual(store(TEX.R16F, [1, 0, 0, 1]), [0x00, 0x3c]);
    assert.deepEqual(store(TEX.RGB8UI, [1, 2, 3, 9]), [1, 2, 3, 1], 'RGB keeps alpha one');
    assert.deepEqual(store(TEX.RGB8_SNORM, [1, 0, -1, 0]), [127, 0, 0x81, 127]);
    assert.deepEqual(store(TEX.DEPTH_COMPONENT16, [2, 0, 0, 0]), [0xff, 0xff]);
    assert.deepEqual(store(TEX.DEPTH_COMPONENT24, [1, 0, 0, 0]), [0xff, 0xff, 0xff, 0]);
    assert.deepEqual(store(TEX.DEPTH24_STENCIL8, [0, 0x5a, 0, 0]), [0, 0, 0, 0x5a]);
    assert.deepEqual(store(TEX.DEPTH24_STENCIL8, [2, 1, 0, 0]), [0xff, 0xff, 0xff, 1]);
    assert.deepEqual(store(TEX.STENCIL_INDEX8, [0, 300, 0, 0]), [255]);
    const float = new DataView(encodeStorage(Float64Array.from([-2, 0, 0, 0]),
        sized(TEX.DEPTH_COMPONENT32F)).buffer);
    assert.equal(float.getFloat32(0, true), -2, 'a float depth is not clamped');
    const fixed = new DataView(encodeStorage(Float64Array.from([-2, 0, 0, 0]),
        sized(TEX.DEPTH_COMPONENT32)).buffer);
    assert.equal(fixed.getFloat32(0, true), 0, 'a fixed-point depth is');
    const rgb10 = new DataView(encodeStorage(Float64Array.from([1, 0, 0.5, 1]),
        sized(TEX.RGB10_A2UI)).buffer).getUint32(0, true);
    assert.equal(rgb10, (1 | (0 << 10) | (0 << 20) | (1 << 30)) >>> 0,
        'an integer format truncates');
});

test('R11F_G11F_B10F: negative is zero, too large is the largest (section 2.3.4.3)', ()=>{
    const word = (/** @type {number[]} */ values)=>new DataView(encodeStorage(
        Float64Array.from(values), sized(TEX.R11F_G11F_B10F)).buffer).getUint32(0, true);
    assert.equal(word([1, 2, 0.5, 1]), ((15 << 6) | ((16 << 6) << 11) | ((14 << 5) << 22)) >>> 0);
    assert.equal(word([-1, 0, 0, 1]), 0);
    assert.equal(word([1e9, 0, 0, 1]) & 0x7ff, 0x7bf, '65024');
    assert.equal(word([70000, 0, 0, 1]) & 0x7ff, 0x7bf, 'past the largest exponent');
    assert.equal(word([Infinity, 0, 0, 1]) & 0x7ff, 0x7c0);
    assert.equal(word([0, 0, 1e9, 1]) >>> 22, 0x3df, '64512');
    // 1 + 1/128 is half way between two 6-bit mantissas: the even one wins.
    assert.equal(word([1 + 1 / 128, 0, 0, 1]) & 0x7ff, 15 << 6);
    assert.equal(word([1 + 3 / 128, 0, 0, 1]) & 0x7ff, (15 << 6) | 2);
    const back = decodeStorage(encodeStorage(Float64Array.from([0.375, 1000, 6e-5, 1]),
        sized(TEX.R11F_G11F_B10F)), sized(TEX.R11F_G11F_B10F));
    assert.deepEqual(Array.from(back.subarray(0, 2)), [0.375, 1000]);
});

test('RGB9_E5 takes its exponent from the largest component (section 8.5.2)', ()=>{
    const word = (/** @type {number[]} */ values)=>new DataView(encodeStorage(
        Float64Array.from(values), sized(TEX.RGB9_E5)).buffer).getUint32(0, true);
    assert.equal(word([1, 0.5, 0, 1]), (256 | (128 << 9) | (16 << 27)) >>> 0);
    assert.equal(word([0, 0, 0, 1]), 0);
    // 511.9 rounds its mantissa to 512 over exponent 8: one exponent up.
    assert.equal(word([511.9, 0, 0, 1]) >>> 27, 15 + 10);
    assert.equal(word([1e9, -1, 0, 1]), (511 | (31 << 27)) >>> 0, 'clamped to the largest');
});

test('the errors of a transfer (sections 8.4.4 and 8.5)', ()=>{
    const cases = [
        [TEX.R8, GL.RED, GL.UNSIGNED_BYTE, 0],
        [TEX.R8, 0x1234, GL.UNSIGNED_BYTE, GL.INVALID_ENUM],
        [TEX.R8, GL.RED, 0x1234, GL.INVALID_ENUM],
        [TEX.R8, TEX.RED_INTEGER, GL.UNSIGNED_BYTE, GL.INVALID_OPERATION],
        [TEX.R8I, GL.RED, GL.BYTE, GL.INVALID_OPERATION],
        [TEX.R32I, TEX.RED_INTEGER, GL.FLOAT, GL.INVALID_OPERATION],
        [TEX.R32I, TEX.RED_INTEGER, GL.INT, 0],
        [TEX.RGBA8UI, TEX.BGRA_INTEGER, GL.UNSIGNED_INT_8_8_8_8_REV, 0],
        [TEX.RGBA16F, GL.RGBA, GL.UNSIGNED_SHORT_5_6_5, GL.INVALID_OPERATION],
        [TEX.R11F_G11F_B10F, GL.RGBA, TEX.UNSIGNED_INT_10F_11F_11F_REV, GL.INVALID_OPERATION],
        [TEX.R11F_G11F_B10F, GL.RGB, TEX.UNSIGNED_INT_10F_11F_11F_REV, 0],
        [TEX.DEPTH_COMPONENT16, GL.RGBA, GL.UNSIGNED_BYTE, GL.INVALID_OPERATION],
        [TEX.R16F, GL.DEPTH_COMPONENT, GL.FLOAT, GL.INVALID_OPERATION],
        [TEX.DEPTH24_STENCIL8, GL.DEPTH_STENCIL, GL.UNSIGNED_INT_24_8, 0],
        [TEX.DEPTH24_STENCIL8, GL.DEPTH_COMPONENT, GL.FLOAT, 0],
        [TEX.DEPTH24_STENCIL8, GL.DEPTH_STENCIL, GL.UNSIGNED_INT, GL.INVALID_OPERATION],
        [TEX.DEPTH_COMPONENT24, GL.DEPTH_COMPONENT, GL.UNSIGNED_INT_24_8, GL.INVALID_OPERATION],
        [TEX.DEPTH24_STENCIL8, GL.STENCIL_INDEX, GL.UNSIGNED_BYTE, GL.INVALID_OPERATION],
        [TEX.STENCIL_INDEX8, GL.STENCIL_INDEX, GL.UNSIGNED_BYTE, 0],
        [TEX.STENCIL_INDEX8, GL.RED, GL.UNSIGNED_BYTE, GL.INVALID_OPERATION],
    ];
    for (const [internal, format, type, error] of cases)
    {
        assert.equal(transferError(sized(internal), format, type), error,
            `${sized(internal).name} 0x${format.toString(16)} 0x${type.toString(16)}`);
    }
});

/**
 * A seeded generator, so a failing case is the same case next time.
 *
 * @param {number} seed
 */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state;
    };
}

test('every sized format: its own layout round-trips byte for byte', ()=>{
    const next = random(17);
    for (const format of SIZED_FORMATS.values())
    {
        const own = storageLayout(format);
        if (!own)
        {
            continue;
        }
        const [width, height, depth] = [3, 2, 2];
        const bytes = new Uint8Array(width * height * depth * modelTexelBytes(format));
        bytes.forEach((_, i)=>{
            bytes[i] = next() & 0xff;
        });
        if (own.type === GL.FLOAT)
        {
            // Any finite float: NaN payloads are not values.
            const floats = new Float32Array(bytes.buffer);
            floats.forEach((_, i)=>{
                floats[i] = (next() / 0x10000 - 0x8000) / 7;
            });
        }
        if (own.type === TEX.HALF_FLOAT)
        {
            const halves = new Uint16Array(bytes.buffer);
            halves.forEach((_, i)=>{
                halves[i] = next() & 0x7bff;
            });
        }
        const out = some(packFromStorage(bytes, width, height, depth, own.format, own.type,
            TIGHT, format));
        assert.deepEqual(out, bytes, format.name);
        // The copy row by row and the conversion give the same bytes.
        const converted = encodeStorage(some(decodeClient(bytes, width, height, depth,
            own.format, own.type, TIGHT)), format);
        assert.deepEqual(some(unpackToStorage(bytes, width, height, depth, own.format, own.type,
            TIGHT, format)), converted, format.name);
    }
});

test('every format of every family reads back what it stored, through RGBA/FLOAT', ()=>{
    const next = random(5);
    for (const format of SIZED_FORMATS.values())
    {
        if (format.compressed || format.kind === 'depth' || format.kind === 'stencil')
        {
            continue;
        }
        const integer = format.kind === 'int' || format.kind === 'uint';
        const client = integer ? TEX.RGBA_INTEGER : GL.RGBA;
        const type = integer ? GL.INT : GL.FLOAT;
        const values = new Float64Array(16).map(()=>(integer ? (next() % 200) - 100
            : (next() % 2001 - 1000) / 1000));
        const data = some(encodeClient(values, 4, 1, 1, client, type, TIGHT));
        const stored = some(unpackToStorage(data, 4, 1, 1, client, type, TIGHT, format));
        const again = some(unpackToStorage(some(packFromStorage(stored, 4, 1, 1, client, type,
            TIGHT, format)), 4, 1, 1, client, type, TIGHT, format));
        assert.deepEqual(again, stored,
            `${format.name}: storing what was read back changes nothing`);
    }
});

test('depth formats read back as DEPTH_COMPONENT/FLOAT what they stored', ()=>{
    for (const internal of [TEX.DEPTH_COMPONENT16, TEX.DEPTH_COMPONENT24,
        TEX.DEPTH_COMPONENT32F, TEX.DEPTH24_STENCIL8, TEX.DEPTH32F_STENCIL8])
    {
        const values = Float32Array.from([0, 0.25, 1, 0.5]);
        const stored = some(unpackToStorage(bytesOf(values), 4, 1, 1, GL.DEPTH_COMPONENT,
            GL.FLOAT, TIGHT, sized(internal)));
        const back = new Float32Array(some(packFromStorage(stored, 4, 1, 1,
            GL.DEPTH_COMPONENT, GL.FLOAT, TIGHT, sized(internal))).buffer);
        const step = sized(internal).depth === 16 ? 1 / 65535 : sized(internal).depth === 24
            ? 1 / 0xffffff : 0;
        back.forEach((depth, i)=>{
            // Half a step of the format, and a float32's own rounding of it.
            assert.ok(Math.abs(depth - values[i]) <= step / 2 + 2 ** -24,
                `${sized(internal).name} ${i}`);
        });
    }
    const pair = some(unpackToStorage(new Uint8Array([0x7f, 0, 0, 0x80]), 1, 1, 1,
        GL.DEPTH_STENCIL, GL.UNSIGNED_INT_24_8, TIGHT, sized(TEX.DEPTH24_STENCIL8)));
    assert.deepEqual(Array.from(some(packFromStorage(pair, 1, 1, 1, GL.DEPTH_STENCIL,
        GL.UNSIGNED_INT_24_8, TIGHT, sized(TEX.DEPTH24_STENCIL8)))), [0x7f, 0, 0, 0x80]);
});

test('packing writes the packed types back as it reads them', ()=>{
    const next = random(9);
    const types = [
        [GL.RGB, GL.UNSIGNED_BYTE_3_3_2], [GL.RGB, TEX.UNSIGNED_BYTE_2_3_3_REV],
        [GL.RGB, GL.UNSIGNED_SHORT_5_6_5], [GL.RGB, GL.UNSIGNED_SHORT_5_6_5_REV],
        [GL.BGRA, GL.UNSIGNED_SHORT_4_4_4_4], [GL.RGBA, GL.UNSIGNED_SHORT_4_4_4_4_REV],
        [GL.RGBA, GL.UNSIGNED_SHORT_5_5_5_1], [GL.BGRA, GL.UNSIGNED_SHORT_1_5_5_5_REV],
        [GL.RGBA, GL.UNSIGNED_INT_8_8_8_8], [GL.BGRA, GL.UNSIGNED_INT_8_8_8_8_REV],
        [GL.RGBA, GL.UNSIGNED_INT_10_10_10_2], [GL.RGBA, GL.UNSIGNED_INT_2_10_10_10_REV],
        [TEX.RGBA_INTEGER, GL.UNSIGNED_INT_2_10_10_10_REV],
    ];
    for (const [format, type] of types)
    {
        const bytes = some(clientLayout(8, 1, format, type, TIGHT)).pixelBytes * 8;
        const data = new Uint8Array(bytes).map(()=>next() & 0xff);
        const values = some(decodeClient(data, 8, 1, 1, format, type, TIGHT));
        assert.deepEqual(some(encodeClient(values, 8, 1, 1, format, type, TIGHT)), data,
            `0x${format.toString(16)} 0x${type.toString(16)}`);
    }
});
