/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * uxtheme on a classic desktop. The answers with no visual style active are
 * the ones Windows gives with theming off: no theme data, E_HANDLE for every
 * handle, the system's own values where a NULL theme is documented to mean
 * them, and a parent asked to paint itself under its child, which needs no
 * theme. The export set is checked whole, because a framework binds the
 * library by name and reads a NULL from GetProcAddress as "older Windows".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThemeFunctions } from './functions.js';
import { createMessageQueue } from '../user32/messages.js';
import { createWindowFunctions } from '../user32/windows.js';
import { decodeAnsi } from '../kernel32/locale.js';

const S_OK = 0;
const E_HANDLE = 0x80070006;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const E_OUTOFMEMORY = 0x8007000e;
const E_FAIL = 0x80004005;
const E_PROP_ID_UNSUPPORTED = 0x80070490;
const E_FILE_NOT_FOUND = 0x80070002;

const WM_ERASEBKGND = 0x0014;
const WM_PRINTCLIENT = 0x0318;
const WM_THEMECHANGED = 0x031a;
const PRF_CLIENT = 4;

const SPI_GETICONTITLELOGFONT = 0x001f;
const SPI_GETNONCLIENTMETRICS = 0x0029;
const SPI_GETFLATMENU = 0x1022;

const TMT_CAPTIONFONT = 801;
const TMT_ICONTITLEFONT = 806;
const TMT_FLATMENUS = 1001;

/** Handles no OpenThemeData made: NULL, INVALID_HANDLE_VALUE and a stray pointer. */
const FOREIGN_THEMES = [0, 0xffffffff, 0xdeadbeef];

const OUT = 0x1000;
const RECT_IN = 0x1200;
const HEAP = 0x8000;
/** Fills a buffer so that "wrote nothing" is distinguishable from "wrote zero". */
const UNTOUCHED = 0xa5;

/**
 * Every documented function Windows XP SP3's uxtheme.dll exports, with the
 * bytes its stdcall pops: four an argument, eight for HitTestThemeBackground's
 * POINT by value.
 */
const XP_EXPORTS = {
    CloseThemeData: 4, DrawThemeBackground: 24, DrawThemeEdge: 32, DrawThemeIcon: 28,
    DrawThemeParentBackground: 12, DrawThemeText: 36, EnableThemeDialogTexture: 8,
    EnableTheming: 4, GetCurrentThemeName: 24, GetThemeAppProperties: 0,
    GetThemeBackgroundContentRect: 24, GetThemeBackgroundExtent: 24,
    GetThemeBackgroundRegion: 24, GetThemeBool: 20, GetThemeColor: 20,
    GetThemeDocumentationProperty: 16, GetThemeEnumValue: 20, GetThemeFilename: 24,
    GetThemeFont: 24, GetThemeInt: 20, GetThemeIntList: 20, GetThemeMargins: 28,
    GetThemeMetric: 24, GetThemePartSize: 28, GetThemePosition: 20,
    GetThemePropertyOrigin: 20, GetThemeRect: 20, GetThemeString: 24, GetThemeSysBool: 8,
    GetThemeSysColor: 8, GetThemeSysColorBrush: 8, GetThemeSysFont: 12, GetThemeSysInt: 12,
    GetThemeSysSize: 8, GetThemeSysString: 16, GetThemeTextExtent: 36,
    GetThemeTextMetrics: 20, GetWindowTheme: 4, HitTestThemeBackground: 40,
    IsAppThemed: 0, IsThemeActive: 0, IsThemeBackgroundPartiallyTransparent: 12,
    IsThemeDialogTextureEnabled: 4, IsThemePartDefined: 12, OpenThemeData: 8,
    SetThemeAppProperties: 4, SetWindowTheme: 12,
};

/** The calls about a theme handle that answer an HRESULT. */
const THEME_CALLS = [
    'CloseThemeData', 'DrawThemeBackground', 'DrawThemeEdge', 'DrawThemeIcon', 'DrawThemeText',
    'GetThemeBackgroundContentRect', 'GetThemeBackgroundExtent', 'GetThemeBackgroundRegion',
    'GetThemeBool', 'GetThemeColor', 'GetThemeEnumValue', 'GetThemeFilename', 'GetThemeFont',
    'GetThemeInt', 'GetThemeIntList', 'GetThemeMargins', 'GetThemeMetric', 'GetThemePartSize',
    'GetThemePosition', 'GetThemePropertyOrigin', 'GetThemeRect', 'GetThemeString',
    'GetThemeTextExtent', 'GetThemeTextMetrics', 'HitTestThemeBackground',
];

/** @typedef {{ argBytes: number, handler: (args: number[]) => any }} Entry */

function fakeMemory(size = 0x10000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address */
        i32: address=>new DataView(bytes.buffer).getInt32(address, true),
        /** @param {number} address @param {number[]} values */
        putI32s(address, values){
            values.forEach((value, index)=>{
                new DataView(bytes.buffer).setInt32(address + index * 4, value, true);
            });
        },
        /** @param {number} address @param {number} length */
        untouched: (address, length)=>bytes.subarray(address, address + length)
            .every(byte=>byte === UNTOUCHED),
    };
}

/**
 * The theme functions over fake guest memory, a heap that records what is
 * still held, and whichever user32 and gdi32 exports a test supplies.
 *
 * @param {{ user32?: Record<string, (args: number[]) => any>,
 *     gdi32?: Record<string, (args: number[]) => any>, heap?: boolean }} [options]
 */
function setup({ user32 = {}, gdi32 = {}, heap = true } = {}){
    const memory = fakeMemory();
    memory.bytes.fill(UNTOUCHED);
    /** @type {number[]} */
    const errors = [];
    /** @type {Set<number>} */
    const held = new Set();
    let next = HEAP;
    /** @param {Record<string, (args: number[]) => any>} table */
    const lookup = table=>(/** @type {string} */ name)=>(table[name]
        ? { handler: table[name] } : undefined);
    const fns = /** @type {Record<string, Entry>} */ (createThemeFunctions({
        setLastError: code=>errors.push(code),
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        allocate: heap
            ? bytes=>{
                const at = next;
                next += (bytes + 15) & ~15;
                held.add(at);
                return at;
            }
            : ()=>0,
        release: address=>{
            assert.ok(held.delete(address), 'released only what was allocated');
        },
        user32: lookup(user32),
        gdi32: lookup(gdi32),
    }));
    return { memory, errors, held, fns };
}

test('exports exactly what XP SP3 exports, each popping its own arguments', ()=>{
    const { fns } = setup();
    assert.deepEqual(Object.keys(fns).sort(), Object.keys(XP_EXPORTS).sort());
    for (const [name, bytes] of Object.entries(XP_EXPORTS))
    {
        assert.equal(fns[name].argBytes, bytes, name);
    }
    for (const later of ['BeginBufferedPaint', 'EndBufferedPaint', 'BufferedPaintSetAlpha',
        'DrawThemeTextEx', 'GetThemeBitmap', 'GetThemeStream', 'OpenThemeDataEx',
        'IsCompositionActive', 'GetThemeTransitionDuration', 'SetWindowThemeAttribute'])
    {
        assert.equal(fns[later], undefined, `${later} is Vista's, and XP answers NULL for it`);
    }
});

test('with the classic style nothing is themed and no theme data opens', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.IsThemeActive.handler([]), 0);
    assert.equal(fns.IsAppThemed.handler([]), 0);
    for (const hwnd of [0, 0x10010])
    {
        assert.equal(fns.OpenThemeData.handler([hwnd, 0]), 0);
        assert.equal(fns.OpenThemeData.handler([hwnd, RECT_IN]), 0);
    }
    assert.deepEqual(errors, [E_POINTER, E_PROP_ID_UNSUPPORTED, E_POINTER,
        E_PROP_ID_UNSUPPORTED], 'no class list is E_POINTER; any class finds no theme');
});

test('every call about a theme refuses the handle it is given and writes nothing', ()=>{
    const { fns, errors, memory } = setup();
    for (const name of THEME_CALLS)
    {
        for (const theme of FOREIGN_THEMES)
        {
            // Every pointer argument points at the out buffer, so a write
            // anywhere the call might make one shows.
            const args = new Array(fns[name].argBytes / 4).fill(OUT);
            args[0] = theme;
            assert.equal(fns[name].handler(args), E_HANDLE, `${name}(0x${theme.toString(16)})`);
        }
    }
    assert.ok(memory.untouched(OUT, 256));
    assert.deepEqual(errors, [], 'an HRESULT says it all');

    for (const name of ['IsThemePartDefined', 'IsThemeBackgroundPartiallyTransparent'])
    {
        errors.length = 0;
        for (const theme of FOREIGN_THEMES)
        {
            assert.equal(fns[name].handler([theme, 1, 1]), 0, name);
        }
        assert.deepEqual(errors, [E_HANDLE, E_HANDLE, E_HANDLE], `${name}'s last error`);
    }
});

test('the system calls answer the global values for no theme, and refuse a stray handle', ()=>{
    const { fns, errors } = setup({ user32: {
        GetSysColor: ([index])=>0x00102030 + index,
        GetSysColorBrush: ([index])=>0x1000 + index,
        GetSystemMetrics: ([index])=>100 + index,
    } });
    for (const index of [0, 5, 15, 24, 1000])
    {
        assert.equal(fns.GetThemeSysColor.handler([0, index]), 0x00102030 + index);
        assert.equal(fns.GetThemeSysColorBrush.handler([0, index]), 0x1000 + index);
        assert.equal(fns.GetThemeSysSize.handler([0, index]), 100 + index,
            'the index goes to GetSystemMetrics as it came');
    }
    assert.deepEqual(errors, []);
    for (const name of ['GetThemeSysColor', 'GetThemeSysColorBrush', 'GetThemeSysSize',
        'GetThemeSysBool'])
    {
        assert.equal(fns[name].handler([0xdeadbeef, 5]), 0, name);
    }
    assert.deepEqual(errors, [E_HANDLE, E_HANDLE, E_HANDLE, E_HANDLE]);
    assert.equal(fns.GetThemeSysFont.handler([0xdeadbeef, TMT_CAPTIONFONT, OUT]), E_HANDLE);
});

test('GetThemeSysFont copies each font out of the non-client metrics', ()=>{
    /** @type {number[][]} */
    const asked = [];
    const { fns, memory, held } = setup({ user32: {
        SystemParametersInfoW: ([action, param, at])=>{
            asked.push([action, param, at === OUT ? OUT : -1]);
            if (action === SPI_GETICONTITLELOGFONT)
            {
                memory.bytes.fill(0x66, at, at + 92);
                return 1;
            }
            if (action !== SPI_GETNONCLIENTMETRICS || memory.i32(at) !== 500)
            {
                return 0;
            }
            // Each font a byte of its own; the sizes around them a byte no
            // font is, so an offset that is off by a size shows.
            memory.bytes.fill(0xee, at + 4, at + 500);
            for (const [font, offset] of [[1, 24], [2, 124], [3, 224], [4, 316], [5, 408]])
            {
                memory.bytes.fill(font * 0x11, at + offset, at + offset + 92);
            }
            return 1;
        },
    } });
    for (let font = 1; font <= 5; font++)
    {
        memory.bytes.fill(UNTOUCHED, OUT, OUT + 128);
        assert.equal(fns.GetThemeSysFont.handler([0, 800 + font, OUT]), S_OK);
        assert.ok(memory.bytes.subarray(OUT, OUT + 92).every(byte=>byte === font * 0x11),
            `font ${800 + font}`);
        assert.ok(memory.untouched(OUT + 92, 36), 'and nothing past the LOGFONTW');
    }
    assert.equal(held.size, 0, 'the scratch structure is given back');
    assert.deepEqual(asked.slice(0, 1), [[SPI_GETNONCLIENTMETRICS, 500, -1]]);

    asked.length = 0;
    assert.equal(fns.GetThemeSysFont.handler([0, TMT_ICONTITLEFONT, OUT]), S_OK);
    assert.deepEqual(asked, [[SPI_GETICONTITLELOGFONT, 92, OUT]],
        'the icon title font has a query of its own, straight into the caller\'s LOGFONTW');
    assert.equal(memory.bytes[OUT], 0x66);

    assert.equal(fns.GetThemeSysFont.handler([0, 807, OUT]), E_INVALIDARG);
    assert.equal(fns.GetThemeSysFont.handler([0, 800, OUT]), E_INVALIDARG);
    assert.equal(fns.GetThemeSysFont.handler([0, TMT_CAPTIONFONT, 0]), E_POINTER);
});

test('GetThemeSysFont says so when the system cannot answer', ()=>{
    const refusing = setup({ user32: { SystemParametersInfoW: ()=>0 } });
    refusing.memory.bytes.fill(UNTOUCHED, OUT, OUT + 92);
    for (const font of [TMT_CAPTIONFONT, TMT_ICONTITLEFONT])
    {
        assert.equal(refusing.fns.GetThemeSysFont.handler([0, font, OUT]), E_FAIL);
    }
    assert.ok(refusing.memory.untouched(OUT, 92));
    assert.equal(refusing.held.size, 0);

    const noHeap = setup({ heap: false, user32: { SystemParametersInfoW: ()=>1 } });
    assert.equal(noHeap.fns.GetThemeSysFont.handler([0, TMT_CAPTIONFONT, OUT]), E_OUTOFMEMORY);
});

test('GetThemeSysBool asks the system about flat menus and about nothing else', ()=>{
    let flat = 1;
    /** @type {number[]} */
    const asked = [];
    const { fns, memory, held } = setup({ user32: {
        SystemParametersInfoW: ([action, , at])=>{
            asked.push(action);
            memory.putI32s(at, [flat]);
            return action === SPI_GETFLATMENU ? 1 : 0;
        },
    } });
    assert.equal(fns.GetThemeSysBool.handler([0, TMT_FLATMENUS]), 1);
    flat = 0;
    assert.equal(fns.GetThemeSysBool.handler([0, TMT_FLATMENUS]), 0);
    assert.equal(fns.GetThemeSysBool.handler([0, 1002]), 0);
    assert.deepEqual(asked, [SPI_GETFLATMENU, SPI_GETFLATMENU]);
    assert.equal(held.size, 0);

    const refusing = setup({ user32: { SystemParametersInfoW: ()=>0 } });
    assert.equal(refusing.fns.GetThemeSysBool.handler([0, TMT_FLATMENUS]), 0,
        'a setting the system does not answer is off');
    assert.equal(setup().fns.GetThemeSysBool.handler([0, TMT_FLATMENUS]), 0);
});

test('the theme\'s own values need a theme, and there is none to name', ()=>{
    const { fns, memory } = setup();
    for (const theme of FOREIGN_THEMES)
    {
        assert.equal(fns.GetThemeSysInt.handler([theme, 1301, OUT]), E_HANDLE);
        assert.equal(fns.GetThemeSysString.handler([theme, 1401, OUT, 64]), E_HANDLE);
    }
    for (const args of [[0, 0, 0, 0, 0, 0], [OUT, 0, 0, 0, 0, 0], [OUT, 2, 0, 0, 0, 0],
        [OUT, 260, OUT + 0x400, 260, OUT + 0x800, 260], [OUT, 520, 0, 0, 0, 0]])
    {
        assert.equal(fns.GetCurrentThemeName.handler(args), E_PROP_ID_UNSUPPORTED);
    }
    assert.equal(fns.GetThemeDocumentationProperty.handler([RECT_IN, RECT_IN, OUT, 64]),
        E_FILE_NOT_FOUND);
    assert.ok(memory.untouched(OUT, 0xc00));
});

test('no window has theme data, and only what is not a window is an error', ()=>{
    const { fns, errors } = setup({ user32: { IsWindow: ([hwnd])=>(hwnd === 0x10010 ? 1 : 0) } });
    assert.equal(fns.GetWindowTheme.handler([0x10010]), 0);
    assert.deepEqual(errors, [], 'a window has no theme, which is no error');
    assert.equal(fns.GetWindowTheme.handler([0]), 0);
    assert.equal(fns.GetWindowTheme.handler([0x20020]), 0);
    assert.deepEqual(errors, [E_HANDLE, E_HANDLE]);
});

test('SetWindowTheme sends WM_THEMECHANGED to the window alone', async()=>{
    /** @type {number[][]} */
    const sent = [];
    let later = false;
    const { fns } = setup({ user32: {
        IsWindow: ([hwnd])=>(hwnd === 0x10010 ? 1 : 0),
        SendMessageW: args=>{
            sent.push(args);
            return later ? Promise.resolve(0) : 0;
        },
    } });
    assert.equal(fns.SetWindowTheme.handler([0, 0, 0]), E_HANDLE);
    assert.equal(fns.SetWindowTheme.handler([0x20020, RECT_IN, 0]), E_HANDLE);
    assert.deepEqual(sent, []);
    assert.equal(fns.SetWindowTheme.handler([0x10010, 0, 0]), S_OK);
    later = true;
    assert.equal(await fns.SetWindowTheme.handler([0x10010, RECT_IN, RECT_IN]), S_OK,
        'answered once the window has');
    assert.deepEqual(sent, [[0x10010, WM_THEMECHANGED, 0, 0], [0x10010, WM_THEMECHANGED, 0, 0]]);
});

test('dialog texture and theming switches answer S_OK and change nothing', ()=>{
    const { fns } = setup({ user32: { IsWindow: ([hwnd])=>(hwnd === 0x10010 ? 1 : 0) } });
    const ETDT_ENABLETAB = 6;
    assert.equal(fns.EnableThemeDialogTexture.handler([0x10010, ETDT_ENABLETAB]), S_OK);
    assert.equal(fns.IsThemeDialogTextureEnabled.handler([0x10010]), 0);
    assert.equal(fns.EnableThemeDialogTexture.handler([0, ETDT_ENABLETAB]), E_HANDLE);
    assert.equal(fns.IsThemeDialogTextureEnabled.handler([0]), 0);
    for (const enable of [0, 1, 0])
    {
        assert.equal(fns.EnableTheming.handler([enable]), S_OK);
        assert.equal(fns.IsThemeActive.handler([]), 0, 'and no theme comes back on');
    }
});

test('GetThemeAppProperties answers every flag until SetThemeAppProperties sets others', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetThemeAppProperties.handler([]), 7,
        'STAP_ALLOW_NONCLIENT | STAP_ALLOW_CONTROLS | STAP_ALLOW_WEBCONTENT');
    for (const flags of [1, 0, 6, 0x80000003])
    {
        fns.SetThemeAppProperties.handler([flags]);
        assert.equal(fns.GetThemeAppProperties.handler([]), flags);
    }
    assert.equal(setup().fns.GetThemeAppProperties.handler([]), 7, 'each process its own');
});

/**
 * A parent at 0x10010 with a child at 0x10020 whose client area starts at
 * (5, 7) in its parent's, 40 by 30; a top-level window at 0x10030.
 *
 * @param {(args: number[]) => any} [send]
 */
function parentAndChild(send = ()=>0){
    /** @type {any[][]} */
    const calls = [];
    const record = (/** @type {string} */ name, /** @type {any} */ answer = 1)=>
        (/** @type {number[]} */ args)=>{
            calls.push([name, ...args]);
            return typeof answer === 'function' ? answer(args) : answer;
        };
    const context = setup({
        user32: {
            IsWindow: ([hwnd])=>([0x10010, 0x10020, 0x10030].includes(hwnd) ? 1 : 0),
            GetAncestor: ([hwnd])=>(hwnd === 0x10020 ? 0x10010 : 0x10001),
            GetDesktopWindow: ()=>0x10001,
            MapWindowPoints: ([from, to, at])=>{
                assert.deepEqual([from, to], [0x10020, 0x10010]);
                context.memory.putI32s(at, [context.memory.i32(at) + 5,
                    context.memory.i32(at + 4) + 7]);
                return 1;
            },
            GetClientRect: ([, at])=>{
                context.memory.putI32s(at, [0, 0, 40, 30]);
                return 1;
            },
            SendMessageW: record('SendMessageW', send),
        },
        gdi32: {
            SaveDC: record('SaveDC', 3),
            IntersectClipRect: record('IntersectClipRect'),
            OffsetViewportOrgEx: record('OffsetViewportOrgEx'),
            RestoreDC: record('RestoreDC'),
        },
    });
    return { ...context, calls };
}

test('DrawThemeParentBackground has the parent erase and print itself under the child', ()=>{
    const HDC = 0x900;
    const { fns, memory, calls, held } = parentAndChild();
    assert.equal(fns.DrawThemeParentBackground.handler([0x10020, HDC, 0]), S_OK);
    assert.deepEqual(calls, [
        ['SaveDC', HDC],
        ['IntersectClipRect', HDC, 0, 0, 40, 30],
        ['OffsetViewportOrgEx', HDC, -5, -7, 0],
        ['SendMessageW', 0x10010, WM_ERASEBKGND, HDC, 0],
        ['SendMessageW', 0x10010, WM_PRINTCLIENT, HDC, PRF_CLIENT],
        ['RestoreDC', HDC, 3],
    ], 'the whole child, the parent drawn in its own coordinates, and the DC put back');
    assert.equal(held.size, 0);

    calls.length = 0;
    memory.putI32s(RECT_IN, [2, 3, 12, 13]);
    assert.equal(fns.DrawThemeParentBackground.handler([0x10020, HDC, RECT_IN]), S_OK);
    assert.deepEqual(calls[1], ['IntersectClipRect', HDC, 2, 3, 12, 13],
        'the rectangle asked for, in the child\'s coordinates');
    assert.deepEqual(calls.map(call=>call[0]), ['SaveDC', 'IntersectClipRect',
        'OffsetViewportOrgEx', 'SendMessageW', 'SendMessageW', 'RestoreDC']);

    calls.length = 0;
    assert.equal(fns.DrawThemeParentBackground.handler([0x10030, HDC, 0]), S_OK);
    assert.deepEqual(calls, [], 'a top-level window has nobody behind it to ask');
    assert.equal(fns.DrawThemeParentBackground.handler([0, HDC, 0]), E_HANDLE);
    assert.equal(fns.DrawThemeParentBackground.handler([0x20020, HDC, 0]), E_HANDLE);
    assert.deepEqual(calls, []);
});

test('DrawThemeParentBackground waits for a parent the program answers for', async()=>{
    const HDC = 0x900;
    /** @type {(() => void)[]} */
    const pending = [];
    const waiting = parentAndChild(()=>new Promise(resolve=>{
        pending.push(()=>resolve(1));
    }));
    const answer = waiting.fns.DrawThemeParentBackground.handler([0x10020, HDC, 0]);
    assert.equal(typeof answer.then, 'function');
    await Promise.resolve();
    assert.deepEqual(waiting.calls.map(call=>call[2] ?? call[0]).slice(3),
        [WM_ERASEBKGND], 'one message at a time');
    pending.shift()?.();
    await new Promise(resolve=>setImmediate(resolve));
    pending.shift()?.();
    assert.equal(await answer, S_OK);
    assert.deepEqual(waiting.calls.at(-1), ['RestoreDC', HDC, 3]);

    const failing = parentAndChild(([, message])=>(message === WM_PRINTCLIENT
        ? Promise.reject(new Error('guest fault')) : 0));
    await assert.rejects(failing.fns.DrawThemeParentBackground.handler([0x10020, HDC, 0]),
        /guest fault/);
    assert.deepEqual(failing.calls.at(-1), ['RestoreDC', HDC, 3],
        'the DC is put back even when the parent never answers');
});

/**
 * The real user32 under the theme functions: what GetThemeSys* answers with
 * no theme has to be what user32 itself answers, structure layout included.
 */
function overUser32(){
    const memory = fakeMemory(0x20000);
    /** @type {any[]} */
    const dispatched = [];
    let next = 4;
    const handles = {
        /** @type {Map<number, any>} */
        entries: new Map(),
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            this.entries.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle */
        close(handle){
            this.entries.delete(handle);
        },
        /** @param {number} handle */
        typeOf(handle){
            return this.entries.get(handle)?.type ?? null;
        },
        /** @param {number} handle @param {string} type */
        resolve(handle, type){
            const entry = this.entries.get(handle);
            if (!entry || entry.type !== type)
            {
                throw new Error('Invalid handle');
            }
            return entry.object;
        },
    };
    const user32 = /** @type {Record<string, Entry>} */ (/** @type {unknown} */ (
        createWindowFunctions({
            readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>
                memory.readMemory(a, n),
            writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
                memory.writeMemory(a, d),
            readCString: (/** @type {number} */ address, /** @type {number} */ max)=>{
                let end = address;
                while (end - address < max && memory.bytes[end] !== 0)
                {
                    end++;
                }
                return decodeAnsi(memory.bytes.subarray(address, end));
            },
            handles,
            queue: createMessageQueue(),
            screen: { width: 640, height: 480, bitsPerPixel: 32 },
            dc: ()=>({ get: ()=>0x900, release: ()=>1 }),
            dispatch: (/** @type {number} */ wndProc, /** @type {any} */ message)=>{
                dispatched.push({ ...message });
                return 0;
            },
            park: ()=>({ parked: true }),
            idle: ()=>new Promise(()=>{}),
        })));
    /** @type {any[][]} */
    const drawn = [];
    let heap = 0x1c000;
    const fns = /** @type {Record<string, Entry>} */ (createThemeFunctions({
        readMemory: memory.readMemory,
        writeMemory: memory.writeMemory,
        allocate: bytes=>{
            const at = heap;
            heap += (bytes + 15) & ~15;
            return at;
        },
        release: ()=>{},
        user32: name=>user32[name],
        gdi32: name=>({ handler: (/** @type {number[]} */ args)=>{
            drawn.push([name, ...args]);
            return 1;
        } }),
    }));
    return { memory, user32, fns, dispatched, drawn };
}

test('with no theme, the system values are user32\'s own, fonts and all', ()=>{
    const { memory, user32, fns } = overUser32();
    for (const index of [0, 5, 8, 15, 20, 24])
    {
        assert.equal(fns.GetThemeSysColor.handler([0, index]),
            user32.GetSysColor.handler([index]));
    }
    for (const index of [2, 3, 4, 30, 31, 52, 53, 54, 55])
    {
        assert.equal(fns.GetThemeSysSize.handler([0, index]),
            user32.GetSystemMetrics.handler([index]));
    }
    const METRICS = 0x2000;
    memory.putI32s(METRICS, [500]);
    assert.equal(user32.SystemParametersInfoW.handler([SPI_GETNONCLIENTMETRICS, 500, METRICS, 0]),
        1);
    for (const [font, offset] of [[801, 24], [802, 124], [803, 224], [804, 316], [805, 408]])
    {
        memory.bytes.fill(UNTOUCHED, OUT, OUT + 92);
        assert.equal(fns.GetThemeSysFont.handler([0, font, OUT]), S_OK);
        assert.deepEqual(memory.bytes.slice(OUT, OUT + 92),
            memory.bytes.slice(METRICS + offset, METRICS + offset + 92), `font ${font}`);
    }
    assert.equal(memory.i32(OUT), -11, 'a real font, not a blank one');
});

test('a real child\'s parent is asked to paint itself under it', async()=>{
    const { memory, user32, fns, dispatched, drawn } = overUser32();
    const WS_POPUP = 0x80000000;
    const WS_CHILD = 0x40000000;
    const WS_VISIBLE = 0x10000000;
    // Above the atoms, which a class name at a smaller address would be taken for.
    const CLASS = 0x10100;
    const NAME = 0x10200;
    memory.bytes.set([...'Parent'].map(c=>c.charCodeAt(0)).concat(0), NAME);
    memory.putI32s(CLASS, [0, 0x401000, 0, 0, 0x400000, 0, 0, 0, 0, NAME]);
    assert.notEqual(user32.RegisterClassA.handler([CLASS]), 0);
    const parent = user32.CreateWindowExA.handler(
        [0, NAME, 0, WS_POPUP | WS_VISIBLE, 0, 0, 100, 100, 0, 0, 0x400000, 0]);
    const child = user32.CreateWindowExA.handler(
        [0, NAME, 0, WS_CHILD | WS_VISIBLE, 1, 2, 50, 50, parent, 0, 0x400000, 0]);
    assert.notEqual(child, 0);
    dispatched.length = 0;

    assert.equal(await fns.DrawThemeParentBackground.handler([child, 0x900, 0]), S_OK);
    assert.deepEqual(dispatched.map(({ hwnd, message, wParam, lParam })=>
        [hwnd, message, wParam, lParam]), [
        [parent, WM_ERASEBKGND, 0x900, 0],
        [parent, WM_PRINTCLIENT, 0x900, PRF_CLIENT],
    ]);
    assert.deepEqual(drawn.find(call=>call[0] === 'OffsetViewportOrgEx'),
        ['OffsetViewportOrgEx', 0x900, -1, -2, 0], 'the child sits at (1, 2) in its parent');
    assert.deepEqual(drawn.find(call=>call[0] === 'IntersectClipRect'),
        ['IntersectClipRect', 0x900, 0, 0, 50, 50]);

    dispatched.length = 0;
    assert.equal(await fns.DrawThemeParentBackground.handler([parent, 0x900, 0]), S_OK);
    assert.deepEqual(dispatched, [], 'nothing is behind a top-level window');

    dispatched.length = 0;
    assert.equal(await fns.SetWindowTheme.handler([child, 0, 0]), S_OK);
    assert.deepEqual(dispatched.map(({ hwnd, message })=>[hwnd, message]),
        [[child, WM_THEMECHANGED]], 'to the window, not its parent or its children');
});
