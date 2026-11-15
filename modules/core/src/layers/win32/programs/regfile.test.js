/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { importRegEntries, parseRegFile } from './regfile.js';
import { parseRegedit, runRegedit } from './regedit.js';
import { parseReg, runReg } from './reg.js';
import { fakeContext } from './context.fixture.js';

/** @param {string} text */
const wide = text=>[...text].flatMap(char=>[char.charCodeAt(0) & 0xff, char.charCodeAt(0) >> 8]);

test('a version 5 file: keys made and removed, each kind of value, a value removed', ()=>{
    const read = parseRegFile([
        'Windows Registry Editor Version 5.00',
        '',
        '; a comment',
        '[HKEY_CURRENT_USER\\Software\\Vendor\\Game]',
        '"Name"="A \\"quoted\\" C:\\\\path"',
        '@="default"',
        '"Count"=dword:0000002a',
        '"Data"=hex:01,02,\\',
        '  ff',
        '"Path"=hex(2):25,00,00,00',
        '"Gone"=-',
        '[-HKEY_LOCAL_MACHINE\\SOFTWARE\\Old]',
        '[HKEY_NOWHERE\\X]',
        '"Skipped"="under no root"',
    ].join('\r\n'));
    assert.ok(!('error' in read));
    assert.deepEqual(read.entries.map(entry=>entry.kind === 'key'
        ? ['key', entry.root, entry.path, entry.remove]
        : ['value', entry.name, entry.type, entry.data && [...entry.data]]), [
        ['key', 0x80000001, 'Software\\Vendor\\Game', false],
        ['value', 'Name', 1, [...wide('A "quoted" C:\\path'), 0, 0]],
        ['value', '', 1, [...wide('default'), 0, 0]],
        ['value', 'Count', 4, [0x2a, 0, 0, 0]],
        ['value', 'Data', 3, [1, 2, 0xff]],
        ['value', 'Path', 2, [0x25, 0, 0, 0]],
        ['value', 'Gone', 0, null],
        ['key', 0x80000002, 'SOFTWARE\\Old', true],
    ]);
});

test('a REGEDIT4 file\'s string bytes are ANSI, stored as UTF-16; anything else is not one', ()=>{
    const read = parseRegFile('REGEDIT4\n[HKCU\\A]\n"E"=hex(2):25,41,25,00\n');
    assert.ok(!('error' in read));
    const [, value] = read.entries;
    assert.deepEqual(value.kind === 'value' && value.data && [...value.data],
        [...wide('%A%'), 0, 0]);
    assert.ok('error' in parseRegFile('[HKCU\\A]\n"x"="y"\n'), 'no version line');
});

test('an import writes in order, and a key that was never there is no error', async()=>{
    const read = parseRegFile('REGEDIT4\n[HKCU\\A]\n"x"=dword:1\n"y"=-\n[-HKCU\\B]\n');
    assert.ok(!('error' in read));
    /** @type {Map<number, Uint8Array>} */
    let written = new Map();
    const { context, calls, memory } = fakeContext('regedit', call=>{
        if (call.name === 'RegCreateKeyExW')
        {
            written.set(/** @type {number} */ (call.args?.[7]), Uint8Array.of(0x40, 0, 0, 0));
        }
        return call.name === 'RegDeleteValueW' || call.name === 'RegDeleteTreeW' ? 2 : 0;
    });
    written = memory;
    assert.equal(await importRegEntries(context, read.entries), 0);
    assert.deepEqual(calls.map(call=>call.name), ['RegCreateKeyExW', 'RegSetValueExW',
        'RegDeleteValueW', 'RegCloseKey', 'RegDeleteTreeW']);
    assert.equal(calls[0].args?.[1], 'L"A"');
});

test('regedit /s imports quietly; without /s it asks and tells; no file is not an editor', async()=>{
    assert.deepEqual(parseRegedit('/S "C:\\a b.reg" /e'),
        { silent: true, files: ['C:\\a b.reg'], unknown: ['/e'] });
    const file = Uint8Array.from([...'REGEDIT4\r\n[HKCU\\A]\r\n"x"="1"\r\n']
        .map(c=>c.charCodeAt(0)));
    /** @param {boolean} yes */
    const answering = yes=>(/** @type {any} */ call)=>{
        switch (call.name)
        {
            case 'CreateFileW': return 4;
            case 'GetFileSize': return file.length;
            case 'ReadFile': return 1;
            default: return call.message?.startsWith('Adding') ? (yes ? 6 : 7) : 0;
        }
    };
    /** @param {string} line @param {boolean} yes */
    const run = async(line, yes)=>{
        /** @type {Map<number, Uint8Array>} */
        let written = new Map();
        const answer = answering(yes);
        const { context, calls, memory } = fakeContext(line, call=>{
            if (call.name === 'RegCreateKeyExW')
            {
                written.set(/** @type {number} */ (call.args?.[7]), Uint8Array.of(0x40, 0, 0, 0));
            }
            return answer(call);
        });
        written = memory;
        const read = context.read;
        // ReadFile's buffer holds the file and its count says how much.
        context.read = (at, length)=>(length === file.length ? file
            : length === 4 && calls.at(-1)?.name === 'ReadFile'
                ? Uint8Array.of(file.length, 0, 0, 0)
                : read(at, length));
        assert.equal(await runRegedit(context), 0);
        return { calls, memory };
    };
    const silent = await run('regedit /s x.reg', true);
    assert.ok(silent.calls.some(call=>call.name === 'RegSetValueExW'));
    assert.ok(!silent.calls.some(call=>call.message !== undefined), 'nothing shown');
    const asked = await run('regedit x.reg', true);
    assert.deepEqual(asked.calls.filter(call=>call.message !== undefined)
        .map(call=>call.message?.slice(0, 16)), ['Adding informati', 'The keys and val']);
    const declined = await run('regedit x.reg', false);
    assert.ok(!declined.calls.some(call=>call.name === 'RegSetValueExW'), 'No leaves it');
    const editor = await run('regedit', true);
    assert.deepEqual(editor.calls.map(call=>call.message), ['The Registry Editor is not shown'
        + ' on this machine.']);
});

test('reg import reads the file the same way, and takes exactly one', async()=>{
    assert.deepEqual(parseReg('IMPORT "C:\\x.reg"'), { operation: 'import', file: 'C:\\x.reg' });
    assert.ok('error' in parseReg('import'));
    assert.ok('error' in parseReg('import a.reg b.reg'));
    const { context, calls } = fakeContext('reg import missing.reg',
        call=>(call.name === 'CreateFileW' ? 0xffffffff : 0));
    assert.equal(await runReg(context), 1, 'a file that cannot be opened');
    assert.ok(!calls.some(call=>call.name === 'RegCreateKeyExW'));
});
