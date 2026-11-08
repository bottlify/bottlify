/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A managed image read as the runtime reads it: the runtime version, the CLI
 * flags, the Assembly row past the tables before it, the File table's names.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readClrImage } from './metadata.js';
import { managedImage } from './metadata.fixture.js';

test('the Assembly row: name, version, culture, key, past the Module table', ()=>{
    const publicKey = Uint8Array.from({ length: 288 }, (_, i)=>i * 7 & 0xff);
    const image = readClrImage(managedImage({ name: 'Widget', version: [2, 0, 5, 9],
        culture: 'de', publicKey, runtime: 'v2.0.50727', machine: 0x8664, flags: 0x3 }));
    assert.ok(image);
    assert.equal(image.version, 'v2.0.50727');
    assert.equal(image.machine, 0x8664);
    assert.equal(image.flags, 0x3);
    assert.deepEqual(image.files, []);
    assert.equal(image.assembly?.name, 'Widget');
    assert.deepEqual(image.assembly?.version, [2, 0, 5, 9]);
    assert.equal(image.assembly?.culture, 'de');
    assert.deepEqual([...image.assembly?.publicKey ?? []], [...publicKey],
        'a blob of 128 bytes or more has a two-byte length');
    assert.equal(image.assembly?.hashAlgorithm, 0x8004);
});

test('the File table names the other modules; a module alone has no Assembly row', ()=>{
    const image = readClrImage(managedImage({ files: ['part1.netmodule', 'part2.netmodule'] }));
    assert.deepEqual(image?.files, ['part1.netmodule', 'part2.netmodule']);
    assert.equal(image?.assembly?.name, 'sample', 'the File table comes after Assembly');
    const module = readClrImage(managedImage({ assembly: false }));
    assert.ok(module);
    assert.equal(module.assembly, null);
});

test('a file that is not a managed image is null', ()=>{
    assert.equal(readClrImage(new Uint8Array(0x80)), null);
    const native = managedImage();
    new DataView(native.buffer).setUint32(0x98 + 96 + 14 * 8, 0, true);
    assert.equal(readClrImage(native), null, 'no CLI header');
    assert.equal(readClrImage(managedImage().subarray(0, 0x258)), null, 'its root cut short');
});
