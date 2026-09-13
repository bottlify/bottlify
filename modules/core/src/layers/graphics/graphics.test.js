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
        win32: {
            gdi: ()=>({
                createSurfaceDc: ()=>0, deleteSurfaceDc: ()=>false, describeDrawable: ()=>null,
            }),
            heap: ()=>({ allocate: ()=>0 }),
        },
        bridge: { callGuest: ()=>Promise.resolve(0) },
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

test('a caller outside the drawing libraries can show a surface', async()=>{
    // Presentation is this layer's own responsibility and was reachable only
    // from inside it: the drawing libraries were handed a way to present and
    // nothing else was. A film a filter graph decoded had nowhere to send its
    // pixels, and asking found nothing to call -- which reads exactly like a
    // decoder that produced nothing.
    const api = await graphicsModule.create({}, hostWith(fakeMemory()));
    assert.equal(typeof api.present, 'function',
        'the layer that owns presentation offers it');
    await graphicsModule.dispose();
});

test('a frame is not delivered faster than the cap the caller set', async()=>{
    // A guest presents whenever its own loop finishes, which can be far more
    // often than any display shows, and every one of those costs a read of the
    // surface out of guest memory and an upload nobody sees.
    let clock = 0;
    /** @type {(() => void)[]} */
    const armed = [];
    const api = await graphicsModule.create({
        now: ()=>clock,
        /** @param {() => void} tick */
        schedule: tick=>armed.push(tick),
        maxFps: 60,
    }, hostWith(fakeMemory()));

    const shown = [];
    api.present({ buffer: 0, width: 1, height: 1, pitch: 4, bitCount: 32, palette: null });
    armed.shift()?.();
    shown.push(clock);

    // A second frame a fraction of a refresh later waits for the cap rather
    // than going straight out.
    clock = 4;
    api.present({ buffer: 0, width: 1, height: 1, pitch: 4, bitCount: 32, palette: null });
    armed.shift()?.();
    assert.ok(armed.length > 0 || clock >= 1000 / 60,
        'it was held rather than delivered inside the cap');

    await graphicsModule.dispose();
});

test('GDI drawing binds a memory context to the bytes of its bitmap in guest memory', async()=>{
    // A program draws into a DIB section and reads the pixels back through the
    // pointer it was given, so the surface has to be the bytes themselves; a
    // context over a window has no pixels here and is refused, not faked.
    const ram = new Uint8Array(0x1000);
    const api = await graphicsModule.create({}, hostWith({
        readBytes: (/** @type {number} */ at, /** @type {number} */ n)=>ram.slice(at, at + n),
        writeBytes: ()=>{},
        window: (/** @type {number} */ at, /** @type {number} */ n)=>ram.subarray(at, at + n),
    }));
    const gdi = api.gdiDrawing();
    const bitmap = { width: 4, height: 2, bitCount: 32, bits: 0x100, topDown: true };
    const surface = gdi.surfaceFor({ kind: 'memory' }, bitmap);
    assert.ok(surface);

    const drawing = gdi.create({ objects: { get: ()=>null } });
    drawing.bind(1, surface);
    assert.ok(drawing.setPixel(1, 1, 1, 0x000000ff), 'red, as a COLORREF');
    assert.deepEqual([...ram.subarray(0x100 + 16 + 4, 0x100 + 16 + 8)], [0, 0, 0xff, 0],
        'landed in guest memory, as BGRX');

    assert.equal(gdi.surfaceFor({ kind: 'window' }, { width: 4, height: 2, bitCount: 32 }), null,
        'a build with no heap has no desktop for a window context to draw on');
    assert.equal(gdi.surfaceFor({ kind: 'memory' }, { ...bitmap, bits: 0 }), null,
        'a bitmap with no storage has nothing to draw into');
    await graphicsModule.dispose();
});

test('a window context is a view of the desktop, which is presented on request', async()=>{
    // The desktop is one surface in guest memory the size of the display; a
    // context over a window draws into the part of it the window covers, and
    // presenting the desktop shows that memory the way a primary surface is.
    const ram = new Uint8Array(0x2000);
    const host = hostWith({
        readBytes: (/** @type {number} */ at, /** @type {number} */ n)=>ram.slice(at, at + n),
        writeBytes: ()=>{},
        window: (/** @type {number} */ at, /** @type {number} */ n)=>ram.subarray(at, at + n),
    });
    host.requireApi('win32').heap = ()=>({ allocate: ()=>0x1000 });
    /** @type {(() => void)[]} */
    const armed = [];
    const api = await graphicsModule.create({
        screen: { width: 8, height: 4, bitsPerPixel: 32 },
        now: ()=>0,
        /** @param {() => void} tick */
        schedule: tick=>armed.push(tick),
    }, host);
    const gdi = api.gdiDrawing();
    const view = gdi.surfaceFor(
        { kind: 'window', bounds: { left: 2, top: 1, right: 6, bottom: 3 } },
        { width: 8, height: 4, bitCount: 32 });
    assert.ok(view);
    assert.equal(view.width, 4);
    view.write(0, 0, 0x00ff0000);
    assert.equal(gdi.desktop().read(2, 1), 0x00ff0000, 'landed at the client origin');
    assert.deepEqual([...ram.subarray(0x1000 + 32 + 8, 0x1000 + 32 + 12)], [0, 0, 0xff, 0],
        'in guest memory, as BGRX, where the presenter reads it');

    gdi.presentDesktop();
    armed.shift()?.();
    const metrics = /** @type {any} */ (graphicsModule.diagnostics().metrics);
    assert.equal(metrics.presenter.presents, 1, 'the desktop reached the presenter');
    await graphicsModule.dispose();
});
