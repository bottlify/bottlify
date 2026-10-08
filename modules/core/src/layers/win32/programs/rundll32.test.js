/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRundll32, runRundll32 } from './rundll32.js';
import { fakeContext } from './context.fixture.js';

test('a library and its entry, by comma or by a blank, and the rest of the line as typed', ()=>{
    assert.deepEqual(parseRundll32('shell32.dll,Control_RunDLL desk.cpl'),
        { library: 'shell32.dll', entry: 'Control_RunDLL', commandLine: 'desk.cpl' });
    assert.deepEqual(parseRundll32('setupapi,InstallHinfSection DefaultInstall 132 C:\\x\\a.inf'),
        { library: 'setupapi', entry: 'InstallHinfSection',
            commandLine: 'DefaultInstall 132 C:\\x\\a.inf' });
    assert.deepEqual(parseRundll32('"C:\\a b\\x,y.dll",Entry  one "two  three"'),
        { library: 'C:\\a b\\x,y.dll', entry: 'Entry', commandLine: 'one "two  three"' },
        'a comma inside the quotes is the path\'s');
    assert.deepEqual(parseRundll32('x.dll Entry rest'),
        { library: 'x.dll', entry: 'Entry', commandLine: 'rest' });
    assert.deepEqual(parseRundll32('x.dll, Entry rest'),
        { library: 'x.dll', entry: 'Entry', commandLine: 'rest' });
    assert.deepEqual(parseRundll32('x.dll,#12'),
        { library: 'x.dll', entry: '#12', commandLine: '' });
    assert.deepEqual(parseRundll32('x.dll'), { library: 'x.dll', entry: '', commandLine: '' });
    assert.equal(parseRundll32('   '), null);
});

const MODULE = 0x10000000;

test('the entry is asked for as EntryW first, handed the line as UTF-16, on a window of its own',
    async()=>{
        const run = fakeContext('rundll32.exe x.dll,Entry a b', call=>(
            call.name === 'LoadLibraryW' ? MODULE
                : call.name === 'GetProcAddress' && call.args?.[1] === '"EntryW"' ? 0x10001000
                    : call.name === 'CreateWindowExW' ? 0x1234 : 0));
        assert.equal(await runRundll32(run.context), 0);
        assert.deepEqual(run.calls.map(call=>call.name ?? 'guest'), ['LoadLibraryW',
            'GetProcAddress', 'CreateWindowExW', 'guest', 'DestroyWindow', 'FreeLibrary']);
        assert.deepEqual(run.calls[3], { guest: 0x10001000,
            args: [0x1234, MODULE, 'L"a b"', 10] }, 'HWND, HINSTANCE, the line, SW_SHOWDEFAULT');
    });

test('then EntryA, then Entry, each handed the line in the ANSI code page', async()=>{
    /** @param {string} found */
    const run = async found=>{
        const each = fakeContext('rundll32 x.dll,Entry text', call=>(
            call.name === 'LoadLibraryW' ? MODULE
                : call.name === 'GetProcAddress' && call.args?.[1] === found ? 0x10002000 : 0));
        await runRundll32(each.context);
        return [each.calls.filter(call=>call.name === 'GetProcAddress').map(call=>call.args?.[1]),
            each.calls.find(call=>call.guest)?.args?.[2]];
    };
    assert.deepEqual(await run('"EntryA"'), [['"EntryW"', '"EntryA"'], '"text"']);
    assert.deepEqual(await run('"Entry"'), [['"EntryW"', '"EntryA"', '"Entry"'], '"text"']);
    const ordinal = fakeContext('rundll32 x.dll,#7', call=>(call.name === 'LoadLibraryW'
        ? MODULE : call.name === 'GetProcAddress' ? 0x10003000 : 0));
    await runRundll32(ordinal.context);
    assert.deepEqual(ordinal.calls.find(call=>call.name === 'GetProcAddress')?.args, [MODULE, 7],
        'an ordinal asked for by number');
});

test('a library or an entry that is not there is said in a box, and the program exits 0',
    async()=>{
        const missing = fakeContext('rundll32 none.dll,Entry');
        assert.equal(await runRundll32(missing.context), 0);
        assert.match(String(missing.calls.at(-1)?.message), /none\.dll/);
        const entry = fakeContext('rundll32 x.dll,Nope', call=>(call.name === 'LoadLibraryW'
            ? MODULE : 0));
        assert.equal(await runRundll32(entry.context), 0);
        assert.deepEqual(entry.calls.slice(-2).map(call=>call.message ?? call.name),
            ['Error in x.dll\nMissing entry:Nope', 'FreeLibrary']);
        const nothing = fakeContext('rundll32');
        assert.equal(await runRundll32(nothing.context), 0);
        assert.deepEqual(nothing.calls, []);
    });
