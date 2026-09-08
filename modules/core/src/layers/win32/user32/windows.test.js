/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from './messages.js';
import { MSG, RECT, WNDCLASSA, WNDCLASSEXA } from './structs.js';
import { createWindowFunctions } from './windows.js';

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

const WNDPROC = 0x401000;
const HINSTANCE = 0x400000;

/** Fills a buffer so that "wrote nothing" is distinguishable from "wrote zero". */
const UNTOUCHED = 0xa5a5a5a5;

const WM_DESTROY = 0x0002;
const WM_CLOSE = 0x0010;
const WM_QUIT = 0x0012;
const WM_KEYDOWN = 0x0100;
const WM_CHAR = 0x0102;
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
function fakeMemory(size = 0x12000){
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
const PARKED = Object.freeze({ parked: true });

function setup(){
    const memory = fakeMemory();
    const handles = fakeHandles();
    const queue = createMessageQueue();
    /** @type {any[]} */
    const dispatched = [];
    /** @type {any[]} */
    const parked = [];
    /** Resolvers for a waiting call, released a turn at a time by the test. */
    /** @type {(() => void)[]} */
    const idlers = [];

    const fns = createWindowFunctions({
        readMemory: (address, length)=>memory.readMemory(address, length),
        writeMemory: (address, data)=>memory.writeMemory(address, data),
        readCString: (address, maxLength)=>memory.readCString(address, maxLength),
        handles,
        queue,
        dispatch: (wndProc, message)=>{
            dispatched.push({ wndProc, ...message });
            return 0x1234;
        },
        park: ()=>{
            parked.push(true);
            return PARKED;
        },
        idle: ()=>new Promise(resolve=>idlers.push(()=>resolve(undefined))),
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

    return { memory, handles, queue, fns, dispatched, parked, tick, idlers };
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

/** A class plus a window of it, which almost every test below needs. */
function withWindow(options = {}){
    const context = setup();
    putClass(context.memory, options);
    context.fns.RegisterClassA.handler([CLASS_STRUCT]);
    const hwnd = createWindow(context.fns, context.memory, options);
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

test('MoveWindow changes both rectangles', ()=>{
    const { fns, memory, hwnd } = withWindow();

    assert.equal(fns.MoveWindow.handler([hwnd, 50, 60, 120, 90, 1]), 1);

    fns.GetWindowRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.left), 50);
    assert.equal(memory.u32(RECT_BUFFER + RECT.bottom), 150);

    fns.GetClientRect.handler([hwnd, RECT_BUFFER]);
    assert.equal(memory.u32(RECT_BUFFER + RECT.right), 120);
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
    const { fns, memory, hwnd } = withWindow();
    memory.putString(TITLE, 'A Window Title');

    assert.equal(fns.SetWindowTextA.handler([hwnd, TITLE]), 1);

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

test('a class that asked for no extra bytes has none', ()=>{
    const { fns, hwnd } = withWindow();

    assert.equal(fns.SetWindowLongA.handler([hwnd, 0, 0x1234]), 0);
    assert.equal(fns.GetWindowLongA.handler([hwnd, 0]), 0);
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

test('WM_DESTROY reaches the procedure of the window that is going away', ()=>{
    const { fns, memory, dispatched, hwnd } = withWindow();
    fns.DestroyWindow.handler([hwnd]);

    assert.equal(fns.GetMessageA.handler([MSG_BUFFER, 0, 0, 0]), 1);
    assert.equal(memory.u32(MSG_BUFFER + MSG.message), WM_DESTROY);
    assert.equal(fns.DispatchMessageA.handler([MSG_BUFFER]), 0x1234);
    assert.equal(dispatched[0].wndProc, WNDPROC);
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
