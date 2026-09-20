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
        pasteboard.text = 'pa\u0161s\u00e9';
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
        assert.equal(memory.readCString(narrow, 16), 'pa?s\u00e9', 'one byte a character');
        assert.equal(fns.GetClipboardData.handler([CF_TEXT]), narrow, 'the same copy again');
        const wide = fns.GetClipboardData.handler([CF_UNICODETEXT]);
        assert.notEqual(wide, narrow);
        assert.deepEqual([...memory.readMemory(wide, 12)],
            [0x70, 0, 0x61, 0, 0x61, 1, 0x73, 0, 0xe9, 0, 0, 0], 'UTF-16, terminated');
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
