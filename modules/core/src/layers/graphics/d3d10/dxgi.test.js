/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_BIND, D3D10_DRIVER_TYPE, D3D10_SDK_VERSION, DXGI_ERROR_INVALID_CALL,
    DXGI_ERROR_NOT_FOUND, DXGI_FORMAT, DXGI_SWAP_EFFECT, DXGI_USAGE, E_INVALIDARG, E_NOINTERFACE,
    IID, S_OK,
} from './constants.js';
import {
    CreateDXGIFactory, CreateDXGIFactory1, createFactory, defaultSwapChainDesc, outputModes,
} from './dxgi.js';
import { D3D10CreateDevice } from './device.js';

/** @param {object} [options] */
function createDevice(options = {}){
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(
        D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, D3D10_SDK_VERSION, out,
            options),
        S_OK);
    return out.device;
}

/** @param {any} object @param {string} what */
function assertFullyReleased(object, what){
    assert.equal(object.release(), 0, `${what} reached a reference count of zero`);
}

/** @param {object} [overrides] */
function swapChainDesc(overrides = {}){
    return { ...defaultSwapChainDesc(), outputWindow: 0x1234, ...overrides };
}

// --- the factory ---

/**
 * `CreateDXGIFactory` is the first version of the entry point, and refusing
 * `IDXGIFactory1` is how a program discovers that. The out pointer is cleared
 * on the refusal, which callers depend on.
 */
test('the factory entry point answers for its own version and no later one', ()=>{
    for (const iid of [IID.IUnknown, IID.IDXGIObject, IID.IDXGIFactory])
    {
        /** @type {{ object?: any }} */
        const out = { object: 'untouched' };
        assert.equal(CreateDXGIFactory(iid, out), S_OK, iid);
        assertFullyReleased(out.object, 'the factory');
    }

    for (const iid of [IID.IDXGIFactory1, IID.IDXGIDevice, IID.IDXGIAdapter])
    {
        /** @type {{ object?: any }} */
        const out = { object: 'untouched' };
        assert.equal(CreateDXGIFactory(iid, out), E_NOINTERFACE, iid);
        assert.equal(out.object, null, `${iid} left no object behind`);
    }
});

test('the second entry point makes a factory that is IDXGIFactory1 as well', ()=>{
    // After Wine's dxgi test_create_factory.
    for (const iid of [IID.IUnknown, IID.IDXGIObject, IID.IDXGIFactory, IID.IDXGIFactory1])
    {
        /** @type {{ object?: any }} */
        const out = {};
        assert.equal(CreateDXGIFactory1(iid, out), S_OK, iid);
        assert.ok(out.object.supports(IID.IDXGIFactory1));
        assert.equal(out.object.IsCurrent(), true);
        /** @type {{ adapter?: any }} */
        const adapter = {};
        assert.equal(out.object.EnumAdapters1(0, adapter), S_OK);
        assert.ok(adapter.adapter.supports(IID.IDXGIAdapter1));
        adapter.adapter.release();
        assertFullyReleased(out.object, 'the factory');
    }
    /** @type {{ object?: any }} */
    const refused = { object: 'untouched' };
    assert.equal(CreateDXGIFactory1(IID.IDXGIDevice, refused), E_NOINTERFACE);
    assert.equal(refused.object, null);
    /** @type {{ object?: any }} */
    const first = {};
    assert.equal(CreateDXGIFactory(IID.IDXGIFactory, first), S_OK);
    assert.ok(!first.object.supports(IID.IDXGIFactory1), 'the first version stays the first');
});

test('a factory has no parent, and says so rather than answering with nothing', ()=>{
    const factory = createFactory();
    /** @type {{ parent?: any }} */
    const out = { parent: 'untouched' };
    assert.equal(factory.GetParent(IID.IUnknown, out), E_NOINTERFACE);
    assert.equal(out.parent, null);
    assertFullyReleased(factory, 'the factory');
});

test('enumerating past the last adapter is not found, not an empty success', ()=>{
    const factory = createFactory();
    /** @type {{ adapter?: any }} */
    const first = {};
    assert.equal(factory.EnumAdapters(0, first), S_OK);
    assert.ok(first.adapter);

    /** @type {{ adapter?: any }} */
    const past = { adapter: 'untouched' };
    assert.equal(factory.EnumAdapters(factory.adapterCount(), past), DXGI_ERROR_NOT_FOUND);
    assert.equal(past.adapter, null);

    first.adapter.release();
    assertFullyReleased(factory, 'the factory');
});

/**
 * The parent chain is the whole ownership graph in one test: an output belongs
 * to its adapter, an adapter to its factory, and every hop takes a reference on
 * what it hands back.
 */
test('the parent chain runs output to adapter to factory', ()=>{
    const factory = createFactory();
    /** @type {{ adapter?: any }} */
    const enumerated = {};
    assert.equal(factory.EnumAdapters(0, enumerated), S_OK);
    const adapter = enumerated.adapter;

    /** @type {{ output?: any }} */
    const outputs = {};
    assert.equal(adapter.EnumOutputs(0, outputs), S_OK);

    /** @type {{ parent?: any }} */
    const outputParent = {};
    assert.equal(outputs.output.GetParent(IID.IDXGIAdapter, outputParent), S_OK);
    assert.equal(outputParent.parent, adapter, 'an output is its adapter\'s');
    outputParent.parent.release();

    /** @type {{ parent?: any }} */
    const adapterParent = {};
    assert.equal(adapter.GetParent(IID.IDXGIFactory, adapterParent), S_OK);
    assert.equal(adapterParent.parent, factory, 'an adapter is its factory\'s');
    adapterParent.parent.release();

    // The adapter this factory made answers to the newer interface as well; the
    // factory that produced it does not, and the pair of answers is what a
    // program reads the DXGI version out of.
    /** @type {{ parent?: any }} */
    const newer = {};
    assert.equal(adapter.GetParent(IID.IDXGIFactory1, newer), E_NOINTERFACE);
    assert.equal(newer.parent, null);

    outputs.output.release();
    adapter.release();
    assertFullyReleased(factory, 'the factory');
});

test('an adapter keeps its factory alive, and an output keeps its adapter', ()=>{
    const factory = createFactory();
    const held = factory.refCount;

    /** @type {{ adapter?: any }} */
    const enumerated = {};
    factory.EnumAdapters(0, enumerated);
    assert.equal(factory.refCount, held + 1, 'the adapter took one on the factory');

    /** @type {{ output?: any }} */
    const outputs = {};
    enumerated.adapter.EnumOutputs(0, outputs);
    assert.equal(enumerated.adapter.refCount, 2, 'the output took one on the adapter');

    outputs.output.release();
    assert.equal(enumerated.adapter.refCount, 1);
    enumerated.adapter.release();
    assert.equal(factory.refCount, held, 'the factory got its reference back');
    assertFullyReleased(factory, 'the factory');
});

// --- swap chains ---

test('a swap chain refuses the four ways of asking for nothing', ()=>{
    const device = createDevice();
    const factory = device.factory();
    /** @type {{ swapChain?: any }} */
    const out = {};

    assert.equal(factory.CreateSwapChain(null, swapChainDesc(), out), DXGI_ERROR_INVALID_CALL);
    assert.equal(factory.CreateSwapChain(device, null, out), DXGI_ERROR_INVALID_CALL);
    assert.equal(factory.CreateSwapChain(device, swapChainDesc(), null),
        DXGI_ERROR_INVALID_CALL);
    assert.equal(factory.CreateSwapChain(device, swapChainDesc({ outputWindow: 0 }), out),
        DXGI_ERROR_INVALID_CALL);
    assert.equal(out.swapChain, null, 'a refused creation leaves no object behind');

    assertFullyReleased(device, 'the device');
});

/**
 * A swap chain holds the factory and the device at once, and its parent is the
 * factory rather than the device that draws into it. Both halves are easy to
 * get half right.
 */
test('a swap chain holds its factory and its device, and parents to the factory', ()=>{
    const device = createDevice();
    const factory = device.factory();
    const factoryBefore = factory.refCount;
    const deviceBefore = device.refCount;

    /** @type {{ swapChain?: any }} */
    const out = {};
    assert.equal(factory.CreateSwapChain(device, swapChainDesc(), out), S_OK);
    assert.equal(factory.refCount, factoryBefore + 1);
    assert.equal(device.refCount, deviceBefore + 1);

    /** @type {{ parent?: any }} */
    const parent = {};
    assert.equal(out.swapChain.GetParent(IID.IDXGIFactory, parent), S_OK);
    assert.equal(parent.parent, factory, 'a swap chain belongs to the factory');
    parent.parent.release();

    assert.equal(out.swapChain.release(), 0);
    assert.equal(factory.refCount, factoryBefore, 'the factory got its reference back');
    assert.equal(device.refCount, deviceBefore, 'so did the device');
    assertFullyReleased(device, 'the device');
});

test('a swap chain reports the description it was made from', ()=>{
    const device = createDevice();
    const requested = swapChainDesc({
        bufferCount: 2,
        swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL,
    });
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, requested, created), S_OK);

    /** @type {{ desc?: any }} */
    const out = {};
    assert.equal(created.swapChain.GetDesc(out), S_OK);
    assert.deepEqual(out.desc, { ...requested, windowed: true });
    // The description handed back is a copy: writing through it must not reach
    // the swap chain's own.
    out.desc.bufferCount = 99;
    /** @type {{ desc?: any }} */
    const again = {};
    created.swapChain.GetDesc(again);
    assert.equal(again.desc.bufferCount, 2);

    created.swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('which buffers a swap chain hands out depends on its swap effect', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc({
        bufferCount: 3, swapEffect: DXGI_SWAP_EFFECT.DISCARD,
    }), created), S_OK);

    /** @type {{ buffer?: any }} */
    const zero = {};
    assert.equal(created.swapChain.GetBuffer(0, IID.ID3D10Texture2D, zero), S_OK);
    zero.buffer.release();

    /** @type {{ buffer?: any }} */
    const one = { buffer: 'untouched' };
    assert.equal(created.swapChain.GetBuffer(1, IID.ID3D10Texture2D, one),
        DXGI_ERROR_INVALID_CALL, 'a discarding chain has one reachable buffer');
    assert.equal(one.buffer, null);

    created.swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('the texture behind a back buffer is bound the way the usage word says', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc({
        bufferUsage: DXGI_USAGE.RENDER_TARGET_OUTPUT | DXGI_USAGE.SHADER_INPUT,
    }), created), S_OK);

    /** @type {{ buffer?: any }} */
    const buffer = {};
    assert.equal(created.swapChain.GetBuffer(0, IID.ID3D10Texture2D, buffer), S_OK);
    /** @type {{ desc?: any }} */
    const desc = {};
    assert.equal(buffer.buffer.GetDesc(desc), S_OK);
    assert.equal(desc.desc.BindFlags, D3D10_BIND.RENDER_TARGET | D3D10_BIND.SHADER_RESOURCE);
    assert.equal(desc.desc.DXGIUsage,
        DXGI_USAGE.RENDER_TARGET_OUTPUT | DXGI_USAGE.SHADER_INPUT
        | DXGI_USAGE.BACK_BUFFER | DXGI_USAGE.DISCARD_ON_PRESENT);
    // A back buffer is a single subresource, so it speaks DXGI as well.
    assert.ok(buffer.buffer.supports(IID.IDXGISurface));

    buffer.buffer.release();
    created.swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('a held back buffer keeps its swap chain alive', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc(), created), S_OK);
    const swapChain = created.swapChain;

    /** @type {{ buffer?: any }} */
    const buffer = {};
    assert.equal(swapChain.GetBuffer(0, IID.ID3D10Texture2D, buffer), S_OK);
    assert.equal(swapChain.refCount, 2, 'the buffer took one on the swap chain');
    assert.equal(swapChain.outstandingBuffers(), 1);

    assert.equal(swapChain.release(), 1, 'the program let go, the buffer has not');
    assert.equal(buffer.buffer.release(), 0);
    assert.equal(swapChain.refCount, 0, 'the last buffer released the swap chain');
    assertFullyReleased(device, 'the device');
});

/**
 * The rule that costs the most to discover late: a resize fails while a buffer
 * is outstanding, and it leaves the description exactly as it was. Programs
 * read the description back afterwards without checking the result.
 */
test('a resize is refused while a buffer is held, and changes nothing', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc({
        bufferCount: 2, swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL,
    }), created), S_OK);
    const swapChain = created.swapChain;

    /** @type {{ desc?: any }} */
    const before = {};
    swapChain.GetDesc(before);

    /** @type {{ buffer?: any }} */
    const held = {};
    assert.equal(swapChain.GetBuffer(0, IID.ID3D10Texture2D, held), S_OK);
    assert.equal(
        swapChain.ResizeBuffers(2, 320, 240, DXGI_FORMAT.B8G8R8A8_UNORM, 0),
        DXGI_ERROR_INVALID_CALL);

    /** @type {{ desc?: any }} */
    const after = {};
    swapChain.GetDesc(after);
    assert.deepEqual(after.desc, before.desc, 'a refused resize touched nothing');

    held.buffer.release();
    assert.equal(swapChain.ResizeBuffers(2, 320, 240, DXGI_FORMAT.B8G8R8A8_UNORM, 0), S_OK);
    /** @type {{ desc?: any }} */
    const resized = {};
    swapChain.GetDesc(resized);
    assert.equal(resized.desc.bufferDesc.width, 320);
    assert.equal(resized.desc.bufferDesc.height, 240);
    assert.equal(resized.desc.bufferDesc.format, DXGI_FORMAT.B8G8R8A8_UNORM);

    swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('a resize reads zero three different ways', ()=>{
    const device = createDevice({
        factoryOptions: { windowClientSize: ()=>({ width: 1024, height: 768 }) },
    });
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc({
        bufferCount: 2, swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL,
    }), created), S_OK);
    const swapChain = created.swapChain;

    assert.equal(swapChain.ResizeBuffers(0, 0, 0, DXGI_FORMAT.UNKNOWN, 0), S_OK);
    /** @type {{ desc?: any }} */
    const out = {};
    swapChain.GetDesc(out);
    assert.equal(out.desc.bufferCount, 2, 'zero buffers means the count it already had');
    assert.equal(out.desc.bufferDesc.width, 1024, 'a zero extent comes from the window');
    assert.equal(out.desc.bufferDesc.height, 768);
    assert.equal(out.desc.bufferDesc.format, DXGI_FORMAT.R8G8B8A8_UNORM,
        'an unknown format means the one it already had');

    // A resize is still a creation, so it is checked against the same rules.
    assert.equal(swapChain.ResizeBuffers(17, 0, 0, DXGI_FORMAT.UNKNOWN, 0),
        DXGI_ERROR_INVALID_CALL);

    swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('a buffer obtained after a resize is not the one from before it', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc(), created), S_OK);
    const swapChain = created.swapChain;

    /** @type {{ buffer?: any }} */
    const first = {};
    assert.equal(swapChain.GetBuffer(0, IID.ID3D10Texture2D, first), S_OK);
    const before = first.buffer;
    before.release();

    assert.equal(swapChain.ResizeBuffers(0, 320, 240, DXGI_FORMAT.UNKNOWN, 0), S_OK);
    /** @type {{ buffer?: any }} */
    const second = {};
    assert.equal(swapChain.GetBuffer(0, IID.ID3D10Texture2D, second), S_OK);
    assert.notEqual(second.buffer, before, 'the buffers were rebuilt');
    /** @type {{ desc?: any }} */
    const desc = {};
    second.buffer.GetDesc(desc);
    assert.equal(desc.desc.Width, 320);

    second.buffer.release();
    swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('presenting advances the buffer and is counted', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc({
        bufferCount: 2, swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL,
    }), created), S_OK);
    const swapChain = created.swapChain;

    assert.equal(swapChain.currentBackBufferIndex(), 0);
    assert.equal(swapChain.Present(0, 0), S_OK);
    assert.equal(swapChain.currentBackBufferIndex(), 1);
    assert.equal(swapChain.Present(1, 0), S_OK);
    assert.equal(swapChain.currentBackBufferIndex(), 0);

    /** @type {{ count?: number }} */
    const presents = {};
    assert.equal(swapChain.GetLastPresentCount(presents), S_OK);
    assert.equal(presents.count, 2);

    // A sync interval beyond four frames is not a request the API has a
    // meaning for.
    assert.equal(swapChain.Present(5, 0), DXGI_ERROR_INVALID_CALL);

    swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('nothing here goes fullscreen, and the target is null when it says so', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc(), created), S_OK);

    /** @type {{ fullscreen?: boolean, target?: any }} */
    const out = { fullscreen: true, target: 'untouched' };
    assert.equal(created.swapChain.GetFullscreenState(out), S_OK);
    assert.equal(out.fullscreen, false);
    assert.equal(out.target, null, 'a windowed swap chain names no output');

    created.swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('a swap chain asked for at zero by zero takes its window\'s client area, and eight where'
    + ' the window has none (test_create_swapchain, dxgi.c:2119-2186)', ()=>{
    /** @type {Record<number, { width: number, height: number }>} */
    const clients = { 0x10: { width: 206, height: 184 }, 0x20: { width: 0, height: 0 } };
    /** @type {number[]} */
    const measured = [];
    const device = createDevice({
        factoryOptions: { windowClientSize: (/** @type {number} */ window)=>{
            measured.push(window);
            return clients[window];
        } },
    });
    /** @param {number} outputWindow @param {number} width @param {number} height */
    const made = (outputWindow, width, height)=>{
        /** @type {{ swapChain?: any }} */
        const created = {};
        const desc = swapChainDesc({ outputWindow });
        desc.bufferDesc.width = width;
        desc.bufferDesc.height = height;
        assert.equal(device.factory().CreateSwapChain(device, desc, created), S_OK);
        /** @type {{ desc?: any }} */
        const out = {};
        created.swapChain.GetDesc(out);
        /** @type {{ buffer?: any }} */
        const buffer = {};
        assert.equal(created.swapChain.GetBuffer(0, IID.ID3D10Texture2D, buffer), S_OK);
        const extent = [out.desc.bufferDesc.width, out.desc.bufferDesc.height,
            buffer.buffer.desc.Width, buffer.buffer.desc.Height];
        buffer.buffer.release();
        created.swapChain.release();
        return extent;
    };
    assert.deepEqual(made(0x10, 0, 0), [206, 184, 206, 184], 'the client area, and the buffer');
    assert.deepEqual(made(0x20, 0, 0), [8, 8, 8, 8], 'an empty client area');
    assert.deepEqual(made(0x10, 0, 50), [206, 50, 206, 50], 'only the side asked for as zero');
    measured.length = 0;
    assert.deepEqual(made(0x10, 64, 32), [64, 32, 64, 32]);
    assert.deepEqual(measured, [], 'a window is measured only when a side is zero');
    assertFullyReleased(device, 'the device');
});

test('a swap chain is made at a sample count its device makes textures at, and at no other',
    ()=>{
        const device = createDevice();
        /** @param {number} count @param {number} quality */
        const made = (count, quality)=>{
            /** @type {{ swapChain?: any }} */
            const created = {};
            const hr = device.factory().CreateSwapChain(device,
                swapChainDesc({ sampleDesc: { count, quality } }), created);
            return { hr, swapChain: created.swapChain };
        };
        const four = made(4, 0);
        assert.equal(four.hr, S_OK);
        /** @type {{ buffer?: any }} */
        const buffer = {};
        assert.equal(four.swapChain.GetBuffer(0, IID.ID3D10Texture2D, buffer), S_OK);
        assert.deepEqual(buffer.buffer.desc.SampleDesc, { Count: 4, Quality: 0 },
            'the back buffer is multisampled');
        buffer.buffer.release();
        four.swapChain.release();
        for (const [count, quality] of [[2, 0], [4, 1], [0, 0], [64, 0]])
        {
            assert.deepEqual(made(count, quality), { hr: E_INVALIDARG, swapChain: null },
                `${count} samples at quality ${quality}`);
        }
        assertFullyReleased(device, 'the device');
    });

test('a present that only tests shows, counts and rotates nothing'
    + ' (test_swapchain_present_count, dxgi.c:8519-8524)', async()=>{
    /** @type {any[]} */
    const shown = [];
    const device = createDevice();
    const present = device.present;
    device.present = (/** @type {any} */ buffer)=>{
        shown.push(buffer);
        return present.call(device, buffer);
    };
    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc({
        bufferCount: 2, swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL,
    }), created), S_OK);
    const swapChain = created.swapChain;
    assert.equal(await swapChain.Present(0, 0), S_OK);
    assert.equal(await swapChain.Present(0, 1), S_OK, 'DXGI_PRESENT_TEST');
    /** @type {{ count?: number }} */
    const presents = {};
    swapChain.GetLastPresentCount(presents);
    assert.equal(presents.count, 1);
    assert.equal(swapChain.currentBackBufferIndex(), 1);
    assert.equal(shown.length, 1, 'one frame went to the device');
    swapChain.release();
    assertFullyReleased(device, 'the device');
});

test('a swap chain is made only in a format it can be shown in (test_create_swapchain,'
    + ' dxgi.c:2100-2108)', ()=>{
    const device = createDevice();
    /** @param {number} format @param {boolean} windowed */
    const made = (format, windowed = true)=>{
        /** @type {{ swapChain?: any }} */
        const created = {};
        const desc = swapChainDesc({ windowed });
        desc.bufferDesc.format = format;
        const hr = device.factory().CreateSwapChain(device, desc, created);
        created.swapChain?.release();
        return [hr, created.swapChain ?? null];
    };
    for (const format of [DXGI_FORMAT.R8G8B8A8_UNORM, DXGI_FORMAT.R8G8B8A8_UNORM_SRGB,
        DXGI_FORMAT.B8G8R8A8_UNORM, DXGI_FORMAT.B8G8R8A8_UNORM_SRGB,
        DXGI_FORMAT.R16G16B16A16_FLOAT, DXGI_FORMAT.R10G10B10A2_UNORM])
    {
        assert.equal(made(format)[0], S_OK, `format ${format}`);
    }
    for (const format of [DXGI_FORMAT.UNKNOWN, DXGI_FORMAT.R8G8B8A8_TYPELESS,
        DXGI_FORMAT.BC5_UNORM, DXGI_FORMAT.R32_FLOAT])
    {
        assert.deepEqual(made(format), [E_INVALIDARG, null], `format ${format}`);
    }
    assert.deepEqual(made(DXGI_FORMAT.UNKNOWN, false), [E_INVALIDARG, null], 'fullscreen too');
    const size = { width: 1024, height: 768 };
    assert.deepEqual([DXGI_FORMAT.R16G16B16A16_FLOAT, DXGI_FORMAT.R10G10B10A2_UNORM,
        DXGI_FORMAT.R32_FLOAT].map(format=>outputModes(size, format).length > 0),
    [true, true, false], 'an output lists modes in the formats a swap chain is shown in');

    /** @type {{ swapChain?: any }} */
    const created = {};
    assert.equal(device.factory().CreateSwapChain(device, swapChainDesc(), created), S_OK);
    assert.equal(created.swapChain.ResizeBuffers(0, 0, 0, DXGI_FORMAT.BC5_UNORM, 0),
        E_INVALIDARG);
    /** @type {{ desc?: any }} */
    const out = {};
    created.swapChain.GetDesc(out);
    assert.equal(out.desc.bufferDesc.format, DXGI_FORMAT.R8G8B8A8_UNORM, 'kept as it was');
    created.swapChain.release();
    assertFullyReleased(device, 'the device');
});
