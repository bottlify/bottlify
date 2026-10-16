/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The faces a program can ask for by name: the classic Windows ones, each
 * with the family a LOGFONT names it by.
 *
 * No font file ships. The font engine draws a face through the browser,
 * under its own name first and the generic family its LOGFONT family maps to
 * when the browser has no face of that name -- so this table is both what
 * EnumFontFamiliesEx lists and what the engine falls back on, and it lives
 * here, where both halves of gdi32 can read it.
 *
 * A substitute is a name Windows answers for with another face's -- a
 * registry FontSubstitutes entry. It is found when asked for by name and is
 * never listed among the faces.
 */

/** A LOGFONT's family, the high nibble of lfPitchAndFamily. */
export const FF_ROMAN = 0x10;
export const FF_SWISS = 0x20;
export const FF_MODERN = 0x30;

/** And its pitch, the low bits. */
export const FIXED_PITCH = 1;
export const VARIABLE_PITCH = 2;

/**
 * @typedef {Object} Face
 * @property {string} name
 * @property {number} family       FF_ROMAN, FF_SWISS or FF_MODERN.
 * @property {number} pitch        FIXED_PITCH or VARIABLE_PITCH.
 * @property {string} [substitute] The face a substitute's name stands for.
 */

/** @param {string} name @param {number} family @param {number} pitch @param {string} [substitute] */
const face = (name, family, pitch, substitute)=>Object.freeze({ name, family, pitch, substitute });

/** @type {readonly Face[]} */
export const FACES = Object.freeze([
    face('MS Sans Serif', FF_SWISS, VARIABLE_PITCH),
    face('Microsoft Sans Serif', FF_SWISS, VARIABLE_PITCH),
    face('MS Shell Dlg', FF_SWISS, VARIABLE_PITCH, 'Microsoft Sans Serif'),
    face('MS Shell Dlg 2', FF_SWISS, VARIABLE_PITCH, 'Tahoma'),
    face('Tahoma', FF_SWISS, VARIABLE_PITCH),
    face('Arial', FF_SWISS, VARIABLE_PITCH),
    face('Helv', FF_SWISS, VARIABLE_PITCH, 'MS Sans Serif'),
    face('Verdana', FF_SWISS, VARIABLE_PITCH),
    face('System', FF_SWISS, VARIABLE_PITCH),
    face('Segoe UI', FF_SWISS, VARIABLE_PITCH),
    face('Times New Roman', FF_ROMAN, VARIABLE_PITCH),
    face('MS Serif', FF_ROMAN, VARIABLE_PITCH),
    face('Georgia', FF_ROMAN, VARIABLE_PITCH),
    face('Courier New', FF_MODERN, FIXED_PITCH),
    face('Courier', FF_MODERN, FIXED_PITCH),
    face('Fixedsys', FF_MODERN, FIXED_PITCH),
    face('Terminal', FF_MODERN, FIXED_PITCH),
    face('Lucida Console', FF_MODERN, FIXED_PITCH),
]);

/**
 * A face by name, as GDI compares names: without regard to case.
 *
 * @param {string} name
 * @returns {Face | null}
 */
export function faceNamed(name){
    const wanted = name.toLowerCase();
    return FACES.find(entry=>entry.name.toLowerCase() === wanted) ?? null;
}

/**
 * What Windows measures for the faces dialogs are laid out in, at the sizes
 * they are laid out at (96 DPI): GetTextMetrics' answer, and the cell a
 * template's dialog units count in -- the alphabet's average width as the
 * dialog manager takes it, and the cell's height.
 *
 * The browser draws these faces with whatever it has in their place, and a
 * substitute's proportions are its own: a dialog sized from them is wider or
 * taller than the program drew its pictures for, and a skin painted for
 * Windows' size leaves the rest of the window bare. So for these requests the
 * measurements are Windows', whatever face draws the glyphs -- as Wine ships
 * faces made to Windows' metrics for the same reason. MS Sans Serif is a
 * bitmap face whose 8-point size is 13 pixels high; MS Shell Dlg and MS Shell
 * Dlg 2 are the TrueType faces of that size the shell's dialogs use, with the
 * same cell; the System font is the one a dialog without a font of its own
 * is counted in.
 *
 * @typedef {Object} WindowsMetrics
 * @property {number} height
 * @property {number} ascent
 * @property {number} descent
 * @property {number} internalLeading
 * @property {number} aveCharWidth
 * @property {{ width: number, height: number }} cell
 * @property {Uint8Array} advances  Each character's advance, 0x20 to 0xFF of
 *           the ANSI code page: where a string wraps, is clipped or is
 *           shortened -- a static that held its line on Windows, a path an
 *           installer cut with an ellipsis -- is decided by these.
 */

/**
 * The advances, one hexadecimal digit a character from 0x20 to 0xFF, read off
 * the fonts Windows draws these faces with at 96 DPI: MS Sans Serif's and
 * System's bitmaps, and Microsoft Sans Serif's and Tahoma's hinted widths at
 * 11 pixels (their `hdmx` tables). A face's own glyphs for 0x80-0x9F where it
 * has them; MS Sans Serif answers those with its default character.
 *
 * @param {string} digits
 */
const advancesOf = digits=>Uint8Array.from(digits, digit=>parseInt(digit, 16));
const MS_SANS_SERIF = advancesOf('33576862334633356666666666336666b7778768835769887887787b777353'
    + '66366666366226286666353668555424736333333333333333333333333333333333666626394663864633366333'
    + '468886777777a7777733338888888688888776666666a6666624446666666666666565');
const MICROSOFT_SANS_SERIF = advancesOf('33576862334633356666666666336666b7778768835769887887787b77'
    + '735366366666366226286666353668555424736336565554b76b373333446565956a35733666626394663864'
    + '633366333468886777777a7777733338888888688888776666666a6666624446666666666666565');
const TAHOMA = advancesOf('34486b72446844446666666666448885a7677667745658786876676a666444866665'
    + '664662352866664546686655458b6b2649666f64bb6bb224456a6a54ab56346666466a5684a6585566646556b'
    + 'bb5777777a7666644448788888887777666666666a5666622226666666866666666');
const SYSTEM = advancesOf('44688b94446844448888888888448888e8a9a98aa4798caa9aa98a8e9a944458588'
    + '7884884474c888858488a8885455444444444444444444444444444444444948888485a5784a8584458745457'
    + 'bbb8888888d999994444aaaaaaa8aaaaaa98888888c7888844448888888688888888');

/** @param {Uint8Array} advances */
const dialog8pt = advances=>Object.freeze({ height: 13, ascent: 11, descent: 2,
    internalLeading: 2, aveCharWidth: 5, cell: Object.freeze({ width: 6, height: 13 }), advances });
/** The 8-point dialog faces, substitutes resolved. @type {ReadonlyMap<string, WindowsMetrics>} */
const DIALOG_8PT = new Map([
    ['ms sans serif', dialog8pt(MS_SANS_SERIF)],
    ['microsoft sans serif', dialog8pt(MICROSOFT_SANS_SERIF)],
    ['tahoma', dialog8pt(TAHOMA)],
]);
/** @type {WindowsMetrics} */
const SYSTEM_CELL = Object.freeze({ height: 16, ascent: 13, descent: 3, internalLeading: 3,
    aveCharWidth: 7, cell: Object.freeze({ width: 8, height: 16 }), advances: SYSTEM });

/**
 * Windows' measurements of a font, for the requests whose Windows answer is
 * known; null for every other, which the font engine or the estimate answers.
 *
 * @param {{ faceName: string, height: number, weight: number }} font
 * @returns {WindowsMetrics | null}
 */
export function windowsMetrics(font){
    const named = faceNamed(font.faceName ?? '');
    const resolved = (named?.substitute ?? named?.name ?? '').toLowerCase();
    const height = font.height | 0;
    const weight = font.weight || 400;
    // ponytail: the bold 8-point faces are measured, not Windows'; a bitmap
    // face's bold is its regular advances plus one, Tahoma's is a face of its own.
    const dialog = DIALOG_8PT.get(resolved);
    if (dialog && weight < 600 && (height === -11 || height === 13))
    {
        return dialog;
    }
    if (resolved === 'system' && (height === 16 || height === -13))
    {
        return SYSTEM_CELL;
    }
    return null;
}

/**
 * The family names a font file declares, one for each face in it: the `name`
 * table's family (name 1), Windows' Unicode record first, US English among
 * those, and the Macintosh one where there is no other. A collection
 * ('ttcf') names one per face. Not a font file, it names none.
 *
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function fontFamilies(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (/** @type {number} */ at)=>view.getUint16(at);
    const u32 = (/** @type {number} */ at)=>view.getUint32(at);
    const tag = (/** @type {number} */ at)=>String.fromCharCode(...bytes.subarray(at, at + 4));
    /** @param {number} at  where a face's table directory starts */
    const familyAt = at=>{
        const tables = u16(at + 4);
        for (let index = 0; index < tables; index++)
        {
            const record = at + 12 + index * 16;
            if (tag(record) !== 'name')
            {
                continue;
            }
            const table = u32(record + 8);
            const count = u16(table + 2);
            const strings = table + u16(table + 4);
            let best = null;
            let rank = 0;
            for (let entry = 0; entry < count; entry++)
            {
                const name = table + 6 + entry * 12;
                const [platform, , language, id, length, offset] =
                    [0, 2, 4, 6, 8, 10].map(field=>u16(name + field));
                const here = id !== 1 ? 0 : platform === 3 ? (language === 0x409 ? 3 : 2)
                    : platform === 1 ? 1 : 0;
                if (here > rank)
                {
                    const raw = bytes.subarray(strings + offset, strings + offset + length);
                    best = platform === 3
                        ? String.fromCharCode(...Array.from({ length: length >> 1 },
                            (_, unit)=>raw[unit * 2] << 8 | raw[unit * 2 + 1]))
                        : String.fromCharCode(...raw);
                    rank = here;
                }
            }
            return best;
        }
        return null;
    };
    try
    {
        const kind = tag(0);
        const starts = kind === 'ttcf'
            ? Array.from({ length: u32(8) }, (_, index)=>u32(12 + index * 4))
            : kind === 'OTTO' || kind === 'true' || u32(0) === 0x00010000 ? [0] : [];
        return /** @type {string[]} */ (starts.map(familyAt).filter(name=>name));
    }
    catch {
        // A directory that points past the end is not a font.
        return [];
    }
}
