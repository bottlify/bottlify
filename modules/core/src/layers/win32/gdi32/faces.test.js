/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fontFamilies, windowsMetrics } from './faces.js';

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
