/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInf } from './inf.js';
import { infNumber, installRegistry } from './registry.js';
import {
    HKEY_CLASSES_ROOT, HKEY_LOCAL_MACHINE, REG_BINARY, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ,
    REG_SZ, createHive,
} from '../advapi32/registry.js';
import { decodeAnsi } from '../kernel32/locale.js';

/**
 * The hive after an install section of an INF is carried out on it.
 *
 * @param {string} text @param {string} section
 * @param {{ hive?: ReturnType<typeof createHive>, relativeRoot?: any }} [options]
 */
function install(text, section, options = {}){
    const hive = options.hive ?? createHive();
    const parsed = parseInf(text);
    assert.ok('inf' in parsed);
    /** @type {string[]} */
    const said = [];
    installRegistry(hive, parsed.inf, /** @type {any} */ (parsed.inf.section(section)),
        { relativeRoot: options.relativeRoot, divergence: detail=>said.push(detail) });
    return { hive, said };
}

/**
 * A value as the hive keeps it: its type and its text, or its bytes.
 *
 * @param {ReturnType<typeof createHive>} hive @param {number} root @param {string} path
 * @param {string} name
 */
function valueOf(hive, root, path, name){
    const key = hive.open(rootOf(hive, root), path);
    const value = key ? hive.getValue(key, name) : null;
    if (!value)
    {
        return null;
    }
    const text = [REG_SZ, REG_EXPAND_SZ, REG_MULTI_SZ].includes(value.type)
        ? decodeAnsi(value.data) : [...value.data];
    return { type: value.type, text };
}

const SIGNATURE = '[Version]\nSignature="$Chicago$"\n';

/** A root key, as the hive always has one. @param {ReturnType<typeof createHive>} hive @param {number} id */
const rootOf = (hive, id)=>/** @type {any} */ (hive.root(id));

test('AddReg writes a string to the default value or a named one, and makes the key alone'
    + ' when told to', ()=>{
    const { hive } = install(`${SIGNATURE}[Install]\nAddReg=Server\n[Server]
HKCR,CLSID\\%CLSID%,,,"%NAME%"
HKCR,CLSID\\%CLSID%\\InProcServer32,,0x00020000,%SystemRoot%\\system32\\x.dll
HKCR,CLSID\\%CLSID%\\InProcServer32,"ThreadingModel",,"Apartment"
HKCR,CLSID\\%CLSID%\\Implemented,,0x10
HKCR,CLSID\\%CLSID%\\Empty
[Strings]
CLSID="{01234567-89ab-cdef-0123-456789abcdef}"
NAME="A Server"
`, 'Install');
    const clsid = 'CLSID\\{01234567-89ab-cdef-0123-456789abcdef}';
    assert.deepEqual(valueOf(hive, HKEY_CLASSES_ROOT, clsid, ''),
        { type: REG_SZ, text: 'A Server\0' });
    assert.deepEqual(valueOf(hive, HKEY_CLASSES_ROOT, `${clsid}\\InProcServer32`, ''),
        { type: REG_EXPAND_SZ, text: '%SystemRoot%\\system32\\x.dll\0' },
        'FLG_ADDREG_TYPE_EXPAND_SZ, and a name nothing defines left as written');
    assert.deepEqual(valueOf(hive, HKEY_CLASSES_ROOT, `${clsid}\\InProcServer32`,
        'ThreadingModel'), { type: REG_SZ, text: 'Apartment\0' });
    const keyOnly = hive.open(rootOf(hive, HKEY_CLASSES_ROOT), `${clsid}\\Implemented`);
    assert.ok(keyOnly, 'FLG_ADDREG_KEYONLY makes the key');
    assert.deepEqual(hive.values(keyOnly), [], 'and sets nothing in it');
    assert.deepEqual(valueOf(hive, HKEY_CLASSES_ROOT, `${clsid}\\Empty`, ''),
        { type: REG_SZ, text: '\0' }, 'a line with no value sets an empty default');
});

test('AddReg writes numbers, bytes and lists by their flags', ()=>{
    const { hive } = install(`${SIGNATURE}[Install]\nAddReg=Values\n[Values]
HKLM,Software\\T,Count,0x00010001,0x2a
HKLM,Software\\T,Bytes,1,de,ad,0B
HKLM,Software\\T,Dword4,0x00010001,01,02,03,04
HKLM,Software\\T,List,0x00010000,one,two
HKLM,Software\\T,List,0x00010008,two,three
HKLM,Software\\T,Octal,0x00010001,010
`, 'Install');
    assert.deepEqual(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'Count'),
        { type: REG_DWORD, text: [0x2a, 0, 0, 0] });
    assert.deepEqual(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'Bytes'),
        { type: REG_BINARY, text: [0xde, 0xad, 0x0b] });
    assert.deepEqual(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'Dword4'),
        { type: REG_DWORD, text: [1, 2, 3, 4] }, 'a DWORD given as bytes is those bytes');
    assert.deepEqual(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'List'),
        { type: REG_MULTI_SZ, text: 'one\0two\0three\0\0' },
        'FLG_ADDREG_APPEND adds only what the list lacks');
    assert.deepEqual(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'Octal'),
        { type: REG_DWORD, text: [8, 0, 0, 0] }, 'a number read as strtoul reads it');
});

test('NOCLOBBER keeps a value that exists, OVERWRITEONLY sets only one that does', ()=>{
    const hive = createHive();
    install(`${SIGNATURE}[Install]\nAddReg=First\n[First]
HKLM,Software\\T,Kept,,"old"
HKLM,Software\\T,Replaced,,"old"
`, 'Install', { hive });
    install(`${SIGNATURE}[Install]\nAddReg=Second\n[Second]
HKLM,Software\\T,Kept,2,"new"
HKLM,Software\\T,Replaced,0x20,"new"
HKLM,Software\\T,Absent,0x20,"new"
HKLM,Software\\None,Absent,0x20,"new"
`, 'Install', { hive });
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'Kept')?.text, 'old\0');
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'Replaced')?.text, 'new\0');
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\T', 'Absent'), null);
    assert.equal(hive.open(rootOf(hive, HKEY_LOCAL_MACHINE), 'Software\\None'), null,
        'nor is a key made for it');
});

test('DelReg deletes a value, a whole key, or a string from a list, before AddReg runs', ()=>{
    const hive = createHive();
    install(`${SIGNATURE}[Install]\nAddReg=Old\n[Old]
HKCR,Old\\Deep\\Deeper,,,"x"
HKCR,Old,Gone,,"x"
HKCR,Keep,Stays,,"x"
HKCR,Keep,Gone,,"x"
HKCR,Keep,List,0x00010000,a,b,c
`, 'Install', { hive });
    install(`${SIGNATURE}[Install]\nDelReg=Clean\nAddReg=New\n[Clean]
HKCR,Old
HKCR,Keep,Gone
HKCR,Keep,List,0x00018002,b
HKCR,Missing\\Key
HKCR,Keep,Again
[New]
HKCR,Keep,Again,,"added"
`, 'Install', { hive });
    assert.equal(hive.open(rootOf(hive, HKEY_CLASSES_ROOT), 'Old'), null,
        'a key named without a value goes, subkeys and all');
    assert.equal(valueOf(hive, HKEY_CLASSES_ROOT, 'Keep', 'Gone'), null);
    assert.equal(valueOf(hive, HKEY_CLASSES_ROOT, 'Keep', 'Stays')?.text, 'x\0');
    assert.equal(valueOf(hive, HKEY_CLASSES_ROOT, 'Keep', 'List')?.text, 'a\0c\0\0');
    assert.equal(valueOf(hive, HKEY_CLASSES_ROOT, 'Keep', 'Again')?.text, 'added\0',
        'deleted first and added after, whatever order the section names them in');
});

test('HKR is the key the caller names, and a root the install has none of is said', ()=>{
    const hive = createHive();
    const relative = hive.create(rootOf(hive, HKEY_LOCAL_MACHINE), 'Software\\Relative').key;
    const { said } = install(`${SIGNATURE}[Install]\nAddReg=Rel\n[Rel]
HKR,Sub,Value,,"here"
HKXX,Sub,Value,,"nowhere"
`, 'Install', { hive, relativeRoot: relative });
    assert.equal(valueOf(hive, HKEY_LOCAL_MACHINE, 'Software\\Relative\\Sub', 'Value')?.text,
        'here\0');
    assert.equal(said.length, 1);
    assert.match(said[0], /HKXX/);
});

test('a number is read as strtoul reads it with base 0', ()=>{
    assert.deepEqual(['0x20', '32', '040', '', 'junk', '0x', '-1', '7x'].map(infNumber),
        [32, 32, 32, 0, 0, 0, 0xffffffff, 7]);
});
