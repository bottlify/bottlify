/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placementOf, publish } from './index.js';

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

test('a bottle\'s manifest says where its installation put it', async()=>{
    const { sent, endpoint } = server();
    await publish({ prefix: PREFIX, endpoint, id: 'a-title' });

    const finished = sent.find(request=>request.url.endsWith('/finish'));
    assert.equal(JSON.parse(finished?.body).manifest.root, 'C:\\Game');
});

test('a bottle is mounted where its installation put it, and started from there', ()=>{
    // The registry the installation left names that directory, and a launcher
    // changes into it before it starts the game.
    assert.deepEqual(placementOf({ entry: 'TRON.exe',
        root: 'C:\\Program Files\\Buena Vista Interactive\\Tron 2.0 Demo' }), {
        prefix: 'Program Files\\Buena Vista Interactive\\Tron 2.0 Demo',
        imagePath: 'C:\\Program Files\\Buena Vista Interactive\\Tron 2.0 Demo\\TRON.exe',
    });
    assert.deepEqual(placementOf({ entry: 'game.exe', root: 'c:\\Games\\Game\\' }),
        { prefix: 'Games\\Game', imagePath: 'C:\\Games\\Game\\game.exe' },
        'a drive letter in either case, a trailing separator or none');
    assert.deepEqual(placementOf({ entry: 'game.exe', root: 'C:\\' }),
        { prefix: '', imagePath: 'C:\\game.exe' }, 'installed at the root');
    assert.deepEqual(placementOf({ entry: 'game.exe' }),
        { prefix: 'App', imagePath: 'C:\\App\\game.exe' }, 'a bottle that says nothing');
    assert.deepEqual(placementOf({ entry: 'game.exe', root: 'D:\\Games\\Game' }),
        { prefix: 'App', imagePath: 'C:\\App\\game.exe' },
        'a bundle is mounted on C:, whatever drive it was installed on');
});
