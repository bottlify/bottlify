/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REGSVR32_EXIT, parseRegsvr32, runRegsvr32 } from './regsvr32.js';
import { fakeContext } from './context.fixture.js';

test('the options, in either spelling and any case, and every library named', ()=>{
    assert.deepEqual(parseRegsvr32('/s /u a.dll "C:\\b c\\d.ocx"'), { silent: true,
        unregister: true, install: false, installLine: '', register: true,
        libraries: ['a.dll', 'C:\\b c\\d.ocx'], error: null });
    assert.deepEqual(parseRegsvr32('-S -I:"one two" -N X.DLL'), { silent: true,
        unregister: false, install: true, installLine: 'one two', register: false,
        libraries: ['X.DLL'], error: null });
    assert.equal(parseRegsvr32('/c a.dll').error, null, '/c changes nothing');
    assert.match(String(parseRegsvr32('/n a.dll').error), /\/n must be used with \/i/);
    assert.match(String(parseRegsvr32('/s').error), /No DLL/);
    assert.match(String(parseRegsvr32('/q a.dll').error), /Unrecognized flag/);
});

const MODULE = 0x10000000;
/** @param {Record<string, number>} answers  by export, what calling it answers */
const library = answers=>(/** @type {import('./context.fixture.js').Recorded} */ call)=>{
    if (call.name === 'LoadLibraryExW')
    {
        return MODULE;
    }
    if (call.name === 'GetProcAddress')
    {
        const name = String(call.args?.[1]).replaceAll('"', '');
        return name in answers ? 0x10001000 + Object.keys(answers).indexOf(name) : 0;
    }
    if (call.guest)
    {
        return Object.values(answers)[call.guest - 0x10001000];
    }
    return 0;
};
/** @param {import('./context.fixture.js').Recorded[]} calls */
const sequence = calls=>calls.map(call=>call.message !== undefined ? 'box'
    : call.guest ? `guest ${call.args?.join(',')}` : call.name === 'GetProcAddress'
        ? `find ${call.args?.[1]}` : call.name);

test('register, and with /i install after it; unregister uninstalls first', async()=>{
    const both = fakeContext('regsvr32 /s /i:x a.dll', library({ DllRegisterServer: 0,
        DllInstall: 0 }));
    assert.equal(await runRegsvr32(both.context), REGSVR32_EXIT.SUCCESS);
    assert.deepEqual(sequence(both.calls), ['OleInitialize', 'LoadLibraryExW',
        'find "DllRegisterServer"', 'guest ', 'find "DllInstall"', 'guest 1,L"x"', 'FreeLibrary',
        'OleUninitialize']);
    const undo = fakeContext('regsvr32 /u /i a.dll', library({ DllUnregisterServer: 0,
        DllInstall: 0 }));
    assert.equal(await runRegsvr32(undo.context), REGSVR32_EXIT.SUCCESS);
    assert.deepEqual(sequence(undo.calls), ['OleInitialize', 'LoadLibraryExW',
        'find "DllInstall"', 'guest 0,L""', 'find "DllUnregisterServer"', 'guest ',
        'FreeLibrary', 'box', 'OleUninitialize'], 'and without /s, says it succeeded');
    assert.deepEqual(undo.calls.find(call=>call.message)?.message,
        'DllInstall and DllUnregisterServer in a.dll succeeded.');
    const only = fakeContext('regsvr32 /s /n /i a.dll', library({ DllInstall: 0 }));
    assert.equal(await runRegsvr32(only.context), 0);
    assert.equal(only.calls.filter(call=>call.guest).length, 1, '/n: DllInstall alone');
});

test('each failure has its exit code, and the libraries after it are not tried', async()=>{
    const load = fakeContext('regsvr32 /s a.dll b.dll');
    assert.equal(await runRegsvr32(load.context), REGSVR32_EXIT.FAIL_LOAD);
    assert.equal(load.calls.filter(call=>call.name === 'LoadLibraryExW').length, 1);
    assert.equal(load.calls.at(-1)?.name, 'OleUninitialize', 'OLE is let go whatever happened');
    const entry = fakeContext('regsvr32 /s a.dll', library({}));
    assert.equal(await runRegsvr32(entry.context), REGSVR32_EXIT.FAIL_ENTRY);
    const call = fakeContext('regsvr32 a.dll', library({ DllRegisterServer: 0x80004005 }));
    assert.equal(await runRegsvr32(call.context), REGSVR32_EXIT.FAIL_REG);
    assert.match(String(call.calls.find(each=>each.message)?.message), /0x80004005/);
    const ole = fakeContext('regsvr32 /s a.dll', each=>(each.name === 'OleInitialize'
        ? 0x80004005 : 0));
    assert.equal(await runRegsvr32(ole.context), REGSVR32_EXIT.FAIL_OLE);
    const args = fakeContext('regsvr32 /x a.dll');
    assert.equal(await runRegsvr32(args.context), REGSVR32_EXIT.FAIL_ARGS);
    assert.equal(args.calls.length, 1, 'the usage, shown');
    const silent = fakeContext('regsvr32 /s');
    assert.equal(await runRegsvr32(silent.context), REGSVR32_EXIT.FAIL_ARGS);
    assert.deepEqual(silent.calls, []);
});
