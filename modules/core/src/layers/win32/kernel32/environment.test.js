/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentFunctions } from './environment.js';

const ERROR_ENVVAR_NOT_FOUND = 203;
const STARTUPINFOA_SIZE = 68;

function fakeHost(overrides = {}){
    // Dirtied on purpose. Guest memory that starts at zero makes "this block
    // ends in a terminator" true whether or not anything wrote one, which is an
    // assertion that cannot fail.
    const bytes = new Uint8Array(0x4000).fill(0xaa);
    /** @type {number[]} */
    const errors = [];
    let next = 0x1000;

    return {
        bytes,
        errors,
        commandLine: ()=>'C:\\game.exe -windowed',
        environment: ()=>({ PATH: 'C:\\WINDOWS', TEMP: 'C:\\TEMP' }),
        ...overrides,
        /** @param {number} address @param {Uint8Array} data */
        writeMemory(address, data){
            bytes.set(data, address);
        },
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        /** @param {number} address @param {number} maxLength */
        readWideString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength; at++)
            {
                const code = bytes[address + at * 2] | bytes[address + at * 2 + 1] << 8;
                if (code === 0)
                {
                    break;
                }
                text += String.fromCharCode(code);
            }
            return text;
        },
        /** @param {number} size */
        allocate(size){
            const address = next;
            next += size + 8;
            return address;
        },
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {number} address @param {string} text */
        plant(address, text){
            for (let at = 0; at < text.length; at++)
            {
                bytes[address + at] = text.charCodeAt(at);
            }
            bytes[address + text.length] = 0;
        },
        /**
         * Bounded by the buffer rather than by the terminator: an unbounded
         * read past the end of a Uint8Array yields undefined, which is not zero,
         * so a missing terminator would grow a string until the process died
         * instead of failing an assertion.
         *
         * @param {number} address
         */
        readAnsi(address){
            let text = '';
            for (let at = 0; address + at < bytes.length && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
    };
}

test('the command line is the same pointer every time it is asked for', ()=>{
    // A runtime takes it once and keeps it, then parses it into argv later. A
    // fresh copy per call works until something compares or frees the one kept.
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);

    const first = fns.GetCommandLineA.handler();
    const second = fns.GetCommandLineA.handler();

    assert.equal(first, second);
    assert.equal(host.readAnsi(first), 'C:\\game.exe -windowed');
});

test('the environment block ends with the empty entry a reader stops on', ()=>{
    // A walker reads NAME=VALUE until it meets a zero-length entry. Without the
    // second terminator it reads past the end of the block.
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);

    const block = fns.GetEnvironmentStrings.handler();
    const entries = [];
    let at = block;
    // Bounded, because that is exactly what a real walker is not: without the
    // closing terminator this loop is the guest reading off the end of the
    // block, and a test that discovers it by exhausting memory has found the
    // right defect in the wrong way.
    while (host.bytes[at] !== 0 && entries.length < 8)
    {
        const entry = host.readAnsi(at);
        entries.push(entry);
        at += entry.length + 1;
    }

    assert.deepEqual(entries, ['PATH=C:\\WINDOWS', 'TEMP=C:\\TEMP']);
    assert.equal(host.bytes[at], 0, 'and the block is closed by a second terminator');
});

test('the wide block is the same shape, two bytes to a character', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);

    const block = fns.GetEnvironmentStringsW.handler();
    const wide = /** @param {number} index */ index=>
        host.bytes[block + index * 2] | host.bytes[block + index * 2 + 1] << 8;

    assert.equal(String.fromCharCode(wide(0), wide(1), wide(2), wide(3)), 'PATH');
    assert.equal(wide(4), '='.charCodeAt(0));

    const total = 'PATH=C:\\WINDOWS\0TEMP=C:\\TEMP\0\0'.length;
    assert.equal(wide(total - 1), 0);
    assert.equal(wide(total - 2), 0, 'the closing pair, both wide');
});

test('freeing accepts the block that was handed out and refuses one that was not', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);

    const block = fns.GetEnvironmentStrings.handler();
    assert.equal(fns.FreeEnvironmentStringsA.handler([block]), 1);
    assert.equal(fns.FreeEnvironmentStringsA.handler([block + 4]), 0,
        'answering yes to a pointer we never gave out would hide the mistake');
});

test('the narrow and wide blocks are not each other', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);

    const narrow = fns.GetEnvironmentStrings.handler();
    const wide = fns.GetEnvironmentStringsW.handler();

    assert.notEqual(narrow, wide);
    assert.equal(fns.FreeEnvironmentStringsW.handler([narrow]), 0);
    assert.equal(fns.FreeEnvironmentStringsW.handler([wide]), 1);
});

test('a variable that exists is written out, and its length excludes the terminator', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.plant(0x100, 'TEMP');

    assert.equal(fns.GetEnvironmentVariableA.handler([0x100, 0x200, 64]), 7);
    assert.equal(host.readAnsi(0x200), 'C:\\TEMP');
});

test('a buffer too small reports what is needed, terminator included', ()=>{
    // The count means two different things either side of "it fits", and a
    // caller sizes its second allocation from the larger one.
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.plant(0x100, 'TEMP');

    assert.equal(fns.GetEnvironmentVariableA.handler([0x100, 0x200, 4]), 8);
});

test('a variable that does not exist says so rather than answering empty', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.plant(0x100, 'NOSUCH');

    assert.equal(fns.GetEnvironmentVariableA.handler([0x100, 0x200, 64]), 0);
    assert.deepEqual(host.errors, [ERROR_ENVVAR_NOT_FOUND]);
});

test('expanding replaces the variables it knows and leaves the rest as written', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.plant(0x100, '%TEMP%\\x %NOSUCH% 100%');

    assert.equal(fns.ExpandEnvironmentStringsA.handler([0x100, 0x200, 64]), 24);
    assert.equal(host.readAnsi(0x200), 'C:\\TEMP\\x %NOSUCH% 100%');
});

test('expanding into a buffer too small writes nothing and still says what is needed', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.plant(0x100, '%TEMP%');

    assert.equal(fns.ExpandEnvironmentStringsA.handler([0x100, 0, 0]), 8);
    assert.equal(fns.ExpandEnvironmentStringsA.handler([0x100, 0x200, 7]), 8);
    assert.equal(host.bytes[0x200], 0xaa);
});

test('setting a variable is visible to the next reader', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.plant(0x100, 'NEW');
    host.plant(0x140, 'value');

    assert.equal(fns.SetEnvironmentVariableA.handler([0x100, 0x140]), 1);
    assert.equal(fns.GetEnvironmentVariableA.handler([0x100, 0x200, 64]), 5);
    assert.equal(host.readAnsi(0x200), 'value');
});

test('a null value removes the variable', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.plant(0x100, 'TEMP');

    assert.equal(fns.SetEnvironmentVariableA.handler([0x100, 0]), 1);
    assert.equal(fns.GetEnvironmentVariableA.handler([0x100, 0x200, 64]), 0);
});

test('a changed environment produces a new block rather than an edited one', ()=>{
    // The pointer a caller already holds keeps describing the environment it
    // asked about, which is what Windows does with a block still in hand.
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    const before = fns.GetEnvironmentStrings.handler();

    host.plant(0x100, 'ADDED');
    host.plant(0x140, 'x');
    fns.SetEnvironmentVariableA.handler([0x100, 0x140]);

    const after = fns.GetEnvironmentStrings.handler();
    assert.notEqual(before, after);
    assert.equal(host.readAnsi(before), 'PATH=C:\\WINDOWS', 'the old block still reads');
});

test('the startup record names its own size and nothing else', ()=>{
    // dwFlags of zero is how a program is told not to read the rest, so every
    // other field being zero is the answer rather than a placeholder.
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    host.bytes.fill(0x5a, 0x300, 0x300 + STARTUPINFOA_SIZE);

    fns.GetStartupInfoA.handler([0x300]);
    const view = new DataView(host.bytes.buffer);
    assert.equal(view.getUint32(0x300, true), STARTUPINFOA_SIZE);
    assert.equal(view.getUint32(0x300 + 44, true), 0, 'dwFlags');
    assert.deepEqual([...host.bytes.slice(0x304, 0x300 + STARTUPINFOA_SIZE)],
        new Array(STARTUPINFOA_SIZE - 4).fill(0));
});

test('the system directory is inside the windows one, as a program assumes', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);

    assert.equal(fns.GetWindowsDirectoryA.handler([0x200, 64]), 10);
    assert.equal(host.readAnsi(0x200), 'C:\\WINDOWS');

    assert.equal(fns.GetSystemDirectoryA.handler([0x280, 64]), 19);
    assert.equal(host.readAnsi(0x280), 'C:\\WINDOWS\\system32');

    assert.equal(fns.GetSystemDirectoryA.handler([0x280, 4]), 20, 'too small: what is needed');
});
