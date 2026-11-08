/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IDWriteBitmapRenderTarget: a memory device context with a 32-bit top-down
 * DIB of the target's size selected into it, in GDI's advanced graphics
 * mode, that glyph runs are drawn into in a colour. An empty target holds
 * the context's own 1x1 monochrome bitmap, as a new memory context does.
 *
 * The context and its bitmaps are gdi32's, made through its exports, so a
 * program reads and blits the target with the GDI calls it already makes.
 * A run is drawn from its glyph run analysis' coverage (`analyzer.js`).
 */

import { createComObject } from '../ole32/objects.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_FAIL = 0x80004005 | 0;

const IID_BITMAP_RENDER_TARGET = '{5E5A32A3-8DFF-4773-9FF6-0696EAB77267}';
const GM_ADVANCED = 2;
const DIB_RGB_COLORS = 0;
/** DWRITE_RENDERING_MODE_GDI_CLASSIC: how GDI-compatible text is drawn. */
const GDI_CLASSIC = 2;

/**
 * @typedef {Object} TargetHost
 * @property {import('./host.js').DwriteHost} host
 * @property {(name: string, args: number[]) => number} gdi  a gdi32 export, called
 * @property {(at: number) => number} u32
 * @property {(at: number, values: number[]) => void} putU32s
 * @property {(bytes: number) => number} scratch
 * @property {(bits: number) => number} f32
 * @property {(value: number) => number} bitsOf
 * @property {(api: string, value: number) => number} floatAnswer
 * @property {(args: number[]) => import('../ole32/objects.js').ComObject | number} glyphRun
 * @property {(analysis: import('../ole32/objects.js').ComObject,
 *     rect: { left: number, top: number, right: number, bottom: number }) => Uint8Array}
 *     coverageOf
 */

/**
 * @param {TargetHost} t
 */
export function createRenderTargets(t){
    const { host, gdi, u32, putU32s, scratch, f32, bitsOf } = t;

    /**
     * A 32-bit top-down DIB section of a size, and where its pixels are.
     *
     * @param {number} hdc @param {number} width @param {number} height
     */
    const dib = (hdc, width, height)=>{
        const info = scratch(44);
        try
        {
            putU32s(info, [40, width, -height >>> 0, 1 | 32 << 16, 0, 0, 0, 0, 0, 0]);
            const bitmap = gdi('CreateDIBSection', [hdc, info, DIB_RGB_COLORS, info + 40, 0, 0]);
            return { bitmap, bits: u32(info + 40) };
        }
        finally
        {
            host.heap.free(info);
        }
    };

    /** @param {any} state @param {number} width @param {number} height */
    const resize = (state, width, height)=>{
        const empty = width === 0 || height === 0;
        const made = empty ? { bitmap: state.stock, bits: 0 } : dib(state.hdc, width, height);
        if (!empty && made.bitmap === 0)
        {
            return E_FAIL;
        }
        gdi('SelectObject', [state.hdc, made.bitmap]);
        if (state.bitmap !== state.stock)
        {
            gdi('DeleteObject', [state.bitmap]);
        }
        Object.assign(state, { width, height, bitmap: made.bitmap, bits: made.bits });
        return S_OK;
    };

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const descriptor = { id: IID_BITMAP_RENDER_TARGET, methods: [
        /**
         * HRESULT DrawGlyphRun(FLOAT baselineOriginX, FLOAT baselineOriginY,
         *     DWRITE_MEASURING_MODE, DWRITE_GLYPH_RUN const*, IDWriteRenderingParams*,
         *     COLORREF textColor, RECT *blackBoxRect)
         */
        { name: 'DrawGlyphRun', argBytes: 32, invoke: (o, args)=>{
            const [x, y, measuring, run, params, color, boxOut] = args;
            const state = o.state;
            // An empty target draws nothing and checks nothing.
            if (state.width === 0 || state.height === 0)
            {
                return S_OK;
            }
            if ((run >>> 0) === 0 || (params >>> 0) === 0 || (measuring >>> 0) > 2)
            {
                return E_INVALIDARG;
            }
            const transform = scratch(24);
            try
            {
                putU32s(transform, state.transform.map(bitsOf));
                const analysis = t.glyphRun([run, bitsOf(state.ppd), transform, GDI_CLASSIC,
                    measuring, bitsOf(f32(x) * state.ppd), bitsOf(f32(y) * state.ppd)]);
                if (typeof analysis === 'number')
                {
                    return analysis;
                }
                const b = analysis.state.bounds;
                const box = { left: Math.max(0, b.left), top: Math.max(0, b.top),
                    right: Math.min(state.width, b.right),
                    bottom: Math.min(state.height, b.bottom) };
                if (box.right > box.left && box.bottom > box.top && state.bits !== 0)
                {
                    drawInto(state, box, t.coverageOf(analysis, box), color >>> 0);
                }
                analysis.release();
                // The run's own box, wherever it falls against the target's.
                if ((boxOut >>> 0) !== 0)
                {
                    putU32s(boxOut, [b.left, b.top, b.right, b.bottom]);
                }
                return S_OK;
            }
            finally
            {
                host.heap.free(transform);
            }
        } },
        /** HDC GetMemoryDC() */
        { name: 'GetMemoryDC', argBytes: 4, invoke: o=>o.state.hdc },
        /** FLOAT GetPixelsPerDip() */
        { name: 'GetPixelsPerDip', argBytes: 4, invoke: o=>t.floatAnswer(
            'IDWriteBitmapRenderTarget::GetPixelsPerDip', o.state.ppd) },
        /** HRESULT SetPixelsPerDip(FLOAT) */
        { name: 'SetPixelsPerDip', argBytes: 8, invoke: (o, [value])=>{
            const ppd = f32(value);
            if (!(ppd > 0))
            {
                return E_INVALIDARG;
            }
            o.state.ppd = ppd;
            return S_OK;
        } },
        /** HRESULT GetCurrentTransform(DWRITE_MATRIX*) */
        { name: 'GetCurrentTransform', argBytes: 8, invoke: (o, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, o.state.transform.map(bitsOf));
            return S_OK;
        } },
        /** HRESULT SetCurrentTransform(DWRITE_MATRIX const*): null for identity */
        { name: 'SetCurrentTransform', argBytes: 8, invoke: (o, [at])=>{
            o.state.transform = (at >>> 0) === 0 ? [1, 0, 0, 1, 0, 0]
                : Array.from({ length: 6 }, (_, i)=>f32(u32((at >>> 0) + i * 4)));
            return S_OK;
        } },
        /** HRESULT GetSize(SIZE*) */
        { name: 'GetSize', argBytes: 8, invoke: (o, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [o.state.width, o.state.height]);
            return S_OK;
        } },
        /** HRESULT Resize(UINT32 width, UINT32 height) */
        { name: 'Resize', argBytes: 12, invoke: (o, [width, height])=>{
            if ((width >>> 0) === o.state.width && (height >>> 0) === o.state.height)
            {
                return S_OK;
            }
            return resize(o.state, width >>> 0, height >>> 0);
        } },
    ] };

    /**
     * Coverage blended into the DIB in a colour, a pixel at a time.
     *
     * @param {any} state @param {{ left: number, top: number, right: number, bottom: number }} box
     * @param {Uint8Array} coverage @param {number} color  COLORREF, 0x00BBGGRR
     */
    const drawInto = (state, box, coverage, color)=>{
        const width = box.right - box.left;
        const ink = [color >>> 16 & 0xff, color >>> 8 & 0xff, color & 0xff];
        for (let row = box.top; row < box.bottom; row++)
        {
            const at = state.bits + (row * state.width + box.left) * 4;
            const pixels = host.readMemory(at, width * 4).slice();
            for (let column = 0; column < width; column++)
            {
                const alpha = coverage[(row - box.top) * width + column];
                for (let channel = 0; channel < 3; channel++)
                {
                    const k = column * 4 + channel;
                    pixels[k] = Math.round(pixels[k] + (ink[channel] - pixels[k]) * alpha / 255);
                }
            }
            host.writeMemory(at, pixels);
        }
    };

    return {
        /**
         * A target over a new memory context, compatible with `hdc`.
         *
         * @param {number} hdc @param {number} width @param {number} height
         * @returns {import('../ole32/objects.js').ComObject | null}
         */
        create(hdc, width, height){
            const memory = gdi('CreateCompatibleDC', [hdc]);
            if (memory === 0)
            {
                return null;
            }
            gdi('SetGraphicsMode', [memory, GM_ADVANCED]);
            const state = { hdc: memory, width: 0, height: 0, stock: 0, bitmap: 0, bits: 0,
                ppd: 1, transform: [1, 0, 0, 1, 0, 0] };
            // The new context's own bitmap, which an empty target keeps selected.
            const first = dib(memory, 1, 1);
            state.stock = gdi('SelectObject', [memory, first.bitmap]);
            gdi('SelectObject', [memory, state.stock]);
            gdi('DeleteObject', [first.bitmap]);
            state.bitmap = state.stock;
            if (resize(state, width, height) !== S_OK)
            {
                gdi('DeleteDC', [memory]);
                return null;
            }
            return createComObject(IID_BITMAP_RENDER_TARGET, { interfaces: [descriptor], state,
                destroy: ()=>{
                    gdi('SelectObject', [state.hdc, state.stock]);
                    if (state.bitmap !== state.stock)
                    {
                        gdi('DeleteObject', [state.bitmap]);
                    }
                    gdi('DeleteDC', [state.hdc]);
                } });
        },
    };
}
