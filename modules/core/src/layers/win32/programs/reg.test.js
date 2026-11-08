/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REG_TYPES, parseReg, shownValue, valueBytes } from './reg.js';

test('the operation, the key by either name of its root, and the options in any case', ()=>{
    const add = parseReg('ADD "HKCU\\Software\\A B" /V Name /t reg_dword /D 0x10 -f /reg:32');
    assert.ok(!('error' in add));
    assert.deepEqual({ ...add }, { operation: 'add', root: 0x80000001, path: 'Software\\A B',
        keyName: 'HKEY_CURRENT_USER\\Software\\A B', value: 'Name', allValues: false,
        type: REG_TYPES.REG_DWORD, separator: '\\0', data: '0x10', force: true, recurse: false,
        view: 0x200 });
    const remove = parseReg('DELETE "HKEY_LOCAL_MACHINE\\SOFTWARE\\Futuremark\\Futuremark'
        + ' SystemInfo" /f');
    assert.ok(!('error' in remove));
    assert.equal(remove.root, 0x80000002);
    assert.equal(remove.path, 'SOFTWARE\\Futuremark\\Futuremark SystemInfo');
    assert.equal(remove.value, null, 'the whole key');
    const query = parseReg('query HKLM\\SOFTWARE\\ /ve /s');
    assert.ok(!('error' in query));
    assert.equal(query.path, 'SOFTWARE', 'a trailing backslash is not part of the name');
    assert.deepEqual([query.value, query.recurse], ['', true]);
});

test('what reg refuses: no operation, no key, a remote or unknown root, an option twice', ()=>{
    for (const line of ['', 'copy HKCU\\A HKCU\\B', 'add', 'add HKXX\\A',
        'add \\\\machine\\HKLM\\A', 'delete HKLM', 'add HKCU\\A /v', 'add HKCU\\A /v a /ve',
        'delete HKCU\\A /s', 'query HKCU\\A /f text', 'add HKCU\\A /t REG_TEXT',
        'add HKCU\\A stray'])
    {
        assert.ok('error' in parseReg(line), line);
    }
});

test('/d as each type stores it, and as a query shows it back', ()=>{
    const sz = /** @type {Uint8Array} */ (valueBytes(REG_TYPES.REG_SZ, 'ab', '\\0'));
    assert.deepEqual([...sz], [0x61, 0, 0x62, 0, 0, 0]);
    assert.equal(shownValue(REG_TYPES.REG_SZ, sz), 'ab');
    const multi = /** @type {Uint8Array} */ (valueBytes(REG_TYPES.REG_MULTI_SZ, 'a#b', '#'));
    assert.deepEqual([...multi], [0x61, 0, 0, 0, 0x62, 0, 0, 0, 0, 0]);
    assert.equal(shownValue(REG_TYPES.REG_MULTI_SZ, multi), 'a\\0b');
    const dword = /** @type {Uint8Array} */ (valueBytes(REG_TYPES.REG_DWORD, '0x10', ''));
    assert.deepEqual([...dword], [0x10, 0, 0, 0]);
    assert.equal(shownValue(REG_TYPES.REG_DWORD, dword), '0x10');
    assert.deepEqual([...valueBytes(REG_TYPES.REG_DWORD, '258', '') ?? []], [2, 1, 0, 0]);
    assert.deepEqual([...valueBytes(REG_TYPES.REG_DWORD_BIG_ENDIAN, '1', '') ?? []], [0, 0, 0, 1]);
    const qword = /** @type {Uint8Array} */ (valueBytes(REG_TYPES.REG_QWORD, '0x100000000', ''));
    assert.equal(shownValue(REG_TYPES.REG_QWORD, qword), '0x100000000');
    const binary = /** @type {Uint8Array} */ (valueBytes(REG_TYPES.REG_BINARY, '0aFF', ''));
    assert.deepEqual([...binary], [10, 255]);
    assert.equal(shownValue(REG_TYPES.REG_BINARY, binary), '0AFF');
    assert.equal(valueBytes(REG_TYPES.REG_DWORD, 'ten', ''), null);
    assert.equal(valueBytes(REG_TYPES.REG_DWORD, '0x100000000', ''), null, 'past 32 bits');
    assert.equal(valueBytes(REG_TYPES.REG_BINARY, 'abc', ''), null, 'half a byte');
});
