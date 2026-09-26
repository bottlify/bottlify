/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from './messages.js';
import { MSG, RECT, WNDCLASSA, WNDCLASSEXA } from './structs.js';
import { createWindowFunctions, watchDispatch } from './windows.js';

/**
 * Guest addresses the fixtures use: far enough apart that nothing overlaps, and
 * above the atom range, since a pointer whose high word is zero is an atom and
 * not a string.
 */
const CLASS_NAME = 0x10000;
const CLASS_STRUCT = 0x10100;
const TITLE = 0x10200;
const MSG_BUFFER = 0x11000;
const RECT_BUFFER = 0x11100;
const TEXT_BUFFER = 0x11200;
const HEAP_BASE = 0x12000;
/** What the bridge names as the thread whose call is being answered. */
const THREAD = { name: 'main' };
const WH_CBT = 5;
const WH_KEYBOARD = 2;
const HCBT_CREATEWND = 3;
const HOOK_PROC = 0x403000;
const OLDER_HOOK_PROC = 0x403100;

const WNDPROC = 0x401000;
const HINSTANCE = 0x400000;

/** Fills a buffer so that "wrote nothing" is distinguishable from "wrote zero". */
const UNTOUCHED = 0xa5a5a5a5;

const WM_DESTROY = 0x0002;
const WM_NCDESTROY = 0x0082;
const WM_CLOSE = 0x0010;
const WM_QUIT = 0x0012;
const WM_KEYDOWN = 0x0100;
const WM_LBUTTONDOWN = 0x0201;
const WM_CHAR = 0x0102;
const WM_PAINT = 0x000f;
const WM_MOVE = 0x0003;
const WM_SIZE = 0x0005;
const WM_SHOWWINDOW = 0x0018;
const WM_NCACTIVATE = 0x0086;
const WM_USER = 0x0400;

const PM_NOREMOVE = 0;
const PM_REMOVE = 1;

const WS_CHILD = 0x40000000;
const WS_VISIBLE = 0x10000000;

const SW_HIDE = 0;
const SW_SHOW = 5;

const GWL_WNDPROC = -4;
const GWL_HWNDPARENT = -8;
const GWL_STYLE = -16;
const GWL_USERDATA = -21;

const CW_USEDEFAULT = 0x80000000;

/**
 * Guest memory as a flat array. The real memory layer hands back views onto the
 * same bytes, so this one does too.
 */
function fakeMemory(size = 0x13000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        // A copy, like the real memory layer: a fake that hands out a window
        // onto its own bytes invents aliasing bugs rather than finding them.
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
        /** @param {number} address */
        readU32: address=>(bytes[address] | (bytes[address + 1] << 8)
            | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0,
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
        u32(address){
            return (bytes[address] | (bytes[address + 1] << 8)
                | (bytes[address + 2] << 16) | (bytes[address + 3] << 24)) >>> 0;
        },
        /** @param {number} address @param {number} count */
        fill(address, count){
            this.putU32s(address, new Array(count).fill(UNTOUCHED));
        },
    };
}

/** The kernel's handle table, reduced to what a window needs from it. */
function fakeHandles(){
    /** @type {Map<number, { type: string, object: any }>} */
    const entries = new Map();
    let next = 4;
    return {
        entries,
        /** @param {string} type @param {any} object */
        open(type, object){
            const handle = next;
            next += 4;
            entries.set(handle, { type, object });
            return handle;
        },
        /** @param {number} handle */
        close(handle){
            if (!entries.delete(handle))
            {
                throw new Error('Invalid handle');
            }
        },
        /** @param {number} handle */
        typeOf: handle=>entries.get(handle)?.type ?? null,
    };
}

/** Stands in for the bridge's parked token: identity is all that matters. */
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 0x102;
const INFINITE = 0xffffffff;
const QS_ALLINPUT = 0x04ff;
const QS_KEY = 0x0001;
const QS_MOUSEBUTTON = 0x0004;
const QS_POSTMESSAGE = 0x0008;
const QS_INPUT = 0x0007;
const ERROR_INVALID_THREAD_ID = 1444;
const PARKED = Object.freeze({ parked: true });

/**
 * The display a test drives the window manager's painting through: a screen to
 * paint the desktop on, a device context to paint with, and a record of every
 * fill and every showing. `fill` is the draw a program makes (which presents);
 * `fillBackground` is the window manager's own screen background (which does
 * not).
 *
 * @param {{ rect: any, color: number, quiet: boolean }[]} fills
 * @param {number[]} presents
 */
function paintedHost(fills, presents){
    return {
        screen: { width: 640, height: 480, bitsPerPixel: 32 },
        dc: ()=>({ get: ()=>1, release: ()=>{} }),
        draw: {
            fill: (/** @type {any} */ hdc, /** @type {any} */ rect,
                /** @type {number} */ color)=>fills.push({ rect, color, quiet: false }),
            // The manager's own screen background: painted, not shown.
            fillBackground: (/** @type {any} */ hdc, /** @type {any} */ rect,
                /** @type {number} */ color)=>fills.push({ rect, color, quiet: true }),
        },
        present: ()=>presents.push(1),
    };
}

/**
 * @param {Object} [options]
 * @param {boolean} [options.heap] Whether the build has guest memory to put a
 *        CREATESTRUCT in. Without it a window is made and nothing is announced,
 *        which is the degraded path a build with no heap takes.
 * @param {(message: any) => any} [options.reply] What a window procedure answers,
 *        so a test can refuse a window or make the answer arrive late.
 * @param {(args: number[]) => number} [options.waitForObjects] kernel32's wait, faked.
 * @param {() => number} [options.now] The guest clock, for a wait with a deadline.
 * @param {(entry: number, args: number[]) => any} [options.hookReply] What a hook
 *        procedure answers.
 * @param {(id: number) => boolean} [options.threadExists] Which thread identifiers
 *        name a thread of this process, for PostThreadMessage.
 * @param {(message: any) => void} [options.trace] Told every message a procedure receives.
 * @param {boolean} [options.paint] Whether the build has a display to paint the
 *        desktop on, so a test can see what is painted and what is shown.
 */
function setup({
    heap = false, reply, waitForObjects, now, hookReply, threadExists, trace, paint = false,
} = {})
{
    const memory = fakeMemory();
    const handles = fakeHandles();
    const queue = createMessageQueue();
    /** @type {any[]} */
    const dispatched = [];
    /** @type {any[]} */
    const parked = [];
    /** @type {{ entry: number, args: number[], thread: unknown }[]} */
    const called = [];
    /** @type {string[]} */
    const divergences = [];
    /** What a refused call left for GetLastError. @type {number[]} */
    const errors = [];
    /** Resolvers for a waiting call, released a turn at a time by the test. */
    /** @type {(() => void)[]} */
    const idlers = [];
    /** A bump allocator over the fake heap: what is freed matters, not where. */
    let heapNext = HEAP_BASE;
    /** @type {number[]} */
    const released = [];

    /**
     * What the window manager drew on the desktop and when it showed it, for
     * a test that drives the painter. Only collected when `paint` is asked
     * for: a build with no display draws nothing and presents nothing.
     */
    /** @type {{ rect: any, color: number, quiet: boolean }[]} */
    const fills = [];
    /** @type {number[]} */
    const presents = [];
    /** What GetKeyState answers for a key, as a test holds it. @type {Map<number, number>} */
    const keys = new Map();

    /** @type {import('./windows.js').WindowService | null} */
    /** @type {import('./windows.js').WindowService | null} */
    let service = null;
    const fns = createWindowFunctions({
        readMemory: (address, length)=>memory.readMemory(address, length),
        writeMemory: (address, data)=>memory.writeMemory(address, data),
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        handles,
        queue,
        keyState: key=>keys.get(key) ?? 0,
        windowService: handed=>{
            service = handed;
        },
        trace,
        dispatch: (wndProc, message, thread)=>{
            dispatched.push(thread === undefined
                ? { wndProc, ...message } : { wndProc, ...message, thread });
            return reply ? reply(message) : 0x1234;
        },
        call: (entry, args, thread)=>{
            called.push({ entry, args, thread });
            return hookReply ? hookReply(entry, args) : 0;
        },
        callerThread: ()=>THREAD,
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        threadExists,
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        park: ()=>{
            parked.push(true);
            return PARKED;
        },
        idle: ()=>new Promise(resolve=>idlers.push(()=>resolve(undefined))),
        waitForObjects,
        now,
        allocate: heap ? (/** @type {number} */ bytes)=>{
            const at = heapNext;
            heapNext += bytes;
            return at;
        } : undefined,
        release: heap ? (/** @type {number} */ at)=>released.push(at) : undefined,
        ...(paint ? paintedHost(fills, presents) : {}),
    });

    /** Lets every waiting call look at the queue once more. */
    const tick = async()=>{
        const waiting = idlers.splice(0, idlers.length);
        for (const release of waiting)
        {
            release();
        }
        await Promise.resolve();
    };

    return { memory, handles, queue, keys, fns, dispatched, parked, tick, idlers, released,
        called, divergences, errors, fills, presents,
        service: /** @type {import('./windows.js').WindowService} */ (
            /** @type {unknown} */ (service)) };
}

/**
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {{ name?: string, wndProc?: number, classExtra?: number, windowExtra?: number }} [options]
 */
function putClass(memory, options = {}){
    const { name = 'MainWnd', wndProc = WNDPROC, classExtra = 0, windowExtra = 0 } = options;
    memory.putString(CLASS_NAME, name);
    memory.putU32s(CLASS_STRUCT, [
        0x0003,      // style: CS_HREDRAW | CS_VREDRAW
        wndProc,
        classExtra,
        windowExtra,
        HINSTANCE,
        0x11,        // hIcon
        0x22,        // hCursor
        0x33,        // hbrBackground
        0,           // lpszMenuName
        CLASS_NAME,
    ]);
    return CLASS_STRUCT;
}

/**
 * @param {any} fns
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {{ className?: number, style?: number, parent?: number, menu?: number,
 *   x?: number, y?: number, width?: number, height?: number }} [options]
 */
function createWindow(fns, memory, options = {}){
    const {
        className = CLASS_NAME, style = 0, parent = 0, menu = 0,
        x = 10, y = 20, width = 300, height = 200,
    } = options;
    memory.putString(TITLE, 'Main');
    return fns.CreateWindowExA.handler(
        [0, className, TITLE, style, x, y, width, height, parent, menu, HINSTANCE, 0]);
}

/**
 * A class plus a window of it, which almost every test below needs.
 *
 * @param {Parameters<typeof putClass>[1] & Parameters<typeof createWindow>[2]
 *     & { reply?: (message: any) => any, trace?: (message: any) => void,
 *         paint?: boolean }} [options]
 */
function withWindow(options = {}){
    const { reply, trace, paint, ...rest } = options;
    const context = setup({ reply, trace, paint });
    putClass(context.memory, rest);
    context.fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hwnd = createWindow(context.fns, context.memory, rest);
    return { ...context, hwnd };
}

// --- window classes ---

test('RegisterClassA answers with an atom, and refuses the same name twice', ()=>{
    const { memory, fns } = setup();
    putClass(memory);

    const atom = fns.RegisterClassA.handler([CLASS_STRUCT]);
    assert.ok(atom >= 0xc000 && atom <= 0xffff, 'a class atom lives in the dynamic atom range');

    assert.equal(fns.RegisterClassA.handler([CLASS_STRUCT]), 0,
        'a second registration of the same name fails rather than replacing the first');
});

test('a class with no name is not a class', ()=>{
    const { memory, fns } = setup();
    putClass(memory);
    memory.putU32s(CLASS_STRUCT + WNDCLASSA.lpszClassName, [0]);

    assert.equal(fns.RegisterClassA.handler([CLASS_STRUCT]), 0);
});

test('RegisterClassExA reads the shifted offsets, and checks cbSize', ()=>{
    const { memory, fns } = setup();
    memory.putString(CLASS_NAME, 'ExWnd');
    memory.putU32s(CLASS_STRUCT, [
        WNDCLASSEXA.SIZE,
        0x0003,
        WNDPROC,
        0,           // cbClsExtra
        16,          // cbWndExtra
        HINSTANCE,
        0x11, 0x22, 0x33,
        0,
        CLASS_NAME,
        0x44,        // hIconSm
    ]);

    assert.ok(fns.RegisterClassExA.handler([CLASS_STRUCT]) >= 0xc000);

    // Read it back through the classic structure: if the Ex offsets were wrong,
    // the window procedure would come back as the style or the extra count.
    memory.fill(TEXT_BUFFER, WNDCLASSA.SIZE / 4);
    assert.equal(fns.GetClassInfoA.handler([HINSTANCE, CLASS_NAME, TEXT_BUFFER]), 1);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.lpfnWndProc), WNDPROC);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.cbWndExtra), 16);

    memory.putU32s(CLASS_STRUCT + WNDCLASSEXA.cbSize, [WNDCLASSA.SIZE]);
    memory.putString(CLASS_NAME, 'Other');
    assert.equal(fns.RegisterClassExA.handler([CLASS_STRUCT]), 0,
        'a cbSize that is not this structure means the guest compiled against another one');
});

test('GetClassInfoA fills WNDCLASSA at the documented offsets', ()=>{
    const { memory, fns } = setup();
    putClass(memory, { windowExtra: 8 });
    fns.RegisterClassA.handler([CLASS_STRUCT]);

    memory.fill(TEXT_BUFFER, WNDCLASSA.SIZE / 4);
    assert.equal(fns.GetClassInfoA.handler([HINSTANCE, CLASS_NAME, TEXT_BUFFER]), 1);

    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.style), 0x0003);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.lpfnWndProc), WNDPROC);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.cbClsExtra), 0);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.cbWndExtra), 8);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.hInstance), HINSTANCE);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.hCursor), 0x22);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSA.lpszClassName), CLASS_NAME);
});

test('GetClassInfoExA fills the extended structure behind the caller\'s cbSize', ()=>{
    const { memory, fns } = setup();
    putClass(memory, { windowExtra: 8 });
    memory.putU32s(CLASS_STRUCT + WNDCLASSEXA.cbSize, [WNDCLASSEXA.SIZE]);
    memory.putU32s(CLASS_STRUCT + WNDCLASSEXA.hIconSm, [0x44]);
    // The classic fields sit four bytes along in the extended layout.
    memory.putU32s(CLASS_STRUCT + WNDCLASSEXA.style, [0x0003, WNDPROC, 0, 8, HINSTANCE,
        0x11, 0x22, 0x33, 0, CLASS_NAME]);
    assert.notEqual(fns.RegisterClassExA.handler([CLASS_STRUCT]), 0);

    memory.fill(TEXT_BUFFER, WNDCLASSEXA.SIZE / 4);
    memory.putU32s(TEXT_BUFFER + WNDCLASSEXA.cbSize, [WNDCLASSEXA.SIZE]);
    assert.equal(fns.GetClassInfoExA.handler([HINSTANCE, CLASS_NAME, TEXT_BUFFER]), 1);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSEXA.cbSize), WNDCLASSEXA.SIZE, 'left alone');
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSEXA.lpfnWndProc), WNDPROC);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSEXA.cbWndExtra), 8);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSEXA.lpszClassName), CLASS_NAME);
    assert.equal(memory.u32(TEXT_BUFFER + WNDCLASSEXA.hIconSm), 0x44);
    assert.equal(fns.GetClassInfoExA.handler([HINSTANCE, CLASS_NAME, 0]), 0);
});

test('GetClassInfoA on a class nobody registered writes nothing', ()=>{
    const { memory, fns } = setup();
    memory.putString(CLASS_NAME, 'Absent');
    memory.fill(TEXT_BUFFER, WNDCLASSA.SIZE / 4);

    assert.equal(fns.GetClassInfoA.handler([HINSTANCE, CLASS_NAME, TEXT_BUFFER]), 0);
    assert.equal(memory.u32(TEXT_BUFFER), UNTOUCHED,
        'a failed call leaves the guest buffer alone');
});

test('a class is also known by the atom registration returned', ()=>{
    const { memory, fns } = setup();
    putClass(memory);
    const atom = fns.RegisterClassA.handler([CLASS_STRUCT]);

    // Programs pass the atom straight back where a name is declared.
    const hwnd = createWindow(fns, memory, { className: atom });
    assert.ok(hwnd > 0);
    assert.equal(fns.GetClassInfoA.handler([HINSTANCE, atom, TEXT_BUFFER]), 1);
});

test('UnregisterClassA waits until the last window of the class is gone', ()=>{
    const { fns, hwnd, memory } = withWindow();

    assert.equal(fns.UnregisterClassA.handler([CLASS_NAME, HINSTANCE]), 0,
        'a class still in use cannot be taken away from the windows using it');

    fns.DestroyWindow.handler([hwnd]);
    assert.equal(fns.UnregisterClassA.handler([CLASS_NAME, HINSTANCE]), 1);
    assert.equal(fns.UnregisterClassA.handler([CLASS_NAME, HINSTANCE]), 0,
        'and it only unregisters once');

    assert.equal(createWindow(fns, memory), 0, 'the name means nothing afterwards');
});

// --- windows ---

test('a window of a class that was never registered is not created', ()=>{
    const { memory, fns, handles } = setup();
    memory.putString(CLASS_NAME, 'Missing');

    assert.equal(createWindow(fns, memory), 0, 'CreateWindowExA reports failure with NULL');
    assert.equal(handles.entries.size, 0, 'and no handle was spent on it');
});

test('an HWND is a handle from the table', ()=>{
    const { hwnd, handles } = withWindow();

    assert.ok(hwnd > 0);
    assert.equal(handles.entries.get(hwnd)?.type, 'window');
});

test('CW_USEDEFAULT is replaced by a real position and size', ()=>{
    const { fns, memory } = withWindow({});
    const hwnd = createWindow(fns, memory, {
        x: CW_USEDEFAULT, y: CW_USEDEFAULT, width: CW_USEDEFAULT, height: CW_USEDEFAULT,
    });

    fns.GetWindowRect.handler([hwnd, RECT_BUFFER]);
    const width = memory.u32(RECT_BUFFER + RECT.right) - memory.u32(RECT_BUFFER + RECT.left);
    const height = memory.u32(RECT_BUFFER + RECT.bottom) - memory.u32(RECT_BUFFER + RECT.top);
    assert.ok(width > 0 && height > 0, 'a window the system placed still has an extent');
});

test('the two rectangles differ in origin, not in extent', ()=>{
    const { fns, memory, hwnd } = withWindow();

    memory.fill(RECT_BUFFER, RECT.SIZE / 4);
    assert.equal(fns.GetWindowRect.handler([hwnd, RECT_BUFFER]), 1);
    assert.equal(memory.u32(RECT_BUFFER + RECT.left), 10);
    assert.equal(memory.u32(RECT_BUFFER + RECT.top), 20);
    assert.equal(memory.u32(RECT_BUFFER + RECT.right), 310);
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 220);

    assert.equal(fns.GetClientRect.handler([hwnd, RECT_BUFFER]), 1);
    assert.equal(memory.u32(RECT_BUFFER + RECT.left), 0,
        'a client rectangle starts at its own origin');
    assert.equal(memory.u32(RECT_BUFFER + RECT.top), 0);
    assert.equal(memory.u32(RECT_BUFFER + RECT.right), 300);
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 200);
});

test('a rectangle of a window that is gone is not written', ()=>{
    const { fns, memory, hwnd } = withWindow();
    fns.DestroyWindow.handler([hwnd]);

    memory.fill(RECT_BUFFER, RECT.SIZE / 4);
    assert.equal(fns.GetClientRect.handler([hwnd, RECT_BUFFER]), 0);
    assert.equal(memory.u32(RECT_BUFFER), UNTOUCHED);
});

test('every message a procedure receives is told to the trace, whoever sent it', ()=>{
    /** @type {any[]} */
    const told = [];
    const { fns, hwnd } = withWindow({ trace: message=>told.push(message) });
    const before = told.length;
    fns.SendMessageA.handler([hwnd, 0x0401, 7, 9]);
    assert.deepEqual(told.slice(before).map(m=>[m.hwnd, m.message, m.wParam, m.lParam]),
        [[hwnd, 0x0401, 7, 9]]);
});

test('placing a window as the system would moves it and tells the program', ()=>{
    // What a fullscreen device does to the window it presents into. The
    // program re-reads its rectangle on WM_SIZE and clips its cursor to it, so
    // both messages have to arrive, packed the way DefWindowProc packs them.
    // A captioned window, so that the frame it would have is visible in
    // the numbers: placed to a mode, it has none.
    const WS_CAPTION = 0x00c00000;
    const { fns, memory, hwnd, queue, service } = withWindow({ style: WS_CAPTION });
    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 200 - 19 - 2 * 3,
        'framed before placing: a caption and a dialog frame');

    assert.equal(service.place(hwnd, 0, 0, 1024, 768), true);

    fns.GetWindowRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.right), 1024);
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 768);
    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.right), 1024, 'the whole mode is client area');
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 768);

    /** @type {any[]} */
    const told = [];
    for (;;)
    {
        const message = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
        if (!message)
        {
            break;
        }
        told.push(message);
    }
    const move = told.find(message=>message.message === 0x0003);
    const size = told.find(message=>message.message === 0x0005);
    assert.ok(move && size, 'a move and a size are posted');
    assert.equal(size.lParam >>> 0, (768 << 16 | 1024) >>> 0,
        'the client size, height above width');
    assert.equal(size.wParam, 0, 'SIZE_RESTORED: neither minimised nor maximised');
    assert.equal(told.indexOf(move) < told.indexOf(size), true, 'the move before the size');

    assert.equal(service.place(0x9999, 0, 0, 1, 1), false,
        'a window that is not there is not placed');
    assert.deepEqual(service.list().map(entry=>[entry.width, entry.height]), [[1024, 768]]);

    // Placed again where it already is -- what a device reset does -- nothing
    // is said: a program that resets its device on WM_SIZE would otherwise
    // reset it for ever.
    assert.equal(service.place(hwnd, 0, 0, 1024, 768), true);
    assert.equal(queue.peek({ hwnd: null, first: 0, last: 0, remove: true }), null,
        'the same place is no move and no size');
    assert.equal(service.place(hwnd, 0, 0, 800, 600), true);
    const again = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.equal(again?.message, 0x0005, 'a new size is a size alone');
    assert.equal(queue.peek({ hwnd: null, first: 0, last: 0, remove: true }), null);

    // Announced, the same place is still a size: what a mode switch says to
    // the window it lands in, once the device that switched exists.
    assert.equal(service.place(hwnd, 0, 0, 800, 600, { announce: true }), true);
    const said = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.equal(said?.message, 0x0005);
    assert.equal(said?.lParam >>> 0, (600 << 16 | 800) >>> 0);
    assert.equal(queue.peek({ hwnd: null, first: 0, last: 0, remove: true }), null);
});

test('MoveWindow changes both rectangles', ()=>{
    const { fns, memory, hwnd } = withWindow();

    assert.equal(fns.MoveWindow.handler([hwnd, 50, 60, 120, 90, 1]), 1);

    fns.GetWindowRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.left), 50);
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 150);

    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.right), 120);
});

test('CloseWindow minimises rather than closing, and a show restores', ()=>{
    const { fns, hwnd } = withWindow();
    fns.ShowWindow.handler([hwnd, SW_SHOW]);

    assert.equal(fns.CloseWindow.handler([hwnd]), 1);
    assert.equal(fns.IsWindow.handler([hwnd]), 1, 'the window is still there');
    assert.equal(fns.IsIconic.handler([hwnd]), 1, 'minimised');
    assert.equal(fns.ShowWindow.handler([hwnd, SW_SHOW]), 1);
    assert.equal(fns.IsIconic.handler([hwnd]), 0, 'and a show restores it');
    assert.equal(fns.CloseWindow.handler([0x9999]), 0, 'no window, nothing to minimise');
});

test('ShowWindow answers with the visibility it found, not the one it set', ()=>{
    const { fns, hwnd } = withWindow();

    assert.equal(fns.ShowWindow.handler([hwnd, SW_SHOW]), 0, 'it was created hidden');
    assert.equal(fns.ShowWindow.handler([hwnd, SW_SHOW]), 1, 'now it was already visible');
    assert.equal(fns.ShowWindow.handler([hwnd, SW_HIDE]), 1);
    assert.equal(fns.ShowWindow.handler([hwnd, SW_SHOW]), 0);
    assert.equal(fns.ShowWindow.handler([0x9999, SW_SHOW]), 0, 'no window, nothing to report');
});

test('a top-level window\'s menu bar comes out of its client area, as AdjustWindowRect adds it',
    ()=>{
        // user32's window tests: the client rectangle mapped to the screen
        // and grown by AdjustWindowRectEx -- with a menu when the window is
        // not a child and GetMenu names one -- is the window rectangle.
        const WS_OVERLAPPEDWINDOW = 0x00cf0000;
        const WS_POPUP = 0x80000000;
        const HTMENU = 5;
        const WM_NCHITTEST = 0x0084;
        const { fns, memory, dispatched } = withWindow();
        const menu = fns.CreateMenu.handler();
        memory.putU32s(RECT_BUFFER, [0, 0, 640, 480]);
        fns.AdjustWindowRect.handler([RECT_BUFFER, WS_OVERLAPPEDWINDOW, 1]);
        const [left, top, right, bottom] = [0, 4, 8, 12]
            .map(at=>memory.u32(RECT_BUFFER + at) | 0);
        const hwnd = createWindow(fns, memory, { style: WS_OVERLAPPEDWINDOW | WS_VISIBLE, menu,
            x: 0, y: 0, width: right - left, height: bottom - top });
        assert.equal(fns.GetMenu.handler([hwnd]), menu);
        /** @returns {number[]} */
        const client = ()=>{
            fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
            return [memory.u32(RECT_BUFFER + RECT.right), memory.u32(RECT_BUFFER + RECT.bottom)];
        };
        assert.deepEqual(client(), [640, 480], 'the client area asked for');
        const frame = -left;
        const inMenu = ((frame + 19 + 5) << 16 | 100) >>> 0;
        assert.equal(fns.DefWindowProcA.handler([hwnd, WM_NCHITTEST, 0, inMenu]), HTMENU,
            'the bar is the menu\'s part of the frame');

        dispatched.length = 0;
        assert.equal(fns.SetMenu.handler([hwnd, 0]), 1);
        assert.deepEqual(client(), [640, 499], 'a window whose menu goes gets the bar back');
        assert.deepEqual(dispatched.filter(m=>m.message === WM_SIZE).map(m=>m.lParam),
            [(499 << 16 | 640) >>> 0], 'and is told its new size');

        const owned = createWindow(fns, memory, { style: WS_POPUP, parent: hwnd, menu });
        assert.equal(fns.GetMenu.handler([owned]), menu,
            'an owned window is not a child, and its hMenu is a menu');
    });

test('SW_SHOWNA tells a visible window it is shown, where SW_SHOW tells it nothing', ()=>{
    // user32's message tests: WmSHOWNATopVisible is WM_SHOWWINDOW(1) for a
    // top-level window that was already visible, with no activation.
    const SW_SHOWNA = 8;
    const { fns, hwnd, dispatched } = withWindow();
    fns.ShowWindow.handler([hwnd, SW_SHOW]);
    dispatched.length = 0;

    assert.equal(fns.ShowWindow.handler([hwnd, SW_SHOW]), 1);
    assert.deepEqual(dispatched, [], 'nothing changed, so nothing is said');
    assert.equal(fns.ShowWindow.handler([hwnd, SW_SHOWNA]), 1, 'it was visible');
    assert.deepEqual(dispatched.map(({ message, wParam, lParam })=>[message, wParam, lParam]),
        [[WM_SHOWWINDOW, 1, 0]]);
});

test('WS_VISIBLE at creation shows in the style and in ShowWindow', ()=>{
    const { fns, memory } = withWindow();
    const hwnd = createWindow(fns, memory, { style: WS_VISIBLE });

    assert.equal(fns.GetWindowLongA.handler([hwnd, GWL_STYLE]) & WS_VISIBLE, WS_VISIBLE);
    assert.equal(fns.ShowWindow.handler([hwnd, SW_HIDE]), 1);
    assert.equal(fns.GetWindowLongA.handler([hwnd, GWL_STYLE]) & WS_VISIBLE, 0,
        'hiding a window clears the style bit that says it is visible');
});

test('IsWindow tells a destroyed window from a live one, and both from junk', ()=>{
    const { fns, hwnd } = withWindow();

    assert.equal(fns.IsWindow.handler([hwnd]), 1);
    assert.equal(fns.IsWindow.handler([0x9999]), 0);
    assert.equal(fns.DestroyWindow.handler([hwnd]), 1);
    assert.equal(fns.IsWindow.handler([hwnd]), 0);
    assert.equal(fns.DestroyWindow.handler([hwnd]), 0, 'destroying twice fails the second time');
});

test('destroying a parent destroys the children it owned', ()=>{
    const { fns, memory, hwnd } = withWindow();
    const child = createWindow(fns, memory, { style: WS_CHILD, parent: hwnd });

    assert.equal(fns.GetWindowLongA.handler([child, GWL_HWNDPARENT]), hwnd);
    fns.DestroyWindow.handler([hwnd]);

    assert.equal(fns.IsWindow.handler([child]), 0,
        'a child outliving its parent is a handle nobody can ever close');
});

test('window text is set, read back, and truncated to the buffer offered', ()=>{
    // SetWindowText is WM_SETTEXT sent to the window, so the text lands
    // through the procedure -- which here, as in most programs, leaves it to
    // the default one.
    const { fns, memory, hwnd, dispatched } = withWindow({
        reply: (/** @type {any} */ message)=>fns.DefWindowProcA.handler(
            [message.hwnd, message.message, message.wParam, message.lParam]),
    });
    memory.putString(TITLE, 'A Window Title');

    assert.equal(fns.SetWindowTextA.handler([hwnd, TITLE]), 1);
    assert.equal(dispatched.at(-1).message, 0x000c, 'WM_SETTEXT reached the procedure');

    assert.equal(fns.GetWindowTextA.handler([hwnd, TEXT_BUFFER, 64]), 14,
        'the count excludes the terminator');
    assert.equal(memory.readCString(TEXT_BUFFER, 64), 'A Window Title');

    assert.equal(fns.GetWindowTextA.handler([hwnd, TEXT_BUFFER, 5]), 4,
        'four characters and a terminator is all that fits in five bytes');
    assert.equal(memory.readCString(TEXT_BUFFER, 64), 'A Wi');

    memory.fill(TEXT_BUFFER, 1);
    assert.equal(fns.GetWindowTextA.handler([hwnd, TEXT_BUFFER, 0]), 0);
    assert.equal(memory.u32(TEXT_BUFFER), UNTOUCHED,
        'there is no room even for a terminator, so nothing is written');
});

test('SetWindowLongA answers with the value it replaced', ()=>{
    const { fns, hwnd } = withWindow();

    assert.equal(fns.SetWindowLongA.handler([hwnd, GWL_USERDATA, 0xdeadbeef]), 0);
    assert.equal(fns.GetWindowLongA.handler([hwnd, GWL_USERDATA]), 0xdeadbeef);
    assert.equal(fns.SetWindowLongA.handler([hwnd, GWL_USERDATA, 1]), 0xdeadbeef,
        'code that restores what it changed needs the old value back');
});

test('the extra bytes a class asked for are the window\'s own storage', ()=>{
    const { fns, memory } = withWindow({ windowExtra: 8 });
    const first = createWindow(fns, memory);
    const second = createWindow(fns, memory);

    fns.SetWindowLongA.handler([first, 4, 0x1111]);
    assert.equal(fns.GetWindowLongA.handler([first, 4]), 0x1111);
    assert.equal(fns.GetWindowLongA.handler([second, 4]), 0,
        'two windows of one class do not share their extra bytes');

    assert.equal(fns.GetWindowLongA.handler([first, 8]), 0,
        'a DWORD at offset 8 does not fit in 8 bytes of extra');
    assert.equal(fns.SetWindowLongA.handler([first, 8, 0x2222]), 0);
    assert.equal(fns.GetWindowLongA.handler([first, 4]), 0x1111,
        'and the refused write did not spill into the neighbour');
});

test('a window word is a 16-bit view of the same extra bytes', ()=>{
    const { fns, memory } = withWindow({ windowExtra: 8 });
    const hwnd = createWindow(fns, memory);

    assert.equal(fns.SetWindowWord.handler([hwnd, 0, 0x1234]), 0);
    assert.equal(fns.SetWindowWord.handler([hwnd, 2, 0x5678]), 0);
    assert.equal(fns.GetWindowWord.handler([hwnd, 0]), 0x1234);
    assert.equal(fns.GetWindowLongA.handler([hwnd, 0]), 0x56781234,
        'the two words are the halves of the long at the same offset');
    assert.equal(fns.SetWindowWord.handler([hwnd, 0, 0x10001]), 0x1234, 'answers the old word');
    assert.equal(fns.GetWindowWord.handler([hwnd, 0]), 1, 'and keeps only a word');
    assert.equal(fns.GetWindowWord.handler([hwnd, 7]), 0, 'a word at 7 does not fit in 8');
    assert.equal(fns.SetWindowWord.handler([hwnd, 7, 1]), 0);
    assert.deepEqual([fns.GetWindowWord.argBytes, fns.SetWindowWord.argBytes], [8, 12]);
});

test('a class that asked for no extra bytes has none', ()=>{
    const { fns, hwnd } = withWindow();

    assert.equal(fns.SetWindowLongA.handler([hwnd, 0, 0x1234]), 0);
    assert.equal(fns.GetWindowLongA.handler([hwnd, 0]), 0);
});

test('the first window shown makes the application active before the call returns', ()=>{
    // user32's message tests: WmCreatePopupSeq (CreateWindow with WS_VISIBLE)
    // and WmShowOverlappedSeq (ShowWindow on a hidden window) both follow
    // WM_SHOWWINDOW(1) with WM_ACTIVATEAPP(1), WM_NCACTIVATE(1),
    // WM_ACTIVATE(WA_ACTIVE) and WM_SETFOCUS, all sent. WM_ACTIVATEAPP goes
    // to every top-level window of the application, a hidden one too; a
    // window made hidden is activated by nothing until it is shown.
    const WM_ACTIVATEAPP = 0x001c;
    const WM_ACTIVATE = 0x0006;
    const WM_SETFOCUS = 0x0007;
    const { memory, fns, dispatched, queue } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hidden = createWindow(fns, memory);
    assert.deepEqual(dispatched.map(entry=>entry.message), [WM_NCCREATE, WM_CREATE]);
    assert.equal(fns.GetActiveWindow.handler(), 0, 'a window made hidden is not activated');
    dispatched.length = 0;

    const shown = createWindow(fns, memory, { style: WS_VISIBLE });
    assert.deepEqual(dispatched.map(({ hwnd, message, wParam })=>[hwnd, message, wParam]), [
        [shown, WM_NCCREATE, 0], [shown, WM_CREATE, 0], [shown, WM_SIZE, 0], [shown, WM_MOVE, 0],
        [shown, WM_SHOWWINDOW, 1], [shown, WM_ACTIVATEAPP, 1], [hidden, WM_ACTIVATEAPP, 1],
        [shown, WM_NCACTIVATE, 1], [shown, WM_ACTIVATE, 1], [shown, WM_SETFOCUS, 0],
    ]);
    assert.deepEqual(dispatched.slice(5).map(entry=>entry.lParam), [0, 0, 0, 0, 0],
        'no thread of this program had the activation, and no window');
    assert.equal(queue.depth(), 0, 'nothing of it was posted');
    assert.equal(fns.GetActiveWindow.handler(), shown);
    assert.equal(fns.GetFocus.handler(), shown);

    // With the active window gone nothing of the application is active, and
    // the next window shown makes it the active application again.
    fns.DestroyWindow.handler([shown]);
    dispatched.length = 0;
    fns.ShowWindow.handler([hidden, SW_SHOW]);
    assert.deepEqual(dispatched.map(({ hwnd, message, wParam })=>[hwnd, message, wParam]), [
        [hidden, WM_SHOWWINDOW, 1], [hidden, WM_ACTIVATEAPP, 1], [hidden, WM_NCACTIVATE, 1],
        [hidden, WM_ACTIVATE, 1], [hidden, WM_SETFOCUS, 0], [hidden, WM_SIZE, 0],
    ], 'with no window active, the application is activated again');
});

test('a window that takes the activation is told, and the one it replaced is told it lost it', ()=>{
    // user32's message tests, SetActiveWindowSeq2: the window losing the
    // activation hears WM_NCACTIVATE(0) and WM_ACTIVATE(WA_INACTIVE), the one
    // gaining it WM_NCACTIVATE(1) and WM_ACTIVATE(WA_ACTIVE), and then the
    // focus moves -- WM_KILLFOCUS, WM_SETFOCUS -- all sent. A second window
    // of the same application is no news to the application: no
    // WM_ACTIVATEAPP. A program that shows a second window, or makes another
    // render window for a mode change, activates its mouse and clips its
    // cursor only in the window it has been told is active.
    const WM_ACTIVATE = 0x0006;
    const WM_SETFOCUS = 0x0007;
    const WM_KILLFOCUS = 0x0008;
    const WA_ACTIVE = 1;
    const WA_INACTIVE = 0;
    const context = setup();
    putClass(context.memory);
    context.fns.RegisterClassA.handler([CLASS_STRUCT]);
    const first = createWindow(context.fns, context.memory, { style: WS_VISIBLE });
    context.dispatched.length = 0;
    const second = createWindow(context.fns, context.memory, { style: WS_VISIBLE });

    assert.deepEqual(context.dispatched.map(({ hwnd, message, wParam, lParam })=>
        [hwnd, message, wParam, lParam >>> 0]), [
        [first, WM_NCACTIVATE, 0, 0], [first, WM_ACTIVATE, WA_INACTIVE, second],
        [second, WM_NCACTIVATE, 1, 0], [second, WM_ACTIVATE, WA_ACTIVE, first],
        [first, WM_KILLFOCUS, second, 0], [second, WM_SETFOCUS, first, 0],
    ]);
    assert.equal(context.queue.depth(), 0, 'sent before the call returns, none of it posted');
});

test('SetFocus into another window sends the activation set, then the focus', ()=>{
    const context = setup();
    putClass(context.memory);
    context.fns.RegisterClassA.handler([CLASS_STRUCT]);
    const first = createWindow(context.fns, context.memory, { style: WS_VISIBLE });
    const second = createWindow(context.fns, context.memory, { style: WS_VISIBLE });
    context.fns.SetFocus.handler([second]);
    context.dispatched.length = 0;

    context.fns.SetFocus.handler([first]);

    assert.deepEqual(context.dispatched.map(call=>[call.hwnd, call.message, call.wParam]), [
        [second, WM_NCACTIVATE, 0], [second, 0x0006, 0], [first, WM_NCACTIVATE, 1],
        [first, 0x0006, 1], [second, 0x0008, first], [first, 0x0007, second],
    ], 'sent before the call returns: NCACTIVATE, ACTIVATE, then KILLFOCUS and SETFOCUS');
});

test('a press activates its window as the program takes it, unless the window says not to', ()=>{
    const WM_MOUSEACTIVATE = 0x0021;
    const MA_NOACTIVATEANDEAT = 4;
    /** @type {number} */
    let refuse = 0;
    const context = setup({
        reply: (/** @type {any} */ message)=>(message.message === WM_MOUSEACTIVATE
            && message.hwnd === refuse ? MA_NOACTIVATEANDEAT : 0),
    });
    putClass(context.memory);
    context.fns.RegisterClassA.handler([CLASS_STRUCT]);
    const first = createWindow(context.fns, context.memory, { style: WS_VISIBLE });
    const second = createWindow(context.fns, context.memory, { style: WS_VISIBLE });
    while (context.queue.depth() > 0)
    {
        context.queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    }
    assert.equal(context.fns.GetActiveWindow.handler(), second);

    // The window procedure answers zero, so the default procedure's
    // MA_ACTIVATE stands: activated by the click, and the click delivered.
    context.dispatched.length = 0;
    context.queue.post({ hwnd: first, message: WM_LBUTTONDOWN, wParam: 1, lParam: 0x00050005 });
    context.fns.PeekMessageA.handler([MSG_BUFFER, 0, WM_LBUTTONDOWN, WM_LBUTTONDOWN, PM_REMOVE]);
    assert.equal(context.memory.u32(MSG_BUFFER + 4), WM_LBUTTONDOWN, 'the press is delivered');
    assert.equal(context.fns.GetActiveWindow.handler(), first);
    const asked = context.dispatched.find(call=>call.message === WM_MOUSEACTIVATE);
    assert.equal(asked?.wParam, first, 'asked with its top-level window');
    assert.equal(asked?.lParam >>> 0, (WM_LBUTTONDOWN << 16 | 1) >>> 0, 'and the hit and message');
    assert.equal(context.dispatched.find(call=>call.hwnd === first && call.message === 0x0006)
        ?.wParam, 2, 'WA_CLICKACTIVE');

    // One that refuses and eats the click keeps things as they were.
    refuse = second;
    context.queue.post({ hwnd: second, message: WM_LBUTTONDOWN, wParam: 1, lParam: 0 });
    assert.equal(context.fns.PeekMessageA.handler(
        [MSG_BUFFER, 0, WM_LBUTTONDOWN, WM_LBUTTONDOWN, PM_REMOVE]), 0, 'eaten');
    assert.equal(context.fns.GetActiveWindow.handler(), first, 'and not activated');
});

// --- the message queue ---

test('PostMessageA refuses a window that has been destroyed', ()=>{
    const { fns, queue, hwnd } = withWindow();
    fns.DestroyWindow.handler([hwnd]);
    const depth = queue.depth();

    assert.equal(fns.PostMessageA.handler([hwnd, WM_USER, 0, 0]), 0);
    assert.equal(queue.depth(), depth, 'and queued nothing on the way out');
});

test('PostMessageA with no window posts to the thread', ()=>{
    const { fns, queue } = setup();

    assert.equal(fns.PostMessageA.handler([0, WM_USER, 1, 2]), 1);
    assert.equal(queue.depth(), 1);
});

test('PeekMessageA on an empty queue reports nothing and writes nothing', ()=>{
    const { fns, memory } = setup();
    memory.fill(MSG_BUFFER, MSG.SIZE / 4);

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 0);
    assert.equal(memory.u32(MSG_BUFFER), UNTOUCHED);
});

test('PeekMessageA writes MSG at the documented offsets', ()=>{
    const { fns, memory, queue, hwnd } = withWindow();
    queue.post({ hwnd, message: WM_USER, wParam: 0x1111, lParam: 0x2222, time: 7, x: 3, y: 4 });

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.hwnd), hwnd);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_USER);
    assert.equal(memory.u32(MSG_BUFFER + MSG.wParam), 0x1111);
    assert.equal(memory.u32(MSG_BUFFER + MSG.lParam), 0x2222);
    assert.equal(memory.u32(MSG_BUFFER + MSG.time), 7);
    assert.equal(memory.u32(MSG_BUFFER + MSG.ptX), 3);
    assert.equal(memory.u32(MSG_BUFFER + MSG.ptY), 4);
});

test('PM_NOREMOVE leaves the message for whoever asks next', ()=>{
    const { fns, queue, hwnd } = withWindow();
    queue.post({ hwnd, message: WM_USER, wParam: 0, lParam: 0 });

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_NOREMOVE]), 1);
    assert.equal(queue.depth(), 1, 'looking is not taking');
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(queue.depth(), 0);
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 0);
});

test('PeekMessageA only reports messages for the window it was asked about', ()=>{
    const { fns, memory, queue, hwnd } = withWindow();
    const other = createWindow(fns, memory);
    queue.post({ hwnd: other, message: WM_USER, wParam: 0, lParam: 0 });

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, hwnd, 0, 0, PM_REMOVE]), 0);
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, other, 0, 0, PM_REMOVE]), 1);
});

test('a message loop runs until PostQuitMessage ends it', ()=>{
    const { fns, memory, queue, hwnd } = withWindow();
    queue.post({ hwnd, message: WM_USER, wParam: 0, lParam: 0 });

    assert.equal(fns.GetMessageA.handler([MSG_BUFFER, 0, 0, 0]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_USER);

    fns.PostQuitMessage.handler([3]);

    assert.equal(fns.GetMessageA.handler([MSG_BUFFER, 0, 0, 0]), 0,
        'zero is the only thing that ends a message loop');
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_QUIT);
    assert.equal(memory.u32(MSG_BUFFER + MSG.wParam), 3,
        'carrying the exit code the program chose');
});

test('GetMessageA waits for a message rather than reporting an empty queue', async()=>{
    const { fns, queue, memory, tick } = setup();

    // A message loop with nothing to do blocks. The wait is the host's, so what
    // comes back is a promise, and the bridge suspends the guest thread on it.
    const answer = /** @type {Promise<number>} */ (
        /** @type {any} */ (fns.GetMessageA.handler([MSG_BUFFER, 0, 0, 0])));
    assert.equal(typeof answer.then, 'function');

    let settled = false;
    answer.then(()=>{
        settled = true;
    });
    await tick();
    assert.equal(settled, false, 'still nothing to give it');

    queue.post({ hwnd: 0, message: 0x0401, wParam: 7, lParam: 8 });
    await tick();
    await tick();

    assert.equal(await answer, 1);
    // The message was written into the guest's buffer before the call answered,
    // which is the half a parked return value cannot carry.
    assert.equal(memory.readU32(MSG_BUFFER + 4), 0x0401);
    assert.equal(memory.readU32(MSG_BUFFER + 8), 7);
});

test('MsgWaitForMultipleObjects answers a ready handle first, then a queued message', ()=>{
    /** @type {number[][]} */
    const asked = [];
    let handleAnswer = WAIT_TIMEOUT;
    const { fns, queue } = setup({ waitForObjects: args=>{
        asked.push(args);
        return handleAnswer;
    } });

    assert.equal(fns.MsgWaitForMultipleObjects.handler([2, 0x100, 0, 0, QS_ALLINPUT]), WAIT_TIMEOUT,
        'a poll with nothing ready times out');
    assert.deepEqual(asked, [[2, 0x100, 0, 0]], 'and the handles were polled, not waited on');

    queue.post({ hwnd: 0, message: 0x0401, wParam: 0, lParam: 0 });
    assert.equal(fns.MsgWaitForMultipleObjects.handler([2, 0x100, 0, INFINITE, QS_ALLINPUT]), 2,
        'a message is reported as the index past the last handle');
    assert.equal(queue.depth(), 1, 'and left in the queue for the program to retrieve');

    handleAnswer = 1;
    assert.equal(fns.MsgWaitForMultipleObjects.handler([2, 0x100, 0, INFINITE, QS_ALLINPUT]), 1,
        'a handle that is ready wins over the message');
});

test('MsgWaitForMultipleObjects with no handles is a sleep the queue can cut short', async()=>{
    let clock = 1000;
    const { fns, queue, tick } = setup({ now: ()=>clock });

    const answer = /** @type {Promise<number>} */ (/** @type {any} */ (
        fns.MsgWaitForMultipleObjects.handler([0, 0, 0, 500, QS_ALLINPUT])));
    assert.equal(typeof answer.then, 'function', 'the thread is not stopped for good');
    await tick();
    queue.post({ hwnd: 0, message: 0x0401, wParam: 0, lParam: 0 });
    await tick();
    await tick();
    assert.equal(await answer, WAIT_OBJECT_0, 'zero handles: the message is index zero');

    queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    const expired = /** @type {Promise<number>} */ (/** @type {any} */ (
        fns.MsgWaitForMultipleObjects.handler([0, 0, 0, 500, QS_ALLINPUT])));
    await tick();
    clock += 600;
    await tick();
    await tick();
    assert.equal(await expired, WAIT_TIMEOUT, 'and the deadline is kept on the guest clock');
});

test('MsgWaitForMultipleObjects wakes for input that arrived since the queue was last looked at',
    ()=>{
        // user32's message tests, step by step: a posted message ends a
        // zero-time wait for QS_POSTMESSAGE until a PeekMessage has seen it,
        // taken or not, and a new post ends it again; MWMO_INPUTAVAILABLE ends
        // it for a message already seen.
        const { fns, hwnd } = withWindow();
        const post = ()=>fns.PostMessageA.handler([hwnd, WM_USER, 0, 0]);
        /** @param {number} [inputAvailable] */
        const wait = (inputAvailable = 0)=>fns.MsgWaitForMultipleObjects.handler(
            [0, 0, 0, 0, QS_POSTMESSAGE, inputAvailable]);
        /** @param {number} remove */
        const peek = remove=>fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, remove]);

        assert.equal(wait(), WAIT_TIMEOUT);
        post();
        assert.equal(wait(), WAIT_OBJECT_0);
        assert.equal(wait(), WAIT_OBJECT_0, 'asking is not a look');
        assert.equal(peek(PM_REMOVE), 1);
        assert.equal(wait(), WAIT_TIMEOUT);
        post();
        assert.equal(wait(), WAIT_OBJECT_0);
        assert.equal(peek(PM_NOREMOVE), 1);
        assert.equal(wait(), WAIT_TIMEOUT, 'a message seen and left is no longer new');
        post();
        assert.equal(wait(), WAIT_OBJECT_0, 'a new one is');
        assert.equal(peek(PM_REMOVE), 1);
        assert.equal(peek(PM_REMOVE), 1);

        post();
        assert.equal(peek(PM_NOREMOVE), 1);
        assert.equal(wait(1), WAIT_OBJECT_0, 'MWMO_INPUTAVAILABLE: seen or not, it is there');
        assert.equal(fns.MsgWaitForMultipleObjects.handler([0, 0, 0, 0, QS_KEY]), WAIT_TIMEOUT,
            'and only the kinds the wake mask names wake it');
    });

test('MsgWaitForMultipleObjects on an event ends when a message arrives while it waits',
    async()=>{
        // As documented: the wait ends when an object is signalled or input
        // arrives. The event is polled on every turn rather than handed to
        // kernel32's wait, which would hold the thread past the message.
        const HANDLES = 0x11800;
        let ready = false;
        /** @type {number[][]} */
        const asked = [];
        const { fns, handles, memory, queue, tick } = setup({ waitForObjects: args=>{
            asked.push(args);
            if (args[3] !== 0)
            {
                return /** @type {any} */ (PARKED);
            }
            return ready ? WAIT_OBJECT_0 : WAIT_TIMEOUT;
        } });
        memory.putU32s(HANDLES, [handles.open('event', {})]);
        /** @returns {Promise<number>} */
        const waiting = ()=>/** @type {any} */ (fns.MsgWaitForMultipleObjects.handler(
            [1, HANDLES, 0, INFINITE, QS_ALLINPUT]));

        const first = waiting();
        assert.equal(typeof first.then, 'function');
        await tick();
        queue.post({ hwnd: 0, message: 0x0401, wParam: 0, lParam: 0 });
        await tick();
        assert.equal(await first, WAIT_OBJECT_0 + 1, 'the message, past the one handle');
        queue.peek({ hwnd: null, first: 0, last: 0, remove: true });

        const second = waiting();
        await tick();
        ready = true;
        await tick();
        assert.equal(await second, WAIT_OBJECT_0, 'and the event, when it is the one');
        assert.ok(asked.every(args=>args[3] === 0), 'the handles were only ever polled');

        ready = false;
        assert.equal(fns.MsgWaitForMultipleObjects.handler(
            [1, HANDLES, 0, INFINITE, QS_ALLINPUT, 0, 1]), PARKED,
        'an alertable wait is kernel32\'s, whose wait an APC can end');

        memory.putU32s(HANDLES, [handles.open('process', {})]);
        ready = false;
        assert.equal(fns.MsgWaitForMultipleObjects.handler([1, HANDLES, 0, INFINITE, QS_ALLINPUT]),
            PARKED, 'a process is kernel32\'s to wait on');
        assert.equal(asked.at(-1)?.[3], INFINITE);
    });

test('with fWaitAll the handles and the input together end the wait, and neither alone',
    async()=>{
        // As documented for fWaitAll: complete only when every object is
        // signalled and an input event has been received -- and the objects
        // are not taken before then.
        const HANDLES = 0x11800;
        let ready = false;
        /** @type {number[][]} */
        const asked = [];
        const { fns, handles, memory, queue, tick } = setup({ waitForObjects: args=>{
            asked.push(args);
            return ready ? WAIT_OBJECT_0 : WAIT_TIMEOUT;
        } });
        memory.putU32s(HANDLES, [handles.open('event', {}), handles.open('event', {})]);

        ready = true;
        assert.equal(fns.MsgWaitForMultipleObjects.handler([2, HANDLES, 1, 0, QS_ALLINPUT]),
            WAIT_TIMEOUT, 'the handles alone');
        assert.deepEqual(asked, [], 'and they were not taken without the input');

        ready = false;
        queue.post({ hwnd: 0, message: 0x0401, wParam: 0, lParam: 0 });
        assert.equal(fns.MsgWaitForMultipleObjects.handler([2, HANDLES, 1, 0, QS_ALLINPUT]),
            WAIT_TIMEOUT, 'the input alone');
        assert.deepEqual(asked, [[2, HANDLES, 1, 0]], 'the set was asked for all at once');

        const both = /** @type {Promise<number>} */ (/** @type {any} */ (
            fns.MsgWaitForMultipleObjects.handler([2, HANDLES, 1, INFINITE, QS_ALLINPUT])));
        await tick();
        ready = true;
        await tick();
        assert.equal(await both, WAIT_OBJECT_0, 'both: the set, answered for all of it');
    });

/**
 * Retrieves and validates until the queue is empty, which runs a paint pass to
 * its end -- and is where the desktop is shown, if it was marked painted.
 *
 * @param {any} fns @param {number} hwnd
 */
function pump(fns, hwnd){
    for (let guard = 0; guard < 32; guard++)
    {
        if (fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]) === 0)
        {
            return;
        }
        fns.ValidateRect.handler([hwnd, 0]);
    }
    throw new Error('the queue never drained');
}

test('a window appearing paints the desktop but does not present it as a frame', ()=>{
    // The desktop colour is the window manager's own background, not a
    // picture the program drew. Presenting it handed the display a blank
    // screen as the first frame -- the frame a launcher hides its loading
    // screen on -- before the program had presented anything. The colour is
    // still painted underneath, so whatever the program draws shows over it.
    const { fns, hwnd, fills, presents } = withWindow({ paint: true });
    fns.ShowWindow.handler([hwnd, SW_SHOW]);
    pump(fns, hwnd);

    assert.equal(fills.length, 1, 'the desktop was painted once');
    assert.equal(fills[0].color, 0x808080, 'in the desktop colour');
    assert.equal(fills[0].quiet, true, 'through the paint that does not present');
    assert.deepEqual(presents, [], 'and was not presented as a frame');
});

test('uncovering the desktop presents it, because a window no longer covers it', ()=>{
    // The other direction, and it is not the same case: something the program
    // had on the screen left a hole, and the desktop showing through that hole
    // is a picture worth a frame.
    const { fns, hwnd, presents } = withWindow({ paint: true });
    fns.ShowWindow.handler([hwnd, SW_SHOW]);
    pump(fns, hwnd);
    fns.ShowWindow.handler([hwnd, SW_HIDE]);
    pump(fns, hwnd);

    assert.ok(presents.length >= 1, 'the desktop under the closed window is shown');
});

test('a window with an area to paint is handed WM_PAINT when nothing else is queued', ()=>{
    // Made up at retrieval, as Windows does: never posted, so a hundred
    // invalidations are one paint, and the area stays until BeginPaint clears
    // it -- a look that does not remove finds the same paint again.
    const { fns, memory, queue, hwnd, dispatched } = withWindow();
    const announced = dispatched.length;
    fns.ShowWindow.handler([hwnd, SW_SHOW]);
    // Sent, not posted: the procedure hears WM_SHOWWINDOW first and its own
    // size second, both before this call returns, because a program measures
    // the window in the code that follows it. Posting either one leaves the
    // text rasterised for whatever default the program started with.
    assert.deepEqual(dispatched.slice(announced).map(entry=>entry.message),
        [WM_SHOWWINDOW, 0x001c, WM_NCACTIVATE, 0x0006, 0x0007, WM_SIZE],
        'shown: the show message, the activation, then the size');
    assert.equal(dispatched[announced].wParam, 1, 'TRUE: the window is being shown');
    // Showing a window is the first thing that paints it.
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_PAINT, 'a shown window paints');
    fns.ValidateRect.handler([hwnd, 0]);
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 0,
        'nothing to paint');

    fns.InvalidateRect.handler([hwnd, 0, 0]);
    fns.InvalidateRect.handler([hwnd, 0, 0]);
    queue.post({ hwnd, message: WM_USER, wParam: 0, lParam: 0 });
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_USER, 'a posted message comes first');

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_NOREMOVE]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_PAINT);
    assert.equal(memory.u32(MSG_BUFFER + MSG.hwnd), hwnd);
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_PAINT,
        'once, however many invalidations');

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0x100, 0x200, PM_REMOVE]), 0,
        'a range that excludes WM_PAINT does not get one');
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1,
        'still there: retrieving does not paint');
    fns.DefWindowProcA.handler([hwnd, WM_PAINT, 0, 0]);
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 0,
        'the default procedure validates what nobody painted');
});

test('a paint dispatched to a window with no procedure is validated as the default one would', ()=>{
    // A control of a system class has no procedure here. Its WM_PAINT still
    // has to go somewhere that clears the area, or a program pumping with
    // PeekMessage retrieves the same paint for ever and never gets back to
    // its work -- which looks like a hang from outside.
    const { fns, memory, hwnd } = withWindow({ wndProc: 0 });
    fns.ShowWindow.handler([hwnd, SW_SHOW]);
    fns.InvalidateRect.handler([hwnd, 0, 0]);
    // The window has no procedure, so the sent show messages go nowhere. The
    // paint it still owes is made up at retrieval.
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_PAINT);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0);
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 0,
        'dispatched once, the area is clean');
});

test('ShowWindow answers only after the procedures it sent to have run', async()=>{
    // The failure this prevents: answering the host call while a procedure it
    // sent to is still pending hands control back to the guest, which reuses
    // its own stack under the procedure that is still standing on it.
    /** @type {(value: number) => void} */
    let answer = ()=>{};
    const pending = new Promise(resolve=>{
        answer = resolve;
    });
    const { fns, dispatched, hwnd } = withWindow({
        reply: message=>message.message === WM_SHOWWINDOW ? pending : 0,
    });

    const result = fns.ShowWindow.handler([hwnd, SW_SHOW]);
    assert.equal(typeof result.then, 'function', 'the show message is still running');
    assert.deepEqual(dispatched.map(entry=>entry.message), [WM_SHOWWINDOW],
        'and the activation and the size wait behind it');

    answer(0);
    assert.equal(await result, 0, 'SW_SHOW on a hidden window answers the state it found');
    assert.deepEqual(dispatched.map(entry=>entry.message),
        [WM_SHOWWINDOW, 0x001c, WM_NCACTIVATE, 0x0006, 0x0007, WM_SIZE],
        'the activation and the size went once the show message was answered');
});

test('WaitMessage yields until there is something to retrieve, and takes nothing', async()=>{
    const { fns, queue, tick, hwnd } = withWindow();
    const answer = /** @type {Promise<number>} */ (
        /** @type {any} */ (fns.WaitMessage.handler()));
    assert.equal(typeof answer.then, 'function', 'nothing to retrieve: it waits');
    let settled = false;
    answer.then(()=>{
        settled = true;
    });
    await tick();
    assert.equal(settled, false);

    queue.post({ hwnd, message: WM_USER, wParam: 0, lParam: 0 });
    await tick();
    await tick();
    assert.equal(await answer, 1);
    assert.equal(queue.depth(), 1, 'the message is still there for the pump');
    assert.equal(fns.WaitMessage.handler(), 1, 'and with one waiting it answers at once');
    assert.equal(fns.WaitMessage.argBytes, 0);
});

test('GetMessageA reports an error for a window filter that names nothing', ()=>{
    const { fns, parked } = setup();

    assert.equal(fns.GetMessageA.handler([MSG_BUFFER, 0x9999, 0, 0]), -1,
        'minus one, which is why a loop testing the result against zero is a bug');
    assert.deepEqual(parked, [], 'an error is not a reason to wait');
});

test('TranslateMessage turns a key down into a character message', ()=>{
    const { fns, memory, queue, hwnd } = withWindow();
    memory.putU32s(MSG_BUFFER, [hwnd, WM_KEYDOWN, 0x41, 0x001e0001, 0, 0, 0]);

    assert.notEqual(fns.TranslateMessage.handler([MSG_BUFFER]), 0);

    const character = queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.equal(character?.message, WM_CHAR);
    assert.equal(character?.wParam, 0x61, 'an unmodified letter key produces the lowercase form');
    assert.equal(character?.lParam, 0x001e0001, 'the key data travels with it');
    assert.equal(character?.hwnd, hwnd);
});

test('TranslateMessage makes the character the held modifiers make, as ToUnicode would', ()=>{
    const { fns, memory, queue, keys, hwnd } = withWindow();
    /** @param {number} vk */
    const typed = vk=>{
        memory.putU32s(MSG_BUFFER, [hwnd, WM_KEYDOWN, vk, 0x00020001, 0, 0, 0]);
        fns.TranslateMessage.handler([MSG_BUFFER]);
        return queue.peek({ hwnd: null, first: 0, last: 0, remove: true })?.wParam;
    };

    keys.set(0x10, 0x8000);
    assert.equal(typed(0x41), 0x41, 'shift and a letter: the capital');
    assert.equal(typed(0x31), 0x21, 'shift and 1: the exclamation mark');
    keys.clear();
    keys.set(0x14, 0x0001);
    assert.equal(typed(0x41), 0x41, 'caps lock on');
    keys.clear();
    keys.set(0x11, 0x8000);
    assert.equal(typed(0x43), 0x03, 'control and C: its control code');
    keys.clear();
    assert.equal(typed(0x6b), 0x2b, 'the keypad\'s plus');
    assert.equal(typed(0xbf), 0x2f, 'and the slash key, which the old fallback had no row for');
});

test('TranslateMessage leaves alone what it cannot translate', ()=>{
    const { fns, memory, queue, hwnd } = withWindow();

    memory.putU32s(MSG_BUFFER, [hwnd, WM_USER, 0, 0, 0, 0, 0]);
    assert.equal(fns.TranslateMessage.handler([MSG_BUFFER]), 0);
    assert.equal(queue.depth(), 0);

    // A key that produces no character is still a key message, and the
    // documented return says so whether or not anything was posted.
    memory.putU32s(MSG_BUFFER, [hwnd, WM_KEYDOWN, 0x70, 0, 0, 0, 0]); // VK_F1
    assert.notEqual(fns.TranslateMessage.handler([MSG_BUFFER]), 0);
    assert.equal(queue.depth(), 0);
});

test('EnumChildWindows walks every descendant until the callback says stop', async()=>{
    const ENUMPROC = 0x405000;
    const { fns, memory, called } = setup({ hookReply: ()=>1 });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hwnd = createWindow(fns, memory);
    const child = createWindow(fns, memory, { parent: hwnd, style: WS_CHILD });
    const grandchild = createWindow(fns, memory, { parent: child, style: WS_CHILD });
    const second = createWindow(fns, memory, { parent: hwnd, style: WS_CHILD });
    createWindow(fns, memory);

    assert.equal(fns.EnumChildWindows.argBytes, 12);
    assert.equal(await fns.EnumChildWindows.handler([hwnd, ENUMPROC, 0x77]), 1);
    assert.deepEqual(called.map(one=>one.args), [
        [child, 0x77], [grandchild, 0x77], [second, 0x77],
    ], 'children, their children, and never the other top-level window');
    assert.ok(called.every(one=>one.entry === ENUMPROC && one.thread === THREAD));

    const stopping = setup({ hookReply: ()=>0 });
    putClass(stopping.memory);
    stopping.fns.RegisterClassA.handler([CLASS_STRUCT]);
    const top = createWindow(stopping.fns, stopping.memory);
    createWindow(stopping.fns, stopping.memory, { parent: top, style: WS_CHILD });
    createWindow(stopping.fns, stopping.memory, { parent: top, style: WS_CHILD });
    await stopping.fns.EnumChildWindows.handler([top, ENUMPROC, 0]);
    assert.equal(stopping.called.length, 1, 'FALSE from the callback ends the walk');
});

test('DispatchMessageA reports what it would have called, and its answer', ()=>{
    const { fns, memory, dispatched, hwnd } = withWindow();
    memory.putU32s(MSG_BUFFER, [hwnd, WM_USER, 1, 2, 5, 0, 0]);

    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0x1234);
    assert.deepEqual(dispatched,
        [{ wndProc: WNDPROC, hwnd, message: WM_USER, wParam: 1, lParam: 2, time: 5 }]);
});

test('DispatchMessageA has nothing to call for a thread message or a stale window', ()=>{
    const { fns, memory, dispatched } = withWindow();

    memory.putU32s(MSG_BUFFER, [0, WM_USER, 0, 0, 0, 0, 0]);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0);

    memory.putU32s(MSG_BUFFER, [0x9999, WM_USER, 0, 0, 0, 0, 0]);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0);

    assert.deepEqual(dispatched, [], 'neither one names a window procedure');
});

test('a WM_TIMER calls the TIMERPROC in its lParam only when a timer set it there', ()=>{
    const { fns, memory, dispatched, hwnd, queue } = withWindow();
    const TIMERPROC = 0x405500;
    queue.setTimer(hwnd, 3, 50, TIMERPROC);

    memory.putU32s(MSG_BUFFER, [hwnd, 0x0113, 3, TIMERPROC, 77, 0, 0]);
    fns.DispatchMessageA.handler([MSG_BUFFER]);
    assert.deepEqual(dispatched.map(call=>[call.wndProc, call.lParam]), [[TIMERPROC, 77]],
        'the timer\'s own procedure, with the tick count');

    // Posted by anyone, naming an address no timer registered.
    memory.putU32s(MSG_BUFFER, [hwnd, 0x0113, 3, 0x0bad0000, 0, 0, 0]);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0);
    memory.putU32s(MSG_BUFFER, [hwnd, 0x0113, 4, TIMERPROC, 0, 0, 0]);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0, 'nor one of another timer');
    assert.equal(dispatched.length, 1, 'neither is called');
});

test('a subclassed window is dispatched to its new procedure', ()=>{
    const { fns, memory, dispatched, hwnd } = withWindow();

    assert.equal(fns.SetWindowLongA.handler([hwnd, GWL_WNDPROC, 0x402000]), WNDPROC);
    memory.putU32s(MSG_BUFFER, [hwnd, WM_USER, 0, 0, 0, 0, 0]);
    fns.DispatchMessageA.handler([MSG_BUFFER]);

    assert.equal(dispatched[0].wndProc, 0x402000);
});

test('WM_DESTROY and WM_NCDESTROY are sent to the window going away, before it has gone',
    async()=>{
        // Sent, not posted: a program that destroys its window and then frees
        // what the procedure reads through GWL_USERDATA relies on the
        // procedure having run inside DestroyWindow. A queued WM_DESTROY
        // arrived after the free and the procedure called into freed memory.
        const { fns, dispatched, hwnd } = withWindow();
        assert.equal(await fns.DestroyWindow.handler([hwnd]), 1);
        assert.deepEqual(dispatched.map((/** @type {any} */ d)=>[d.hwnd, d.message]),
            [[hwnd, WM_DESTROY], [hwnd, WM_NCDESTROY]]);
        assert.equal(dispatched[0].wndProc, WNDPROC);
        assert.equal(fns.IsWindow.handler([hwnd]), 0, 'and only then is the handle gone');
        assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, 0]), 0, 'nothing queued');
    });

// --- the default window procedure ---

test('DefWindowProcA closes a window by destroying it', ()=>{
    const { fns, hwnd } = withWindow();

    assert.equal(fns.DefWindowProcA.handler([hwnd, WM_CLOSE, 0, 0]), 0);
    assert.equal(fns.IsWindow.handler([hwnd]), 0);
});

test('DefWindowProcA does not end the program when a window ends', ()=>{
    // Windows' default procedure does nothing with WM_DESTROY, and the
    // difference is not academic: a program of any size destroys windows all
    // the time -- a dialog, a tooltip, a splash screen -- and passes their
    // WM_DESTROY here because it has nothing to add. Quitting on each one ends
    // the process the first time any of them closes.
    const { fns, queue, hwnd } = withWindow();

    assert.equal(fns.DefWindowProcA.handler([hwnd, WM_DESTROY, 0, 0]), 0);
    assert.equal(queue.quitPending(), false);
});

test('DefWindowProcA(WM_SETCURSOR) asks the parent first, then sets the cursor of the '
    + 'window under it', ()=>{
    // As documented for WM_SETCURSOR: the parent decides first, and the
    // default sets the class cursor over the client area and the arrow
    // elsewhere. The cursor is the class's of the window wParam names, so a
    // parent that passes a child's message on sets the child's.
    const WM_SETCURSOR = 0x0020;
    const WM_MOUSEMOVE = 0x0200;
    const HTCLIENT = 1;
    const HTCAPTION = 2;
    const IDC_ARROW = 32512;
    const GCL_HCURSOR = -12;
    let parentAnswer = 0;
    const { fns, memory, dispatched, hwnd: parent } = withWindow({
        reply: message=>(message.message === WM_SETCURSOR ? parentAnswer : 0),
    });
    const child = createWindow(fns, memory, { style: WS_CHILD | WS_VISIBLE, parent });
    const overClient = (WM_MOUSEMOVE << 16 | HTCLIENT) >>> 0;
    dispatched.length = 0;

    assert.equal(fns.DefWindowProcA.handler([child, WM_SETCURSOR, child, overClient]), 1);
    assert.deepEqual(dispatched.map(({ hwnd, message, wParam, lParam })=>
        ({ hwnd, message, wParam, lParam })),
    [{ hwnd: parent, message: WM_SETCURSOR, wParam: child, lParam: overClient }],
    'the parent was asked with the same arguments');
    assert.equal(fns.GetCursor.handler(), 0x22, 'the class cursor is set');

    parentAnswer = 1;
    fns.SetCursor.handler([0x99]);
    assert.equal(fns.DefWindowProcA.handler([child, WM_SETCURSOR, child, overClient]), 1);
    assert.equal(fns.GetCursor.handler(), 0x99, 'a parent that answers TRUE has set it');

    fns.DefWindowProcA.handler([parent, WM_SETCURSOR, parent,
        (WM_MOUSEMOVE << 16 | HTCAPTION) >>> 0]);
    assert.equal(fns.GetCursor.handler(), IDC_ARROW, 'the frame shows the arrow');

    fns.SetClassLongA.handler([parent, GCL_HCURSOR, 0]);
    fns.SetCursor.handler([0x99]);
    assert.equal(fns.DefWindowProcA.handler([parent, WM_SETCURSOR, parent, overClient]), 0,
        'a class with no cursor leaves the client area to its procedure');
    assert.equal(fns.GetCursor.handler(), 0x99);
});

test('DefWindowProcA does nothing at all with a message it has no opinion on', ()=>{
    const { fns, queue, hwnd } = withWindow();

    assert.equal(fns.DefWindowProcA.handler([hwnd, WM_USER, 5, 6]), 0);
    assert.equal(fns.IsWindow.handler([hwnd]), 1);
    assert.equal(queue.depth(), 0);
    assert.equal(queue.quitPending(), false);
});

// --- the stack every one of them pops ---

test('every function declares the stack its arguments occupy', ()=>{
    const { fns } = setup();
    /** @type {Record<string, number>} */
    const expected = {
        RegisterClassA: 4,
        RegisterClassExA: 4,
        UnregisterClassA: 8,
        GetClassInfoA: 12,
        CreateWindowExA: 48,
        CreateWindowA: 44,
        DestroyWindow: 4,
        ShowWindow: 8,
        IsWindow: 4,
        GetClientRect: 8,
        GetWindowRect: 8,
        MoveWindow: 24,
        SetWindowTextA: 8,
        GetWindowTextA: 12,
        GetWindowLongA: 8,
        SetWindowLongA: 12,
        PostMessageA: 16,
        PostQuitMessage: 4,
        PeekMessageA: 20,
        GetMessageA: 16,
        TranslateMessage: 4,
        DispatchMessageA: 4,
        DefWindowProcA: 16,
    };

    const table = /** @type {Record<string, { argBytes: number }>} */ (
        /** @type {unknown} */ (fns));

    for (const [name, argBytes] of Object.entries(expected))
    {
        // stdcall: the callee pops these bytes itself, so a wrong count corrupts
        // the guest stack silently rather than failing here.
        assert.equal(table[name].argBytes, argBytes, `${name} pops the wrong number of bytes`);
    }

    // Checked over the whole table rather than against a list of names: this
    // file's table is three tables merged, and a list would have to be edited
    // every time a function lands, which is a list that stops being read.
    for (const [name, entry] of Object.entries(table))
    {
        assert.equal(Number.isInteger(entry.argBytes) && entry.argBytes % 4 === 0, true,
            `${name} declares argBytes ${entry.argBytes}, which is not a stack slot count`);
    }
});

test('CreateWindowA is CreateWindowExA without the extended style', ()=>{
    const { fns, memory } = withWindow();
    memory.putString(TITLE, 'Plain');

    const hwnd = fns.CreateWindowA.handler(
        [CLASS_NAME, TITLE, WS_VISIBLE, 1, 2, 30, 40, 0, 0, HINSTANCE, 0]);

    assert.ok(hwnd > 0);
    fns.GetWindowRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.left), 1);
    assert.equal(memory.u32(RECT_BUFFER + RECT.right), 31);
    assert.equal(fns.GetWindowLongA.handler([hwnd, GWL_STYLE]) & WS_VISIBLE, WS_VISIBLE);
});

// --- telling a new window that it exists ---

/** CREATESTRUCTA, by the offsets a guest compiled against. */
const CREATESTRUCT = Object.freeze({
    lpCreateParams: 0x00,
    hInstance: 0x04,
    hMenu: 0x08,
    hwndParent: 0x0c,
    cy: 0x10,
    cx: 0x14,
    y: 0x18,
    x: 0x1c,
    style: 0x20,
    lpszName: 0x24,
    lpszClass: 0x28,
    dwExStyle: 0x2c,
});

const WM_CREATE = 0x0001;
const WM_NCCREATE = 0x0081;

test('a new window is announced to its procedure with a CREATESTRUCT', ()=>{
    // A procedure does its setup in WM_CREATE. A program that never receives it
    // gets a window that looks real from every angle and does nothing, which
    // from outside is a program waiting for something it should have started.
    const { memory, fns, dispatched } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    memory.putString(TITLE, 'Main');

    const hwnd = fns.CreateWindowExA.handler(
        [0x200, CLASS_NAME, TITLE, 0x10000000, 10, 20, 300, 200, 0, 0x77, HINSTANCE, 0x999]);

    // A window created visible hears its size and its place inside the same
    // call, as the real CreateWindowEx sends them once WM_CREATE is answered:
    // a program that never calls ShowWindow measures the screen it lays itself
    // out and rasterises its text for from what it is told here.
    // And, the application's first window shown, that the application is
    // the active one: WM_ACTIVATEAPP, WM_NCACTIVATE, WM_ACTIVATE, WM_SETFOCUS.
    assert.deepEqual(dispatched.map(entry=>entry.message),
        [WM_NCCREATE, WM_CREATE, WM_SIZE, WM_MOVE, WM_SHOWWINDOW, 0x001c, WM_NCACTIVATE, 0x0006,
            0x0007]);
    assert.equal(dispatched[0].lParam, dispatched[1].lParam,
        'WM_NCCREATE carries the same structure');
    const message = dispatched[1];
    assert.equal(message.message, WM_CREATE);
    assert.equal(message.wndProc, WNDPROC);
    assert.equal(message.hwnd, hwnd);
    assert.equal(message.wParam, 0);

    const at = message.lParam;
    assert.notEqual(at, 0, 'the structure lives in guest memory the procedure can read');
    assert.equal(memory.u32(at + CREATESTRUCT.lpCreateParams), 0x999,
        'the last argument is how a program hands its own object to its procedure');
    assert.equal(memory.u32(at + CREATESTRUCT.hInstance), HINSTANCE);
    assert.equal(memory.u32(at + CREATESTRUCT.hMenu), 0x77);
    assert.equal(memory.u32(at + CREATESTRUCT.hwndParent), 0);
    assert.equal(memory.u32(at + CREATESTRUCT.cx), 300);
    assert.equal(memory.u32(at + CREATESTRUCT.cy), 200);
    assert.equal(memory.u32(at + CREATESTRUCT.x), 10);
    assert.equal(memory.u32(at + CREATESTRUCT.y), 20);
    assert.equal(memory.u32(at + CREATESTRUCT.style), 0x10000000);
    assert.equal(memory.u32(at + CREATESTRUCT.lpszName), TITLE);
    assert.equal(memory.u32(at + CREATESTRUCT.lpszClass), CLASS_NAME);
    assert.equal(memory.u32(at + CREATESTRUCT.dwExStyle), 0x200);

    const size = dispatched[2];
    assert.equal(size.hwnd, hwnd);
    assert.equal(size.wParam, 0, 'SIZE_RESTORED');
    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    const clientWidth = memory.u32(RECT_BUFFER + RECT.right)
        - memory.u32(RECT_BUFFER + RECT.left);
    const clientHeight = memory.u32(RECT_BUFFER + RECT.bottom)
        - memory.u32(RECT_BUFFER + RECT.top);
    assert.equal(size.lParam >>> 16, clientHeight, 'the client height, not the frame');
    assert.equal(size.lParam & 0xffff, clientWidth, 'and the client width');
    const place = dispatched[3];
    assert.equal(place.hwnd, hwnd);
    assert.equal(place.lParam >>> 16, 20, 'the y it was created at');
    assert.equal(place.lParam & 0xffff, 10, 'and the x');
    assert.deepEqual([dispatched[4].wParam, dispatched[4].lParam], [1, 0], 'shown');
});

test('a window created hidden hears only that it is being created', ()=>{
    // A hidden window is told nothing about a size or a place it does not
    // have on screen yet, nor that it is shown.
    const { memory, fns, dispatched } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    createWindow(fns, memory);

    assert.deepEqual(dispatched.map(m=>m.message), [WM_NCCREATE, WM_CREATE],
        'hidden: the two creates only');
});

test('CreateWindowEx tells the hook, then the procedure, in the order user32\'s message '
    + 'tests pin', ()=>{
    // WmCreateOverlappedSeq and WmCreatePopupSeq, less what this layer does
    // not send (WM_GETMINMAXINFO, WM_NCCALCSIZE, the WM_WINDOWPOS pair, the
    // painting, HCBT_ACTIVATE and HCBT_SETFOCUS): HCBT_CREATEWND, WM_NCCREATE,
    // WM_CREATE, and for a window created visible WM_SIZE (SIZE_RESTORED),
    // WM_MOVE, WM_SHOWWINDOW(1) and the activation -- WM_ACTIVATEAPP to each
    // of the application's top-level windows, the hidden one too.
    /** @type {string[]} */
    const log = [];
    const { memory, fns } = setup({
        heap: true,
        reply: message=>{
            log.push(`0x${message.message.toString(16)}:${message.wParam}`);
            return message.message === WM_NCCREATE ? 1 : 0;
        },
        hookReply: (entry, args)=>{
            log.push(`hook:${args[0]}`);
            return 0;
        },
    });
    fns.SetWindowsHookExA.handler([WH_CBT, HOOK_PROC, 0, 0]);
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);

    createWindow(fns, memory, { style: 0x80000000 });
    assert.deepEqual(log, [`hook:${HCBT_CREATEWND}`, '0x81:0', '0x1:0'], 'hidden');

    log.length = 0;
    createWindow(fns, memory, { style: 0x80000000 | WS_VISIBLE });
    assert.deepEqual(log, [`hook:${HCBT_CREATEWND}`, '0x81:0', '0x1:0', '0x5:0', '0x3:0',
        '0x18:1', '0x1c:1', '0x1c:1', '0x86:1', '0x6:1', '0x7:0'], 'visible');
});

test('WM_NCCREATE answered FALSE refuses the window, which hears WM_NCDESTROY alone', ()=>{
    // As documented for WM_NCCREATE: FALSE and CreateWindowEx answers NULL.
    const { memory, fns, dispatched } = setup({
        heap: true, reply: message=>(message.message === WM_NCCREATE ? 0 : 1),
    });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);

    const hwnd = createWindow(fns, memory, { style: WS_VISIBLE });
    assert.equal(hwnd, 0);
    assert.deepEqual(dispatched.map(m=>m.message), [WM_NCCREATE, WM_NCDESTROY]);
    assert.equal(fns.IsWindow.handler([dispatched[0].hwnd]), 0, 'and nothing is left behind');
});

test('the CREATESTRUCT is freed once the procedure has seen it', ()=>{
    const { memory, fns, dispatched, released } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    createWindow(fns, memory);

    assert.deepEqual(released, [dispatched[0].lParam], 'one create, one allocation, one free');
});

test('a procedure answering -1 refuses the window', ()=>{
    // How a program refuses a window it cannot set up. The handle must not
    // survive: a caller checks for zero and carries on with whatever it has.
    const { memory, fns } = setup({ heap: true, reply: ()=>-1 });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);

    const hwnd = createWindow(fns, memory);

    assert.equal(hwnd, 0);
    assert.equal(fns.IsWindow.handler([hwnd]), 0, 'and nothing is left behind');
});

test('a procedure that answers late leaves the caller a promise to park on', async()=>{
    /** @type {(value: number) => void} */
    let answer = ()=>{};
    const pending = new Promise(resolve=>{
        answer = resolve;
    });
    const { memory, fns } = setup({ heap: true, reply: ()=>pending });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);

    const result = createWindow(fns, memory);
    assert.equal(typeof result.then, 'function', 'sending is running guest code, which waits');

    // TRUE to WM_NCCREATE, and anything but -1 to WM_CREATE.
    answer(1);
    assert.notEqual(await result, 0, 'and the handle arrives when the procedure is done');
});

test('a build with no heap makes the window anyway', ()=>{
    // Degraded, not broken: without guest memory there is nowhere to put a
    // CREATESTRUCT, and a window nobody was told about beats no window at all.
    const { memory, fns, dispatched } = setup();
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);

    assert.notEqual(createWindow(fns, memory), 0);
    assert.equal(dispatched.length, 0);
});

test('a class with no procedure is not announced to anything', ()=>{
    const { memory, fns, dispatched } = setup({ heap: true });
    putClass(memory, { wndProc: 0 });
    fns.RegisterClassA.handler([CLASS_STRUCT]);

    assert.notEqual(createWindow(fns, memory), 0);
    assert.equal(dispatched.length, 0);
});

test('DefWindowProcA answers WM_NCCREATE with TRUE', ()=>{
    // FALSE means "do not make this window", and a default that said so would
    // refuse every window whose procedure passes the message on.
    const { fns } = setup();
    assert.equal(fns.DefWindowProcA.handler([0x40, WM_NCCREATE, 0, 0]), 1);
});

// --- finding a window that already exists ---

test('a window is found by its class, its title, or both', ()=>{
    const { memory, fns } = setup();
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hwnd = createWindow(fns, memory);

    const CLASS_QUERY = 0x11400;
    const TITLE_QUERY = 0x11500;
    memory.putString(CLASS_QUERY, 'MainWnd');
    memory.putString(TITLE_QUERY, 'Main');

    assert.equal(fns.FindWindowA.handler([CLASS_QUERY, 0]), hwnd);
    assert.equal(fns.FindWindowA.handler([0, TITLE_QUERY]), hwnd);
    assert.equal(fns.FindWindowA.handler([CLASS_QUERY, TITLE_QUERY]), hwnd);
    assert.equal(fns.FindWindowA.handler([0, 0]), hwnd, 'both absent means the first there is');
});

test('a name that matches nothing answers with nothing', ()=>{
    // The answer that matters most. A program discovers a copy of itself this
    // way, and an installer refuses to run while what it installs is open --
    // both read "not found" as permission to continue, so a window that is not
    // the one asked for is a worse answer than no window at all.
    const { memory, fns } = setup();
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    createWindow(fns, memory);

    const OTHER = 0x11400;
    memory.putString(OTHER, 'SomeOtherClass');
    assert.equal(fns.FindWindowA.handler([OTHER, 0]), 0,
        'a class nobody registered names nothing');

    const WRONG_TITLE = 0x11500;
    memory.putString(WRONG_TITLE, 'Not This One');
    assert.equal(fns.FindWindowA.handler([0, WRONG_TITLE]), 0);
});

test('the search ignores case, as Windows does', ()=>{
    const { memory, fns } = setup();
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hwnd = createWindow(fns, memory);

    const SHOUTED = 0x11400;
    memory.putString(SHOUTED, 'MAIN');
    assert.equal(fns.FindWindowA.handler([0, SHOUTED]), hwnd);
});

test('a destroyed window is not found', ()=>{
    const { memory, fns } = setup();
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hwnd = createWindow(fns, memory);
    const TITLE_QUERY = 0x11500;
    memory.putString(TITLE_QUERY, 'Main');

    assert.equal(fns.DestroyWindow.handler([hwnd]), 1);
    assert.equal(fns.FindWindowA.handler([0, TITLE_QUERY]), 0);
});

test('FindWindowEx searches one parent\'s children and resumes after one', ()=>{
    const { memory, fns } = setup();
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const parent = createWindow(fns, memory);
    const first = createWindow(fns, memory, { parent, style: WS_CHILD });
    const second = createWindow(fns, memory, { parent, style: WS_CHILD });

    assert.equal(fns.FindWindowExA.handler([parent, 0, 0, 0]), first);
    assert.equal(fns.FindWindowExA.handler([parent, first, 0, 0]), second,
        'resuming walks the rest, which is how a caller enumerates them');
    assert.equal(fns.FindWindowExA.handler([parent, second, 0, 0]), 0, 'and then runs out');
    assert.equal(fns.FindWindowExA.handler([0, 0, 0, 0]), parent,
        'a top-level search does not descend into children');
});

test('both spellings pop the stack their signature declares', ()=>{
    const { fns } = setup();
    assert.equal(fns.FindWindowA.argBytes, 8);
    assert.equal(fns.FindWindowExA.argBytes, 16);
});

test('a window procedure that has not returned is named while it is inside', async()=>{
    // The call log writes a call when it answers, so a procedure that never
    // returns is the one call missing from it -- and it is the one holding the
    // thread that pumps the queue, and with it the whole program.
    /** @type {any[]} */
    const open = [];
    /** @type {(value: number) => void} */
    let answer = ()=>{};
    const pending = new Promise(resolve=>{
        answer = resolve;
    });

    watchDispatch({ dispatching: open }, { hwnd: 0x40b8, message: 0x1c }, pending);
    assert.deepEqual(open.map(held=>[held.hwnd, held.message]), [[0x40b8, 0x1c]]);

    answer(0);
    await pending;
    await Promise.resolve();
    assert.deepEqual(open, [], 'and it is gone the moment the procedure answers');
});

test('a procedure that answered at once leaves nothing behind', ()=>{
    // Most messages never suspend at all: the handler answers a number and the
    // call is over before it is recorded.
    /** @type {any[]} */
    const open = [];
    assert.equal(watchDispatch({ dispatching: open }, { hwnd: 1, message: 2 }, 0), 0);
    assert.deepEqual(open, []);
});

test('a procedure that threw is not left standing for ever', async()=>{
    /** @type {any[]} */
    const open = [];
    const failed = Promise.reject(new Error('the procedure faulted'));
    watchDispatch({ dispatching: open }, { hwnd: 3, message: 4 }, failed);
    await failed.catch(()=>{});
    await Promise.resolve();
    assert.deepEqual(open, []);
});

test('TranslateMessage delivers the character the host composed, once', ()=>{
    // The host knows the layout, the dead keys and the input method; this file
    // knows only a table of virtual keys. So the host composes and this
    // delivers -- and delivers exactly one, which is the whole contract: a
    // character posted by whoever composed it as well would arrive twice.
    const h = setup();
    h.memory.putU32s(MSG_BUFFER, [0x40, WM_KEYDOWN, 0x41, 0x001e0001, 0, 0, 0]);
    h.queue.compose(0xe9, 0x001e0001);

    assert.equal(h.fns.TranslateMessage.handler([MSG_BUFFER]), 1);
    const posted = h.queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
    assert.equal(posted?.message, WM_CHAR);
    assert.equal(posted?.wParam, 0xe9, 'the composed character, not the virtual key');
    assert.equal(h.queue.peek({ hwnd: null, first: 0, last: 0, remove: true }), null,
        'and only the one');
});

test('a key the host composed nothing for still translates from the table', ()=>{
    // A recorded session and a test send key presses and no text at all.
    const h = setup();
    h.memory.putU32s(MSG_BUFFER, [0x40, WM_KEYDOWN, 0x41, 0x001e0001, 0, 0, 0]);

    assert.equal(h.fns.TranslateMessage.handler([MSG_BUFFER]), 1);
    assert.equal(h.queue.peek({ hwnd: null, first: 0, last: 0, remove: true })?.wParam, 0x61);
});

test('a modifier does not take the character meant for the key after it', ()=>{
    // A modifier goes down producing nothing. Handing it the next character in
    // the queue would put it on the wrong press and lose the right one.
    const h = setup();
    h.queue.compose(0x41, 0x001e0001);

    h.memory.putU32s(MSG_BUFFER, [0x40, WM_KEYDOWN, 0x10, 0x002a0001, 0, 0, 0]);
    h.fns.TranslateMessage.handler([MSG_BUFFER]);
    assert.equal(h.queue.peek({ hwnd: null, first: 0, last: 0, remove: true }), null,
        'the shift produced nothing');

    h.memory.putU32s(MSG_BUFFER, [0x40, WM_KEYDOWN, 0x41, 0x001e0001, 0, 0, 0]);
    h.fns.TranslateMessage.handler([MSG_BUFFER]);
    assert.equal(h.queue.peek({ hwnd: null, first: 0, last: 0, remove: true })?.wParam, 0x41);
});

// --- hooks ---

test('a CBT hook is told of a window before its procedure is, and can refuse it', ()=>{
    // A framework attaches its own object to the window from this hook and
    // subclasses the procedure there, so what WM_CREATE reaches is the
    // framework. That is why the hook comes first.
    const { memory, fns, dispatched, called } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hook = fns.SetWindowsHookExA.handler([WH_CBT, HOOK_PROC, HINSTANCE, 1]);
    assert.notEqual(hook, 0);

    const hwnd = createWindow(fns, memory);
    assert.equal(called.length, 1);
    const [{ entry, args, thread }] = called;
    assert.equal(entry, HOOK_PROC);
    assert.equal(args[0], HCBT_CREATEWND);
    assert.equal(args[1], hwnd);
    assert.equal(thread, THREAD, 'named, because the send after it is made after an await');
    // lParam is a CBT_CREATEWND whose first word is the CREATESTRUCT the
    // procedure is then handed.
    assert.equal(memory.u32(args[2]), dispatched[0].lParam);
    assert.equal(memory.u32(dispatched[0].lParam + CREATESTRUCT.lpszClass), CLASS_NAME);
    assert.deepEqual(dispatched.map(m=>m.message), [WM_NCCREATE, WM_CREATE]);
    assert.equal(dispatched[1].lParam, dispatched[0].lParam);
    assert.equal(dispatched[1].thread, THREAD);
});

test('a CBT hook answering non-zero refuses the window before WM_CREATE', ()=>{
    const { memory, fns, dispatched } = setup({ heap: true, hookReply: ()=>1 });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    fns.SetWindowsHookExA.handler([WH_CBT, HOOK_PROC, HINSTANCE, 1]);

    const hwnd = createWindow(fns, memory);
    assert.equal(hwnd, 0);
    assert.deepEqual(dispatched, [], 'the procedure never hears of a window the hook refused');
});

test('a hook that answers late leaves a promise, and the creation follows it', async()=>{
    /** @type {(value: number) => void} */
    let answer = ()=>{};
    const pending = new Promise(resolve=>{
        answer = resolve;
    });
    const { memory, fns, dispatched } = setup({ heap: true, hookReply: ()=>pending });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    fns.SetWindowsHookExA.handler([WH_CBT, HOOK_PROC, HINSTANCE, 1]);

    const result = createWindow(fns, memory);
    assert.equal(typeof result.then, 'function');
    assert.deepEqual(dispatched, [], 'not yet');
    answer(0);
    assert.notEqual(await result, 0);
    assert.deepEqual(/** @type {any[]} */ (dispatched).map(m=>m.message),
        [WM_NCCREATE, WM_CREATE]);
});

test('the newest hook is called first and reaches the older through CallNextHookEx', ()=>{
    const { memory, fns, called } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    const older = fns.SetWindowsHookExA.handler([WH_CBT, OLDER_HOOK_PROC, HINSTANCE, 1]);
    const newer = fns.SetWindowsHookExA.handler([WH_CBT, HOOK_PROC, HINSTANCE, 1]);

    createWindow(fns, memory);
    assert.deepEqual(called.map(call=>call.entry), [HOOK_PROC]);

    assert.equal(fns.CallNextHookEx.handler([newer, HCBT_CREATEWND, 0x40, 0x50]), 0);
    assert.deepEqual(called.at(-1), { entry: OLDER_HOOK_PROC, args: [HCBT_CREATEWND, 0x40, 0x50],
        thread: THREAD });
    assert.equal(fns.CallNextHookEx.handler([older, HCBT_CREATEWND, 0x40, 0x50]), 0,
        'the last in the chain has nobody to pass to');
    assert.equal(called.length, 2);

    assert.equal(fns.UnhookWindowsHookEx.handler([newer]), 1);
    assert.equal(fns.UnhookWindowsHookEx.handler([newer]), 0, 'and not twice');
    createWindow(fns, memory);
    assert.equal(called.at(-1)?.entry, OLDER_HOOK_PROC, 'the older is the newest now');
});

test('a hook of a type that is never called says so once, and is still installed', ()=>{
    const { memory, fns, called, divergences } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    assert.notEqual(fns.SetWindowsHookExA.handler([WH_KEYBOARD, HOOK_PROC, HINSTANCE, 1]), 0);
    assert.equal(divergences.length, 1);
    assert.match(divergences[0], /SetWindowsHookExA: hook type 2/);
    createWindow(fns, memory);
    assert.deepEqual(called, []);
    assert.equal(fns.SetWindowsHookExA.handler([WH_CBT, 0, HINSTANCE, 1]), 0,
        'no procedure is no hook');
});

test('the hook functions declare the stack they pop', ()=>{
    const { fns } = setup();
    assert.equal(fns.SetWindowsHookExA.argBytes, 16);
    assert.equal(fns.UnhookWindowsHookEx.argBytes, 4);
    assert.equal(fns.CallNextHookEx.argBytes, 16);
});

// --- what is waiting, without pumping for it ---

test('GetQueueStatus reports what is waiting in the high word and what is new in the low', ()=>{
    const { fns, queue } = setup();
    assert.equal(fns.GetQueueStatus.handler([QS_ALLINPUT]), 0, 'an empty queue is nothing');

    queue.post({ hwnd: 0x40, message: WM_LBUTTONDOWN, wParam: 0, lParam: 0 });
    const first = fns.GetQueueStatus.handler([QS_ALLINPUT]) >>> 0;
    assert.equal(first >>> 16 & QS_MOUSEBUTTON, QS_MOUSEBUTTON, 'a click is waiting');
    assert.equal(first & QS_MOUSEBUTTON, QS_MOUSEBUTTON, 'and it is news');

    const again = fns.GetQueueStatus.handler([QS_ALLINPUT]) >>> 0;
    assert.equal(again >>> 16 & QS_MOUSEBUTTON, QS_MOUSEBUTTON, 'still waiting');
    assert.equal(again & 0xffff, 0, 'and no longer news');

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(fns.GetQueueStatus.handler([QS_ALLINPUT]), 0,
        'once it has been taken there is nothing waiting at all');
});

test('GetQueueStatus answers only about the classes it was asked about', ()=>{
    const { fns, queue } = setup();
    queue.post({ hwnd: 0x40, message: WM_KEYDOWN, wParam: 0x41, lParam: 0 });
    queue.post({ hwnd: 0, message: WM_USER, wParam: 0, lParam: 0 });

    // The mask is the whole point of the call for a playback loop: it asks about
    // input and must not be woken by its own posted work.
    const input = fns.GetQueueStatus.handler([QS_INPUT]) >>> 0;
    assert.equal(input >>> 16, QS_KEY);
    const posts = fns.GetQueueStatus.handler([QS_POSTMESSAGE]) >>> 0;
    assert.equal(posts >>> 16, QS_POSTMESSAGE);
});

test('GetQueueStatus and the thread post pop the stack they were pushed', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetQueueStatus.argBytes, 4);
    assert.equal(fns.PostThreadMessageA.argBytes, 16);
});

test('a message posted to a thread is taken by a retrieval that named no window', ()=>{
    const { fns, memory, queue } = setup({ threadExists: id=>id === 0x88 });
    memory.fill(MSG_BUFFER, MSG.SIZE / 4);

    assert.equal(fns.PostThreadMessageA.handler([0x88, WM_USER, 7, 9]), 1);
    assert.equal(queue.depth(), 1);
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.hwnd), 0, 'a thread message has no window');
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_USER);
    assert.equal(memory.u32(MSG_BUFFER + MSG.wParam), 7);
    assert.equal(memory.u32(MSG_BUFFER + MSG.lParam), 9);
});

test('a thread message is not handed to a retrieval that named a window', ()=>{
    const { fns, hwnd, queue } = withWindow();
    assert.equal(fns.PostThreadMessageA.handler([0x88, WM_USER, 0, 0]), 1);

    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, hwnd, 0, 0, PM_REMOVE]), 0,
        'a filter naming a window skips thread messages, as Windows documents');
    assert.equal(queue.depth(), 1, 'and leaves the message where it was');
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
});

test('PostThreadMessageA refuses a thread that does not exist, and says why', ()=>{
    const { fns, queue, errors } = setup({ threadExists: id=>id === 0x88 });
    assert.equal(fns.PostThreadMessageA.handler([0x99, WM_USER, 0, 0]), 0);
    assert.equal(queue.depth(), 0, 'and queues nothing for nobody to find');
    assert.deepEqual(errors, [ERROR_INVALID_THREAD_ID]);
});

// --- raw input ---

const WM_INPUT = 0x00ff;
const RID_INPUT = 0x10000003;
const RID_HEADER = 0x10000005;
const RIDEV_REMOVE = 0x0001;
const RIDEV_INPUTSINK = 0x0100;
const RIM_INPUT = 0;
const RIM_INPUTSINK = 1;
const RAWINPUTDEVICE_SIZE = 12;
const RAWINPUTHEADER_SIZE = 16;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INSUFFICIENT_BUFFER = 122;
const DEVICES = 0x11400;
const COUNT = 0x11500;
const RAW = 0x11600;

/**
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {[number, number, number, number][]} devices  page, usage, flags, target
 */
function putDevices(memory, devices){
    devices.forEach(([page, usage, flags, target], index)=>{
        memory.putU32s(DEVICES + index * RAWINPUTDEVICE_SIZE,
            [(usage << 16 | page) >>> 0, flags, target]);
    });
    return devices.length;
}

/** @param {ReturnType<typeof fakeMemory>} memory @param {number} at */
const u16 = (memory, at)=>memory.u32(at) & 0xffff;

test('RegisterRawInputDevices checks its devices, and the registered list is ordered', ()=>{
    // user32's input tests: no devices or a cbSize of 0 is ERROR_INVALID_PARAMETER;
    // the registered list is counted with a null buffer, refused for a count of
    // 0, too small with ERROR_INSUFFICIENT_BUFFER and the count needed, and
    // comes back ordered by usage; RIDEV_INPUTSINK needs a window and
    // RIDEV_REMOVE must not name one.
    const HID_USAGE_GENERIC_JOYSTICK = 0x04;
    const HID_USAGE_GENERIC_GAMEPAD = 0x05;
    const { fns, memory, hwnd, errors } = withWindow({ style: WS_VISIBLE });
    const count = putDevices(memory, [[1, HID_USAGE_GENERIC_GAMEPAD, 0, 0],
        [1, HID_USAGE_GENERIC_JOYSTICK, 0, 0]]);
    const registered = (/** @type {number} */ buffer, /** @type {number} */ size)=>
        fns.GetRegisteredRawInputDevices.handler([buffer, COUNT, size]);

    assert.equal(fns.RegisterRawInputDevices.handler([0, 0, 0]), 0);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, count, 0]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, count, RAWINPUTDEVICE_SIZE]), 1);

    errors.length = 0;
    assert.equal(fns.GetRegisteredRawInputDevices.handler([0, 0, 0]), 0xffffffff);
    assert.equal(registered(0, 0), 0xffffffff);
    memory.putU32s(COUNT, [0]);
    assert.equal(registered(0, RAWINPUTDEVICE_SIZE), 0);
    assert.equal(memory.u32(COUNT), 2, 'counted');
    memory.putU32s(COUNT, [0]);
    assert.equal(registered(DEVICES, RAWINPUTDEVICE_SIZE), 0xffffffff);
    assert.equal(memory.u32(COUNT), 0);
    memory.putU32s(COUNT, [1]);
    assert.equal(registered(DEVICES, RAWINPUTDEVICE_SIZE), 0xffffffff);
    assert.equal(memory.u32(COUNT), 2, 'told how many it needs');
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER,
        ERROR_INVALID_PARAMETER, ERROR_INSUFFICIENT_BUFFER]);
    memory.fill(DEVICES, 6);
    memory.putU32s(COUNT, [2]);
    assert.equal(registered(DEVICES, RAWINPUTDEVICE_SIZE), 2);
    assert.deepEqual([0, 12].map(at=>memory.u32(DEVICES + at)),
        [(HID_USAGE_GENERIC_JOYSTICK << 16 | 1) >>> 0, (HID_USAGE_GENERIC_GAMEPAD << 16 | 1) >>> 0],
        'ordered by usage, not by registration');

    errors.length = 0;
    putDevices(memory, [[1, 4, RIDEV_INPUTSINK, 0], [1, 5, RIDEV_INPUTSINK, 0]]);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, 2, RAWINPUTDEVICE_SIZE]), 0);
    putDevices(memory, [[1, 4, RIDEV_INPUTSINK, hwnd], [1, 5, RIDEV_INPUTSINK, hwnd]]);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, 2, RAWINPUTDEVICE_SIZE]), 1);
    putDevices(memory, [[1, 4, RIDEV_REMOVE, hwnd], [1, 5, RIDEV_REMOVE, hwnd]]);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, 2, RAWINPUTDEVICE_SIZE]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
    putDevices(memory, [[1, 4, RIDEV_REMOVE, 0], [1, 5, RIDEV_REMOVE, 0]]);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, 2, RAWINPUTDEVICE_SIZE]), 1);
    memory.putU32s(COUNT, [0]);
    assert.equal(registered(0, RAWINPUTDEVICE_SIZE), 0);
    assert.equal(memory.u32(COUNT), 0, 'both removed');
});

test('GetRawInputData refuses a handle that names no input', ()=>{
    const { fns, memory, errors } = setup();
    memory.putU32s(COUNT, [0]);
    assert.equal(fns.GetRawInputData.handler([0, RID_INPUT, 0, COUNT, RAWINPUTHEADER_SIZE]),
        0xffffffff);
    assert.deepEqual(errors, [ERROR_INVALID_HANDLE]);
});

test('a registered mouse is posted WM_INPUT, and GetRawInputData reads the report', ()=>{
    // As documented for WM_INPUT and GetRawInputData: wParam says whether the
    // window was in the foreground, lParam is the handle, a null buffer asks
    // the size, RID_HEADER reads the RAWINPUTHEADER alone, and a RAWMOUSE
    // carries relative motion, button transitions and the wheel.
    const RI_MOUSE_LEFT_BUTTON_DOWN = 0x0001;
    const RI_MOUSE_WHEEL = 0x0400;
    const RAWINPUT_MOUSE_SIZE = 40;
    const { fns, memory, hwnd, queue, service, errors } = withWindow({ style: WS_VISIBLE });
    fns.SetFocus.handler([hwnd]);
    service.rawInput({ device: 'mouse', dx: 5, dy: -3 });
    assert.equal(queue.depth(), 0, 'nothing is posted for a device nobody registered');

    putDevices(memory, [[1, 2, 0, hwnd]]);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, 1, RAWINPUTDEVICE_SIZE]), 1);
    service.rawInput({ device: 'mouse', dx: 5, dy: -3 });
    assert.equal(fns.GetQueueStatus.handler([0x0400]) >>> 16, 0x0400, 'QS_RAWINPUT');
    assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
    assert.deepEqual([MSG.hwnd, MSG.message, MSG.wParam].map(at=>memory.u32(MSG_BUFFER + at)),
        [hwnd, WM_INPUT, RIM_INPUT]);
    const handle = memory.u32(MSG_BUFFER + MSG.lParam);
    assert.notEqual(handle, 0);

    memory.putU32s(COUNT, [0]);
    assert.equal(fns.GetRawInputData.handler([handle, RID_INPUT, 0, COUNT, RAWINPUTHEADER_SIZE]),
        0, 'a null buffer asks the size');
    assert.equal(memory.u32(COUNT), RAWINPUT_MOUSE_SIZE);
    memory.fill(RAW, 10);
    assert.equal(fns.GetRawInputData.handler([handle, RID_INPUT, RAW, COUNT, RAWINPUTHEADER_SIZE]),
        RAWINPUT_MOUSE_SIZE);
    assert.deepEqual([0, 4, 8, 12].map(at=>memory.u32(RAW + at)),
        [0, RAWINPUT_MOUSE_SIZE, 0, 0], 'RIM_TYPEMOUSE, its size, no device, RIM_INPUT');
    assert.deepEqual([16, 20, 24, 28, 32, 36].map(at=>memory.u32(RAW + at)),
        [0, 0, 0, 5, 0xfffffffd, 0], 'relative motion, no buttons');

    memory.putU32s(COUNT, [RAWINPUTHEADER_SIZE]);
    memory.fill(RAW, 10);
    assert.equal(fns.GetRawInputData.handler([handle, RID_HEADER, RAW, COUNT,
        RAWINPUTHEADER_SIZE]), RAWINPUTHEADER_SIZE);
    assert.equal(memory.u32(RAW + 16), UNTOUCHED, 'the header alone');
    assert.equal(fns.GetRawInputData.handler([handle, RID_INPUT, RAW, COUNT,
        RAWINPUTHEADER_SIZE]), 0xffffffff, 'a buffer too small for the report');
    assert.equal(fns.GetRawInputData.handler([handle, RID_INPUT, RAW, COUNT, 12]), 0xffffffff);
    assert.deepEqual(errors, [ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_PARAMETER]);

    service.rawInput({ device: 'mouse', button: 'left', down: true });
    service.rawInput({ device: 'mouse', wheel: -120 });
    memory.putU32s(COUNT, [RAWINPUT_MOUSE_SIZE]);
    /** @returns {number[]} usButtonFlags and usButtonData of the next report */
    const nextButtons = ()=>{
        fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]);
        fns.GetRawInputData.handler([memory.u32(MSG_BUFFER + MSG.lParam), RID_INPUT, RAW,
            COUNT, RAWINPUTHEADER_SIZE]);
        return [u16(memory, RAW + 20), u16(memory, RAW + 22)];
    };
    assert.deepEqual(nextButtons(), [RI_MOUSE_LEFT_BUTTON_DOWN, 0]);
    assert.deepEqual(nextButtons(), [RI_MOUSE_WHEEL, 0xff88], 'the wheel\'s signed delta');
});

test('a registered keyboard follows the focus, and only a sink hears it in the background', ()=>{
    // RAWINPUTDEVICE documents a null hwndTarget as the keyboard focus, and
    // RIDEV_INPUTSINK as input received while the window is not in the
    // foreground, with wParam RIM_INPUTSINK; a RAWKEYBOARD carries the make
    // code, RI_KEY_BREAK and RI_KEY_E0, the virtual key and the message.
    const RI_KEY_BREAK = 1;
    const RI_KEY_E0 = 2;
    const WM_KEYUP = 0x0101;
    const RAWINPUT_KEYBOARD_SIZE = 32;
    const { fns, memory, hwnd, queue, service } = withWindow({ style: WS_VISIBLE });
    const other = createWindow(fns, memory, { style: WS_VISIBLE });
    /** Moves the focus, dropping what activation posted, so only raw input is queued. */
    const focusOn = (/** @type {number} */ target)=>{
        fns.SetFocus.handler([target]);
        queue.purge(hwnd);
        queue.purge(other);
    };
    focusOn(hwnd);
    putDevices(memory, [[1, 6, 0, 0]]);
    assert.equal(fns.RegisterRawInputDevices.handler([DEVICES, 1, RAWINPUTDEVICE_SIZE]), 1);

    /** @returns {number[]} the window, wParam and the RAWKEYBOARD's fields */
    const next = ()=>{
        assert.equal(fns.PeekMessageA.handler([MSG_BUFFER, 0, 0, 0, PM_REMOVE]), 1);
        assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_INPUT);
        memory.putU32s(COUNT, [RAWINPUT_KEYBOARD_SIZE]);
        assert.equal(fns.GetRawInputData.handler([memory.u32(MSG_BUFFER + MSG.lParam),
            RID_INPUT, RAW, COUNT, RAWINPUTHEADER_SIZE]), RAWINPUT_KEYBOARD_SIZE);
        assert.equal(memory.u32(RAW), 1, 'RIM_TYPEKEYBOARD');
        return [memory.u32(MSG_BUFFER + MSG.hwnd), memory.u32(MSG_BUFFER + MSG.wParam),
            u16(memory, RAW + 16), u16(memory, RAW + 18), u16(memory, RAW + 22),
            memory.u32(RAW + 24)];
    };
    service.rawInput({ device: 'key', scan: 0x1e, vk: 0x41, down: true });
    assert.deepEqual(next(), [hwnd, RIM_INPUT, 0x1e, 0, 0x41, WM_KEYDOWN]);
    focusOn(other);
    service.rawInput({ device: 'key', scan: 0x1d, extended: true, vk: 0x11, down: false });
    assert.deepEqual(next(), [other, RIM_INPUT, 0x1d, RI_KEY_BREAK | RI_KEY_E0, 0x11, WM_KEYUP]);

    putDevices(memory, [[1, 6, 0, hwnd]]);
    fns.RegisterRawInputDevices.handler([DEVICES, 1, RAWINPUTDEVICE_SIZE]);
    service.rawInput({ device: 'key', scan: 0x1e, vk: 0x41, down: true });
    assert.equal(queue.depth(), 0, 'a window in the background is not told');
    putDevices(memory, [[1, 6, RIDEV_INPUTSINK, hwnd]]);
    fns.RegisterRawInputDevices.handler([DEVICES, 1, RAWINPUTDEVICE_SIZE]);
    service.rawInput({ device: 'key', scan: 0x1e, vk: 0x41, down: true });
    assert.deepEqual(next().slice(0, 2), [hwnd, RIM_INPUTSINK], 'unless it is a sink');
});
