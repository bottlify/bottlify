/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The expectations are the answers Windows gives in Wine's conformance tests
 * (format.c's test_formatrecord and test_formatrecord_package, package.c's
 * test_formatrecord2 and test_formatrecord_tables, custom.c's
 * test_format_record). Where Wine marks an answer todo_wine, the line here
 * carries Windows' answer, not Wine's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRecord } from './format.js';

/**
 * @typedef {Record<number, string | number | null>} Fields
 * @typedef {[string | null, Fields, string]} Case   template, fields 1..n, expected
 */

/**
 * @param {string | number | null} template
 * @param {Fields} [fields]
 * @param {number} [count]
 * @returns {import('./format.js').FormatRecord}
 */
const record = (template, fields = {}, count = 12)=>({
    count,
    field: index=>(index === 0 ? template : fields[index] ?? null),
});

/**
 * A package: properties by name, and optional table answers.
 *
 * @param {Record<string, string>} [properties]
 * @param {Partial<import('./format.js').FormatEnvironment>} [rest]
 * @returns {import('./format.js').FormatEnvironment}
 */
const pkg = (properties = {}, rest = {})=>({
    property: name=>(Object.hasOwn(properties, name) ? properties[name] : ''),
    ...rest,
});

/**
 * @param {Case[]} cases
 * @param {import('./format.js').FormatEnvironment | null} env
 */
const check = (cases, env)=>{
    for (const [template, fields, expected] of cases)
    {
        assert.equal(formatRecord(record(template, fields), env), expected,
            `template ${JSON.stringify(template)}`);
    }
};

const BOO_HOO = { 1: 'boo', 2: 'hoo' };
const HOO = { 1: 'hoo' };
/** The fields test_formatrecord keeps reusing for its nesting cases. */
const NEST = { 1: '2', 2: 'hey', 3: '1', 12: 'big' };
const ONE_TWO_THREE = { 1: '1', 2: '2', 3: '3', 12: 'big' };

test('a record without a template is formatted as numbered fields', ()=>{
    assert.equal(formatRecord(record(null, {}, 0), null), '');
    assert.equal(formatRecord(record(null, {}, 4), null), '1:  2:  3:  4:  ');
    assert.equal(formatRecord(record(null, {}, 6), null), '1:  2:  3:  4:  5:  6:  ');
    assert.equal(formatRecord(record('', BOO_HOO, 6), null), '1: boo 2: hoo 3:  4:  5:  6:  ');
    assert.equal(formatRecord(record('', { 1: '123', 2: 4567 }, 6), null),
        '1: 123 2: 4567 3:  4:  5:  6:  ');
    assert.equal(formatRecord(record(null, {}, 12), pkg()),
        '1:  2:  3:  4:  5:  6:  7:  8:  9:  10:  11:  12:  ');
});

test('fields are expanded on their own before the default template reads them', ()=>{
    const fields = { 1: '[2]', 2: 'stuff', 3: 'prop', 4: '[prop]', 5: '[noprop]' };
    const out = formatRecord(record(null, fields), pkg({ prop: 'val' }));
    assert.equal(out, '1: [2] 2: stuff 3: prop 4: val 5:  6:  7:  8:  9:  10:  11:  12:  ');
    assert.equal(out.length, 66);

    const tables = pkg({ imaprop: 'ringer' }, { environment: name=>(name === 'crazyvar'
        ? 'crazyval' : null) });
    /** @param {string | null} template @param {string} field */
    const one = (template, field)=>formatRecord(record(template, { 1: field }, 1), tables);
    assert.equal(one(null, '[idontexist]'), '1:  ');
    assert.equal(one(null, '[imaprop]'), '1: ringer ');
    assert.equal(one('1: [1] ', '[imaprop]'), '1: ringer ');
    assert.equal(one('1: [1] ', '[%idontexist]'), '1:  ');
    assert.equal(one('1: [1] ', '[%crazyvar]'), '1: crazyval ');
});

test('field references without a package', ()=>{
    check([
        ['%1', {}, '%1'],
        ['[1]', {}, ''],
        ['[1]', { 1: 'boo hoo' }, 'boo hoo'],
        ['[1] [2]', BOO_HOO, 'boo hoo'],
        // Field 0 is the template as written; it is not expanded a second time.
        ['[1] test [0]', BOO_HOO, 'boo test [1] test [0]'],
        ['[[1]] [2]', { 1: '2', 2: 'hey' }, 'hey hey'],
        ['[[1]] [2]', { 1: '[2]', 2: 'hey' }, '[[2]] hey'],
        ['[[[3]]] [2]', { 1: '2', 2: 'hey', 3: '1' }, 'hey hey'],
        ['[[3][1]] [2]', NEST, 'big hey'],
        ['[[3][4][1]] [2]', NEST, 'big hey'],
        ['[[3][[4]][1]] [2]', NEST, '[1[]2] hey'],
        ['[1]', { 1: 123456 }, '123456'],
        ['[1] [2]', { 1: 100, 2: -100 }, '100 -100'],
        ['[100]', {}, ''],
        ['[01]', HOO, 'hoo'],
        ['[ 1]', HOO, '[ 1]'],
        ['[01.]', HOO, '[01.]'],
        ['[-1]', {}, '[-1]'],
        ['[0]', {}, '[0]'],
        ['[1]', { 1: '[2]', 2: 'foo' }, '[2]'],
        ['[1{{boo}}]', HOO, '[1]'],
    ], null);
});

test('without a package, properties and the other forms stay as written', ()=>{
    check([
        ['[1] [2] [\\3asdf]', BOO_HOO, 'boo hoo [\\3asdf]'],
        ['[1] [2] [\\x]', BOO_HOO, 'boo hoo [\\x]'],
        ['[\\x]', {}, '[\\x]'],
        ['{\\x}', {}, '{\\x}'],
        ['[abc\\x]', {}, '[abc\\x]'],
        ['[\\[]Bracket Text[\\]]', {}, '[\\[]Bracket Text[\\]]'],
        ['[\\[]', HOO, '[\\[]'],
        ['[1] [2] [property]', BOO_HOO, 'boo hoo [property]'],
        ['[1] [~] [2]', BOO_HOO, 'boo [~] hoo'],
        ['[~]', {}, '[~]'],
        ['[]', {}, '[]'],
        ['{[]}', {}, '{[]}'],
        ['[foo]', HOO, '[foo]'],
        ['[%FOO]', {}, '[%FOO]'],
    ], null);
});

test('unbalanced brackets and braces without a package', ()=>{
    check([
        // More openers than closers: nothing is expanded.
        ['[[[3][[4]][1]] [2]', NEST, '[[[3][[4]][1]] [2]'],
        ['[a[1]b', { 1: '2' }, '[a[1]b'],
        ['[[3][[4]][1]] [2]]', NEST, '[1[]2] hey]'],
        ['a[1]b]', { 1: '2' }, 'a2b]'],
        [']a[1]b', { 1: '2' }, ']a2b'],
        ['[1]}', HOO, 'hoo}'],
        ['\\[1]', { 1: '2' }, '\\2'],
        ['\\{[1]}', { 1: '2' }, '\\2'],
        ['{{[1]}', HOO, '{{hoo}'],
        ['{{ {[1]}', HOO, '{{ {hoo}'],
        ['{{ {{[1]}', HOO, '{{ {{hoo}'],
        ['{{ {{a}', {}, '{{ {{a}'],
        [' {{a}}}', {}, ' }'],
        ['{[1{{bo}o}}]}', HOO, '{[1{{bo}o}}]}'],
    ], null);
});

test('groups without a package', ()=>{
    check([
        ['{[3][1]} [2]', NEST, '12 hey'],
        ['[{[3][1]}] [2]', NEST, '[12] hey'],
        ['{test} [2]', NEST, '{test} hey'],
        ['{[test]} [2]', NEST, '{[test]} hey'],
        ['{[1][2][3][4]} [2]', NEST, ' hey'],
        ['{[1][2][3][dummy]} [2]', NEST, '{2hey1[dummy]} hey'],
        ['{[1][2][3][4][dummy]} [2]', NEST, '{2hey1[dummy]} hey'],
        ['{{[1][2]}[3][4][dummy]}', NEST, '{{2hey}1[dummy]}'],
        ['{{[1][2]}[3]{[4][dummy]}}', NEST, ''],
        ['{{[1][2]}[3]} {[1][2]}', ONE_TWO_THREE, '{{12}3} {12}'],
        ['{[1][2]} {{[1][2]}[3]} {[1][2]}', ONE_TWO_THREE, '12 {{12}3} {12}'],
        ['{[4]}{[1][2]} {{[1][2]}[3]} {[1][2]}', ONE_TWO_THREE, '12 {{12}3} {12}'],
        ['{blah} {[4]}{[1][2]} {{[1][2]}[3]} {[1][2]}', ONE_TWO_THREE,
            '{blah} 12 {{12}3} {12}'],
        ['{{[1]}[2]} {[4]}{[1][2]}', ONE_TWO_THREE, '{{1}2} {}{12}'],
        ['{{[1]}} {[4]}{[1][2]}', ONE_TWO_THREE, ' 12'],
        ['{[1] [2]}', BOO_HOO, 'boo hoo'],
        ['{}', {}, ''],
        ['{foo}', {}, '{foo}'],
        ['{boo [1]}', HOO, 'boo hoo'],
        ['{{[1]}}', HOO, ''],
        ['{{[1]} }', HOO, '{{hoo} }'],
        ['{{ [1]}}', HOO, ''],
        ['{{[1] }}', HOO, ''],
        ['{{a}{b}{c }{ d}{any text}}', {}, ''],
        ['{{a} }', {}, '{{a} }'],
        ['{{a} {b}}', {}, ''],
        ['{{a b}}', {}, ''],
        ['{ }', {}, '{ }'],
        ['a{b[1]c}d', { 1: null }, 'ad'],
        ['{a[0]b}', { 1: 'foo' }, 'a{a[0]b}b'],
        ['{abcd}', {}, '{abcd}'],
        ['{a[one]bc[two]de[one]f}', {}, '{a[one]bc[two]de[one]f}'],
        ['{a[one]bc[bad]de[two]f}', {}, '{a[one]bc[bad]de[two]f}'],
        ['{[bad]}', {}, '{[bad]}'],
        ['{abc{d[one]ef}', {}, '{abc{d[one]ef}'],
        ['{abc{d[one]ef}}', {}, '{abc{d[one]ef}}'],
        ['{abc}{{def}hi{j[one]k}}', {}, '{abc}'],
        ['{{def}hi{j[one]k}}', {}, ''],
        ['{{def}hi{jk}}', {}, ''],
        ['{{def}{jk}}', {}, ''],
        ['{{def}}', {}, ''],
        ['{a{b}c}', {}, '{a{b}c}'],
        ['{a{b}}', {}, '{a{b}}'],
        ['{{b}c}', {}, '{{b}c}'],
        ['[1] {[noprop] [twoprop]} {abcdef}', { 1: 'one' }, 'one {[noprop] [twoprop]} {abcdef}'],
        ['[1] {[noprop] [one]} {abcdef}', { 1: 'one' }, 'one {[noprop] [one]} {abcdef}'],
        ['[1] {[one]} {abcdef}', { 1: 'one' }, 'one {[one]} {abcdef}'],
    ], null);
});

test('only the length of two answers is pinned down', ()=>{
    // Windows' text for these is recorded as todo in Wine and not reproduced;
    // the length it reports is.
    assert.equal(formatRecord(record('{[1.} [1]', HOO), null).length, 9);
    assert.equal(formatRecord(record('[{{boo}}1]', HOO), null).length, 3);
});

test('escapes with a package', ()=>{
    check([
        ['[1] [2] [\\3asdf]', BOO_HOO, 'boo hoo 3'],
        ['[1] [2] [\\x]', BOO_HOO, 'boo hoo x'],
        ['[\\x]', {}, 'x'],
        ['{\\x}', {}, '{\\x}'],
        ['[abc\\x]', {}, ''],
        ['[abc\\xdef]', {}, ''],
        ['\\x', {}, '\\x'],
        ['[\\[', {}, '[\\['],
        ['[\\[]', {}, '['],
        ['[[]', {}, '[[]'],
        ['[\\[]]', {}, '[]'],
        ['[\\[a]', {}, '['],
        ['[\\b]', {}, 'b'],
        ['[\\c]', {}, 'c'],
        ['[\\[]prop]', {}, '[prop]'],
        ['[\\a]prop]', {}, 'aprop]'],
        ['[\\[]Bracket Text[\\]]', {}, '[Bracket Text]'],
        ['[\\xabcd]', {}, 'x'],
        ['[abcd\\xefgh]', {}, ''],
        ['[1] [2] [[3]]', { 1: 'boo', 2: 'hoo', 3: '\\help' }, 'boo hoo h'],
    ], pkg({ prop: 'val', b: 'ball' }));
});

test('[~] is a NUL character with a package', ()=>{
    const env = pkg();
    assert.equal(formatRecord(record('[1] [~] [2]', BOO_HOO), env), 'boo \0 hoo');
    assert.equal(formatRecord(record('[1] [~abc] [2]', BOO_HOO), env), 'boo  hoo');
    assert.equal(formatRecord(record('x[~]x', HOO, 2), env), 'x\0x');
    assert.equal(formatRecord(record('[~]np', {}, 1), env), '\0np');
});

test('properties with a package', ()=>{
    check([
        ['[prop]', {}, 'val'],
        ['[prop] [pro\\pblah] [prop]', {}, 'val  val'],
        ['[1] [dummy] [2]', BOO_HOO, 'boo Bork hoo'],
        ['[1] [invalid] [2]', BOO_HOO, 'boo  hoo'],
        ['[foo][1]', HOO, 'hoo'],
        ['[foo.$%}][1]', HOO, 'hoo'],
    ], pkg({ prop: 'val', dummy: 'Bork' }));

    const nesting = pkg({ dummy: 'Bork', dummya: 'foo', dummyb: 'baa', adummyc: 'whoa' });
    assert.equal(formatRecord(record('[dummy[1]] [dummy[2]] [[1]dummy[3]]',
        { 1: 'a', 2: 'b', 3: 'c' }), nesting), 'foo baa whoa');

    const escaped = pkg({ dummya: '1', dummyb: 'a', dummyc: '\\blath', dummyd: '[\\blath]' });
    assert.equal(formatRecord(record('[dummyc] [[dummyc]] [dummy[dummyb]]',
        { 1: 'aaa', 2: 'bbb', 3: 'ccc' }), escaped), '\\blath b 1');

    assert.equal(formatRecord(record('[fmtprop]', {}, 1), pkg({ fmtprop: 'foobar' })), 'foobar');
    assert.equal(formatRecord(record('foo [1]', { 1: 123 }, 1), pkg()), 'foo 123');
});

test('a property value is not expanded again', ()=>{
    /** @param {string} template @param {Record<string, string>} props */
    const run = (template, props)=>formatRecord(record(template), pkg({ PropA: 'surprise',
        ...props }));
    assert.equal(run('[PropC]', { PropB: '[PropA]', PropC: '[PropB]' }), '[PropB]');
    assert.equal(run('[PropC]', { PropB: 'PropA', PropC: 'PropB' }), 'PropB');
    assert.equal(run('[[PropC]]', { PropB: '[PropA]', PropC: '[PropB]' }), '');
    assert.equal(run('[[PropC]]', { PropB: '[PropA]', PropC: 'PropB' }), '[PropA]');
    assert.equal(run('[[PropC]]', { PropB: 'PropA', PropC: 'PropB' }), 'PropA');
    assert.equal(run('[[[PropC]]]', { PropB: 'PropA', PropC: 'PropB' }), 'surprise');
});

test('groups with a package vanish when a property in them is unset', ()=>{
    check([
        ['{abcd}', {}, '{abcd}'],
        ['{a[one]bc[two]de[one]f}', {}, 'amercurybcvenusdemercuryf'],
        ['{a[one]bc[bad]de[two]f}', {}, ''],
        ['{[bad]}', {}, ''],
        ['{abc}{{def}hi{j[one]k}}', {}, '{abc}'],
        ['{{def}hi{j[one]k}}', {}, ''],
        ['[1] {[noprop] [twoprop]} {abcdef}', { 1: 'one' }, 'one  {abcdef}'],
        ['[1] {[noprop] [one]} {abcdef}', { 1: 'one' }, 'one  {abcdef}'],
        ['[1] {[one]} {abcdef}', { 1: 'one' }, 'one mercury {abcdef}'],
    ], pkg({ one: 'mercury', two: 'venus', bad: '' }));
});

test('environment variables', ()=>{
    const env = pkg({}, { environment: name=>(name === 'FOO' ? 'BAR' : null) });
    assert.equal(formatRecord(record('[%FOO]', {}, 2), env), 'BAR');
    assert.equal(formatRecord(record('[[1]]', { 1: '%FOO' }, 2), env), 'BAR');
    assert.equal(formatRecord(record('[%NONE]x', {}, 2), env), 'x');
    // A package without the callback knows no variables.
    assert.equal(formatRecord(record('[%FOO]x', {}, 2), pkg()), 'x');
});

test('files and components through the package tables', ()=>{
    const ROOT = 'C:\\';
    const LONG = `${ROOT}I am a really long directory\\`;
    /** @type {Record<string, string>} */
    const files = { frontal_file: `${ROOT}frontal.txt`, temporal_file: `${LONG}temporal.txt` };
    /** @type {Record<string, string>} */
    const shortNames = { temporal_file: `${ROOT}IAMARE~1\\temporal.txt` };
    /** @type {Record<string, string>} */
    const components = { temporal: LONG, parietal: 'C:\\source\\' };
    /** @type {[string, boolean][]} */
    const asked = [];
    const env = pkg({}, {
        file: (key, short)=>
        {
            asked.push([key, short]);
            return (short ? shortNames[key] : undefined) ?? files[key] ?? null;
        },
        component: key=>components[key] ?? null,
    });
    /** @param {string} field */
    const one = field=>formatRecord(record(null, { 1: field }, 1), env);

    assert.equal(one('[#frontal_file]'), `1: ${ROOT}frontal.txt `);
    // The short form asks for the short name; the package answers the long
    // one when the file does not exist yet.
    assert.equal(one('[!frontal_file]'), `1: ${ROOT}frontal.txt `);
    assert.equal(one('[#temporal_file]'), `1: ${LONG}temporal.txt `);
    assert.equal(one('[!temporal_file]'), `1: ${ROOT}IAMARE~1\\temporal.txt `);
    assert.deepEqual(asked, [['frontal_file', false], ['frontal_file', true],
        ['temporal_file', false], ['temporal_file', true]]);
    assert.equal(one('[#nofile]'), '1:  ');
    assert.equal(one('[$temporal]'), `1: ${LONG} `);
    assert.equal(one('[$parietal]'), '1: C:\\source\\ ');
    assert.equal(one('[$nocomp]'), '1:  ');
    // Before costing the package knows no paths at all.
    assert.equal(formatRecord(record(null, { 1: '[#frontal_file]' }, 1), pkg()), '1:  ');

    // An unknown file is not an unset property: the group survives it.
    assert.equal(formatRecord(record('{a[#nofile]b}'), env), '{ab}');
    assert.equal(formatRecord(record('{a[#nofile]b}'), null), '{a[#nofile]b}');
});

test('inside a deferred custom action', ()=>{
    const env = pkg({ CustomActionData: 'data', ProductCode: '{GUID}', UserSID: 'S-1-5',
        TESTPATH: 'C:\\x' }, {
        deferred: true,
        file: ()=>'C:\\file.txt',
        component: ()=>'C:\\dir\\',
        environment: name=>(name === 'FOO' ? 'BAR' : null),
    });
    assert.equal(formatRecord(record('[CustomActionData]|[ProductCode]|[UserSID]'), env),
        'data|{GUID}|S-1-5');
    assert.equal(formatRecord(record('<[TESTPATH]>'), env), '<>');
    assert.equal(formatRecord(record('{x[TESTPATH]}'), env), '');
    assert.equal(formatRecord(record('<[#key]><[!key]><[$comp]>'), env), '<><><>');
    assert.equal(formatRecord(record('[%FOO] [1] [\\x] [~]', { 1: 'f' }), env), 'BAR f x \0');
});

test('field values are cut at a NUL, and an empty one is a null field', ()=>{
    // A field that expands to a NUL ends there, as a record stores it.
    assert.equal(formatRecord(record('<[1]>', { 1: 'a[~]b' }, 1), pkg()), '<a>');
    assert.equal(formatRecord(record('{<[1]>}', { 1: '[~]' }, 1), pkg()), '');
    assert.equal(formatRecord(record('{<[1]>}', { 1: '' }, 1), null), '');
    assert.equal(formatRecord(record('<[2]>', { 1: 'a', 2: 'b' }, 1), null), '<>');
    assert.equal(formatRecord(record(7, {}, 0), null), '7');
});
