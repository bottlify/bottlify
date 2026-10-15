/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Enhanced metafiles recorded and played over the real drawing engine, their
 * bytes read and written as Wine's metafile tests read and write them, and
 * the conversion to a Windows metafile and back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMR, META, emfRecords, readEmfHeader, viewOf, wmfRecords } from './emf.js';
import { painted } from './fixtures.test.js';

const RECT = 0x1000;
const OUT = 0x2000;
const POINTS = 0x1800;
const ERROR_INVALID_DATA = 13;
const ERROR_NOT_SUPPORTED = 50;
const MM_ANISOTROPIC = 8;
const RED = 0x0000ff;
const RED_PIXEL = 0xff0000;
const WHITE_PIXEL = 0xffffff;

/**
 * @param {ReturnType<typeof painted>} machine @param {number[]} values
 * @param {number} [at]
 */
function putInts(machine, values, at = RECT){
    values.forEach((value, index)=>machine.view.setInt32(at + index * 4, value, true));
}

/** @param {ReturnType<typeof painted>} machine @param {number} metafile */
function bitsOf(machine, metafile){
    const size = machine.fns.GetEnhMetaFileBits.handler([metafile, 0, 0]);
    assert.ok(size > 0);
    const at = 0x60000;
    assert.equal(machine.fns.GetEnhMetaFileBits.handler([metafile, size, at]), size);
    return machine.bytes.slice(at, at + size);
}

/**
 * A picture recorded on an enhanced metafile DC: a red square with a black
 * border, and a triangle.
 *
 * @param {ReturnType<typeof painted>} machine @param {number[] | null} frame
 */
function recordPicture(machine, frame){
    const { fns } = machine;
    if (frame)
    {
        putInts(machine, frame);
    }
    const hdc = fns.CreateEnhMetaFileA.handler([0, 0, frame ? RECT : 0, 0]);
    const brush = fns.CreateSolidBrush.handler([RED]);
    fns.SelectObject.handler([hdc, brush]);
    fns.SelectObject.handler([hdc, fns.GetStockObject.handler([7])]);
    fns.Rectangle.handler([hdc, 0, 0, 10, 10]);
    putInts(machine, [12, 0, 16, 8, 12, 8], POINTS);
    fns.Polygon.handler([hdc, POINTS, 3]);
    fns.DeleteObject.handler([brush]);
    return fns.CloseEnhMetaFile.handler([hdc]);
}

test('what is drawn on an enhanced metafile DC is recorded, with the bounds it covers', ()=>{
    const machine = painted(4, 4);
    const bits = bitsOf(machine, recordPicture(machine, null));
    const header = readEmfHeader(bits);
    const view = viewOf(bits);
    assert.equal(view.getUint32(40, true), 0x464d4520, '\' EMF\'');
    assert.equal(header.bytes, bits.length);
    const records = emfRecords(bits);
    assert.equal(header.records, records.length);
    assert.deepEqual(records.map(record=>record.type), [EMR.HEADER, EMR.CREATEBRUSHINDIRECT,
        EMR.SELECTOBJECT, EMR.SELECTOBJECT, EMR.RECTANGLE, EMR.POLYGON16, EMR.DELETEOBJECT,
        EMR.EOF]);
    assert.equal(header.handles, 2, 'the metafile itself, and the brush');
    assert.equal(view.getUint32(records[3].offset + 8, true), 0x80000007, 'the stock black pen');
    assert.deepEqual(header.bounds, { left: 0, top: 0, right: 16, bottom: 9 },
        'in pixels, the right and bottom ones drawn included');
    assert.ok(header.frame.right > 0 && header.frame.bottom > 0, 'a frame worked out from them');
});

test('PlayEnhMetaFile draws the picture fitted to the rectangle it is given', ()=>{
    const machine = painted(40, 40);
    const { fns, dc, pixel, fill } = machine;
    // Frame the 0..20 pixel square: 20 pixels of a 96-dpi display are 529 hundredths of a
    // millimetre; the display here is 640 pixels and 169 millimetres across.
    const metafile = recordPicture(machine, [0, 0, 528, 528]);
    fill(WHITE_PIXEL);
    putInts(machine, [0, 0, 40, 40]);
    assert.equal(fns.PlayEnhMetaFile.handler([dc, metafile, RECT]), 1);
    assert.equal(pixel(10, 10) & 0xffffff, RED_PIXEL, 'the square, twice as large');
    assert.equal(pixel(0, 10) & 0xffffff, 0, 'its border');
    assert.equal(pixel(25, 10) & 0xffffff, RED_PIXEL, 'the triangle, moved as far');
    assert.equal(pixel(38, 38) & 0xffffff, WHITE_PIXEL, 'nothing past the picture');
    assert.equal(fns.GetCurrentObject.handler([dc, 2]), fns.GetStockObject.handler([0]),
        'and the DC\'s own brush back after it');

    fill(WHITE_PIXEL);
    putInts(machine, [20, 20, 30, 30]);
    fns.PlayEnhMetaFile.handler([dc, metafile, RECT]);
    assert.equal(pixel(22, 22) & 0xffffff, RED_PIXEL, 'half as large, where it is put');
    assert.equal(pixel(25, 25) & 0xffffff, WHITE_PIXEL);
    assert.equal(pixel(10, 10) & 0xffffff, WHITE_PIXEL);
    assert.equal(fns.PlayEnhMetaFile.handler([dc, metafile, 0]), 0, 'no rectangle');
    assert.equal(fns.PlayEnhMetaFile.handler([dc, dc, RECT]), 0, 'no metafile');
    assert.equal(fns.PlayEnhMetaFile.argBytes, 12);
});

test('SetEnhMetaFileBits takes what XP takes, and GetEnhMetaFileBits gives it back', ()=>{
    // Wine's test_SetEnhMetaFileBits.
    const machine = painted(1, 1);
    const { fns, bytes, view, errors } = machine;
    bytes.fill(0xaa, OUT, OUT + 256);
    assert.equal(fns.SetEnhMetaFileBits.handler([256, OUT]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_DATA);
    bytes.fill(0, OUT, OUT + 256);
    view.setUint32(OUT, EMR.HEADER, true);
    view.setUint32(OUT + 4, 108, true);
    view.setUint32(OUT + 40, 0x464d4520, true);
    view.setUint32(OUT + 48, 108, true);
    view.setUint16(OUT + 56, 1, true);
    const before = errors.length;
    const metafile = fns.SetEnhMetaFileBits.handler([108, OUT]);
    assert.notEqual(metafile, 0);
    assert.equal(fns.GetObjectType.handler([metafile]), 13, 'OBJ_ENHMETAFILE');
    view.setUint32(OUT + 48, 109, true);
    assert.equal(fns.SetEnhMetaFileBits.handler([109, OUT]), 0, 'unaligned');
    view.setUint32(OUT + 48, 108, true);
    view.setUint32(OUT + 40, 0, true);
    assert.equal(fns.SetEnhMetaFileBits.handler([108, OUT]), 0, 'no signature');
    view.setUint32(OUT + 40, 0x464d4520, true);
    view.setUint16(OUT + 56, 0, true);
    assert.equal(fns.SetEnhMetaFileBits.handler([108, OUT]), 0, 'no handles');
    assert.equal(errors.length, before, 'all three with nothing set');

    assert.equal(fns.GetEnhMetaFileBits.handler([metafile, 0, 0]), 108);
    assert.equal(fns.GetEnhMetaFileBits.handler([metafile, 20, 0x3000]), 20, 'what fits');
    assert.equal(fns.GetEnhMetaFileBits.handler([0xdeadbeef, 0, 0]), 0, 'no metafile');
    assert.equal(fns.GetEnhMetaFileHeader.handler([metafile, 0, 0]), 108);
    assert.equal(fns.GetEnhMetaFileHeader.handler([metafile, 200, 0x3000]), 108);
    assert.equal(view.getUint32(0x3000 + 40, true), 0x464d4520);
    assert.equal(fns.GetEnhMetaFilePaletteEntries.handler([metafile, 0, 0]), 0, 'no palette');
    assert.equal(fns.GetEnhMetaFilePaletteEntries.handler([0x9999, 0, 0]), 0xffffffff);
    assert.deepEqual([fns.SetEnhMetaFileBits, fns.GetEnhMetaFileBits, fns.GetEnhMetaFileHeader,
        fns.GetEnhMetaFilePaletteEntries].map(fn=>fn.argBytes), [8, 12, 12, 12]);
});

test('CopyEnhMetaFile copies in memory and refuses a file', ()=>{
    const machine = painted(4, 4);
    const { fns, errors } = machine;
    const metafile = recordPicture(machine, null);
    const copy = fns.CopyEnhMetaFileA.handler([metafile, 0]);
    assert.notEqual(copy, 0);
    assert.deepEqual(bitsOf(machine, copy), bitsOf(machine, metafile));
    assert.equal(fns.DeleteEnhMetaFile.handler([metafile]), 1);
    assert.ok(bitsOf(machine, copy).length > 0, 'the copy outlives the original');
    machine.bytes.set([0x61, 0x2e, 0x65, 0x6d, 0x66, 0], OUT);
    assert.equal(fns.CopyEnhMetaFileA.handler([copy, OUT]), 0);
    assert.equal(errors.at(-1), ERROR_NOT_SUPPORTED);
    assert.equal(fns.CopyEnhMetaFileW.handler([0x9999, 0]), 0);
    assert.equal(fns.CopyEnhMetaFileA.argBytes, 8);
});

test('GetWinMetaFileBits carries the EMF whole, and SetWinMetaFileBits gives it back', ()=>{
    // Wine's getwinmetafilebits, at a size that takes more than one chunk.
    const machine = painted(4, 4);
    const { fns, view, bytes } = machine;
    putInts(machine, [0, 0, 1000, 2000]);
    const hdc = fns.CreateEnhMetaFileA.handler([0, 0, RECT, 0]);
    for (let index = 0; index < 600; index++)
    {
        fns.Rectangle.handler([hdc, 0, 0, 100, 20]);
    }
    const emf = bitsOf(machine, fns.CloseEnhMetaFile.handler([hdc]));
    assert.ok(emf.length > 0x2000 * 1.5);
    const metafile = fns.SetEnhMetaFileBits.handler([emf.length,
        (()=>{
            bytes.set(emf, 0x50000);
            return 0x50000;
        })()]);
    const size = fns.GetWinMetaFileBits.handler([metafile, 0, 0, MM_ANISOTROPIC, 0]);
    assert.ok(size > emf.length);
    const at = 0x30000;
    assert.equal(fns.GetWinMetaFileBits.handler([metafile, size, at, MM_ANISOTROPIC, 0]), size);
    const wmf = bytes.slice(at, at + size);
    let sum = 0;
    for (let index = 0; index < size; index += 2)
    {
        sum = (sum + view.getUint16(at + index, true)) & 0xffff;
    }
    assert.equal(sum, 0, 'the checksum makes the words add up to nothing');
    const records = wmfRecords(wmf);
    const chunks = Math.ceil(emf.length / 0x2000);
    const wmfView = viewOf(wmf);
    records.slice(0, chunks).forEach((record, index)=>{
        const piece = index === chunks - 1 ? emf.length - index * 0x2000 : 0x2000;
        assert.equal(record.func, META.ESCAPE);
        assert.equal(record.size, piece + 44, `chunk ${index}`);
        assert.equal(wmfView.getUint16(record.offset + 6, true), 15, 'MFCOMMENT');
        assert.equal(wmfView.getUint32(record.offset + 10, true), 0x43464d57, 'WMFC');
        assert.equal(wmfView.getUint32(record.offset + 28, true), chunks);
        assert.equal(wmfView.getUint32(record.offset + 36, true),
            emf.length - piece - index * 0x2000, 'what is left after it');
        assert.equal(wmfView.getUint32(record.offset + 40, true), emf.length);
    });
    assert.deepEqual(records.slice(chunks, chunks + 3).map(record=>record.func),
        [META.SETMAPMODE, META.SETWINDOWORG, META.SETWINDOWEXT]);
    const ext = records[chunks + 2];
    // 1000 by 2000 hundredths of a millimetre, on a display of 640 by 480 pixels and
    // 169 by 127 millimetres.
    assert.deepEqual([wmfView.getInt16(ext.offset + 6, true), wmfView.getInt16(ext.offset + 8,
        true)], [Math.round(2000 * 480 / 12700), Math.round(1000 * 640 / 16900)]);
    assert.ok(records.slice(chunks + 3).every(record=>record.func === META.RECTANGLE),
        'and the rectangles, drawn again in WMF\'s terms');

    putInts(machine, [MM_ANISOTROPIC, 0xcafe, 0xbeef], OUT);
    const back = fns.SetWinMetaFileBits.handler([size, at, 0, OUT]);
    assert.notEqual(back, 0);
    assert.deepEqual(bitsOf(machine, back), emf, 'exactly the EMF that went in');
    assert.equal(fns.GetWinMetaFileBits.handler([metafile, size - 1, at, MM_ANISOTROPIC, 0]),
        0, 'a buffer too small for the whole');
    assert.equal(fns.GetWinMetaFileBits.argBytes, 20);
    assert.equal(fns.SetWinMetaFileBits.argBytes, 16);
});

test('SetWinMetaFileBits records a WMF of its own onto the picture\'s viewport', ()=>{
    // Wine's test_SetWinMetaFileBits: a window 100 by 100 with its top
    // left quarter filled, as an EMF of the size a METAFILEPICT gives.
    const machine = painted(40, 40);
    const { fns, view, bytes, dc, pixel, fill, errors } = machine;
    const at = 0x3000;
    const records = [
        [5, META.SETWINDOWEXT, 100, 100],
        [4, META.SETBKMODE, 1],
        [7, META.RECTANGLE, 50, 50, 0, 0],
        [3, 0],
    ];
    let offset = at + 18;
    for (const [words, func, ...params] of records)
    {
        view.setUint32(offset, words, true);
        view.setUint16(offset + 4, func, true);
        params.forEach((param, index)=>view.setInt16(offset + 6 + index * 2, param, true));
        offset += words * 2;
    }
    view.setUint16(at, 1, true);
    view.setUint16(at + 2, 9, true);
    view.setUint16(at + 4, 0x300, true);
    view.setUint32(at + 6, (offset - at) / 2, true);
    putInts(machine, [MM_ANISOTROPIC, 1000, 1000], OUT);
    const metafile = fns.SetWinMetaFileBits.handler([offset - at, at, 0, OUT]);
    assert.notEqual(metafile, 0);
    const emf = bitsOf(machine, metafile);
    assert.deepEqual(readEmfHeader(emf).frame, { left: 0, top: 0, right: 1000, bottom: 1000 });
    const types = emfRecords(emf).map(record=>record.type);
    assert.ok(types.includes(EMR.RECTANGLE) && types.includes(EMR.SETWINDOWEXTEX));

    fill(WHITE_PIXEL);
    putInts(machine, [0, 0, 40, 40]);
    assert.equal(fns.PlayEnhMetaFile.handler([dc, metafile, RECT]), 1);
    assert.equal(pixel(10, 10) & 0xffffff, WHITE_PIXEL, 'the white stock brush inside');
    assert.equal(pixel(0, 10) & 0xffffff, 0, 'the black pen on its edge');
    assert.equal(pixel(30, 30) & 0xffffff, WHITE_PIXEL);
    assert.ok([19, 20].some(x=>(pixel(x, 5) & 0xffffff) === 0), 'its right edge half way');

    bytes.fill(0xaa, at, at + 64);
    assert.equal(fns.SetWinMetaFileBits.handler([64, at, 0, 0]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_DATA, 'no WMF');
});

test('a Windows metafile closes blank, gives its bits, and plays', ()=>{
    const machine = painted(4, 4);
    const { fns, view, dc } = machine;
    const metafile = fns.CloseMetaFile.handler([fns.CreateMetaFileA.handler([0])]);
    assert.equal(fns.GetMetaFileBitsEx.handler([metafile, 0, 0]), 24, 'a header and the end');
    assert.equal(fns.GetMetaFileBitsEx.handler([metafile, 24, OUT]), 24);
    assert.deepEqual([view.getUint16(OUT, true), view.getUint16(OUT + 2, true),
        view.getUint16(OUT + 4, true), view.getUint32(OUT + 6, true)], [1, 9, 0x300, 12]);
    assert.equal(fns.PlayMetaFile.handler([dc, metafile]), 1);
    assert.equal(fns.GetMetaFileBitsEx.handler([0xdeadbeef, 0, 0]), 0, 'not a metafile');
    const copy = fns.CopyMetaFileA.handler([metafile, 0]);
    assert.equal(fns.GetMetaFileBitsEx.handler([copy, 0, 0]), 24, 'a copy has the same bits');
    assert.equal(fns.GetMetaFileBitsEx.argBytes, 12);
});

test('SetMetaFileBitsEx makes a metafile of a memory WMF\'s bytes, which plays', ()=>{
    // Wine's test_SetMetaFileBits: the header's size is made the buffer's, and
    // anything but a version 3 memory metafile is ERROR_INVALID_DATA.
    const machine = painted(40, 40);
    const { fns, view, dc, pixel, fill, errors } = machine;
    const at = 0x3000;
    const size = 18 + 14 + 6;
    view.setUint16(at, 1, true);
    view.setUint16(at + 2, 9, true);
    view.setUint16(at + 4, 0x300, true);
    view.setUint32(at + 6, 999, true);
    view.setUint32(at + 18, 7, true);
    view.setUint16(at + 22, META.RECTANGLE, true);
    [20, 20, 0, 0].forEach((param, index)=>view.setInt16(at + 24 + index * 2, param, true));
    view.setUint32(at + 32, 3, true);
    view.setUint16(at + 36, 0, true);

    const metafile = fns.SetMetaFileBitsEx.handler([size, at]);
    assert.notEqual(metafile, 0);
    assert.equal(fns.GetMetaFileBitsEx.handler([metafile, size, OUT]), size);
    assert.equal(view.getUint32(OUT + 6, true), size / 2, 'its size is the buffer\'s');
    fill(0);
    assert.equal(fns.PlayMetaFile.handler([dc, metafile]), 1);
    assert.equal(pixel(10, 10) & 0xffffff, WHITE_PIXEL, 'the white stock brush inside');
    assert.equal(pixel(30, 30) & 0xffffff, 0, 'nothing outside');

    assert.equal(fns.SetMetaFileBitsEx.handler([size - 1, at]), 0, 'an odd size');
    view.setUint16(at, 2, true);
    assert.equal(fns.SetMetaFileBitsEx.handler([size, at]), 0, 'a disk metafile');
    assert.equal(errors.at(-1), ERROR_INVALID_DATA);
    assert.equal(fns.SetMetaFileBitsEx.argBytes, 8);
});

test('a call no record keeps leaves nothing, and GdiComment is kept', ()=>{
    const machine = painted(4, 4);
    const { fns, bytes } = machine;
    const hdc = fns.CreateEnhMetaFileA.handler([0, 0, 0, 0]);
    bytes.set([1, 2, 3, 4, 5], OUT);
    assert.equal(fns.GdiComment.handler([hdc, 5, OUT]), 1);
    fns.GdiAlphaBlend.handler([hdc, 0, 0, 1, 1, machine.dc, 0, 0, 1, 1, 0x00ff0000]);
    const emf = bitsOf(machine, fns.CloseEnhMetaFile.handler([hdc]));
    const comment = emfRecords(emf).find(record=>record.type === EMR.GDICOMMENT);
    assert.ok(comment);
    assert.equal(viewOf(emf).getUint32(comment.offset + 8, true), 5);
    assert.deepEqual([...emf.slice(comment.offset + 12, comment.offset + 17)], [1, 2, 3, 4, 5]);
    assert.ok(!emfRecords(emf).some(record=>record.type === EMR.BITBLT), 'no blend recorded');
});

test('a picture, a mapping, text and a clip recorded play back as they were drawn', ()=>{
    const machine = painted(40, 40);
    const { fns, dc, pixel, fill, section, bytes } = machine;
    const source = section(4, 4);
    source.fill(0x00ff00);
    source.put(0, 0, 0xff0000);

    // A 40-pixel frame; inside it a window of 20 units mapped onto 40 pixels.
    putInts(machine, [0, 0, 1056, 1056]);
    const hdc = fns.CreateEnhMetaFileA.handler([0, 0, RECT, 0]);
    fns.SetMapMode.handler([hdc, MM_ANISOTROPIC]);
    fns.SetWindowExtEx.handler([hdc, 20, 20, 0]);
    fns.SetViewportExtEx.handler([hdc, 40, 40, 0]);
    fns.BitBlt.handler([hdc, 0, 0, 4, 4, source.dc, 0, 0, 0x00cc0020]);
    const clip = fns.CreateRectRgn.handler([20, 20, 30, 30]);
    fns.SelectClipRgn.handler([hdc, clip]);
    fns.SelectObject.handler([hdc, fns.GetStockObject.handler([4])]);
    fns.PatBlt.handler([hdc, 0, 0, 20, 20, 0x00f00021]);
    fns.SelectClipRgn.handler([hdc, 0]);
    bytes.set([0x41, 0x42], OUT);
    fns.TextOutA.handler([hdc, 0, 15, OUT, 2]);
    const metafile = fns.CloseEnhMetaFile.handler([hdc]);
    const types = emfRecords(bitsOf(machine, metafile)).map(record=>record.type);
    for (const type of [EMR.SETMAPMODE, EMR.SETWINDOWEXTEX, EMR.SETVIEWPORTEXTEX, EMR.BITBLT,
        EMR.EXTSELECTCLIPRGN, EMR.EXTTEXTOUTW])
    {
        assert.ok(types.includes(type), `record ${type}`);
    }

    fill(WHITE_PIXEL);
    putInts(machine, [0, 0, 40, 40]);
    assert.equal(fns.PlayEnhMetaFile.handler([dc, metafile, RECT]), 1);
    assert.deepEqual([pixel(0, 0), pixel(1, 1), pixel(2, 0), pixel(7, 7), pixel(8, 8)]
        .map(value=>value & 0xffffff), [0xff0000, 0xff0000, 0x00ff00, 0x00ff00, WHITE_PIXEL],
    'the source\'s pixels, each two by two');
    assert.equal(pixel(25, 25) & 0xffffff, 0, 'the black pattern inside the clip');
    assert.equal(pixel(15, 15) & 0xffffff, WHITE_PIXEL, 'and nothing of it outside');
    assert.ok(Array.from({ length: 10 }, (_, y)=>Array.from({ length: 40 }, (__, x)=>
        pixel(x, 30 + y) & 0xffffff)).flat().some(value=>value !== WHITE_PIXEL),
    'the text, below');
    const copy = fns.CreateRectRgn.handler([0, 0, 0, 0]);
    assert.equal(fns.GetClipRgn.handler([dc, copy]), 0, 'the DC\'s clip as it was');
});

test('what the window manager draws on a metafile DC is recorded as the calls it makes', ()=>{
    const machine = painted(4, 4);
    const { fns, gdi } = machine;
    const draw = /** @type {any} */ (gdi).draw;
    const hdc = fns.CreateEnhMetaFileA.handler([0, 0, 0, 0]);
    const brush = fns.CreateSolidBrush.handler([RED]);
    draw.fillWith(hdc, { left: 1, top: 2, right: 5, bottom: 6 }, brush);
    draw.text(hdc, 3, 4, 'Hi', { color: 0x00ff00 });
    const emf = bitsOf(machine, fns.CloseEnhMetaFile.handler([hdc]));
    const records = emfRecords(emf);
    const view = viewOf(emf);
    assert.deepEqual(records.map(record=>record.type).slice(1, -1), [EMR.CREATEBRUSHINDIRECT,
        EMR.SELECTOBJECT, EMR.BITBLT, EMR.SELECTOBJECT, EMR.SETTEXTCOLOR, EMR.SETBKMODE,
        EMR.SETTEXTALIGN, EMR.EXTTEXTOUTW, EMR.SETTEXTCOLOR, EMR.SETBKMODE, EMR.SETTEXTALIGN]);
    const blit = records[3].offset;
    assert.deepEqual([24, 28, 32, 36, 40].map(at=>view.getUint32(blit + at, true)),
        [1, 2, 4, 4, 0x00f00021], 'a PATCOPY over the rectangle');
    assert.equal(view.getUint32(records[4].offset + 8, true), 0x80000000,
        'and the white stock brush selected back');
    const text = records[8].offset;
    assert.equal(view.getUint32(text + 44, true), 2);
    assert.equal(String.fromCharCode(view.getUint16(text + 76, true),
        view.getUint16(text + 78, true)), 'Hi');
});
