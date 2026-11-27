/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, fileUrlPath } from './monikers.js';

test('a file URL names the path of the local disk, however a program wrote it', ()=>{
    assert.equal(fileUrlPath('file:///C|/WINDOWS/TEMP/wrd1.%7Elk/%7Eswd1.swf'),
        'C:\\WINDOWS\\TEMP\\wrd1.~lk\\~swd1.swf', 'a drive bar and percent escapes');
    assert.equal(fileUrlPath('file://\\C|\\WINDOWS\\TEMP\\wrd1.~lk\\~swd1.dat'),
        'C:\\WINDOWS\\TEMP\\wrd1.~lk\\~swd1.dat', 'backslashes joined onto a path');
    assert.equal(fileUrlPath('file:///C:/Program%20Files/a.txt'), 'C:\\Program Files\\a.txt');
    assert.equal(fileUrlPath('file://server/share/a.txt'), '\\\\server\\share\\a.txt', 'a share');
    assert.equal(fileUrlPath('file:///C:/100%/a'), 'C:\\100%\\a', 'a % that escapes nothing');
    assert.equal(fileUrlPath('http://example.com/a'), null, 'another scheme names no path');
});

test('a URL is kept as urlmon keeps it: a path made a file URL, a relative one joined on', ()=>{
    assert.equal(canonicalUrl('C:\\dir\\movie.swf', null), 'file:///C:/dir/movie.swf');
    assert.equal(canonicalUrl('http://example.com/a/b.swf', 'file:///C:/x/y.swf'),
        'http://example.com/a/b.swf', 'one with a scheme of its own');
    assert.equal(canonicalUrl('c.swf', 'http://example.com/a/b.swf'), 'http://example.com/a/c.swf');
    assert.equal(canonicalUrl('/c.swf', 'http://example.com/a/b.swf'), 'http://example.com/c.swf');
    assert.equal(canonicalUrl('c.swf', null), 'c.swf', 'with no context, as written');
});
