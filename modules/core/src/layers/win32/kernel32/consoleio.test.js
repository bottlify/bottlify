/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
