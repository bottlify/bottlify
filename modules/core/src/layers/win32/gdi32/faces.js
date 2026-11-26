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
    face('Small Fonts', FF_SWISS, VARIABLE_PITCH),
]);

/**
 * A face by name, as GDI compares names: without regard to case.
 *
 * @param {string} name
 * @returns {Face | null}
 */
export function faceNamed(name){
    // As the face is spelled first, which is how programs ask: no string made.
    return BY_NAME.get(name) ?? BY_LOWER_NAME.get(name.toLowerCase()) ?? null;
}

/** The faces by their names as spelled, and lowered. */
const BY_NAME = new Map(FACES.map(entry=>[entry.name, entry]));
const BY_LOWER_NAME = new Map(FACES.map(entry=>[entry.name.toLowerCase(), entry]));

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
 * The em, in pixels, the dialog tables' outline faces were measured at: their
 * `hdmx` widths at 8 points on a 96 DPI display.
 */
const MEASURED_EM = 11;

/**
 * Each ANSI character's advance for an outline face of any size whose widths
 * are known at one em - Tahoma's and Microsoft Sans Serif's, measured at 11
 * pixels - scaled to the font's em and rounded, as GDI rounds a TrueType
 * glyph's advance at its pixel size (decisions.md A266: the hinted widths at
 * one size stand in for the face's design widths, which this engine does not
 * carry). The em is the requested height for a negative one and the cell less
 * its internal leading for a positive one where the face's cell is known.
 * Null for a bitmap face, a bold one, an em that cannot be told, or a face
 * whose widths are not known.
 *
 * @param {{ faceName: string, height: number, weight: number }} font
 * @returns {number[] | null}  advances, 0x20 to 0xFF
 */
export function scaledAdvances(font){
    const named = faceNamed(font.faceName ?? '');
    const resolved = (named?.substitute ?? named?.name ?? '').toLowerCase();
    const measured = DIALOG_8PT.get(resolved);
    if (!measured || rasterFace(font.faceName ?? '') || (font.weight || 400) >= 600)
    {
        return null;
    }
    const requested = font.height | 0;
    const cell = requested > 0 ? outlineCell(font) : null;
    const em = requested < 0 ? -requested
        : cell ? cell.height - cell.internalLeading : 0;
    if (em <= 0)
    {
        return null;
    }
    return Array.from(measured.advances, advance=>Math.round(advance * em / MEASURED_EM));
}

/**
 * An outline face's vertical extent, from its own tables: the em square
 * ('head' unitsPerEm) and the cell Windows measures it by, OS/2's
 * usWinAscent and usWinDescent; and where the face has a 'VDMX' that holds
 * the Windows ANSI set at the display's 1:1 aspect, the extent its hinted
 * glyphs reach at each em in pixels, which Windows measures by over the
 * shares.
 *
 * @typedef {{ ppem: number, ascent: number, descent: number }} PixelExtent
 * @typedef {{ unitsPerEm: number, ascent: number, descent: number,
 *     pixels?: PixelExtent[] }} OutlineCell
 */

/**
 * The cells of the system's faces, which have no file here. Only faces whose
 * numbers Windows' answers confirm are written: Tahoma's give every height of
 * Wine's test_height_selection and the 8-point dialog cell. A face a program
 * adds brings its own (`fontCells`).
 *
 * @type {ReadonlyMap<string, OutlineCell>}
 */
const OUTLINE_CELLS = new Map([
    ['tahoma', Object.freeze({ unitsPerEm: 2048, ascent: 2049, descent: 423 })],
]);

/**
 * Font metrics with no font engine behind them, shares of the em: an estimate
 * GetTextMetrics answers for a face whose cell is not known, chosen so the
 * numbers a program divides by add up (see gdi32's metricsOf). GDI+ estimates
 * a family's design metrics from the same shares.
 */
export const DEFAULT_EM_HEIGHT = 13;
export const INTERNAL_LEADING_RATIO = 0.2;
export const DESCENT_RATIO = 0.25;

/**
 * An outline face's design metrics, as GDI+ answers a family's: its em, its
 * cell's ascent and descent, in font units; the estimate's shares of a 2048
 * em for a face whose cell is not known. Null for a bitmap face, which GDI+
 * does not take.
 *
 * @param {string} faceName
 * @returns {{ unitsPerEm: number, ascent: number, descent: number } | null}
 */
export function designCell(faceName){
    if (rasterFace(faceName))
    {
        return null;
    }
    const named = faceNamed(faceName ?? '');
    const known = OUTLINE_CELLS.get((named?.substitute ?? named?.name ?? '').toLowerCase());
    if (known)
    {
        return { unitsPerEm: known.unitsPerEm, ascent: known.ascent, descent: known.descent };
    }
    const em = 2048;
    const descent = Math.round(em * DESCENT_RATIO);
    return { unitsPerEm: em, ascent: Math.round(em * (1 + INTERNAL_LEADING_RATIO)) - descent,
        descent };
}

/**
 * What GetTextMetrics measures vertically for an outline face whose cell is
 * known, as Windows scales a TrueType face: a negative height is the em, the
 * ascent and descent each its share of it rounded; a positive one is the
 * cell, split by the same shares, the em what is left of it. Null for a face
 * not known, or a height of zero.
 *
 * @param {{ faceName: string, height: number }} font
 * @param {(family: string) => OutlineCell | undefined} [added]  The cell of a
 *     face a program added, by its family name.
 * @returns {{ height: number, ascent: number, descent: number, internalLeading: number } | null}
 */
export function outlineCell(font, added){
    const named = faceNamed(font.faceName ?? '');
    const cell = OUTLINE_CELLS.get((named?.substitute ?? named?.name ?? '').toLowerCase())
        ?? added?.(font.faceName ?? '');
    const requested = font.height | 0;
    if (!cell || requested === 0)
    {
        return null;
    }
    const pixels = cell.pixels ?? [];
    // An em the table holds is its extent; a cell the table holds is the
    // largest em whose extent fits in it.
    const hinted = requested < 0
        ? pixels.find(extent=>extent.ppem === -requested)
        : pixels.filter(extent=>extent.ascent + extent.descent <= requested).at(-1);
    if (hinted && (requested < 0 || pixels[pixels.length - 1].ascent
        + pixels[pixels.length - 1].descent >= requested))
    {
        const height = hinted.ascent + hinted.descent;
        return { height, ascent: hinted.ascent, descent: hinted.descent,
            internalLeading: height - hinted.ppem };
    }
    const tall = cell.ascent + cell.descent;
    if (requested < 0)
    {
        const em = -requested;
        const ascent = Math.round(cell.ascent * em / cell.unitsPerEm);
        const descent = Math.round(cell.descent * em / cell.unitsPerEm);
        return { height: ascent + descent, ascent, descent,
            internalLeading: ascent + descent - em };
    }
    const ascent = Math.round(cell.ascent * requested / tall);
    return { height: requested, ascent, descent: requested - ascent,
        internalLeading: requested - Math.round(cell.unitsPerEm * requested / tall) };
}

/**
 * One size of a bitmap face, as its .fon holds it at 96 DPI: the cell, its
 * split, the leadings and the widths GetTextMetrics answers.
 *
 * @typedef {Object} RasterStrike
 * @property {number} height
 * @property {number} ascent
 * @property {number} descent
 * @property {number} internalLeading
 * @property {number} externalLeading
 * @property {number} aveCharWidth
 * @property {number} maxCharWidth
 */

/**
 * A bitmap face: its sizes, smallest first, the weight they are drawn at and
 * the character it answers for one it has not got.
 *
 * @typedef {Object} RasterFace
 * @property {number} weight
 * @property {number} defaultChar
 * @property {readonly RasterStrike[]} strikes
 */

/** @param {number[]} row height, ascent, descent, internal and external leading, widths */
const strikeOf = ([height, ascent, descent, internalLeading, externalLeading, aveCharWidth,
    maxCharWidth])=>Object.freeze({ height, ascent, descent, internalLeading, externalLeading,
    aveCharWidth, maxCharWidth });
/** @param {number} weight @param {number} defaultChar @param {number[][]} rows */
const bitmapFace = (weight, defaultChar, rows)=>Object.freeze({ weight, defaultChar,
    strikes: Object.freeze(rows.map(strikeOf)) });

/**
 * The bitmap faces Windows installs for the ANSI code page (sserife.fon,
 * serife.fon, coure.fon, vgasys.fon, smalle.fon, vgafix.fon), each size at
 * 96 DPI as GetTextMetrics measures it - the rows Wine's
 * test_bitmap_font_metrics holds Windows to. A bitmap face is not scaled: a
 * request is realised as one of these sizes.
 *
 * @type {ReadonlyMap<string, RasterFace>}
 */
const RASTER_FACES = new Map([
    ['ms sans serif', bitmapFace(400, 0x81, [[13, 11, 2, 2, 0, 5, 11], [16, 13, 3, 3, 0, 7, 14],
        [20, 16, 4, 4, 0, 8, 16], [24, 19, 5, 6, 0, 9, 19], [29, 23, 6, 5, 0, 12, 24],
        [37, 29, 8, 5, 0, 16, 32]])],
    ['ms serif', bitmapFace(400, 0x80, [[10, 8, 2, 2, 0, 4, 8], [11, 9, 2, 2, 0, 5, 9],
        [13, 11, 2, 2, 0, 5, 11], [16, 13, 3, 3, 0, 6, 14], [19, 15, 4, 3, 0, 8, 18],
        [21, 16, 5, 3, 0, 9, 17], [27, 21, 6, 3, 0, 12, 23], [35, 27, 8, 3, 0, 16, 33]])],
    ['courier', bitmapFace(400, 0x80, [[13, 11, 2, 0, 0, 8, 8], [16, 13, 3, 0, 0, 9, 9],
        [20, 16, 4, 0, 0, 12, 12]])],
    ['system', bitmapFace(700, 0x80, [[16, 13, 3, 3, 0, 7, 14]])],
    ['small fonts', bitmapFace(400, 0x80, [[3, 2, 1, 0, 0, 1, 2], [5, 4, 1, 1, 0, 3, 4],
        [6, 5, 1, 1, 0, 3, 13], [8, 7, 1, 1, 0, 4, 7], [10, 8, 2, 2, 0, 4, 8],
        [11, 9, 2, 2, 0, 5, 9]])],
    ['fixedsys', bitmapFace(400, 0x80, [[15, 12, 3, 3, 0, 8, 8]])],
]);

/**
 * The bitmap face a font names, substitutes resolved; null for an outline one.
 *
 * @param {string} faceName
 * @returns {RasterFace | null}
 */
export function rasterFace(faceName){
    const named = faceNamed(faceName ?? '');
    return RASTER_FACES.get((named?.substitute ?? named?.name ?? '').toLowerCase()) ?? null;
}

/**
 * How a bitmap face realises a request, as GDI does it: the strike is the
 * largest whose cell (a positive height) or character (a negative one) is no
 * larger than asked, and the smallest when every one is; zero asks for the
 * 8-point character height. A request well past the strike is that strike
 * repeated a whole number of times: the multiple nearest above, unless that
 * overshoots by more than a quarter of the strike (by a quarter or more for
 * the step from one to two). A width scales across the same way from the
 * average character width; with none, across as much as down.
 *
 * @typedef {Object} RasterRealization
 * @property {RasterFace} face
 * @property {RasterStrike} strike
 * @property {number} scaleX
 * @property {number} scaleY
 * @property {Uint8Array | null} advances  The strike's own advances, 0x20 to
 *           0xFF, where they are known.
 */

/** @param {number} target @param {number} base */
const wholeScale = (target, base)=>{
    let scale = Math.max(1, Math.ceil(target / base));
    const over = scale * base - target;
    if ((scale > 2 && over > base / 4) || (scale === 2 && over >= base / 4))
    {
        scale--;
    }
    return scale;
};

/**
 * @param {{ faceName: string, height: number, width?: number }} font
 * @returns {RasterRealization | null}
 */
export function rasterRealization(font){
    const bitmap = rasterFace(font.faceName);
    if (!bitmap)
    {
        return null;
    }
    const requested = (font.height | 0) || -11;
    const size = (/** @type {RasterStrike} */ strike)=>requested > 0
        ? strike.height : strike.height - strike.internalLeading;
    const target = Math.abs(requested);
    const fits = bitmap.strikes.filter(strike=>size(strike) <= target);
    const strike = fits.length > 0 ? fits[fits.length - 1] : bitmap.strikes[0];
    const scaleY = wholeScale(target, size(strike));
    const width = Math.abs((font.width ?? 0) | 0);
    const scaleX = width === 0 ? scaleY : wholeScale(width, strike.aveCharWidth);
    const named = (faceNamed(font.faceName)?.substitute ?? faceNamed(font.faceName)?.name ?? '')
        .toLowerCase();
    const advances = named === 'ms sans serif' && strike.height === 13 ? MS_SANS_SERIF
        : named === 'system' && strike.height === 16 ? SYSTEM : null;
    return { face: bitmap, strike, scaleX, scaleY, advances };
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
    return fontFaces(bytes).map(held=>held.family);
}

/**
 * The faces a font file holds: each one's family (see `fontFamilies`) and,
 * where its 'head' and 'OS/2' tables are there, its cell (`OutlineCell`).
 *
 * @param {Uint8Array} bytes
 * @returns {{ family: string, cell: OutlineCell | null }[]}
 */
export function fontFaces(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (/** @type {number} */ at)=>view.getUint16(at);
    const u32 = (/** @type {number} */ at)=>view.getUint32(at);
    const tag = (/** @type {number} */ at)=>String.fromCharCode(...bytes.subarray(at, at + 4));
    /**
     * Where a face's table starts, null where it has none.
     *
     * @param {number} at  where the face's table directory starts
     * @param {string} name
     */
    const tableAt = (at, name)=>{
        const tables = u16(at + 4);
        for (let index = 0; index < tables; index++)
        {
            const record = at + 12 + index * 16;
            if (tag(record) === name)
            {
                return u32(record + 8);
            }
        }
        return null;
    };
    const s16 = (/** @type {number} */ at)=>view.getInt16(at);
    /**
     * The VDMX group Windows measures by: the first ratio record for the
     * Windows ANSI set (bCharSet 1; Windows passes over a record for every
     * glyph, decisions.md A254) that covers the display's 1:1 aspect, or
     * names no ratio at all.
     *
     * @param {number} at  where a face's table directory starts
     * @returns {PixelExtent[] | undefined}
     */
    const pixelsAt = at=>{
        const table = tableAt(at, 'VDMX');
        if (table === null)
        {
            return undefined;
        }
        const ratios = u16(table + 4);
        for (let index = 0; index < ratios; index++)
        {
            const ratio = table + 6 + index * 4;
            const [charSet, x, yStart, yEnd] = bytes.subarray(ratio, ratio + 4);
            const any = x === 0 && yStart === 0 && yEnd === 0;
            if (charSet !== 1 || !(any || (yStart <= x && x <= yEnd)))
            {
                continue;
            }
            const group = table + u16(table + 6 + ratios * 4 + index * 2);
            return Array.from({ length: u16(group) }, (_, entry)=>{
                const record = group + 4 + entry * 6;
                return { ppem: u16(record), ascent: s16(record + 2), descent: -s16(record + 4) };
            });
        }
        return undefined;
    };
    /** @param {number} at  where a face's table directory starts */
    const cellAt = at=>{
        const head = tableAt(at, 'head');
        const os2 = tableAt(at, 'OS/2');
        if (head === null || os2 === null)
        {
            return null;
        }
        const pixels = pixelsAt(at);
        // head.unitsPerEm at 18; OS/2 usWinAscent and usWinDescent at 74, 76.
        return { unitsPerEm: u16(head + 18), ascent: u16(os2 + 74), descent: u16(os2 + 76),
            ...(pixels?.length ? { pixels } : {}) };
    };
    /** @param {number} at  where a face's table directory starts */
    const familyAt = at=>{
        const table = tableAt(at, 'name');
        if (table !== null)
        {
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
    /** @param {number} at */
    const faceAt = at=>{
        const family = familyAt(at);
        return family ? { family, cell: cellAt(at) } : null;
    };
    try
    {
        const kind = tag(0);
        const starts = kind === 'ttcf'
            ? Array.from({ length: u32(8) }, (_, index)=>u32(12 + index * 4))
            : kind === 'OTTO' || kind === 'true' || u32(0) === 0x00010000 ? [0] : [];
        return starts.map(faceAt).filter(held=>held !== null);
    }
    catch {
        // A directory that points past the end is not a font.
        return [];
    }
}
