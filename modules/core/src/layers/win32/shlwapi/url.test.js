/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;

const URL_DONT_SIMPLIFY = 0x08000000;
const URL_ESCAPE_SPACES_ONLY = 0x04000000;
const URL_DONT_ESCAPE_EXTRA_INFO = 0x02000000;
const URL_UNESCAPE = 0x10000000;
const URL_ESCAPE_UNSAFE = 0x20000000;
const URL_UNESCAPE_INPLACE = 0x00100000;

const WIDTHS = /** @type {const} */ ([['A', false], ['W', true]]);

/**
 * A call that answers into a counted buffer, made with plenty of room.
 *
 * @param {ReturnType<typeof shlwapiMachine>} m @param {string} name @param {boolean} wide
 * @param {number[]} before  the arguments before the buffer
 * @param {number[]} [after]  and after the count
 */
const counted = (m, name, wide, before, after = [])=>{
    const out = m.put('', wide, 0x1000);
    const room = m.count(0x400);
    const hr = m.fns[name].handler([...before, out, room, ...after]) >>> 0;
    return { hr, text: m.read(out, wide), length: m.dwordAt(room) };
};

test('UrlCanonicalize lowers the scheme and an http host, and resolves dots', ()=>{
    // Wine's test_UrlCanonicalizeA, its http, file and drive tables.
    const cases = /** @type {[string, number, string][]} */ ([
        ['http://www.winehq.org/tests/../tests/', 0, 'http://www.winehq.org/tests/'],
        ['http://www.winehq.org', 0, 'http://www.winehq.org/'],
        ['http://a/b/', 0, 'http://a/b/'],
        ['http://a/b/.', 0, 'http://a/b/'],
        ['http://a/b/./c', 0, 'http://a/b/c'],
        ['http://a/b/..', 0, 'http://a/'],
        ['http://a/b/..', URL_DONT_SIMPLIFY, 'http://a/b/..'],
        ['http://a/b/../c/../..', 0, 'http://a/'],
        ['http://a/b/../../../c', 0, 'http://a/c'],
        ['http://a/b?c/./d', 0, 'http://a/b?c/./d'],
        ['http://a/b#c/./d', 0, 'http://a/b#c/./d'],
        ['http://a/b\\c', 0, 'http://a/b/c'],
        ['http://a/b &c', 0, 'http://a/b &c'],
        ['ftp://a/b\\c', 0, 'ftp://a/b\\c'],
        ['hTtP://A/b/../../C', 0, 'http://a/C'],
        ['wInE://A/B', 0, 'wine://A/B'],
        ['http:a/..', 0, 'http:'],
        ['http://www.winehq.org/tests\n', URL_ESCAPE_SPACES_ONLY | URL_ESCAPE_UNSAFE,
            'http://www.winehq.org/tests'],
        ['http://www.winehq.org/tests/foo bar', URL_ESCAPE_SPACES_ONLY
            | URL_DONT_ESCAPE_EXTRA_INFO, 'http://www.winehq.org/tests/foo%20bar'],
        ['http://www.winehq.org/tests/foo%20bar', 0, 'http://www.winehq.org/tests/foo%20bar'],
        ['http://www.winehq.org/tests/foo%20bar', URL_UNESCAPE,
            'http://www.winehq.org/tests/foo bar'],
        ['mailto://a/b/./c/../d\\e', 0, 'mailto://a/b/./c/../d\\e'],
        ['about:a/b &c', 0, 'about:a/b &c'],
        ['javascript://a/b%20%26c', URL_UNESCAPE, 'javascript://a/b &c'],
        ['file://a:/b', 0, 'file:///a:/b'],
        ['file://a:/b/../..', 0, 'file:///a:/'],
        ['file:///a/.', 0, 'file:///a/'],
        ['file:/a', 0, 'file:///a'],
        ['file:/a:/b/../..', 0, 'file:///a:/'],
        ['file:a:', 0, 'file:///a:'],
        ['fIlE://A/B', 0, 'file://A/B'],
        ['file://C:/user/file/../asdf', 0, 'file:///C:/user/asdf'],
        ['file:////C:/user/file', 0, 'file:///C:/user/file'],
        ['file:///c:\\tests\\foo bar', 0, 'file:///c:/tests/foo bar'],
        ['file://a/b !"$%&\'()*+,-:;<=>@[]^_`{|}~c', URL_ESCAPE_UNSAFE,
            'file://a/b%20!%22$%%26\'()*+,-:;%3C=%3E@%5B%5D%5E_%60%7B%7C%7D~c'],
        ['q:/a', 0, 'file:///q:/a'],
        ['q:/a/..', 0, 'file:///q:/'],
        ['q:\\a/b', 0, 'file:///q:/a/b'],
        ['q:/a/b !"$%&\'()*+,-:;<=>@[]^_`{|}~c', 0,
            'file:///q:/a/b%20!%22$%25%26\'()*+,-:;%3C=%3E@%5B%5D%5E_%60%7B%7C%7D~c'],
        ['q:/a/b%20%26c', 0, 'file:///q:/a/b%2520%2526c'],
        ['q:/a/b%20%26c', URL_UNESCAPE, 'file:///q:/a/b &c'],
        ['q:/a/b%20%26c', URL_UNESCAPE | URL_ESCAPE_UNSAFE, 'file:///q:/a/b%20%26c'],
        ['\\\\a', 0, 'file://a/'],
        ['\\\\A/B', 0, 'file://A/B'],
        ['', 0, ''],
        ['a', 0, 'a'],
        ['.', 0, '/'],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [url, flags, expected] of cases)
        {
            const { hr, text, length } = counted(m, `UrlCanonicalize${suffix}`, wide,
                [m.put(url, wide)], [flags]);
            assert.equal(hr, S_OK, url);
            assert.equal(text, expected, `${url} with ${flags.toString(16)}`);
            assert.equal(length, expected.length, url);
        }
    }
});

test('UrlCanonicalize answers its buffer as the documentation counts it', ()=>{
    // Wine's test_UrlCanonicalizeA parameter checks.
    const m = shlwapiMachine();
    const url = 'http://www.winehq.org/tests/';
    const call = m.fns.UrlCanonicalizeA;
    const out = m.put('', false, 0x200);
    let room = m.count(0x80);
    assert.equal(call.handler([0, out, room, 0]) >>> 0, E_INVALIDARG);
    assert.equal(call.handler([m.put(url), 0, room, 0]) >>> 0, E_INVALIDARG);
    assert.equal(m.dwordAt(room), 0x80, 'the count untouched');
    assert.equal(call.handler([m.put(url), out, 0, 0]) >>> 0, E_INVALIDARG);
    room = m.count(0);
    assert.equal(call.handler([m.put(url), out, room, 0]) >>> 0, E_INVALIDARG);
    assert.equal(m.dwordAt(room), 0);
    for (const size of [url.length - 1, url.length])
    {
        room = m.count(size);
        assert.equal(call.handler([m.put(url), out, room, 0]) >>> 0, E_POINTER);
        assert.equal(m.dwordAt(room), url.length + 1);
    }
    for (const size of [url.length + 1, url.length + 2])
    {
        room = m.count(size);
        assert.equal(call.handler([m.put(url), out, room, 0]) >>> 0, S_OK);
        assert.equal(m.dwordAt(room), url.length);
    }
});

test('UrlCombine resolves a relative URL against a base', ()=>{
    // Wine's TEST_COMBINE, the cases outside the mk: and .htm(l) rules.
    const cases = /** @type {[string, string, number, string][]} */ ([
        ['http://www.winehq.org/tests', 'tests1', 0, 'http://www.winehq.org/tests1'],
        ['http://www.%77inehq.org/tests', 'tests1', 0, 'http://www.%77inehq.org/tests1'],
        ['http://www.winehq.org/tests/', '../tests3', 0, 'http://www.winehq.org/tests3'],
        ['http://www.winehq.org/tests/test1', 'test2', 0, 'http://www.winehq.org/tests/test2'],
        ['http://www.winehq.org/tests/../tests', 'tests4', 0, 'http://www.winehq.org/tests4'],
        ['http://www.winehq.org/tests/../tests/', 'tests5', 0,
            'http://www.winehq.org/tests/tests5'],
        ['http://www.winehq.org/tests/../tests/', '/tests6/..', 0, 'http://www.winehq.org/'],
        ['http://www.winehq.org/tests/../tests/', '\\tests6\\..', 0, 'http://www.winehq.org/'],
        ['http://www.winehq.org/tests/../tests/..', 'tests7/..', 0, 'http://www.winehq.org/'],
        ['http://www.winehq.org/tests/?query=x&return=y', 'tests8', 0,
            'http://www.winehq.org/tests/tests8'],
        ['http://www.winehq.org/tests/#example', 'tests9', 0,
            'http://www.winehq.org/tests/tests9'],
        ['http://www.winehq.org/tests/../tests/', '/tests10/..', URL_DONT_SIMPLIFY,
            'http://www.winehq.org/tests10/..'],
        ['http://www.winehq.org/tests/../', 'tests11', URL_DONT_SIMPLIFY,
            'http://www.winehq.org/tests/../tests11'],
        ['http://www.winehq.org/test12', '#', 0, 'http://www.winehq.org/test12#'],
        ['http://www.winehq.org/test13#aaa', '#bbb', 0, 'http://www.winehq.org/test13#bbb'],
        ['http://www.winehq.org/test14#aaa/bbb#ccc', '#', 0, 'http://www.winehq.org/test14#'],
        ['http://www.winehq.org/tests/?query=x/y/z', 'tests15', 0,
            'http://www.winehq.org/tests/tests15'],
        ['file:///C:\\dir\\file.txt', 'test.txt', 0, 'file:///C:/dir/test.txt'],
        ['C:\\winehq\\winehq.txt', 'C:\\Test\\test.txt', 0, 'file:///C:/Test/test.txt'],
        ['http://www.winehq.org/test/', 'test%20file.txt', 0,
            'http://www.winehq.org/test/test%20file.txt'],
        ['xxx:@MSITStore:file.chm/file.html', 'dir/file', 0, 'xxx:dir/file'],
        ['foo:today', 'foo:calendar', 0, 'foo:calendar'],
        ['foo:today', 'bar:calendar', 0, 'bar:calendar'],
        ['foo:/today', 'foo:calendar', 0, 'foo:/calendar'],
        ['Foo:/today/', 'fOo:calendar', 0, 'foo:/today/calendar'],
        ['c:\\test\\', '//share/file.txt', 0, 'file://share/file.txt'],
        ['c:\\test\\', '\\\\share\\file.txt', 0, 'file://share/file.txt'],
        ['outbind://xxxxxxxxx', 'http://wine1/dir', 0, 'http://wine1/dir'],
        ['http://xxxxxxxxx', 'outbind://wine7/dir', 0, 'outbind://wine7/dir'],
        ['ftp://xxxxxxxxx/', 'xXx:wine19/dir', 0, 'xxx:wine19/dir'],
        ['file:///c:/dir/file.txt', 'index.html?test=c:/abc', URL_ESCAPE_SPACES_ONLY
            | URL_DONT_ESCAPE_EXTRA_INFO, 'file:///c:/dir/index.html?test=c:/abc'],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [base, relative, flags, expected] of cases)
        {
            const { hr, text, length } = counted(m, `UrlCombine${suffix}`, wide,
                [m.put(base, wide), m.put(relative, wide)], [flags]);
            assert.equal(hr, S_OK, `${base} + ${relative}`);
            assert.equal(text, expected, `${base} + ${relative}`);
            assert.equal(length, expected.length);
        }
    }
});

test('UrlCombine counts its buffer as Windows does', ()=>{
    // Wine's test_UrlCombine.
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const call = m.fns[`UrlCombine${suffix}`];
        const base = m.put('http://base/', wide);
        const relative = m.put('relative', wide);
        const whole = 'http://base/relative';
        assert.equal(call.handler([base, relative, 0, 0, 0]) >>> 0, E_INVALIDARG);
        let room = m.count(0);
        assert.equal(call.handler([base, relative, 0, room, 0]) >>> 0, E_POINTER);
        assert.equal(m.dwordAt(room), whole.length + 1);
        const out = m.put('x', wide);
        room = m.count(whole.length);
        assert.equal(call.handler([base, relative, out, room, 0]) >>> 0, E_POINTER);
        assert.equal(m.dwordAt(room), whole.length + 1);
        assert.equal(m.read(out, wide), 'x', 'the buffer untouched');
        assert.equal(call.handler([base, relative, out, room, 0]) >>> 0, S_OK);
        assert.equal(m.dwordAt(room), whole.length);
        assert.equal(m.read(out, wide), whole);
    }
});

test('UrlCreateFromPath makes a file URL, and copies a URL with S_FALSE', ()=>{
    // Wine's TEST_URLFROMPATH.
    const cases = /** @type {[string, string, number][]} */ ([
        ['foo', 'file:foo', S_OK],
        ['foo\\bar', 'file:foo/bar', S_OK],
        ['\\foo\\bar', 'file:///foo/bar', S_OK],
        ['c:\\foo\\bar', 'file:///c:/foo/bar', S_OK],
        ['c:foo\\bar', 'file:///c:foo/bar', S_OK],
        ['c:\\foo/b a%r', 'file:///c:/foo/b%20a%25r', S_OK],
        ['c:\\foo\\foo bar', 'file:///c:/foo/foo%20bar', S_OK],
        ['\\\\server\\share\\file', 'file://server/share/file', S_OK],
        ['file:///c:/foo/bar', 'file:///c:/foo/bar', S_FALSE],
        ['xx:c:\\foo\\bar', 'xx:c:\\foo\\bar', S_FALSE],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        for (const [path, url, hr] of cases)
        {
            const answer = counted(m, `UrlCreateFromPath${suffix}`, wide, [m.put(path, wide)],
                [0]);
            assert.equal(answer.hr, hr, path);
            assert.equal(answer.text, url, path);
            assert.equal(answer.length, url.length, path);
        }
        const room = m.count(4);
        assert.equal(m.fns[`UrlCreateFromPath${suffix}`].handler([m.put('c:\\x', wide),
            m.put('', wide), room, 0]) >>> 0, E_POINTER);
        assert.equal(m.dwordAt(room), 'file:///c:/x'.length + 1);
    }
});

test('UrlUnescapeW decodes escapes to the code each names', ()=>{
    // Wine's TEST_URL_UNESCAPEW, without URL_UNESCAPE_AS_UTF8, which is later.
    const cases = [
        ['file://foo/bar', 'file://foo/bar'],
        ['file://fo%20o%5Ca/bar', 'file://fo o\\a/bar'],
        ['file://%24%25foobar', 'file://$%foobar'],
        ['file:///C:/Program%20Files', 'file:///C:/Program Files'],
        ['file://foo/%E4%B8%AD/bar', 'file://foo/\xe4\xb8\xad/bar'],
    ];
    const m = shlwapiMachine();
    for (const [url, expected] of cases)
    {
        const { hr, text, length } = counted(m, 'UrlUnescapeW', true, [m.put(url, true)], [0]);
        assert.equal(hr, S_OK);
        assert.equal(text, expected);
        assert.equal(length, expected.length);
        const inPlace = m.put(url, true);
        const room = m.count(0x824);
        assert.equal(m.fns.UrlUnescapeW.handler([inPlace, 0, room, URL_UNESCAPE_INPLACE]), S_OK);
        assert.equal(m.read(inPlace, true), expected);
        assert.equal(m.dwordAt(room), 0x824, 'in place, the count is not touched');
        const short = m.count(expected.length - 1);
        assert.equal(m.fns.UrlUnescapeW.handler([m.put(url, true), m.put('', true), short, 0])
            >>> 0, E_POINTER);
    }
    const narrow = m.put('a%80b');
    assert.equal(m.fns.UrlUnescapeA.handler([narrow, 0, 0, URL_UNESCAPE_INPLACE]), S_OK);
    assert.deepEqual([...m.memory.subarray(narrow, narrow + 4)], [0x61, 0x80, 0x62, 0],
        'an ANSI escape is the byte it names');
});

test('UrlIs answers whether it is a URL, opaque, a file, a directory or has a query', ()=>{
    // Wine's test_UrlIs, TEST_PATH_IS_URL and TEST_URLIS_ATTRIBS.
    const urls = /** @type {[string, number][]} */ ([['http://foo/bar', 1],
        ['c:\\foo\\bar', 0], ['foo://foo/bar', 1], ['foo\\bar', 0], ['foo.bar', 0],
        ['bogusscheme:', 1], ['http:partial', 1]]);
    const attributes = /** @type {[string, number, number][]} */ ([
        ['ftp:', 0, 0], ['http:', 0, 0], ['mailto:', 1, 0], ['news:', 0, 0], ['file:', 0, 1],
        ['shell:', 1, 0], ['javascript:', 1, 0], ['vbscript:', 1, 0], ['about:', 1, 0],
        ['res:', 0, 0], ['bogusscheme:', 0, 0], ['file:\\\\e:\\b\\c', 0, 1],
        ['file://e:/b/c', 0, 1], ['mailto://www.winehq.org/test.html', 1, 0],
        ['file:partial', 0, 1], ['File:partial', 0, 1],
    ]);
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const call = m.fns[`UrlIs${suffix}`];
        for (const [url, expected] of urls)
        {
            assert.equal(call.handler([m.put(url, wide), 0]), expected, url);
        }
        for (const [url, opaque, file] of attributes)
        {
            assert.equal(call.handler([m.put(url, wide), 1]), opaque, `${url} opaque`);
            assert.equal(call.handler([m.put(url, wide), 3]), file, `${url} file`);
        }
        for (let question = 0; question <= 6; question++)
        {
            assert.equal(call.handler([0, question]), 0, 'never for no URL');
        }
        assert.equal(call.handler([m.put('http://a/b/', wide), 5]), 1, 'a directory');
        assert.equal(call.handler([m.put('http://a/b', wide), 5]), 0);
        assert.equal(call.handler([m.put('http://a/b?c=d', wide), 6]), 1, 'a query');
        assert.equal(call.handler([m.put('http://a/b#c?d', wide), 6]), 0, 'a ? after #');
        assert.equal(call.handler([m.put('http://a/b', wide), 4]), 0, 'URLIS_APPLIABLE');
        assert.equal(m.divergences.length, 1);
    }
});

test('UrlGetLocation points at the location, a file URL\'s # only', ()=>{
    for (const [suffix, wide] of WIDTHS)
    {
        const m = shlwapiMachine();
        const unit = wide ? 2 : 1;
        const cases = /** @type {[string, number | null][]} */ ([
            ['http://a/b#c', 10], ['http://a/b?q#c', 10], ['http://a/b', null],
            ['file:///c:/a?b#c', 14], ['file:///c:/a?b', null], ['c:\\a#b', null],
        ]);
        for (const [url, index] of cases)
        {
            const at = m.put(url, wide);
            assert.equal(m.fns[`UrlGetLocation${suffix}`].handler([at]),
                index === null ? 0 : at + index * unit, url);
        }
    }
});

test('each URL function declares the arguments it pops, in both spellings', ()=>{
    const { fns } = shlwapiMachine();
    const expected = /** @type {Record<string, number>} */ ({ UrlUnescape: 16,
        UrlCanonicalize: 16, UrlCombine: 20, UrlCreateFromPath: 16, UrlGetLocation: 4,
        UrlIs: 8 });
    for (const [name, bytes] of Object.entries(expected))
    {
        assert.equal(fns[`${name}A`].argBytes, bytes, `${name}A`);
        assert.equal(fns[`${name}W`].argBytes, bytes, `${name}W`);
    }
});
