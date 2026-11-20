/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_WOW64_32KEY, KEY_WOW64_64KEY, inView, wow64Hive } from './wow64-registry.js';
import {
    HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, createHive,
} from './registry.js';

/** @param {number} root @param {string} path @param {32 | 64} view */
const seen = (root, path, view)=>inView(root, path.split('\\'), view).join('\\');

test('a 32-bit view has HKLM\\SOFTWARE under Wow6432Node, but for the keys both widths share',
    ()=>{
        assert.equal(seen(HKEY_LOCAL_MACHINE, 'SOFTWARE\\Vendor\\App', 32),
            'SOFTWARE\\Wow6432Node\\Vendor\\App');
        assert.equal(seen(HKEY_LOCAL_MACHINE, 'SOFTWARE', 32), 'SOFTWARE\\Wow6432Node');
        assert.equal(seen(HKEY_LOCAL_MACHINE, 'SOFTWARE\\Vendor\\App', 64),
            'SOFTWARE\\Vendor\\App');
        assert.equal(seen(HKEY_LOCAL_MACHINE, 'SOFTWARE\\Wow6432Node\\Vendor', 64),
            'SOFTWARE\\Vendor',
            'the node itself is the 32-bit view, whichever view names it');
        assert.equal(seen(HKEY_LOCAL_MACHINE,
            'Software\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-18', 32),
        'Software\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\S-1-5-18', 'shared');
        assert.equal(seen(HKEY_LOCAL_MACHINE, 'SOFTWARE\\Policies\\Vendor', 32),
            'SOFTWARE\\Policies\\Vendor');
        assert.equal(seen(HKEY_LOCAL_MACHINE,
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\App', 32),
        'SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\App');
        assert.equal(seen(HKEY_LOCAL_MACHINE, 'SYSTEM\\CurrentControlSet', 32),
            'SYSTEM\\CurrentControlSet', 'only SOFTWARE is redirected');
        assert.equal(seen(HKEY_CURRENT_USER, 'Software\\Vendor', 32), 'Software\\Vendor',
            'nor the user\'s, but for the classes');
    });

test('the classes have a 32-bit view of CLSID, Interface and three more alone', ()=>{
    const clsid = 'CLSID\\{00000000-0000-0000-0000-000000000001}\\InprocServer32';
    assert.equal(seen(HKEY_CLASSES_ROOT, clsid, 32), `Wow6432Node\\${clsid}`);
    assert.equal(seen(HKEY_CLASSES_ROOT, clsid, 64), clsid);
    assert.equal(seen(HKEY_CLASSES_ROOT, 'Interface\\{X}', 32), 'Wow6432Node\\Interface\\{X}');
    assert.equal(seen(HKEY_CLASSES_ROOT, '.txt', 32), '.txt', 'an extension is one for both');
    assert.equal(seen(HKEY_CLASSES_ROOT, 'Vendor.Object\\CLSID', 32), 'Vendor.Object\\CLSID',
        'a ProgID too');
    assert.equal(seen(HKEY_LOCAL_MACHINE, `SOFTWARE\\Classes\\${clsid}`, 32),
        `SOFTWARE\\Classes\\Wow6432Node\\${clsid}`);
    assert.equal(seen(HKEY_LOCAL_MACHINE, `SOFTWARE\\Wow6432Node\\Classes\\${clsid}`, 32),
        `SOFTWARE\\Classes\\Wow6432Node\\${clsid}`, 'reached through the 32-bit SOFTWARE');
    assert.equal(seen(HKEY_CURRENT_USER, `Software\\Classes\\${clsid}`, 32),
        `Software\\Classes\\Wow6432Node\\${clsid}`);
});

test('a process\'s view keeps a key\'s place, takes KEY_WOW64_* per call, and leaves the rest'
    + ' to the hive', ()=>{
    const hive = createHive();
    const narrow = wow64Hive(hive, 32);
    const machine = narrow.root(HKEY_LOCAL_MACHINE);
    const made = narrow.create(machine, 'SOFTWARE\\Vendor').key;
    narrow.setValue(made, 'Width', 1, new Uint8Array([0x33, 0, 0, 0]));
    const raw = /** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE));
    assert.ok(hive.open(raw, 'SOFTWARE\\Wow6432Node\\Vendor'), 'made under the node');
    assert.equal(hive.open(raw, 'SOFTWARE\\Vendor'), null, 'not in the 64-bit view');

    const software = narrow.open(machine, 'SOFTWARE');
    assert.equal(narrow.open(software, 'Vendor'), made, 'a key under a key the view reached');
    assert.equal(narrow.open(machine, 'SOFTWARE\\Vendor', KEY_WOW64_64KEY), null,
        'KEY_WOW64_64KEY names the other view');
    const wide = wow64Hive(hive, 64);
    assert.equal(wide.open(wide.root(HKEY_LOCAL_MACHINE), 'SOFTWARE\\Vendor', KEY_WOW64_32KEY),
        made, 'and a 64-bit process reaches the 32-bit one so');
    assert.equal(narrow.remove(machine, 'SOFTWARE\\Vendor'), 'deleted', 'removed where it is');
    assert.equal(hive.open(raw, 'SOFTWARE\\Wow6432Node\\Vendor'), null);
});

test('a 64-bit Windows has its machine keys in both views: a 32-bit process finds the classes'
    + ' the system serves and the version keys', ()=>{
    const narrow = wow64Hive(createHive({ machine64: true }), 32);
    const machine = narrow.root(HKEY_LOCAL_MACHINE);
    const classes = narrow.root(HKEY_CLASSES_ROOT);
    assert.ok(narrow.open(classes,
        'CLSID\\{47D4D946-62E8-11CF-93BC-444553540000}\\InprocServer32'),
    'DirectSound\'s class, under Classes\\Wow6432Node');
    assert.ok(narrow.open(machine, 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion'));
    const raw = createHive({ machine64: true });
    assert.ok(raw.open(/** @type {any} */ (raw.root(HKEY_LOCAL_MACHINE)),
        'SOFTWARE\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion'));
    const plain = createHive();
    assert.equal(plain.open(/** @type {any} */ (plain.root(HKEY_LOCAL_MACHINE)),
        'SOFTWARE\\Wow6432Node'), null, 'a 32-bit Windows has one view');
});

test('each view\'s CurrentVersion names its own program folder, and both widths\'', ()=>{
    const hive = createHive({ machine64: true });
    /** @param {32 | 64} width @param {string} name */
    const value = (width, name)=>{
        const view = wow64Hive(hive, width);
        const key = view.open(view.root(HKEY_LOCAL_MACHINE),
            'SOFTWARE\\Microsoft\\Windows\\CurrentVersion');
        const found = view.getValue(key, name);
        return found ? new TextDecoder('latin1').decode(found.data).replace(/\0.*$/, '') : null;
    };
    assert.equal(value(32, 'ProgramFilesDir'), 'C:\\Program Files (x86)');
    assert.equal(value(64, 'ProgramFilesDir'), 'C:\\Program Files');
    for (const width of /** @type {(32 | 64)[]} */ ([32, 64]))
    {
        assert.equal(value(width, 'ProgramFilesDir (x86)'), 'C:\\Program Files (x86)');
        assert.equal(value(width, 'ProgramW6432Dir'), 'C:\\Program Files');
    }
});
