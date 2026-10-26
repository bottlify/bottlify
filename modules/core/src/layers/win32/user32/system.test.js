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
    DEVMODEA, DEVMODEW, DISPLAY_DEVICEA, DISPLAY_DEVICEW, DM_BITSPERPEL, DM_DISPLAYFREQUENCY,
    DM_PELSHEIGHT, DM_PELSWIDTH, PAINTSTRUCT, RECT,
} from './structs.js';
import { createWindowFunctions } from './windows.js';
import { createInputRouter } from '../../input/router.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { displayModes } from './display.js';

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
 * @param {(region: number) => any} [options.regionBox]
 *        The rectangle a GDI region holds, for the calls that name one.
 * @param {(instance: number) => number} [options.moduleBase]
 *        Where a module is mapped, for a resource read in place.
 * @param {(info: number, bits: number) => number} [options.bitmapFromDib]
 *        The bitmap a packed DIB in guest memory is made into.
 * @param {any} [options.files]  The volume, for an image loaded from a file.
 * @param {(bytes: number) => number} [options.allocate]
 * @param {(address: number) => void} [options.release]
 * @param {(entry: number, args: number[]) => number} [options.call]
 * @param {any} [options.draw]  What draws on a context, for a test that reads its clip.
 * @param {() => unknown} [options.callerThread]  The thread a call is made on.
 * @param {(id: number) => boolean} [options.processExists]  Which process ids are live.
 */
function setup(
    { cursor, keyState, asyncKeyState, keyboardState, setKeyboardState,
        findResource, loadString, dispatch = ()=>0, screen, regionBox,
        moduleBase, bitmapFromDib, files, allocate, release, call, draw, callerThread,
        processExists } = {})
{
    screen ??= { ...SCREEN, displayWidth: SCREEN.width, displayHeight: SCREEN.height };
    const memory = fakeMemory();
    const clock = { at: 0 };
    // The same key-state thunk the real host hands to both, as in module.js:
    // a hot key fires on a combination, and the queue is what reads it.
    const queue = createMessageQueue({ now: ()=>clock.at, keyState });
    const contexts = fakeContexts();
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
        bitmapFromDib,
        files,
        allocate,
        release,
        call,
        loadString,
        regionBox,
        draw,
        callerThread,
        processExists,
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
    return { memory, queue, fns: table, contexts, clock, said, diverged, errors,
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

test('GetWindowInfo answers what the single queries do, and refuses no window as they do', ()=>{
    // win.c's test_window_info: no window is ERROR_INVALID_WINDOW_HANDLE, the
    // atom is GetClassLong's GCW_ATOM and the status WS_ACTIVECAPTION exactly
    // when the window is the active one.
    const GCW_ATOM = -32;
    const WINDOWINFO_SIZE = 60;
    const ERROR_INVALID_WINDOW_HANDLE = 1400;
    const { memory, fns, errors } = setup();
    const hwnd = makeWindow(memory, fns, WS_OVERLAPPED | WS_VISIBLE);
    const other = makeWindow(memory, fns);
    assert.equal(fns.GetWindowInfo.handler([0, OUT_BUFFER]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_WINDOW_HANDLE);

    memory.fill(OUT_BUFFER, WINDOWINFO_SIZE / 4);
    assert.equal(fns.GetWindowInfo.handler([hwnd, OUT_BUFFER]), 1);
    assert.equal(memory.u32(OUT_BUFFER + 56) & 0xffff, fns.GetClassLongA.handler([hwnd, GCW_ATOM]));
    assert.notEqual(memory.u32(OUT_BUFFER + 56) & 0xffff, 0);
    assert.equal(fns.GetActiveWindow.handler([]), hwnd);
    assert.equal(memory.u32(OUT_BUFFER + 44), 1, 'WS_ACTIVECAPTION on the active window');
    fns.GetWindowInfo.handler([other, OUT_BUFFER]);
    assert.equal(memory.u32(OUT_BUFFER + 44), 0, 'and on no other');
});

test('GetTitleBarInfo checks cbSize and reports the caption strip and its buttons', ()=>{
    // win.c's test_GetTitleBarInfo: a wrong cbSize is ERROR_INVALID_PARAMETER;
    // the bar sits above the client area inside the window, and a window with
    // no caption reports the bar invisible.
    const ERROR_INVALID_PARAMETER = 87;
    const WS_OVERLAPPEDWINDOW = 0x00CF0000;
    const STATE_SYSTEM_INVISIBLE = 0x8000;
    const STATE_SYSTEM_FOCUSABLE = 0x100000;
    const { memory, fns, errors } = setup();
    const hwnd = makeWindow(memory, fns, WS_OVERLAPPEDWINDOW | WS_VISIBLE);
    memory.fill(OUT_BUFFER, 11);
    memory.putU32s(OUT_BUFFER, [40]);
    assert.equal(fns.GetTitleBarInfo.handler([hwnd, OUT_BUFFER]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);

    memory.putU32s(OUT_BUFFER, [44]);
    assert.equal(fns.GetTitleBarInfo.handler([hwnd, OUT_BUFFER]), 1);
    fns.GetWindowInfo.handler([hwnd, OUT_BUFFER + 64]);
    const [left, top, right, bottom] = [4, 8, 12, 16].map(at=>memory.u32(OUT_BUFFER + at) | 0);
    const [, , , , clientLeft, clientTop, clientRight] =
        [4, 8, 12, 16, 20, 24, 28].map(at=>memory.u32(OUT_BUFFER + 64 + at) | 0);
    assert.equal(bottom, clientTop, 'the bar ends where the client area begins');
    assert.ok(top < bottom && top >= (memory.u32(OUT_BUFFER + 64 + 8) | 0));
    assert.deepEqual([left, right], [clientLeft, clientRight]);
    assert.equal(memory.u32(OUT_BUFFER + 20), STATE_SYSTEM_FOCUSABLE);
    assert.equal(memory.u32(OUT_BUFFER + 40), 0, 'the close button is there');
    assert.equal(memory.u32(OUT_BUFFER + 36), STATE_SYSTEM_INVISIBLE, 'and no help button');

    const bare = makeWindow(memory, fns, WS_VISIBLE | 0x80000000);
    fns.GetTitleBarInfo.handler([bare, OUT_BUFFER]);
    assert.equal(memory.u32(OUT_BUFFER + 20), STATE_SYSTEM_FOCUSABLE | STATE_SYSTEM_INVISIBLE);
    assert.equal(memory.u32(OUT_BUFFER + 40), STATE_SYSTEM_INVISIBLE);
});

test('GetComboBoxInfo describes a combo box, and only a combo box', ()=>{
    // A program asks for it before it subclasses the parts; one that is not
    // there must not stop the machine (msg.c's combo box tests ask for it).
    const ERROR_INVALID_PARAMETER = 87;
    const CBS_DROPDOWNLIST = 0x3;
    const CBS_SIMPLE = 0x1;
    const STATE_SYSTEM_INVISIBLE = 0x8000;
    const { memory, fns, errors } = setup();
    const main = makeWindow(memory, fns, WS_VISIBLE);
    memory.putString(TITLE, 'ComboBox');
    /** @param {number} style */
    const combo = style=>fns.CreateWindowExA.handler([0, TITLE, 0,
        0x40000000 | WS_VISIBLE | style, 10, 10, 120, 24, main, 0, HINSTANCE, 0]);
    const list = combo(CBS_DROPDOWNLIST);
    memory.putU32s(OUT_BUFFER, [48]);
    assert.equal(fns.GetComboBoxInfo.handler([list, OUT_BUFFER]), 0);
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'a cbSize not the structure\'s');
    memory.putU32s(OUT_BUFFER, [52]);
    assert.equal(fns.GetComboBoxInfo.handler([list, OUT_BUFFER]), 1);
    const [, itemLeft, , itemRight, , buttonLeft, , buttonRight] =
        [0, 4, 8, 12, 16, 20, 24, 28].map(at=>memory.u32(OUT_BUFFER + at) | 0);
    assert.ok(itemLeft < itemRight && itemRight <= buttonLeft && buttonLeft < buttonRight,
        'the field, then the button at the right');
    assert.deepEqual([36, 40].map(at=>memory.u32(OUT_BUFFER + at)), [0, list]);
    fns.GetComboBoxInfo.handler([combo(CBS_SIMPLE), OUT_BUFFER]);
    assert.equal(memory.u32(OUT_BUFFER + 36), STATE_SYSTEM_INVISIBLE, 'CBS_SIMPLE has no button');
    assert.equal(fns.GetComboBoxInfo.handler([main, OUT_BUFFER]), 0, 'no combo box');
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
    // A popup sits on the desktop whatever window it was made over; placed
    // inside one, it is a child of it once its style says so.
    fns.SetParent.handler([child4, child3]);
    fns.SetParent.handler([child3, child2]);
    fns.SetParent.handler([child2, child1]);
    assert.equal(fns.IsChild.handler([child3, child4]), 0);
    fns.SetWindowLongA.handler([child4, GWL_STYLE, WS_CHILD]);
    assert.equal(fns.IsChild.handler([child3, child4]), 1);
    assert.equal(fns.IsChild.handler([child2, child4]), 1);
    assert.equal(fns.IsChild.handler([child1, child4]), 0, 'a popup ends the chain');
    fns.SetWindowLongA.handler([child2, GWL_STYLE, WS_CHILD]);
    assert.equal(fns.IsChild.handler([child1, child4]), 1);
    assert.equal(fns.IsChild.handler([parent, child4]), 1);
});

test('a window made over a child is owned by that child\'s top-level window, and SetParent '
    + 'refuses a window inside itself', ()=>{
    // check_parents in user32's window tests: the owner of a popup made with a
    // child window as its hWndParent is the child's top-level window, which
    // is what GWL_HWNDPARENT, GetParent and GW_OWNER all report; SetParent
    // into the window itself or one of its descendants fails, and answers
    // the desktop as the previous parent of a window that was no child.
    const GWL_HWNDPARENT = -8;
    const GW_OWNER = 4;
    const WS_CHILD = 0x40000000;
    const WS_POPUP = 0x80000000;
    const ERROR_INVALID_PARAMETER = 87;
    const ERROR_TLW_WITH_WSCHILD = 1406;
    const { memory, fns, errors } = setup();
    const desktop = fns.GetDesktopWindow.handler([]);
    const parent = makeWindow(memory, fns);
    /** @param {number} style @param {number} over */
    const make = (style, over)=>fns.CreateWindowExA.handler([0, CLASS_NAME, TITLE, style,
        0, 0, 50, 50, over, 0, HINSTANCE, 0]);
    const child1 = make(WS_CHILD, parent);
    const child2 = make(WS_POPUP, child1);
    const child3 = make(WS_CHILD, child2);
    /** @param {number} hwnd */
    const parents = hwnd=>[fns.GetWindowLongA.handler([hwnd, GWL_HWNDPARENT]),
        fns.GetParent.handler([hwnd]), fns.GetWindow.handler([hwnd, GW_OWNER])];
    assert.deepEqual(parents(parent), [0, 0, 0]);
    assert.deepEqual(parents(child1), [parent, parent, 0]);
    assert.deepEqual(parents(child2), [parent, parent, parent], 'owned by child1\'s top level');
    assert.deepEqual(parents(child3), [child2, child2, 0]);
    assert.equal(make(WS_CHILD, 0), 0, 'a child needs a parent');
    assert.equal(errors.at(-1), ERROR_TLW_WITH_WSCHILD);

    assert.equal(fns.SetParent.handler([parent, child1]), 0, 'not into its own child');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(fns.SetParent.handler([child2, child3]), 0);
    assert.equal(fns.SetParent.handler([child3, child3]), 0, 'nor into itself');
    assert.deepEqual(parents(child3), [child2, child2, 0], 'and a refusal changes nothing');
    assert.equal(fns.SetParent.handler([child1, parent]), parent);
    assert.equal(fns.SetParent.handler([child3, 0]), child2);
    const popup = make(WS_POPUP, 0);
    assert.equal(fns.SetParent.handler([popup, child1]), desktop,
        'a window that was no child had the desktop for its parent');
    assert.deepEqual([1, 2, 3].map(flags=>fns.GetAncestor.handler([popup, flags])),
        [child1, parent, popup], 'inside child1, rooted in its window, owned by nobody');
    assert.equal(fns.DestroyWindow.handler([parent]), 1);
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

test('ValidateRect takes a band off the update area, and a hole out of it', ()=>{
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
        'a hole in the middle leaves the rectangle around the region as it was');
    memory.putU32s(RECT_BUFFER, [0, 30, 100, 40]);
    fns.ValidateRect.handler([hwnd, RECT_BUFFER]);
    memory.putU32s(RECT_BUFFER, [0, 60, 100, 100]);
    fns.ValidateRect.handler([hwnd, RECT_BUFFER]);
    assert.deepEqual(updateRectOf(memory, fns, hwnd), [0, 40, 100, 60],
        'and the region is kept, not the rectangle: the hole stays valid');
    memory.putU32s(RECT_BUFFER, [0, 40, 40, 60]);
    fns.ValidateRect.handler([hwnd, RECT_BUFFER]);
    memory.putU32s(RECT_BUFFER, [60, 40, 100, 60]);
    fns.ValidateRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(updateRectOf(memory, fns, hwnd), null, 'the hole was never to paint again');

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

test('GetWindowRgnBox answers the rectangle of the region SetWindowRgn gave, and ERROR for none',
    ()=>{
        const SIMPLEREGION = 2;
        const box = { left: 1, top: 2, right: 30, bottom: 40 };
        const { memory, fns } = setup({ regionBox: region=>(region === 0x1234 ? box : null) });
        const hwnd = makeWindow(memory, fns);
        assert.equal(fns.GetWindowRgnBox.handler([hwnd, RECT_BUFFER]), 0, 'no region yet');
        fns.SetWindowRgn.handler([hwnd, 0x1234, 1]);
        assert.equal(fns.GetWindowRgnBox.handler([hwnd, RECT_BUFFER]), SIMPLEREGION);
        assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at)), [1, 2, 30, 40]);
        fns.SetWindowRgn.handler([hwnd, 0, 1]);
        assert.equal(fns.GetWindowRgnBox.handler([hwnd, RECT_BUFFER]), 0, 'and none again');
    });

test('MonitorFromPoint finds the monitor for a point on the screen, and none off it only when '
    + 'asked for none', ()=>{
    const { fns } = setup();
    const monitor = fns.MonitorFromWindow.handler([0, 0]);
    assert.equal(fns.MonitorFromPoint.argBytes, 12, 'the point by value');
    assert.equal(fns.MonitorFromPoint.handler([10, 10, 0]), monitor);
    assert.equal(fns.MonitorFromPoint.handler([-5, 10, 0]), 0, 'MONITOR_DEFAULTTONULL');
    assert.equal(fns.MonitorFromPoint.handler([-5, 10, 1]), monitor, 'MONITOR_DEFAULTTOPRIMARY');
    assert.equal(fns.MonitorFromPoint.handler([5000, 10, 2]), monitor, 'MONITOR_DEFAULTTONEAREST');
});

test('EnumDisplayMonitors hands the one monitor to the callback, cut by the clip', async()=>{
    /** @type {number[][]} */
    const seen = [];
    /** @type {any} */
    let box = null;
    const { memory, fns, screen } = setup({
        allocate: ()=>0x7000,
        release: ()=>{},
        call: (entry, args)=>{
            seen.push([entry, ...args]);
            box = Array.from({ length: 4 }, (_, i)=>{
                const b = memory.readMemory(args[2] + i * 4, 4);
                return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) | 0;
            });
            return 0;
        },
    });
    const monitor = fns.MonitorFromWindow.handler([0, 0]);
    assert.equal(fns.EnumDisplayMonitors.argBytes, 16);
    assert.equal(await fns.EnumDisplayMonitors.handler([0, 0, 0x9000, 0x55]), 1,
        'the callback answering FALSE is not the call failing');
    assert.deepEqual(seen, [[0x9000, monitor, 0, 0x7000, 0x55]]);
    assert.deepEqual(box, [0, 0, screen.width, screen.height]);

    memory.writeMemory(RECT_BUFFER, new Uint8Array(new Int32Array([10, 20, 30, 40]).buffer));
    assert.equal(await fns.EnumDisplayMonitors.handler([0, RECT_BUFFER, 0x9000, 0]), 1);
    assert.deepEqual(box, [10, 20, 30, 40]);

    memory.writeMemory(RECT_BUFFER, new Uint8Array(new Int32Array([-50, -50, -10, -10]).buffer));
    assert.equal(await fns.EnumDisplayMonitors.handler([0, RECT_BUFFER, 0x9000, 0]), 1);
    assert.equal(seen.length, 2, 'a clip off the screen leaves no monitor to call about');
    assert.equal(fns.EnumDisplayMonitors.handler([0, 0, 0, 0]), 0, 'no callback');
});

test('SetWindowRgn shapes a live window, which it clips to, and refuses a handle of none', ()=>{
    const { memory, fns, diverged } = setup();
    const hwnd = makeWindow(memory, fns);
    assert.equal(fns.SetWindowRgn.argBytes, 12);
    assert.equal(fns.SetWindowRgn.handler([hwnd, 0x1234, 1]), 1);
    assert.equal(fns.SetWindowRgn.handler([hwnd, 0, 1]), 1);
    assert.equal(fns.SetWindowRgn.handler([0x9999, 0x1234, 1]), 0);
    assert.deepEqual(diverged.filter(text=>text.startsWith('SetWindowRgn')), [],
        'nothing differs from Windows to report');
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
    fns.InvalidateRect.handler([hwnd, 0, 0]);

    const hdc = fns.BeginPaint.handler([hwnd, PAINT_BUFFER]);
    assert.notEqual(hdc, 0, 'a DC was made for the window');

    assert.equal(memory.u32(PAINT_BUFFER + PAINTSTRUCT.hdc), hdc);
    const painted = [0, 4, 8, 12].map(at=>memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + at));
    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    assert.deepEqual(painted, [0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at)),
        'a window invalidated whole paints all of its client area');
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

test('a BeginPaint with nothing to paint paints nowhere: the second of one WM_PAINT', ()=>{
    // A skin paints the dialog in its own WM_PAINT, then hands the message to
    // the procedure it subclassed, whose BeginPaint finds the window clean.
    // Windows clips that one to the empty update region; one that drew
    // everywhere filled the dialog grey over the skin.
    /** @type {[number, any[]][]} */
    const clips = [];
    const { memory, fns } = setup({ draw: {
        clip: (/** @type {number} */ hdc, /** @type {any[]} */ area)=>clips.push([hdc, area]),
    } });
    const hwnd = makeWindow(memory, fns, WS_OVERLAPPED | WS_VISIBLE);
    fns.InvalidateRect.handler([hwnd, 0, 0]);
    const rcPaint = ()=>[0, 4, 8, 12].map(at=>memory.u32(PAINT_BUFFER + PAINTSTRUCT.rcPaint + at));

    const skin = fns.BeginPaint.handler([hwnd, PAINT_BUFFER]);
    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    assert.deepEqual(rcPaint(), [0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at)),
        'the first paints the client area');
    assert.ok((clips.at(-1)?.[1].length ?? 0) > 0, 'and draws where the window shows');
    fns.EndPaint.handler([hwnd, PAINT_BUFFER]);

    const behind = fns.BeginPaint.handler([hwnd, PAINT_BUFFER]);
    assert.notEqual(behind, 0, 'a context all the same');
    assert.notEqual(skin, 0);
    assert.deepEqual(rcPaint(), [0, 0, 0, 0], 'with nothing in rcPaint');
    assert.deepEqual(clips.at(-1), [behind, []], 'and clipped to nothing');
    assert.equal(memory.u32(PAINT_BUFFER + PAINTSTRUCT.fErase), 0, 'nor anything to erase');
    fns.EndPaint.handler([hwnd, PAINT_BUFFER]);
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
    assert.equal(index, displayModes(SCREEN).length,
        'every size of the era at both rates, and then the end');
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
    assert.equal(index, displayModes(SCREEN).length,
        'every mode the display offers answers under its own name');
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

test('a bitmap resource is made from its packed DIB, past the header and its colours', ()=>{
    // The resource is a BITMAPINFOHEADER, the colour table, then the pixels;
    // the pixels start where the colours end, which is what the bits pointer
    // has to say -- one entry short and every row reads the palette's tail.
    const RT_BITMAP = 2;
    const base = 0x8000;
    /** @type {number[][]} */
    const made = [];
    const { memory, fns } = setup({
        findResource: (/** @type {number} */ instance, /** @type {number} */ type,
            /** @type {number | string} */ name)=>(instance === HINSTANCE && type === RT_BITMAP
            ? { 101: { rva: 0x100 }, CloseU: { rva: 0x800 } }[name] ?? null : null),
        moduleBase: (/** @type {number} */ instance)=>(instance === HINSTANCE ? base : 0),
        bitmapFromDib: (/** @type {number} */ info, /** @type {number} */ bits)=>{
            made.push([info, bits]);
            return 0x7000 + made.length;
        },
    });
    // An 8-bit DIB with its full palette, and a 24-bit one with none.
    memory.putU32s(base + 0x100, [40, 16, 16]);
    memory.bytes.set([1, 0, 8, 0], base + 0x100 + 12);
    memory.putU32s(base + 0x800, [40, 16, 16]);
    memory.bytes.set([1, 0, 24, 0], base + 0x800 + 12);
    memory.putString(TEXT_BUFFER, 'CloseU');

    assert.equal(fns.LoadBitmapA.handler([HINSTANCE, 101]), 0x7001);
    assert.deepEqual(made[0], [base + 0x100, base + 0x100 + 40 + 256 * 4]);
    assert.equal(fns.LoadImageA.handler([HINSTANCE, TEXT_BUFFER, 0, 0, 0, 0x2000]), 0x7002,
        'IMAGE_BITMAP, by name');
    assert.deepEqual(made[1], [base + 0x800, base + 0x800 + 40]);
    assert.equal(fns.LoadBitmapA.handler([HINSTANCE, 999]), 0, 'and one it does not carry is null');
});

test('LR_LOADFROMFILE makes a bitmap of a .bmp file, its pixels where bfOffBits says', async()=>{
    // A setup's banner is a file beside it: LoadImage(hinst, "AutoRun\\AutoRun.bmp",
    // IMAGE_BITMAP, 0, 0, LR_LOADFROMFILE | LR_CREATEDIBSECTION). The module
    // handle plays no part; the file is a BITMAPFILEHEADER and a DIB, and a
    // zero bfOffBits means the pixels are packed behind the colours.
    const IMAGE_BITMAP = 0;
    const LR_LOADFROMFILE = 0x10;
    const LR_CREATEDIBSECTION = 0x2000;
    const SCRATCH = 0x9000;
    /** @param {number} offBits @param {number} gap */
    const bmp = (offBits, gap)=>{
        const bytes = new Uint8Array(14 + 40 + gap + 16);
        const view = new DataView(bytes.buffer);
        bytes.set([0x42, 0x4d]);
        view.setUint32(2, bytes.length, true);
        view.setUint32(10, offBits, true);
        view.setUint32(14, 40, true);
        view.setInt32(18, 2, true);
        view.setInt32(22, 2, true);
        view.setUint16(26, 1, true);
        view.setUint16(28, 24, true);
        return bytes;
    };
    /** @type {Map<string, Uint8Array>} */
    const disk = new Map([
        ['C:\\SETUP\\AUTORUN\\AUTORUN.BMP', bmp(14 + 40 + 2, 2)],
        ['C:\\SETUP\\PACKED.BMP', bmp(0, 0)],
        ['C:\\SETUP\\NOTES.TXT', new TextEncoder().encode('not a bitmap at all, only words')],
        ...[0, 11, 13, 39, 41, 107, 109, 123, 125, 26, 116, 0xdeadbeef, 0xffffffff]
            .map(size=>{
                const bytes = bmp(0, 0);
                new DataView(bytes.buffer).setUint32(14, size, true);
                return /** @type {[string, Uint8Array]} */ ([`C:\\SETUP\\SIZE${size}.BMP`, bytes]);
            }),
        ...[[65536, 2], [2, 65536]].map(([width, height])=>{
            const bytes = bmp(0, 0);
            new DataView(bytes.buffer).setInt32(18, width, true);
            new DataView(bytes.buffer).setInt32(22, height, true);
            return /** @type {[string, Uint8Array]} */ ([`C:\\SETUP\\W${width}H${height}.BMP`, bytes]);
        }),
    ]);
    /** @param {string} path */
    const find = path=>disk.get(path.toUpperCase());
    const files = {
        stat: (/** @type {string} */ path)=>(find(path)
            ? { exists: true, isDirectory: false, size: find(path)?.length ?? 0 } : null),
        open: (/** @type {string} */ path)=>find(path) ?? null,
        // Read as a bundle's file is, later.
        read: (/** @type {Uint8Array} */ node, /** @type {number} */ at,
            /** @type {number} */ length)=>Promise.resolve(node.slice(at, at + length)),
        close: ()=>{},
    };
    /** @type {{ info: number, bits: number, header: number }[]} */
    const made = [];
    /** @type {number[]} */
    const released = [];
    const { memory, fns } = setup({
        files,
        allocate: ()=>SCRATCH,
        release: address=>released.push(address),
        bitmapFromDib: (info, bits)=>{
            made.push({ info, bits, header: memory.u32(info) });
            return 0x7100 + made.length;
        },
    });

    memory.putString(TEXT_BUFFER, 'C:\\Setup\\AutoRun\\AutoRun.bmp');
    assert.equal(await fns.LoadImageA.handler([HINSTANCE, TEXT_BUFFER, IMAGE_BITMAP, 0, 0,
        LR_LOADFROMFILE | LR_CREATEDIBSECTION]), 0x7101);
    assert.deepEqual(made[0], { info: SCRATCH, bits: SCRATCH + 40 + 2, header: 40 },
        'the DIB behind the file header, its pixels where the header says');
    assert.deepEqual(released, [SCRATCH], 'and the copy goes once the bitmap is made');

    memory.putString(TEXT_BUFFER, 'C:\\Setup\\Packed.bmp');
    assert.equal(await fns.LoadImageA.handler([0, TEXT_BUFFER, IMAGE_BITMAP, 0, 0,
        LR_LOADFROMFILE]), 0x7102, 'no module needed');
    assert.equal(made[1].bits, SCRATCH + 40, 'packed: no colours for 24 bits');

    memory.putString(TEXT_BUFFER, 'C:\\Setup\\Notes.txt');
    assert.equal(await fns.LoadImageA.handler([0, TEXT_BUFFER, IMAGE_BITMAP, 0, 0,
        LR_LOADFROMFILE]), 0, 'not a bitmap file');
    memory.putString(TEXT_BUFFER, 'C:\\Setup\\Missing.bmp');
    assert.equal(fns.LoadImageA.handler([0, TEXT_BUFFER, IMAGE_BITMAP, 0, 0, LR_LOADFROMFILE]),
        0, 'no file');
    assert.equal(made.length, 2);

    // Wine's cursoricon test: a header of no size a header has, or a side
    // past 65535, is a broken file, refused before its colours are looked for.
    for (const name of [0, 11, 13, 39, 41, 107, 109, 123, 125, 26, 116, 0xdeadbeef, 0xffffffff]
        .map(size=>`C:\\Setup\\Size${size}.bmp`).concat(
            ['C:\\Setup\\W65536H2.bmp', 'C:\\Setup\\W2H65536.bmp']))
    {
        memory.putString(TEXT_BUFFER, name);
        assert.equal(await fns.LoadImageA.handler([0, TEXT_BUFFER, IMAGE_BITMAP, 0, 0,
            LR_LOADFROMFILE]), 0, name);
    }
    assert.equal(made.length, 2);
});

test('a bitmap the module does not carry, and a program-manager conversation, are refused', ()=>{
    // Both were reaching the missing-import stub, which pops nothing: an
    // installer painting its banner from a bitmap left eight bytes on its
    // stack per attempt and returned into them.
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
    memory.bytes.set([0x61, 0, 0, 0], TEXT_BUFFER + 0x40);
    assert.equal(fns.CharNextW.handler([TEXT_BUFFER + 0x40]), TEXT_BUFFER + 0x42, 'two bytes on');
    assert.equal(fns.CharNextW.handler([TEXT_BUFFER + 0x42]), TEXT_BUFFER + 0x42);
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
    // Wine's text test: a NULL source or target is FALSE, nothing written.
    for (const [source, target] of [[0, 0], [TEXT_BUFFER, 0], [0, TEXT_BUFFER + 8]])
    {
        assert.equal(fns.OemToCharBuffA.handler([source, target, 3]), 0);
        assert.equal(fns.CharToOemBuffA.handler([source, target, 3]), 0);
    }
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

test('the wide and uncounted OEM conversions agree with the counted ANSI ones', ()=>{
    // 0x81 is u-umlaut in page 437, U+00FC as a character, 0xfc in Windows-1252.
    const { memory, fns } = setup();
    memory.writeMemory(TEXT_BUFFER, Uint8Array.of(0x81, 0x61, 0x00, 0x7a));
    memory.fill(OUT_BUFFER, 16);
    assert.equal(fns.OemToCharBuffW.handler([TEXT_BUFFER, OUT_BUFFER, 2]), 1);
    assert.deepEqual([...memory.readMemory(OUT_BUFFER, 6)],
        [0xfc, 0x00, 0x61, 0x00, UNTOUCHED & 0xff, UNTOUCHED & 0xff], 'counted: no terminator');
    assert.equal(fns.OemToCharW.handler([TEXT_BUFFER, OUT_BUFFER]), 1);
    assert.deepEqual([...memory.readMemory(OUT_BUFFER, 6)], [0xfc, 0x00, 0x61, 0x00, 0, 0]);
    assert.equal(fns.CharToOemW.handler([OUT_BUFFER, OUT_BUFFER + 8]), 1);
    assert.deepEqual([...memory.readMemory(OUT_BUFFER + 8, 3)], [0x81, 0x61, 0x00]);
    // A character page 437 has no byte for becomes the default character.
    memory.writeMemory(OUT_BUFFER, Uint8Array.of(0xac, 0x20, 0x62, 0x00));
    assert.equal(fns.CharToOemBuffW.handler([OUT_BUFFER, OUT_BUFFER + 8, 2]), 1);
    assert.deepEqual([...memory.readMemory(OUT_BUFFER + 8, 2)], [0x3f, 0x62]);
    memory.writeMemory(TEXT_BUFFER, Uint8Array.of(0xfc, 0x61, 0x00));
    assert.equal(fns.CharToOemA.handler([TEXT_BUFFER, OUT_BUFFER]), 1);
    assert.deepEqual([...memory.readMemory(OUT_BUFFER, 3)], [0x81, 0x61, 0x00]);
    for (const name of ['OemToCharW', 'CharToOemW', 'CharToOemA'])
    {
        assert.equal(fns[name].handler([0, OUT_BUFFER]), 0, `${name} refuses a null`);
    }
});

test('OemKeyScan answers the scan code and shift state that type an OEM character', ()=>{
    // input.c's test_OemKeyScan: VkKeyScan's shift state moved to the high
    // word, MapVirtualKey's scan code in the low, -1 for a character no key
    // types; only the low byte of the argument counts.
    const { fns } = setup();
    assert.equal(fns.OemKeyScan.handler([0x61]), 0x0000001e, 'a');
    assert.equal(fns.OemKeyScan.handler([0x41]), 0x0001001e, 'A, with shift');
    assert.equal(fns.OemKeyScan.handler([0x141]), 0x0001001e, 'the high byte ignored');
    assert.equal(fns.OemKeyScan.handler([0x01]), 0x0002001e, 'control and A');
    assert.equal(fns.OemKeyScan.handler([0x31]), 0x00000002, '1');
    assert.equal(fns.OemKeyScan.handler([0x81]), 0xffffffff, 'u-umlaut: no key on this layout');
    assert.equal(fns.OemKeyScan.argBytes, 4);
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

test('CharUpperA and CharUpperW read a string ending just short of its region\'s end', ()=>{
    // Past the end lies another allocation, or nothing: memory refuses a read
    // that runs into it, as the memory layer refuses one past a region's end.
    const { memory, fns } = setup();
    memory.regionAt = address=>address >= 0x10000 && address < 0x14000
        ? { base: 0x10000, size: 0x4000 } : null;
    const ansi = 0x14000 - 8 - 4;
    memory.putString(ansi, 'abc');
    assert.equal(fns.CharUpperA.handler([ansi]), ansi);
    assert.equal(memory.readCString(ansi, 16), 'ABC');
    const wide = 0x14000 - 8 - 8;
    memory.bytes.set([0x61, 0, 0x62, 0, 0x63, 0, 0, 0], wide);
    assert.equal(fns.CharUpperW.handler([wide]), wide);
    assert.deepEqual([...memory.bytes.subarray(wide, wide + 8)], [0x41, 0, 0x42, 0, 0x43, 0, 0, 0]);
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
    const SPI_GETFONTSMOOTHING = 0x004a;
    assert.equal(ask(SPI_GETFONTSMOOTHING), 0, 'text is not smoothed, and that is an answer');
});

test('SPI_GETNONCLIENTMETRICS answers the frame the metrics describe and its fonts', ()=>{
    // A launcher takes its menu font from here without looking at the answer:
    // left unwritten, the structure's height was whatever its stack held, and
    // every label came out three million pixels tall.
    const { memory, fns } = setup();
    const SPI_GETNONCLIENTMETRICS = 0x0029;
    /** @param {number} at */
    const i32 = at=>memory.u32(OUT_BUFFER + at) | 0;
    /** @param {number} at @param {boolean} wide */
    const face = (at, wide)=>{
        let name = '';
        for (let index = 0; index < 32; index++)
        {
            const unit = wide
                ? memory.bytes[OUT_BUFFER + at + 28 + index * 2]
                    | memory.bytes[OUT_BUFFER + at + 29 + index * 2] << 8
                : memory.bytes[OUT_BUFFER + at + 28 + index];
            if (unit === 0)
            {
                break;
            }
            name += String.fromCharCode(unit);
        }
        return name;
    };
    const metric = (/** @type {number} */ index)=>fns.GetSystemMetrics.handler([index]);
    for (const [name, sizes, font] of /** @type {const} */ ([
        ['SystemParametersInfoA', [340, 344], 60], ['SystemParametersInfoW', [500, 504], 92]]))
    {
        for (const size of sizes)
        {
            memory.fill(OUT_BUFFER, 130);
            memory.putU32s(OUT_BUFFER, [size]);
            assert.equal(fns[name].handler([SPI_GETNONCLIENTMETRICS, size, OUT_BUFFER, 0]), 1);
            assert.deepEqual([4, 8, 12, 16, 20].map(i32), [1, metric(2), metric(3), metric(30),
                metric(4) - 1], 'border, scroll bars, caption buttons, caption');
            const smallCaption = 24 + font;
            const menu = smallCaption + 8 + font;
            assert.deepEqual([smallCaption, smallCaption + 4, menu, menu + 4].map(i32),
                [metric(52), metric(53), metric(54), metric(15) - 1]);
            const fonts = [24, smallCaption + 8, menu + 8, menu + 8 + font, menu + 8 + 2 * font];
            assert.deepEqual(fonts.map(at=>[i32(at), i32(at + 16), face(at, font === 92)]), [
                [-11, 700, 'Tahoma'], [-11, 700, 'Tahoma'], [-11, 400, 'Tahoma'],
                [-11, 400, 'Tahoma'], [-11, 400, 'Tahoma']],
            `caption, small caption, menu, status and message fonts at ${size} bytes`);
            if (size % 4 === 0 && size === sizes[1])
            {
                assert.equal(i32(size - 4), 0, 'and a padded border of nothing');
            }
        }
        memory.fill(OUT_BUFFER, 4);
        memory.putU32s(OUT_BUFFER, [sizes[0] - 4]);
        assert.equal(fns[name].handler([SPI_GETNONCLIENTMETRICS, 0, OUT_BUFFER, 0]), 0,
            'a size that is neither layout is refused');
        assert.equal(memory.u32(OUT_BUFFER + 4), UNTOUCHED);
    }
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

test('wsprintf keeps the ANSI page: a byte of the format, a %s or a %c is itself', ()=>{
    // The format and a %s are read as Windows-1252, where 0x80 is the euro
    // sign, 0x99 the trade mark and 0x97 an em dash; wsprintfA writes them
    // back as those bytes, a %c byte is one too, and a wide %C is converted
    // into the page. wsprintfW widens a narrow %C as it widens a %S.
    const { memory, fns } = setup();
    memory.bytes.set([0x80, 0x25, 0x73, 0x25, 0x63, 0x25, 0x43, 0], FORMAT_BUFFER);
    memory.bytes.set([0x99, 0], TEXT_BUFFER);

    assert.equal(fns.wsprintfA.handler([OUT_BUFFER, FORMAT_BUFFER, TEXT_BUFFER, 0x97, 0x2014]), 4);
    assert.deepEqual([...memory.bytes.subarray(OUT_BUFFER, OUT_BUFFER + 5)],
        [0x80, 0x99, 0x97, 0x97, 0]);

    [...'%C%S\0'].forEach((character, at)=>{
        memory.bytes[FORMAT_BUFFER + at * 2] = character.charCodeAt(0);
        memory.bytes[FORMAT_BUFFER + at * 2 + 1] = 0;
    });
    assert.equal(fns.wsprintfW.handler([OUT_BUFFER, FORMAT_BUFFER, 0x80, TEXT_BUFFER]), 2);
    assert.deepEqual([...memory.bytes.subarray(OUT_BUFFER, OUT_BUFFER + 6)],
        [0xac, 0x20, 0x22, 0x21, 0, 0]);
});

test('LoadStringA and GetClassNameA write their text in the ANSI page', ()=>{
    // A resource string is UTF-16 and reaches an ANSI caller as
    // WideCharToMultiByte(CP_ACP) writes it; a class name goes back in the
    // page it was registered in.
    const { memory, fns } = setup({ loadString: ()=>'€™—é' });
    assert.equal(fns.LoadStringA.handler([HINSTANCE, 0x10, OUT_BUFFER, 16]), 4);
    assert.deepEqual([...memory.bytes.subarray(OUT_BUFFER, OUT_BUFFER + 5)],
        [0x80, 0x99, 0x97, 0xe9, 0]);

    memory.bytes.set([0x80, 0x99, 0x97, 0], CLASS_NAME);
    memory.putU32s(CLASS_STRUCT, [
        0x0003, WNDPROC, 0, 0, HINSTANCE, 0x11, 0x22, 0x33, 0, CLASS_NAME,
    ]);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    memory.putString(TITLE, 'Window');
    const hwnd = fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, WS_OVERLAPPED, 0, 0, 320, 240, 0, 0, HINSTANCE, 0]);
    assert.equal(fns.GetClassNameA.handler([hwnd, OUT_BUFFER, 32]), 3);
    assert.deepEqual([...memory.bytes.subarray(OUT_BUFFER, OUT_BUFFER + 4)],
        [0x80, 0x99, 0x97, 0]);
});

test('the keyboard is the enhanced one, and anything else asked of it is nothing', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetKeyboardType.handler([0]), 4, 'type: enhanced 101/102-key');
    assert.equal(fns.GetKeyboardType.handler([1]), 0, 'subtype');
    assert.equal(fns.GetKeyboardType.handler([2]), 12, 'function keys');
    assert.equal(fns.GetKeyboardType.handler([3]), 0);
    assert.equal(fns.GetKeyboardType.argBytes, 4);
});

test('the double-click time starts at 500 and is what SetDoubleClickTime sets', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetDoubleClickTime.handler([]), 500);
    assert.equal(fns.SetDoubleClickTime.handler([1]), 1);
    assert.equal(fns.GetDoubleClickTime.handler([]), 1);
    fns.SetDoubleClickTime.handler([0]);
    assert.equal(fns.GetDoubleClickTime.handler([]), 500, 'zero is the default again');
});

test('the caret blinks every 530 ms, and SetLastErrorEx sets the error whatever its type', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.GetCaretBlinkTime.argBytes, 0);
    assert.equal(fns.GetCaretBlinkTime.handler([]), 530);
    assert.equal(fns.SetLastErrorEx.argBytes, 8);
    fns.SetLastErrorEx.handler([1400, 3]);
    assert.equal(errors.at(-1), 1400);
});

test('the one layout there is is named, listed, activated and loaded', ()=>{
    // input.c's test_keyboard_layout_name and test_ActivateKeyboardLayout:
    // no buffer is ERROR_NOACCESS, the name is eight hexadecimal digits, and
    // the list, activation and loading all answer that one layout.
    const { memory, fns, errors } = setup();
    const layout = fns.GetKeyboardLayout.handler([0]);
    assert.equal(fns.GetKeyboardLayoutNameW.handler([0]), 0);
    assert.equal(errors.at(-1), 998);
    assert.equal(fns.GetKeyboardLayoutNameA.handler([TEXT_BUFFER]), 1);
    assert.equal(memory.readCString(TEXT_BUFFER, 16), '00000409');
    assert.equal(fns.GetKeyboardLayoutNameW.handler([TEXT_BUFFER]), 1);
    assert.equal(memory.u32(TEXT_BUFFER), 0x00300030, 'wide');
    assert.equal(fns.GetKeyboardLayoutList.handler([0, 0]), 1);
    assert.equal(fns.GetKeyboardLayoutList.handler([4, OUT_BUFFER]), 1);
    assert.equal(memory.u32(OUT_BUFFER), layout);
    assert.equal(fns.ActivateKeyboardLayout.handler([layout, 0]), layout);
    assert.equal(fns.LoadKeyboardLayoutA.handler([TEXT_BUFFER, 1]), layout);
    // input.c's test_LoadKeyboardLayoutEx: a layout to replace, or nothing.
    assert.equal(fns.LoadKeyboardLayoutEx.handler([0, TEXT_BUFFER, 0]), 0);
    assert.equal(fns.LoadKeyboardLayoutEx.handler([layout, TEXT_BUFFER, 0]), layout);
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

test('a class word is read from the atom or the extra bytes, and the atom is not set', ()=>{
    const { memory, fns, errors } = setup();
    const hwnd = makeWindow(memory, fns);
    const GCW_ATOM = -32;
    assert.equal(fns.GetClassWord.handler([hwnd, GCW_ATOM]),
        fns.GetClassLongA.handler([hwnd, GCW_ATOM]) & 0xffff);
    assert.equal(fns.SetClassWord.handler([hwnd, GCW_ATOM, 2]), 0);
    assert.equal(errors.at(-1), 1413, 'ERROR_INVALID_INDEX');
    assert.equal(fns.SetClassWord.handler([hwnd, 0, 2]), 0, 'the class asked for no extra bytes');
    assert.equal(errors.at(-1), 1413);
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

test('SendInput refuses no events and no array, and counts an event that does nothing', ()=>{
    // input.c's test_SendInput: a count of none is ERROR_INVALID_PARAMETER,
    // no array ERROR_NOACCESS, and zeroed INPUTs -- a mouse event with no
    // flags -- are each inserted.
    const { memory, fns, errors } = setup();
    assert.equal(fns.SendInput.handler([0, INPUT_BUFFER, 28]), 0);
    assert.equal(errors.at(-1), 87);
    assert.equal(fns.SendInput.handler([1, 0, 28]), 0);
    assert.equal(errors.at(-1), 998);
    memory.putU32s(INPUT_BUFFER, new Array(28 * 16 / 4).fill(0));
    assert.equal(fns.SendInput.handler([16, INPUT_BUFFER, 28]), 16);
});

test('SendInput injects a keyboard event named by virtual key', ()=>{
    const INPUT_KEYBOARD = 1;
    const VK_A = 0x41;
    const { memory, fns, sent } = setup();
    // KEYBDINPUT: wVk, wScan packed into one dword, then dwFlags. No flags:
    // a key going down, named by wVk rather than a scan code.
    memory.putU32s(INPUT_BUFFER, [INPUT_KEYBOARD, VK_A, 0, 0, 0, 0, 0]);

    assert.equal(fns.SendInput.handler([1, INPUT_BUFFER, 28]), 1);
    assert.deepEqual(sent, [{ kind: 'key', vk: VK_A, scanGiven: 0, extended: false, down: true }],
        'the scan code written beside it goes along, none here');
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
    assert.deepEqual(sent, [{ kind: 'type', text: 'A' }]);

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
    assert.equal(fns.RegisterClipboardFormatA.handler([FORMAT_BUFFER]),
        fns.RegisterWindowMessageA.handler([FORMAT_BUFFER]), 'a clipboard format is the same atom');
});

test('a message registered by a UTF-16 name is the number its narrow name has', ()=>{
    // MFC42U registers its messages through the wide call, which did not
    // exist: InstallShield's IKernel stopped on the import and its client
    // was left with RPC_E_DISCONNECTED.
    const { memory, fns } = setup();
    memory.putString(TEXT_BUFFER, 'MSWHEEL_ROLLMSG');
    const text = 'mswheel_rollmsg';
    const bytes = new Uint8Array((text.length + 1) * 2);
    [...text].forEach((character, at)=>{
        bytes[at * 2] = character.charCodeAt(0);
    });
    memory.writeMemory(FORMAT_BUFFER, bytes);

    const narrow = fns.RegisterWindowMessageA.handler([TEXT_BUFFER]);
    assert.equal(fns.RegisterWindowMessageW.handler([FORMAT_BUFFER]), narrow);
    assert.equal(fns.RegisterClipboardFormatW.handler([FORMAT_BUFFER]), narrow);
    assert.equal(fns.RegisterWindowMessageW.argBytes, 4);
});

test('GetClipboardFormatName reads back a fixed and a registered name', ()=>{
    const { memory, fns } = setup();
    const OUT = 0x12000;

    assert.equal(fns.GetClipboardFormatNameW.handler([13, OUT, 20]), 12,
        'CF_UNICODETEXT is "Unicode Text", 12 characters');
    assert.equal(memory.bytes[OUT], 'U'.charCodeAt(0));
    assert.equal(memory.bytes[OUT + 1], 0, 'and it is wide');

    memory.putString(FORMAT_BUFFER, 'MyFormat');
    const id = fns.RegisterClipboardFormatA.handler([FORMAT_BUFFER]);
    assert.equal(fns.GetClipboardFormatNameA.handler([id, OUT, 20]), 8,
        '"MyFormat" is 8 characters');
    assert.equal(memory.bytes[OUT], 'M'.charCodeAt(0));
    assert.equal(memory.bytes[OUT + 8], 0, 'and it is terminated');

    assert.equal(fns.GetClipboardFormatNameW.handler([0xffff, OUT, 20]), 0, 'no such format');
    // Wine's clipboard test: a size of zero with no buffer answers zero and
    // writes nothing -- there is no room even for the terminator.
    assert.equal(fns.GetClipboardFormatNameA.handler([id, 0, 0]), 0);
    assert.equal(fns.GetClipboardFormatNameW.handler([id, 0, 0]), 0);
    assert.deepEqual([fns.GetClipboardFormatNameA.argBytes, fns.GetClipboardFormatNameW.argBytes],
        [12, 12]);
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
    memory.putU32s(rect, [10, 20, 30, 40]);
    memory.putU32s(other, [0, 0, 0, 0]);
    assert.equal(fns.IsRectEmpty.handler([other]), 1);
    assert.equal(fns.IsRectEmpty.handler([rect]), 0);
    assert.equal(fns.IsRectEmpty.handler([0]), 1, 'no rectangle is an empty one');
    const union = FORMAT_BUFFER + 0x40;
    assert.equal(fns.UnionRect.handler([union, rect, other]), 1, 'an empty source adds nothing');
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(union + at) | 0), [10, 20, 30, 40]);
    memory.putU32s(other, [0, 50, 5, 60]);
    assert.equal(fns.UnionRect.handler([union, rect, other]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(union + at) | 0), [0, 20, 30, 60]);
    memory.putU32s(other, [0, 0, 0, 0]);
    assert.equal(fns.UnionRect.handler([union, other, other]), 0, 'two empty ones make nothing');

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

// --- the wide display calls, and small calls a program reaches for early ---

test('EnumDisplaySettingsW fills a DEVMODEW at its own offsets, past the wide device name', ()=>{
    const { memory, fns } = setup();
    memory.fill(DEVMODE_BUFFER, DEVMODEW.SIZE / 4);
    assert.equal(fns.EnumDisplaySettingsW.argBytes, 12);
    assert.equal(fns.EnumDisplaySettingsW.handler([0, -1 >>> 0, DEVMODE_BUFFER]), 1);
    const u16 = (/** @type {number} */ at)=>memory.bytes[at] | memory.bytes[at + 1] << 8;
    assert.equal(u16(DEVMODE_BUFFER + DEVMODEW.dmSize), DEVMODEW.SIZE);
    assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEW.dmPelsWidth), SCREEN.width);
    assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEW.dmPelsHeight), SCREEN.height);
    assert.equal(memory.u32(DEVMODE_BUFFER + DEVMODEW.dmBitsPerPel), SCREEN.bitsPerPixel);
    // The ExA form is the same enumeration with a flags argument after it.
    assert.equal(fns.EnumDisplaySettingsExA.argBytes, 16);
    assert.equal(fns.EnumDisplaySettingsExA.handler([0, 0, DEVMODE_BUFFER, 0]), 1);
    assert.equal(fns.EnumDisplaySettingsExW.handler([0, 100000, DEVMODE_BUFFER, 0]), 0,
        'past the end of the list');
});

test('ChangeDisplaySettingsW reads the mode asked for from a DEVMODEW', ()=>{
    const { memory, fns, screen } = setup();
    memory.fill(DEVMODE_BUFFER, DEVMODEW.SIZE / 4);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEW.dmFields, [DM_PELSWIDTH | DM_PELSHEIGHT]);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEW.dmPelsWidth, [800, 600]);
    assert.equal(fns.ChangeDisplaySettingsW.handler([DEVMODE_BUFFER, 0]),
        DISP_CHANGE_SUCCESSFUL);
    assert.equal(screen.width, 800);
    memory.putU32s(DEVMODE_BUFFER + DEVMODEW.dmPelsWidth, [801, 600]);
    assert.equal(fns.ChangeDisplaySettingsExW.handler([0, DEVMODE_BUFFER, 0, 0, 0]),
        DISP_CHANGE_BADMODE);
});

test('GetClipCursor answers the rectangle ClipCursor set, cut to the screen, or the screen', ()=>{
    const { memory, fns } = setup();
    assert.equal(fns.GetClipCursor.handler([RECT_BUFFER]), 1);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at) | 0),
        [0, 0, SCREEN.width, SCREEN.height]);
    memory.putU32s(OUT_BUFFER, [-10 >>> 0, 20, 300, 5000]);
    fns.ClipCursor.handler([OUT_BUFFER]);
    fns.GetClipCursor.handler([RECT_BUFFER]);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at) | 0),
        [0, 20, 300, SCREEN.height]);
    fns.ClipCursor.handler([0]);
    fns.GetClipCursor.handler([RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + 8), SCREEN.width);
});

test('SubtractRect takes off a band that covers one side right across, and nothing else', ()=>{
    const { memory, fns } = setup();
    const A = OUT_BUFFER;
    const B = OUT_BUFFER + 16;
    /** @param {number[]} a @param {number[]} b */
    const subtract = (a, b)=>{
        memory.putU32s(A, a);
        memory.putU32s(B, b);
        const answer = fns.SubtractRect.handler([RECT_BUFFER, A, B]);
        return [answer, [0, 4, 8, 12].map(at=>memory.u32(RECT_BUFFER + at) | 0)];
    };
    assert.deepEqual(subtract([0, 0, 100, 100], [0, 0, 100, 30]), [1, [0, 30, 100, 100]]);
    assert.deepEqual(subtract([0, 0, 100, 100], [-5, 70, 105, 200]), [1, [0, 0, 100, 70]]);
    assert.deepEqual(subtract([0, 0, 100, 100], [60, -1, 100, 101]), [1, [0, 0, 60, 100]]);
    // A hole in the middle leaves no rectangle, so the first is answered whole.
    assert.deepEqual(subtract([0, 0, 100, 100], [10, 10, 20, 20]), [1, [0, 0, 100, 100]]);
    assert.deepEqual(subtract([0, 0, 100, 100], [0, 0, 100, 100]), [0, [0, 100, 100, 100]]);
    assert.deepEqual(subtract([5, 5, 5, 10], [0, 0, 1, 1]), [0, [0, 0, 0, 0]]);
});

test('a device-change registration is a handle, taken back once and not twice', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.RegisterDeviceNotificationA.argBytes, 12);
    const handle = fns.RegisterDeviceNotificationW.handler([0x1234, 0x5000, 0]);
    assert.ok(handle);
    assert.equal(fns.RegisterDeviceNotificationA.handler([0, 0x5000, 0]), 0, 'no recipient');
    assert.equal(fns.UnregisterDeviceNotification.handler([handle]), 1);
    assert.equal(fns.UnregisterDeviceNotification.handler([handle]), 0);
    assert.deepEqual(errors, [6]);
});

test('LoadCursorW and LoadIconW find a resource by its wide name', ()=>{
    /** @type {any[]} */
    const asked = [];
    const { memory, fns } = setup({
        findResource: (/** @type {number} */ instance, /** @type {number} */ type,
            /** @type {number | string} */ name)=>
        {
            asked.push([type, name]);
            return { rva: 0x100, size: 16 };
        },
    });
    memory.writeMemory(TEXT_BUFFER, new Uint8Array(Buffer.from('ARROWS\0', 'utf16le')));
    assert.ok(fns.LoadCursorW.handler([HINSTANCE, TEXT_BUFFER]));
    assert.ok(fns.LoadIconW.handler([HINSTANCE, TEXT_BUFFER]));
    assert.ok(fns.LoadImageW.handler([HINSTANCE, TEXT_BUFFER, 2, 0, 0, 0]));
    assert.deepEqual(asked, [[12, 'ARROWS'], [14, 'ARROWS'], [12, 'ARROWS']]);
});

test('keybd_event and mouse_event are one INPUT each, handed over as arguments', ()=>{
    const KEYEVENTF_KEYUP = 0x2;
    const MOUSEEVENTF_MOVE = 0x1;
    const MOUSEEVENTF_LEFTDOWN = 0x2;
    const MOUSEEVENTF_WHEEL = 0x800;
    const { fns, sent } = setup();
    assert.equal(fns.keybd_event.argBytes, 16);
    assert.equal(fns.mouse_event.argBytes, 20);
    fns.keybd_event.handler([0x41, 0x1e, 0, 0]);
    fns.keybd_event.handler([0x41, 0x1e, KEYEVENTF_KEYUP, 0]);
    fns.mouse_event.handler([MOUSEEVENTF_MOVE | MOUSEEVENTF_LEFTDOWN, -3 >>> 0, 4, 0, 0]);
    fns.mouse_event.handler([MOUSEEVENTF_WHEEL, 0, 0, -120 >>> 0, 0]);
    assert.deepEqual(sent, [
        { kind: 'key', vk: 0x41, scanGiven: 0x1e, extended: false, down: true },
        { kind: 'key', vk: 0x41, scanGiven: 0x1e, extended: false, down: false },
        { kind: 'pointerMove', dx: -3, dy: 4 },
        { kind: 'pointerButton', button: 'left', down: true },
        { kind: 'wheel', delta: -120 },
    ]);
});

test('RealGetWindowClass answers the class name, as no window is made on a system superclass',
    ()=>{
        const { memory, fns } = setup();
        const hwnd = makeWindow(memory, fns);
        assert.equal(fns.RealGetWindowClassA.handler([hwnd, OUT_BUFFER, 32]), 7);
        assert.equal(memory.readCString(OUT_BUFFER, 32), 'MainWnd');
        assert.equal(fns.RealGetWindowClassA.handler([0x9999, OUT_BUFFER, 32]), 0);
    });

test('GetKeyNameText names a key from its scan code, the extended bit and the sideless bit', ()=>{
    // Wine's user32 input.c test_keynames; GetKeyNameTextA was missing, and
    // a key-binding screen asks it for every key it shows.
    const { memory, fns } = setup();
    /** @param {number} lParam */
    const name = lParam=>{
        memory.bytes.fill(0x2d, 0x100, 0x120);
        const length = fns.GetKeyNameTextA.handler([lParam, 0x100, 32]);
        return new TextDecoder().decode(memory.bytes.slice(0x100, 0x100 + length));
    };
    assert.equal(name(0x01480000), 'Up');
    assert.equal(name(0x011d0000), 'Right Ctrl');
    assert.equal(name(0x021d0000), 'Ctrl');
    assert.equal(name(0xe0450000), 'Pause', 'the top bits are the message\'s, not the key\'s');
    assert.equal(name(0x01450000), 'Num Lock');
    assert.equal(name(0x00390000), 'Space');
    assert.equal(name(0x001e0000), 'A');
    assert.equal(name(0x03380000), 'Alt', 'the right Alt with left and right as one');
    assert.equal(fns.GetKeyNameTextA.handler([0x007f0000, 0x100, 32]), 0, 'a key with no name');
    assert.equal(memory.bytes[0x100], 0, 'and an empty string');
    const length = fns.GetKeyNameTextW.handler([0x002a0000, 0x100, 3]);
    assert.equal(length, 2, 'cut to the room with its terminator');
    assert.deepEqual([...memory.bytes.slice(0x100, 0x106)], [0x53, 0, 0x68, 0, 0, 0]);
    assert.equal(fns.GetKeyNameTextW.argBytes, 12);
});

/** @param {any} memory @param {number} at @param {string} text */
function putWideText(memory, at, text){
    memory.writeMemory(at, new Uint8Array(Buffer.from(`${text}\0`, 'utf16le')));
}

/** @param {any} memory @param {number} at */
function readWideText(memory, at){
    let end = at;
    while (memory.bytes[end] !== 0 || memory.bytes[end + 1] !== 0)
    {
        end += 2;
    }
    return Buffer.from(memory.bytes.subarray(at, end)).toString('utf16le');
}

test('CharUpperW and CharLowerW convert UTF-16 in place, or one character by value', ()=>{
    const { memory, fns } = setup();
    putWideText(memory, TEXT_BUFFER, 'Ab-zéбß');

    assert.equal(fns.CharUpperW.argBytes, 4);
    assert.equal(fns.CharUpperW.handler([TEXT_BUFFER]), TEXT_BUFFER, 'the pointer is the answer');
    assert.equal(readWideText(memory, TEXT_BUFFER), 'AB-ZÉБß',
        'a letter whose upper case is two is left alone; the string cannot grow');
    assert.equal(fns.CharLowerW.handler([TEXT_BUFFER]), TEXT_BUFFER);
    assert.equal(readWideText(memory, TEXT_BUFFER), 'ab-zéбß');

    assert.equal(fns.CharUpperW.handler([0x0431]), 0x0411, 'a zero high word is a character');
    assert.equal(fns.CharLowerW.handler(['Q'.charCodeAt(0)]), 'q'.charCodeAt(0));
    assert.equal(fns.CharUpperW.handler([0]), 0);

    putWideText(memory, TEXT_BUFFER, 'ab\0c');
    assert.equal(fns.CharUpperBuffW.handler([TEXT_BUFFER, 4]), 4, 'a counted buffer, NUL included');
    assert.equal(Buffer.from(memory.bytes.subarray(TEXT_BUFFER, TEXT_BUFFER + 8))
        .toString('utf16le'), 'AB\0C');
    assert.equal(fns.CharLowerBuffW.handler([0, 4]), 0);
});

test('wvsprintfW formats wide through the list it was handed', ()=>{
    const { memory, fns } = setup();
    putWideText(memory, FORMAT_BUFFER, '%s scored %d of %S');
    putWideText(memory, TEXT_BUFFER, 'Spieler');
    memory.putString(TEXT_BUFFER + 0x40, 'hundert');
    memory.putU32s(RECT_BUFFER, [TEXT_BUFFER, 42, TEXT_BUFFER + 0x40]);

    const written = fns.wvsprintfW.handler([OUT_BUFFER, FORMAT_BUFFER, RECT_BUFFER]);

    assert.equal(readWideText(memory, OUT_BUFFER), 'Spieler scored 42 of hundert');
    assert.equal(written, 'Spieler scored 42 of hundert'.length);
    assert.equal(fns.wvsprintfW.argBytes, 12, 'stdcall: three pointers, and the callee pops them');
});

test('GetTabbedTextExtent answers the width and height of a line with its tabs expanded', ()=>{
    // With no font to measure, every character is the estimated cell: eight
    // wide and sixteen high.
    const { memory, fns } = setup();
    memory.putString(TEXT_BUFFER, 'ab\tc');
    memory.putU32s(RECT_BUFFER, [40]);

    assert.equal(fns.GetTabbedTextExtentA.argBytes, 20);
    assert.equal(fns.GetTabbedTextExtentA.handler([0, TEXT_BUFFER, 4, 1, RECT_BUFFER]),
        (16 << 16 | 48) >>> 0, 'the c starts at the stop at 40');
    assert.equal(fns.GetTabbedTextExtentA.handler([0, TEXT_BUFFER, 4, 0, 0]),
        (16 << 16 | 72) >>> 0, 'no stops: every eight average characters');
    assert.equal(fns.GetTabbedTextExtentA.handler([0, TEXT_BUFFER, 2, 1, RECT_BUFFER]),
        (16 << 16 | 16) >>> 0, 'only the count given is read');
    assert.equal(fns.GetTabbedTextExtentA.handler([0, TEXT_BUFFER, 0, 1, RECT_BUFFER]), 0,
        'user32\'s text tests: no characters is a zero extent');

    putWideText(memory, TEXT_BUFFER, '\tx');
    memory.putU32s(RECT_BUFFER, [-40 >>> 0]);
    assert.equal(fns.GetTabbedTextExtentW.handler([0, TEXT_BUFFER, 2, 1, RECT_BUFFER]),
        (16 << 16 | 40) >>> 0, 'a negative stop right-aligns what follows it');
});

test('WindowFromDC names the window a context was handed out on, until it is given back', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns, WS_OVERLAPPED | WS_VISIBLE);

    const hdc = fns.GetDC.handler([hwnd]);
    assert.equal(fns.WindowFromDC.argBytes, 4);
    assert.equal(fns.WindowFromDC.handler([hdc]), hwnd);
    fns.ReleaseDC.handler([hwnd, hdc]);
    assert.equal(fns.WindowFromDC.handler([hdc]), 0, 'user32\'s DCE tests: not once released');

    const whole = fns.GetWindowDC.handler([hwnd]);
    assert.equal(fns.WindowFromDC.handler([whole]), hwnd);
    fns.ReleaseDC.handler([hwnd, whole]);

    fns.InvalidateRect.handler([hwnd, 0, 0]);
    const painting = fns.BeginPaint.handler([hwnd, PAINT_BUFFER]);
    assert.equal(fns.WindowFromDC.handler([painting]), hwnd);
    fns.EndPaint.handler([hwnd, PAINT_BUFFER]);
    assert.equal(fns.WindowFromDC.handler([painting]), 0);

    const screen = fns.GetDC.handler([0]);
    assert.equal(fns.WindowFromDC.handler([screen]), fns.GetDesktopWindow.handler([]),
        'the screen\'s context is the desktop\'s');
    fns.ReleaseDC.handler([0, screen]);
    assert.equal(fns.WindowFromDC.handler([0x5555]), 0, 'a context on no window');
});

test('LoadCursorFromFile loads a .cur or .ani; SetSystemCursor replaces a system one', async()=>{
    /** A one-entry .cur file holding a 2x2 32-bit image with its hot spot at (1, 0). */
    const cur = (/** @type {number} */ blue)=>{
        const image = new Uint8Array(40 + 16 + 8);
        const imageView = new DataView(image.buffer);
        imageView.setUint32(0, 40, true);
        imageView.setInt32(4, 2, true);
        imageView.setInt32(8, 4, true);
        imageView.setUint16(14, 32, true);
        image.set([blue, 0, 0, 255], 40);
        const file = new Uint8Array(22 + image.length);
        const view = new DataView(file.buffer);
        view.setUint16(2, 2, true);
        view.setUint16(4, 1, true);
        file[6] = 2;
        file[7] = 2;
        view.setUint16(10, 1, true);
        view.setUint32(14, image.length, true);
        view.setUint32(18, 22, true);
        file.set(image, 22);
        return file;
    };
    /** A RIFF ACON file whose only frame is a .cur file. */
    const ani = (/** @type {Uint8Array} */ frame)=>{
        const file = new Uint8Array(12 + 8 + frame.length);
        const view = new DataView(file.buffer);
        file.set(new TextEncoder().encode('RIFF'), 0);
        view.setUint32(4, file.length - 8, true);
        file.set(new TextEncoder().encode('ACON'), 8);
        file.set(new TextEncoder().encode('icon'), 12);
        view.setUint32(16, frame.length, true);
        file.set(frame, 20);
        return file;
    };
    /** @type {Map<string, Uint8Array>} */
    const disk = new Map([
        ['C:\\C\\ARROW.CUR', cur(200)],
        ['C:\\C\\SPIN.ANI', ani(cur(100))],
        ['C:\\C\\NOTES.TXT', new TextEncoder().encode('not a cursor, only words')],
    ]);
    const files = {
        stat: (/** @type {string} */ path)=>(disk.has(path.toUpperCase())
            ? { exists: true, isDirectory: false, size: disk.get(path.toUpperCase())?.length ?? 0 }
            : null),
        open: (/** @type {string} */ path)=>disk.get(path.toUpperCase()) ?? null,
        read: (/** @type {Uint8Array} */ node, /** @type {number} */ at,
            /** @type {number} */ length)=>Promise.resolve(node.slice(at, at + length)),
        close: ()=>{},
    };
    const { memory, fns, cursors } = setup({ files });

    memory.putString(TEXT_BUFFER, 'C:\\C\\Arrow.cur');
    const arrow = await fns.LoadCursorFromFileA.handler([TEXT_BUFFER]);
    assert.notEqual(arrow, 0);
    fns.SetCursor.handler([arrow]);
    assert.deepEqual([cursors.at(-1).width, cursors.at(-1).height, cursors.at(-1).hotSpot],
        [2, 2, { x: 1, y: 0 }]);

    memory.putString(TEXT_BUFFER, 'C:\\C\\Spin.ani');
    const spin = await fns.LoadCursorFromFileA.handler([TEXT_BUFFER]);
    assert.notEqual(spin, 0, 'the first frame stands for an animated cursor');

    memory.putString(TEXT_BUFFER, 'C:\\C\\Notes.txt');
    assert.equal(await fns.LoadCursorFromFileA.handler([TEXT_BUFFER]), 0, 'not a cursor file');
    memory.putString(TEXT_BUFFER, 'C:\\C\\Missing.cur');
    assert.equal(fns.LoadCursorFromFileA.handler([TEXT_BUFFER]), 0, 'no file');

    // The arrow replaces OCR_NORMAL; the handle is consumed, LoadCursor(NULL, IDC_ARROW)
    // answers with the same picture.
    assert.equal(fns.SetSystemCursor.handler([spin, 32512]), 1);
    fns.SetCursor.handler([0x7f00]);
    assert.equal(cursors.at(-1).bgra[8], 100, 'the standard arrow is now the file\'s picture');
    assert.equal(fns.SetSystemCursor.handler([spin, 32512]), 0, 'the handle was destroyed');
    assert.equal(fns.SetSystemCursor.handler([arrow, 1]), 0, 'not a system cursor id');
});

// --- AnimateWindow, AllowSetForegroundWindow, ghosting and the legacy IME switch ---

const AW_HOR_POSITIVE = 0x00000001;
const AW_VER_NEGATIVE = 0x00000008;
const AW_CENTER = 0x00000010;
const AW_HIDE = 0x00010000;
const AW_ACTIVATE = 0x00020000;
const AW_SLIDE = 0x00040000;
const AW_BLEND = 0x00080000;
const ERROR_INVALID_PARAMETER = 87;

test('AnimateWindow ends where the animation would: shown, activated or hidden', ()=>{
    const { memory, fns, errors } = setup();
    assert.equal(fns.AnimateWindow.argBytes, 12);
    const hwnd = makeWindow(memory, fns);

    assert.equal(fns.AnimateWindow.handler([hwnd, 200, AW_ACTIVATE | AW_BLEND]), 1);
    assert.equal(fns.IsWindowVisible.handler([hwnd]), 1);
    assert.equal(fns.GetActiveWindow.handler([]), hwnd, 'AW_ACTIVATE activates it');

    errors.length = 0;
    assert.equal(fns.AnimateWindow.handler([hwnd, 200, AW_ACTIVATE | AW_BLEND]), 0,
        'showing a window that is visible is refused');
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER]);

    assert.equal(fns.AnimateWindow.handler([hwnd, 200, AW_HIDE | AW_SLIDE | AW_VER_NEGATIVE]),
        1);
    assert.equal(fns.IsWindowVisible.handler([hwnd]), 0);
    errors.length = 0;
    assert.equal(fns.AnimateWindow.handler([hwnd, 200, AW_HIDE | AW_BLEND]), 0,
        'and so is hiding one that is hidden');
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER]);
});

test('AnimateWindow without AW_ACTIVATE shows a window and leaves the active one active', ()=>{
    const { memory, fns } = setup();
    const active = makeWindow(memory, fns, WS_VISIBLE);
    const other = makeWindow(memory, fns);
    assert.equal(fns.GetActiveWindow.handler([]), active);

    assert.equal(fns.AnimateWindow.handler([other, 150, AW_CENTER]), 1,
        'AW_CENTER needs no direction');
    assert.equal(fns.IsWindowVisible.handler([other]), 1);
    assert.equal(fns.GetActiveWindow.handler([]), active);
});

test('AnimateWindow refuses what MSDN says it refuses, and changes nothing', ()=>{
    const ERROR_INVALID_WINDOW_HANDLE = 1400;
    const WS_CHILD = 0x40000000;
    const { memory, fns, errors } = setup();
    const hwnd = makeWindow(memory, fns);
    const child = fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, WS_CHILD, 0, 0, 10, 10, hwnd, 0, HINSTANCE, 0]);
    /** @type {[number, number, string][]} */
    const refused = [
        [hwnd, 0, 'a roll with no direction'],
        [hwnd, AW_SLIDE, 'a slide with no direction'],
        [hwnd, AW_ACTIVATE, 'activation is no effect, and a roll needs a direction'],
        [child, AW_BLEND, 'a child does not fade'],
        [hwnd, AW_HIDE | AW_ACTIVATE | AW_BLEND, 'nor is a window hidden and activated'],
    ];
    for (const [target, flags, reason] of refused)
    {
        errors.length = 0;
        assert.equal(fns.AnimateWindow.handler([target, 200, flags]), 0, reason);
        assert.deepEqual(errors, [ERROR_INVALID_PARAMETER], reason);
    }
    assert.equal(fns.IsWindowVisible.handler([hwnd]), 0, 'nothing was shown');

    errors.length = 0;
    assert.equal(fns.AnimateWindow.handler([0x9999, 200, AW_BLEND]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_WINDOW_HANDLE]);
    assert.equal(fns.AnimateWindow.handler([hwnd, 200, AW_SLIDE | AW_HOR_POSITIVE]), 1,
        'a slide with a direction is accepted');
});

test('AnimateWindow refuses another thread\'s window and leaves the last error clear', ()=>{
    const caller = { current: { id: 7 } };
    const { memory, fns, errors } = setup({ callerThread: ()=>caller.current });
    const hwnd = makeWindow(memory, fns);
    caller.current = { id: 8 };
    errors.length = 0;
    assert.equal(fns.AnimateWindow.handler([hwnd, 200, AW_BLEND]), 0);
    assert.deepEqual(errors, [0], 'GetLastError answers ERROR_SUCCESS, as MSDN says');
    assert.equal(fns.IsWindowVisible.handler([hwnd]), 0);
    caller.current = { id: 7 };
    assert.equal(fns.AnimateWindow.handler([hwnd, 200, AW_BLEND]), 1, 'its own thread may');
});

test('AllowSetForegroundWindow lends a right every caller has, to a process that exists', ()=>{
    const ASFW_ANY = 0xffffffff;
    const live = new Set([0x2000]);
    const { fns, errors } = setup({ processExists: id=>live.has(id) });
    assert.equal(fns.AllowSetForegroundWindow.argBytes, 4);
    assert.equal(fns.AllowSetForegroundWindow.handler([ASFW_ANY]), 1, 'every process');
    assert.equal(fns.AllowSetForegroundWindow.handler([0x2000]), 1, 'a process that runs');
    assert.equal(fns.AllowSetForegroundWindow.handler([0x3000]), 0, 'one that does not');
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER]);

    const unknowing = setup();
    assert.equal(unknowing.fns.AllowSetForegroundWindow.handler([0x3000]), 1,
        'a host that cannot tell which ids are live accepts every one');
});

test('DisableProcessWindowsGhosting takes nothing and changes nothing', ()=>{
    const { memory, fns, errors } = setup();
    const hwnd = makeWindow(memory, fns, WS_VISIBLE);
    assert.equal(fns.DisableProcessWindowsGhosting.argBytes, 0);
    assert.equal(fns.DisableProcessWindowsGhosting.handler([]), 0);
    assert.equal(fns.IsWindowVisible.handler([hwnd]), 1);
    assert.deepEqual(errors, []);
});

test('WINNLSEnableIME finds the input method off on a system that has none', ()=>{
    // The legacy switch serves Japanese and Korean systems' input methods;
    // on this en-US one there is none to turn on, so the state it answers
    // having found stays off whatever was asked before.
    const { fns } = setup();
    assert.equal(fns.WINNLSEnableIME.argBytes, 8);
    assert.equal(fns.WINNLSEnableIME.handler([0, 1]), 0);
    assert.equal(fns.WINNLSEnableIME.handler([0, 0]), 0);
    assert.equal(fns.WINNLSEnableIME.handler([0, 1]), 0);
});

// --- the colours, the caption's flash, a window opened from its icon ---

/**
 * A drawing that answers every call, writing down the colour of each fill:
 * enough of one for the frame to be painted and its caption read back.
 *
 * @param {number[]} fills
 */
function recordingDraw(fills){
    return new Proxy({}, {
        get: (_, name)=>{
            if (name === 'fill')
            {
                /** @param {number} hdc @param {any} rect @param {number} color */
                return (hdc, rect, color)=>{
                    fills.push(color);
                    return true;
                };
            }
            if (name === 'measure')
            {
                return ()=>({ width: 8, height: 16, ascent: 12 });
            }
            return ()=>1;
        },
    });
}

test('SetSysColors changes what GetSysColor answers, and every window is told', ()=>{
    const WM_SYSCOLORCHANGE = 0x0015;
    const COLOR_WINDOW = 5;
    /** @type {number[]} */
    const told = [];
    const { memory, fns, errors } = setup({
        dispatch: (/** @type {number} */ wndProc, /** @type {any} */ message)=>{
            told.push(message.message);
            return 0;
        },
    });
    makeWindow(memory, fns, WS_OVERLAPPED | WS_VISIBLE);
    const before = fns.GetSysColor.handler([COLOR_WINDOW]);
    memory.putU32s(OUT_BUFFER, [COLOR_WINDOW, 99, 0x00123456, 0x00abcdef]);
    assert.equal(fns.SetSysColors.handler([2, OUT_BUFFER, OUT_BUFFER + 8]), 1);
    assert.equal(fns.GetSysColor.handler([COLOR_WINDOW]), 0x00123456);
    assert.notEqual(before, 0x00123456);
    assert.equal(fns.GetSysColor.handler([99]), 0, 'an index that names nothing is passed over');
    assert.ok(told.includes(WM_SYSCOLORCHANGE), 'the window heard of it');

    assert.equal(fns.SetSysColors.handler([1, 0, 0]), 0);
    assert.deepEqual(errors, [998]);
    assert.equal(fns.SetSysColors.handler([0, 0, 0]), 1, 'none to change is no fault');
});

test('FlashWindow draws the caption the other way about, and answers how it was', ()=>{
    const COLOR_ACTIVE = 0x00800000;
    const COLOR_INACTIVE = 0x00808080;
    /** @type {number[]} */
    const fills = [];
    const { memory, fns, errors } = setup({ draw: recordingDraw(fills) });
    const hwnd = makeWindow(memory, fns, WS_CAPTION | WS_VISIBLE);
    fns.SetActiveWindow.handler([hwnd]);
    assert.equal(fns.GetActiveWindow.handler([]), hwnd);

    fills.length = 0;
    assert.equal(fns.FlashWindow.handler([hwnd, 1]), 1, 'it was drawn active');
    assert.ok(fills.includes(COLOR_INACTIVE) && !fills.includes(COLOR_ACTIVE),
        'and is drawn inactive now');
    fills.length = 0;
    assert.equal(fns.FlashWindow.handler([hwnd, 1]), 0, 'drawn inactive before this one');
    assert.ok(fills.includes(COLOR_ACTIVE));
    fns.FlashWindow.handler([hwnd, 1]);
    fills.length = 0;
    assert.equal(fns.FlashWindow.handler([hwnd, 0]), 0);
    assert.ok(fills.includes(COLOR_ACTIVE), 'FALSE puts it back as the activation has it');

    assert.equal(fns.FlashWindow.handler([0x9999, 1]), 0);
    assert.deepEqual(errors, [1400]);
});

test('OpenIcon restores a minimised window, and refuses one that is not', async()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns, WS_OVERLAPPED | WS_VISIBLE);
    assert.equal(await fns.OpenIcon.handler([hwnd]), 0);
    await fns.CloseWindow.handler([hwnd]);
    assert.equal(fns.IsIconic.handler([hwnd]), 1);
    assert.equal(await fns.OpenIcon.handler([hwnd]), 1);
    assert.equal(fns.IsIconic.handler([hwnd]), 0);
    assert.equal(fns.IsWindowVisible.handler([hwnd]), 1);
    assert.equal(await fns.OpenIcon.handler([0x9999]), 0);
});

test('BroadcastSystemMessage sends to every top-level window, and a query can be denied', ()=>{
    const WM_APP = 0x8000;
    const BSF_QUERY = 0x0001;
    const BSF_POSTMESSAGE = 0x0010;
    const BSM_VXDS = 0x0001;
    const BSM_APPLICATIONS = 0x0008;
    const BROADCAST_QUERY_DENY = 0x424d5144;
    /** @type {{ hwnd: number, message: number }[]} */
    const told = [];
    let deny = 0;
    const { memory, fns, errors } = setup({
        dispatch: (/** @type {number} */ wndProc, /** @type {any} */ message)=>{
            if (message.message === WM_APP)
            {
                told.push({ hwnd: message.hwnd, message: message.message });
                return message.hwnd === deny ? BROADCAST_QUERY_DENY : 1;
            }
            return 0;
        },
    });
    const first = makeWindow(memory, fns, WS_OVERLAPPED);
    const second = makeWindow(memory, fns, WS_OVERLAPPED);

    memory.putU32s(OUT_BUFFER, [0]);
    assert.equal(fns.BroadcastSystemMessageA.handler([0, OUT_BUFFER, WM_APP, 1, 2]), 1);
    assert.deepEqual(told.map(each=>each.hwnd).sort(), [first, second].sort());
    assert.equal(memory.u32(OUT_BUFFER), BSM_APPLICATIONS, 'all components: the applications');

    told.length = 0;
    deny = first;
    assert.equal(fns.BroadcastSystemMessageW.handler([BSF_QUERY, 0, WM_APP, 0, 0]), 0,
        'one denied the query');

    told.length = 0;
    memory.putU32s(OUT_BUFFER, [BSM_VXDS]);
    assert.equal(fns.BroadcastSystemMessageA.handler([0, OUT_BUFFER, WM_APP, 0, 0]), 1);
    assert.deepEqual(told, [], 'drivers alone: nobody here to tell');
    assert.equal(memory.u32(OUT_BUFFER), 0);

    assert.equal(fns.BroadcastSystemMessageA.handler([BSF_POSTMESSAGE, 0, WM_APP, 0, 0]), 1);
    assert.deepEqual(told, [], 'posted, not sent');
    assert.equal(fns.PeekMessageA.handler([OUT_BUFFER, 0, 0, 0, 1]), 1);
    assert.equal(memory.u32(OUT_BUFFER + 4), WM_APP);

    assert.equal(fns.BroadcastSystemMessageA.handler([BSF_QUERY | BSF_POSTMESSAGE, 0, WM_APP,
        0, 0]), 0);
    assert.deepEqual(errors, [87]);
});

test('ExcludeUpdateRgn keeps a context off what is still to be repainted', ()=>{
    /** @type {[number, any[]][]} */
    const clips = [];
    const { memory, fns } = setup({ draw: {
        clip: (/** @type {number} */ hdc, /** @type {any[]} */ area)=>clips.push([hdc, area]),
    } });
    const hwnd = makeWindow(memory, fns, WS_OVERLAPPED | WS_VISIBLE);
    fns.ValidateRect.handler([hwnd, 0]);
    const hdc = fns.GetDC.handler([hwnd]);
    const SIMPLEREGION = 2;
    const COMPLEXREGION = 3;
    assert.equal(fns.ExcludeUpdateRgn.handler([hdc, hwnd]), SIMPLEREGION, 'nothing to leave out');
    memory.putU32s(RECT_BUFFER, [0, 0, 10, 10]);
    fns.InvalidateRect.handler([hwnd, RECT_BUFFER, 0]);
    assert.equal(fns.ExcludeUpdateRgn.handler([hdc, hwnd]), COMPLEXREGION);
    const [on, area] = /** @type {[number, any[]]} */ (clips.at(-1));
    assert.equal(on, hdc);
    assert.ok(area.every(piece=>piece.left >= 10 || piece.top >= 10),
        'no piece left inside the update area');
    assert.equal(fns.ExcludeUpdateRgn.handler([hdc, 0x9999]), 0, 'ERROR for no window');
    fns.ReleaseDC.handler([hwnd, hdc]);
});

// --- characters, DDE and the old IME interface ---

test('CharPrevW steps back one unit, and CharNextExA over a double-byte character', ()=>{
    const { memory, fns } = setup();
    assert.equal(fns.CharPrevW.handler([0x100, 0x104]), 0x102);
    assert.equal(fns.CharPrevW.handler([0x100, 0x100]), 0x100);
    assert.equal(fns.CharPrevW.handler([0x100, 0xfe]), 0xfe, 'not past the start: as it came');

    memory.writeMemory(TEXT_BUFFER, Uint8Array.from([0x82, 0xa0, 0x41, 0x82, 0]));
    assert.equal(fns.CharNextExA.handler([932, TEXT_BUFFER, 0]), TEXT_BUFFER + 2);
    assert.equal(fns.CharNextExA.handler([0, TEXT_BUFFER, 0]), TEXT_BUFFER + 1,
        'the process\'s own page is single-byte');
    assert.equal(fns.CharNextExA.handler([936, TEXT_BUFFER + 2, 0]), TEXT_BUFFER + 3);
    assert.equal(fns.CharNextExA.handler([932, TEXT_BUFFER + 3, 0]), TEXT_BUFFER + 4,
        'a lead byte before the terminator is one character');
    assert.equal(fns.CharNextExA.handler([932, TEXT_BUFFER + 4, 0]), TEXT_BUFFER + 4);
    assert.equal(fns.CharNextExA.handler([932, 0, 0]), 0);
    assert.equal(fns.CharNextExA.argBytes, 12);
});

test('with no DDE instance its handles are refused, and string handles still compare', ()=>{
    const { fns, diverged } = setup();
    for (const [name, args] of /** @type {[string, number[]][]} */ ([
        ['DdeFreeDataHandle', [0x10]], ['DdeAbandonTransaction', [1, 2, 3]],
        ['DdePostAdvise', [1, 2, 3]], ['DdeQueryConvInfo', [1, 2, 0x100]],
        ['DdeSetUserHandle', [1, 2, 3]]]))
    {
        assert.equal(fns[name].handler(args), 0, name);
        assert.equal(fns[name].argBytes, args.length * 4, name);
    }
    fns.DdeFreeDataHandle.handler([0x10]);
    assert.equal(diverged.filter(line=>line.startsWith('DdeFreeDataHandle')).length, 1,
        'said once');
    assert.equal(fns.DdeCmpStringHandles.handler([1, 2]), 0xffffffff);
    assert.equal(fns.DdeCmpStringHandles.handler([2, 1]), 1);
    assert.equal(fns.DdeCmpStringHandles.handler([0, 0]), 0);
    assert.equal(fns.SendIMEMessageExA.handler([0, 0]), 0, 'no IME to take the request');
    assert.equal(fns.SendIMEMessageExW.argBytes, 8);
});
