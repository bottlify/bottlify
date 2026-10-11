/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleIoFunctions } from './consoleio.js';

function setup(){
    const bytes = new Uint8Array(0x1000);
    /** @type {{ handle: number, text: string }[]} */
    const written = [];
    /** @type {number[]} */
    const errors = [];
    const fns = createConsoleIoFunctions({
        readMemory: (address, length)=>bytes.slice(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        setLastError: code=>{
            errors.push(code);
        },
        write: (handle, text)=>{
            written.push({ handle, text });
        },
    });
    return { fns, bytes, written, errors };
}

/** @param {Uint8Array} bytes @param {number} at */
const dword = (bytes, at)=>
    (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

test('there is no console, and the mode query says so rather than inventing one', ()=>{
    // A runtime calls this to decide whether to line-buffer, and a game calls it
    // to find out whether it was launched from a console with a debugger. A
    // fabricated yes changes both.
    const { fns, bytes, errors } = setup();
    bytes.set([0xaa, 0xaa, 0xaa, 0xaa], 0x100);

    assert.equal(fns.GetConsoleMode.handler(), 0);
    assert.equal(dword(bytes, 0x100), 0xaaaaaaaa,
        'and the mode is left as the caller had it, not overwritten');
    assert.equal(errors.at(-1), 6);
    assert.equal(fns.SetConsoleMode.handler(), 0);
});

test('a wide write reads twice the bytes for the same count', ()=>{
    // Both forms take a character count, not a byte count. Reading it as bytes
    // truncates every wide write to half its length.
    const { fns, bytes, written } = setup();
    for (const [at, character] of [...'Hi'].entries())
    {
        bytes[0x200 + at * 2] = character.charCodeAt(0);
        bytes[0x200 + at * 2 + 1] = 0;
    }
    bytes[0x300] = 'H'.charCodeAt(0);
    bytes[0x301] = 'i'.charCodeAt(0);

    fns.WriteConsoleW.handler([2, 0x200, 2, 0x400, 0]);
    fns.WriteConsoleA.handler([2, 0x300, 2, 0x404, 0]);

    assert.deepEqual(written.map(entry=>entry.text), ['Hi', 'Hi']);
    assert.equal(dword(bytes, 0x400), 2, 'and the count reported is in characters');
    assert.equal(dword(bytes, 0x404), 2);
});

test('an ANSI write is read in the page the console reports, as WriteFile\'s is', ()=>{
    // The console's page is 1252, where 0x80 is the euro sign, 0x99 the trade
    // mark and 0x97 an em dash; the same bytes written through WriteFile to
    // the console reach it as those characters, and so do they here.
    const { fns, bytes, written } = setup();
    bytes.set([0x80, 0x99, 0x97, 0xe9], 0x300);
    fns.WriteConsoleA.handler([2, 0x300, 4, 0x404, 0]);
    assert.deepEqual(written.map(entry=>entry.text), ['€™—é']);
    assert.equal(fns.GetConsoleOutputCP.handler(), 1252);
});

test('reading reports end of input rather than blocking on a queue nothing fills', ()=>{
    const { fns, bytes } = setup();
    bytes.set([9, 0, 0, 0], 0x100);

    assert.equal(fns.ReadConsoleA.handler([1, 0x200, 16, 0x100, 0]), 1);
    assert.equal(dword(bytes, 0x100), 0);

    assert.equal(fns.ReadConsoleInputA.handler([1, 0x200, 4, 0x104]), 1);
    assert.equal(dword(bytes, 0x104), 0);
    assert.equal(fns.PeekConsoleInputA.handler([1, 0x200, 4, 0x108]), 1);
    assert.equal(dword(bytes, 0x108), 0);
});

test('the input queue is empty and says how empty', ()=>{
    const { fns, bytes } = setup();
    bytes.set([7, 0, 0, 0], 0x100);
    assert.equal(fns.GetNumberOfConsoleInputEvents.handler([1, 0x100]), 1);
    assert.equal(dword(bytes, 0x100), 0);
    assert.equal(fns.GetNumberOfConsoleInputEvents.handler([1, 0]), 0);
});

test('a control handler is accepted, because none of what it waits for can happen', ()=>{
    const { fns } = setup();
    assert.equal(fns.SetConsoleCtrlHandler.handler(), 1);
});

test('no console is made, none is a screen buffer, and the one page is the one taken', ()=>{
    // Wine's kernel32 process.c test_Console frees and allocates one, then
    // asks the screen buffer and sets the pages; the three were missing.
    const { fns, errors } = setup();
    assert.equal(fns.FreeConsole.handler(), 1, 'leaving none is done');
    assert.equal(fns.AllocConsole.handler(), 0);
    assert.equal(errors.at(-1), 5, 'ERROR_ACCESS_DENIED');
    assert.equal(fns.GetConsoleScreenBufferInfo.handler(), 0);
    assert.equal(errors.at(-1), 6);
    assert.equal(fns.SetConsoleCursorPosition.handler(), 0);
    assert.equal(fns.SetConsoleCursorPosition.argBytes, 8, 'a handle and a COORD by value');
    assert.equal(fns.SetConsoleCP.handler([0]), 0);
    assert.equal(fns.SetConsoleOutputCP.handler([0]), 0);
    assert.deepEqual(errors.slice(-2), [87, 87]);
    assert.equal(fns.SetConsoleCP.handler([1252]), 1);
    assert.equal(fns.SetConsoleOutputCP.handler([1252]), 1);
    assert.deepEqual([fns.SetConsoleCP.argBytes, fns.GetConsoleScreenBufferInfo.argBytes,
        fns.AllocConsole.argBytes], [4, 8, 0]);
});

test('no console is attached, because no process has one', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.AttachConsole.handler(), 0);
    assert.equal(errors.at(-1), 6, 'ERROR_INVALID_HANDLE');
    assert.equal(fns.AttachConsole.argBytes, 4);
});

test('the screen buffer\'s calls and writing input are refused as for a handle that is no console',
    ()=>{
        /** @type {string[]} */
        const said = [];
        const { fns: typed, errors } = setup();
        const fns = /** @type {any} */ (typed);
        const withSay = /** @type {any} */ (createConsoleIoFunctions({
            readMemory: ()=>new Uint8Array(0),
            writeMemory: ()=>{},
            setLastError: code=>errors.push(code),
            write: ()=>{},
            divergence: api=>said.push(api),
        }));
        /** @type {[string, number][]} */
        const cases = [
            ['WriteConsoleInputA', 16], ['WriteConsoleInputW', 16],
            ['ReadConsoleOutputCharacterA', 20], ['ReadConsoleOutputCharacterW', 20],
            ['SetConsoleScreenBufferSize', 8], ['SetConsoleTextAttribute', 8],
            ['SetConsoleWindowInfo', 12], ['GetLargestConsoleWindowSize', 4],
            ['SetConsoleTitleA', 4], ['SetConsoleTitleW', 4],
            ['GetConsoleTitleA', 8], ['GetConsoleTitleW', 8],
            ['WriteConsoleOutputCharacterA', 20], ['WriteConsoleOutputCharacterW', 20],
        ];
        for (const [name, argBytes] of cases)
        {
            assert.equal(fns[name].argBytes, argBytes, name);
            assert.equal(fns[name].handler([7, 0x100, 1, 0, 0x200]), 0, name);
            assert.equal(errors.at(-1), 6, `${name}: ERROR_INVALID_HANDLE`);
            withSay[name].handler([]);
            withSay[name].handler([]);
        }
        assert.equal(said.length, cases.length, 'each said once');
    });

test('flushing the console input succeeds: the queue the reads find empty stays empty', ()=>{
    const { fns: typed, errors } = setup();
    const fns = /** @type {any} */ (typed);
    assert.equal(fns.FlushConsoleInputBuffer.argBytes, 4);
    assert.equal(fns.FlushConsoleInputBuffer.handler([3]), 1);
    assert.deepEqual(errors, []);
});

test('a console title is a console\'s, and there is none to have one', ()=>{
    const { fns, errors } = setup();
    assert.equal(fns.SetConsoleTitleA.handler(), 0);
    assert.equal(fns.SetConsoleTitleW.handler(), 0);
    assert.equal(fns.GetConsoleTitleA.handler(), 0, 'no characters copied');
    assert.equal(fns.GetConsoleTitleW.handler(), 0);
    assert.deepEqual(errors, [6, 6, 6, 6], 'ERROR_INVALID_HANDLE, as GetConsoleMode answers');
    assert.equal(fns.SetConsoleTitleA.argBytes, 4);
    assert.equal(fns.GetConsoleTitleA.argBytes, 8);
});
