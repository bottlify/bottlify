/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Dialogs, and the template they are built from.
 *
 * The template is the whole of the risk. Its variable-length parts are counted
 * strings rather than terminated ones and each control begins on a four-byte
 * boundary, so a reader that is wrong about either produces a plausible number
 * of controls at plausible positions -- which looks like a layout bug in the
 * program rather than a parsing bug here. So the fixtures are laid out by hand
 * and the assertions are about where the controls actually landed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from './messages.js';
import { createWindowFunctions } from './windows.js';
import { DIALOG_LAYOUT } from './dialogs.js';
import { decodeAnsi } from '../kernel32/locale.js';

const TEMPLATE = 0x12000;
const TEXT = 0x10400;
const OUT = 0x11200;

const WM_INITDIALOG = DIALOG_LAYOUT.WM_INITDIALOG;
const DS_SETFONT = DIALOG_LAYOUT.DS_SETFONT;

const DIALOGPROC = 0x402000;
const MODULE_BASE = 0x400000;
const HINSTANCE = 0x400000;

function fakeMemory(size = 0x14000){
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
        /** @param {number} address */
        u32: address=>(bytes[address] | bytes[address + 1] << 8
            | bytes[address + 2] << 16 | bytes[address + 3] << 24) >>> 0,
    };
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
    };
}

/**
 * @param {{ resources?: Record<string, number>,
 *           dispatch?: (wndProc: number, message: any, thread?: unknown) => number,
 *           allocate?: (bytes: number) => number,
 *           call?: (entry: number, args: number[], thread?: unknown) => any,
 *           unattended?: boolean, answer?: (dialog: any) => number | Promise<number>,
 *           bitmapFromDib?: (info: number, bits: number) => number }} [options]
 */
function setup({ resources = {}, dispatch = ()=>0, allocate, call, unattended, answer,
    bitmapFromDib } = {})
{
    const memory = fakeMemory();
    const queue = createMessageQueue();
    const fns = createWindowFunctions({
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        queue,
        dispatch,
        allocate,
        call,
        unattended,
        answer,
        release: ()=>{},
        callerThread: ()=>'the caller',
        park: ()=>({ parked: true }),
        // A modal loop awaits this when its queue runs dry, and a test posts
        // its messages after the call that opened the dialog returned -- so it
        // resolves on a macrotask rather than never, or the loop could never
        // see them.
        idle: ()=>new Promise(resolve=>setImmediate(resolve)),
        // A module whose resources sit at fixed offsets from a fixed base:
        // the type is folded into the key so a lookup under the wrong type
        // finds nothing, as the real tree would answer.
        /** @param {number} instance @param {number} type @param {number | string} name */
        findResource: (instance, type, name)=>(
            instance === HINSTANCE && `${type}:${name}` in resources
                ? { rva: resources[`${type}:${name}`], size: 0, codePage: 0, language: 0 }
                : null),
        /** @param {number} instance */
        moduleBase: instance=>(instance === HINSTANCE ? MODULE_BASE : 0),
        bitmapFromDib,
    });
    const table = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (fns));
    return { memory, queue, fns: table };
}

/**
 * A cursor that writes a template the way a resource compiler does: everything
 * little-endian and consecutive, with the alignment that matters spelled out.
 *
 * @param {any} memory @param {number} base
 */
function writer(memory, base){
    let at = 0;
    const put = (/** @type {number} */ byte)=>{
        memory.bytes[base + at] = byte & 0xff;
        at++;
    };
    return {
        get at(){
            return at;
        },
        /** @param {number} value */
        u16(value){
            put(value);
            put(value >>> 8);
            return this;
        },
        /** @param {number} value */
        u32(value){
            this.u16(value & 0xffff);
            this.u16(value >>> 16);
            return this;
        },
        /** A counted UTF-16 string, terminated. @param {string} text */
        sz(text){
            for (const character of text)
            {
                this.u16(character.charCodeAt(0));
            }
            return this.u16(0);
        },
        /** The ordinal form: the marker word, then the number. @param {number} value */
        ordinal(value){
            return this.u16(0xffff).u16(value);
        },
        /** Every item template begins on a four-byte boundary. */
        align(){
            while (true)
            {
                if ((at & 3) === 0)
                {
                    return this;
                }
                put(0);
            }
        },
    };
}

/**
 * A dialog forty units across and twenty down, holding the controls given.
 *
 * @param {any} memory
 * @param {{ id: number, x: number, y: number, cx: number, cy: number, style?: number,
 *           className?: string, ordinal?: number, title?: string, titleOrdinal?: number,
 *           data?: number[] }[]} controls
 * @param {{ style?: number, menu?: string, title?: string, x?: number, y?: number }} [options]
 */
function putTemplate(memory, controls, options = {}){
    const template = writer(memory, TEMPLATE);
    template.u32(options.style ?? 0).u32(0).u16(controls.length);
    template.u16((options.x ?? 10) & 0xffff).u16((options.y ?? 20) & 0xffff).u16(40).u16(20);
    template.sz(options.menu ?? '');
    template.sz('');
    template.sz(options.title ?? 'Dialog');
    if (((options.style ?? 0) & DS_SETFONT) !== 0)
    {
        template.u16(8).sz('MS Sans Serif');
    }
    for (const control of controls)
    {
        template.align();
        template.u32(control.style ?? 0).u32(0);
        template.u16(control.x).u16(control.y).u16(control.cx).u16(control.cy);
        template.u16(control.id);
        if (control.ordinal !== undefined)
        {
            template.ordinal(control.ordinal);
        }
        else
        {
            template.sz(control.className ?? 'BUTTON');
        }
        if (control.titleOrdinal !== undefined)
        {
            template.ordinal(control.titleOrdinal);
        }
        else
        {
            template.sz(control.title ?? '');
        }
        // The creation data: in this layout its size word counts itself.
        template.u16(control.data ? (control.data.length + 1) * 2 : 0);
        for (const word of control.data ?? [])
        {
            template.u16(word);
        }
    }
    return TEMPLATE;
}

test('a template is walked into a dialog and the controls it names', ()=>{
    const { memory, fns } = setup();
    putTemplate(memory, [
        { id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' },
        { id: 101, x: 4, y: 20, cx: 20, cy: 6, title: 'Cancel' },
    ]);

    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0x1234]);
    assert.notEqual(dialog, 0);

    const first = fns.GetDlgItem.handler([dialog, 100]);
    const second = fns.GetDlgItem.handler([dialog, 101]);
    assert.notEqual(first, 0);
    assert.notEqual(second, 0);
    assert.notEqual(first, second);
    assert.equal(fns.GetDlgCtrlID.handler([first]), 100);
    assert.equal(fns.GetDlgItem.handler([dialog, 999]), 0);
});

test('a control is a child of its dialog whatever its template says, its border a sunken edge',
    ()=>{
        // The dialog test's TEST_DLG_CHILD_POPUP: a control with WS_POPUP in
        // its template is still found by its id as a child, the popup bit and
        // the border gone, WS_EX_NOPARENTNOTIFY and for the border
        // WS_EX_CLIENTEDGE in their place.
        const WS_CHILD = 0x40000000;
        const WS_POPUP = 0x80000000;
        const WS_VISIBLE = 0x10000000;
        const WS_BORDER = 0x00800000;
        const WS_EX_NOPARENTNOTIFY = 0x4;
        const WS_EX_CLIENTEDGE = 0x200;
        const { memory, fns } = setup();
        putTemplate(memory, [
            { id: 7, x: 0, y: 0, cx: 40, cy: 10, className: 'static', title: 'bump7',
                style: WS_CHILD | WS_POPUP | WS_BORDER | WS_VISIBLE },
            { id: 8, x: 0, y: 10, cx: 40, cy: 10, className: 'static', title: 'bump8',
                style: WS_POPUP | WS_VISIBLE },
        ]);
        const dialog = fns.CreateDialogIndirectParamA.handler(
            [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
        const bordered = fns.GetDlgItem.handler([dialog, 7]);
        const plain = fns.GetDlgItem.handler([dialog, 8]);
        assert.notEqual(bordered, 0);
        assert.notEqual(plain, 0);
        assert.equal(fns.GetWindowLongA.handler([bordered, -16]) >>> 0, WS_CHILD | WS_VISIBLE);
        assert.equal(fns.GetWindowLongA.handler([bordered, -20]),
            WS_EX_NOPARENTNOTIFY | WS_EX_CLIENTEDGE);
        assert.equal(fns.GetWindowLongA.handler([plain, -16]) >>> 0, WS_CHILD | WS_VISIBLE);
        assert.equal(fns.GetWindowLongA.handler([plain, -20]), WS_EX_NOPARENTNOTIFY);
    });

test('a CBT hook hears of the dialog window and may subclass it before its first message', ()=>{
    // A framework attaches its dialog object to the window from the hook and
    // puts its own procedure in; the dialog's creation messages then reach
    // that procedure, and the dialog procedure hears none of them.
    const HOOK = 0x7000;
    const FRAMEWORK = 0x7100;
    let heap = 0x9000;
    /** @type {number[][]} */
    const hooked = [];
    /** @type {{ hwnd: number, message: number }[]} */
    const reached = [];
    /** @type {any} */
    let table = null;
    const { memory, fns } = setup({
        allocate: (/** @type {number} */ size)=>{
            heap += size;
            return heap - size;
        },
        call: (/** @type {number} */ entry, /** @type {number[]} */ args)=>{
            hooked.push([entry, ...args]);
            table.SetWindowLongA.handler([args[1], -4, FRAMEWORK]);
            return 0;
        },
        dispatch: (/** @type {number} */ address, /** @type {any} */ message)=>{
            if (address === FRAMEWORK)
            {
                reached.push({ hwnd: message.hwnd, message: message.message });
                return message.message === 0x81 ? 1 : 0;
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);
    fns.SetWindowsHookExA.handler([5, HOOK, 0, 0]);

    const dialog = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.notEqual(dialog, 0);
    assert.deepEqual(hooked[0].slice(0, 3), [HOOK, 3, dialog], 'HCBT_CREATEWND, for the dialog');
    assert.deepEqual(reached.filter(m=>m.hwnd === dialog).slice(0, 3).map(m=>m.message),
        [0x81, 0x83, 0x1],
        'WM_NCCREATE, WM_NCCALCSIZE and WM_CREATE reached the procedure the hook put in');
});

test('a dialog named in the resources is the template read where it was mapped', ()=>{
    // CreateDialogParam is CreateDialogIndirectParam over the resource tree:
    // an installer names its welcome dialog by id and nothing more, and a
    // module whose dialogs cannot be found by name has no dialogs at all.
    const RT_DIALOG = 5;
    const { memory, fns } = setup({ resources: { [`${RT_DIALOG}:200`]: TEMPLATE - MODULE_BASE } });
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);

    const dialog = fns.CreateDialogParamA.handler([HINSTANCE, 200, 0, DIALOGPROC, 0]);
    assert.notEqual(dialog, 0);
    assert.notEqual(fns.GetDlgItem.handler([dialog, 100]), 0);
    assert.equal(fns.CreateDialogParamA.handler([HINSTANCE, 201, 0, DIALOGPROC, 0]), 0,
        'a name the module does not carry is no dialog');
    assert.equal(fns.CreateDialogParamA.argBytes, 20);
});

test('DialogBox pumps until EndDialog and answers what it was given', async()=>{
    // The modal form: WM_INITDIALOG reaches the procedure from inside the
    // call, and the call returns only once the procedure has ended the
    // dialog -- on the thread that made the call, named on every delivery
    // because the loop has let the processor go by then.
    /** @type {{ message: number, thread: unknown }[]} */
    const delivered = [];
    /** @type {any} */
    let table = null;
    const { memory, fns } = setup({
        dispatch: (wndProc, message, thread)=>{
            delivered.push({ message: message.message, thread });
            if (message.message === 0x0110)
            {
                table.EndDialog.handler([message.hwnd, 7]);
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);

    const answer = fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.equal(await answer, 7);
    // WM_INITDIALOG on the way in, WM_DESTROY and WM_NCDESTROY on the way
    // out: a modal dialog is destroyed, and its procedure hears so.
    assert.deepEqual(delivered, [
        { message: 0x0110, thread: 'the caller' },
        { message: 0x0002, thread: 'the caller' },
        { message: 0x0082, thread: 'the caller' },
    ]);
    assert.equal(fns.DialogBoxIndirectParamA.handler([HINSTANCE, 0, 0, DIALOGPROC, 0]), -1,
        'and a dialog that cannot be made answers -1 at once');
    assert.equal(fns.DialogBoxIndirectParamA.argBytes, 20);
    assert.equal(fns.DialogBoxParamA.argBytes, 20);
});

/**
 * A dialog whose procedure ends it with whatever button was pressed, run
 * unattended with the answerer given.
 *
 * @param {((dialog: any) => number | Promise<number>) | undefined} answer
 */
const unattendedDialog = answer=>{
    /** @type {any} */
    let table = null;
    const { memory, fns } = setup({
        unattended: true,
        answer,
        dispatch: (wndProc, message)=>{
            if (message.message === 0x0111)
            {
                table.EndDialog.handler([message.hwnd, message.wParam & 0xffff]);
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, [
        { id: 100, x: 4, y: 8, cx: 20, cy: 6, title: '&Cancel' },
        { id: 6, x: 4, y: 20, cx: 20, cy: 6, title: 'Yes', style: 1 },
    ]);
    return fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
};

test('unattended, a modal dialog waiting for input is answered with its default button', async()=>{
    // A silent install run from a terminal: nobody presses anything, so the
    // engine presses Enter -- the default button's WM_COMMAND, which the
    // program's own procedure turns into EndDialog.
    assert.equal(await unattendedDialog(undefined), 6, 'the BS_DEFPUSHBUTTON control, IDYES');
});

test('unattended, the button the answerer chooses is the press the procedure receives', async()=>{
    /** @type {any[]} */
    const asked = [];
    const pressed = await unattendedDialog(dialog=>{
        asked.push(dialog);
        return Promise.resolve(100);
    });
    assert.equal(pressed, 100);
    assert.deepEqual(asked[0].buttons, [
        { id: 100, label: 'Cancel', default: false },
        { id: 6, label: 'Yes', default: true },
    ]);
    assert.equal(asked[0].kind, 'dialog');
});

test('attended, a modal dialog is left waiting for a person', async()=>{
    /** @type {number[]} */
    const heard = [];
    let dialog = 0;
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            heard.push(message.message);
            dialog = message.hwnd;
            return 0;
        },
    });
    putTemplate(memory, [{ id: 6, x: 4, y: 20, cx: 20, cy: 6, title: 'Yes', style: 1 }]);
    const answer = fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    for (let turn = 0; turn < 5; turn++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
    assert.ok(!heard.includes(0x0111), 'no button was pressed');
    fns.EndDialog.handler([dialog, 3]);
    assert.equal(await answer, 3, 'until the person ends it');
});

test('DialogBox shows a dialog whose template does not say WS_VISIBLE', async()=>{
    // Most templates leave the bit off: the modal call is what shows the
    // window, and a dialog left invisible is a program that appears to do
    // nothing when its own menu is clicked. The showing happens after
    // WM_INITDIALOG, so that is where it is looked at.
    /** @type {any} */
    let table = null;
    /** @type {number} */
    let visibleAtInit = -1;
    let visibleWhileUp = -1;
    let inits = 0;
    const MARKER = 0x0400; // WM_USER
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (message.message === WM_INITDIALOG)
            {
                // The modeless dialog made below initialises first and is not
                // the one being looked at; only the modal one posts a marker.
                if (++inits === 2)
                {
                    visibleAtInit = table.IsWindowVisible.handler([message.hwnd]);
                    table.PostMessageA.handler([message.hwnd, MARKER, 0, 0]);
                }
            }
            if (message.message === MARKER)
            {
                visibleWhileUp = table.IsWindowVisible.handler([message.hwnd]);
                table.EndDialog.handler([message.hwnd, 1]);
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);
    const modeless = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.equal(fns.IsWindowVisible.handler([modeless]), 0,
        'a modeless dialog stays as the template made it');

    await fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.equal(visibleAtInit, 0, 'not shown yet while its procedure runs');
    assert.equal(visibleWhileUp, 1, 'and shown once the modal loop is running');
});

test('a message sent to a control with no procedure is answered with nothing', ()=>{
    // The same control SendDlgItemMessage already answers zero for: sent to
    // by handle instead, it used to ask the bridge to run code at address
    // zero, which stopped the machine inside the dialog's own initialisation.
    const { memory, fns } = setup({
        // The dialog's own WM_INITDIALOG is sent during creation and is the
        // one call a program made; nothing else has a procedure to run.
        dispatch: (wndProc, message)=>{
            if (message.message !== WM_INITDIALOG)
            {
                throw new Error('nothing to run');
            }
            return 0;
        },
    });
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const control = fns.GetDlgItem.handler([dialog, 100]);

    const BM_SETCHECK = 0x00f1;
    assert.equal(fns.SendMessageA.handler([control, BM_SETCHECK, 1, 0]), 0);

    const MSG = 0x3000;
    memory.writeMemory(MSG, Uint8Array.of(control, control >>> 8, control >>> 16, control >>> 24,
        BM_SETCHECK, 0, 0, 0));
    assert.equal(fns.DispatchMessageA.handler([MSG]), 0, 'and dispatched, the same');
});

test('Enter and Escape in a modal loop reach the procedure as a button\'s commands', async()=>{
    // The dialog manager's two keys: Enter is the default push button, or
    // IDOK without one, and Escape is IDCANCEL. A headless driver ends a
    // dialog this way, and so does a person who never touches the mouse.
    /** @type {any[]} */
    const delivered = [];
    /** @type {any} */
    let table = null;
    const { memory, queue, fns } = setup({
        dispatch: (wndProc, message, thread)=>{
            delivered.push({ ...message, thread });
            if (message.message === 0x0111 && (message.wParam & 0xffff) === 7)
            {
                table.EndDialog.handler([message.hwnd, 42]);
            }
            return 0;
        },
    });
    table = fns;
    const BS_DEFPUSHBUTTON = 1;
    putTemplate(memory, [
        { id: 1, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' },
        { id: 7, x: 4, y: 20, cx: 20, cy: 6, title: 'Go', style: BS_DEFPUSHBUTTON },
    ]);
    const answer = fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const dialog = delivered.length ? delivered[0].hwnd : 0;
    assert.notEqual(dialog, 0, 'WM_INITDIALOG named the dialog');
    const go = fns.GetDlgItem.handler([dialog, 7]);
    queue.post({ hwnd: dialog, message: 0x0100, wParam: 0x1b, lParam: 0 });
    queue.post({ hwnd: dialog, message: 0x0100, wParam: 0x0d, lParam: 0 });
    assert.equal(await answer, 42);

    const commands = delivered.filter(one=>one.message === 0x0111);
    assert.deepEqual(commands.map(one=>one.wParam & 0xffff), [2, 7],
        'Escape is IDCANCEL; Enter is the default button, not IDOK');
    assert.equal(commands[1].lParam, go, 'and the command names the button it stands for');
    assert.equal(commands[1].thread, 'the caller');
});

test('IsDialogMessage takes Enter for IDOK and dispatches anything else inside the dialog', ()=>{
    /** @type {any[]} */
    const delivered = [];
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            delivered.push(message);
            return 0;
        },
    });
    putTemplate(memory, [{ id: 1, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const control = fns.GetDlgItem.handler([dialog, 1]);
    // The dialog's own WM_INITDIALOG ran during the create; only the key's
    // messages are what this test is about.
    delivered.length = 0;

    const MSG = 0x3000;
    memory.writeMemory(MSG, Uint8Array.of(control, control >>> 8, control >>> 16, control >>> 24,
        0x00, 0x01, 0, 0, 0x0d));
    assert.equal(fns.IsDialogMessageA.handler([dialog, MSG]), 1, 'Enter on a control inside');
    // The dialog is asked for its default button first, and told the click.
    assert.deepEqual(delivered.map(one=>[one.message, one.wParam & 0xffff]),
        [[0x0400, 0], [0x0111, 1]]);

    // Any other message for a window inside is translated and dispatched by
    // the call itself, so it answers TRUE and the caller does not dispatch it
    // again (Wine's test_IsDialogMessage).
    memory.writeMemory(MSG + 8, Uint8Array.of(0x41));
    delivered.length = 0;
    assert.equal(fns.IsDialogMessageA.handler([dialog, MSG]), 1, 'a letter is dispatched');
    memory.writeMemory(MSG, Uint8Array.of(dialog, dialog >>> 8, dialog >>> 16, dialog >>> 24,
        0x00, 0x04, 0, 0, 0x05));
    assert.equal(fns.IsDialogMessageA.handler([dialog, MSG]), 1);
    assert.deepEqual(delivered.map(one=>[one.message, one.wParam]), [[0x0400, 5]],
        'a message for the dialog itself reached its procedure');
    memory.writeMemory(MSG, Uint8Array.of(0x99, 0, 0, 0, 0, 0x01, 0, 0, 0x0d));
    assert.equal(fns.IsDialogMessageA.handler([dialog, MSG]), 0,
        'nor is Enter in a window outside the dialog');
    assert.equal(fns.IsDialogMessageA.argBytes, 8);
});

test('a modal dialog disables its owner until it ends', async()=>{
    const OWNERPROC = 0x402100;
    /** @type {any} */
    let table = null;
    /** @type {number} */
    let owner = 0;
    let enabledWhileUp = -1;
    const MARKER = 0x0400; // WM_USER
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (wndProc === DIALOGPROC && message.message === WM_INITDIALOG)
            {
                // Delivered once the modal loop is running, which is where the
                // owner's state is the one the program would read.
                table.PostMessageA.handler([message.hwnd, MARKER, 0, 0]);
            }
            if (wndProc === DIALOGPROC && message.message === MARKER)
            {
                enabledWhileUp = table.IsWindowEnabled.handler([owner]);
                table.EndDialog.handler([message.hwnd, 7]);
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, []);
    owner = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, OWNERPROC, 0]);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 1);

    const answer = fns.DialogBoxIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, owner, DIALOGPROC, 0]);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 0, 'disabled while the dialog is up');
    assert.equal(await answer, 7);
    assert.equal(enabledWhileUp, 0, 'the program saw it disabled from inside its own loop');
    assert.equal(fns.IsWindowEnabled.handler([owner]), 1, 'and enabled again after');
});

test('CheckRadioButton tells every button in the range, and only the one named is checked', ()=>{
    /** @type {{ wndProc: number, hwnd: number, message: number, wParam: number }[]} */
    const sent = [];
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            sent.push({ wndProc, hwnd: message.hwnd, message: message.message,
                wParam: message.wParam });
            return 0;
        },
    });
    putTemplate(memory, [
        { id: 10, x: 0, y: 0, cx: 4, cy: 4 },
        { id: 11, x: 0, y: 4, cx: 4, cy: 4 },
        { id: 12, x: 0, y: 8, cx: 4, cy: 4 },
        { id: 20, x: 0, y: 12, cx: 4, cy: 4 },
    ]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    // A control has no procedure of its own and a message to it runs
    // nothing, so two of the three are given one, as a program subclassing
    // its buttons would; the third shows a procedure-less one is skipped.
    const GWL_WNDPROC = -4;
    const BUTTONPROC = 0x403000;
    const BM_SETCHECK = 0x00f1;
    fns.SetWindowLongA.handler([fns.GetDlgItem.handler([dialog, 10]), GWL_WNDPROC, BUTTONPROC]);
    fns.SetWindowLongA.handler([fns.GetDlgItem.handler([dialog, 11]), GWL_WNDPROC, BUTTONPROC]);
    fns.SetWindowLongA.handler([fns.GetDlgItem.handler([dialog, 20]), GWL_WNDPROC, BUTTONPROC]);
    // The dialog's own WM_INITDIALOG ran during the create; only the checks
    // CheckRadioButton sends are what this test is about.
    sent.length = 0;

    assert.equal(fns.CheckRadioButton.argBytes, 16);
    assert.equal(fns.CheckRadioButton.handler([dialog, 10, 12, 11]), 1);
    assert.deepEqual(sent.map(one=>[one.wndProc, one.hwnd, one.message, one.wParam]), [
        [BUTTONPROC, fns.GetDlgItem.handler([dialog, 10]), BM_SETCHECK, 0],
        [BUTTONPROC, fns.GetDlgItem.handler([dialog, 11]), BM_SETCHECK, 1],
    ], 'the button outside the range is not told, and one with no procedure runs nothing');
    assert.equal(fns.CheckRadioButton.handler([0x9999, 10, 12, 11]), 0, 'no dialog, no buttons');
});

test('the base units and MapDialogRect scale the way the template was scaled', ()=>{
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 800, x: 10, y: 20, cx: 40, cy: 8 }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const control = fns.GetDlgItem.handler([dialog, 800]);

    const units = fns.GetDialogBaseUnits.handler([]);
    assert.equal(units & 0xffff, DIALOG_LAYOUT.CHAR_WIDTH);
    assert.equal(units >>> 16, DIALOG_LAYOUT.CHAR_HEIGHT);

    const view = new DataView(memory.bytes.buffer);
    for (const [at, value] of [10, 20, 50, 28].entries())
    {
        view.setInt32(OUT + at * 4, value, true);
    }
    assert.equal(fns.MapDialogRect.handler([dialog, OUT]), 1);
    // The control's rectangle is on the screen; the template's is in the
    // dialog's client area, so it is brought back there before comparing.
    fns.GetWindowRect.handler([control, OUT + 16]);
    fns.ScreenToClient.handler([dialog, OUT + 16]);
    fns.ScreenToClient.handler([dialog, OUT + 24]);
    for (const at of [0, 1, 2, 3])
    {
        assert.equal(view.getInt32(OUT + at * 4, true), view.getInt32(OUT + 16 + at * 4, true),
            'the mapped rectangle is where the template put the control');
    }
    assert.equal(fns.MapDialogRect.handler([0x9999, OUT]), 0);
});

test('a quit retrieved inside a modal loop ends the dialog, which answers IDOK, and is put '
    + 'back', async()=>{
    // user32's window tests (test_dialog_parent): a dialog its loop left on a
    // WM_QUIT, never ended, answers IDOK.
    const { memory, queue, fns } = setup();
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6 }]);
    queue.postQuit(3);

    assert.equal(await fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]),
        1, 'IDOK');
    assert.equal(queue.quitPending(), true, 'the loop outside has yet to see it');
});

test('input over a dialog is placed without running the program, whose dialog procedure is '
    + 'asked WM_NCHITTEST on the thread that takes the message', async()=>{
    // user32's message tests (WmMove_mouse): WM_NCHITTEST reaches the window
    // under the pointer from the thread taking the input, a dialog's
    // procedure first as for every message it gets. The input layer's
    // messages are routed as they arrive, when no thread of the program is
    // there to run it on.
    const WS_VISIBLE = 0x10000000;
    const WM_NCHITTEST = 0x0084;
    const WM_LBUTTONDOWN = 0x0201;
    const PM_REMOVE = 1;
    /** @type {[number, unknown][]} */
    const heard = [];
    const { memory, queue, fns } = setup({ dispatch: (wndProc, message, thread)=>{
        heard.push([message.message, thread]);
        return 0;
    } });
    putTemplate(memory, [], { style: WS_VISIBLE });
    const dialog = await fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0,
        DIALOGPROC, 0]);
    memory.writeMemory(OUT, new Uint8Array(new Uint32Array([2, 2]).buffer));
    fns.ClientToScreen.handler([dialog, OUT]);
    const [x, y] = [memory.u32(OUT), memory.u32(OUT + 4)];
    heard.length = 0;

    queue.post({ hwnd: 0, message: WM_LBUTTONDOWN, wParam: 1, lParam: 0, x, y });
    assert.deepEqual([...heard], [], 'nothing of the program runs as the input arrives');

    assert.equal(await fns.PeekMessageA.handler([OUT, 0, 0, 0, PM_REMOVE]), 1);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [dialog, WM_LBUTTONDOWN]);
    assert.deepEqual(heard.find(([message])=>message === WM_NCHITTEST),
        [WM_NCHITTEST, 'the caller'], 'asked as the message is taken, on the taking thread');
});

test('a modal loop takes a mouse message the way GetMessage takes it, the window under the '
    + 'pointer asked WM_SETCURSOR first', async()=>{
    // user32's message tests (WmMove_mouse): WM_SETCURSOR is sent to the
    // window under the pointer as each mouse message of the input is taken,
    // whichever loop takes it -- here the dialog manager's own.
    const WM_USER = 0x0400;
    const WM_SETCURSOR = 0x0020;
    const WM_MOUSEMOVE = 0x0200;
    /** @type {number[]} */
    const heard = [];
    /** @type {any} */
    let table = null;
    const { memory, queue, fns } = setup({ dispatch: (wndProc, message)=>{
        heard.push(message.message);
        if (message.message === WM_INITDIALOG)
        {
            table.PostMessageA.handler([message.hwnd, WM_USER, 0, 0]);
        }
        else if (message.message === WM_USER)
        {
            // Shown by now: the pointer moves over its client area, clear of
            // the control.
            table.GetClientRect.handler([message.hwnd, OUT]);
            const height = memory.u32(OUT + 12);
            memory.writeMemory(OUT, new Uint8Array(new Uint32Array([2, height - 2]).buffer));
            table.ClientToScreen.handler([message.hwnd, OUT]);
            queue.post({ hwnd: 0, message: WM_MOUSEMOVE, wParam: 0, lParam: 0,
                x: memory.u32(OUT), y: memory.u32(OUT + 4) });
        }
        else if (message.message === WM_MOUSEMOVE)
        {
            table.EndDialog.handler([message.hwnd, 5]);
        }
        return 0;
    } });
    table = fns;
    putTemplate(memory, [{ id: 100, x: 4, y: 2, cx: 20, cy: 6 }]);
    assert.equal(await fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC,
        0]), 5);
    const moved = heard.indexOf(WM_MOUSEMOVE);
    assert.ok(moved > 0, 'the move reached the dialog');
    assert.equal(heard.slice(heard.indexOf(WM_USER), moved).includes(WM_SETCURSOR), true,
        'asked for its cursor before it was handed the move');
});

test('DialogBox answers -1 for a dialog its procedure destroyed during WM_INITDIALOG, and 0 '
    + 'for one destroyed later', async()=>{
    // user32's dialog tests (test_DialogBoxParam): DestroyWindow from
    // WM_INITDIALOG leaves no dialog to run, and DialogBox answers -1;
    // destroyed from WM_CLOSE once it runs, it answers 0; EndDialog from
    // WM_INITDIALOG answers what EndDialog was given.
    const WM_CLOSE = 0x0010;
    /** @type {any} */
    let table = null;
    let how = 'destroy';
    const { memory, fns } = setup({ dispatch: (wndProc, message)=>{
        if (message.message === WM_INITDIALOG)
        {
            if (how === 'destroy')
            {
                table.DestroyWindow.handler([message.hwnd]);
            }
            else if (how === 'end')
            {
                table.EndDialog.handler([message.hwnd, 1]);
            }
            else
            {
                table.PostMessageA.handler([message.hwnd, WM_CLOSE, 0, 0]);
            }
            return 1;
        }
        if (message.message === WM_CLOSE)
        {
            table.DestroyWindow.handler([message.hwnd]);
            return 1;
        }
        return 0;
    } });
    table = fns;
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6 }]);
    const run = ()=>fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.equal(await run(), -1);
    how = 'end';
    assert.equal(await run(), 1);
    how = 'close';
    assert.equal(await run(), 0);
});

test('a dialog of its own is moved wholly onto the screen, wherever its template put it', ()=>{
    // A setup whose owner window was zero pixels tall at the top of the screen
    // had a box placed above it, caption and all; the dialog manager moves a
    // top-level dialog into the screen's area.
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 100, x: 2, y: 2, cx: 10, cy: 4 }], { x: -30, y: -60 });
    const dialog = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    fns.GetWindowRect.handler([dialog, OUT]);
    assert.equal(memory.u32(OUT), 0, 'left');
    assert.equal(memory.u32(OUT + 4), 0, 'top');

    putTemplate(memory, [{ id: 100, x: 2, y: 2, cx: 10, cy: 4 }], { x: 4000, y: 4000 });
    const far = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    fns.GetWindowRect.handler([far, OUT]);
    assert.ok(memory.u32(OUT + 8) <= 640 && memory.u32(OUT + 12) <= 480,
        'nor past the right and bottom edges');
});

test('coordinates are dialog units, not pixels', ()=>{
    // Four horizontal units to a character width and eight vertical to a
    // character height. Read as pixels, every control lands in the top-left
    // eighth of the dialog and it looks like the program laid it out wrong.
    const { memory, fns } = setup();
    const { CHAR_WIDTH, CHAR_HEIGHT, DLU_PER_CHAR_X, DLU_PER_CHAR_Y } = DIALOG_LAYOUT;
    putTemplate(memory, [{ id: 100, x: 8, y: 16, cx: 40, cy: 8 }]);

    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const control = fns.GetDlgItem.handler([dialog, 100]);

    fns.GetWindowRect.handler([control, OUT]);
    fns.ScreenToClient.handler([dialog, OUT]);
    fns.ScreenToClient.handler([dialog, OUT + 8]);
    assert.equal(memory.u32(OUT), 8 * CHAR_WIDTH / DLU_PER_CHAR_X, 'x');
    assert.equal(memory.u32(OUT + 4), 16 * CHAR_HEIGHT / DLU_PER_CHAR_Y, 'y');
    assert.equal(memory.u32(OUT + 8) - memory.u32(OUT),
        40 * CHAR_WIDTH / DLU_PER_CHAR_X, 'width');
    assert.equal(memory.u32(OUT + 12) - memory.u32(OUT + 4),
        8 * CHAR_HEIGHT / DLU_PER_CHAR_Y, 'height');
});

test('the variable-length names are counted, so what follows them is found', ()=>{
    // A menu name, a font block and an ordinal class are each a different
    // length. A reader that assumed any of them would land on the wrong byte
    // for every control after it.
    const { memory, fns } = setup();
    putTemplate(memory, [
        { id: 200, x: 2, y: 2, cx: 10, cy: 4, ordinal: 0x0080, title: 'Push' },
        { id: 201, x: 2, y: 8, cx: 10, cy: 4, className: 'STATIC', title: 'Label' },
    ], { style: DS_SETFONT, menu: 'MainMenu', title: 'Settings' });

    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.notEqual(fns.GetDlgItem.handler([dialog, 200]), 0);
    assert.notEqual(fns.GetDlgItem.handler([dialog, 201]), 0);

    fns.GetWindowTextA.handler([dialog, OUT, 32]);
    assert.equal(memory.readCString(OUT, 32), 'Settings');
});

test('a control is a child window, and carries the text the template gave it', ()=>{
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 300, x: 0, y: 0, cx: 10, cy: 4, title: 'Ready' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);

    assert.equal(fns.GetDlgItemTextA.handler([dialog, 300, OUT, 32]), 5);
    assert.equal(memory.readCString(OUT, 32), 'Ready');

    memory.putString(TEXT, 'Working');
    assert.equal(fns.SetDlgItemTextA.handler([dialog, 300, TEXT]), 1);
    assert.equal(fns.GetDlgItemTextA.handler([dialog, 300, OUT, 32]), 7);
    assert.equal(memory.readCString(OUT, 32), 'Working');

    // A control that is not there still leaves a terminated buffer: the caller
    // reads it after a zero length and must not find what was there before.
    assert.equal(fns.GetDlgItemTextA.handler([dialog, 999, OUT, 32]), 0);
    assert.equal(memory.readCString(OUT, 32), '');
});

test('a control\'s upper-half text reads back as the bytes it was set as', ()=>{
    // SetDlgItemTextA's text is read as Windows-1252, where 0x80 is the euro
    // sign, 0x99 the trade mark and 0x97 an em dash, and GetDlgItemTextA
    // writes it back in that page.
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 300, x: 0, y: 0, cx: 10, cy: 4, title: 'Ready' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    memory.bytes.set([0x80, 0x99, 0x97, 0xe9, 0], TEXT);
    assert.equal(fns.SetDlgItemTextA.handler([dialog, 300, TEXT]), 1);
    assert.equal(fns.GetDlgItemTextA.handler([dialog, 300, OUT, 32]), 4);
    assert.deepEqual([...memory.bytes.subarray(OUT, OUT + 5)], [0x80, 0x99, 0x97, 0xe9, 0]);
});

test('a control of a class the program registered is the window of that class', async()=>{
    // A template names the program's own control class beside the system
    // ones. Such a control has the class's procedure and extra bytes, and is
    // told it exists before the dialog is told to initialise -- the order a
    // procedure that sets the control up from WM_INITDIALOG depends on.
    const METER_PROC = 0x403000;
    const CLASS_STRUCT = 0x10800;
    const CLASS_NAME = 0x10900;
    /** @type {{ wndProc: number, message: number, lParam: number }[]} */
    const seen = [];
    /** CREATESTRUCT's hwndParent and hMenu, read while the procedure has it. */
    /** @type {number[]} */
    const created = [];
    const WM_NCCREATE = 0x0081;
    const { memory, fns } = setup({
        allocate: ()=>0x13000,
        dispatch: (wndProc, message)=>{
            seen.push({ wndProc, message: message.message, lParam: message.lParam });
            if (message.message === WM_NCCREATE && created.length === 0)
            {
                created.push(memory.u32(message.lParam + 12), memory.u32(message.lParam + 8));
            }
            // TRUE to WM_NCCREATE, as the default procedure answers it.
            return message.message === WM_NCCREATE ? 1 : 0;
        },
    });
    memory.putString(CLASS_NAME, 'meter');
    memory.writeMemory(CLASS_STRUCT, new Uint8Array(new Uint32Array([
        0, METER_PROC, 0, 8, HINSTANCE, 0, 0, 0, 0, CLASS_NAME,
    ]).buffer));
    assert.notEqual(fns.RegisterClassA.handler([CLASS_STRUCT]), 0);
    putTemplate(memory, [
        { id: 201, x: 4, y: 8, cx: 30, cy: 4, className: 'Meter' },
        { id: 1, x: 4, y: 14, cx: 20, cy: 6, title: 'OK' },
    ]);

    const dialog = await fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const meter = fns.GetDlgItem.handler([dialog, 201]);
    assert.notEqual(meter, 0);
    const WM_CREATE = 0x0001;
    const WM_SIZE = 0x0005;
    const WM_MOVE = 0x0003;
    const WM_NCCALCSIZE = 0x0083;
    assert.deepEqual(seen.map(call=>[call.wndProc, call.message]),
        [[METER_PROC, WM_NCCREATE], [METER_PROC, WM_NCCALCSIZE], [METER_PROC, WM_CREATE],
            [METER_PROC, WM_SIZE], [METER_PROC, WM_MOVE], [DIALOGPROC, WM_INITDIALOG]],
        'the control was told it exists and its size, then the dialog initialised, all'
        + ' during the call');
    assert.equal(created[0], dialog, 'CREATESTRUCT.hwndParent');
    assert.equal(created[1], 201, 'CREATESTRUCT.hMenu is the id');
    assert.equal(fns.SetWindowWord.handler([meter, 0, 7]), 0, 'and it has the extra bytes');
    assert.equal(fns.GetWindowWord.handler([meter, 0]), 7);
    assert.notEqual(fns.GetWindowLongA.handler([fns.GetDlgItem.handler([dialog, 1]), -4]),
        METER_PROC, 'a system-class control keeps the system procedure, not its own');
});

test('a registered-class control is created under the name its template gives', async()=>{
    // A splash control loads its picture from WM_CREATE with
    // FindResource(hInstance, lpszName, ...): an ordinal title reaches it as
    // "#id", the string form of that ordinal, and a text title as the text.
    const PICTURE_PROC = 0x403000;
    const CLASS_STRUCT = 0x10800;
    const CLASS_NAME = 0x10900;
    const WM_CREATE = 0x0001;
    let next = 0x13000;
    /** @type {string[]} */
    const names = [];
    const { memory, fns } = setup({
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 15) & ~15;
            return at;
        },
        dispatch: (_wndProc, message)=>{
            if (message.message === WM_CREATE)
            {
                const name = memory.u32(message.lParam + 0x24);
                names.push(name < 0x10000 ? `ordinal ${name}` : memory.readCString(name, 64));
            }
            return message.message === 0x0081 ? 1 : 0;
        },
    });
    memory.putString(CLASS_NAME, 'picture');
    memory.writeMemory(CLASS_STRUCT, new Uint8Array(new Uint32Array([
        0, PICTURE_PROC, 0, 0, HINSTANCE, 0, 0, 0, 0, CLASS_NAME,
    ]).buffer));
    assert.notEqual(fns.RegisterClassA.handler([CLASS_STRUCT]), 0);
    putTemplate(memory, [
        { id: 201, x: 4, y: 8, cx: 30, cy: 4, className: 'Picture', titleOrdinal: 105 },
        { id: 202, x: 4, y: 14, cx: 30, cy: 4, className: 'Picture', title: 'Splash' },
    ]);
    await fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.deepEqual(names, ['#105', 'Splash']);
});

test('WM_INITDIALOG carries the parameter the caller passed', ()=>{
    /** @type {number[]} */
    const params = [];
    const { memory, queue, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (message.message === WM_INITDIALOG)
            {
                params.push(message.lParam);
            }
            return 0;
        },
    });
    putTemplate(memory, [{ id: 400, x: 0, y: 0, cx: 4, cy: 4 }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0xcafe]);

    assert.notEqual(dialog, 0);
    assert.deepEqual(params, [0xcafe], 'the initialisation parameter, sent during the call');
    assert.equal(queue.depth(), 0, 'and nothing was left posted for a loop to find');
});

test('an extended template is read with its own layout, font block and item ids', ()=>{
    // Every field past the signature sits somewhere else: the style comes
    // after the extended style, the font carries a weight and a charset, an
    // item id is a DWORD and the creation-data count does not count itself.
    // Read with the ordinary layout it would be a dialog of plausible nonsense.
    const { memory, fns } = setup();
    const template = writer(memory, TEMPLATE);
    template.u16(1).u16(0xffff);
    template.u32(0).u32(0x00000001).u32(DS_SETFONT | 0x80000000).u16(2);
    template.u16(10).u16(20).u16(40).u16(20);
    template.sz('').sz('').sz('Progress');
    template.u16(8).u16(400).u16(0x0100).sz('MS Sans Serif');
    for (const control of [
        { id: 0x10064, x: 4, y: 8, cx: 20, cy: 6, ordinal: 0x82, title: 'Preparing', extra: 4 },
        { id: 101, x: 4, y: 20, cx: 20, cy: 6, ordinal: 0x80, title: 'Cancel', extra: 0 },
    ])
    {
        template.align();
        template.u32(0).u32(0).u32(0);
        template.u16(control.x).u16(control.y).u16(control.cx).u16(control.cy);
        template.u32(control.id);
        template.ordinal(control.ordinal).sz(control.title);
        template.u16(control.extra);
        for (let at = 0; at < control.extra; at++)
        {
            template.u16(0xeeee);
            at++;
        }
    }

    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.notEqual(dialog, 0);
    const label = fns.GetDlgItem.handler([dialog, 100]);
    const button = fns.GetDlgItem.handler([dialog, 101]);
    assert.notEqual(label, 0, 'the id is the low word of the DWORD');
    assert.notEqual(button, 0, 'and the creation data of the first item was stepped over');
    assert.equal(memory.readCString(
        (fns.GetDlgItemTextA.handler([dialog, 101, OUT, 32]), OUT), 32), 'Cancel');
});

test('EndDialog hides a dialog, and destroying it takes the controls it owns', ()=>{
    // EndDialog destroys nothing on Windows: a modal dialog is destroyed by
    // the loop running it once it sees the dialog ended, and a modeless one
    // -- a framework's modal loop is one -- by the DestroyWindow after.
    const { memory, fns } = setup();
    const WS_VISIBLE = 0x10000000;
    putTemplate(memory, [{ id: 500, x: 0, y: 0, cx: 4, cy: 4 }], { style: WS_VISIBLE });
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const control = fns.GetDlgItem.handler([dialog, 500]);
    assert.equal(fns.IsWindowVisible.handler([dialog]), 1);

    assert.equal(fns.EndDialog.handler([dialog, 7]), 1);
    assert.equal(fns.IsWindow.handler([dialog]), 1, 'ended, not destroyed');
    assert.equal(fns.IsWindowVisible.handler([dialog]), 0, 'but hidden');
    assert.equal(fns.DestroyWindow.handler([dialog]), 1);
    assert.equal(fns.IsWindow.handler([dialog]), 0);
    assert.equal(fns.IsWindow.handler([control]), 0, 'a child outliving its parent is a leak');
});

test("a static showing a bitmap loads it from its template's module by the name it gives",
    ()=>{
        // A launcher's banner is a static whose title in the template is the
        // ordinal of a bitmap in the module the template came from, which the
        // static loads as it is made; left unloaded, the banner is blank.
        const RT_BITMAP = 2;
        const SS_BITMAP = 0x0e;
        const STATIC_ATOM = 0x82;
        const STM_GETIMAGE = 0x0173;
        /** @type {number[]} */
        const made = [];
        const { memory, fns } = setup({
            resources: { [`${RT_BITMAP}:104`]: 0x100 },
            bitmapFromDib: (/** @type {number} */ info)=>{
                made.push(info);
                return 0x4440;
            },
        });
        putTemplate(memory, [
            { id: 7, x: 0, y: 0, cx: 10, cy: 10, ordinal: STATIC_ATOM, style: SS_BITMAP,
                titleOrdinal: 104 },
            { id: 8, x: 0, y: 10, cx: 10, cy: 10, ordinal: STATIC_ATOM, title: 'Words' },
        ]);
        const dialog = fns.CreateDialogIndirectParamA.handler(
            [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
        const picture = fns.GetDlgItem.handler([dialog, 7]);
        assert.equal(fns.SendMessageA.handler([picture, STM_GETIMAGE, 0, 0]), 0x4440);
        assert.deepEqual(made, [MODULE_BASE + 0x100], "bitmap 104, of the template's module");
        assert.equal(fns.SendMessageA.handler([fns.GetDlgItem.handler([dialog, 8]),
            STM_GETIMAGE, 0, 0]), 0, 'and a static of text loads nothing');
    });

test('a dropdown combo box a template makes is as tall as its field', ()=>{
    // The template's height is the dropped list's, as for one CreateWindowEx
    // makes; the dialog manager's controls are told WM_CREATE like any.
    const COMBOBOX_ATOM = 0x85;
    const CBS_DROPDOWNLIST = 0x0003;
    const WS_VSCROLL = 0x00200000;
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 9, x: 0, y: 0, cx: 40, cy: 60, ordinal: COMBOBOX_ATOM,
        style: CBS_DROPDOWNLIST | WS_VSCROLL }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const combo = fns.GetDlgItem.handler([dialog, 9]);
    const RECT = 0x13000;
    fns.GetWindowRect.handler([combo, RECT]);
    const height = memory.u32(RECT + 12) - memory.u32(RECT + 4);
    assert.ok(height > 8 && height < 40, `the field's height: ${height}`);
    assert.equal(fns.GetWindowLongA.handler([combo, -16]) & WS_VSCROLL, 0);
});

test('a message is reported as not a dialog message, so the caller dispatches it', ()=>{
    // Claiming a message was handled would swallow every keystroke a dialog is
    // open for, and there is no focus to move between controls that have no
    // procedures of their own.
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 600, x: 0, y: 0, cx: 4, cy: 4 }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);

    assert.equal(fns.IsDialogMessageA.handler([dialog, OUT]), 0);
});

test('CheckDlgButton tells the one button, passing the state through', ()=>{
    /** @type {{ hwnd: number, message: number, wParam: number }[]} */
    const sent = [];
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            sent.push({ hwnd: message.hwnd, message: message.message, wParam: message.wParam });
            return 0;
        },
    });
    putTemplate(memory, [{ id: 10, x: 0, y: 0, cx: 4, cy: 4 }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const GWL_WNDPROC = -4;
    const BUTTONPROC = 0x403000;
    const BM_SETCHECK = 0x00f1;
    const BST_INDETERMINATE = 2;
    const button = fns.GetDlgItem.handler([dialog, 10]);
    fns.SetWindowLongA.handler([button, GWL_WNDPROC, BUTTONPROC]);

    assert.equal(fns.CheckDlgButton.argBytes, 12);
    assert.equal(fns.CheckDlgButton.handler([dialog, 10, 1]), 1);
    // Passed through rather than reduced to a boolean: the third state is one a
    // three-state button keeps and a program reads back.
    assert.equal(fns.CheckDlgButton.handler([dialog, 10, BST_INDETERMINATE]), 1);
    assert.deepEqual(sent.filter(one=>one.message === BM_SETCHECK), [
        { hwnd: button, message: BM_SETCHECK, wParam: 1 },
        { hwnd: button, message: BM_SETCHECK, wParam: BST_INDETERMINATE },
    ]);

    assert.equal(fns.CheckDlgButton.handler([dialog, 99, 1]), 0, 'no such control');
    assert.equal(fns.CheckDlgButton.handler([0x9999, 10, 1]), 0, 'no such dialog');
});

/**
 * A program's own dialog class, as a custom dialog is built: DefDlgProc for
 * its procedure and the dialog's extra bytes, with a window of it made.
 *
 * @param {ReturnType<typeof setup>} context @param {number} wndProc
 */
function customDialog({ memory, fns }, wndProc){
    const DLGWINDOWEXTRA = 30;
    const WS_POPUP = 0x80000000;
    const CLASS_STRUCT = 0x10800;
    const CLASS_NAME = 0x10900;
    memory.putString(CLASS_NAME, 'TestDialogClass');
    memory.writeMemory(CLASS_STRUCT, new Uint8Array(new Uint32Array([
        0, wndProc, 0, DLGWINDOWEXTRA, HINSTANCE, 0, 0, 0, 0, CLASS_NAME,
    ]).buffer));
    assert.notEqual(fns.RegisterClassA.handler([CLASS_STRUCT]), 0);
    return fns.CreateWindowExA.handler(
        [0, CLASS_NAME, 0, WS_POPUP, 0, 0, 100, 100, 0, 0, HINSTANCE, 0]);
}

test('DefDlgProcA hands a message to the dialog procedure first, as a dialog class does', ()=>{
    // As documented for DefDlgProc: it forwards to the procedure in
    // DWLP_DLGPROC and does the default processing only for what that
    // procedure answers FALSE, the answer of a handled one being
    // DWLP_MSGRESULT.
    const DEFDLGPROC = 0x404000;
    const DWLP_MSGRESULT = 0;
    const DWLP_DLGPROC = 4;
    // Past the dialog manager's own DM_ messages, which start at WM_USER.
    const WM_APP_MESSAGE = 0x0500;
    const WM_CTLCOLORDLG = 0x0136;
    /** @type {number[]} */
    const asked = [];
    /** @type {ReturnType<typeof setup> | null} */
    let context = null;
    context = setup({
        dispatch: (wndProc, message)=>{
            if (wndProc !== DIALOGPROC)
            {
                return 0;
            }
            asked.push(message.message);
            if (message.message === WM_APP_MESSAGE)
            {
                context?.fns.SetWindowLongA.handler([message.hwnd, DWLP_MSGRESULT, 0x55]);
                return 1;
            }
            return 0;
        },
    });
    const { fns } = context;
    const dialog = customDialog(context, DEFDLGPROC);
    fns.SetWindowLongA.handler([dialog, DWLP_DLGPROC, DIALOGPROC]);

    assert.equal(fns.DefDlgProcA.handler([dialog, WM_APP_MESSAGE, 1, 2]), 0x55,
        'handled: the answer is DWLP_MSGRESULT');
    assert.equal(fns.DefDlgProcA.handler([dialog, WM_APP_MESSAGE + 1, 0, 0]), 0,
        'unhandled: the default, which has nothing to say about it');
    assert.equal(fns.DefDlgProcA.handler([dialog, WM_CTLCOLORDLG, 0, dialog]), 0,
        'an unhandled colour message is the default\'s, a brush where there is a painter');
    assert.deepEqual(asked, [WM_APP_MESSAGE, WM_APP_MESSAGE + 1, WM_CTLCOLORDLG]);
});

test('DefDlgProcA(WM_SETFOCUS) passes the focus to the first control that stops Tab', ()=>{
    // user32's message tests: with the focus taken from everything, a custom
    // dialog told WM_SETFOCUS gives it to its first tab-stop edit, selecting
    // that edit's text first, and answers 0.
    const DEFDLGPROC = 0x404000;
    const WM_SETFOCUS = 0x0007;
    const WM_GETDLGCODE = 0x0087;
    const EM_SETSEL = 0x00b1;
    const DLGC_HASSETSEL = 0x0008;
    const WS_CHILD = 0x40000000;
    const WS_VISIBLE = 0x10000000;
    const WS_TABSTOP = 0x00010000;
    const EDITPROC = 0x405000;
    /** @type {{ hwnd: number, message: number, wParam: number, lParam: number }[]} */
    const seen = [];
    const context = setup({
        dispatch: (wndProc, message)=>{
            if (wndProc === EDITPROC)
            {
                seen.push({ hwnd: message.hwnd, message: message.message,
                    wParam: message.wParam, lParam: message.lParam });
            }
            return wndProc === EDITPROC && message.message === WM_GETDLGCODE
                ? DLGC_HASSETSEL : 0;
        },
    });
    const { memory, fns } = context;
    const dialog = customDialog(context, DEFDLGPROC);
    const CLASS_STRUCT = 0x10a00;
    const CLASS_NAME = 0x10b00;
    memory.putString(CLASS_NAME, 'my_edit_class');
    memory.writeMemory(CLASS_STRUCT, new Uint8Array(new Uint32Array([
        0, EDITPROC, 0, 0, HINSTANCE, 0, 0, 0, 0, CLASS_NAME,
    ]).buffer));
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    /** @param {number} id @param {number} y */
    const edit = (id, y)=>fns.CreateWindowExA.handler([0, CLASS_NAME, 0,
        WS_CHILD | WS_VISIBLE | WS_TABSTOP, 0, y, 80, 20, dialog, id, HINSTANCE, 0]);
    const first = edit(1, 0);
    const second = edit(2, 40);
    fns.SetFocus.handler([second]);
    fns.SetFocus.handler([0]);
    seen.length = 0;

    assert.equal(fns.DefDlgProcA.handler([dialog, WM_SETFOCUS, 0, 0]), 0);
    assert.equal(fns.GetFocus.handler([]), first);
    assert.deepEqual(seen.map(({ message })=>message), [WM_GETDLGCODE, EM_SETSEL, WM_SETFOCUS],
        'the control is asked what it wants, its text selected, then it has the focus');
    assert.equal(seen[1].wParam, 0);
});

test('DefDlgProcA(WM_NEXTDLGCTL) moves the focus to the next tab stop, or the one named, '
    + 'restyling the push buttons and keeping the default id', ()=>{
    // user32's dialog tests (test_WM_NEXTDLGCTL): an edit, a push button and
    // another with IDCANCEL, IDCANCEL the default id. From the edit the
    // focus moves to the first button, which takes BS_DEFPUSHBUTTON from the
    // second, then to the second, which takes it back, then round to the
    // edit, the default id IDCANCEL throughout. As documented, wParam names
    // the control when lParam's low word is TRUE and says which way to go
    // otherwise.
    const DEFDLGPROC = 0x404000;
    const WM_NEXTDLGCTL = 0x0028;
    const DM_SETDEFID = 0x0401;
    const DM_GETDEFID = 0x0400;
    const GWL_STYLE = -16;
    const WS_CHILD = 0x40000000;
    const WS_VISIBLE = 0x10000000;
    const WS_TABSTOP = 0x00010000;
    const BS_PUSHBUTTON = 0;
    const BS_DEFPUSHBUTTON = 1;
    const IDCANCEL = 2;
    const context = setup();
    const { memory, fns } = context;
    const dialog = customDialog(context, DEFDLGPROC);
    /** @param {string} name @param {number} id @param {number} style */
    const control = (name, id, style)=>{
        memory.putString(TEXT, name);
        return fns.CreateWindowExA.handler([0, TEXT, 0, WS_CHILD | WS_VISIBLE | WS_TABSTOP
            | style, 0, 0, 40, 20, dialog, id, HINSTANCE, 0]);
    };
    const edit = control('Edit', 101, 0);
    const first = control('Button', 201, BS_PUSHBUTTON);
    const second = control('Button', IDCANCEL, BS_PUSHBUTTON);
    fns.DefDlgProcA.handler([dialog, DM_SETDEFID, IDCANCEL, 0]);
    /** @param {number} hwnd */
    const kind = hwnd=>fns.GetWindowLongA.handler([hwnd, GWL_STYLE]) & 0x0f;
    const defaultId = ()=>fns.DefDlgProcA.handler([dialog, DM_GETDEFID, 0, 0]) & 0xffff;
    fns.SetFocus.handler([edit]);

    assert.equal(fns.DefDlgProcA.handler([dialog, WM_NEXTDLGCTL, 0, 0]), 0);
    assert.equal(fns.GetFocus.handler([]), first);
    assert.equal(defaultId(), IDCANCEL, 'the default id stays');
    assert.deepEqual([kind(first), kind(second)], [BS_DEFPUSHBUTTON, BS_PUSHBUTTON]);
    fns.DefDlgProcA.handler([dialog, WM_NEXTDLGCTL, 0, 0]);
    assert.equal(fns.GetFocus.handler([]), second);
    assert.deepEqual([kind(first), kind(second)], [BS_PUSHBUTTON, BS_DEFPUSHBUTTON]);
    fns.DefDlgProcA.handler([dialog, WM_NEXTDLGCTL, 0, 0]);
    assert.equal(fns.GetFocus.handler([]), edit, 'round to the edit');
    assert.equal(defaultId(), IDCANCEL);

    fns.DefDlgProcA.handler([dialog, WM_NEXTDLGCTL, 1, 0]);
    assert.equal(fns.GetFocus.handler([]), second, 'the one before');
    fns.DefDlgProcA.handler([dialog, WM_NEXTDLGCTL, first, 1]);
    assert.equal(fns.GetFocus.handler([]), first, 'the one named');
});

test('a template naming a control of a class nobody has makes no dialog, unless it says '
    + 'DS_NOFAILCREATE', async()=>{
    // user32's dialog tests (test_DialogBoxParam): DialogBoxParam of a
    // template whose control's class does not exist answers -1, the dialog
    // never made. A class Windows' own libraries register, which this build
    // has no procedure for, is still a control, a window answering nothing.
    const DS_NOFAILCREATE = 0x0010;
    /** @type {number[]} */
    const heard = [];
    const { memory, fns } = setup({ dispatch: (wndProc, message)=>{
        heard.push(message.message);
        return 0;
    } });
    const controls = [{ id: 1, x: 0, y: 0, cx: 40, cy: 10, className: 'no such class' }];
    putTemplate(memory, controls);
    assert.equal(fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC,
        0]), 0);
    assert.equal(await fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0,
        DIALOGPROC, 0]), -1);
    assert.equal(heard.includes(WM_INITDIALOG), false, 'the procedure never hears of it');

    putTemplate(memory, controls, { style: DS_NOFAILCREATE });
    const forgiving = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0,
        DIALOGPROC, 0]);
    assert.notEqual(forgiving, 0);
    assert.equal(fns.GetDlgItem.handler([forgiving, 1]), 0, 'without the control');

    putTemplate(memory, [{ ...controls[0], className: 'RichEdit20A' }]);
    const standard = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0,
        DIALOGPROC, 0]);
    assert.notEqual(standard, 0);
    assert.notEqual(fns.GetDlgItem.handler([standard, 1]), 0);
});

/**
 * The hierarchy of statics user32's dialog tests (test_GetNextDlgItem) ask
 * the tab and group items of, made here window for window: a handle by
 * Wine's id, and the id of a handle.
 */
function dialogHierarchy(){
    const WS_CHILD = 0x40000000;
    const WS_VISIBLE = 0x10000000;
    const WS_DISABLED = 0x08000000;
    const WS_GROUP = 0x00020000;
    const WS_TABSTOP = 0x00010000;
    const DS_CONTROL = 0x0400;
    const WS_EX_CONTROLPARENT = 0x00010000;
    const V = WS_CHILD | WS_VISIBLE;
    /** id, parent, style, extended style: Wine's table, in its order. */
    const hierarchy = [
        [1, 0, WS_VISIBLE, 0],
        [20, 1, V | WS_GROUP, 0],
        [2, 1, V, WS_EX_CONTROLPARENT],
        [60, 2, V | WS_TABSTOP, 0],
        [8, 2, V | WS_DISABLED | WS_TABSTOP, WS_EX_CONTROLPARENT],
        [85, 8, V | WS_TABSTOP | WS_GROUP, 0],
        [9, 8, WS_CHILD, WS_EX_CONTROLPARENT],
        [86, 9, V, 0],
        [87, 9, V, 0],
        [31, 8, V | WS_GROUP, 0],
        [10, 2, V, WS_EX_CONTROLPARENT],
        [88, 10, V | WS_GROUP, 0],
        [11, 10, WS_CHILD, WS_EX_CONTROLPARENT],
        [89, 11, V, 0],
        [32, 11, V | WS_GROUP, 0],
        [90, 11, V, 0],
        [33, 10, V | WS_GROUP, 0],
        [21, 2, V | WS_GROUP, 0],
        [61, 2, V | WS_TABSTOP, 0],
        [3, 1, V | DS_CONTROL, 0],
        [22, 3, V | WS_GROUP, 0],
        [62, 3, V | WS_TABSTOP, 0],
        [7, 3, V, WS_EX_CONTROLPARENT],
        [4, 7, V | DS_CONTROL, 0],
        [83, 4, V, 0],
        [5, 4, V | DS_CONTROL, 0],
        [29, 5, V | WS_GROUP, 0],
        [81, 5, V, 0],
        [6, 5, V, WS_EX_CONTROLPARENT],
        [63, 6, V | WS_DISABLED | WS_TABSTOP, 0],
        [64, 6, WS_CHILD | WS_TABSTOP, 0],
        [65, 6, WS_CHILD | WS_DISABLED | WS_TABSTOP, 0],
        [66, 6, V, 0],
        [23, 6, V | WS_GROUP, 0],
        [67, 6, V | WS_TABSTOP, 0],
        [24, 6, WS_CHILD | WS_DISABLED | WS_GROUP, 0],
        [68, 6, V | WS_DISABLED | WS_TABSTOP, 0],
        [69, 6, WS_CHILD | WS_TABSTOP, 0],
        [25, 6, V | WS_GROUP, 0],
        [70, 6, V, 0],
        [71, 6, V | WS_DISABLED | WS_TABSTOP, 0],
        [72, 6, V | WS_TABSTOP, 0],
        [73, 6, V | WS_DISABLED | WS_TABSTOP, 0],
        [26, 6, V | WS_GROUP, 0],
        [74, 6, V | WS_TABSTOP, 0],
        [75, 6, V | WS_TABSTOP, 0],
        [27, 6, V | WS_DISABLED | WS_GROUP, 0],
        [76, 6, V | WS_TABSTOP, 0],
        [77, 6, V | WS_TABSTOP, 0],
        [28, 6, WS_CHILD | WS_GROUP, 0],
        [78, 6, V | WS_TABSTOP, 0],
        [79, 6, V, 0],
        [80, 6, V | WS_DISABLED | WS_TABSTOP, 0],
        [82, 5, V, 0],
        [30, 5, V | WS_GROUP, 0],
        [84, 4, V | WS_TABSTOP, 0],
    ];
    const { memory, fns } = setup();
    const CLASS_NAME = 0x10b00;
    memory.putString(CLASS_NAME, 'static');
    /** @type {Map<number, number>} */
    const hwnd = new Map([[0, 0]]);
    for (const [id, parent, style, exStyle] of hierarchy)
    {
        hwnd.set(id, fns.CreateWindowExA.handler([exStyle, CLASS_NAME, 0, style, 10, 10, 10,
            10, hwnd.get(parent) ?? 0, parent === 0 ? 0 : 2000 + id, HINSTANCE, 0]));
    }
    const idOf = (/** @type {number} */ handle)=>[...hwnd].find(([, each])=>each === handle)?.[0];
    return { fns, hwnd, idOf };
}

test('GetNextDlgTabItem walks into a shown, enabled WS_EX_CONTROLPARENT child as if its '
    + 'controls were the dialog\'s own', ()=>{
    // user32's dialog tests (test_GetNextDlgItem) ask for the tab item after
    // or before one: a child with WS_EX_CONTROLPARENT is searched through,
    // DS_CONTROL alone is not, a control that could not be reached that way
    // is searched from where it is, and the item before nothing, or before
    // the dialog itself, is none.
    const { fns, hwnd, idOf } = dialogHierarchy();
    /** Wine's test number, the dialog, the control, whether before, and the answer. */
    const records = [
        [2, 6, 0, 1, 0], [4, 6, 6, 1, 0], [6, 6, 0, 0, 67], [8, 6, 6, 0, 67],
        [9, 4, 83, 0, 84], [11, 5, 81, 0, 67], [13, 5, 82, 1, 78], [27, 1, 70, 0, 72],
        [29, 6, 67, 0, 72], [30, 6, 72, 1, 67], [36, 2, 0, 0, 60],
    ];
    for (const [number, dialog, control, previous, expected] of records)
    {
        const found = fns.GetNextDlgTabItem.handler([hwnd.get(dialog) ?? 0,
            hwnd.get(control) ?? 0, previous]);
        assert.equal(idOf(found), expected, `test ${number}`);
    }
});

test('GetNextDlgGroupItem walks a group round, through a shown, enabled WS_EX_CONTROLPARENT '
    + 'child as if its controls were the dialog\'s own', ()=>{
    // user32's dialog tests (test_GetNextDlgItem), the group records: a group
    // runs from one WS_GROUP control to the next, round the end of the
    // dialog to its start; the next or previous item in it is the next that
    // is shown and enabled, wrapping within the group, or the control itself
    // when there is none; a child with WS_EX_CONTROLPARENT is searched
    // through, DS_CONTROL alone is not; from nothing, or from the dialog,
    // the first shown and enabled control, and nothing before it.
    const { fns, hwnd, idOf } = dialogHierarchy();
    /** Wine's test number, the dialog, the control, whether before, and the answer. */
    const records = [
        [1, 6, 0, 1, 0], [3, 6, 6, 1, 0], [5, 6, 0, 0, 66], [7, 6, 6, 0, 66],
        [10, 4, 83, 0, 5], [12, 5, 81, 0, 66], [14, 5, 82, 1, 79], [15, 6, 70, 0, 72],
        [16, 6, 72, 0, 25], [17, 6, 75, 0, 26], [18, 6, 77, 0, 76], [19, 6, 79, 0, 66],
        [20, 6, 71, 0, 72], [21, 6, 64, 0, 66], [22, 6, 25, 0, 70], [23, 6, 68, 0, 68],
        [24, 6, 25, 1, 72], [25, 1, 70, 0, 72], [35, 2, 0, 0, 60],
    ];
    for (const [number, dialog, control, previous, expected] of records)
    {
        const found = fns.GetNextDlgGroupItem.handler([hwnd.get(dialog) ?? 0,
            hwnd.get(control) ?? 0, previous]);
        assert.equal(idOf(found), expected, `test ${number}`);
    }
});

test('SetDlgItemTextW sets a control\'s text through the ANSI page', ()=>{
    let next = 0x13000;
    const { memory, fns } = setup({
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
    });
    putTemplate(memory, [{ id: 300, x: 0, y: 0, cx: 10, cy: 4, title: 'Ready' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    memory.writeMemory(TEXT, new Uint8Array(Buffer.from('Fertig ü\0', 'utf16le')));

    assert.equal(fns.SetDlgItemTextW.argBytes, 12);
    assert.equal(fns.SetDlgItemTextW.handler([dialog, 300, TEXT]), 1);
    assert.equal(fns.GetDlgItemTextA.handler([dialog, 300, OUT, 32]), 8);
    assert.deepEqual([...memory.readMemory(OUT, 9)],
        [...Buffer.from('Fertig ', 'latin1'), 0xfc, 0]);
    assert.equal(fns.SetDlgItemTextW.handler([dialog, 999, TEXT]), 0, 'no such control');
});

test('a template\'s controls are made one after another, each handed its creation data', async()=>{
    // Each control is CreateWindowEx'd in turn: the second is made only once
    // the first's WM_CREATE has answered, and its WM_CREATE reads the data
    // the template carries for it, size word first, as lpCreateParams.
    const GAUGE_PROC = 0x403000;
    const CLASS_STRUCT = 0x10800;
    const CLASS_NAME = 0x10900;
    const WM_NCCREATE = 0x0081;
    const WM_CREATE = 0x0001;
    /** @type {string[]} */
    const order = [];
    /** @type {number[][]} */
    const data = [];
    /** @type {(() => void) | null} */
    let finishFirst = null;
    /** @type {any} */
    let context = null;
    let heap = 0x13000;
    context = setup({
        allocate: (/** @type {number} */ size)=>{
            heap += size + 15 & ~15;
            return heap - (size + 15 & ~15);
        },
        dispatch: (wndProc, message)=>{
            if (wndProc !== GAUGE_PROC)
            {
                return 0;
            }
            order.push(`${message.hwnd}:${message.message}`);
            if (message.message === WM_NCCREATE)
            {
                return 1;
            }
            if (message.message === WM_CREATE)
            {
                const params = context.memory.u32(message.lParam);
                const bytes = context.memory.bytes;
                data.push(params === 0 ? [] : [0, 2, 4].map(at=>
                    bytes[params + at] | bytes[params + at + 1] << 8));
                if (finishFirst === null)
                {
                    // A procedure that answers late, as one that runs guest code does.
                    return /** @type {any} */ (new Promise(resolve=>{
                        finishFirst = ()=>resolve(0);
                    }));
                }
            }
            return 0;
        },
    });
    const { memory, fns } = context;
    memory.putString(CLASS_NAME, 'gauge');
    memory.writeMemory(CLASS_STRUCT, new Uint8Array(new Uint32Array([
        0, GAUGE_PROC, 0, 0, HINSTANCE, 0, 0, 0, 0, CLASS_NAME,
    ]).buffer));
    assert.notEqual(fns.RegisterClassA.handler([CLASS_STRUCT]), 0);
    putTemplate(memory, [
        { id: 301, x: 4, y: 4, cx: 30, cy: 4, className: 'gauge', data: [7, 8] },
        { id: 302, x: 4, y: 10, cx: 30, cy: 4, className: 'gauge' },
    ]);

    const creating = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(order.length, 3, 'the second control is not made while the first is answering');
    /** @type {() => void} */ (/** @type {unknown} */ (finishFirst))();
    const dialog = await creating;
    assert.notEqual(dialog, 0);
    const [first, second] = [301, 302].map(id=>fns.GetDlgItem.handler([dialog, id]));
    // Each, as CreateWindowEx tells a child, then hears its size and place.
    const WM_SIZE = 0x0005;
    const WM_MOVE = 0x0003;
    const WM_NCCALCSIZE = 0x0083;
    assert.deepEqual(order, [`${first}:${WM_NCCREATE}`, `${first}:${WM_NCCALCSIZE}`,
        `${first}:${WM_CREATE}`, `${first}:${WM_SIZE}`, `${first}:${WM_MOVE}`,
        `${second}:${WM_NCCREATE}`, `${second}:${WM_NCCALCSIZE}`, `${second}:${WM_CREATE}`,
        `${second}:${WM_SIZE}`, `${second}:${WM_MOVE}`]);
    assert.deepEqual(data, [[6, 7, 8], []], 'the size word, then the data; NULL for none');
});

test('a dialog made through the wide call is a Unicode window, its procedure reading wide', ()=>{
    const WM_SETTEXT = 0x000c;
    /** @type {any} */
    let context = null;
    /** @type {string[]} */
    const texts = [];
    let heap = 0x13000;
    context = setup({
        allocate: (/** @type {number} */ size)=>{
            heap += size + 15 & ~15;
            return heap - (size + 15 & ~15);
        },
        dispatch: (wndProc, message)=>{
            if (wndProc === DIALOGPROC && message.message === WM_SETTEXT)
            {
                let text = '';
                for (let at = message.lParam; ; at += 2)
                {
                    const unit = context.memory.bytes[at] | context.memory.bytes[at + 1] << 8;
                    if (unit === 0)
                    {
                        break;
                    }
                    text += String.fromCharCode(unit);
                }
                texts.push(text);
                return 1;
            }
            return 0;
        },
    });
    const { memory, fns } = context;
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);
    const dialog = fns.CreateDialogIndirectParamW.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    assert.notEqual(dialog, 0);
    assert.equal(fns.IsWindowUnicode.handler([dialog]), 1);
    assert.equal(fns.IsWindowUnicode.handler([
        fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0])]), 0);
    memory.putString(0x3000, 'Café');
    fns.SetWindowTextA.handler([dialog, 0x3000]);
    assert.deepEqual(texts, ['Café'], 'an ANSI caller\'s text, as the wide procedure reads it');

    assert.equal(fns.GetDlgItemTextW.handler([dialog, 100, 0x3100, 16]), 2);
    assert.deepEqual([...memory.bytes.subarray(0x3100, 0x3106)], [0x4f, 0, 0x4b, 0, 0, 0]);
    assert.equal(fns.SendDlgItemMessageW.argBytes, 20);
    assert.equal(fns.DialogBoxParamW.argBytes, 20);
});

test('IsDlgButtonChecked asks the one button, and answers what it says', ()=>{
    const BM_GETCHECK = 0x00f0;
    /** @type {number[]} */
    const asked = [];
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (message.message === BM_GETCHECK)
            {
                asked.push(message.hwnd);
                return 2;
            }
            return 0;
        },
    });
    putTemplate(memory, [{ id: 10, x: 0, y: 0, cx: 4, cy: 4 }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const button = fns.GetDlgItem.handler([dialog, 10]);
    fns.SetWindowLongA.handler([button, -4, 0x403000]);

    assert.equal(fns.IsDlgButtonChecked.argBytes, 8);
    assert.equal(fns.IsDlgButtonChecked.handler([dialog, 10]), 2, 'BST_INDETERMINATE as it is');
    assert.deepEqual(asked, [button]);
    assert.equal(fns.IsDlgButtonChecked.handler([dialog, 99]), 0, 'no such control');
});

test('every dialog has the 3-D look; a DS_CONTROL one has no caption or system menu of its '
    + 'own, and it and any dialog that is not a child let the tab walk into it', ()=>{
    // user32's window tests (test_dialog_styles), the window manager's own
    // additions -- a top-level window's clipped siblings, an overlapped
    // one's caption -- on top.
    const DS_3DLOOK = 0x0004;
    const DS_CONTROL = 0x0400;
    const WS_CHILD = 0x40000000;
    const WS_POPUP = 0x80000000;
    const WS_CLIPSIBLINGS = 0x04000000;
    const WS_CAPTION = 0x00c00000;
    const WS_SYSMENU = 0x00080000;
    const WS_EX_WINDOWEDGE = 0x100;
    const WS_EX_CONTROLPARENT = 0x10000;
    const { memory, fns } = setup();
    /** @param {number} style @param {number} [parent] */
    const styles = (style, parent = 0)=>{
        putTemplate(memory, [], { style });
        const hwnd = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, parent,
            DIALOGPROC, 0]);
        return [fns.GetWindowLongA.handler([hwnd, -16]) >>> 0,
            fns.GetWindowLongA.handler([hwnd, -20]) >>> 0, hwnd];
    };
    const [style, exStyle, top] = styles(0);
    assert.deepEqual([style, exStyle], [WS_CLIPSIBLINGS | WS_CAPTION | DS_3DLOOK,
        WS_EX_WINDOWEDGE | WS_EX_CONTROLPARENT]);
    assert.deepEqual(styles(WS_POPUP | WS_CAPTION | WS_SYSMENU | DS_CONTROL).slice(0, 2),
        [(WS_POPUP | DS_CONTROL | WS_CLIPSIBLINGS | DS_3DLOOK) >>> 0, WS_EX_CONTROLPARENT]);
    assert.deepEqual(styles(WS_CHILD, top).slice(0, 2), [WS_CHILD | DS_3DLOOK, 0],
        'a child dialog: nothing of the tab walk\'s');
    assert.deepEqual(styles(WS_CHILD | DS_CONTROL, top).slice(0, 2),
        [WS_CHILD | DS_CONTROL | DS_3DLOOK, WS_EX_CONTROLPARENT]);
});

test('DialogBox disables the first window above a child that is not one before WM_INITDIALOG, '
    + 'tells it WM_ENTERIDLE as the queue runs dry, and only EndDialog enables it', async()=>{
    // user32's window tests (test_dialog_parent): the owner of a modal dialog
    // made for a child window is the window above it that can own one, and
    // the dialog -- a child one too -- is made that window's; ended from
    // WM_ENTERIDLE, EndDialog gives it back; destroyed there instead, the
    // dialog answers IDOK and the owner stays disabled; EndDialog of a
    // modeless child dialog enables its parent.
    const WS_CHILD = 0x40000000;
    const WM_ENTERIDLE = 0x0121;
    const OWNERPROC = 0x402100;
    /** @type {any} */
    let table = null;
    let owner = 0;
    let child = 0;
    let how = 'end';
    /** @type {any[]} */
    const atInit = [];
    /** @type {any[]} */
    const idle = [];
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (wndProc === DIALOGPROC && message.message === WM_INITDIALOG)
            {
                atInit.push([table.IsWindowEnabled.handler([owner]),
                    table.IsWindowEnabled.handler([child]),
                    table.GetParent.handler([message.hwnd])]);
            }
            if (wndProc === OWNERPROC && message.message === WM_ENTERIDLE)
            {
                idle.push([message.wParam, message.lParam]);
                if (how === 'end')
                {
                    table.EndDialog.handler([message.lParam, 5]);
                }
                else
                {
                    table.DestroyWindow.handler([message.lParam]);
                }
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, []);
    owner = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, OWNERPROC, 0]);
    putTemplate(memory, [], { style: WS_CHILD });
    child = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, owner, OWNERPROC, 0]);

    const answer = fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, child, DIALOGPROC,
        0]);
    assert.equal(await answer, 5);
    assert.deepEqual(atInit.splice(0), [[0, 1, owner]],
        'the owner disabled, the child not, and the dialog the owner\'s');
    assert.equal(idle.length, 1, 'told once the queue ran dry');
    assert.equal(idle[0][0], 0, 'MSGF_DIALOGBOX');
    assert.equal(fns.IsWindowEnabled.handler([owner]), 1, 'given back by EndDialog');

    how = 'destroy';
    assert.equal(await fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, child,
        DIALOGPROC, 0]), 1, 'IDOK');
    assert.equal(fns.IsWindowEnabled.handler([owner]), 0, 'and the owner left disabled');

    const modeless = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, owner,
        DIALOGPROC, 0]);
    assert.equal(fns.EndDialog.handler([modeless, 0]), 1);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 1,
        'EndDialog enables the window a dialog belongs to, whoever disabled it');
});

test('GetDlgItemInt reads a number after spaces, up to the first non-digit, and says whether '
    + 'it found one', ()=>{
    // MSDN's GetDlgItemInt: leading spaces are stripped, a minus sign counts
    // only when bSigned, and a value past INT_MAX or UINT_MAX is a failure.
    // A failure is zero with FALSE in lpTranslated, so a caller tells "0"
    // from nothing.
    const TRANSLATED = 0x11400;
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 300, x: 0, y: 0, cx: 10, cy: 4, title: '' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    /** @param {string} text @param {number} signed */
    const read = (text, signed)=>{
        memory.putString(TEXT, text);
        fns.SetDlgItemTextA.handler([dialog, 300, TEXT]);
        memory.bytes.fill(0xa5, TRANSLATED, TRANSLATED + 4);
        const value = fns.GetDlgItemInt.handler([dialog, 300, TRANSLATED, signed]);
        return [value, memory.u32(TRANSLATED)];
    };

    assert.equal(fns.GetDlgItemInt.argBytes, 16);
    assert.deepEqual(read('42', 0), [42, 1]);
    assert.deepEqual(read('0', 0), [0, 1], 'a real zero is translated');
    assert.deepEqual(read('   17', 0), [17, 1], 'spaces before it are skipped');
    assert.deepEqual(read('12px', 0), [12, 1], 'the number ends at a non-digit');
    assert.deepEqual(read('-42', 1), [(-42 >>> 0), 1], 'signed, a minus sign is one');
    assert.deepEqual(read('-42', 0), [0, 0], 'unsigned, it is not a digit');
    assert.deepEqual(read('', 0), [0, 0], 'no text is no number');
    assert.deepEqual(read('abc', 1), [0, 0]);
    assert.deepEqual(read('4294967295', 0), [0xffffffff, 1]);
    assert.deepEqual(read('4294967296', 0), [0, 0], 'past UINT_MAX');
    assert.deepEqual(read('2147483647', 1), [0x7fffffff, 1]);
    assert.deepEqual(read('2147483648', 1), [0, 0], 'past INT_MAX');
    assert.deepEqual(read('-2147483648', 1), [0x80000000, 1]);
    assert.deepEqual(read('-2147483649', 1), [0, 0]);

    memory.bytes.fill(0xa5, TRANSLATED, TRANSLATED + 4);
    assert.equal(fns.GetDlgItemInt.handler([dialog, 999, TRANSLATED, 0]), 0, 'no such control');
    assert.equal(memory.u32(TRANSLATED), 0);
    assert.equal(fns.GetDlgItemInt.handler([dialog, 300, 0, 0]), 0, 'lpTranslated may be null');
});

test('SetDlgItemInt sets the number as text, signed when asked', ()=>{
    let next = 0x13000;
    const { memory, fns } = setup({
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
    });
    putTemplate(memory, [{ id: 300, x: 0, y: 0, cx: 10, cy: 4, title: 'Ready' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    /** @param {number} value @param {number} signed */
    const set = (value, signed)=>{
        assert.equal(fns.SetDlgItemInt.handler([dialog, 300, value >>> 0, signed]), 1);
        fns.GetDlgItemTextA.handler([dialog, 300, OUT, 32]);
        return memory.readCString(OUT, 32);
    };

    assert.equal(fns.SetDlgItemInt.argBytes, 16);
    assert.equal(set(1234, 0), '1234');
    assert.equal(set(-5, 1), '-5');
    assert.equal(set(-5, 0), '4294967291', 'unsigned, the same bits are a large number');
    assert.equal(fns.GetDlgItemInt.handler([dialog, 300, 0, 0]), 4294967291);
    assert.equal(fns.SetDlgItemInt.handler([dialog, 999, 1, 0]), 0, 'no such control');
});

test('the AorW calls make the Unicode dialog for flags zero and the ANSI one otherwise', async()=>{
    // DLG_ISANSI is the 2 CreateDialogIndirectParamA passes on; zero is
    // the W form. What differs is the encoding the procedure is handed.
    const DLG_ISANSI = 2;
    /** @type {any} */
    let table = null;
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (message.message === 0x0110)
            {
                table.EndDialog.handler([message.hwnd, table.IsWindowUnicode.handler([
                    message.hwnd]) + 40]);
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);
    const wide = fns.CreateDialogIndirectParamAorW.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0, 0]);
    assert.notEqual(wide, 0);
    assert.equal(fns.IsWindowUnicode.handler([wide]), 1);
    const ansi = fns.CreateDialogIndirectParamAorW.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0, DLG_ISANSI]);
    assert.equal(fns.IsWindowUnicode.handler([ansi]), 0);
    assert.equal(fns.CreateDialogIndirectParamAorW.argBytes, 24);

    assert.equal(await fns.DialogBoxIndirectParamAorW.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0, 0]), 41, 'modal and Unicode');
    assert.equal(await fns.DialogBoxIndirectParamAorW.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0, DLG_ISANSI]), 40, 'modal and ANSI');
    assert.equal(fns.DialogBoxIndirectParamAorW.handler([HINSTANCE, 0, 0, DIALOGPROC, 0, 0]), -1);
    assert.equal(fns.DialogBoxIndirectParamAorW.argBytes, 24);
});
