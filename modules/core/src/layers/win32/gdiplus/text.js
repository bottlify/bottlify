/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GDI+'s text: a string laid in a rectangle by a string format - broken
 * into lines at spaces and line feeds, aligned along and across them,
 * padded by a sixth of an em each side unless the format is the typographic
 * one - then measured, measured by character range, or drawn.
 *
 * A face's glyphs and advances are gdi32's: the string is measured with
 * GetTextExtentExPoint in a font of the em GDI+ asks for, and drawn by
 * TextOut into a DIB whose pixels are the coverage the brush is laid by
 * (`graphics.js`), so GDI and GDI+ set a face alike. Text is laid along the
 * device's axes: a world transform that turns or shears it moves where it
 * starts and scales it, said once.
 */

import { designCell } from '../gdi32/faces.js';
import { Status, fn } from './kit.js';
import { invert } from './matrix.js';
import { CombineMode, combine, rectNode, transformNode } from './region.js';
import { Unit, pixelsPer } from './graphics.js';

/** StringFormatFlags. */
const NoWrap = 0x1000;
const LineLimit = 0x2000;
const NoClip = 0x4000;
const MeasureTrailingSpaces = 0x800;
/** HotkeyPrefixNone. */
const HotkeyPrefixNone = 0;
/** DriverStringOptions. */
const DriverStringOptionsCmapLookup = 1;
const DriverStringOptionsRealizedAdvance = 4;
/** FontStyle. */
const FontStyleBold = 1;
const FontStyleItalic = 2;
const FontStyleUnderline = 4;
const FontStyleStrikeout = 8;
/** How much larger than the em a string is measured, for advances finer than a pixel. */
const MEASURE_SCALE = 8;

/**
 * @typedef {{ face: string, size: number, style: number, unit: number }} Font
 *
 * @typedef {Object} Line
 * @property {number} start @property {number} end  its characters of the laid text
 * @property {number} x @property {number} y  its top left, device pixels
 * @property {number} width
 * @property {number[]} advances  where each of its characters ends, from its left
 *
 * @typedef {Object} Layout
 * @property {string} text  the string as laid, a hotkey prefix taken out
 * @property {number[]} source  each laid character's place in the string given
 * @property {Line[]} lines
 * @property {number[]} bounds  x y width height, device pixels
 * @property {number} fitted  characters of the string the lines hold
 * @property {number} lineHeight
 */

/**
 * @param {import('./kit.js').Kit} kit
 * @param {Object} deps
 * @param {import('./image.js').ImageHost & { divergence?: (api: string, detail: string,
 *     kind?: string) => void, readWideString?: (address: number) => string }} deps.host
 * @param {{ font: (at: number) => (Font | undefined) }} deps.fonts
 * @param {ReturnType<typeof import('./graphics.js').createGraphicsFunctions>} deps.graphics
 * @param {{ get: (at: number) => (import('./brush.js').Brush | undefined) }} deps.brushes
 * @param {ReturnType<typeof import('./stringformat.js').createStringFormatFunctions>} deps.formats
 * @param {{ set: (at: number, node: import('./region.js').Node) => boolean }} deps.regions
 */
export function createTextFunctions(kit, { host, fonts, graphics, brushes, formats, regions }){
    const { Ok, InvalidParameter, ObjectBusy } = Status;
    const gdi32 = host.gdi32;
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail @param {string} [kind] */
    const diverge = (api, detail, kind)=>{
        if (!said.has(`${api}:${detail}`))
        {
            said.add(`${api}:${detail}`);
            host.divergence?.(api, detail, kind);
        }
    };

    /**
     * The string a program passed: `length` characters, or to its NUL at -1.
     *
     * @param {number} at @param {number} length
     */
    const stringAt = (at, length)=>{
        if ((length | 0) < 0)
        {
            return host.readWideString ? host.readWideString(at >>> 0) : '';
        }
        const bytes = kit.read(at, (length | 0) * 2);
        return String.fromCharCode(...new Uint16Array(bytes.buffer, 0, length | 0));
    };

    /**
     * A font's em in device pixels on a graphics, and the scale from device
     * pixels back to world units.
     *
     * @param {number} g @param {Font} font
     */
    const emOf = (g, font)=>{
        const m = /** @type {import('./matrix.js').Elements} */ (graphics.device(g));
        const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
        if (m[1] !== 0 || m[2] !== 0)
        {
            diverge('GdipDrawString', 'text under a turned or sheared transform is laid along '
                + 'the device\'s axes');
        }
        const em = font.unit === Unit.World ? font.size * scale
            : font.size * pixelsPer(font.unit, graphics.dpi(g));
        return { em, scale, m };
    };

    /**
     * Uses a memory DC holding a GDI font of the face at `height` pixels.
     *
     * @template T
     * @param {Font} font @param {number} height @param {(dc: number) => T} use @param {T} none
     * @returns {T}
     */
    const withFont = (font, height, use, none)=>{
        if (!gdi32)
        {
            return none;
        }
        const lf = host.allocate(92);
        if (lf === 0)
        {
            return none;
        }
        const bytes = new Uint8Array(92);
        const view = new DataView(bytes.buffer);
        view.setInt32(0, -Math.max(1, Math.round(height)), true);
        view.setInt32(16, font.style & FontStyleBold ? 700 : 400, true);
        bytes[20] = font.style & FontStyleItalic ? 1 : 0;
        bytes[21] = font.style & FontStyleUnderline ? 1 : 0;
        bytes[22] = font.style & FontStyleStrikeout ? 1 : 0;
        bytes[23] = 1;
        // ANTIALIASED_QUALITY: the coverage is drawn at more than one level.
        bytes[26] = 4;
        for (let i = 0; i < Math.min(31, font.face.length); i++)
        {
            view.setUint16(28 + i * 2, font.face.charCodeAt(i), true);
        }
        kit.write(lf, bytes);
        const dc = gdi32('CreateCompatibleDC', [0]);
        const hfont = gdi32('CreateFontIndirectW', [lf]);
        host.free(lf);
        const old = gdi32('SelectObject', [dc, hfont]);
        try
        {
            return use(dc);
        }
        finally
        {
            gdi32('SelectObject', [dc, old]);
            gdi32('DeleteObject', [hfont]);
            gdi32('DeleteDC', [dc]);
        }
    };

    /**
     * Where each character of a run ends, from its start, in pixels of an em
     * of `em`: GDI's advances in a font eight times the size, scaled back.
     *
     * @param {Font} font @param {number} em @param {string} text
     * @returns {number[]}
     */
    const advancesOf = (font, em, text)=>{
        if (text.length === 0)
        {
            return [];
        }
        const measured = withFont(font, em * MEASURE_SCALE, dc=>{
            const at = host.allocate(text.length * 6 + 16);
            if (at === 0)
            {
                return null;
            }
            try
            {
                kit.write(at, new Uint8Array(Uint16Array.from(text, c=>c.charCodeAt(0)).buffer));
                const dx = at + text.length * 2;
                if (gdi32?.('GetTextExtentExPointW', [dc, at, text.length, 0, 0, dx,
                    dx + text.length * 4]) === 0)
                {
                    return null;
                }
                return kit.i32s(dx, text.length).map(v=>v / MEASURE_SCALE);
            }
            finally
            {
                host.free(at);
            }
        }, null);
        if (measured)
        {
            return measured;
        }
        diverge('GdipMeasureString', 'no GDI to measure a face with: half an em a character');
        return Array.from(text, (_, i)=>(i + 1) * em / 2);
    };

    /**
     * Lays a string in a box of device pixels by a format.
     *
     * @param {string} given @param {Font} font @param {number} em
     * @param {number[]} box  x y width height
     * @param {import('./stringformat.js').StringFormat} format
     * @returns {Layout}
     */
    const layout = (given, font, em, box, format)=>{
        /** @type {number[]} */
        const source = [];
        let text = '';
        for (let i = 0; i < given.length; i++)
        {
            const c = given[i];
            if (format.hotkey !== HotkeyPrefixNone && c === '&')
            {
                if (given[i + 1] !== '&')
                {
                    continue;
                }
                i++;
            }
            text += given[i];
            source.push(i);
        }
        const cell = /** @type {NonNullable<ReturnType<typeof designCell>>} */ (
            designCell(font.face) ?? designCell('Arial'));
        const lineHeight = em * (cell.ascent + cell.descent) / cell.unitsPerEm;
        const pad = format.typographic ? 0 : em / 6;
        const [bx, by, bw, bh] = box;
        const wrap = bw > 0 && (format.flags & NoWrap) === 0 ? Math.max(0, bw - 2 * pad)
            : Infinity;
        /** @type {Line[]} */
        const lines = [];
        let start = 0;
        while (start <= text.length)
        {
            const end = text.indexOf('\n', start);
            const paragraphEnd = end < 0 ? text.length : end;
            // A paragraph is a line at least, empty or not.
            for (let from = start, first = true; first || from < paragraphEnd; first = false)
            {
                const run = text.slice(from, paragraphEnd).replace(/\r$/, '');
                const advances = advancesOf(font, em, run);
                // A whole run takes the paragraph to its end, a carriage return with it.
                let cut = paragraphEnd - from;
                if (advances.length > 0 && advances[advances.length - 1] > wrap)
                {
                    const over = advances.findIndex(v=>v > wrap);
                    const space = run.lastIndexOf(' ', over);
                    cut = space > 0 ? space + 1 : Math.max(1, over);
                }
                const kept = run.slice(0, cut);
                const trimmed = (format.flags & MeasureTrailingSpaces) !== 0 ? kept
                    : kept.replace(/ +$/, '');
                lines.push({ start: from, end: from + cut, x: 0, y: 0,
                    width: trimmed.length > 0 ? advances[trimmed.length - 1] : 0,
                    advances: advances.slice(0, cut) });
                from += cut;
            }
            if (end < 0)
            {
                break;
            }
            start = end + 1;
        }
        let kept = lines;
        if (bh > 0)
        {
            const most = (format.flags & LineLimit) !== 0 ? Math.floor(bh / lineHeight + 1e-6)
                : Math.ceil(bh / lineHeight - 1e-6);
            kept = lines.slice(0, Math.max(0, most));
        }
        const total = kept.length * lineHeight;
        const top = bh > 0 ? by + [0, (bh - total) / 2, bh - total][format.lineAlign] : by
            - [0, total / 2, total][format.lineAlign];
        let left = Infinity;
        let widest = 0;
        kept.forEach((line, i)=>{
            line.y = top + i * lineHeight;
            line.x = bw > 0 ? bx + [pad, (bw - line.width) / 2, bw - pad - line.width][
                format.align] : bx + [pad, -line.width / 2, -line.width - pad][format.align];
            left = Math.min(left, line.x - pad);
            widest = Math.max(widest, line.width);
        });
        const fitted = kept.length === 0 ? 0 : kept[kept.length - 1].end;
        return { text, source, lines: kept, lineHeight, fitted: fitted >= text.length
            ? given.length : source[fitted] ?? given.length,
        bounds: [kept.length === 0 ? bx : left, top, kept.length === 0 ? 0 : widest + 2 * pad,
            total] };
    };

    /**
     * The device box a world rectangle lands on.
     *
     * @param {import('./matrix.js').Elements} m @param {number[]} rect
     */
    const deviceBox = (m, [x, y, w, h])=>[x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5],
        w * m[0], h * m[3]];
    /**
     * World coordinates of a device box.
     *
     * @param {import('./matrix.js').Elements} m @param {number[]} box
     */
    const worldBox = (m, [x, y, w, h])=>{
        const inverse = invert(m) ?? [1, 0, 0, 1, 0, 0];
        return [x * inverse[0] + y * inverse[2] + inverse[4],
            x * inverse[1] + y * inverse[3] + inverse[5], w * inverse[0], h * inverse[3]];
    };

    /**
     * Draws laid lines with a brush: TextOut into a DIB, its pixels the coverage.
     *
     * @param {number} g @param {Font} font @param {number} em
     * @param {{ text: string, x: number, y: number }[]} runs  each run's top left
     * @param {import('./brush.js').Brush} brush @param {number[] | null} clip  device box
     */
    const drawRuns = (g, font, em, runs, brush, clip)=>{
        if (runs.length === 0)
        {
            return Ok;
        }
        if (!gdi32)
        {
            diverge('GdipDrawString', 'no GDI to draw a face with', 'loss');
            return Ok;
        }
        const pad = Math.ceil(em);
        const left = Math.floor(Math.min(...runs.map(r=>r.x))) - pad;
        const top = Math.floor(Math.min(...runs.map(r=>r.y))) - pad;
        const right = Math.ceil(Math.max(...runs.map(r=>r.x + (advancesOf(font, em, r.text)
            .at(-1) ?? 0)))) + pad;
        const bottom = Math.ceil(Math.max(...runs.map(r=>r.y))) + Math.ceil(em * 1.5) + pad;
        const width = right - left;
        const height = bottom - top;
        const cover = withFont(font, em, dc=>{
            const info = host.allocate(48);
            if (info === 0)
            {
                return null;
            }
            try
            {
                const header = new DataView(new ArrayBuffer(40));
                header.setUint32(0, 40, true);
                header.setInt32(4, width, true);
                header.setInt32(8, -height, true);
                header.setUint16(12, 1, true);
                header.setUint16(14, 32, true);
                kit.write(info, new Uint8Array(header.buffer));
                const section = gdi32('CreateDIBSection', [dc, info, 0, info + 40, 0, 0]);
                if (section === 0)
                {
                    return null;
                }
                const bits = kit.u32(info + 40);
                const old = gdi32('SelectObject', [dc, section]);
                gdi32('SetBkMode', [dc, 1]);
                gdi32('SetTextColor', [dc, 0xffffff]);
                for (const run of runs)
                {
                    const at = host.allocate(run.text.length * 2 + 2);
                    kit.write(at, new Uint8Array(Uint16Array.from(run.text, c=>c.charCodeAt(0))
                        .buffer));
                    gdi32('TextOutW', [dc, Math.round(run.x - left), Math.round(run.y - top), at,
                        run.text.length]);
                    host.free(at);
                }
                const pixels = kit.read(bits, width * height * 4);
                gdi32('SelectObject', [dc, old]);
                gdi32('DeleteObject', [section]);
                const out = new Float32Array(width * height);
                for (let i = 0; i < out.length; i++)
                {
                    const x = left + i % width;
                    const y = top + Math.floor(i / width);
                    const inside = !clip || (x >= clip[0] && y >= clip[1] && x < clip[0] + clip[2]
                        && y < clip[1] + clip[3]);
                    out[i] = inside ? Math.max(pixels[i * 4], pixels[i * 4 + 1],
                        pixels[i * 4 + 2]) / 255 : 0;
                }
                return out;
            }
            finally
            {
                host.free(info);
            }
        }, null);
        if (!cover)
        {
            diverge('GdipDrawString', 'text whose glyphs could not be drawn', 'loss');
            return Ok;
        }
        return graphics.layCoverage(g, brush, { left, top, right, bottom }, cover);
    };

    /**
     * The arguments of a string call checked and resolved.
     *
     * @param {number} g @param {number} string @param {number} length @param {number} fontAt
     * @param {number} rect @param {number} formatAt
     */
    const resolve = (g, string, length, fontAt, rect, formatAt)=>{
        const font = fonts.font(fontAt);
        const format = (formatAt >>> 0) === 0 ? formats.defaultFormat() : formats.get(formatAt);
        if (!graphics.isGraphics(g) || (string >>> 0) === 0 || !font || (rect >>> 0) === 0
            || !format)
        {
            return null;
        }
        const { em, scale, m } = emOf(g, font);
        const box = deviceBox(m, kit.f32s(rect, 4));
        return { font, format, em, scale, m, box, text: stringAt(string, length) };
    };

    const functions = {
        /**
         * Status GdipDrawString(GpGraphics *graphics, const WCHAR *string, INT length,
         *   const GpFont *font, const RectF *layoutRect, const GpStringFormat *format,
         *   const GpBrush *brush)
         *
         * Clipped to the layout rectangle unless the format says NoClip, or
         * the rectangle has no size.
         */
        GdipDrawString: fn(28, ([g, string, length, fontAt, rect, formatAt, brushAt])=>{
            if (graphics.busy(g))
            {
                return ObjectBusy;
            }
            const brush = brushes.get(brushAt);
            const call = resolve(g, string, length, fontAt, rect, formatAt);
            if (!call || !brush)
            {
                return InvalidParameter;
            }
            const laid = layout(call.text, call.font, call.em, call.box, call.format);
            const [, , w, h] = call.box;
            const clip = (call.format.flags & NoClip) !== 0 || w <= 0 || h <= 0 ? null : call.box;
            return drawRuns(g, call.font, call.em, laid.lines.map(line=>({
                text: laid.text.slice(line.start, line.end).replace(/[\r\n]/g, ''), x: line.x,
                y: line.y })), brush, clip);
        }),
        /**
         * Status GdipMeasureString(GpGraphics *graphics, const WCHAR *string, INT length,
         *   const GpFont *font, const RectF *layoutRect, const GpStringFormat *format,
         *   RectF *bounds, INT *codepointsFitted, INT *linesFilled)
         */
        GdipMeasureString: fn(36, ([g, string, length, fontAt, rect, formatAt, bounds, fitted,
            lines])=>{
            if (graphics.busy(g))
            {
                return ObjectBusy;
            }
            const call = resolve(g, string, length, fontAt, rect, formatAt);
            if (!call || (bounds >>> 0) === 0)
            {
                return InvalidParameter;
            }
            const laid = layout(call.text, call.font, call.em, call.box, call.format);
            kit.putF32s(bounds, worldBox(call.m, laid.bounds));
            if ((fitted >>> 0) !== 0)
            {
                kit.putI32(fitted, laid.fitted);
            }
            if ((lines >>> 0) !== 0)
            {
                kit.putI32(lines, laid.lines.length);
            }
            return Ok;
        }),
        /**
         * Status GdipMeasureCharacterRanges(GpGraphics *graphics, const WCHAR *string,
         *   INT length, const GpFont *font, const RectF *layoutRect,
         *   const GpStringFormat *format, INT regionCount, GpRegion **regions)
         *
         * Each of the format's ranges: the union of the boxes its laid
         * characters take on each line, in world space.
         */
        GdipMeasureCharacterRanges: fn(32, ([g, string, length, fontAt, rect, formatAt, count,
            out])=>{
            if (graphics.busy(g))
            {
                return ObjectBusy;
            }
            const call = resolve(g, string, length, fontAt, rect, formatAt);
            if (!call || (out >>> 0) === 0 || (count | 0) < call.format.ranges.length)
            {
                return InvalidParameter;
            }
            const laid = layout(call.text, call.font, call.em, call.box, call.format);
            const inverse = invert(call.m) ?? [1, 0, 0, 1, 0, 0];
            call.format.ranges.forEach(([first, size], i)=>{
                /** @type {import('./region.js').Node} */
                let node = { type: 'empty' };
                for (const line of laid.lines)
                {
                    const from = Math.max(line.start, laid.source.findIndex(s=>s >= first));
                    const to = Math.min(line.end, laid.source.findIndex(s=>s >= first + size)
                        < 0 ? laid.text.length : laid.source.findIndex(s=>s >= first + size));
                    if (to <= from)
                    {
                        continue;
                    }
                    const x0 = from === line.start ? 0 : line.advances[from - line.start - 1];
                    const x1 = line.advances[to - line.start - 1] ?? x0;
                    node = combine(node, rectNode([line.x + x0, line.y, x1 - x0,
                        laid.lineHeight]), CombineMode.Union);
                }
                const region = kit.pointerAt(out + i * kit.pointer.size);
                regions.set(region, node.type === 'empty' ? node : transformNode(node, inverse));
            });
            return Ok;
        }),
        /**
         * Status GdipDrawDriverString(GpGraphics *graphics, const UINT16 *text, INT length,
         *   const GpFont *font, const GpBrush *brush, const PointF *positions, INT flags,
         *   const GpMatrix *matrix)
         *
         * Characters at their baselines' positions - the first alone with
         * DriverStringOptionsRealizedAdvance; glyph indices cannot be drawn.
         */
        GdipDrawDriverString: fn(32, ([g, text, length, fontAt, brushAt, positions, flags])=>{
            if (graphics.busy(g))
            {
                return ObjectBusy;
            }
            const font = fonts.font(fontAt);
            const brush = brushes.get(brushAt);
            if (!graphics.isGraphics(g) || (text >>> 0) === 0 || !font || !brush
                || (positions >>> 0) === 0 || (length | 0) === 0)
            {
                return InvalidParameter;
            }
            if ((flags & DriverStringOptionsCmapLookup) === 0)
            {
                diverge('GdipDrawDriverString', 'glyph indices are not drawn', 'loss');
                return Ok;
            }
            const string = stringAt(text, length);
            const { em, m } = emOf(g, font);
            const cell = /** @type {NonNullable<ReturnType<typeof designCell>>} */ (
                designCell(font.face) ?? designCell('Arial'));
            const ascent = em * cell.ascent / cell.unitsPerEm;
            const realized = (flags & DriverStringOptionsRealizedAdvance) !== 0;
            const points = kit.points(positions, realized ? 1 : string.length, false)
                .map(([x, y])=>[x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
            const runs = realized ? [{ text: string, x: points[0][0], y: points[0][1] - ascent }]
                : Array.from(string, (c, i)=>({ text: c, x: points[i][0],
                    y: points[i][1] - ascent }));
            return drawRuns(g, font, em, runs, brush, null);
        }),
        /**
         * Status GdipMeasureDriverString(GpGraphics *graphics, const UINT16 *text, INT length,
         *   const GpFont *font, const PointF *positions, INT flags, const GpMatrix *matrix,
         *   RectF *bounds)
         */
        GdipMeasureDriverString: fn(32, ([g, text, length, fontAt, positions, flags, ,
            bounds])=>{
            if (graphics.busy(g))
            {
                return ObjectBusy;
            }
            const font = fonts.font(fontAt);
            if (!graphics.isGraphics(g) || (text >>> 0) === 0 || !font || (positions >>> 0) === 0
                || (bounds >>> 0) === 0 || (length | 0) === 0)
            {
                return InvalidParameter;
            }
            const string = stringAt(text, length);
            const { em, m } = emOf(g, font);
            const cell = /** @type {NonNullable<ReturnType<typeof designCell>>} */ (
                designCell(font.face) ?? designCell('Arial'));
            const ascent = em * cell.ascent / cell.unitsPerEm;
            const descent = em * cell.descent / cell.unitsPerEm;
            const realized = (flags & DriverStringOptionsRealizedAdvance) !== 0;
            const advances = advancesOf(font, em, string);
            const points = kit.points(positions, realized ? 1 : string.length, false)
                .map(([x, y])=>[x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]]);
            const xs = realized ? [points[0][0], points[0][0] + (advances.at(-1) ?? 0)]
                : points.flatMap(([x], i)=>[x, x + advances[i] - (i > 0 ? advances[i - 1] : 0)]);
            const ys = points.map(([, y])=>y);
            const left = Math.min(...xs);
            const top = Math.min(...ys) - ascent;
            kit.putF32s(bounds, worldBox(m, [left, top, Math.max(...xs) - left,
                Math.max(...ys) + descent - top]));
            return Ok;
        }),
    };
    return { functions };
}
