/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSICONDITION, evaluateCondition } from './condition.js';

const { FALSE, TRUE, NONE, ERROR } = MSICONDITION;

/**
 * @param {Record<string, string>} [properties]
 * @param {Record<string, string>} [variables]
 * @returns {import('./condition.js').ConditionEnvironment}
 */
const environmentOf = (properties = {}, variables = {})=>({
    property: name=>properties[name] ?? '',
    environment: name=>{
        const key = Object.keys(variables).find(k=>k.toUpperCase() === name.toUpperCase());
        return key === undefined ? null : variables[key];
    },
    component: key=>key === 'Comp' ? { installed: 2, action: 3 } : null,
    feature: key=>key === 'Feat' ? { installed: -1, action: 4 } : null,
});

/** @typedef {[string, Record<string, string>, number]} Case */

/**
 * What Windows answers in Wine's test_condition (dlls/msi/tests/package.c),
 * each case with the properties set at that point of the test.
 *
 * @type {Case[]}
 */
const WINE = [
    ['', {}, NONE],
    [' ', {}, NONE],
    ['1', {}, TRUE],
    ['0', {}, FALSE],
    ['-1', {}, TRUE],
    ['0 = 0', {}, TRUE],
    ['0 <> 0', {}, FALSE],
    ['0 = 1', {}, FALSE],
    ['0 > 1', {}, FALSE],
    ['0 ~> 1', {}, FALSE],
    ['1 > 1', {}, FALSE],
    ['1 ~> 1', {}, FALSE],
    ['0 >= 1', {}, FALSE],
    ['0 ~>= 1', {}, FALSE],
    ['1 >= 1', {}, TRUE],
    ['1 ~>= 1', {}, TRUE],
    ['0 < 1', {}, TRUE],
    ['0 ~< 1', {}, TRUE],
    ['1 < 1', {}, FALSE],
    ['1 ~< 1', {}, FALSE],
    ['0 <= 1', {}, TRUE],
    ['0 ~<= 1', {}, TRUE],
    ['1 <= 1', {}, TRUE],
    ['1 ~<= 1', {}, TRUE],
    ['0 >=', {}, ERROR],
    ['LicView <> "1"', {}, TRUE],
    ['LicView <> "0"', {}, TRUE],
    ['LicView <> LicView', {}, FALSE],
    ['not 0', {}, TRUE],
    ['not LicView', {}, TRUE],
    ['"Testing" ~<< "Testing"', {}, TRUE],
    ['LicView ~<< "Testing"', {}, FALSE],
    ['Not LicView ~<< "Testing"', {}, TRUE],
    ['not "A"', {}, FALSE],
    ['~not "A"', {}, ERROR],
    ['"0"', {}, TRUE],
    ['1 and 2', {}, TRUE],
    ['not 0 and 3', {}, TRUE],
    ['not 0 and 0', {}, FALSE],
    ['not 0 or 1', {}, TRUE],
    ['(0)', {}, FALSE],
    ['(((((1))))))', {}, ERROR],
    ['(((((1)))))', {}, TRUE],
    [' "A" < "B" ', {}, TRUE],
    [' "A" > "B" ', {}, FALSE],
    [' "1" > "12" ', {}, FALSE],
    [' "100" < "21" ', {}, TRUE],
    ['0 < > 0', {}, ERROR],
    ['(1<<1) == 2', {}, ERROR],
    [' "A" = "a" ', {}, FALSE],
    [' "A" ~ = "a" ', {}, ERROR],
    [' "A" ~= "a" ', {}, TRUE],
    [' "A" ~= 1 ', {}, FALSE],
    [' "A" = 1 ', {}, FALSE],
    [' 1 ~= 1 ', {}, TRUE],
    [' 1 ~= "1" ', {}, FALSE],
    [' 1 = "1" ', {}, FALSE],
    [' 0 = "1" ', {}, FALSE],
    [' 0 < "100" ', {}, FALSE],
    [' 100 > "0" ', {}, FALSE],
    ['1 XOR 1', {}, FALSE],
    ['1 IMP 1', {}, TRUE],
    ['1 IMP 0', {}, FALSE],
    ['0 IMP 0', {}, TRUE],
    ['0 EQV 0', {}, TRUE],
    ['0 EQV 1', {}, FALSE],
    ['1 IMP 1 OR 0', {}, TRUE],
    ['1 IMPL 1', {}, ERROR],
    ['"ASFD" >< "S" ', {}, TRUE],
    ['"ASFD" ~>< "s" ', {}, TRUE],
    ['"ASFD" ~>< "" ', {}, TRUE],
    ['"ASFD" ~>< "sss" ', {}, FALSE],
    ['mm = 5', { mm: '5' }, TRUE],
    ['mm < 6', { mm: '5' }, TRUE],
    ['mm <= 5', { mm: '5' }, TRUE],
    ['mm > 4', { mm: '5' }, TRUE],
    ['mm < 12', { mm: '5' }, TRUE],
    ['mm = "5"', { mm: '5' }, TRUE],
    ['0 = ""', {}, FALSE],
    ['0 AND ""', {}, FALSE],
    ['1 AND ""', {}, FALSE],
    ['1 AND "1"', {}, TRUE],
    ['3 >< 1', {}, TRUE],
    ['3 >< 4', {}, FALSE],
    ['NOT 0 AND 0', {}, FALSE],
    ['NOT 0 AND 1', {}, TRUE],
    ['NOT 1 OR 0', {}, FALSE],
    ['0 AND 1 OR 1', {}, TRUE],
    ['0 AND 0 OR 1', {}, TRUE],
    ['NOT 0 AND 1 OR 0', {}, TRUE],
    ['_1 = _1', {}, TRUE],
    ['( 1 AND 1 ) = 2', {}, ERROR],
    ['NOT ( 1 AND 1 )', {}, FALSE],
    ['NOT A AND (BBBBBBBBBB=2 OR CCC=1) AND Ddddddddd', {}, FALSE],
    ['Installed<>""', {}, FALSE],
    ['NOT 1 AND 0', {}, FALSE],
    ['bandalmael=0', {}, FALSE],
    ['bandalmael<>0', {}, TRUE],
    ['bandalmael<0', {}, FALSE],
    ['bandalmael>0', {}, FALSE],
    ['bandalmael>=0', {}, FALSE],
    ['bandalmael<=0', {}, FALSE],
    ['bandalmael~<>0', {}, TRUE],
    ['bandalmael=0', { bandalmael: '0' }, TRUE],
    ['bandalmael=0', { bandalmael: '' }, FALSE],
    ['bandalmael=0', { bandalmael: 'asdf' }, FALSE],
    ['bandalmael=0', { bandalmael: '0asdf' }, FALSE],
    ['bandalmael=0', { bandalmael: '0 ' }, FALSE],
    ['bandalmael=0', { bandalmael: '-0' }, TRUE],
    ['bandalmael=0', { bandalmael: '0000000000000' }, TRUE],
    ['bandalmael=0', { bandalmael: '--0' }, FALSE],
    ['bandalmael=0', { bandalmael: '0x00' }, FALSE],
    ['bandalmael=0', { bandalmael: '-' }, FALSE],
    ['bandalmael=0', { bandalmael: '+0' }, FALSE],
    ['bandalmael=0', { bandalmael: '0.0' }, FALSE],
    ['bandalmael<>0', { bandalmael: '0.0' }, TRUE],
    ['one >< two', { one: 'hi', two: 'hithere' }, FALSE],
    ['one >< two', { one: 'hithere', two: 'hi' }, TRUE],
    ['one >< two', { one: 'hello', two: 'hi' }, FALSE],
    ['one >< two', { one: 'hellohithere', two: 'hi' }, TRUE],
    ['one >< two', { one: '', two: 'hi' }, FALSE],
    ['one >< two', { one: 'hi', two: '' }, TRUE],
    ['one >< two', { one: '', two: '' }, FALSE],
    ['one >< two', { one: '1234', two: '1' }, FALSE],
    ['one >< two', { one: 'one 1234', two: '1' }, TRUE],
    ['one << two', { one: 'hithere', two: 'hi' }, TRUE],
    ['one << two', { one: 'hi', two: 'hithere' }, FALSE],
    ['one << two', { one: 'hi', two: 'hi' }, TRUE],
    ['one << two', { one: 'abcdhithere', two: 'hi' }, FALSE],
    ['one << two', { one: '', two: 'hi' }, FALSE],
    ['one << two', { one: 'hithere', two: '' }, TRUE],
    ['one << two', { one: '', two: '' }, FALSE],
    ['one << two', { one: '1234', two: '1' }, FALSE],
    ['one << two', { one: '1234 one', two: '1' }, TRUE],
    ['one >> two', { one: 'hithere', two: 'there' }, TRUE],
    ['one >> two', { one: 'hithere', two: 'hi' }, FALSE],
    ['one >> two', { one: 'there', two: 'hithere' }, FALSE],
    ['one >> two', { one: 'there', two: 'there' }, TRUE],
    ['one >> two', { one: 'abcdhithere', two: 'hi' }, FALSE],
    ['one >> two', { one: '', two: 'there' }, FALSE],
    ['one >> two', { one: 'there', two: '' }, TRUE],
    ['one >> two', { one: '', two: '' }, FALSE],
    ['one >> two', { one: '1234', two: '4' }, FALSE],
    ['one >> two', { one: 'one 1234', two: '4' }, TRUE],
    ['MsiNetAssemblySupport < "1.1.4322"', {}, TRUE],
    ['MsiNetAssemblySupport > "1.1.4322"', {}, FALSE],
    ['MsiNetAssemblySupport >= "1.1.4322"', {}, FALSE],
    ['MsiNetAssemblySupport <= "1.1.4322"', {}, TRUE],
    ['MsiNetAssemblySupport <> "1.1.4322"', {}, TRUE],
    ['MsiNetAssemblySupport ~< "1.1.4322"', {}, TRUE],
    ['MsiNetAssemblySupport < "abcd"', {}, TRUE],
    ['MsiNetAssemblySupport < "a1.1.4322"', {}, TRUE],
    ['MsiNetAssemblySupport < "1.1.4322a"', {}, TRUE],
    ['MsiNetAssemblySupport < "0000001.1.4322"', {}, TRUE],
    ['MsiNetAssemblySupport < "1.1.4322.1"', {}, TRUE],
    ['MsiNetAssemblySupport < "1.1.4322.1.1"', {}, TRUE],
    ['"2" < "1.1', {}, ERROR],
    ['"2" < "1.1"', {}, FALSE],
    ['"2" < "12.1"', {}, FALSE],
    ['"02.1" < "2.11"', {}, TRUE],
    ['"02.1.1" < "2.1"', {}, TRUE],
    ['MsiNetAssemblySupport < "1.1"', {}, TRUE],
    ['MsiNetAssemblySupport < "1"', {}, TRUE],
    ['MsiNetAssemblySupport < "0"', {}, TRUE],
    ['MsiNetAssemblySupport < "-1"', {}, TRUE],
    ['MsiNetAssemblySupport < "a"', {}, TRUE],
    ['MsiNetAssemblySupport < "!"', {}, TRUE],
    ['MsiNetAssemblySupport < "/"', {}, TRUE],
    ['MsiNetAssemblySupport < " "', {}, TRUE],
    ['MsiNetAssemblySupport < "azAZ_"', {}, TRUE],
    ['MsiNetAssemblySupport < "a[a]"', {}, TRUE],
    ['MsiNetAssemblySupport < "a[a]a"', {}, TRUE],
    ['MsiNetAssemblySupport < "[a]"', {}, TRUE],
    ['MsiNetAssemblySupport < "[a]a"', {}, TRUE],
    ['MsiNetAssemblySupport < "{a}"', {}, TRUE],
    ['MsiNetAssemblySupport < "{a"', {}, TRUE],
    ['MsiNetAssemblySupport < "[a"', {}, TRUE],
    ['MsiNetAssemblySupport < "a{"', {}, TRUE],
    ['MsiNetAssemblySupport < "a]"', {}, TRUE],
    ['MsiNetAssemblySupport < "A"', {}, TRUE],
    ['MsiNetAssemblySupport < "1.1.4322"', { MsiNetAssemblySupport: '1.1.4322' }, FALSE],
    ['MsiNetAssemblySupport < "1.1.14322"', { MsiNetAssemblySupport: '1.1.4322' }, FALSE],
    ['MsiNetAssemblySupport < "1.1.5"', { MsiNetAssemblySupport: '1.1.4322' }, TRUE],
    ['MsiNetAssemblySupport < "1.1"', { MsiNetAssemblySupport: '1.1.4322' }, FALSE],
    ['MsiNetAssemblySupport < "1"', { MsiNetAssemblySupport: '1.1.4322' }, FALSE],
    ['one < "1"', { one: '1' }, FALSE],
    ['X != ""', { X: '5.0' }, ERROR],
    ['X ="5.0"', { X: '5.0' }, TRUE],
    ['X ="5.1"', { X: '5.0' }, FALSE],
    ['X ="6.0"', { X: '5.0' }, FALSE],
    ['X ="5.0" or X ="5.1" or X ="6.0"', { X: '5.0' }, TRUE],
    ['(X ="5.0" or X ="5.1" or X ="6.0")', { X: '5.0' }, TRUE],
    ['X !="" and (X ="5.0" or X ="5.1" or X ="6.0")', { X: '5.0' }, ERROR],
    ['&nofeature', {}, FALSE],
    ['&nofeature=""', {}, TRUE],
    ['&nofeature<>3', {}, TRUE],
    ['""<>3', {}, TRUE],
    ['!nofeature=""', {}, TRUE],
    ['$nocomponent=""', {}, TRUE],
    ['?nocomponent=""', {}, TRUE],
    ['2 <= X', { A: '2', X: '50' }, TRUE],
    ['A <= X', { A: '2', X: '50' }, TRUE],
    ['A <= 50', { A: '2', X: '50' }, TRUE],
    ['2 <= X', { A: '2', X: '50val' }, FALSE],
    ['A <= X', { A: '2', X: '50val' }, TRUE],
    ['7 <= X', { A: '7', X: '50' }, TRUE],
    ['A <= X', { A: '7', X: '50' }, TRUE],
    ['A <= 50', { A: '7', X: '50' }, TRUE],
    ['2 <= X', { A: '7', X: '50val' }, FALSE],
    ['A <= X', { A: '7', X: '50val' }, FALSE],
    // By UTF-16 unit, not by collation: U+030A sorts after 'a' and before U+00E5.
    ['"a\u030a"<"\u00e5"', {}, TRUE],
    ['"a\u030a">"\u00e5"', {}, FALSE],
    ['"a\u030a"<>"\u00e5"', {}, TRUE],
    ['"a\u030a"="\u00e5"', {}, FALSE],
];

/**
 * Not in Wine's tests: what the SDK's syntax, or the rules the cases above
 * pin down, imply for the parts those tests do not reach.
 *
 * @type {Case[]}
 */
const DERIVED = [
    // The SDK's precedence, high to low: NOT AND OR XOR EQV IMP.
    ['1 XOR 1 OR 1', {}, FALSE],
    ['1 OR 1 XOR 1', {}, FALSE],
    ['0 EQV 0 XOR 1', {}, FALSE],
    ['0 IMP 0 EQV 1', {}, TRUE],
    ['1 IMP 0 IMP 0', {}, TRUE],
    ['NOT NOT 1', {}, TRUE],
    ['not 0 And 1 oR 0 xOr 0', {}, TRUE],
    ['(1 OR 0) AND (0 OR 0)', {}, FALSE],
    // Keywords are whole words only.
    ['NOTE', {}, FALSE],
    ['NOTE', { NOTE: 'x' }, TRUE],
    ['ANDY OR 0', { ANDY: '1' }, TRUE],
    // Numbers: the leading integer of the token, held at 32 bits.
    ['1.9 = 1', {}, TRUE],
    ['- = 0', {}, TRUE],
    ['-5 < -4', {}, TRUE],
    ['99999999999 = 2147483647', {}, TRUE],
    ['-99999999999 = -2147483648', {}, TRUE],
    ['P = -12', { P: '-12' }, TRUE],
    ['P = 2147483647', { P: '2147483647' }, TRUE],
    ['P = -2147483648', { P: '-2147483648' }, TRUE],
    ['P = 0', { P: '4294967296' }, FALSE],
    ['P <> 0', { P: '4294967296' }, TRUE],
    ['P = Q', { P: '010', Q: '10' }, TRUE],
    ['"010" = "10"', {}, FALSE],
    // Bitwise forms of the substring operators.
    ['P << 1', { P: '65536' }, TRUE],
    ['P >> 5', { P: '65541' }, TRUE],
    ['196613 >> 5', {}, TRUE],
    ['196613 << 3', {}, TRUE],
    ['"196613" << "3"', {}, TRUE],
    ['-1 >< 4', {}, TRUE],
    ['P ~>< 2', { P: '6' }, TRUE],
    ['196613 ~<< 3', {}, FALSE],
    // Case folding on the other comparisons.
    ['"abc" ~< "ABD"', {}, TRUE],
    ['"abc" < "ABD"', {}, FALSE],
    ['P ~<< "HEL"', { P: 'hello' }, TRUE],
    ['P ~>> "LO"', { P: 'hello' }, TRUE],
    ['P >> "LO"', { P: 'hello' }, FALSE],
    ['P ~>< "ELL"', { P: 'hello' }, TRUE],
    // Environment variables are symbols, unset ones empty.
    ['%UNSET', {}, FALSE],
    ['%path', {}, TRUE],
    ['%Path = "C:\\WINDOWS"', {}, TRUE],
    ['% Path >< "WIN"', {}, TRUE],
    ['%NUM = 3', {}, TRUE],
    ['%NUM = "3"', {}, TRUE],
    ['%', {}, ERROR],
    ['%"PATH"', {}, ERROR],
    // Known features and components are integer states.
    ['$Comp = 3', {}, TRUE],
    ['?Comp = 2', {}, TRUE],
    ['&Feat = 4', {}, TRUE],
    ['!Feat = -1', {}, TRUE],
    ['!Feat', {}, TRUE],
    ['&Feat = "4"', {}, FALSE],
    ['&Feat <> "4"', {}, TRUE],
    ['$Comp=3 AND &Feat=4', {}, TRUE],
    ['$', {}, ERROR],
    ['$3', {}, ERROR],
    // Syntax errors.
    ['(', {}, ERROR],
    [')', {}, ERROR],
    ['()', {}, ERROR],
    ['1 1', {}, ERROR],
    ['1 = 1 = 1', {}, ERROR],
    ['NOT', {}, ERROR],
    ['1 AND', {}, ERROR],
    ['AND 1', {}, ERROR],
    ['= 1', {}, ERROR],
    ['1 <<= 1', {}, ERROR],
    ['1 ~ 1', {}, ERROR],
    ['"', {}, ERROR],
    ['#A', {}, ERROR],
    ['1 + 1', {}, ERROR],
    ['1\t=\t1', {}, ERROR],
    // Identifier characters include digits, '-', '.', and '#'.
    ['A-B.C#1 = "x"', { 'A-B.C#1': 'x' }, TRUE],
    // A NUL ends the condition, as it does the C string it arrives in.
    ['1\0garbage', {}, TRUE],
    ['\0', {}, NONE],
];

for (const [label, cases] of /** @type {[string, Case[]][]} */ ([
    ['Wine', WINE], ['derived', DERIVED],
]))
{
    test(`evaluateCondition: ${label} cases`, ()=>{
        for (const [condition, properties, expected] of cases)
        {
            const env = environmentOf(properties, { Path: 'C:\\WINDOWS', NUM: '3' });
            assert.equal(evaluateCondition(condition, env), expected,
                `${JSON.stringify(condition)} with ${JSON.stringify(properties)}`);
        }
    });
}

test('evaluateCondition: optional callbacks absent read as unset and unknown', ()=>{
    /** @type {import('./condition.js').ConditionEnvironment} */
    const env = { property: ()=>'' };
    assert.equal(evaluateCondition('%PATH', env), FALSE);
    assert.equal(evaluateCondition('$Comp = ""', env), TRUE);
    assert.equal(evaluateCondition('!Feat <> 3', env), TRUE);
});

test('evaluateCondition: deep nesting is an error, not a stack overflow', ()=>{
    const env = environmentOf();
    const deep = 100000;
    assert.equal(evaluateCondition('('.repeat(deep) + '1' + ')'.repeat(deep), env), ERROR);
    assert.equal(evaluateCondition('NOT '.repeat(deep) + '1', env), ERROR);
    assert.equal(evaluateCondition('('.repeat(500) + '1' + ')'.repeat(500), env), TRUE);
});

test('evaluateCondition: a throwing callback is not swallowed as a syntax error', ()=>{
    const env = { property: ()=>{ throw new TypeError('boom'); } };
    assert.throws(()=>evaluateCondition('A', env), TypeError);
});

test('MSICONDITION is frozen with the SDK values', ()=>{
    assert.deepEqual({ ...MSICONDITION }, { FALSE: 0, TRUE: 1, NONE: 2, ERROR: 3 });
    assert.ok(Object.isFrozen(MSICONDITION));
});
