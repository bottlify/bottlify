/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGdiplusFunctions } from './functions.js';

const Ok = 0;
const InvalidParameter = 2;
const FontFamilyNotFound = 14;
const NotTrueTypeFont = 16;
const UnitWorld = 0;
const UnitDisplay = 1;
const UnitPoint = 3;
const FontStyleBold = 1;
const FF_ROMAN = 0x10;

function machine(){
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let heap = 0x10000;
    const fns = createGdiplusFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readMemory: (address, length)=>memory.subarray(address, address + length),
        allocate: bytes=>{
            const at = heap;
            heap += Math.ceil(bytes / 16) * 16;
            return at;
        },
        free: ()=>{},
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
    });
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        view.setUint16(at + text.length * 2, 0, true);
    };
    /** A LOGFONTW at `at`. @param {number} at @param {{ height: number, weight?: number, family?: number, face: string }} lf */
    const putLogfont = (at, { height, weight = 400, family = 0, face })=>{
        memory.fill(0, at, at + 92);
        view.setInt32(at, height, true);
        view.setInt32(at + 16, weight, true);
        memory[at + 27] = family;
        putWide(at + 28, face);
    };
    const u32 = (/** @type {number} */ at)=>view.getUint32(at, true);
    const f32 = (/** @type {number} */ at)=>view.getFloat32(at, true);
    const u16 = (/** @type {number} */ at)=>view.getUint16(at, true);
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let p = at; u16(p) !== 0; p += 2)
        {
            text += String.fromCharCode(u16(p));
        }
        return text;
    };
    /** A REAL as its bits are passed. @param {number} value */
    const real = value=>new Uint32Array(Float32Array.of(value).buffer)[0];
    /** The table by any name. @type {Record<string, { handler: (args: number[]) => any }>} */
    const table = fns;
    return { fns, table, view, putWide, putLogfont, u32, f32, u16, wideAt, real };
}

test('the default GUI font comes through a LOGFONT as WinForms reads it, 8.25 points', ()=>{
    // SystemFonts.DefaultFont: DEFAULT_GUI_FONT's LOGFONT (MS Shell Dlg, -11)
    // through Font.FromLogFont, then SizeInPoints from the line spacing, the
    // family's em and spacing and the screen's DPI - Microsoft Sans Serif at
    // 8.25 points on Windows.
    const { fns, putLogfont, u32, f32, u16, wideAt } = machine();
    putLogfont(0x100, { height: -11, face: 'MS Shell Dlg' });
    assert.equal(fns.GdipCreateFontFromLogfontW.handler([0x1234, 0x100, 0x200]), Ok);
    const font = u32(0x200);
    assert.equal(fns.GdipGetFontSize.handler([font, 0x210]), Ok);
    assert.equal(f32(0x210), 11, 'the character height, in World units');
    assert.equal(fns.GdipGetFontUnit.handler([font, 0x214]), Ok);
    assert.equal(u32(0x214), UnitWorld);
    assert.equal(fns.GdipGetFontStyle.handler([font, 0x218]), Ok);
    assert.equal(u32(0x218), 0);

    assert.equal(fns.GdipGetFamily.handler([font, 0x220]), Ok);
    const family = u32(0x220);
    assert.equal(fns.GdipGetFamilyName.handler([family, 0x300, 0]), Ok);
    assert.equal(wideAt(0x300), 'Microsoft Sans Serif', 'the substitute GDI names');

    assert.equal(fns.GdipCreateFromHDC.handler([0x1234, 0x230]), Ok);
    const graphics = u32(0x230);
    assert.equal(fns.GdipGetDpiY.handler([graphics, 0x240]), Ok);
    assert.equal(fns.GdipGetFontHeight.handler([font, graphics, 0x244]), Ok);
    assert.equal(fns.GdipGetEmHeight.handler([family, 0, 0x248]), Ok);
    assert.equal(fns.GdipGetLineSpacing.handler([family, 0, 0x24c]), Ok);
    const emPixels = f32(0x244) * u16(0x248) / u16(0x24c);
    assert.ok(Math.abs(emPixels / (f32(0x240) / 72) - 8.25) < 1e-4,
        `${emPixels / (f32(0x240) / 72)} points`);

    assert.equal(fns.GdipDeleteFontFamily.handler([family]), Ok);
    assert.equal(fns.GdipDeleteFont.handler([font]), Ok);
    assert.equal(fns.GdipDeleteFont.handler([font]), InvalidParameter, 'once');
});

test('a family is an outline face by name; a bitmap face or none is not found', ()=>{
    const { fns, table, putWide, u32, wideAt } = machine();
    putWide(0x100, 'tahoma');
    assert.equal(fns.GdipCreateFontFamilyFromName.handler([0x100, 0, 0x200]), Ok);
    assert.equal(fns.GdipGetFamilyName.handler([u32(0x200), 0x300, 0]), Ok);
    assert.equal(wideAt(0x300), 'Tahoma');
    putWide(0x100, 'MS Sans Serif');
    assert.equal(fns.GdipCreateFontFamilyFromName.handler([0x100, 0, 0x200]), FontFamilyNotFound);
    putWide(0x100, 'ThisFontShouldNotExist');
    assert.equal(fns.GdipCreateFontFamilyFromName.handler([0x100, 0, 0x200]), FontFamilyNotFound);
    for (const [name, face] of [['GdipGetGenericFontFamilySansSerif', 'Microsoft Sans Serif'],
        ['GdipGetGenericFontFamilySerif', 'Times New Roman'],
        ['GdipGetGenericFontFamilyMonospace', 'Courier New']])
    {
        assert.equal(table[name].handler([0x200]), Ok);
        assert.equal(fns.GdipGetFamilyName.handler([u32(0x200), 0x300, 0]), Ok);
        assert.equal(wideAt(0x300), face, name);
    }
});

test('a family\'s design metrics are gdi32\'s for its face', ()=>{
    // Tahoma's cell is gdi32's measured one; the line spacing is the cell.
    const { fns, table, putWide, u32, u16 } = machine();
    putWide(0x100, 'Tahoma');
    fns.GdipCreateFontFamilyFromName.handler([0x100, 0, 0x200]);
    const family = u32(0x200);
    for (const [name, value] of /** @type {[string, number][]} */ ([['GdipGetEmHeight', 2048], ['GdipGetCellAscent', 2049],
        ['GdipGetCellDescent', 423], ['GdipGetLineSpacing', 2472]]))
    {
        assert.equal(table[name].handler([family, 0, 0x210]), Ok);
        assert.equal(u16(0x210), value, name);
    }
});

test('a LOGFONT names a bitmap face: not TrueType; an unknown name: its family\'s generic face',
    ()=>{
        const { fns, putLogfont, u32, wideAt } = machine();
        putLogfont(0x100, { height: -11, face: 'MS Sans Serif' });
        assert.equal(fns.GdipCreateFontFromLogfontW.handler([1, 0x100, 0x200]), NotTrueTypeFont);
        putLogfont(0x100, { height: -11, family: FF_ROMAN, face: 'NoSuchFace' });
        assert.equal(fns.GdipCreateFontFromLogfontW.handler([1, 0x100, 0x200]), Ok);
        fns.GdipGetFamily.handler([u32(0x200), 0x210]);
        fns.GdipGetFamilyName.handler([u32(0x210), 0x300, 0]);
        assert.equal(wideAt(0x300), 'Times New Roman');
        assert.equal(fns.GdipCreateFontFromLogfontW.handler([0, 0x100, 0x200]), InvalidParameter,
            'a DC is required');
    });

test('a LOGFONT\'s cell height is the em it holds; its weight bold from semibold', ()=>{
    const { fns, putLogfont, u32, f32 } = machine();
    putLogfont(0x100, { height: 2472, weight: 700, face: 'Tahoma' });
    assert.equal(fns.GdipCreateFontFromLogfontW.handler([1, 0x100, 0x200]), Ok);
    fns.GdipGetFontSize.handler([u32(0x200), 0x210]);
    assert.ok(Math.abs(f32(0x210) - 2048) < 1e-3, 'a cell of 2472 holds Tahoma\'s em of 2048');
    fns.GdipGetFontStyle.handler([u32(0x200), 0x214]);
    assert.equal(u32(0x214), FontStyleBold);
});

test('a font made from a family at a size gives back a LOGFONT of its em in pixels', ()=>{
    const { fns, putWide, u32, view, wideAt, real } = machine();
    putWide(0x100, 'Tahoma');
    fns.GdipCreateFontFamilyFromName.handler([0x100, 0, 0x200]);
    const family = u32(0x200);
    assert.equal(fns.GdipCreateFont.handler([family, real(8.25), FontStyleBold, UnitPoint, 0x210]),
        Ok);
    const font = u32(0x210);
    assert.equal(fns.GdipGetLogFontW.handler([font, 0, 0x400]), Ok);
    assert.equal(view.getInt32(0x400, true), -11, '8.25 points at 96 DPI');
    assert.equal(view.getInt32(0x410, true), 700);
    assert.equal(wideAt(0x400 + 28), 'Tahoma');
    assert.equal(fns.GdipCloneFont.handler([font, 0x220]), Ok);
    assert.notEqual(u32(0x220), font);
    assert.equal(fns.GdipCreateFont.handler([family, real(8), 0, UnitDisplay, 0x210]),
        InvalidParameter, 'no font is sized in display units');
    assert.equal(fns.GdipCreateFont.handler([family, real(0), 0, UnitPoint, 0x210]),
        InvalidParameter);
    assert.equal(fns.GdipGetFontHeightGivenDPI.handler([font, real(96), 0x230]), Ok);
});
