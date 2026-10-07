/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitCommandLine } from './commandline.js';
import { createShellFunctions } from './functions.js';

test('arguments are split at white space, and a quoted part keeps its own', ()=>{
    // The documentation's own table of how a command line is read.
    /** @type {[string, string[]][]} */
    const cases = [
        ['exe "a b c" d e', ['exe', 'a b c', 'd', 'e']],
        ['exe "ab\\"c" "\\\\" d', ['exe', 'ab"c', '\\', 'd']],
        ['exe a\\\\\\b d"e f"g h', ['exe', 'a\\\\\\b', 'de fg', 'h']],
        ['exe a\\\\\\"b c d', ['exe', 'a\\"b', 'c', 'd']],
        ['exe a\\\\\\\\"b c" d e', ['exe', 'a\\\\b c', 'd', 'e']],
        ['exe\targ1\t \targ2', ['exe', 'arg1', 'arg2']],
    ];
    for (const [line, args] of cases)
    {
        assert.deepEqual(splitCommandLine(line), args, line);
    }
});

test('two quotes inside a quoted part are a quote, and close it', ()=>{
    // The rule CommandLineToArgvW kept from the C runtime of its day, where
    // the later runtime stays inside the quotes.
    assert.deepEqual(splitCommandLine('exe a"b"" c d'), ['exe', 'ab"', 'c', 'd']);
    assert.deepEqual(splitCommandLine('exe """"'), ['exe', '"']);
    assert.deepEqual(splitCommandLine('exe "a""b c"'), ['exe', 'a"b', 'c']);
});

test('runs of quotes count in threes, as Windows answers in Wine\'s conformance test', ()=>{
    // Outside a quoted part 3n quotes are n quotes, 3n+1 also open one and
    // 3n+2 open and close one; inside, the opening quote counts in the run.
    /** @type {[string, string[]][]} */
    const cases = [
        ['exe two""quotes next', ['exe', 'twoquotes', 'next']],
        ['exe three"""quotes next', ['exe', 'three"quotes', 'next']],
        ['exe four"""" quotes" next', ['exe', 'four" quotes', 'next']],
        ['exe six""""""quotes next', ['exe', 'six""quotes', 'next']],
        ['exe "two"" next', ['exe', 'two"', 'next']],
        ['exe "five"""""quotes next', ['exe', 'five""quotes', 'next']],
        ['exe "the crazy \\\\"""\\\\" quotes', ['exe', 'the crazy \\"\\', 'quotes']],
        ['exe arg1 "unclosed', ['exe', 'arg1', 'unclosed']],
        ['exe three\tfour\rfour\nfour ', ['exe', 'three', 'four\rfour\nfour']],
        ['"two"" arg1 ', ['two', ' arg1 ']],
        ['"three""" arg2', ['three', '', 'arg2']],
        ['"four""""arg1', ['four', '"arg1']],
        ['exe"file"path arg1', ['exe"file"path', 'arg1']],
        ['"spaced exe\\"arg1 arg2', ['spaced exe\\', 'arg1', 'arg2']],
    ];
    for (const [line, args] of cases)
    {
        assert.deepEqual(splitCommandLine(line), args, line);
    }
});

test('an empty argument is only one that was quoted, and white space at the end is none', ()=>{
    assert.deepEqual(splitCommandLine('exe "" b'), ['exe', '', 'b']);
    assert.deepEqual(splitCommandLine('exe a  '), ['exe', 'a']);
    assert.deepEqual(splitCommandLine('exe "'), ['exe', ''], 'a quote opens an argument');
    assert.deepEqual(splitCommandLine('exe trailing\\'), ['exe', 'trailing\\']);
});

test('the program is read by its own rule, in which a backslash is a path\'s', ()=>{
    assert.deepEqual(splitCommandLine('"C:\\Program Files\\setup.exe" /S'),
        ['C:\\Program Files\\setup.exe', '/S']);
    assert.deepEqual(splitCommandLine('"C:\\dir\\" x'), ['C:\\dir\\', 'x'],
        'the quote after a backslash still ends the program');
    assert.deepEqual(splitCommandLine('C:\\dir\\a\\"b x'), ['C:\\dir\\a\\"b', 'x']);
    assert.deepEqual(splitCommandLine('"a b"c d'), ['a b', 'c', 'd'],
        'the program ends at its closing quote');
    assert.deepEqual(splitCommandLine('"unterminated program'), ['unterminated program']);
    assert.deepEqual(splitCommandLine(' x y'), ['', 'x', 'y'],
        'a line that starts with white space has an empty program');
});

/**
 * Guest memory with a heap the arguments go on, a wide-string writer and a
 * reader for what came back.
 *
 * @param {Record<string, any>} [extra]  More of the host, laid over the rest.
 */
function machine(extra = {}){
    const memory = new Uint8Array(0x2000).fill(0xaa);
    const view = new DataView(memory.buffer);
    let free = 0x1000;
    /** @type {number[]} */
    const errors = [];
    const shell = /** @type {any} */ (createShellFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: bytes=>{
            const at = free;
            free += bytes + 15 & ~15;
            return at;
        },
        imagePath: ()=>'C:\\Program Files\\App\\setup.exe',
        setLastError: code=>errors.push(code),
        ...extra,
    }));
    /** @param {string} text @param {number} at */
    const putWide = (text, at)=>{
        [...text, '\0'].forEach((unit, index)=>view.setUint16(at + index * 2, unit.charCodeAt(0),
            true));
        return at;
    };
    /** @param {number} at */
    const wideAt = at=>{
        let text = '';
        for (let unit = view.getUint16(at, true); unit !== 0; unit = view.getUint16(at, true))
        {
            text += String.fromCharCode(unit);
            at += 2;
        }
        return text;
    };
    /** The array a call answered, read up to its null. @param {number} block */
    const argv = block=>{
        const args = [];
        for (let at = block; view.getUint32(at, true) !== 0; at += 4)
        {
            args.push(wideAt(view.getUint32(at, true)));
        }
        return args;
    };
    return { memory, view, shell, errors, putWide, argv };
}

test('CommandLineToArgvW answers one block: the pointers, a null, then the strings', ()=>{
    const m = machine();
    const line = m.putWide('"C:\\Program Files\\App\\setup.exe" /SP- "/DIR=C:\\My Games"', 0x100);
    const block = m.shell.CommandLineToArgvW.handler([line, 0x80]);

    assert.ok(block >= 0x1000);
    assert.equal(m.view.getUint32(0x80, true), 3, 'the count, where pNumArgs points');
    assert.deepEqual(m.argv(block),
        ['C:\\Program Files\\App\\setup.exe', '/SP-', '/DIR=C:\\My Games']);
    assert.equal(m.view.getUint32(block + 12, true), 0, 'argv[argc] is null');
    assert.equal(m.view.getUint32(block, true), block + 16,
        'the strings follow the array, in the block the caller frees with LocalFree');
    assert.equal(m.shell.CommandLineToArgvW.argBytes, 8);
});

test('an empty command line is the program\'s own path, alone', ()=>{
    const m = machine();
    const block = m.shell.CommandLineToArgvW.handler([m.putWide('', 0x100), 0x80]);
    assert.equal(m.view.getUint32(0x80, true), 1);
    assert.deepEqual(m.argv(block), ['C:\\Program Files\\App\\setup.exe']);
});

test('a missing count or line is an invalid parameter, with nothing allocated', ()=>{
    const m = machine();
    const line = m.putWide('exe', 0x100);
    assert.equal(m.shell.CommandLineToArgvW.handler([line, 0]), 0);
    assert.equal(m.shell.CommandLineToArgvW.handler([0, 0x80]), 0);
    assert.deepEqual(m.errors, [87, 87], 'ERROR_INVALID_PARAMETER');
    assert.equal(m.memory[0x80], 0xaa, 'the count is not written');
    assert.equal(m.memory[0x1000], 0xaa);
});

test('a command line longer than a path is read whole', ()=>{
    const m = machine();
    const long = 'x'.repeat(600);
    const block = m.shell.CommandLineToArgvW.handler([m.putWide(`exe ${long} end`, 0x100), 0x80]);
    assert.deepEqual(m.argv(block), ['exe', long, 'end']);
});

test('with no heap the call fails as out of memory, and says so in the last error', ()=>{
    const m = machine({ allocate: undefined });
    assert.equal(m.shell.CommandLineToArgvW.handler([m.putWide('exe a', 0x100), 0x80]), 0);
    assert.deepEqual(m.errors, [8], 'ERROR_NOT_ENOUGH_MEMORY');
});
