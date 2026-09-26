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
import { createPresenter } from './webgpu/internal/presenter.js';
import { createFakeDevice } from './webgpu/internal/fake-device.js';
import { FVF } from './webgpu/internal/vertexformat.js';
import { D3DERR_DEVICELOST, D3DFMT, D3DPOOL, D3DRTYPE, D3D_OK } from './d3d9/constants.js';
import { D3DPT, D3DTA, D3DTOP, D3DTSS } from './d3d8/constants.js';
import { IID_IDirectDraw } from './seam/iids.js';

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

test('a Direct3D 9 object made by the module can write guest memory', async()=>{
    // UpdateSurface, StretchRect and GetRenderTargetData describe their moves
    // and make them only when the device can write guest memory; the seam
    // makes none of them itself. A factory that forgets the writer hands out
    // a device whose every copy succeeds and moves nothing.
    /** @type {{ address: number, bytes: Uint8Array }[]} */
    const writes = [];
    const memory = {
        readBytes: (/** @type {number} */ _address, /** @type {number} */ length)=>
            new Uint8Array(length).fill(7),
        writeBytes: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            writes.push({ address, bytes }),
    };
    const api = await graphicsModule.create({ allocate: ()=>0x1000 }, hostWith(memory));
    const d3d9 = api.create('d3d9');
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d9.CreateDevice({
        backBufferWidth: 4, backBufferHeight: 4, backBufferFormat: 0x16, backBufferCount: 1,
        swapEffect: 1,
    }, out), 0);
    /** @type {{ surface?: any }} */
    const source = {};
    assert.equal(out.device.CreateOffscreenPlainSurface(4, 4, 0x16, 2, source), 0);
    /** @type {{ surface?: any }} */
    const destination = {};
    assert.equal(out.device.CreateOffscreenPlainSurface(4, 4, 0x16, 0, destination), 0);
    assert.equal(out.device.UpdateSurface(source.surface, null, destination.surface, null), 0);
    assert.ok(writes.length > 0, 'the copy wrote guest memory');
    assert.equal(writes[0].bytes[0], 7, 'with the source\'s bytes');
    await graphicsModule.dispose();
});

/** Where a texture's locked bytes are written to and its surface reads from. */
const RAM_BASE = 0x40000000;
const RAM_SIZE = 1 << 16;

/** @returns {{ ram: Uint8Array, readBytes: any, writeBytes: any }} */
function ramMemory(){
    const ram = new Uint8Array(RAM_SIZE);
    return {
        ram,
        readBytes: (/** @type {number} */ address, /** @type {number} */ length)=>
            ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        writeBytes: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            ram.set(bytes, address - RAM_BASE),
    };
}

const FVF_TEXTURED_QUAD = FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);

/** A pre-transformed, textured quad spanning a 4x4 target exactly once. */
function texturedQuad(){
    const stride = 28;
    const corners = [
        [0, 0, 0, 0], [4, 0, 1, 0], [0, 4, 0, 1],
        [0, 4, 0, 1], [4, 0, 1, 0], [4, 4, 1, 1],
    ];
    const out = new Uint8Array(stride * corners.length);
    corners.forEach(([x, y, u, v], index)=>{
        const bytes = new DataView(new ArrayBuffer(stride));
        bytes.setFloat32(0, x, true);
        bytes.setFloat32(4, y, true);
        bytes.setFloat32(8, 0.5, true);
        bytes.setFloat32(12, 1, true);
        bytes.setUint32(16, 0xffffffff, true);
        bytes.setFloat32(20, u, true);
        bytes.setFloat32(24, v, true);
        out.set(new Uint8Array(bytes.buffer), index * stride);
    });
    return out;
}

/**
 * A Direct3D 9 device over a recording GPU double, with a 4x4 (one block)
 * DXT1 texture created, drawn once and presented -- so what the renderer
 * chose to upload it as can be read off the GPU double afterwards.
 *
 * @param {{ blocks: boolean, compressedTextures?: boolean, createOptions?: any }} options
 *        `blocks`: whether the adapter double reports `texture-compression-bc`.
 *        `createOptions`: passed to `api.create('d3d9', ...)` itself, as
 *        opposed to `compressedTextures`, which is the module's own config.
 * @returns {Promise<{ gpu: any, formatResult: number }>}
 */
async function drawDxtTexture({ blocks, compressedTextures, createOptions }){
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set(blocks ? ['texture-compression-bc'] : []);
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const memory = ramMemory();
    /** @type {any} */
    const config = { device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} } };
    if (compressedTextures !== undefined)
    {
        config.compressedTextures = compressedTextures;
    }
    const api = await graphicsModule.create(config, hostWith(memory));
    const d3d9 = api.create('d3d9', createOptions);
    const formatResult = d3d9.CheckDeviceFormat(0, D3DRTYPE.TEXTURE, D3DFMT.DXT1);

    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d9.CreateDevice({
        swapEffect: 1, backBufferCount: 1, backBufferWidth: 4, backBufferHeight: 4,
        backBufferFormat: D3DFMT.X8R8G8B8,
    }, out), D3D_OK);
    const { device } = out;

    /** @type {{ texture?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture(4, 4, 1, 0, D3DFMT.DXT1, D3DPOOL.MANAGED, texture), D3D_OK,
        'a DXT1 texture is always creatable');
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(await texture.texture.LockRect(0, locked, null, 0), D3D_OK);
    memory.ram.set(new Uint8Array(8).fill(3), /** @type {number} */ (locked.pBits) - RAM_BASE);
    assert.equal(texture.texture.UnlockRect(0), D3D_OK);

    assert.equal(device.SetTexture(0, texture.texture), D3D_OK);
    device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1);
    device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE);
    device.SetTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
    device.SetTextureStageState(0, D3DTSS.ALPHAARG1, D3DTA.TEXTURE);
    assert.equal(device.SetFVF(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, texturedQuad(), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    assert.equal(device.Present(), D3D_OK);
    await device.idle();

    return { gpu, formatResult };
}

test('compressedTextures off decodes a DXT texture to bgra8unorm, whatever the adapter offers',
    async()=>{
        // A change that is faster on paper and jams the GPU process on some
        // hardware is not a fix until it is measured and asked for -- so the
        // adapter's own feature bit alone must not turn BC blocks on; the
        // configuration has to ask too (module.js, `compressedTextures`). But
        // whether the format exists is a different question from how it
        // uploads: a DXT texture is legal on every device of the era, and a
        // device that keeps the flag off decodes it instead of refusing it.
        const { gpu, formatResult } = await drawDxtTexture(
            { blocks: true, compressedTextures: false });
        assert.equal(formatResult, D3D_OK, 'DXT1 is a legal format whatever the flag says');
        const uploaded = gpu.of('createTexture').find((/** @type {any} */ c)=>
            c.descriptor.label === 'texture');
        assert.equal(uploaded.descriptor.format, 'bgra8unorm',
            'the flag is off, so the surface decodes even though the adapter can sample blocks');
        assert.equal(gpu.of('copyBufferToTexture').length, 0, 'no BC blocks were staged');
        await graphicsModule.dispose();
    });

test('the adapter\'s block-compression capability and the configuration together decide'
    + ' BC blocks vs a decode -- never whether DXT exists', async()=>{
    const withBlocks = await drawDxtTexture({ blocks: true, compressedTextures: true });
    assert.equal(withBlocks.formatResult, D3D_OK);
    const bc = withBlocks.gpu.of('createTexture').find((/** @type {any} */ c)=>
        c.descriptor.label === 'texture');
    assert.equal(bc.descriptor.format, 'bc1-rgba-unorm',
        'asked for, and a device whose adapter samples blocks keeps them');
    assert.ok(withBlocks.gpu.of('copyBufferToTexture')
        .some((/** @type {any} */ c)=>c.destination.texture === bc.texture),
    'the level travelled through staging, undecoded');
    await graphicsModule.dispose();

    const withoutFeature = await drawDxtTexture({ blocks: false, compressedTextures: true });
    assert.equal(withoutFeature.formatResult, D3D_OK,
        'still legal: the format never depended on the adapter feature');
    const decoded = withoutFeature.gpu.of('createTexture').find((/** @type {any} */ c)=>
        c.descriptor.label === 'texture');
    assert.equal(decoded.descriptor.format, 'bgra8unorm',
        'asked for, but the adapter cannot sample blocks: the surface decodes');
    await graphicsModule.dispose();
});

test('a per-call compressedTextures override cannot turn BC on for a device without the feature',
    async()=>{
        // graphics.create('d3d9', { compressedTextures: true }) is a second,
        // per-call way to ask for BC blocks, independent of the module's own
        // configuration; the device's feature bit has to gate that path too,
        // or a caller can force blocks onto a device that cannot sample them.
        const { gpu, formatResult } = await drawDxtTexture(
            { blocks: false, createOptions: { compressedTextures: true } });
        assert.equal(formatResult, D3D_OK, 'still legal: the format never depended on the feature');
        const decoded = gpu.of('createTexture').find((/** @type {any} */ c)=>
            c.descriptor.label === 'texture');
        assert.equal(decoded.descriptor.format, 'bgra8unorm',
            'the override asked for blocks, but the adapter cannot sample them: it decodes');
        await graphicsModule.dispose();
    });

test('Direct3D 10 is handed block compression as 8 and 9 are, the guest clock and depth clip'
    + ' control', async()=>{
    // A timestamp query a program compares with its own timers reads the
    // guest's clock, as the raster does; block compression is asked for by
    // the configuration and granted by the adapter; unclipped depth needs a
    // device made with depth-clip-control.
    for (const features of [['texture-compression-bc', 'depth-clip-control'], []])
    {
        const gpu = createFakeDevice();
        /** @type {any} */ (gpu.device).features = new Set(features);
        const api = await graphicsModule.create({
            device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
            compressedTextures: true,
            guestNow: ()=>1234,
        }, hostWith(fakeMemory()));
        const options = api.create('d3d10');
        const granted = features.length > 0;
        assert.equal(options.compressedTextures, granted, 'block compression');
        assert.equal(options.depthClipControl, granted, 'depth clip control');
        assert.equal(options.now(), 1234, 'the guest\'s milliseconds');
        await graphicsModule.dispose();
    }
    const api = await graphicsModule.create({}, hostWith(fakeMemory()));
    const headless = api.create('d3d10');
    assert.equal(headless.compressedTextures, false);
    assert.equal(headless.depthClipControl, false);
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

test('a DirectDraw surface\'s pixels are guest memory the configuration hands out', async()=>{
    // A lock hands the program an address it writes through, and the presenter
    // reads the primary back from the same address; neither works on bytes the
    // guest cannot reach.
    /** @type {number[]} */
    const freed = [];
    const api = await graphicsModule.create({
        allocate: ()=>0x123000,
        free: (/** @type {number} */ address)=>{
            freed.push(address);
        },
    }, hostWith(fakeMemory()));
    const ddraw = api.create('ddraw');
    ddraw.setCooperativeLevel(0, 8);
    const created = ddraw.createSurface({ flags: 7, caps: 0x40, width: 4, height: 4 });
    const locked = created.surface.lock();
    assert.equal(locked.surfacePointer, 0x123000);
    created.surface.unlock(null);
    created.surface.release();
    assert.deepEqual(freed, [0x123000], 'and gives them back');
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

test('the display\'s raster runs on the guest\'s clock when the caller hands one over', async()=>{
    // A program that spins on the vertical blank or the scan line and times
    // the spin with its own timers is comparing two readings of one clock --
    // the guest's -- so the raster has to be on it too; on the host's, the
    // two drift apart whenever the machine runs slower or faster than real
    // time.
    const ram = new Uint8Array(0x1000);
    /** @type {any[]} */
    const published = [];
    let guest = 0;
    const api = await graphicsModule.create({
        guestNow: ()=>guest,
        publishInterface: (/** @type {any} */ object)=>{
            published.push(object);
            return 0x100 + published.length * 4;
        },
    }, hostWith({
        readBytes: (/** @type {number} */ at, /** @type {number} */ n)=>ram.slice(at, at + n),
        writeBytes: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>ram.set(bytes, at),
    }));
    assert.equal(api.libraries()['DDRAW.dll'].DirectDrawCreate.handler([0, 0x800, 0]), 0);
    const adapter = published[0];
    const scanLine = adapter.interfaceFor(IID_IDirectDraw).methods
        .find((/** @type {any} */ method)=>method.name === 'GetScanLine');
    /** @param {number} at @returns {number} the line the raster is on, at that guest time */
    const lineAt = at=>{
        guest = at;
        assert.equal(scanLine.invoke(adapter, [0x900]), 0);
        return new DataView(ram.buffer).getUint32(0x900, true);
    };
    assert.equal(lineAt(0), 0, 'the top of the frame at guest time zero');
    const later = lineAt(1000 / 120);
    assert.ok(later > 100, `half a frame of guest time later the beam is lower (${later})`);
    assert.equal(lineAt(0), 0, 'and it is the guest\'s clock it follows, not the host\'s');
    await graphicsModule.dispose();
});

test('a lost GPU loses every Direct3D 8 and 9 device made on it', async()=>{
    // WebGPU says its device is gone by settling device.lost; the devices a
    // program made on it then answer D3DERR_DEVICELOST from
    // TestCooperativeLevel and Present, as they do on a lost display, rather
    // than go on succeeding while nothing reaches the screen. A device made
    // after the loss starts lost.
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    /** @type {(info: any) => void} */
    let lose = ()=>{};
    gpuDevice.lost = new Promise(resolve=>{
        lose = resolve;
    });
    const api = await graphicsModule.create({
        device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
    }, hostWith(ramMemory()));
    const parameters = {
        swapEffect: 1, backBufferCount: 1, backBufferWidth: 4, backBufferHeight: 4,
        backBufferFormat: D3DFMT.X8R8G8B8,
    };
    /** @param {string} name */
    const deviceOf = name=>{
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(api.create(name).CreateDevice(parameters, out), D3D_OK);
        return out.device;
    };
    const nine = deviceOf('d3d9');
    const eight = deviceOf('d3d8');
    assert.equal(nine.TestCooperativeLevel(), D3D_OK);
    assert.equal(eight.TestCooperativeLevel(), D3D_OK);

    lose({ reason: 'unknown', message: 'the GPU process went away' });
    await gpuDevice.lost;
    await Promise.resolve();
    assert.equal(nine.TestCooperativeLevel(), D3DERR_DEVICELOST);
    assert.equal(nine.Present(), D3DERR_DEVICELOST);
    assert.equal(eight.TestCooperativeLevel(), D3DERR_DEVICELOST);
    assert.equal(deviceOf('d3d9').TestCooperativeLevel(), D3DERR_DEVICELOST,
        'and one made after it is born lost');
    await graphicsModule.dispose();
});

test('a GPU device the host destroys does not lose the program\'s devices', async()=>{
    // WebGPU settles device.lost with reason "destroyed" when destroy() was
    // called, which is the host ending the run rather than the GPU failing.
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    gpuDevice.lost = Promise.resolve({ reason: 'destroyed', message: '' });
    const api = await graphicsModule.create({
        device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
    }, hostWith(ramMemory()));
    await gpuDevice.lost;
    await Promise.resolve();
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(api.create('d3d9').CreateDevice({
        swapEffect: 1, backBufferCount: 1, backBufferWidth: 4, backBufferHeight: 4,
        backBufferFormat: D3DFMT.X8R8G8B8,
    }, out), D3D_OK);
    assert.equal(out.device.TestCooperativeLevel(), D3D_OK);
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

test('a primary presented under a visible dialog shows through the desktop, dialog on top',
    async()=>{
        // One screen: the primary belongs to the program's window, and a
        // dialog over that window stays over the picture. With nothing over
        // it and the whole screen its own, the primary goes out as it is.
        const ram = new Uint8Array(0x4000);
        const host = hostWith({
            readBytes: (/** @type {number} */ at, /** @type {number} */ n)=>ram.slice(at, at + n),
            writeBytes: ()=>{},
            window: (/** @type {number} */ at, /** @type {number} */ n)=>ram.subarray(at, at + n),
        });
        const screen = { left: 0, top: 0, right: 8, bottom: 4 };
        const game = { hwnd: '0x10', rect: screen, client: screen, visible: true, child: false,
            parent: null };
        const dialog = { hwnd: '0x20', rect: { left: 2, top: 1, right: 5, bottom: 3 },
            client: { left: 3, top: 2, right: 4, bottom: 3 }, visible: true, child: false,
            parent: '0x10' };
        const button = { hwnd: '0x24', rect: { left: 3, top: 2, right: 4, bottom: 3 },
            client: { left: 3, top: 2, right: 4, bottom: 3 }, visible: true, child: true,
            parent: '0x20' };
        let windows = [game, dialog, button];
        host.requireApi('win32').heap = ()=>({ allocate: ()=>0x1000 });
        host.requireApi('win32').windows = ()=>windows;
        /** @type {(() => void)[]} */
        const armed = [];
        const api = await graphicsModule.create({
            screen: { width: 8, height: 4, bitsPerPixel: 32 },
            now: ()=>0,
            /** @param {() => void} tick */
            schedule: tick=>armed.push(tick),
        }, host);
        const gdi = api.gdiDrawing();
        const desktop = gdi.desktop();
        assert.ok(desktop);
        // The dialog's pixels, as the window manager painted them.
        for (let y = 1; y < 3; y++)
        {
            for (let x = 2; x < 5; x++)
            {
                desktop.write(x, y, 0x00c0c0c0);
            }
        }
        // A 16-bit primary of the screen's size, solid red.
        const primary = { buffer: 0x2000, width: 8, height: 4, pitch: 16, bitCount: 16,
            palette: null };
        for (let at = 0; at < 8 * 4; at++)
        {
            ram[0x2000 + at * 2] = 0x00;
            ram[0x2000 + at * 2 + 1] = 0xf8;
        }
        const shown = ()=>{
            const metrics = /** @type {any} */ (graphicsModule.diagnostics().metrics);
            return metrics.presenter;
        };

        // The same entry the ddraw seam presents a primary through.
        const seamPresent = api.present;
        seamPresent(primary, 0x10, false);
        assert.equal(shown().lastBuffer, 0x1000, 'the desktop was shown, not the primary');
        assert.equal(desktop.read(0, 0), 0x00ff0000, 'the primary landed on the desktop');
        assert.equal(desktop.read(7, 3), 0x00ff0000);
        assert.equal(desktop.read(2, 1), 0x00c0c0c0, 'the dialog stayed on top');
        assert.equal(desktop.read(4, 2), 0x00c0c0c0);
        assert.equal(desktop.read(5, 2), 0x00ff0000, 'right up to its edge');

        // The dialog gone, the same primary is shown as it is: the desktop
        // is not touched again.
        windows = [game];
        desktop.write(0, 0, 0x00000000);
        seamPresent(primary, 0x10, false);
        assert.equal(shown().lastBuffer, 0x2000, 'the primary itself');
        assert.equal(desktop.read(0, 0), 0x00000000, 'without a copy');

        // A windowed primary is the part of the screen its window covers.
        windows = [{ ...game, client: { left: 1, top: 1, right: 4, bottom: 3 } }];
        seamPresent(primary, 0, false);
        assert.equal(shown().lastBuffer, 0x1000);
        assert.equal(desktop.read(0, 0), 0x00000000, 'outside the window: untouched');
        assert.equal(desktop.read(1, 1), 0x00ff0000, 'inside: the primary');

        // Exclusive mode is the screen whatever the window's client area,
        // and a hidden dialog covers nothing.
        windows = [{ ...game, client: { left: 1, top: 1, right: 4, bottom: 3 } },
            { ...dialog, visible: false }];
        seamPresent(primary, 0x10, true);
        assert.equal(shown().lastBuffer, 0x2000, 'shown as it is');
        await graphicsModule.dispose();
    });

test('the desktop survives the emulator growing its memory under it', async()=>{
    // A view of the emulator's memory is a view of one buffer, and growing
    // the memory replaces the buffer: every view of the old one empties. The
    // pixels are still at the same guest address, so the desktop takes its
    // view again rather than drawing into nothing from then on.
    const memory = new WebAssembly.Memory({ initial: 1 });
    let ram = new Uint8Array(memory.buffer);
    const host = hostWith({
        readBytes: (/** @type {number} */ at, /** @type {number} */ n)=>ram.slice(at, at + n),
        writeBytes: ()=>{},
        window: (/** @type {number} */ at, /** @type {number} */ n)=>ram.subarray(at, at + n),
    });
    host.requireApi('win32').heap = ()=>({ allocate: ()=>0x1000 });
    const api = await graphicsModule.create(
        { screen: { width: 8, height: 4, bitsPerPixel: 32 } }, host);
    const gdi = api.gdiDrawing();
    gdi.desktop()?.write(1, 1, 0x00ff0000);

    // Growing carries the contents over and leaves every old view empty.
    const stale = ram;
    memory.grow(1);
    ram = new Uint8Array(memory.buffer);
    assert.equal(stale.length, 0, 'the old view emptied');
    const before = gdi.desktop();
    assert.ok(before);
    assert.equal(before.read(1, 1), 0x00ff0000, 'the pixel is where it was');
    before.write(2, 1, 0x0000ff00);
    assert.deepEqual([...ram.subarray(0x1000 + 32 + 8, 0x1000 + 32 + 12)], [0, 0xff, 0, 0],
        'and a new one lands in the new buffer');
    await graphicsModule.dispose();
});

test('dispose releases this machine\'s backend and leaves the run\'s presenter untouched',
    async()=>{
        // The presenter is a service of the run: a process replacement hands
        // the same one to the next machine. So a machine's dispose takes its
        // backend with it and the canvas, its format and the texture the
        // primary is copied into stay exactly as they were.
        const gpu = createFakeDevice();
        const ram = new Uint8Array(0x10000);
        const presenter = createPresenter({
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            now: ()=>0,
        });
        const device = {
            device: gpu.device,
            queue: gpu.queue,
            screen: gpu.screen,
            canvas: gpu.canvas,
            presentTo: (/** @type {any} */ frame)=>presenter.show(frame),
        };
        const host = hostWith({
            readBytes: (/** @type {number} */ at, /** @type {number} */ n)=>ram.slice(at, at + n),
            writeBytes: ()=>{},
            window: (/** @type {number} */ at, /** @type {number} */ n)=>ram.subarray(at, at + n),
        });
        const api = await graphicsModule.create({ presenter, device }, host);
        assert.equal(presenter.diagnostics().disposed, false);

        api.present({ buffer: 0, width: 1, height: 1, pitch: 4, bitCount: 32, palette: null });
        // The presenter coalesces onto a microtask; let it flush and build the
        // backend, which is what the machine's dispose has to release.
        await new Promise(resolve=>setImmediate(resolve));
        const before = /** @type {any} */ (graphicsModule.diagnostics().metrics);
        assert.ok(before.backend, 'the machine built its backend');
        assert.ok(presenter.diagnostics().presents >= 1, 'the frame went through the presenter');

        await graphicsModule.dispose();
        const after = /** @type {any} */ (graphicsModule.diagnostics().metrics);
        assert.equal(after.backend, null, 'the backend went with the machine');
        assert.equal(presenter.diagnostics().disposed, false,
            'and the run\'s presenter was not the machine\'s to dispose');
        assert.ok(presenter.diagnostics().presents >= 1, 'its counters are untouched');
    });

test('a second instance in one realm does not take the first one\'s backend', async()=>{
    // A process replacement runs `create()` again in the same realm, and the
    // plan for two machines in one worker needs two live at once. The backend
    // belongs to the machine that asked for it, so a second create() cannot
    // hand the first one's GPU to an api that was never given a device.
    const gpu = {
        device: {
            createBuffer: ()=>({ destroy(){} }),
            createBindGroupLayout: ()=>({}),
            createCommandEncoder: ()=>({ finish: ()=>({}) }),
        },
        queue: { submit(){}, writeBuffer(){} },
        presentTo: ()=>{},
    };
    const first = await graphicsModule.create({ device: gpu }, hostWith(fakeMemory()));
    const second = await graphicsModule.create({}, hostWith(fakeMemory()));

    assert.ok(first.backend(), 'the first builds its own backend');
    assert.throws(()=>second.backend(), /no GPU device/,
        'and the second, which has none, still says so');

    await graphicsModule.dispose();
});

test('a disposed machine answers as a build with graphics disabled', async()=>{
    // A host call that was in flight when the machine was disposed retires
    // afterwards and reaches this layer. A build with `graphics: null` is the
    // stub, and a disposed machine is the same absence: every method refuses
    // the way the stub does rather than dereferencing what disposal took away.
    const api = await graphicsModule.create({}, hostWith(fakeMemory()));

    await graphicsModule.dispose();

    for (const name of ['backend', 'available', 'adapter', 'present', 'screen',
        'create', 'apis', 'libraries', 'opengl', 'gdiDrawing'])
    {
        assert.throws(()=>api[name](), (/** @type {any} */ error)=>
            error.code === 'NOT_IMPLEMENTED', `graphics.${name} refuses`);
    }
    assert.equal(graphicsModule.diagnostics().status, 'created');
});

test('diagnostics answers for the live instance', async()=>{
    await graphicsModule.create({}, hostWith(fakeMemory()));
    const second = await graphicsModule.create({}, hostWith(fakeMemory()));
    second.create('ddraw');

    const diagnostics = graphicsModule.diagnostics();
    assert.equal(diagnostics.status, 'ready');
    assert.deepEqual(diagnostics.metrics?.created, ['ddraw'],
        'the live instance is the one whose request is reported');
    await graphicsModule.dispose();
});

test('the display\'s gamma ramp is the run\'s: a device\'s goes with the machine, GDI\'s stays',
    async()=>{
        const gpu = createFakeDevice();
        const gpuDevice = /** @type {any} */ (gpu.device);
        gpuDevice.features = new Set();
        gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler',
            descriptor });
        const presenter = createPresenter({
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            now: ()=>0,
        });
        const device = {
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            presentTo: (/** @type {any} */ frame)=>presenter.show(frame),
        };
        const api = await graphicsModule.create({ presenter, device }, hostWith(ramMemory()));
        /** @param {(index: number) => number} entry */
        const rampOf = entry=>{
            const channel = Uint16Array.from({ length: 256 }, (_, index)=>entry(index));
            return { red: channel, green: channel.slice(), blue: channel.slice() };
        };
        const dim = rampOf(index=>(index >> 1) * 257);
        const inverted = rampOf(index=>(255 - index) * 257);

        const gdi = api.gdiDrawing();
        assert.equal(gdi.displayGamma(), null, 'none set: the caller answers the identity');
        gdi.setDisplayGamma(dim);
        assert.deepEqual([...(presenter.gammaRamp()?.green ?? [])], [...dim.green]);

        const d3d9 = api.create('d3d9');
        assert.equal(d3d9.caps.fullscreenGamma, true, 'the presenter draws through a ramp');
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(d3d9.CreateDevice({
            swapEffect: 1, backBufferCount: 1, backBufferWidth: 4, backBufferHeight: 4,
            backBufferFormat: D3DFMT.X8R8G8B8, windowed: false,
        }, out), D3D_OK);
        out.device.SetGammaRamp(inverted);
        assert.deepEqual([...(gdi.displayGamma()?.red ?? [])], [...inverted.red],
            'the device\'s ramp is the display\'s while it is full-screen');

        await graphicsModule.dispose();
        assert.deepEqual([...(presenter.gammaRamp()?.red ?? [])], [...dim.red],
            'the machine\'s device went with it, and the display keeps its own ramp');

        const headless = await graphicsModule.create({}, hostWith(fakeMemory()));
        assert.equal(headless.create('d3d9').caps.fullscreenGamma, false,
            'without a canvas no ramp is shown, and none is claimed');
        await graphicsModule.dispose();
    });
