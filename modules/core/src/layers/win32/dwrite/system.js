/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The system font collection's faces. No font file ships: the faces are the
 * TrueType ones of gdi32's table (bitmap faces and substitutes are GDI's
 * alone, as on Windows), four of each family - regular, bold, italic, bold
 * italic - and the browser draws them, as it draws GDI's text. A face's
 * tables are written here from what the font engine measures of the face at
 * a probe size, in 2048 units to the em, so DirectWrite answers about it -
 * metrics, glyph indices, advances, TryGetFontTable - from tables like any
 * file's (decision A238).
 *
 * A glyph is the character's own number, as in the 'cmap' gdi32 answers
 * GetFontData with, so drawing a glyph is drawing that character.
 * Without a font engine (Node, the tests) the measurements are estimates of
 * Arial's and Courier New's proportions, as gdi32's bookkeeping estimates.
 */

import { FACES, FIXED_PITCH, FF_ROMAN } from '../gdi32/faces.js';
import { nameTable, pack, writeSfnt } from './sfnt.js';
import { isInvisible } from './text.js';

/** Design units to the em, as Windows' TrueType faces have them. */
export const UNITS_PER_EM = 2048;
/** The em, in pixels, a face is measured at; a pixel is SCALE design units. */
const PROBE_EM = 128;
const SCALE = UNITS_PER_EM / PROBE_EM;
/**
 * Glyphs 'hmtx' gives an advance of their own: Latin through IPA. A glyph
 * past them takes the last one's, as the format has it; an advance a program
 * asks DirectWrite for is measured for every glyph.
 */
const LONG_METRICS = 0x250;
/** maxp's count: the Basic Multilingual Plane but U+FFFF. */
export const GLYPH_COUNT = 0xffff;

/** The faces the font engine measures, by what a LOGFONT asks of it. */
const FAMILY_NAMES = FACES.filter(face=>!face.substitute && ![
    'MS Sans Serif', 'System', 'MS Serif', 'Courier', 'Fixedsys', 'Terminal',
].includes(face.name));

/** The four faces of a family: weight, italic, the face name and the file's suffix. */
const VARIANTS = Object.freeze([
    { weight: 400, italic: false, face: 'Regular', suffix: '' },
    { weight: 700, italic: false, face: 'Bold', suffix: 'bd' },
    { weight: 400, italic: true, face: 'Italic', suffix: 'i' },
    { weight: 700, italic: true, face: 'Bold Italic', suffix: 'bi' },
]);

/**
 * @typedef {Object} SystemFont
 * @property {string} family
 * @property {number} weight
 * @property {boolean} italic
 * @property {string} faceName
 * @property {string} path      where the face's file is said to be
 * @property {boolean} fixed
 * @property {boolean} roman
 */

/**
 * Families Windows ships fewer faces of: how many of VARIANTS they have.
 * Tahoma has no italic, so an italic Tahoma is the regular one slanted - an
 * oblique simulation - as there.
 */
const FACES_SHIPPED = new Map([['Microsoft Sans Serif', 1], ['Tahoma', 2],
    ['Lucida Console', 1]]);

/** @type {readonly { name: string, fonts: readonly SystemFont[] }[]} */
export const SYSTEM_FAMILIES = Object.freeze(FAMILY_NAMES.map(face=>({ name: face.name,
    fonts: Object.freeze(VARIANTS.slice(0, FACES_SHIPPED.get(face.name) ?? VARIANTS.length)
        .map(variant=>Object.freeze({ family: face.name,
            weight: variant.weight, italic: variant.italic, faceName: variant.face,
            path: `C:\\WINDOWS\\Fonts\\${face.name.toLowerCase().replace(/ /g, '')}`
                + `${variant.suffix}.ttf`,
            fixed: face.pitch === FIXED_PITCH, roman: face.family === FF_ROMAN }))) })));

/**
 * The faces' 'cmap': format 4 for Windows' Unicode encoding, every character
 * of the Basic Multilingual Plane from the space on to the glyph of its own
 * number, but the surrogates, which are halves of characters and no glyph's.
 */
const CHARACTER_MAP = (()=>{
    const segments = [[0x20, 0xd7ff], [0xe000, 0xfffd], [0xffff, 0xffff]];
    const length = 16 + segments.length * 8;
    const bytes = new Uint8Array(12 + length);
    const view = new DataView(bytes.buffer);
    view.setUint16(2, 1);
    view.setUint16(4, 3);
    view.setUint16(6, 1);
    view.setUint32(8, 12);
    const search = 2 * 2 ** Math.floor(Math.log2(segments.length));
    [4, length, 0, segments.length * 2, search, Math.log2(search / 2),
        segments.length * 2 - search].forEach((value, i)=>view.setUint16(12 + i * 2, value));
    const ends = 26;
    const starts = ends + segments.length * 2 + 2;
    segments.forEach(([first, last], i)=>{
        view.setUint16(ends + i * 2, last);
        view.setUint16(starts + i * 2, first);
        // idDelta 0: the glyph is the character's number; the last segment,
        // the format's closing one, maps to glyph 0 by delta 1.
        view.setUint16(starts + segments.length * 2 + i * 2, last === 0xffff ? 1 : 0);
    });
    return bytes;
})();

/**
 * What a face is measured with: the font engine's hooks, each null without one.
 *
 * @typedef {Object} Measurer
 * @property {(font: any) => { ascent: number, descent: number, externalLeading: number,
 *     aveCharWidth: number, maxCharWidth: number } | null} metrics
 * @property {(font: any, text: string) => number | null} textWidth
 * @property {(code: number, font: any) => { advance: number, left: number, top: number,
 *     width: number, height: number, coverage: Uint8Array } | null} glyph
 */

/** Characters Arial's widths put narrow and wide, for the estimates. */
const NARROW = new Set([...'iljI.,:;!|\'`[]()ft']);
const WIDE = new Set([...'mwMW@%']);

/**
 * A face of the system collection: its file's bytes and its glyphs' measurements.
 *
 * @param {SystemFont} font @param {Measurer} measure
 */
export function createSystemFace(font, measure){
    const request = { height: -PROBE_EM, weight: font.weight, italic: font.italic ? 1 : 0,
        underline: 0, strikeOut: 0, faceName: font.family };
    /** @type {Map<number, number>} */
    const advances = new Map();
    const measured = measure.metrics(request);
    const ascent = measured ? Math.round(measured.ascent * SCALE) : font.fixed ? 1705 : 1854;
    const descent = measured ? Math.round(measured.descent * SCALE) : font.fixed ? 615 : 434;
    const lineGap = measured ? Math.round(measured.externalLeading * SCALE) : 0;

    /**
     * A glyph's advance in design units: measured, or estimated.
     *
     * @param {number} glyph
     */
    const advance = glyph=>{
        let units = advances.get(glyph);
        if (units !== undefined)
        {
            return units;
        }
        const width = glyph === 0 || glyph >= GLYPH_COUNT ? null
            : measure.textWidth(request, String.fromCharCode(glyph));
        if (width !== null && width !== undefined)
        {
            units = Math.round(width * SCALE);
        }
        else
        {
            const c = String.fromCharCode(glyph);
            const em = UNITS_PER_EM;
            units = glyph < 0x20 ? 0 : font.fixed ? 1229 : c === ' ' ? 569
                : NARROW.has(c) ? 455 : WIDE.has(c) ? 1706
                    : c >= 'A' && c <= 'Z' ? 1366 : Math.round(em * 0.556);
            if (font.weight >= 700 && !font.fixed && units > 0)
            {
                units = Math.round(units * 1.08);
            }
        }
        advances.set(glyph, units);
        return units;
    };

    /**
     * A glyph's inked box in design units, y up from the baseline, or null for
     * one with no ink (or no engine to say).
     *
     * @param {number} glyph
     * @returns {{ xMin: number, yMin: number, xMax: number, yMax: number } | null}
     */
    const box = glyph=>{
        if (glyph <= 0x20 || glyph >= GLYPH_COUNT || isInvisible(glyph) || glyph === 0xa0
            || glyph === 0x3000 || (glyph >= 0x2000 && glyph <= 0x200a))
        {
            return null;
        }
        const drawn = measured ? measure.glyph(glyph, request) : null;
        if (!drawn)
        {
            // No engine: the box a Latin glyph of that advance would have.
            const c = String.fromCharCode(glyph);
            const width = advance(glyph);
            const tall = /[A-Z0-9bdfhklt]/.test(c) || glyph > 0x7f;
            return { xMin: Math.round(width * 0.06), xMax: width - Math.round(width * 0.06),
                yMin: /[gjpqy]/.test(c) ? -Math.round(descent * 0.9) : 0,
                yMax: tall ? Math.round(UNITS_PER_EM * 0.716) : Math.round(UNITS_PER_EM * 0.519) };
        }
        if (drawn.width === 0 || drawn.height === 0 || !measured)
        {
            return null;
        }
        const up = measured.ascent - drawn.top;
        return { xMin: drawn.left * SCALE, xMax: (drawn.left + drawn.width) * SCALE,
            yMax: up * SCALE, yMin: (up - drawn.height) * SCALE };
    };

    /** @type {Uint8Array | null} */
    let file = null;
    /** The face's file: its tables written out. */
    const bytes = ()=>{
        if (file)
        {
            return file;
        }
        const em = UNITS_PER_EM;
        const capHeight = Math.round(em * 0.716);
        const xHeight = Math.round(em * 0.519);
        const widest = Math.max(...Array.from({ length: 0x5f }, (_, i)=>advance(0x20 + i)));
        const average = Math.round([...'abcdefghijklmnopqrstuvwxyz']
            .reduce((sum, c)=>sum + advance(c.charCodeAt(0)), 0) / 26);
        const bold = font.weight >= 700;
        const macStyle = (bold ? 1 : 0) | (font.italic ? 2 : 0);
        const fullName = font.faceName === 'Regular' ? font.family
            : `${font.family} ${font.faceName}`;
        const postscript = `${font.family.replace(/ /g, '')}${font.faceName === 'Regular' ? ''
            : `-${font.faceName.replace(/ /g, '')}`}`;
        const head = pack([['u32', 0x00010000], ['u32', 0x00010000], ['u32', 0],
            ['u32', 0x5f0f3cf5], ['u16', 0x000b], ['u16', em], ['u32', 0], ['u32', 0],
            ['u32', 0], ['u32', 0], ['i16', -Math.round(em * 0.33)], ['i16', -descent],
            ['i16', Math.max(widest, em)], ['i16', ascent], ['u16', macStyle], ['u16', 9],
            ['i16', 2], ['i16', 0], ['i16', 0]]);
        const hhea = pack([['u32', 0x00010000], ['i16', ascent], ['i16', -descent],
            ['i16', lineGap], ['u16', widest], ['i16', 0], ['i16', 0], ['i16', widest],
            ['i16', font.italic ? 2048 : 1], ['i16', font.italic ? 431 : 0], ['i16', 0],
            ['i16', 0], ['i16', 0], ['i16', 0], ['i16', 0], ['i16', 0],
            ['u16', LONG_METRICS]]);
        const maxp = pack([['u32', 0x00010000], ['u16', GLYPH_COUNT], ...Array.from({ length: 13 },
            ()=>/** @type {[string, number]} */ (['u16', 0]))]);
        const selection = (font.italic ? 1 : 0) | (bold ? 0x20 : 0)
            | (!bold && !font.italic ? 0x40 : 0);
        const os2 = pack([['u16', 4], ['i16', average], ['u16', font.weight], ['u16', 5],
            ['u16', 0], ['i16', Math.round(em * 0.65)], ['i16', Math.round(em * 0.6)],
            ['i16', 0], ['i16', Math.round(em * 0.075)], ['i16', Math.round(em * 0.65)],
            ['i16', Math.round(em * 0.6)], ['i16', 0], ['i16', Math.round(em * 0.35)],
            ['i16', Math.round(em / 14)], ['i16', Math.round(xHeight / 2)], ['i16', 0],
            // PANOSE: a text face, serif or sans, its weight, monospaced or not.
            ['bytes', [2, font.roman ? 2 : 11, bold ? 8 : 6, font.fixed ? 9 : 4, 2, 2, 2, 2, 2,
                4]],
            ['u32', 0xe0002eff], ['u32', 0xc000785b], ['u32', 0x00000009], ['u32', 0],
            ['bytes', [...'BTFY'].map(c=>c.charCodeAt(0))], ['u16', selection], ['u16', 0x20],
            ['u16', 0xfffd], ['i16', ascent], ['i16', -descent], ['i16', lineGap],
            ['u16', ascent], ['u16', descent], ['u32', 0x000001ff], ['u32', 0],
            ['i16', xHeight], ['i16', capHeight], ['u16', 0], ['u16', 0x20], ['u16', 0]]);
        const post = pack([['u32', 0x00030000], ['i32', font.italic ? -12 * 65536 : 0],
            ['i16', -Math.round(em * 0.1)], ['i16', Math.round(em / 14)],
            ['u32', font.fixed ? 1 : 0], ['u32', 0], ['u32', 0], ['u32', 0], ['u32', 0]]);
        const hmtx = new Uint8Array(LONG_METRICS * 4 + (GLYPH_COUNT - LONG_METRICS) * 2);
        const view = new DataView(hmtx.buffer);
        for (let glyph = 0; glyph < LONG_METRICS; glyph++)
        {
            view.setUint16(glyph * 4, advance(glyph));
        }
        const name = nameTable([[1, font.family], [2, font.faceName],
            [3, `Bottlify: ${fullName}`], [4, fullName], [5, 'Version 1.00'], [6, postscript]]);
        file = writeSfnt(new Map([['cmap', CHARACTER_MAP], ['head', head],
            ['hhea', hhea], ['hmtx', hmtx], ['maxp', maxp], ['name', name], ['OS/2', os2],
            ['post', post]]));
        return file;
    };

    return { font, request, bytes, advance, box };
}
