/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectWrite's text analyzer and glyph run analysis.
 *
 * The analyzer reads the program's text through its IDWriteTextAnalysisSource
 * and answers through its IDWriteTextAnalysisSink: scripts, bidi levels, line
 * breaks and number substitution (`text.js`), then glyphs and their
 * placements. Shaping is a glyph a character, mirrored in right to left runs:
 * no ligatures, no reordering, no OpenType features (decision A239).
 *
 * A glyph run analysis is a run's coverage: its bounds from the glyphs'
 * boxes, its texture drawn from the font engine's glyphs (the browser's, as
 * GDI's text is), sampled through the run's transform. A face a program
 * loaded from a file has no rasteriser here, so its texture is empty and
 * that is said.
 */

import { createComObject } from '../ole32/objects.js';
import {
    JUSTIFY, SCRIPT, bidiLevels, codePoints, itemize, justification, lineBreakpoints, mirrored,
} from './text.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const DWRITE_E_UNSUPPORTEDOPERATION = 0x88985009 | 0;

const IID_TEXT_ANALYZER = '{B7E6163E-7F46-43B4-84B3-E4E6249C365D}';
const IID_GLYPH_RUN_ANALYSIS = '{7D97DBF7-E085-42D4-81E3-6A883BDED118}';

/** DWRITE_RENDERING_MODE. */
export const RENDERING = Object.freeze({ DEFAULT: 0, ALIASED: 1, GDI_CLASSIC: 2,
    GDI_NATURAL: 3, NATURAL: 4, NATURAL_SYMMETRIC: 5, OUTLINE: 6 });
/** DWRITE_TEXTURE_TYPE. */
export const TEXTURE = Object.freeze({ ALIASED_1x1: 0, CLEARTYPE_3x1: 1 });
/**
 * The gamma GDI's text is blended with: SPI_GETFONTSMOOTHINGCONTRAST over a
 * thousand, Windows' default 1400.
 */
export const GDI_GAMMA = 1.4;


/** Characters that take no room: zero-width spaces and joiners. @param {number} code */
const isZeroWidth = code=>code === 0x200b || code === 0x200c || code === 0x200d
    || code === 0x2060 || code === 0xfeff;

/**
 * @typedef {Object} AnalysisHost
 * @property {import('./host.js').DwriteHost} host
 * @property {(thread: any, object: number, slot: number, rest: number[]) => Promise<number>} method
 * @property {(at: number) => number} u32
 * @property {(at: number, values: number[]) => void} putU32s
 * @property {(at: number, count: number) => number[]} readU16s
 * @property {(bytes: number) => number} scratch
 * @property {(api: string, detail: string, kind?: 'loss') => void} say
 * @property {(bits: number) => number} f32
 * @property {(value: number) => number} bitsOf
 * @property {(pointer: number) => import('./fonts.js').Face | null} faceAt
 * @property {(face: import('./fonts.js').Face, glyph: number) => { advanceWidth: number,
 *     leftSideBearing: number, rightSideBearing: number, topSideBearing: number,
 *     advanceHeight: number, bottomSideBearing: number, verticalOriginY: number }}
 *     designMetrics
 */

/**
 * @param {AnalysisHost} a
 */
export function createAnalysis(a){
    const { host, method, u32, putU32s, readU16s, scratch, say, f32, bitsOf, faceAt } = a;

    /** UTF-16 text in guest memory. @param {number} at @param {number} length */
    const textAt = (at, length)=>String.fromCharCode(...readU16s(at, length));

    /**
     * The source's text from `position` for `length` units, as far as the
     * source has it.
     *
     * @param {any} thread @param {number} source @param {number} position @param {number} length
     */
    const sourceText = async(thread, source, position, length)=>{
        const cell = scratch(8);
        let text = '';
        try
        {
            while (text.length < length)
            {
                // IDWriteTextAnalysisSource::GetTextAtPosition(position, &text, &length).
                const hr = await method(thread, source, 3, [position + text.length, cell,
                    cell + 4]);
                const got = Math.min(u32(cell + 4), length - text.length);
                if (hr !== 0 || got === 0 || u32(cell) === 0)
                {
                    break;
                }
                text += textAt(u32(cell), got);
            }
        }
        finally
        {
            host.heap.free(cell);
        }
        return text;
    };

    /** @param {number} source @param {number} sink */
    const checked = (source, sink)=>(source >>> 0) !== 0 && (sink >>> 0) !== 0;

    const analyzer = createComObject(IID_TEXT_ANALYZER, { owned: true, state: null,
        interfaces: [{ id: IID_TEXT_ANALYZER, methods: [
            /** HRESULT AnalyzeScript(source*, UINT32 position, UINT32 length, sink*) */
            { name: 'AnalyzeScript', argBytes: 20, invoke: async(_o, args)=>{
                const [source, position, length, sink] = args;
                if (!checked(source, sink))
                {
                    return E_INVALIDARG;
                }
                const thread = host.currentThread();
                const text = await sourceText(thread, source, position >>> 0, length >>> 0);
                const cell = scratch(8);
                try
                {
                    for (const run of itemize(text))
                    {
                        putU32s(cell, [run.script, run.shapes]);
                        // IDWriteTextAnalysisSink::SetScriptAnalysis(position, length, &sa).
                        const hr = await method(thread, sink, 3, [(position >>> 0) + run.at,
                            run.length, cell]);
                        if (hr !== 0)
                        {
                            return hr | 0;
                        }
                    }
                }
                finally
                {
                    host.heap.free(cell);
                }
                return S_OK;
            } },
            /** HRESULT AnalyzeBidi(source*, UINT32 position, UINT32 length, sink*) */
            { name: 'AnalyzeBidi', argBytes: 20, invoke: async(_o, args)=>{
                const [source, position, length, sink] = args;
                if (!checked(source, sink))
                {
                    return E_INVALIDARG;
                }
                const thread = host.currentThread();
                const text = await sourceText(thread, source, position >>> 0, length >>> 0);
                // IDWriteTextAnalysisSource::GetParagraphReadingDirection().
                const base = (await method(thread, source, 5, [])) === 1 ? 1 : 0;
                const { explicit, resolved } = bidiLevels(text, base);
                for (let at = 0; at < resolved.length;)
                {
                    let end = at + 1;
                    while (end < resolved.length && resolved[end] === resolved[at]
                        && explicit[end] === explicit[at])
                    {
                        end++;
                    }
                    // IDWriteTextAnalysisSink::SetBidiLevel(position, length, explicit, resolved).
                    const hr = await method(thread, sink, 5, [(position >>> 0) + at, end - at,
                        explicit[at], resolved[at]]);
                    if (hr !== 0)
                    {
                        return hr | 0;
                    }
                    at = end;
                }
                return S_OK;
            } },
            /** HRESULT AnalyzeNumberSubstitution(source*, UINT32 position, UINT32 length, sink*) */
            { name: 'AnalyzeNumberSubstitution', argBytes: 20, invoke: async(_o, args)=>{
                const [source, position, length, sink] = args;
                if (!checked(source, sink))
                {
                    return E_INVALIDARG;
                }
                const thread = host.currentThread();
                const cell = scratch(8);
                try
                {
                    for (let at = 0; at < (length >>> 0);)
                    {
                        // GetNumberSubstitution(position, &length, &substitution).
                        let hr = await method(thread, source, 7, [(position >>> 0) + at, cell,
                            cell + 4]);
                        const span = Math.min(u32(cell), (length >>> 0) - at);
                        if (hr !== 0 || span === 0)
                        {
                            break;
                        }
                        if (u32(cell + 4) !== 0)
                        {
                            // SetNumberSubstitution(position, length, substitution).
                            hr = await method(thread, sink, 6, [(position >>> 0) + at, span,
                                u32(cell + 4)]);
                            if (hr !== 0)
                            {
                                return hr | 0;
                            }
                        }
                        at += span;
                    }
                }
                finally
                {
                    host.heap.free(cell);
                }
                return S_OK;
            } },
            /** HRESULT AnalyzeLineBreakpoints(source*, UINT32 position, UINT32 length, sink*) */
            { name: 'AnalyzeLineBreakpoints', argBytes: 20, invoke: async(_o, args)=>{
                const [source, position, length, sink] = args;
                if (!checked(source, sink))
                {
                    return E_INVALIDARG;
                }
                const thread = host.currentThread();
                const text = await sourceText(thread, source, position >>> 0, length >>> 0);
                if (!text.length)
                {
                    return S_OK;
                }
                const breaks = lineBreakpoints(text);
                const at = scratch(breaks.length);
                try
                {
                    host.writeMemory(at, breaks);
                    // IDWriteTextAnalysisSink::SetLineBreakpoints(position, length, breakpoints).
                    const hr = await method(thread, sink, 4, [position >>> 0, breaks.length, at]);
                    return hr === 0 ? S_OK : hr | 0;
                }
                finally
                {
                    host.heap.free(at);
                }
            } },
            /**
             * HRESULT GetGlyphs(WCHAR const *text, UINT32 length, IDWriteFontFace*,
             *     BOOL isSideways, BOOL isRtl, DWRITE_SCRIPT_ANALYSIS const*, WCHAR const
             *     *locale, IDWriteNumberSubstitution*, features**, UINT32 const *featureLengths,
             *     UINT32 featureRanges, UINT32 maxGlyphs, UINT16 *clusterMap,
             *     DWRITE_SHAPING_TEXT_PROPERTIES*, UINT16 *glyphs,
             *     DWRITE_SHAPING_GLYPH_PROPERTIES*, UINT32 *glyphCount)
             */
            { name: 'GetGlyphs', argBytes: 72, invoke: (_o, args)=>getGlyphs(args) },
            /**
             * HRESULT GetGlyphPlacements(text, clusterMap, textProperties, UINT32 length,
             *     glyphs, glyphProperties, UINT32 glyphCount, IDWriteFontFace*, FLOAT emSize,
             *     BOOL isSideways, BOOL isRtl, DWRITE_SCRIPT_ANALYSIS const*, locale,
             *     features**, featureLengths, UINT32 featureRanges, FLOAT *advances,
             *     DWRITE_GLYPH_OFFSET *offsets)
             */
            { name: 'GetGlyphPlacements', argBytes: 76, invoke: (_o, args)=>placements(
                args[6], args[4], args[5], args[7], f32(args[8]), args[15], args[16],
                args[17], null) },
            /**
             * HRESULT GetGdiCompatibleGlyphPlacements(text, clusterMap, textProperties,
             *     UINT32 length, glyphs, glyphProperties, UINT32 glyphCount, face, FLOAT emSize,
             *     FLOAT pixelsPerDip, DWRITE_MATRIX const*, BOOL useGdiNatural, isSideways,
             *     isRtl, analysis*, locale, features**, featureLengths, featureRanges,
             *     FLOAT *advances, DWRITE_GLYPH_OFFSET *offsets)
             */
            { name: 'GetGdiCompatibleGlyphPlacements', argBytes: 88, invoke: (_o, args)=>
                placements(args[6], args[4], args[5], args[7], f32(args[8]), args[18],
                    args[19], args[20], pixelsPerEm(f32(args[8]), f32(args[9]),
                        args[10])) },
        ] }] });

    /**
     * The pixels an em takes: the size times pixels a DIP, times the
     * transform's vertical scale.
     *
     * @param {number} emSize @param {number} pixelsPerDip @param {number} transform
     */
    const pixelsPerEm = (emSize, pixelsPerDip, transform)=>{
        const m21 = (transform >>> 0) === 0 ? 0 : f32(u32(transform + 8));
        const m22 = (transform >>> 0) === 0 ? 1 : f32(u32(transform + 12));
        return emSize * pixelsPerDip * Math.hypot(m21, m22);
    };

    /** OpenType features asked for: not applied here, and said. @param {number} ranges */
    const noFeatures = ranges=>{
        if ((ranges >>> 0) !== 0)
        {
            say('IDWriteTextAnalyzer', 'typographic features are not applied (a glyph a'
                + ' character, no OpenType shaping)');
        }
    };

    /** @param {number[]} args */
    const getGlyphs = args=>{
        const [textAt_, length, facePointer, , isRtl, analysisAt, , , , , featureRanges,
            maxGlyphs, clusterMap, textProperties, glyphsOut, glyphProperties, countOut] = args;
        const n = length >>> 0;
        if ((textAt_ >>> 0) === 0 || (analysisAt >>> 0) === 0 || (clusterMap >>> 0) === 0
            || (textProperties >>> 0) === 0 || (glyphsOut >>> 0) === 0
            || (glyphProperties >>> 0) === 0 || (countOut >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const face = faceAt(facePointer);
        if (!face || n === 0)
        {
            return E_INVALIDARG;
        }
        noFeatures(featureRanges);
        const text = textAt(textAt_, n);
        const points = codePoints(text);
        putU32s(countOut, [points.length]);
        if (points.length > (maxGlyphs >>> 0))
        {
            return E_NOT_SUFFICIENT_BUFFER;
        }
        const clusters = new Uint8Array(n * 2);
        const glyphs = new Uint8Array(points.length * 2);
        const properties = new Uint8Array(points.length * 2);
        const classes = justification(points.map(point=>point.code),
            (u32(analysisAt) & 0xffff) === SCRIPT.Arab);
        points.forEach(({ code, at, units }, i)=>{
            const shown = isRtl !== 0 ? mirrored(code) : code;
            const glyph = face.cmap.lookup(shown) || face.cmap.lookup(code);
            glyphs[i * 2] = glyph & 0xff;
            glyphs[i * 2 + 1] = glyph >> 8;
            for (let k = 0; k < units; k++)
            {
                clusters[(at + k) * 2] = i & 0xff;
                clusters[(at + k) * 2 + 1] = i >> 8;
            }
            // justification 4 bits, then isClusterStart, isDiacritic, isZeroWidthSpace.
            properties[i * 2] = (classes[i] ?? JUSTIFY.NONE) | 0x10
                | (isZeroWidth(code) ? 0x40 : 0);
        });
        host.writeMemory(clusterMap >>> 0, clusters);
        host.writeMemory(textProperties >>> 0, new Uint8Array(n * 2));
        host.writeMemory(glyphsOut >>> 0, glyphs);
        host.writeMemory(glyphProperties >>> 0, properties);
        return S_OK;
    };

    /**
     * Glyphs' advances, at a size, and their offsets (none: nothing moves a
     * glyph here); advances rounded to whole pixels for GDI's placements.
     *
     * @param {number} count @param {number} glyphsAt @param {number} propertiesAt
     * @param {number} facePointer @param {number} emSize @param {number} featureRanges
     * @param {number} advancesOut @param {number} offsetsOut @param {number | null} ppem
     */
    const placements = (count, glyphsAt, propertiesAt, facePointer, emSize, featureRanges,
        advancesOut, offsetsOut, ppem)=>
    {
        const n = count >>> 0;
        const face = faceAt(facePointer);
        if (!face || (glyphsAt >>> 0) === 0 || (propertiesAt >>> 0) === 0
            || (advancesOut >>> 0) === 0 || (offsetsOut >>> 0) === 0 || ppem !== null
            && !(ppem > 0))
        {
            return E_INVALIDARG;
        }
        noFeatures(featureRanges);
        const glyphs = readU16s(glyphsAt, n);
        const properties = readU16s(propertiesAt, n);
        const units = face.metrics.designUnitsPerEm;
        const advances = new Uint8Array(n * 4);
        const view = new DataView(advances.buffer);
        glyphs.forEach((glyph, i)=>{
            let advance = 0;
            if (!(properties[i] & 0x40))
            {
                const design = a.designMetrics(face, glyph).advanceWidth;
                advance = ppem === null ? design * emSize / units
                    : Math.round(design * ppem / units) * emSize / ppem;
            }
            view.setUint32(i * 4, bitsOf(advance), true);
        });
        host.writeMemory(advancesOut >>> 0, advances);
        host.writeMemory(offsetsOut >>> 0, new Uint8Array(n * 8));
        return S_OK;
    };

    /**
     * A glyph run analysis, or the HRESULT that refuses one.
     *
     * @param {number[]} args  run*, FLOAT pixelsPerDip, DWRITE_MATRIX const*,
     *     DWRITE_RENDERING_MODE, DWRITE_MEASURING_MODE, FLOAT originX, FLOAT originY
     * @returns {import('../ole32/objects.js').ComObject | number}
     */
    const glyphRun = args=>{
        const [runAt, ppdBits, transformAt, mode, measuring, xBits, yBits] = args;
        const ppd = f32(ppdBits);
        if ((runAt >>> 0) === 0 || !(ppd > 0) || (mode >>> 0) === RENDERING.DEFAULT
            || (mode >>> 0) >= RENDERING.OUTLINE || (measuring >>> 0) > 2)
        {
            return E_INVALIDARG;
        }
        const run = host.readMemory(runAt >>> 0, 32);
        const view = new DataView(run.buffer, run.byteOffset, 32);
        const facePointer = view.getUint32(0, true);
        const faceObject = facePointer === 0 ? null : host.objectAt(facePointer);
        const face = faceAt(facePointer);
        if (!face || !faceObject)
        {
            return E_INVALIDARG;
        }
        const emSize = view.getFloat32(4, true);
        const count = view.getUint32(8, true);
        const glyphs = readU16s(view.getUint32(12, true), count);
        const advancesAt = view.getUint32(16, true);
        const offsetsAt = view.getUint32(20, true);
        const rtl = (view.getUint32(28, true) & 1) === 1;
        const matrix = (transformAt >>> 0) === 0 ? [1, 0, 0, 1, 0, 0]
            : Array.from({ length: 6 }, (_, i)=>f32(u32((transformAt >>> 0) + i * 4)));
        const units = face.metrics.designUnitsPerEm;
        const scale = emSize * ppd / units;
        // Each glyph's pen position along the baseline, in pixels before the transform.
        /** @type {{ glyph: number, x: number, y: number }[]} */
        const placed = [];
        let pen = 0;
        glyphs.forEach((glyph, i)=>{
            const advance = (advancesAt !== 0 ? f32(u32(advancesAt + i * 4)) * ppd
                : a.designMetrics(face, glyph).advanceWidth * scale);
            const dx = offsetsAt !== 0 ? f32(u32(offsetsAt + i * 8)) * ppd : 0;
            const dy = offsetsAt !== 0 ? f32(u32(offsetsAt + i * 8 + 4)) * ppd : 0;
            if (rtl)
            {
                pen -= advance;
            }
            placed.push({ glyph, x: pen + (rtl ? -dx : dx), y: -dy });
            if (!rtl)
            {
                pen += advance;
            }
        });
        const origin = { x: f32(xBits), y: f32(yBits) };
        /** A point of the run in the texture's pixels. @param {number} x @param {number} y */
        const toTexture = (x, y)=>({
            x: x * matrix[0] + y * matrix[2] + matrix[4] * ppd + origin.x,
            y: x * matrix[1] + y * matrix[3] + matrix[5] * ppd + origin.y,
        });
        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;
        for (const { glyph, x, y } of placed)
        {
            const box = inkBox(face, glyph);
            if (!box)
            {
                continue;
            }
            for (const [bx, by] of [[box.xMin, box.yMin], [box.xMin, box.yMax],
                [box.xMax, box.yMin], [box.xMax, box.yMax]])
            {
                const point = toTexture(x + bx * scale, y - by * scale);
                left = Math.min(left, point.x);
                right = Math.max(right, point.x);
                top = Math.min(top, point.y);
                bottom = Math.max(bottom, point.y);
            }
        }
        const bounds = left === Infinity ? { left: 0, top: 0, right: 0, bottom: 0 }
            : { left: Math.floor(left), top: Math.floor(top), right: Math.ceil(right),
                bottom: Math.ceil(bottom) };
        faceObject.addRef();
        return createComObject(IID_GLYPH_RUN_ANALYSIS, { interfaces: [analysisDescriptor],
            state: { face, placed, matrix, ppd, origin, scale, emSize, bounds,
                type: (mode >>> 0) === RENDERING.ALIASED ? TEXTURE.ALIASED_1x1
                    : TEXTURE.CLEARTYPE_3x1, mode: mode >>> 0 },
            destroy: ()=>faceObject.release() });
    };

    /**
     * A glyph's inked box in design units, y up, or null for one with no ink.
     *
     * @param {import('./fonts.js').Face} face @param {number} glyph
     */
    const inkBox = (face, glyph)=>(face.system ? face.system.box(glyph)
        : face.glyphs.box(glyph));

    /**
     * The run's coverage over a rectangle, a byte a pixel: each pixel's centre
     * taken back through the transform into the run and read from the glyph
     * the engine drew there.
     *
     * @param {any} state @param {{ left: number, top: number, right: number, bottom: number }} rect
     */
    const coverage = (state, rect)=>{
        const width = rect.right - rect.left;
        const height = rect.bottom - rect.top;
        const out = new Uint8Array(Math.max(0, width) * Math.max(0, height));
        if (out.length === 0)
        {
            return out;
        }
        const { face, matrix, ppd, origin, placed } = state;
        const system = face.system;
        if (!system)
        {
            say('IDWriteGlyphRunAnalysis::CreateAlphaTexture', 'a face loaded from a file is'
                + ' not drawn: there is no rasteriser for its outlines', 'loss');
            return out;
        }
        const pixels = state.emSize * ppd;
        const request = { ...system.request, height: -Math.max(1, Math.round(pixels)) };
        const metrics = host.measure.metrics(request);
        // The engine draws at whole pixel heights; the rest of the size is a scale.
        const fit = pixels / Math.max(1, Math.round(pixels));
        const det = matrix[0] * matrix[3] - matrix[1] * matrix[2];
        if (!metrics || det === 0)
        {
            say('IDWriteGlyphRunAnalysis::CreateAlphaTexture', 'no font engine to draw the'
                + ' glyphs with', 'loss');
            return out;
        }
        const drawn = placed.map((/** @type {{ glyph: number, x: number, y: number }} */
            { glyph, x, y })=>({ x, y, image: host.measure.glyph(glyph, request) }));
        for (let row = 0; row < height; row++)
        {
            for (let column = 0; column < width; column++)
            {
                // The pixel's centre, back through the transform into the run.
                const tx = rect.left + column + 0.5 - origin.x - matrix[4] * ppd;
                const ty = rect.top + row + 0.5 - origin.y - matrix[5] * ppd;
                const rx = (tx * matrix[3] - ty * matrix[2]) / det;
                const ry = (ty * matrix[0] - tx * matrix[1]) / det;
                let value = 0;
                for (const { x, y, image } of drawn)
                {
                    if (!image || image.width === 0)
                    {
                        continue;
                    }
                    const gx = Math.floor((rx - x) / fit - image.left);
                    const gy = Math.floor((ry - y) / fit + metrics.ascent - image.top);
                    if (gx >= 0 && gy >= 0 && gx < image.width && gy < image.height)
                    {
                        value = Math.max(value, image.coverage[gy * image.width + gx]);
                    }
                }
                out[row * width + column] = state.mode === RENDERING.ALIASED
                    ? (value >= 128 ? 255 : 0) : value;
            }
        }
        return out;
    };

    /** RECT. @param {number} at */
    const readRect = at=>{
        const raw = host.readMemory(at >>> 0, 16);
        const view = new DataView(raw.buffer, raw.byteOffset, 16);
        return { left: view.getInt32(0, true), top: view.getInt32(4, true),
            right: view.getInt32(8, true), bottom: view.getInt32(12, true) };
    };

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const analysisDescriptor = { id: IID_GLYPH_RUN_ANALYSIS, methods: [
        /** HRESULT GetAlphaTextureBounds(DWRITE_TEXTURE_TYPE, RECT*) */
        { name: 'GetAlphaTextureBounds', argBytes: 12, invoke: (o, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if ((type >>> 0) > TEXTURE.CLEARTYPE_3x1)
            {
                putU32s(out, [0, 0, 0, 0]);
                return E_INVALIDARG;
            }
            const b = (type >>> 0) === o.state.type ? o.state.bounds
                : { left: 0, top: 0, right: 0, bottom: 0 };
            putU32s(out, [b.left, b.top, b.right, b.bottom]);
            return S_OK;
        } },
        /** HRESULT CreateAlphaTexture(DWRITE_TEXTURE_TYPE, RECT const*, BYTE*, UINT32 size) */
        { name: 'CreateAlphaTexture', argBytes: 20, invoke: (o, [type, rectAt, buffer, size])=>{
            if ((type >>> 0) > TEXTURE.CLEARTYPE_3x1 || (rectAt >>> 0) === 0
                || (buffer >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const rect = readRect(rectAt);
            const width = Math.max(0, rect.right - rect.left);
            const height = Math.max(0, rect.bottom - rect.top);
            const bytesPerPixel = (type >>> 0) === TEXTURE.CLEARTYPE_3x1 ? 3 : 1;
            if ((size >>> 0) < width * height * bytesPerPixel)
            {
                return E_NOT_SUFFICIENT_BUFFER;
            }
            if ((type >>> 0) !== o.state.type)
            {
                return DWRITE_E_UNSUPPORTEDOPERATION;
            }
            const b = o.state.bounds;
            const inside = { left: Math.max(rect.left, b.left), top: Math.max(rect.top, b.top),
                right: Math.min(rect.right, b.right), bottom: Math.min(rect.bottom, b.bottom) };
            const out = new Uint8Array(width * height * bytesPerPixel);
            if (inside.right > inside.left && inside.bottom > inside.top)
            {
                const drawn = coverage(o.state, inside);
                const w = inside.right - inside.left;
                for (let row = 0; row < inside.bottom - inside.top; row++)
                {
                    for (let column = 0; column < w; column++)
                    {
                        const value = drawn[row * w + column];
                        const at = ((inside.top - rect.top + row) * width + inside.left
                            - rect.left + column) * bytesPerPixel;
                        out.fill(value, at, at + bytesPerPixel);
                    }
                }
            }
            host.writeMemory(buffer >>> 0, out);
            return S_OK;
        } },
        /**
         * HRESULT GetAlphaBlendParams(IDWriteRenderingParams*, FLOAT *gamma,
         *     FLOAT *contrast, FLOAT *clearTypeLevel)
         */
        { name: 'GetAlphaBlendParams', argBytes: 20, invoke: (o, args)=>{
            const [params, gammaAt, contrastAt, levelAt] = args;
            const values = (params >>> 0) === 0 ? null
                : host.objectAt(params >>> 0)?.state?.values;
            if (!values)
            {
                return E_INVALIDARG;
            }
            const gdi = o.state.mode === RENDERING.GDI_CLASSIC
                || o.state.mode === RENDERING.GDI_NATURAL;
            const [gamma, contrast, level] = gdi ? [GDI_GAMMA, 0, 1] : values;
            for (const [at, value] of [[gammaAt, gamma], [contrastAt, contrast],
                [levelAt, level]])
            {
                if ((at >>> 0) !== 0)
                {
                    putU32s(at, [bitsOf(value)]);
                }
            }
            return S_OK;
        } },
    ] };

    return {
        analyzer: ()=>analyzer,
        glyphRun,
        /**
         * A glyph run analysis' coverage over a rectangle, a byte a pixel.
         *
         * @param {import('../ole32/objects.js').ComObject} analysis
         * @param {{ left: number, top: number, right: number, bottom: number }} rect
         */
        coverageOf: (analysis, rect)=>coverage(analysis.state, rect),
    };
}
