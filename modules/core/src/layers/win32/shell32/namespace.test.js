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
        folders: { Desktop: 'C:\\Desk' },
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
    return { memory, shell, call, u32, put, string, wide, texts, published };
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
