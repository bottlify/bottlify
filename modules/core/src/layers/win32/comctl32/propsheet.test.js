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
import { createComctlFunctions } from './functions.js';
import {
    PSP, PSP_USETITLE, PSP_USECALLBACK, PSP_PREMATURE, PSPCB_ADDREF, PSPCB_RELEASE,
    PSPCB_CREATE, PSH, PSH_MODELESS, PSH_USECALLBACK, PSH_PROPSHEETPAGE, PSH_WIZARD,
    PSH_NOAPPLYNOW, PSCB_INITIALIZED, PSCB_PRECREATE,
    PSN_SETACTIVE, PSN_KILLACTIVE, PSN_APPLY, PSN_RESET, PSN_QUERYCANCEL,
    PSN_QUERYINITIALFOCUS, PSN_WIZNEXT, PSN_WIZBACK,
    PSM_SETCURSEL, PSM_REMOVEPAGE, PSM_ADDPAGE, PSM_CHANGED, PSM_UNCHANGED, PSM_QUERYSIBLINGS,
    PSM_PRESSBUTTON, PSM_GETTABCONTROL, PSM_GETCURRENTPAGEHWND, PSM_INSERTPAGE,
    PSM_HWNDTOINDEX, PSM_INDEXTOHWND, PSM_PAGETOINDEX, PSM_INDEXTOPAGE, PSM_IDTOINDEX,
    PSM_INDEXTOID, PSM_ISDIALOGMESSAGE, PSBTN_NEXT, PSBTN_BACK, PSBTN_OK, PSBTN_CANCEL,
    PSBTN_APPLYNOW,
    IDOK, IDCANCEL, IDHELP, IDC_APPLY_BUTTON, IDC_NEXT_BUTTON, IDC_BACK_BUTTON,
} from './propsheet.js';

/**
 * The window manager over the real drawing engine with the common controls
 * registered, comctl32 built on its exports, and a program made of
 * procedures on this side: the dispatcher runs whichever one an address
 * names, as the bridge runs the program's. The expectations are those of
 * Wine's comctl32 property sheet tests, which run the same calls against
 * Windows.
 */

const MSG_BUFFER = 0x13000;
const STRINGS = 0x14000;
const PAGES = 0x15000;
const HEADER = 0x16000;
const HANDLES = 0x16100;
const HEAP = 0x20000;
const MODULE = 0x60000;
const HINSTANCE = 0x400000;
const PROCEDURES = 0x700000;
const THREAD = { name: 'main' };

const SCREEN = { width: 1024, height: 768, bitsPerPixel: 32 };

const WM_NCDESTROY = 0x0082;
const WM_INITDIALOG = 0x0110;
const WM_NOTIFY = 0x004e;
const WM_LBUTTONDOWN = 0x0201;
const WM_KEYDOWN = 0x0100;
const VK_TAB = 0x09;
const VK_SHIFT = 0x10;
const VK_CONTROL = 0x11;
const VK_PRIOR = 0x21;
const VK_NEXT = 0x22;
const WM_QUIT = 0x0012;
const DM_GETDEFID = 0x0400;
const DC_HASDEFID = 0x534b;
const DWLP_MSGRESULT = 0;
const GWL_STYLE = -16;
const PM_REMOVE = 1;
const TCM_GETITEMCOUNT = 0x1304;
const TCM_GETITEMRECT = 0x130a;
const TCM_GETCURSEL = 0x130b;

const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;
const WS_CLIPSIBLINGS = 0x04000000;
const WS_CAPTION = 0x00c00000;
const WS_SYSMENU = 0x00080000;
const WS_TABSTOP = 0x00010000;
const DS_3DLOOK = 0x0004;
const DS_SETFONT = 0x0040;
const DS_MODALFRAME = 0x0080;
const DS_CONTEXTHELP = 0x2000;
const ES_MULTILINE = 0x0004;

const EDIT = 0x81;
const STATIC = 0x82;
const IDC_PS_EDIT1 = 1000;
const IDC_PS_EDIT2 = 1001;

/** Page templates by resource id, as Wine's tests name theirs. */
const IDD_PROP_PAGE_INTRO = 100;
const IDD_PROP_PAGE_EDIT = 101;
const IDD_PROP_PAGE_EXIT = 102;

function fakeMemory(size = 0x80000){
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

/**
 * A dialog template in the old layout, as a resource compiler writes one.
 *
 * @param {{ style: number, cx: number, cy: number, title?: string,
 *     controls?: { atom: number, id: number, style: number, x: number, y: number,
 *         cx: number, cy: number }[] }} shape
 */
function dialogTemplate(shape){
    /** @type {number[]} */
    const words = [];
    const word = (/** @type {number} */ value)=>words.push(value & 0xffff);
    const dword = (/** @type {number} */ value)=>{
        word(value);
        word(value >>> 16);
    };
    const text = (/** @type {string} */ value)=>{
        [...value].forEach(unit=>word(unit.charCodeAt(0)));
        word(0);
    };
    const controls = shape.controls ?? [];
    dword((shape.style | DS_SETFONT) >>> 0);
    dword(0);
    word(controls.length);
    [0, 0, shape.cx, shape.cy].forEach(value=>word(value));
    word(0);
    word(0);
    text(shape.title ?? '');
    word(8);
    text('MS Shell Dlg');
    for (const control of controls)
    {
        if (words.length % 2 !== 0)
        {
            word(0);
        }
        dword((WS_CHILD | WS_VISIBLE | control.style) >>> 0);
        dword(0);
        [control.x, control.y, control.cx, control.cy, control.id].forEach(value=>word(value));
        word(0xffff);
        word(control.atom);
        word(0);
        word(0);
    }
    const bytes = new Uint8Array(words.length * 2);
    words.forEach((value, index)=>{
        bytes[index * 2] = value & 0xff;
        bytes[index * 2 + 1] = value >>> 8;
    });
    return bytes;
}

const PAGE_STYLE = WS_POPUP | WS_CAPTION | WS_CLIPSIBLINGS | WS_VISIBLE;

/** The templates the pages below are made from, by resource id. */
const TEMPLATES = new Map([
    [IDD_PROP_PAGE_INTRO, dialogTemplate({ style: PAGE_STYLE, cx: 227, cy: 215,
        title: 'Edit Control Page',
        controls: [{ atom: STATIC, id: 0xffff, style: 0, x: 10, y: 6, cx: 100, cy: 8 }] })],
    [IDD_PROP_PAGE_EDIT, dialogTemplate({ style: PAGE_STYLE, cx: 227, cy: 215,
        title: 'Edit Control Page',
        controls: [
            { atom: EDIT, id: IDC_PS_EDIT1, style: WS_TABSTOP | ES_MULTILINE,
                x: 5, y: 5, cx: 150, cy: 140 },
            { atom: EDIT, id: IDC_PS_EDIT2, style: WS_TABSTOP | ES_MULTILINE,
                x: 5, y: 160, cx: 150, cy: 28 },
        ] })],
    [IDD_PROP_PAGE_EXIT, dialogTemplate({ style: PAGE_STYLE, cx: 227, cy: 215,
        title: 'Exit Page',
        controls: [{ atom: STATIC, id: 0xffff, style: 0, x: 10, y: 6, cx: 170, cy: 8 }] })],
]);

/**
 * @typedef {(args: number[]) => number | Promise<number>} Procedure
 */

function setup({ modal = false } = {}){
    const memory = fakeMemory();
    const handles = fakeHandles();
    const queue = createMessageQueue();
    const desktop = createSurface({ width: SCREEN.width, height: SCREEN.height });
    /** Every procedure and callback the program has, by address. @type {Map<number, Procedure>} */
    const procedures = new Map();
    let nextProcedure = PROCEDURES;
    let heapNext = HEAP;
    let stringNext = STRINGS;
    /** The keys held down, as GetKeyState reads them. @type {Set<number>} */
    const keysDown = new Set();
    /** @param {number} bytes */
    const allocate = bytes=>{
        const at = heapNext;
        heapNext += (bytes + 15) & ~15;
        return at;
    };
    /** Where each template sits in the module, by resource id. @type {Map<number, number>} */
    const resources = new Map();
    let at = MODULE + 0x100;
    for (const [id, bytes] of TEMPLATES)
    {
        memory.writeMemory(at, bytes);
        resources.set(id, at - MODULE);
        at += (bytes.length + 15) & ~15;
    }

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
            const procedure = procedures.get(wndProc >>> 0);
            if (procedure)
            {
                return procedure([message.hwnd, message.message, message.wParam,
                    message.lParam]);
            }
            return table.DefWindowProcA.handler(
                [message.hwnd, message.message, message.wParam, message.lParam]);
        },
        callerThread: ()=>THREAD,
        park: ()=>({ parked: true }),
        idle: modal ? ()=>new Promise(resolve=>setImmediate(resolve)) : ()=>new Promise(()=>{}),
        keyState: key=>(keysDown.has(key) ? 0x8000 : 0),
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

    const functions = createComctlFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        user32: name=>table[name],
        allocate,
        release: ()=>{},
        call: (entry, args)=>{
            const procedure = procedures.get(entry >>> 0);
            if (!procedure)
            {
                throw new Error(`no callback at 0x${entry.toString(16)}`);
            }
            return procedure(args);
        },
        callerThread: ()=>THREAD,
        procedure: (name, handler)=>register(handler),
        findResource: (instance, type, name)=>{
            const rva = type === 5 && instance === HINSTANCE && typeof name === 'number'
                ? resources.get(name) : undefined;
            return rva === undefined ? null : { rva };
        },
        moduleBase: instance=>(instance === HINSTANCE ? MODULE : 0),
        loadString: ()=>null,
    });
    const comctl = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => any }>} */ (/** @type {unknown} */ (functions));

    /** A procedure of the program's, at an address of its own. @param {Procedure} handler */
    const register = handler=>{
        const address = nextProcedure;
        nextProcedure += 16;
        procedures.set(address, handler);
        return address;
    };

    /** @param {string} text */
    const string = text=>{
        const address = stringNext;
        stringNext += (text.length + 16) & ~15;
        return memory.putString(address, text);
    };

    /** @param {number[]} args @returns {any} */
    const send = args=>table.SendMessageA.handler(args);

    /** The DWLP_MSGRESULT a dialog procedure answers through. @param {number} hwnd @param {number} value */
    const result = (hwnd, value)=>{
        table.SetWindowLongA.handler([hwnd, DWLP_MSGRESULT, value >>> 0]);
        return 1;
    };

    /**
     * What each page procedure heard, as [page, message or notification].
     * @type {[string, number][]}
     */
    const heard = [];

    /**
     * A page's dialog procedure, which records what it hears and answers a
     * notification with what `answers` says for its code.
     *
     * @param {string} name
     * @param {Record<number, (hwnd: number, notify: number) => number>} [answers]
     * @param {(args: number[]) => void} [also]
     */
    const pageProc = (name, answers = {}, also = ()=>{})=>register(args=>{
        const [hwnd, message, , lParam] = args;
        also(args);
        if (message === WM_NOTIFY)
        {
            const code = memory.i32(lParam + 8);
            heard.push([name, code]);
            const answer = answers[code];
            return answer ? result(hwnd, answer(hwnd, lParam)) : 0;
        }
        if (message === WM_INITDIALOG)
        {
            heard.push([name, message]);
            return 1;
        }
        return 0;
    });

    let descriptionNext = PAGES;
    /**
     * A PROPSHEETPAGEA in memory.
     *
     * @param {{ size?: number, flags?: number, template?: number, title?: string,
     *     proc?: number, lParam?: number, callback?: number, extra?: number[] }} fields
     */
    const description = fields=>{
        const address = descriptionNext;
        descriptionNext += 0x80;
        memory.bytes.fill(0, address, address + 0x80);
        memory.put32(address + PSP.dwSize, fields.size ?? PSP.V1_SIZE);
        memory.put32(address + PSP.dwFlags, fields.flags ?? 0);
        memory.put32(address + PSP.hInstance, HINSTANCE);
        memory.put32(address + PSP.pszTemplate, fields.template ?? IDD_PROP_PAGE_EDIT);
        memory.put32(address + PSP.pszTitle, fields.title ? string(fields.title) : 0);
        memory.put32(address + PSP.pfnDlgProc, fields.proc ?? 0);
        memory.put32(address + PSP.lParam, fields.lParam ?? 0);
        memory.put32(address + PSP.pfnCallback, fields.callback ?? 0);
        (fields.extra ?? []).forEach((value, index)=>
            memory.put32(address + PSP.V1_SIZE + index * 4, value));
        return address;
    };

    /**
     * Descriptions copied end to end, as PSH_PROPSHEETPAGE hands them over.
     *
     * @param {number[]} list
     */
    const descriptions = list=>{
        const base = descriptionNext;
        descriptionNext += 0x400;
        list.forEach((address, index)=>memory.writeMemory(base + index * PSP.V1_SIZE,
            memory.readMemory(address, PSP.V1_SIZE)));
        return base;
    };

    /**
     * A PROPSHEETHEADERA in memory, over handles or, with PSH_PROPSHEETPAGE,
     * over descriptions laid end to end.
     *
     * @param {{ flags?: number, parent?: number, caption?: string, pages: number[],
     *     start?: number, callback?: number, descriptions?: number }} fields
     *     `descriptions` is where the descriptions are, and `pages` then only
     *     counts them.
     */
    const header = fields=>{
        memory.bytes.fill(0, HEADER, HEADER + 0x40);
        memory.put32(HEADER + PSH.dwSize, PSH.V1_SIZE);
        memory.put32(HEADER + PSH.dwFlags, fields.flags ?? 0);
        memory.put32(HEADER + PSH.hwndParent, fields.parent ?? 0);
        memory.put32(HEADER + PSH.hInstance, HINSTANCE);
        memory.put32(HEADER + PSH.pszCaption, string(fields.caption ?? 'test caption'));
        memory.put32(HEADER + PSH.nPages, fields.pages.length);
        memory.put32(HEADER + PSH.nStartPage, fields.start ?? 0);
        memory.put32(HEADER + PSH.pfnCallback, fields.callback ?? 0);
        if (fields.descriptions)
        {
            memory.put32(HEADER + PSH.phpage, fields.descriptions);
        }
        else
        {
            fields.pages.forEach((page, index)=>memory.put32(HANDLES + index * 4, page));
            memory.put32(HEADER + PSH.phpage, HANDLES);
        }
        return HEADER;
    };

    /** @param {number} address @returns {Promise<number>} */
    const createPage = async address=>
        (await comctl.CreatePropertySheetPageA.handler([address])) >>> 0;

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

    /** @param {number} hwnd */
    const windowRect = hwnd=>{
        const RECT = STRINGS - 0x40;
        table.GetWindowRect.handler([hwnd, RECT]);
        return { left: memory.i32(RECT), top: memory.i32(RECT + 4),
            right: memory.i32(RECT + 8), bottom: memory.i32(RECT + 12) };
    };

    /** @param {number} hwnd */
    const textOf = hwnd=>{
        const BUFFER = STRINGS - 0x200;
        table.GetWindowTextA.handler([hwnd, BUFFER, 256]);
        return memory.readCString(BUFFER, 256);
    };

    /** A top-level window of the program's own, to own a sheet. */
    const makeOwner = async()=>{
        const name = string('owner');
        const CLASS = STRINGS - 0x100;
        [0, register(args=>table.DefWindowProcA.handler(args)), 0, 0, HINSTANCE, 0, 0, 0, 0,
            name].forEach((value, index)=>memory.put32(CLASS + index * 4, value));
        table.RegisterClassA.handler([CLASS]);
        const owner = await table.CreateWindowExA.handler([0, name, name,
            WS_POPUP | WS_CAPTION | WS_VISIBLE, 0, 0, 300, 200, 0, 0, HINSTANCE, 0]);
        await pump();
        return owner;
    };

    /**
     * A key press for a window, handed to the dialog manager the way a
     * modeless sheet's loop hands it: IsDialogMessage, or PSM_ISDIALOGMESSAGE
     * with `sheet`. The keys named are held while it is.
     *
     * @param {number} dialog @param {number} key @param {number[]} [held]
     * @param {boolean} [sheet]
     * @returns {Promise<number>} whether the message was taken
     */
    const press = async(dialog, key, held = [], sheet = false)=>{
        const target = table.GetFocus.handler([]) || dialog;
        [target, WM_KEYDOWN, key, 1].forEach((value, index)=>
            memory.put32(MSG_BUFFER + index * 4, value));
        held.forEach(each=>keysDown.add(each));
        try
        {
            return sheet ? await send([dialog, PSM_ISDIALOGMESSAGE, 0, MSG_BUFFER])
                : await table.IsDialogMessageA.handler([dialog, MSG_BUFFER]);
        }
        finally
        {
            keysDown.clear();
        }
    };

    return { memory, desktop, fns: table, comctl, send, pump, heard, register, pageProc,
        description, descriptions, header, createPage, result, string, windowRect, textOf,
        makeOwner, press };
}

test('CreatePropertySheetPage copies the description, refuses one older than the first '
    + 'size, and adds a reference only past it; DestroyPropertySheetPage releases it once',
async()=>{
    const context = setup();
    const { memory } = context;
    /** @type {{ hwnd: number, message: number, copy: number }[]} */
    const calls = [];
    const callback = context.register(([hwnd, message, copy])=>{
        calls.push({ hwnd, message, copy });
        return 1;
    });
    const original = context.description({ flags: PSP_USECALLBACK, callback, title: 'Title',
        lParam: 0x1234, extra: [0x4321] });
    for (let size = PSP.V1_SIZE - 1; size <= PSP.V1_SIZE + 4; size++)
    {
        memory.put32(original + PSP.dwSize, size);
        calls.length = 0;
        const handle = await context.createPage(original);
        if (size < PSP.V1_SIZE)
        {
            assert.equal(handle, 0, `size ${size} is refused`);
            continue;
        }
        assert.notEqual(handle, 0);
        assert.notEqual(handle, original, 'the handle is a copy');
        assert.deepEqual(calls.map(call=>call.message),
            size > PSP.V1_SIZE ? [PSPCB_ADDREF] : [], `size ${size}`);
        if (size === PSP.V1_SIZE + 4)
        {
            assert.equal(calls[0].hwnd, 0, 'never with a window');
            assert.equal(calls[0].copy, handle);
            assert.equal(memory.u32(handle + PSP.lParam), 0x1234);
            assert.equal(memory.u32(handle + PSP.V1_SIZE), 0x4321, 'what follows is kept');
            assert.equal(memory.u32(handle + PSP.pszTitle),
                memory.u32(original + PSP.pszTitle), 'a title not in use stays where it was');
        }
        calls.length = 0;
        assert.equal(await context.comctl.DestroyPropertySheetPage.handler([handle]), 1);
        assert.deepEqual(calls.map(call=>call.message), [PSPCB_RELEASE]);
        assert.equal(await context.comctl.DestroyPropertySheetPage.handler([handle]), 0,
            'and once only');
    }

    memory.put32(original + PSP.dwSize, PSP.V1_SIZE);
    memory.put32(original + PSP.dwFlags, PSP_USECALLBACK | PSP_USETITLE);
    const titled = await context.createPage(original);
    const title = memory.u32(titled + PSP.pszTitle);
    assert.notEqual(title, memory.u32(original + PSP.pszTitle), 'a title in use is copied');
    assert.equal(memory.readCString(title, 16), 'Title');
});

test('a modeless sheet is its window: the callback hears PSCB_PRECREATE then '
    + 'PSCB_INITIALIZED with the caption set, and the start page is made its child',
async()=>{
    const context = setup();
    /** @type {[number, number, string][]} */
    const told = [];
    let sheetSeen = 0;
    const callback = context.register(([hwnd, message])=>{
        told.push([hwnd, message, hwnd !== 0 ? context.textOf(hwnd) : '']);
        sheetSeen = message === PSCB_INITIALIZED ? hwnd : sheetSeen;
        return 0;
    });
    /** @type {{ parent: number, caption: string, lParam: number }[]} */
    const initial = [];
    const proc = context.pageProc('page', {}, ([hwnd, message, , lParam])=>{
        if (message === WM_INITDIALOG)
        {
            const parent = context.fns.GetParent.handler([hwnd]);
            initial.push({ parent, caption: context.textOf(parent), lParam });
        }
    });
    const page = await context.createPage(context.description({ flags: PSP_USETITLE,
        title: 'page title', proc }));
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS | PSH_USECALLBACK, pages: [page], callback })]);
    assert.ok(hwnd > 0, 'the sheet');
    assert.deepEqual(told.map(([, message])=>message), [PSCB_PRECREATE, PSCB_INITIALIZED]);
    assert.equal(told[0][0], 0, 'before there is a window');
    assert.equal(sheetSeen, hwnd);
    assert.equal(told[1][2], 'test caption');
    const style = context.fns.GetWindowLongA.handler([hwnd, GWL_STYLE]) >>> 0;
    assert.equal(style, (WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CAPTION | WS_SYSMENU
        | DS_CONTEXTHELP | DS_MODALFRAME | DS_SETFONT | DS_3DLOOK) >>> 0);
    assert.deepEqual(initial, [{ parent: hwnd, caption: 'test caption', lParam: page }],
        'the page is handed its description');
    const current = context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]);
    assert.notEqual(current, 0);
    assert.equal(context.send([hwnd, PSM_HWNDTOINDEX, current, 0]), 0);
    assert.equal(context.send([hwnd, PSM_INDEXTOPAGE, 0, 0]), page);
    assert.equal(context.send([hwnd, PSM_PAGETOINDEX, 0, page]), 0);
    assert.equal(context.send([hwnd, PSM_IDTOINDEX, 0, IDD_PROP_PAGE_EDIT]), 0);
    assert.equal(context.send([hwnd, PSM_INDEXTOID, 0, 0]), IDD_PROP_PAGE_EDIT);
    assert.deepEqual(context.heard.filter(([, code])=>code !== WM_INITDIALOG),
        [['page', PSN_SETACTIVE], ['page', PSN_QUERYINITIALFOCUS]]);
    await context.pump();
});

test('the buttons stand in a row under the tabs, OK, Cancel, Apply and Help from the left',
    async()=>{
        const context = setup();
        const page = await context.createPage(context.description({}));
        const hwnd = await context.comctl.PropertySheetA.handler([context.header({
            flags: PSH_MODELESS, pages: [page] })]);
        const rects = [IDOK, IDCANCEL, IDC_APPLY_BUTTON, IDHELP].map(id=>
            context.windowRect(context.fns.GetDlgItem.handler([hwnd, id])));
        rects.forEach(rect=>assert.equal(rect.top, rects[0].top));
        rects.slice(1).forEach((rect, index)=>assert.ok(rect.left > rects[index].right));
        const tab = context.send([hwnd, PSM_GETTABCONTROL, 0, 0]);
        assert.ok(context.windowRect(tab).bottom <= rects[0].top, 'under the tabs');
        const sheet = context.windowRect(hwnd);
        assert.ok(rects[2].right <= sheet.right, 'Apply within the sheet');
        // The page fits in the tab control's pane.
        const pageRect = context.windowRect(context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]));
        const tabRect = context.windowRect(tab);
        assert.ok(pageRect.left > tabRect.left && pageRect.right < tabRect.right
            && pageRect.bottom < tabRect.bottom);
        assert.equal(context.fns.IsWindowEnabled.handler(
            [context.fns.GetDlgItem.handler([hwnd, IDC_APPLY_BUTTON])]), 0,
        'Apply waits for a change');
    });

test('PSM_ADDPAGE and PSM_INSERTPAGE add a tab for a page, refuse nothing and a handle '
    + 'that is none, and a page that cannot be made is dropped when chosen', async()=>{
    const context = setup();
    const proc = context.pageProc('page');
    const pages = [];
    for (let index = 0; index < 3; index++)
    {
        pages.push(await context.createPage(context.description({ proc })));
    }
    // A template that is nowhere, made when shown and made at once, and a
    // page whose callback will not have it made.
    const missing = await context.createPage(context.description({ proc, template: 999 }));
    const premature = await context.createPage(context.description({ proc,
        flags: PSP_PREMATURE, template: 999 }));
    const refuse = context.register(([, message])=>(message === PSPCB_CREATE ? 0 : 1));
    const refused = await context.createPage(context.description({ proc,
        flags: PSP_USECALLBACK, callback: refuse }));
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS, pages: [pages[0]] })]);
    const tab = context.send([hwnd, PSM_GETTABCONTROL, 0, 0]);
    assert.equal(await context.send([hwnd, PSM_ADDPAGE, 0, pages[1]]), 1);
    assert.equal(await context.send([hwnd, PSM_ADDPAGE, 0, 0]), 0);
    assert.equal(context.send([tab, TCM_GETITEMCOUNT, 0, 0]), 2);
    assert.equal(await context.send([hwnd, PSM_INSERTPAGE, -1, pages[2]]), 0,
        'after a page that is not one');
    assert.equal(await context.send([hwnd, PSM_INSERTPAGE, pages[1], pages[2]]), 1);
    assert.equal(context.send([hwnd, PSM_PAGETOINDEX, 0, pages[2]]), 2);
    // A description found nowhere cannot be sized, and is refused.
    assert.equal(await context.send([hwnd, PSM_INSERTPAGE, 1, missing]), 0);
    assert.equal(context.send([tab, TCM_GETITEMCOUNT, 0, 0]), 3);
    assert.equal(await context.send([hwnd, PSM_ADDPAGE, 0, premature]), 0);
    assert.equal(context.send([tab, TCM_GETITEMCOUNT, 0, 0]), 3);
    assert.equal(await context.comctl.DestroyPropertySheetPage.handler([premature]), 1,
        'a page refused is still the program\'s');

    // Only the page on show has been made.
    assert.notEqual(context.send([hwnd, PSM_INDEXTOHWND, 0, 0]), 0);
    assert.equal(context.send([hwnd, PSM_INDEXTOHWND, 1, 0]), 0);
    assert.equal(context.send([hwnd, PSM_INDEXTOHWND, 400, 0]), 0);
    assert.equal(await context.send([hwnd, PSM_SETCURSEL, 2, 0]), 1);
    assert.equal(context.send([hwnd, PSM_HWNDTOINDEX,
        context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]), 0]), 2);
    assert.equal(context.send([tab, TCM_GETCURSEL, 0, 0]), 2, 'the tab follows');

    // Chosen, the page that cannot be made is dropped, and the sheet stays.
    assert.equal(await context.send([hwnd, PSM_ADDPAGE, 0, refused]), 1);
    assert.equal(context.send([tab, TCM_GETITEMCOUNT, 0, 0]), 4);
    assert.equal(await context.send([hwnd, PSM_SETCURSEL, 3, 1]), 1);
    assert.equal(context.send([tab, TCM_GETITEMCOUNT, 0, 0]), 3);
    assert.equal(context.send([hwnd, PSM_HWNDTOINDEX,
        context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]), 0]), 2);
    assert.equal(context.send([tab, TCM_GETCURSEL, 0, 0]), 2);
});

test('pages marked PSP_PREMATURE are made with the sheet, the others when first shown',
    async()=>{
        const context = setup();
        const proc = context.pageProc('page');
        const pages = [];
        for (const flags of [PSP_PREMATURE, PSP_PREMATURE, 0])
        {
            pages.push(context.description({ flags: flags | PSP_USETITLE, proc,
                title: 'page title' }));
        }
        const hwnd = await context.comctl.PropertySheetA.handler([context.header({
            flags: PSH_PROPSHEETPAGE | PSH_MODELESS, pages: pages.map(()=>0),
            descriptions: context.descriptions(pages) })]);
        const made = [0, 1, 2].map(index=>context.send([hwnd, PSM_INDEXTOHWND, index, 0]) !== 0);
        assert.deepEqual(made, [true, true, false]);
    });

test('removing the only page leaves no page on show', async()=>{
    const context = setup();
    const page = await context.createPage(context.description({}));
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS, pages: [page] })]);
    await context.send([hwnd, PSM_REMOVEPAGE, 0, 0]);
    const current = context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]);
    assert.equal(current, 0);
    assert.equal(context.send([hwnd, PSM_HWNDTOINDEX, current, 0]) | 0, -1);
    await context.pump();
});

test('a click on a tab asks the page on show to let go, shows the other, and puts the '
    + 'focus where it answers PSN_QUERYINITIALFOCUS, else on its first tab stop', async()=>{
    const context = setup();
    let focusSecond = true;
    const answers = {
        [PSN_QUERYINITIALFOCUS]: (/** @type {number} */ hwnd)=>(focusSecond
            ? context.fns.GetDlgItem.handler([hwnd, IDC_PS_EDIT2]) : 0),
    };
    const pages = [
        context.description({ flags: PSP_USETITLE, title: 'Page1',
            proc: context.pageProc('one', answers) }),
        context.description({ flags: PSP_USETITLE, title: 'Page2',
            proc: context.pageProc('two', answers) }),
    ];
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_PROPSHEETPAGE | PSH_MODELESS, pages: pages.map(()=>0),
        descriptions: context.descriptions(pages) })]);
    const focusId = ()=>context.fns.GetDlgCtrlID.handler([context.fns.GetFocus.handler([])]);
    assert.equal(focusId(), IDC_PS_EDIT2, 'where the page asked');

    focusSecond = false;
    context.heard.length = 0;
    const tab = context.send([hwnd, PSM_GETTABCONTROL, 0, 0]);
    const RECT = 0x13800;
    context.send([tab, TCM_GETITEMRECT, 1, RECT]);
    const x = (context.memory.i32(RECT) + context.memory.i32(RECT + 8)) >> 1;
    const y = (context.memory.i32(RECT + 4) + context.memory.i32(RECT + 12)) >> 1;
    await context.send([tab, WM_LBUTTONDOWN, 1, (y << 16 | x) >>> 0]);
    assert.deepEqual(context.heard.filter(([, code])=>code !== WM_INITDIALOG), [
        ['one', PSN_KILLACTIVE], ['two', PSN_SETACTIVE], ['two', PSN_QUERYINITIALFOCUS]]);
    assert.equal(focusId(), IDC_PS_EDIT1, 'the first tab stop');
    assert.equal(context.send([hwnd, PSM_HWNDTOINDEX,
        context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]), 0]), 1);

    // Apply puts the focus back where the page says.
    focusSecond = true;
    context.heard.length = 0;
    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_APPLYNOW, 0]);
    assert.deepEqual(context.heard, [['two', PSN_KILLACTIVE], ['one', PSN_APPLY],
        ['two', PSN_APPLY], ['two', PSN_QUERYINITIALFOCUS]]);
    assert.equal(focusId(), IDC_PS_EDIT2);
});

test('a page that will not let go keeps its tab', async()=>{
    const context = setup();
    const pages = [
        context.description({ proc: context.pageProc('one', { [PSN_KILLACTIVE]: ()=>1 }) }),
        context.description({ proc: context.pageProc('two') }),
    ];
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_PROPSHEETPAGE | PSH_MODELESS, pages: pages.map(()=>0),
        descriptions: context.descriptions(pages) })]);
    const tab = context.send([hwnd, PSM_GETTABCONTROL, 0, 0]);
    const RECT = 0x13800;
    context.send([tab, TCM_GETITEMRECT, 1, RECT]);
    const x = (context.memory.i32(RECT) + context.memory.i32(RECT + 8)) >> 1;
    const y = (context.memory.i32(RECT + 4) + context.memory.i32(RECT + 12)) >> 1;
    await context.send([tab, WM_LBUTTONDOWN, 1, (y << 16 | x) >>> 0]);
    assert.equal(context.send([tab, TCM_GETCURSEL, 0, 0]), 0);
    assert.equal(context.send([hwnd, PSM_INDEXTOHWND, 1, 0]), 0, 'never made');
    assert.equal(await context.send([hwnd, PSM_SETCURSEL, 1, 0]), 0, 'nor by the program');
});

test('PSM_CHANGED enables Apply until the pages are applied or PSM_UNCHANGED, and '
    + 'PSM_QUERYSIBLINGS stops at the first page that answers', async()=>{
    const context = setup();
    const pages = [
        context.description({ proc: context.pageProc('one', {}, ()=>{}) }),
        context.description({ flags: PSP_PREMATURE, proc: context.register(([hwnd, message])=>
            (message === PSM_QUERYSIBLINGS ? context.result(hwnd, 0x77) : 0)) }),
    ];
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_PROPSHEETPAGE | PSH_MODELESS, pages: pages.map(()=>0),
        descriptions: context.descriptions(pages) })]);
    const apply = context.fns.GetDlgItem.handler([hwnd, IDC_APPLY_BUTTON]);
    const page = context.send([hwnd, PSM_INDEXTOHWND, 0, 0]);
    context.send([hwnd, PSM_CHANGED, page, 0]);
    assert.equal(context.fns.IsWindowEnabled.handler([apply]), 1);
    context.send([hwnd, PSM_UNCHANGED, page, 0]);
    assert.equal(context.fns.IsWindowEnabled.handler([apply]), 0);
    context.send([hwnd, PSM_CHANGED, page, 0]);
    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_APPLYNOW, 0]);
    assert.equal(context.fns.IsWindowEnabled.handler([apply]), 0, 'applied');
    assert.equal(await context.send([hwnd, PSM_QUERYSIBLINGS, 1, 2]), 0x77);
});

test('a modal sheet disables its owner while it is up and answers 1 once OK has applied '
    + 'the pages', async()=>{
    const context = setup({ modal: true });
    const owner = await context.makeOwner();
    let ownerEnabled = -1;
    const callback = context.register(([hwnd, message])=>{
        if (message === PSCB_INITIALIZED)
        {
            ownerEnabled = context.fns.IsWindowEnabled.handler([owner]);
            context.fns.PostMessageA.handler([hwnd, PSM_PRESSBUTTON, PSBTN_OK, 0]);
        }
        return 0;
    });
    const pages = [
        context.description({ proc: context.pageProc('one') }),
        context.description({ flags: PSP_PREMATURE, proc: context.pageProc('two') }),
        context.description({ proc: context.pageProc('three') }),
    ];
    const answer = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_PROPSHEETPAGE | PSH_USECALLBACK, parent: owner, pages: pages.map(()=>0),
        descriptions: context.descriptions(pages),
        callback })]);
    assert.equal(ownerEnabled, 0, 'disabled before the callback hears');
    assert.equal(answer, 1);
    assert.equal(context.fns.IsWindowEnabled.handler([owner]), 1, 'and enabled after');
    assert.deepEqual(context.heard.filter(([, code])=>code !== WM_INITDIALOG
        && code !== PSN_QUERYINITIALFOCUS), [
        ['one', PSN_SETACTIVE], ['one', PSN_KILLACTIVE], ['one', PSN_APPLY],
        ['two', PSN_APPLY]]);
});

test('Cancel asks the page, then resets every page made, and a modal sheet answers 0',
    async()=>{
        const context = setup({ modal: true });
        const callback = context.register(([hwnd, message])=>{
            if (message === PSCB_INITIALIZED)
            {
                context.fns.PostMessageA.handler([hwnd, PSM_PRESSBUTTON, PSBTN_CANCEL, 0]);
            }
            return 0;
        });
        const pages = [
            context.description({ proc: context.pageProc('one') }),
            context.description({ flags: PSP_PREMATURE, proc: context.pageProc('two') }),
        ];
        const answer = await context.comctl.PropertySheetA.handler([context.header({
            flags: PSH_PROPSHEETPAGE | PSH_USECALLBACK, pages: pages.map(()=>0),
            descriptions: context.descriptions(pages),
            callback })]);
        assert.equal(answer, 0);
        assert.deepEqual(context.heard.filter(([, code])=>code === PSN_QUERYCANCEL
            || code === PSN_RESET), [['one', PSN_QUERYCANCEL], ['one', PSN_RESET],
            ['two', PSN_RESET]]);
    });

test('a WM_QUIT while a modal sheet is up ends it with 0 and gives its owner back', async()=>{
    const context = setup({ modal: true });
    const owner = await context.makeOwner();
    const callback = context.register(([hwnd, message])=>{
        if (message === PSCB_INITIALIZED)
        {
            context.fns.PostQuitMessage.handler([0]);
        }
        return hwnd & 0;
    });
    const page = await context.createPage(context.description({}));
    const answer = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_USECALLBACK, parent: owner, pages: [page], callback })]);
    assert.equal(answer, 0);
    assert.equal(context.fns.IsWindowEnabled.handler([owner]), 1);
    assert.equal(context.fns.PeekMessageA.handler([MSG_BUFFER, 0, WM_QUIT, WM_QUIT, PM_REMOVE]),
        1, 'the quit is put back');
});

test('a wizard walks its pages with Back and Next, the pressed button the default, and a '
    + 'page that will not let go keeps the wizard where it is', async()=>{
    const context = setup();
    let active = -1;
    /** @param {number} index */
    const proc = index=>context.pageProc(`page${index}`, {
        [PSN_SETACTIVE]: (hwnd, notify)=>{
            active = context.send([context.memory.u32(notify), PSM_HWNDTOINDEX, hwnd, 0]);
            return 0;
        },
        [PSN_KILLACTIVE]: ()=>(active === 3 ? 1 : 0),
    });
    const templates = [IDD_PROP_PAGE_INTRO, IDD_PROP_PAGE_EDIT, IDD_PROP_PAGE_EDIT,
        IDD_PROP_PAGE_EXIT];
    const pages = [];
    for (const [index, template] of templates.entries())
    {
        pages.push(await context.createPage(context.description({ template,
            proc: proc(index) })));
    }
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS | PSH_WIZARD, caption: 'A Wizard', pages })]);
    const focusId = ()=>context.fns.GetDlgCtrlID.handler([context.fns.GetFocus.handler([])]);
    const defaultId = ()=>{
        const answer = context.send([hwnd, DM_GETDEFID, 0, 0]) >>> 0;
        assert.equal(answer >>> 16, DC_HASDEFID);
        return answer & 0xffff;
    };
    assert.equal(active, 0);
    const style = context.fns.GetWindowLongA.handler([hwnd, GWL_STYLE])
        & ~(DS_CONTEXTHELP | WS_SYSMENU);
    assert.equal(style >>> 0, (WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CAPTION
        | DS_MODALFRAME | DS_SETFONT | DS_3DLOOK) >>> 0);
    assert.equal(focusId(), IDC_NEXT_BUTTON, 'a page with no tab stop leaves it on Next');

    context.heard.length = 0;
    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_NEXT, 0]);
    assert.equal(active, 1);
    assert.deepEqual(context.heard.slice(0, 3), [['page0', PSN_WIZNEXT],
        ['page0', PSN_KILLACTIVE], ['page1', WM_INITDIALOG]]);
    assert.equal(focusId(), IDC_PS_EDIT1);
    assert.equal(defaultId(), IDC_NEXT_BUTTON);

    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_NEXT, 0]);
    assert.equal(active, 2);
    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_BACK, 0]);
    assert.equal(active, 1);
    assert.equal(focusId(), IDC_PS_EDIT1);
    assert.equal(defaultId(), IDC_BACK_BUTTON);

    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_NEXT, 0]);
    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_NEXT, 0]);
    assert.equal(active, 3);
    assert.equal(focusId(), IDC_NEXT_BUTTON);
    context.heard.length = 0;
    await context.send([hwnd, PSM_PRESSBUTTON, PSBTN_BACK, 0]);
    assert.equal(active, 3, 'the last page would not let go');
    assert.deepEqual(context.heard, [['page3', PSN_WIZBACK], ['page3', PSN_KILLACTIVE]]);
    assert.equal(defaultId(), IDC_NEXT_BUTTON);
    assert.notEqual(context.fns.GetDlgItem.handler([hwnd, IDC_BACK_BUTTON]), 0);
});

test('destroying a sheet releases the pages it was given, and a page asking it anything '
    + 'as it goes is still answered', async()=>{
    const context = setup();
    /** @type {number[]} */
    const released = [];
    const callback = context.register(([, message, copy])=>{
        if (message === PSPCB_RELEASE)
        {
            released.push(copy);
        }
        return 1;
    });
    /** @type {number[]} */
    const asked = [];
    let sheet = 0;
    const proc = context.register(([hwnd, message])=>{
        if (message === WM_NCDESTROY)
        {
            asked.push(context.send([sheet, PSM_INDEXTOHWND, 400, 0]));
        }
        return hwnd & 0;
    });
    const page = await context.createPage(context.description({ flags: PSP_USECALLBACK,
        callback, proc }));
    sheet = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS, pages: [page] })]);
    await context.fns.DestroyWindow.handler([sheet]);
    assert.deepEqual(released, [page]);
    assert.deepEqual(asked, [0]);
    assert.equal(context.fns.IsWindow.handler([sheet]), 0);
});

test('a description handed where a page belongs is made a page of its own', async()=>{
    const context = setup();
    const description = context.description({});
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS, pages: [description] })]);
    const made = context.send([hwnd, PSM_INDEXTOPAGE, 0, 0]);
    assert.notEqual(made, 0);
    assert.notEqual(made, description, 'not the program\'s own memory');
});

test('without Apply, the row is OK and Cancel, and the sheet is painted', async()=>{
    const context = setup();
    const page = await context.createPage(context.description({}));
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS | PSH_NOAPPLYNOW, pages: [page] })]);
    await context.pump();
    const sheet = context.windowRect(hwnd);
    const cancel = context.windowRect(context.fns.GetDlgItem.handler([hwnd, IDCANCEL]));
    const apply = context.fns.GetDlgItem.handler([hwnd, IDC_APPLY_BUTTON]);
    assert.equal(context.fns.IsWindowVisible.handler([apply]), 0);
    assert.ok(sheet.right - cancel.right < 20, 'Cancel ends the row at the right margin');
    // The face under the buttons is the dialog's.
    assert.equal(context.desktop.read(sheet.left + 8, cancel.bottom + 2), 0x00c0c0c0);
});

test('Tab walks from the sheet into the page on show and through its controls, and '
    + 'Shift+Tab walks back out', async()=>{
    // user32's dialog tests (test_GetNextDlgItem): the dialog manager searches
    // through a child with WS_EX_CONTROLPARENT, which a page is made, as if
    // its controls were the sheet's own.
    const context = setup();
    const page = await context.createPage(context.description({
        proc: context.pageProc('page') }));
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS, pages: [page] })]);
    const current = context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]);
    const edit = (/** @type {number} */ id)=>context.fns.GetDlgItem.handler([current, id]);
    const focus = ()=>context.fns.GetFocus.handler([]);
    const parentOf = (/** @type {number} */ child)=>context.fns.GetParent.handler([child]);
    assert.equal(focus(), edit(IDC_PS_EDIT1), 'the page\'s first tab stop');

    assert.equal(await context.press(hwnd, VK_TAB), 1);
    assert.equal(focus(), edit(IDC_PS_EDIT2), 'to the page\'s next');
    assert.equal(await context.press(hwnd, VK_TAB), 1);
    assert.equal(parentOf(focus()), hwnd, 'past the page\'s last, to a control of the sheet');
    /** @type {number[]} */
    const walked = [];
    for (let guard = 0; guard < 8 && focus() !== edit(IDC_PS_EDIT1); guard++)
    {
        walked.push(focus());
        await context.press(hwnd, VK_TAB);
    }
    assert.equal(focus(), edit(IDC_PS_EDIT1), 'and round into the page again');
    await context.press(hwnd, VK_TAB, [VK_SHIFT]);
    assert.equal(focus(), walked.at(-1), 'Shift+Tab back to the sheet\'s control before it');
});

test('PSM_ISDIALOGMESSAGE takes Ctrl+PgDn and Ctrl+Tab to the next page, Ctrl+PgUp and '
    + 'Ctrl+Shift+Tab to the one before, and hands anything else to the dialog manager',
async()=>{
    // comctl32's property sheet tests (test_hotkey_navigation): the keys move
    // a wizard of two pages from the first to the second and back, twice.
    const context = setup();
    const pages = [];
    for (const name of ['one', 'two'])
    {
        pages.push(await context.createPage(context.description({
            proc: context.pageProc(name) })));
    }
    const hwnd = await context.comctl.PropertySheetA.handler([context.header({
        flags: PSH_MODELESS | PSH_WIZARD, caption: 'A Wizard', pages })]);
    const active = ()=>context.send([hwnd, PSM_HWNDTOINDEX,
        context.send([hwnd, PSM_GETCURRENTPAGEHWND, 0, 0]), 0]);
    assert.equal(active(), 0);
    /** @type {[number, number[], number][]} the key, the keys held with it, the page after */
    const steps = [[VK_NEXT, [VK_CONTROL], 1], [VK_PRIOR, [VK_CONTROL], 0],
        [VK_TAB, [VK_CONTROL], 1], [VK_TAB, [VK_CONTROL, VK_SHIFT], 0]];
    for (const [key, held, page] of steps)
    {
        context.heard.length = 0;
        assert.equal(await context.press(hwnd, key, held, true), 1, `key ${key} taken`);
        assert.equal(active(), page, `key ${key} with ${held}`);
        assert.deepEqual(context.heard.filter(([, code])=>code === PSN_KILLACTIVE
            || code === PSN_SETACTIVE).map(([, code])=>code), [PSN_KILLACTIVE, PSN_SETACTIVE],
        'the page on show is asked to let go, as a click on a tab asks it');
    }

    const focused = context.fns.GetFocus.handler([]);
    assert.equal(await context.press(hwnd, VK_TAB, [], true), 1, 'a plain Tab');
    assert.notEqual(context.fns.GetFocus.handler([]), focused, 'moves the focus');
    assert.equal(active(), 0, 'and not the page');
    assert.equal(await context.press(hwnd, VK_NEXT, [], true), 0,
        'PgDn alone is not the sheet\'s');
});
