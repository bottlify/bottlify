/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createMessageQueue } from './messages.js';
import { createWindowFunctions } from './windows.js';
import { MSG } from './structs.js';
import { createGdiFunctions } from '../gdi32/functions.js';
import { createGdiDrawing } from '../../graphics/gdi/context.js';
import { createSurface, surfaceForDibSection, viewOf } from '../../graphics/gdi/surface.js';
import { createCommonControls } from '../comctl32/controls.js';
import { PBM_SETRANGE, PBM_SETPOS } from '../comctl32/progress.js';
import {
    TVM_INSERTITEMA, TVM_EXPAND, TVM_SELECTITEM, TVS_HASBUTTONS, TVS_HASLINES,
    TVS_LINESATROOT, TVS_CHECKBOXES, TVS_SHOWSELALWAYS, TVITEM, TVINSERTSTRUCT,
    TVIF_TEXT, TVIF_STATE, TVIF_CHILDREN, TVIS_STATEIMAGEMASK,
} from '../comctl32/treeview.js';
import { decodePng, encodePng } from './png.fixture.js';

/**
 * These tests assemble the window manager over the real drawing engine: a
 * desktop surface in test memory, gdi32's contexts over it, and user32's
 * windows and controls on top. What a control paints is compared byte for
 * byte with a stored image; what it does is read off the messages it sends.
 */

const REFERENCE = new URL('./controls.reference.png', import.meta.url);

/** Guest addresses the fixtures use: above the atom range, so none reads as one. */
const TEMPLATE = 0x12000;
const MSG_BUFFER = 0x13000;
const TEXT = 0x13100;
const OUT = 0x13200;
const HEAP = 0x18000;
const HINSTANCE = 0x400000;
const DIALOGPROC = 0x401000;
const GUEST_PROC = 0x402000;
const THREAD = { name: 'main' };

const SCREEN = { width: 240, height: 320, bitsPerPixel: 32 };

const WM_CREATE = 0x0001;
const WM_PAINT = 0x000f;
const WM_CLOSE = 0x0010;
const WM_KEYDOWN = 0x0100;
const WM_KEYUP = 0x0101;
const WM_CHAR = 0x0102;
const WM_GETFONT = 0x0031;
const WM_INITDIALOG = 0x0110;
const WM_COMMAND = 0x0111;
const WM_VSCROLL = 0x0115;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONUP = 0x0202;
const WM_NCLBUTTONDOWN = 0x00a1;
const WM_NCHITTEST = 0x0084;
const WM_CTLCOLORSTATIC = 0x0138;
const BM_GETCHECK = 0x00f0;
const BM_SETCHECK = 0x00f1;
const BN_CLICKED = 0;
const EM_GETSEL = 0x00b0;
const EM_SETSEL = 0x00b1;
const EM_REPLACESEL = 0x00c2;
const EM_LIMITTEXT = 0x00c5;
const EM_GETLINECOUNT = 0x00ba;
const EM_GETFIRSTVISIBLELINE = 0x00ce;
const EN_SETFOCUS = 0x0100;
const EN_CHANGE = 0x0300;
const LB_ADDSTRING = 0x0180;
const LB_GETCOUNT = 0x018b;
const LB_GETCURSEL = 0x0188;
const LB_SETCURSEL = 0x0186;
const LB_GETTEXT = 0x0189;
const LB_GETTEXTLEN = 0x018a;
const LBN_SELCHANGE = 1;
const CB_ADDSTRING = 0x0143;
const CB_GETCOUNT = 0x0146;
const CB_GETCURSEL = 0x0147;
const CB_SETCURSEL = 0x014e;
const CB_GETLBTEXT = 0x0148;
const CB_GETEDITSEL = 0x0140;
const CB_SETEDITSEL = 0x0142;
const CB_LIMITTEXT = 0x0141;
const CBN_SELCHANGE = 1;
const CBN_EDITUPDATE = 5;
const CBN_EDITCHANGE = 6;
const SBM_SETRANGE = 0x00e2;
const SBM_SETPOS = 0x00e0;
const SBM_GETPOS = 0x00e1;
const SB_LINEDOWN = 1;
const DM_GETDEFID = 0x0400;
const DM_SETDEFID = 0x0401;
const HTCLIENT = 1;
const HTTRANSPARENT = -1;
const IDCANCEL = 2;

const VK_TAB = 0x09;
const VK_RETURN = 0x0d;
const VK_SHIFT = 0x10;
const VK_ESCAPE = 0x1b;
const VK_SPACE = 0x20;
const VK_LEFT = 0x25;
const VK_DOWN = 0x28;
const VK_NEXT = 0x22;

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CAPTION = 0x00c00000;
const WS_VSCROLL = 0x00200000;
const WS_TABSTOP = 0x00010000;
const WS_EX_CLIENTEDGE = 0x00000200;
const DS_SETFONT = 0x0040;
const DS_MODALFRAME = 0x0080;
const BS_DEFPUSHBUTTON = 0x0001;
const BS_AUTOCHECKBOX = 0x0003;
const BS_AUTORADIOBUTTON = 0x0009;
const BS_GROUPBOX = 0x0007;
const SS_NOTIFY = 0x0100;
const ES_MULTILINE = 0x0004;
const ES_READONLY = 0x0800;
const LBS_NOTIFY = 0x0001;
const SBS_VERT = 0x0001;
const GWL_WNDPROC = -4;
const PM_REMOVE = 1;

/** Guest memory as a flat array, with helpers to put fixtures in it. */
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
            if (end - address >= maxLength)
            {
                throw new Error(`No NUL within ${maxLength} bytes of 0x${address.toString(16)}`);
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
 * A dialog template as a resource compiler writes one: everything
 * little-endian, names as terminated UTF-16, each item on a four-byte edge.
 *
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {{ style: number, title: string, x?: number, y?: number, cx: number, cy: number,
 *     font?: { pointSize: number, face: string },
 *     controls: { id: number, className: string, title: string, style: number,
 *         x: number, y: number, cx: number, cy: number }[] }} dialog
 */
function putTemplate(memory, dialog){
    let at = TEMPLATE;
    /** @param {number} value */
    const u16 = value=>{
        memory.bytes[at] = value & 0xff;
        memory.bytes[at + 1] = (value >>> 8) & 0xff;
        at += 2;
    };
    /** @param {number} value */
    const u32 = value=>{
        u16(value & 0xffff);
        u16(value >>> 16);
    };
    /** @param {string} text */
    const sz = text=>{
        for (const character of text)
        {
            u16(character.charCodeAt(0));
        }
        u16(0);
    };
    u32(dialog.style);
    u32(0);
    u16(dialog.controls.length);
    u16(dialog.x ?? 0);
    u16(dialog.y ?? 0);
    u16(dialog.cx);
    u16(dialog.cy);
    sz('');
    sz('');
    sz(dialog.title);
    if (dialog.font)
    {
        u16(dialog.font.pointSize);
        sz(dialog.font.face);
    }
    for (const control of dialog.controls)
    {
        at = (at + 3) & ~3;
        u32(control.style);
        u32(0);
        u16(control.x);
        u16(control.y);
        u16(control.cx);
        u16(control.cy);
        u16(control.id);
        sz(control.className);
        sz(control.title);
        u16(0);
    }
    return TEMPLATE;
}

/**
 * What the test engine draws a string as: each character its average width,
 * a pixel less or more by its code.
 *
 * @param {string} text @param {number} average
 */
const textWidth = (text, average)=>[...text]
    .reduce((sum, character)=>sum + average + character.charCodeAt(0) % 3 - 1, 0);

/**
 * @param {Object} [options]
 * @param {(message: { hwnd: number, message: number, wParam: number, lParam: number })
 *     => number} [options.reply]  What a guest window procedure answers.
 * @param {boolean} [options.engine]
 *     A font engine of sorts: every face measures as a cell of half its
 *     character height across and two more than it down, so a dialog set in
 *     a smaller font lays out smaller, and the face asked for is recorded.
 *     Its glyphs are proportional -- a pixel either side of the average by
 *     the character code -- and average out exactly over the alphabet.
 */
function setup({ reply = ()=>0, engine = false } = {}){
    const memory = fakeMemory();
    const handles = fakeHandles();
    const queue = createMessageQueue();
    const desktop = createSurface({ width: SCREEN.width, height: SCREEN.height });
    /** @type {{ wndProc: number, hwnd: number, message: number, wParam: number,
     *     lParam: number }[]} */
    const dispatched = [];
    /** @type {Set<number>} */
    const keysDown = new Set();
    let presents = 0;
    let heapNext = HEAP;
    /** @type {string[]} */
    const faces = [];
    /** @param {{ height: number, faceName: string }} font */
    const metricsOf = font=>{
        faces.push(font.faceName);
        const em = Math.abs(font.height) || 16;
        return { height: em + 2, ascent: em, descent: 2, internalLeading: 2, externalLeading: 0,
            aveCharWidth: Math.ceil(em / 2), maxCharWidth: em };
    };

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
            ...(engine ? {
                fontMetrics: metricsOf,
                /** @param {{ height: number, faceName: string }} font @param {string} text */
                textWidth: (font, text)=>textWidth(text, metricsOf(font).aveCharWidth),
            } : {}),
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
            dispatched.push({ wndProc, ...message });
            return reply(message);
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
        present: ()=>{
            presents++;
        },
        keyState: key=>(keysDown.has(key) ? 0x8000 : 0),
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

    /**
     * Pumps the queue the way a program's loop does, until it is empty:
     * the dialog keys first, then translate and dispatch.
     *
     * @param {number} [dialog]
     */
    const pump = async(dialog = 0)=>{
        for (let guard = 0; guard < 1000; guard++)
        {
            if (table.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]) === 0)
            {
                return;
            }
            if (dialog !== 0 && await table.IsDialogMessageA.handler([dialog, MSG_BUFFER]) !== 0)
            {
                continue;
            }
            table.TranslateMessage.handler([MSG_BUFFER]);
            await table.DispatchMessageA.handler([MSG_BUFFER]);
        }
        throw new Error('the queue never emptied');
    };

    /** A message from the input layer: named by the pointer's position, not a window. */
    const mouse = (/** @type {number} */ message, /** @type {number} */ x,
        /** @type {number} */ y)=>queue.post({
        hwnd: 0, message, wParam: 0, lParam: ((y & 0xffff) << 16 | x & 0xffff) >>> 0,
        time: 0, x, y,
    });
    const key = (/** @type {number} */ message, /** @type {number} */ code)=>queue.post({
        hwnd: 0, message, wParam: code, lParam: 0, time: 0, x: 0, y: 0,
    });
    /** A click: down and up at one point. */
    const click = (/** @type {number} */ x, /** @type {number} */ y)=>{
        mouse(WM_LBUTTONDOWN, x, y);
        mouse(WM_LBUTTONUP, x, y);
    };
    /** The WM_COMMANDs the dialog procedure was handed, as [id, code, lParam]. */
    const commands = ()=>dispatched
        .filter(one=>one.wndProc === DIALOGPROC && one.message === WM_COMMAND)
        .map(one=>[one.wParam & 0xffff, one.wParam >>> 16, one.lParam]);
    /** Centre of a window on the screen. @param {number} hwnd */
    const centre = hwnd=>{
        table.GetWindowRect.handler([hwnd, OUT]);
        return {
            x: Math.floor((memory.u32(OUT) + memory.u32(OUT + 8)) / 2),
            y: Math.floor((memory.u32(OUT + 4) + memory.u32(OUT + 12)) / 2),
        };
    };

    return {
        memory, queue, desktop, gdi, fns: table, dispatched, keysDown, pump, mouse, key, click,
        commands, centre, faces, presents: ()=>presents,
    };
}

/** The dialog every test starts from: a push button, a static, a check box. */
const WIZARD_PAGE = Object.freeze({
    style: WS_POPUP | WS_CAPTION | WS_VISIBLE | DS_MODALFRAME,
    title: 'Setup',
    x: 4, y: 4, cx: 100, cy: 60,
    controls: [
        { id: 3, className: 'Button', title: '&Next >', x: 56, y: 40, cx: 40, cy: 14,
            style: WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON },
        { id: 100, className: 'Static', title: 'Welcome to the setup wizard', x: 4, y: 4,
            cx: 92, cy: 16, style: WS_CHILD | WS_VISIBLE },
        { id: 101, className: 'Button', title: '&Verify files', x: 4, y: 24, cx: 60, cy: 10,
            style: WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX },
    ],
});

/**
 * @param {ReturnType<typeof setup>} context
 * @param {Parameters<typeof putTemplate>[1]} [page]
 */
async function openDialog(context, page = WIZARD_PAGE){
    putTemplate(context.memory, page);
    const dialog = context.fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.notEqual(dialog, 0);
    await context.pump(dialog);
    return dialog;
}

test('byte-exact: a dialog with a push button, a static and a check box paints as stored',
    async()=>{
        // What the classic controls look like, pinned pixel for pixel. The
        // reference beside this file is written once with WRITE_REFERENCE=1
        // and looked at; from then on any change to the painting is a change
        // to the picture, and has to be a deliberate one.
        const context = setup({ reply: message=>(message.message === WM_INITDIALOG ? 1 : 0) });
        const dialog = await openDialog(context);
        context.fns.SendDlgItemMessageA.handler([dialog, 101, BM_SETCHECK, 1, 0]);
        await context.pump(dialog);

        // The common controls, in the band the dialog leaves empty below it:
        // a progress bar three fifths of the way along its range. Its region
        // of the reference is new; everything above it is the dialog's and
        // must come out exactly as it did before the bar existed.
        context.memory.putString(TEXT, 'msctls_progress32');
        const progress = context.fns.CreateWindowExA.handler([0, TEXT, 0,
            WS_POPUP | WS_VISIBLE, 8, 164, 200, 22, 0, 0, HINSTANCE, 0]);
        assert.notEqual(progress, 0);
        context.fns.SendMessageA.handler([progress, PBM_SETRANGE, 0, (100 << 16) | 0]);
        context.fns.SendMessageA.handler([progress, PBM_SETPOS, 60, 0]);
        await context.pump(dialog);

        // A tree view under the bar: a two-level component list with lines,
        // [+] buttons and check boxes, one item checked and one selected, so
        // the whole of the classic look is in the picture. Its region is new
        // too; the dialog's and the bar's are not.
        const INS2 = 0x15000;
        /** @param {number} at @param {number} value */
        const put32 = (at, value)=>context.memory.writeMemory(at, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
        context.memory.putString(TEXT, 'SysTreeView32');
        const tree = context.fns.CreateWindowExA.handler([0, TEXT, 0,
            WS_POPUP | WS_VISIBLE | TVS_HASBUTTONS | TVS_HASLINES | TVS_LINESATROOT
            | TVS_CHECKBOXES | TVS_SHOWSELALWAYS, 8, 200, 200, 110, 0, 0, HINSTANCE, 0]);
        assert.notEqual(tree, 0);
        /** @param {number} parent @param {string} text @param {any} [opts] */
        const insertTree = (parent, text, opts = {})=>{
            put32(INS2 + TVINSERTSTRUCT.hParent, parent);
            put32(INS2 + TVINSERTSTRUCT.hInsertAfter, 0xffff0002);
            const item = INS2 + TVINSERTSTRUCT.item;
            put32(item + TVITEM.mask, TVIF_TEXT
                | (opts.state !== undefined ? TVIF_STATE : 0)
                | (opts.children ? TVIF_CHILDREN : 0));
            context.memory.putString(TEXT + 0x200, text);
            put32(item + TVITEM.pszText, TEXT + 0x200);
            if (opts.state !== undefined)
            {
                put32(item + TVITEM.state, opts.state);
                put32(item + TVITEM.stateMask, TVIS_STATEIMAGEMASK);
            }
            if (opts.children)
            {
                put32(item + TVITEM.cChildren, 1);
            }
            return context.fns.SendMessageA.handler([tree, TVM_INSERTITEMA, 0, INS2]);
        };
        const root = insertTree(0xffff0000, 'Components',
            { children: true, state: 2 << 12 });
        const child = insertTree(root, 'Game files');
        insertTree(root, 'Movies');
        insertTree(0xffff0000, 'Shortcuts');
        context.fns.SendMessageA.handler([tree, TVM_EXPAND, 2, root]);
        context.fns.SendMessageA.handler([tree, TVM_SELECTITEM, 9, child]);
        await context.pump(dialog);

        if (process.env.WRITE_REFERENCE)
        {
            writeFileSync(REFERENCE, encodePng(context.desktop));
        }
        const stored = decodePng(new Uint8Array(readFileSync(REFERENCE)));
        assert.equal(stored.width, SCREEN.width);
        assert.equal(stored.height, SCREEN.height);
        let differing = 0;
        for (let y = 0; y < stored.height; y++)
        {
            for (let x = 0; x < stored.width; x++)
            {
                if (context.desktop.read(x, y) !== stored.pixels[y * stored.width + x])
                {
                    differing++;
                }
            }
        }
        assert.equal(differing, 0, 'every pixel is as stored');
        assert.equal(context.presents(), 4, 'one presentation per paint pass, four pumps');
    });

test('a click at the button\'s screen coordinates reaches the dialog as BN_CLICKED', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    const button = context.fns.GetDlgItem.handler([dialog, 3]);
    const at = context.centre(button);

    context.click(at.x, at.y);
    await context.pump(dialog);
    assert.deepEqual(context.commands(), [[3, BN_CLICKED, button]],
        'WM_COMMAND(BN_CLICKED, 3) with the button as lParam');
    assert.equal(context.fns.GetFocus.handler([]), button, 'the click took the focus');

    // Pressed and released outside is not a click.
    context.mouse(WM_LBUTTONDOWN, at.x, at.y);
    context.mouse(WM_LBUTTONUP, 1, 1);
    await context.pump(dialog);
    assert.equal(context.commands().length, 1);
});

test('a static passes the pointer through to the dialog unless it has SS_NOTIFY', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    const label = context.fns.GetDlgItem.handler([dialog, 100]);
    const at = context.centre(label);
    assert.equal(context.fns.WindowFromPoint.handler([at.x, at.y]), dialog);
    assert.equal(context.fns.SendMessageA.handler([label, WM_NCHITTEST, 0, 0]) | 0, HTTRANSPARENT);

    context.mouse(WM_LBUTTONDOWN, at.x, at.y);
    await context.pump(dialog);
    const down = context.dispatched.find(one=>one.message === WM_LBUTTONDOWN);
    assert.ok(down);
    assert.equal(down.hwnd, dialog, 'the dialog procedure saw the click, in its own coordinates');
    context.fns.ClientToScreen.handler([dialog, (()=>{
        context.memory.writeMemory(OUT, new Uint8Array(8));
        return OUT;
    })()]);
    assert.deepEqual([down.lParam & 0xffff, down.lParam >>> 16],
        [at.x - context.memory.u32(OUT), at.y - context.memory.u32(OUT + 4)],
        'client coordinates: relative to the client origin, inside the frame');

    const notifying = { ...WIZARD_PAGE, controls: WIZARD_PAGE.controls.map(control=>(
        control.id === 100 ? { ...control, style: control.style | SS_NOTIFY } : control)) };
    const second = setup();
    const other = await openDialog(second, notifying);
    const notifier = second.fns.GetDlgItem.handler([other, 100]);
    assert.equal(second.fns.WindowFromPoint.handler([at.x, at.y]), notifier);
    assert.equal(second.fns.SendMessageA.handler([notifier, WM_NCHITTEST, 0, 0]), HTCLIENT);
});

test('WM_INITDIALOG is sent during CreateDialogParam, after the controls exist', async()=>{
    // A program that creates a dialog and then reads a control its procedure
    // was to fill in is entitled to find it filled: the message is sent from
    // inside the call, not posted for a loop that has not run yet, and it comes
    // before a template's WS_VISIBLE shows the window.
    /** @type {{ lParam: number, controlExists: boolean, visible: number }[]} */
    const seen = [];
    const context = setup({
        reply: message=>{
            if (message.message === WM_INITDIALOG)
            {
                seen.push({
                    lParam: message.lParam,
                    controlExists: context.fns.GetDlgItem.handler([message.hwnd, 100]) !== 0,
                    visible: context.fns.IsWindowVisible.handler([message.hwnd]),
                });
            }
            return 0;
        },
    });
    putTemplate(context.memory, WIZARD_PAGE);
    const dialog = context.fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0xabcd]);
    assert.notEqual(dialog, 0);
    assert.deepEqual(seen, [{ lParam: 0xabcd, controlExists: true, visible: 0 }],
        'sent inside the call, after the controls, before the window is shown');

    await context.pump(dialog);
    assert.equal(context.fns.IsWindowVisible.handler([dialog]), 1,
        'and the template WS_VISIBLE shows it once initialisation is done');
});

test('Tab moves the focus between the tab stops, and Shift+Tab back', async()=>{
    const context = setup({ reply: message=>(message.message === WM_INITDIALOG ? 1 : 0) });
    const dialog = await openDialog(context);
    const next = context.fns.GetDlgItem.handler([dialog, 3]);
    const check = context.fns.GetDlgItem.handler([dialog, 101]);
    assert.equal(context.fns.GetFocus.handler([]), next,
        'TRUE from WM_INITDIALOG gives the first tab stop the focus');
    assert.equal(context.fns.GetNextDlgTabItem.handler([dialog, next, 0]), check);
    assert.equal(context.fns.GetNextDlgTabItem.handler([dialog, check, 0]), next, 'wrapping');

    context.key(WM_KEYDOWN, VK_TAB);
    await context.pump(dialog);
    assert.equal(context.fns.GetFocus.handler([]), check);

    context.keysDown.add(VK_SHIFT);
    context.key(WM_KEYDOWN, VK_TAB);
    await context.pump(dialog);
    assert.equal(context.fns.GetFocus.handler([]), next);
});

test('Enter fires the default button and Escape is IDCANCEL', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    const next = context.fns.GetDlgItem.handler([dialog, 3]);

    context.key(WM_KEYDOWN, VK_RETURN);
    await context.pump(dialog);
    assert.deepEqual(context.commands(), [[3, BN_CLICKED, next]]);

    context.key(WM_KEYDOWN, VK_ESCAPE);
    await context.pump(dialog);
    assert.deepEqual(context.commands().at(-1), [IDCANCEL, BN_CLICKED, 0],
        'no Cancel button, so lParam is nothing');

    // DM_SETDEFID moves Enter to another button.
    context.fns.SendMessageA.handler([dialog, DM_SETDEFID, 101, 0]);
    assert.equal(context.fns.SendMessageA.handler([dialog, DM_GETDEFID, 0, 0]) & 0xffff, 101);
    context.key(WM_KEYDOWN, VK_RETURN);
    await context.pump(dialog);
    assert.equal(context.commands().at(-1)?.[0], 101);
});

test('an auto check box toggles on a click and on Space, and answers BM_GETCHECK', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    const check = context.fns.GetDlgItem.handler([dialog, 101]);
    assert.equal(context.fns.SendDlgItemMessageA.handler([dialog, 101, BM_GETCHECK, 0, 0]), 0);

    const at = context.centre(check);
    context.click(at.x, at.y);
    await context.pump(dialog);
    assert.equal(context.fns.SendMessageA.handler([check, BM_GETCHECK, 0, 0]), 1);
    assert.deepEqual(context.commands(), [[101, BN_CLICKED, check]]);

    context.key(WM_KEYDOWN, VK_SPACE);
    context.key(WM_KEYUP, VK_SPACE);
    await context.pump(dialog);
    assert.equal(context.fns.SendMessageA.handler([check, BM_GETCHECK, 0, 0]), 0,
        'Space on the focused check box toggles it back');
});

test('auto radio buttons check one and clear the rest of their group', async()=>{
    const radios = { ...WIZARD_PAGE, controls: [
        { id: 200, className: 'Button', title: 'Full', x: 4, y: 4, cx: 40, cy: 10,
            style: WS_CHILD | WS_VISIBLE | WS_TABSTOP | 0x00020000 | BS_AUTORADIOBUTTON },
        { id: 201, className: 'Button', title: 'Compact', x: 4, y: 16, cx: 40, cy: 10,
            style: WS_CHILD | WS_VISIBLE | BS_AUTORADIOBUTTON },
        { id: 202, className: 'Button', title: 'Options', x: 4, y: 30, cx: 60, cy: 24,
            style: WS_CHILD | WS_VISIBLE | BS_GROUPBOX },
    ] };
    const context = setup();
    const dialog = await openDialog(context, radios);
    context.fns.CheckRadioButton.handler([dialog, 200, 201, 200]);
    assert.equal(context.fns.SendDlgItemMessageA.handler([dialog, 200, BM_GETCHECK, 0, 0]), 1);

    const at = context.centre(context.fns.GetDlgItem.handler([dialog, 201]));
    context.click(at.x, at.y);
    await context.pump(dialog);
    assert.equal(context.fns.SendDlgItemMessageA.handler([dialog, 201, BM_GETCHECK, 0, 0]), 1);
    assert.equal(context.fns.SendDlgItemMessageA.handler([dialog, 200, BM_GETCHECK, 0, 0]), 0,
        'the other radio button in the group was cleared');
});

test('an edit takes typing at its caret, selects, and tells its parent EN_CHANGE', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    context.memory.putString(TEXT, 'Edit');
    const edit = context.fns.CreateWindowExA.handler([WS_EX_CLIENTEDGE, TEXT, 0,
        WS_CHILD | WS_VISIBLE | WS_TABSTOP, 8, 60, 120, 20, dialog, 300, HINSTANCE, 0]);
    assert.notEqual(edit, 0);
    await context.fns.SetFocus.handler([edit]);
    await context.pump(dialog);

    for (const character of 'ab')
    {
        context.key(WM_CHAR, character.charCodeAt(0));
    }
    await context.pump(dialog);
    assert.equal(context.fns.GetWindowTextA.handler([edit, OUT, 16]), 2);
    assert.equal(context.memory.readCString(OUT, 16), 'ab');
    assert.deepEqual(context.commands().filter(([id, code])=>id === 300 && code === EN_CHANGE)
        .length, 2, 'once per change');

    // The caret moves, Shift extends the selection, and typing replaces it.
    context.key(WM_KEYDOWN, VK_LEFT);
    await context.pump(dialog);
    context.keysDown.add(VK_SHIFT);
    context.key(WM_KEYDOWN, VK_LEFT);
    await context.pump(dialog);
    context.keysDown.delete(VK_SHIFT);
    const selection = context.fns.SendMessageA.handler([edit, EM_GETSEL, 0, 0]);
    assert.deepEqual([selection & 0xffff, selection >>> 16], [0, 1]);
    context.key(WM_CHAR, 'X'.charCodeAt(0));
    await context.pump(dialog);
    assert.equal(context.fns.GetWindowTextA.handler([edit, OUT, 16]), 2);
    assert.equal(context.memory.readCString(OUT, 16), 'Xb');

    context.fns.SendMessageA.handler([edit, EM_SETSEL, 0, -1]);
    context.memory.putString(TEXT, 'replaced');
    context.fns.SendMessageA.handler([edit, EM_REPLACESEL, 0, TEXT]);
    context.fns.GetWindowTextA.handler([edit, OUT, 16]);
    assert.equal(context.memory.readCString(OUT, 16), 'replaced');

    context.fns.SendMessageA.handler([edit, EM_LIMITTEXT, 9, 0]);
    context.key(WM_CHAR, '!'.charCodeAt(0));
    context.key(WM_CHAR, '?'.charCodeAt(0));
    await context.pump(dialog);
    context.fns.GetWindowTextA.handler([edit, OUT, 16]);
    assert.equal(context.memory.readCString(OUT, 16), 'replaced!', 'the limit holds');

    context.fns.SetWindowLongA.handler([edit, -16, WS_CHILD | WS_VISIBLE | ES_READONLY]);
    context.key(WM_CHAR, 'z'.charCodeAt(0));
    await context.pump(dialog);
    context.fns.GetWindowTextA.handler([edit, OUT, 16]);
    assert.equal(context.memory.readCString(OUT, 16), 'replaced!', 'read-only takes nothing');
});

/**
 * A dialog that records the owner-draw messages its procedure is handed, the
 * DRAWITEMSTRUCT read while it is still there.
 */
async function ownerDrawDialog(){
    const WM_DRAWITEM = 0x002b;
    /** @type {any[]} */
    const seen = [];
    /** @type {any} */
    let context = null;
    context = setup({
        reply: message=>{
            if (message.message === WM_DRAWITEM)
            {
                const at = message.lParam;
                const [type, id, item, action, state, hwnd, hdc, left, top, right, bottom]
                    = Array.from({ length: 11 }, (_, index)=>context.memory.u32(at + index * 4));
                seen.push({ message: 'draw', wParam: message.wParam, type, id, item, action,
                    state, hwnd, hdc, rect: [left, top, right, bottom] });
            }
            else if (message.message >= 0x0133 && message.message <= 0x0138)
            {
                seen.push({ message: `ctlcolor 0x${message.message.toString(16)}` });
            }
            else if (message.message === WM_COMMAND)
            {
                seen.push({ message: 'command', code: message.wParam >>> 16 });
            }
            return 0;
        },
    });
    const dialog = await openDialog(context);
    seen.length = 0;
    return { context, dialog, seen };
}

test('an owner-drawn button is drawn by its parent, told what changed', async()=>{
    // user32's message tests: a BS_OWNERDRAW button asks WM_CTLCOLORBTN and
    // then hands WM_DRAWITEM to its parent -- ODA_DRAWENTIRE when it paints,
    // ODA_FOCUS with ODS_FOCUS when it takes the focus, ODA_SELECT with
    // ODS_SELECTED when BM_SETSTATE pushes it.
    const BS_OWNERDRAW = 0x000b;
    const BS_NOTIFY = 0x4000;
    const BM_SETSTATE = 0x00f3;
    const ODT_BUTTON = 4;
    const ODA_DRAWENTIRE = 1;
    const ODA_SELECT = 2;
    const ODA_FOCUS = 4;
    const ODS_SELECTED = 1;
    const ODS_FOCUS = 0x10;
    const BN_SETFOCUS = 6;
    const { context, dialog, seen } = await ownerDrawDialog();
    context.memory.putString(TEXT, 'Button');
    const button = context.fns.CreateWindowExA.handler([0, TEXT, 0,
        WS_CHILD | WS_VISIBLE | BS_OWNERDRAW | BS_NOTIFY, 150, 110, 50, 14, dialog, 0xe,
        HINSTANCE, 0]);
    await context.pump(dialog);
    assert.deepEqual(seen.map(one=>one.message), ['ctlcolor 0x135', 'draw']);
    const [, painted] = seen;
    assert.deepEqual([painted.wParam, painted.type, painted.id, painted.item, painted.action,
        painted.state, painted.hwnd], [0xe, ODT_BUTTON, 0xe, 0, ODA_DRAWENTIRE, 0, button]);
    assert.notEqual(painted.hdc, 0, 'a context to draw in');
    assert.deepEqual(painted.rect, [0, 0, 50, 14], 'the client area');

    seen.length = 0;
    await context.fns.SetFocus.handler([button]);
    assert.deepEqual(seen.map(one=>[one.message, one.action, one.state, one.code]), [
        ['ctlcolor 0x135', undefined, undefined, undefined],
        ['draw', ODA_FOCUS, ODS_FOCUS, undefined],
        ['command', undefined, undefined, BN_SETFOCUS],
    ]);

    seen.length = 0;
    await context.fns.SendMessageA.handler([button, BM_SETSTATE, 1, 0]);
    assert.deepEqual(seen.map(one=>[one.message, one.action, one.state]), [
        ['ctlcolor 0x135', undefined, undefined],
        ['draw', ODA_SELECT, ODS_SELECTED | ODS_FOCUS],
    ]);
});

test('an owner-drawn static is drawn by its parent', async()=>{
    // As documented for SS_OWNERDRAW: the parent draws it on WM_DRAWITEM,
    // having been asked WM_CTLCOLORSTATIC first.
    const SS_OWNERDRAW = 0x000d;
    const ODT_STATIC = 5;
    const ODA_DRAWENTIRE = 1;
    const { context, dialog, seen } = await ownerDrawDialog();
    context.memory.putString(TEXT, 'Static');
    const shown = context.fns.CreateWindowExA.handler([0, TEXT, 0,
        WS_CHILD | WS_VISIBLE | SS_OWNERDRAW, 150, 110, 40, 20, dialog, 7, HINSTANCE, 0]);
    await context.pump(dialog);
    assert.deepEqual(seen.map(one=>one.message), ['ctlcolor 0x138', 'draw']);
    assert.deepEqual([seen[1].wParam, seen[1].type, seen[1].id, seen[1].action, seen[1].state,
        seen[1].hwnd], [7, ODT_STATIC, 7, ODA_DRAWENTIRE, 0, shown]);
    assert.deepEqual(seen[1].rect, [0, 0, 40, 20]);
});

test('statics and check boxes write their text in the colour WM_CTLCOLORSTATIC set',
    async()=>{
        // As documented for WM_CTLCOLORSTATIC: the parent sets the text
        // colour on the device context it is handed, and the control draws
        // its text in it. A push button keeps the system colours, as
        // documented for WM_CTLCOLORBTN.
        const RED = 0x000000ff;
        /** @type {any} */
        let gdi = null;
        const context = setup({
            reply: message=>{
                if (message.message === WM_CTLCOLORSTATIC || message.message === 0x0135)
                {
                    gdi.table.SetTextColor.handler([message.wParam, RED]);
                }
                return 0;
            },
        });
        gdi = context.gdi;
        const dialog = await openDialog(context);
        /** @param {number} id @returns {Set<number>} the pixels in the control */
        const colours = id=>{
            context.fns.GetWindowRect.handler([context.fns.GetDlgItem.handler([dialog, id]), OUT]);
            const [left, top, right, bottom] = [0, 4, 8, 12]
                .map(at=>context.memory.u32(OUT + at));
            const seen = new Set();
            for (let y = top; y < bottom; y++)
            {
                for (let x = left; x < right; x++)
                {
                    seen.add(context.desktop.read(x, y));
                }
            }
            return seen;
        };
        const red = 0x00ff0000;
        assert.ok(colours(100).has(red), 'the static\'s text is red');
        assert.ok(!colours(100).has(0), 'and none of it is left black');
        assert.ok(colours(101).has(red), 'so is the check box\'s');
        assert.ok(!colours(3).has(red), 'a push button keeps its own');
    });

test('an edit copies, cuts, pastes and clears through the clipboard, and undoes a change',
    async()=>{
        // user32's edit tests: WM_PASTE inserts the clipboard's CF_TEXT, and a
        // single-line edit keeps only its first line. The rest as documented
        // for the edit control's clipboard messages and EM_CANUNDO.
        const WM_CUT = 0x0300;
        const WM_COPY = 0x0301;
        const WM_PASTE = 0x0302;
        const WM_CLEAR = 0x0303;
        const WM_UNDO = 0x0304;
        const EM_CANUNDO = 0x00c6;
        const EM_EMPTYUNDOBUFFER = 0x00cd;
        const EM_SETREADONLY = 0x00cf;
        const CF_TEXT = 1;
        const context = setup();
        const dialog = await openDialog(context);
        const { fns, memory } = context;
        memory.putString(TEXT, 'Edit');
        const edit = fns.CreateWindowExA.handler([WS_EX_CLIENTEDGE, TEXT, 0,
            WS_CHILD | WS_VISIBLE, 8, 110, 100, 20, dialog, 300, HINSTANCE, 0]);
        /** @param {number} message @param {number} [wParam] @param {number} [lParam] */
        const send = (message, wParam = 0, lParam = 0)=>
            fns.SendMessageA.handler([edit, message, wParam, lParam]);
        const text = ()=>{
            fns.GetWindowTextA.handler([edit, OUT, 64]);
            return memory.readCString(OUT, 64);
        };
        const clipboard = ()=>{
            fns.OpenClipboard.handler([0]);
            const handle = fns.GetClipboardData.handler([CF_TEXT]);
            fns.CloseClipboard.handler([]);
            return handle === 0 ? null : memory.readCString(handle, 64);
        };
        /** @param {string} value */
        const putClipboard = value=>{
            const at = memory.putString(TEXT + 0x100, value);
            fns.OpenClipboard.handler([0]);
            fns.EmptyClipboard.handler([]);
            fns.SetClipboardData.handler([CF_TEXT, at]);
            fns.CloseClipboard.handler([]);
        };
        memory.putString(TEXT, 'hello world');
        fns.SetWindowTextA.handler([edit, TEXT]);
        assert.equal(send(EM_CANUNDO), 0, 'nothing to undo after WM_SETTEXT');

        send(EM_SETSEL, 0, 5);
        send(WM_COPY);
        assert.equal(clipboard(), 'hello', 'the selection is on the clipboard');
        assert.equal(text(), 'hello world', 'and still in the edit');

        send(EM_SETSEL, 6, 11);
        send(WM_PASTE);
        assert.equal(text(), 'hello hello');
        assert.equal(send(EM_CANUNDO), 1);
        send(WM_UNDO);
        assert.equal(text(), 'hello world', 'the paste undone');

        send(EM_SETSEL, 0, 6);
        send(WM_CUT);
        assert.equal(text(), 'world');
        assert.equal(clipboard(), 'hello ');
        send(EM_SETSEL, 0, 2);
        send(WM_CLEAR);
        assert.equal(text(), 'rld');
        send(EM_EMPTYUNDOBUFFER);
        assert.equal(send(EM_CANUNDO), 0);

        putClipboard('first line\r\nsecond line');
        send(EM_SETSEL, 0, -1);
        send(WM_PASTE);
        assert.equal(text(), 'first line', 'a single-line edit keeps the first line');

        send(EM_SETREADONLY, 1);
        send(EM_SETSEL, 0, 5);
        send(WM_CUT);
        send(WM_CLEAR);
        send(WM_PASTE);
        assert.equal(text(), 'first line', 'read-only: nothing taken out or put in');
        send(WM_COPY);
        assert.equal(clipboard(), 'first', 'but copying still works');
    });

test('typing inside a modal loop reaches the edit with the focus, translated', async()=>{
    // DialogBox pumps for the program, so it translates for the program too:
    // a key press left alone by the dialog manager becomes the character an
    // edit types. The dialog procedure gives the focus to the first tab
    // stop, the edit, and ends the dialog once two characters have landed.
    let typed = '';
    const context = setup({ reply: message=>{
        if (message.message === WM_INITDIALOG)
        {
            return 1;
        }
        if (message.message === WM_COMMAND && (message.wParam >>> 16) === EN_SETFOCUS)
        {
            for (const code of [0x49, 0x4c])
            {
                context.key(WM_KEYDOWN, code);
                context.key(WM_KEYUP, code);
            }
        }
        if (message.message === WM_COMMAND && (message.wParam >>> 16) === EN_CHANGE
            && context.fns.GetWindowTextA.handler([message.lParam, OUT, 16]) === 2)
        {
            typed = context.memory.readCString(OUT, 16);
            context.fns.EndDialog.handler([message.hwnd, 5]);
        }
        return 0;
    } });
    putTemplate(context.memory, {
        ...WIZARD_PAGE,
        controls: [
            { id: 300, className: 'Edit', title: '', x: 4, y: 4, cx: 60, cy: 10,
                style: WS_CHILD | WS_VISIBLE | WS_TABSTOP },
            ...WIZARD_PAGE.controls,
        ],
    });
    assert.equal(await context.fns.DialogBoxIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]), 5);
    assert.equal(typed, 'il');
});

test('an edit places its caret and selection where the drawn text ends', async()=>{
    // Measured, not gridded: with a proportional face the grid puts the
    // caret past narrow characters and short of wide ones.
    const context = setup({ engine: true });
    const dialog = await openDialog(context);
    context.memory.putString(TEXT, 'Edit');
    // Clear of the page's own controls, which are stacked above a control
    // made after them and would take the clicks below.
    const edit = context.fns.CreateWindowExA.handler([WS_EX_CLIENTEDGE, TEXT, 0,
        WS_CHILD | WS_VISIBLE | WS_TABSTOP, 8, 110, 100, 20, dialog, 300, HINSTANCE, 0]);
    assert.notEqual(edit, 0);
    await context.fns.SetFocus.handler([edit]);
    for (const character of 'il')
    {
        context.key(WM_CHAR, character.charCodeAt(0));
    }
    await context.pump(dialog);

    // The client area's corner on the screen: inside the client edge.
    context.memory.writeMemory(OUT, new Uint8Array(8));
    context.fns.ClientToScreen.handler([edit, OUT]);
    const left = context.memory.u32(OUT);
    const top = context.memory.u32(OUT + 4);
    context.fns.GetClientRect.handler([edit, OUT]);
    const y = top + Math.floor(context.memory.u32(OUT + 12) / 2);
    // The system font here averages 8 across; 'i' and 'l' are a pixel
    // narrower each, so the text ends 14 in from the margin, where a grid
    // of the widest character would have said 18.
    const ink = 0x00000000;
    const paper = 0x00ffffff;
    const width = textWidth('il', 8);
    assert.equal(width, 14);
    assert.equal(context.desktop.read(left + 1 + width, y), ink, 'the caret, where the text ends');
    assert.equal(context.desktop.read(left + 1 + 18, y), paper, 'and not on the grid');

    // A click just past the second character lands the caret after it, and
    // one between the two lands before the second.
    context.click(left + 1 + width + 1, y);
    await context.pump(dialog);
    assert.equal(context.fns.SendMessageA.handler([edit, EM_GETSEL, 0, 0]) & 0xffff, 2);
    context.click(left + 1 + textWidth('i', 8) + 1, y);
    await context.pump(dialog);
    assert.equal(context.fns.SendMessageA.handler([edit, EM_GETSEL, 0, 0]) & 0xffff, 1);

    // Shift+End selects to the end, and the highlight ends with the text.
    context.keysDown.add(VK_SHIFT);
    context.key(WM_KEYDOWN, 0x23);
    await context.pump(dialog);
    context.keysDown.delete(VK_SHIFT);
    const highlight = 0x00000080;
    assert.equal(context.desktop.read(left + 1 + width - 1, y), highlight);
    assert.equal(context.desktop.read(left + 1 + width, y), ink, 'the caret at its end');
    assert.equal(context.desktop.read(left + 1 + width + 1, y), paper);
});

test('a read-only multi-line edit breaks its text into lines and scrolls by pages', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    context.memory.putString(TEXT, 'Edit');
    const edit = context.fns.CreateWindowExA.handler([WS_EX_CLIENTEDGE, TEXT, 0,
        WS_CHILD | WS_VISIBLE | WS_VSCROLL | ES_MULTILINE | ES_READONLY,
        8, 60, 200, 40, dialog, 301, HINSTANCE, 0]);
    const licence = Array.from({ length: 12 }, (_, index)=>`Clause ${index + 1} of the licence`)
        .join('\r\n');
    context.memory.putString(TEXT, licence);
    context.fns.SetWindowTextA.handler([edit, TEXT]);
    await context.pump(dialog);
    assert.equal(context.fns.SendMessageA.handler([edit, EM_GETLINECOUNT, 0, 0]), 12);
    assert.equal(context.fns.SendMessageA.handler([edit, EM_GETFIRSTVISIBLELINE, 0, 0]), 0);

    await context.fns.SetFocus.handler([edit]);
    context.key(WM_KEYDOWN, VK_NEXT);
    await context.pump(dialog);
    assert.ok(context.fns.SendMessageA.handler([edit, EM_GETFIRSTVISIBLELINE, 0, 0]) > 0,
        'Page Down scrolled');
    context.fns.SendMessageA.handler([edit, WM_VSCROLL, 6, 0]);
    assert.equal(context.fns.SendMessageA.handler([edit, EM_GETFIRSTVISIBLELINE, 0, 0]), 0,
        'SB_TOP goes back to the top');
});

test('a list box keeps its items and a click selects one with LBN_SELCHANGE', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    context.memory.putString(TEXT, 'ListBox');
    const list = context.fns.CreateWindowExA.handler([0, TEXT, 0,
        WS_CHILD | WS_VISIBLE | LBS_NOTIFY, 8, 60, 100, 60, dialog, 400, HINSTANCE, 0]);
    for (const item of ['Alpha', 'Beta', 'Gamma'])
    {
        context.memory.putString(TEXT, item);
        context.fns.SendMessageA.handler([list, LB_ADDSTRING, 0, TEXT]);
    }
    assert.equal(context.fns.SendMessageA.handler([list, LB_GETCOUNT, 0, 0]), 3);
    assert.equal(context.fns.SendMessageA.handler([list, LB_GETCURSEL, 0, 0]), -1);
    assert.equal(context.fns.SendMessageA.handler([list, LB_SETCURSEL, 2, 0]), 2);
    assert.equal(context.fns.SendMessageA.handler([list, LB_GETTEXTLEN, 2, 0]), 5);
    assert.equal(context.fns.SendMessageA.handler([list, LB_GETTEXT, 2, OUT]), 5);
    assert.equal(context.memory.readCString(OUT, 16), 'Gamma');
    await context.pump(dialog);

    // A click in the second row.
    context.fns.GetWindowRect.handler([list, OUT]);
    const left = context.memory.u32(OUT);
    const top = context.memory.u32(OUT + 4);
    const rowHeight = context.gdi.draw.measure(context.gdi.windowContext(list, null), 'M').height;
    context.click(left + 10, top + rowHeight + Math.floor(rowHeight / 2));
    await context.pump(dialog);
    assert.equal(context.fns.SendMessageA.handler([list, LB_GETCURSEL, 0, 0]), 1);
    assert.deepEqual(context.commands().filter(([id, code])=>id === 400 && code === LBN_SELCHANGE),
        [[400, LBN_SELCHANGE, list]]);
});

test('a combo box shows its selection and the arrow keys change it with CBN_SELCHANGE',
    async()=>{
        const context = setup();
        const dialog = await openDialog(context);
        context.memory.putString(TEXT, 'ComboBox');
        const combo = context.fns.CreateWindowExA.handler([0, TEXT, 0,
            WS_CHILD | WS_VISIBLE | 0x0003, 8, 60, 100, 60, dialog, 500, HINSTANCE, 0]);
        for (const item of ['One', 'Two'])
        {
            context.memory.putString(TEXT, item);
            context.fns.SendMessageA.handler([combo, CB_ADDSTRING, 0, TEXT]);
        }
        assert.equal(context.fns.SendMessageA.handler([combo, CB_GETCOUNT, 0, 0]), 2);
        assert.equal(context.fns.SendMessageA.handler([combo, CB_SETCURSEL, 0, 0]), 0);
        assert.equal(context.fns.SendMessageA.handler([combo, CB_GETLBTEXT, 0, OUT]), 3);
        assert.equal(context.memory.readCString(OUT, 16), 'One');
        assert.equal(context.fns.GetWindowTextA.handler([combo, OUT, 16]), 3);

        await context.fns.SetFocus.handler([combo]);
        context.key(WM_KEYDOWN, VK_DOWN);
        await context.pump(dialog);
        assert.equal(context.fns.SendMessageA.handler([combo, CB_GETCURSEL, 0, 0]), 1);
        assert.deepEqual(context.commands().filter(([id, code])=>id === 500
            && code === CBN_SELCHANGE), [[500, CBN_SELCHANGE, combo]]);
    });

test('an editable combo box field takes typing and answers the edit selection', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    context.memory.putString(TEXT, 'ComboBox');
    const CBS_DROPDOWN = 0x0002;
    const combo = context.fns.CreateWindowExA.handler([0, TEXT, 0,
        WS_CHILD | WS_VISIBLE | CBS_DROPDOWN, 8, 60, 100, 60, dialog, 500, HINSTANCE, 0]);
    context.memory.putString(TEXT, 'C:\\Program Files\\Game');
    context.fns.SetWindowTextA.handler([combo, TEXT]);
    await context.fns.SetFocus.handler([combo]);
    await context.pump(dialog);

    // The field is what a program reads back: select it whole and type the
    // replacement, as a person driving the dialog would.
    assert.equal(context.fns.SendMessageA.handler([combo, CB_SETEDITSEL, 0, -1]), 1);
    for (const character of 'C:\\App')
    {
        context.key(WM_CHAR, character.charCodeAt(0));
    }
    await context.pump(dialog);
    assert.equal(context.fns.GetWindowTextA.handler([combo, OUT, 16]), 6);
    assert.equal(context.memory.readCString(OUT, 16), 'C:\\App');
    const notices = context.commands().filter(([id])=>id === 500).map(([, code])=>code);
    assert.ok(notices.includes(CBN_EDITUPDATE) && notices.includes(CBN_EDITCHANGE),
        'the parent hears the field edited, with the combo box codes');

    // The caret sits past what was typed, a backspace deletes behind it, and
    // the selection reads back through the pointers a program hands over.
    context.key(WM_CHAR, 0x08);
    await context.pump(dialog);
    context.fns.GetWindowTextA.handler([combo, OUT, 16]);
    assert.equal(context.memory.readCString(OUT, 16), 'C:\\Ap');
    assert.equal(context.fns.SendMessageA.handler([combo, CB_GETEDITSEL, OUT, OUT + 4]), 1);
    assert.deepEqual([context.memory.u32(OUT), context.memory.u32(OUT + 4)], [5, 5]);

    // A limit the program sets holds, as an edit's does, and a character the
    // limit refuses makes no change at all.
    context.fns.SendMessageA.handler([combo, CB_LIMITTEXT, 6, 0]);
    context.key(WM_CHAR, 'p'.charCodeAt(0));
    context.key(WM_CHAR, '!'.charCodeAt(0));
    await context.pump(dialog);
    context.fns.GetWindowTextA.handler([combo, OUT, 16]);
    assert.equal(context.memory.readCString(OUT, 16), 'C:\\App', 'the limit holds');
});

test('a dropdown list takes no typed text', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    context.memory.putString(TEXT, 'ComboBox');
    const CBS_DROPDOWNLIST = 0x0003;
    const combo = context.fns.CreateWindowExA.handler([0, TEXT, 0,
        WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 8, 60, 100, 60, dialog, 500, HINSTANCE, 0]);
    context.memory.putString(TEXT, 'One');
    context.fns.SendMessageA.handler([combo, CB_ADDSTRING, 0, TEXT]);
    context.fns.SendMessageA.handler([combo, CB_SETCURSEL, 0, 0]);
    await context.fns.SetFocus.handler([combo]);
    await context.pump(dialog);
    context.key(WM_CHAR, 'X'.charCodeAt(0));
    await context.pump(dialog);
    assert.equal(context.fns.GetWindowTextA.handler([combo, OUT, 16]), 3);
    assert.equal(context.memory.readCString(OUT, 16), 'One', 'the field shows the selection');
});

test('a scroll bar keeps its range and position, and a click on an arrow asks its parent',
    async()=>{
        const context = setup();
        const dialog = await openDialog(context);
        context.memory.putString(TEXT, 'ScrollBar');
        // Short of the Next button, which is stacked above a control made
        // after it and would take the click on the lower arrow.
        const bar = context.fns.CreateWindowExA.handler([0, TEXT, 0,
            WS_CHILD | WS_VISIBLE | SBS_VERT, 180, 4, 16, 70, dialog, 600, HINSTANCE, 0]);
        context.fns.SendMessageA.handler([bar, SBM_SETRANGE, 0, 50]);
        assert.equal(context.fns.SendMessageA.handler([bar, SBM_SETPOS, 70, 1]), 0,
            'the previous position');
        assert.equal(context.fns.SendMessageA.handler([bar, SBM_GETPOS, 0, 0]), 50,
            'clamped to the range');
        await context.pump(dialog);

        context.fns.GetWindowRect.handler([bar, OUT]);
        context.click(context.memory.u32(OUT) + 8, context.memory.u32(OUT + 12) - 4);
        await context.pump(dialog);
        const scrolled = context.dispatched.find(one=>one.message === WM_VSCROLL);
        assert.deepEqual([scrolled?.hwnd, scrolled?.wParam, scrolled?.lParam],
            [dialog, SB_LINEDOWN, bar], 'WM_VSCROLL(SB_LINEDOWN) with the bar as lParam');
    });

test('a system class has a procedure address a program can subclass and call through',
    async()=>{
        const context = setup();
        const dialog = await openDialog(context);
        const check = context.fns.GetDlgItem.handler([dialog, 101]);
        const next = context.fns.GetDlgItem.handler([dialog, 3]);
        const address = context.fns.GetWindowLongA.handler([check, GWL_WNDPROC]);
        assert.notEqual(address, 0);
        assert.equal(context.fns.GetWindowLongA.handler([next, GWL_WNDPROC]), address,
            'one address per class');
        assert.notEqual(context.fns.GetWindowLongA.handler([dialog, GWL_WNDPROC]), address);

        // Subclassed: messages reach the program's procedure, which reaches
        // the class's through CallWindowProc with the address it was given.
        assert.equal(context.fns.SetWindowLongA.handler([check, GWL_WNDPROC, GUEST_PROC]), address);
        context.fns.SendMessageA.handler([check, BM_SETCHECK, 1, 0]);
        assert.equal(context.dispatched.at(-1)?.wndProc, GUEST_PROC);
        assert.equal(context.fns.SendMessageA.handler([check, BM_GETCHECK, 0, 0]), 0,
            'the guest procedure answered, not the class');
        assert.equal(context.fns.CallWindowProcA.handler([address, check, BM_SETCHECK, 1, 0]), 0);
        assert.equal(context.fns.CallWindowProcA.handler([address, check, BM_GETCHECK, 0, 0]), 1,
            'the class procedure keeps the state');
    });

test('a click on the caption\'s close box asks the dialog to close, which is Cancel', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    context.fns.GetWindowRect.handler([dialog, OUT]);
    const right = context.memory.u32(OUT + 8);
    const top = context.memory.u32(OUT + 4);
    context.click(right - 8, top + 10);
    await context.pump(dialog);
    const closing = context.dispatched.filter(one=>one.wndProc === DIALOGPROC
        && (one.message === WM_NCLBUTTONDOWN || one.message === WM_CLOSE));
    assert.deepEqual(closing.map(one=>one.message), [WM_NCLBUTTONDOWN, WM_CLOSE]);
    assert.deepEqual(context.commands().at(-1), [IDCANCEL, BN_CLICKED, 0]);
});

test('a template that sets a font lays the dialog out in it and hands it to every control',
    async()=>{
        // The system font here is 16 high, so its cell is 8 by 18; eight
        // points is 11 pixels, a cell of 6 by 13. A dialog set in it is laid
        // out three quarters as wide and its controls paint in it.
        const context = setup({ engine: true });
        const dialog = await openDialog(context, {
            ...WIZARD_PAGE,
            style: WIZARD_PAGE.style | DS_SETFONT,
            font: { pointSize: 8, face: 'MS Sans Serif' },
        });
        const button = context.fns.GetDlgItem.handler([dialog, 3]);
        const font = context.fns.SendMessageA.handler([button, WM_GETFONT, 0, 0]);
        assert.notEqual(font, 0, 'the button was given a font');
        assert.equal(context.fns.SendMessageA.handler([dialog, WM_GETFONT, 0, 0]), font,
            'the dialog answers with the same one');
        assert.equal(context.fns.SendMessageA.handler(
            [context.fns.GetDlgItem.handler([dialog, 100]), WM_GETFONT, 0, 0]), font);
        assert.deepEqual(context.gdi.draw.fontUnits(font), { width: 6, height: 13 });
        assert.equal(context.faces.at(-1), 'MS Sans Serif', 'the face the template named');

        // Forty units across and fourteen down, in that cell rather than
        // the system font's 80 by 32.
        context.fns.GetWindowRect.handler([button, OUT]);
        assert.equal(context.memory.u32(OUT + 8) - context.memory.u32(OUT), 60);
        assert.equal(context.memory.u32(OUT + 12) - context.memory.u32(OUT + 4), 23);
        context.memory.writeMemory(OUT, new Uint8Array(16));
        context.memory.bytes[OUT + 8] = 4;
        context.memory.bytes[OUT + 12] = 8;
        assert.equal(context.fns.MapDialogRect.handler([dialog, OUT]), 1);
        assert.deepEqual([context.memory.u32(OUT + 8), context.memory.u32(OUT + 12)], [6, 13],
            'MapDialogRect scales by the dialog\'s own font');
        assert.equal(context.fns.GetDialogBaseUnits.handler([]), (18 << 16) | 8,
            'while the base units stay the system font\'s');

        // The font is the dialog's, and goes with it.
        context.fns.DestroyWindow.handler([dialog]);
        assert.equal(context.gdi.draw.fontUnits(font), null);
    });

test('a window context draws on the desktop at the client origin and no further', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    const label = context.fns.GetDlgItem.handler([dialog, 100]);
    const hdc = context.fns.GetDC.handler([label]);
    assert.notEqual(hdc, 0);
    const RECT = OUT + 32;
    [-5, -5, 1000, 1000].forEach((value, index)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value, true);
        context.memory.writeMemory(RECT + index * 4, bytes);
    });
    // COLOR_HIGHLIGHT plus one: a brush named as a system colour.
    assert.equal(context.fns.FillRect.handler([hdc, RECT, 14]), 1);
    context.fns.ReleaseDC.handler([label, hdc]);
    context.fns.GetWindowRect.handler([label, OUT]);
    const left = context.memory.u32(OUT);
    const top = context.memory.u32(OUT + 4);
    const right = context.memory.u32(OUT + 8);
    assert.equal(context.desktop.read(left, top), 0x00000080, 'inside: the highlight, as a pixel');
    assert.equal(context.desktop.read(right, top), 0x00c0c0c0, 'outside: the dialog face');
    assert.equal(context.desktop.read(left - 1, top), 0x00c0c0c0);
    assert.equal(context.presents(), 1, 'nothing shown until the next pump');
    context.fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, 0]);
    assert.equal(context.presents(), 2, 'the pump found nothing to paint and showed the desktop');
});

test('a program\'s own class is told to erase with its background brush and to paint',
    async()=>{
        // The default procedure fills with the class brush -- a system colour
        // plus one -- and the frame goes out through WM_NCPAINT: a program that
        // paints nothing itself still gets a window that looks like one.
        const context = setup({ reply: message=>context.fns.DefWindowProcA.handler(
            [message.hwnd, message.message, message.wParam, message.lParam]) });
        context.memory.putString(TEXT, 'Frame');
        const CLASS = OUT + 64;
        [0, GUEST_PROC, 0, 0, HINSTANCE, 0, 0, 5 + 1, 0, TEXT].forEach((value, index)=>{
            const bytes = new Uint8Array(4);
            new DataView(bytes.buffer).setUint32(0, value, true);
            context.memory.writeMemory(CLASS + index * 4, bytes);
        });
        assert.notEqual(context.fns.RegisterClassA.handler([CLASS]), 0);
        const hwnd = await context.fns.CreateWindowExA.handler([0, TEXT, TEXT,
            WS_POPUP | WS_CAPTION | WS_VISIBLE, 20, 30, 100, 60, 0, 0, HINSTANCE, 0]);
        assert.notEqual(hwnd, 0);
        await context.pump();
        const seen = context.dispatched.map(one=>one.message);
        assert.ok(seen.includes(WM_CREATE) && seen.includes(WM_PAINT), 'created and painted');
        assert.equal(context.desktop.read(60, 53), 0x00ffffff, 'COLOR_WINDOW inside the client');
        assert.equal(context.desktop.read(60, 38), 0x00000080, 'the active caption above it');
        assert.equal(context.desktop.read(20, 30), 0x00ffffff, 'the frame\'s highlight corner');
        assert.equal(context.desktop.read(10, 10), 0x00808080, 'the desktop around it');

        // A WM_CTLCOLORSTATIC the program leaves to the default answers a brush.
        assert.notEqual(context.fns.DefWindowProcA.handler([hwnd, WM_CTLCOLORSTATIC, 0, 0]), 0);
    });

test('ChildWindowFromPoint finds the child at a point in the parent\'s client area', async()=>{
    const context = setup();
    const dialog = await openDialog(context);
    const next = context.fns.GetDlgItem.handler([dialog, 3]);
    const at = context.centre(next);
    context.fns.ScreenToClient.handler([dialog, (()=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setInt32(0, at.x, true);
        new DataView(bytes.buffer).setInt32(4, at.y, true);
        context.memory.writeMemory(OUT, bytes);
        return OUT;
    })()]);
    const x = context.memory.u32(OUT) | 0;
    const y = context.memory.u32(OUT + 4) | 0;
    assert.equal(context.fns.ChildWindowFromPoint.handler([dialog, x, y]), next);
    assert.equal(context.fns.ChildWindowFromPoint.handler([dialog, 1, 1]), dialog,
        'the parent itself where no child is');
});

test('an unread message for a hidden window paints nothing and the desktop stays', async()=>{
    // GetClientRect is the window less its frame; MoveWindow repaints what
    // it uncovers and what it now covers.
    const context = setup();
    const dialog = await openDialog(context);
    context.fns.GetClientRect.handler([dialog, OUT]);
    assert.deepEqual([context.memory.u32(OUT + 8), context.memory.u32(OUT + 12)], [200, 120],
        'the template\'s size in pixels');
    context.fns.GetWindowRect.handler([dialog, OUT]);
    assert.deepEqual([context.memory.u32(OUT + 8) - context.memory.u32(OUT),
        context.memory.u32(OUT + 12) - context.memory.u32(OUT + 4)], [206, 145],
    'plus the three-pixel dialog frame each side and the caption');
    const presentedBefore = context.presents();
    context.fns.MoveWindow.handler([dialog, 30, 10, 206, 145, 1]);
    await context.pump(dialog);
    assert.ok(context.presents() > presentedBefore, 'moving repainted and showed the desktop');
    assert.equal(context.desktop.read(8, 8), 0x00808080, 'the desktop shows where it was');
    assert.equal(context.desktop.read(181, 130), 0x00c0c0c0, 'the dialog face where it is now');
    assert.deepEqual(context.fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 0);
    void MSG;
});
