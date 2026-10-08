/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCookieJar } from './cookies.js';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_NO_MORE_ITEMS = 259;
const ERROR_INTERNET_UNRECOGNIZED_SCHEME = 12006;

/** @param {ReturnType<typeof createCookieJar>} jar @param {string} url */
const read = (jar, url)=>{
    const answer = jar.get(url);
    return 'text' in answer ? answer.text : answer.error;
};

test('the domain widens a cookie, and the path is matched against the URL\'s directory', ()=>{
    // The arrangement Windows' answers are recorded for in Wine's tests.
    const jar = createCookieJar();
    assert.equal(jar.set('http://www.example.com/bar', null, 'A=B; domain=.example.com'), null);
    jar.set('http://www.example.com/bar', null, 'C=D; domain=.example.com; path=/');
    jar.set('http://www.example.com', null, 'E=F; domain=example.com');
    jar.set('http://www.example.com', null, 'G=H; domain=.example.com; invalid=attr; path=/foo');
    jar.set('http://www.example.com/bar.html', null, 'I=J; domain=.example.com');
    jar.set('http://www.example.com/bar/', null, 'K=L; domain=.example.com');
    jar.set('http://www.example.com/bar/', null, 'M=N; domain=.example.com; path=/foo/');
    jar.set('http://www.example.com/bar/', null, 'O=P; secure; path=/bar');

    const base = 'A=B; C=D; E=F; I=J';
    assert.equal(read(jar, 'http://testing.example.com'), base);
    assert.equal(read(jar, 'http://testing.example.com/foobar'), base);
    assert.equal(read(jar, 'http://testing.example.com/foobar/'), 'A=B; C=D; E=F; G=H; I=J');
    assert.equal(read(jar, 'http://testing.example.com/foo/bar'),
        'A=B; C=D; E=F; G=H; I=J; M=N');
    assert.equal(read(jar, 'http://testing.example.com/bar/foo'), `${base}; K=L`);
    assert.equal(read(jar, 'http://www.example.com/bar/x'), `${base}; K=L`,
        'a secure cookie is not sent over http');
    assert.equal(read(jar, 'https://www.example.com/bar/x'), `${base}; K=L; O=P`);
});

test('a cookie is replaced by name and place, deleted by a date gone, empty is its name', ()=>{
    let clock = Date.UTC(2010, 0, 1);
    const jar = createCookieJar({ now: ()=>clock });
    jar.set('http://a.test/', null, 'x=1');
    jar.set('http://a.test/', 'x', '2; expires=Fri, 01-Jan-2038 00:00:00 GMT');
    assert.equal(read(jar, 'http://a.test/'), 'x=2');
    jar.set('http://a.test/', 'y', '');
    jar.set('http://a.test/', null, 'z');
    assert.equal(read(jar, 'http://a.test/'), 'x=2; y; z');
    jar.set('http://a.test/', null, 'x=gone; expires=Thu, 01-Jan-1970 00:00:01 GMT');
    assert.equal(read(jar, 'http://a.test/'), 'y; z');
    clock = Date.UTC(2040, 0, 1);
    jar.set('http://a.test/', null, 'w=1; expires=Fri, 01-Jan-2038 00:00:00 GMT');
    assert.equal(read(jar, 'http://a.test/'), 'y; z', 'already past by the guest clock');

    const timeless = createCookieJar();
    timeless.set('http://a.test/', null, 'w=1; expires=Thu, 01-Jan-1970 00:00:01 GMT');
    assert.equal(read(timeless, 'http://a.test/'), 'w=1', 'no clock: the expiry is kept');
});

test('a URL with no scheme, no host or no cookies, or a foreign domain, is refused', ()=>{
    const jar = createCookieJar();
    assert.deepEqual(jar.set('server', null, 'a=b'), { error: ERROR_INTERNET_UNRECOGNIZED_SCHEME });
    assert.deepEqual(jar.set('http://', null, 'a=b'), { error: ERROR_INVALID_PARAMETER });
    assert.deepEqual(jar.set('http://www.aaa.example.com/bar', null, 'E=F; domain=different.com'),
        { error: ERROR_INVALID_PARAMETER });
    assert.equal(read(jar, 'about:blank'), ERROR_INVALID_PARAMETER);
    assert.equal(read(jar, 'http://www.example.com'), ERROR_NO_MORE_ITEMS);
});
