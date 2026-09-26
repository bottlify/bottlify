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
import {
    TAB_CLASS, TCS_BUTTONS, TCS_FIXEDWIDTH, TCS_FOCUSNEVER, TCS_VERTICAL, TCS_MULTILINE,
    TCM_GETITEMCOUNT, TCM_INSERTITEMA, TCM_INSERTITEMW, TCM_GETITEMA, TCM_SETITEMA,
    TCM_DELETEITEM, TCM_GETCURSEL, TCM_SETCURSEL, TCM_GETCURFOCUS, TCM_SETCURFOCUS,
    TCM_SETITEMEXTRA, TCM_ADJUSTRECT, TCM_SETITEMSIZE, TCM_GETITEMRECT, TCM_SETMINTABWIDTH,
    TCM_GETROWCOUNT, TCM_SETEXTENDEDSTYLE, TCM_GETEXTENDEDSTYLE, TCM_SETUNICODEFORMAT,
    TCM_GETUNICODEFORMAT, TCM_HITTEST, TCM_REMOVEIMAGE,
    TCITEM, TCIF_TEXT, TCIF_IMAGE, TCIF_PARAM, TCIF_STATE, TCIS_BUTTONPRESSED,
    TCIS_HIGHLIGHTED, TCHITTESTINFO, TCHT_ONITEM, TCHT_NOWHERE,
    WM_NOTIFY, NM_CLICK, TCN_SELCHANGE, TCN_SELCHANGING, TCN_FOCUSCHANGE,
} from './tab.js';

/**
 * The window manager over the real drawing engine, the common controls
 * registered, and a parent that records every notification's code and
 * answers TCN_SELCHANGING with whatever the test says.
 *
 * The expectations are those of Wine's comctl32 tab tests, which run the
 * same messages against Windows.
 */

const MSG_BUFFER = 0x13000;
const TEXT = 0x13100;
const OUT = 0x13200;
const ITEM = 0x13400;
const HEAP = 0x18000;
const HINSTANCE = 0x400000;
const PARENTPROC = 0x401000;
const THREAD = { name: 'main' };

const SCREEN = { width: 320, height: 240, bitsPerPixel: 32 };

const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_KEYDOWN = 0x0100;
const VK_RIGHT = 0x27;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CAPTION = 0x00c00000;
const WS_CLIPSIBLINGS = 0x04000000;
const GWL_STYLE = -16;
const PM_REMOVE = 1;
const TCS_EX_FLATSEPARATORS = 0x1;
const TCS_EX_REGISTERDROP = 0x2;

/** COLOR_3DFACE as the desktop reads it back. */
const FACE = 0x00c0c0c0;

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
        /** @param {number} address @param {number} value */
        put32(address, value){
            bytes[address] = value & 0xff;
            bytes[address + 1] = value >>> 8 & 0xff;
            bytes[address + 2] = value >>> 16 & 0xff;
            bytes[address + 3] = value >>> 24 & 0xff;
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

function setup(){
    const memory = fakeMemory();
    const handles = fakeHandles();
    const queue = createMessageQueue();
    const desktop = createSurface({ width: SCREEN.width, height: SCREEN.height });
    /** The code of every WM_NOTIFY the parent was sent, in order. @type {number[]} */
    const codes = [];
    /** What the parent answers TCN_SELCHANGING with: TRUE refuses. */
    const answers = { selChanging: 0 };
    let heapNext = HEAP;
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = heapNext;
        heapNext += (bytes + 15) & ~15;
        return at;
    };

    const gdi = createGdiFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        readCString: memory.readCString,
        handles,
        surfaces: { allocate, free: ()=>{} },
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
        dispatch: (wndProc, message)=>{
            if (message.message === WM_NOTIFY)
            {
                const code = memory.i32(message.lParam + 8);
                codes.push(code);
                return code === TCN_SELCHANGING ? answers.selChanging : 0;
            }
            return table.DefWindowProcA.handler(
                [message.hwnd, message.message, message.wParam, message.lParam]);
        },
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
        allocate,
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
    /** @param {number[]} args */
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
    const makeParent = async()=>{
        const name = TEXT + 64;
        memory.putString(name, 'parent');
        const CLASS = name + 64;
        [0, PARENTPROC, 0, 0, HINSTANCE, 0, 0, 0, 0, name].forEach((value, index)=>{
            memory.put32(CLASS + index * 4, value);
        });
        table.RegisterClassA.handler([CLASS]);
        parent = await table.CreateWindowExA.handler([0, name, name,
            WS_POPUP | WS_CAPTION | WS_VISIBLE, 0, 0, 300, 200, 0, 0, HINSTANCE, 0]);
        await pump();
        return parent;
    };

    /**
     * A tab control on the parent, WS_CHILD so its notifications reach it,
     * and filled with `count` tabs named "Tab 1" on, each image its index,
     * as Wine's tests fill theirs.
     *
     * @param {number} style @param {number} count
     */
    const tabs = async(style, count)=>{
        memory.putString(TEXT, TAB_CLASS);
        const hwnd = await table.CreateWindowExA.handler([0, TEXT, 0,
            WS_CHILD | WS_VISIBLE | TCS_FOCUSNEVER | style, 0, 0, 280, 160, parent, 7,
            HINSTANCE, 0]);
        for (let index = 0; index < count; index++)
        {
            insert(hwnd, index, { text: `Tab ${index + 1}`, image: index });
        }
        codes.length = 0;
        return hwnd;
    };

    /**
     * @param {number} hwnd @param {number} at
     * @param {{ text?: string, image?: number, param?: number }} fields
     */
    const insert = (hwnd, at, fields)=>{
        memory.bytes.fill(0, ITEM, ITEM + TCITEM.SIZE);
        memory.put32(ITEM + TCITEM.mask, (fields.text !== undefined ? TCIF_TEXT : 0)
            | (fields.image !== undefined ? TCIF_IMAGE : 0)
            | (fields.param !== undefined ? TCIF_PARAM : 0));
        if (fields.text !== undefined)
        {
            memory.put32(ITEM + TCITEM.pszText, memory.putString(TEXT + 0x80, fields.text));
        }
        memory.put32(ITEM + TCITEM.iImage, fields.image ?? 0);
        memory.put32(ITEM + TCITEM.lParam, fields.param ?? 0);
        return send([hwnd, TCM_INSERTITEMA, at, ITEM]) | 0;
    };

    /**
     * An item's state, read through TCM_GETITEM with the mask it names.
     *
     * @param {number} hwnd @param {number} index
     */
    const stateOf = (hwnd, index, stateMask = TCIS_BUTTONPRESSED)=>{
        memory.bytes.fill(0, OUT, OUT + TCITEM.SIZE);
        memory.put32(OUT + TCITEM.mask, TCIF_STATE);
        memory.put32(OUT + TCITEM.dwStateMask, stateMask);
        assert.equal(send([hwnd, TCM_GETITEMA, index, OUT]), 1);
        return memory.u32(OUT + TCITEM.dwState);
    };

    /** @param {number} hwnd @param {number} index */
    const itemRect = (hwnd, index)=>{
        memory.bytes.fill(0, OUT, OUT + 16);
        const found = send([hwnd, TCM_GETITEMRECT, index, OUT]);
        return { found, left: memory.i32(OUT), top: memory.i32(OUT + 4),
            right: memory.i32(OUT + 8), bottom: memory.i32(OUT + 12) };
    };

    /** The font's measure of a text in the control. @param {number} hwnd @param {string} text */
    const measure = (hwnd, text)=>{
        const hdc = gdi.windowContext(hwnd, null);
        const size = gdi.draw.measure(hdc, text);
        gdi.table.ReleaseDC.handler([hwnd, hdc]);
        return size;
    };

    /** @param {number} hwnd */
    const windowRect = hwnd=>{
        table.GetWindowRect.handler([hwnd, OUT + 0x100]);
        return { left: memory.i32(OUT + 0x100), top: memory.i32(OUT + 0x104) };
    };

    return { memory, desktop, fns: table, send, pump, codes, answers, makeParent, tabs,
        insert, stateOf, itemRect, measure, windowRect };
}

test('a tab control is a class a program creates by name, clipping its siblings', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(0, 0);
    assert.notEqual(hwnd, 0, 'SysTabControl32 resolves to a window');
    assert.equal(context.send([hwnd, TCM_GETITEMCOUNT, 0, 0]), 0);
    assert.equal(context.send([hwnd, TCM_GETROWCOUNT, 0, 0]), 1);
    const style = context.fns.GetWindowLongA.handler([hwnd, GWL_STYLE]) >>> 0;
    assert.notEqual(style & WS_CLIPSIBLINGS, 0);
    // A vertical row takes several lines.
    const vertical = await context.tabs(TCS_VERTICAL, 0);
    const verticalStyle = context.fns.GetWindowLongA.handler([vertical, GWL_STYLE]) >>> 0;
    assert.notEqual(verticalStyle & TCS_MULTILINE, 0);
});

test('an insert past the end goes at the end, and a control with no focus gives it to '
    + 'the tab it is handed', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_FIXEDWIDTH, 0);
    assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]) | 0, -1);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]) | 0, -1);
    assert.equal(context.insert(hwnd, 1, { text: 'TAB', image: 1 }), 0);
    assert.equal(context.send([hwnd, TCM_GETITEMCOUNT, 0, 0]), 1);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 0);
    assert.equal(context.insert(hwnd, 2, { text: 'TAB', image: 2 }), 1);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 0, 'the focus stays');
    assert.equal(context.send([hwnd, TCM_SETCURFOCUS, -1, 0]), 0);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]) | 0, -1);
    assert.equal(context.insert(hwnd, 3, { text: 'TAB', image: 3 }), 2);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 2, 'the new tab takes it');
});

test('TCM_SETCURSEL answers the previous selection, moves the focus and the pressed '
    + 'state with it, and tells nobody', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_FIXEDWIDTH, 5);
    assert.equal(context.send([hwnd, TCM_SETCURSEL, 4, 0]), 0);
    assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]), 4);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 4);
    context.send([hwnd, TCM_SETCURSEL, -10, 0]);
    assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]) | 0, -1, 'negative deselects');
    assert.equal(context.send([hwnd, TCM_SETCURSEL, 1, 0]) | 0, -1);
    assert.equal(context.send([hwnd, TCM_SETCURSEL, 6, 0]) | 0, -1, 'past the end fails');
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 1, 'and changes nothing');
    assert.equal(context.stateOf(hwnd, 1), TCIS_BUTTONPRESSED, 'the selection is pressed');
    assert.equal(context.send([hwnd, TCM_SETCURSEL, -1, 0]), 1);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]) | 0, -1, 'the focus goes too');
    assert.equal(context.stateOf(hwnd, 1), 0);
    assert.deepEqual(context.codes, []);
});

test('TCM_SETCURFOCUS asks the parent with TCN_SELCHANGING, then tells it TCN_SELCHANGE; '
    + 'a refusal keeps the selection, and taking the focus away is only told', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_FIXEDWIDTH, 5);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 0, 'the first tab to start');
    assert.equal(context.send([hwnd, TCM_SETCURFOCUS, 0, 0]), 0);
    assert.deepEqual(context.codes, [], 'the focused tab again does nothing');

    assert.equal(context.send([hwnd, TCM_SETCURFOCUS, 4, 0]), 0);
    assert.deepEqual(context.codes, [TCN_SELCHANGING, TCN_SELCHANGE]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 4);
    assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]), 4);

    context.codes.length = 0;
    context.answers.selChanging = 1;
    assert.equal(context.send([hwnd, TCM_SETCURFOCUS, 0, 0]), 0);
    assert.deepEqual(context.codes, [TCN_SELCHANGING]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 4);
    assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]), 4);

    context.codes.length = 0;
    assert.equal(context.send([hwnd, TCM_SETCURFOCUS, -1, 0]), 0);
    assert.deepEqual(context.codes, [TCN_SELCHANGE]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]) | 0, -1);
});

test('TCM_SETCURFOCUS past the end is passed over, a negative index takes the focus and '
    + 'the selection away, and the pressed state follows', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_FIXEDWIDTH, 5);
    context.send([hwnd, TCM_SETCURFOCUS, 4, 0]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 4);
    context.send([hwnd, TCM_SETCURFOCUS, -10, 0]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]) | 0, -1);
    assert.equal(context.send([hwnd, TCM_SETCURSEL, 1, 0]) | 0, -1);
    context.send([hwnd, TCM_SETCURFOCUS, 6, 0]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 1);

    context.send([hwnd, TCM_SETCURFOCUS, -1, 0]);
    assert.equal(context.stateOf(hwnd, 0), 0);
    context.send([hwnd, TCM_SETCURFOCUS, 0, 0]);
    assert.equal(context.stateOf(hwnd, 0), TCIS_BUTTONPRESSED);
    context.send([hwnd, TCM_SETCURFOCUS, 1, 0]);
    assert.equal(context.stateOf(hwnd, 0), 0);
    assert.equal(context.stateOf(hwnd, 1), TCIS_BUTTONPRESSED);
    context.send([hwnd, TCM_SETCURFOCUS, -1, 0]);
    assert.equal(context.stateOf(hwnd, 1), 0);
    assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]) | 0, -1);
    context.send([hwnd, TCM_SETCURFOCUS, 0, 0]);
    assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]), 0);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 0);
});

test('buttons keep the focus apart from the selection and tell TCN_FOCUSCHANGE', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_BUTTONS, 5);
    assert.equal(context.send([hwnd, TCM_SETCURFOCUS, 4, 0]), 0);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 4);
    context.send([hwnd, TCM_SETCURFOCUS, -10, 0]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 4, 'a negative is passed over');
    assert.equal(context.send([hwnd, TCM_SETCURSEL, 1, 0]), 0, 'the selection never moved');
    context.send([hwnd, TCM_SETCURFOCUS, 6, 0]);
    assert.equal(context.send([hwnd, TCM_GETCURFOCUS, 0, 0]), 4,
        'nor does the focus follow the selection');
    assert.deepEqual(context.codes, [TCN_FOCUSCHANGE]);
});

test('TCM_GETITEM of a missing tab zeroes the numbers its mask names and leaves the text',
    async()=>{
        const context = setup();
        await context.makeParent();
        const hwnd = await context.tabs(TCS_FIXEDWIDTH, 5);
        const { memory } = context;
        for (const [index, mask, field] of /** @type {const} */ ([
            [5, TCIF_PARAM, TCITEM.lParam], [5, TCIF_IMAGE, TCITEM.iImage],
            [5, TCIF_STATE, TCITEM.dwState], [-1, TCIF_PARAM, TCITEM.lParam],
            [-2, TCIF_PARAM, TCITEM.lParam]]))
        {
            memory.bytes.fill(0xcc, OUT, OUT + TCITEM.SIZE);
            memory.put32(OUT + TCITEM.mask, mask);
            memory.put32(OUT + TCITEM.dwStateMask, TCIS_BUTTONPRESSED);
            assert.equal(context.send([hwnd, TCM_GETITEMA, index, OUT]), 0);
            assert.equal(memory.u32(OUT + field), 0, `field ${field} of tab ${index}`);
        }
        memory.bytes.fill(0xcc, OUT, OUT + TCITEM.SIZE);
        memory.put32(OUT + TCITEM.mask, TCIF_TEXT);
        memory.put32(OUT + TCITEM.pszText, memory.putString(OUT + 0x40, 'a'));
        memory.put32(OUT + TCITEM.cchTextMax, 32);
        assert.equal(context.send([hwnd, TCM_GETITEMA, 5, OUT]), 0);
        assert.equal(memory.readCString(OUT + 0x40, 32), 'a');
    });

test('a tab\'s text round-trips, and its state is read and written through the mask',
    async()=>{
        const context = setup();
        await context.makeParent();
        const hwnd = await context.tabs(TCS_FIXEDWIDTH, 5);
        const { memory } = context;
        memory.bytes.fill(0, OUT, OUT + TCITEM.SIZE);
        memory.put32(OUT + TCITEM.mask, TCIF_TEXT);
        memory.put32(OUT + TCITEM.pszText, memory.putString(OUT + 0x40, 'New Label'));
        memory.put32(OUT + TCITEM.cchTextMax, 32);
        assert.equal(context.send([hwnd, TCM_SETITEMA, 0, OUT]), 1);
        memory.putString(OUT + 0x40, '');
        assert.equal(context.send([hwnd, TCM_GETITEMA, 0, OUT]), 1);
        assert.equal(memory.readCString(OUT + 0x40, 32), 'New Label');
        assert.equal(context.send([hwnd, TCM_GETITEMA, 1, OUT]), 1);
        assert.equal(memory.readCString(OUT + 0x40, 32), 'Tab 2');
        assert.equal(context.send([hwnd, TCM_SETITEMA, 5, OUT]), 0, 'no such tab');

        // The state of the first tab, the selection, is pressed already;
        // highlighting it touches only the bit the mask names.
        memory.put32(OUT + TCITEM.mask, TCIF_STATE);
        memory.put32(OUT + TCITEM.dwStateMask, TCIS_HIGHLIGHTED);
        memory.put32(OUT + TCITEM.dwState, TCIS_HIGHLIGHTED);
        assert.equal(context.send([hwnd, TCM_SETITEMA, 0, OUT]), 1);
        assert.equal(context.stateOf(hwnd, 0, TCIS_HIGHLIGHTED), TCIS_HIGHLIGHTED);
        assert.equal(context.stateOf(hwnd, 0, TCIS_BUTTONPRESSED), TCIS_BUTTONPRESSED);

        // The wide spelling reads and writes the same items.
        memory.put32(OUT + TCITEM.mask, TCIF_TEXT);
        memory.put32(OUT + TCITEM.pszText, memory.putWide(OUT + 0x80, 'Wide'));
        assert.equal(context.send([hwnd, TCM_INSERTITEMW, 5, OUT]), 5);
        memory.put32(OUT + TCITEM.pszText, OUT + 0x40);
        memory.put32(OUT + TCITEM.cchTextMax, 32);
        context.send([hwnd, TCM_GETITEMA, 5, OUT]);
        assert.equal(memory.readCString(OUT + 0x40, 32), 'Wide');
    });

test('TCM_SETITEMEXTRA sizes the tabs\' data before there are any, and exactly that many '
    + 'bytes are kept', async()=>{
    const context = setup();
    await context.makeParent();
    const { memory } = context;
    const empty = await context.tabs(TCS_FIXEDWIDTH, 0);
    assert.equal(context.send([empty, TCM_SETITEMEXTRA, 0, 0]), 1, 'zero is a size');
    assert.equal(context.send([empty, TCM_SETITEMEXTRA, -1, 0]), 0);
    assert.equal(context.send([empty, TCM_SETITEMEXTRA, 2, 0]), 1);
    const full = await context.tabs(TCS_FIXEDWIDTH, 4);
    assert.equal(context.send([full, TCM_SETITEMEXTRA, 2, 0]), 0, 'not once there are tabs');

    const three = await context.tabs(TCS_FIXEDWIDTH, 0);
    assert.equal(context.send([three, TCM_SETITEMEXTRA, 3, 0]), 1);
    assert.equal(context.insert(three, 0, { param: 0xffffffff }), 0);
    memory.bytes.fill(0, OUT, OUT + TCITEM.SIZE);
    memory.put32(OUT + TCITEM.mask, TCIF_PARAM);
    memory.put32(OUT + TCITEM.lParam, 0xaaaaaaaa);
    assert.equal(context.send([three, TCM_GETITEMA, 0, OUT]), 1);
    assert.equal(memory.u32(OUT + TCITEM.lParam), 0xaaffffff, 'the byte past them is left');
});

test('deleting the selected tab leaves none selected, and deleting shifts the focus',
    async()=>{
        const context = setup();
        await context.makeParent();
        const four = await context.tabs(TCS_FIXEDWIDTH, 4);
        assert.equal(context.send([four, TCM_SETCURSEL, 3, 0]), 0);
        assert.equal(context.send([four, TCM_DELETEITEM, 3, 0]), 1);
        assert.equal(context.send([four, TCM_GETCURSEL, 0, 0]) | 0, -1);
        assert.equal(context.send([four, TCM_DELETEITEM, 3, 0]), 0, 'no such tab');

        const two = await context.tabs(TCS_FIXEDWIDTH, 2);
        assert.equal(context.send([two, TCM_GETCURFOCUS, 0, 0]), 0);
        assert.equal(context.send([two, TCM_DELETEITEM, 1, 0]), 1);
        assert.equal(context.send([two, TCM_GETITEMCOUNT, 0, 0]), 1);
        assert.equal(context.send([two, TCM_GETCURFOCUS, 0, 0]), 0);
        context.send([two, TCM_SETCURFOCUS, -1, 0]);
        assert.equal(context.send([two, TCM_DELETEITEM, 0, 0]), 1);
        assert.equal(context.send([two, TCM_GETITEMCOUNT, 0, 0]), 0);
        assert.equal(context.send([two, TCM_GETCURFOCUS, 0, 0]) | 0, -1);
    });

test('TCM_ADJUSTRECT without a rectangle answers -1, and the pane and the window it sits '
    + 'in are each other\'s inverse', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_FIXEDWIDTH, 3);
    assert.equal(context.send([hwnd, TCM_ADJUSTRECT, 0, 0]) | 0, -1);
    assert.equal(context.send([hwnd, TCM_ADJUSTRECT, 1, 0]) | 0, -1);
    const { memory } = context;
    const RECT = OUT + 0x180;
    [0, 0, 280, 160].forEach((value, index)=>memory.put32(RECT + index * 4, value));
    context.send([hwnd, TCM_ADJUSTRECT, 0, RECT]);
    const pane = [0, 4, 8, 12].map(offset=>memory.i32(RECT + offset));
    const row = context.itemRect(hwnd, 0);
    assert.ok(pane[1] >= row.bottom, 'the pane starts below the tabs');
    assert.ok(pane[0] > 0 && pane[2] < 280 && pane[3] < 160, 'and inside the border');
    context.send([hwnd, TCM_ADJUSTRECT, 1, RECT]);
    assert.deepEqual([0, 4, 8, 12].map(offset=>memory.i32(RECT + offset)), [0, 0, 280, 160]);
});

test('a fixed-width tab is an inch wide until TCM_SETITEMSIZE sets it, which answers the '
    + 'size before', async()=>{
    const context = setup();
    await context.makeParent();
    const fixed = await context.tabs(TCS_FIXEDWIDTH, 3);
    const first = context.itemRect(fixed, 0);
    assert.equal(first.found, 1);
    assert.equal(first.right - first.left, 96);
    const before = context.send([fixed, TCM_SETITEMSIZE, 0, 20 << 16 | 50]) >>> 0;
    assert.equal(before & 0xffff, 96);
    let rect = context.itemRect(fixed, 0);
    assert.deepEqual([rect.right - rect.left, rect.bottom - rect.top], [50, 20]);
    const answer = context.send([fixed, TCM_SETITEMSIZE, 0, 1 << 16 | 0]) >>> 0;
    assert.deepEqual([answer & 0xffff, answer >>> 16], [50, 20]);
    rect = context.itemRect(fixed, 0);
    assert.deepEqual([rect.right - rect.left, rect.bottom - rect.top], [0, 1]);
    assert.equal(context.itemRect(fixed, 3).found, 0, 'no such tab');
});

test('a tab that is not fixed is its label and padding wide, at least six average '
    + 'characters, and TCM_SETITEMSIZE sets only its height', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(0, 0);
    context.insert(hwnd, 0, { text: 'A rather long label' });
    context.insert(hwnd, 1, { text: 'x' });
    const label = context.measure(hwnd, 'A rather long label');
    const least = context.measure(hwnd, 'x').width * 6 + 12;
    const wide = context.itemRect(hwnd, 0);
    assert.equal(wide.right - wide.left, Math.max(least, label.width + 12));
    assert.equal(wide.bottom - wide.top, context.measure(hwnd, 'M').height + 5);
    const narrow = context.itemRect(hwnd, 1);
    assert.equal(narrow.right - narrow.left, least);
    assert.equal(narrow.left, wide.right, 'the tabs sit side by side');
    context.send([hwnd, TCM_SETMINTABWIDTH, 0, 94]);
    const set = context.itemRect(hwnd, 1);
    assert.equal(set.right - set.left, 94);
    context.send([hwnd, TCM_SETITEMSIZE, 0, 20 << 16 | 50]);
    const sized = context.itemRect(hwnd, 1);
    assert.deepEqual([sized.right - sized.left, sized.bottom - sized.top], [94, 20]);
});

test('extended style and unicode format answer what they replace', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_FIXEDWIDTH, 5);
    const initial = context.send([hwnd, TCM_GETEXTENDEDSTYLE, 0, 0]);
    assert.equal(context.send([hwnd, TCM_SETEXTENDEDSTYLE, 0, TCS_EX_FLATSEPARATORS]),
        initial);
    assert.equal(context.send([hwnd, TCM_GETEXTENDEDSTYLE, 0, 0]), TCS_EX_FLATSEPARATORS);
    assert.equal(context.send([hwnd, TCM_SETEXTENDEDSTYLE, 0, TCS_EX_REGISTERDROP]),
        TCS_EX_FLATSEPARATORS);
    assert.equal(context.send([hwnd, TCM_GETEXTENDEDSTYLE, 0, 0]), TCS_EX_REGISTERDROP);

    assert.equal(context.send([hwnd, TCM_SETUNICODEFORMAT, 1, 0]), 0);
    assert.equal(context.send([hwnd, TCM_GETUNICODEFORMAT, 0, 0]), 1);
    assert.equal(context.send([hwnd, TCM_SETUNICODEFORMAT, 0, 0]), 1);
    assert.equal(context.send([hwnd, TCM_GETUNICODEFORMAT, 0, 0]), 0);
});

test('removing an image takes the tabs that showed it to none and moves the later ones '
    + 'down', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(TCS_FIXEDWIDTH, 3);
    const images = ()=>[0, 1, 2].map(index=>{
        context.memory.put32(OUT + TCITEM.mask, TCIF_IMAGE);
        context.send([hwnd, TCM_GETITEMA, index, OUT]);
        return context.memory.i32(OUT + TCITEM.iImage);
    });
    assert.deepEqual(images(), [0, 1, 2]);
    context.send([hwnd, TCM_REMOVEIMAGE, 1, 0]);
    assert.deepEqual(images(), [0, -1, 1]);
    context.send([hwnd, TCM_REMOVEIMAGE, 0, 0]);
    assert.deepEqual(images(), [-1, -1, 0]);
});

test('a hit test names the tab under a point, and a click chooses it through the parent',
    async()=>{
        const context = setup();
        await context.makeParent();
        const hwnd = await context.tabs(0, 3);
        const second = context.itemRect(hwnd, 1);
        const x = (second.left + second.right) >> 1;
        const y = (second.top + second.bottom) >> 1;
        const { memory } = context;
        memory.put32(OUT + TCHITTESTINFO.x, x);
        memory.put32(OUT + TCHITTESTINFO.y, y);
        assert.equal(context.send([hwnd, TCM_HITTEST, 0, OUT]), 1);
        assert.equal(memory.u32(OUT + TCHITTESTINFO.flags), TCHT_ONITEM);
        memory.put32(OUT + TCHITTESTINFO.y, 150);
        assert.equal(context.send([hwnd, TCM_HITTEST, 0, OUT]) | 0, -1);
        assert.equal(memory.u32(OUT + TCHITTESTINFO.flags), TCHT_NOWHERE);

        await context.send([hwnd, WM_LBUTTONDOWN, 1, (y << 16 | x) >>> 0]);
        await context.send([hwnd, WM_LBUTTONUP, 0, (y << 16 | x) >>> 0]);
        assert.deepEqual(context.codes, [TCN_SELCHANGING, TCN_SELCHANGE, NM_CLICK]);
        assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]), 1);

        context.codes.length = 0;
        await context.send([hwnd, WM_KEYDOWN, VK_RIGHT, 0]);
        assert.deepEqual(context.codes, [TCN_SELCHANGING, TCN_SELCHANGE]);
        assert.equal(context.send([hwnd, TCM_GETCURSEL, 0, 0]), 2, 'the arrow moves it on');
    });

test('the row and the pane are drawn in the 3D face, the label over it', async()=>{
    const context = setup();
    await context.makeParent();
    const hwnd = await context.tabs(0, 2);
    await context.pump();
    const origin = context.windowRect(hwnd);
    const tab = context.itemRect(hwnd, 1);
    // Inside the pane, clear of its edge.
    assert.equal(context.desktop.read(origin.left + 140, origin.top + 120), FACE);
    // Somewhere across the unselected tab's label, the ink is not the face.
    const row = [];
    const y = origin.top + ((tab.top + tab.bottom) >> 1);
    for (let x = origin.left + tab.left + 3; x < origin.left + tab.right - 3; x++)
    {
        row.push(context.desktop.read(x, y));
    }
    assert.ok(row.some(pixel=>pixel !== FACE), 'the label is drawn');
});

test('in the button form the tabs are buttons, the chosen one pressed in, and the pane has '
    + 'no border', async()=>{
    // The tab control styles: with TCS_BUTTONS "tabs appear as buttons, and
    // no border is drawn around the display area"; TCIS_BUTTONPRESSED is the
    // chosen button's state. The tab form draws the pane's raised border.
    const HILIGHT = 0x00ffffff;
    const SHADOW = 0x00808080;
    const context = setup();
    await context.makeParent();
    /** @param {number} style */
    const drawn = async style=>{
        const hwnd = await context.tabs(style, 2);
        await context.pump();
        const origin = context.windowRect(hwnd);
        /** @param {number} x @param {number} y */
        const at = (x, y)=>context.desktop.read(origin.left + x, origin.top + y);
        const first = context.itemRect(hwnd, 0);
        const second = context.itemRect(hwnd, 1);
        const seen = { chosen: at(first.left, first.top), other: at(second.left, second.top),
            pane: at(0, 120) };
        context.fns.DestroyWindow.handler([hwnd]);
        await context.pump();
        return seen;
    };
    assert.equal((await drawn(0)).pane, HILIGHT, 'the tab form borders the pane');
    const buttons = await drawn(TCS_BUTTONS);
    assert.equal(buttons.pane, FACE, 'the button form does not');
    assert.equal(buttons.chosen, SHADOW, 'the chosen button is pressed in');
    assert.equal(buttons.other, HILIGHT, 'and the other stands out');
});
