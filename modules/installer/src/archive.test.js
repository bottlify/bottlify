/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveDisc, isZipArchive, readZip } from './archive.js';
import { discOptions } from './disc.js';

/** @param {Uint8Array} bytes */
const deflate = async bytes=>new Uint8Array(await new Response(new Blob([bytes]).stream()
    .pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());

/**
 * A zip of the entries given, laid out as APPNOTE has it: local headers and
 * data, the central directory, the end record. A null body is a directory.
 *
 * @param {[string, Uint8Array | null, boolean][]} entries  name, bytes, deflated
 */
async function zipOf(entries){
    const parts = [];
    const central = [];
    let offset = 0;
    for (const [name, bytes, deflated] of entries)
    {
        const nameBytes = new TextEncoder().encode(name);
        const body = bytes === null ? new Uint8Array(0) : deflated ? await deflate(bytes) : bytes;
        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034b50, true);
        local.setUint16(6, 0x800, true);
        local.setUint16(8, deflated ? 8 : 0, true);
        local.setUint32(18, body.length, true);
        local.setUint32(22, bytes?.length ?? 0, true);
        local.setUint16(26, nameBytes.length, true);
        const head = new DataView(new ArrayBuffer(46));
        head.setUint32(0, 0x02014b50, true);
        head.setUint16(8, 0x800, true);
        head.setUint16(10, deflated ? 8 : 0, true);
        head.setUint32(20, body.length, true);
        head.setUint32(24, bytes?.length ?? 0, true);
        head.setUint16(28, nameBytes.length, true);
        head.setUint32(42, offset, true);
        parts.push(new Uint8Array(local.buffer), nameBytes, body);
        central.push(new Uint8Array(head.buffer), nameBytes);
        offset += 30 + nameBytes.length + body.length;
    }
    const size = central.reduce((sum, part)=>sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)]);
}

test('a zip unpacks stored and deflated entries, directories and UTF-8 names', async()=>{
    const setup = new Uint8Array(4096).map((_, i)=>i * 7);
    const text = new TextEncoder().encode('readme '.repeat(200));
    const zip = await zipOf([
        ['Game/', null, false],
        ['Game/Setup.exe', setup, false],
        ['Game/Data/Read me — first.txt', text, true],
    ]);
    assert.equal(await isZipArchive(zip), true);
    assert.equal(await isZipArchive(new Blob([new Uint8Array(2048)])), false);
    const seen = [];
    const entries = await readZip(zip, (done, total)=>seen.push(`${done}/${total}`));
    assert.deepEqual(entries.map(entry=>entry.path),
        ['Game', 'Game\\Setup.exe', 'Game\\Data\\Read me — first.txt']);
    assert.deepEqual(entries[1].bytes, setup);
    assert.deepEqual(entries[2].bytes, text);
    assert.deepEqual(seen, ['2/3', '3/3'], 'progress counts the files it unpacked');
});

test('an archive is the disc it stands in for, and the program picked out of it starts from D:',
    async()=>{
        const program = new Uint8Array([0x4d, 0x5a, 1, 2, 3]);
        const entries = await readZip(await zipOf([
            ['Disk1/Install.exe', program, false],
            ['Disk1/data.cab', new Uint8Array(5000).fill(9), true],
        ]));
        const media = archiveDisc('My Game 1.0.zip', entries);
        const run = await discOptions(media, { entry: 'Disk1\\Install.exe' });
        assert.equal(run.imagePath, 'D:\\Disk1\\Install.exe');
        assert.deepEqual(run.executable, program);
        assert.equal(run.discs[0].letter, 'D');
        await assert.rejects(()=>discOptions(media), /names no program to start/,
            'an archive has no autorun.inf, so nothing is started unless it is picked');
    });

test('an entry packed some other way, or encrypted, is refused by name', async()=>{
    const packed = await zipOf([['a.exe', new Uint8Array(3), false]]);
    const zip = new Uint8Array(await packed.arrayBuffer());
    const view = new DataView(zip.buffer);
    const central = zip.length - 22 - 46 - 5;
    view.setUint16(central + 10, 14, true);
    await assert.rejects(()=>readZip(new Blob([zip])), /a\.exe is packed with method 14/);
    view.setUint16(central + 10, 0, true);
    view.setUint16(central + 8, 0x801, true);
    await assert.rejects(()=>readZip(new Blob([zip])), /a\.exe is encrypted/);
});
