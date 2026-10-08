/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argumentsOf, indexOutsideQuotes, splitArguments } from './command-line.js';

test('the arguments start after argv[0], quoted or not, and the blanks after it', ()=>{
    assert.equal(argumentsOf('"C:\\WINDOWS\\system32\\msiexec.exe" /i x'), '/i x');
    assert.equal(argumentsOf('msiexec \t /i x '), '/i x ');
    assert.equal(argumentsOf('"C:\\a b\\rundll32.exe"x.dll,E'), 'x.dll,E',
        'argv[0] ends at its closing quote');
    assert.equal(argumentsOf('msiexec'), '');
    assert.equal(argumentsOf(''), '');
});

test('an argument keeps its quotes as typed beside its text, and where it stands', ()=>{
    assert.deepEqual(splitArguments(' A="b c" "d e"f  \\"'), [
        { raw: 'A="b c"', text: 'A=b c', start: 1, end: 8 },
        { raw: '"d e"f', text: 'd ef', start: 9, end: 15 },
        { raw: '\\"', text: '\\', start: 17, end: 19 },
    ]);
    assert.deepEqual(splitArguments(' \t '), []);
    assert.equal(indexOutsideQuotes('"a,b",c', ','), 5);
    assert.equal(indexOutsideQuotes('"a,b"', ','), -1);
});
