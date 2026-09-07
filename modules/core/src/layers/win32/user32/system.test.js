/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The painting and system-query halves of user32, over the same window records
 * the bookkeeping half keeps. What is checked here is what a wrong answer costs
 * rather than what the documentation says: a region that never clears is a
 * repaint loop, an enumeration that never ends is a hang, and a metric that
 * disagrees with the screen puts a window off the edge of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from './messages.js';
import { PAINTSTRUCT, RECT } from './structs.js';
import { createWindowFunctions } from './windows.js';

const CLASS_NAME = 0x10000;
const CLASS_STRUCT = 0x10100;
const TITLE = 0x10200;
const PAINT_BUFFER = 0x11000;
const RECT_BUFFER = 0x11200;
const TEXT_BUFFER = 0x11300;
const FORMAT_BUFFER = 0x11500;
const OUT_BUFFER = 0x11600;
const DEVMODE_BUFFER = 0x11800;

const WNDPROC = 0x401000;
const HINSTANCE = 0x400000;

const SCREEN = { width: 1024, height: 768, bitsPerPixel: 32 };

const WS_OVERLAPPED = 0x00000000;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_EX_CLIENTEDGE = 0x00000200;

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_CXVIRTUALSCREEN = 78;

/** Fills a buffer so that "wrote nothing" is distinguishable from "wrote zero". */
const UNTOUCHED = 0xa5a5a5a5;

function fakeMemory(size = 0x14000){
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
            return new TextDecoder('latin1').decode(bytes.subarray(address, end));
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
        /** @param {number} address @param {number[]} values */
        putU32s(address, values){
            values.forEach((value, index)=>{
                const at = address + (index * 4);
                bytes[at] = value & 0xff;
                bytes[at + 1] = (value >>> 8) & 0xff;
                bytes[at + 2] = (value >>> 16) & 0xff;
                bytes[at + 3] = (value >>> 24) & 0xff;
            });
        },
        /** @param {number} address */
        u32: address=>(bytes[address] | bytes[address + 1] << 8
            | bytes[address + 2] << 16 | bytes[address + 3] << 24) >>> 0,
        /** @param {number} address @param {number} count */
        fill(address, count){
            this.putU32s(address, new Array(count).fill(UNTOUCHED));
        },
    };
}

function fakeHandles(){
    /** @type {Map<number, any>} */
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
        close: handle=>entries.delete(handle),
    };
}

/**
 * A device-context service that counts, because GetDC and ReleaseDC are a pair
 * and a leak shows up as a count that never returns to zero.
 */
function fakeContexts(){
    let next = 0x900;
    const live = new Map();
    return {
        outstanding: ()=>live.size,
        service: {
            /** @param {number} hwnd */
            get(hwnd){
                const hdc = next;
                next += 4;
                live.set(hdc, hwnd);
                return hdc;
            },
            /** @param {number} hwnd @param {number} hdc */
            release(hwnd, hdc){
                return live.delete(hdc) ? 1 : 0;
            },
        },
    };
}

function setup(){
    const memory = fakeMemory();
    const queue = createMessageQueue();
    const contexts = fakeContexts();
    const fns = createWindowFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        queue,
        screen: SCREEN,
        dc: ()=>contexts.service,
        dispatch: ()=>0,
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
    });
    // Cast once: the table's handlers declare only the arguments they read, and
    // a guest call always arrives with the whole argument array.
    const table = /** @type {Record<string, { argBytes: number, convention?: string,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (fns));
    return { memory, queue, fns: table, contexts };
}

/** @param {any} memory @param {any} fns @param {number} [style] */
function makeWindow(memory, fns, style = WS_OVERLAPPED){
    memory.putString(CLASS_NAME, 'MainWnd');
    memory.putU32s(CLASS_STRUCT, [
        0x0003, WNDPROC, 0, 0, HINSTANCE, 0x11, 0x22, 0x33, 0, CLASS_NAME,
    ]);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    memory.putString(TITLE, 'Window');
    return fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, style, 0, 0, 320, 240, 0, 0, HINSTANCE, 0]);
}

// --- painting ---

test('BeginPaint fills the struct the guest allocated', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    memory.fill(PAINT_BUFFER, PAINTSTRUCT.SIZE / 4);

    const hdc = fns.BeginPaint.handler([hwnd, PAINT_BUFFER]);
    assert.notEqual(hdc, 0, 'a DC was made for the window');

    assert.equal(memory.u32(PAINT_BUFFER + PAINTSTRUCT.hdc), hdc);
    assert.deepEqual([
        memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + RECT.left),
        memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + RECT.top),
        memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + RECT.right),
        memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + RECT.bottom),
    ], [0, 0, 320, 240], 'a window with no partial damage paints all of itself');
    assert.equal(memory.u32(PAINT_BUFFER + PAINTSTRUCT.fRestore), 0);
});

test('BeginPaint clears the update region, so the next one has nothing to do', ()=>{
    // The whole reason these calls exist as a set. A region that is not cleared
    // means WM_PAINT for as long as the program runs, which looks like a hang
    // and has nothing to do with drawing.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);

    memory.putU32s(RECT_BUFFER, [10, 20, 110, 120]);
    fns.InvalidateRect.handler([hwnd, RECT_BUFFER, 0]);

    fns.BeginPaint.handler([hwnd, PAINT_BUFFER]);
    assert.deepEqual([
        memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + RECT.left),
        memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + RECT.right),
    ], [10, 110], 'the first paint gets what was invalidated');
    fns.EndPaint.handler([hwnd, PAINT_BUFFER]);

    memory.fill(RECT_BUFFER, 4);
    assert.equal(fns.GetUpdateRect.handler([hwnd, RECT_BUFFER, 0]), 0,
        'and afterwards there is nothing left dirty');
});

test('a DC taken is a DC given back', ()=>{
    const { memory, fns, contexts } = setup();
    const hwnd = makeWindow(memory, fns);

    const first = fns.GetDC.handler([hwnd]);
    const second = fns.GetDC.handler([hwnd]);
    assert.notEqual(first, second, 'two requests are two contexts');
    assert.equal(contexts.outstanding(), 2);

    assert.equal(fns.ReleaseDC.handler([hwnd, first]), 1);
    assert.equal(fns.ReleaseDC.handler([hwnd, second]), 1);
    assert.equal(contexts.outstanding(), 0, 'nothing is left held');
    assert.equal(fns.ReleaseDC.handler([hwnd, first]), 0,
        'releasing one already given back is a failure, not a second release');
});

// --- what the program asks about the system ---

test('the metrics agree with the screen this build was configured for', ()=>{
    // A metric that contradicts the configured screen makes a program centre
    // its window off the edge of it, and nothing about that failure points here.
    const { fns } = setup();

    assert.equal(fns.GetSystemMetrics.handler([SM_CXSCREEN]), SCREEN.width);
    assert.equal(fns.GetSystemMetrics.handler([SM_CYSCREEN]), SCREEN.height);
    assert.equal(fns.GetSystemMetrics.handler([SM_CXVIRTUALSCREEN]), SCREEN.width);
    assert.equal(fns.GetSystemMetrics.handler([0x7fff]), 0,
        'a metric with no answer is zero, not an invented number');
});

test('the display enumeration ends', ()=>{
    // A caller walks this until it returns FALSE. One that never does is a hang
    // with no error anywhere.
    const { memory, fns } = setup();
    memory.putU32s(DEVMODE_BUFFER, new Array(40).fill(0));
    // dmSize, at offset 0x24 of DEVMODEA, is what the caller declares.
    memory.bytes[DEVMODE_BUFFER + 0x24] = 156;

    assert.equal(fns.EnumDisplaySettingsA.handler([0, 0, DEVMODE_BUFFER]), 1,
        'the first mode exists');
    let index = 0;
    while (fns.EnumDisplaySettingsA.handler([0, index, DEVMODE_BUFFER]) !== 0)
    {
        index++;
        assert.ok(index < 1000, 'the enumeration did not terminate');
    }
    assert.ok(index >= 1, 'and it offered at least one mode before stopping');
});

test('AdjustWindowRectEx grows a client rectangle by the frame the style carries', ()=>{
    const { memory, fns } = setup();

    // A plain rectangle with no frame at all comes back unchanged.
    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRectEx.handler([RECT_BUFFER, 0, 0, 0]);
    assert.deepEqual([memory.u32(RECT_BUFFER), memory.u32(RECT_BUFFER + 8)], [0, 100]);

    // A caption and a sizing border push the top out furthest.
    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRectEx.handler([RECT_BUFFER, WS_CAPTION | WS_THICKFRAME, 0, 0]);
    const top = memory.u32(RECT_BUFFER + 4) | 0;
    const left = memory.u32(RECT_BUFFER) | 0;
    assert.ok(left < 0, 'the frame is outside the client area');
    assert.ok(top < left, 'and the caption makes the top the furthest out');

    // The extended style is the reason this call exists separately from
    // AdjustWindowRect: a client edge adds frame the plain style cannot express.
    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRectEx.handler([RECT_BUFFER, WS_CAPTION, 0, WS_EX_CLIENTEDGE]);
    const withEdge = memory.u32(RECT_BUFFER) | 0;
    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRectEx.handler([RECT_BUFFER, WS_CAPTION, 0, 0]);
    assert.ok(withEdge < (memory.u32(RECT_BUFFER) | 0),
        'the extended style adds frame rather than being ignored');
});

test('AdjustWindowRect is the same call without an extended style', ()=>{
    const { memory, fns } = setup();
    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRect.handler([RECT_BUFFER, WS_CAPTION, 0]);
    const plain = [memory.u32(RECT_BUFFER), memory.u32(RECT_BUFFER + 4)];

    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRectEx.handler([RECT_BUFFER, WS_CAPTION, 0, 0]);
    assert.deepEqual([memory.u32(RECT_BUFFER), memory.u32(RECT_BUFFER + 4)], plain);
});

test('wsprintfA reads its arguments off the stack and pops none of them', ()=>{
    // cdecl: the caller cleans up, so the count declared here says how many
    // slots to read. Declaring too few is a conversion that gets nothing.
    const { memory, fns } = setup();
    memory.putString(FORMAT_BUFFER, '%s scored %d of %d');
    memory.putString(TEXT_BUFFER, 'Player');

    const written = fns.wsprintfA.handler(
        [OUT_BUFFER, FORMAT_BUFFER, TEXT_BUFFER, 42, 100]);

    assert.equal(memory.readCString(OUT_BUFFER, 64), 'Player scored 42 of 100');
    assert.equal(written, 'Player scored 42 of 100'.length);
    assert.equal(fns.wsprintfA.convention, 'cdecl',
        'the caller pops these, and saying otherwise corrupts the guest stack');
    assert.ok(fns.wsprintfA.argBytes >= 8 + 4 * 4,
        'and enough slots are read for a format with several conversions');
});

test('capture is a pair: releasing clears what setting recorded', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);

    assert.equal(fns.SetCapture.handler([hwnd]), 0, 'nothing had it before');
    assert.equal(fns.GetCapture.handler([]), hwnd);
    assert.equal(fns.ReleaseCapture.handler([]), 1);
    assert.equal(fns.GetCapture.handler([]), 0,
        'a release that does not clear leaves a program believing it has the mouse');
});

test('EnableWindow answers with the state it found, not the one it set', ()=>{
    // The return is true when the window was *already* disabled, which is the
    // opposite way round from what the argument means -- and is the classic way
    // to read this backwards.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);

    assert.equal(fns.EnableWindow.handler([hwnd, 0]), 0, 'it was enabled');
    assert.equal(fns.EnableWindow.handler([hwnd, 0]), 1, 'and now it was disabled');
    assert.equal(fns.EnableWindow.handler([hwnd, 1]), 1);
    assert.equal(fns.EnableWindow.handler([hwnd, 1]), 0);
    assert.equal(fns.EnableWindow.handler([0x9999, 1]), 0, 'and a window that is not one');
});

test('a class long is class data: every window of a class reads the same value', ()=>{
    const { memory, fns } = setup();
    const first = makeWindow(memory, fns);
    const second = fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, 0, 0, 0, 100, 100, 0, 0, HINSTANCE, 0]);

    const GCL_HICON = -14;
    assert.equal(fns.GetClassLongA.handler([first, GCL_HICON]), 0x11);
    assert.equal(fns.SetClassLongA.handler([second, GCL_HICON, 0x77]), 0x11,
        'and setting through one answers with what the class held');
    assert.equal(fns.GetClassLongA.handler([first, GCL_HICON]), 0x77,
        'which the other window now reads too');

    fns.GetClassNameA.handler([first, OUT_BUFFER, 32]);
    assert.equal(memory.readCString(OUT_BUFFER, 32), 'MainWnd');
});
