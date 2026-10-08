/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The INF syntax as setupapi's loader accepts it; the expectations are the
 * ones Wine's setupapi parser tests establish on Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INF_ERROR, INF_STYLE_OLDNT, INF_STYLE_WIN4, infText, parseInf } from './inf.js';

const HEADER = '[Version]\r\nSignature="$CHICAGO$"\r\n';

/** @param {string} text */
const parsed = text=>{
    const result = parseInf(text, { dirid: id=>({ 10: 'C:\\WINDOWS', 24: 'C:\\' })[id] ?? null });
    assert.ok('inf' in result, `loads: ${JSON.stringify(result)}`);
    return result.inf;
};

/** One line of a [Test] section: its key and its fields. @param {string} body */
const line = body=>{
    const only = parsed(`${HEADER}[Test]\n${body}`).section('Test')?.lines[0];
    assert.ok(only, `a line in ${JSON.stringify(body)}`);
    return { key: only.key, fields: only.fields };
};

test('what makes a file a Windows INF, and the errors that stop one loading', ()=>{
    assert.equal(parsed('[version]\nsignature=$chicago$').style, INF_STYLE_WIN4);
    assert.equal(parsed('[VERSION]\nSIGNATURE=$Windows NT$,abcd').style, INF_STYLE_WIN4);
    assert.equal(parsed('[Version]\nabc=def\n[Version]\nSignature=$chicago$').style,
        INF_STYLE_WIN4, 'sections of one name are one section');
    assert.equal(parsed('[Version]\nSignature=foo').style, INF_STYLE_OLDNT);
    assert.equal(parsed('\r\n').style, INF_STYLE_OLDNT);

    assert.deepEqual(parseInf(`${HEADER}[ab\r\n`),
        { error: INF_ERROR.ERROR_BAD_SECTION_NAME_LINE, line: 3 });
    assert.deepEqual(parseInf(`${HEADER}\n\n[ab\x1a]\n`),
        { error: INF_ERROR.ERROR_BAD_SECTION_NAME_LINE, line: 5 }, 'Ctrl-Z ends the file');
    assert.deepEqual(parseInf(`${HEADER}[${'a'.repeat(256)}]\r\n`),
        { error: INF_ERROR.ERROR_SECTION_NAME_TOO_LONG, line: 3 });
    assert.ok('inf' in parseInf(`${HEADER}[${'a'.repeat(255)}]\r\n`));
});

test('lines before the first section are an error unless the file has [Strings]', ()=>{
    assert.deepEqual(parseInf(`abc\r\n${HEADER}`),
        { error: INF_ERROR.ERROR_EXPECTED_SECTION_NAME, line: 1 });
    assert.deepEqual(parseInf(`;comment\ngarbage1\ngarbage2\n[abc]\n${HEADER}`),
        { error: INF_ERROR.ERROR_EXPECTED_SECTION_NAME, line: 2 });
    assert.deepEqual(parseInf(`garbage1\ngarbage2\n${HEADER}[abc]\n`),
        { error: INF_ERROR.ERROR_EXPECTED_SECTION_NAME, line: 1 });
    assert.ok('inf' in parseInf(`garbage1\ngarbage2\n[Strings]\n${HEADER}`));
    assert.ok('inf' in parseInf(`garbage1\ngarbage2\n${HEADER}[Strings]\n`));
    assert.ok('inf' in parseInf(`;aa\n;bb\n${HEADER}`), 'comments are not lines');
});

test('a section name is everything up to the first ], and case does not matter', ()=>{
    /** @param {string} text @param {string} name */
    const has = (text, name)=>parsed(HEADER + text).section(name) !== null;
    assert.ok(has('[TESTSECTION]\r\n', 'TestSection'));
    assert.ok(has('   [TestSection]   dummy\r\n', 'testsection'),
        'the rest of the line is ignored');
    assert.ok(has(' [  Test Section  ] dummy\r\n', '  Test Section  '));
    assert.ok(has('[Test[S]ection]\r\n', 'Test[S'));
    assert.ok(has('[[[]\n', '[['));
    assert.ok(has('[]\r\n', ''));
    assert.ok(has('[Test;Section]\r\n', 'Test;Section'), 'no comment inside a name');
    assert.ok(has(' [Test\r\b\tSection] \n', 'Test\r\b\tSection'));
    assert.ok(!has(';[TestSection]\n', 'TestSection'), 'a commented-out section');
});

test('keys and fields: the first = before any comma splits them', ()=>{
    assert.deepEqual(line('ab=cd,ef,gh,ij'), { key: 'ab', fields: ['cd', 'ef', 'gh', 'ij'] });
    assert.deepEqual(line('ab'), { key: 'ab', fields: ['ab'] }, 'one field is its own key');
    assert.deepEqual(line('ab,cd'), { key: null, fields: ['ab', 'cd'] });
    assert.deepEqual(line('ab,cd=ef'), { key: null, fields: ['ab', 'cd=ef'] });
    assert.deepEqual(line('=abcd,ef'), { key: '', fields: ['abcd', 'ef'] });
    assert.deepEqual(line(',=,,b'), { key: null, fields: ['', '=', '', 'b'] });
    assert.deepEqual(line('a=b,,,c,,,d'), { key: 'a', fields: ['b', '', '', 'c', '', '', 'd'] });
    assert.deepEqual(line('a=\n'), { key: 'a', fields: [''] });
    assert.deepEqual(line('='), { key: '', fields: [''] });
    assert.deepEqual(line(' a b = c , d \n'), { key: 'a b', fields: ['c', 'd'] });
    assert.deepEqual(line(' a b\r = c\r\n'), { key: 'a b', fields: ['c'] });
    assert.deepEqual(line('HKLM,A,B,\'C\',D'),
        { key: null, fields: ['HKLM', 'A', 'B', '\'C\'', 'D'] },
        'single quotes are characters');
});

test('quotes keep what they hold and vanish, and "" inside them is one quote', ()=>{
    assert.deepEqual(line('Ab"Cd"=Ef'), { key: 'AbCd', fields: ['Ef'] });
    assert.deepEqual(line('Ab"Cd=Ef"'), { key: 'AbCd=Ef', fields: ['AbCd=Ef'] });
    assert.deepEqual(line('ab"""cd,ef=gh"'), { key: 'ab"cd,ef=gh', fields: ['ab"cd,ef=gh'] });
    assert.deepEqual(line('ab""cd=ef,gh'), { key: 'abcd', fields: ['ef', 'gh'] });
    assert.deepEqual(line('ab=cd""ef'), { key: 'ab', fields: ['cdef'] });
    assert.deepEqual(line('ab=cd","ef'), { key: 'ab', fields: ['cd,ef'] });
    assert.deepEqual(line('ab=cd",ef'), { key: 'ab', fields: ['cd,ef'] },
        'open to the end of the line');
    assert.deepEqual(line(' a b = c ," d" \n'), { key: 'a b', fields: ['c', ' d'] });
    assert.deepEqual(line('a=b,"",c," ",d'), { key: 'a', fields: ['b', '', 'c', ' ', 'd'] });
});

test('a trailing backslash joins the next line, and one followed by text is text', ()=>{
    assert.deepEqual(line('ba\\\ncd=ef'), { key: 'bacd', fields: ['ef'] });
    assert.deepEqual(line('ab  \\  \ncd=ef'), { key: 'abcd', fields: ['ef'] });
    assert.deepEqual(line('ab  \\ ;cc\ncd=ef'), { key: 'abcd', fields: ['ef'] });
    assert.deepEqual(line('ab \\ \\ \ncd=ef'), { key: 'abcd', fields: ['ef'] });
    assert.deepEqual(line('ba \\\\ \nc=d'), { key: 'bac', fields: ['d'] });
    assert.deepEqual(line('ba \\ dc=xx'), { key: 'ba \\ dc', fields: ['xx'] });
    assert.deepEqual(line('a=b\\\\c'), { key: 'a', fields: ['b\\\\c'] });
    assert.deepEqual(line('ab=cd \\ '), { key: 'ab', fields: ['cd'] });
    assert.deepEqual(line('ba=c \\ \n \\ \n a'), { key: 'ba', fields: ['ca'] });
    assert.deepEqual(line('ba=c \\ \n \\ a'), { key: 'ba', fields: ['c\\ a'] });
    assert.deepEqual(line('  \\ a= \\ b'), { key: '\\ a', fields: ['\\ b'] });
    assert.deepEqual(line('ab=cd",ef\\\nab'), { key: 'ab', fields: ['cd,ef\\'] },
        'no joining inside quotes');
});

test('Ctrl-Z ends the file and a NUL reads as a space', ()=>{
    assert.deepEqual(line('ab=c\x1ad'), { key: 'ab', fields: ['c'] });
    assert.deepEqual(line('ab\x1a=cd'), { key: 'ab', fields: ['ab'] });
    assert.deepEqual(line('abcd=ef\x00gh'), { key: 'abcd', fields: ['ef gh'] });
});

const STRINGS = '[Strings]\nfoo=aaa\nbar=bbb\nloop=%loop2%\nloop2=%loop%\n'
    + 'per%%cent=abcd\nper=1\ncent=2\nmydrive="C:\\"\n'
    + `verybig=${'a'.repeat(1200)}\n`;

test('%name% is a [Strings] entry or a DIRID, and anything else stays as it is', ()=>{
    assert.deepEqual(line(`%foo%=%bar%\n${STRINGS}`), { key: 'aaa', fields: ['bbb'] });
    assert.deepEqual(line(`%foo%xx=%bar%yy\n${STRINGS}`), { key: 'aaaxx', fields: ['bbbyy'] });
    assert.deepEqual(line(`%% %foo%=%bar%\n${STRINGS}`), { key: '% aaa', fields: ['bbb'] });
    assert.deepEqual(line(`%f"o"o%=ccc\n${STRINGS}`), { key: 'aaa', fields: ['ccc'] },
        'quotes go first');
    assert.deepEqual(line(`abc=%bar;bla%\n${STRINGS}`), { key: 'abc', fields: ['%bar'] });
    assert.deepEqual(line(`loop=%loop%\n${STRINGS}`), { key: 'loop', fields: ['%loop2%'] },
        'not substituted again');
    assert.deepEqual(line(`%per%%cent%=100\n${STRINGS}`), { key: '12', fields: ['100'] });
    assert.deepEqual(line(`a=%verybig%\n${STRINGS}`), { key: 'a', fields: ['a'.repeat(511)] });
    assert.deepEqual(line('RTM="%OTHER_NAME%",SP1\n[Strings]\nNAME=x'),
        { key: 'RTM', fields: ['%OTHER_NAME%', 'SP1'] });
});

test('a DIRID merges its trailing separator with the next, a string never does', ()=>{
    assert.deepEqual(line(`ab="%24%"\n${STRINGS}`).fields, ['C:\\']);
    assert.deepEqual(line(`ab="%24%\\fred"\n${STRINGS}`).fields, ['C:\\fred']);
    assert.deepEqual(line(`ab="%mydrive%\\fred"\n${STRINGS}`).fields, ['C:\\\\fred']);
    assert.deepEqual(line('ab="%24%\\\\fred"').fields, ['C:\\\\fred']);
    assert.deepEqual(line('ab=%10%\\system32').fields, ['C:\\WINDOWS\\system32']);
});

test('the lines of a section keep their order, merged across repeats', ()=>{
    const inf = parsed(`${HEADER}[A]\none=1\n[B]\nx\n[a]\ntwo=2\n`);
    assert.deepEqual(inf.section('a')?.lines.map(l=>l.key), ['one', 'two']);
    assert.equal(inf.value('A', 'TWO'), '2');
    assert.equal(inf.value('Version', 'signature'), '$CHICAGO$');
});

test('a UTF-16 INF is read after its byte-order mark', ()=>{
    const text = '[Version]\r\nSignature="$Windows NT$"\r\n';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    [...text].forEach((c, i)=>{
        bytes[2 + i * 2] = c.charCodeAt(0);
    });
    assert.equal(infText(bytes), text);
    assert.equal(infText(Uint8Array.from([0x61, 0xe9])), 'a\u00e9');
});

test('strings a caller adds stand beside [Strings] and over its own of the same name, taken'
    + ' as written', ()=>{
    const added = parseInf('[Version]\nSignature="$Chicago$"\n[S]\nk=%Mine%,%Theirs%,%Path%\n'
        + '[Strings]\nTheirs="file"\nMine="file"\n', {
        strings: new Map([['MINE', 'caller'], ['Path', '%SystemRoot%\\x.dll']]),
    });
    assert.ok('inf' in added);
    assert.deepEqual(added.inf.section('S')?.lines[0].fields,
        ['caller', 'file', '%SystemRoot%\\x.dll'],
        'the names fold case, and a value holding %...% is not read again');
});
