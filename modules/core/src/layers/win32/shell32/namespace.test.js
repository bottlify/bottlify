/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShellFunctions } from './functions.js';
import { IID_IENUMIDLIST, IID_ISHELLFOLDER, MY_COMPUTER, itemsOf } from './namespace.js';
import { decodeAnsi } from '../kernel32/locale.js';

const S_OK = 0;
const S_FALSE = 1;
const SHCONTF_FOLDERS = 0x20;
const SHCONTF_NONFOLDERS = 0x40;
const SFGAO_FILESYSANCESTOR = 0x10000000;
const SFGAO_FOLDER = 0x20000000;
const SFGAO_FILESYSTEM = 0x40000000;
const SFGAO_HASSUBFOLDER = 0x80000000;
const SHGDN_FORPARSING = 0x8000;
const CSIDL_DRIVES = 0x11;

/** IShellFolder's slots after IUnknown's three. */
const FOLDER = { ParseDisplayName: 3, EnumObjects: 4, BindToObject: 5, CompareIDs: 7,
    GetAttributesOf: 9, GetDisplayNameOf: 11 };
/** IEnumIDList's. */
const ENUM = { Next: 3, Skip: 4, Reset: 5 };

/**
 * A guest memory, a volume with one drive and two directories, and a
 * publisher that hands out a pointer per object and keeps the object so a
 * test can call its methods the way the vtable would.
 */
function machine(){
    const memory = new Uint8Array(0x4000);
    const view = new DataView(memory.buffer);
    let free = 0x2000;
    /** @type {Map<number, { object: any, iid: string }>} */
    const published = new Map();
    let nextPointer = 0x10000;
    /** @type {Record<string, { isDirectory: boolean, children: string[] }>} */
    const tree = {
        'C:\\': { isDirectory: true, children: ['Program Files', 'readme.txt'] },
        'C:\\Program Files': { isDirectory: true, children: ['Common'] },
        'C:\\Program Files\\Common': { isDirectory: true, children: [] },
        'C:\\readme.txt': { isDirectory: false, children: [] },
    };
    const host = {
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        readMemory: (/** @type {number} */ a, /** @type {number} */ n)=>memory.slice(a, a + n),
        allocate: (/** @type {number} */ bytes)=>{
            const at = free;
            free += (bytes + 3) & ~3;
            return at;
        },
        folders: { Desktop: 'C:\\Desk', Personal: 'C:\\Program Files\\Common' },
        volume: {
            drives: ()=>['C'],
            /** @param {string} path */
            stat: path=>(tree[path] ? { isDirectory: tree[path].isDirectory } : null),
            /** @param {string} path */
            list: path=>(tree[path]?.children ?? []).map(name=>({
                name, isDirectory: tree[path.endsWith('\\') ? path + name : `${path}\\${name}`]
                    .isDirectory,
            })),
        },
        /** @param {any} object @param {string} iid */
        publish: (object, iid)=>{
            const pointer = nextPointer;
            nextPointer += 4;
            published.set(pointer, { object, iid });
            return pointer;
        },
    };
    const shell = /** @type {any} */ (createShellFunctions(host));
    /**
     * Calls a method through the pointer the guest holds, as the vtable
     * would: `this` removed, the arguments as pushed.
     *
     * @param {number} pointer @param {number} slot @param {number[]} args
     */
    const call = (pointer, slot, args)=>{
        const entry = published.get(pointer);
        assert.ok(entry, `no object at 0x${pointer.toString(16)}`);
        const record = entry.object.interfaceFor(entry.iid);
        return record.methods[slot].invoke(entry.object, args);
    };
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    /** @param {number} at @param {number} value */
    const put = (at, value)=>view.setUint32(at, value >>> 0, true);
    /** @param {number} at */
    const string = at=>decodeAnsi(memory.subarray(at, memory.indexOf(0, at)));
    /** @param {string} text */
    const wide = text=>{
        const at = host.allocate(text.length * 2 + 2);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
        return at;
    };
    const lists = { readMemory: host.readMemory, writeMemory: host.writeMemory };
    /** @param {number} list */
    const texts = list=>itemsOf(lists, list);
    return { memory, view, shell, call, u32, put, string, wide, texts, published };
}

/**
 * Every child of a folder, as a program's loop over Next would collect them.
 *
 * @param {ReturnType<typeof machine>} m @param {number} folder @param {number} flags
 */
function children(m, folder, flags){
    assert.equal(m.call(folder, FOLDER.EnumObjects, [0, flags, 0x100]), S_OK);
    const enumerator = m.u32(0x100);
    assert.equal(m.published.get(enumerator)?.iid, IID_IENUMIDLIST);
    const found = [];
    for (;;)
    {
        const status = m.call(enumerator, ENUM.Next, [1, 0x104, 0x108]);
        if (status !== S_OK)
        {
            assert.equal(status, S_FALSE);
            assert.equal(m.u32(0x108), 0, 'nothing fetched past the end');
            break;
        }
        assert.equal(m.u32(0x108), 1);
        found.push(m.u32(0x104));
    }
    return found;
}

test('the desktop holds the computer, the computer the drives, a drive its directories', ()=>{
    const m = machine();
    assert.equal(m.shell.SHGetDesktopFolder.handler([0x100]), S_OK);
    const desktop = m.u32(0x100);
    assert.equal(m.published.get(desktop)?.iid, IID_ISHELLFOLDER);

    const [computer] = children(m, desktop, SHCONTF_FOLDERS | SHCONTF_NONFOLDERS);
    assert.deepEqual(m.texts(computer), [MY_COMPUTER]);

    // The root a browser starts from: the item enumerated is the one the
    // special-folder call names, or the browser shows nothing at all.
    assert.equal(m.shell.SHGetSpecialFolderLocation.handler([0, CSIDL_DRIVES, 0x110]), S_OK);
    assert.equal(m.call(desktop, FOLDER.CompareIDs, [0, m.u32(0x110), computer]), 0);
    assert.equal(m.shell.SHGetPathFromIDListA.handler([m.u32(0x110), 0x200]), 0,
        'the computer is no path');

    assert.equal(m.call(desktop, FOLDER.BindToObject,
        [computer, 0, guid(m, IID_ISHELLFOLDER), 0x120]), S_OK);
    const drives = m.u32(0x120);
    const [c] = children(m, drives, SHCONTF_FOLDERS);
    assert.deepEqual(m.texts(c), ['C:\\']);

    assert.equal(m.call(drives, FOLDER.BindToObject,
        [c, 0, guid(m, IID_ISHELLFOLDER), 0x124]), S_OK);
    const root = m.u32(0x124);
    assert.deepEqual(children(m, root, SHCONTF_FOLDERS).map(m.texts), [['C:\\Program Files']],
        'folders only when only folders were asked for');
    assert.deepEqual(children(m, root, SHCONTF_FOLDERS | SHCONTF_NONFOLDERS).map(m.texts),
        [['C:\\Program Files'], ['C:\\readme.txt']], 'folders first');
});

test('attributes, names and a combined list say what a browser needs of an item', ()=>{
    const m = machine();
    m.shell.SHGetDesktopFolder.handler([0x100]);
    const desktop = m.u32(0x100);
    const [computer] = children(m, desktop, SHCONTF_FOLDERS);
    m.call(desktop, FOLDER.BindToObject, [computer, 0, guid(m, IID_ISHELLFOLDER), 0x120]);
    const drives = m.u32(0x120);
    const [c] = children(m, drives, SHCONTF_FOLDERS);

    // GetAttributesOf answers within the mask it was handed.
    m.put(0x130, c);
    m.put(0x134, 0xf0000000);
    assert.equal(m.call(drives, FOLDER.GetAttributesOf, [1, 0x130, 0x134]), S_OK);
    assert.equal(m.u32(0x134),
        (SFGAO_FOLDER | SFGAO_FILESYSTEM | SFGAO_FILESYSANCESTOR | SFGAO_HASSUBFOLDER) >>> 0);
    m.put(0x130, computer);
    m.put(0x134, SFGAO_FILESYSTEM | SFGAO_FOLDER);
    assert.equal(m.call(desktop, FOLDER.GetAttributesOf, [1, 0x130, 0x134]), S_OK);
    assert.equal(m.u32(0x134), SFGAO_FOLDER, 'the computer is a folder but no file system');

    // Names: for parsing what the item carries, otherwise what is shown --
    // as STRRET_CSTR, in place.
    assert.equal(m.call(drives, FOLDER.GetDisplayNameOf, [c, SHGDN_FORPARSING, 0x140]), S_OK);
    assert.equal(m.u32(0x140), 2);
    assert.equal(m.string(0x144), 'C:\\');
    assert.equal(m.call(drives, FOLDER.GetDisplayNameOf, [c, 0, 0x140]), S_OK);
    assert.equal(m.string(0x144), 'Local Disk (C:)');
    assert.equal(m.call(desktop, FOLDER.GetDisplayNameOf,
        [computer, SHGDN_FORPARSING, 0x140]), S_OK);
    assert.equal(m.string(0x144), MY_COMPUTER, 'the :: prefix tells a program it is no path');
    assert.equal(m.call(desktop, FOLDER.GetDisplayNameOf, [computer, 0, 0x140]), S_OK);
    assert.equal(m.string(0x144), 'My Computer');

    // A program combines the lists it was given into one, walking `cb`
    // fields and copying bytes; the result still names the place.
    const combined = combine(m, [computer, c]);
    assert.deepEqual(m.texts(combined), [MY_COMPUTER, 'C:\\']);
    assert.equal(m.shell.SHGetPathFromIDListA.handler([combined, 0x200]), 1);
    assert.equal(m.string(0x200), 'C:\\');

    // Sorting a listing: the computer first, then by name regardless of case.
    m.call(drives, FOLDER.BindToObject, [c, 0, guid(m, IID_ISHELLFOLDER), 0x124]);
    const root = m.u32(0x124);
    const [programs, readme] = children(m, root, SHCONTF_FOLDERS | SHCONTF_NONFOLDERS);
    assert.equal(m.call(root, FOLDER.CompareIDs, [0, programs, readme]) << 16 >> 16, -1);
    assert.equal(m.call(root, FOLDER.CompareIDs, [0, readme, programs]) << 16 >> 16, 1);
    assert.equal(m.call(desktop, FOLDER.CompareIDs, [0, computer, c]) << 16 >> 16, -1);

    // A path parses to its item, with the attributes asked for.
    m.put(0x150, SFGAO_FOLDER | SFGAO_FILESYSTEM);
    assert.equal(m.call(root, FOLDER.ParseDisplayName,
        [0, 0, m.wide('C:\\Program Files\\Common'), 0x14c, 0x148, 0x150]), S_OK);
    assert.deepEqual(m.texts(m.u32(0x148)), ['C:\\Program Files\\Common']);
    assert.equal(m.u32(0x150), SFGAO_FOLDER | SFGAO_FILESYSTEM, 'Common has no subfolder');
    assert.equal(m.u32(0x14c), 'C:\\Program Files\\Common'.length);
    // Wine's shlfolder test: no name is E_INVALIDARG, read from nowhere.
    m.put(0x148, 0xdeadbeef);
    assert.equal(m.call(root, FOLDER.ParseDisplayName, [0, 0, 0, 0, 0x148, 0]) >>> 0,
        0x80070057);
    assert.equal(m.u32(0x148), 0, 'and the item is NULL');
});

test('binding a file, or asking for an interface the folder lacks, is refused with a null', ()=>{
    const m = machine();
    m.shell.SHGetDesktopFolder.handler([0x100]);
    const desktop = m.u32(0x100);
    const [computer] = children(m, desktop, SHCONTF_FOLDERS);
    m.call(desktop, FOLDER.BindToObject, [computer, 0, guid(m, IID_ISHELLFOLDER), 0x120]);
    const drives = m.u32(0x120);
    const [c] = children(m, drives, SHCONTF_FOLDERS);
    m.call(drives, FOLDER.BindToObject, [c, 0, guid(m, IID_ISHELLFOLDER), 0x124]);
    const root = m.u32(0x124);
    const [, readme] = children(m, root, SHCONTF_FOLDERS | SHCONTF_NONFOLDERS);

    m.put(0x128, 0xdeadbeef);
    assert.equal(m.call(root, FOLDER.BindToObject,
        [readme, 0, guid(m, IID_ISHELLFOLDER), 0x128]) | 0, 0x80070057 | 0);
    assert.equal(m.u32(0x128), 0);
    const IID_ISHELLVIEW = '{000214E3-0000-0000-C000-000000000046}';
    assert.equal(m.call(root, FOLDER.BindToObject, [c, 0, guid(m, IID_ISHELLVIEW), 0x128]) | 0,
        0x80004002 | 0);
    assert.equal(m.u32(0x128), 0);

    // An enumerator skips and resets as one.
    m.call(root, FOLDER.EnumObjects, [0, SHCONTF_FOLDERS | SHCONTF_NONFOLDERS, 0x12c]);
    const enumerator = m.u32(0x12c);
    assert.equal(m.call(enumerator, ENUM.Skip, [1]), S_OK);
    assert.equal(m.call(enumerator, ENUM.Next, [1, 0x104, 0x108]), S_OK);
    assert.deepEqual(m.texts(m.u32(0x104)), ['C:\\readme.txt']);
    assert.equal(m.call(enumerator, ENUM.Reset, []), S_OK);
    assert.equal(m.call(enumerator, ENUM.Next, [1, 0x104, 0x108]), S_OK);
    assert.deepEqual(m.texts(m.u32(0x104)), ['C:\\Program Files']);
});

test('without a volume there is no namespace, and the refusal is the loud one', ()=>{
    const memory = new Uint8Array(0x200).fill(0xaa);
    /** @type {string[]} */
    const diverged = [];
    const shell = /** @type {any} */ (createShellFunctions({
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>memory.set(b, a),
        /** @param {string} api */
        divergence: api=>diverged.push(api),
    }));
    assert.equal(shell.SHGetDesktopFolder.handler([0x100]) | 0, 0x80004005 | 0);
    assert.deepEqual([...memory.slice(0x100, 0x104)], [0, 0, 0, 0]);
    assert.deepEqual(diverged, ['SHGetDesktopFolder']);
    assert.equal(shell.SHGetDesktopFolder.handler([0]) | 0, 0x80070057 | 0);
});

/**
 * A GUID in guest memory, as the guest passes `riid`.
 *
 * @param {ReturnType<typeof machine>} m @param {string} text
 */
function guid(m, text){
    const hex = text.replace(/[{}-]/g, '');
    const bytes = new Uint8Array(16);
    const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15];
    for (let i = 0; i < 16; i++)
    {
        bytes[order[i]] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const at = 0x1f00;
    m.memory.set(bytes, at);
    return at;
}

/**
 * ILCombine as a program writes it: every item of each list, then the
 * terminator.
 *
 * @param {ReturnType<typeof machine>} m @param {number[]} lists
 */
function combine(m, lists){
    const pieces = [];
    for (const list of lists)
    {
        let at = list;
        for (;;)
        {
            const cb = m.memory[at] | m.memory[at + 1] << 8;
            if (cb === 0)
            {
                break;
            }
            pieces.push(m.memory.slice(at, at + cb));
            at += cb;
        }
    }
    const out = 0x1e00;
    let at = out;
    for (const piece of pieces)
    {
        m.memory.set(piece, at);
        at += piece.length;
    }
    m.memory[at] = 0;
    m.memory[at + 1] = 0;
    return out;
}

test('SHBindToParent binds the folder a list ends in, and points at its last item', ()=>{
    // Wine's shlfolder tests: the child is a pointer into the caller's list,
    // an empty list is the desktop and itself, and no list fails.
    const m = machine();
    assert.equal(m.shell.SHGetSpecialFolderLocation.handler([0, CSIDL_DRIVES, 0x100]), S_OK);
    const computer = m.u32(0x100);
    assert.equal(m.shell.SHGetDesktopFolder.handler([0x104]), S_OK);
    const desktop = m.u32(0x104);
    const iid = guid(m, IID_ISHELLFOLDER);
    assert.equal(m.call(desktop, FOLDER.ParseDisplayName, [0, 0, m.wide('C:\\Program Files'),
        0, 0x108, 0]), S_OK);
    const path = combine(m, [computer, m.u32(0x108)]);

    assert.equal(m.shell.SHBindToParent.handler([path, iid, 0x110, 0x114]), S_OK);
    const parent = m.u32(0x110);
    assert.equal(m.published.get(parent)?.iid, IID_ISHELLFOLDER);
    const last = m.u32(0x114);
    assert.equal(last, path + (m.memory[path] | m.memory[path + 1] << 8),
        'the last item, inside the list given');
    assert.equal(m.call(parent, FOLDER.GetDisplayNameOf, [last, SHGDN_FORPARSING, 0x200]), S_OK);
    assert.equal(m.string(0x204), 'C:\\Program Files');
    assert.deepEqual(children(m, parent, SHCONTF_FOLDERS).map(list=>m.texts(list).at(-1)),
        ['C:\\Program Files'], 'the parent is the drive');

    const empty = 0x1d00;
    m.put(empty, 0);
    assert.equal(m.shell.SHBindToParent.handler([empty, iid, 0x110, 0x114]), S_OK);
    assert.equal(m.u32(0x114), empty, 'an empty list is its own last item');
    assert.deepEqual(children(m, m.u32(0x110), SHCONTF_FOLDERS).map(list=>m.texts(list)),
        [[MY_COMPUTER]], 'and its folder the desktop');

    m.put(0x114, 0xdeadbeef);
    assert.equal(m.shell.SHBindToParent.handler([0, iid, 0x110, 0x114]) | 0, 0x80070057 | 0);
    assert.equal(m.u32(0x114), 0, 'no list: a null child');
    assert.equal(m.shell.SHBindToParent.handler([path, guid(m,
        '{00000000-0000-0000-0000-000000000001}'), 0x110, 0]) | 0, 0x80004002 | 0,
    'an interface a folder does not have');
    assert.equal(m.u32(0x110), 0);
    assert.equal(m.shell.SHBindToParent.argBytes, 16);
});

test('SHGetDataFromIDList fills the find data of what a list names', ()=>{
    const m = machine();
    assert.equal(m.shell.SHGetDesktopFolder.handler([0x104]), S_OK);
    assert.equal(m.call(m.u32(0x104), FOLDER.ParseDisplayName, [0, 0, m.wide('C:\\readme.txt'),
        0, 0x108, 0]), S_OK);
    const file = m.u32(0x108);
    const out = 0x2c00;
    m.memory.fill(0xaa, out, out + 0x300);
    assert.equal(m.shell.SHGetDataFromIDListA.handler([0, file, 1, out, 320]), S_OK);
    assert.equal(m.u32(out), 0x20, 'FILE_ATTRIBUTE_ARCHIVE, a file');
    assert.equal(m.string(out + 44), 'readme.txt');
    assert.equal(m.memory[out + 304], 0, 'no short name');
    assert.equal(m.shell.SHGetDataFromIDListW.handler([0, file, 1, out, 592]), S_OK);
    assert.equal(String.fromCharCode(...new Uint16Array(m.memory.slice(out + 44, out + 64)
        .buffer)), 'readme.txt');
    assert.equal(m.shell.SHGetDataFromIDListA.handler([0, file, 3, out, 20]), S_OK);
    assert.equal(m.u32(out), 2, 'SHDID_FS_FILE');
    assert.equal(m.shell.SHGetDataFromIDListA.handler([0, file, 1, out, 319]) | 0,
        0x80070057 | 0, 'a buffer too small');
    assert.equal(m.shell.SHGetDataFromIDListA.handler([0, file, 2, out, 1024]) | 0,
        0x80070057 | 0, 'no network resource');
    assert.equal(m.shell.SHGetSpecialFolderLocation.handler([0, CSIDL_DRIVES, 0x100]), S_OK);
    assert.equal(m.shell.SHGetDataFromIDListA.handler([0, m.u32(0x100), 1, out, 320]) | 0,
        0x80070057 | 0, 'the computer is no path');
    assert.equal(m.shell.SHGetDataFromIDListW.argBytes, 20);
});

test('SHGetFolderLocation is SHGetSpecialFolderLocation, its reserved word zero', ()=>{
    const m = machine();
    assert.equal(m.shell.SHGetFolderLocation.handler([0, CSIDL_DRIVES, 0, 0, 0x100]), S_OK);
    assert.deepEqual(m.texts(m.u32(0x100)), [MY_COMPUTER]);
    assert.equal(m.shell.SHGetFolderLocation.handler([0, 0x10, 0, 0, 0x100]), S_OK);
    assert.deepEqual(m.texts(m.u32(0x100)), ['C:\\Desk']);
    assert.equal(m.shell.SHGetFolderLocation.handler([0, 0xeeee, 0, 0, 0x100]) | 0,
        0x80070057 | 0, 'a folder this machine does not have');
    assert.equal(m.u32(0x100), 0);
    assert.equal(m.shell.SHGetFolderLocation.handler([0, 0x10, 0, 1, 0x100]) | 0,
        0x80070057 | 0, 'a reserved word that is not zero');
    assert.equal(m.shell.SHGetFolderLocation.argBytes, 20);
});

test('the desktop parses its own items by CLSID, in any case: My Documents is its folder', ()=>{
    // A game finds where to save as ParseDisplayName("::{450d8fba-...}") on the
    // desktop and SHGetPathFromIDList of what comes back; an item it could not
    // parse leaves it saving under an empty path.
    const m = machine();
    assert.equal(m.shell.SHGetDesktopFolder.handler([0x104]), S_OK);
    const desktop = m.u32(0x104);
    assert.equal(m.call(desktop, FOLDER.ParseDisplayName, [0, 0,
        m.wide('::{450d8fba-ad25-11d0-98a8-0800361b1103}'), 0, 0x108, 0]), S_OK);
    assert.equal(m.shell.SHGetPathFromIDListA.handler([m.u32(0x108), 0x200]), 1);
    assert.equal(m.string(0x200), 'C:\\Program Files\\Common');
    assert.equal(m.call(desktop, FOLDER.ParseDisplayName, [0, 0,
        m.wide('::{20d04fe0-3aea-1069-a2d8-08002b30309d}'), 0, 0x10c, 0]), S_OK,
    'My Computer too');
});

test('the Control Panel is a folder of the desktop\'s, with nothing of the volume in it', ()=>{
    // Wine's test_BindToObject: its parsing name binds, as a folder that lists nothing.
    const m = machine();
    assert.equal(m.shell.SHGetDesktopFolder.handler([0x104]), S_OK);
    const desktop = m.u32(0x104);
    m.view.setUint32(0x110, 0xffffffff, true);
    assert.equal(m.call(desktop, FOLDER.ParseDisplayName, [0, 0,
        m.wide('::{21EC2020-3AEA-1069-A2DD-08002B30309D}'), 0, 0x108, 0x110]), S_OK);
    assert.equal(m.u32(0x110), (0x4 | 0x20000000 | 0x80000000) >>> 0,
        'SFGAO_CANLINK, SFGAO_FOLDER and SFGAO_HASSUBFOLDER');
    assert.equal(m.shell.SHGetPathFromIDListA.handler([m.u32(0x108), 0x200]), 0, 'no path');
});
