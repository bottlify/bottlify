/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The helpers comctl32 has exported since Windows 95 beside its controls: a
 * toolbar made in one call, a bitmap with its colours mapped to the system's,
 * and the drag list -- the last three by ordinal as often as by name.
 *
 * Each is built from the calls a program would make itself: the toolbar is
 * CreateWindowEx and the toolbar's own messages, the bitmap is user32's
 * LoadImage and gdi32's bits, the hit test is the list box's own messages.
 */

import { TB_ADDBITMAP, TB_ADDBUTTONSA, TB_BUTTONSTRUCTSIZE, TB_SETBITMAPSIZE,
    TB_SETBUTTONSIZE, TOOLBAR_CLASS } from './toolbar.js';
import { createRefusals } from '../common/refusal.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { after } from '../user32/controls.js';

const WS_CHILD = 0x40000000;
const IMAGE_BITMAP = 0;

/** The list box messages a hit test asks. */
const LB_GETCOUNT = 0x018b;
const LB_GETTOPINDEX = 0x018e;
const LB_SETTOPINDEX = 0x0197;
const LB_GETITEMRECT = 0x0198;

/** How often a drag held past a list box's edge scrolls it, in milliseconds. */
const SCROLL_INTERVAL = 200;

/** The system colours CreateMappedBitmap's default map maps to. */
const COLOR_BTNFACE = 15;
const COLOR_BTNSHADOW = 16;
const COLOR_BTNTEXT = 18;
const COLOR_BTNHIGHLIGHT = 20;

/**
 * The colours a button bitmap is drawn in, and which system colour each
 * becomes when no map is given: black is button text, grey the shadow,
 * silver the face, white the highlight.
 *
 * @type {readonly [number, number][]}
 */
const DEFAULT_MAP = Object.freeze([[0x000000, COLOR_BTNTEXT], [0x808080, COLOR_BTNSHADOW],
    [0xc0c0c0, COLOR_BTNFACE], [0xffffff, COLOR_BTNHIGHLIGHT]]);

/** The most entries a colour map is read for. */
const MAX_MAP = 0x100;

/**
 * @typedef {Object} HelperHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [user32]
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [gdi32]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [release]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {() => number} [now]  Milliseconds, for the drag list's scroll
 *           pace; the wall clock when absent.
 */

/** @param {Uint8Array} bytes @param {number} at */
const i32 = (bytes, at)=>bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24;

/**
 * @param {HelperHost} host
 */
export function createHelperFunctions(host){
    const refuse = createRefusals(host);

    /**
     * One of user32's or gdi32's exports called as a program calls it; null
     * when it is not there.
     *
     * @param {'user32' | 'gdi32'} library @param {string} name @param {number[]} args
     * @returns {any}
     */
    const api = (library, name, args)=>{
        const entry = host[library]?.(name);
        return entry ? entry.handler(args) : null;
    };

    /**
     * Guest memory for the length of `use`, which may answer later; `failed`
     * when there is none to be had.
     *
     * @template T
     * @param {number} bytes @param {(block: number) => T} use @param {T} failed
     * @returns {T}
     */
    const withBlock = (bytes, use, failed)=>{
        const block = host.allocate?.(bytes) ?? 0;
        if (block === 0)
        {
            return failed;
        }
        const release = ()=>host.release?.(block);
        let answer;
        try
        {
            answer = use(block);
        }
        catch (e){
            release();
            throw e;
        }
        return after(answer, (/** @type {any} */ settled)=>{
            release();
            return settled;
        });
    };

    /** When a drag list last scrolled. */
    let lastScroll = -Infinity;

    return {
        /**
         * HWND CreateToolbarEx(HWND hwnd, DWORD ws, UINT wID, int nBitmaps,
         *     HINSTANCE hBMInst, UINT_PTR wBMID, LPCTBBUTTON lpButtons, int iNumButtons,
         *     int dxButton, int dyButton, int dxBitmap, int dyBitmap, UINT uStructSize)
         *
         * A toolbar child of the window with the id given, told its button
         * structure's size, its image and button sizes where they are given,
         * the bitmap's images where there are any -- a module's resource, or
         * with no module a bitmap handle -- and its buttons. NULL when the
         * window could not be made.
         */
        CreateToolbarEx: {
            argBytes: 52,
            /** @param {number[]} args */
            handler: ([parent, style, id, bitmaps, instance, bitmapId, buttons, count,
                buttonX, buttonY, bitmapX, bitmapY, structSize])=>{
                if (!host.user32)
                {
                    host.divergence?.('CreateToolbarEx',
                        'no window manager to make a toolbar with');
                    return 0;
                }
                const name = encodeAnsi(`${TOOLBAR_CLASS}\0`);
                return withBlock(name.length + 8, block=>{
                    host.writeMemory(block, name);
                    const made = api('user32', 'CreateWindowExA', [0, block, 0,
                        (style | WS_CHILD) >>> 0, 0, 0, 100, 30, parent, id, 0, 0]);
                    return after(made, (/** @type {number} */ hwnd)=>{
                        if ((hwnd >>> 0) === 0)
                        {
                            return 0;
                        }
                        /** @param {number} message @param {number} wParam @param {number} lParam */
                        const send = (message, wParam, lParam)=>()=>api('user32', 'SendMessageA',
                            [hwnd, message, wParam, lParam]);
                        const table = new Uint8Array(8);
                        new DataView(table.buffer).setUint32(0, instance >>> 0, true);
                        new DataView(table.buffer).setUint32(4, bitmapId >>> 0, true);
                        host.writeMemory(block + name.length, table);
                        const steps = [send(TB_BUTTONSTRUCTSIZE, structSize >>> 0, 0)];
                        if ((bitmapX | 0) > 0 && (bitmapY | 0) > 0)
                        {
                            steps.push(send(TB_SETBITMAPSIZE, 0,
                                ((bitmapY & 0xffff) << 16 | bitmapX & 0xffff) >>> 0));
                        }
                        if ((buttonX | 0) > 0 && (buttonY | 0) > 0)
                        {
                            steps.push(send(TB_SETBUTTONSIZE, 0,
                                ((buttonY & 0xffff) << 16 | buttonX & 0xffff) >>> 0));
                        }
                        if ((bitmaps | 0) > 0)
                        {
                            steps.push(send(TB_ADDBITMAP, bitmaps | 0, block + name.length));
                        }
                        if ((count | 0) > 0 && (buttons >>> 0) !== 0)
                        {
                            steps.push(send(TB_ADDBUTTONSA, count | 0, buttons >>> 0));
                        }
                        return after(steps.reduce((done, step)=>after(done, step),
                            /** @type {any} */ (0)), ()=>hwnd >>> 0);
                    });
                }, 0);
            },
        },

        /**
         * HBITMAP CreateMappedBitmap(HINSTANCE hInstance, INT_PTR idBitmap,
         *     UINT wFlags, LPCOLORMAP lpColorMap, int iNumMaps)
         *
         * Ordinal 8. A module's bitmap resource with each colour a map names
         * replaced: the caller's COLORMAP pairs, or with none the button
         * colours (`DEFAULT_MAP`) made the system's. CMB_MASKED asks for
         * nothing this answer would draw differently and is not acted on.
         * NULL when the resource is not there.
         */
        CreateMappedBitmap: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([instance, id, , map, entries])=>{
                const bitmap = (api('user32', 'LoadImageA', [instance, id, IMAGE_BITMAP, 0, 0,
                    0]) ?? 0) >>> 0;
                if (bitmap === 0)
                {
                    return 0;
                }
                /** @type {[number, number][]} */
                const pairs = (map >>> 0) !== 0 && (entries | 0) > 0
                    ? Array.from({ length: Math.min(entries | 0, MAX_MAP) }, (_, at)=>{
                        const pair = host.readMemory((map >>> 0) + at * 8, 8);
                        return [i32(pair, 0) & 0xffffff, i32(pair, 4) & 0xffffff];
                    })
                    : DEFAULT_MAP.map(([from, index])=>[from,
                        (api('user32', 'GetSysColor', [index]) ?? from) & 0xffffff]);
                if (!host.gdi32)
                {
                    host.divergence?.('CreateMappedBitmap',
                        'no gdi32 to reach the bits: the bitmap is not mapped');
                    return bitmap;
                }
                return withBlock(24, info=>{
                    if ((api('gdi32', 'GetObjectA', [bitmap, 24, info]) ?? 0) === 0)
                    {
                        return bitmap;
                    }
                    const header = host.readMemory(info, 24);
                    const depth = header[18] | header[19] << 8;
                    const size = i32(header, 12) * Math.abs(i32(header, 8));
                    if (depth !== 32 && depth !== 24)
                    {
                        host.divergence?.('CreateMappedBitmap',
                            `a ${depth}-bit bitmap's colours are not mapped`);
                        return bitmap;
                    }
                    return withBlock(size, bits=>{
                        api('gdi32', 'GetBitmapBits', [bitmap, size, bits]);
                        const pixels = host.readMemory(bits, size).slice();
                        const step = depth >>> 3;
                        const rowBytes = i32(header, 12);
                        const across = i32(header, 4);
                        for (let row = 0; row + rowBytes <= pixels.length; row += rowBytes)
                        {
                            for (let at = row; at < row + across * step; at += step)
                            {
                                const rgb = pixels[at + 2] | pixels[at + 1] << 8 | pixels[at] << 16;
                                const found = pairs.find(([from])=>from === rgb);
                                if (found)
                                {
                                    pixels[at] = found[1] >>> 16 & 0xff;
                                    pixels[at + 1] = found[1] >>> 8 & 0xff;
                                    pixels[at + 2] = found[1] & 0xff;
                                }
                            }
                        }
                        host.writeMemory(bits, pixels);
                        api('gdi32', 'SetBitmapBits', [bitmap, size, bits]);
                        return bitmap;
                    }, bitmap);
                }, bitmap);
            },
        },

        /**
         * BOOL MakeDragList(HWND hLB)
         *
         * Ordinal 13. Would make a list box send its parent the drag-list
         * notifications as an item is dragged; the list box here sends none,
         * and the call fails as it does when the list box cannot be
         * subclassed, so a program knows its items will not be dragged.
         */
        MakeDragList: refuse('MakeDragList', { argBytes: 4, answer: 0,
            why: 'a list box is not made a drag list: no drag notifications are sent' }),

        /**
         * int LBItemFromPt(HWND hLB, POINT pt, BOOL bAutoScroll)
         *
         * Ordinal 14. The item of a list box under a point on the screen, or
         * -1. A point above or below the list, with bAutoScroll, scrolls it
         * one item that way -- no more often than every 200 ms, so a drag
         * held there scrolls at a pace -- and is still -1.
         */
        LBItemFromPt: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([list, x, y, scroll])=>{
                if (!host.user32)
                {
                    return -1;
                }
                /** @param {number} message @param {number} wParam @param {number} lParam */
                const send = (message, wParam, lParam)=>api('user32', 'SendMessageA',
                    [list, message, wParam, lParam]);
                const answer = withBlock(32, block=>{
                    host.writeMemory(block, Uint8Array.from([...new Uint8Array(new Int32Array(
                        [x | 0, y | 0]).buffer)]));
                    if (!api('user32', 'ScreenToClient', [list, block])
                        || !api('user32', 'GetClientRect', [list, block + 8]))
                    {
                        return -1;
                    }
                    const read = host.readMemory(block, 24);
                    const [px, py] = [i32(read, 0), i32(read, 4)];
                    const [left, top, right, bottom] = [8, 12, 16, 20].map(at=>i32(read, at));
                    const first = (send(LB_GETTOPINDEX, 0, 0) ?? 0) | 0;
                    const count = (send(LB_GETCOUNT, 0, 0) ?? 0) | 0;
                    if (px < left || px >= right || py < top || py >= bottom)
                    {
                        const now = host.now?.() ?? Date.now();
                        if ((scroll | 0) !== 0 && px >= left && px < right
                            && now - lastScroll >= SCROLL_INTERVAL)
                        {
                            const to = py < top ? first - 1 : first + 1;
                            if (to >= 0 && to < count)
                            {
                                lastScroll = now;
                                send(LB_SETTOPINDEX, to, 0);
                            }
                        }
                        return -1;
                    }
                    for (let index = Math.max(0, first); index < count; index++)
                    {
                        if (((send(LB_GETITEMRECT, index, block + 8) ?? -1) | 0) === -1)
                        {
                            return -1;
                        }
                        const item = host.readMemory(block + 8, 16);
                        const [itemTop, itemBottom] = [i32(item, 4), i32(item, 12)];
                        if (itemTop > bottom)
                        {
                            return -1;
                        }
                        if (px >= i32(item, 0) && px < i32(item, 8) && py >= itemTop
                            && py < itemBottom)
                        {
                            return index;
                        }
                    }
                    return -1;
                }, -1);
                return answer;
            },
        },
    };
}
