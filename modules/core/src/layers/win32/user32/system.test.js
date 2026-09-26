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
import {
    DEVMODEA, DISPLAY_DEVICEA, DISPLAY_DEVICEW, DM_BITSPERPEL, DM_DISPLAYFREQUENCY,
    DM_PELSHEIGHT, DM_PELSWIDTH, PAINTSTRUCT, RECT,
} from './structs.js';
import { createWindowFunctions } from './windows.js';
import { createInputRouter } from '../../input/router.js';

const CLASS_NAME = 0x10000;
const CLASS_STRUCT = 0x10100;
const TITLE = 0x10200;
const PAINT_BUFFER = 0x11000;
const RECT_BUFFER = 0x11200;
const TEXT_BUFFER = 0x11300;
const FORMAT_BUFFER = 0x11500;
const OUT_BUFFER = 0x11600;
const DEVMODE_BUFFER = 0x11800;
const INPUT_BUFFER = 0x11a00;
const KEYBOARD_BUFFER = 0x11c00;
const DEVICE_BUFFER = 0x12200;
const DEVICE_NAME_BUFFER = 0x12600;

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
    const memory = {
        bytes,
        /** @type {((address: number) => { base: number, size: number } | null) | null} */
        regionAt: null,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>{
            // A test that names a region gets the memory layer's real refusal:
            // a read that crosses its end throws rather than shorting.
            const region = memory.regionAt?.(address) ?? null;
            if (region && address + length > region.base + region.size)
            {
                throw new Error(`read of ${length} bytes at 0x${address.toString(16)}`
                    + ' runs past the end of region');
            }
            return bytes.slice(address, address + length);
        },
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
    return memory;
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
        /** @param {number} handle */
        typeOf: handle=>entries.get(handle)?.type ?? null,
        /** @param {number} handle @param {string} type */
        resolve(handle, type){
            const entry = entries.get(handle);
            if (!entry || entry.type !== type)
            {
                throw new Error('Invalid handle');
            }
            return entry.object;
        },
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
 * @param {(key: number) => number} [options.asyncKeyState]
 * @param {() => Uint8Array | null} [options.keyboardState]
 * @param {(bytes: Uint8Array) => void} [options.setKeyboardState]
 * @param {(instance: number, type: number, name: number | string) => unknown}
 *        [options.findResource]
 *        Which resources the program's own image carries.
 * @param {(wndProc: number, message: any) => number} [options.dispatch]
 *        What a window procedure answers; nothing unless given.
 * @param {(instance: number, id: number) => string | null} [options.loadString]
 *        The string table of the program's own image.
 * @param {{ width: number, height: number, bitsPerPixel: number,
 *           displayWidth?: number, displayHeight?: number }} [options.screen]
 *        The screen, its own object per test because a mode switch moves it.
 * @param {(notice: any) => any} [options.messageBox]
 *        What answers a message box: a promise leaves the caller parked, and
 *        nothing at all leaves the box its own default. Defaults to recording
 *        the notice and answering nothing.
 * @param {(region: number) => any} [options.regionBox]
 *        The rectangle a GDI region holds, for the calls that name one.
 * @param {(instance: number) => number} [options.moduleBase]
 *        Where a module is mapped, for a resource read in place.
 */
function setup(
    { cursor, keyState, asyncKeyState, keyboardState, setKeyboardState,
        findResource, loadString, dispatch = ()=>0, screen, messageBox, regionBox,
        moduleBase } = {})
{
    screen ??= { ...SCREEN, displayWidth: SCREEN.width, displayHeight: SCREEN.height };
    const memory = fakeMemory();
    const clock = { at: 0 };
    // The same key-state thunk the real host hands to both, as in module.js:
    // a hot key fires on a combination, and the queue is what reads it.
    const queue = createMessageQueue({ now: ()=>clock.at, keyState });
    const contexts = fakeContexts();
    /** @type {any[]} */
    const notices = [];
    /** @type {string[]} */
    const said = [];
    /** @type {string[]} */
    const diverged = [];
    /** @type {number[]} */
    const errors = [];
    /** The cursor pictures user32 handed up, oldest first. */
    /** @type {any[]} */
    const cursors = [];
    /** Where user32 put the cursor, oldest first. */
    /** @type {{ x: number, y: number }[]} */
    const placed = [];
    /** What SendInput handed to the input layer, oldest first. */
    /** @type {any[]} */
    const sent = [];
    const fns = createWindowFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        regionAt: address=>memory.regionAt?.(address) ?? null,
        handles: fakeHandles(),
        queue,
        screen,
        dc: ()=>contexts.service,
        dispatch,
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
        cursor: cursor && (()=>cursor),
        keyState,
        asyncKeyState,
        keyboardState,
        setKeyboardState,
        findResource,
        moduleBase,
        loadString,
        regionBox,
        /** @param {any} notice */
        messageBox: messageBox ?? (notice=>{
            notices.push(notice);
        }),
        /** @param {string} text */
        say: text=>said.push(text),
        /** @param {string} api @param {string} detail */
        divergence: (api, detail)=>diverged.push(`${api}: ${detail}`),
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {any} picture */
        reportCursor: picture=>cursors.push(picture),
        /** @param {number} x @param {number} y */
        placeCursor: (x, y)=>placed.push({ x, y }),
        /** @param {any} event */
        sendInput: event=>sent.push(event),
    });
    // Cast once: the table's handlers declare only the arguments they read, and
    // a guest call always arrives with the whole argument array.
    const table = /** @type {Record<string, { argBytes: number, convention?: string,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (fns));
    return { memory, queue, fns: table, contexts, clock, notices, said, diverged, errors,
        screen, cursors, placed, sent };
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

test('GetWindow walks top-level windows from the top, and children in creation order', ()=>{
    const GW_HWNDFIRST = 0;
    const GW_HWNDLAST = 1;
    const GW_HWNDNEXT = 2;
    const GW_OWNER = 4;
    const GW_CHILD = 5;
    const WS_CHILD = 0x40000000;
    const { memory, fns } = setup();
    const bottom = makeWindow(memory, fns);
    const top = makeWindow(memory, fns);
    /** @param {number} parent */
    const child = parent=>fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, WS_CHILD, 0, 0, 10, 10, parent, 0, HINSTANCE, 0]);
    const firstControl = child(top);
    const secondControl = child(top);

    assert.equal(fns.GetWindow.handler([bottom, GW_HWNDFIRST]), top, 'the newest is on top');
    assert.equal(fns.GetWindow.handler([top, GW_HWNDNEXT]), bottom, 'and the next is below it');
    assert.equal(fns.GetWindow.handler([top, GW_HWNDLAST]), bottom);
    assert.equal(fns.GetWindow.handler([top, GW_CHILD]), firstControl,
        'a dialog\'s first control is the first one made');
    assert.equal(fns.GetWindow.handler([firstControl, GW_HWNDNEXT]), secondControl);
    assert.equal(fns.GetWindow.handler([firstControl, GW_OWNER]), 0, 'a child has no owner');
});

test('a child is hit where GetWindow stacks it, and SetWindowPos restacks it', ()=>{
    // user32's window tests: children made one after another are stacked
    // first-made on top (GW_CHILD, then GW_HWNDNEXT, walks them in creation
    // order), and the point both overlap belongs to GW_CHILD's window.
    const GW_CHILD = 5;
    const GW_HWNDNEXT = 2;
    const WS_CHILD = 0x40000000;
    const WS_POPUP = 0x80000000;
    const HWND_TOP = 0;
    const HWND_BOTTOM = 1;
    const SWP_NOSIZE = 0x0001;
    const SWP_NOMOVE = 0x0002;
    const { memory, fns } = setup();
    makeWindow(memory, fns);
    const parent = fns.CreateWindowExA.handler([0, CLASS_NAME, TITLE, WS_POPUP | WS_VISIBLE,
        0, 0, 200, 200, 0, 0, HINSTANCE, 0]);
    /** @returns {number} */
    const child = ()=>fns.CreateWindowExA.handler([0, CLASS_NAME, TITLE,
        WS_CHILD | WS_VISIBLE, 0, 0, 100, 100, parent, 0, HINSTANCE, 0]);
    const a = child();
    const b = child();
    const c = child();
    /** @returns {number[]} */
    const stack = ()=>{
        const listed = [];
        for (let at = fns.GetWindow.handler([parent, GW_CHILD]); at !== 0;
            at = fns.GetWindow.handler([at, GW_HWNDNEXT]))
        {
            listed.push(at);
        }
        return listed;
    };

    assert.deepEqual(stack(), [a, b, c]);
    assert.equal(fns.WindowFromPoint.handler([50, 50]), a, 'the top child takes the point');
    assert.equal(fns.ChildWindowFromPoint.handler([parent, 50, 50]), a);

    fns.SetWindowPos.handler([c, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE]);
    assert.deepEqual(stack(), [c, a, b], 'HWND_TOP puts a child above its siblings');
    assert.equal(fns.WindowFromPoint.handler([50, 50]), c);
    assert.equal(fns.ChildWindowFromPoint.handler([parent, 50, 50]), c);

    fns.SetWindowPos.handler([c, HWND_BOTTOM, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE]);
    assert.deepEqual(stack(), [a, b, c], 'and HWND_BOTTOM below them');
    fns.SetWindowPos.handler([a, b, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE]);
    assert.deepEqual(stack(), [b, a, c], 'a sibling handle places it just below that sibling');
    assert.equal(fns.WindowFromPoint.handler([50, 50]), b);
});

test('the desktop is a window: it exists, it is the screen, and it cannot be destroyed', ()=>{
    // user32's window tests take GetDesktopWindow for a window throughout: a
    // parent for top-level windows, a rectangle that is the screen. It is
    // one window, the same handle every time, of the class #32769.
    const GW_CHILD = 5;
    const WS_POPUP = 0x80000000;
    const { memory, fns } = setup();
    const desktop = fns.GetDesktopWindow.handler([]);
    assert.notEqual(desktop, 0);
    assert.equal(fns.GetDesktopWindow.handler([]), desktop, 'the same one every time');
    assert.equal(fns.IsWindow.handler([desktop]), 1);
    assert.equal(fns.IsWindowVisible.handler([desktop]), 1);
    memory.fill(RECT_BUFFER, 4);
    assert.equal(fns.GetWindowRect.handler([desktop, RECT_BUFFER]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at)),
        [0, 0, SCREEN.width, SCREEN.height], 'the screen');
    fns.GetClientRect.handler([desktop, RECT_BUFFER]);
    assert.deepEqual([8, 12].map(at=>memory.u32(RECT_BUFFER + at)), [SCREEN.width, SCREEN.height]);
    assert.equal(fns.GetClassNameA.handler([desktop, TEXT_BUFFER, 32]), 6);
    assert.equal(memory.readCString(TEXT_BUFFER, 32), '#32769');

    makeWindow(memory, fns);
    const top = fns.CreateWindowExA.handler([0, CLASS_NAME, TITLE, WS_POPUP | WS_VISIBLE,
        0, 0, 50, 50, desktop, 0, HINSTANCE, 0]);
    assert.notEqual(top, 0);
    assert.equal(fns.GetParent.handler([top]), 0, 'a window made on the desktop is top-level');
    assert.equal(fns.GetWindow.handler([desktop, GW_CHILD]), top,
        'and the topmost of them is the desktop\'s first child');

    assert.equal(fns.DestroyWindow.handler([desktop]), 0);
    assert.equal(fns.IsWindow.handler([desktop]), 1, 'nothing takes the desktop away');
});

test('GetLastActivePopup answers the popup of an owner chain that was active last', ()=>{
    // user32's window tests: an owner, a popup it owns, and a popup that one
    // owns, each shown as it is made -- the owner's last active popup is the
    // innermost.
    const WS_POPUPWINDOW = 0x80880000;
    const { memory, fns } = setup();
    makeWindow(memory, fns);
    /** @param {number} owner */
    const popup = owner=>fns.CreateWindowExA.handler([0, CLASS_NAME, TITLE,
        WS_POPUPWINDOW | WS_VISIBLE, 100, 100, 200, 200, owner, 0, HINSTANCE, 0]);
    const owner = popup(0);
    const first = popup(owner);
    const second = popup(first);

    assert.equal(fns.GetLastActivePopup.handler([owner]), second);
    assert.equal(fns.GetLastActivePopup.handler([first]), first,
        'an owned window answers itself');
    fns.DestroyWindow.handler([second]);
    assert.notEqual(fns.GetLastActivePopup.handler([owner]), second,
        'and a popup that is gone is no answer');
    assert.equal(fns.GetLastActivePopup.handler([0x7777]), 0);
});

test('GetAncestor walks parents and owners as GA_PARENT, GA_ROOT and GA_ROOTOWNER ask, and '
    + 'IsChild walks the chain of child windows only', ()=>{
    // user32's window tests (test_SetParent, check_parents): a child, a popup
    // made on that child, a child of the popup and a popup made on that one.
    // GA_PARENT of a window that is no child is the desktop, GA_ROOT stops
    // at the first window that is no child, GA_ROOTOWNER goes on through the
    // owners; IsChild is true only through WS_CHILD windows, never for the
    // desktop, and follows a style changed afterwards.
    const GA_PARENT = 1;
    const GA_ROOT = 2;
    const GA_ROOTOWNER = 3;
    const GWL_STYLE = -16;
    const WS_CHILD = 0x40000000;
    const WS_POPUP = 0x80000000;
    const { memory, fns } = setup();
    const desktop = fns.GetDesktopWindow.handler([]);
    const parent = makeWindow(memory, fns);
    /** @param {number} style @param {number} over */
    const make = (style, over)=>fns.CreateWindowExA.handler([0, CLASS_NAME, TITLE, style,
        0, 0, 50, 50, over, 0, HINSTANCE, 0]);
    const child1 = make(WS_CHILD, parent);
    const child2 = make(WS_POPUP, child1);
    const child3 = make(WS_CHILD, child2);
    const child4 = make(WS_POPUP, child3);
    /** @param {number} hwnd */
    const ancestors = hwnd=>[GA_PARENT, GA_ROOT, GA_ROOTOWNER].map(flags=>
        fns.GetAncestor.handler([hwnd, flags]));
    assert.deepEqual(ancestors(parent), [desktop, parent, parent]);
    assert.deepEqual(ancestors(child1), [parent, parent, parent]);
    assert.deepEqual(ancestors(child2), [desktop, child2, parent]);
    assert.deepEqual(ancestors(child3), [child2, child2, parent]);
    assert.deepEqual(ancestors(child4), [desktop, child4, parent]);
    assert.deepEqual(ancestors(desktop), [0, 0, 0], 'the desktop has no ancestor');
    assert.deepEqual(ancestors(0x7777), [0, 0, 0]);

    const pairs = [[desktop, parent, 0], [desktop, child1, 0], [desktop, child3, 0],
        [parent, child1, 1], [parent, child2, 0], [child1, child2, 0], [parent, child3, 0],
        [child2, child3, 1], [parent, child4, 0], [child3, child4, 0]];
    for (const [over, under, answer] of pairs)
    {
        assert.equal(fns.IsChild.handler([over, under]), answer, `IsChild(${over}, ${under})`);
    }
    fns.SetWindowLongA.handler([child4, GWL_STYLE, WS_CHILD]);
    assert.equal(fns.IsChild.handler([child3, child4]), 1);
    assert.equal(fns.IsChild.handler([child2, child4]), 1);
    assert.equal(fns.IsChild.handler([child1, child4]), 0, 'a popup ends the chain');
    fns.SetWindowLongA.handler([child2, GWL_STYLE, WS_CHILD]);
    assert.equal(fns.IsChild.handler([child1, child4]), 1);
    assert.equal(fns.IsChild.handler([parent, child4]), 1);
});

// --- painting ---

test('RedrawWindow invalidates, validates and updates as its flags say', ()=>{
    /** @type {number[]} */
    const sent = [];
    const { memory, fns, queue } = setup({
        dispatch: (/** @type {number} */ _proc, /** @type {any} */ message)=>{
            sent.push(message.message);
            return 0;
        },
    });
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
    assert.deepEqual(sent, [0x000f], 'RDW_UPDATENOW is a WM_PAINT, sent before it returns');

    assert.equal(fns.RedrawWindow.handler([hwnd, 0, 0, RDW_VALIDATE]), 1);
    assert.equal(fns.GetUpdateRect.handler([hwnd, OUT_BUFFER, 0]), 0, 'validated: nothing dirty');
    assert.equal(fns.RedrawWindow.handler([0x9999, 0, 0, RDW_INVALIDATE]), 0);
});

/** The update rectangle GetUpdateRect reports, or null for none. */
function updateRectOf(/** @type {any} */ memory, /** @type {any} */ fns, /** @type {number} */ hwnd){
    return fns.GetUpdateRect.handler([hwnd, OUT_BUFFER, 0]) === 0
        ? null
        : [RECT.left, RECT.top, RECT.right, RECT.bottom].map(at=>memory.u32(OUT_BUFFER + at));
}

test('UpdateWindow sends WM_PAINT before it returns, and only with something to paint', ()=>{
    /** @type {number[]} */
    const sent = [];
    const { memory, fns, queue } = setup({
        dispatch: (/** @type {number} */ _proc, /** @type {any} */ message)=>{
            sent.push(message.message);
            return 0;
        },
    });
    const hwnd = makeWindow(memory, fns);
    fns.ValidateRect.handler([hwnd, 0]);

    assert.equal(fns.UpdateWindow.handler([hwnd]), 1);
    assert.deepEqual(sent, [], 'nothing to paint, nothing sent');

    fns.InvalidateRect.handler([hwnd, 0, 0]);
    assert.equal(fns.UpdateWindow.handler([hwnd]), 1);
    assert.deepEqual(sent, [0x000f], 'the procedure has run by the time the call returns');
    assert.equal(queue.depth(), 0, 'and nothing waits in the queue to paint again later');
    assert.equal(fns.UpdateWindow.handler([0x9999]), 0);
});

test('InvalidateRgn and ValidateRgn take the region\'s own rectangle', ()=>{
    const REGION = 0x3000;
    const { memory, fns } = setup({
        regionBox: (/** @type {number} */ region)=>(region === REGION
            ? { left: 5, top: 6, right: 25, bottom: 36 } : null),
    });
    const hwnd = makeWindow(memory, fns);
    fns.ValidateRect.handler([hwnd, 0]);

    assert.equal(fns.InvalidateRgn.handler([hwnd, REGION, 0]), 1);
    assert.deepEqual(updateRectOf(memory, fns, hwnd), [5, 6, 25, 36]);
    assert.equal(fns.ValidateRgn.handler([hwnd, REGION]), 1);
    assert.equal(updateRectOf(memory, fns, hwnd), null);
    assert.equal(fns.ValidateRgn.argBytes, 8);
});

test('ValidateRect takes a band off the update area, and keeps it whole over a hole', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    fns.ValidateRect.handler([hwnd, 0]);
    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.InvalidateRect.handler([hwnd, RECT_BUFFER, 0]);

    memory.putU32s(RECT_BUFFER, [0, 0, 100, 30]);
    fns.ValidateRect.handler([hwnd, RECT_BUFFER]);
    assert.deepEqual(updateRectOf(memory, fns, hwnd), [0, 30, 100, 100], 'the top band is painted');

    memory.putU32s(RECT_BUFFER, [40, 40, 60, 60]);
    fns.ValidateRect.handler([hwnd, RECT_BUFFER]);
    assert.deepEqual(updateRectOf(memory, fns, hwnd), [0, 30, 100, 100],
        'a hole in the middle is not something a rectangle can hold');

    memory.putU32s(RECT_BUFFER, [0, 0, 200, 200]);
    fns.ValidateRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(updateRectOf(memory, fns, hwnd), null, 'all of it');
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

test('hiding the cursor through ShowCursor is reported once, not on every call', ()=>{
    // The whole reason the event exists: a shooter hides its cursor by dropping
    // the display count below zero, and the launcher arms the pointer lock on
    // that report. It happens once; a report per call buries it.
    const { fns, cursors } = setup();

    assert.equal(fns.ShowCursor.handler([0]), -1);
    assert.deepEqual(cursors, [{ shown: false }], 'the first FALSE reports hidden');
    assert.equal(fns.ShowCursor.handler([0]), -2);
    assert.equal(cursors.length, 1, 'a second FALSE hides it again but reports nothing');
});

test('showing the cursor again is reported on the crossing, and only there', ()=>{
    const { fns, cursors } = setup();

    fns.ShowCursor.handler([0]);
    fns.ShowCursor.handler([0]);
    cursors.length = 0;
    assert.equal(fns.ShowCursor.handler([1]), -1);
    assert.equal(cursors.length, 0, 'still below zero: nothing has crossed');
    assert.equal(fns.ShowCursor.handler([1]), 0);
    assert.deepEqual(cursors, [{ shown: true }], 'crossing back to zero reports shown, once');
    assert.equal(fns.ShowCursor.handler([1]), 1);
    assert.equal(cursors.length, 1, 'a positive count is no further change');
});

test('a null cursor hides even while the count says shown, and setting one shows again', ()=>{
    const { fns, cursors } = setup();

    // A non-negative count and a null cursor: the cursor is NULL, so it is gone.
    assert.equal(fns.SetCursor.handler([0]), 0);
    assert.deepEqual(cursors, [{ shown: false }], 'SetCursor(NULL) reports hidden');
    assert.equal(fns.SetCursor.handler([0x32512]), 0);
    assert.deepEqual(cursors, [{ shown: false }, { shown: true }],
        'a real cursor back reports shown');
});

test('a per-frame ShowCursor(FALSE) under a negative count never reports', ()=>{
    // The frame loop of the title that hides its cursor: it drives the count
    // further and further negative every frame, and the page is told once.
    const { fns, cursors } = setup();
    fns.ShowCursor.handler([0]);
    cursors.length = 0;

    for (let frame = 0; frame < 100; frame++)
    {
        assert.equal(fns.ShowCursor.handler([0]), -2 - frame);
    }
    assert.equal(cursors.length, 0, 'a hundred more FALSE calls report nothing');
});

test('a cursor a program made is shown to the page as its picture and hot spot', ()=>{
    // SetCursor is documented as setting the cursor's shape; a shape the
    // program made with CreateCursor is handed up with its bitmap, once per
    // change, and a standard cursor is handed up with none -- the page's own.
    const { memory, fns, cursors } = setup();
    const AND = OUT_BUFFER;
    const XOR = OUT_BUFFER + 4;
    memory.putU32s(AND, [0b0110_0000]);
    memory.putU32s(XOR, [0b0101_0000]);
    const made = fns.CreateCursor.handler([HINSTANCE, 1, 0, 4, 1, AND, XOR]);
    assert.notEqual(made, 0);

    fns.SetCursor.handler([made]);
    assert.deepEqual(cursors, [{ shown: true, width: 4, height: 1, hotSpot: { x: 1, y: 0 },
        bgra: Uint8Array.of(0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255) }]);
    fns.SetCursor.handler([made]);
    assert.equal(cursors.length, 1, 'the same cursor again is no change');

    const IDC_ARROW = 0x7f00;
    fns.SetCursor.handler([IDC_ARROW]);
    assert.deepEqual(cursors.at(-1), { shown: true }, 'the standard arrow is the page\'s own');
    fns.SetCursor.handler([made]);
    fns.ShowCursor.handler([0]);
    fns.ShowCursor.handler([1]);
    assert.deepEqual(cursors.slice(-2).map(picture=>[picture.shown, picture.width]),
        [[false, undefined], [true, 4]], 'shown again as the picture it was');
});

test('a cursor out of the program\'s resources is shown as the image its group offers', ()=>{
    // RT_GROUP_CURSOR names the images by id; RT_CURSOR is the hot spot, then
    // a DIB whose height counts both masks. A 32x32 image is the one a cursor
    // of the standard size is loaded from.
    const BASE = 0x400000;
    const GROUP = 0x12a00;
    const IMAGE = 0x12b00;
    const RT_CURSOR = 1;
    const RT_GROUP_CURSOR = 12;
    const width = 32;
    const group = new Uint8Array(6 + 2 * 14);
    const groupView = new DataView(group.buffer);
    groupView.setUint16(2, 2, true);
    groupView.setUint16(4, 2, true);
    [[16, 7], [width, 8]].forEach(([size, id], index)=>{
        groupView.setUint16(6 + index * 14, size, true);
        groupView.setUint16(6 + index * 14 + 6, 32, true);
        groupView.setUint16(6 + index * 14 + 12, id, true);
    });
    const pixelsSize = width * width * 4;
    const image = new Uint8Array(4 + 40 + pixelsSize + width * 4);
    const imageView = new DataView(image.buffer);
    imageView.setUint16(0, 5, true);
    imageView.setUint16(2, 9, true);
    imageView.setUint32(4, 40, true);
    imageView.setInt32(8, width, true);
    imageView.setInt32(12, width * 2, true);
    imageView.setUint16(18, 32, true);
    // The bottom-left pixel, the first stored: half-transparent blue.
    image.set([255, 0, 0, 128], 4 + 40);
    const { fns, memory, cursors } = setup({
        moduleBase: instance=>(instance === HINSTANCE ? BASE : 0),
        findResource: (instance, type, name)=>{
            if (type === RT_GROUP_CURSOR && name === 101)
            {
                return { rva: GROUP - BASE, size: group.length };
            }
            return type === RT_CURSOR && name === 8 ? { rva: IMAGE - BASE, size: image.length }
                : null;
        },
    });
    memory.writeMemory(GROUP, group);
    memory.writeMemory(IMAGE, image);

    fns.SetCursor.handler([fns.LoadCursorA.handler([HINSTANCE, 101])]);
    const [picture] = cursors;
    assert.deepEqual([picture.width, picture.height, picture.hotSpot], [width, width,
        { x: 5, y: 9 }]);
    assert.deepEqual([...picture.bgra.subarray((width - 1) * width * 4, (width - 1) * width * 4
        + 4)], [255, 0, 0, 128], 'the image\'s first row is the picture\'s last');
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

test('SetWindowRgn accepts a shape it does not clip to, and says so', ()=>{
    const { memory, fns, diverged } = setup();
    const hwnd = makeWindow(memory, fns);
    assert.equal(fns.SetWindowRgn.argBytes, 12);
    assert.equal(fns.SetWindowRgn.handler([hwnd, 0x1234, 1]), 1);
    assert.equal(fns.SetWindowRgn.handler([hwnd, 0, 1]), 1, 'no region is nothing to report');
    assert.equal(fns.SetWindowRgn.handler([0x9999, 0x1234, 1]), 0);
    assert.equal(diverged.filter(text=>text.startsWith('SetWindowRgn')).length, 1);
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

test('the metrics a window, an icon and a mouse are measured by are the classic ones', ()=>{
    // user32's sysparams tests at 96 dpi with the classic non-client metrics:
    // icons and cursors 32 across, small icons 16, edges 2, the minimum
    // window a caption and two sizing frames high, the tracking limits
    // derived from those -- and a mouse present, with its buttons.
    const { fns } = setup();
    /** @param {number} index */
    const gsm = index=>fns.GetSystemMetrics.handler([index]);
    const SM_CYCAPTION = 4;
    const SM_CXICON = 11;
    const SM_CYICON = 12;
    const SM_CXCURSOR = 13;
    const SM_CYCURSOR = 14;
    const SM_MOUSEPRESENT = 19;
    const SM_CXMIN = 28;
    const SM_CYMIN = 29;
    const SM_CXSIZE = 30;
    const SM_CYSIZE = 31;
    const SM_CXFRAME = 32;
    const SM_CYFRAME = 33;
    const SM_CXMINTRACK = 34;
    const SM_CYMINTRACK = 35;
    const SM_CMOUSEBUTTONS = 43;
    const SM_CXEDGE = 45;
    const SM_CYEDGE = 46;
    const SM_CXSMICON = 49;
    const SM_CYSMICON = 50;
    const SM_CXMAXTRACK = 59;
    const SM_CYMAXTRACK = 60;
    const SM_CXMENUCHECK = 71;
    const SM_CYMENUCHECK = 72;
    const SM_MOUSEWHEELPRESENT = 75;

    assert.deepEqual([SM_CXICON, SM_CYICON, SM_CXCURSOR, SM_CYCURSOR].map(gsm), [32, 32, 32, 32]);
    assert.deepEqual([SM_CXSMICON, SM_CYSMICON].map(gsm), [16, 16]);
    assert.deepEqual([SM_CXEDGE, SM_CYEDGE].map(gsm), [2, 2]);
    assert.equal(gsm(SM_CYSIZE), gsm(SM_CYCAPTION) - 1, 'a caption button is the caption less one');
    assert.equal(gsm(SM_CXSIZE), gsm(SM_CYSIZE));
    assert.equal(gsm(SM_CYMIN), gsm(SM_CYCAPTION) + 2 * gsm(SM_CYFRAME));
    assert.ok(gsm(SM_CXMIN) > 0);
    assert.deepEqual([gsm(SM_CXMINTRACK), gsm(SM_CYMINTRACK)], [gsm(SM_CXMIN), gsm(SM_CYMIN)]);
    assert.equal(gsm(SM_CXMAXTRACK), SCREEN.width + 4 + 2 * gsm(SM_CXFRAME));
    assert.equal(gsm(SM_CYMAXTRACK), SCREEN.height + 4 + 2 * gsm(SM_CYFRAME));
    const SM_CYFULLSCREEN = 17;
    const SM_CYMAXIMIZED = 62;
    assert.equal(gsm(SM_CYFULLSCREEN), gsm(SM_CYMAXIMIZED) - gsm(SM_CYMIN),
        'a maximised window\'s client height');
    assert.deepEqual([SM_CXMENUCHECK, SM_CYMENUCHECK].map(gsm), [13, 13]);
    assert.equal(gsm(SM_MOUSEPRESENT), 1, 'there is a mouse');
    assert.equal(gsm(SM_CMOUSEBUTTONS), 3, 'with three buttons');
    assert.equal(gsm(SM_MOUSEWHEELPRESENT), 1, 'and a wheel');
});

test('a tool window\'s caption is the small caption the metrics give, and a pixel', ()=>{
    // user32's sysparams tests: SM_CYSMCAPTION is the small caption height
    // plus one, SM_CYSMSIZE one less than that, and SM_CXSMSIZE the small
    // caption width -- 15 each by default, as SM_CYCAPTION is the caption
    // height of 18 plus one. Its window tests take a tool window's caption
    // as SM_CYSMCAPTION high where any other is SM_CYCAPTION high.
    const SM_CYSMCAPTION = 51;
    const SM_CXSMSIZE = 52;
    const SM_CYSMSIZE = 53;
    const WS_EX_TOOLWINDOW = 0x00000080;
    const { memory, fns } = setup();
    /** @param {number} index */
    const gsm = index=>fns.GetSystemMetrics.handler([index]);
    assert.deepEqual([SM_CYSMCAPTION, SM_CXSMSIZE, SM_CYSMSIZE].map(gsm), [16, 15, 15]);

    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRectEx.handler([RECT_BUFFER, WS_CAPTION, 0, WS_EX_TOOLWINDOW]);
    const toolTop = memory.u32(RECT_BUFFER + 4) | 0;
    memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
    fns.AdjustWindowRectEx.handler([RECT_BUFFER, WS_CAPTION, 0, 0]);
    const plainTop = memory.u32(RECT_BUFFER + 4) | 0;
    assert.equal(plainTop - toolTop, gsm(SM_CYSMCAPTION) - gsm(4), 'the two captions differ');
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
    // Every size of the era, whatever the display: a program's resolution
    // menu is built from exactly this walk.
    assert.equal(index, 38, 'every size of the era at both rates, and then the end');
    const last = memory.u32(DEVMODE_BUFFER + DEVMODEA.dmPelsWidth);
    assert.equal(last, 3456, 'the largest listed is the largest of the era');
    assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEA.dmDisplayFrequency), 120,
        'the second rate of the last size ends the list');
});

test('the display device enumeration names the adapter and the monitor on it', ()=>{
    // The walk a resolution menu is built from: the adapter's name, then every
    // mode under it. A program refused the device has no name to ask modes by
    // and serves a table of its own that no display was ever asked about.
    const { memory, fns } = setup();

    memory.fill(DEVICE_BUFFER, DISPLAY_DEVICEA.SIZE / 4);
    memory.putU32s(DEVICE_BUFFER, [DISPLAY_DEVICEA.SIZE]);
    assert.equal(fns.EnumDisplayDevicesA.argBytes, 16);
    assert.equal(fns.EnumDisplayDevicesA.handler([0, 0, DEVICE_BUFFER, 0]), 1,
        'the one adapter answers at index zero');
    assert.equal(memory.readCString(DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceName, 32),
        '\\\\.\\DISPLAY1', 'the name the mode enumeration beside it is asked by');
    assert.equal(memory.u32(DEVICE_BUFFER + DISPLAY_DEVICEA.StateFlags), 0x5,
        'on the desktop, and the one the desktop is on');
    assert.ok(memory.readCString(DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceString, 128).length > 0,
        'a description a program may show');
    assert.equal(memory.readCString(DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceID, 128), '',
        'no plug-and-play path: a card database keyed by one asks Direct3D instead');
    assert.equal(memory.bytes[DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceName + 31], 0,
        'the field is written whole, so the caller\'s own stack cannot answer through it');

    assert.equal(fns.EnumDisplayDevicesA.handler([0, 1, DEVICE_BUFFER, 0]), 0,
        'and the walk ends where the devices do');
    assert.equal(fns.EnumDisplayDevicesA.handler([0, 0, 0, 0]), 0);

    memory.fill(DEVICE_BUFFER, DISPLAY_DEVICEA.SIZE / 4);
    memory.putU32s(DEVICE_BUFFER, [DISPLAY_DEVICEA.SIZE - 4]);
    assert.equal(fns.EnumDisplayDevicesA.handler([0, 0, DEVICE_BUFFER, 0]), 0,
        'a caller that declared less than the structure is refused');
    assert.equal(memory.u32(DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceName), UNTOUCHED,
        'and nothing is written it made no room for');

    memory.putString(DEVICE_NAME_BUFFER, '\\\\.\\DISPLAY1');
    memory.fill(DEVICE_BUFFER, DISPLAY_DEVICEA.SIZE / 4);
    memory.putU32s(DEVICE_BUFFER, [DISPLAY_DEVICEA.SIZE]);
    assert.equal(fns.EnumDisplayDevicesA.handler([DEVICE_NAME_BUFFER, 0, DEVICE_BUFFER, 0]), 1,
        'the adapter\'s own name asks for the monitor on it');
    assert.equal(memory.u32(DEVICE_BUFFER + DISPLAY_DEVICEA.StateFlags), 0x20000001,
        'attached, and in use');
    assert.equal(memory.readCString(DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceString, 128),
        'Default Monitor', 'a monitor that never reported one');
    assert.equal(memory.readCString(DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceID, 128),
        'MONITOR\\DEFAULT\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\0000');

    memory.putString(DEVICE_NAME_BUFFER, '\\\\.\\display1');
    assert.equal(fns.EnumDisplayDevicesA.handler([DEVICE_NAME_BUFFER, 0, DEVICE_BUFFER, 0]), 1,
        'a device name does not care about case');
    memory.putString(DEVICE_NAME_BUFFER, '\\\\.\\DISPLAY2');
    assert.equal(fns.EnumDisplayDevicesA.handler([DEVICE_NAME_BUFFER, 0, DEVICE_BUFFER, 0]), 0,
        'a name that is not the adapter\'s names nothing');
    assert.equal(fns.EnumDisplayDevicesA.handler([DEVICE_NAME_BUFFER, 1, DEVICE_BUFFER, 0]), 0);
});

test('the wide display device enumeration reads and writes UTF-16', ()=>{
    const { memory, fns } = setup();
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        for (let i = 0; i <= text.length; i++)
        {
            const code = i < text.length ? text.charCodeAt(i) : 0;
            memory.bytes[at + i * 2] = code & 0xff;
            memory.bytes[at + i * 2 + 1] = code >>> 8;
        }
    };
    /** @param {number} at */
    const readWide = at=>{
        let text = '';
        for (let i = 0; ; i++)
        {
            const code = memory.bytes[at + i * 2] | memory.bytes[at + i * 2 + 1] << 8;
            if (code === 0)
            {
                return text;
            }
            text += String.fromCharCode(code);
        }
    };

    memory.fill(DEVICE_BUFFER, DISPLAY_DEVICEW.SIZE / 4);
    memory.putU32s(DEVICE_BUFFER, [DISPLAY_DEVICEW.SIZE]);
    assert.equal(fns.EnumDisplayDevicesW.handler([0, 0, DEVICE_BUFFER, 0]), 1);
    assert.equal(readWide(DEVICE_BUFFER + DISPLAY_DEVICEW.DeviceName), '\\\\.\\DISPLAY1');
    assert.equal(memory.u32(DEVICE_BUFFER + DISPLAY_DEVICEW.StateFlags), 0x5,
        'the state word sits where the wide structure puts it');

    putWide(DEVICE_NAME_BUFFER, '\\\\.\\DISPLAY1');
    memory.fill(DEVICE_BUFFER, DISPLAY_DEVICEW.SIZE / 4);
    memory.putU32s(DEVICE_BUFFER, [DISPLAY_DEVICEW.SIZE]);
    assert.equal(fns.EnumDisplayDevicesW.handler([DEVICE_NAME_BUFFER, 0, DEVICE_BUFFER, 0]), 1,
        'the monitor answers through the wide spelling too');
    assert.equal(readWide(DEVICE_BUFFER + DISPLAY_DEVICEW.DeviceString), 'Default Monitor');
    assert.equal(memory.u32(DEVICE_BUFFER + DISPLAY_DEVICEW.StateFlags), 0x20000001);

    memory.fill(DEVICE_BUFFER, DISPLAY_DEVICEW.SIZE / 4);
    memory.putU32s(DEVICE_BUFFER, [DISPLAY_DEVICEA.SIZE]);
    assert.equal(fns.EnumDisplayDevicesW.handler([0, 0, DEVICE_BUFFER, 0]), 0,
        'the ANSI size declares the ANSI structure, not this one');
    assert.equal(memory.u32(DEVICE_BUFFER + DISPLAY_DEVICEW.DeviceName), UNTOUCHED);
});

test('the name the device enumeration gives is one the mode enumeration takes', ()=>{
    // The pair a resolution menu is built from: the adapter's name, then every
    // mode under it until the walk ends. The two answers have to agree on what
    // the display is called, or the second walk is asked for a device nobody
    // ever named and comes back empty.
    const { memory, fns } = setup();
    memory.putU32s(DEVICE_BUFFER, [DISPLAY_DEVICEA.SIZE]);
    assert.equal(fns.EnumDisplayDevicesA.handler([0, 0, DEVICE_BUFFER, 0]), 1);
    const name = DEVICE_BUFFER + DISPLAY_DEVICEA.DeviceName;

    memory.putU32s(DEVMODE_BUFFER, new Array(40).fill(0));
    let index = 0;
    while (fns.EnumDisplaySettingsA.handler([name, index, DEVMODE_BUFFER]) !== 0)
    {
        index++;
        assert.ok(index < 1000, 'the enumeration did not terminate');
    }
    assert.equal(index, 38, 'every mode the display offers answers under its own name');
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

test('a frame is as wide as the non-client metrics make it, and SM_CXDLGFRAME says so', ()=>{
    // user32's window tests check AdjustWindowRectEx against the classic
    // non-client model: a dialog or sizing frame has a two-pixel outer edge,
    // a sizing frame one more for the sizing border, a border or dialog frame
    // one more, a static edge alone one, and a client edge two inside the
    // rest. WS_EX_WINDOWEDGE is the look of the outer edge, not more width.
    const WS_BORDER = 0x00800000;
    const WS_DLGFRAME = 0x00400000;
    const WS_POPUP = 0x80000000;
    const WS_EX_DLGMODALFRAME = 0x00000001;
    const WS_EX_WINDOWEDGE = 0x00000100;
    const WS_EX_STATICEDGE = 0x00020000;
    const SM_CXDLGFRAME = 7;
    const SM_CYDLGFRAME = 8;
    const { memory, fns } = setup();
    /** @param {number} style @param {number} exStyle @returns {number[]} */
    const grown = (style, exStyle)=>{
        memory.putU32s(RECT_BUFFER, [0, 0, 100, 100]);
        fns.AdjustWindowRectEx.handler([RECT_BUFFER, style, 0, exStyle]);
        return [0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at) | 0);
    };
    assert.deepEqual(grown(WS_CAPTION, 0), [-3, -22, 103, 103], 'a dialog frame is three');
    assert.deepEqual(grown(WS_CAPTION | WS_THICKFRAME, 0), [-4, -23, 104, 104],
        'a sizing frame four');
    assert.deepEqual(grown(WS_BORDER, 0), [-1, -1, 101, 101], 'a border one');
    assert.deepEqual(grown(WS_DLGFRAME, 0), [-3, -3, 103, 103]);
    assert.deepEqual(grown(WS_THICKFRAME, 0), [-3, -3, 103, 103],
        'a sizing frame with no border has no inner line');
    assert.deepEqual(grown(WS_POPUP | WS_CAPTION, WS_EX_DLGMODALFRAME), [-3, -22, 103, 103]);
    assert.deepEqual(grown(WS_POPUP, WS_EX_DLGMODALFRAME), [-3, -3, 103, 103]);
    assert.deepEqual(grown(WS_POPUP, WS_EX_STATICEDGE), [-1, -1, 101, 101]);
    assert.deepEqual(grown(WS_BORDER, WS_EX_CLIENTEDGE), [-3, -3, 103, 103]);
    assert.deepEqual(grown(WS_POPUP, WS_EX_WINDOWEDGE), [0, 0, 100, 100]);
    assert.deepEqual(grown(WS_CAPTION | WS_THICKFRAME, WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE),
        [-6, -25, 106, 106]);
    assert.deepEqual([SM_CXDLGFRAME, SM_CYDLGFRAME].map(index=>
        fns.GetSystemMetrics.handler([index])), [3, 3]);
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

test('wvsprintfA stops its va_list window at the end of its region', ()=>{
    // The list sits 8 bytes below the top of the region: the two slots the
    // format reads are there, the fixed 64-slot window reaches off the end,
    // and memory that does not exist must throw only for the part nobody
    // asked for -- which is to say, for none of it.
    const { memory, fns } = setup();
    memory.regionAt = address=>address >= 0x10000 && address < 0x14000
        ? { base: 0x10000, size: 0x4000 } : null;
    memory.putString(FORMAT_BUFFER, '%s=%d');
    memory.putString(TEXT_BUFFER, 'x');
    memory.putU32s(0x13ff8, [TEXT_BUFFER, 42]);

    assert.equal(fns.wvsprintfA.handler([OUT_BUFFER, FORMAT_BUFFER, 0x13ff8]), 4);
    assert.equal(memory.readCString(OUT_BUFFER, 64), 'x=42');
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

test('the IsChar family classifies a character of the ANSI page, or a UTF-16 one', ()=>{
    const { fns } = setup();
    /** @param {string} name @param {number} code */
    const ask = (name, code)=>fns[name].handler([code]);

    for (const name of ['IsCharAlphaA', 'IsCharAlphaNumericA', 'IsCharLowerA', 'IsCharUpperA',
        'IsCharAlphaW', 'IsCharAlphaNumericW', 'IsCharLowerW', 'IsCharUpperW'])
    {
        assert.equal(fns[name].argBytes, 4, `${name} pops its one argument`);
    }
    assert.equal(ask('IsCharAlphaA', 0x61), 1, 'a letter');
    assert.equal(ask('IsCharAlphaA', 0x31), 0, 'a digit is not');
    assert.equal(ask('IsCharAlphaNumericA', 0x31), 1, 'but is alphanumeric');
    assert.equal(ask('IsCharAlphaNumericA', 0x2d), 0, 'and a dash is neither');
    assert.equal(ask('IsCharAlphaA', 0xe9), 1, 'an accented letter of the page counts');
    assert.equal(ask('IsCharUpperA', 0xc9), 1, 'and has a case');
    assert.equal(ask('IsCharLowerA', 0xc9), 0);
    assert.equal(ask('IsCharLowerA', 0xdf), 1, 'sharp s is a lowercase letter');
    assert.equal(ask('IsCharUpperA', 0x8a), 1, 'S caron sits among the page\'s own additions');
    assert.equal(ask('IsCharAlphaA', 0xffffff41), 1, 'a CHAR widened with its sign is still A');
    assert.equal(ask('IsCharLowerW', 0x0431), 1, 'a Cyrillic small letter, read as UTF-16');
    assert.equal(ask('IsCharUpperW', 0x0411), 1);
    assert.equal(ask('IsCharAlphaW', 0x3000), 0, 'an ideographic space is no letter');
});

test('GetCursorInfo reports the cursor, whether it shows and where, for a declared size', ()=>{
    const { memory, fns, errors } = setup({ cursor: { x: 12, y: 34 } });
    const CURSORINFO_SIZE = 20;
    const CURSOR_SHOWING = 1;
    const ERROR_INVALID_PARAMETER = 87;
    fns.SetCursor.handler([0x300]);
    memory.putU32s(OUT_BUFFER, [CURSORINFO_SIZE, UNTOUCHED, UNTOUCHED, UNTOUCHED, UNTOUCHED]);

    assert.equal(fns.GetCursorInfo.handler([OUT_BUFFER]), 1);
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>memory.u32(OUT_BUFFER + at)),
        [CURSORINFO_SIZE, CURSOR_SHOWING, 0x300, 12, 34]);

    fns.ShowCursor.handler([0]);
    fns.GetCursorInfo.handler([OUT_BUFFER]);
    assert.equal(memory.u32(OUT_BUFFER + 4), 0, 'a count below zero is not showing');

    memory.putU32s(OUT_BUFFER, [CURSORINFO_SIZE - 1]);
    assert.equal(fns.GetCursorInfo.handler([OUT_BUFFER]), 0, 'a wrong cbSize is refused');
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER]);
});

test('SystemParametersInfoW answers the work area as the A spelling does', ()=>{
    const { memory, fns } = setup();
    const SPI_GETWORKAREA = 0x0030;
    memory.fill(RECT_BUFFER, 4);

    assert.equal(fns.SystemParametersInfoW.argBytes, 16);
    assert.equal(fns.SystemParametersInfoW.handler([SPI_GETWORKAREA, 0, RECT_BUFFER, 0]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at)),
        [0, 0, SCREEN.width, SCREEN.height]);
    assert.equal(fns.SystemParametersInfoW.handler([0x0068, 0, RECT_BUFFER, 0]), 0,
        'and refuses what the A spelling refuses');
});

test('SetMessageExtraInfo answers with the value it replaced, which GetMessageExtraInfo read', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetMessageExtraInfo.handler([]), 0, 'nothing set yet');
    assert.equal(fns.SetMessageExtraInfo.handler([0xdeadbeef]), 0);
    assert.equal(fns.GetMessageExtraInfo.handler([]), 0xdeadbeef);
    assert.equal(fns.SetMessageExtraInfo.handler([7]), 0xdeadbeef);
    assert.equal(fns.SetMessageExtraInfo.argBytes, 4);
    assert.equal(fns.GetMessageExtraInfo.argBytes, 0);
});

/** TrackMouseEvent's flags, and the messages its tracking posts. */
const TME_HOVER = 0x1;
const TME_LEAVE = 0x2;
const TME_NONCLIENT = 0x10;
const TME_QUERY = 0x40000000;
const TME_CANCEL = 0x80000000;
const HOVER_DEFAULT = 0xffffffff;
const HOVER_TIME = 400;
const WM_MOUSEMOVE = 0x0200;
const WM_NCMOUSEHOVER = 0x02a0;
const WM_MOUSEHOVER = 0x02a1;
const WM_NCMOUSELEAVE = 0x02a2;
const WM_MOUSELEAVE = 0x02a3;

/**
 * A captioned window with a child in its client area, the pointer resting on
 * the window's client area clear of the child, and the calls a test of the
 * tracking makes: TrackMouseEvent asked and queried, the pointer moved as the
 * input layer moves it, and the queue emptied.
 */
function trackingSetup(){
    const WS_CHILD = 0x40000000;
    const TRACKMOUSEEVENT_SIZE = 16;
    const POINT = OUT_BUFFER + 0x40;
    const cursor = { x: 0, y: 0 };
    const context = setup({ cursor });
    const { memory, fns, queue } = context;
    const parent = makeWindow(memory, fns, WS_CAPTION | WS_VISIBLE);
    const child = fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, WS_CHILD | WS_VISIBLE, 50, 50, 100, 100, parent, 0, HINSTANCE, 0]);
    /** @param {number} hwnd @param {number} x @param {number} y */
    const onScreen = (hwnd, x, y)=>{
        memory.putU32s(POINT, [x, y]);
        fns.ClientToScreen.handler([hwnd, POINT]);
        return { x: memory.u32(POINT), y: memory.u32(POINT + 4) };
    };
    /** @param {{ x: number, y: number }} point */
    const moveTo = point=>{
        cursor.x = point.x;
        cursor.y = point.y;
        queue.post({ hwnd: 0, message: WM_MOUSEMOVE, wParam: 0, lParam: 0, x: point.x,
            y: point.y });
    };
    /** @param {number} flags @param {number} hwnd @param {number} [hoverTime] */
    const track = (flags, hwnd, hoverTime = 0)=>{
        memory.putU32s(OUT_BUFFER, [TRACKMOUSEEVENT_SIZE, flags, hwnd, hoverTime]);
        return fns.TrackMouseEvent.handler([OUT_BUFFER]);
    };
    /** What a TME_QUERY fills in: the flags, the window and the hover time. */
    const query = ()=>{
        memory.putU32s(OUT_BUFFER, [TRACKMOUSEEVENT_SIZE, TME_QUERY, 0xdeadbeef, 0xdeadbeef]);
        assert.equal(fns.TrackMouseEvent.handler([OUT_BUFFER]), 1, 'a query succeeds');
        assert.equal(memory.u32(OUT_BUFFER), TRACKMOUSEEVENT_SIZE, 'and leaves cbSize alone');
        return [4, 8, 12].map(at=>memory.u32(OUT_BUFFER + at));
    };
    /** Every posted message, up to the paint that stays until it is painted. */
    const take = ()=>{
        const WM_PAINT = 0x000f;
        const taken = [];
        for (let message = queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true });
            message !== null && message.message !== WM_PAINT;
            message = queue.peek({ hwnd: ANY_WINDOW, first: 0, last: 0, remove: true }))
        {
            taken.push([message.hwnd, message.message, message.wParam, message.lParam]);
        }
        return taken;
    };
    const rest = onScreen(parent, 10, 10);
    cursor.x = rest.x;
    cursor.y = rest.y;
    return { ...context, parent, child, onScreen, moveTo, track, query, take, rest };
}

test('TrackMouseEvent refuses a wrong cbSize and a window that does not exist', ()=>{
    // user32's message tests: a query with cbSize 0 fails with
    // ERROR_INVALID_PARAMETER, and TME_HOVER, cancelled or not, for a handle
    // naming no window fails with ERROR_INVALID_WINDOW_HANDLE.
    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_INVALID_WINDOW_HANDLE = 1400;
    const { memory, fns, errors, track } = trackingSetup();
    memory.putU32s(OUT_BUFFER, [0, TME_QUERY, 0xdeadbeef, 0xdeadbeef]);

    assert.equal(fns.TrackMouseEvent.argBytes, 4);
    assert.equal(fns.TrackMouseEvent.handler([OUT_BUFFER]), 0);
    assert.equal(track(TME_HOVER, 0xdeadbeef, 0xdeadbeef), 0);
    assert.equal(track(TME_HOVER | TME_CANCEL, 0xdeadbeef, 0xdeadbeef), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_WINDOW_HANDLE,
        ERROR_INVALID_WINDOW_HANDLE]);
});

test('TrackMouseEvent posts WM_MOUSEHOVER once the pointer has rested for the hover time', ()=>{
    // user32's message tests: nothing is tracked to begin with; hover asked
    // for a window the pointer is not over is accepted and tracks nothing; a
    // hover time of 0 or HOVER_DEFAULT is SPI_GETMOUSEHOVERTIME's, which a
    // query reports; a move of a pixel and back inside the hover rectangle
    // does not start the time again; WM_MOUSEHOVER arrives with no buttons
    // down, and the tracking has ended when it does.
    const { memory, fns, clock, parent, child, rest, moveTo, track, query, take } =
        trackingSetup();
    assert.deepEqual(query(), [0, 0, 0], 'nothing tracked');
    assert.equal(track(TME_HOVER, child), 1);
    assert.deepEqual(query(), [0, 0, 0], 'the pointer is not over the child');

    assert.equal(track(TME_HOVER, parent, 0), 1);
    assert.deepEqual(query(), [TME_HOVER, parent, HOVER_TIME]);
    clock.at = HOVER_TIME / 2;
    moveTo({ x: rest.x - 1, y: rest.y });
    moveTo(rest);
    assert.deepEqual(query(), [TME_HOVER, parent, HOVER_TIME]);
    clock.at = HOVER_TIME - 1;
    assert.deepEqual(take().map(entry=>entry[1]), [WM_MOUSEMOVE], 'not yet');
    clock.at = HOVER_TIME;
    assert.deepEqual(take(), [[parent, WM_MOUSEHOVER, 0, (10 << 16 | 10) >>> 0]],
        'where the pointer is, in client coordinates');
    assert.deepEqual(query(), [0, 0, 0], 'hover tracking stops once it is posted');

    assert.equal(track(TME_HOVER, parent, HOVER_DEFAULT), 1);
    assert.deepEqual(query(), [TME_HOVER, parent, HOVER_TIME]);
    clock.at += 100;
    moveTo({ x: rest.x + 5, y: rest.y });
    clock.at += HOVER_TIME - 1;
    assert.deepEqual(take().map(entry=>entry[1]), [WM_MOUSEMOVE],
        'leaving the hover rectangle starts the time again');
    clock.at += 1;
    assert.deepEqual(take(), [[parent, WM_MOUSEHOVER, 0, (10 << 16 | 15) >>> 0]]);

    assert.equal(track(TME_HOVER, parent, 50), 1);
    assert.deepEqual(query(), [TME_HOVER, parent, 50], 'a time of its own is its own');
    memory.putU32s(OUT_BUFFER, [16, TME_HOVER | TME_CANCEL, parent, 0xdeadbeef]);
    assert.equal(fns.TrackMouseEvent.handler([OUT_BUFFER]), 1);
    assert.deepEqual(query(), [0, 0, 0], 'cancelled');
    clock.at += 1000;
    assert.deepEqual(take(), [], 'and nothing is posted');
});

test('TrackMouseEvent posts WM_MOUSELEAVE when the pointer leaves, or at once if it is out', ()=>{
    // As documented for TRACKMOUSEEVENT: a leave asked for a window or area
    // the pointer is not over is posted at once and nothing is tracked, and
    // WM_MOUSELEAVE, like WM_NCMOUSELEAVE, ends all the tracking asked for.
    // Moving onto a child is leaving the parent's client area.
    const { clock, parent, child, onScreen, rest, moveTo, track, query, take } =
        trackingSetup();
    assert.equal(track(TME_LEAVE, child), 1);
    assert.deepEqual(query(), [0, 0, 0]);
    assert.deepEqual(take(), [[child, WM_MOUSELEAVE, 0, 0]], 'posted at once');

    assert.equal(track(TME_LEAVE | TME_HOVER, parent), 1);
    assert.deepEqual(query().slice(0, 2), [TME_LEAVE | TME_HOVER, parent]);
    moveTo(onScreen(child, 5, 5));
    assert.deepEqual(take(), [[parent, WM_MOUSELEAVE, 0, 0],
        [child, WM_MOUSEMOVE, 0, (5 << 16 | 5) >>> 0]], 'the leave comes before the move');
    assert.deepEqual(query(), [0, 0, 0], 'and ends the hover too');
    clock.at += 1000;
    assert.deepEqual(take(), []);

    moveTo(rest);
    take();
    const caption = onScreen(parent, 10, -5);
    assert.equal(track(TME_LEAVE | TME_NONCLIENT, parent), 1);
    assert.deepEqual(take(), [[parent, WM_NCMOUSELEAVE, 0, 0]],
        'the frame is an area of its own, and the pointer is not on it');
    moveTo(caption);
    take();
    assert.equal(track(TME_LEAVE | TME_HOVER | TME_NONCLIENT, parent), 1);
    assert.deepEqual(query().slice(0, 2), [TME_LEAVE | TME_HOVER | TME_NONCLIENT, parent]);
    clock.at += HOVER_TIME;
    const HTCAPTION = 2;
    assert.deepEqual(take(), [[parent, WM_NCMOUSEHOVER, HTCAPTION,
        (caption.y << 16 | caption.x) >>> 0]], 'a frame hover names the hit and the screen point');
    moveTo(rest);
    assert.deepEqual(take().map(entry=>entry[1]), [WM_NCMOUSELEAVE, WM_MOUSEMOVE]);
});

test('SystemParametersInfo answers the hover time and the hover rectangle', ()=>{
    // user32's message tests read all three before tracking a hover.
    const { memory, fns } = setup();
    const SPI_GETMOUSEHOVERWIDTH = 0x0062;
    const SPI_GETMOUSEHOVERHEIGHT = 0x0064;
    const SPI_GETMOUSEHOVERTIME = 0x0066;
    /** @param {number} action */
    const ask = action=>{
        memory.fill(OUT_BUFFER, 1);
        assert.equal(fns.SystemParametersInfoA.handler([action, 0, OUT_BUFFER, 0]), 1);
        return memory.u32(OUT_BUFFER);
    };
    assert.deepEqual([SPI_GETMOUSEHOVERWIDTH, SPI_GETMOUSEHOVERHEIGHT, SPI_GETMOUSEHOVERTIME]
        .map(ask), [4, 4, HOVER_TIME]);
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

test('wsprintfW formats wide, takes a wide %s and a narrow %S, and writes UTF-16', ()=>{
    const { memory, fns } = setup();
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        for (let i = 0; i <= text.length; i++)
        {
            const code = i < text.length ? text.charCodeAt(i) : 0;
            memory.bytes[at + i * 2] = code & 0xff;
            memory.bytes[at + i * 2 + 1] = code >>> 8;
        }
    };
    /** @param {number} at */
    const readWide = at=>{
        let text = '';
        for (let i = 0; ; i++)
        {
            const code = memory.bytes[at + i * 2] | memory.bytes[at + i * 2 + 1] << 8;
            if (code === 0)
            {
                return text;
            }
            text += String.fromCharCode(code);
        }
    };
    putWide(FORMAT_BUFFER, '%s: %S #%d');
    putWide(TEXT_BUFFER, 'Wide');
    memory.putString(TEXT_BUFFER + 0x40, 'narrow');

    const written = fns.wsprintfW.handler(
        [OUT_BUFFER, FORMAT_BUFFER, TEXT_BUFFER, TEXT_BUFFER + 0x40, 7]);
    assert.equal(readWide(OUT_BUFFER), 'Wide: narrow #7');
    assert.equal(written, 'Wide: narrow #7'.length);
    assert.equal(fns.wsprintfW.convention, 'cdecl');
    assert.equal(fns.wsprintfW.argBytes, fns.wsprintfA.argBytes);
});

test('the keyboard is the enhanced one, and anything else asked of it is nothing', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetKeyboardType.handler([0]), 4, 'type: enhanced 101/102-key');
    assert.equal(fns.GetKeyboardType.handler([1]), 0, 'subtype');
    assert.equal(fns.GetKeyboardType.handler([2]), 12, 'function keys');
    assert.equal(fns.GetKeyboardType.handler([3]), 0);
    assert.equal(fns.GetKeyboardType.argBytes, 4);
});

test('GetKeyboardLayout answers the one supported layout for any thread, including zero', ()=>{
    const { fns } = setup();
    const layout = fns.GetKeyboardLayout.handler([0]);
    assert.notEqual(layout, 0, 'never nothing for a live thread');
    assert.equal(layout, fns.GetKeyboardLayout.handler([4321]),
        'GetKeyboardLayout(0) equals GetKeyboardLayout(GetCurrentThreadId()) -- one layout');
    assert.equal(layout >>> 16, layout & 0xffff,
        'the default layout: device handle equals the language id');
    assert.equal(layout & 0xffff, 0x0409, 'en-US');
});

test('MapVirtualKeyA maps a virtual key to its scan code and back, and a scan code to the '
    + 'sided virtual key', ()=>{
    const { fns } = setup();
    const MAPVK_VK_TO_VSC = 0;
    const MAPVK_VSC_TO_VK = 1;
    const MAPVK_VK_TO_CHAR = 2;
    const MAPVK_VSC_TO_VK_EX = 3;

    assert.equal(fns.MapVirtualKeyA.handler([0x41, MAPVK_VK_TO_VSC]), 0x1e,
        'VK_A -> its scan code');
    assert.equal(fns.MapVirtualKeyA.handler([0x1e, MAPVK_VSC_TO_VK]), 0x41, 'and back');
    assert.equal(fns.MapVirtualKeyA.handler([0x41, MAPVK_VK_TO_CHAR]), 0x41,
        'the unshifted char of a letter key is its own uppercase code, as before this change');

    // The scan code 0x1d names both control keys; VSC_TO_VK answers the generic (paired) VK,
    // VSC_TO_VK_EX the side that owns that scan code.
    assert.equal(fns.MapVirtualKeyA.handler([0x1d, MAPVK_VSC_TO_VK]), 0x11,
        'VK_CONTROL, not a side');
    assert.equal(fns.MapVirtualKeyA.handler([0x1d, MAPVK_VSC_TO_VK_EX]), 0xa2, 'VK_LCONTROL');

    assert.equal(fns.MapVirtualKeyA.handler([0xff, MAPVK_VK_TO_VSC]), 0,
        'no key at that code: nothing');
});

test('MAPVK_VK_TO_VSC_EX prefixes a scan code only where the E0 half alone has the key', ()=>{
    // user32's input tests: a right-hand control carries its E0 prefix, the
    // arrows answer the keypad's unprefixed code that also sends them, and
    // Print Screen answers SysRq's.
    const { fns } = setup();
    const MAPVK_VK_TO_VSC_EX = 4;
    const hkl = fns.GetKeyboardLayout.handler([0]);
    /** @type {[number, number][]} */
    const expected = [
        [0xa1, 0x36],     // VK_RSHIFT
        [0x6a, 0x37],     // VK_MULTIPLY
        [0x90, 0x45],     // VK_NUMLOCK
        [0x26, 0x48],     // VK_UP
        [0xa2, 0x1d],     // VK_LCONTROL
        [0xa3, 0xe01d],   // VK_RCONTROL
        [0xa5, 0xe038],   // VK_RMENU
        [0x91, 0x46],     // VK_SCROLL
        [0x2c, 0x54],     // VK_SNAPSHOT
        [0x6f, 0xe035],   // VK_DIVIDE
    ];
    for (const [vk, scan] of expected)
    {
        assert.equal(fns.MapVirtualKeyExA.handler([vk, MAPVK_VK_TO_VSC_EX, hkl]), scan,
            `VK 0x${vk.toString(16)}`);
    }
    assert.equal(fns.MapVirtualKeyA.handler([0xa3, 0]), 0x1d,
        'and MAPVK_VK_TO_VSC never carries the prefix');
    assert.equal(fns.MapVirtualKeyW.handler([0xa3, MAPVK_VK_TO_VSC_EX]), 0xe01d,
        'the other spellings answer alike');
});

test('MapVirtualKeyExA behaves as MapVirtualKeyA for the one layout this build has', ()=>{
    const { fns } = setup();
    const MAPVK_VK_TO_VSC = 0;
    const hkl = fns.GetKeyboardLayout.handler([0]);
    assert.equal(
        fns.MapVirtualKeyExA.handler([0x41, MAPVK_VK_TO_VSC, hkl]),
        fns.MapVirtualKeyA.handler([0x41, MAPVK_VK_TO_VSC]),
    );
});

test('ToUnicode reads the shift and caps-lock bits out of the caller\'s key-state array', ()=>{
    const { memory, fns } = setup();
    const KEY_STATE = 0x11e00;
    const CHAR_BUFFER = 0x11f00;

    memory.writeMemory(KEY_STATE, new Uint8Array(256));
    assert.equal(fns.ToUnicode.handler([0x41, 0x1e, KEY_STATE, CHAR_BUFFER, 1, 0]), 1,
        'one character translated');
    assert.equal(memory.bytes[CHAR_BUFFER], 'a'.charCodeAt(0),
        'no shift, no caps lock: lowercase');

    const shifted = new Uint8Array(256);
    shifted[0x10] = 0x80; // VK_SHIFT held
    memory.writeMemory(KEY_STATE, shifted);
    assert.equal(fns.ToUnicode.handler([0x41, 0x1e, KEY_STATE, CHAR_BUFFER, 1, 0]), 1);
    assert.equal(memory.bytes[CHAR_BUFFER], 'A'.charCodeAt(0), 'shift held: uppercase');

    assert.equal(fns.ToUnicode.handler([0x31, 0x02, KEY_STATE, CHAR_BUFFER, 1, 0]), 1);
    assert.equal(memory.bytes[CHAR_BUFFER], '!'.charCodeAt(0),
        'a digit key with shift is its symbol');

    memory.writeMemory(KEY_STATE, new Uint8Array(256));
    assert.equal(fns.ToUnicode.handler([0x26, 0x48, KEY_STATE, CHAR_BUFFER, 1, 0]), 0,
        'a key with no character, such as an arrow, translates to nothing');
});

test('ToUnicode and ToAscii agree, answer nothing for a key going up, and know control', ()=>{
    const { memory, fns } = setup();
    const KEY_STATE = 0x11e00;
    const CHAR_BUFFER = 0x11f00;
    const state = new Uint8Array(256);
    memory.writeMemory(KEY_STATE, state);

    memory.writeMemory(CHAR_BUFFER, new Uint8Array([0xee, 0xee]));
    assert.equal(fns.ToAscii.handler([0xbe, 0x34, KEY_STATE, CHAR_BUFFER, 0]), 1);
    assert.deepEqual([...memory.bytes.subarray(CHAR_BUFFER, CHAR_BUFFER + 2)], [0x2e, 0],
        'the period, in a WORD with its high byte clear');
    assert.equal(fns.ToAsciiEx.handler([0xbe, 0x34, KEY_STATE, CHAR_BUFFER, 0, 0]), 1);
    assert.equal(fns.ToUnicodeEx.handler([0xbe, 0x34, KEY_STATE, CHAR_BUFFER, 1, 0, 0]), 1);

    assert.equal(fns.ToUnicode.handler([0x41, 0x801e, KEY_STATE, CHAR_BUFFER, 1, 0]), 0,
        'the scan code\'s top bit says the key is going up');

    state[0x11] = 0x80;
    memory.writeMemory(KEY_STATE, state);
    assert.equal(fns.ToAscii.handler([0x5a, 0x2c, KEY_STATE, CHAR_BUFFER, 0]), 1);
    assert.equal(memory.bytes[CHAR_BUFFER], 0x1a, 'control and Z');
});

test('VkKeyScan names the key and the shift state that type a character', ()=>{
    const { fns } = setup();

    assert.equal(fns.VkKeyScanA.handler([0x61]), 0x0041, 'a: the A key alone');
    assert.equal(fns.VkKeyScanA.handler([0x41]), 0x0141, 'A: with shift');
    assert.equal(fns.VkKeyScanA.handler([0x3f]), 0x01bf, '?: shift and the slash key');
    assert.equal(fns.VkKeyScanA.handler([0x35]), 0x0035,
        'a digit is its own key, not the keypad\'s');
    assert.equal(fns.VkKeyScanA.handler([0x03]), 0x0243, 'a control code: control and its letter');
    assert.equal(fns.VkKeyScanA.handler([0x0a]), 0x020d, 'a line feed: control and enter');
    assert.equal(fns.VkKeyScanW.handler([0x00e9]), 0xffff, 'nothing on this layout types é');
    assert.equal(fns.VkKeyScanExW.handler([0x20, 0]), 0x0020);
    assert.equal(fns.VkKeyScanExA.argBytes, 8);
});

test('the W spellings of MapVirtualKey are the A ones, and a keypad key has its character', ()=>{
    const { fns } = setup();
    assert.equal(fns.MapVirtualKeyW.handler([0x41, 0]), 0x1e, 'MAPVK_VK_TO_VSC');
    assert.equal(fns.MapVirtualKeyExW.handler([0x1e, 1, 0]), 0x41, 'MAPVK_VSC_TO_VK');
    assert.equal(fns.MapVirtualKeyA.handler([0x67, 2]), 0x37, 'MAPVK_VK_TO_CHAR: keypad 7');
    assert.equal(fns.MapVirtualKeyA.handler([0xbf, 2]), 0x2f);
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

test('ChangeDisplaySettingsA sets any listed mode, and the screen follows it', ()=>{
    const { memory, fns, screen } = setup();
    const CDS_FULLSCREEN = 0x4;
    const CDS_TEST = 0x2;

    putMode(memory, SCREEN.width, SCREEN.height);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, 0]),
        DISP_CHANGE_SUCCESSFUL, 'the mode in effect is on the list');

    // A program of this era asks for the size it was configured for, names
    // the fields it filled, and walks up its own list when refused. Every
    // size EnumDisplaySettings offered can be set, and the metrics move with
    // it: a window created "fullscreen" afterwards is the mode's size.
    putMode(memory, 640, 480);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmFields,
        [DM_PELSWIDTH | DM_PELSHEIGHT | DM_BITSPERPEL | DM_DISPLAYFREQUENCY]);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmBitsPerPel, [32]);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmDisplayFrequency, [85]);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, CDS_FULLSCREEN]),
        DISP_CHANGE_SUCCESSFUL, 'a listed mode is set, whatever refresh rate was asked');
    assert.equal(fns.GetSystemMetrics.handler([SM_CXSCREEN]), 640);
    assert.equal(fns.GetSystemMetrics.handler([SM_CYSCREEN]), 480);
    memory.putU32s(DEVMODE_BUFFER, new Array(40).fill(0));
    assert.equal(fns.EnumDisplaySettingsA.handler([0, 0xffffffff, DEVMODE_BUFFER]), 1);
    assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEA.dmPelsWidth), 640,
        'and the current settings answer the mode set');
    assert.equal(fns.EnumDisplaySettingsA.handler([0, 4, DEVMODE_BUFFER]), 1,
        'while the list still offers the larger sizes of the display');
    assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEA.dmPelsWidth), 1024);

    putMode(memory, 700, 500);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmFields, [DM_PELSWIDTH | DM_PELSHEIGHT]);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, CDS_FULLSCREEN]),
        DISP_CHANGE_BADMODE,
        'a size the list does not carry is refused: a switch reported and not made'
        + ' makes every later metric disagree');
    assert.equal(screen.width, 640, 'and nothing moved');

    putMode(memory, 800, 600);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmFields, [DM_PELSWIDTH | DM_PELSHEIGHT]);
    assert.equal(fns.ChangeDisplaySettingsA.handler([DEVMODE_BUFFER, CDS_TEST]),
        DISP_CHANGE_SUCCESSFUL, 'CDS_TEST answers whether a mode could be set');
    assert.equal(screen.width, 640, 'without setting it');

    assert.equal(fns.ChangeDisplaySettingsA.handler([0, 0]), DISP_CHANGE_SUCCESSFUL,
        'a null mode means the registry mode: the size of the display');
    assert.equal(screen.width, SCREEN.width);
    assert.equal(screen.height, SCREEN.height);

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
        DISP_CHANGE_SUCCESSFUL, 'and the depth of the screen is the mode in effect');

    // The Ex spelling carries the flags two words further along.
    putMode(memory, 800, 600);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEA.dmFields, [DM_PELSWIDTH | DM_PELSHEIGHT]);
    assert.equal(fns.ChangeDisplaySettingsExA.handler([0, DEVMODE_BUFFER, 0, CDS_FULLSCREEN, 0]),
        DISP_CHANGE_SUCCESSFUL);
    assert.equal(screen.width, 800);
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

test('SetCursorPos puts the cursor where the program says, and says so', ()=>{
    // A mouse-look program reads the cursor, takes its distance from the
    // centre as the frame's motion and puts it back to the centre; the
    // placement has to reach the layer that reports the cursor, or the
    // distance is the whole way to the edge every frame.
    const { fns, placed } = setup({ cursor: { x: 0, y: 0 } });
    assert.equal(fns.SetCursorPos.handler([320, 240]), 1);
    assert.equal(fns.SetCursorPos.handler([0xfffffffe, 5]), 1);
    assert.deepEqual(placed, [{ x: 320, y: 240 }, { x: -2, y: 5 }],
        'each placement, as signed integers');
});

test('SendInput injects a mouse move into the input layer', ()=>{
    // A game that reads the pointer's travel and centres it depends on the
    // move having reached the device layer, not merely on the call succeeding.
    const { memory, fns, sent } = setup();
    memory.putU32s(INPUT_BUFFER, [0, 10, -5, 0, 0x0001, 0, 0]);

    assert.equal(fns.SendInput.argBytes, 12);
    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1);
    assert.deepEqual(sent, [{ kind: 'pointerMove', dx: 10, dy: -5 }]);
});

test('SendInput injects every mouse flag one INPUT carries at once', ()=>{
    const { memory, fns, sent } = setup();
    const MOUSEEVENTF_LEFTDOWN = 0x0002;
    const MOUSEEVENTF_LEFTUP = 0x0004;
    memory.putU32s(INPUT_BUFFER, [0, 0, 0, 0, MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_LEFTUP, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1, 'one INPUT, however many flags');
    assert.deepEqual(sent, [
        { kind: 'pointerButton', button: 'left', down: true },
        { kind: 'pointerButton', button: 'left', down: false },
    ]);
});

test('an absolute mouse move is scaled from the normalised display space', ()=>{
    const { memory, fns, sent } = setup({ screen: { width: 1024, height: 768, bitsPerPixel: 32 } });
    // 0x8000 is the centre of 0..65535, and 0 the top-left.
    memory.putU32s(INPUT_BUFFER, [0, 0x8000, 0, 0, 0x8001, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1);
    assert.deepEqual(sent, [{ kind: 'pointerMove', x: 512, y: 0 }]);
});

test('a cbSize that is not an INPUT is refused whole, with the last error set', ()=>{
    const { memory, fns, sent, errors } = setup();
    memory.putU32s(INPUT_BUFFER, [0, 10, -5, 0, 0x0001, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 24]), 0);
    assert.deepEqual(errors, [87], 'ERROR_INVALID_PARAMETER');
    assert.deepEqual(sent, [], 'and nothing was inserted');
});

test('SendInput injects a keyboard event named by virtual key', ()=>{
    const INPUT_KEYBOARD = 1;
    const VK_A = 0x41;
    const { memory, fns, sent } = setup();
    // KEYBDINPUT: wVk, wScan packed into one dword, then dwFlags. No flags:
    // a key going down, named by wVk rather than a scan code.
    memory.putU32s(INPUT_BUFFER, [INPUT_KEYBOARD, VK_A, 0, 0, 0, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1);
    assert.deepEqual(sent, [{ kind: 'key', vk: VK_A, down: true }]);
});

test('SendInput reads a scan code and the key-up flag off KEYBDINPUT', ()=>{
    const INPUT_KEYBOARD = 1;
    const KEYEVENTF_KEYUP = 0x0002;
    const KEYEVENTF_SCANCODE = 0x0008;
    const SCAN_W = 0x11;
    const { memory, fns, sent } = setup();
    memory.putU32s(INPUT_BUFFER,
        [INPUT_KEYBOARD, SCAN_W << 16, KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP, 0, 0, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1);
    assert.deepEqual(sent, [{ kind: 'key', scan: SCAN_W, extended: false, down: false }]);
});

test('SendInput turns KEYEVENTF_UNICODE into a character with no physical key', ()=>{
    const INPUT_KEYBOARD = 1;
    const KEYEVENTF_UNICODE = 0x0004;
    const KEYEVENTF_KEYUP = 0x0002;
    const { memory, fns, sent } = setup();
    const character = 'A'.charCodeAt(0);
    memory.putU32s(INPUT_BUFFER, [INPUT_KEYBOARD, character << 16, KEYEVENTF_UNICODE, 0, 0, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1,
        'the down half produces the character');
    assert.deepEqual(sent, [{ kind: 'text', text: 'A' }]);

    sent.length = 0;
    memory.putU32s(INPUT_BUFFER,
        [INPUT_KEYBOARD, character << 16, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0, 0, 0]);
    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1,
        'the up half is still counted, and produces nothing');
    assert.deepEqual(sent, []);
});

test('SendInput counts an INPUT_HARDWARE event without injecting it', ()=>{
    // A device model of its own -- low-level message replay -- that nothing
    // here reproduces; Windows still accepts the call.
    const INPUT_HARDWARE = 2;
    const { memory, fns, sent, diverged } = setup();
    memory.putU32s(INPUT_BUFFER, [INPUT_HARDWARE, 0, 0, 0, 0, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1);
    assert.deepEqual(sent, []);
    assert.deepEqual(diverged, []);
});

test('an INPUT type nothing here knows is reported rather than silently inserted', ()=>{
    const UNKNOWN_TYPE = 99;
    const { memory, fns, diverged } = setup();
    memory.putU32s(INPUT_BUFFER, [UNKNOWN_TYPE, 0, 0, 0, 0, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 0);
    assert.equal(diverged.length, 1);
    assert.match(diverged[0], /SendInput/);
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
    /** @param {number} key */
    const state = key=>(down.has(key) ? 0x8000 : 0);
    const { fns } = setup({ keyState: state, asyncKeyState: state });

    assert.equal(fns.GetAsyncKeyState.handler([0x41]), 0x8000, 'the high bit is "down"');
    assert.equal(fns.GetAsyncKeyState.handler([0x42]), 0);
    assert.equal(fns.GetKeyState.handler([0x41]), 0x8000);
});

test('GetAsyncKeyState reports a press once and the read clears it', ()=>{
    const router = createInputRouter({ post: ()=>{}, device: ()=>{} });
    const { fns } = setup({ asyncKeyState: key=>router.asyncKeyState(key) });

    router.send({ kind: 'key', code: 'KeyA', down: true });
    assert.equal(fns.GetAsyncKeyState.handler([0x41]), 0x8001,
        'the low bit promises a press since the last call');
    assert.equal(fns.GetAsyncKeyState.handler([0x41]), 0x8000,
        'the press belongs to the call that asked for it');
});

test('GetKeyboardState fills 256 bytes of the router the keys reached', ()=>{
    const router = createInputRouter({ post: ()=>{}, device: ()=>{} });
    const { memory, fns } = setup({ keyboardState: ()=>router.keyboardState() });

    router.send({ kind: 'key', code: 'KeyA', down: true });
    memory.fill(OUT_BUFFER, 64);
    assert.equal(fns.GetKeyboardState.handler([OUT_BUFFER]), 1);
    assert.equal(memory.bytes[OUT_BUFFER + 0x41], 0x80, 'KeyA is virtual key 0x41');
    assert.equal(memory.bytes[OUT_BUFFER + 0x42], 0, 'and no other key reads as down');
});

test('SetKeyboardState becomes the state GetKeyboardState reads back', ()=>{
    const router = createInputRouter({ post: ()=>{}, device: ()=>{} });
    const { memory, fns } = setup({
        keyboardState: ()=>router.keyboardState(),
        setKeyboardState: bytes=>router.setKeyboardState(bytes),
    });

    const table = new Uint8Array(256);
    table[0x41] = 0x80;
    table[0x14] = 0x01;
    memory.writeMemory(KEYBOARD_BUFFER, table);
    assert.equal(fns.SetKeyboardState.handler([KEYBOARD_BUFFER]), 1);

    memory.fill(OUT_BUFFER, 0);
    assert.equal(fns.GetKeyboardState.handler([OUT_BUFFER]), 1);
    assert.equal(memory.bytes[OUT_BUFFER + 0x41], 0x80);
    assert.equal(memory.bytes[OUT_BUFFER + 0x14], 0x01, 'the CapsLock toggle');
});

test('the keyboard-state calls refuse a null pointer', ()=>{
    const { fns } = setup({ keyboardState: ()=>new Uint8Array(256),
        setKeyboardState: ()=>{} });

    assert.equal(fns.GetKeyboardState.handler([0]), 0);
    assert.equal(fns.SetKeyboardState.handler([0]), 0);
});

test('a message box is handed up whole, with the buttons its type asks for', ()=>{
    // A message box is a program explaining, in its own words, why it is about
    // to stop -- the most useful sentence it will ever say. A line in a log is
    // where such a sentence goes to be missed, so whoever is embedding the
    // engine gets it as its own thing, buttons and all, and can put it in front
    // of a person. With nobody listening it answers with its own default.
    const { memory, fns, notices, said } = setup();
    memory.putString(TEXT_BUFFER, 'Unable to initialize DirectX.');
    memory.putString(FORMAT_BUFFER, 'Warcraft III');

    const MB_YESNO = 0x4, MB_ICONERROR = 0x10;
    assert.equal(
        fns.MessageBoxA.handler([0, TEXT_BUFFER, FORMAT_BUFFER, MB_YESNO | MB_ICONERROR]),
        6, 'IDYES: the default button, there being nobody to press one');

    assert.deepEqual(notices, [{
        id: 1,
        text: 'Unable to initialize DirectX.',
        caption: 'Warcraft III',
        type: MB_YESNO | MB_ICONERROR,
        buttons: [{ id: 6, label: 'Yes' }, { id: 7, label: 'No' }],
        defaultButton: 6,
        icon: 'error',
    }]);
    assert.deepEqual(said, ['Warcraft III: Unable to initialize DirectX.'],
        'and it still reaches the log, for a reader who only has that');
});

test('all seven message-box types show the buttons Windows gives them', ()=>{
    const { fns, notices } = setup();
    /** @type {[number, number[]][]} */
    const sets = [
        [0x0, [1]], [0x1, [1, 2]], [0x2, [3, 4, 5]], [0x3, [6, 7, 2]],
        [0x4, [6, 7]], [0x5, [4, 2]], [0x6, [2, 10, 11]],
    ];
    for (const [type, ids] of sets)
    {
        fns.MessageBoxA.handler([0, 0, 0, type]);
        assert.deepEqual(notices.at(-1).buttons.map((/** @type {any} */ button)=>button.id),
            ids, `uType 0x${type.toString(16)}`);
    }
    // A type past the seventh is no set at all, and Windows shows a single OK.
    fns.MessageBoxA.handler([0, 0, 0, 0x7]);
    assert.deepEqual(notices.at(-1).buttons.map((/** @type {any} */ button)=>button.id), [1]);
});

test('MB_DEFBUTTON1..4 chooses which button is the default, and the answer', ()=>{
    const { fns, notices } = setup();
    const MB_YESNOCANCEL = 0x3, MB_DEFBUTTON2 = 0x100, MB_DEFBUTTON3 = 0x200;
    const MB_DEFBUTTON4 = 0x300;

    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_YESNOCANCEL]), 6);
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_YESNOCANCEL | MB_DEFBUTTON2]), 7);
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_YESNOCANCEL | MB_DEFBUTTON3]), 2);
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_YESNOCANCEL | MB_DEFBUTTON4]), 2,
        'a rank past the last button is the last button');
    assert.deepEqual(notices.map(notice=>notice.defaultButton), [6, 7, 2, 2]);
});

test('the icon in uType is named for the page', ()=>{
    const { fns, notices } = setup();
    /** @type {[number, string | null][]} */
    const icons = [
        [0x10, 'error'], [0x20, 'question'], [0x30, 'warning'],
        [0x40, 'information'], [0x80, 'user'], [0x00, null],
    ];
    for (const [bit, name] of icons)
    {
        fns.MessageBoxA.handler([0, 0, 0, bit]);
        assert.equal(notices.at(-1).icon, name, `icon bit 0x${bit.toString(16)}`);
    }
});

test('a message box parks the caller until the page answers it', async()=>{
    // MessageBox is modal and synchronous: it returns the id of the button
    // pressed and not before. The page answers through the id the notice
    // carries, and until it does the call is a promise nothing has settled.
    /** @type {any[]} */
    const notices = [];
    /** @type {((button: number) => void)[]} */
    const waiting = [];
    const { fns } = setup({
        messageBox: notice=>{
            notices.push(notice);
            return new Promise(resolve=>waiting.push(resolve));
        },
    });

    const parked = /** @type {any} */ (fns.MessageBoxA.handler([0, 0, 0, 0x4])); // MB_YESNO
    assert.equal(typeof parked.then, 'function',
        'the call is parked, not answered');
    assert.equal(notices[0].id, 1);
    assert.equal(notices[0].defaultButton, 6);

    waiting[0](7);
    assert.equal(await parked, 7, 'IDNO: the button the page answered');
});

test('a second box is raised while the first is still parked', async()=>{
    // The parked thread is inside its own call and the machine keeps running,
    // so a second box is put up and answered under its own id while the first
    // still waits -- and answering one does not unpark the other.
    /** @type {Map<number, (button: number) => void>} */
    const waiting = new Map();
    const { fns } = setup({
        messageBox: notice=>new Promise(resolve=>waiting.set(notice.id, resolve)),
    });

    const first = /** @type {Promise<number>} */ (
        /** @type {unknown} */ (fns.MessageBoxA.handler([0, 0, 0, 0x4]))); // MB_YESNO
    const second = /** @type {Promise<number>} */ (
        /** @type {unknown} */ (fns.MessageBoxA.handler([0, 0, 0, 0x1]))); // MB_OKCANCEL
    assert.equal(waiting.size, 2, 'two boxes are up at once, under two ids');

    waiting.get(2)?.(2);
    assert.equal(await second, 2, 'IDCANCEL on the second');
    assert.equal(await Promise.race([first.then(()=>'settled'), Promise.resolve('parked')]),
        'parked', 'the first is still waiting on its own answer');

    waiting.get(1)?.(6);
    assert.equal(await first, 6);
});

test('an MB_OK box with nobody listening answers IDOK', ()=>{
    const { fns } = setup();
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, 0]), 1);
});

test('MessageBoxW reads the same box from UTF-16 text', ()=>{
    const { memory, fns, notices, said } = setup();
    /** @param {number} address @param {string} text */
    const putWide = (address, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let at = 0; at < text.length; at++)
        {
            const code = text.charCodeAt(at);
            bytes[at * 2] = code & 0xff;
            bytes[at * 2 + 1] = code >>> 8;
        }
        memory.writeMemory(address, bytes);
    };
    putWide(TEXT_BUFFER, 'Wide text');
    putWide(FORMAT_BUFFER, 'Wide caption');

    assert.equal(fns.MessageBoxW.handler([0, TEXT_BUFFER, FORMAT_BUFFER, 0x4]), 6);
    assert.equal(notices[0].text, 'Wide text');
    assert.equal(notices[0].caption, 'Wide caption');
    assert.deepEqual(notices[0].buttons.map((/** @type {any} */ button)=>button.id), [6, 7]);
    assert.deepEqual(said, ['Wide caption: Wide text']);
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
    assert.deepEqual(notices, [{
        id: 1, text: '', caption: '', type: 0,
        buttons: [{ id: 1, label: 'OK' }], defaultButton: 1, icon: null,
    }]);
});

// --- hot keys ---

const WM_KEYDOWN = 0x0100;
const WM_HOTKEY = 0x0312;

test('a registered hot key answers 1, and its pair is what identifies it', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);

    assert.equal(fns.RegisterHotKey.handler([hwnd, 7, 0x0001, 0x2a]), 1, 'Alt+F');
    assert.equal(fns.RegisterHotKey.argBytes, 16);
    assert.equal(fns.UnregisterHotKey.argBytes, 8);

    // The same (hwnd, id) again with a different combination replaces it, as
    // the contract says, rather than colliding with itself.
    assert.equal(fns.RegisterHotKey.handler([hwnd, 7, 0x0002, 0x2b]), 1);
    assert.equal(fns.UnregisterHotKey.handler([hwnd, 7]), 1, 'and exactly one is gone');
    assert.equal(fns.UnregisterHotKey.handler([hwnd, 7]), 0, 'a second release names nothing');
});

test('a combination already taken fails with 1409, however the windows are related', ()=>{
    const { memory, fns, errors } = setup();
    const first = makeWindow(memory, fns);
    memory.putString(CLASS_NAME, 'Second');
    memory.putU32s(CLASS_STRUCT, [
        0x0003, WNDPROC, 0, 0, HINSTANCE, 0x11, 0x22, 0x33, 0, CLASS_NAME,
    ]);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const second = fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, WS_OVERLAPPED, 0, 0, 320, 240, 0, 0, HINSTANCE, 0]);

    assert.equal(fns.RegisterHotKey.handler([first, 1, 0x0001, 0x09]), 1, 'Alt+Tab');
    assert.equal(fns.RegisterHotKey.handler([second, 1, 0x0001, 0x09]), 0,
        'the same id on another window is still another claim');
    assert.deepEqual(errors, [1409]);
    // MOD_NOREPEAT is a rule about repeats, not part of the combination, so
    // a registration differing only in it collides with the first as well.
    assert.equal(fns.RegisterHotKey.handler([second, 2, 0x4001, 0x09]), 0);
    assert.equal(fns.RegisterHotKey.handler([first, 3, 0x0003, 0x09]), 1,
        'a different modifier set is a different combination');

    assert.equal(fns.UnregisterHotKey.handler([second, 99]), 0, 'never registered');
    assert.equal(errors.at(-1), 1410);
});

const WM_SYSKEYDOWN = 0x0104;
/** The lParam of a first press: transition bit, scan code, nothing else. */
const PRESS = 1 | 0x0f << 16;
/** The same press again while it is held: the previous-state bit says so. */
const REPEAT = PRESS | 0x40000000;

test('a keystroke whose combination is taken becomes WM_HOTKEY, not the key', ()=>{
    const { memory, fns, queue } = setup();
    const hwnd = makeWindow(memory, fns);
    assert.equal(fns.RegisterHotKey.handler([hwnd, 7, 0x0000, 0x41]), 1);

    queue.post({ hwnd: 0, message: WM_KEYDOWN, wParam: 0x41, lParam: PRESS, x: 0, y: 0 });

    const fired = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.ok(fired);
    assert.equal(fired.message, WM_HOTKEY);
    assert.equal(fired.hwnd, hwnd, 'to the window that registered it');
    assert.equal(fired.wParam, 7, 'wParam is the id');
    assert.equal(fired.lParam, 0x41 << 16, 'lParam is MAKELONG(modifiers, vk)');
    assert.equal(queue.depth(), 0, 'and the key itself is gone, not merely followed');
});

test('the held modifiers decide whether a press matches its registration', ()=>{
    // The Alt+Tab a full-screen game registers, spelled the way the input
    // layer actually reports it: Alt down, then Tab as a system key.
    const { fns, queue } = setup({ keyState: key=>(key === 0x12 ? 0x8000 : 0) });
    assert.equal(fns.RegisterHotKey.handler([0x40, 1, 0x0001, 0x09]), 1);

    queue.post({ hwnd: 0, message: WM_SYSKEYDOWN, wParam: 0x09, lParam: PRESS, x: 0, y: 0 });
    const fired = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.ok(fired);
    assert.equal(fired.message, WM_HOTKEY);
    assert.equal(fired.hwnd, 0x40);
    assert.equal(fired.lParam, 0x09 << 16 | 0x0001);

    // The same Tab with Alt *not* held is not the combination, and stays the
    // window's own key.
    const idle = setup();
    idle.fns.RegisterHotKey.handler([0x40, 1, 0x0001, 0x09]);
    idle.queue.post({ hwnd: 0x40, message: WM_SYSKEYDOWN, wParam: 0x09, lParam: PRESS,
        x: 0, y: 0 });
    assert.equal(idle.queue.peek({ hwnd: null, first: 0, last: 0, remove: true })?.message,
        WM_SYSKEYDOWN, 'nobody held Alt: the window gets its key');
});

test('a program\'s own key post is not a keystroke and never fires a hot key', ()=>{
    const { memory, fns, queue } = setup();
    const hwnd = makeWindow(memory, fns);
    assert.equal(fns.RegisterHotKey.handler([hwnd, 7, 0x0000, 0x41]), 1);

    // PostMessage names no position; the same virtual key from the input
    // layer does. Windows claims hardware, not a program talking to itself.
    queue.post({ hwnd: 0x99, message: WM_KEYDOWN, wParam: 0x41, lParam: PRESS });
    const kept = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.ok(kept);
    assert.equal(kept.message, WM_KEYDOWN, 'it reaches the queue as posted');
    assert.equal(kept.hwnd, 0x99);
});

test('MOD_NOREPEAT fires on the press and swallows the repeats', ()=>{
    const { fns, queue } = setup({ keyState: key=>(key === 0x12 ? 0x8000 : 0) });
    assert.equal(fns.RegisterHotKey.handler([0, 0, 0x4001, 0x09]), 1, 'a thread hot key');

    queue.post({ hwnd: 0, message: WM_SYSKEYDOWN, wParam: 0x09, lParam: PRESS, x: 0, y: 0 });
    assert.equal(queue.peek({ hwnd: null, first: 0, last: 0, remove: true })?.message,
        WM_HOTKEY, 'the first press');
    queue.post({ hwnd: 0, message: WM_SYSKEYDOWN, wParam: 0x09, lParam: REPEAT, x: 0, y: 0 });
    assert.equal(queue.peek({ hwnd: null, first: 0, last: 0, remove: true }), null,
        'the repeat is eaten without a second notification');

    // Without the flag, every repeat reports, which is what the ones who did
    // not ask for quiet expect.
    const loud = setup({ keyState: key=>(key === 0x12 ? 0x8000 : 0) });
    loud.fns.RegisterHotKey.handler([0, 0, 0x0001, 0x09]);
    loud.queue.post({ hwnd: 0, message: WM_SYSKEYDOWN, wParam: 0x09, lParam: REPEAT, x: 0, y: 0 });
    assert.equal(loud.queue.peek({ hwnd: null, first: 0, last: 0, remove: true })?.message,
        WM_HOTKEY);
});

test('a thread hot key is posted with no window, and only an every-window pump sees it', ()=>{
    const { fns, queue } = setup({ keyState: key=>(key === 0x12 ? 0x8000 : 0) });
    assert.equal(fns.RegisterHotKey.handler([0, 0, 0x0001, 0x09]), 1);

    queue.post({ hwnd: 0, message: WM_SYSKEYDOWN, wParam: 0x09, lParam: PRESS, x: 0, y: 0 });
    assert.equal(queue.peek({ hwnd: 0x40, first: 0, last: 0, remove: true }), null,
        'a pump naming another window passes it by');
    const fired = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.ok(fired);
    assert.equal(fired.message, WM_HOTKEY);
    assert.equal(fired.hwnd, 0, 'with no window: the thread\'s own message');
    assert.equal(queue.peek({ hwnd: null, first: 0, last: 0, remove: true }), null,
        'and nothing of it is left behind');
});

test('a destroyed window takes its hot keys with it', ()=>{
    const { memory, fns, queue } = setup();
    const hwnd = makeWindow(memory, fns);
    assert.equal(fns.RegisterHotKey.handler([hwnd, 7, 0x0000, 0x41]), 1);
    assert.equal(fns.DestroyWindow.handler([hwnd]), 1);

    queue.post({ hwnd: 0, message: WM_KEYDOWN, wParam: 0x41, lParam: PRESS, x: 0, y: 0 });
    // The range filter walks past WM_DESTROY the destruction left queued.
    const kept = queue.peek({ hwnd: null, first: WM_KEYDOWN, last: WM_HOTKEY, remove: true });
    assert.equal(kept?.message, WM_KEYDOWN,
        'the key is the focused window\'s again, not a dead one\'s');
});

test('a hot key is waiting news, in the class GetQueueStatus asks about', ()=>{
    const { fns, queue } = setup({ keyState: key=>(key === 0x12 ? 0x8000 : 0) });
    assert.equal(fns.RegisterHotKey.handler([0, 0, 0x0001, 0x09]), 1);
    const QS_HOTKEY = 0x0080;

    queue.post({ hwnd: 0, message: WM_SYSKEYDOWN, wParam: 0x09, lParam: PRESS, x: 0, y: 0 });
    const status = queue.status();
    assert.equal(status.inQueue & QS_HOTKEY, QS_HOTKEY);
    assert.equal(status.changed & QS_HOTKEY, QS_HOTKEY, 'and it is news until looked at');
    assert.equal(queue.status().changed & QS_HOTKEY, 0, 'one look spends the news');
});

test('a message box answers a button it actually shows', ()=>{
    // A box answered outside its own set hands the caller a value its switch
    // has no arm for: a yes-or-no question answered "OK" is a program waiting
    // for a click the answer said had already happened.
    const { fns } = setup();
    const MB_OKCANCEL = 0x1, MB_ABORTRETRYIGNORE = 0x2, MB_YESNOCANCEL = 0x3;
    const MB_YESNO = 0x4, MB_RETRYCANCEL = 0x5;
    const MB_DEFBUTTON2 = 0x100, MB_DEFBUTTON3 = 0x200;

    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_YESNO]), 6, 'IDYES: the first button');
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_YESNO | MB_DEFBUTTON2]), 7, 'IDNO');
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_YESNOCANCEL | MB_DEFBUTTON3]), 2,
        'IDCANCEL: the default rank walks the set');
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_RETRYCANCEL]), 4, 'IDRETRY');
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_ABORTRETRYIGNORE]), 3, 'IDABORT');
    assert.equal(fns.MessageBoxA.handler([0, 0, 0, MB_OKCANCEL | MB_DEFBUTTON3]), 2,
        'a rank past the last button is the last button');
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

test('LoadStringW writes the resource string as code units and counts characters', ()=>{
    const { memory, fns } = setup({
        loadString: (instance, id)=>(instance === HINSTANCE && id === 0x10 ? 'Loading' : null),
    });
    memory.fill(OUT_BUFFER, 8);

    assert.equal(fns.LoadStringW.handler([HINSTANCE, 0x10, OUT_BUFFER, 16]), 7,
        'the count is characters, and excludes the terminator');
    const units = [...Array(8).keys()].map(at=>
        memory.bytes[OUT_BUFFER + at * 2] | (memory.bytes[OUT_BUFFER + at * 2 + 1] << 8));
    assert.deepEqual(units, [...'Loading'].map(character=>character.charCodeAt(0)).concat(0));
    assert.equal(fns.LoadStringW.argBytes, 16);
});

test('LoadStringW truncates to the buffer and still terminates it', ()=>{
    const { memory, fns } = setup({ loadString: ()=>'Loading' });

    assert.equal(fns.LoadStringW.handler([HINSTANCE, 0x10, OUT_BUFFER, 4]), 3,
        'three characters and the terminator fill a buffer of four');
    assert.equal(memory.bytes[OUT_BUFFER + 6], 0);
    assert.equal(memory.bytes[OUT_BUFFER + 7], 0);
});

test('LoadStringW reports nothing for a string the image does not have', ()=>{
    const { memory, fns } = setup({ loadString: ()=>null });
    memory.fill(OUT_BUFFER, 4);

    assert.equal(fns.LoadStringW.handler([HINSTANCE, 0x99, OUT_BUFFER, 16]), 0);
    // Emptied rather than left alone: a caller reads the buffer whatever the
    // return says, and unwritten it holds whatever was there before.
    assert.equal(memory.bytes[OUT_BUFFER], 0);
    assert.equal(memory.bytes[OUT_BUFFER + 1], 0);
});
