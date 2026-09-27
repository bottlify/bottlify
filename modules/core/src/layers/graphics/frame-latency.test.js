/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A present waits, as a Windows driver makes it wait, once the device has
 * the bound's worth of frames still to finish -- through every drawing API
 * that presents on the device, against one count for the run. The device
 * here finishes its work only when the test says so.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { graphicsModule } from './module.js';
import { createFakeDevice } from './webgpu/internal/fake-device.js';
import { D3DFMT, D3D_OK } from './d3d9/constants.js';
import { D3DCLEAR } from './d3d8/constants.js';
import { GL } from './opengl/constants.js';

/** A host that hands over only what the module declares it requires. */
function hostWith(){
    /** @type {Record<string, any>} */
    const apis = {
        memory: {
            readBytes: (/** @type {number} */ _at, /** @type {number} */ length)=>
                new Uint8Array(length),
            writeBytes: ()=>{},
        },
        win32: {
            gdi: ()=>({
                createSurfaceDc: ()=>0, deleteSurfaceDc: ()=>false,
                // Every handle is one window's DC, the size of the back buffers.
                describeDrawable: ()=>({ key: 'window', width: 4, height: 4 }),
            }),
            heap: ()=>({ allocate: ()=>0 }),
        },
        bridge: { callGuest: ()=>Promise.resolve(0) },
    };
    return /** @type {any} */ ({ requireApi: (/** @type {string} */ name)=>apis[name] });
}

/** Lets every settled promise's reactions run, and a few rounds of theirs. */
const drain = ()=>new Promise(resolve=>setImmediate(resolve));

/**
 * The module over a device whose work finishes when the test says.
 *
 * @param {number} [maxFrameLatency]
 */
async function build(maxFrameLatency){
    const gpu = createFakeDevice({ workDone: true });
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const api = await graphicsModule.create({
        device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
        maxFrameLatency,
    }, hostWith());
    return {
        gpu,
        api,
        /** @returns {any} the run presenter's count */
        latency: ()=>/** @type {any} */ (graphicsModule.diagnostics()).metrics.presenter.latency,
    };
}

/** @param {any} api @param {'d3d8' | 'd3d9'} name @returns {any} */
function deviceOf(api, name){
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(api.create(name).CreateDevice({
        swapEffect: 1, backBufferCount: 1, backBufferWidth: 4, backBufferHeight: 4,
        backBufferFormat: D3DFMT.X8R8G8B8, windowed: true,
    }, out), D3D_OK);
    return out.device;
}

/** @param {number} value  a grey, one channel's byte */
const grey = value=>(0xff000000 | value << 16 | value << 8 | value) >>> 0;

/** @param {Promise<any> | number | boolean} answer @returns {{ settled: boolean, value: any }} */
function watch(answer){
    const state = { settled: !(answer instanceof Promise), value: answer };
    if (answer instanceof Promise)
    {
        answer.then(value=>{
            state.settled = true;
            state.value = value;
        });
    }
    return state;
}

test('a Direct3D 8 present past three frames in flight waits for the oldest to finish',
    async()=>{
        const { gpu, api } = await build();
        const device = deviceOf(api, 'd3d8');
        /** @type {any[]} */
        const answers = [];
        for (let frame = 0; frame < 4; frame++)
        {
            assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, grey(frame + 1), 1, 0), D3D_OK);
            answers.push(device.Present());
        }
        assert.deepEqual(answers.slice(0, 3), [D3D_OK, D3D_OK, D3D_OK],
            'three frames go with nothing finished');
        assert.ok(answers[3] instanceof Promise, 'the fourth is held');
        const fourth = watch(answers[3]);
        await device.idle();
        await drain();
        assert.equal(gpu.count('submit'), 4, 'every frame is on the queue meanwhile');
        assert.equal(fourth.settled, false, 'and the call waits while the device works');

        gpu.finish(1);
        await drain();
        assert.deepEqual(fourth, { settled: true, value: D3D_OK },
            'the oldest finished, and the present answers as it always did');
        await graphicsModule.dispose();
    });

test('frames reach the queue in the order presented and as drawn, bound or not', async()=>{
    /**
     * @param {number} maxFrameLatency
     * @returns {Promise<{ colours: number[], submits: number, peak: number }>}
     */
    const run = async maxFrameLatency=>{
        const { gpu, api, latency } = await build(maxFrameLatency);
        const device = deviceOf(api, 'd3d8');
        let peak = 0;
        for (let frame = 0; frame < 8; frame++)
        {
            device.Clear(0, null, D3DCLEAR.TARGET, grey(frame + 1), 1, 0);
            const answer = device.Present();
            if (answer instanceof Promise)
            {
                // The device gets through a frame at a time while the call waits.
                await device.idle();
                gpu.finish(1);
                assert.equal(await answer, D3D_OK);
            }
            peak = Math.max(peak, latency().inFlight);
        }
        await device.idle();
        const colours = gpu.of('beginRenderPass').map((/** @type {any} */ call)=>
            Math.round(call.descriptor.colorAttachments[0].clearValue.r * 255));
        const submits = gpu.count('submit');
        await graphicsModule.dispose();
        return { colours, submits, peak };
    };
    const bound = await run(3);
    const free = await run(0);
    assert.deepEqual(bound.colours, [1, 2, 3, 4, 5, 6, 7, 8], 'each frame in its turn');
    assert.deepEqual(bound.colours, free.colours, 'the same frames as with no bound');
    assert.equal(bound.submits, free.submits);
    assert.ok(bound.peak <= 3, `no call answered with more than three in flight (${bound.peak})`);
});

test('a bound of zero never holds a present', async()=>{
    const { api } = await build(0);
    const device = deviceOf(api, 'd3d8');
    for (let frame = 0; frame < 10; frame++)
    {
        assert.equal(device.Present(), D3D_OK);
    }
    await graphicsModule.dispose();
});

test('Direct3D 9: the device and a swap chain beside it count against one bound', async()=>{
    const { gpu, api } = await build();
    const device = deviceOf(api, 'd3d9');
    /** @type {{ swapChain?: any }} */
    const out = {};
    assert.equal(device.CreateAdditionalSwapChain({
        swapEffect: 1, backBufferCount: 1, backBufferWidth: 4, backBufferHeight: 4,
        backBufferFormat: D3DFMT.X8R8G8B8, windowed: true,
    }, out), D3D_OK);
    const chain = out.swapChain;
    assert.equal(device.Present(), D3D_OK);
    assert.equal(chain.Present(true), D3D_OK);
    assert.equal(chain.Present(false), D3D_OK, 'a picture kept rather than shown is a frame too');
    const held = watch(device.Present());
    assert.equal(held.settled, false);
    await device.idle();
    gpu.finish(1);
    await drain();
    assert.deepEqual(held, { settled: true, value: D3D_OK });
    await graphicsModule.dispose();
});

test('OpenGL: SwapBuffers, from GDI or from WGL, waits the same way', async()=>{
    const { gpu, api } = await build();
    const gl = api.opengl();
    const hdc = 0x900d;
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>{
        const entry = gl.entry(name);
        assert.ok(entry, `${name} is implemented`);
        return entry(args);
    };
    assert.equal(call('wglSetPixelFormat', [hdc, 1, 0]), 1);
    const context = call('wglCreateContext', [hdc]);
    assert.equal(call('wglMakeCurrent', [hdc, context]), 1);
    assert.equal(gl.entry('wglSwapBuffers'), null,
        'a caller on this side has no thread to park, so it is not handed a swap');
    const wglSwapBuffers = api.libraries()['OPENGL32.dll'].wglSwapBuffers.handler;
    /** @type {any[]} */
    const answers = [];
    for (let frame = 0; frame < 4; frame++)
    {
        call('glClear', [GL.COLOR_BUFFER_BIT]);
        answers.push(frame % 2 === 0 ? gl.swapBuffers(hdc) : wglSwapBuffers([hdc]));
    }
    assert.deepEqual(answers.slice(0, 3), [true, 1, true]);
    const fourth = watch(answers[3]);
    assert.equal(fourth.settled, false, 'the fourth swap is held');
    await drain();
    assert.equal(gpu.count('submit'), 4, 'with every frame on the queue');
    assert.equal(fourth.settled, false);
    gpu.finish(1);
    await drain();
    assert.deepEqual(fourth, { settled: true, value: 1 });
    await graphicsModule.dispose();
});

test('a device without a way to say when work is done holds nothing', async()=>{
    // The recording double every other test uses has no onSubmittedWorkDone.
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    const api = await graphicsModule.create({
        device: { device: gpu.device, queue: gpu.queue, presentTo: ()=>{} },
    }, hostWith());
    const device = deviceOf(api, 'd3d8');
    for (let frame = 0; frame < 10; frame++)
    {
        assert.equal(device.Present(), D3D_OK);
    }
    await graphicsModule.dispose();
});
