/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from './messages.js';
import { createWindowFunctions } from './windows.js';
import { messageBoxButtons, messageBoxDefault } from './msgbox.js';
import { decodeAnsi } from '../kernel32/locale.js';

// Above 0xffff: a name pointer below that is an atom or a resource number.
const TEXT = 0x11000;
const CAPTION = 0x11400;
const CLASS = 0x11500;
const OUT = 0x11600;
const WNDCLASS = 0x11700;
const HEAP = 0x14000;
const SCREEN = { width: 800, height: 600, bitsPerPixel: 32 };

const MB_OKCANCEL = 0x1, MB_YESNOCANCEL = 0x3, MB_YESNO = 0x4, MB_RETRYCANCEL = 0x5;
const MB_ABORTRETRYIGNORE = 0x2;
const MB_DEFBUTTON2 = 0x100, MB_DEFBUTTON3 = 0x200;
const IDOK = 1, IDCANCEL = 2, IDNO = 7;
const WM_KEYDOWN = 0x0100;
const VK_RETURN = 0x0d, VK_ESCAPE = 0x1b;
const BM_CLICK = 0x00f5;
const GWL_STYLE = -16;
const BS_DEFPUSHBUTTON = 1;
const WS_POPUP = 0x80000000, WS_VISIBLE = 0x10000000;

/**
 * The whole window manager over a flat memory, with a heap the box's template
 * is made in, and a queue a test posts keys to as a person would press them.
 *
 * @param {{ unattended?: boolean, answer?: (dialog: any) => number }} [options]
 */
function setup({ unattended, answer } = {}){
    const bytes = new Uint8Array(0x20000);
    let next = HEAP;
    /** @type {string[]} */
    const said = [];
    const queue = createMessageQueue();
    /** @type {Map<number, any>} */
    const handles = new Map();
    let nextHandle = 4;
    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */
    const fns = /** @type {any} */ (
        /** @type {unknown} */ (createWindowFunctions({
            readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>bytes.slice(a, a + n),
            writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>bytes.set(d, a),
            readCString: (/** @type {number} */ a, /** @type {number} */ n)=>{
                let end = a;
                while (end < bytes.length && end - a < n && bytes[end] !== 0)
                {
                    end++;
                }
                return decodeAnsi(bytes.subarray(a, end));
            },
            handles: {
                open: (/** @type {string} */ type, /** @type {any} */ object)=>{
                    const handle = nextHandle;
                    nextHandle += 4;
                    handles.set(handle, { type, object });
                    return handle;
                },
                close: (/** @type {number} */ handle)=>handles.delete(handle),
            },
            queue,
            // The program's own procedure hands everything to the default,
            // as a frame that does nothing of its own does.
            dispatch: (/** @type {number} */ _wndProc, /** @type {any} */ message)=>
                fns.DefWindowProcA.handler(
                    [message.hwnd, message.message, message.wParam, message.lParam]),
            screen: SCREEN,
            allocate: (/** @type {number} */ size)=>{
                const at = next;
                next += (size + 15) & ~15;
                return at;
            },
            release: ()=>{},
            unattended,
            answer,
            messageBox: unattended ? (/** @type {any} */ notice)=>answer?.({
                kind: 'messagebox', title: notice.caption, text: notice.text,
                buttons: notice.buttons.map((/** @type {any} */ button)=>
                    ({ ...button, default: button.id === notice.defaultButton })),
            }) : undefined,
            say: (/** @type {string} */ text)=>said.push(text),
            callerThread: ()=>'the caller',
            park: ()=>({ parked: true }),
            idle: ()=>new Promise(resolve=>setImmediate(resolve)),
        })));
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        bytes.set(new TextEncoder().encode(`${text}\0`), at);
        return at;
    };
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        for (let index = 0; index <= text.length; index++)
        {
            const unit = index < text.length ? text.charCodeAt(index) : 0;
            bytes[at + index * 2] = unit & 0xff;
            bytes[at + index * 2 + 1] = unit >>> 8;
        }
        return at;
    };
    /** @param {number} at */
    const textAt = at=>decodeAnsi(bytes.subarray(at, bytes.indexOf(0, at)));
    /** @param {number} hwnd */
    const textOf = hwnd=>{
        fns.GetWindowTextA.handler([hwnd, OUT, 256]);
        return textAt(OUT);
    };
    /** @param {number} hwnd */
    const rectOf = hwnd=>{
        fns.GetWindowRect.handler([hwnd, OUT]);
        const view = new DataView(bytes.buffer, OUT, 16);
        return { left: view.getInt32(0, true), top: view.getInt32(4, true),
            right: view.getInt32(8, true), bottom: view.getInt32(12, true) };
    };
    /** The box standing under a caption, once it is up and laid out. @param {string} caption */
    const boxNamed = async caption=>{
        put(CAPTION + 0x80, caption);
        for (let tries = 0; tries < 200; tries++)
        {
            const found = fns.FindWindowA.handler([0, CAPTION + 0x80]);
            if (found !== 0 && fns.IsWindowVisible.handler([found]) !== 0)
            {
                return found;
            }
            await new Promise(resolve=>setImmediate(resolve));
        }
        return 0;
    };
    /** @param {number} hwnd @param {number} key */
    const press = (hwnd, key)=>queue.post({ hwnd, message: WM_KEYDOWN, wParam: key, lParam: 0 });
    /** @param {number} at @param {Uint8Array} data */
    const write = (at, data)=>bytes.set(data, at);
    return { fns, put, putWide, write, textAt, textOf, rectOf, boxNamed, press, said };
}

test('a message box is a dialog on the program\'s desktop: its caption, its text, a push button '
    + 'per answer', async()=>{
    const { fns, put, textAt, textOf, rectOf, boxNamed, press, said } = setup();
    put(TEXT, 'Setup has finished installing the demo.');
    put(CAPTION, 'Setup');
    const answer = fns.MessageBoxA.handler([0, TEXT, CAPTION, MB_OKCANCEL | MB_DEFBUTTON2]);
    const box = await boxNamed('Setup');
    assert.notEqual(box, 0, 'a window titled with the caption is up');
    fns.GetClassNameA.handler([box, OUT, 64]);
    assert.equal(textAt(OUT), '#32770', 'of the dialog class');

    const text = fns.GetDlgItem.handler([box, 0xffff]);
    assert.equal(textOf(text), 'Setup has finished installing the demo.');
    const ok = fns.GetDlgItem.handler([box, IDOK]);
    const cancel = fns.GetDlgItem.handler([box, IDCANCEL]);
    assert.deepEqual([textOf(ok), textOf(cancel)], ['OK', 'Cancel']);
    // MB_DEFBUTTON2: the second button is the default and has the focus.
    assert.equal(fns.GetWindowLongA.handler([cancel, GWL_STYLE]) & 0xf, BS_DEFPUSHBUTTON);
    assert.equal(fns.GetFocus.handler([]), cancel);

    // The text above, the buttons one size in a row under it, centred, and
    // the box centred on the screen.
    const [whole, words, left, right] = [box, text, ok, cancel].map(rectOf);
    assert.ok(words.bottom <= left.top, 'the text above the buttons');
    assert.equal(left.top, right.top);
    assert.equal(left.right - left.left, right.right - right.left);
    assert.ok(left.right < right.left, 'OK, then Cancel');
    assert.ok(Math.abs((left.left - whole.left) - (whole.right - right.right)) <= 1,
        'the row centred');
    assert.ok(words.right - words.left > 0 && words.bottom - words.top > 0);
    assert.ok(Math.abs(whole.left - (SCREEN.width - (whole.right - whole.left)) / 2) <= 1);
    assert.ok(Math.abs(whole.top - (SCREEN.height - (whole.bottom - whole.top)) / 2) <= 1);

    // Enter presses the default button.
    press(box, VK_RETURN);
    assert.equal(await answer, IDCANCEL);
    assert.equal(fns.IsWindow.handler([box]), 0, 'and the box is gone');
    assert.deepEqual(said, ['Setup: Setup has finished installing the demo.'],
        'what it said is in the journal as well');
});

test('Escape cancels a box with Cancel, is OK for a lone OK, and does not answer a question',
    async()=>{
        const { fns, put, boxNamed, press } = setup();
        put(TEXT, 'Done.');
        put(CAPTION, 'Lone');
        const lone = fns.MessageBoxA.handler([0, TEXT, CAPTION, 0]);
        press(await boxNamed('Lone'), VK_ESCAPE);
        assert.equal(await lone, IDOK);

        put(CAPTION, 'Question');
        const question = fns.MessageBoxA.handler([0, TEXT, CAPTION, MB_YESNO]);
        const box = await boxNamed('Question');
        press(box, VK_ESCAPE);
        for (let turn = 0; turn < 20; turn++)
        {
            await new Promise(resolve=>setImmediate(resolve));
        }
        assert.equal(fns.IsWindow.handler([box]), 1, 'a question has to be answered');
        fns.SendMessageA.handler([fns.GetDlgItem.handler([box, IDNO]), BM_CLICK, 0, 0]);
        assert.equal(await question, IDNO);
    });

test('the owner is disabled while its box is up, and a null caption is "Error"', async()=>{
    const { fns, put, putWide, write, textOf, boxNamed } = setup();
    // A frame of the program's own class, as a program's main window is.
    put(CLASS, 'Frame');
    const fields = new DataView(new ArrayBuffer(40));
    fields.setUint32(4, 0x402000, true);
    fields.setUint32(36, CLASS, true);
    write(WNDCLASS, new Uint8Array(fields.buffer));
    assert.notEqual(fns.RegisterClassA.handler([WNDCLASS]), 0);
    put(TEXT, 'Main');
    const owner = fns.CreateWindowExA.handler([0, CLASS, TEXT, WS_POPUP | WS_VISIBLE,
        0, 0, 200, 100, 0, 0, 0, 0]);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 1);
    putWide(TEXT, 'Überschrift: “wide” text');
    const answer = fns.MessageBoxW.handler([owner, TEXT, 0, 0]);
    const box = await boxNamed('Error');
    assert.notEqual(box, 0);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 0, 'disabled while the box is up');
    assert.equal(fns.GetWindow.handler([box, 4]), owner, 'GW_OWNER');
    assert.equal(textOf(fns.GetDlgItem.handler([box, 0xffff])).length, 24);
    fns.SendMessageA.handler([fns.GetDlgItem.handler([box, IDOK]), BM_CLICK, 0, 0]);
    assert.equal(await answer, IDOK);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 1, 'and enabled again after');
});

test('unattended, the box is put to the answerer and no window is made', ()=>{
    /** @type {any[]} */
    const asked = [];
    const { fns, put } = setup({ unattended: true, answer: dialog=>{
        asked.push(dialog);
        return IDNO;
    } });
    put(TEXT, 'Overwrite?');
    put(CAPTION, 'Copy');
    assert.equal(fns.MessageBoxA.handler([0, TEXT, CAPTION, MB_YESNO]), IDNO);
    assert.deepEqual(asked.map(dialog=>[dialog.title, dialog.text]), [['Copy', 'Overwrite?']]);
    assert.equal(fns.FindWindowA.handler([0, CAPTION]), 0);
});

test('a box answers with buttons it shows, the default walking the set', ()=>{
    // A box answered outside its own set hands the caller a value its switch
    // has no arm for.
    assert.deepEqual(messageBoxButtons(MB_YESNOCANCEL).map(button=>button.id), [6, 7, 2]);
    assert.equal(messageBoxDefault(MB_YESNO), 6, 'IDYES: the first button');
    assert.equal(messageBoxDefault(MB_YESNO | MB_DEFBUTTON2), 7);
    assert.equal(messageBoxDefault(MB_YESNOCANCEL | MB_DEFBUTTON3), 2);
    assert.equal(messageBoxDefault(MB_RETRYCANCEL), 4);
    assert.equal(messageBoxDefault(MB_ABORTRETRYIGNORE), 3);
    assert.equal(messageBoxDefault(MB_OKCANCEL | MB_DEFBUTTON3), 2,
        'a rank past the last button is the last button');
});
