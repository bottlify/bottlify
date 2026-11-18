/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    fontFaces, fontFamilies, outlineCell, rasterFace, rasterRealization, scaledAdvances,
    windowsMetrics,
} from './faces.js';

/**
 * The smallest font a name can be read from: an sfnt directory with one
 * table, `name`, holding the given (platform, language, text) family records.
 *
 * @param {[number, number, string][]} names
 * @param {number} [version]  the directory's first four bytes
 */
export function fontWithNames(names, version = 0x00010000){
    const strings = names.map(([platform, , text])=>(platform === 3
        ? Uint8Array.from([...text].flatMap(ch=>[0, ch.charCodeAt(0)]))
        : Uint8Array.from([...text].map(ch=>ch.charCodeAt(0)))));
    const tableAt = 12 + 16;
    const stringsAt = 6 + names.length * 12;
    const size = tableAt + stringsAt + strings.reduce((sum, one)=>sum + one.length, 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, version);
    view.setUint16(4, 1);
    bytes.set([...'name'].map(ch=>ch.charCodeAt(0)), 12);
    view.setUint32(12 + 8, tableAt);
    view.setUint32(12 + 12, size - tableAt);
    view.setUint16(tableAt + 2, names.length);
    view.setUint16(tableAt + 4, stringsAt);
    let offset = 0;
    names.forEach(([platform, language], index)=>{
        const record = tableAt + 6 + index * 12;
        [platform, platform === 3 ? 1 : 0, language, 1, strings[index].length, offset]
            .forEach((value, field)=>view.setUint16(record + field * 2, value));
        bytes.set(strings[index], tableAt + stringsAt + offset);
        offset += strings[index].length;
    });
    return bytes;
}

test('a font file names its family from its name table, Windows English first', ()=>{
    assert.deepEqual(fontFamilies(fontWithNames([[1, 0, 'Mac Name'], [3, 0x407, 'Deutsch'],
        [3, 0x409, 'Trajan Pro']])), ['Trajan Pro']);
    assert.deepEqual(fontFamilies(fontWithNames([[1, 0, 'Only Mac']], 0x4f54544f)), ['Only Mac'],
        'an OpenType CFF font, and a Macintosh record where there is no other');
    assert.deepEqual(fontFamilies(Uint8Array.from([1, 2, 3, 4, 5, 6])), [], 'not a font');
    const cut = fontWithNames([[3, 0x409, 'Cut']]).subarray(0, 30);
    assert.deepEqual(fontFamilies(cut), [], 'a directory past the end');
});

/**
 * A font with a family and a cell: `fontWithNames`' name table beside a
 * 'head' and an 'OS/2' holding the em square and the Windows ascent and descent.
 *
 * With `vdmx`, a 'VDMX' of one ratio record naming no ratio, for that
 * character set, over one group of [ppem, yMax, yMin] entries.
 *
 * @param {string} family @param {number} unitsPerEm @param {number} ascent
 * @param {number} descent
 * @param {{ charSet: number, entries: [number, number, number][] }} [vdmx]
 */
function fontWithCell(family, unitsPerEm, ascent, descent, vdmx){
    const named = fontWithNames([[3, 0x409, family]]);
    const name = named.subarray(12 + 16);
    const vdmxSize = vdmx ? 6 + 4 + 2 + 4 + vdmx.entries.length * 6 : 0;
    const tables = [['head', 54], ['OS/2', 78], ['name', name.length],
        ...(vdmx ? [['VDMX', vdmxSize]] : [])];
    const directory = 12 + tables.length * 16;
    const size = directory + tables.reduce((sum, [, length])=>sum + Number(length), 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x00010000);
    view.setUint16(4, tables.length);
    let at = directory;
    /** @type {Record<string, number>} */
    const where = {};
    tables.forEach(([tag, length], index)=>{
        const record = 12 + index * 16;
        bytes.set([...String(tag)].map(ch=>ch.charCodeAt(0)), record);
        view.setUint32(record + 8, at);
        view.setUint32(record + 12, Number(length));
        where[tag] = at;
        at += Number(length);
    });
    view.setUint16(where.head + 18, unitsPerEm);
    view.setUint16(where['OS/2'] + 74, ascent);
    view.setUint16(where['OS/2'] + 76, descent);
    bytes.set(name, where.name);
    if (vdmx)
    {
        const table = where.VDMX;
        view.setUint16(table + 2, 1);
        view.setUint16(table + 4, 1);
        bytes[table + 6] = vdmx.charSet;
        view.setUint16(table + 10, 12);
        const group = table + 12;
        view.setUint16(group, vdmx.entries.length);
        vdmx.entries.forEach(([ppem, yMax, yMin], index)=>{
            view.setUint16(group + 4 + index * 6, ppem);
            view.setInt16(group + 6 + index * 6, yMax);
            view.setInt16(group + 8 + index * 6, yMin);
        });
    }
    return bytes;
}

test('a font file brings its own cell, and a face added measures by it', ()=>{
    const [face] = fontFaces(fontWithCell('Shipped Face', 1000, 900, 200));
    assert.deepEqual(face, { family: 'Shipped Face',
        cell: { unitsPerEm: 1000, ascent: 900, descent: 200 } });
    assert.equal(fontFaces(fontWithNames([[3, 0x409, 'No Cell']]))[0].cell, null,
        'no head or OS/2, no cell');
    /** @param {string} family */
    const added = family=>(family === 'Shipped Face' ? face.cell ?? undefined : undefined);
    /** @param {number} height */
    const measure = height=>{
        const known = outlineCell({ faceName: 'Shipped Face', height }, added);
        assert.ok(known);
        return [known.height, known.ascent, known.descent, known.internalLeading];
    };
    assert.deepEqual(measure(12), [12, 10, 2, 1], 'the cell split by the shares');
    assert.deepEqual(measure(-10), [11, 9, 2, 1], 'the em, each share rounded');
    assert.equal(outlineCell({ faceName: 'Other', height: 12 }, added), null);
});

test('a face whose VDMX holds the ANSI set measures by its hinted extents', ()=>{
    const entries = /** @type {[number, number, number][]} */ ([[10, 9, -3], [11, 10, -3],
        [12, 10, -3], [13, 11, -4]]);
    const [face] = fontFaces(fontWithCell('Hinted', 1000, 900, 200, { charSet: 1, entries }));
    /** @param {number} height */
    const measure = height=>{
        const known = outlineCell({ faceName: 'Hinted', height }, ()=>face.cell ?? undefined);
        assert.ok(known);
        return [known.height, known.ascent, known.descent, known.internalLeading];
    };
    assert.deepEqual(measure(-12), [13, 10, 3, 1], 'an em the table holds');
    assert.deepEqual(measure(14), [13, 10, 3, 1], 'the largest em whose extent fits the cell');
    assert.deepEqual(measure(15), [15, 11, 4, 2]);
    assert.deepEqual(measure(-20), [22, 18, 4, 2], 'an em past the table: the shares');
    assert.deepEqual(measure(30), [30, 25, 5, 3], 'a cell past the table: the shares');
    const [every] = fontFaces(fontWithCell('Every', 1000, 900, 200, { charSet: 0, entries }));
    assert.equal(every.cell?.pixels, undefined, 'a record for every glyph is passed over (A254)');
});

test('the dialog faces advance as Windows draws them, so a line breaks where Windows broke it',
    ()=>{
        // An installer's statics are sized to their text in MS Sans Serif 8:
        // "Please Enter Date of Birth" is 122 pixels on Windows in a static 125
        // wide, and a stand-in face's wider advances wrapped it and clipped the
        // second line.
        /** @param {string} faceName @param {number} height @param {string} text */
        const width = (faceName, height, text)=>{
            const known = windowsMetrics({ faceName, height, weight: 400 });
            assert.ok(known, faceName);
            return Array.from(text, character=>known.advances[character.charCodeAt(0) - 0x20])
                .reduce((sum, advance)=>sum + advance, 0);
        };
        assert.equal(width('MS Sans Serif', 13, 'Please Enter Date of Birth'), 122);
        assert.equal(width('MS Sans Serif', 13, 'Information will not be stored.'), 137);
        assert.equal(width('MS Shell Dlg', -11, 'Please Enter Date of Birth'), 122,
            'Microsoft Sans Serif, whose hinted widths are the bitmap face\'s');
        // System, which a DC answers in before a font is selected: the path an
        // installer measures that way is 350 pixels, wider than its 333-pixel
        // static, and is shortened there on Windows too.
        assert.equal(width('System', 16,
            'C:\\Program Files\\Rockstar Games\\Max Payne 2 Demo'), 350);
        assert.equal(windowsMetrics({ faceName: 'Arial', height: 13, weight: 400 }), null);
    });

test('an outline face known at one em advances proportionally at every other', ()=>{
    // Tahoma's widths are known at 11 pixels (its hdmx at 8 points): "W" 10,
    // "i" 2, "x" 6. A cell of 20 is a 17-pixel em (Wine's test_height_selection
    // gives Tahoma 20 an internal leading of 3), each advance scaled to it and
    // rounded: "WWWW" is 60 pixels, where one fixed pitch made it 36 and a
    // button sized to it was narrower than its text (comctl32 button.c's
    // ideal size in Tahoma 20).
    /** @param {number} height @param {string} text */
    const width = (height, text)=>{
        const advances = scaledAdvances({ faceName: 'Tahoma', height, weight: 400 });
        assert.ok(advances, String(height));
        return Array.from(text, character=>advances[character.charCodeAt(0) - 0x20])
            .reduce((sum, advance)=>sum + advance, 0);
    };
    assert.equal(width(20, 'WWWW'), 60);
    assert.equal(width(20, 'i'), 3, '2 * 17 / 11, rounded');
    assert.equal(width(-11, 'WWWW'), 40, 'the em it was measured at is the table itself');
    assert.equal(width(-22, 'x'), 12);
    assert.equal(scaledAdvances({ faceName: 'Tahoma', height: 20, weight: 700 }), null,
        'bold Tahoma is a face of its own');
    assert.equal(scaledAdvances({ faceName: 'MS Sans Serif', height: 20, weight: 400 }), null,
        'a bitmap face is realised, not scaled');
    assert.equal(scaledAdvances({ faceName: 'Arial', height: 20, weight: 400 }), null);
    assert.equal(scaledAdvances({ faceName: 'Microsoft Sans Serif', height: 20, weight: 400 }),
        null, 'a cell whose em cannot be told');
});

test('a bitmap face is realised at one of its sizes, a whole number of times over', ()=>{
    // Wine's test_bitmap_font_metrics and test_bitmap_font: a bitmap face is
    // never drawn at the size asked, but at a size it has, repeated.
    /** @param {string} faceName @param {number} height @param {number} [width] */
    const realise = (faceName, height, width = 0)=>{
        const raster = rasterRealization({ faceName, height, width });
        assert.ok(raster, faceName);
        return [raster.strike.height, raster.scaleX, raster.scaleY];
    };
    assert.equal(rasterRealization({ faceName: 'Arial', height: 13 }), null, 'an outline face');
    assert.equal(rasterFace('Helv'), rasterFace('MS Sans Serif'), 'a substitute is its face');
    // The largest size no larger than asked, the smallest when all are.
    assert.deepEqual(realise('MS Sans Serif', 14), [13, 1, 1]);
    assert.deepEqual(realise('MS Sans Serif', 18), [16, 1, 1]);
    assert.deepEqual(realise('MS Sans Serif', 6), [13, 1, 1]);
    assert.deepEqual(realise('MS Sans Serif', -11), [13, 1, 1], 'a character height');
    assert.deepEqual(realise('MS Sans Serif', 0), [13, 1, 1], 'eight points');
    // System has one size, 16: a quarter of it is the tolerance.
    assert.deepEqual(realise('System', 28), [16, 1, 1], 'two times overshoots by four');
    assert.deepEqual(realise('System', 29), [16, 2, 2]);
    assert.deepEqual(realise('System', 44), [16, 3, 3], 'three times, four short');
    assert.deepEqual(realise('System', 43), [16, 2, 2], 'five short is too far');
    assert.deepEqual(realise('System', 32, 21), [16, 3, 2], 'a width scales across alone');
    assert.deepEqual(realise('System', 0, 4), [16, 1, 1]);
});

test('an outline face whose cell is known measures as Windows scales it', ()=>{
    // Wine's test_height_selection: Tahoma at every height it asks for.
    /** @param {number} height */
    const cell = height=>{
        const known = outlineCell({ faceName: 'Tahoma', height });
        assert.ok(known);
        return [known.height, known.ascent, known.descent, known.internalLeading];
    };
    assert.deepEqual(cell(-12), [14, 12, 2, 2]);
    assert.deepEqual(cell(-24), [29, 24, 5, 5]);
    assert.deepEqual(cell(-192), [232, 192, 40, 40]);
    assert.deepEqual(cell(12), [12, 10, 2, 2]);
    assert.deepEqual(cell(192), [192, 159, 33, 33]);
    assert.deepEqual(cell(-11), [13, 11, 2, 2], 'the 8-point dialog cell');
    assert.equal(outlineCell({ faceName: 'Tahoma', height: 0 }), null);
    assert.equal(outlineCell({ faceName: 'Arial', height: -12 }), null, 'a cell not known');
});
