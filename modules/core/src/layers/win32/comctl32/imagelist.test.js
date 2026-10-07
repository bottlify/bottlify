/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageLists } from './imagelist.js';
import { createGdiFunctions } from '../gdi32/functions.js';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import { surfaceForDdb, surfaceForDibSection } from '../../graphics/gdi/surface.js';

/**
 * Image lists over gdi32 and the drawing engine, wired as the win32 module
 * wires them. The expectations are those of Wine's comctl32 image list
 * tests, which run the same calls against Windows.
 */

const INFO = 0x100;
const POINTER = 0x80;
const PARAMS = 0x200;
const OUT = 0x300;
const BITS = 0x400;

const ILC_MASK = 0x0001;
const ILC_COLOR16 = 0x0010;
const ILC_COLOR32 = 0x0020;
const ILD_NORMAL = 0x0000;
const ILD_TRANSPARENT = 0x0001;
const ILD_MASK = 0x0010;
const ILD_IMAGE = 0x0020;
const ILD_ROP = 0x0040;
const ILD_PRESERVEALPHA = 0x1000;
const CLR_NONE = 0xffffffff;
const SRCCOPY = 0x00cc0020;
const SRCINVERT = 0x00660046;

/**
 * @param {{ user32?: (name: string) => ({ handler: (args: number[]) => number } | undefined) }}
 *     [wired]
 */
function machine(wired = {}){
    const bytes = new Uint8Array(0x40000);
    const view = new DataView(bytes.buffer);
    let next = 0x10000;
    let handle = 4;
    const gdi = createGdiFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        readCString: ()=>'',
        handles: { open: ()=>(handle += 4), close: ()=>undefined },
        surfaces: {
            /** @param {number} size */
            allocate(size){
                const address = next;
                next += (size + 0xff) & ~0xff;
                return address;
            },
            free: ()=>undefined,
        },
        graphics: {
            createDrawing: options=>createGdiDrawing(options),
            surfaceFor: (dc, bitmap)=>(bitmap.pixels ? surfaceForDdb(bitmap)
                : surfaceForDibSection(bitmap, bytes, 0)),
        },
    });
    const gdi32 = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (gdi.table));
    const lists = createImageLists({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        gdi32: name=>gdi32[name],
        user32: wired.user32,
        bitmapSize: bitmap=>gdi.bitmapSize(bitmap),
    });
    const fns = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (lists.functions));

    /**
     * A top-down 32-bit DIB section holding `pixels`, as Wine's
     * create_test_bitmap makes one.
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
        return { bitmap, at };
    };
    /** A monochrome bitmap from its first row's bytes. @param {number} width @param {number[]} row */
    const mono = (width, row)=>{
        bytes.set(row, BITS);
        return gdi32.CreateBitmap.handler([width, 1, 1, 1, BITS]);
    };
    /** A DC over a new 32-bit section, which reads back its pixels. @param {number} width */
    const target = width=>{
        const made = section(width, 1, Array(width).fill(0));
        const dc = gdi32.CreateCompatibleDC.handler([0]);
        gdi32.SelectObject.handler([dc, made.bitmap]);
        return {
            dc,
            /** @param {number} value */
            fill: value=>{
                for (let index = 0; index < width; index++)
                {
                    view.setUint32(made.at + index * 4, value >>> 0, true);
                }
            },
            pixels: ()=>[...Array(width).keys()].map(index=>view.getUint32(made.at + index * 4,
                true)),
        };
    };
    return { bytes, view, gdi32, fns, section, mono, target };
}

test('a list loaded out of a bitmap resource is cut into images cx wide', ()=>{
    // What a framework's toolbar loads its buttons with: the strip the
    // resource holds, masked by a colour, the bitmap let go of after.
    /** @type {number[]} */
    const loaded = [];
    /** @type {any} */
    let made = null;
    made = machine({
        user32: name=>(name === 'LoadImageA'
            ? { handler: ([, resource])=>{
                loaded.push(resource);
                return made.section(4, 2, Array(8).fill(0x00ff00ff)).bitmap;
            } }
            : undefined),
    });
    const { fns } = made;
    const list = fns.ImageList_LoadImageA.handler([0x400000, 0x71, 2, 10, 0xff00ff, 0, 0]);
    assert.notEqual(list, 0);
    assert.deepEqual(loaded, [0x71], 'the resource it named');
    assert.equal(fns.ImageList_GetImageCount.handler([list]), 2, 'a strip four wide in twos');
    const square = fns.ImageList_LoadImageA.handler([0x400000, 0x71, 0, 10, CLR_NONE, 0, 0]);
    assert.equal(fns.ImageList_GetImageCount.handler([square]), 2, 'a cx of 0 cuts squares');
    assert.equal(fns.ImageList_LoadImageA.handler([0x400000, 0x71, 16, 10, CLR_NONE, 1, 0]), 0,
        'an icon resource is not loaded');
});

test('ImageList_DrawIndirect refuses no structure, no DC, no list and a missing image', ()=>{
    // Wine's test_DrawIndirect: three 48-pixel images, the structure checked
    // field by field, each image drawn and the one past them refused; the
    // bitmaps added stay the caller's to delete.
    const m = machine();
    const list = m.fns.ImageList_Create.handler([48, 48, ILC_COLOR16, 0, 3]);
    const bitmaps = [0, 1, 2].map(()=>m.gdi32.CreateBitmap.handler([48, 48, 1, 1, 0]));
    assert.equal(m.fns.ImageList_Add.handler([list, bitmaps[0], 0]), 0);
    assert.equal(m.fns.ImageList_Add.handler([list, bitmaps[1], 0]), 1);
    assert.equal(m.fns.ImageList_Add.handler([list, bitmaps[2], 0]), 2);
    const screen = m.target(64);
    /** @param {number[]} fields */
    const put = fields=>fields.forEach((value, index)=>m.view.setUint32(PARAMS + index * 4,
        value >>> 0, true));
    put(Array(17).fill(0));
    assert.equal(m.fns.ImageList_DrawIndirect.handler([PARAMS]), 0, 'zero data');
    put([56]);
    assert.equal(m.fns.ImageList_DrawIndirect.handler([PARAMS]), 0, 'zero hdc');
    put([56, 0, 0, screen.dc]);
    assert.equal(m.fns.ImageList_DrawIndirect.handler([PARAMS]), 0, 'zero himl');
    put([56, 0xdeadbeef, 0, screen.dc]);
    assert.equal(m.fns.ImageList_DrawIndirect.handler([PARAMS]), 0, 'bad himl');
    for (const index of [0, 1, 2])
    {
        put([56, list, index, screen.dc, 100, 100, 0, 0, 0, 0, 0xff000000, 0xff000000, SRCCOPY]);
        assert.equal(m.fns.ImageList_DrawIndirect.handler([PARAMS]), 1, `image ${index}`);
    }
    put([56, list, 3, screen.dc]);
    assert.equal(m.fns.ImageList_DrawIndirect.handler([PARAMS]), 0, 'past the end');
    assert.equal(m.fns.ImageList_DrawIndirect.argBytes, 4);

    assert.equal(m.fns.ImageList_Destroy.handler([list]), 1);
    assert.deepEqual(bitmaps.map(bitmap=>m.gdi32.DeleteObject.handler([bitmap])), [1, 1, 1],
        'the bitmaps are not the list\'s to delete');
});

test('a list with no mask draws its image whatever the style, and ILD_ROP by the operation',
    ()=>{
        // Wine's test_ImageList_DrawIndirect, the image with no alpha: onto a
        // pixel that was 0xFFFFFFFF, every style gives the image, a mask added
        // to a list made without ILC_MASK being ignored; ILD_IMAGE | ILD_ROP
        // draws by the raster operation, SRCINVERT flipping the destination.
        const m = machine();
        const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR32, 0, 1]);
        const image = m.section(2, 1, [0x00abcdef, 0x00abcdef]);
        const index = m.fns.ImageList_Add.handler([list, image.bitmap, m.mono(2, [0, 0])]);
        assert.notEqual(index, -1);
        const dest = m.target(2);
        const draw = (/** @type {number} */ style, rop = 0)=>{
            dest.fill(0xffffffff);
            m.view.setUint32(PARAMS, 68, true);
            [list, index, dest.dc, 0, 0, 0, 0, 0, 0, CLR_NONE, CLR_NONE, style, rop]
                .forEach((value, at)=>m.view.setUint32(PARAMS + 4 + at * 4, value >>> 0, true));
            assert.equal(m.fns.ImageList_DrawIndirect.handler([PARAMS]), 1);
            return dest.pixels()[0];
        };
        for (const style of [ILD_NORMAL, ILD_TRANSPARENT, ILD_MASK, ILD_IMAGE, ILD_PRESERVEALPHA])
        {
            assert.equal(draw(style), 0x00abcdef, `style ${style}`);
        }
        assert.equal(draw(ILD_IMAGE | ILD_ROP, SRCCOPY), 0x00abcdef);
        assert.equal(draw(ILD_IMAGE | ILD_ROP, SRCINVERT), 0xff543210);
    });

test('a masked list keeps its images black under the mask and draws them through it', ()=>{
    // Wine's test_alpha, the rows without alpha: ImageList_Add with a mask of
    // alternate bits, and ImageList_AddMasked keyed on 0x654321, read back
    // through ImageList_GetImageInfo's bitmap and drawn with ILD_TRANSPARENT
    // onto a cleared DIB section -- a transparent pixel black in the list's
    // bitmap and left as it was by the drawing.
    const m = machine();
    const rows = [[0x654321, 0xabcdef], [0x654321, 0x654321], [0xabcdef, 0x654321],
        [0xabcdef, 0xabcdef]];
    const masked = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR32 | ILC_MASK, 0, 15]);
    const keyed = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR32 | ILC_MASK, 0, 15]);
    const mask = m.mono(2, [0xaa, 0]);
    rows.forEach((row, index)=>{
        const bitmap = m.section(2, 1, row).bitmap;
        assert.equal(m.fns.ImageList_Add.handler([masked, bitmap, mask]), index);
        assert.equal(m.fns.ImageList_AddMasked.handler([keyed, bitmap, 0x214365]), index);
        m.gdi32.DeleteObject.handler([bitmap]);
    });
    /** @param {number} list @param {number} index @returns {number[]} */
    const byBitmap = (list, index)=>{
        assert.equal(m.fns.ImageList_GetImageInfo.handler([list, index, OUT]), 1);
        assert.equal(m.fns.ImageList_GetIconSize.handler([list, OUT + 0x40, OUT + 0x44]), 1);
        const [cx, cy] = [m.view.getInt32(OUT + 0x40, true), m.view.getInt32(OUT + 0x44, true)];
        assert.deepEqual([cx, cy], [2, 1]);
        const [left, top, right, bottom] = [16, 20, 24, 28].map(at=>m.view.getInt32(OUT + at,
            true));
        assert.deepEqual([top, right - left, bottom], [0, 2, 1], 'rcImage');
        const strip = m.view.getUint32(OUT, true);
        const size = m.gdi32.GetBitmapBits.handler([strip, 0, 0]);
        assert.equal(m.gdi32.GetBitmapBits.handler([strip, size, BITS]), size);
        return [0, 1].map(x=>m.view.getUint32(BITS + (left + x) * 4, true));
    };
    const dest = m.target(2);
    /** @param {number} list @param {number} index @returns {number[]} */
    const byDraw = (list, index)=>{
        dest.fill(0);
        assert.equal(m.fns.ImageList_Draw.handler([list, index, dest.dc, 0, 0, ILD_TRANSPARENT]),
            1);
        return dest.pixels();
    };
    rows.forEach((row, index)=>{
        assert.deepEqual(byBitmap(masked, index), [0, row[1]], `Add ${index}, the bitmap`);
        assert.deepEqual(byDraw(masked, index), [0, row[1]], `Add ${index}, drawn`);
        const keyedRow = row.map(pixel=>(pixel === 0x654321 ? 0 : pixel));
        assert.deepEqual(byBitmap(keyed, index), keyedRow, `AddMasked ${index}, the bitmap`);
        assert.deepEqual(byDraw(keyed, index), keyedRow, `AddMasked ${index}, drawn`);
    });
});

test('ILD_NORMAL puts the background colour behind the image, and ILD_MASK draws the mask',
    ()=>{
        // The ImageList_Draw and ImageList_DrawEx documentation: with a
        // background colour -- the list's, or the one DrawEx names --
        // ILD_NORMAL fills the transparent pixels with it; CLR_NONE, the
        // default, draws them transparently, as ILD_TRANSPARENT always does;
        // ILD_MASK draws the mask, black where the image is and white where
        // it is not.
        const m = machine();
        const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR32 | ILC_MASK, 0, 1]);
        const image = m.section(2, 1, [0x112233, 0x445566]);
        m.fns.ImageList_Add.handler([list, image.bitmap, m.mono(2, [0x80, 0])]);
        const dest = m.target(2);
        /** @param {() => number} draw */
        const drawn = draw=>{
            dest.fill(0x00777777);
            assert.equal(draw(), 1);
            return dest.pixels();
        };
        const draw = (/** @type {number} */ style)=>drawn(()=>m.fns.ImageList_Draw.handler([
            list, 0, dest.dc, 0, 0, style]));
        assert.deepEqual(draw(ILD_NORMAL), [0x777777, 0x445566], 'no background: transparent');
        assert.equal(m.fns.ImageList_GetBkColor.handler([list]) >>> 0, CLR_NONE);
        assert.equal(m.fns.ImageList_SetBkColor.handler([list, 0x0000ff]) >>> 0, CLR_NONE);
        assert.equal(m.fns.ImageList_GetBkColor.handler([list]), 0x0000ff);
        assert.deepEqual(draw(ILD_NORMAL), [0xff0000, 0x445566], 'the list\'s red behind it');
        assert.deepEqual(draw(ILD_TRANSPARENT), [0x777777, 0x445566]);
        assert.deepEqual(draw(ILD_MASK), [0xffffff, 0x000000]);
        assert.deepEqual(draw(ILD_IMAGE), [0x000000, 0x445566], 'black under the mask');
        const ex = (/** @type {number} */ background)=>drawn(()=>m.fns.ImageList_DrawEx.handler([
            list, 0, dest.dc, 0, 0, 0, 0, background, CLR_NONE, ILD_NORMAL]));
        assert.deepEqual(ex(CLR_NONE), [0x777777, 0x445566]);
        assert.deepEqual(ex(0x00ff00), [0x00ff00, 0x445566]);
        assert.deepEqual(ex(0xff000000), [0xff0000, 0x445566], 'CLR_DEFAULT: the list\'s');
        assert.deepEqual(drawn(()=>m.fns.ImageList_DrawEx.handler([list, 0, dest.dc, 1, 0, 1, 0,
            CLR_NONE, CLR_NONE, ILD_IMAGE])), [0x777777, 0x000000], 'its first column only');
        assert.equal(m.fns.ImageList_DrawEx.argBytes, 40);
    });

test('an icon is appended at -1 or put in place, and counted', ()=>{
    const { fns } = machine();
    const list = fns.ImageList_Create.handler([4, 4, ILC_COLOR32, 1, 1]);
    assert.equal(fns.ImageList_ReplaceIcon.argBytes, 12);
    assert.equal(fns.ImageList_ReplaceIcon.handler([list, -1, 0x1234]), 0, 'appended first');
    assert.equal(fns.ImageList_ReplaceIcon.handler([list, -1, 0x1234]), 1);
    assert.equal(fns.ImageList_GetImageCount.handler([list]), 2);
    assert.equal(fns.ImageList_ReplaceIcon.handler([list, 0, 0x1234]), 0, 'replaced in place');
    assert.equal(fns.ImageList_GetImageCount.handler([list]), 2);
    assert.equal(fns.ImageList_ReplaceIcon.handler([list, 5, 0x1234]), -1, 'past the end');
    assert.equal(fns.ImageList_ReplaceIcon.handler([list, -1, 0]), -1, 'no icon');
});

test('removing an image moves the later ones down, and -1 removes them all', ()=>{
    const m = machine();
    const list = m.fns.ImageList_Create.handler([1, 1, ILC_COLOR32, 0, 1]);
    const strip = m.section(3, 1, [0x010101, 0x020202, 0x030303]);
    assert.equal(m.fns.ImageList_Add.handler([list, strip.bitmap, 0]), 0);
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), 3);
    assert.equal(m.fns.ImageList_Remove.handler([list, 0]), 1);
    const dest = m.target(1);
    const drawn = (/** @type {number} */ index)=>{
        m.fns.ImageList_Draw.handler([list, index, dest.dc, 0, 0, ILD_NORMAL]);
        return dest.pixels()[0];
    };
    assert.deepEqual([drawn(0), drawn(1)], [0x020202, 0x030303]);
    assert.equal(m.fns.ImageList_Remove.handler([list, 2]), 0, 'past the end');
    assert.equal(m.fns.ImageList_Remove.handler([list, -1]), 1);
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), 0);
    assert.equal(m.fns.ImageList_Draw.handler([list, 0, dest.dc, 0, 0, ILD_NORMAL]), 0);
});

test('ImageList_SetIconSize empties the list and takes images of the new size', ()=>{
    // test_ImageList_DrawIndirect: a list of 32-bit images resized to 4x4
    // takes a 4x4 bitmap as its first image.
    const m = machine();
    const list = m.fns.ImageList_Create.handler([2, 1, ILC_COLOR32 | ILC_MASK, 1, 1]);
    m.fns.ImageList_Add.handler([list, m.section(4, 1, [1, 2, 3, 4]).bitmap, 0]);
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), 2);
    assert.equal(m.fns.ImageList_SetIconSize.argBytes, 12);

    assert.equal(m.fns.ImageList_SetIconSize.handler([list, 4, 1]), 1);
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), 0, 'every image went');
    assert.equal(m.fns.ImageList_GetIconSize.handler([list, OUT, OUT + 4]), 1);
    assert.deepEqual([m.view.getInt32(OUT, true), m.view.getInt32(OUT + 4, true)], [4, 1]);
    const wide = [0x010203, 0x040506, 0x070809, 0x0a0b0c];
    assert.equal(m.fns.ImageList_Add.handler([list, m.section(4, 1, wide).bitmap, 0]), 0,
        'one image four wide');
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), 1);
    const dest = m.target(4);
    assert.equal(m.fns.ImageList_Draw.handler([list, 0, dest.dc, 0, 0, ILD_NORMAL]), 1);
    assert.deepEqual(dest.pixels(), wide);

    assert.equal(m.fns.ImageList_SetIconSize.handler([list, 0, 4]), 0, 'no width');
    assert.equal(m.fns.ImageList_SetIconSize.handler([list, 4, -1]), 0, 'a negative height');
    assert.equal(m.fns.ImageList_GetImageCount.handler([list]), 1, 'and nothing changed');
    assert.equal(m.fns.ImageList_SetIconSize.handler([0xdeadbeef, 4, 4]), 0, 'no list');
});

test('ImageList_SetImageCount grows and cuts the list, keeping the images it keeps', ()=>{
    // test_imagecount: 84x84 at 16 bits, grown to three and cut to one and
    // to none; the first image survives both ways.
    const m = machine();
    const big = m.fns.ImageList_Create.handler([84, 84, ILC_COLOR16, 0, 3]);
    assert.equal(m.fns.ImageList_SetImageCount.argBytes, 8);
    for (const count of [3, 1, 0])
    {
        assert.equal(m.fns.ImageList_SetImageCount.handler([big, count]), 1);
        assert.equal(m.fns.ImageList_GetImageCount.handler([big]), count);
    }
    assert.equal(m.fns.ImageList_SetImageCount.handler([0xdeadbeef, 3]), 0, 'no list');

    const list = m.fns.ImageList_Create.handler([1, 1, ILC_COLOR32, 0, 1]);
    m.fns.ImageList_Add.handler([list, m.section(2, 1, [0x111111, 0x222222]).bitmap, 0]);
    const dest = m.target(1);
    const drawn = (/** @type {number} */ index)=>{
        dest.fill(0x777777);
        return m.fns.ImageList_Draw.handler([list, index, dest.dc, 0, 0, ILD_NORMAL]) === 1
            ? dest.pixels()[0] : null;
    };
    assert.equal(m.fns.ImageList_SetImageCount.handler([list, 5]), 1);
    assert.deepEqual([0, 1, 4, 5].map(drawn), [0x111111, 0x222222, 0, null],
        'the images kept, the new places blank, none past them');
    assert.equal(m.fns.ImageList_SetImageCount.handler([list, 1]), 1);
    assert.deepEqual([0, 1].map(drawn), [0x111111, null]);
    // test_DrawIndirect: a place SetImageCount made is replaced like any other.
    assert.equal(m.fns.ImageList_SetImageCount.handler([list, 2]), 1);
    assert.equal(m.fns.ImageList_Replace.handler([list, 1, m.section(1, 1, [0x333333]).bitmap,
        0]), 1);
    assert.equal(drawn(1), 0x333333);
});
