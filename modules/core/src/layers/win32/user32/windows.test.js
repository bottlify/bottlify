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
 */
function setup({ heap = false, reply, waitForObjects, now, hookReply, threadExists, trace } = {}){
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

    /** @type {import('./windows.js').WindowService | null} */
    /** @type {import('./windows.js').WindowService | null} */
    let service = null;
    const fns = createWindowFunctions({
        readMemory: (address, length)=>memory.readMemory(address, length),
        writeMemory: (address, data)=>memory.writeMemory(address, data),
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        handles,
        queue,
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

    return { memory, handles, queue, fns, dispatched, parked, tick, idlers, released,
        called, divergences, errors,
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
 *     & { reply?: (message: any) => any, trace?: (message: any) => void }} [options]
 */
function withWindow(options = {}){
    const { reply, trace, ...rest } = options;
    const context = setup({ reply, trace });
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
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 200 - 19 - 2, 'framed before placing');

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

test('a window that takes the activation is told, and the one it replaced is told it lost it', ()=>{
    const WM_ACTIVATE = 0x0006;
    const WA_ACTIVE = 1;
    const WA_INACTIVE = 0;
    // The application is told it is foreground once, when its first window
    // appears. Which of its own windows holds that activation afterwards is a
    // window-level fact, and a program that shows a second window -- or destroys
    // its render window and makes another for a mode change -- activates its
    // mouse, captures and clips only in the window it believes active, so that
    // window has to be told it is. The first activation is left alone (the
    // input layer sends that one, with WM_ACTIVATEAPP, in order); this is the
    // switch to a later window.
    const context = setup();
    putClass(context.memory);
    context.fns.RegisterClassA.handler([CLASS_STRUCT]);
    const first = createWindow(context.fns, context.memory, { style: WS_VISIBLE });
    const second = createWindow(context.fns, context.memory, { style: WS_VISIBLE });

    /** @type {any[]} */
    const told = [];
    // Only what was actually posted: a visible window's paint is made up on
    // every look and never leaves by looking, so draining to "nothing" would
    // never stop -- the pending count is the queue's own, and reaches zero.
    while (context.queue.depth() > 0)
    {
        const message = context.queue.peek({ hwnd: null, first: 0, last: 0, remove: true });
        if (!message)
        {
            break;
        }
        told.push(message);
    }

    const gained = told.find(entry=>entry.hwnd === second && entry.message === WM_ACTIVATE);
    const yielded = told.find(entry=>entry.hwnd === first && entry.message === WM_ACTIVATE);
    assert.ok(gained, 'the new window is told it became the active one');
    assert.equal(gained.wParam, WA_ACTIVE);
    assert.equal(gained.lParam >>> 0, first, 'and names the window it took the activation from');
    assert.ok(yielded, 'the window that gave it up is told it no longer has it');
    assert.equal(yielded.wParam, WA_INACTIVE);
    assert.equal(told.indexOf(yielded) < told.indexOf(gained), true,
        'the one that loses hears it before the one that gains');
    const activations = told.filter(entry=>entry.message === WM_ACTIVATE
        && entry.hwnd === second && entry.wParam === WA_ACTIVE).length;
    assert.equal(activations, 1,
        'exactly once: the switch does not re-send the first activation');

    // WM_NCACTIVATE tells the frame before WM_ACTIVATE tells the window, for
    // both the one losing activation and the one gaining it.
    const yieldedNc = told.find(entry=>entry.hwnd === first && entry.message === WM_NCACTIVATE);
    const gainedNc = told.find(entry=>entry.hwnd === second && entry.message === WM_NCACTIVATE);
    assert.ok(yieldedNc);
    assert.equal(yieldedNc.wParam, 0);
    assert.ok(gainedNc);
    assert.equal(gainedNc.wParam, 1);
    assert.equal(told.indexOf(yieldedNc) < told.indexOf(yielded), true);
    assert.equal(told.indexOf(gainedNc) < told.indexOf(gained), true);
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
        [WM_SHOWWINDOW, WM_SIZE], 'shown: the show message, then the size');
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
        'and the size waits behind it');

    answer(0);
    assert.equal(await result, 0, 'SW_SHOW on a hidden window answers the state it found');
    assert.deepEqual(dispatched.map(entry=>entry.message), [WM_SHOWWINDOW, WM_SIZE],
        'the size went once the show message was answered');
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
    memory.putU32s(MSG_BUFFER, [hwnd, WM_USER, 1, 2, 0, 0, 0]);

    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0x1234);
    assert.deepEqual(dispatched,
        [{ wndProc: WNDPROC, hwnd, message: WM_USER, wParam: 1, lParam: 2 }]);
});

test('DispatchMessageA has nothing to call for a thread message or a stale window', ()=>{
    const { fns, memory, dispatched } = withWindow();

    memory.putU32s(MSG_BUFFER, [0, WM_USER, 0, 0, 0, 0, 0]);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0);

    memory.putU32s(MSG_BUFFER, [0x9999, WM_USER, 0, 0, 0, 0, 0]);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0);

    assert.deepEqual(dispatched, [], 'neither one names a window procedure');
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
    assert.deepEqual(dispatched.map(entry=>entry.message), [WM_CREATE, WM_SIZE, WM_MOVE]);
    const [message] = dispatched;
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

    const size = dispatched[1];
    assert.equal(size.hwnd, hwnd);
    assert.equal(size.wParam, 0, 'SIZE_RESTORED');
    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    const clientWidth = memory.u32(RECT_BUFFER + RECT.right)
        - memory.u32(RECT_BUFFER + RECT.left);
    const clientHeight = memory.u32(RECT_BUFFER + RECT.bottom)
        - memory.u32(RECT_BUFFER + RECT.top);
    assert.equal(size.lParam >>> 16, clientHeight, 'the client height, not the frame');
    assert.equal(size.lParam & 0xffff, clientWidth, 'and the client width');
    const place = dispatched[2];
    assert.equal(place.hwnd, hwnd);
    assert.equal(place.lParam >>> 16, 20, 'the y it was created at');
    assert.equal(place.lParam & 0xffff, 10, 'and the x');
});

test('a window created hidden hears only WM_CREATE', ()=>{
    // WM_NCCREATE is the one to leave out: its default answer is TRUE and its
    // structure arrives again a moment later. A hidden window is told nothing
    // about a size or a place it does not have on screen yet.
    const { memory, fns, dispatched } = setup({ heap: true });
    putClass(memory);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    createWindow(fns, memory);

    assert.deepEqual(dispatched.map(m=>m.message), [WM_CREATE], 'hidden: the create only');
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

    answer(0);
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
    assert.equal(dispatched[0].message, WM_CREATE);
    assert.equal(dispatched[0].thread, THREAD);
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

test('a hook that answers late leaves the caller a promise, and WM_CREATE follows it', async()=>{
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
    assert.equal(/** @type {any} */ (dispatched[0]).message, WM_CREATE);
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
