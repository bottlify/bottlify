/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publish } from './index.js';

/** A prefix with one installed file, which is the least a bottle is made of. */
const PREFIX = {
    root: 'C:\\Game',
    files: [{ path: 'game.exe', bytes: new TextEncoder().encode('MZ') }],
    outside: [],
    entry: 'game.exe',
};

/** Answers every request as a bottle server would, and keeps what was sent. */
function server(){
    /** @type {{ url: string, body: any }[]} */
    const sent = [];
    /** @type {any} */
    const fetch = async(/** @type {string} */ url, /** @type {any} */ init)=>{
        sent.push({ url, body: init.body });
        return { ok: true, json: async()=>({ id: 'a-title', manifest: {} }), text: async()=>'' };
    };
    return { sent, endpoint: { url: 'http://bottles/', token: 'secret', fetch } };
}

test('a bottle\'s Windows travels in its manifest', async()=>{
    const { sent, endpoint } = server();
    await publish({ prefix: PREFIX, endpoint, id: 'a-title', manifest: { windows: 'win7' } });

    const finished = sent.find(request=>request.url.endsWith('/finish'));
    assert.equal(JSON.parse(finished?.body).manifest.windows, 'win7');
});

test('a Windows that is not one of the four is refused before anything is sent', async()=>{
    // The engine would refuse it when the bottle first started, which is the
    // moment furthest from anybody able to correct the manifest.
    const { sent, endpoint } = server();
    await assert.rejects(publish({ prefix: PREFIX, endpoint, id: 'a-title',
        manifest: { windows: 'win98' } }), /the choices are win2000, winxp, win7, win10/);
    assert.equal(sent.length, 0);
});
