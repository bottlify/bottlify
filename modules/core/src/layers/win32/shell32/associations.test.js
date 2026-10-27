/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    argify, createAssociations, namesFile, pathOfFileUrl, splitParameters,
} from './associations.js';

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

/**
 * The classes' registry, as advapi32 answers for it: keys by path, each with
 * its values by name ('' the default).
 *
 * @param {Record<string, Record<string, string>>} keys
 */
function classes(keys){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let heap = 0x1000;
    /** @param {number} at */
    const text = at=>String.fromCharCode(...memory.subarray(at, memory.indexOf(0, at)));
    /** @type {Map<number, string>} */
    const open = new Map();
    const lower = new Map(Object.entries(keys).map(([path, values])=>[path.toLowerCase(), values]));
    const advapi = {
        RegOpenKeyExA: { handler: (/** @type {number[]} */ [, name, , , out])=>{
            const path = text(name).toLowerCase();
            if (!lower.has(path))
            {
                return 2;
            }
            const handle = 0x100 + open.size;
            open.set(handle, path);
            view.setUint32(out, handle, true);
            return 0;
        } },
        RegQueryValueExA: { handler: (/** @type {number[]} */ [key, name, , type, data])=>{
            const value = lower.get(open.get(key) ?? '')?.[name ? text(name) : ''];
            if (value === undefined)
            {
                return 2;
            }
            if (type)
            {
                view.setUint32(type, 1, true);
            }
            if (data)
            {
                memory.set(Array.from(`${value}\0`, c=>c.charCodeAt(0)), data);
            }
            return 0;
        } },
        RegEnumKeyA: { handler: (/** @type {number[]} */ [key, index, out])=>{
            const prefix = `${open.get(key)}\\`;
            const children = [...lower.keys()].filter(path=>path.startsWith(prefix)
                && !path.slice(prefix.length).includes('\\'));
            const child = children[index];
            if (child === undefined)
            {
                return 259;
            }
            memory.set(Array.from(`${child.slice(prefix.length)}\0`, c=>c.charCodeAt(0)), out);
            return 0;
        } },
        RegCloseKey: { handler: ()=>0 },
    };
    return createAssociations({
        readMemory: (at, length)=>memory.slice(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
        allocate: bytes=>{
            const at = heap;
            heap += bytes + 16;
            return at;
        },
        library: name=>(name === 'ADVAPI32.dll' ? advapi : undefined),
    });
}

test('a class is found by its extension, or as the extension itself with a shell', ()=>{
    const found = classes({
        '.qqqq': { '': 'exefile' },
        '.own': {}, '.own\\shell': {}, '.own\\shell\\open': {},
        '.own\\shell\\open\\command': { '': 'own.exe "%1"' },
    });
    assert.equal(found.classOf('.qqqq'), 'exefile');
    assert.equal(found.classOf('.own'), '.own');
    assert.equal(found.classOf('.none'), null);
    assert.equal(found.commandOf('.own', null)?.value, 'own.exe "%1"');
});

test('the classes Windows ships for programs run the file itself', ()=>{
    const found = classes({});
    assert.equal(found.classOf('.exe'), 'exefile');
    assert.equal(found.classOf('.BAT'), 'batfile');
    assert.deepEqual(found.commandOf('exefile', null),
        { verb: 'open', value: '"%1" %*', expand: false });
    assert.equal(found.commandOf('exefile', 'runas')?.value, '"%1" %*');
    assert.equal(found.commandOf('exefile', 'print'), null, 'no other verb');
    assert.equal(found.commandOf('qqqq', null), null);
});

test('a scheme is a class with a URL Protocol value, and its verb defaults', ()=>{
    const found = classes({
        shlproto: { 'URL Protocol': '' }, 'shlproto\\shell': {}, 'shlproto\\shell\\averb': {},
        'shlproto\\shell\\averb\\command': { '': 'child.exe "%1"' },
        fakeproto: {},
    });
    assert.equal(found.isProtocol('shlproto'), true);
    assert.equal(found.isProtocol('fakeproto'), false);
    assert.equal(found.isProtocol('notaproto'), false);
    assert.deepEqual(found.commandOf('shlproto', null),
        { verb: 'averb', value: 'child.exe "%1"', expand: false }, 'its first verb');
});
