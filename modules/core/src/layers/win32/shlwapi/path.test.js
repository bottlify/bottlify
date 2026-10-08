/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { compactPath } from './path.js';

const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const ERROR_INVALID_PARAMETER = 87;

/** Both spellings of a call. */
const WIDTHS = /** @type {const} */ ([['A', false], ['W', true]]);

test('PathCreateFromUrl reads a file URL by its slashes, as Windows does', ()=>{
    // Wine's shlwapi test_PathCreateFromUrl, TEST_PATHFROMURL.
    const cases = [
        ['file:c:/foo/bar', 'c:\\foo\\bar'],
        ['file:c|/foo/bar', 'c:\\foo\\bar'],
        ['file:cx|/foo/bar', 'cx|\\foo\\bar'],
        ['file:c:foo/bar', 'c:foo\\bar'],
        ['file:c:/foo%20ba%2fr', 'c:\\foo ba/r'],
        ['file:foo%20ba%2fr', 'foo ba/r'],
        ['file:foo/bar/', 'foo\\bar\\'],
        ['file:/c:/foo/bar', 'c:\\foo\\bar'],
        ['file:\\c:/foo/bar', 'c:\\foo\\bar'],
        ['file:/cx|/foo/bar', '\\cx|\\foo\\bar'],
        ['file:/foo%20ba%2fr', '\\foo ba/r'],
        ['file://c:/foo/bar', 'c:\\foo\\bar'],
        ['file://c:/d:/foo/bar', 'c:\\d:\\foo\\bar'],
        ['file://c|/d|/foo/bar', 'c:\\d|\\foo\\bar'],
        ['file://cx|/foo/bar', '\\\\cx|\\foo\\bar'],
        ['file://c:/foo%20ba%2fr', 'c:\\foo%20ba%2fr'],
        ['file://c%3a/foo/../bar', '\\\\c:\\foo\\..\\bar'],
        ['file://foo%20ba%2fr', '\\\\foo ba/r'],
        ['file://localhost/c:/foo/bar', 'c:\\foo\\bar'],
        ['file://localhost/c:/foo%20ba%5Cr', 'c:\\foo ba\\r'],
        ['file://LocalHost/c:/foo/bar', 'c:\\foo\\bar'],
        ['file:\\\\localhost\\c:\\foo\\bar', 'c:\\foo\\bar'],
        ['file://incomplete', '\\\\incomplete'],
        ['file:///c:/foo/bar', 'c:\\foo\\bar'],
        ['File:///c:/foo/bar', 'c:\\foo\\bar'],
        ['file:///foo%20ba%2fr', '\\foo ba/r'],
        ['file:///localhost/c:/foo/bar', '\\localhost\\c:\\foo\\bar'],
        ['file:////c:/foo/bar', 'c:\\foo\\bar'],
        ['file:////c:/foo%20ba%2fr', 'c:\\foo%20ba%2fr'],
        ['file:////foo%20ba%2fr', '\\\\foo%20ba%2fr'],
        ['file://///c:/foo/bar', '\\\\c:\\foo\\bar'],
        ['file://///c:/foo%20ba%2fr', '\\\\c:\\foo ba/r'],
        ['file://////c:/foo/bar', '\\\\c:\\foo\\bar'],
        ['file:%2f%2flocalhost%2fc:/foo/bar', '//localhost/c:\\foo\\bar'],
        ['file:%5C%5Clocalhost%5Cc:/foo/bar', '\\\\localhost\\c:\\foo\\bar'],
        ['file://l%6fcalhost/c:/foo/bar', '\\\\localhostc:\\foo\\bar'],
        ['file://localhost:80/c:/foo/bar', '\\\\localhost:80c:\\foo\\bar'],
        ['file://host//c:/foo/bar', '\\\\host\\\\c:\\foo\\bar'],
        ['file://host/foo/bar', '\\\\host\\foo\\bar'],
        ['file:\\\\host\\c|\\foo\\bar', '\\\\hostc|\\foo\\bar'],
        ['file:\\%5Chost\\c:\\foo\\bar', '\\\\host\\c:\\foo\\bar'],
        ['file:\\\\host\\cx:\\foo\\bar', '\\\\host\\cx:\\foo\\bar'],
    ];
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const call = m.fns[`PathCreateFromUrl${suffix}`];
        for (const [url, path] of cases)
        {
            const out = m.put('', wide, 0x800);
            const room = m.count(0x400);
            assert.equal(call.handler([m.put(url, wide), out, room, 0]), 0, url);
            assert.equal(m.read(out, wide).toLowerCase(), path.toLowerCase(), url);
            assert.equal(m.dwordAt(room), path.length, `${url}: the length written`);
            const small = m.count(2);
            assert.equal(call.handler([m.put(url, wide), out, small, 0]) >>> 0, E_POINTER);
            assert.equal(m.dwordAt(small), path.length + 1, 'the room it needs');
        }
        for (const url of ['c:\\foo\\bar', 'foo/bar', 'http://foo/bar'])
        {
            assert.equal(call.handler([m.put(url, wide), m.put('', wide), m.count(0x400), 0])
                >>> 0, E_INVALIDARG, url);
        }
        const kept = m.count(0xdeca);
        assert.equal(call.handler([m.put('file://foo', wide), 0, kept, 0]) >>> 0, E_INVALIDARG,
            'no buffer');
        assert.equal(m.dwordAt(kept), 0xdeca, 'and the count is not touched');
        assert.equal(call.argBytes, 16);
    }
});

test('PathIsURL wants a scheme of two characters or more', ()=>{
    // Wine's TEST_PATH_IS_URL.
    const cases = /** @type {[string, number][]} */ ([
        ['http://foo/bar', 1], ['c:\\foo\\bar', 0], ['c:/foo/bar', 0], ['foo://foo/bar', 1],
        ['foo\\bar', 0], ['foo.bar', 0], ['bogusscheme:', 1], ['http:partial', 1],
        ['www.winehq.org', 0], ['winehq.org', 0], ['https://winehq.org', 1],
        ['file://does_not_exist.txt', 1], ['about:blank', 1], ['HTTP://www.winehq.org', 1],
        [' http://www.winehq.org', 0], ['', 0],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [path, expected] of cases)
        {
            assert.equal(m.fns[`PathIsURL${suffix}`].handler([m.put(path, wide)]), expected, path);
        }
        assert.equal(m.fns[`PathIsURL${suffix}`].handler([0]), 0);
    }
});

test('PathCanonicalize resolves dots between backslashes only', ()=>{
    // Wine's test_PathCanonicalizeA.
    const cases = [
        ['', '\\'],
        ['C:\\', 'C:\\'],
        [' ', ' '],
        ['one\\two', 'one\\two'],
        ['C:\\one\\.\\..\\two\\three\\..', 'C:\\two'],
        ['C:\\one/two/three\\four/five\\six', 'C:\\one/two/three\\four/five\\six'],
        ['C:\\one/.\\two', 'C:\\one/.\\two'],
        ['C:\\one/.\\two\\..', 'C:\\one/.'],
        ['../../one/two/', '../../one/two/'],
        ['../../one/two/\\*', '../../one/two/\\*'],
        ['C:\\one/.\\..\\two/three\\..\\four/.five', 'C:\\four/.five'],
    ];
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const call = m.fns[`PathCanonicalize${suffix}`];
        for (const [source, expected] of cases)
        {
            const out = m.put('test', wide);
            assert.equal(call.handler([out, m.put(source, wide)]), 1, source);
            assert.equal(m.read(out, wide), expected, source);
        }
        const out = m.put('test', wide);
        assert.equal(call.handler([out, 0]), 0, 'no source');
        assert.equal(m.read(out, wide), 'test');
        assert.equal(call.handler([0, m.put('C:\\', wide)]), 0, 'no destination');
        assert.deepEqual(m.errors, [ERROR_INVALID_PARAMETER, ERROR_INVALID_PARAMETER]);
        assert.equal(call.handler([out, m.put('a'.repeat(300), wide, 0x800)]), 0, 'too long');
    }
});

test('PathAddBackslash, PathRemoveExtension, PathStripToRoot and PathIsUNC in UTF-16', ()=>{
    // Wine's test_PathAddBackslash, in the wide spelling the ANSI tests mirror.
    const m = shlwapiMachine();
    let path = m.put('one\\two', true);
    assert.equal(m.fns.PathAddBackslashW.handler([path]), path + 8 * 2);
    assert.equal(m.read(path, true), 'one\\two\\');
    path = m.put('C:\\one\\', true);
    assert.equal(m.fns.PathAddBackslashW.handler([path]), path + 7 * 2, 'already there');
    path = m.put('', true);
    assert.equal(m.fns.PathAddBackslashW.handler([path]), path);
    assert.equal(m.read(path, true), '');
    assert.equal(m.fns.PathAddBackslashW.handler([m.put('a'.repeat(300), true, 0x800)]), 0);

    path = m.put('C:\\dir.d\\file.tar.gz', true);
    m.fns.PathRemoveExtensionW.handler([path]);
    assert.equal(m.read(path, true), 'C:\\dir.d\\file.tar');

    path = m.put('\\\\server\\share\\dir\\file', true);
    assert.equal(m.fns.PathStripToRootW.handler([path]), 1);
    assert.equal(m.read(path, true), '\\\\server\\share');
    path = m.put('dir\\file', true);
    assert.equal(m.fns.PathStripToRootW.handler([path]), 0);
    assert.equal(m.read(path, true), '');

    assert.equal(m.fns.PathIsUNCW.handler([m.put('\\\\server\\share', true)]), 1);
    assert.equal(m.fns.PathIsUNCW.handler([m.put('C:\\dir', true)]), 0);
    assert.equal(m.fns.PathIsUNCW.handler([0]), 0);
});

test('PathIsRoot is a lone backslash, a bare drive root, or a server and share', ()=>{
    const cases = /** @type {[string, number][]} */ ([
        ['\\', 1], ['C:\\', 1], ['C:', 0], ['C:\\dir', 0], ['\\\\server', 1],
        ['\\\\server\\', 1], ['\\\\server\\share', 1], ['\\\\server\\share\\', 0],
        ['\\\\server\\share\\dir', 0], ['dir', 0], ['', 0], ['\\dir', 0],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [path, expected] of cases)
        {
            assert.equal(m.fns[`PathIsRoot${suffix}`].handler([m.put(path, wide)]), expected,
                path);
        }
    }
});

test('PathSkipRoot answers a pointer just past the root, or NULL', ()=>{
    const cases = /** @type {[string, number | null][]} */ ([
        ['C:\\dir\\file', 3], ['C:\\', 3], ['C:', null], ['C:dir', null], ['\\dir', null],
        ['\\\\server\\share\\dir', 15], ['\\\\server\\share', null], ['\\\\server', null],
        ['dir\\file', null],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [path, index] of cases)
        {
            const at = m.put(path, wide);
            assert.equal(m.fns[`PathSkipRoot${suffix}`].handler([at]),
                index === null ? 0 : at + index * (wide ? 2 : 1), path);
        }
    }
});

test('PathRemoveBlanks takes the spaces off both ends', ()=>{
    // Wine's test_PathRemoveBlanks.
    const cases = [['', ''], [' ', ''], ['test', 'test'], [' test', 'test'],
        ['  test', 'test'], ['test ', 'test'], ['test  ', 'test'], [' test  ', 'test'],
        ['  test ', 'test'], ['\ttest\t', '\ttest\t']];
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [path, expected] of cases)
        {
            const at = m.put(path, wide);
            m.fns[`PathRemoveBlanks${suffix}`].handler([at]);
            assert.equal(m.read(at, wide), expected, JSON.stringify(path));
        }
        m.fns[`PathRemoveBlanks${suffix}`].handler([0]);
    }
});

test('PathRemoveFileSpec cuts the last component, a root\'s backslash kept', ()=>{
    const cases = /** @type {[string, string, number][]} */ ([
        ['C:\\dir\\file', 'C:\\dir', 1], ['C:\\file', 'C:\\', 1], ['C:\\', 'C:\\', 0],
        ['C:\\dir\\', 'C:\\dir', 1], ['C:file', 'C:', 1], ['file', '', 1], ['\\file', '\\', 1],
        ['\\', '\\', 0], ['\\\\server\\share', '\\\\server', 1], ['\\\\server', '\\\\', 1],
        ['', '', 0], ['dir/file', '', 1],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [path, expected, answer] of cases)
        {
            const at = m.put(path, wide);
            assert.equal(m.fns[`PathRemoveFileSpec${suffix}`].handler([at]), answer, path);
            assert.equal(m.read(at, wide), expected, path);
        }
        assert.equal(m.fns[`PathRemoveFileSpec${suffix}`].handler([0]), 0);
    }
});

test('PathRenameExtension replaces or adds the extension, within MAX_PATH', ()=>{
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const call = m.fns[`PathRenameExtension${suffix}`];
        let at = m.put('C:\\dir.d\\file.txt', wide);
        assert.equal(call.handler([at, m.put('.bak', wide)]), 1);
        assert.equal(m.read(at, wide), 'C:\\dir.d\\file.bak');
        at = m.put('C:\\dir.d\\file', wide);
        assert.equal(call.handler([at, m.put('.ini', wide)]), 1);
        assert.equal(m.read(at, wide), 'C:\\dir.d\\file.ini');
        at = m.put(`C:\\${'a'.repeat(254)}.x`, wide, 0x800);
        assert.equal(call.handler([at, m.put('.long', wide)]), 0, 'past MAX_PATH');
        assert.equal(m.read(at, wide), `C:\\${'a'.repeat(254)}.x`, 'untouched');
        assert.equal(call.handler([0, m.put('.x', wide)]), 0);
        assert.equal(call.argBytes, 8);
    }
});

test('PathFileExists asks the volume against the current directory', ()=>{
    /** @type {Record<string, boolean>} */
    const volume = { 'C:\\App': true, 'C:\\App\\game.exe': false };
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine({
            files: { stat: path=>(path in volume
                ? { exists: true, isDirectory: volume[path] } : null) },
            fullPath: path=>(/^[A-Za-z]:/.test(path) ? path : `C:\\App\\${path}`),
        });
        const call = m.fns[`PathFileExists${suffix}`];
        assert.equal(call.handler([m.put('C:\\App', wide)]), 1);
        assert.equal(call.handler([m.put('game.exe', wide)]), 1);
        assert.equal(call.handler([m.put('C:\\Missing', wide)]), 0);
        assert.equal(call.handler([0]), 0);
    }
    assert.equal(shlwapiMachine().fns.PathFileExistsW.handler([0x10000]), 0, 'no volume');
});

test('PathSearchAndQualify is kernel32\'s search, then its full path', ()=>{
    /** @type {string[]} */
    const calls = [];
    /** @type {any} */
    let m = null;
    /** @param {string} name @param {(args: number[]) => string | null} answer */
    const fake = (name, answer)=>({
        handler: (/** @type {number[]} */ args)=>{
            calls.push(name);
            const found = answer(args);
            const [buffer, room] = name.startsWith('Search') ? [args[4], args[3]]
                : [args[2], args[1]];
            if (found === null)
            {
                return 0;
            }
            if (found.length >= room)
            {
                return found.length + 1;
            }
            m.memory.set(name.endsWith('W') ? new Uint8Array(new Uint16Array(
                [...found, '\0'].map(c=>c.charCodeAt(0))).buffer) : new TextEncoder().encode(
                `${found}\0`), buffer);
            return found.length;
        },
    });
    const kernel32 = {
        SearchPathW: fake('SearchPathW', args=>(m.read(args[1], true) === 'win.ini'
            ? 'C:\\WINDOWS\\win.ini' : null)),
        GetFullPathNameW: fake('GetFullPathNameW', args=>`C:\\App\\${m.read(args[0], true)}`),
        SearchPathA: fake('SearchPathA', ()=>null),
        GetFullPathNameA: fake('GetFullPathNameA', args=>`C:\\App\\${m.read(args[0])}`),
    };
    m = shlwapiMachine({ library: name=>(name === 'KERNEL32.dll' ? kernel32 : undefined) });
    const out = m.put('', true, 0x400);
    assert.equal(m.fns.PathSearchAndQualifyW.handler([m.put('win.ini', true), out, 260]), 1);
    assert.equal(m.read(out, true), 'C:\\WINDOWS\\win.ini', 'found by the search');
    assert.deepEqual(calls, ['SearchPathW']);
    assert.equal(m.fns.PathSearchAndQualifyW.handler([m.put('foo', true), out, 260]), 1);
    assert.equal(m.read(out, true), 'C:\\App\\foo', 'not found: made full');
    assert.equal(m.fns.PathSearchAndQualifyW.handler([m.put('foo', true), out, 5]), 0,
        'a buffer too small');
    const narrow = m.put('', false, 0x400);
    assert.equal(m.fns.PathSearchAndQualifyA.handler([m.put('bar'), narrow, 260]), 1);
    assert.equal(m.read(narrow), 'C:\\App\\bar');
    assert.equal(shlwapiMachine().fns.PathSearchAndQualifyW.handler([0x10000, out, 260]), 0,
        'no kernel32 behind it');
});

test('each path function declares the arguments it pops, in both spellings', ()=>{
    const { fns } = shlwapiMachine();
    const expected = /** @type {Record<string, number>} */ ({
        PathIsUNC: 4, PathRemoveExtension: 4, PathStripToRoot: 4, PathAddBackslash: 4,
        PathCanonicalize: 8, PathCreateFromUrl: 16, PathFileExists: 4, PathIsRoot: 4,
        PathIsURL: 4, PathRemoveBlanks: 4, PathRemoveFileSpec: 4, PathRenameExtension: 8,
        PathSearchAndQualify: 12, PathSkipRoot: 4,
    });
    for (const [name, bytes] of Object.entries(expected))
    {
        assert.equal(fns[`${name}A`].argBytes, bytes, `${name}A`);
        assert.equal(fns[`${name}W`].argBytes, bytes, `${name}W`);
    }
});

test('PathCompactPath cuts the directories, then the name, behind an ellipsis', ()=>{
    // Six pixels a character, as a fixed-pitch font measures.
    const width = (/** @type {string} */ text)=>text.length * 6;
    const path = 'C:\\Program Files\\Infogrames\\Desperados\\setup.exe';
    assert.equal(compactPath(path, path.length * 6, width), path, 'it fits as it is');
    assert.equal(compactPath(path, 30 * 6, width), 'C:\\Program Files\\...\\setup.exe');
    assert.equal(compactPath(path, 12 * 6, width), '...setup.exe',
        'the name is kept whole while it fits behind the ellipsis');
    assert.equal(compactPath(path, 8 * 6, width), '...setup');
    assert.equal(compactPath(path, 2 * 6, width), '..', 'not even the ellipsis fits');
});
