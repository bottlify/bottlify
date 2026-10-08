/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { N, parseExpressionProgram, parseFunctionParts, parseProgram } from './parser.js';
import { SyntaxFailure } from './errors.js';

/** @param {string} text @param {number} code */
function failsWith(text, code){
    assert.throws(()=>parseProgram(text), e=>e instanceof SyntaxFailure && e.code === code,
        `${JSON.stringify(text)} should fail with ${code}`);
}

test('automatic semicolon insertion (7.9)', ()=>{
    assert.equal(parseProgram('a = 1\nb = 2').body.length, 2);
    assert.equal(parseProgram('{ 1 }').body.length, 1);
    // A restricted production: the line break ends the return.
    const fn = parseProgram('function f(){ return\n1 }').funcs[0];
    assert.equal(fn.body[0].type, N.Return);
    assert.equal(fn.body[0].argument, null);
    // ++ after a line break belongs to the next statement.
    const program = parseProgram('a\n++b');
    assert.equal(program.body.length, 2);
    assert.equal(program.body[1].expression.type, N.Update);
    assert.equal(program.body[1].expression.prefix, true);
    // A do-while's semicolon may be left out.
    assert.equal(parseProgram('do x(); while (y) z()').body.length, 2);
    failsWith('a b', 1004);
    failsWith('for (a; b\n) c', 1004);
});

test('declarations are gathered for hoisting, from blocks too', ()=>{
    const program = parseProgram('var a, b = 1; if (x) { var c; function f(){ var inner; } }');
    assert.deepEqual(program.vars, ['a', 'b', 'c']);
    assert.deepEqual(program.funcs.map(fn=>fn.name), ['f']);
    assert.deepEqual(program.funcs[0].vars, ['inner']);
});

test('a named function expression declares its name in the enclosing function', ()=>{
    const program = parseProgram('var g = function h(){};');
    assert.deepEqual(program.funcs.map(fn=>fn.name), ['h']);
    assert.equal(parseProgram('var g = function(){};').funcs.length, 0);
});

test('functions keep their own text, and note arguments and eval', ()=>{
    const [fn] = parseProgram('  function f(a, b) { return arguments[0] + eval("b"); }  ').funcs;
    assert.equal(fn.text, 'function f(a, b) { return arguments[0] + eval("b"); }');
    assert.deepEqual(fn.params, ['a', 'b']);
    assert.equal(fn.usesArguments, true);
    assert.equal(fn.usesEval, true);
});

test('labels, break and continue are checked against their targets', ()=>{
    parseProgram('a: b: while (1) { continue a; }');
    parseProgram('a: { break a; }');
    parseProgram('while (1) { break; }');
    parseProgram('switch (x) { case 1: break; }');
    failsWith('break;', 1019);
    failsWith('continue;', 1020);
    failsWith('a: { continue a; }', 1026);
    failsWith('while (1) break b;', 1026);
    failsWith('a: a: ;', 1025);
    failsWith('return 1;', 1018);
    failsWith('function f(){ a: { } break a; }', 1026);
});

test('the grammar\'s other errors are JScript\'s numbers', ()=>{
    failsWith('if x', 1005);
    failsWith('if (x', 1006);
    failsWith('[1, 2', 1007);
    failsWith('function f() }', 1008);
    failsWith('{', 1009);
    failsWith('var 1', 1010);
    failsWith('a ? b', 1003);
    failsWith('do x; until (y)', 1024);
    failsWith('try {}', 1033);
    failsWith('throw\n1', 1035);
    failsWith('switch (x) { default: default: }', 1027);
    failsWith('var class;', 1010);
    failsWith('({ +: 1 })', 1028);
});

test('array literals count holes, and an element after a trailing comma', ()=>{
    const [statement] = parseProgram('[1, , 2, ]').body;
    assert.equal(statement.expression.elements.length, 4);
    assert.equal(statement.expression.elements[1], null);
    assert.equal(statement.expression.elements[3], null);
    assert.equal(parseProgram('[]').body[0].expression.elements.length, 0);
});

test('a call may be assigned to, as an automation property with arguments', ()=>{
    const [statement] = parseProgram('Session.Property("X") = "1"').body;
    assert.equal(statement.expression.type, N.Assign);
    assert.equal(statement.expression.target.type, N.Call);
});

test('operator precedence and the in operator in a for head', ()=>{
    const expression = parseProgram('a + b * c').body[0].expression;
    assert.equal(expression.op, '+');
    assert.equal(expression.right.op, '*');
    const forIn = parseProgram('for (x in o) ;').body[0];
    assert.equal(forIn.type, N.ForIn);
    const plain = parseProgram('for (var i = ("a" in o); i; ) ;').body[0];
    assert.equal(plain.type, N.For);
    assert.equal(parseProgram('new a.b(1).c').body[0].expression.type, N.Member);
});

test('an expression text, and the Function constructor\'s parts', ()=>{
    const program = parseExpressionProgram('1 + 2');
    assert.equal(program.body[0].type, N.Expr);
    assert.throws(()=>parseExpressionProgram('1; 2'), SyntaxFailure);
    const fn = parseFunctionParts('a, b', 'return a + b');
    assert.deepEqual(fn.params, ['a', 'b']);
    assert.equal(fn.text, 'function anonymous(a, b) {\nreturn a + b\n}');
    assert.throws(()=>parseFunctionParts('a) {', 'x'), SyntaxFailure);
});
