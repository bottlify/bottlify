/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argvOf, commandLineString, parseCommandLine, splitCommandLine } from './command-line.js';

test('a command line splits as CommandLineToArgvW splits it', ()=>{
    assert.deepEqual(splitCommandLine('"C:\\Program Files\\a.exe" -x  "two words" b'),
        ['C:\\Program Files\\a.exe', '-x', 'two words', 'b']);
    assert.deepEqual(splitCommandLine('a "-cachedir=C:\\Users\\U\\Steam" c\\\\"d e"'),
        ['a', '-cachedir=C:\\Users\\U\\Steam', 'c\\d e'], 'an even run of backslashes halves');
    assert.deepEqual(splitCommandLine('a \\"b'), ['a', '"b'], 'an odd run escapes the quote');
    assert.deepEqual(splitCommandLine('   '), []);
});

test('switches are read as Chromium reads them, names lower-cased, arguments kept', ()=>{
    const line = parseCommandLine(['web.exe', '-nocrashdialog', '--Lang=en_US', '/flag', 'page',
        '--', '--not-a-switch']);
    assert.equal(line.program, 'web.exe');
    assert.deepEqual(line.switches, [['nocrashdialog', ''], ['lang', 'en_US'], ['flag', '']]);
    assert.deepEqual(line.args, ['page', '--not-a-switch'], '-- ends the switches');
    assert.deepEqual(argvOf(line), ['web.exe', '--nocrashdialog', '--lang=en_US', '--flag', 'page',
        '--not-a-switch']);
    assert.equal(commandLineString(parseCommandLine(['C:\\a b\\w.exe', '--dir=x y'])),
        '"C:\\a b\\w.exe" "--dir=x y"', 'quoted where a token needs it');
});
