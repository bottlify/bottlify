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

test('the diagnostics name every library the layer stands in for', async()=>{
    await mediaModule.create({});
    assert.deepEqual(mediaModule.diagnostics().metrics?.libraries, [],
        'no way into guest memory, so no hosted library');
    await mediaModule.dispose();

    const memory = new Uint8Array(0x1000);
    const api = await mediaModule.create({
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            memory.subarray(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, address),
        allocate: ()=>0,
    });
    assert.deepEqual(mediaModule.diagnostics().metrics?.libraries, Object.keys(api.libraries()),
        'every library the loader is handed is one the diagnostics report');
    assert.ok(api.libraries()['ijl15.dll']);
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

test('a machine attaches to a decoder an earlier one made', async()=>{
    let closed = 0;
    const clip = { close(){ closed++; } };
    const instance = {
        open: ()=>clip,
        openAudio: ()=>null,
        audioCapable: ()=>true,
        closeAll(){ closed++; },
        diagnostics: ()=>({ opened: 1, clips: 1, audioCapable: true, heapBytes: 0 }),
    };

    // No binary, and none needed: the instance is the decoder.
    const first = await mediaModule.create({ instance });
    assert.equal(first.available(), true, 'a given instance is enough to decode');
    assert.equal(first.instance(), instance);
    assert.equal(mediaModule.diagnostics().metrics?.configured, true);
    assert.equal(await first.open(new Uint8Array(1)), clip);

    await mediaModule.dispose();
    assert.equal(closed, 1, 'dispose closed the clip this machine opened');

    // The instance outlives the machine that used it, and the next one is
    // handed the same object rather than instantiating anything of its own.
    const second = await mediaModule.create({ instance });
    assert.equal(second.instance(), instance, 'the same decoder serves the next machine');
    await mediaModule.dispose();
});

test('a second instance in one realm does not take the first one\'s decoder', async()=>{
    // A process replacement runs `create()` again in the same realm, and the
    // plan for two machines in one worker needs two decoder views at once.
    // The instance a machine was given belongs to that machine, so a second
    // create() cannot take the first one's clips or its given decoder.
    const instance = {
        open: (/** @type {Uint8Array} */ bytes)=>({ bytes }),
        openAudio: ()=>null,
        audioCapable: ()=>true,
        closeAll(){},
        diagnostics: ()=>({ opened: 1, clips: 1, audioCapable: true, heapBytes: 0 }),
    };
    const first = await mediaModule.create({ instance });
    const second = await mediaModule.create({});

    assert.equal(first.available(), true, 'the first still has the decoder it was given');
    assert.deepEqual(await first.open(new Uint8Array([7])), { bytes: new Uint8Array([7]) });
    assert.equal(second.available(), false, 'the second has none');
    await assert.rejects(()=>second.open(new Uint8Array(1)), /no decoder binary/);

    await mediaModule.dispose();
});

test('a disposed media refuses to open rather than throwing', async()=>{
    // A host call that was in flight when the machine was disposed retires
    // afterwards and asks for a clip. A build that is gone can decode
    // nothing, so it refuses the way a build with no decoder binary does, and
    // answers the synchronous questions empty rather than dereferencing what
    // disposal took away.
    const instance = {
        open: ()=>({}),
        openAudio: ()=>null,
        audioCapable: ()=>true,
        closeAll(){},
        diagnostics: ()=>({}),
    };
    const api = await mediaModule.create({ instance });

    await mediaModule.dispose();

    assert.equal(api.available(), false);
    assert.equal(api.openAudio({ formatTag: 0x55, sampleRate: 44100, channels: 2 }), null);
    assert.equal(api.instance(), null);
    assert.deepEqual(api.libraries(), {});
    assert.deepEqual(api.ordinals(), {});
    assert.doesNotThrow(()=>api.closeAll());
    await assert.rejects(()=>api.open(new Uint8Array(1)), /no decoder binary/);
    await assert.rejects(()=>api.prepare(), /no decoder binary/);
});

test('diagnostics answers for the live instance', async()=>{
    await mediaModule.create({});
    const second = await mediaModule.create({ wasmBytes: new Uint8Array([0, 1, 2]) });

    const report = mediaModule.diagnostics();
    assert.equal(report.status, 'created');
    assert.equal(report.metrics?.configured, true,
        'the live instance was given a binary, whatever the one before it was');
    assert.equal(second.available(), true);
    await mediaModule.dispose();
});
