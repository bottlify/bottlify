/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The font engine: glyph coverage and font measurements from the browser's
 * own fonts, through a 2D canvas.
 *
 * The engine runs on a worker, and a worker has `OffscreenCanvas` and no
 * DOM; a 2D context on one measures and fills text with whatever faces the
 * browser has, and the alpha channel of what it painted is the coverage a
 * glyph has over each pixel. No font file ships and nothing is parsed: the
 * browser is the rasteriser. Where there is no canvas -- Node, the unit
 * tests -- the engine says so and answers nothing, and the drawing keeps its
 * own pixel face and the bookkeeping half its estimates.
 *
 * A glyph is rasterised once per font and kept in the run's cache; a run of
 * text is the sum of its glyphs at integer advances, which is how GDI
 * positions a string too, and why a string's extent is the sum of the
 * advances rather than the canvas's own fractional width.
 *
 * Glyphs are kept as pages, bodies of the run's cache named by what they
 * hold: a face's request and a run of 32 codes (`PAGE_CODES`). A page is a
 * record a code - its advance, its box against the pen and where its
 * coverage starts - and the coverage of the glyphs drawn so far after them;
 * a glyph drawn for the first time is a page put again with it added. A page
 * is read in place (`glyph`'s `read`), never copied out, and one the cache
 * let go of for room is drawn again glyph by glyph as it is asked for: the
 * canvas draws the same coverage for the same name, which is why a name is
 * the request's fields and, for a family a program added a face to, that
 * face's bytes, so two processes of a run share the glyphs of one face.
 * A page the cache has no room for is read from where it was built for the
 * call that drew it and drawn again at the next, as one it let go of is.
 */

import { FACES, FF_MODERN, FF_ROMAN, windowsMetrics } from '../../win32/gdi32/faces.js';
import { fnv1a } from '../../../system/hash.js';

/**
 * The LOGFONT fields the engine reads. The rest -- escapement, the
 * precisions -- describe a rendering nobody here can do differently.
 *
 * @typedef {Object} FontRequest
 * @property {number} height     Negative: the character height; positive:
 *                               the cell height; zero: a default.
 * @property {number} weight     0 for normal.
 * @property {number} italic
 * @property {number} underline
 * @property {number} strikeOut
 * @property {string} faceName
 * @property {number} [quality]  NONANTIALIASED_QUALITY asks for glyphs with
 *                               no partly covered pixel; any other value is
 *                               drawn smoothed, as the user setting that
 *                               DEFAULT_QUALITY defers to would have it.
 */

/** lfQuality: "Font is never antialiased." */
export const NONANTIALIASED_QUALITY = 3;

/**
 * @typedef {Object} FontMetrics
 * @property {number} height            The cell: ascent plus descent.
 * @property {number} ascent
 * @property {number} descent
 * @property {number} internalLeading   The cell less the character height.
 * @property {number} externalLeading
 * @property {number} aveCharWidth
 * @property {number} maxCharWidth
 */

/**
 * One character's coverage, positioned against the pen: the bitmap's origin
 * is `left` right of the pen and `top` below the top of the cell, and the
 * pen moves on by `advance`. Read in place: its `width * height` bytes of
 * coverage, row by row and 255 for fully inked, lie in `bytes` from
 * `offset`, memory of the run's cache that is the reader's only inside the
 * read it is handed to, and the object itself is the engine's, filled again
 * for the next read.
 *
 * @typedef {Object} Glyph
 * @property {number} advance
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} bytes
 * @property {number} offset
 */

/**
 * A glyph read in place: `read` is handed the glyph and the caller's `arg`,
 * and what it answers is the call's answer; null when the engine is
 * unavailable. A reader that needs a glyph past the read takes what it needs
 * of it there.
 *
 * @typedef {<T, A>(code: number, font: FontRequest | null,
 *     read: (glyph: Glyph, arg: A) => T, arg?: A) => T | null} GlyphReader
 */

/**
 * @typedef {Object} FontEngine
 * @property {boolean} available   False when there is no canvas to rasterise on.
 * @property {(font: FontRequest | null) => FontMetrics | null} metrics
 * @property {GlyphReader} glyph
 *           `code` is a byte of the program's text.
 * @property {() => { drawn: number, pagesPut: number, pagesRefused: number }} [figures]
 *           Glyphs drawn, pages put into the cache, and pages it had no room for.
 * @property {(family: string, bytes: Uint8Array) => Promise<boolean>} addFace
 *           A program's own font, drawn under its family name from then on;
 *           false where the platform cannot take a font.
 */

/**
 * The measurements the engine takes from a 2D context.
 *
 * @typedef {Object} MeasuredText
 * @property {number} width
 * @property {number} actualBoundingBoxLeft
 * @property {number} actualBoundingBoxRight
 * @property {number} actualBoundingBoxAscent
 * @property {number} actualBoundingBoxDescent
 * @property {number} fontBoundingBoxAscent
 * @property {number} fontBoundingBoxDescent
 */

/**
 * What the engine uses of a 2D context, so a test can stand one in.
 *
 * @typedef {Object} Context2D
 * @property {string} font
 * @property {string} textBaseline
 * @property {string | CanvasGradient | CanvasPattern} fillStyle
 * @property {(text: string) => MeasuredText} measureText
 * @property {(x: number, y: number, width: number, height: number) => void} clearRect
 * @property {(x: number, y: number, width: number, height: number) => void} fillRect
 * @property {(text: string, x: number, y: number) => void} fillText
 * @property {(a: number, b: number, c: number, d: number, e: number, f: number) => void}
 *           [setTransform]
 * @property {(x: number, y: number, width: number, height: number) => { data: Uint8ClampedArray }}
 *           getImageData
 */

/**
 * @typedef {Object} Canvas2D
 * @property {number} width
 * @property {number} height
 * @property {(kind: '2d', options?: { willReadFrequently?: boolean }) => Context2D | null}
 *           getContext
 */

/**
 * The classic Windows faces -- the ones gdi32 offers a program -- and which
 * generic family stands in when the browser has no face of that name. The
 * named family goes first in the stack, so a machine that does have it uses it.
 *
 * @type {Record<string, string>}
 */
const GENERIC_FAMILIES = Object.fromEntries(FACES.map(face=>[face.name.toLowerCase(),
    face.family === FF_ROMAN ? 'serif' : face.family === FF_MODERN ? 'monospace' : 'sans-serif']));

/** FW_NORMAL, which a LOGFONT weight of zero means. */
const FW_NORMAL = 400;

/**
 * The character height a LOGFONT of height zero gets. Chosen to match what
 * the bookkeeping half estimates for the same request, so the two agree in
 * the one case the program left open.
 */
const DEFAULT_EM_HEIGHT = 13;

/** The size a face is measured at to learn how tall its cell is per pixel of em. */
const PROBE_EM = 100;

/** Codes a page of glyphs holds: a run of them, so a line of text reads a few pages. */
export const PAGE_CODES = 32;

/**
 * Bytes of a code's record at the head of its page: advance, left and top
 * (signed), width and height, whether it was drawn, two of each; where its
 * coverage starts, four.
 */
const RECORD = 16;

/** Bytes before a page's coverage: its records. */
const PAGE_HEAD = PAGE_CODES * RECORD;

/**
 * The faces programs added in this realm (AddFontMemResourceEx), by family
 * in lower case, to a name of their bytes: the realm's font set is what the
 * canvas draws with, so it is the realm's, not one engine's.
 *
 * @type {Map<string, string>}
 */
const addedFaces = new Map();

/** @param {Uint8Array} bytes @param {number} at */
const int16At = (bytes, at)=>((bytes[at] | bytes[at + 1] << 8) << 16) >> 16;
/** @param {Uint8Array} bytes @param {number} at */
const uint32At = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
    | bytes[at + 3] << 24) >>> 0;
/** @param {Uint8Array} bytes @param {number} at @param {number} value */
const put16 = (bytes, at, value)=>{
    bytes[at] = value & 0xff;
    bytes[at + 1] = (value >> 8) & 0xff;
};
/** @param {Uint8Array} bytes @param {number} at @param {number} value */
const put32 = (bytes, at, value)=>{
    put16(bytes, at, value & 0xffff);
    put16(bytes, at + 2, value >>> 16);
};

/** A glyph bitmap never needs a canvas bigger than this; one is kept and reused. */
const SCRATCH_SIZE = 256;

/** What a LOGFONT nobody filled in asks for. */
const DEFAULT_FONT = Object.freeze({
    height: 0, weight: 0, italic: 0, underline: 0, strikeOut: 0, faceName: '',
});

/**
 * The program's bytes are in its ANSI code page, and 1252 is the one drawn.
 * It is Latin-1 everywhere but 0x80..0x9f, where Latin-1 has controls and
 * 1252 has these; the five it leaves undefined are the controls.
 */
const ANSI_HIGH = '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039'
    + '\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122'
    + '\u0161\u203a\u0153\u009d\u017e\u0178';

/** @param {number} code  A byte of the program's text, or a wider code as is. */
const characterOf = code=>(code >= 0x80 && code < 0xa0 ? ANSI_HIGH[code - 0x80]
    : String.fromCharCode(code));

/**
 * The CSS family stack for a face name.
 *
 * @param {string} face
 * @returns {string}
 */
export function familyOf(face){
    const generic = GENERIC_FAMILIES[face.toLowerCase()] ?? 'sans-serif';
    return face === '' ? generic : `"${face.replace(/["\\]/g, '')}", ${generic}`;
}

/**
 * @param {FontRequest} font
 * @param {number} em   The character height in pixels.
 * @returns {string} a CSS font shorthand
 */
function cssFont(font, em){
    const weight = font.weight || FW_NORMAL;
    return `${font.italic ? 'italic ' : ''}${weight} ${em}px ${familyOf(font.faceName)}`;
}

/**
 * A face as the engine measured it: its CSS, em and metrics, and the names
 * of its pages in the run's cache, each made the first time it is read.
 *
 * @typedef {{ css: string, em: number, metrics: FontMetrics, name: string,
 *     pages: string[] }} Face
 */

/**
 * @param {{ canvas?: (width: number, height: number) => Canvas2D,
 *     space: import('../../cache/module.js').CacheSpace,
 *     scratch: import('../../cache/scratch.js').Scratch }} options
 *        `canvas`: where a canvas comes from; the platform's `OffscreenCanvas`
 *        when not given, and no engine at all when there is none. `space`:
 *        names of the run's cache the glyphs' pages are kept under. `scratch`:
 *        where a page is built on its way into the cache, kept between glyphs.
 * @returns {FontEngine}
 */
export function createFontEngine(options){
    const Offscreen = /** @type {(new (w: number, h: number) => Canvas2D) | undefined} */ (
        /** @type {Record<string, unknown>} */ (globalThis).OffscreenCanvas);
    const makeCanvas = options.canvas
        ?? (Offscreen ? (/** @type {number} */ w, /** @type {number} */ h)=>new Offscreen(w, h) : null);
    const context = makeCanvas
        ? makeCanvas(SCRATCH_SIZE, SCRATCH_SIZE).getContext('2d', { willReadFrequently: true })
        : null;
    if (!context)
    {
        return { available: false, metrics: ()=>null, glyph: ()=>null, addFace: async()=>false };
    }
    const ctx = context;
    ctx.textBaseline = 'alphabetic';

    /**
     * A font's CSS and measurements, once per distinct request.
     *
     * @type {Map<string, Face>}
     */
    const faces = new Map();
    /**
     * Each request object already measured, to its face: a font a program
     * selected is one object for as long as it lives, so measuring and
     * drawing with it again make no key string a character.
     *
     * @type {WeakMap<FontRequest, Face>}
     */
    let facesOf = new WeakMap();
    const { space, scratch: building } = options;
    const counts = { drawn: 0, pagesPut: 0, pagesRefused: 0 };

    // ponytail: lfWidth is not honoured -- a face is drawn at its own
    // proportions; stretch the canvas horizontally if a program depends on it.
    /** @param {FontRequest} font */
    const keyOf = font=>[font.faceName, font.height | 0, font.weight | 0, font.italic ? 1 : 0,
        font.underline ? 1 : 0, font.strikeOut ? 1 : 0,
        font.quality === NONANTIALIASED_QUALITY ? 1 : 0].join('|');

    /**
     * @param {FontRequest} font
     * @returns {Face}
     */
    const faceOf = font=>{
        const seen = facesOf.get(font);
        if (seen)
        {
            return seen;
        }
        const key = keyOf(font);
        let face = faces.get(key);
        if (face)
        {
            facesOf.set(font, face);
            return face;
        }
        const requested = font.height | 0;
        let em = requested < 0 ? -requested : DEFAULT_EM_HEIGHT;
        if (requested > 0)
        {
            // A positive height is the cell, and GDI picks the largest face
            // whose cell fits it: the cell grows in proportion to the em, so
            // one probe says how much em a pixel of cell buys.
            ctx.font = cssFont(font, PROBE_EM);
            const probe = ctx.measureText('M');
            const cellPerEm = (probe.fontBoundingBoxAscent + probe.fontBoundingBoxDescent)
                / PROBE_EM;
            em = Math.max(1, Math.floor(requested / cellPerEm));
        }
        const css = cssFont(font, em);
        ctx.font = css;
        const box = ctx.measureText('M');
        const ascent = Math.ceil(box.fontBoundingBoxAscent);
        const descent = Math.ceil(box.fontBoundingBoxDescent);
        let maxCharWidth = 0;
        for (let code = 0x20; code < 0x7f; code++)
        {
            maxCharWidth = Math.max(maxCharWidth,
                Math.round(ctx.measureText(String.fromCharCode(code)).width));
        }
        // A dialog face's cell is Windows', whatever face the browser draws
        // it with: the glyphs stand on Windows' baseline in Windows' cell.
        const known = windowsMetrics(font);
        const added = addedFaces.get(font.faceName.toLowerCase());
        face = {
            css,
            em,
            name: added === undefined ? key : `${key}|${added}`,
            pages: [],
            metrics: {
                height: ascent + descent,
                ascent,
                descent,
                internalLeading: Math.max(0, ascent + descent - em),
                externalLeading: 0,
                aveCharWidth: Math.max(1,
                    Math.round(ctx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26)),
                maxCharWidth,
                ...known ? { height: known.height, ascent: known.ascent, descent: known.descent,
                    internalLeading: known.internalLeading, aveCharWidth: known.aveCharWidth } : {},
            },
        };
        faces.set(key, face);
        facesOf.set(font, face);
        return face;
    };

    /**
     * Draws `code` and builds its page anew with it added: what the page held
     * (`from`, read in place, or none) and the glyph's coverage after it, in
     * the scratch the engine builds pages in. Answers the page built, valid
     * until the next is.
     *
     * @param {number} code @param {FontRequest} font @param {Face} face
     * @param {Uint8Array | null} from
     * @returns {Uint8Array}
     */
    const drawInto = (code, font, face, from)=>{
        const text = characterOf(code);
        ctx.font = face.css;
        const box = ctx.measureText(text);
        // A face whose Windows advances are known advances by them, and its
        // stand-in's glyph is drawn narrowed or widened to the same width: a
        // line laid out here breaks where Windows broke it.
        const windows = code >= 0x20 && code <= 0xff
            ? windowsMetrics(font)?.advances[code - 0x20] : undefined;
        const advance = windows ?? Math.round(box.width);
        const scale = windows !== undefined && box.width > 0 ? windows / box.width : 1;
        // A line under or through the glyph spans the advance, which an
        // italic or a narrow glyph's own box need not; the box grows to it.
        const ruled = font.underline || font.strikeOut;
        const stroke = Math.max(1, Math.round(face.em / 14));
        const left = Math.min(ruled ? 0 : Infinity,
            -Math.ceil(box.actualBoundingBoxLeft * scale));
        const right = Math.max(ruled ? advance : -Infinity,
            Math.ceil(box.actualBoundingBoxRight * scale));
        const up = Math.max(ruled ? Math.ceil(face.em / 2) : 0,
            Math.ceil(box.actualBoundingBoxAscent));
        const down = Math.max(ruled ? 1 + stroke : 0, Math.ceil(box.actualBoundingBoxDescent));
        const width = Math.min(SCRATCH_SIZE, Math.max(0, right - left));
        const height = Math.min(SCRATCH_SIZE, Math.max(0, up + down));
        const offset = from ? from.length : PAGE_HEAD;
        const page = building.bytes(offset + width * height);
        if (from)
        {
            page.set(from);
        }
        else
        {
            page.fill(0, 0, PAGE_HEAD);
        }
        if (width > 0 && height > 0)
        {
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = '#ffffff';
            if (scale !== 1 && ctx.setTransform)
            {
                ctx.setTransform(scale, 0, 0, 1, -left, up);
                ctx.fillText(text, 0, 0);
                ctx.setTransform(1, 0, 0, 1, 0, 0);
            }
            else
            {
                ctx.fillText(text, -left, up);
            }
            if (font.underline)
            {
                ctx.fillRect(-left, up + 1, advance, stroke);
            }
            if (font.strikeOut)
            {
                ctx.fillRect(-left, up - Math.ceil(face.em / 3), advance, stroke);
            }
            const pixels = ctx.getImageData(0, 0, width, height).data;
            // The canvas always smooths; a font that must not be smoothed
            // keeps a pixel that is at least half covered and drops the rest.
            const aliased = font.quality === NONANTIALIASED_QUALITY;
            for (let index = 0; index < width * height; index++)
            {
                const alpha = pixels[index * 4 + 3];
                page[offset + index] = aliased ? (alpha >= 128 ? 255 : 0) : alpha;
            }
        }
        const at = (code % PAGE_CODES) * RECORD;
        put16(page, at, advance);
        put16(page, at + 2, left | 0);
        put16(page, at + 4, face.metrics.ascent - up);
        put16(page, at + 6, width);
        put16(page, at + 8, height);
        put16(page, at + 10, 1);
        put32(page, at + 12, offset);
        counts.drawn++;
        return page;
    };

    // What the read in flight asks for, and whether its page had it: a page
    // is read through one function made once, so a glyph read makes nothing.
    let wantCode = 0;
    /** @type {(glyph: Glyph, arg: any) => any} */
    let wantRead = ()=>undefined;
    /** @type {any} */
    let wantArg;
    let found = false;
    /** @type {FontRequest} */
    let drawFont = DEFAULT_FONT;
    /** @type {Face | null} */
    let drawFace = null;
    /** One glyph object a depth of reads in one another, filled for each. @type {Glyph[]} */
    const views = [];
    let depth = 0;
    const EMPTY = new Uint8Array(0);

    /** @param {Uint8Array} page */
    const readPage = page=>{
        const at = (wantCode % PAGE_CODES) * RECORD;
        if (page[at + 10] === 0)
        {
            return undefined;
        }
        found = true;
        const view = views[depth] ??= { advance: 0, left: 0, top: 0, width: 0, height: 0,
            bytes: EMPTY, offset: 0 };
        view.advance = int16At(page, at);
        view.left = int16At(page, at + 2);
        view.top = int16At(page, at + 4);
        view.width = int16At(page, at + 6) & 0xffff;
        view.height = int16At(page, at + 8) & 0xffff;
        view.bytes = page;
        view.offset = uint32At(page, at + 12);
        try
        {
            return wantRead(view, wantArg);
        }
        finally
        {
            view.bytes = EMPTY;
        }
    };
    /**
     * A page the cache holds, lacking the code asked: built anew from where
     * it lies, into the engine's own scratch.
     *
     * @param {Uint8Array} page
     */
    const growPage = page=>drawInto(wantCode, drawFont, /** @type {Face} */ (drawFace), page);

    const scope = /** @type {any} */ (globalThis);
    return {
        available: true,
        async addFace(family, bytes){
            if (typeof scope.FontFace !== 'function' || !scope.fonts)
            {
                return false;
            }
            const face = new scope.FontFace(family, bytes);
            await face.load();
            scope.fonts.add(face);
            // What was measured and drawn of that name was a stand-in's: its
            // pages are named by this face's bytes from now on.
            addedFaces.set(family.toLowerCase(), `${fnv1a(bytes).toString(16)}.${bytes.length}`);
            faces.clear();
            facesOf = new WeakMap();
            return true;
        },
        metrics: font=>faceOf(font ?? DEFAULT_FONT).metrics,
        glyph(code, font, read, arg){
            const request = font ?? DEFAULT_FONT;
            const face = faceOf(request);
            const index = Math.floor(code / PAGE_CODES);
            const name = face.pages[index] ??= `${face.name}|${index}`;
            // A read inside a read is a read of its own: what the outer one
            // asked for is put back once this one is done.
            const outerCode = wantCode;
            const outerRead = wantRead;
            const outerArg = wantArg;
            const outerFound = found;
            wantCode = code;
            wantRead = read;
            wantArg = arg;
            found = false;
            depth++;
            try
            {
                const value = space.with(name, readPage);
                if (found)
                {
                    return value;
                }
                // Not drawn yet: the page built again with it, from what it
                // held where it lies.
                drawFont = request;
                drawFace = face;
                const page = space.with(name, growPage) ?? drawInto(code, request, face, null);
                drawFace = null;
                if (!space.put(name, page))
                {
                    counts.pagesRefused++;
                    return readPage(page);
                }
                counts.pagesPut++;
                // Read where it is kept now, as every later read reads it.
                return space.with(name, readPage);
            }
            finally
            {
                depth--;
                wantCode = outerCode;
                wantRead = outerRead;
                wantArg = outerArg;
                found = outerFound;
            }
        },
        figures: ()=>({ ...counts }),
    };
}
