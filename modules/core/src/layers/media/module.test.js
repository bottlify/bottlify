/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mediaModule } from './module.js';

test('a build with no decoder binary comes up and says so', async()=>{
    const api = await mediaModule.create({});
    assert.equal(api.available(), false);

    const diagnostics = mediaModule.diagnostics();
    assert.equal(diagnostics.metrics?.configured, false);
    assert.match(diagnostics.issues?.[0] ?? '', /no decoder binary/i);

    await assert.rejects(()=>api.open(new Uint8Array(8)), /no decoder binary/);
    await mediaModule.dispose();
});

test('a configured build is not instantiated until something is opened', async()=>{
    // The bytes are never valid wasm: reaching instantiation at all is the
    // failure this is watching for, and it would show up as a rejection here.
    const api = await mediaModule.create({ wasmBytes: new Uint8Array([0, 1, 2]) });
    assert.equal(api.available(), true);
    assert.equal(mediaModule.diagnostics().status, 'created');
    assert.deepEqual(mediaModule.diagnostics().issues, []);
    await mediaModule.dispose();
});

test('closing everything is safe before anything was opened', async()=>{
    const api = await mediaModule.create({});
    api.closeAll();
    await mediaModule.dispose();
});

test('a packet-fed stream is null until there is a decoder to answer with', async()=>{
    const shape = { formatTag: 0x55, sampleRate: 44100, channels: 2 };
    let api = await mediaModule.create({});
    assert.equal(api.openAudio(shape), null, 'no binary: nothing to decode with');
    await mediaModule.dispose();

    // A binary that is not up yet answers null and starts coming up, so the
    // next stream finds it; one that cannot come up says so in the issues.
    api = await mediaModule.create({ wasmBytes: new Uint8Array([0, 1, 2]) });
    assert.equal(api.openAudio(shape), null);
    for (let guard = 0; guard < 50 && mediaModule.diagnostics().issues?.length === 0; guard++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
    assert.match(mediaModule.diagnostics().issues?.[0] ?? '', /could not be instantiated/);
    await mediaModule.dispose();
});
