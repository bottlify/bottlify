/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironmentFunctions, defaultEnvironment } from './environment.js';
import {
    PROCESSOR, PROCESSOR_IDENTIFIER, PROCESSOR_LEVEL, PROCESSOR_REVISION,
} from './processor.js';
import { WINDOWS_VERSIONS } from './versions.js';
import { shellFolders } from '../advapi32/registry.js';
import { decodeAnsi } from './locale.js';

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

test('GetEnvironmentVariableW reads a variable by a wide name into a wide buffer', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    const name = 'TEMP';
    for (let at = 0; at <= name.length; at++)
    {
        host.bytes[0x200 + at * 2] = at < name.length ? name.charCodeAt(at) : 0;
        host.bytes[0x201 + at * 2] = 0;
    }
    assert.equal(fns.GetEnvironmentVariableW.handler([0x200, 0x300, 2]), 8,
        'too short: the size wanted, terminator included');
    assert.equal(fns.GetEnvironmentVariableW.handler([0x200, 0x300, 0x40]), 7);
    assert.equal(host.readWideString(0x300, 0x40), 'C:\\TEMP');
    assert.notEqual(fns.GetEnvironmentStringsA.handler(), 0, 'the block under its A name too');
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
    assert.equal(fns.GetStartupInfoW, fns.GetStartupInfoA,
        'the wide record is the same size, with no strings to give either');
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

test('the system Windows directory is the Windows directory: this is no terminal server', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    assert.equal(fns.GetSystemWindowsDirectoryA.handler([0x200, 64]), 10);
    assert.equal(host.readAnsi(0x200), 'C:\\WINDOWS');
    assert.equal(fns.GetSystemWindowsDirectoryW.handler([0x300, 64]), 10);
    assert.equal(host.readWideString(0x300, 64), 'C:\\WINDOWS');
    assert.equal(fns.GetSystemWindowsDirectoryW.handler([0x300, 10]), 11,
        'too small: what is needed');
    assert.deepEqual([fns.GetSystemWindowsDirectoryA.argBytes,
        fns.GetSystemWindowsDirectoryW.argBytes], [8, 8]);
});

/** The processor as one machine of one processor defines it in every Windows. */
const PROCESSOR_VARIABLES = Object.freeze({
    NUMBER_OF_PROCESSORS: '1',
    PROCESSOR_ARCHITECTURE: 'x86',
    PROCESSOR_IDENTIFIER: 'x86 Family 6 Model 7 Stepping 3, GenuineIntel',
    PROCESSOR_LEVEL: '6',
    PROCESSOR_REVISION: '0703',
});

test('a process starts with the profile variables of the machine\'s layout', ()=>{
    // The same folders the registry and the shell name: a program that joins
    // %APPDATA% and one that asks SHGetFolderPath arrive at one directory.
    const xp = WINDOWS_VERSIONS.winxp;
    assert.deepEqual(defaultEnvironment(xp, shellFolders(xp)), {
        ALLUSERSPROFILE: 'C:\\Documents and Settings\\All Users',
        APPDATA: 'C:\\Documents and Settings\\User\\Application Data',
        ...PROCESSOR_VARIABLES,
        SystemRoot: 'C:\\WINDOWS',
        TEMP: 'C:\\WINDOWS\\TEMP',
        TMP: 'C:\\WINDOWS\\TEMP',
        USERPROFILE: 'C:\\Documents and Settings\\User',
        windir: 'C:\\WINDOWS',
    }, 'XP has no LOCALAPPDATA, ProgramData or PUBLIC: they came with Vista');
    const win2000 = WINDOWS_VERSIONS.win2000;
    assert.deepEqual(defaultEnvironment(win2000, shellFolders(win2000)),
        defaultEnvironment(xp, shellFolders(xp)));

    const seven = WINDOWS_VERSIONS.win7;
    assert.deepEqual(defaultEnvironment(seven, shellFolders(seven)), {
        ALLUSERSPROFILE: 'C:\\ProgramData',
        APPDATA: 'C:\\Users\\User\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\User\\AppData\\Local',
        ...PROCESSOR_VARIABLES,
        ProgramData: 'C:\\ProgramData',
        PUBLIC: 'C:\\Users\\Public',
        SystemRoot: 'C:\\WINDOWS',
        TEMP: 'C:\\WINDOWS\\TEMP',
        TMP: 'C:\\WINDOWS\\TEMP',
        USERPROFILE: 'C:\\Users\\User',
        windir: 'C:\\WINDOWS',
    });
    const ten = WINDOWS_VERSIONS.win10;
    assert.deepEqual(defaultEnvironment(ten, shellFolders(ten)),
        defaultEnvironment(seven, shellFolders(seven)));

    for (const windows of [xp, seven])
    {
        const names = Object.keys(defaultEnvironment(windows, shellFolders(windows)));
        assert.deepEqual(names, [...names].sort((a, b)=>(a.toUpperCase() < b.toUpperCase() ? -1
            : 1)), 'in the order Windows keeps the block, whatever the case');
    }
});

test('NUMBER_OF_PROCESSORS is the machine\'s count, and the processor the registry names', ()=>{
    // The identifier is the registry's with the vendor after it, the level the
    // family and the revision model and stepping in four hex digits, as
    // GetSystemInfo gives them.
    const xp = WINDOWS_VERSIONS.winxp;
    const variables = defaultEnvironment(xp, shellFolders(xp), 4);
    assert.equal(variables.NUMBER_OF_PROCESSORS, '4');
    assert.equal(variables.PROCESSOR_IDENTIFIER, `${PROCESSOR_IDENTIFIER}, ${PROCESSOR.vendor}`);
    assert.equal(Number(variables.PROCESSOR_LEVEL), PROCESSOR_LEVEL);
    assert.equal(parseInt(variables.PROCESSOR_REVISION, 16), PROCESSOR_REVISION);
});

test('text in the upper half of the ANSI page goes back as the bytes it was read from', ()=>{
    // The memory layer reads an ANSI string as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash; a variable, the block
    // and the command line are written back in that page.
    const host = fakeHost({ commandLine: ()=>'C:\\\u20ac\\game.exe' });
    host.readCString = (address, maxLength)=>decodeAnsi(
        host.bytes.subarray(address, host.bytes.indexOf(0, address)).subarray(0, maxLength));
    const fns = createEnvironmentFunctions(host);
    const value = [0x80, 0x99, 0x97, 0xe9];
    host.plant(0x3000, 'X');
    host.bytes.set([...value, 0], 0x3010);
    /** @param {number} address @param {number} length */
    const bytesAt = (address, length)=>[...host.bytes.subarray(address, address + length)];

    assert.equal(fns.SetEnvironmentVariableA.handler([0x3000, 0x3010]), 1);
    assert.equal(fns.GetEnvironmentVariableA.handler([0x3000, 0x3100, 32]), value.length);
    assert.deepEqual(bytesAt(0x3100, value.length + 1), [...value, 0]);

    host.plant(0x3020, '%X%');
    assert.equal(fns.ExpandEnvironmentStringsA.handler([0x3020, 0x3200, 32]), value.length + 1);
    assert.deepEqual(bytesAt(0x3200, value.length + 1), [...value, 0]);

    const block = fns.GetEnvironmentStrings.handler();
    const entry = host.bytes.indexOf(0x58, block);
    assert.deepEqual(bytesAt(entry, value.length + 3), [0x58, 0x3d, ...value, 0]);

    assert.deepEqual(bytesAt(fns.GetCommandLineA.handler() + 3, 2), [0x80, 0x5c]);
});

test('the wide forms answer the windows directory and expand as the A forms do', ()=>{
    const host = fakeHost();
    const fns = createEnvironmentFunctions(host);
    /** @param {number} address @param {string} text */
    const plantWide = (address, text)=>{
        [...text, '\0'].forEach((unit, at)=>{
            host.bytes[address + at * 2] = unit.charCodeAt(0) & 0xff;
            host.bytes[address + at * 2 + 1] = unit.charCodeAt(0) >> 8;
        });
    };

    assert.equal(fns.GetWindowsDirectoryW.argBytes, 8);
    assert.equal(fns.GetWindowsDirectoryW.handler([0x200, 64]), 10);
    assert.equal(host.readWideString(0x200, 64), 'C:\\WINDOWS');
    assert.equal(host.bytes[0x200 + 20] | host.bytes[0x200 + 21], 0, 'terminated');
    assert.equal(fns.GetWindowsDirectoryW.handler([0x200, 10]), 11, 'too small: what is needed');

    plantWide(0x100, '%TEMP%\\\u3042 %NOSUCH%');
    assert.equal(fns.ExpandEnvironmentStringsW.argBytes, 12);
    const expanded = 'C:\\TEMP\\\u3042 %NOSUCH%';
    assert.equal(fns.ExpandEnvironmentStringsW.handler([0x100, 0, 0]), expanded.length + 1);
    host.bytes.fill(0xaa, 0x300, 0x380);
    assert.equal(fns.ExpandEnvironmentStringsW.handler([0x100, 0x300, expanded.length]),
        expanded.length + 1);
    assert.equal(host.bytes[0x300], 0xaa, 'a buffer too small gets nothing');
    assert.equal(fns.ExpandEnvironmentStringsW.handler([0x100, 0x300, 64]), expanded.length + 1);
    assert.equal(host.readWideString(0x300, 64), expanded);
});
