/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNotepad, runNotepad, textOfFile } from './notepad.js';
import { fakeContext } from './context.fixture.js';
import { systemProgramAt } from './table.js';

test('Notepad is in the Windows directory and the system folder, by any spelling', ()=>{
    assert.equal(systemProgramAt('C:\\WINDOWS\\Notepad.exe'), 'notepad');
    assert.equal(systemProgramAt('c:/windows/system32/NOTEPAD.EXE'), 'notepad');
    assert.equal(systemProgramAt('C:\\WINDOWS\\msiexec.exe'), null,
        'msiexec is in the system folder only');
});

test('a Notepad line names the rest of the line, its quotes taken off', ()=>{
    assert.deepEqual(parseNotepad('C:\\Program Files\\Game\\readme.txt'),
        { path: 'C:\\Program Files\\Game\\readme.txt', print: false });
    assert.deepEqual(parseNotepad('"C:\\a b\\readme.txt"'),
        { path: 'C:\\a b\\readme.txt', print: false });
    assert.deepEqual(parseNotepad('/p readme.txt'), { path: 'readme.txt', print: true });
    assert.deepEqual(parseNotepad(''), { path: null, print: false });
});

test('a text file reads in its own encoding, its lines ended CR LF', ()=>{
    assert.equal(textOfFile(Uint8Array.of(0x41, 0x0a, 0x42)), 'A\r\nB');
    assert.equal(textOfFile(Uint8Array.of(0xff, 0xfe, 0x41, 0, 0x0d, 0, 0x0a, 0)), 'A\r\n');
    assert.equal(textOfFile(Uint8Array.of(0xef, 0xbb, 0xbf, 0xc3, 0xa9)), '\u00e9');
});

test('Notepad shows the file in a window of its own and ends when the window goes', async()=>{
    // A setup shows its readme as C:\WINDOWS\Notepad.exe readme.txt; with no
    // Notepad it said it could not display the file.
    const bytes = new TextEncoder().encode('Welcome\nto the demo');
    let windows = 0;
    let alive = 2;
    const { context, calls, memory } = fakeContext(
        'C:\\WINDOWS\\Notepad.exe C:\\Game\\readme.txt', call=>{
            switch (call.name){
                case 'CreateFileW': return 0x44;
                case 'GetFileSize': return bytes.length;
                case 'ReadFile': {
                    const [, buffer, , done] = /** @type {number[]} */ (call.args);
                    memory.set(buffer, bytes);
                    memory.set(done, Uint8Array.of(bytes.length, 0, 0, 0));
                    return 1;
                }
                case 'CreateWindowExW': return 0x100 + 4 * windows++;
                case 'GetClientRect': {
                    memory.set(/** @type {number} */ (call.args?.[1]),
                        new Uint8Array(new Uint32Array([0, 0, 600, 400]).buffer));
                    return 1;
                }
                case 'IsWindow': return alive-- > 0 ? 1 : 0;
                default: return undefined;
            }
        });
    assert.equal(await runNotepad(context), 0);
    const made = calls.filter(call=>call.name === 'CreateWindowExW');
    assert.equal(made[0].args?.[2], 'L"readme.txt - Notepad"', 'titled as Notepad titles it');
    assert.equal(made[1].args?.[1], 'L"EDIT"');
    assert.deepEqual(made[1].args?.slice(6, 8), [600, 400], 'filling the frame\'s client area');
    const text = calls.find(call=>call.name === 'SendMessageW' && call.args?.[1] === 0x000c);
    assert.equal(text?.args?.[3], 'L"Welcome\r\nto the demo"');
    assert.ok(calls.some(call=>call.name === 'CloseHandle'), 'the file closed again');
    assert.equal(calls.filter(call=>call.name === 'IsWindow').length, 3,
        'the loop ran until the window was gone');
});

test('Notepad says a file it cannot find is not there, and opens untitled', async()=>{
    const { context, calls } = fakeContext('notepad missing.txt', call=>
        (call.name === 'CreateFileW' ? 0xffffffff : call.name === 'CreateWindowExW' ? 0x100
            : undefined));
    assert.equal(await runNotepad(context), 0);
    assert.equal(calls.find(call=>call.message)?.message, 'Cannot find the missing.txt file.');
    assert.equal(calls.find(call=>call.name === 'CreateWindowExW')?.args?.[2],
        'L"Untitled - Notepad"');
});
