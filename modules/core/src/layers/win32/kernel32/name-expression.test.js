/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNameInExpression } from './name-expression.js';

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
