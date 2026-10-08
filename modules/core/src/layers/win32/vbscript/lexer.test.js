/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntaxFailure } from './errors.js';
import { positionOf, tokenize } from './lexer.js';

/** @param {string} text @returns {string[]} each token as kind:key-or-value */
const kinds = text=>tokenize(text).map(t=>(t.kind === 'num'
    ? `num:${t.value.type}:${t.value.value}` : t.kind === 'op' || t.kind === 'kw'
        ? `${t.kind}:${t.key}` : `${t.kind}:${t.value ?? ''}`));

/** @param {string} text @returns {number} the code it fails with */
const failing = text=>{
    try
    {
        tokenize(text);
    }
    catch (e){
        assert.ok(e instanceof SyntaxFailure);
        return e.code;
    }
    return assert.fail(`${text} lexed`);
};

test('keywords and names without case; a name after "." is a name', ()=>{
    assert.deepEqual(kinds('DIM x: If X THEN obj.End = Nothing'), [
        'kw:dim', 'id:x', 'op::', 'kw:if', 'id:X', 'kw:then', 'id:obj', 'op:.', 'id:End', 'op:=',
        'kw:nothing', 'eof:']);
    assert.deepEqual(kinds('[my name] = 1'), ['id:my name', 'op:=', 'num:integer:1', 'eof:']);
});

test('numbers: Integer, Long, Double, hex and octal as sixteen or thirty-two bits', ()=>{
    /** @type {[string, string][]} */
    const cases = [
        ['1', 'integer:1'], ['32767', 'integer:32767'], ['32768', 'long:32768'],
        ['2147483648', 'double:2147483648'], ['1.5', 'double:1.5'], ['.5', 'double:0.5'],
        ['1E3', 'double:1000'], ['&HFF', 'integer:255'], ['&HFFFF', 'integer:-1'],
        ['&HFFFF&', 'long:65535'], ['&H10000', 'long:65536'], ['&O17', 'integer:15'],
        ['&17', 'integer:15'], ['&HFFFFFFFF', 'long:-1'],
    ];
    for (const [text, expected] of cases)
    {
        assert.deepEqual(kinds(`x = ${text}`), ['id:x', 'op:=', `num:${expected}`, 'eof:'], text);
    }
    // After a value, & joins: "a" &H1 is not a hex number.
    assert.deepEqual(kinds('a&b'), ['id:a', 'op:&', 'id:b', 'eof:']);
    assert.equal(failing('x = 12abc'), 1031);
});

test('strings, dates, comments and continued lines', ()=>{
    assert.deepEqual(kinds('"say ""hi""" #1/2/2003# \' comment\nRem remark\nx _\n = 1'), [
        'str:say "hi"', 'date:1/2/2003', 'nl:', 'nl:', 'id:x', 'op:=', 'num:integer:1', 'eof:']);
    assert.deepEqual(kinds('a <= b >= c <> d =< e'),
        ['id:a', 'op:<=', 'id:b', 'op:>=', 'id:c', 'op:<>', 'id:d', 'op:<=', 'id:e', 'eof:']);
    assert.equal(failing('x = "open'), 1033);
    assert.equal(failing('x = "open\n"'), 1033);
    assert.equal(failing('x = @'), 1032);
    assert.equal(failing('x = [open'), 1007);
});

test('positionOf: the line, the column and the text of the line', ()=>{
    assert.deepEqual(positionOf('a\r\nbc\nd', 5), { line: 1, column: 2, lineText: 'bc' });
    assert.deepEqual(positionOf('a\rb', 2), { line: 1, column: 0, lineText: 'b' });
});
