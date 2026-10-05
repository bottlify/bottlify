/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from '../user32/messages.js';
import { createWindowFunctions } from '../user32/windows.js';
import { createGdiFunctions } from '../gdi32/functions.js';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import { createSurface, surfaceForDibSection, viewOf } from '../../graphics/gdi/surface.js';
import { createCommonControls } from './controls.js';
import { decodeAnsi } from '../kernel32/locale.js';
import {
    PBM_SETRANGE, PBM_SETPOS, PBM_DELTAPOS, PBM_SETSTEP, PBM_STEPIT, PBM_SETRANGE32,
    PBM_GETRANGE, PBM_GETPOS, PBM_SETBARCOLOR, PBM_SETBKCOLOR, PBS_SMOOTH, PBS_VERTICAL,
} from './progress.js';

/**
 * The window manager over the real drawing engine, with the common controls
 * registered the way the process registers them: through the window manager's
 * own hook, so a progress bar here is the same class a program meets.
 */

const MSG_BUFFER = 0x13000;
const TEXT = 0x13100;
const OUT = 0x13200;
const HEAP = 0x18000;
const HINSTANCE = 0x400000;
const DIALOGPROC = 0x401000;
const THREAD = { name: 'main' };

const SCREEN = { width: 240, height: 160, bitsPerPixel: 32 };

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CAPTION = 0x00c00000;
const PM_REMOVE = 1;

const COLOR_3DFACE = 0x00c0c0c0;
const COLOR_HIGHLIGHT = 0x00000080;

function fakeMemory(size = 0x20000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
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
        /** @param {number} address */
        u32: address=>(bytes[address] | bytes[address + 1] << 8 | bytes[address + 2] << 16
            | bytes[address + 3] << 24) >>> 0,
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

function setup(){
    const memory = fakeMemory();
    const handles = fakeHandles();
    const queue = createMessageQueue();
    const desktop = createSurface({ width: SCREEN.width, height: SCREEN.height });
    let heapNext = HEAP;

    const gdi = createGdiFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        handles,
        surfaces: {
            allocate: bytes=>{
                const at = heapNext;
                heapNext += (bytes + 15) & ~15;
                return at;
            },
            free: ()=>{},
        },
        screen: SCREEN,
        graphics: {
            createDrawing: options=>createGdiDrawing(options),
            surfaceFor: (dc, bitmap)=>{
                if (dc.kind !== 'memory')
                {
                    return viewOf(desktop, dc.bounds
                        ?? { left: 0, top: 0, right: SCREEN.width, bottom: SCREEN.height });
                }
                return bitmap.bits ? surfaceForDibSection(bitmap, memory.bytes, 0) : null;
            },
        },
    });

    const fns = createWindowFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        handles,
        queue,
        screen: SCREEN,
        // The container's procedure is a guest address that does what a plain
        // procedure does: hand everything to the default, which is what
        // validates a paint and stops the queue refilling it.
        dispatch: (wndProc, message)=>table.DefWindowProcA.handler(
            [message.hwnd, message.message, message.wParam, message.lParam]),
        callerThread: ()=>THREAD,
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
        dc: ()=>({
            /** @param {number} hwnd @param {any} bounds */
            get: (hwnd, bounds = null)=>gdi.windowContext(hwnd, bounds),
            /** @param {number} hwnd @param {number} hdc */
            release: (hwnd, hdc)=>gdi.table.ReleaseDC.handler([hwnd, hdc]),
        }),
        draw: gdi.draw,
        present: ()=>{},
        allocate: bytes=>{
            const at = heapNext;
            heapNext += (bytes + 15) & ~15;
            return at;
        },
        release: ()=>{},
        registerControls: (controlHost, toolkit, register)=>{
            for (const definition of createCommonControls(controlHost, toolkit))
            {
                register(definition);
            }
        },
    });
    const table = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => any }>} */ (/** @type {unknown} */ (fns));

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

    /** A progress bar as a child of a bare top-level window. @param {number} style */
    const bar = async(style, x = 8, y = 8, width = 100, height = 16)=>{
        memory.putString(TEXT, 'msctls_progress32');
        return table.CreateWindowExA.handler([0, TEXT, 0, WS_CHILD | WS_VISIBLE | style,
            x, y, width, height, host_window.hwnd, 700, HINSTANCE, 0]);
    };

    /** @param {number} hwnd */
    const rectOf = hwnd=>{
        table.GetWindowRect.handler([hwnd, OUT]);
        return { left: memory.u32(OUT), top: memory.u32(OUT + 4),
            right: memory.u32(OUT + 8), bottom: memory.u32(OUT + 12) };
    };
    /** The middle row of a bar's client, inside its sunken edge. @param {number} hwnd */
    const barRow = hwnd=>{
        const r = rectOf(hwnd);
        const y = Math.floor((r.top + r.bottom) / 2);
        const row = [];
        for (let x = r.left + 3; x < r.right - 3; x++)
        {
            row.push(desktop.read(x, y));
        }
        return row;
    };
    /** The middle column of a bar's client. @param {number} hwnd */
    const barColumn = hwnd=>{
        const r = rectOf(hwnd);
        const x = Math.floor((r.left + r.right) / 2);
        const column = [];
        for (let y = r.top + 3; y < r.bottom - 3; y++)
        {
            column.push(desktop.read(x, y));
        }
        return column;
    };
    /** @param {number} hwnd @param {number} fx @param {number} fy */
    const barPixel = (hwnd, fx, fy)=>{
        const r = rectOf(hwnd);
        return desktop.read(Math.floor(r.left + (r.right - r.left) * fx),
            Math.floor(r.top + (r.bottom - r.top) * fy));
    };

    const host_window = { hwnd: 0 };
    return { memory, desktop, gdi, fns: table, pump, bar, barRow, barColumn, barPixel,
        makeHost: async()=>{
            const name = TEXT + 64;
            memory.putString(name, 'host');
            const CLASS = name + 64;
            [0, DIALOGPROC, 0, 0, HINSTANCE, 0, 0, 0, 0, name].forEach((value, index)=>{
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, value, true);
                memory.writeMemory(CLASS + index * 4, bytes);
            });
            table.RegisterClassA.handler([CLASS]);
            host_window.hwnd = await table.CreateWindowExA.handler([0, name, name,
                WS_POPUP | WS_CAPTION | WS_VISIBLE, 0, 0, 220, 150, 0, 0, HINSTANCE, 0]);
            await pump();
            return host_window.hwnd;
        } };
}

test('a progress bar is a class a program creates by name', async()=>{
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(0);
    assert.notEqual(bar, 0, 'msctls_progress32 resolves to a window');
    // The default range is 0..100 and the position starts at the bottom.
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_GETPOS, 0, 0]), 0);
    context.memory.writeMemory(OUT, new Uint8Array(8));
    context.fns.SendMessageA.handler([bar, PBM_GETRANGE, 0, OUT]);
    assert.deepEqual([context.memory.u32(OUT), context.memory.u32(OUT + 4)], [0, 100]);
});

test('SETRANGE keeps the previous range and SETPOS the previous position', async()=>{
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(0);
    // MAKELPARAM(0, 100) is the default; setting 0..50 answers the old one.
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_SETRANGE, 0, (50 << 16) | 0]),
        (100 << 16) | 0, 'the previous range, packed');
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_SETPOS, 25, 0]), 0,
        'the previous position');
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_GETPOS, 0, 0]), 25);
    // A position past the top is clamped to it, not stored as asked.
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_SETPOS, 90, 0]), 25);
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_GETPOS, 0, 0]), 50);
});

test('SETRANGE32 takes two full widths where SETRANGE takes one packed pair', async()=>{
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(0);
    context.fns.SendMessageA.handler([bar, PBM_SETRANGE32, 1000, 2000]);
    context.memory.writeMemory(OUT, new Uint8Array(8));
    context.fns.SendMessageA.handler([bar, PBM_GETRANGE, 0, OUT]);
    assert.deepEqual([context.memory.u32(OUT), context.memory.u32(OUT + 4)], [1000, 2000]);
});

test('DELTAPOS moves by an amount and STEPIT by the step, wrapping at the top',
    async()=>{
        const context = setup();
        await context.makeHost();
        const bar = await context.bar(0);
        context.fns.SendMessageA.handler([bar, PBM_SETRANGE, 0, (20 << 16) | 0]);
        assert.equal(context.fns.SendMessageA.handler([bar, PBM_DELTAPOS, 7, 0]), 0);
        assert.equal(context.fns.SendMessageA.handler([bar, PBM_GETPOS, 0, 0]), 7);
        context.fns.SendMessageA.handler([bar, PBM_SETSTEP, 10, 0]);
        assert.equal(context.fns.SendMessageA.handler([bar, PBM_STEPIT, 0, 0]), 7);
        assert.equal(context.fns.SendMessageA.handler([bar, PBM_GETPOS, 0, 0]), 17);
        // One more step of ten past twenty comes back around at the bottom.
        context.fns.SendMessageA.handler([bar, PBM_STEPIT, 0, 0]);
        assert.equal(context.fns.SendMessageA.handler([bar, PBM_GETPOS, 0, 0]), 6,
            'the step that overflowed wrapped');
    });

test('SETBARCOLOR and SETBKCOLOR answer the colour they replace', async()=>{
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(PBS_SMOOTH);
    // The colours a bar starts with are the system's, as COLORREFs (blue in
    // the high byte); the desktop reads back pixels, the order reversed.
    const HIGHLIGHT_REF = 0x00800000;
    const FACE_REF = 0x00c0c0c0;
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_SETBARCOLOR, 0x00ffffff, 0]),
        HIGHLIGHT_REF, 'the bar was the highlight until now');
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_SETBKCOLOR, 0x000000ff, 0]),
        FACE_REF, 'and the track was the dialog face');
    context.fns.SendMessageA.handler([bar, PBM_SETPOS, 100, 0]);
    await context.pump();
    // White is its own byte reversal, so the pixel and the COLORREF agree.
    assert.equal(context.barPixel(bar, 0.5, 0.5), 0x00ffffff,
        'the fill is the colour the program set');
});

test('the default look is blocks and PBS_SMOOTH is one rectangle', async()=>{
    const context = setup();
    await context.makeHost();
    const blocky = await context.bar(0);
    context.fns.SendMessageA.handler([blocky, PBM_SETPOS, 100, 0]);
    await context.pump();
    // Walk the middle row of a full bar: blocks leave two-pixel gaps of track.
    const row = context.barRow(blocky);
    assert.ok(row.includes(COLOR_3DFACE), 'a blocked bar shows gaps between blocks');

    const smooth = await context.bar(PBS_SMOOTH, 8, 40);
    context.fns.SendMessageA.handler([smooth, PBM_SETPOS, 100, 0]);
    await context.pump();
    const filled = context.barRow(smooth).filter(pixel=>pixel === COLOR_HIGHLIGHT);
    assert.ok(filled.length > 40, 'a smooth bar fills the track in one run');
});

test('PBS_VERTICAL fills from the bottom up', async()=>{
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(PBS_VERTICAL | PBS_SMOOTH, 120, 8, 16, 60);
    context.fns.SendMessageA.handler([bar, PBM_SETPOS, 50, 0]);
    await context.pump();
    const column = context.barColumn(bar);
    const firstFill = column.indexOf(COLOR_HIGHLIGHT);
    assert.ok(firstFill > 0, 'the top of a half bar is track');
    assert.ok(column.slice(firstFill).every(pixel=>pixel === COLOR_HIGHLIGHT),
        'and everything below the fill line is the bar');
});

test('SETPOS, DELTAPOS and STEPIT show the bar at once, with no message pumped', async()=>{
    // An installer's copy loop moves its bar and never looks at its queue.
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(PBS_SMOOTH);
    await context.pump();
    const filled = ()=>context.barRow(bar).filter(pixel=>pixel === COLOR_HIGHLIGHT).length;
    assert.equal(filled(), 0);
    context.fns.SendMessageA.handler([bar, PBM_SETPOS, 50, 0]);
    const half = filled();
    assert.ok(half > 0, 'SETPOS');
    context.fns.SendMessageA.handler([bar, PBM_DELTAPOS, 25, 0]);
    const more = filled();
    assert.ok(more > half, 'DELTAPOS');
    context.fns.SendMessageA.handler([bar, PBM_SETSTEP, 25, 0]);
    context.fns.SendMessageA.handler([bar, PBM_STEPIT, 0, 0]);
    assert.ok(filled() > more, 'STEPIT');
});

test('a position set again where it was paints nothing; a moved one paints at once', async()=>{
    // A setup copying a kilobyte at a time sets the same position after every
    // one, hundreds of thousands of times; the real control paints when the
    // position moves (Wine's progress.c), and DELTAPOS by nothing is no move.
    const MARK = 0x00123456;
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(PBS_SMOOTH);
    await context.pump();
    context.fns.SendMessageA.handler([bar, PBM_SETPOS, 50, 0]);
    context.fns.GetWindowRect.handler([bar, 0x6000]);
    const [left, top] = [context.memory.u32(0x6000), context.memory.u32(0x6004)];
    const marked = ()=>context.desktop.read(left + 5, top + 8) === MARK;
    context.desktop.write(left + 5, top + 8, MARK);
    assert.equal(context.fns.SendMessageA.handler([bar, PBM_SETPOS, 50, 0]), 50);
    assert.ok(marked(), 'the same position: not painted');
    context.fns.SendMessageA.handler([bar, PBM_DELTAPOS, 0, 0]);
    assert.ok(marked(), 'a move by nothing: not painted');
    context.fns.SendMessageA.handler([bar, PBM_SETPOS, 60, 0]);
    assert.ok(!marked(), 'a new position: painted');
});

test('a bar paints its track and fill on WM_PAINT', async()=>{
    const context = setup();
    await context.makeHost();
    const bar = await context.bar(0);
    context.fns.SendMessageA.handler([bar, PBM_SETPOS, 100, 0]);
    await context.pump();
    const row = context.barRow(bar);
    assert.ok(row.includes(COLOR_HIGHLIGHT), 'a full bar shows its fill');
});
