/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An installer database as a signature's subject: its signature out of the
 * \x05DigitalSignature stream, and the digest over the other streams and the
 * storages' classes, children taken in the order of their names' UTF-16LE
 * bytes - which is neither the directory's order nor the names' code points'.
 * Microsoft's signed databases (Visual C++ 2010's vc_red.msi, PhysX 9.13's)
 * digest to their stated value in this order and in no other tried.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntry, createRoot, nameKey, serializeCompoundFile } from '../ole32/cfb.js';
import { parseGuid } from '../ole32/guid.js';
import { createSha1 } from '../crypto/digest.js';
import { msiSubject, readSubject } from './subject.js';

const SHA1 = '1.3.14.3.2.26';
const ROOT_CLASS = '{000C1084-0000-0000-C000-000000000046}';
const INNER_CLASS = '{12345678-9ABC-DEF0-1234-56789ABCDEF0}';

/** @param {number} seed @param {number} length */
const bytesOf = (seed, length)=>Uint8Array.from({ length }, (_, i)=>(i * 7 + seed) & 0xff);

function database(){
    const root = createRoot();
    root.clsid = ROOT_CLASS;
    /** @param {Map<string, any>} into @param {string} name @param {Uint8Array} data */
    const stream = (into, name, data)=>{
        const entry = createEntry(name, 'stream');
        entry.data = data;
        into.set(nameKey(name), entry);
    };
    // 'B' is 42 00, U+4100 is 00 41 and 'a' is 61 00: by bytes U+4100, 'B', 'a';
    // by code points 'B', 'a', U+4100; the directory has its own order again.
    stream(root.children, 'a', bytesOf(1, 10));
    stream(root.children, 'B', bytesOf(2, 20));
    stream(root.children, '䄀', bytesOf(3, 30));
    stream(root.children, '\u0005DigitalSignature', Uint8Array.of(0x30, 0x00));
    const inner = createEntry('ab', 'storage');
    inner.clsid = INNER_CLASS;
    stream(inner.children, 'x', bytesOf(4, 40));
    root.children.set(nameKey('ab'), inner);
    return serializeCompoundFile(root);
}

test('an installer database digests its streams by their names\' bytes, classes after', async()=>{
    const bytes = database();
    assert.equal(readSubject(bytes), null, 'neither a cabinet nor an image');
    const subject = await msiSubject(bytes);
    assert.ok(subject);
    assert.equal(subject.form, 'msi');
    assert.deepEqual([...subject.signature ?? []], [0x30, 0x00], 'the signature stream');
    const expected = createSha1();
    // U+4100, 'B', 'a', then the storage 'ab' (61 00 62 00 after 'a''s 61 00):
    // its stream and class, then the root's class.
    for (const piece of [bytesOf(3, 30), bytesOf(2, 20), bytesOf(1, 10), bytesOf(4, 40),
        /** @type {Uint8Array} */ (parseGuid(INNER_CLASS)),
        /** @type {Uint8Array} */ (parseGuid(ROOT_CLASS))])
    {
        expected.update(piece);
    }
    assert.deepEqual([...subject.digest(SHA1) ?? []], [...expected.digest()]);
    assert.equal(subject.digest('1.2.3.4'), null, 'an algorithm not known');
});

test('bytes that are no compound file are no installer database', async()=>{
    assert.equal(await msiSubject(new Uint8Array(0)), null);
    assert.equal(await msiSubject(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 1)), null);
});
