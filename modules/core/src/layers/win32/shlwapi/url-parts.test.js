/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shlwapiMachine } from './memory.fixture.js';
import { applyScheme, escapeUrl, hashData, parseUrl, urlPart } from './url-parts.js';

const S_OK = 0;
const S_FALSE = 1;
const E_FAIL = 0x80004005 | 0;
const E_POINTER = 0x80004003;
const E_INVALIDARG = 0x80070057;
const E_NOTIMPL = 0x80004001 | 0;

const GUESSSCHEME = 0x2;
const DEFAULT = 0x1;
const GUESSFILE = 0x4;
const FORCEAPPLY = 0x8;

test('UrlApplyScheme guesses a file, then a prefix, then the default', ()=>{
    // Wine's TEST_APPLY.
    for (const [url, flags, expected] of /** @type {[string, number, string | null][]} */ ([
        ['www.winehq.org', GUESSSCHEME, 'http://www.winehq.org'],
        ['ftp.winehq.org', GUESSSCHEME, 'ftp://ftp.winehq.org'],
        ['ftp.winehq.org', DEFAULT, 'http://ftp.winehq.org'],
        ['winehq.org', GUESSSCHEME, null],
        ['http://www.winehq.org', GUESSSCHEME | DEFAULT, null],
        ['http://www.winehq.org', GUESSSCHEME | FORCEAPPLY, null],
        ['http://www.winehq.org', GUESSSCHEME | FORCEAPPLY | DEFAULT, 'http://http://www.winehq.org'],
        ['', GUESSSCHEME | DEFAULT, 'http://'],
        ['u:\\windows', GUESSFILE, 'file:///u:/windows'],
        ['u:\\windows', DEFAULT, 'http://u:\\windows'],
        ['aa:\\windows', GUESSFILE, null],
        ['\\\\server\\share', GUESSFILE, 'file://server/share'],
        ['\\\\server\\share', GUESSSCHEME, null],
    ]))
    {
        assert.equal(applyScheme(url, flags), expected, `${url} ${flags}`);
    }
});

test('UrlEscape escapes by the scheme, and nothing past the query', ()=>{
    // Wine's TEST_ESCAPE and TEST_ESCAPEW, a sample from each kind of URL.
    for (const [url, flags, expected] of /** @type {[string, number, string][]} */ ([
        ['http://www.winehq.org/tests1\n', 0, 'http://www.winehq.org/tests1%0A'],
        ['http://www.winehq.org/tests3\r', 0x24000000, 'http://www.winehq.org/tests3\r'],
        ['file://////foo/bar\\baz', 0, 'file://foo/bar/baz'],
        ['file://loCalHost/foo/bar\\baz', 0, 'file:///foo/bar/baz'],
        ['file:/localhost/foo/bar\\baz', 0, 'file:///localhost/foo/bar/baz'],
        ['file:foo/bar\\baz', 0, 'file:foo/bar/baz'],
        ['file:///foo/b#a r\\baz', 0, 'file:///foo/b%23a%20r/baz'],
        ['file:///f o%o/b?a r\\b%az', 0x1000, 'file:///f%20o%25o/b?a r\\b%az'],
        ['foo/b%ar\\ba?z\\', 0x2000, 'foo%2Fb%ar%5Cba%3Fz%5C'],
        ['/foo/bar\\ba#z\\', 0, '/foo/bar%5Cba#z\\'],
        ['http:foo/bar\\ba?z\\', 0, 'http:foo%2Fbar%2Fba?z\\'],
        ['http:\\\\foo/bar\\baz', 0, 'http://foo/bar/baz'],
        ['foo:\\foo/bar\\baz', 0, 'foo:%5Cfoo%2Fbar%5Cbaz'],
        ['foo:/foo/bar\\ba?\\z', 0, 'foo:/foo/bar%5Cba?\\z'],
        ['mailto:fo/o@b\\%a?\\r.b#\\az', 0x1000, 'mailto:fo%2Fo@b%5C%25a%3F%5Cr.b%23%5Caz'],
        ['ftp:fo/o@bar.baz/foo/bar', 0, 'ftp:fo%2Fo@bar.baz%2Ffoo%2Fbar'],
        ['ftp\x1f\x01end/', 0, 'ftp%1F%01end/'],
        ['ftp\x1f\xff\xfa\u2122q/', 0, 'ftp%1F%FF%FA\u2122q/'],
        ['Ma\xdf', 0x40000, 'Ma%C3%9F'],
        ['\ud841\udf0e', 0x40000, '%F0%A0%9C%8E'],
        ['\ud85eQ', 0x40000, '%EF%BF%BDQ'],
        ['&/?#', 0x40000, '%26/?#'],
    ]))
    {
        assert.equal(escapeUrl(url, flags), expected, JSON.stringify(url));
    }
});

test('UrlGetPart finds a part only where the scheme has one', ()=>{
    // Wine's test_UrlGetPart.
    const url = 'http://foo:bar@localhost:21/internal.php?query=x&return=y';
    for (const [given, part, flags, kind, text] of /** @type {[string, number, number, string,
        string][]} */ ([
            ['hi', 1, 0, 'empty', ''], ['hi', 3, 0, 'none', ''], [url, 1, 0, 'found', 'http'],
            [url, 3, 0, 'found', 'foo'], [url, 4, 0, 'found', 'bar'],
            [url, 2, 0, 'found', 'localhost'],
            [url, 5, 0, 'found', '21'], [url, 6, 0, 'found', 'query=x&return=y'],
            [url, 3, 1, 'found', 'http:foo'], [url, 6, 1, 'found', 'query=x&return=y'],
            ['http://localhost/', 3, 0, 'invalid', ''], ['http://@', 3, 0, 'empty', ''],
            ['http://user@host@q', 2, 0, 'found', 'host@q'], ['http:/localhost/index.html', 2, 0, 'none', ''],
            ['http:\\/localhost/index.html', 2, 0, 'found', 'localhost'],
            ['http://host#a:b@c:d', 6, 0, 'empty', ''], ['http:///index.html', 2, 1, 'found', 'http:'],
            ['file://foo:bar@localhost:21/file?query=x', 2, 0, 'found', 'foo:bar@localhost:21'],
            ['file://foo:bar@localhost:21/file?query=x', 3, 0, 'none', ''],
            ['file://c:\\index.htm', 2, 0, 'empty', ''], ['file:some text', 2, 0, 'empty', ''],
            ['about:blank', 2, 0, 'none', ''], ['sChEmE-.+:', 1, 0, 'found', 'scheme-.+'],
            ['scheme_:', 1, 0, 'empty', ''], ['a:', 1, 0, 'empty', ''],
            ['file://hostname/', 2, 1, 'found', 'hostname'], ['telnet://hostname/', 2, 1, 'found',
                'telnet:hostname'],
        ]))
    {
        assert.deepEqual(urlPart(given, part, flags), { kind, text }, `${given} ${part} ${flags}`);
    }
});

test('ParseURL accepts a scheme of two characters or more', ()=>{
    // Wine's parse_url_tests.
    assert.deepEqual(parseUrl('http://www.winehq.org/'), { protocolLength: 4, number: 2 });
    assert.deepEqual(parseUrl('HTTP://www.winehq.org/'), { protocolLength: 4, number: 2 });
    assert.deepEqual(parseUrl('https://www.winehq.org/'), { protocolLength: 5, number: 11 });
    assert.deepEqual(parseUrl('a+-.://www.winehq.org/'), { protocolLength: 4, number: 0 });
    for (const bad of ['test.txt?test=c:/dir', 'x://www.winehq.org/', 'xx$://www.winehq.org/',
        ' http://www.winehq.org/'])
    {
        assert.equal(parseUrl(bad), null, bad);
    }
});

test('the URL functions count their answers as Windows does', ()=>{
    const m = shlwapiMachine();
    for (const [suffix, wide] of /** @type {const} */ ([['A', false], ['W', true]]))
    {
        const buffer = m.put('untouched', wide, 512);
        const apply = m.fns[`UrlApplyScheme${suffix}`].handler;
        let count = m.count(256);
        assert.equal(apply([m.put('www.winehq.org', wide), buffer, count, GUESSSCHEME]), S_OK);
        assert.equal(m.read(buffer, wide), 'http://www.winehq.org');
        assert.equal(m.dwordAt(count), 21, 'without the terminator');
        count = m.count(21);
        assert.equal(apply([m.put('www.winehq.org', wide), buffer, count, GUESSSCHEME]), E_POINTER);
        assert.equal(m.dwordAt(count), 22, 'with it when the room is short');
        assert.equal(apply([m.put('winehq.org', wide), buffer, count, GUESSSCHEME]), S_FALSE);
        assert.equal(m.dwordAt(count), 22);

        count = m.count(256);
        assert.equal(m.fns[`UrlGetPart${suffix}`].handler([m.put('hi', wide), buffer, count, 1, 0]),
            wide ? S_OK : S_FALSE, 'an empty part is S_OK in the wide spelling');
        assert.equal(m.read(buffer, wide), '');
        assert.equal(m.dwordAt(count), 0);
        assert.equal(m.fns[`UrlGetPart${suffix}`].handler([m.put('hi', wide), buffer,
            m.count(256), 3, 0]), E_FAIL);
        assert.equal(m.fns[`UrlGetPart${suffix}`].handler([m.put('hi', wide), buffer,
            m.count(0), 1, 0]), E_INVALIDARG);

        count = m.count(1);
        const source = m.put('/woningplan/woonkamer basis.swf', wide);
        assert.equal(m.fns[`UrlEscape${suffix}`].handler([source, buffer, count, 0x04000000]),
            E_POINTER);
        assert.equal(m.dwordAt(count), 34);
        assert.equal(m.fns[`UrlEscape${suffix}`].handler([source, 0, count, 0x04000000]),
            E_INVALIDARG);

        const parsed = m.put('', false, 24);
        m.view.setUint32(parsed, 24, true);
        const url = m.put('http://x/', wide);
        assert.equal(m.fns[`ParseURL${suffix}`].handler([url, parsed]), S_OK);
        const unit = wide ? 2 : 1;
        assert.deepEqual([1, 2, 3, 4, 5].map(i=>m.dwordAt(parsed + i * 4)),
            [url, 4, url + 5 * unit, 4, 2]);
        assert.equal(m.fns[`ParseURL${suffix}`].handler([m.put('x', wide), parsed]),
            0x80041001 | 0);
        assert.equal(m.dwordAt(parsed + 4), 0, 'the protocol cleared');
        assert.equal(m.dwordAt(parsed + 20), 2, 'the number left');
    }
    const empty = m.put('', false, 4);
    assert.equal(m.fns.UrlEscapeA.handler([m.put('x'), empty, m.count(1), 0x40000]), E_NOTIMPL,
        'UTF-8 is the wide spelling\'s');
});

test('UrlHash and HashData hash alike in either spelling, and refuse no pointer', ()=>{
    const m = shlwapiMachine();
    const narrow = m.put('', false, 8);
    const wide = m.put('', false, 8);
    assert.equal(m.fns.UrlHashA.handler([m.put('http://www.winehq.org/tests'), narrow, 4]), S_OK);
    assert.equal(m.fns.UrlHashW.handler([m.put('http://www.winehq.org/tests', true), wide, 4]),
        S_OK);
    assert.equal(m.dwordAt(narrow), m.dwordAt(wide));
    assert.deepEqual(hashData(Uint8Array.of(1, 2, 3), 4), hashData(Uint8Array.of(1, 2, 3), 4));
    assert.notDeepEqual(hashData(Uint8Array.of(1, 2, 3), 4), hashData(Uint8Array.of(1, 2, 4), 4));
    assert.equal(m.fns.HashData.handler([0, 0, 0, 0]), E_INVALIDARG);
    assert.equal(m.fns.HashData.handler([narrow, 0, 0, 0]), E_INVALIDARG);
    assert.equal(m.fns.HashData.handler([0xdeadbeef, 0, 0xdeadbeef, 0]), S_OK,
        'nothing to hash reads nothing');
    assert.equal(m.divergences.filter(d=>d.startsWith('HashData')).length, 1);
});
