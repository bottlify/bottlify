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
import { ANY_WINDOW, WM_TIMER, createMessageQueue } from './messages.js';
import { DEVMODEA, DM_BITSPERPEL, PAINTSTRUCT, RECT } from './structs.js';
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
const WS_VISIBLE = 0x10000000;

const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const SM_CXVIRTUALSCREEN = 78;

const DISP_CHANGE_SUCCESSFUL = 0;
const DISP_CHANGE_BADMODE = -2;

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

/**
 * @param {Object} [options]
 * @param {{ x: number, y: number }} [options.cursor] Where the host says the
 *        pointer is, for the queries a game polls instead of reading messages.
 * @param {(key: number) => number} [options.keyState]
 * @param {(instance: number, type: number, name: number | string) => unknown}
 *        [options.findResource]
 *        Which resources the program's own image carries.
 * @param {(wndProc: number, message: any) => number} [options.dispatch]
 *        What a window procedure answers; nothing unless given.
 */
function setup({ cursor, keyState, findResource, dispatch = ()=>0 } = {}){
    const memory = fakeMemory();
    const clock = { at: 0 };
    const queue = createMessageQueue({ now: ()=>clock.at });
    const contexts = fakeContexts();
    /** @type {any[]} */
    const notices = [];
    /** @type {string[]} */
    const said = [];
    /** @type {string[]} */
    const diverged = [];
    const fns = createWindowFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        queue,
        screen: SCREEN,
        dc: ()=>contexts.service,
        dispatch,
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
        cursor: cursor && (()=>cursor),
        keyState,
        findResource,
        /** @param {any} notice */
        messageBox: notice=>notices.push(notice),
        /** @param {string} text */
        say: text=>said.push(text),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
    });
    // Cast once: the table's handlers declare only the arguments they read, and
    // a guest call always arrives with the whole argument array.
    const table = /** @type {Record<string, { argBytes: number, convention?: string,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (fns));
    return { memory, queue, fns: table, contexts, clock, notices, said, diverged };
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

test('RedrawWindow invalidates, validates and updates as its flags say', ()=>{
    const { memory, fns, queue } = setup();
    const hwnd = makeWindow(memory, fns);
    const RDW_INVALIDATE = 0x0001;
    const RDW_ERASE = 0x0004;
    const RDW_VALIDATE = 0x0008;
    const RDW_UPDATENOW = 0x0100;

    assert.equal(fns.RedrawWindow.argBytes, 16);
    memory.putU32s(RECT_BUFFER, [10, 20, 110, 120]);
    assert.equal(fns.RedrawWindow.handler([hwnd, RECT_BUFFER, 0, RDW_INVALIDATE | RDW_ERASE]), 1);
    memory.fill(OUT_BUFFER, 4);
    assert.equal(fns.GetUpdateRect.handler([hwnd, OUT_BUFFER, 0]), 1);
    assert.equal(memory.u32(OUT_BUFFER + RECT.right), 110, 'the rectangle given is what is dirty');
    assert.equal(queue.depth(), 0, 'and nothing was posted yet');

    assert.equal(fns.RedrawWindow.handler([hwnd, 0, 0, RDW_UPDATENOW]), 1);
    assert.equal(queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true })?.message,
        0x000f, 'RDW_UPDATENOW is a WM_PAINT');

    assert.equal(fns.RedrawWindow.handler([hwnd, 0, 0, RDW_VALIDATE]), 1);
    assert.equal(fns.GetUpdateRect.handler([hwnd, OUT_BUFFER, 0]), 0, 'validated: nothing dirty');
    assert.equal(fns.RedrawWindow.handler([0x9999, 0, 0, RDW_INVALIDATE]), 0);
});

test('SetRect writes the four sides, and PtInRect is closed on the left and top only', ()=>{
    const { memory, fns } = setup();

    assert.equal(fns.SetRect.handler([RECT_BUFFER, 10, 20, 30, 40]), 1);
    assert.deepEqual([RECT.left, RECT.top, RECT.right, RECT.bottom].map(at=>
        memory.u32(RECT_BUFFER + at)), [10, 20, 30, 40]);
    assert.equal(fns.SetRect.handler([0, 1, 2, 3, 4]), 0);

    assert.equal(fns.PtInRect.argBytes, 12, 'the point travels by value');
    assert.equal(fns.PtInRect.handler([RECT_BUFFER, 10, 20]), 1);
    assert.equal(fns.PtInRect.handler([RECT_BUFFER, 29, 39]), 1);
    assert.equal(fns.PtInRect.handler([RECT_BUFFER, 30, 20]), 0, 'the right edge is outside');
    assert.equal(fns.PtInRect.handler([RECT_BUFFER, 10, 40]), 0, 'and so is the bottom');
    assert.equal(fns.PtInRect.handler([RECT_BUFFER, -1, 20]), 0);
});

test('SetCursor answers with the cursor it replaced, and GetCursor with the current one', ()=>{
    const { fns } = setup();

    assert.equal(fns.GetCursor.handler([]), 0);
    assert.equal(fns.SetCursor.handler([0x300]), 0);
    assert.equal(fns.GetCursor.handler([]), 0x300);
    assert.equal(fns.SetCursor.handler([0x400]), 0x300);
    assert.equal(fns.SetCursor.handler([0]), 0x400);
    assert.equal(fns.GetCursor.handler([]), 0);
});

test('SendMessageTimeoutA is a send whose answer goes out through the pointer', async()=>{
    const { memory, fns } = setup({ dispatch: (wndProc, message)=>message.wParam * 2 });
    const hwnd = makeWindow(memory, fns);
    const SMTO_NORMAL = 0;

    assert.equal(fns.SendMessageTimeoutA.argBytes, 28);
    memory.putU32s(OUT_BUFFER, [0xffffffff]);
    assert.equal(await fns.SendMessageTimeoutA.handler(
        [hwnd, 0x0400, 21, 0, SMTO_NORMAL, 1000, OUT_BUFFER]), 1);
    assert.equal(memory.u32(OUT_BUFFER), 42, 'the procedure answered in time, as it always does');
    assert.equal(fns.SendMessageTimeoutA.handler([0x9999, 0x0400, 0, 0, 0, 1000, OUT_BUFFER]), 0);
});

test('DrawIcon succeeds without painting, and says so once', ()=>{
    const { fns, diverged } = setup();

    assert.equal(fns.DrawIcon.argBytes, 16);
    assert.equal(fns.DrawIcon.handler([0x100, 4, 4, 0x200]), 1);
    assert.equal(fns.DrawIcon.handler([0x100, 4, 4, 0x200]), 1);
    assert.equal(diverged.length, 1, 'a progress display draws its icon on every tick');
    assert.match(diverged[0], /^DrawIcon: /);
});

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
    // A 1024x768 display of the era offers 640x480, 800x600 and 1024x768; a
    // program's resolution menu is built from exactly this walk.
    assert.equal(index, 3, 'every size up to the display, and then the end');
    const last = memory.u32(DEVMODE_BUFFER + DEVMODEA.dmPelsWidth);
    assert.equal(last, SCREEN.width, 'the largest listed is the display itself');
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

test('a banner bitmap and a program-manager conversation are refused with the stack intact', ()=>{
    // Neither has an implementation to offer, and both were reaching the
    // missing-import stub, which pops nothing: an installer painting its
    // banner from a bitmap left eight bytes on its stack per attempt and
    // returned into them.
    const { fns } = setup();
    assert.equal(fns.LoadBitmapA.handler([0x400000, 101]), 0);
    assert.equal(fns.LoadBitmapA.argBytes, 8);
    assert.equal(fns.DdeInitializeA.handler([0x1000, 0x2000, 0, 0]), 0x400f,
        'DMLERR_SYS_ERROR: the exchange is not available, which a program handles');
    assert.equal(fns.DdeInitializeA.argBytes, 16);
    assert.equal(fns.DdeCreateStringHandleA.handler([1, 0x100, 0]), 0);
    assert.equal(fns.DdeNameService.handler([1, 0, 0, 1]), 0);
    assert.equal(fns.DdeNameService.argBytes, 16);
});

test('a DDE client finds no server, and each refusal pops what it was pushed', ()=>{
    const { fns } = setup();
    assert.equal(fns.DdeConnect.handler([1, 0, 0, 0]), 0);
    assert.equal(fns.DdeClientTransaction.handler([0, 0, 0, 0, 1, 0x4050, 1000, 0]), 0);
    assert.equal(fns.DdeCreateDataHandle.handler([1, 0, 0, 0, 0, 1, 0]), 0);
    assert.equal(fns.DdeGetData.handler([0, 0, 0, 0]), 0);
    assert.equal(fns.DdeQueryStringA.handler([1, 0, 0, 0, 0]), 0);
    assert.equal(fns.DdeDisconnect.handler([0]), 0);
    assert.equal(fns.DdeGetLastError.handler([1]), 0, 'DMLERR_NO_ERROR');
    assert.deepEqual(
        ['DdeConnect', 'DdeDisconnect', 'DdeClientTransaction', 'DdeCreateDataHandle',
            'DdeGetData', 'DdeQueryStringA', 'DdeGetLastError'].map(name=>fns[name].argBytes),
        [16, 4, 32, 28, 16, 20, 4]);
});

test('CharNext walks a string a byte at a time and stops at its end', ()=>{
    // A program walks a path with this and stops when the pointer stops
    // moving; a stub that answered zero sent it on to copy from address zero.
    const { memory, fns } = setup();
    memory.putString(TEXT_BUFFER, 'ab');

    assert.equal(fns.CharNextA.handler([TEXT_BUFFER]), TEXT_BUFFER + 1);
    assert.equal(fns.CharNextA.handler([TEXT_BUFFER + 2]), TEXT_BUFFER + 2,
        'the terminator is where it stays');
    assert.equal(fns.CharNextA.handler([0]), 0);
    assert.equal(fns.CharPrevA.handler([TEXT_BUFFER, TEXT_BUFFER + 2]), TEXT_BUFFER + 1);
    assert.equal(fns.CharPrevA.handler([TEXT_BUFFER, TEXT_BUFFER]), TEXT_BUFFER,
        'and never before the start');
});

test('OemToCharBuff translates a counted buffer between the OEM and ANSI pages', ()=>{
    // An archive's file names are OEM text: 0x81 is u-umlaut in page 437 and
    // 0xfc in Windows-1252. Counted, so the terminator travels and a byte
    // past the count is left alone.
    const { memory, fns } = setup();
    memory.writeMemory(TEXT_BUFFER, Uint8Array.of(0x81, 0x61, 0x00, 0x7a));

    assert.equal(fns.OemToCharBuffA.handler([TEXT_BUFFER, TEXT_BUFFER + 8, 3]), 1);
    assert.deepEqual([...memory.readMemory(TEXT_BUFFER + 8, 4)], [0xfc, 0x61, 0x00, 0x00]);
    assert.equal(fns.CharToOemBuffA.handler([TEXT_BUFFER + 8, TEXT_BUFFER + 8, 3]), 1,
        'and back in place');
    assert.deepEqual([...memory.readMemory(TEXT_BUFFER + 8, 3)], [0x81, 0x61, 0x00]);
    assert.equal(fns.OemToCharBuffA.argBytes, 12);
    assert.equal(fns.CharToOemBuffA.argBytes, 12);
});

test('OemToCharA copies through the terminator and refuses a null on either side', ()=>{
    const { memory, fns } = setup();
    memory.writeMemory(TEXT_BUFFER, Uint8Array.of(0x81, 0x61, 0x00, 0x7a));
    memory.fill(TEXT_BUFFER + 8, 2);

    assert.equal(fns.OemToCharA.handler([TEXT_BUFFER, TEXT_BUFFER + 8]), 1);
    assert.deepEqual([...memory.readMemory(TEXT_BUFFER + 8, 4)],
        [0xfc, 0x61, 0x00, UNTOUCHED & 0xff]);
    assert.equal(fns.OemToCharA.handler([0, TEXT_BUFFER + 8]), 0);
    assert.equal(fns.OemToCharA.argBytes, 8);
});

test('wvsprintfA reads its arguments through the list it was handed', ()=>{
    const { memory, fns } = setup();
    memory.putString(FORMAT_BUFFER, '%s scored %d of %d');
    memory.putString(TEXT_BUFFER, 'Player');
    memory.putU32s(RECT_BUFFER, [TEXT_BUFFER, 42, 100]);

    const written = fns.wvsprintfA.handler([OUT_BUFFER, FORMAT_BUFFER, RECT_BUFFER]);

    assert.equal(memory.readCString(OUT_BUFFER, 64), 'Player scored 42 of 100');
    assert.equal(written, 'Player scored 42 of 100'.length);
    assert.equal(fns.wvsprintfA.argBytes, 12, 'stdcall: three pointers, and the callee pops them');
});

test('CopyRect copies the four fields and refuses a null on either side', ()=>{
    const { memory, fns } = setup();
    memory.putU32s(RECT_BUFFER, [1, 2, 3, 4]);

    assert.equal(fns.CopyRect.handler([OUT_BUFFER, RECT_BUFFER]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(OUT_BUFFER + at)), [1, 2, 3, 4]);
    assert.equal(fns.CopyRect.handler([OUT_BUFFER, 0]), 0);
    assert.equal(fns.WaitForInputIdle.handler([0x1234, 5000]), 0, 'a process is idle at once');
    assert.equal(fns.WaitForInputIdle.argBytes, 8);
});

test('CharLowerA and CharUpperA convert a string in place, or a character by value', ()=>{
    const { memory, fns } = setup();
    memory.putString(TEXT_BUFFER, 'Ab-Z\xe9\xdf');

    assert.equal(fns.CharUpperA.handler([TEXT_BUFFER]), TEXT_BUFFER, 'the pointer is the answer');
    assert.equal(memory.readCString(TEXT_BUFFER, 16), 'AB-Z\xc9\xdf',
        'a letter with no single-byte upper case is left alone');
    assert.equal(fns.CharLowerA.handler([TEXT_BUFFER]), TEXT_BUFFER);
    assert.equal(memory.readCString(TEXT_BUFFER, 16), 'ab-z\xe9\xdf');
    assert.equal(memory.bytes[TEXT_BUFFER + 6], 0, 'and the terminator stays');

    assert.equal(fns.CharLowerA.handler(['Q'.charCodeAt(0)]), 'q'.charCodeAt(0),
        'a value with a zero high word is one character');
    assert.equal(fns.CharUpperA.handler([0]), 0);

    memory.putString(TEXT_BUFFER, 'ab');
    memory.bytes[TEXT_BUFFER + 3] = 'c'.charCodeAt(0);
    assert.equal(fns.CharUpperBuffA.handler([TEXT_BUFFER, 4]), 4, 'a counted buffer, NUL included');
    assert.deepEqual([...memory.bytes.subarray(TEXT_BUFFER, TEXT_BUFFER + 4)],
        [0x41, 0x42, 0, 0x43]);
    assert.equal(fns.CharLowerBuffA.handler([0, 4]), 0);
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

    assert.equal(fns.IsWindowEnabled.handler([hwnd]), 1);
    assert.equal(fns.EnableWindow.handler([hwnd, 0]), 0, 'it was enabled');
    assert.equal(fns.IsWindowEnabled.handler([hwnd]), 0, 'and is not any more');
    assert.equal(fns.EnableWindow.handler([hwnd, 0]), 1, 'and now it was disabled');
    assert.equal(fns.EnableWindow.handler([hwnd, 1]), 1);
    assert.equal(fns.IsWindowEnabled.handler([hwnd]), 1);
    assert.equal(fns.EnableWindow.handler([hwnd, 1]), 0);
    assert.equal(fns.EnableWindow.handler([0x9999, 1]), 0, 'and a window that is not one');
    assert.equal(fns.IsWindowEnabled.handler([0x9999]), 0);
});

test('the foreground window is the one the program showed, never nothing while one shows', ()=>{
    // A program told that nothing is in the foreground concludes it was put
    // behind another window, and re-activates itself every frame -- bringing
    // its window to the top and restarting what it plays on coming back.
    const { memory, fns } = setup();
    assert.equal(fns.GetForegroundWindow.handler([]), 0, 'no window yet');

    const hidden = makeWindow(memory, fns);
    assert.equal(fns.GetForegroundWindow.handler([]), 0, 'a window made hidden is not active');
    assert.equal(fns.ShowWindow.handler([hidden, 5]), 0);
    assert.equal(fns.GetForegroundWindow.handler([]), hidden, 'showing it activates it');
    assert.equal(fns.GetActiveWindow.handler([]), hidden);
    assert.equal(fns.GetFocus.handler([]), hidden);

    const shown = makeWindow(memory, fns, WS_VISIBLE);
    assert.equal(fns.GetForegroundWindow.handler([]), shown, 'a window made visible is active');
    assert.equal(fns.SetFocus.handler([hidden]), shown, 'SetFocus answers the window that had it');
    assert.equal(fns.GetForegroundWindow.handler([]), hidden);

    assert.equal(fns.DestroyWindow.handler([hidden]), 1);
    assert.equal(fns.GetForegroundWindow.handler([]), shown,
        'the visible window that remains is the foreground, not nothing');
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

// --- display mode ---

/** @param {any} memory @param {number} width @param {number} height */
function putMode(memory, width, height){
    memory.putU32s(DEVMODE_BUFFER, new Array(40).fill(0));
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmPelsWidth, [width, height]);
}

test('ChangeDisplaySettingsA accepts the mode already in effect and refuses another', ()=>{
    const { memory, fns } = setup();

    putMode(memory, SCREEN.width, SCREEN.height);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, 0]),
        DISP_CHANGE_SUCCESSFUL);

    putMode(memory, 640, 480);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, 0]),
        DISP_CHANGE_BADMODE,
        'reporting a switch that did not happen makes every later metric disagree');

    assert.equal(fns.ChangeDisplaySettingsA.handler([0, 0]), DISP_CHANGE_SUCCESSFUL,
        'a null mode means what is already on the screen');

    // A depth the caller names is checked too: a program walks its own list
    // of modes and takes the first accepted as the display's depth, so a
    // sixteen-bit request for this screen has to be refused.
    putMode(memory, SCREEN.width, SCREEN.height);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmFields, [DM_BITSPERPEL]);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmBitsPerPel, [16]);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, 0]),
        DISP_CHANGE_BADMODE, 'a shallower depth is another mode');
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmBitsPerPel, [SCREEN.bitsPerPixel]);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, 0]),
        DISP_CHANGE_SUCCESSFUL, 'and the screen\'s own depth is the mode in effect');
});

test('the current settings are answered by name, and say how deep the screen is', ()=>{
    // A program asks for ENUM_CURRENT_SETTINGS before choosing its own depth;
    // refused, it settles for sixteen bits for everything it makes after.
    const { memory, fns } = setup();
    memory.putU32s(DEVMODE_BUFFER, new Array(40).fill(0));
    for (const index of [0xffffffff, 0xfffffffe])
    {
        assert.equal(fns.EnumDisplaySettingsA.handler([0, index, DEVMODE_BUFFER]), 1,
            `index ${index.toString(16)} is a name for a mode, not a mode past the end`);
        assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEA.dmBitsPerPel), SCREEN.bitsPerPixel);
        assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEA.dmPelsWidth), SCREEN.width);
        assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEA.dmPelsHeight), SCREEN.height);
    }
});

test('both ChangeDisplaySettings spellings pop the stack their signature declares', ()=>{
    const { fns } = setup();
    // An import nobody wrote gets a stub that cleans up no arguments, so the
    // caller returns with its stack adrift and dies later in a cookie check, a
    // long way from anything that would explain it.
    assert.equal(fns.ChangeDisplaySettingsA.argBytes, 8);
    assert.equal(fns.ChangeDisplaySettingsExA.argBytes, 20);
});

// --- cursors and icons out of the image ---

test('a cursor or icon the image carries is loaded, one it does not is null', ()=>{
    // A program registers its window class with the cursor and icon it was
    // built with, by id or by name, and reads null as its own image being
    // short of them. Only the resource directory can say whether they exist.
    /** @type {[number, number, number | string][]} */
    const asked = [];
    const { fns, memory } = setup({
        findResource: (instance, type, name)=>{
            asked.push([instance, type, name]);
            const carried = name === 101 || name === 'MAINCURSOR';
            return instance === 0x400000 && carried ? { rva: 1 } : null;
        },
    });
    const RT_GROUP_CURSOR = 12;
    const RT_GROUP_ICON = 14;
    const IMAGE_ICON = 1;
    // Above 64 KiB, as a pointer must be: below it the argument is an id.
    const NAME = 0x12000;
    memory.writeMemory(NAME, new TextEncoder().encode('MAINCURSOR\0'));

    const byId = fns.LoadCursorA.handler([0x400000, 101]);
    const byName = fns.LoadCursorA.handler([0x400000, NAME]);
    assert.notEqual(byId, 0);
    assert.notEqual(byName, 0);
    assert.notEqual(byName, byId, 'two loads are two handles');
    assert.equal(fns.LoadCursorA.handler([0x400000, 102]), 0, 'a cursor the image lacks');
    assert.notEqual(fns.LoadImageA.handler([0x400000, 101, IMAGE_ICON, 0, 0, 0]), 0);
    assert.equal(fns.LoadImageA.handler([0x400000, 101, 0, 0, 0, 0]), 0,
        'a bitmap needs a decoder');
    assert.deepEqual(asked.slice(0, 3), [
        [0x400000, RT_GROUP_CURSOR, 101], [0x400000, RT_GROUP_CURSOR, 'MAINCURSOR'],
        [0x400000, RT_GROUP_CURSOR, 102],
    ], 'looked up in the cursor directory, by the id or the name given');
    assert.equal(asked[3][1], RT_GROUP_ICON);

    const IDC_ARROW = 0x7f00;
    assert.equal(fns.LoadCursorA.handler([0, IDC_ARROW]), IDC_ARROW,
        'a standard cursor is its own handle and needs no image');
});

// --- timers ---

test('SetTimer registers the timer and gives back the id the caller must kill', ()=>{
    const { fns, clock } = setup();
    const hwnd = 0x40;

    assert.equal(fns.SetTimer.handler([hwnd, 7, 50, 0]), 7,
        'a timer with a window keeps the id it asked for');
    clock.at = 50;
    assert.equal(fns.KillTimer.handler([hwnd, 7]), 1);
    assert.equal(fns.KillTimer.handler([hwnd, 7]), 0, 'and it is gone');
});

test('a timer with no window gets an id of our choosing', ()=>{
    const { fns } = setup();

    const first = fns.SetTimer.handler([0, 0, 50, 0]);
    const second = fns.SetTimer.handler([0, 0, 50, 0]);

    assert.notEqual(first, 0, 'zero is the failure the caller checks for');
    assert.notEqual(second, first, 'two timers are two timers');
});

test('a window timer numbered zero is a success, not a failure', ()=>{
    // A program sets timer 0 on its window and reads the answer as a BOOL. A
    // title was measured re-arming it on every message, for ever, when zero
    // came back; Windows answers a nonzero integer for any window timer.
    const { fns, queue, clock } = setup();
    const hwnd = 0x40b4;

    assert.equal(fns.SetTimer.handler([hwnd, 0, 100, 0]), 1);
    clock.at = 100;
    const fired = queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true });
    assert.equal(fired?.message, WM_TIMER, 'and the timer is real');
    assert.equal(fired?.wParam, 0, 'under the id the program asked for');
    assert.equal(fns.KillTimer.handler([hwnd, 0]), 1);
});

test('SetTimer reaches the queue a message loop reads', ()=>{
    // A program of this era blocks in GetMessage and a timer is the only thing
    // that wakes it. Refusing to make one leaves it waiting for a message that
    // cannot arrive, which from outside looks like a program with nothing to do.
    const { fns, queue, clock } = setup();
    fns.SetTimer.handler([0x40, 7, 50, 0]);

    assert.equal(queue.nextDue(), 50);
    clock.at = 50;
    assert.equal(queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true })?.message,
        WM_TIMER);
});

// --- input state ---

test('GetCursorPos answers from the host rather than inventing a position', ()=>{
    const { memory, fns } = setup({ cursor: { x: 320, y: 240 } });
    memory.fill(OUT_BUFFER, 2);

    assert.equal(fns.GetCursorPos.handler([OUT_BUFFER]), 1);
    assert.deepEqual([memory.u32(OUT_BUFFER), memory.u32(OUT_BUFFER + 4)], [320, 240]);

    assert.equal(fns.GetCursorPos.handler([0]), 0, 'and a null point is a failure');
});

test('a build with nothing feeding it reports nothing pressed', ()=>{
    // The one safe wrong answer: a state invented here would have a program act
    // on a press that never happened.
    const { memory, fns } = setup();
    memory.fill(OUT_BUFFER, 2);

    assert.equal(fns.GetAsyncKeyState.handler([0x41]), 0);
    assert.equal(fns.GetKeyState.handler([0x41]), 0);
    assert.equal(fns.GetCursorPos.handler([OUT_BUFFER]), 1);
    assert.deepEqual([memory.u32(OUT_BUFFER), memory.u32(OUT_BUFFER + 4)], [0, 0]);
});

test('the key-state queries pass the key through to the host', ()=>{
    const down = new Set([0x41]);
    const { fns } = setup({ keyState: key=>(down.has(key) ? 0x8000 : 0) });

    assert.equal(fns.GetAsyncKeyState.handler([0x41]), 0x8000, 'the high bit is "down"');
    assert.equal(fns.GetAsyncKeyState.handler([0x42]), 0);
    assert.equal(fns.GetKeyState.handler([0x41]), 0x8000);
});

test('a message box is handed up whole, not only written to the log', ()=>{
    // A message box is a program explaining, in its own words, why it is about
    // to stop -- the most useful sentence it will ever say. A line in a log is
    // where such a sentence goes to be missed, so whoever is embedding the
    // engine gets it as its own thing and can put it in front of a person.
    const { memory, fns, notices, said } = setup();
    memory.putString(TEXT_BUFFER, 'Unable to initialize DirectX.');
    memory.putString(FORMAT_BUFFER, 'Warcraft III');

    const MB_ICONERROR = 0x10;
    assert.equal(
        fns.MessageBoxA.handler([0, TEXT_BUFFER, FORMAT_BUFFER, MB_ICONERROR]),
        1, 'IDOK: there is nobody to press a button');

    assert.deepEqual(notices, [{
        text: 'Unable to initialize DirectX.',
        caption: 'Warcraft III',
        type: MB_ICONERROR,
    }]);
    assert.deepEqual(said, ['Warcraft III: Unable to initialize DirectX.'],
        'and it still reaches the log, for a reader who only has that');
});

test('a message registered by name is the same number every time, whatever the case', ()=>{
    const { memory, fns } = setup();
    memory.putString(TEXT_BUFFER, 'commdlg_FindReplace');
    memory.putString(FORMAT_BUFFER, 'COMMDLG_FINDREPLACE');

    const first = fns.RegisterWindowMessageA.handler([TEXT_BUFFER]);
    assert.ok(first >= 0xc000 && first <= 0xffff, 'in the range Windows keeps for them');
    assert.equal(fns.RegisterWindowMessageA.handler([FORMAT_BUFFER]), first);

    memory.putString(FORMAT_BUFFER, 'another');
    assert.notEqual(fns.RegisterWindowMessageA.handler([FORMAT_BUFFER]), first);
    assert.equal(fns.RegisterWindowMessageA.handler([0]), 0, 'and no name is no message');
    assert.equal(fns.RegisterWindowMessageA.argBytes, 4);
});

test('a message box with neither text nor caption still reports', ()=>{
    const { fns, notices } = setup();
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, 0]), 1);
    assert.deepEqual(notices, [{ text: '', caption: '', type: 0 }]);
});

// --- rectangles and the small string helpers ---

test('the rectangle helpers work over the caller\'s memory and refuse a null pointer', ()=>{
    const { memory, fns } = setup();
    const rect = TEXT_BUFFER;
    const other = FORMAT_BUFFER;
    memory.putU32s(rect, [10, 20, 30, 40]);

    assert.equal(fns.CopyRect.handler([other, rect]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(other + at)), [10, 20, 30, 40]);
    assert.equal(fns.EqualRect.handler([other, rect]), 1);

    assert.equal(fns.OffsetRect.handler([other, 5, -5]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(other + at) | 0), [15, 15, 35, 35]);
    assert.equal(fns.EqualRect.handler([other, rect]), 0);

    assert.equal(fns.InflateRect.handler([other, 1, 2]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(other + at) | 0), [14, 13, 36, 37]);

    assert.equal(fns.PtInRect.handler([rect, 10, 20]), 1, 'the top-left edge is inside');
    assert.equal(fns.PtInRect.handler([rect, 30, 20]), 0, 'the right edge is outside');
    assert.equal(fns.PtInRect.handler([rect, -1, -1]), 0);

    assert.equal(fns.SetRectEmpty.handler([rect]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(rect + at)), [0, 0, 0, 0]);

    /** @type {[string, number[]][]} */
    const nulls = [['SetRectEmpty', [0]], ['CopyRect', [0, rect]],
        ['EqualRect', [rect, 0]], ['OffsetRect', [0, 1, 1]], ['InflateRect', [0, 1, 1]],
        ['PtInRect', [0, 1, 1]]];
    for (const [name, args] of nulls)
    {
        assert.equal(fns[name].handler(args), 0, name);
    }
    assert.equal(fns.PtInRect.argBytes, 12, 'the POINT is two words on the stack');
    assert.equal(fns.OffsetRect.argBytes, 12);
    assert.equal(fns.CopyRect.argBytes, 8);
});

test('GetMessageTime and GetMessagePos describe the message last taken off the queue', ()=>{
    const { queue, fns } = setup();
    assert.equal(fns.GetMessageTime.handler([]), 0, 'nothing yet');
    queue.post({ hwnd: 0x40, message: 0x400, wParam: 0, lParam: 0, time: 5000, x: 17, y: 23 });
    queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.equal(fns.GetMessageTime.handler([]), 5000);
    assert.equal(fns.GetMessagePos.handler([]), 17 | 23 << 16);
    assert.equal(fns.GetMessageTime.argBytes, 0);
});
