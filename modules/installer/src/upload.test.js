/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PART_BYTES, finish, partSink } from './upload.js';

/**
 * What one request looked like, in the shape this module actually sends.
 *
 * @typedef {Object} Recorded
 * @property {string} url
 * @property {{ body: Uint8Array | string, headers: Record<string, string> }} init
 */

/** Records what would go over the wire and answers as a server would. */
function recorder(){
    /** @type {Recorded[]} */
    const sent = [];
    /** @type {any} */
    const fetch = async(/** @type {string} */ url, /** @type {any} */ init)=>{
        sent.push({ url, init });
        return { ok: true, json: async()=>({ id: 'a-title', manifest: {} }), text: async()=>'' };
    };
    return { sent, endpoint: { url: 'http://bottles/', token: 'secret', fetch } };
}

test('blocks are batched into parts rather than sent one at a time', async()=>{
    const { sent, endpoint } = recorder();
    const sink = partSink(endpoint, 'a-title');

    for (let at = 0; at < 5; at++)
    {
        await sink.write(new Uint8Array(1000));
    }
    assert.equal(sent.length, 0, 'a block is a quarter of a mebibyte; a request per block '
        + 'would be thousands of round trips');

    // Reaching the part size is what closes a part, and it takes everything
    // pending with it rather than cutting at exactly the size.
    await sink.write(new Uint8Array(PART_BYTES));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].init.body.length, PART_BYTES + 5000);

    // What is left over is only sent when the caller says there is no more.
    await sink.write(new Uint8Array(7));
    assert.equal(sent.length, 1);
    assert.equal(await sink.flush(), PART_BYTES + 5007);
    assert.equal(sent.length, 2);
});

test('each part says where it goes, so a hole cannot be left silently', async()=>{
    const { sent, endpoint } = recorder();
    const sink = partSink(endpoint, 'a-title');

    await sink.write(new Uint8Array(PART_BYTES));
    await sink.write(new Uint8Array(PART_BYTES));
    await sink.flush();

    assert.deepEqual(sent.map(request=>new URL(request.url).searchParams.get('at')),
        ['0', String(PART_BYTES)]);
});

test('every request carries the token, because the endpoint is not public', async()=>{
    const { sent, endpoint } = recorder();
    const sink = partSink(endpoint, 'a-title');
    await sink.write(new Uint8Array(4));
    await sink.flush();

    assert.equal(sent[0].init.headers.Authorization, 'Bearer secret');
});

test('a refusal is reported with what the server said, not as a bare failure', async()=>{
    /** @type {any} */
    const endpoint = {
        url: 'http://bottles',
        token: 'wrong',
        fetch: async()=>({ ok: false, status: 401, text: async()=>'this endpoint is private' }),
    };
    const sink = partSink(endpoint, 'a-title');
    await sink.write(new Uint8Array(4));
    await assert.rejects(sink.flush(), /401.*this endpoint is private/);
});

test('what the container needs and what the catalogue needs travel together', async()=>{
    const { sent, endpoint } = recorder();
    await finish(endpoint, 'a-title', {
        header: new Uint8Array([1, 2, 3]),
        index: new Uint8Array([4, 5]),
        blockSize: 1 << 18,
        files: 3,
        directories: 0,
        uncompressedBytes: 900,
        blockBytes: 800,
        bytes: 845,
        storedBlocks: 1,
        totalBlocks: 2,
        indexSha256: 'abc',
    }, { title: 'A Title', entry: 'title.exe' });

    const body = JSON.parse(String(sent[0].init.body));
    assert.equal(body.blockBytes, 800);
    // The header and the index are in this request because neither exists until
    // the last block has been packed.
    assert.equal(body.header, 'AQID');
    assert.equal(body.manifest.title, 'A Title');
    assert.equal(body.manifest.bundle.indexSha256, 'abc');
});
