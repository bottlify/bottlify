/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { CLIENT_CDN, fetchClientFiles, zipEntries } from './client.js';

/**
 * A zip as the client's packages are laid out: local headers whose sizes are
 * zero (a data descriptor's job), the real ones in the central directory.
 *
 * @param {{ name: string, bytes: Uint8Array, deflate?: boolean }[]} entries
 */
function zip(entries){
    /** @type {number[]} */
    const out = [];
    /** @type {number[]} */
    const central = [];
    const u16 = (/** @type {number[]} */ to, /** @type {number} */ v)=>to.push(v & 255, v >>> 8 & 255);
    const u32 = (/** @type {number[]} */ to, /** @type {number} */ v)=>{
        u16(to, v & 0xffff);
        u16(to, v >>> 16);
    };
    for (const { name, bytes, deflate } of entries)
    {
        const body = deflate ? new Uint8Array(deflateRawSync(bytes)) : bytes;
        const nameBytes = [...new TextEncoder().encode(name)];
        const local = out.length;
        u32(out, 0x04034b50); u16(out, 20); u16(out, 8); u16(out, deflate ? 8 : 0);
        u32(out, 0); u32(out, 0); u32(out, 0); u32(out, 0);
        u16(out, nameBytes.length); u16(out, 0); out.push(...nameBytes, ...body);
        u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 8);
        u16(central, deflate ? 8 : 0); u32(central, 0); u32(central, 0);
        u32(central, body.length); u32(central, bytes.length);
        u16(central, nameBytes.length); u16(central, 0); u16(central, 0); u16(central, 0);
        u16(central, 0); u32(central, 0); u32(central, local); central.push(...nameBytes);
    }
    const at = out.length;
    out.push(...central);
    u32(out, 0x06054b50); u16(out, 0); u16(out, 0); u16(out, entries.length);
    u16(out, entries.length); u32(out, central.length); u32(out, at); u16(out, 0);
    return new Uint8Array(out);
}

const client64 = new Uint8Array(4096).map((_, i)=>(i * 7) & 255);
const client32 = new TextEncoder().encode('MZ the 32-bit client');

test('the wanted entries are read through the central directory, stored or deflated', async()=>{
    const archive = zip([{ name: 'other.dll', bytes: new Uint8Array(9) },
        { name: 'steamclient64.dll', bytes: client64, deflate: true },
        { name: 'steamclient.dll', bytes: client32 }]);
    const found = await zipEntries(archive, ['steamclient.dll', 'steamclient64.dll']);
    assert.deepEqual(Object.keys(found).sort(), ['steamclient.dll', 'steamclient64.dll']);
    assert.deepEqual(found['steamclient64.dll'], client64);
    assert.deepEqual(found['steamclient.dll'], client32);
});

test('the client\'s files come from the binaries package the manifest names, checked', async()=>{
    const archive = zip([{ name: 'steamclient64.dll', bytes: client64, deflate: true },
        { name: 'steamclient.dll', bytes: client32, deflate: true }]);
    const sha2 = createHash('sha256').update(archive).digest('hex');
    /** @param {string} digest */
    const manifest = digest=>`"win32"\n{\n\t"version"\t\t"123"\n\t"bins_win32"\n\t{\n`
        + `\t\t"file"\t\t"bins_win32.zip.abc"\n\t\t"sha2"\t\t"${digest}"\n\t}\n}\n`;
    /** @param {string} digest */
    const cdn = digest=>/** @type {typeof fetch} */ (/** @type {unknown} */ (
        async(/** @type {string} */ url)=>{
            const body = url === `${CLIENT_CDN}/steam_client_win32`
                ? new TextEncoder().encode(manifest(digest))
                : url === `${CLIENT_CDN}/bins_win32.zip.abc` ? archive : null;
            return body ? new Response(body) : new Response(null, { status: 404 });
        }));
    const { version, files } = await fetchClientFiles({ fetch: cdn(sha2) });
    assert.equal(version, '123');
    assert.deepEqual(files['steamclient64.dll'], client64);
    assert.deepEqual(files['steamclient.dll'], client32);
    await assert.rejects(fetchClientFiles({ fetch: cdn('00'.repeat(32)) }),
        /not the package the manifest names/);
});
