/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the layer promises the rest of the build, as opposed to what any one
 * drawing API promises a program. Those are checked in each API's own
 * directory; this is about assembly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphicsModule } from './module.js';

/** A host that hands over only what the module declares it requires. */
function hostWith(/** @type {any} */ memory){
    /** @type {Record<string, any>} */
    const apis = {
        memory,
        // Only the part this layer reaches for: a device context over a surface
        // it owns rather than gdi32 does.
        win32: { gdi: ()=>({ createSurfaceDc: ()=>0, deleteSurfaceDc: ()=>false }) },
    };
    return /** @type {any} */ ({
        requireApi: (/** @type {string} */ name)=>{
            if (!(name in apis))
            {
                throw new Error(`unexpected requireApi("${name}")`);
            }
            return apis[name];
        },
    });
}

const fakeMemory = ()=>({
    readBytes: ()=>new Uint8Array(0),
    writeBytes: ()=>{},
});

test('a build with no GPU still comes up', async()=>{
    // Building the module graph must not require a device: a console program, a
    // test, or an inspection of the configuration should not pay for one, and a
    // machine without WebGPU has to reach a running engine rather than fail at
    // assembly.
    const api = await graphicsModule.create({}, hostWith(fakeMemory()));

    assert.equal(api.available(), false);
    assert.ok(api.apis().length > 0, 'the APIs are still enumerable');
    assert.throws(()=>api.backend(), /no GPU device/);

    await graphicsModule.dispose();
});

test('the backend is built once, on first use', async()=>{
    let built = 0;
    const device = {
        device: {
            createBuffer: ()=>({ destroy(){} }),
            createBindGroupLayout: ()=>({}),
            createCommandEncoder: ()=>({ finish: ()=>({}) }),
        },
        queue: { submit(){}, writeBuffer(){} },
        presentTo: ()=>{
            built++;
        },
    };

    const api = await graphicsModule.create({ device }, hostWith(fakeMemory()));
    assert.equal(api.available(), true);

    const first = api.backend();
    assert.equal(api.backend(), first, 'a second ask gets the same backend');
    assert.equal(built, 0, 'and nothing was presented merely by asking');

    await graphicsModule.dispose();
});

test('an API is made by name, and an unknown one says so', async()=>{
    const api = await graphicsModule.create({}, hostWith(fakeMemory()));

    const ddraw = api.create('ddraw');
    assert.ok(ddraw, 'DirectDraw is one of them');
    assert.throws(()=>api.create('directdraw'), /no such API/,
        'a near-miss name is an error, not a silent null');

    await graphicsModule.dispose();
});

test('diagnostics report what a program asked for, not what was on offer', async()=>{
    const api = await graphicsModule.create({}, hostWith(fakeMemory()));
    api.create('ddraw');
    api.create('d3d9');
    api.create('ddraw');

    const diagnostics = graphicsModule.diagnostics();
    const metrics = /** @type {any} */ (diagnostics.metrics);
    assert.equal(diagnostics.status, 'ready');
    assert.deepEqual(metrics.created, ['ddraw', 'd3d9', 'ddraw'],
        'in order, and repeats kept: which API a program settled on is the question');
    assert.equal(metrics.backend, null, 'nothing was drawn, so there is no backend');

    await graphicsModule.dispose();
    assert.equal(graphicsModule.diagnostics().status, 'created');
});
