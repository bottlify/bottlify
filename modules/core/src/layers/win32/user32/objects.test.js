/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The things a window or a process owns: properties, menus, accelerators, the
 * clipboard, scroll bars.
 *
 * What is checked is what a wrong answer costs. A property that outlives its
 * window surfaces on a stranger; an accelerator array walked at the wrong
 * stride produces plausible rubbish rather than an error; a clipboard write
 * that succeeds without the clipboard being open leaves the program with no
 * reason to open it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageQueue } from './messages.js';
import { createWindowFunctions } from './windows.js';
import { OBJECT_LAYOUT } from './objects.js';
import { decodeAnsi } from '../kernel32/locale.js';

const CLASS_NAME = 0x10000;
const CLASS_STRUCT = 0x10100;
const TITLE = 0x10200;
const NAME_A = 0x10300;
const NAME_B = 0x10380;
const TEXT = 0x10400;
const INFO = 0x11000;
const OUT = 0x11200;
const ACCEL = 0x11400;
const MSG = 0x11500;

const WNDPROC = 0x401000;
const HINSTANCE = 0x400000;

const MIIM_STATE = 0x0001;
const MIIM_ID = 0x0002;
const MIIM_SUBMENU = 0x0004;
const MIIM_STRING = 0x0040;

const SIF_RANGE = 0x0001;
const SIF_PAGE = 0x0002;
const SIF_POS = 0x0004;

const MF_BYPOSITION = 0x0400;

const WM_KEYDOWN = 0x0100;
const WM_COMMAND = 0x0111;

const FVIRTKEY = 0x01;
const FCONTROL = 0x08;

const CF_TEXT = 1;
const CF_OEMTEXT = 7;
const CF_UNICODETEXT = 13;

const { MENUITEMINFO, SCROLLINFO, ACCEL_SIZE, SB_HORZ } = OBJECT_LAYOUT;

function fakeMemory(size = 0x14000){
    const bytes = new Uint8Array(size);
    let next = 0x10000;
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
        /** @param {number} address @param {number[]} values */
        putU32s(address, values){
            values.forEach((value, index)=>{
                const at = address + index * 4;
                bytes[at] = value & 0xff;
                bytes[at + 1] = value >>> 8 & 0xff;
                bytes[at + 2] = value >>> 16 & 0xff;
                bytes[at + 3] = value >>> 24 & 0xff;
            });
        },
        /** @param {number} address */
        u32: address=>(bytes[address] | bytes[address + 1] << 8
            | bytes[address + 2] << 16 | bytes[address + 3] << 24) >>> 0,
        /** A bump allocator over the top of the fake, for what the host lays down. */
        alloc: (/** @type {number} */ wanted)=>{
            const address = next;
            next += (wanted + 15) & ~15;
            return address;
        },
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
        typeOf: handle=>entries.get(handle)?.type ?? null,
        /** @param {number} handle @param {string} type */
        resolve(handle, type){
            const entry = entries.get(handle);
            if (!entry || entry.type !== type)
            {
                throw new Error('Invalid handle');
            }
            return entry.object;
        },
        // The kernel's table throws on a handle it does not know, by design, so
        // a destroy entry point that lets the throw escape is caught here rather
        // than passing a test the real table would fail.
        /** @param {number} handle */
        close(handle){
            const entry = entries.get(handle);
            if (!entry)
            {
                throw new Error(
                    `Cannot close invalid handle 0x${(handle >>> 0).toString(16)}`);
            }
            entries.delete(handle);
            return entry.object;
        },
    };
}

/** @param {Record<string, unknown>} [extra] More of the host, for a test that listens to it. */
function setup(extra = {}){
    const memory = fakeMemory();
    const queue = createMessageQueue();
    const fns = createWindowFunctions({
        ...extra,
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readMemory(a, n),
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ d)=>
            memory.writeMemory(a, d),
        readCString: (/** @type {number} */ a, /** @type {number} */ n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        queue,
        dispatch: ()=>0,
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
    });
    const table = /** @type {Record<string, { argBytes: number,
        handler: (args: number[]) => number }>} */ (/** @type {unknown} */ (fns));
    return { memory, queue, fns: table };
}

/** @param {any} memory @param {any} fns */
function makeWindow(memory, fns){
    memory.putString(CLASS_NAME, 'MainWnd');
    memory.putU32s(CLASS_STRUCT, [
        0x0003, WNDPROC, 0, 0, HINSTANCE, 0x11, 0x22, 0x33, 0, CLASS_NAME,
    ]);
    fns.RegisterClassA.handler([CLASS_STRUCT]);
    memory.putString(TITLE, 'Window');
    return fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, 0, 0, 0, 320, 240, 0, 0, HINSTANCE, 0]);
}

/**
 * Lays out a MENUITEMINFO. Everything the mask does not name is left as the
 * caller had it, which is the behaviour SetMenuItemInfo has to respect.
 *
 * @param {any} memory @param {any} fields
 */
function putItemInfo(memory, fields){
    memory.putU32s(INFO, new Array(MENUITEMINFO.SIZE / 4).fill(0));
    memory.putU32s(INFO + MENUITEMINFO.cbSize, [MENUITEMINFO.SIZE, fields.mask ?? 0]);
    memory.putU32s(INFO + MENUITEMINFO.fType, [fields.type ?? 0, fields.state ?? 0]);
    memory.putU32s(INFO + MENUITEMINFO.wID, [fields.id ?? 0, fields.submenu ?? 0]);
    memory.putU32s(INFO + MENUITEMINFO.dwItemData, [fields.data ?? 0]);
    memory.putU32s(INFO + MENUITEMINFO.dwTypeData,
        [fields.text === undefined ? 0 : memory.putString(TEXT, fields.text), fields.cch ?? 0]);
    return INFO;
}

// --- properties ---

test('a property is read back, and answers with what removing it took away', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    memory.putString(NAME_A, 'MyData');

    assert.equal(fns.SetPropA.handler([hwnd, NAME_A, 0xdeadbeef]), 1);
    assert.equal(fns.GetPropA.handler([hwnd, NAME_A]), 0xdeadbeef);
    // The value is usually a handle the caller now has to free, so a remove
    // that answered zero would leave it with nothing to free.
    assert.equal(fns.RemovePropA.handler([hwnd, NAME_A]), 0xdeadbeef);
    assert.equal(fns.GetPropA.handler([hwnd, NAME_A]), 0);
});

test('a property named in either encoding, in any case, is the same property', ()=>{
    // A property's name is an atom underneath: case-blind, and the same atom
    // whichever spelling of SetProp added it.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    memory.putString(NAME_A, 'MyData');
    putWideString(memory, TEXT, 'MYDATA');

    assert.equal(fns.SetPropA.handler([hwnd, NAME_A, 0x5678]), 1);
    assert.equal(fns.GetPropW.handler([hwnd, TEXT]), 0x5678);
    assert.equal(fns.SetPropW.handler([hwnd, TEXT, 0x9abc]), 1);
    assert.equal(fns.GetPropA.handler([hwnd, NAME_A]), 0x9abc);
    assert.equal(fns.RemovePropW.handler([hwnd, TEXT]), 0x9abc);
    assert.equal(fns.GetPropA.handler([hwnd, NAME_A]), 0);
});

test('a property belongs to one window, and dies with it', ()=>{
    // Handles are recycled. A property that outlived its window would surface
    // on whatever window is handed that value next, as data its new owner never
    // set and cannot account for -- so it must not be reachable from another
    // window even while both are alive.
    const { memory, fns } = setup();
    const first = makeWindow(memory, fns);
    const second = fns.CreateWindowExA.handler(
        [0, CLASS_NAME, TITLE, 0, 0, 0, 100, 100, 0, 0, HINSTANCE, 0]);
    memory.putString(NAME_A, 'MyData');

    fns.SetPropA.handler([first, NAME_A, 0x1234]);
    assert.equal(fns.GetPropA.handler([second, NAME_A]), 0,
        'the other window never set this and cannot account for it');

    fns.DestroyWindow.handler([first]);
    assert.equal(fns.GetPropA.handler([first, NAME_A]), 0);
});

test('an atom and a string are different names for different properties', ()=>{
    // A pointer whose high word is zero is an atom, not a string -- the same
    // convention GetProcAddress uses, and the reason no string may live in the
    // first 64 KiB.
    //
    // The two are made to collide on purpose: the same text is planted at the
    // low address used as an atom and at a real one, so a name read as a string
    // when it is an atom gives both properties the same key and one overwrites
    // the other.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    const ATOM = 0xc001;
    memory.putString(ATOM, 'Shared');
    memory.putString(NAME_B, 'Shared');

    fns.SetPropA.handler([hwnd, ATOM, 0xaaaa]);
    fns.SetPropA.handler([hwnd, NAME_B, 0xbbbb]);

    assert.equal(fns.GetPropA.handler([hwnd, ATOM]), 0xaaaa);
    assert.equal(fns.GetPropA.handler([hwnd, NAME_B]), 0xbbbb);
});

// --- menus ---

test('a window has a system menu with the standard commands, and its close can be grayed', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    const SC_CLOSE = 0xf060;
    const MF_BYCOMMAND = 0;
    const MF_GRAYED = 1;

    const menu = fns.GetSystemMenu.handler([hwnd, 0]);
    assert.notEqual(menu, 0);
    assert.equal(fns.GetSystemMenu.handler([hwnd, 0]), menu, 'the same one each time');
    assert.equal(fns.GetMenuItemCount.handler([menu]), 7);
    assert.equal(fns.GetMenuItemID.handler([menu, 6]), SC_CLOSE, 'close is last');
    assert.equal(fns.GetMenuItemID.handler([menu, 7]), -1, 'and nothing follows it');

    assert.equal(fns.EnableMenuItem.handler([menu, SC_CLOSE, MF_BYCOMMAND | MF_GRAYED]), 0,
        'it was enabled');
    assert.equal(fns.EnableMenuItem.handler([menu, SC_CLOSE, MF_BYCOMMAND]), MF_GRAYED,
        'and then it was grayed');
    assert.equal(fns.EnableMenuItem.handler([menu, 0x1234, MF_BYCOMMAND]), -1);

    const text = 0x3000;
    assert.equal(fns.GetMenuStringA.handler([menu, SC_CLOSE, text, 64, MF_BYCOMMAND]), 13);
    assert.equal(memory.readCString(text, 64), '&Close\tAlt+F4');
    assert.equal(fns.GetMenuStringA.handler([menu, 0, text, 5, 0x400]), 4, 'cut to the room');
    assert.equal(memory.readCString(text, 64), '&Res');
    assert.equal(fns.GetMenuStringA.handler([menu, SC_CLOSE, 0, 0, MF_BYCOMMAND]), 13,
        'no buffer asks for the length');
    assert.equal(fns.GetMenuStringA.handler([menu, 0x1234, text, 64, MF_BYCOMMAND]), 0);

    assert.equal(fns.GetSystemMenu.handler([hwnd, 1]), 0, 'reverting answers nothing');
    assert.equal(fns.GetMenuItemCount.handler([menu]), -1, 'and the copy is gone');
    assert.notEqual(fns.GetSystemMenu.handler([hwnd, 0]), 0, 'a fresh one comes after');
    assert.equal(fns.GetSystemMenu.handler([0x9999, 0]), 0);
});

test('a menu item is inserted, counted and read back', ()=>{
    const { memory, fns } = setup();
    const menu = fns.CreateMenu.handler([]);

    putItemInfo(memory, { mask: MIIM_ID | MIIM_STRING, id: 101, text: 'Open' });
    assert.equal(fns.InsertMenuItemA.handler([menu, 0, 1, INFO]), 1);
    assert.equal(fns.GetMenuItemCount.handler([menu]), 1);

    putItemInfo(memory, { mask: MIIM_ID | MIIM_STRING, text: undefined, cch: 16 });
    memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [OUT, 16]);
    assert.equal(fns.GetMenuItemInfoA.handler([menu, 0, 1, INFO]), 1);
    assert.equal(memory.u32(INFO + MENUITEMINFO.wID), 101);
    assert.equal(memory.readCString(OUT, 16), 'Open');
    assert.equal(memory.u32(INFO + MENUITEMINFO.cch), 4,
        'cch comes back as the length written, not as the room offered');
});

test('an item\'s upper-half text reads back as the bytes it was given', ()=>{
    // The text is read as Windows-1252, where 0x80 is the euro sign, 0x99 the
    // trade mark and 0x97 an em dash, and GetMenuItemInfoA writes it back in
    // that page.
    const { memory, fns } = setup();
    const menu = fns.CreateMenu.handler([]);
    memory.bytes.set([0x80, 0x99, 0x97, 0xe9, 0], TITLE);
    assert.equal(fns.AppendMenuA.handler([menu, 0, 9, TITLE]), 1);

    putItemInfo(memory, { mask: MIIM_STRING, text: undefined, cch: 16 });
    memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [OUT, 16]);
    assert.equal(fns.GetMenuItemInfoA.handler([menu, 0, 1, INFO]), 1);
    assert.deepEqual([...memory.bytes.subarray(OUT, OUT + 5)], [0x80, 0x99, 0x97, 0xe9, 0]);
});

test('setting an item changes only what the mask names', ()=>{
    // Copying the whole structure across would blank every member the caller
    // deliberately left alone, which is how a menu loses its text on a state
    // change.
    const { memory, fns } = setup();
    const menu = fns.CreateMenu.handler([]);
    putItemInfo(memory, { mask: MIIM_ID | MIIM_STRING, id: 7, text: 'Save' });
    fns.InsertMenuItemA.handler([menu, 0, 1, INFO]);

    putItemInfo(memory, { mask: MIIM_STATE, state: 8 });
    assert.equal(fns.SetMenuItemInfoA.handler([menu, 7, 0, INFO]), 1);

    memory.putU32s(INFO + MENUITEMINFO.cbSize, [MENUITEMINFO.SIZE, MIIM_STATE | MIIM_STRING]);
    memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [OUT, 16]);
    fns.GetMenuItemInfoA.handler([menu, 7, 0, INFO]);
    assert.equal(memory.u32(INFO + MENUITEMINFO.fState), 8);
    assert.equal(memory.readCString(OUT, 16), 'Save', 'the text the mask did not name survived');
});

/**
 * Lays out a MENUITEMINFOW: the same structure, its text in UTF-16.
 *
 * @param {any} memory @param {any} fields
 */
function putItemInfoW(memory, fields){
    putItemInfo(memory, { ...fields, text: undefined });
    if (fields.text !== undefined)
    {
        putWideString(memory, TEXT, fields.text);
        memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [TEXT, fields.cch ?? 0]);
    }
    return INFO;
}

/** @param {any} memory @param {number} address @param {number} length */
const wideAt = (memory, address, length)=>String.fromCharCode(...new Uint16Array(
    memory.bytes.slice(address, address + length * 2).buffer));

test('the wide menu item calls take and give UTF-16, cch counting characters', ()=>{
    // user32's test_menu_iteminfo runs every case through both spellings:
    // the structure is the same, dwTypeData is a wide string, and cch is in
    // WCHARs -- the length written, cut to one short of the room.
    const { memory, fns } = setup();
    const menu = fns.CreateMenu.handler([]);
    for (const name of ['InsertMenuItemW', 'GetMenuItemInfoW', 'SetMenuItemInfoW'])
    {
        assert.equal(fns[name].argBytes, 16, name);
    }

    putItemInfoW(memory, { mask: MIIM_ID | MIIM_STRING, id: 31, text: 'Öffnen…' });
    assert.equal(fns.InsertMenuItemW.handler([menu, 0, 1, INFO]), 1);

    putItemInfoW(memory, { mask: MIIM_ID | MIIM_STRING });
    memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [OUT, 32]);
    assert.equal(fns.GetMenuItemInfoW.handler([menu, 0, 1, INFO]), 1);
    assert.equal(memory.u32(INFO + MENUITEMINFO.wID), 31);
    assert.equal(wideAt(memory, OUT, 8), 'Öffnen…\0');
    assert.equal(memory.u32(INFO + MENUITEMINFO.cch), 7);

    memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [OUT, 4]);
    fns.GetMenuItemInfoW.handler([menu, 31, 0, INFO]);
    assert.equal(wideAt(memory, OUT, 4), 'Öff\0', 'cut to the room, the terminator inside it');
    assert.equal(memory.u32(INFO + MENUITEMINFO.cch), 3);

    memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [0, 0]);
    fns.GetMenuItemInfoW.handler([menu, 0, 1, INFO]);
    assert.equal(memory.u32(INFO + MENUITEMINFO.cch), 7, 'a null buffer asks for the length');

    assert.equal(fns.GetMenuItemInfoW.handler([menu, 5, 1, INFO]), 0, 'no such place');
    assert.equal(fns.GetMenuItemInfoW.handler([0x9999, 0, 1, INFO]), 0, 'no such menu');
    memory.putU32s(INFO + MENUITEMINFO.cbSize, [20]);
    assert.equal(fns.GetMenuItemInfoW.handler([menu, 0, 1, INFO]), 0, 'a size of neither version');
    assert.equal(fns.InsertMenuItemW.handler([menu, 0, 1, INFO]), 0);
    assert.equal(fns.SetMenuItemInfoW.handler([menu, 0, 1, INFO]), 0);
});

test('an item set through one spelling reads back through the other', ()=>{
    const { memory, fns } = setup();
    const menu = fns.CreateMenu.handler([]);
    putItemInfo(memory, { mask: MIIM_ID | MIIM_STRING, id: 9, text: 'Save' });
    fns.InsertMenuItemA.handler([menu, 0, 1, INFO]);

    putItemInfoW(memory, { mask: MIIM_STATE | MIIM_STRING, state: 8, text: 'Save às' });
    assert.equal(fns.SetMenuItemInfoW.handler([menu, 9, 0, INFO]), 1);

    putItemInfo(memory, { mask: MIIM_ID | MIIM_STATE | MIIM_STRING });
    memory.putU32s(INFO + MENUITEMINFO.dwTypeData, [OUT, 16]);
    assert.equal(fns.GetMenuItemInfoA.handler([menu, 0, 1, INFO]), 1);
    assert.equal(memory.u32(INFO + MENUITEMINFO.wID), 9, 'the id the mask left alone');
    assert.equal(memory.u32(INFO + MENUITEMINFO.fState), 8);
    assert.equal(memory.readCString(OUT, 16), 'Save às', 'in the ANSI page');
});

test('a bitmap item\'s type data is its handle, never read as text', ()=>{
    // Under MIIM_TYPE dwTypeData is the bitmap for MFT_BITMAP and the
    // program's value for MFT_OWNERDRAW. Text is planted where the value
    // would point if it were taken for a string.
    const MIIM_TYPE = 0x0010;
    const MFT_BITMAP = 0x0004;
    const MFT_OWNERDRAW = 0x0100;
    const { memory, fns } = setup();
    const menu = fns.CreateMenu.handler([]);
    for (const [type, wide] of [[MFT_BITMAP, false], [MFT_OWNERDRAW, true]])
    {
        putItemInfo(memory, { mask: MIIM_TYPE, type, text: 'Not text' });
        const insert = wide ? fns.InsertMenuItemW : fns.InsertMenuItemA;
        assert.equal(insert.handler([menu, 0, 1, INFO]), 1);
        assert.equal(fns.GetMenuStringA.handler([menu, 0, OUT, 16, MF_BYPOSITION]), 0,
            `type ${type} carries no string`);
    }
});

test('a command names an item wherever it is, and a position names a place', ()=>{
    const { memory, fns } = setup();
    const outer = fns.CreateMenu.handler([]);
    const inner = fns.CreatePopupMenu.handler([]);

    putItemInfo(memory, { mask: MIIM_ID | MIIM_STRING, id: 42, text: 'Deep' });
    fns.InsertMenuItemA.handler([inner, 0, 1, INFO]);
    putItemInfo(memory, { mask: MIIM_SUBMENU | MIIM_STRING, submenu: inner, text: 'File' });
    fns.InsertMenuItemA.handler([outer, 0, 1, INFO]);

    // By command it is found inside the submenu; by position there is only one
    // item at the top level, so position one is nothing.
    assert.equal(fns.DeleteMenu.handler([outer, 42, 0]), 1);
    assert.equal(fns.GetMenuItemCount.handler([inner]), 0);
    assert.equal(fns.GetMenuItemCount.handler([outer]), 1);
    assert.equal(fns.DeleteMenu.handler([outer, 1, MF_BYPOSITION]), 0);

    // RemoveMenu takes the item out and leaves the submenu alive.
    assert.equal(fns.RemoveMenu.argBytes, 12);
    assert.equal(fns.RemoveMenu.handler([outer, 0, MF_BYPOSITION]), 1);
    assert.equal(fns.GetMenuItemCount.handler([outer]), 0);
    assert.equal(fns.GetMenuItemCount.handler([inner]), 0, 'the submenu is still a menu');
    assert.equal(fns.RemoveMenu.handler([outer, 0, MF_BYPOSITION]), 0);

    // AppendMenuA: a command with text, a separator, and a popup by handle.
    const MF_POPUP = 0x10;
    const MF_SEPARATOR = 0x800;
    const MF_GRAYED = 0x1;
    memory.putString(TEXT, 'Close');
    assert.equal(fns.AppendMenuA.argBytes, 16);
    assert.equal(fns.AppendMenuA.handler([outer, MF_GRAYED, 7, TEXT]), 1);
    assert.equal(fns.AppendMenuA.handler([outer, MF_SEPARATOR, 0, 0]), 1);
    assert.equal(fns.AppendMenuA.handler([outer, MF_POPUP, inner, TEXT]), 1);
    assert.equal(fns.GetMenuItemCount.handler([outer]), 3);
    assert.equal(fns.GetMenuState.handler([outer, 7, 0]) & MF_GRAYED, MF_GRAYED);
    assert.equal(fns.GetSubMenu.handler([outer, 2]), inner);
    assert.equal(fns.AppendMenuA.handler([0x9999, 0, 1, TEXT]), 0);
});

test('destroying a menu takes its submenus with it', ()=>{
    // The submenu was handed over when it was inserted. A program that had to
    // destroy it itself would be freeing it twice.
    const { memory, fns } = setup();
    const outer = fns.CreateMenu.handler([]);
    const inner = fns.CreatePopupMenu.handler([]);
    putItemInfo(memory, { mask: MIIM_SUBMENU, submenu: inner });
    fns.InsertMenuItemA.handler([outer, 0, 1, INFO]);

    assert.equal(fns.DestroyMenu.handler([outer]), 1);
    assert.equal(fns.GetMenuItemCount.handler([inner]), -1, 'the submenu went too');
});

test('IsMenu holds for a live menu and refuses a destroyed one with the reason', ()=>{
    // user32's menu tests: a popup is a menu until DestroyMenu, and then IsMenu
    // fails with ERROR_INVALID_MENU_HANDLE.
    const ERROR_INVALID_MENU_HANDLE = 1401;
    /** @type {number[]} */
    const errors = [];
    const { fns } = setup({ setLastError: (/** @type {number} */ code)=>errors.push(code) });
    const menu = fns.CreatePopupMenu.handler([]);
    assert.equal(fns.IsMenu.handler([menu]), 1);
    assert.equal(fns.IsMenu.argBytes, 4);

    fns.DestroyMenu.handler([menu]);
    assert.equal(fns.IsMenu.handler([menu]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_MENU_HANDLE]);
    assert.equal(fns.IsMenu.handler([0]), 0, 'nor is null a menu');
});

/**
 * A menu template in the resource compiler's own layout: items end to end with
 * no padding, a popup's items right after its text, MF_END closing a level.
 *
 * @param {number[]} words The template as little-endian WORDs.
 * @returns {Uint8Array}
 */
function menuResource(words){
    const bytes = new Uint8Array(words.length * 2);
    words.forEach((word, index)=>{
        bytes[index * 2] = word & 0xff;
        bytes[index * 2 + 1] = (word >>> 8) & 0xff;
    });
    return bytes;
}

/** "File" holding New, a separator and Exit; then "Help" holding About. */
const TWO_MENUS = menuResource([
    0x0000, 0x0000,                          // version 0, no extra header
    0x0010, ...[...'File'].map(c=>c.charCodeAt(0)), 0x0000,  // popup "File"
    0x0000, 0x0001, ...[...'New'].map(c=>c.charCodeAt(0)), 0x0000,
    0x0800, 0x0000, 0x0000,                  // separator
    0x0080, 0x0002, ...[...'Exit'].map(c=>c.charCodeAt(0)), 0x0000,  // MF_END
    0x0090, ...[...'Help'].map(c=>c.charCodeAt(0)), 0x0000,  // popup, MF_END
    0x0080, 0x0003, ...[...'About'].map(c=>c.charCodeAt(0)), 0x0000, // MF_END
]);

/**
 * A host whose module holds one menu resource, at a base the reads add to.
 *
 * @param {Uint8Array} template @param {number | string} [name]
 */
function menuHost(template, name = 128){
    const BASE = 0x400;
    const RVA = 0x10;
    return {
        base: BASE,
        host: {
            /** @param {number} instance @param {number} type @param {number | string} asked */
            findResource: (instance, type, asked)=>(type === 4 && asked === name
                && instance === BASE ? { rva: RVA, size: template.length } : null),
            moduleBase: ()=>BASE,
        },
        /** @param {any} memory */
        plant(memory){
            memory.writeMemory(BASE + RVA, template);
        },
    };
}

test('a menu resource loads into the tree its template holds', ()=>{
    const source = menuHost(TWO_MENUS);
    const { memory, fns } = setup(source.host);
    source.plant(memory);

    const menu = fns.LoadMenuA.handler([source.base, 128]);
    assert.notEqual(menu, 0, 'the module carries the resource, so the menu loads');
    // The top level is the two bars; each opens a popup of its own.
    assert.equal(fns.GetMenuItemCount.handler([menu]), 2);
    const file = fns.GetSubMenu.handler([menu, 0]);
    assert.notEqual(file, 0, 'the first bar opens a submenu');
    assert.equal(fns.GetMenuItemCount.handler([file]), 3, 'New, a separator and Exit');
    assert.equal(fns.GetMenuItemID.handler([file, 0]), 1, 'New keeps its id');
    assert.equal(fns.GetMenuItemID.handler([file, 2]), 2, 'and so does Exit');
    assert.equal(fns.GetMenuItemID.handler([file, 1]), 0, 'a separator has no command');
    const help = fns.GetSubMenu.handler([menu, 1]);
    assert.equal(fns.GetMenuItemCount.handler([help]), 1);
    assert.equal(fns.GetMenuItemID.handler([help, 0]), 3, 'About under Help');
});

test('a loaded menu reads back its text, and a separator says it is one', ()=>{
    const source = menuHost(TWO_MENUS);
    const { memory, fns } = setup(source.host);
    source.plant(memory);

    const menu = fns.LoadMenuA.handler([source.base, 128]);
    const file = fns.GetSubMenu.handler([menu, 0]);
    putItemInfo(memory, { mask: MIIM_STRING, text: '........', cch: 16 });
    assert.equal(fns.GetMenuItemInfoA.handler([file, 0, 1, INFO]), 1);
    // GetMenuItemInfoA writes the text into the caller's buffer and its length
    // back into cch; read both to see the item was named "New".
    assert.equal(memory.readCString(TEXT, 16), 'New');
    assert.equal(memory.u32(INFO + 40), 3, 'and cch came back the text\'s length');

    putItemInfo(memory, { mask: 0x0010, text: '........' });   // MIIM_TYPE
    fns.GetMenuItemInfoA.handler([file, 1, 1, INFO]);
    assert.equal(memory.u32(INFO + 8) & 0x0800, 0x0800, 'the middle item is a separator');
});

test('a menu named by a string is found, and one the module lacks is not', ()=>{
    const source = menuHost(TWO_MENUS, 'MAINMENU');
    const { memory, fns } = setup(source.host);
    source.plant(memory);
    memory.putString(NAME_A, 'MAINMENU');

    assert.notEqual(fns.LoadMenuA.handler([source.base, NAME_A]), 0,
        'the name the resource is filed under loads it');
    memory.putString(NAME_B, 'OTHER');
    assert.equal(fns.LoadMenuA.handler([source.base, NAME_B]), 0, 'a name it lacks does not');
    assert.equal(fns.LoadMenuA.handler([source.base, 999]), 0, 'nor does an id it lacks');
});

test('a menu with no module behind it, or a cut template, loads nothing', ()=>{
    const source = menuHost(TWO_MENUS);
    const { memory, fns } = setup(source.host);
    source.plant(memory);

    // A module the loader never mapped has no base, so there is nothing to read.
    assert.equal(fns.LoadMenuA.handler([0x999, 128]), 0);

    // A template whose last popup never says MF_END was cut mid-menu; loading
    // it would invent the items the bytes ran out before spelling.
    const cut = menuHost(TWO_MENUS.subarray(0, TWO_MENUS.length - 6), 7);
    const partial = setup(cut.host);
    cut.plant(partial.memory);
    assert.equal(partial.fns.LoadMenuA.handler([cut.base, 7]), 0);
});

test('loading a menu twice makes two menus, each its owner can destroy alone', ()=>{
    const source = menuHost(TWO_MENUS);
    const { memory, fns } = setup(source.host);
    source.plant(memory);

    const first = fns.LoadMenuA.handler([source.base, 128]);
    const second = fns.LoadMenuA.handler([source.base, 128]);
    assert.notEqual(first, second, 'each load is the caller\'s own copy');
    assert.equal(fns.DestroyMenu.handler([first]), 1);
    assert.equal(fns.GetMenuItemCount.handler([second]), 2, 'and the other is untouched');
});

// --- accelerators ---

test('an accelerator table is six bytes to an entry, not eight', ()=>{
    // Walked at four-byte stride the second entry is read out of the middle of
    // its neighbour, which yields a table of plausible rubbish rather than an
    // error.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    // Six, written out rather than taken from the code under test: a fixture
    // laid out with the same constant moves with it and can never disagree.
    assert.equal(ACCEL_SIZE, 6);
    memory.bytes.set([FVIRTKEY, 0, 0x70, 0, 0x11, 0x11], ACCEL);
    memory.bytes.set([FVIRTKEY, 0, 0x71, 0, 0x22, 0x22], ACCEL + 6);
    const table = fns.CreateAcceleratorTableA.handler([ACCEL, 2]);
    assert.equal(fns.CreateAcceleratorTableW.argBytes, 8);
    const wideTable = fns.CreateAcceleratorTableW.handler([ACCEL, 2]);
    assert.equal(fns.CopyAcceleratorTableA.handler([wideTable, 0, 0]), 2,
        'the W form reads the same six-byte entries');

    memory.putU32s(MSG, [hwnd, WM_KEYDOWN, 0x71, 0]);
    assert.equal(fns.TranslateAcceleratorA.handler([hwnd, table, MSG]), 1);

    const posted = fns.GetMessageA.handler([OUT, 0, 0, 0]);
    assert.equal(posted, 1);
    assert.equal(memory.u32(OUT + 4), WM_COMMAND);
    assert.equal(memory.u32(OUT + 8), (1 << 16 | 0x2222) >>> 0,
        'the high word says an accelerator produced it, not a menu');
});

test('an accelerator that needs a modifier is not matched without one', ()=>{
    // There is no keyboard state to consult, so firing the command on the
    // unmodified key would run a menu command the person never asked for.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    memory.bytes.set([FVIRTKEY | FCONTROL, 0, 0x53, 0, 0x33, 0x33], ACCEL);
    const table = fns.CreateAcceleratorTableA.handler([ACCEL, 1]);

    memory.putU32s(MSG, [hwnd, WM_KEYDOWN, 0x53, 0]);
    assert.equal(fns.TranslateAcceleratorA.handler([hwnd, table, MSG]), 0);
});

// --- clipboard ---

test('the clipboard is bracketed, and a write outside the brackets fails', ()=>{
    const { fns } = setup();

    assert.equal(fns.SetClipboardData.handler([CF_TEXT, 0x5000]), 0,
        'a program told this succeeded has no reason to open the clipboard');
    assert.equal(fns.OpenClipboard.handler([0]), 1);
    assert.equal(fns.OpenClipboard.handler([0]), 0, 'and it cannot be opened twice');
    assert.equal(fns.SetClipboardData.handler([CF_TEXT, 0x5000]), 0x5000);
    assert.equal(fns.GetClipboardData.handler([CF_TEXT]), 0x5000);
    assert.equal(fns.EmptyClipboard.handler([]), 1);
    assert.equal(fns.GetClipboardData.handler([CF_TEXT]), 0);
    assert.equal(fns.CloseClipboard.handler([]), 1);
    assert.equal(fns.CloseClipboard.handler([]), 0);
});

test('what the host pasted is read back in the format asked for, until the program takes over',
    ()=>{
        // The page's paste lands on the host's pasteboard; a program's
        // GetClipboardData for a text format gets a copy laid down in guest
        // memory, the same handle while the paste stands, a fresh one after
        // the next paste, and none once it has emptied the clipboard itself.
        const { memory, fns } = setup({
            pasteboard,
            allocate: (/** @type {number} */ bytes)=>memory.alloc(bytes),
            release: (/** @type {number} */ address)=>released.push(address),
        });
        assert.equal(fns.IsClipboardFormatAvailable.handler([CF_TEXT]), 0);
        pasteboard.text = 'pa\u0161s\u00e9\u20ac\u0416';
        pasteboard.version = 1;
        assert.equal(fns.IsClipboardFormatAvailable.handler([CF_TEXT]), 1);
        assert.equal(fns.IsClipboardFormatAvailable.handler([CF_UNICODETEXT]), 1);
        assert.equal(fns.IsClipboardFormatAvailable.handler([2]), 0, 'no bitmap');
        assert.equal(fns.CountClipboardFormats.handler([]), 3);
        assert.equal(fns.GetClipboardData.handler([CF_TEXT]), 0, 'closed');

        assert.equal(fns.OpenClipboard.handler([0]), 1);
        assert.equal(fns.EnumClipboardFormats.handler([0]), CF_TEXT);
        assert.equal(fns.EnumClipboardFormats.handler([CF_UNICODETEXT]), 0);
        const narrow = fns.GetClipboardData.handler([CF_TEXT]);
        assert.notEqual(narrow, 0);
        assert.deepEqual([...memory.readMemory(narrow, 8)],
            [0x70, 0x61, 0x9a, 0x73, 0xe9, 0x80, 0x3f, 0],
            'in the ANSI page, where a character it lacks is the default character');
        assert.equal(fns.GetClipboardData.handler([CF_TEXT]), narrow, 'the same copy again');
        const wide = fns.GetClipboardData.handler([CF_UNICODETEXT]);
        assert.notEqual(wide, narrow);
        assert.deepEqual([...memory.readMemory(wide, 16)],
            [0x70, 0, 0x61, 0, 0x61, 1, 0x73, 0, 0xe9, 0, 0xac, 0x20, 0x16, 4, 0, 0],
            'UTF-16, terminated');
        assert.equal(fns.CloseClipboard.handler([]), 1);
        assert.deepEqual(released, []);

        pasteboard.text = 'next';
        pasteboard.version = 2;
        assert.equal(fns.OpenClipboard.handler([0]), 1);
        const again = fns.GetClipboardData.handler([CF_TEXT]);
        assert.equal(memory.readCString(again, 16), 'next');
        assert.deepEqual(released.sort(), [narrow, wide].sort(), 'the old copies went back');

        // The program takes the clipboard for its own copy: the paste is
        // gone until the host pastes anew, and its own data is what is read.
        assert.equal(fns.EmptyClipboard.handler([]), 1);
        assert.equal(fns.GetClipboardData.handler([CF_TEXT]), 0);
        assert.equal(fns.IsClipboardFormatAvailable.handler([CF_TEXT]), 0);
        assert.equal(fns.SetClipboardData.handler([CF_TEXT, 0x5000]), 0x5000);
        assert.equal(fns.GetClipboardData.handler([CF_TEXT]), 0x5000);
        assert.equal(fns.CloseClipboard.handler([]), 1);
        pasteboard.text = 'newer';
        pasteboard.version = 3;
        assert.equal(fns.OpenClipboard.handler([0]), 1);
        assert.equal(fns.GetClipboardData.handler([CF_TEXT]), 0x5000, 'its own copy stays first');
        assert.equal(fns.GetClipboardData.handler([CF_UNICODETEXT]) !== 0, true,
            'a format it did not set is answered from the paste');
        assert.equal(fns.CloseClipboard.handler([]), 1);
    });
/** @type {{ text: string | null, version: number }} */
const pasteboard = { text: null, version: 0 };
/** @type {number[]} */
const released = [];

/** @returns {{ copied: string[], host: { clipboard: (text: string) => void } }} */
function clipboardListener(){
    /** @type {string[]} */
    const copied = [];
    return { copied, host: { clipboard: text=>copied.push(text) } };
}

/** @param {any} memory @param {number} address @param {string} text */
function putWideString(memory, address, text){
    for (let index = 0; index < text.length; index++)
    {
        const code = text.charCodeAt(index);
        memory.bytes[address + index * 2] = code & 0xff;
        memory.bytes[address + index * 2 + 1] = code >>> 8;
    }
    memory.bytes[address + text.length * 2] = 0;
    memory.bytes[address + text.length * 2 + 1] = 0;
}

test('CF_TEXT set under an open clipboard reaches the host, exactly, on close', ()=>{
    // The handle is the guest allocation itself: what a program locks is the
    // pointer it got back, so the text is read straight through the handle.
    const { copied, host } = clipboardListener();
    const { memory, fns } = setup(host);
    memory.putString(TEXT, 'Fatal error at 0x00401000\r\nstack: 3 frames');

    assert.equal(fns.OpenClipboard.handler([0]), 1);
    assert.equal(fns.EmptyClipboard.handler([]), 1);
    assert.equal(fns.SetClipboardData.handler([CF_TEXT, TEXT]), TEXT);
    assert.deepEqual(copied, [], 'nothing leaves before the clipboard is closed');
    assert.equal(fns.CloseClipboard.handler([]), 1);
    assert.deepEqual(copied, ['Fatal error at 0x00401000\r\nstack: 3 frames']);

    // Opened again to read, and closed without a write: a paste does not
    // push the stale copy over what the person took since.
    fns.OpenClipboard.handler([0]);
    assert.equal(fns.GetClipboardData.handler([CF_TEXT]), TEXT);
    fns.CloseClipboard.handler([]);
    assert.equal(copied.length, 1);
});

test('CF_UNICODETEXT is read as UTF-16 and preferred over the byte formats', ()=>{
    const { copied, host } = clipboardListener();
    const { memory, fns } = setup(host);
    memory.putString(TEXT, 'narrow');
    putWideString(memory, OUT, 'wide \u0416');

    fns.OpenClipboard.handler([0]);
    fns.SetClipboardData.handler([CF_TEXT, TEXT]);
    fns.SetClipboardData.handler([CF_UNICODETEXT, OUT]);
    fns.CloseClipboard.handler([]);
    assert.deepEqual(copied, ['wide \u0416']);
});

test('CF_TEXT reaches the host as the characters its bytes are in the ANSI page', ()=>{
    // 0x80 is the euro sign there, 0x99 the trade mark and 0x97 an em dash,
    // as Windows turns CF_TEXT into the Unicode text it offers.
    const { copied, host } = clipboardListener();
    const { memory, fns } = setup(host);
    memory.bytes.set([0x80, 0x99, 0x97, 0xe9, 0], TEXT);

    fns.OpenClipboard.handler([0]);
    fns.SetClipboardData.handler([CF_TEXT, TEXT]);
    fns.CloseClipboard.handler([]);
    assert.deepEqual(copied, ['\u20ac\u2122\u2014\u00e9']);
});

test('CF_OEMTEXT is text too, and a close with no text format hands nothing up', ()=>{
    const { copied, host } = clipboardListener();
    const { memory, fns } = setup(host);

    fns.OpenClipboard.handler([0]);
    fns.SetClipboardData.handler([2, 0x5000]);
    fns.CloseClipboard.handler([]);
    assert.deepEqual(copied, [], 'a bitmap is not text');

    memory.putString(TEXT, 'oem');
    fns.OpenClipboard.handler([0]);
    fns.SetClipboardData.handler([CF_OEMTEXT, TEXT]);
    fns.CloseClipboard.handler([]);
    assert.deepEqual(copied, ['oem']);

    // Nothing to read through a null handle: that is delayed rendering, and
    // the owner is not asked to render here.
    fns.OpenClipboard.handler([0]);
    fns.EmptyClipboard.handler([]);
    fns.SetClipboardData.handler([CF_TEXT, 0]);
    fns.CloseClipboard.handler([]);
    assert.equal(copied.length, 1);
});

// --- scroll bars ---

test('a scroll position is clamped to the range less the page', ()=>{
    // Where the thumb can actually sit. The return is the position after
    // clamping rather than the one asked for, because a caller that scrolled
    // past the end needs to know where it ended up.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);

    memory.putU32s(SCROLLINFO.cbSize + INFO,
        [SCROLLINFO.SIZE, SIF_RANGE | SIF_PAGE | SIF_POS, 0, 100, 10, 500, 0]);
    assert.equal(fns.SetScrollInfo.handler([hwnd, SB_HORZ, INFO, 0]), 91);

    memory.putU32s(INFO, [SCROLLINFO.SIZE, SIF_POS, 0, 0, 0, 0, 0]);
    assert.equal(fns.GetScrollInfo.handler([hwnd, SB_HORZ, INFO]), 1);
    assert.equal(memory.u32(INFO + SCROLLINFO.nPos), 91);
});

test('SetScrollPos answers with where the thumb was, not where it went', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    memory.putU32s(INFO, [SCROLLINFO.SIZE, SIF_RANGE | SIF_POS, 0, 100, 0, 20, 0]);
    fns.SetScrollInfo.handler([hwnd, SB_HORZ, INFO, 0]);

    assert.equal(fns.SetScrollPos.handler([hwnd, SB_HORZ, 60, 0]), 20);
    assert.equal(fns.SetScrollPos.handler([hwnd, SB_HORZ, 999, 0]), 60);
    memory.putU32s(INFO, [SCROLLINFO.SIZE, SIF_POS, 0, 0, 0, 0, 0]);
    fns.GetScrollInfo.handler([hwnd, SB_HORZ, INFO]);
    assert.equal(memory.u32(INFO + SCROLLINFO.nPos), 100, 'and clamps what it was given');
});

test('a range set through SCROLLINFO is read through GetScrollRange, and the other way round', ()=>{
    // One state behind both halves: a program of the era sets the range with
    // the old call and reads it with the new one, or the reverse.
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    memory.putU32s(INFO, [SCROLLINFO.SIZE, SIF_RANGE | SIF_POS, 7, 42, 0, 30, 0]);
    fns.SetScrollInfo.handler([hwnd, SB_HORZ, INFO, 0]);

    assert.equal(fns.GetScrollRange.handler([hwnd, SB_HORZ, OUT, OUT + 4]), 1);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [7, 42]);
    assert.equal(fns.GetScrollPos.handler([hwnd, SB_HORZ]), 30);

    assert.equal(fns.SetScrollRange.handler([hwnd, SB_HORZ, 0, 10, 1]), 1);
    memory.putU32s(INFO, [SCROLLINFO.SIZE, SIF_RANGE | SIF_POS, 0, 0, 0, 0, 0]);
    fns.GetScrollInfo.handler([hwnd, SB_HORZ, INFO]);
    assert.equal(memory.u32(INFO + SCROLLINFO.nMax), 10);
    assert.equal(memory.u32(INFO + SCROLLINFO.nPos), 10, 'the thumb follows a range that shrank');
    assert.equal(fns.GetScrollPos.handler([0x9999, SB_HORZ]), 0, 'no window, no position');
});

test('EnableScrollBar says whether the arrows changed, and SB_BOTH covers both bars', ()=>{
    const ESB_DISABLE_BOTH = 3;
    const SB_VERT = 1;
    const SB_BOTH = 3;
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    assert.equal(fns.EnableScrollBar.handler([hwnd, SB_HORZ, 0]), 0, 'already enabled');
    assert.equal(fns.EnableScrollBar.handler([hwnd, SB_BOTH, ESB_DISABLE_BOTH]), 1);
    assert.equal(fns.EnableScrollBar.handler([hwnd, SB_VERT, ESB_DISABLE_BOTH]), 0,
        'already disabled');
    assert.equal(fns.ShowScrollBar.handler([hwnd, SB_BOTH, 1]), 1);
    assert.equal(fns.ShowScrollBar.handler([0x9999, SB_BOTH, 1]), 0);
});

test('the scroll-range family declares the stack it pops', ()=>{
    const { fns } = setup();
    assert.equal(fns.GetScrollRange.argBytes, 16);
    assert.equal(fns.SetScrollRange.argBytes, 20);
    assert.equal(fns.GetScrollPos.argBytes, 8);
    assert.equal(fns.ShowScrollBar.argBytes, 12);
    assert.equal(fns.EnableScrollBar.argBytes, 12);
});

test('destroying a cursor or icon fails on a handle it was never given, rather than throwing', ()=>{
    const { fns } = setup();

    // A shared standard object is named by a small integer on a null instance
    // and is handed back as it is, never opened in the table; an invalid handle
    // is not open either. Windows fails the destroy of both, and the table's
    // close throws on a handle it does not know -- so the throw has to become
    // the FALSE answer here, not something that escapes and stops the guest.
    const shared = 0x7f02;
    assert.equal(fns.DestroyCursor.handler([shared]), 0, 'a shared cursor is not destroyed');
    assert.equal(fns.DestroyIcon.handler([shared]), 0, 'nor a shared icon');
    assert.equal(fns.DestroyCursor.handler([0]), 0, 'an invalid handle fails, not throws');

    // A cursor the program created is a real handle: destroying it succeeds
    // exactly once, and the second destroy is the failure a double free is.
    const cursor = fns.CreateCursor.handler([0, 0, 0, 32, 32]);
    assert.equal(fns.DestroyCursor.handler([cursor]), 1, 'a created cursor is destroyed');
    assert.equal(fns.DestroyCursor.handler([cursor]), 0, 'and only once');
});

test('CopyImage makes a new handle on the same picture, and can let the original go', ()=>{
    const { fns } = setup();
    const cursor = fns.CreateCursor.handler([0, 3, 4, 32, 32]);
    const copy = fns.CopyImage.handler([cursor, 2, 0, 0, 0]);
    assert.notEqual(copy, 0);
    assert.notEqual(copy, cursor);
    assert.equal(fns.DestroyCursor.handler([cursor]), 1, 'the original is its own handle');
    const moved = fns.CopyImage.handler([copy, 2, 0, 0, 8]);
    assert.notEqual(moved, 0);
    assert.equal(fns.DestroyCursor.handler([copy]), 0, 'LR_COPYDELETEORG let it go');
    assert.equal(fns.CopyImage.handler([0x7777, 1, 0, 0, 0]), 0, 'nothing to copy');
    assert.equal(fns.CopyImage.handler([moved, 0, 0, 0, 0]), 0, 'a bitmap is not copied here');
});

test('CreateIcon makes an icon of the size given, its hot spot in the middle', ()=>{
    const { fns, memory } = setup();
    const icon = fns.CreateIcon.handler([0, 10, 10, 1, 32, 0x200, 0x400]);
    assert.notEqual(icon, 0);
    assert.equal(fns.GetIconInfo.handler([icon, 0x100]), 1);
    const view = new DataView(memory.bytes.buffer);
    assert.deepEqual([0, 4, 8].map(at=>view.getUint32(0x100 + at, true)), [1, 5, 5], 'an icon');
    assert.equal(fns.DestroyIcon.handler([icon]), 1);
    assert.equal(fns.CreateIcon.handler([0, 0, 10, 1, 32, 0x200, 0x400]), 0, 'no width');
    assert.equal(fns.CreateIcon.handler([0, 10, 10, 1, 7, 0x200, 0x400]), 0, 'no such depth');
});

test('GetIconInfo answers the kind and hot spot, and fails on a destroyed handle', ()=>{
    const { fns, memory } = setup();
    const cursor = fns.CreateCursor.handler([0, 3, 4, 32, 32]);
    assert.equal(fns.GetIconInfo.handler([cursor, 0x100]), 1);
    const view = new DataView(memory.bytes.buffer);
    assert.deepEqual([0, 4, 8, 12, 16].map(at=>view.getUint32(0x100 + at, true)), [0, 3, 4, 0, 0]);
    fns.DestroyCursor.handler([cursor]);
    assert.equal(fns.GetIconInfo.handler([cursor, 0x100]), 0);
});

// --- the flag-described menu calls, accelerators out of resources, help ids ---

test('InsertMenu puts an item before the one named, and at the end for a place past the last', ()=>{
    const MF_POPUP = 0x10;
    const MF_HILITE = 0x80;
    const { memory, fns } = setup();
    const outer = fns.CreateMenu.handler([]);
    const inner = fns.CreatePopupMenu.handler([]);
    memory.putString(TEXT, 'x');
    fns.AppendMenuA.handler([inner, 0, 10, TEXT]);
    fns.AppendMenuA.handler([outer, MF_POPUP, inner, TEXT]);
    /** @param {number} menu */
    const ids = menu=>Array.from({ length: fns.GetMenuItemCount.handler([menu]) },
        (_, at)=>fns.GetMenuItemID.handler([menu, at]));

    assert.equal(fns.InsertMenuA.argBytes, 20);
    assert.equal(fns.InsertMenuA.handler([outer, 0, MF_BYPOSITION, 1, TEXT]), 1);
    assert.equal(fns.InsertMenuA.handler([outer, -1, MF_BYPOSITION, 2, TEXT]), 1);
    assert.equal(fns.InsertMenuA.handler([outer, 99, MF_BYPOSITION, 3, TEXT]), 1);
    assert.deepEqual(ids(outer), [1, -1, 2, 3], 'first, then -1 and a place past the last append');

    // By command the item is found inside the popup, and the new one joins it.
    assert.equal(fns.InsertMenuA.handler([outer, 10, MF_HILITE, 11, TEXT]), 1);
    assert.deepEqual(ids(inner), [11, 10]);
    assert.equal(fns.GetMenuState.handler([inner, 11, 0]) & MF_HILITE, MF_HILITE,
        'InsertMenu keeps MF_HILITE, as user32\'s menu tests expect');
    assert.equal(fns.InsertMenuA.handler([outer, 777, 0, 12, TEXT]), 1);
    assert.equal(ids(outer).at(-1), 12, 'a command no item has appends to the menu named');
    assert.equal(fns.InsertMenuA.handler([0x9999, 0, MF_BYPOSITION, 1, TEXT]), 0);
});

test('the wide menu calls read their text as UTF-16', ()=>{
    const { memory, fns } = setup();
    const menu = fns.CreateMenu.handler([]);
    putWideString(memory, TEXT, 'Öffnen…');
    assert.equal(fns.AppendMenuW.argBytes, 16);
    assert.equal(fns.AppendMenuW.handler([menu, 0, 5, TEXT]), 1);
    putWideString(memory, TEXT, 'Neu');
    assert.equal(fns.InsertMenuW.handler([menu, 0, MF_BYPOSITION, 4, TEXT]), 1);

    assert.equal(fns.GetMenuStringW.handler([menu, 5, OUT, 16, 0]), 7);
    assert.equal(Buffer.from(memory.bytes.subarray(OUT, OUT + 14)).toString('utf16le'),
        'Öffnen…');
    assert.equal(fns.GetMenuStringA.handler([menu, 0, OUT, 16, MF_BYPOSITION]), 3);
    assert.equal(memory.readCString(OUT, 16), 'Neu');
});

test('CopyAcceleratorTable counts with no destination and copies what fits', ()=>{
    // user32's resource tests: a null destination answers the entry count
    // whatever the count argument says; a copy answers how many it wrote;
    // the key comes back as given and the flags without their top bit.
    const { memory, fns } = setup();
    memory.bytes.set([0xff, 0, 0xff, 0xff, 0xff, 0xff], ACCEL);
    memory.bytes.set([FVIRTKEY, 0, 0x41, 0, 0xe8, 0x03], ACCEL + 6);
    const table = fns.CreateAcceleratorTableA.handler([ACCEL, 2]);

    assert.equal(fns.CopyAcceleratorTableA.argBytes, 12);
    for (const room of [0, 1, 100])
    {
        assert.equal(fns.CopyAcceleratorTableA.handler([table, 0, room]), 2);
    }
    memory.bytes.fill(0xa5, OUT, OUT + 12);
    assert.equal(fns.CopyAcceleratorTableA.handler([table, OUT, 1]), 1);
    assert.deepEqual([...memory.bytes.subarray(OUT, OUT + 6)].filter((_, at)=>at !== 1),
        [0x7f, 0xff, 0xff, 0xff, 0xff]);
    assert.equal(memory.bytes[OUT + 6], 0xa5, 'nothing past the room given');
    assert.equal(fns.CopyAcceleratorTableW.handler([table, OUT, 5]), 2);
    assert.deepEqual([...memory.bytes.subarray(OUT + 6, OUT + 12)].filter((_, at)=>at !== 1),
        [FVIRTKEY, 0x41, 0, 0xe8, 0x03]);
    assert.equal(fns.CopyAcceleratorTableA.handler([0x9999, 0, 0]), 0, 'no such table');
});

/**
 * An RT_ACCELERATOR resource: eight bytes to an entry, the last flagged 0x80.
 *
 * @param {[number, number, number][]} entries  flags, key, command
 */
function acceleratorResource(entries){
    const bytes = new Uint8Array(entries.length * 8);
    entries.forEach(([flags, key, command], index)=>{
        const at = index * 8;
        bytes.set([flags | (index === entries.length - 1 ? 0x80 : 0), 0,
            key & 0xff, key >>> 8, command & 0xff, command >>> 8, 0, 0], at);
    });
    return bytes;
}

/** A host whose module holds one accelerator resource, filed under `name`. */
function acceleratorHost(/** @type {Uint8Array} */ resource, /** @type {number | string} */ name){
    const BASE = 0x400;
    const RVA = 0x10;
    return {
        base: BASE,
        host: {
            /** @param {number} instance @param {number} type @param {number | string} asked */
            findResource: (instance, type, asked)=>(type === 9 && instance === BASE
                && (asked === name || (typeof asked === 'string' && typeof name === 'string'
                    && asked.toUpperCase() === name.toUpperCase()))
                ? { rva: RVA, size: resource.length } : null),
            moduleBase: ()=>BASE,
        },
        /** @param {any} memory */
        plant(memory){
            memory.writeMemory(BASE + RVA, resource);
        },
    };
}

test('LoadAccelerators reads a resource\'s eight-byte entries, its end flag not kept', ()=>{
    const VK_F5 = 0x74;
    const source = acceleratorHost(acceleratorResource([
        [FVIRTKEY, VK_F5, 0x100],
        [FVIRTKEY | FCONTROL, 0x53, 0x101],
    ]), 'MAINACCEL');
    const { memory, fns } = setup(source.host);
    source.plant(memory);
    memory.putString(NAME_A, 'MainAccel');
    const hwnd = makeWindow(memory, fns);

    const table = fns.LoadAcceleratorsA.handler([source.base, NAME_A]);
    assert.notEqual(table, 0);
    assert.equal(fns.CopyAcceleratorTableA.handler([table, 0, 0]), 2, 'stops at the flagged one');
    fns.CopyAcceleratorTableA.handler([table, OUT, 2]);
    assert.equal(memory.bytes[OUT + 6], FVIRTKEY | FCONTROL, 'the end flag is the resource\'s');
    assert.equal(memory.bytes[OUT + 10] | memory.bytes[OUT + 11] << 8, 0x101);

    putWideString(memory, NAME_B, 'mainaccel');
    assert.equal(fns.LoadAcceleratorsW.handler([source.base, NAME_B]), table,
        'the module\'s table, by a name in any case and either spelling, is the one table');
    assert.equal(fns.LoadAcceleratorsA.handler([source.base, 7]), 0, 'an id it lacks');
    assert.equal(fns.LoadAcceleratorsA.handler([0x999, NAME_A]), 0, 'a module it is not in');

    memory.putU32s(MSG, [hwnd, WM_KEYDOWN, VK_F5, 0]);
    assert.equal(fns.TranslateAcceleratorW.argBytes, 12);
    assert.equal(fns.TranslateAcceleratorW.handler([hwnd, table, MSG]), 1);
    assert.equal(fns.GetMessageA.handler([OUT, 0, 0, 0]), 1);
    assert.equal(memory.u32(OUT + 4), WM_COMMAND);
    assert.equal(memory.u32(OUT + 8), (1 << 16 | 0x100) >>> 0);
});

test('a window\'s context help id is read back, and a window that is not one has none', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    assert.equal(fns.GetWindowContextHelpId.handler([hwnd]), 0);
    assert.equal(fns.SetWindowContextHelpId.argBytes, 8);
    assert.equal(fns.SetWindowContextHelpId.handler([hwnd, 0x20001]), 1);
    assert.equal(fns.GetWindowContextHelpId.handler([hwnd]), 0x20001);
    assert.equal(fns.SetWindowContextHelpId.handler([0x9999, 1]), 0);
    assert.equal(fns.GetWindowContextHelpId.handler([0x9999]), 0);
});

// --- default items, radio groups, highlighting, help ids ---

const MF_GRAYED = 0x0001;
const MF_CHECKED = 0x0008;
const MF_HILITE = 0x0080;
const MF_POPUP = 0x0010;
const MF_SEPARATOR = 0x0800;
const MFS_DEFAULT = 0x1000;
const MFT_RADIOCHECK = 0x0200;
const GMDI_USEDISABLED = 0x0001;
const GMDI_GOINTOPOPUPS = 0x0002;
const ERROR_INVALID_MENU_HANDLE = 1401;
const NONE = 0xffffffff;

/** A popup of the given commands, each named after its id. @param {any} fns @param {any} memory */
function popupOf(fns, memory, /** @type {number[]} */ ids){
    const menu = fns.CreatePopupMenu.handler([]);
    for (const id of ids)
    {
        fns.AppendMenuA.handler([menu, id === 0 ? MF_SEPARATOR : 0, id,
            id === 0 ? 0 : memory.putString(TEXT, `Item ${id}`)]);
    }
    return menu;
}

test('one item of a menu is its default, by command or place, and -1 leaves none', ()=>{
    /** @type {number[]} */
    const errors = [];
    const { memory, fns } = setup({ setLastError: (/** @type {number} */ code)=>errors.push(code) });
    const menu = popupOf(fns, memory, [10, 20, 30]);
    assert.equal(fns.GetMenuDefaultItem.handler([menu, 0, 0]), NONE, 'none to begin with');

    assert.equal(fns.SetMenuDefaultItem.handler([menu, 20, 0]), 1);
    assert.equal(fns.GetMenuDefaultItem.handler([menu, 0, 0]), 20);
    assert.equal(fns.GetMenuDefaultItem.handler([menu, 1, 0]), 1, 'by place');
    assert.equal(fns.GetMenuState.handler([menu, 20, 0]) & MFS_DEFAULT, MFS_DEFAULT);

    // Marking another unmarks the first: there is one default.
    assert.equal(fns.SetMenuDefaultItem.handler([menu, 2, 1]), 1);
    assert.equal(fns.GetMenuDefaultItem.handler([menu, 0, 0]), 30);
    assert.equal(fns.GetMenuState.handler([menu, 20, 0]) & MFS_DEFAULT, 0);

    assert.equal(fns.SetMenuDefaultItem.handler([menu, 99, 0]), 0, 'no such command');
    assert.equal(fns.SetMenuDefaultItem.handler([menu, 3, 1]), 0, 'no such place');
    assert.equal(fns.GetMenuDefaultItem.handler([menu, 0, 0]), 30, 'a refusal changes nothing');
    assert.equal(fns.SetMenuDefaultItem.handler([menu, -1 >>> 0, 0]), 1);
    assert.equal(fns.GetMenuDefaultItem.handler([menu, 0, 0]), NONE);

    assert.equal(fns.SetMenuDefaultItem.handler([0x9999, 0, 0]), 0);
    assert.equal(fns.GetMenuDefaultItem.handler([0x9999, 0, 0]), NONE);
    assert.deepEqual(errors, [ERROR_INVALID_MENU_HANDLE]);
});

test('a disabled default counts only when asked, and a default popup is looked into', ()=>{
    const { memory, fns } = setup();
    const inner = popupOf(fns, memory, [5, 6]);
    const outer = popupOf(fns, memory, [1]);
    fns.AppendMenuA.handler([outer, MF_POPUP, inner, memory.putString(TEXT, 'More')]);
    fns.SetMenuDefaultItem.handler([outer, 1, 1]);
    // The popup has no default of its own yet: the popup item itself answers.
    assert.equal(fns.GetMenuDefaultItem.handler([outer, 1, GMDI_GOINTOPOPUPS]), 1);
    fns.SetMenuDefaultItem.handler([inner, 6, 0]);
    assert.equal(fns.GetMenuDefaultItem.handler([outer, 0, GMDI_GOINTOPOPUPS]), 6);
    assert.equal(fns.GetMenuDefaultItem.handler([outer, 1, 0]), 1, 'not looked into unasked');

    fns.EnableMenuItem.handler([inner, 6, MF_GRAYED]);
    assert.equal(fns.GetMenuDefaultItem.handler([inner, 0, 0]), NONE);
    assert.equal(fns.GetMenuDefaultItem.handler([inner, 0, GMDI_USEDISABLED]), 6);
});

test('CheckMenuRadioItem checks one of a group with the bullet and clears the rest', ()=>{
    const { memory, fns } = setup();
    const menu = popupOf(fns, memory, [100, 101, 0, 102, 200]);
    fns.CheckMenuItem.handler([menu, 100, MF_CHECKED]);
    fns.CheckMenuItem.handler([menu, 200, MF_CHECKED]);
    assert.equal(fns.CheckMenuRadioItem.handler([menu, 100, 102, 102, 0]), 1);
    assert.equal(fns.GetMenuState.handler([menu, 100, 0]) & MF_CHECKED, 0, 'unchecked');
    assert.equal(fns.GetMenuState.handler([menu, 102, 0]) & (MF_CHECKED | MFT_RADIOCHECK),
        MF_CHECKED | MFT_RADIOCHECK, 'checked with the bullet');
    assert.equal(fns.GetMenuState.handler([menu, 200, 0]) & MF_CHECKED, MF_CHECKED,
        'outside the group, untouched');

    // A check outside the group checks nothing, and says so -- after
    // clearing the group, as Windows does.
    assert.equal(fns.CheckMenuRadioItem.handler([menu, 100, 101, 200, 0]), 0);
    // By place, the separator is no part of the group.
    assert.equal(fns.CheckMenuRadioItem.handler([menu, 0, 3, 1, MF_BYPOSITION]), 1);
    assert.equal(fns.GetMenuState.handler([menu, 1, MF_BYPOSITION]) & MF_CHECKED, MF_CHECKED);
    assert.equal(fns.GetMenuState.handler([menu, 3, MF_BYPOSITION]) & MF_CHECKED, 0);
    // The widest range there is is walked by the ids the menu has, not by number.
    assert.equal(fns.CheckMenuRadioItem.handler([menu, 0, 0xffffffff, 200, 0]), 1);
    assert.equal(fns.CheckMenuRadioItem.handler([0x9999, 0, 1, 0, 0]), 0);
});

test('HiliteMenuItem marks the item, and a menu carries a help id of its own', ()=>{
    const { memory, fns } = setup();
    const hwnd = makeWindow(memory, fns);
    const menu = popupOf(fns, memory, [7, 8]);
    assert.equal(fns.HiliteMenuItem.handler([hwnd, menu, 8, MF_HILITE]), 1);
    assert.equal(fns.GetMenuState.handler([menu, 8, 0]) & MF_HILITE, MF_HILITE);
    assert.equal(fns.HiliteMenuItem.handler([hwnd, menu, 1, MF_HILITE | MF_BYPOSITION]), 1);
    assert.equal(fns.HiliteMenuItem.handler([hwnd, menu, 8, 0]), 1);
    assert.equal(fns.GetMenuState.handler([menu, 8, 0]) & MF_HILITE, 0);
    assert.equal(fns.HiliteMenuItem.handler([hwnd, menu, 99, MF_HILITE]), 0);

    assert.equal(fns.GetMenuContextHelpId.handler([menu]), 0);
    assert.equal(fns.SetMenuContextHelpId.handler([menu, 0x1234]), 1);
    assert.equal(fns.GetMenuContextHelpId.handler([menu]), 0x1234);
    assert.equal(fns.SetMenuContextHelpId.handler([0x9999, 1]), 0);
    assert.equal(fns.GetMenuContextHelpId.handler([0x9999]), 0);
});

test('TrackPopupMenuEx is dismissed as TrackPopupMenu is, and refuses what is no menu', ()=>{
    /** @type {number[]} */
    const errors = [];
    const { memory, fns } = setup({ setLastError: (/** @type {number} */ code)=>errors.push(code) });
    const hwnd = makeWindow(memory, fns);
    const menu = popupOf(fns, memory, [1]);
    const TPM_RETURNCMD = 0x0100;
    assert.equal(fns.TrackPopupMenuEx.argBytes, 24);
    assert.equal(fns.TrackPopupMenuEx.handler([menu, TPM_RETURNCMD, 0, 0, hwnd, 0]), 0);
    assert.deepEqual(errors, []);
    assert.equal(fns.TrackPopupMenuEx.handler([0x9999, 0, 0, 0, hwnd, 0]), 0);
    assert.equal(fns.TrackPopupMenu.handler([0x9999, 0, 0, 0, 0, hwnd, 0]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_MENU_HANDLE, ERROR_INVALID_MENU_HANDLE]);
});

// --- menus out of templates in memory ---

const TEMPLATE_AT = 0x12000;

test('LoadMenuIndirect builds a menu out of a template in the program\'s memory', ()=>{
    const { memory, fns } = setup();
    memory.writeMemory(TEMPLATE_AT, TWO_MENUS);
    for (const name of ['LoadMenuIndirectA', 'LoadMenuIndirectW'])
    {
        const menu = fns[name].handler([TEMPLATE_AT]);
        assert.notEqual(menu, 0, name);
        assert.equal(fns.GetMenuItemCount.handler([menu]), 2);
        const file = fns.GetSubMenu.handler([menu, 0]);
        assert.equal(fns.GetMenuItemCount.handler([file]), 3);
        assert.equal(fns.GetMenuStringA.handler([file, 2, OUT, 16, MF_BYPOSITION]), 4);
        assert.equal(memory.readCString(OUT, 16), 'Exit');
    }
    assert.equal(fns.LoadMenuIndirectA.handler([0]), 0);
    // A template whose last item never says it is the last is cut short.
    memory.writeMemory(0x13f00, TWO_MENUS.subarray(0, 24));
    assert.equal(fns.LoadMenuIndirectA.handler([0x13f00]), 0);
});

/**
 * An extended (MENUEX) template: the header, then each item's type, state,
 * id and flags, its text padded to a DWORD, a popup's help id and items.
 *
 * @param {{ type?: number, state?: number, id?: number, text: string, last?: boolean,
 *     help?: number, popup?: any[] }[]} items @param {number} help
 */
function menuExTemplate(items, help){
    /** @type {number[]} */
    const bytes = [1, 0, 4, 0, help & 0xff, help >>> 8 & 0xff, help >>> 16 & 0xff, help >>> 24];
    /** @param {number} value */
    const dword = value=>bytes.push(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
        value >>> 24 & 0xff);
    /** @param {any[]} level */
    const put = level=>level.forEach((item, index)=>{
        dword(item.type ?? 0);
        dword(item.state ?? 0);
        dword(item.id ?? 0);
        const flags = (item.popup ? 0x01 : 0) | (index === level.length - 1 ? 0x80 : 0);
        bytes.push(flags, 0);
        for (const character of `${item.text}\0`)
        {
            bytes.push(character.charCodeAt(0), 0);
        }
        while (bytes.length % 4 !== 0)
        {
            bytes.push(0);
        }
        if (item.popup)
        {
            dword(item.help ?? 0);
            put(item.popup);
        }
    });
    put(items);
    return Uint8Array.from(bytes);
}

test('an extended template carries states, popup ids and help ids', ()=>{
    const { memory, fns } = setup();
    memory.writeMemory(TEMPLATE_AT, menuExTemplate([
        { text: 'File', id: 50, help: 0x77, popup: [
            { text: 'Open', id: 1, state: MFS_DEFAULT },
            { text: '', type: MF_SEPARATOR },
            { text: 'Quit', id: 2, state: MF_GRAYED },
        ] },
        { text: 'Go', id: 3 },
    ], 0x55));
    const menu = fns.LoadMenuIndirectW.handler([TEMPLATE_AT]);
    assert.notEqual(menu, 0);
    assert.equal(fns.GetMenuItemCount.handler([menu]), 2);
    assert.equal(fns.GetMenuContextHelpId.handler([menu]), 0x55);
    const file = fns.GetSubMenu.handler([menu, 0]);
    assert.equal(fns.GetMenuContextHelpId.handler([file]), 0x77);
    assert.equal(fns.GetMenuItemCount.handler([file]), 3);
    assert.equal(fns.GetMenuDefaultItem.handler([file, 0, 0]), 1);
    assert.equal(fns.GetMenuState.handler([file, 2, 0]) & MF_GRAYED, MF_GRAYED);
    assert.equal(fns.GetMenuStringA.handler([menu, 3, OUT, 16, 0]), 2);
    assert.equal(memory.readCString(OUT, 16), 'Go');
});

// --- the clipboard's owner, its sequence and its viewers ---

const WM_DRAWCLIPBOARD = 0x0308;
const WM_CHANGECBCHAIN = 0x030d;

/** The table over a window manager that writes down what each window procedure is sent. */
function listening(){
    /** @type {{ hwnd: number, message: number, wParam: number, lParam: number }[]} */
    const sent = [];
    /** @type {number[]} */
    const errors = [];
    const memory = fakeMemory();
    const board = { text: /** @type {string | null} */ (null), version: 0 };
    const fns = /** @type {any} */ (createWindowFunctions({
        readMemory: (a, n)=>memory.readMemory(a, n),
        writeMemory: (a, d)=>memory.writeMemory(a, d),
        readCString: (a, n)=>memory.readCString(a, n),
        handles: fakeHandles(),
        queue: createMessageQueue(),
        dispatch: (wndProc, message)=>{
            sent.push({ hwnd: message.hwnd, message: message.message, wParam: message.wParam,
                lParam: message.lParam });
            return message.message === WM_CHANGECBCHAIN ? 0 : 0;
        },
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
        setLastError: code=>errors.push(code),
        pasteboard: board,
    }));
    /** @param {number} kind */
    const told = kind=>sent.filter(each=>each.message === kind);
    return { memory, fns, sent, told, errors, board };
}

test('the window that empties the clipboard owns it, and the open window is told apart', ()=>{
    const { memory, fns, board } = listening();
    const a = makeWindow(memory, fns);
    const b = makeWindow(memory, fns);
    assert.equal(fns.GetClipboardOwner.handler([]), 0);
    assert.equal(fns.GetOpenClipboardWindow.handler([]), 0);
    const first = fns.GetClipboardSequenceNumber.handler([]);

    fns.OpenClipboard.handler([a]);
    assert.equal(fns.GetOpenClipboardWindow.handler([]), a);
    assert.equal(fns.GetClipboardOwner.handler([]), 0, 'opening is not owning');
    fns.EmptyClipboard.handler([]);
    assert.equal(fns.GetClipboardOwner.handler([]), a);
    fns.SetClipboardData.handler([CF_TEXT, 0x10400]);
    fns.CloseClipboard.handler([]);
    assert.equal(fns.GetOpenClipboardWindow.handler([]), 0);
    assert.equal(fns.GetClipboardOwner.handler([]), a, 'owned after it is closed');
    const second = fns.GetClipboardSequenceNumber.handler([]);
    assert.ok(second > first, 'the contents changed, so the number did');

    // Opened by another to read: the owner stays, and nothing changed.
    fns.OpenClipboard.handler([b]);
    fns.CloseClipboard.handler([]);
    assert.equal(fns.GetClipboardOwner.handler([]), a);
    assert.equal(fns.GetClipboardSequenceNumber.handler([]), second);

    // The host's paste replaces it: a change, and no window of ours owns it.
    board.text = 'pasted';
    board.version = 1;
    assert.equal(fns.GetClipboardOwner.handler([]), 0);
    assert.ok(fns.GetClipboardSequenceNumber.handler([]) > second);
});

test('a clipboard viewer is told of every change and of the chain changing', ()=>{
    const { memory, fns, told, errors } = listening();
    const first = makeWindow(memory, fns);
    const second = makeWindow(memory, fns);
    assert.equal(fns.GetClipboardViewer.handler([]), 0);
    assert.equal(fns.SetClipboardViewer.handler([first]), 0, 'nobody to pass the news to');
    assert.deepEqual(told(WM_DRAWCLIPBOARD).map(each=>each.hwnd), [first], 'told at once');
    assert.equal(fns.SetClipboardViewer.handler([second]), first, 'passes it on to the first');
    assert.equal(fns.GetClipboardViewer.handler([]), second);

    fns.OpenClipboard.handler([0]);
    fns.EmptyClipboard.handler([]);
    fns.CloseClipboard.handler([]);
    assert.deepEqual(told(WM_DRAWCLIPBOARD).map(each=>each.hwnd), [first, second, second],
        'the front of the chain hears of the change');
    fns.OpenClipboard.handler([0]);
    fns.CloseClipboard.handler([]);
    assert.equal(told(WM_DRAWCLIPBOARD).length, 3, 'and not of a look that changed nothing');

    // The second viewer is the front: one behind it leaving is the front's
    // news to pass along.
    assert.equal(fns.ChangeClipboardChain.handler([first, 0]), 1);
    assert.deepEqual(told(WM_CHANGECBCHAIN).map(each=>[each.hwnd, each.wParam, each.lParam]),
        [[second, first, 0]]);
    // The front leaving hands the front on, unannounced.
    assert.equal(fns.ChangeClipboardChain.handler([second, 0]), 1);
    assert.equal(fns.GetClipboardViewer.handler([]), 0);
    assert.equal(told(WM_CHANGECBCHAIN).length, 1);

    assert.equal(fns.SetClipboardViewer.handler([0x9999]), 0);
    assert.deepEqual(errors, [1400]);
});

// --- icons made of bitmaps, and copies ---

test('CreateIconIndirect copies the two bitmaps into a picture, the mask\'s pixels clear', ()=>{
    // A 2 x 1 icon: the left pixel shows red, the right is masked out.
    const pixels = new Map([
        [0x700, { width: 2, height: 1, bgra: Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 0]) }],
        [0x704, { width: 2, height: 1, bgra: Uint8Array.from([0, 0, 255, 0, 0, 0, 0, 0]) }],
    ]);
    const { memory, fns } = setup({
        bitmapSize: (/** @type {number} */ handle)=>pixels.get(handle) ?? null,
        bitmapPixels: (/** @type {number} */ handle)=>pixels.get(handle) ?? null,
    });
    memory.putU32s(INFO, [1, 9, 9, 0x700, 0x704]);
    const icon = fns.CreateIconIndirect.handler([INFO]);
    assert.notEqual(icon, 0);
    memory.putU32s(OUT, [0, 0, 0, 0, 0]);
    assert.equal(fns.GetIconInfo.handler([icon, OUT]), 1);
    assert.equal(memory.u32(OUT), 1, 'an icon');
    assert.deepEqual([memory.u32(OUT + 4), memory.u32(OUT + 8)], [1, 0],
        'whose hot spot is its centre, whatever it was given');

    // A cursor keeps the hot spot it was given.
    memory.putU32s(INFO, [0, 1, 0, 0x700, 0x704]);
    const cursor = fns.CreateIconIndirect.handler([INFO]);
    fns.GetIconInfo.handler([cursor, OUT]);
    assert.deepEqual([memory.u32(OUT), memory.u32(OUT + 4)], [0, 1]);

    memory.putU32s(INFO, [1, 0, 0, 0, 0x704]);
    assert.equal(fns.CreateIconIndirect.handler([INFO]), 0, 'no mask, no icon');
    assert.equal(fns.CreateIconIndirect.handler([0]), 0);
});

test('a monochrome icon is a mask twice its height, the colour in its lower half', ()=>{
    const mask = { width: 1, height: 2, bgra: Uint8Array.from([0, 0, 0, 0, 255, 255, 255, 0]) };
    /** @type {any} */
    let drawn = null;
    /** @param {number} hdc @param {number} x @param {number} y @param {any} shown */
    const picture = (hdc, x, y, shown)=>{
        drawn = shown;
        return true;
    };
    const { memory, fns } = setup({
        bitmapSize: ()=>mask,
        bitmapPixels: ()=>mask,
        dc: ()=>({ get: ()=>1, release: ()=>{} }),
        draw: { fill: ()=>true, clip: ()=>{}, picture },
    });
    memory.putU32s(INFO, [1, 0, 0, 0x700, 0]);
    const icon = fns.CreateIconIndirect.handler([INFO]);
    assert.notEqual(icon, 0);
    fns.DrawIcon.handler([1, 0, 0, icon]);
    assert.deepEqual(drawn && [drawn.width, drawn.height, ...drawn.bgra],
        [1, 1, 255, 255, 255, 255], 'drawn white, opaque, at half the mask\'s height');
});

test('CopyIcon is a new handle to the same picture, and a standard icon copies too', ()=>{
    /** @type {number[]} */
    const errors = [];
    const { memory, fns } = setup({ setLastError: (/** @type {number} */ code)=>errors.push(code) });
    memory.putU32s(INFO, [1, 0, 0, 0x700, 0]);
    const icon = fns.CreateIconIndirect.handler([INFO]);
    const copy = fns.CopyIcon.handler([icon]);
    assert.notEqual(copy, 0);
    assert.notEqual(copy, icon);
    assert.equal(fns.DestroyIcon.handler([icon]), 1);
    assert.equal(fns.GetIconInfo.handler([copy, OUT]), 1, 'the copy outlives the original');
    assert.equal(fns.DestroyIcon.handler([copy]), 1);

    const IDI_APPLICATION = 32512;
    const standard = fns.CopyIcon.handler([IDI_APPLICATION]);
    assert.notEqual(standard, 0);
    assert.equal(fns.DestroyIcon.handler([standard]), 1, 'the copy is the program\'s to destroy');
    assert.equal(fns.CopyIcon.handler([0]), 0);
    assert.deepEqual(errors, [1402]);
});

test('LoadMenu reads an extended menu resource as LoadMenuIndirect does', ()=>{
    const source = menuHost(menuExTemplate([{ text: 'Only', id: 9, state: MF_CHECKED }], 3));
    const { memory, fns } = setup(source.host);
    source.plant(memory);
    const menu = fns.LoadMenuA.handler([source.base, 128]);
    assert.notEqual(menu, 0);
    assert.equal(fns.GetMenuItemID.handler([menu, 0]), 9);
    assert.equal(fns.GetMenuState.handler([menu, 9, 0]) & MF_CHECKED, MF_CHECKED);
    assert.equal(fns.GetMenuContextHelpId.handler([menu]), 3);
});

test('CreateIconFromResourceEx makes an icon or cursor of one resource entry\'s image', ()=>{
    const { fns, memory } = setup();
    // A 2x2 32-bit entry: BITMAPINFOHEADER with both masks' height, the
    // colour rows and the AND mask (each row padded to a DWORD), bottom up.
    const header = new DataView(new ArrayBuffer(40));
    header.setUint32(0, 40, true);
    header.setInt32(4, 2, true);
    header.setInt32(8, 4, true);
    header.setUint16(12, 1, true);
    header.setUint16(14, 32, true);
    const image = new Uint8Array([...new Uint8Array(header.buffer),
        ...new Array(16).fill(0x80), ...new Array(8).fill(0)]);
    const ICON = 0x300;
    memory.bytes.set(image, ICON);
    const VERSION = 0x00030000;
    const icon = fns.CreateIconFromResourceEx.handler([ICON, image.length, 1, VERSION, 0, 0, 0]);
    assert.notEqual(icon, 0);
    assert.equal(fns.GetIconInfo.handler([icon, 0x100]), 1);
    const view = new DataView(memory.bytes.buffer);
    assert.deepEqual([0, 4, 8].map(at=>view.getUint32(0x100 + at, true)), [1, 1, 1],
        'an icon, its hot spot in the middle');
    assert.equal(fns.DestroyIcon.handler([icon]), 1);

    // A cursor's entry is its hot spot, two WORDs, before the same image.
    const CURSOR = 0x500;
    memory.bytes.set([1, 0, 0, 0, ...image], CURSOR);
    const cursor = fns.CreateIconFromResource.handler([CURSOR, image.length + 4, 0, VERSION]);
    assert.notEqual(cursor, 0);
    assert.equal(fns.GetIconInfo.handler([cursor, 0x100]), 1);
    assert.deepEqual([0, 4, 8].map(at=>view.getUint32(0x100 + at, true)), [0, 1, 0],
        'a cursor, at its own hot spot');

    assert.equal(fns.CreateIconFromResourceEx.handler([0, image.length, 1, VERSION, 0, 0, 0]), 0,
        'no bits');
    assert.equal(fns.CreateIconFromResourceEx.handler([ICON, image.length, 1, 0x00010000, 0, 0, 0]),
        0, 'a version below 0x00020000');
    assert.equal(fns.CreateIconFromResourceEx.argBytes, 28);
    assert.equal(fns.CreateIconFromResource.argBytes, 16);
});
