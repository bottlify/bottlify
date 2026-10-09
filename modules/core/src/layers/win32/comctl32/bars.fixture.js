/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The toolbar's and the status bar's tests share this: the window manager
 * over the real drawing engine, the common controls registered through its
 * own hook with image lists and a module's bitmaps behind them, and a parent
 * window that records every message its procedure is sent. The drawing
 * engine is the graphics layer's, which a test hands in: only a test may
 * reach across the layers.
 */

import { createMessageQueue } from '../user32/messages.js';
import { createWindowFunctions } from '../user32/windows.js';
import { createGdiFunctions } from '../gdi32/functions.js';
import { createCommonControls } from './controls.js';
import { createImageLists } from './imagelist.js';
import { decodeAnsi } from '../kernel32/locale.js';

export const MSG_BUFFER = 0x13000;
export const TEXT = 0x13100;
export const OUT = 0x13200;
export const ITEM = 0x13400;
export const PIXELS = 0x14000;
const HEAP = 0x20000;
export const HINSTANCE = 0x400000;
const PARENTPROC = 0x401000;
const THREAD = { name: 'main' };

const SCREEN = { width: 320, height: 240, bitsPerPixel: 32 };

const WS_POPUP = 0x80000000;
export const WS_CHILD = 0x40000000;
export const WS_VISIBLE = 0x10000000;
const WS_CAPTION = 0x00c00000;
const PM_REMOVE = 1;

function fakeMemory(size = 0x40000){
    const bytes = new Uint8Array(size);
    // An address past the end faults, as one the guest never mapped does.
    /** @param {number} address @param {number} length */
    const mapped = (address, length)=>{
        if (address < 0 || address + length > size)
        {
            throw new Error(`Unmapped read at 0x${address.toString(16)}`);
        }
    };
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>{
            mapped(address, length);
            return bytes.slice(address, address + length);
        },
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            mapped(address, 1);
            let end = address;
            while (end < bytes.length && end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
        },
        /** @param {number} address @param {string} text */
        putString(address, text){
            for (let index = 0; index < text.length; index++)
            {
                bytes[address + index] = text.charCodeAt(index) & 0xff;
            }
            bytes[address + text.length] = 0;
            return address;
        },
        /** @param {number} address @param {string} text */
        putWide(address, text){
            for (let index = 0; index < text.length; index++)
            {
                bytes[address + index * 2] = text.charCodeAt(index) & 0xff;
                bytes[address + index * 2 + 1] = text.charCodeAt(index) >>> 8;
            }
            bytes[address + text.length * 2] = 0;
            bytes[address + text.length * 2 + 1] = 0;
            return address;
        },
        /** @param {number} address */
        u32: address=>(bytes[address] | bytes[address + 1] << 8 | bytes[address + 2] << 16
            | bytes[address + 3] << 24) >>> 0,
        /** @param {number} address */
        i32: address=>(bytes[address] | bytes[address + 1] << 8 | bytes[address + 2] << 16
            | bytes[address + 3] << 24) | 0,
        /** @param {number} address @param {number[]} values */
        put32s(address, values){
            values.forEach((value, index)=>{
                const at = address + index * 4;
                bytes[at] = value & 0xff;
                bytes[at + 1] = value >>> 8 & 0xff;
                bytes[at + 2] = value >>> 16 & 0xff;
                bytes[at + 3] = value >>> 24 & 0xff;
            });
        },
    };
}

function fakeHandles(){
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 4;
    return {
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            entries.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle */
        close(handle){
            entries.delete(handle);
        },
    };
}

/**
 * @param {Record<string, any>} gdiEngine  The graphics layer's createGdiDrawing,
 *     createSurface, surfaceForDdb, surfaceForDibSection and viewOf.
 */
export function setupBars(gdiEngine){
    const { createGdiDrawing, createSurface, surfaceForDdb, surfaceForDibSection,
        viewOf } = gdiEngine;
    const memory = fakeMemory();
    const handles = fakeHandles();
    const queue = createMessageQueue();
    const desktop = createSurface({ width: SCREEN.width, height: SCREEN.height });
    /** Every message the parent's procedure was sent. @type {any[]} */
    const sent = [];
    /** @type {string[]} */
    const divergences = [];
    /** The bitmap resources a module holds, by id. @type {Map<number, number>} */
    const resources = new Map();
    let heapNext = HEAP;
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = heapNext;
        heapNext += (bytes + 15) & ~15;
        return at;
    };

    /** The window manager's, once it has said: how a held DC is brought up to date. */
    let refreshContext = (/** @type {number} */ hdc)=>{
        void hdc;
    };
    const gdi = createGdiFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        windowContextCurrent: hdc=>refreshContext(hdc),
        handles,
        surfaces: { allocate, free: ()=>{} },
        screen: SCREEN,
        graphics: {
            createDrawing: (/** @type {any} */ options)=>createGdiDrawing(options),
            surfaceFor: (/** @type {any} */ dc, /** @type {any} */ bitmap)=>{
                if (dc.kind !== 'memory')
                {
                    return viewOf(desktop, dc.bounds
                        ?? { left: 0, top: 0, right: SCREEN.width, bottom: SCREEN.height });
                }
                if (bitmap.pixels)
                {
                    return surfaceForDdb(bitmap);
                }
                return bitmap.bits ? surfaceForDibSection(bitmap, memory.bytes, 0) : null;
            },
        },
    });
    const gdi32 = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (gdi.table));
    const imageLists = createImageLists({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        gdi32: name=>gdi32[name],
        bitmapSize: bitmap=>gdi.bitmapSize(bitmap),
    });

    const fns = createWindowFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        handles,
        queue,
        screen: SCREEN,
        dispatch: (wndProc, message)=>{
            sent.push({ ...message });
            return table.DefWindowProcA.handler(
                [message.hwnd, message.message, message.wParam, message.lParam]);
        },
        callerThread: ()=>THREAD,
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
        dc: ()=>({
            /** @param {number} hwnd @param {any} bounds */
            get: (hwnd, bounds = null)=>gdi.windowContext(hwnd, bounds),
            /** @param {number} hdc @param {any} bounds */
            rebind: (hdc, bounds)=>gdi.rebindWindowContext(hdc, bounds),
            /** @param {number} hwnd @param {number} hdc */
            release: (hwnd, hdc)=>gdi.table.ReleaseDC.handler([hwnd, hdc]),
        }),
        windowService: service=>{
            refreshContext = service.refreshContext;
        },
        draw: gdi.draw,
        /** @param {number} region @param {any} rect */
        setRegion: (region, rect)=>gdi.setRegion(region, rect),
        present: ()=>{},
        allocate,
        release: ()=>{},
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        registerControls: (controlHost, toolkit, register)=>{
            for (const definition of createCommonControls(controlHost, toolkit, imageLists, {
                loadBitmap: (instance, id)=>(instance === HINSTANCE
                    ? resources.get(id) ?? 0 : 0),
            }))
            {
                register(definition);
            }
        },
    });
    const table = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => any }>} */ (/** @type {unknown} */ (fns));
    /** @param {number[]} args @returns {any} */
    const send = args=>table.SendMessageA.handler(args);

    const pump = async()=>{
        for (let guard = 0; guard < 1000; guard++)
        {
            if (table.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]) === 0)
            {
                return;
            }
            table.TranslateMessage.handler([MSG_BUFFER]);
            await table.DispatchMessageA.handler([MSG_BUFFER]);
        }
        throw new Error('the queue never emptied');
    };

    let parent = 0;
    const makeParent = async(width = 300, height = 200)=>{
        const name = TEXT + 64;
        memory.putString(name, 'parent');
        const CLASS = name + 64;
        memory.put32s(CLASS, [0, PARENTPROC, 0, 0, HINSTANCE, 0, 0, 0, 0, name]);
        table.RegisterClassA.handler([CLASS]);
        parent = await table.CreateWindowExA.handler([0, name, name,
            WS_POPUP | WS_CAPTION | WS_VISIBLE, 0, 0, width, height, 0, 0, HINSTANCE, 0]);
        await pump();
        sent.length = 0;
        return parent;
    };

    /**
     * A control of a class on the parent, as a child with an id.
     *
     * @param {string} className @param {number} style
     * @param {number[]} [place]  x, y, width, height
     * @returns {Promise<number>}
     */
    const control = (className, style, [x, y, width, height] = [0, 0, 0, 0])=>{
        memory.putString(TEXT, className);
        return table.CreateWindowExA.handler([0, TEXT, 0, WS_CHILD | WS_VISIBLE | style,
            x, y, width, height, parent, 7, HINSTANCE, 0]);
    };

    /**
     * A 32-bit bitmap of `width` by `height`, each pixel from `colorAt`.
     *
     * @param {number} width @param {number} height
     * @param {(x: number, y: number) => number} colorAt
     */
    const bitmap = (width, height, colorAt)=>{
        for (let y = 0; y < height; y++)
        {
            for (let x = 0; x < width; x++)
            {
                memory.put32s(PIXELS + (y * width + x) * 4, [colorAt(x, y)]);
            }
        }
        return gdi32.CreateBitmap.handler([width, height, 1, 32, PIXELS]);
    };

    /** @param {number} hwnd */
    const windowRect = hwnd=>{
        table.GetWindowRect.handler([hwnd, OUT + 0x100]);
        return { left: memory.i32(OUT + 0x100), top: memory.i32(OUT + 0x104),
            right: memory.i32(OUT + 0x108), bottom: memory.i32(OUT + 0x10c) };
    };

    /** @param {number} hwnd */
    const clientSize = hwnd=>{
        table.GetClientRect.handler([hwnd, OUT + 0x100]);
        return { width: memory.i32(OUT + 0x108), height: memory.i32(OUT + 0x10c) };
    };

    /**
     * A point of a window's client area on the screen.
     *
     * @param {number} hwnd @param {number} x @param {number} y
     */
    const toScreen = (hwnd, x, y)=>{
        memory.put32s(OUT + 0x120, [x, y]);
        table.ClientToScreen.handler([hwnd, OUT + 0x120]);
        return { x: memory.i32(OUT + 0x120), y: memory.i32(OUT + 0x124) };
    };

    /**
     * A pixel of a window's client area, as the desktop shows it.
     *
     * @param {number} hwnd @param {number} x @param {number} y
     */
    const pixel = (hwnd, x, y)=>{
        const point = toScreen(hwnd, x, y);
        return desktop.read(point.x, point.y);
    };

    return { memory, desktop, fns: table, send, pump, sent, divergences, resources,
        makeParent, control, bitmap, windowRect, clientSize, toScreen, pixel, gdi32,
        lists: imageLists.functions };
}
