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
    TREEVIEW_CLASS, TVS_HASBUTTONS, TVS_HASLINES, TVS_LINESATROOT, TVS_CHECKBOXES,
    TVS_SHOWSELALWAYS, TVM_INSERTITEMA, TVM_DELETEITEM, TVM_EXPAND, TVM_GETCOUNT,
    TVM_GETNEXTITEM, TVM_SELECTITEM, TVM_GETITEMA, TVM_SETITEMA, TVM_GETVISIBLECOUNT,
    TVM_HITTEST, TVM_ENSUREVISIBLE, TVM_SETIMAGELIST, TVM_GETIMAGELIST,
    TVIF_TEXT, TVIF_PARAM, TVIF_STATE, TVIF_CHILDREN, TVIS_SELECTED, TVIS_EXPANDED,
    TVIS_STATEIMAGEMASK, LPSTR_TEXTCALLBACK, TVITEM, TVINSERTSTRUCT,
    WM_NOTIFY, NM_CLICK, NM_DBLCLK, TVN_SELCHANGINGA, TVN_SELCHANGEDA,
    TVN_GETDISPINFOA, TVN_ITEMEXPANDINGA, TVN_ITEMEXPANDEDA,
} from './treeview.js';

/**
 * The window manager over the real drawing engine, with the common controls
 * registered and a parent window that watches WM_NOTIFY: it records every
 * notification and answers TVN_GETDISPINFO the way a parent that knows its
 * items' text would, by writing into the buffer the control handed it.
 */

const MSG_BUFFER = 0x13000;
const TEXT = 0x13100;
const OUT = 0x13200;
const INS = 0x14000;
const HEAP = 0x18000;
const HINSTANCE = 0x400000;
const DIALOGPROC = 0x401000;
const THREAD = { name: 'main' };

const SCREEN = { width: 240, height: 320, bitsPerPixel: 32 };

const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
const WM_VSCROLL = 0x0115;
const WM_LBUTTONDOWN = 0x0201;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CAPTION = 0x00c00000;
const PM_REMOVE = 1;

const TVI_ROOT = 0xffff0000;
const TVI_LAST = 0xffff0002;
const TVE_EXPAND = 2;
const TVE_COLLAPSE = 1;
const TVGN_ROOT = 0;
const TVGN_NEXT = 1;
const TVGN_PARENT = 3;
const TVGN_CHILD = 4;
const TVGN_FIRSTVISIBLE = 5;
const TVGN_NEXTVISIBLE = 6;
const TVGN_CARET = 9;
const VK_SPACE = 0x20;
const VK_DOWN = 0x28;
const SB_LINEDOWN = 1;

const COLOR_HIGHLIGHT = 0x00000080;
const COLOR_WINDOW = 0x00ffffff;

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
    /** @type {{ hwnd: number, message: number, wParam: number, lParam: number }[]} */
    const dispatched = [];
    /** What a TVN_GETDISPINFO answers for each item handle. @type {Map<number,string>} */
    const callbackText = new Map();
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
        dispatch: (wndProc, message)=>{
            dispatched.push({ ...message });
            if (message.message === WM_NOTIFY)
            {
                const code = memory.i32(message.lParam + 8);
                if (code === TVN_GETDISPINFOA)
                {
                    const handle = memory.u32(message.lParam + 12 + TVITEM.hItem);
                    const buffer = memory.i32(message.lParam + 12 + TVITEM.pszText) >>> 0;
                    const text = callbackText.get(handle) ?? '';
                    if (buffer !== 0)
                    {
                        memory.putString(buffer, text);
                    }
                }
                return 0;
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

    const host_window = { hwnd: 0 };
    /** @param {number} style */
    const tree = async(style, x = 8, y = 8, width = 200, height = 120)=>{
        memory.putString(TEXT, TREEVIEW_CLASS);
        return table.CreateWindowExA.handler([0, TEXT, 0, WS_CHILD | WS_VISIBLE | style,
            x, y, width, height, host_window.hwnd, 800, HINSTANCE, 0]);
    };

    /**
     * Inserts an item. `options.text` is a real string, `options.callback`
     * makes the text a LPSTR_TEXTCALLBACK answered by `callbackText`.
     *
     * @param {number} hwnd @param {number} parent
     * @param {{ text?: string, callback?: boolean, param?: number, state?: number,
     *     stateMask?: number, children?: number }} options
     */
    const insert = (hwnd, parent, options)=>{
        memory.put32(INS + TVINSERTSTRUCT.hParent, parent);
        memory.put32(INS + TVINSERTSTRUCT.hInsertAfter, TVI_LAST);
        const item = INS + TVINSERTSTRUCT.item;
        memory.put32(item + TVITEM.mask,
            (options.text !== undefined || options.callback ? TVIF_TEXT : 0)
            | (options.param !== undefined ? TVIF_PARAM : 0)
            | (options.state !== undefined ? TVIF_STATE : 0)
            | (options.children !== undefined ? TVIF_CHILDREN : 0));
        if (options.callback)
        {
            memory.put32(item + TVITEM.pszText, LPSTR_TEXTCALLBACK);
        }
        else if (options.text !== undefined)
        {
            memory.putString(TEXT + 0x100, options.text);
            memory.put32(item + TVITEM.pszText, TEXT + 0x100);
        }
        if (options.param !== undefined)
        {
            memory.put32(item + TVITEM.lParam, options.param);
        }
        if (options.state !== undefined)
        {
            memory.put32(item + TVITEM.state, options.state);
            memory.put32(item + TVITEM.stateMask, options.stateMask ?? options.state);
        }
        if (options.children !== undefined)
        {
            memory.put32(item + TVITEM.cChildren, options.children);
        }
        return table.SendMessageA.handler([hwnd, TVM_INSERTITEMA, 0, INS]);
    };

    /** The notification codes the parent was handed, in order. */
    const notifications = ()=>dispatched
        .filter(one=>one.message === WM_NOTIFY)
        .map(one=>memory.i32(one.lParam + 8));

    /** The client area of the tree on the screen (a borderless child: itself).
     * @param {number} hwnd */
    const treeRect = hwnd=>{
        table.GetWindowRect.handler([hwnd, OUT + 0x200]);
        return { left: memory.u32(OUT + 0x200), top: memory.u32(OUT + 0x204),
            right: memory.u32(OUT + 0x208), bottom: memory.u32(OUT + 0x20c) };
    };
    /**
     * A depth-0 row at a visible index, in client coordinates (cx, cy: what a
     * click or a hit test names) and in screen coordinates (sx, sy: what the
     * desktop shows it at).
     *
     * @param {number} hwnd @param {number} index
     */
    const treeRow = (hwnd, index)=>{
        const rect = treeRect(hwnd);
        const hdc = gdi.windowContext(hwnd, null);
        const height = hdc !== 0 ? gdi.draw.measure(hdc, 'M').height : 18;
        gdi.table.ReleaseDC.handler([hwnd, hdc]);
        return { cx: 1, cy: index * height, sx: rect.left + 1,
            sy: rect.top + index * height, rect };
    };

    return {
        memory, desktop, gdi, fns: table, pump, tree, insert, notifications,
        dispatched, callbackText, host_window, treeRect, treeRow,
        makeHost: async()=>{
            const name = TEXT + 64;
            memory.putString(name, 'host');
            const CLASS = name + 64;
            [0, DIALOGPROC, 0, 0, HINSTANCE, 0, 0, 0, 0, name].forEach((value, index)=>{
                memory.put32(CLASS + index * 4, value);
            });
            table.RegisterClassA.handler([CLASS]);
            host_window.hwnd = await table.CreateWindowExA.handler([0, name, name,
                WS_POPUP | WS_CAPTION | WS_VISIBLE, 0, 0, 230, 300, 0, 0, HINSTANCE, 0]);
            await pump();
            return host_window.hwnd;
        },
    };
}

test('items insert into a hierarchy the relations walk', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(TVS_HASBUTTONS | TVS_HASLINES);
    const root = context.insert(tree, TVI_ROOT, { text: 'Components' });
    const child = context.insert(tree, root, { text: 'Game.dll' });
    const other = context.insert(tree, TVI_ROOT, { text: 'Shortcuts' });
    assert.notEqual(root, 0);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETCOUNT, 0, 0]), 3);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM, TVGN_ROOT, 0]), root);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM, TVGN_NEXT, root]),
        other, 'roots are siblings in insertion order');
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM, TVGN_CHILD, root]),
        child);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM, TVGN_PARENT, child]),
        root);
});

test('an item\'s text and param round-trip through GETITEM and SETITEM', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(0);
    const item = context.insert(tree, TVI_ROOT, { text: 'War3.mpq', param: 0x1234 });
    context.memory.put32(OUT + TVITEM.hItem, item);
    context.memory.put32(OUT + TVITEM.mask, TVIF_TEXT | TVIF_PARAM);
    context.memory.put32(OUT + TVITEM.pszText, OUT + 64);
    context.memory.put32(OUT + TVITEM.cchTextMax, 32);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]), 1);
    assert.equal(context.memory.readCString(OUT + 64, 32), 'War3.mpq');
    assert.equal(context.memory.u32(OUT + TVITEM.lParam), 0x1234);

    context.memory.putString(OUT + 64, 'renamed');
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_SETITEMA, 0, OUT]), 1);
    context.memory.put32(OUT + TVITEM.pszText, OUT + 96);
    context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]);
    assert.equal(context.memory.readCString(OUT + 96, 32), 'renamed');
});

test('a callback text is asked of the parent with TVN_GETDISPINFO', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(0);
    const item = context.insert(tree, TVI_ROOT, { callback: true });
    context.callbackText.set(item, 'Answered by the parent');
    context.memory.put32(OUT + TVITEM.hItem, item);
    context.memory.put32(OUT + TVITEM.mask, TVIF_TEXT);
    context.memory.put32(OUT + TVITEM.pszText, OUT + 64);
    context.memory.put32(OUT + TVITEM.cchTextMax, 48);
    await context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]);
    assert.equal(context.memory.readCString(OUT + 64, 48), 'Answered by the parent');
    assert.ok(context.notifications().includes(TVN_GETDISPINFOA),
        'the parent was asked, not guessed at');
});

test('expanding tells the parent before and after, and shows the children', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(TVS_HASBUTTONS);
    const root = context.insert(tree, TVI_ROOT, { text: 'Root', children: 1 });
    const child = context.insert(tree, root, { text: 'Child' });
    // Collapsed: the child is not a visible row.
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM,
        TVGN_FIRSTVISIBLE, 0]), root);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_EXPAND, TVE_EXPAND, root]), 1);
    assert.deepEqual(context.notifications(), [TVN_ITEMEXPANDINGA, TVN_ITEMEXPANDEDA]);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM,
        TVGN_NEXTVISIBLE, root]), child, 'the child is on show once expanded');
    context.fns.SendMessageA.handler([tree, TVM_EXPAND, TVE_COLLAPSE, root]);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM,
        TVGN_NEXTVISIBLE, root]), 0, 'and hidden again once collapsed');
});

test('selecting sends SELCHANGING then SELCHANGED and moves the caret', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(TVS_SHOWSELALWAYS);
    const first = context.insert(tree, TVI_ROOT, { text: 'One' });
    const second = context.insert(tree, TVI_ROOT, { text: 'Two' });
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_SELECTITEM, TVGN_CARET, second]),
        0);
    assert.deepEqual(context.notifications(), [TVN_SELCHANGINGA, TVN_SELCHANGEDA]);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM, TVGN_CARET, 0]),
        second);
    context.memory.put32(OUT + TVITEM.hItem, second);
    context.memory.put32(OUT + TVITEM.mask, TVIF_STATE);
    context.memory.put32(OUT + TVITEM.stateMask, TVIS_SELECTED);
    context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]);
    assert.notEqual(context.memory.u32(OUT + TVITEM.state) & TVIS_SELECTED, 0,
        'the selected item reports TVIS_SELECTED');
    void first;
});

test('the check-box state lives in the state image mask and a click toggles it',
    async()=>{
        const context = setup();
        await context.makeHost();
        const tree = await context.tree(TVS_CHECKBOXES);
        const item = context.insert(tree, TVI_ROOT, { text: 'Install',
            state: 1 << 12, stateMask: TVIS_STATEIMAGEMASK });
        context.memory.put32(OUT + TVITEM.hItem, item);
        context.memory.put32(OUT + TVITEM.mask, TVIF_STATE);
        context.memory.put32(OUT + TVITEM.stateMask, TVIS_STATEIMAGEMASK);
        context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]);
        assert.equal(context.memory.u32(OUT + TVITEM.state) >>> 12, 1, 'unchecked');

        // A click on the row's check box toggles it and says NM_CLICK.
        context.fns.SendMessageA.handler([tree, TVM_SELECTITEM, TVGN_CARET, item]);
        const at = context.treeRow(tree, 0);
        context.fns.PostMessageA.handler([tree, WM_LBUTTONDOWN, 0,
            ((at.cy + 4) << 16 | at.cx) >>> 0]);
        await context.pump();
        context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]);
        assert.equal(context.memory.u32(OUT + TVITEM.state) >>> 12, 2, 'checked');
        assert.ok(context.notifications().includes(NM_CLICK));
    });

test('space on the focused item toggles its check', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(TVS_CHECKBOXES);
    const item = context.insert(tree, TVI_ROOT, { text: 'Install',
        state: 2 << 12, stateMask: TVIS_STATEIMAGEMASK });
    await context.fns.SetFocus.handler([tree]);
    context.fns.SendMessageA.handler([tree, TVM_SELECTITEM, TVGN_CARET, item]);
    context.fns.PostMessageA.handler([tree, WM_CHAR, VK_SPACE, 0]);
    await context.pump();
    context.memory.put32(OUT + TVITEM.hItem, item);
    context.memory.put32(OUT + TVITEM.mask, TVIF_STATE);
    context.memory.put32(OUT + TVITEM.stateMask, TVIS_STATEIMAGEMASK);
    context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]);
    assert.equal(context.memory.u32(OUT + TVITEM.state) >>> 12, 1, 'space unchecked it');
});

test('the arrow keys move the caret down the visible rows', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(0);
    const first = context.insert(tree, TVI_ROOT, { text: 'One' });
    const second = context.insert(tree, TVI_ROOT, { text: 'Two' });
    await context.fns.SetFocus.handler([tree]);
    context.fns.SendMessageA.handler([tree, TVM_SELECTITEM, TVGN_CARET, first]);
    context.fns.PostMessageA.handler([tree, WM_KEYDOWN, VK_DOWN, 0]);
    await context.pump();
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM, TVGN_CARET, 0]),
        second);
});

test('DELETEITEM removes a subtree and TVI_ROOT clears the whole tree', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(0);
    const root = context.insert(tree, TVI_ROOT, { text: 'Root', children: 1 });
    context.insert(tree, root, { text: 'Child' });
    context.insert(tree, TVI_ROOT, { text: 'Other' });
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETCOUNT, 0, 0]), 3);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_DELETEITEM, 0, root]), 1);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETCOUNT, 0, 0]), 1,
        'the subtree went with it');
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_DELETEITEM, 0, TVI_ROOT]), 1);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETCOUNT, 0, 0]), 0);
});

test('HITTEST names the row a point falls in', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(0);
    const first = context.insert(tree, TVI_ROOT, { text: 'One' });
    context.insert(tree, TVI_ROOT, { text: 'Two' });
    const at = context.treeRow(tree, 1);
    context.memory.put32(OUT + 0, at.cx);
    context.memory.put32(OUT + 4, at.cy + 4);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_HITTEST, 0, OUT]),
        context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM, TVGN_NEXT, first]),
        'the second row');
});

test('ENSUREVISIBLE opens the ancestors of a hidden item', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(TVS_HASBUTTONS);
    const root = context.insert(tree, TVI_ROOT, { text: 'Root', children: 1 });
    const child = context.insert(tree, root, { text: 'Child', children: 1 });
    const leaf = context.insert(tree, child, { text: 'Leaf' });
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_ENSUREVISIBLE, 0, leaf]), 1);
    context.memory.put32(OUT + TVITEM.hItem, root);
    context.memory.put32(OUT + TVITEM.mask, TVIF_STATE);
    context.memory.put32(OUT + TVITEM.stateMask, TVIS_EXPANDED);
    context.fns.SendMessageA.handler([tree, TVM_GETITEMA, 0, OUT]);
    assert.notEqual(context.memory.u32(OUT + TVITEM.state) & TVIS_EXPANDED, 0,
        'the root opened on the way to the leaf');
});

test('an image list is kept and handed back, and said to be undrawn', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(0);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_SETIMAGELIST, 0, 0x77]), 0);
    assert.equal(context.fns.SendMessageA.handler([tree, TVM_GETIMAGELIST, 0, 0]), 0x77);
});

test('rows past the client area bring a scroll bar that WM_VSCROLL moves', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(0, 8, 8, 200, 40);
    for (let index = 0; index < 12; index++)
    {
        context.insert(tree, TVI_ROOT, { text: `Row ${index}` });
    }
    const visible = context.fns.SendMessageA.handler([tree, TVM_GETVISIBLECOUNT, 0, 0]);
    assert.ok(visible < 12, 'not every row fits');
    const firstBefore = context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM,
        TVGN_FIRSTVISIBLE, 0]);
    context.fns.SendMessageA.handler([tree, WM_VSCROLL, SB_LINEDOWN, 0]);
    const firstAfter = context.fns.SendMessageA.handler([tree, TVM_GETNEXTITEM,
        TVGN_FIRSTVISIBLE, 0]);
    assert.notEqual(firstAfter, firstBefore, 'the first visible row moved down');
    await context.pump();
    // The scroll bar's face is on the right edge of the client area.
    const rect = context.treeRect(tree);
    assert.notEqual(context.desktop.read(rect.right - 8, rect.top + 4), COLOR_WINDOW,
        'a scroll bar occupies the right edge');
});

test('a tree paints its rows, its selection and its check boxes', async()=>{
    const context = setup();
    await context.makeHost();
    const tree = await context.tree(TVS_HASBUTTONS | TVS_HASLINES | TVS_LINESATROOT
        | TVS_CHECKBOXES | TVS_SHOWSELALWAYS);
    const root = context.insert(tree, TVI_ROOT, { text: 'Components', children: 1,
        state: 2 << 12, stateMask: TVIS_STATEIMAGEMASK });
    context.insert(tree, root, { text: 'Game.dll' });
    context.fns.SendMessageA.handler([tree, TVM_EXPAND, TVE_EXPAND, root]);
    context.fns.SendMessageA.handler([tree, TVM_SELECTITEM, TVGN_CARET, root]);
    await context.pump();
    const rect = context.treeRect(tree);
    const row = context.treeRow(tree, 0);
    // The selected first row is the highlight colour across its band.
    assert.equal(context.desktop.read(row.sx + 60, row.sy + 4), COLOR_HIGHLIGHT,
        'the selected row is highlighted');
    // A row below the painted ones is still the window colour.
    assert.equal(context.desktop.read(rect.left + 60, rect.bottom - 4), COLOR_WINDOW);
    void NM_DBLCLK;
});
