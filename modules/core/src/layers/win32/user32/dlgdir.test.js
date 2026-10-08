/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DDL_DIRECTORY, DDL_DRIVES, DDL_EXCLUSIVE, DDL_HIDDEN, DDL_READONLY, absolutePath,
    directoryItems, selectedPath,
} from './dlgdir.js';
import { createMessageQueue } from './messages.js';
import { createWindowFunctions } from './windows.js';
import { decodeAnsi } from '../kernel32/locale.js';

/**
 * A volume of a few files: C: with a games directory, and a D: with nothing
 * on it. Names match a pattern as FindFirstFile matches them, `*.*` taking
 * names with no dot.
 */
function volume(){
    /** @type {Record<string, { name: string, isDirectory: boolean, readOnly?: boolean,
     *     hidden?: boolean }[]>} */
    const tree = {
        'c:\\': [{ name: 'GAMES', isDirectory: true }, { name: 'boot.ini', isDirectory: false,
            hidden: true }],
        'c:\\games': [
            { name: 'saves', isDirectory: true },
            { name: 'game.exe', isDirectory: false },
            { name: 'slot1.sav', isDirectory: false },
            { name: 'slot2.sav', isDirectory: false, readOnly: true },
            { name: 'README', isDirectory: false },
        ],
        'c:\\games\\saves': [],
        'd:\\': [],
    };
    let current = 'C:\\GAMES';
    /** @param {string} path */
    const key = path=>(path.length <= 3 ? path : path.replace(/\\$/, '')).toLowerCase();
    /** @param {string} pattern @param {string} name */
    const matches = (pattern, name)=>{
        if (pattern === '*.*' || pattern === '*')
        {
            return true;
        }
        const expression = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
            .replace(/\?/g, '.');
        return new RegExp(`^${expression}$`, 'i').test(name);
    };
    const files = /** @type {any} */ ({
        stat: (/** @type {string} */ path)=>{
            if (key(path) in tree)
            {
                return { exists: true, isDirectory: true, size: 0 };
            }
            const cut = path.lastIndexOf('\\');
            const parent = tree[key(cut <= 2 ? path.slice(0, 3) : path.slice(0, cut))];
            const found = parent?.find(entry=>entry.name.toLowerCase()
                === path.slice(cut + 1).toLowerCase());
            return found ? { exists: true, isDirectory: found.isDirectory, size: 0 } : null;
        },
        list: (/** @type {string} */ path, /** @type {string} */ pattern)=>
            (tree[key(path)] ?? []).filter(entry=>matches(pattern, entry.name))
                .map(entry=>({ size: 0, ...entry })),
        currentDirectory: ()=>current,
        setCurrentDirectory: (/** @type {string} */ path)=>{
            current = path;
            return true;
        },
    });
    return files;
}

test('a path is made absolute against the current directory, its drive, or its root', ()=>{
    const files = volume();
    assert.equal(absolutePath(files, '*.sav'), 'C:\\GAMES\\*.sav');
    assert.equal(absolutePath(files, '..\\x'), 'C:\\x');
    assert.equal(absolutePath(files, '\\WINDOWS\\.\\a'), 'C:\\WINDOWS\\a');
    assert.equal(absolutePath(files, 'd:*.*'), 'd:\\*.*', 'another drive\'s own directory');
    assert.equal(absolutePath(files, 'c:saves'), 'C:\\GAMES\\saves', 'this drive\'s current one');
    assert.equal(absolutePath(files, 'E:/a/b'), 'E:\\a\\b');
});

test('LB_DIR lists files plain, directories in brackets, drives between dashes', ()=>{
    const files = volume();
    assert.deepEqual(directoryItems(files, 0, '*.*'),
        { found: true, items: ['game.exe', 'slot1.sav', 'README'] },
        'read-write files: a read-only one only when asked for');
    assert.deepEqual(directoryItems(files, DDL_READONLY, '*.sav').items,
        ['slot1.sav', 'slot2.sav']);
    assert.deepEqual(directoryItems(files, DDL_DIRECTORY | DDL_EXCLUSIVE, '*.*').items,
        ['[..]', '[saves]'], 'the parent too, which FindFirstFile finds');
    assert.deepEqual(directoryItems(files, DDL_DRIVES | DDL_EXCLUSIVE, '*.*').items,
        ['[-c-]', '[-d-]']);
    assert.deepEqual(directoryItems(files, DDL_READONLY | DDL_EXCLUSIVE, '*.*').items,
        ['slot2.sav'], 'exclusive: only what carries the mark');
    assert.deepEqual(directoryItems(files, DDL_HIDDEN | DDL_DIRECTORY, 'C:\\*.*').items,
        ['[GAMES]', 'boot.ini'], 'a root has no parent, and a hidden file wants asking for');
    assert.deepEqual(directoryItems(files, 0, '*.zip'), { found: false, items: [] });
    assert.deepEqual(directoryItems(files, DDL_DRIVES, 'Q:\\*.*'), { found: false, items: [] },
        'a search that finds nothing adds no drives either');
});

test('a selected entry reads back as a path piece, TRUE for a directory or drive', ()=>{
    assert.deepEqual(selectedPath('[saves]'), { text: 'saves\\', directory: true });
    assert.deepEqual(selectedPath('[-d-]'), { text: 'd:', directory: true });
    assert.deepEqual(selectedPath('slot1.sav'), { text: 'slot1.sav', directory: false });
    assert.deepEqual(selectedPath('README'), { text: 'README.', directory: false },
        'a name with no extension is given its dot');
});

/** The window manager over the volume, with a dialog of a list, a combo and a static. */
function dialogOver(){
    const bytes = new Uint8Array(0x30000);
    let heap = 0x20000;
    const files = volume();
    const handles = new Map();
    let next = 4;
    const fns = /** @type {any} */ (createWindowFunctions({
        readMemory: (a, n)=>bytes.slice(a, a + n),
        writeMemory: (a, d)=>bytes.set(d, a),
        readCString: (a, n)=>{
            let end = a;
            while (bytes[end] !== 0 && end - a < n)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(a, end));
        },
        handles: {
            open: (type, object)=>{
                handles.set(next, object);
                next += 4;
                return next - 4;
            },
            close: handle=>handles.delete(handle),
            resolve: handle=>handles.get(handle),
        },
        queue: createMessageQueue(),
        dispatch: ()=>0,
        park: ()=>({ parked: true }),
        idle: ()=>new Promise(()=>{}),
        files,
        allocate: size=>{
            const at = heap;
            heap += (size + 15) & ~15;
            return at;
        },
        release: ()=>{},
    }));
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        bytes.set(new TextEncoder().encode(`${text}\0`), at);
        return at;
    };
    /** @param {number} at */
    const text = at=>decodeAnsi(bytes.subarray(at, bytes.indexOf(0, at)));
    const dialog = fns.CreateWindowExA.handler([0, put(0x10000, 'Static'), put(0x10100, ''),
        0x10000000, 0, 0, 300, 200, 0, 0, 0, 0]);
    const make = (/** @type {string} */ name, /** @type {number} */ id, /** @type {number} */ style)=>
        fns.CreateWindowExA.handler([0, put(0x10000, name), put(0x10100, ''),
            0x50000000 | style, 0, 0, 100, 100, dialog, id, 0, 0]);
    const LBS_SORT = 0x0002;
    const list = make('ListBox', 100, LBS_SORT);
    const combo = make('ComboBox', 102, 0x0003);
    const label = make('Static', 101, 0);
    /** @param {number} box @param {boolean} [fromCombo] */
    const items = (box, fromCombo = false)=>{
        const count = fns.SendMessageA.handler([box, fromCombo ? 0x0146 : 0x018b, 0, 0]);
        return Array.from({ length: count }, (_, at)=>{
            fns.SendMessageA.handler([box, fromCombo ? 0x0148 : 0x0189, at, 0x11000]);
            return text(0x11000);
        });
    };
    /** @param {number} at @param {Uint8Array} data */
    const write = (at, data)=>bytes.set(data, at);
    /** @param {number} at @param {number} length */
    const read = (at, length)=>bytes.slice(at, at + length);
    return { fns, files, dialog, list, combo, label, put, text, items, write, read };
}

test('DlgDirList fills the list, moves into the directory, and shows where it is', ()=>{
    const m = dialogOver();
    const SPEC = 0x12000;
    m.put(SPEC, 'C:\\GAMES\\*.sav');
    m.files.setCurrentDirectory('C:\\');
    assert.equal(m.fns.DlgDirListA.handler([m.dialog, SPEC, 100, 101,
        DDL_DIRECTORY | DDL_DRIVES]), 1);
    // The files the pattern matches, then every directory whatever the
    // pattern, then the drives, in the order a sorted list keeps.
    assert.deepEqual(m.items(m.list), ['[-c-]', '[-d-]', '[..]', '[saves]', 'slot1.sav']);
    assert.equal(m.files.currentDirectory(), 'C:\\GAMES', 'the directory is made current');
    assert.equal(m.text(SPEC), '*.sav', 'and the pattern is what is left of the spec');
    m.fns.GetWindowTextA.handler([m.label, 0x11100, 64]);
    assert.equal(m.text(0x11100), 'c:\\games');

    // A directory named alone lists all of it.
    m.put(SPEC, 'saves');
    assert.equal(m.fns.DlgDirListA.handler([m.dialog, SPEC, 100, 0, 0]), 1);
    assert.equal(m.files.currentDirectory(), 'C:\\GAMES\\saves');
    assert.equal(m.text(SPEC), '*.*');
    assert.deepEqual(m.items(m.list), []);

    m.put(SPEC, 'C:\\NOWHERE\\*.*');
    assert.equal(m.fns.DlgDirListA.handler([m.dialog, SPEC, 100, 0, 0]), 0,
        'a directory that is not there');
    assert.equal(m.files.currentDirectory(), 'C:\\GAMES\\saves', 'and nothing moved');
});

test('DlgDirSelectEx reads the selection back, TRUE for a directory', ()=>{
    const m = dialogOver();
    const SPEC = 0x12000;
    const OUT = 0x12100;
    m.put(SPEC, '*.*');
    m.fns.DlgDirListA.handler([m.dialog, SPEC, 100, 0, DDL_DIRECTORY]);
    const LB_SETCURSEL = 0x0186;
    assert.equal(m.fns.DlgDirSelectExA.handler([m.dialog, OUT, 64, 100]), 0, 'nothing selected');
    const at = m.items(m.list).indexOf('[saves]');
    m.fns.SendMessageA.handler([m.list, LB_SETCURSEL, at, 0]);
    assert.equal(m.fns.DlgDirSelectExA.handler([m.dialog, OUT, 64, 100]), 1);
    assert.equal(m.text(OUT), 'saves\\');
    m.fns.SendMessageA.handler([m.list, LB_SETCURSEL, m.items(m.list).indexOf('README'), 0]);
    assert.equal(m.fns.DlgDirSelectExA.handler([m.dialog, OUT, 4, 100]), 0);
    assert.equal(m.text(OUT), 'REA', 'cut to the room, terminator included');
});

test('the combo-box forms fill and read a combo box the same way', ()=>{
    const m = dialogOver();
    const SPEC = 0x12000;
    const OUT = 0x12100;
    m.put(SPEC, '*.*');
    assert.equal(m.fns.DlgDirListComboBoxA.handler([m.dialog, SPEC, 102, 0,
        DDL_DIRECTORY | DDL_EXCLUSIVE]), 1);
    assert.deepEqual(m.items(m.combo, true), ['[..]', '[saves]']);
    const CB_SETCURSEL = 0x014e;
    m.fns.SendMessageA.handler([m.combo, CB_SETCURSEL, 0, 0]);
    assert.equal(m.fns.DlgDirSelectComboBoxExA.handler([m.dialog, OUT, 64, 102]), 1);
    assert.equal(m.text(OUT), '..\\');
    assert.equal(m.fns.DlgDirListComboBoxA.argBytes, 20);
    assert.equal(m.fns.DlgDirSelectComboBoxExA.argBytes, 16);
});

test('the wide forms read and write UTF-16', ()=>{
    const m = dialogOver();
    const SPEC = 0x12000;
    /** @param {string} value */
    const wide = value=>new Uint8Array(Uint16Array.from(`${value}\0`, c=>c.charCodeAt(0)).buffer);
    m.write(SPEC, wide('C:\\GAMES\\*.sav'));
    assert.equal(m.fns.DlgDirListW.handler([m.dialog, SPEC, 100, 0, 0]), 1);
    assert.deepEqual(m.items(m.list), ['slot1.sav']);
    assert.deepEqual([...m.read(SPEC, 12)], [...wide('*.sav')], 'the pattern written back wide');

    const OUT = 0x12100;
    m.fns.SendMessageA.handler([m.list, 0x0186, 0, 0]);
    assert.equal(m.fns.DlgDirSelectExW.handler([m.dialog, OUT, 64, 100]), 0);
    assert.deepEqual([...m.read(OUT, 20)], [...wide('slot1.sav')]);
});
