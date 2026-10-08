/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyntaxFailure } from './errors.js';
import { parseExpressionProgram, parseProgram } from './parser.js';

/**
 * A tree with positions taken out, to compare shapes.
 *
 * @param {any} node @returns {any}
 */
const shape = node=>{
    if (Array.isArray(node))
    {
        return node.map(shape);
    }
    if (node === null || typeof node !== 'object' || !('type' in node || 'kind' in node))
    {
        return node;
    }
    const out = /** @type {Record<string, any>} */ ({});
    for (const [key, value] of Object.entries(node))
    {
        if (key !== 'pos' && key !== 'name' && key !== 'source')
        {
            out[key] = shape(value);
        }
    }
    return out;
};

/** @param {string} text */
const statements = text=>shape(parseProgram(text).body);

/** @param {string} text @returns {number} */
const failing = text=>{
    try
    {
        parseProgram(text);
    }
    catch (e){
        assert.ok(e instanceof SyntaxFailure, String(e));
        return e.code;
    }
    return assert.fail(`${text} parsed`);
};

const name = (/** @type {string} */ key)=>({ type: 'Name', key });

test('a call statement\'s arguments: bare, or one in parentheses passed by value', ()=>{
    const [bare, paren, sum, pair, called] = statements(
        'Foo 1, x\nFoo (x)\nFoo (1) + 2\nFoo (1), (2)\nCall Foo(x, 2)');
    assert.equal(bare.type, 'Call');
    assert.deepEqual(bare.args.map((/** @type {any} */ a)=>a.type), ['Lit', 'Name']);
    assert.deepEqual(paren, { type: 'Call', target: name('foo'),
        args: [{ type: 'Paren', expr: name('x') }] });
    assert.equal(sum.args.length, 1);
    assert.equal(sum.args[0].type, 'Binary');
    assert.equal(sum.args[0].left.type, 'Paren');
    assert.equal(pair.args.length, 2);
    assert.deepEqual(called.args.map((/** @type {any} */ a)=>a.type), ['Name', 'Lit']);
    assert.equal(failing('Foo(1, 2)'), 1044);
    // An argument may be left out.
    assert.deepEqual(statements('obj.Do 1, , 3')[0].args.map((/** @type {any} */ a)=>a?.type
        ?? null), ['Lit', null, 'Lit']);
});

test('an assignment\'s target: a name, a member, an element, a default property', ()=>{
    const [plain, member, element, set] = statements(
        'x = 1\no.p = 2\na(1, 2) = 3\nSet o.q = Nothing');
    assert.deepEqual(plain.target, name('x'));
    assert.equal(member.target.type, 'Member');
    assert.equal(element.target.type, 'Index');
    assert.equal(element.target.args.length, 2);
    assert.equal(set.set, true);
});

test('precedence: ^ over negation over * / over \\ over Mod over + - over & over comparison',
    ()=>{
        const [expr] = parseExpressionProgram('-2 ^ 2 * 3 \\ 4 Mod 5 + 6 & 7 = 8 And Not 9')
            .body;
        const tree = shape(expr.expr);
        assert.equal(tree.op, 'and');
        assert.equal(tree.right.op, 'not');
        const compare = tree.left;
        assert.equal(compare.op, '=');
        const concat = compare.left;
        assert.equal(concat.op, '&');
        const sum = concat.left;
        assert.equal(sum.op, '+');
        const modulo = sum.left;
        assert.equal(modulo.op, 'mod');
        assert.equal(modulo.left.op, '\\');
        assert.equal(modulo.left.left.op, '*');
        assert.equal(modulo.left.left.left.type, 'Unary');
        assert.equal(modulo.left.left.left.operand.op, '^');
    });

test('one-line Ifs, block Ifs and the statements that end them', ()=>{
    const [inline, nested, block] = statements('If a Then b = 1: c = 2 Else d = 3\n'
        + 'If a Then If b Then c Else d\n'
        + 'If a Then\n  x\nElseIf b Then y\nElse\n  z\nEnd If');
    assert.equal(inline.branches[0].body.length, 2);
    assert.equal(inline.otherwise.length, 1);
    assert.equal(nested.branches[0].body[0].type, 'If');
    assert.equal(nested.branches[0].body[0].otherwise.length, 1);
    assert.equal(block.branches.length, 2);
    assert.equal(block.otherwise.length, 1);
});

test('declarations are gathered before any statement runs', ()=>{
    const program = parseProgram('x = 1\nDim a, b(2), c()\nConst K = -5\n'
        + 'Sub S(ByVal p, q): Dim local: End Sub\nClass C\nPublic f\nPrivate g(3)\n'
        + 'Public Default Property Get V: End Property\nEnd Class');
    assert.deepEqual(program.dims.map(d=>[d.key, d.dims]), [['a', null], ['b', [2]], ['c', []]]);
    assert.deepEqual(program.consts.map(c=>[c.key, c.value.value]), [['k', -5]]);
    const [sub] = program.procs;
    assert.deepEqual(sub.params.map(p=>[p.key, p.byVal]), [['p', true], ['q', false]]);
    assert.deepEqual(sub.dims.map(d=>d.key), ['local']);
    const [cls] = program.classes;
    assert.deepEqual(cls.fields.map(f=>[f.key, /** @type {any} */ (f).isPublic, f.dims]),
        [['f', true, null], ['g', false, [3]]]);
    assert.equal(cls.procs[0].isDefault, true);
});

test('compilation errors as VBScript numbers them', ()=>{
    /** @type {[string, number][]} */
    const cases = [
        ['If a Then\n', 1014], ['x = (1', 1006], ['Do\nx', 1019], ['While a\n', 1018],
        ['Select Case x\nfoo\nEnd Select', 1021], ['For x = 1\nNext', 1013],
        ['For Each x Of y\nNext', 1046], ['Exit For', 1039],
        ['Sub S: Exit Function: End Sub', 1039], ['Class C\nx = 1\nEnd Class', 1024],
        ['Dim a(n)', 1026], ['Const X = y', 1045], ['Class C\nPublic Default Property Let P(v)'
            + ': End Property\nEnd Class', 1058], ['Sub S\nSub T: End Sub\nEnd Sub', 1024],
        ['Class C\nSub Class_Initialize(a): End Sub\nEnd Class', 1053],
        ['Class C\nProperty Let P: End Property\nEnd Class', 1054],
        ['Class C\nPublic Default Function A: End Function\n'
            + 'Public Default Function B: End Function\nEnd Class', 1052],
        ['Loop', 1038], ['Next', 1055], ['x = 1 +', 1023], ['On Error Resume', 1002],
    ];
    for (const [text, code] of cases)
    {
        assert.equal(failing(text), code, text);
    }
});
