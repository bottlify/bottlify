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

test('a database signed with its metadata digests that first, and a changed entry fails', async()=>{
    // \x05MsiDigitalSignatureEx holds a digest of every entry's name (none for
    // the root), a storage's class or a stream's four size bytes, its state
    // bits and its two times (none for the root), storages before their
    // children, in the contents' order; the signed digest is of that stream's
    // bytes, then the contents. The .NET Framework 4.5 to 4.8 setups' databases
    // are signed so.
    /** @param {Uint8Array} extended @param {bigint} [stamp] */
    const build = (extended, stamp = 0x01d2_0000_1234_5678n)=>{
        const root = createRoot();
        root.clsid = ROOT_CLASS;
        root.stateBits = 0x11;
        /** @param {Map<string, any>} into @param {string} name @param {Uint8Array} data */
        const stream = (into, name, data)=>{
            const entry = createEntry(name, 'stream');
            entry.data = data;
            entry.stateBits = 3;
            into.set(nameKey(name), entry);
        };
        stream(root.children, 'B', bytesOf(2, 20));
        stream(root.children, 'a', bytesOf(1, 10));
        stream(root.children, '\u0005DigitalSignature', Uint8Array.of(0x30, 0x00));
        stream(root.children, '\u0005MsiDigitalSignatureEx', extended);
        const inner = createEntry('ab', 'storage');
        inner.clsid = INNER_CLASS;
        inner.created = stamp;
        inner.modified = stamp + 1n;
        stream(inner.children, 'x', bytesOf(4, 40));
        root.children.set(nameKey('ab'), inner);
        return serializeCompoundFile(root);
    };
    /** @param {string} name */
    const utf16 = name=>Uint8Array.from([...name].flatMap(c=>[c.charCodeAt(0) & 0xff,
        c.charCodeAt(0) >> 8]));
    /** @param {number} value @param {number} size */
    const little = (value, size)=>Uint8Array.from({ length: size },
        (_, i)=>Number((BigInt(value) >> BigInt(i * 8)) & 0xffn));
    const times = (/** @type {bigint} */ stamp)=>Uint8Array.from([...little(Number(stamp & 0xffffffffn), 4),
        ...little(Number(stamp >> 32n), 4), ...little(Number((stamp + 1n) & 0xffffffffn), 4),
        ...little(Number((stamp + 1n) >> 32n), 4)]);
    const zeroTimes = new Uint8Array(16);
    const prehash = createSha1();
    // The root: its class and state bits. Then 'B', 'a', 'ab' and its 'x', by bytes.
    const rootClass = /** @type {Uint8Array} */ (parseGuid(ROOT_CLASS));
    for (const piece of [rootClass, little(0x11, 4),
        utf16('B'), little(20, 4), little(3, 4), zeroTimes,
        utf16('a'), little(10, 4), little(3, 4), zeroTimes,
        utf16('ab'), /** @type {Uint8Array} */ (parseGuid(INNER_CLASS)), little(0, 4),
        times(0x01d2_0000_1234_5678n),
        utf16('x'), little(40, 4), little(3, 4), zeroTimes])
    {
        prehash.update(piece);
    }
    const extended = prehash.digest();
    const subject = await msiSubject(build(extended));
    const expected = createSha1();
    for (const piece of [extended, bytesOf(2, 20), bytesOf(1, 10), bytesOf(4, 40),
        /** @type {Uint8Array} */ (parseGuid(INNER_CLASS)),
        /** @type {Uint8Array} */ (parseGuid(ROOT_CLASS))])
    {
        expected.update(piece);
    }
    assert.deepEqual([...subject?.digest(SHA1) ?? []], [...expected.digest()]);

    const touched = await msiSubject(build(extended, 0x01d2_0000_1234_5679n));
    assert.deepEqual([...touched?.digest(SHA1) ?? [1]], [],
        'a storage whose times changed since it was signed digests to nothing');
});
