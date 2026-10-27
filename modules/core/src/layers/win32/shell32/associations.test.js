/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argify, namesFile, pathOfFileUrl, splitParameters } from './associations.js';

test('the shell splits parameters at spaces alone, halving runs of quotes', ()=>{
    // Wine's test_argify, as its comments set the rules out.
    const texts = (/** @type {string} */ raw)=>splitParameters(raw).map(p=>p.text);
    assert.deepEqual(texts('p=2 p-3 p4\tp4'), ['p=2', 'p-3', 'p4\tp4'], 'a tab is no separator');
    assert.deepEqual(texts('one"quote "p four"'), ['one', 'quote', 'p four']);
    assert.deepEqual(texts('two""quotes'), ['two"quotes']);
    assert.deepEqual(texts('"p two"p3'), ['p two', 'p3'], 'a closing quote ends the parameter');
    assert.deepEqual(texts('""twoquotes'), ['', 'twoquotes']);
    assert.deepEqual(texts('"""three quotes"'), ['"three quotes']);
    assert.deepEqual(texts('p2 "p3" "p4 is lost'), ['p2', 'p3'], 'an unclosed one is lost');
    assert.deepEqual(texts('\\"p\\three'), ['\\', 'p\\three'], 'a backslash is ordinary');
});

test('a command template is filled in with the file and the parameters', ()=>{
    // Wine's argify_tests, a sample.
    for (const [template, raw, expected] of /** @type {[string, string, string][]} */ ([
        ['%*', 'p2 p3 "p4 ', 'p2 p3 "p4 '],
        ['%2 %3 "%2" "%*"', '"p two" p3 p4  ', 'p two p3 "p two" ""p two" p3 p4  "'],
        ['"%20"', 'p', '"p0"'],
        ['~2="%~2" ~3="%~3" ~4="%~4" ~5=%~5', 'p2  p3 "p4"  p5 p6 ',
            '~2="p2  p3 "p4"  p5 p6 " ~3="  p3 "p4"  p5 p6 " ~4=" "p4"  p5 p6 " ~5=  p5 p6 '],
        ['~9="%~9"', 'p2 p3 p4 p5 p6 p7 p8   ', '~9="   "'],
        ['~9="%~9"', 'p2 p3 p4 p5 p6 p7   ', '~9=""'],
        ['"%% %- %~ %~0 %~1 %~a %~* %a %b %c %TMPDIR%"', 'p2',
            '"% - %~ %~0 %~1 %~a %~* a b c TMPDIR"'],
        ['open "%1"', '', 'open "C:\\f.txt"'],
        ['%L', '', 'C:\\f.txt'],
    ]))
    {
        assert.equal(argify(template, 'C:\\f.txt', raw), expected, template);
    }
    assert.equal(namesFile('notepad.exe'), false);
    assert.equal(namesFile('notepad.exe "%1"'), true);
    assert.equal(namesFile('x %*'), true);
});

test('a file: URL names its path when it has up to four slashes, or localhost', ()=>{
    // Wine's fileurl_tests.
    for (const [url, path] of /** @type {[string, string | null][]} */ ([
        ['file:C|/a/b%20c', 'C:\\a\\b c'], ['file:/C:/a', 'C:\\a'], ['File:///C:/a', 'C:\\a'],
        ['file:////C:/a', 'C:\\a'], ['file://///C:/a', null], ['file://localhost/C:/a', 'C:\\a'],
        ['file://LocalHost/C:/a', 'C:\\a'], ['file://127.0.0.1/C:/a', null],
        ['file://notahost/C:/a', null], ['C:\\plain', 'C:\\plain'], ['shlproto://x', 'shlproto://x'],
    ]))
    {
        assert.equal(pathOfFileUrl(url), path, url);
    }
});
