/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ImageList_Write and ImageList_Read, over gdi32 and a stream that is guest
 * code, wired as the win32 module wires comctl32. The expectations are those
 * of Wine's test_imagelist_storage, which runs against Windows: the header's
 * counts as a list grows and shrinks, the size of each bitmap written, its
 * depth and its headers.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageLists } from './imagelist.js';
import { createComctlFunctions } from './functions.js';
import { createGdiFunctions } from '../gdi32/functions.js';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import { surfaceForDdb, surfaceForDibSection } from '../../graphics/gdi/surface.js';

const ILC_MASK = 0x0001;
const ILC_COLOR = 0x0000;
const ILC_COLOR4 = 0x0004;
const ILC_COLOR8 = 0x0008;
const ILC_COLOR24 = 0x0018;
const ILC_COLOR32 = 0x0020;
const CLR_NONE = 0xffffffff;
const ILD_TRANSPARENT = 0x0001;
const ILD_MASK = 0x0010;
const E_FAIL = 0x80004005 | 0;

/** Where the fake stream object, its vtable and its two methods are. */
const STREAM = 0x200;
const VTABLE = 0x210;
const READ_ENTRY = 0x7000;
const WRITE_ENTRY = 0x7004;
const INFO = 0x300;
const POINTER = 0x380;
const OUT = 0x400;

/** ILHEAD as Wine's tests declare it, packed to two bytes. */
const ILHEAD_SIZE = 28;

function machine(){
    const bytes = new Uint8Array(0x200000);
    const view = new DataView(bytes.buffer);
    let next = 0x10000;
    /** @param {number} size */
    const allocate = size=>{
        const address = next;
        next += (size + 0xff) & ~0xff;
        return address;
    };
    /** @type {number[]} */
    const released = [];
    let handle = 4;
    const readMemory = (/** @type {number} */ address, /** @type {number} */ length)=>
        bytes.slice(address, address + length);
    const writeMemory = (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
        bytes.set(data, address);
    const gdi = createGdiFunctions({
        readMemory, writeMemory,
        readCString: ()=>'',
        handles: { open: ()=>(handle += 4), close: ()=>undefined },
        surfaces: { allocate, free: ()=>undefined },
        graphics: {
            createDrawing: options=>createGdiDrawing(options),
            surfaceFor: (dc, bitmap)=>(bitmap.pixels ? surfaceForDdb(bitmap)
                : surfaceForDibSection(bitmap, bytes, 0)),
        },
    });
    const gdi32 = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (gdi.table));

    /**
     * The stream: what was written, and where Read takes the next byte from.
     * Its methods are guest code, reached through the vtable at VTABLE.
     */
    /** @type {{ data: Uint8Array, at: number, writes: number, failWrite: boolean }} */
    const stream = { data: new Uint8Array(0), at: 0, writes: 0, failWrite: false };
    view.setUint32(STREAM, VTABLE, true);
    view.setUint32(VTABLE + 3 * 4, READ_ENTRY, true);
    view.setUint32(VTABLE + 4 * 4, WRITE_ENTRY, true);
    /** @type {unknown[]} */
    const threads = [];
    /** @param {number} entry @param {number[]} args @param {unknown} thread */
    const call = (entry, args, thread)=>{
        const [self, buffer, count, done] = args;
        threads.push(thread);
        assert.equal(self, STREAM, 'this is the stream');
        if (entry === WRITE_ENTRY)
        {
            if (stream.failWrite)
            {
                return Promise.resolve(E_FAIL);
            }
            const joined = new Uint8Array(stream.data.length + count);
            joined.set(stream.data);
            joined.set(bytes.slice(buffer, buffer + count), stream.data.length);
            stream.data = joined;
            stream.writes++;
            if (done !== 0)
            {
                view.setUint32(done, count, true);
            }
            return Promise.resolve(0);
        }
        assert.equal(entry, READ_ENTRY);
        const taken = stream.data.slice(stream.at, stream.at + count);
        bytes.set(taken, buffer);
        stream.at += taken.length;
        if (done !== 0)
        {
            view.setUint32(done, taken.length, true);
        }
        // An HGLOBAL stream answers S_OK however little was left.
        return Promise.resolve(0);
    };
    const lists = createImageLists({
        readMemory, writeMemory,
        gdi32: name=>gdi32[name],
        bitmapSize: bitmap=>gdi.bitmapSize(bitmap),
    });
    const comctl = createComctlFunctions({
        readMemory, writeMemory, imageLists: lists,
        allocate,
        release: address=>released.push(address),
        call,
        callerThread: ()=>'caller',
    });
    const fns = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => any }>} */ (/** @type {unknown} */ (comctl));

    /**
     * A 32-bit DIB section, top-down, holding `pixels`.
     *
     * @param {number} width @param {number} height @param {number[]} pixels
     */
    const section = (width, height, pixels)=>{
        bytes.fill(0, INFO, INFO + 40);
        view.setUint32(INFO, 40, true);
        view.setInt32(INFO + 4, width, true);
        view.setInt32(INFO + 8, -height, true);
        view.setUint16(INFO + 12, 1, true);
        view.setUint16(INFO + 14, 32, true);
        const bitmap = gdi32.CreateDIBSection.handler([0, INFO, 0, POINTER, 0, 0]);
        const at = view.getUint32(POINTER, true);
        pixels.forEach((pixel, index)=>view.setUint32(at + index * 4, pixel >>> 0, true));
        return bitmap;
    };
    /** A DC over a new 32-bit section of one row, and its pixels. @param {number} width */
    const target = width=>{
        bytes.fill(0, INFO, INFO + 40);
        view.setUint32(INFO, 40, true);
        view.setInt32(INFO + 4, width, true);
        view.setInt32(INFO + 8, -1, true);
        view.setUint16(INFO + 12, 1, true);
        view.setUint16(INFO + 14, 32, true);
        const bitmap = gdi32.CreateDIBSection.handler([0, INFO, 0, POINTER, 0, 0]);
        const at = view.getUint32(POINTER, true);
        const dc = gdi32.CreateCompatibleDC.handler([0]);
        gdi32.SelectObject.handler([dc, bitmap]);
        return {
            dc,
            /** @param {number} value */
            fill: value=>[...Array(width).keys()].forEach(x=>view.setUint32(at + x * 4,
                value >>> 0, true)),
            pixels: ()=>[...Array(width).keys()].map(x=>view.getUint32(at + x * 4, true)),
        };
    };

    /** Writes a list into an empty stream; what Write answered. @param {number} list */
    const write = async list=>{
        Object.assign(stream, { data: new Uint8Array(0), at: 0, writes: 0 });
        return fns.ImageList_Write.handler([list, STREAM]);
    };
    /** Reads a list from the start of what was written. */
    const read = async()=>{
        stream.at = 0;
        return fns.ImageList_Read.handler([STREAM]);
    };
    return { bytes, view, gdi32, fns, stream, threads, released, section, target, write, read };
}

/**
 * What a written list holds, read the way Wine's check_ilhead_data and
 * check_bitmap_data read it.
 *
 * @param {Uint8Array} data
 */
function parse(data){
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const word = (/** @type {number} */ at)=>view.getUint16(at, true);
    const header = {
        magic: word(0), version: word(2), cur: word(4), max: word(6), grow: word(8),
        cx: word(10), cy: word(12), bkcolor: view.getUint32(14, true), flags: word(18),
        ovls: [0, 1, 2, 3].map(index=>view.getInt16(20 + index * 2, true)),
    };
    /** @param {number} at */
    const bitmap = at=>{
        const bpp = word(at + 14 + 14);
        const headers = 14 + 40 + (bpp <= 8 ? (1 << bpp) * 4 : 0);
        const width = view.getInt32(at + 14 + 4, true);
        const height = view.getInt32(at + 14 + 8, true);
        const stride = ((width * bpp + 31) >>> 5) * 4;
        return {
            type: word(at), bfSize: view.getUint32(at + 2, true),
            reserved: [word(at + 6), word(at + 8)], offBits: view.getUint32(at + 10, true),
            biSize: view.getUint32(at + 14, true), width, height, planes: word(at + 14 + 12),
            bpp, sizeImage: view.getUint32(at + 14 + 20, true), headers, stride,
            bits: at + headers, end: at + headers + stride * height,
        };
    };
    const image = bitmap(ILHEAD_SIZE);
    const mask = image.end < data.length ? bitmap(image.end) : null;
    return { header, image, mask, end: mask ? mask.end : image.end };
}

/**
 * Checks what a written list holds as Wine's check_iml_data does, and that
 * it reads back.
 *
 * @param {ReturnType<typeof machine>} m @param {number} list
 * @param {{ cx: number, cy: number, cur: number, max: number, grow: number,
 *     flags: number }} expected
 * @param {string} comment
 */
async function checkStorage(m, list, expected, comment){
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), expected.cur, comment);
    assert.equal(await m.write(list), 1, comment);
    const written = parse(m.stream.data);
    const grown = (Math.max(expected.grow, 1) + 3) & ~3;
    assert.deepEqual(written.header, {
        magic: 0x4c49, version: 0x101, cur: expected.cur, max: expected.max, grow: grown,
        cx: expected.cx, cy: expected.cy, bkcolor: CLR_NONE, flags: expected.flags,
        ovls: [-1, -1, -1, -1],
    }, comment);
    const size = { width: expected.cx * 4, height: Math.ceil(expected.max / 4) * expected.cy };
    const bitmaps = [[written.image, expected.flags & 0xfe]];
    if ((expected.flags & ILC_MASK) !== 0)
    {
        assert.ok(written.mask, `${comment}: the mask follows the image`);
        bitmaps.push([written.mask, 1]);
    }
    else
    {
        assert.equal(written.mask, null, `${comment}: no mask`);
    }
    for (const [bitmap, bpp] of /** @type {[any, number][]} */ (bitmaps))
    {
        assert.deepEqual([bitmap.type, bitmap.bfSize, bitmap.reserved, bitmap.offBits],
            [0x4d42, bitmap.headers, [0, 0], bitmap.headers],
            `${comment}: bfSize is the headers' size, as Windows writes it`);
        assert.deepEqual([bitmap.biSize, bitmap.planes, bitmap.bpp, bitmap.sizeImage],
            [40, 1, bpp, bitmap.stride * bitmap.height], comment);
        assert.deepEqual({ width: bitmap.width, height: bitmap.height }, size, comment);
    }
    assert.equal(written.end, m.stream.data.length, `${comment}: nothing after the bitmaps`);
    const copy = await m.read();
    assert.notEqual(copy, 0, `${comment}: read back`);
    assert.equal(m.fns.ImageList_Destroy.handler([copy]), 1);
}

test('ImageList_Write writes the header and the bitmaps Windows writes', async()=>{
    const m = machine();
    assert.equal(m.fns.ImageList_Write.argBytes, 8);
    assert.equal(m.fns.ImageList_Read.argBytes, 4);
    const list = m.fns.ImageList_Create.handler([4, 4, ILC_COLOR24, 1, 1]);
    await checkStorage(m, list, { cx: 4, cy: 4, cur: 0, max: 2, grow: 1, flags: ILC_COLOR24 },
        'empty');
    assert.equal(m.stream.writes, 2, 'the header, then the image');
    assert.ok(m.threads.every(thread=>thread === 'caller'), 'on the caller\'s thread');
    assert.ok(m.released.length > 0, 'the guest memory it lent is given back');
});

test('the room a list has grows, shrinks and is written as Windows keeps it', async()=>{
    // test_imagelist_storage's image_list_init: one image at a time into a
    // list made with one place and a cGrow of one, which is four.
    const m = machine();
    const list = m.fns.ImageList_Create.handler([4, 4, ILC_COLOR24, 1, 1]);
    const bitmap = m.section(4, 4, Array(16).fill(0x808080));
    const maxes = [2, 7, 7, 7, 7, 7, 12, 12, 12, 12, 12, 17];
    for (const [index, max] of maxes.entries())
    {
        assert.equal(m.fns.ImageList_Add.handler([list, bitmap, 0]), index);
        await checkStorage(m, list, { cx: 4, cy: 4, cur: index + 1, max, grow: 1,
            flags: ILC_COLOR24 }, `total ${index + 1}`);
    }
    assert.equal(m.fns.ImageList_Remove.handler([list, 4]), 1);
    await checkStorage(m, list, { cx: 4, cy: 4, cur: 11, max: 17, grow: 1, flags: ILC_COLOR24 },
        'one removed keeps the room');
    assert.equal(m.fns.ImageList_Remove.handler([list, -1]), 1);
    await checkStorage(m, list, { cx: 4, cy: 4, cur: 0, max: 4, grow: 1, flags: ILC_COLOR24 },
        'all removed leaves cGrow');

    const strip = m.section(36, 4, Array(144).fill(0x404040));
    const byNine = m.fns.ImageList_Create.handler([4, 4, ILC_COLOR24, 4, 4]);
    await checkStorage(m, byNine, { cx: 4, cy: 4, cur: 0, max: 5, grow: 4, flags: ILC_COLOR24 },
        'init 4 grow 4');
    assert.equal(m.fns.ImageList_Add.handler([byNine, strip, 0]), 0);
    await checkStorage(m, byNine, { cx: 4, cy: 4, cur: 9, max: 15, grow: 4,
        flags: ILC_COLOR24 }, 'add 9 x 1');
    assert.equal(m.fns.ImageList_Add.handler([byNine, strip, 0]), 9);
    await checkStorage(m, byNine, { cx: 4, cy: 4, cur: 18, max: 25, grow: 4,
        flags: ILC_COLOR24 }, 'add 9 x 1 again');

    for (const [initial, grow, max] of [[207, 209, 208], [209, 207, 210], [14, 4, 15],
        [5, 9, 6], [9, 5, 10], [2, 4, 3], [0, 32, 1]])
    {
        const made = m.fns.ImageList_Create.handler([4, 4, ILC_COLOR24, initial, grow]);
        await checkStorage(m, made, { cx: 4, cy: 4, cur: 0, max, grow, flags: ILC_COLOR24 },
            `init ${initial} grow ${grow}`);
    }
    const negative = m.fns.ImageList_Create.handler([4, 4, ILC_COLOR4 | ILC_MASK, 2, -20]);
    await checkStorage(m, negative, { cx: 4, cy: 4, cur: 0, max: 3, grow: -20,
        flags: ILC_COLOR4 | ILC_MASK }, 'init 2 grow -20');
});

test('icons, SetImageCount and the depths a list is written at', async()=>{
    // test_imagelist_storage: ILC_COLOR is written as ILC_COLOR4, a list
    // with a mask writes it after the image at one bit, an icon appended
    // grows the list as an image does, and SetImageCount leaves one place.
    const m = machine();
    for (const [flags, written] of [[ILC_COLOR8, ILC_COLOR8], [ILC_COLOR4, ILC_COLOR4],
        [ILC_COLOR, ILC_COLOR4], [ILC_COLOR24 | ILC_MASK, ILC_COLOR24 | ILC_MASK],
        [ILC_COLOR4 | ILC_MASK, ILC_COLOR4 | ILC_MASK]])
    {
        const list = m.fns.ImageList_Create.handler([4, 4, flags, 4, 2]);
        await checkStorage(m, list, { cx: 4, cy: 4, cur: 0, max: 5, grow: 2, flags: written },
            `flags ${flags}`);
        assert.equal(m.fns.ImageList_ReplaceIcon.handler([list, -1, 0x1234]), 0);
        assert.equal(m.fns.ImageList_ReplaceIcon.handler([list, -1, 0x1234]), 1);
        await checkStorage(m, list, { cx: 4, cy: 4, cur: 2, max: 5, grow: 2, flags: written },
            `flags ${flags}, two icons`);
    }

    const list = m.fns.ImageList_Create.handler([4, 4, ILC_COLOR4 | ILC_MASK, 2, 99]);
    const flags = ILC_COLOR4 | ILC_MASK;
    m.fns.ImageList_ReplaceIcon.handler([list, -1, 0x1234]);
    m.fns.ImageList_ReplaceIcon.handler([list, -1, 0x1234]);
    await checkStorage(m, list, { cx: 4, cy: 4, cur: 2, max: 3, grow: 99, flags }, '2 icons');
    assert.equal(m.fns.ImageList_ReplaceIcon.handler([list, -1, 0x1234]), 2);
    await checkStorage(m, list, { cx: 4, cy: 4, cur: 3, max: 104, grow: 99, flags }, '3 icons');
    assert.equal(m.fns.ImageList_Remove.handler([list, -1]), 1);
    await checkStorage(m, list, { cx: 4, cy: 4, cur: 0, max: 100, grow: 99, flags }, 'empty');
    for (const count of [22, 0, 42])
    {
        assert.equal(m.fns.ImageList_SetImageCount.handler([list, count]), 1);
        await checkStorage(m, list, { cx: 4, cy: 4, cur: count, max: count + 1, grow: 99,
            flags }, `set count ${count}`);
    }
});

test('the images are written four to a row, top row first, the mask beside them', async()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR24 | ILC_MASK, 4, 4]);
    const colours = [0x0000ff, 0x00ff00, 0xff0000, 0x00ffff, 0xff00ff];
    const strip = m.section(10, 1, colours.flatMap(colour=>[colour, colour]));
    // Each image's right pixel transparent: a mask byte of 0x55 per pair.
    m.bytes.set([0x55, 0x40, 0, 0], OUT);
    const mask = m.gdi32.CreateBitmap.handler([10, 1, 1, 1, OUT]);
    assert.equal(m.fns.ImageList_Add.handler([list, strip, mask]), 0);
    assert.equal(await m.write(list), 1);
    const written = parse(m.stream.data);
    // Five images in a list of five places grew it to eleven: three rows.
    assert.equal(written.header.max, 11);
    assert.deepEqual([written.image.width, written.image.height], [8, 3]);
    const { image } = written;
    /** The colour at (x, y) from the top, out of the bottom-up 24-bit rows. */
    const pixel = (/** @type {number} */ x, /** @type {number} */ y)=>{
        const at = image.bits + (image.height - 1 - y) * image.stride + x * 3;
        return m.stream.data[at] | m.stream.data[at + 1] << 8 | m.stream.data[at + 2] << 16;
    };
    colours.forEach((colour, index)=>{
        const x = (index % 4) * 2;
        const y = Math.floor(index / 4);
        assert.equal(pixel(x, y), colour, `image ${index}`);
        assert.equal(pixel(x + 1, y), 0, `image ${index} is black under its mask`);
    });
    const bits = /** @type {any} */ (written.mask);
    /** The mask bit at (x, y) from the top. */
    const maskBit = (/** @type {number} */ x, /** @type {number} */ y)=>(m.stream.data[bits.bits
        + (bits.height - 1 - y) * bits.stride + (x >> 3)] >> (7 - (x & 7))) & 1;
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map(x=>maskBit(x, 0)), [0, 1, 0, 1, 0, 1, 0, 1]);
    assert.deepEqual([maskBit(0, 1), maskBit(1, 1)], [0, 1], 'the fifth on the second row');
    const table = bits.bits - 8;
    assert.deepEqual([...m.stream.data.slice(table, table + 8)], [0, 0, 0, 0, 255, 255, 255, 0],
        'the mask\'s colours: black, then white');
});

test('a list read back is the list written: its images, its mask and its colour', async()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR32 | ILC_MASK, 1, 2]);
    const colours = [0x123456, 0x654321, 0x0a0b0c, 0x112233, 0x445566];
    m.bytes.set([0x55, 0x40, 0, 0], OUT);
    const mask = m.gdi32.CreateBitmap.handler([10, 1, 1, 1, OUT]);
    m.fns.ImageList_Add.handler([list, m.section(10, 1, colours.flatMap(c=>[c, c])), mask]);
    m.fns.ImageList_SetBkColor.handler([list, 0x00ff00]);
    assert.equal(await m.write(list), 1);
    const original = m.stream.data.slice();
    const copy = await m.read();
    assert.notEqual(copy, 0);
    assert.notEqual(copy, list, 'a new list');
    assert.equal(m.stream.at, m.stream.data.length, 'it read all that was written, and no more');
    assert.equal(m.fns.ImageList_GetImageCount.handler([copy]), 5);
    assert.equal(m.fns.ImageList_GetIconSize.handler([copy, OUT, OUT + 4]), 1);
    assert.deepEqual([m.view.getInt32(OUT, true), m.view.getInt32(OUT + 4, true)], [2, 1]);
    assert.equal(m.fns.ImageList_GetBkColor.handler([copy]), 0x00ff00);
    const dest = m.target(2);
    colours.forEach((colour, index)=>{
        dest.fill(0x777777);
        assert.equal(m.fns.ImageList_Draw.handler([copy, index, dest.dc, 0, 0, ILD_TRANSPARENT]),
            1);
        assert.deepEqual(dest.pixels(), [colour, 0x777777], `image ${index} through its mask`);
        dest.fill(0x777777);
        m.fns.ImageList_Draw.handler([copy, index, dest.dc, 0, 0, ILD_MASK]);
        assert.deepEqual(dest.pixels(), [0, 0xffffff], `mask ${index}`);
    });
    assert.equal(await m.write(copy), 1);
    assert.deepEqual(m.stream.data, original, 'and it writes what the original wrote');
});

test('a 4-bit list reads back at its depth, its colours from the VGA table', async()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR, 0, 1]);
    m.fns.ImageList_Add.handler([list, m.section(2, 1, [0xff0000, 0x0000ff]), 0]);
    assert.equal(await m.write(list), 1);
    assert.equal(parse(m.stream.data).image.bpp, 4);
    const copy = await m.read();
    assert.notEqual(copy, 0);
    const dest = m.target(2);
    m.fns.ImageList_Draw.handler([copy, 0, dest.dc, 0, 0, ILD_TRANSPARENT]);
    assert.deepEqual(dest.pixels(), [0xff0000, 0x0000ff], 'pure colours survive four bits');
});

test('ImageList_Read refuses what is not a list Windows XP\'s library wrote', async()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR24 | ILC_MASK, 0, 1]);
    assert.equal(await m.write(list), 1);
    const good = m.stream.data.slice();
    /** @param {(data: Uint8Array) => Uint8Array} spoil */
    const readSpoilt = async spoil=>{
        m.stream.data = spoil(good.slice());
        return m.read();
    };
    assert.notEqual(await readSpoilt(data=>data), 0, 'the unspoilt stream reads');
    assert.equal(await readSpoilt(data=>{
        data[0] = 0x4a;
        return data;
    }), 0, 'another magic');
    assert.equal(await readSpoilt(data=>{
        data.set([0x00, 0x06], 2);
        return data;
    }), 0, 'the version-6 library\'s layout');
    assert.equal(await readSpoilt(data=>{
        data.set([0, 0], 10);
        return data;
    }), 0, 'no image width');
    assert.equal(await readSpoilt(data=>{
        data.set([0x42, 0x41], ILHEAD_SIZE);
        return data;
    }), 0, 'a bitmap that is not one');
    assert.equal(await readSpoilt(data=>data.slice(0, data.length - 1)), 0,
        'a stream that ends a byte early');
    assert.equal(await readSpoilt(data=>data.slice(0, 20)), 0, 'one that ends in the header');
    assert.equal(await m.fns.ImageList_Read.handler([0]), 0, 'no stream');
});

test('ImageList_Write refuses no list, no stream and a stream that will not take it', async()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR24, 0, 1]);
    assert.equal(await m.write(0x9999), 0, 'no list');
    assert.equal(m.stream.writes, 0, 'and nothing was written');
    assert.equal(await m.fns.ImageList_Write.handler([list, 0]), 0, 'no stream');
    m.stream.failWrite = true;
    assert.equal(await m.write(list), 0, 'a refused write');
});

test('a host with no guest calls cannot use a stream, and says so', async()=>{
    /** @type {string[]} */
    const said = [];
    const memory = new Uint8Array(0x100);
    const fns = /** @type {any} */ (createComctlFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, data)=>memory.set(data, address),
        divergence: api=>said.push(api),
    }));
    const list = fns.ImageList_Create.handler([2, 1, ILC_COLOR32, 0, 1]);
    assert.equal(await fns.ImageList_Write.handler([list, 0x40]), 0);
    assert.equal(await fns.ImageList_Read.handler([0x40]), 0);
    assert.deepEqual(said, ['ImageList_Write', 'ImageList_Read']);
});
