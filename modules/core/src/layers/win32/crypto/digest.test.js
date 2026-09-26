/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMd5, createSha1, createSha256 } from './digest.js';

const hex = (/** @type {Uint8Array} */ bytes)=>Buffer.from(bytes).toString('hex');
const ascii = (/** @type {string} */ text)=>new Uint8Array(Buffer.from(text, 'latin1'));

const DIGESTS = /** @type {const} */ ([
    ['md5', createMd5],
    ['sha1', createSha1],
    ['sha256', createSha256],
]);

test('each digest answers its published vector for "abc"', ()=>{
    // RFC 1321 appendix A.5; FIPS 180-2 appendices A.1 and B.1.
    const expected = {
        md5: '900150983cd24fb0d6963f7d28e17f72',
        sha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    };
    for (const [name, create] of DIGESTS)
    {
        const digest = create();
        digest.update(ascii('abc'));
        assert.equal(hex(digest.digest()), expected[name], name);
    }
});

test('a message fed in pieces of every size hashes as it would whole', ()=>{
    // Lengths either side of the block and of the length field's boundary.
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000])
    {
        const message = new Uint8Array(length).map((_, i)=>(i * 31 + 7) & 0xff);
        for (const [name, create] of DIGESTS)
        {
            const digest = create();
            for (let at = 0; at < length; at += 13)
            {
                digest.update(message.subarray(at, at + 13));
            }
            assert.equal(hex(digest.digest()),
                createHash(name).update(message).digest('hex'), `${name} of ${length} bytes`);
        }
    }
});

test('a clone carries on from where it was taken, leaving the original as it was', ()=>{
    for (const [name, create] of DIGESTS)
    {
        const digest = create();
        digest.update(ascii('hello, '));
        const copy = digest.clone();
        copy.update(ascii('world'));
        assert.equal(hex(copy.digest()), createHash(name).update('hello, world').digest('hex'));
        assert.equal(hex(digest.digest()), createHash(name).update('hello, ').digest('hex'));
    }
});
