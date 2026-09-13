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
 *           allocate?: (bytes: number) => number }} [options]
 */
function setup({ resources = {}, dispatch = ()=>0, allocate } = {}){
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
        release: ()=>{},
        callerThread: ()=>'the caller',
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
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
 *           className?: string, ordinal?: number, title?: string }[]} controls
 * @param {{ style?: number, menu?: string, title?: string }} [options]
 */
function putTemplate(memory, controls, options = {}){
    const template = writer(memory, TEMPLATE);
    template.u32(options.style ?? 0).u32(0).u16(controls.length);
    template.u16(10).u16(20).u16(40).u16(20);
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
        template.sz(control.title ?? '');
        template.u16(0);
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
    assert.deepEqual(delivered, [{ message: 0x0110, thread: 'the caller' }]);
    assert.equal(fns.DialogBoxIndirectParamA.handler([HINSTANCE, 0, 0, DIALOGPROC, 0]), -1,
        'and a dialog that cannot be made answers -1 at once');
    assert.equal(fns.DialogBoxIndirectParamA.argBytes, 20);
    assert.equal(fns.DialogBoxParamA.argBytes, 20);
});

test('DialogBox shows a dialog whose template does not say WS_VISIBLE', async()=>{
    // Most templates leave the bit off: the modal call is what shows the
    // window, and a dialog left invisible is a program that appears to do
    // nothing when its own menu is clicked.
    /** @type {any} */
    let table = null;
    /** @type {number} */
    let visibleAtInit = -1;
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (message.message === WM_INITDIALOG)
            {
                visibleAtInit = table.IsWindowVisible.handler([message.hwnd]);
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
    assert.equal(visibleAtInit, 1, 'the modal one is visible by the time its procedure runs');
});

test('a message sent to a control with no procedure is answered with nothing', ()=>{
    // The same control SendDlgItemMessage already answers zero for: sent to
    // by handle instead, it used to ask the bridge to run code at address
    // zero, which stopped the machine inside the dialog's own initialisation.
    const { memory, fns } = setup({
        dispatch: ()=>{
            throw new Error('nothing to run');
        },
    });
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6, title: 'OK' }]);
    const dialog = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const control = fns.GetDlgItem.handler([dialog, 100]);

    const BM_SETCHECK = 0x00f1;
    assert.equal(fns.SendMessageA.handler([control, BM_SETCHECK, 1, 0]), 0);

    const MSG = 0x3000;
    memory.writeMemory(MSG, Uint8Array.of(control, control >>> 8, 0, 0, BM_SETCHECK, 0, 0, 0));
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

test('IsDialogMessage takes Enter for IDOK and nothing else', ()=>{
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

    const MSG = 0x3000;
    memory.writeMemory(MSG, Uint8Array.of(control, control >>> 8, 0, 0, 0x00, 0x01, 0, 0, 0x0d));
    assert.equal(fns.IsDialogMessageA.handler([dialog, MSG]), 1, 'Enter on a control inside');
    // The dialog is asked for its default button first, and told the click.
    assert.deepEqual(delivered.map(one=>[one.message, one.wParam & 0xffff]),
        [[0x0400, 0], [0x0111, 1]]);

    memory.writeMemory(MSG + 8, Uint8Array.of(0x41));
    assert.equal(fns.IsDialogMessageA.handler([dialog, MSG]), 0, 'a letter is not taken');
    memory.writeMemory(MSG, Uint8Array.of(0x99, 0, 0, 0, 0, 0x01, 0, 0, 0x0d));
    assert.equal(fns.IsDialogMessageA.handler([dialog, MSG]), 0,
        'nor is Enter in a window outside the dialog');
    assert.equal(fns.IsDialogMessageA.argBytes, 8);
});

test('a modal dialog disables its owner until it ends', async()=>{
    const OWNERPROC = 0x402100;
    /** @type {any} */
    let table = null;
    const { memory, fns } = setup({
        dispatch: (wndProc, message)=>{
            if (wndProc === DIALOGPROC && message.message === WM_INITDIALOG)
            {
                table.EndDialog.handler([message.hwnd, 7]);
            }
            return 0;
        },
    });
    table = fns;
    putTemplate(memory, []);
    const owner = fns.CreateDialogIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, OWNERPROC, 0]);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 1);

    const answer = fns.DialogBoxIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, owner, DIALOGPROC, 0]);
    assert.equal(fns.IsWindowEnabled.handler([owner]), 0, 'disabled while the dialog is up');
    assert.equal(await answer, 7);
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

test('a quit retrieved inside a modal loop ends the dialog and is put back', async()=>{
    const { memory, queue, fns } = setup();
    putTemplate(memory, [{ id: 100, x: 4, y: 8, cx: 20, cy: 6 }]);
    queue.postQuit(3);

    assert.equal(await fns.DialogBoxIndirectParamA.handler([HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]),
        0);
    assert.equal(queue.quitPending(), true, 'the loop outside has yet to see it');
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
    const { memory, fns } = setup({
        allocate: ()=>0x13000,
        dispatch: (wndProc, message)=>{
            seen.push({ wndProc, message: message.message, lParam: message.lParam });
            return 0;
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
    assert.deepEqual(seen.map(call=>[call.wndProc, call.message]), [[METER_PROC, WM_CREATE]],
        'the class procedure was told, by name folded without regard to case');
    assert.equal(memory.u32(seen[0].lParam + 12), dialog, 'CREATESTRUCT.hwndParent');
    assert.equal(memory.u32(seen[0].lParam + 8), 201, 'CREATESTRUCT.hMenu is the id');
    assert.equal(fns.SetWindowWord.handler([meter, 0, 7]), 0, 'and it has the extra bytes');
    assert.equal(fns.GetWindowWord.handler([meter, 0]), 7);
    assert.notEqual(fns.GetWindowLongA.handler([fns.GetDlgItem.handler([dialog, 1]), -4]),
        METER_PROC, 'a system-class control keeps the system procedure, not its own');

    assert.equal(fns.GetMessageA.handler([OUT, 0, 0, 0]), 1);
    assert.equal(memory.u32(OUT + 4), WM_INITDIALOG, 'posted after the controls were told');
});

test('WM_INITDIALOG carries the parameter the caller passed', ()=>{
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 400, x: 0, y: 0, cx: 4, cy: 4 }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0xcafe]);

    assert.equal(fns.GetMessageA.handler([OUT, 0, 0, 0]), 1);
    assert.equal(memory.u32(OUT), dialog);
    assert.equal(memory.u32(OUT + 4), WM_INITDIALOG);
    assert.equal(memory.u32(OUT + 12), 0xcafe, 'the initialisation parameter');
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

test('ending a dialog destroys it and the controls it owns', ()=>{
    const { memory, fns } = setup();
    putTemplate(memory, [{ id: 500, x: 0, y: 0, cx: 4, cy: 4 }]);
    const dialog = fns.CreateDialogIndirectParamA.handler(
        [HINSTANCE, TEMPLATE, 0, DIALOGPROC, 0]);
    const control = fns.GetDlgItem.handler([dialog, 500]);

    assert.equal(fns.EndDialog.handler([dialog, 7]), 1);
    assert.equal(fns.IsWindow.handler([dialog]), 0);
    assert.equal(fns.IsWindow.handler([control]), 0, 'a child outliving its parent is a leak');
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
