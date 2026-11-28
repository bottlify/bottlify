/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { guestOver } from '../common/guest.fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLSID_FILE_OPEN_DIALOG, CLSID_FILE_SAVE_DIALOG, OPEN_OPTIONS, SAVE_OPTIONS,
    registerFileDialogClasses } from './itemdialog.js';

const OUT = 0x1000;
const TEXT = 0x2000;
const SPECS = 0x3000;
const HEAP = 0x8000;

/** Both dialogs registered over plain memory; `make` gives one's methods by name. */
function dialogs(width = /** @type {4 | 8} */ (4)){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    let heap = HEAP;
    /** @type {Map<string, () => any>} */
    const classes = new Map();
    registerFileDialogClasses(/** @type {any} */ ({
        registerClass: (/** @type {string} */ clsid, /** @type {() => any} */ factory)=>
            classes.set(clsid, factory),
    }), {
        guest: guestOver(bytes, width),
        allocate: n=>{
            const at = heap;
            heap += n;
            return at;
        },
    });
    const wide = (/** @type {number} */ at, /** @type {string} */ text)=>{
        [...`${text}\0`].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
        return at;
    };
    const readWide = (/** @type {number} */ at)=>{
        let text = '';
        for (let p = at; view.getUint16(p, true) !== 0; p += 2)
        {
            text += String.fromCharCode(view.getUint16(p, true));
        }
        return text;
    };
    /** @param {string} clsid */
    const make = clsid=>{
        const definition = /** @type {() => any} */ (classes.get(clsid))();
        const object = { state: definition.state };
        /** @type {Record<string, (...args: number[]) => number>} */
        const methods = {};
        for (const method of definition.interfaces[0].methods)
        {
            methods[method.name] = (...args)=>method.invoke(object, args);
        }
        return { methods, definition };
    };
    return { make, view, wide, readWide };
}

test('a file dialog keeps its options, file types and name, and Show is dismissed', ()=>{
    const d = dialogs();
    const { methods } = d.make(CLSID_FILE_OPEN_DIALOG);
    assert.equal(methods.GetOptions(OUT), 0);
    assert.equal(d.view.getUint32(OUT, true), OPEN_OPTIONS);
    assert.equal(methods.GetFileName(OUT), 0x80004005 | 0, 'no name before one is set');
    methods.SetFileName(d.wide(TEXT, 'save1.dat'));
    assert.equal(methods.GetFileName(OUT), 0);
    assert.equal(d.readWide(d.view.getUint32(OUT, true)), 'save1.dat');

    assert.equal(methods.GetFileTypeIndex(OUT), 0);
    assert.equal(d.view.getUint32(OUT, true), 0, 'no types, no index');
    d.view.setUint32(SPECS, d.wide(TEXT, 'Saves'), true);
    d.view.setUint32(SPECS + 4, d.wide(TEXT + 0x100, '*.sav'), true);
    assert.equal(methods.SetFileTypes(0, 0), 0x80070057 | 0, 'no array is refused');
    assert.equal(methods.SetFileTypeIndex(1), 0x80004005 | 0, 'no types to choose from');
    assert.equal(methods.SetFileTypes(0, SPECS), 0, 'none given sets none');
    assert.equal(methods.SetFileTypes(1, SPECS), 0);
    assert.equal(methods.SetFileTypes(1, SPECS), 0x8000ffff | 0, 'the types are set once');
    methods.GetFileTypeIndex(OUT);
    assert.equal(d.view.getUint32(OUT, true), 0, 'none chosen yet');
    assert.equal(methods.SetFileTypeIndex(100), 0);
    methods.GetFileTypeIndex(OUT);
    assert.equal(d.view.getUint32(OUT, true), 1, 'held within the types, one-based');

    assert.equal(methods.SetOptions(0x10), 0x80070057 | 0, 'an undefined option is refused');
    methods.GetOptions(OUT);
    assert.equal(d.view.getUint32(OUT, true), OPEN_OPTIONS, 'and the options kept');
    assert.equal(methods.ClearClientData(), 0x80004005 | 0, 'no client to clear');

    assert.equal(methods.Advise(0x4444, OUT), 0);
    const cookie = d.view.getUint32(OUT, true);
    assert.equal(methods.Unadvise(cookie), 0);
    assert.equal(methods.Unadvise(cookie), 0x80070057 | 0);

    assert.equal(methods.Show(0), 0x800704c7 | 0, 'dismissed without a choice');
    d.view.setUint32(OUT, 0xdeadbeef, true);
    assert.equal(methods.GetResult(OUT), 0x8000ffff | 0);
    assert.equal(d.view.getUint32(OUT, true), 0xdeadbeef, 'no result, the pointer untouched');
    assert.equal(methods.GetResult(0), 0x80070057 | 0);
});

test('a file dialog answers its customization under both names, and its browser interfaces',
    ()=>{
        const d = dialogs();
        const { definition } = d.make(CLSID_FILE_OPEN_DIALOG);
        const customize = definition.interfaces.find((/** @type {any} */ i)=>
            i.id === '{E6FDD21A-163F-4975-9C8C-A69F1BA37034}');
        assert.deepEqual(customize.also, ['{8016B7B3-3D49-4504-A0AA-2A37494E606F}'],
            'IFileDialogCustomizeAlt is the same interface');
        for (const id of ['{361BBDC7-E6EE-4E13-BE58-58E2240C810F}',
            '{C8AD25A1-3294-41EE-8165-71174BD01C57}'])
        {
            assert.ok(definition.interfaces.some((/** @type {any} */ i)=>i.id === id), id);
        }
    });

test('a save dialog starts with its own options and answers the save dialog\'s interface', ()=>{
    const d = dialogs();
    const { methods, definition } = d.make(CLSID_FILE_SAVE_DIALOG);
    methods.GetOptions(OUT);
    assert.equal(d.view.getUint32(OUT, true), SAVE_OPTIONS);
    assert.equal(definition.interfaces[0].id, '{84BCCD23-5FDE-4CDB-AEA4-AF64B83D78AB}');
    assert.ok(definition.interfaces.some((/** @type {any} */ i)=>
        i.id === '{42F85136-DB7E-439C-85F1-E4075D135FC8}'), 'and IFileDialog');
});

test('in a 64-bit process COMDLG_FILTERSPEC is two pointers of eight, and a name comes out whole',
    ()=>{
        const d = dialogs(8);
        const { methods, definition } = d.make(CLSID_FILE_OPEN_DIALOG);
        d.view.setBigUint64(SPECS, BigInt(d.wide(TEXT, 'Saves')), true);
        d.view.setBigUint64(SPECS + 8, BigInt(d.wide(TEXT + 0x100, '*.sav')), true);
        d.view.setBigUint64(SPECS + 16, BigInt(d.wide(TEXT + 0x200, 'All')), true);
        d.view.setBigUint64(SPECS + 24, BigInt(d.wide(TEXT + 0x300, '*.*')), true);
        assert.equal(methods.SetFileTypes(2, SPECS), 0);
        assert.deepEqual(definition.state.types, [{ name: 'Saves', spec: '*.sav' },
            { name: 'All', spec: '*.*' }]);
        methods.SetFileName(d.wide(TEXT + 0x400, 'save1.dat'));
        d.view.setBigUint64(OUT, 0xffff_ffff_ffff_ffffn, true);
        assert.equal(methods.GetFileName(OUT), 0);
        assert.equal(d.readWide(Number(d.view.getBigUint64(OUT, true))), 'save1.dat');
    });
