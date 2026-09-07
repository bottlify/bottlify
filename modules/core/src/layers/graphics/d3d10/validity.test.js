/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_BIND, D3D10_CPU_ACCESS, D3D10_USAGE, DXGI_FORMAT, DXGI_SWAP_EFFECT, DXGI_USAGE,
    E_INVALIDARG, S_OK,
} from './constants.js';
import {
    RESOURCE_ACCESS, backBufferUsage, bindFlagsForUsage, bufferCreateResult,
    formatAllowsBind, fullMipChainLength, highestAccessibleBuffer, resolveViewFormat,
    resourceAccessResult, swapChainDescResult, usageRequiresCpuAccess,
} from './validity.js';

const CPU_ACCESS_CASES = [
    0,
    D3D10_CPU_ACCESS.WRITE,
    D3D10_CPU_ACCESS.READ,
    D3D10_CPU_ACCESS.WRITE | D3D10_CPU_ACCESS.READ,
];

/**
 * The whole usage x bind x CPU-access table, walked row by row.
 *
 * The expectation is computed from the row rather than listed a fourth time,
 * because the rule the row encodes is the thing under test: a combination is
 * valid, the CPU access asked for is within what the row permits, and a usage
 * that needs CPU access got some.
 */
test('usage, bind flags and CPU access decide whether a resource exists', ()=>{
    for (const row of RESOURCE_ACCESS)
    {
        for (const cpuAccess of CPU_ACCESS_CASES)
        {
            const permitted = (cpuAccess & ~row.allowedCpuAccess) === 0;
            const satisfied = !usageRequiresCpuAccess(row.usage) || cpuAccess !== 0;
            const expected = row.valid && permitted && satisfied ? S_OK : E_INVALIDARG;
            const label = `usage ${row.usage} bind ${row.bindFlags} cpu ${cpuAccess}`;
            assert.equal(resourceAccessResult(row.usage, row.bindFlags, cpuAccess), expected,
                label);
        }
    }
});

test('a dynamic or staging resource the CPU cannot reach is refused', ()=>{
    assert.equal(usageRequiresCpuAccess(D3D10_USAGE.DEFAULT), false);
    assert.equal(usageRequiresCpuAccess(D3D10_USAGE.IMMUTABLE), false);
    assert.equal(usageRequiresCpuAccess(D3D10_USAGE.DYNAMIC), true);
    assert.equal(usageRequiresCpuAccess(D3D10_USAGE.STAGING), true);

    assert.equal(
        resourceAccessResult(D3D10_USAGE.DYNAMIC, D3D10_BIND.VERTEX_BUFFER, 0), E_INVALIDARG);
    assert.equal(
        resourceAccessResult(D3D10_USAGE.DYNAMIC, D3D10_BIND.VERTEX_BUFFER,
            D3D10_CPU_ACCESS.WRITE), S_OK);
    // Staging is the only usage that reads back, and the only one that takes no
    // bind flag at all.
    assert.equal(resourceAccessResult(D3D10_USAGE.STAGING, 0, D3D10_CPU_ACCESS.READ), S_OK);
    assert.equal(
        resourceAccessResult(D3D10_USAGE.STAGING, D3D10_BIND.SHADER_RESOURCE,
            D3D10_CPU_ACCESS.READ), E_INVALIDARG);
    assert.equal(resourceAccessResult(D3D10_USAGE.DEFAULT, 0, D3D10_CPU_ACCESS.READ),
        E_INVALIDARG, 'a default resource is never readable by the CPU');
});

const IMMUTABLE_VERTEX = {
    ByteWidth: 1024,
    Usage: D3D10_USAGE.IMMUTABLE,
    BindFlags: D3D10_BIND.VERTEX_BUFFER,
    CPUAccessFlags: 0,
    MiscFlags: 0,
};

test('an immutable resource must arrive with its contents', ()=>{
    assert.equal(bufferCreateResult(IMMUTABLE_VERTEX, true), S_OK);
    // Nothing may ever write it -- not the CPU, not the GPU -- so a creation
    // that supplies nothing has made a resource that can never hold anything.
    assert.equal(bufferCreateResult(IMMUTABLE_VERTEX, false), E_INVALIDARG);
});

test('a constant buffer is a whole number of registers or nothing', ()=>{
    for (let size = 0; size <= 48; size++)
    {
        const desc = {
            ByteWidth: size,
            Usage: D3D10_USAGE.DEFAULT,
            BindFlags: D3D10_BIND.CONSTANT_BUFFER,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        const expected = size !== 0 && size % 16 === 0 ? S_OK : E_INVALIDARG;
        assert.equal(bufferCreateResult(desc, false), expected, `size ${size}`);
    }
    // The rule is the constant buffer's alone: a vertex buffer of the same odd
    // size is fine.
    assert.equal(bufferCreateResult({
        ByteWidth: 17,
        Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.VERTEX_BUFFER,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    }, false), S_OK);
});

test('a format decides which bind flags a texture may carry', ()=>{
    /** @type {[number, number, boolean][]} */
    const cases = [
        [DXGI_FORMAT.R8G8B8A8_UNORM, D3D10_BIND.SHADER_RESOURCE, true],
        [DXGI_FORMAT.R8G8B8A8_UNORM, D3D10_BIND.RENDER_TARGET, true],
        [DXGI_FORMAT.R8G8B8A8_UNORM, D3D10_BIND.DEPTH_STENCIL, false],
        [DXGI_FORMAT.D24_UNORM_S8_UINT, D3D10_BIND.DEPTH_STENCIL, true],
        [DXGI_FORMAT.D24_UNORM_S8_UINT, D3D10_BIND.SHADER_RESOURCE, false],
        [DXGI_FORMAT.D24_UNORM_S8_UINT, D3D10_BIND.RENDER_TARGET, false],
        [DXGI_FORMAT.D32_FLOAT, D3D10_BIND.DEPTH_STENCIL, true],
        [DXGI_FORMAT.D32_FLOAT, D3D10_BIND.SHADER_RESOURCE, false],
        // A typeless format may be whatever its family can express, which is
        // how one resource carries both a depth view and a sampled one.
        [DXGI_FORMAT.R32_TYPELESS, D3D10_BIND.DEPTH_STENCIL, true],
        [DXGI_FORMAT.R32_TYPELESS, D3D10_BIND.SHADER_RESOURCE, true],
        [DXGI_FORMAT.R24G8_TYPELESS, D3D10_BIND.DEPTH_STENCIL, true],
        [DXGI_FORMAT.R24G8_TYPELESS, D3D10_BIND.SHADER_RESOURCE, true],
        // ...but only if the family has a depth format in it at all.
        [DXGI_FORMAT.R32G32B32A32_TYPELESS, D3D10_BIND.DEPTH_STENCIL, false],
        [DXGI_FORMAT.R8G8B8A8_TYPELESS, D3D10_BIND.DEPTH_STENCIL, false],
        [DXGI_FORMAT.R8G8B8A8_TYPELESS, D3D10_BIND.RENDER_TARGET, true],
    ];
    for (const [format, bindFlag, expected] of cases)
    {
        assert.equal(formatAllowsBind(format, bindFlag), expected,
            `format ${format} bind ${bindFlag}`);
    }
});

test('a view names a type, and only one its resource can be cast to', ()=>{
    // A typed resource inherits its own format when the view names none.
    assert.equal(
        resolveViewFormat(DXGI_FORMAT.R8G8B8A8_UNORM, DXGI_FORMAT.UNKNOWN),
        DXGI_FORMAT.R8G8B8A8_UNORM);
    // A typeless one has nothing to inherit, so there is no default view.
    assert.equal(resolveViewFormat(DXGI_FORMAT.R8G8B8A8_TYPELESS, DXGI_FORMAT.UNKNOWN), null);
    assert.equal(
        resolveViewFormat(DXGI_FORMAT.R8G8B8A8_TYPELESS, DXGI_FORMAT.R8G8B8A8_UNORM),
        DXGI_FORMAT.R8G8B8A8_UNORM);
    assert.equal(
        resolveViewFormat(DXGI_FORMAT.R24G8_TYPELESS, DXGI_FORMAT.D24_UNORM_S8_UINT),
        DXGI_FORMAT.D24_UNORM_S8_UINT);
    // Across families is not a cast, it is a different layout.
    assert.equal(
        resolveViewFormat(DXGI_FORMAT.R8G8B8A8_TYPELESS, DXGI_FORMAT.R16G16_UNORM), null);
    // A typeless view format names no type either way round.
    assert.equal(
        resolveViewFormat(DXGI_FORMAT.D24_UNORM_S8_UINT, DXGI_FORMAT.R24G8_TYPELESS), null);
    // A typed resource may not be reinterpreted, even within its family.
    assert.equal(
        resolveViewFormat(DXGI_FORMAT.R8G8B8A8_UNORM, DXGI_FORMAT.R8G8B8A8_UINT),
        DXGI_FORMAT.R8G8B8A8_UINT);
});

test('a full mip chain is as long as the largest extent takes to reach one', ()=>{
    assert.equal(fullMipChainLength(1, 1, 1), 1);
    assert.equal(fullMipChainLength(512, 512, 1), 10);
    assert.equal(fullMipChainLength(512, 1, 1), 10);
    assert.equal(fullMipChainLength(4, 8, 1), 4);
    // Not a power of two: the chain runs until the extent would fall below one.
    assert.equal(fullMipChainLength(5, 1, 1), 3);
});

// --- swap chains ---

/** A description that differs from the default only where a case says so. */
function swapChainDesc(overrides = {}){
    return {
        bufferDesc: {
            width: 640,
            height: 480,
            refreshNumerator: 60,
            refreshDenominator: 1,
            format: DXGI_FORMAT.R8G8B8A8_UNORM,
            scanlineOrdering: 0,
            scaling: 0,
        },
        sampleDesc: { count: 1, quality: 0 },
        bufferUsage: DXGI_USAGE.RENDER_TARGET_OUTPUT,
        bufferCount: 1,
        outputWindow: 0x1234,
        windowed: true,
        swapEffect: DXGI_SWAP_EFFECT.DISCARD,
        flags: 0,
        ...overrides,
    };
}

/**
 * The buffer count each swap effect accepts. The two flip effects are the
 * interesting rows: they refuse the single buffer the older effects are happy
 * with, and both refuse seventeen where sixteen is fine.
 */
const SWAP_CHAIN_CASES = [
    { swapEffect: DXGI_SWAP_EFFECT.DISCARD, bufferCount: 1, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.DISCARD, bufferCount: 2, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.DISCARD, bufferCount: 16, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.DISCARD, bufferCount: 17, expected: E_INVALIDARG },
    { swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL, bufferCount: 1, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL, bufferCount: 3, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL, bufferCount: 16, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL, bufferCount: 17, expected: E_INVALIDARG },
    { swapEffect: DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL, bufferCount: 0, expected: E_INVALIDARG },
    { swapEffect: DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL, bufferCount: 1, expected: E_INVALIDARG },
    { swapEffect: DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL, bufferCount: 2, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL, bufferCount: 16, expected: S_OK },
    { swapEffect: DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL, bufferCount: 17, expected: E_INVALIDARG },
    { swapEffect: DXGI_SWAP_EFFECT.FLIP_DISCARD, bufferCount: 1, expected: E_INVALIDARG },
    { swapEffect: DXGI_SWAP_EFFECT.FLIP_DISCARD, bufferCount: 2, expected: S_OK },
    // 2 and 5 are values the enumeration does not define, and a hole in an
    // enumeration is a failure rather than a nearest match.
    { swapEffect: 2, bufferCount: 2, expected: E_INVALIDARG },
    { swapEffect: 5, bufferCount: 2, expected: E_INVALIDARG },
];

test('the swap effect and the buffer count are checked together', ()=>{
    for (const testCase of SWAP_CHAIN_CASES)
    {
        const label = `effect ${testCase.swapEffect}, ${testCase.bufferCount} buffers`;
        assert.equal(swapChainDescResult(swapChainDesc(testCase)), testCase.expected, label);
    }
});

test('a flip swap chain cannot be multisampled', ()=>{
    const multisampled = { sampleDesc: { count: 4, quality: 0 } };
    assert.equal(swapChainDescResult(swapChainDesc({
        swapEffect: DXGI_SWAP_EFFECT.DISCARD, bufferCount: 4, ...multisampled,
    })), S_OK);
    assert.equal(swapChainDescResult(swapChainDesc({
        swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL, bufferCount: 4, ...multisampled,
    })), S_OK);
    // A flip presents the buffer itself, so there is nothing left to resolve
    // the samples into.
    assert.equal(swapChainDescResult(swapChainDesc({
        swapEffect: DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL, bufferCount: 4, ...multisampled,
    })), E_INVALIDARG);
    assert.equal(swapChainDescResult(swapChainDesc({
        swapEffect: DXGI_SWAP_EFFECT.FLIP_DISCARD, bufferCount: 4, ...multisampled,
    })), E_INVALIDARG);
});

test('a swap chain with no output window is refused', ()=>{
    assert.equal(swapChainDescResult(swapChainDesc({ outputWindow: 0 })), E_INVALIDARG);
});

test('a discarding swap chain hands out one buffer however many it has', ()=>{
    assert.equal(highestAccessibleBuffer(DXGI_SWAP_EFFECT.DISCARD, 1), 0);
    assert.equal(highestAccessibleBuffer(DXGI_SWAP_EFFECT.DISCARD, 16), 0);
    assert.equal(highestAccessibleBuffer(DXGI_SWAP_EFFECT.FLIP_DISCARD, 16), 0);
    // A sequential chain is the other way: every buffer is reachable, and the
    // ones past zero are the readable history.
    assert.equal(highestAccessibleBuffer(DXGI_SWAP_EFFECT.SEQUENTIAL, 3), 2);
    assert.equal(highestAccessibleBuffer(DXGI_SWAP_EFFECT.SEQUENTIAL, 16), 15);
    assert.equal(highestAccessibleBuffer(DXGI_SWAP_EFFECT.FLIP_SEQUENTIAL, 16), 15);
});

test('a back buffer reports more usage than was asked for', ()=>{
    const asked = DXGI_USAGE.RENDER_TARGET_OUTPUT;
    assert.equal(backBufferUsage(asked, 0),
        asked | DXGI_USAGE.BACK_BUFFER | DXGI_USAGE.DISCARD_ON_PRESENT);
    // Every buffer past zero is history: readable, and never discarded on a
    // present because it is what a present produced.
    assert.equal(backBufferUsage(asked, 1),
        asked | DXGI_USAGE.BACK_BUFFER | DXGI_USAGE.READ_ONLY);
});

test('a swap chain usage word and a bind flag word are the same idea', ()=>{
    assert.equal(bindFlagsForUsage(0), 0);
    assert.equal(bindFlagsForUsage(DXGI_USAGE.RENDER_TARGET_OUTPUT), D3D10_BIND.RENDER_TARGET);
    assert.equal(bindFlagsForUsage(DXGI_USAGE.SHADER_INPUT), D3D10_BIND.SHADER_RESOURCE);
    assert.equal(
        bindFlagsForUsage(DXGI_USAGE.SHADER_INPUT | DXGI_USAGE.RENDER_TARGET_OUTPUT),
        D3D10_BIND.SHADER_RESOURCE | D3D10_BIND.RENDER_TARGET);
    // The bits that describe presentation rather than the pipeline contribute
    // nothing to the texture behind the buffer.
    assert.equal(bindFlagsForUsage(DXGI_USAGE.BACK_BUFFER | DXGI_USAGE.DISCARD_ON_PRESENT), 0);
});
