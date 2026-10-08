/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lexer, T, conditionalVariables, positionOf } from './lexer.js';
import { SyntaxFailure } from './errors.js';

/** @param {string} text @param {object} [options] */
function tokens(text, options){
    const lexer = new Lexer(text, options);
    const out = [];
    for (;;)
    {
        const token = lexer.next();
        if (token.t === T.EOF)
        {
            return out;
        }
        out.push(token);
    }
}

/** @param {string} text */
const values = text=>tokens(text).map(token=>token.v);

/** @param {() => unknown} fn @param {number} code */
function failsWith(fn, code){
    assert.throws(fn, e=>e instanceof SyntaxFailure && e.code === code);
}

test('numbers: decimal, exponent, hexadecimal, and JScript\'s octal', ()=>{
    assert.deepEqual(values('1 1.5 .5 1e3 1.5E-2 0x1F 0XfF 010 019 0'),
        [1, 1.5, 0.5, 1000, 0.015, 31, 255, 8, 19, 0]);
    failsWith(()=>values('1e'), 1013);
    failsWith(()=>values('3in'), 1013);
    failsWith(()=>values('0x'), 1023);
});

test('strings: escapes, \\v as the letter v, octal escapes, continued lines', ()=>{
    assert.deepEqual(values(String.raw`'a\tb' "\x41B" "\v" '\101\0' "\q"`),
        ['a\tb', 'AB', 'v', 'A\0', 'q']);
    assert.deepEqual(values('"one\\\ntwo"'), ['onetwo']);
    assert.deepEqual(values('"one\\\r\ntwo"'), ['onetwo']);
    failsWith(()=>values('"open'), 1015);
    failsWith(()=>values('"line\nbreak"'), 1015);
});

test('punctuators are read longest first', ()=>{
    assert.deepEqual(values('a>>>=b===c!==d>>e'),
        ['a', '>>>=', 'b', '===', 'c', '!==', 'd', '>>', 'e']);
});

test('a line break before a token is recorded, inside a comment too', ()=>{
    const [a, b, c] = tokens('a\nb /*\n*/ c');
    assert.equal(a.nl, false);
    assert.equal(b.nl, true);
    assert.equal(c.nl, true);
    failsWith(()=>values('/* open'), 1016);
});

test('identifiers take \\u escapes, which are never keywords', ()=>{
    const [token] = tokens('\\u0069f');
    assert.equal(token.v, 'if');
    assert.equal(token.escaped, true);
    failsWith(()=>values('#'), 1014);
});

test('a slash is read again as a regular expression where one begins', ()=>{
    const lexer = new Lexer('/a[/]b\\//gi x');
    const slash = lexer.next();
    assert.equal(slash.v, '/');
    const regex = lexer.regex(slash);
    assert.equal(regex.t, T.REGEX);
    assert.deepEqual(regex.v, { pattern: 'a[/]b\\/', flags: 'gi' });
    assert.equal(lexer.next().v, 'x');
});

test('conditional compilation: @cc_on, @if/@elif/@else/@end, @set, variables', ()=>{
    const version = { major: 5, minor: 6, build: 8835 };
    const options = ()=>({ conditional: conditionalVariables(version) });
    assert.deepEqual(values('/*@cc_on @*/ a'), ['a']);
    const kept = tokens('/*@cc_on @if (@_jscript_version >= 5.5) yes @else no @end @*/',
        options()).map(token=>token.v);
    assert.deepEqual(kept, ['yes']);
    const elif = tokens('@cc_on @if (@_win16) a @elif (@_win32) b @else c @end', options())
        .map(token=>token.v);
    assert.deepEqual(elif, ['b']);
    const nested = tokens('@cc_on @if (false) @if (true) x @end y @else z @end', options())
        .map(token=>token.v);
    assert.deepEqual(nested, ['z']);
    const set = tokens('@cc_on @set @n = (3 + 4) * 2 @n @_jscript_build @_undefined', options());
    assert.deepEqual(set.map(token=>token.v), [14, 8835, NaN]);
    assert.equal(tokens('@cc_on @_jscript', options())[0].v, 'true');
});

test('conditional compilation: a comment is code only once it is on', ()=>{
    assert.deepEqual(values('/*@ a @*/ b'), ['b']);
    assert.deepEqual(values('//@ a\nb'), ['b']);
    // Code begins at the @ of a directive or a variable; an @ before a space
    // is a comment's, on or off.
    assert.deepEqual(values('/*@cc_on @*/ //@ a\nb'), ['b']);
    assert.deepEqual(values('/*@cc_on @*/ /*@if (true) a @end @*/ b'), ['a', 'b']);
    assert.deepEqual(values('//@cc_on\n//@if (false)\nx\n//@end\ny'), ['y']);
    failsWith(()=>values('@x'), 1030);
    failsWith(()=>values('@cc_on @if (true) a'), 1029);
    failsWith(()=>values('@cc_on @if (true a @end'), 1006);
});

test('positions are lines and columns from 0, a CR LF one break', ()=>{
    assert.deepEqual(positionOf('ab\r\ncd\nef', 5), { line: 1, column: 1, lineText: 'cd' });
    assert.deepEqual(positionOf('x', 0), { line: 0, column: 0, lineText: 'x' });
});
