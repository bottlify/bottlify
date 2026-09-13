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
 * A glyph is rasterised once per font and cached; a run of text is the sum
 * of its glyphs at integer advances, which is how GDI positions a string
 * too, and why a string's extent is the sum of the advances rather than the
 * canvas's own fractional width.
 */

/**
 * The LOGFONT fields the engine reads. The rest -- escapement, quality,
 * the precisions -- describe a rendering nobody here can do differently.
 *
 * @typedef {Object} FontRequest
 * @property {number} height     Negative: the character height; positive:
 *                               the cell height; zero: a default.
 * @property {number} weight     0 for normal.
 * @property {number} italic
 * @property {number} underline
 * @property {number} strikeOut
 * @property {string} faceName
 */

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
 * pen moves on by `advance`.
 *
 * @typedef {Object} Glyph
 * @property {number} advance
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} coverage   `width * height` bytes, 255 for fully inked.
 */

/**
 * @typedef {Object} FontEngine
 * @property {boolean} available   False when there is no canvas to rasterise on.
 * @property {(font: FontRequest | null) => FontMetrics | null} metrics
 * @property {(code: number, font: FontRequest | null) => Glyph | null} glyph
 *           `code` is a byte of the program's text; null when unavailable.
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
 * The classic Windows faces, and which generic family stands in when the
 * browser has no face of that name. The named family goes first in the
 * stack, so a machine that does have it uses it.
 *
 * @type {Record<string, string>}
 */
const GENERIC_FAMILIES = {
    'ms sans serif': 'sans-serif',
    'microsoft sans serif': 'sans-serif',
    'ms shell dlg': 'sans-serif',
    'ms shell dlg 2': 'sans-serif',
    tahoma: 'sans-serif',
    arial: 'sans-serif',
    helv: 'sans-serif',
    verdana: 'sans-serif',
    system: 'sans-serif',
    'segoe ui': 'sans-serif',
    'times new roman': 'serif',
    'ms serif': 'serif',
    georgia: 'serif',
    'courier new': 'monospace',
    courier: 'monospace',
    fixedsys: 'monospace',
    terminal: 'monospace',
    'lucida console': 'monospace',
};

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

/** Glyphs kept before the cache is emptied wholesale. */
const CACHE_LIMIT = 4096;

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
 * @param {{ canvas?: (width: number, height: number) => Canvas2D }} [options]
 *        Where a canvas comes from; the platform's `OffscreenCanvas` when not
 *        given, and no engine at all when there is none.
 * @returns {FontEngine}
 */
export function createFontEngine(options = {}){
    const Offscreen = /** @type {(new (w: number, h: number) => Canvas2D) | undefined} */ (
        /** @type {Record<string, unknown>} */ (globalThis).OffscreenCanvas);
    const makeCanvas = options.canvas
        ?? (Offscreen ? (/** @type {number} */ w, /** @type {number} */ h)=>new Offscreen(w, h) : null);
    const context = makeCanvas
        ? makeCanvas(SCRATCH_SIZE, SCRATCH_SIZE).getContext('2d', { willReadFrequently: true })
        : null;
    if (!context)
    {
        return { available: false, metrics: ()=>null, glyph: ()=>null };
    }
    const ctx = context;
    ctx.textBaseline = 'alphabetic';

    /**
     * A font's CSS and measurements, once per distinct request.
     *
     * @type {Map<string, { css: string, em: number, metrics: FontMetrics }>}
     */
    const faces = new Map();
    /** @type {Map<string, Glyph>} */
    const glyphs = new Map();

    // ponytail: lfWidth is not honoured -- a face is drawn at its own
    // proportions; stretch the canvas horizontally if a program depends on it.
    /** @param {FontRequest} font */
    const keyOf = font=>[font.faceName, font.height | 0, font.weight | 0, font.italic ? 1 : 0,
        font.underline ? 1 : 0, font.strikeOut ? 1 : 0].join('|');

    /**
     * @param {FontRequest} font
     * @returns {{ css: string, em: number, metrics: FontMetrics }}
     */
    const faceOf = font=>{
        const key = keyOf(font);
        let face = faces.get(key);
        if (face)
        {
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
        face = {
            css,
            em,
            metrics: {
                height: ascent + descent,
                ascent,
                descent,
                internalLeading: Math.max(0, ascent + descent - em),
                externalLeading: 0,
                aveCharWidth: Math.max(1,
                    Math.round(ctx.measureText('abcdefghijklmnopqrstuvwxyz').width / 26)),
                maxCharWidth,
            },
        };
        faces.set(key, face);
        return face;
    };

    /**
     * @param {number} code
     * @param {FontRequest} font
     * @returns {Glyph}
     */
    const rasterise = (code, font)=>{
        const face = faceOf(font);
        const text = characterOf(code);
        ctx.font = face.css;
        const box = ctx.measureText(text);
        const advance = Math.round(box.width);
        // A line under or through the glyph spans the advance, which an
        // italic or a narrow glyph's own box need not; the box grows to it.
        const ruled = font.underline || font.strikeOut;
        const stroke = Math.max(1, Math.round(face.em / 14));
        const left = Math.min(ruled ? 0 : Infinity, -Math.ceil(box.actualBoundingBoxLeft));
        const right = Math.max(ruled ? advance : -Infinity, Math.ceil(box.actualBoundingBoxRight));
        const up = Math.max(ruled ? Math.ceil(face.em / 2) : 0,
            Math.ceil(box.actualBoundingBoxAscent));
        const down = Math.max(ruled ? 1 + stroke : 0, Math.ceil(box.actualBoundingBoxDescent));
        const width = Math.min(SCRATCH_SIZE, Math.max(0, right - left));
        const height = Math.min(SCRATCH_SIZE, Math.max(0, up + down));
        const coverage = new Uint8Array(width * height);
        if (width > 0 && height > 0)
        {
            ctx.clearRect(0, 0, width, height);
            ctx.fillStyle = '#ffffff';
            ctx.fillText(text, -left, up);
            if (font.underline)
            {
                ctx.fillRect(-left, up + 1, advance, stroke);
            }
            if (font.strikeOut)
            {
                ctx.fillRect(-left, up - Math.ceil(face.em / 3), advance, stroke);
            }
            const pixels = ctx.getImageData(0, 0, width, height).data;
            for (let index = 0; index < coverage.length; index++)
            {
                coverage[index] = pixels[index * 4 + 3];
            }
        }
        return { advance, left: left | 0, top: face.metrics.ascent - up, width, height, coverage };
    };

    return {
        available: true,
        metrics: font=>faceOf(font ?? DEFAULT_FONT).metrics,
        glyph(code, font){
            const request = font ?? DEFAULT_FONT;
            const key = `${keyOf(request)}|${code}`;
            let glyph = glyphs.get(key);
            if (!glyph)
            {
                // ponytail: emptied wholesale at the limit rather than kept
                // least-recently-used; a program's dialogs use a few faces.
                if (glyphs.size >= CACHE_LIMIT)
                {
                    glyphs.clear();
                }
                glyph = rasterise(code, request);
                glyphs.set(key, glyph);
            }
            return glyph;
        },
    };
}
