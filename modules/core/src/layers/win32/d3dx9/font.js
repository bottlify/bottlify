/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createComObject } from '../ole32/objects.js';
import { writeTextMetrics, writeTextMetricsW } from '../gdi32/structs.js';
import { DEVICE, TEXTURE, createDeviceCalls } from './device.js';
import { SPRITE } from './sprite.js';

/**
 * ID3DXFont: text drawn on the program's device, as D3DX draws it -- each
 * character rasterised once by the font engine GDI draws with, kept in a page
 * of a texture (white, its coverage in alpha) on the device, and placed with
 * a sprite: the program's own when it passes one, else one of the font's.
 *
 * DrawText lays text out the way DrawText in user32 does for the flags a game
 * passes: lines broken at line feeds, and at spaces with DT_WORDBREAK; left,
 * centred or right; top, centred or bottom on a single line; DT_CALCRECT
 * measures without drawing.
 */

export const IID_ID3DXFONT = '{D79DBB70-5F21-4D36-BBC2-FF525C213CDC}';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const E_OUTOFMEMORY = 0x8007000e;

/** DT_ flags. */
const DT = Object.freeze({ CENTER: 0x1, RIGHT: 0x2, VCENTER: 0x4, BOTTOM: 0x8,
    WORDBREAK: 0x10, SINGLELINE: 0x20, CALCRECT: 0x400 });

/** A page of glyphs, and what it is made as. */
const PAGE = 256;
const D3DFMT_A8R8G8B8 = 21;
const D3DPOOL_MANAGED = 1;

/**
 * @typedef {Object} FontDesc
 * @property {number} height
 * @property {number} width
 * @property {number} weight
 * @property {number} mipLevels
 * @property {number} italic
 * @property {number} charSet
 * @property {number} outputPrecision
 * @property {number} quality
 * @property {number} pitchAndFamily
 * @property {string} faceName
 */

/**
 * @typedef {Object} FontHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {{ publish: (object: any, interfaceId: string) => number }} [vtables]
 * @property {(font: any) => { height: number, ascent: number, descent: number,
 *     internalLeading: number, externalLeading: number, aveCharWidth: number,
 *     maxCharWidth: number } | null} [fontMetrics]
 * @property {(code: number, font: any) => { advance: number, left: number, top: number,
 *     width: number, height: number, coverage: Uint8Array } | null} [glyph]
 */

/**
 * @param {FontHost} host
 * @param {ReturnType<typeof import('./sprite.js').createSprites>} sprites
 */
export function createFonts(host, sprites){
    const { u32, putU32s, method } = createDeviceCalls(host);

    /** The LOGFONT the font engine is asked with. @param {FontDesc} desc */
    const logFontOf = desc=>({ height: desc.height, width: desc.width,
        escapement: 0, orientation: 0, weight: desc.weight, italic: desc.italic,
        underline: 0, strikeOut: 0, charSet: desc.charSet, outPrecision: desc.outputPrecision,
        clipPrecision: 0, quality: desc.quality, pitchAndFamily: desc.pitchAndFamily,
        faceName: desc.faceName });

    /**
     * What the font measures as: the engine's, or an estimate from the height
     * a build with no engine has to go on.
     *
     * @param {any} state
     */
    const metricsOf = state=>{
        const measured = host.fontMetrics?.(state.logFont) ?? null;
        if (measured)
        {
            return measured;
        }
        const height = Math.max(1, Math.abs(state.desc.height) || 16);
        return { height, ascent: Math.round(height * 0.8), descent: height
            - Math.round(height * 0.8), internalLeading: 0, externalLeading: 0,
        aveCharWidth: Math.max(1, Math.round(height / 2)),
        maxCharWidth: Math.max(1, height) };
    };

    /**
     * A character's place in the font's pages, rasterised and put there the
     * first time. Null when the engine has nothing for it; an advance alone
     * for one with no ink.
     *
     * @param {any} state @param {number} code
     */
    const glyphOf = (state, code)=>{
        const known = state.glyphs.get(code);
        if (known)
        {
            return known;
        }
        const drawn = host.glyph?.(code, state.logFont) ?? null;
        const metrics = metricsOf(state);
        /** @type {any} */
        let entry;
        if (!drawn)
        {
            entry = { advance: metrics.aveCharWidth, width: 0, height: 0, left: 0, top: 0,
                page: -1, x: 0, y: 0 };
        }
        else if (drawn.width === 0 || drawn.height === 0)
        {
            entry = { ...drawn, page: -1, x: 0, y: 0 };
        }
        else
        {
            const width = Math.min(drawn.width, PAGE - 2);
            const height = Math.min(drawn.height, PAGE - 2);
            let page = state.pages.at(-1);
            if (!page || page.x + width + 1 > PAGE)
            {
                if (page)
                {
                    page.x = 1;
                    page.y += page.row + 1;
                    page.row = 0;
                }
            }
            if (!page || page.y + height + 1 > PAGE)
            {
                page = { texture: 0, x: 1, y: 1, row: 0, writes: [] };
                state.pages.push(page);
            }
            entry = { advance: drawn.advance, left: drawn.left, top: drawn.top, width, height,
                page: state.pages.length - 1, x: page.x, y: page.y };
            page.writes.push({ x: page.x, y: page.y, width, height, coverage: drawn.coverage,
                stride: drawn.width });
            page.x += width + 1;
            page.row = Math.max(page.row, height);
        }
        state.glyphs.set(code, entry);
        return entry;
    };

    /**
     * Every page made on the device and its new glyphs written.
     *
     * @param {any} state @param {any} thread
     * @returns {Promise<number>}
     */
    const upload = async(state, thread)=>{
        const heap = /** @type {NonNullable<FontHost['heap']>} */ (host.heap);
        for (const page of state.pages)
        {
            if (page.writes.length === 0)
            {
                continue;
            }
            const scratch = heap.allocate(12);
            if (scratch === 0)
            {
                return E_OUTOFMEMORY;
            }
            try
            {
                if (page.texture === 0)
                {
                    putU32s(scratch, [0]);
                    const made = await method(thread, state.device, DEVICE.CreateTexture,
                        [PAGE, PAGE, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, scratch, 0]);
                    if (made !== D3D_OK)
                    {
                        return made;
                    }
                    page.texture = u32(scratch);
                    // A page starts transparent: what lies between glyphs is never drawn,
                    // but a filtered edge reads it.
                    page.writes.unshift({ x: 0, y: 0, width: PAGE, height: PAGE,
                        coverage: new Uint8Array(PAGE * PAGE), stride: PAGE });
                }
                const locked = await method(thread, page.texture, TEXTURE.LockRect,
                    [0, scratch + 4, 0, 0]);
                if (locked !== D3D_OK)
                {
                    return locked;
                }
                const pitch = u32(scratch + 4);
                const bits = u32(scratch + 8);
                for (const write of page.writes)
                {
                    const row = new Uint8Array(write.width * 4);
                    for (let y = 0; y < write.height; y++)
                    {
                        for (let x = 0; x < write.width; x++)
                        {
                            row.set([255, 255, 255, write.coverage[y * write.stride + x]], x * 4);
                        }
                        host.writeMemory(bits + (write.y + y) * pitch + write.x * 4, row);
                    }
                }
                page.writes = [];
                await method(thread, page.texture, TEXTURE.UnlockRect, [0]);
            }
            finally
            {
                heap.free(scratch);
            }
        }
        return D3D_OK;
    };

    /**
     * The lines a text makes in a rectangle of `width`, each as its codes and
     * its width.
     *
     * @param {any} state @param {number[]} codes @param {number} format @param {number} width
     * @returns {{ codes: number[], width: number }[]}
     */
    const layout = (state, codes, format, width)=>{
        /** @param {number[]} run */
        const widthOf = run=>run.reduce((sum, code)=>sum + glyphOf(state, code).advance, 0);
        /** @type {number[][]} */
        const paragraphs = [];
        /** @type {number[]} */
        let current = [];
        for (const code of codes)
        {
            if (!(format & DT.SINGLELINE) && code === 10)
            {
                paragraphs.push(current);
                current = [];
            }
            else if (!(code === 13 && !(format & DT.SINGLELINE)))
            {
                current.push(code);
            }
        }
        paragraphs.push(current);
        /** @type {{ codes: number[], width: number }[]} */
        const lines = [];
        for (const paragraph of paragraphs)
        {
            if (!(format & DT.WORDBREAK) || (format & DT.SINGLELINE))
            {
                lines.push({ codes: paragraph, width: widthOf(paragraph) });
                continue;
            }
            /** @type {number[]} */
            let line = [];
            /** @type {number[]} */
            let word = [];
            const flushWord = ()=>{
                if (line.length > 0 && widthOf([...line, ...word]) > width)
                {
                    lines.push({ codes: line, width: widthOf(line) });
                    line = word.slice(word[0] === 32 ? 1 : 0);
                }
                else
                {
                    line = [...line, ...word];
                }
                word = [];
            };
            for (const code of paragraph)
            {
                if (code === 32)
                {
                    flushWord();
                }
                word.push(code);
            }
            flushWord();
            lines.push({ codes: line, width: widthOf(line) });
        }
        return lines;
    };

    /**
     * DrawText's work, once the handler has returned.
     *
     * @param {any} state @param {number} spriteAt @param {number[]} codes
     * @param {number} rectAt @param {number} format @param {number} color @param {any} thread
     * @returns {Promise<number>}
     */
    const draw = async(state, spriteAt, codes, rectAt, format, color, thread)=>{
        await null;
        const rect = rectAt === 0 ? [0, 0, 0, 0] : [0, 1, 2, 3].map(i=>u32(rectAt + i * 4) | 0);
        const [left, top, right, bottom] = rect;
        const metrics = metricsOf(state);
        const lines = layout(state, codes, format, right - left);
        const lineHeight = metrics.height;
        const height = lines.length * lineHeight;
        if (format & DT.CALCRECT)
        {
            if (rectAt !== 0)
            {
                const widest = Math.max(0, ...lines.map(line=>line.width));
                putU32s(rectAt + 8, [left + widest, top + height]);
            }
            return height;
        }
        const answer = await upload(state, thread);
        if (answer !== D3D_OK)
        {
            return 0;
        }
        let y = top;
        if (format & DT.SINGLELINE)
        {
            if (format & DT.BOTTOM)
            {
                y = bottom - height;
            }
            else if (format & DT.VCENTER)
            {
                y = top + Math.floor((bottom - top - height) / 2);
            }
        }
        const own = spriteAt === 0 ? null : sprites.stateAt(spriteAt);
        if (spriteAt !== 0 && !own)
        {
            host.divergence?.('ID3DXFont::DrawText', 'a sprite that is not D3DX\'s own: drawn '
                + 'with the font\'s');
        }
        const target = own ?? sprites.detached(state.device);
        if (!own)
        {
            await sprites.start(target, SPRITE.ALPHABLEND, thread);
        }
        for (const line of lines)
        {
            let x = format & DT.RIGHT ? right - line.width
                : format & DT.CENTER ? left + Math.floor((right - left - line.width) / 2) : left;
            for (const code of line.codes)
            {
                const glyph = glyphOf(state, code);
                if (glyph.page >= 0)
                {
                    target.queue.push({ texture: state.pages[glyph.page].texture,
                        source: [glyph.x, glyph.y, glyph.x + glyph.width, glyph.y + glyph.height],
                        center: [0, 0, 0], position: [x + glyph.left, y + glyph.top, 0],
                        color: color >>> 0, transform: target.transform });
                }
                x += glyph.advance;
            }
            y += lineHeight;
        }
        if (!own)
        {
            await sprites.finish(target, thread);
        }
        return height;
    };

    /** @param {number} at @param {number} count  -1: to the NUL. */
    const ansi = (at, count)=>{
        const bytes = host.readMemory(at >>> 0, count < 0 ? 4096 : count);
        const end = count < 0 ? bytes.indexOf(0) : bytes.length;
        return [...bytes.subarray(0, end < 0 ? bytes.length : end)];
    };
    /** @param {number} at @param {number} count */
    const wide = (at, count)=>{
        const bytes = host.readMemory(at >>> 0, (count < 0 ? 2048 : count) * 2).slice();
        const units = [...new Uint16Array(bytes.buffer)];
        const end = count < 0 ? units.indexOf(0) : units.length;
        return units.slice(0, end < 0 ? units.length : end);
    };

    /**
     * @param {any} state @param {number} at @param {boolean} isWide
     */
    const writeDesc = (state, at, isWide)=>{
        const d = state.desc;
        const bytes = new Uint8Array(isWide ? 88 : 56);
        const view = new DataView(bytes.buffer);
        view.setInt32(0, d.height, true);
        view.setUint32(4, d.width, true);
        view.setUint32(8, d.weight, true);
        view.setUint32(12, d.mipLevels, true);
        view.setUint32(16, d.italic ? 1 : 0, true);
        bytes.set([d.charSet, d.outputPrecision, d.quality, d.pitchAndFamily], 20);
        [...d.faceName.slice(0, 31)].forEach((c, i)=>{
            if (isWide)
            {
                view.setUint16(24 + i * 2, c.charCodeAt(0), true);
            }
            else
            {
                bytes[24 + i] = c.charCodeAt(0) & 0xff;
            }
        });
        host.writeMemory(at >>> 0, bytes);
    };

    /** @param {any} state @param {number} at @param {boolean} isWide */
    const writeMetrics = (state, at, isWide)=>{
        const m = metricsOf(state);
        const fields = { ...m, weight: state.desc.weight || 400, digitizedAspectX: 96,
            digitizedAspectY: 96, firstChar: 32, lastChar: isWide ? 0xfffc : 255,
            defaultChar: 31, breakChar: 32, italic: state.desc.italic ? 1 : 0, underlined: 0,
            struckOut: 0, pitchAndFamily: state.desc.pitchAndFamily, charSet: state.desc.charSet };
        (isWide ? writeTextMetricsW : writeTextMetrics)(host, at >>> 0, fields);
    };

    /**
     * @param {(object: any, args: number[]) => number[]} read
     * @returns {import('../ole32/objects.js').ComMethod['invoke']}
     */
    const drawText = read=>(object, args)=>{
        const [spriteAt, text, count, rect, format, color] = args;
        if ((text >>> 0) === 0)
        {
            return 0;
        }
        const codes = read(object, [text, count | 0]);
        return draw(object.state, spriteAt >>> 0, codes, rect >>> 0, format >>> 0, color,
            host.currentThread?.());
    };

    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const font = {
        id: IID_ID3DXFONT,
        methods: [
            /** HRESULT GetDevice(LPDIRECT3DDEVICE9 *ppDevice) */
            { name: 'GetDevice', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                putU32s(out, [object.state.device]);
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>method(thread, object.state.device, 1, []))
                    .then(()=>D3D_OK);
            } },
            /** HRESULT GetDescA(D3DXFONT_DESCA *pDesc) */
            { name: 'GetDescA', argBytes: 8, invoke: (object, [at])=>{
                writeDesc(object.state, at, false);
                return D3D_OK;
            } },
            /** HRESULT GetDescW(D3DXFONT_DESCW *pDesc) */
            { name: 'GetDescW', argBytes: 8, invoke: (object, [at])=>{
                writeDesc(object.state, at, true);
                return D3D_OK;
            } },
            /** BOOL GetTextMetricsA(TEXTMETRICA *pTextMetrics) */
            { name: 'GetTextMetricsA', argBytes: 8, invoke: (object, [at])=>{
                writeMetrics(object.state, at, false);
                return 1;
            } },
            /** BOOL GetTextMetricsW(TEXTMETRICW *pTextMetrics) */
            { name: 'GetTextMetricsW', argBytes: 8, invoke: (object, [at])=>{
                writeMetrics(object.state, at, true);
                return 1;
            } },
            /** HDC GetDC() */
            { name: 'GetDC', argBytes: 4, invoke: ()=>{
                host.divergence?.('ID3DXFont::GetDC', 'no device context: answered NULL');
                return 0;
            } },
            /**
             * HRESULT GetGlyphData(UINT Glyph, LPDIRECT3DTEXTURE9 *ppTexture, RECT *pBlackBox,
             *     POINT *pCellInc)
             */
            { name: 'GetGlyphData', argBytes: 20, invoke: (object, args)=>{
                const [code, textureOut, box, cell] = args;
                const state = object.state;
                const glyph = glyphOf(state, code >>> 0);
                const thread = host.currentThread?.();
                return upload(state, thread).then(answer=>{
                    if ((textureOut >>> 0) !== 0)
                    {
                        putU32s(textureOut, [glyph.page >= 0 ? state.pages[glyph.page].texture
                            : 0]);
                    }
                    if ((box >>> 0) !== 0)
                    {
                        putU32s(box, [glyph.x, glyph.y, glyph.x + glyph.width,
                            glyph.y + glyph.height]);
                    }
                    if ((cell >>> 0) !== 0)
                    {
                        putU32s(cell, [glyph.advance, 0]);
                    }
                    return answer;
                });
            } },
            /** HRESULT PreloadCharacters(UINT First, UINT Last) */
            { name: 'PreloadCharacters', argBytes: 12, invoke: (object, [first, last])=>{
                for (let code = first >>> 0; code <= Math.min(last >>> 0, 0xffff); code++)
                {
                    glyphOf(object.state, code);
                }
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>upload(object.state, thread));
            } },
            /** HRESULT PreloadGlyphs(UINT First, UINT Last) */
            { name: 'PreloadGlyphs', argBytes: 12, invoke: ()=>D3D_OK },
            /** HRESULT PreloadTextA(LPCSTR pString, INT Count) */
            { name: 'PreloadTextA', argBytes: 12, invoke: (object, [text, count])=>{
                ansi(text, count | 0).forEach(code=>glyphOf(object.state, code));
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>upload(object.state, thread));
            } },
            /** HRESULT PreloadTextW(LPCWSTR pString, INT Count) */
            { name: 'PreloadTextW', argBytes: 12, invoke: (object, [text, count])=>{
                wide(text, count | 0).forEach(code=>glyphOf(object.state, code));
                const thread = host.currentThread?.();
                return Promise.resolve().then(()=>upload(object.state, thread));
            } },
            /**
             * INT DrawTextA(LPD3DXSPRITE pSprite, LPCSTR pString, INT Count, LPRECT pRect,
             *     DWORD Format, D3DCOLOR Color)
             */
            { name: 'DrawTextA', argBytes: 28, invoke: drawText((_, [at, n])=>ansi(at, n)) },
            /** INT DrawTextW(..., LPCWSTR pString, ...) */
            { name: 'DrawTextW', argBytes: 28, invoke: drawText((_, [at, n])=>wide(at, n)) },
            /** HRESULT OnLostDevice() */
            { name: 'OnLostDevice', argBytes: 4, invoke: ()=>D3D_OK },
            /** HRESULT OnResetDevice() */
            { name: 'OnResetDevice', argBytes: 4, invoke: ()=>D3D_OK },
        ],
    };

    /**
     * A font on `device` as D3DXCreateFont describes it, its pointer written to `out`.
     *
     * @param {number} device @param {FontDesc} desc @param {number} out
     * @returns {number}
     */
    const create = (device, desc, out)=>{
        const vtables = /** @type {NonNullable<FontHost['vtables']>} */ (host.vtables);
        const object = createComObject(IID_ID3DXFONT, { interfaces: [font],
            state: { device: device >>> 0, desc, logFont: logFontOf(desc), glyphs: new Map(),
                pages: [] } });
        const pointer = vtables.publish(object, IID_ID3DXFONT) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        putU32s(out, [pointer]);
        return D3D_OK;
    };

    return { create, layout, font };
}
