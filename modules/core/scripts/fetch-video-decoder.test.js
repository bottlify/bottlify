/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
    downloadAsset, downloadViaApi, planRoutes, releaseUrl,
} from './lib/release-download.mjs';

const ASSET = { repo: 'owner/name', tag: 'v1', name: 'thing.wasm' };

/**
 * A fetch that answers from a table and records what it was asked.
 * @param {Record<string, () => Response>} answers
 */
function fakeFetch(answers){
    /** @type {{ url: string, init: RequestInit | undefined }[]} */
    const calls = [];
    /** @type {typeof fetch} */
    const impl = async(url, init)=>{
        calls.push({ url: String(url), init });
        const answer = answers[String(url)];
        return answer ? answer() : new Response('', { status: 404 });
    };
    return { impl, calls };
}

test('the plan is api with a token, then the url, then gh when on PATH', ()=>{
    assert.deepEqual(planRoutes({ token: 't', ghAvailable: true }), ['api', 'url', 'gh']);
    assert.deepEqual(planRoutes({ token: 't', ghAvailable: false }), ['api', 'url']);
    assert.deepEqual(planRoutes({ token: null, ghAvailable: true }), ['url', 'gh']);
    assert.deepEqual(planRoutes({ token: null, ghAvailable: false }), ['url']);
});

test('the api route resolves the release by tag and the asset by id, with the token', async()=>{
    const { impl, calls } = fakeFetch({
        'https://api.github.com/repos/owner/name/releases/tags/v1': ()=>Response.json(
            { assets: [{ id: 5, name: 'other' }, { id: 7, name: 'thing.wasm' }] }),
        'https://api.github.com/repos/owner/name/releases/assets/7': ()=>
            new Response(new Uint8Array([1, 2, 3])),
    });
    const bytes = await downloadViaApi({ ...ASSET, token: 'secret', fetchImpl: impl });
    assert.deepEqual([...bytes], [1, 2, 3]);
    assert.deepEqual(calls.map(c=>c.url), [
        'https://api.github.com/repos/owner/name/releases/tags/v1',
        'https://api.github.com/repos/owner/name/releases/assets/7',
    ]);
    assert.deepEqual(calls.map(c=>c.init?.headers), [
        { Authorization: 'Bearer secret', Accept: 'application/vnd.github+json' },
        { Authorization: 'Bearer secret', Accept: 'application/octet-stream' },
    ]);
    assert.ok(calls.every(c=>c.init?.redirect === 'follow'));
});

test('the api route names an asset the release does not carry', async()=>{
    const { impl } = fakeFetch({
        'https://api.github.com/repos/owner/name/releases/tags/v1': ()=>Response.json(
            { assets: [{ id: 5, name: 'other' }] }),
    });
    await assert.rejects(downloadViaApi({ ...ASSET, token: 't', fetchImpl: impl }),
        /owner\/name@v1 has no asset named thing\.wasm/);
});

test('the token does not follow the asset redirect to another origin', async()=>{
    // The storage host is stood in for by a second local server on a different
    // host name; what it receives is what the real one would.
    const storage = createServer((req, res)=>res.end(JSON.stringify(
        { auth: req.headers.authorization ?? null, accept: req.headers.accept })));
    await new Promise(r=>storage.listen(0, '127.0.0.1', ()=>r(null)));
    const storageAddress = /** @type {import("node:net").AddressInfo} */ (storage.address());
    const api = createServer((req, res)=>{
        res.writeHead(302, { location: `http://127.0.0.1:${storageAddress.port}/blob` });
        res.end();
    });
    await new Promise(r=>api.listen(0, 'localhost', ()=>r(null)));
    const apiAddress = /** @type {import("node:net").AddressInfo} */ (api.address());
    try
    {
        /** @type {typeof fetch} */
        const impl = (url, init)=>String(url).endsWith('/tags/v1')
            ? Promise.resolve(Response.json({ assets: [{ id: 1, name: 'thing.wasm' }] }))
            : fetch(`http://localhost:${apiAddress.port}/asset`, init);
        const bytes = await downloadViaApi({ ...ASSET, token: 'secret', fetchImpl: impl });
        assert.deepEqual(JSON.parse(new TextDecoder().decode(bytes)),
            { auth: null, accept: 'application/octet-stream' });
    }
    finally
    {
        api.close();
        storage.close();
    }
});

test('a route that fails hands over to the next', async()=>{
    const { impl } = fakeFetch({
        [releaseUrl('owner/name', 'v1', 'thing.wasm')]: ()=>new Response(new Uint8Array([9])),
    });
    const bytes = await downloadAsset({ ...ASSET, token: 'bad', fetchImpl: impl });
    assert.deepEqual([...bytes], [9]);
});

test('a failure names every route, tried or skipped', async()=>{
    const { impl } = fakeFetch({});
    await assert.rejects(downloadAsset({ ...ASSET, fetchImpl: impl }), e=>{
        const message = /** @type {Error} */ (e).message;
        assert.match(message, /thing\.wasm could not be downloaded from owner\/name@v1/);
        assert.match(message, /api: skipped, no token/);
        assert.match(message, /url: https:\/\/github\.com\/owner\/name\/releases\/download\/v1\/thing\.wasm: HTTP 404/);
        assert.match(message, /gh: skipped, not on PATH/);
        return true;
    });
});
