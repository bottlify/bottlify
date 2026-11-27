/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { FNV_OFFSET, crc32, fnv1a, fnv1aLowBytes, fnv1aString, fnv1aWord } from './hash.js';

const ascii = (/** @type {string} */ text)=>Uint8Array.from(text, c=>c.charCodeAt(0));

/** xorshift32: the same inputs every run. @param {number} seed */
const random = seed=>{
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
};
const next = random(0x6a09e667);
const ROUNDS = 400;
/** Bytes of a length up to 300, the empty array among them. */
const bytesOf = ()=>Uint8Array.from({ length: next(301) }, ()=>next(256));
/** Every UTF-16 unit, lone surrogates and units past a byte included. */
const textOf = ()=>String.fromCharCode(...Array.from({ length: next(120) },
    ()=>(next(4) === 0 ? next(0x10000) : next(0x80))));
const wordOf = ()=>(next(0x10000) * 0x10000 + next(0x10000)) >>> 0;

// The copies these functions replaced, verbatim, each to its own output.

/** shared-sharing.js. @param {string} key @param {number} seed */
const sharingHashOf = (key, seed)=>{
    let hash = seed;
    for (let index = 0; index < key.length; index++)
    {
        hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193);
    }
    return hash | 0;
};

/** app.js. @param {number} hash @param {number} word */
const hashWord = (hash, word)=>{
    let h = hash;
    for (let shift = 0; shift < 32; shift += 8)
    {
        h = Math.imul(h ^ ((word >>> shift) & 0xff), 0x01000193);
    }
    return h >>> 0;
};
/** app.js. @param {number} hash @param {string} text */
const hashText = (hash, text)=>{
    let h = hash;
    for (let at = 0; at < text.length; at++)
    {
        h = Math.imul(h ^ text.charCodeAt(at), 0x01000193);
    }
    // The length too, so "ab" then "c" is not "a" then "bc".
    return hashWord(h >>> 0, text.length);
};

/** d3dx9/effect.js. @param {string} name */
function nameHash(name){
    let hash = 0x811c9dc5 | 0;
    for (let i = 0; i < name.length; i++)
    {
        hash = Math.imul(hash ^ (name.charCodeAt(i) & 0xff), 16777619);
    }
    return hash >>> 0;
}

/** webgpu/internal/bindings.js. @param {Int32Array} words @param {number} at */
const bindingHash = (words, at)=>{
    let hash = 0x811c9dc5;
    for (let i = 0; i < at; i++)
    {
        hash = Math.imul(hash ^ words[i], 0x01000193);
    }
    return hash;
};

/** seam/level-locks-contract.itest.js. @param {Uint8Array} bytes */
const digest = bytes=>{
    let hash = 0x811c9dc5;
    for (const byte of bytes)
    {
        hash = Math.imul(hash ^ byte, 0x01000193);
    }
    return (hash >>> 0).toString(16);
};

/** filesystem/internal/bundle/crc32.js, its table built eagerly. */
const bundleTable = new Uint32Array(256);
for (let at = 0; at < 256; at++)
{
    let value = at;
    for (let bit = 0; bit < 8; bit++)
    {
        value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    }
    bundleTable[at] = value >>> 0;
}
/** @param {Uint8Array} bytes */
function bundleCrc32(bytes){
    const lookup = bundleTable;
    let crc = 0xffffffff;
    for (let at = 0; at < bytes.length; at++)
    {
        crc = lookup[(crc ^ bytes[at]) & 0xff] ^ crc >>> 8;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** gdiplus/region.js. @param {Uint8Array} bytes */
const regionCrc32 = bytes=>{
    let c = 0xffffffff;
    for (const byte of bytes)
    {
        c ^= byte;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
        }
    }
    return (c ^ 0xffffffff) >>> 0;
};

/** ntdll/checksum.js (its table is bundle/crc32.js's). @param {number} initial @param {Uint8Array} bytes */
function ntdllCrc32(initial, bytes){
    let crc = ~initial >>> 0;
    for (const byte of bytes)
    {
        crc = bundleTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return ~crc >>> 0;
}

/** tools/run/install-watch.mjs; game.mjs's is the same and answers it signed. @param {Uint8Array} bytes */
const toolCrc32 = bytes=>{
    let crc = ~0;
    for (const byte of bytes)
    {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++)
        {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return ~crc >>> 0;
};

/** user32/png.fixture.js, a signed table. */
const fixtureTable = new Int32Array(256).map((_, n)=>{
    let c = n;
    for (let k = 0; k < 8; k++)
    {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c;
});
/** @param {Uint8Array} bytes */
function fixtureCrc(bytes){
    let c = -1;
    for (const b of bytes)
    {
        c = fixtureTable[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

test('FNV-1a, 32 bits: the published vectors', ()=>{
    for (const [text, hash] of /** @type {[string, number][]} */ ([['', 0x811c9dc5],
        ['a', 0xe40c292c], ['foobar', 0xbf9cf968]]))
    {
        assert.equal(fnv1a(ascii(text)), hash, text);
        assert.equal(fnv1aString(text), hash, text);
        assert.equal(fnv1aLowBytes(text), hash, text);
    }
    assert.equal(FNV_OFFSET, 0x811c9dc5);
    // A word is its four bytes, low first.
    assert.equal(fnv1aWord(0x62_6f_6f_66), fnv1a(ascii('foob')));
});

test('FNV-1a continues: two pieces hash as one, the end bounds what is read', ()=>{
    assert.equal(fnv1a(ascii('bar'), fnv1a(ascii('foo'))), 0xbf9cf968);
    assert.equal(fnv1aString('bar', fnv1aString('foo')), 0xbf9cf968);
    assert.equal(fnv1a(ascii('foobarbaz'), FNV_OFFSET, 6), 0xbf9cf968);
});

test('CRC-32: the check value, the empty case, a continued one, and zlib\'s answer', ()=>{
    assert.equal(crc32(ascii('123456789')), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0)), 0);
    assert.equal(crc32(new Uint8Array([0])), 0xd202ef8d);
    assert.equal(crc32(ascii('56789'), crc32(ascii('1234'))), 0xcbf43926);
    assert.equal(crc32(new Uint8Array(0), 0x1234), 0x1234);
    for (let round = 0; round < ROUNDS; round++)
    {
        const bytes = bytesOf();
        assert.equal(crc32(bytes), zlib.crc32(bytes));
    }
});

test('CRC-32: one flipped bit or a truncation is a different number', ()=>{
    const clean = new Uint8Array(4096).fill(0x5a);
    const damaged = clean.slice();
    damaged[2048] ^= 0x01;
    assert.notEqual(crc32(clean), crc32(damaged));
    assert.notEqual(crc32(clean), crc32(clean.subarray(0, 4095)));
});

test('the FNV-1a copies it replaced answer what it answers, on seeded random inputs', ()=>{
    for (let round = 0; round < ROUNDS; round++)
    {
        const text = textOf();
        const bytes = bytesOf();
        const seed = wordOf();
        assert.equal(fnv1aString(text, seed | 0) | 0, sharingHashOf(text, seed | 0));
        assert.equal(fnv1aString(text) | 0, sharingHashOf(text, 0x811c9dc5 | 0));
        assert.equal(fnv1aWord(text.length, fnv1aString(text, seed)), hashText(seed, text));
        const word = wordOf();
        const hash = wordOf();
        assert.equal(fnv1aWord(word, hash), hashWord(hash, word));
        assert.equal(fnv1aLowBytes(text), nameHash(text));
        assert.equal(fnv1a(bytes).toString(16), digest(bytes));
        const words = Int32Array.from({ length: 64 }, wordOf);
        const at = next(65);
        assert.equal(fnv1a(words, FNV_OFFSET, at) | 0, bindingHash(words, at) | 0);
    }
});

test('the CRC-32 copies it replaced answer what it answers, on seeded random inputs', ()=>{
    for (let round = 0; round < ROUNDS; round++)
    {
        const bytes = bytesOf();
        const initial = wordOf();
        const ours = crc32(bytes);
        assert.equal(ours, bundleCrc32(bytes));
        assert.equal(ours, regionCrc32(bytes));
        assert.equal(ours, toolCrc32(bytes));
        assert.equal(ours, fixtureCrc(bytes));
        assert.equal(crc32(bytes, initial), ntdllCrc32(initial, bytes));
    }
});
