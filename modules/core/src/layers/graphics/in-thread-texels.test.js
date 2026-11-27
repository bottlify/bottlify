/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A root drawn on the process's own thread - no graphics worker - is given
 * names of its own in the run's cache (`module.js` `ownTexels`, the cache
 * layer's `owner`), as a root in the worker is given its own there, and lets
 * go of them with the layer. Whether its texels read the same from those
 * names as from plain memory is the gates' (`d3d9/kept-texels.test.js`,
 * `opengl/ordered-texels.test.js`, both over `ownedSpace`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphicsModule } from './module.js';
import { createCacheModule } from '../cache/module.js';
import { createFakeDevice } from './webgpu/internal/fake-device.js';
import { openRunCache } from '../../process/run-cache.js';

/** @param {any} cache @returns {any} a host that hands over what the module requires */
function hostWith(cache){
    /** @type {Record<string, any>} */
    const apis = {
        memory: { readBytes: (/** @type {number} */ _at, /** @type {number} */ length)=>
            new Uint8Array(length), writeBytes: ()=>{} },
        win32: { gdi: ()=>({ createSurfaceDc: ()=>0, deleteSurfaceDc: ()=>false,
            describeDrawable: ()=>({ key: 'window', width: 4, height: 4 }) }),
        heap: ()=>({ allocate: ()=>0 }) },
        bridge: { callGuest: ()=>Promise.resolve(0) },
        log: {},
        cache,
    };
    return { requireApi: (/** @type {string} */ name)=>apis[name] };
}

test('a root drawn on the process\'s thread holds names of its own in the run\'s cache, let go of '
    + 'with the layer', { timeout: 60_000 }, async()=>{
    const run = await openRunCache();
    try
    {
        const cacheModule = createCacheModule();
        const cache = await cacheModule.create({ reader: run.reader, join: run.join,
            serve: run.serve, own: run.own });
        const gpu = createFakeDevice({ workDone: true });
        const gpuDevice = /** @type {any} */ (gpu.device);
        gpuDevice.features = new Set();
        gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
        const graphics = createGraphicsModule();
        const api = await graphics.create({
            device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
        }, /** @type {any} */ (hostWith(cache)));
        // The process's scratches are an owner already.
        assert.deepEqual(Object.keys(run.figures().ownersOut), ['scratch/1/']);
        const texelOwners = ()=>Object.keys(run.figures().ownersOut)
            .filter(prefix=>prefix.startsWith('texels/'));
        api.create('d3d8');
        api.create('d3d9');
        assert.equal(run.figures().owners, 3, 'one owner a root, numbered by the run');
        assert.deepEqual(texelOwners(), ['texels/2/', 'texels/3/']);
        assert.equal(run.figures().served, 0, 'on this thread, no channel');
        await graphics.dispose();
        assert.deepEqual(texelOwners(), [], 'every owner let go of with the layer');
        await cacheModule.dispose();
        assert.deepEqual(run.figures().ownersOut, {}, 'nor the process\'s scratches, once it went');
        assert.equal(run.figures().ownerTails.owners, 0, 'and none left a tail');
    }
    finally
    {
        run.close();
    }
});
