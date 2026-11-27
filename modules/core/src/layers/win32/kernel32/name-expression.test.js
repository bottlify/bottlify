/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNameInExpression, win32Expression } from './name-expression.js';

/** @param {string} expression @param {string[]} names */
const listed = (expression, names)=>names.filter(name=>isNameInExpression(expression, name));

const NAMES = ['n.tmp', 'ea.tmp', 'ea', '.', '..', 'ea.tmp.tmp', '.a', '.a.a', 'a.', '..a', 'a..'];

test('* and ? are any run and one character; *.* asks for a dot', ()=>{
    assert.deepEqual(listed('*', NAMES), NAMES);
    assert.deepEqual(listed('*.*', NAMES), NAMES.filter(name=>name !== 'ea'));
    assert.deepEqual(listed('??', NAMES), ['ea', '.a', 'a.']);
    assert.deepEqual(listed('*..*', NAMES), ['..a', 'a..']);
    assert.ok(isNameInExpression('N.TMP', 'n.tmp'), 'case is ignored');
});

test('DOS_STAR runs to the final dot, or takes it', ()=>{
    assert.deepEqual(listed('<.tmp', NAMES), ['n.tmp', 'ea.tmp', 'ea.tmp.tmp']);
    assert.deepEqual(listed('<tmp', NAMES), ['n.tmp', 'ea.tmp', 'ea.tmp.tmp']);
    assert.deepEqual(listed('<.a', NAMES), ['.a', '.a.a', '..a']);
    assert.deepEqual(listed('.<', NAMES), ['.', '..', '.a']);
    assert.deepEqual(listed('<.<.<', NAMES), ['ea.tmp.tmp', '.a.a', '..a', 'a..']);
    assert.ok(!isNameInExpression('<name<', 'longfilename.tmp'), 'not past the final dot');
    assert.ok(isNameInExpression('<nam<tmp', 'longfilename.tmp'));
});

test('DOS_QM is one character or none at a dot; DOS_DOT a dot or none past the end', ()=>{
    assert.deepEqual(listed('>', NAMES), ['.', '..']);
    assert.deepEqual(listed('>.', NAMES), ['.', '..', 'a.']);
    assert.deepEqual(listed('>>.tmp', ['n.tmp', 'ea.tmp', 'abc.tmp']), ['n.tmp', 'ea.tmp']);
    assert.deepEqual(listed('"', NAMES), ['.', '..']);
    assert.deepEqual(listed('ea"', NAMES), ['ea']);
    assert.deepEqual(listed('n"tmp', NAMES), ['n.tmp']);
    assert.deepEqual(listed('e"a', NAMES), [], 'nothing stands in for a dot inside the name');
});

test('"." and ".." are matched as the one dot or as nothing', ()=>{
    assert.ok(isNameInExpression('?', '..'));
    assert.ok(!isNameInExpression('??', '..'));
    assert.ok(!isNameInExpression('?.', '..'));
    assert.ok(isNameInExpression('*.', '..'));
});

test('a Win32 search pattern is the native expression kernel32 makes of it', ()=>{
    // Wine's test_FindFirstFile_wildcards, the rows no 8.3 name decides.
    const names = ['.', '..', '..a', '..a.a', '.a', '.a..a', '.a.a', '.aaa', 'a', 'a..a', 'a.a',
        'a.a.a', 'aa', 'aaa', 'aaaa', ' .a'];
    /** @param {string} pattern */
    const found = pattern=>listed(win32Expression(pattern), names);
    assert.equal(win32Expression('*.*'), '*');
    assert.deepEqual(found('*.*'), names, 'every name');
    assert.equal(win32Expression('*.'), '<"', 'the names with no extension');
    assert.deepEqual(found('*.'), ['.', '..', 'a', 'aa', 'aaa', 'aaaa']);
    assert.equal(win32Expression('* .'), '<"', 'trailing dots and spaces, one dot kept');
    assert.equal(win32Expression('*..'), '<"');
    assert.equal(win32Expression('*. '), '*', 'ending in a space: none kept');
    assert.deepEqual(found('*. '), names);
    assert.equal(win32Expression('?.??.'), '>">>"');
    assert.deepEqual(found('?.??.'), ['.', '..', '.a', 'a', 'a.a', ' .a']);
    assert.deepEqual(found('*..*'), ['.', '..', '..a', '..a.a', '.a..a', 'a..a']);
    assert.deepEqual(found('. *'), [], 'a space is a character like any other');
});

test('a long expression is matched without recursion', ()=>{
    // The guest-pointer validator hands every argument a long string: the
    // matcher recursed once a character and overflowed the stack.
    assert.ok(isNameInExpression('*'.repeat(20000), 'name'));
    assert.ok(!isNameInExpression('?'.repeat(20000), 'name'));
});

test('a long expression against a long name costs two rows of the table, not the table', ()=>{
    // A search pattern's last component of 32K characters against a name as
    // long: the whole table is a gigabyte, a row of it a name long.
    const long = 'A'.repeat(4096);
    const before = process.memoryUsage().external + process.memoryUsage().heapUsed;
    assert.ok(isNameInExpression(long, long.toLowerCase()));
    assert.ok(!isNameInExpression(`${long}B`, long));
    assert.ok(isNameInExpression(`${long.slice(1)}>`, long), 'a DOS_QM at the end');
    assert.ok(isNameInExpression(`${long.slice(1)}>>>`, long), 'a run of them');
    const grown = process.memoryUsage().external + process.memoryUsage().heapUsed - before;
    assert.ok(grown < 4 * 2 ** 20, `${grown} bytes grown`);
});
