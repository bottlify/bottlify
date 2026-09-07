/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DXGI_FORMAT, DXGI_MODE_SCALING, DXGI_MODE_SCANLINE_ORDER, DXGI_SWAP_EFFECT,
    DXGI_USAGE } from './constants.js';
import {
    DXGI_MODE_DESC, DXGI_SAMPLE_DESC, DXGI_SWAP_CHAIN_DESC, readModeDesc, readSampleDesc,
    readSwapChainDesc, readU32, writeModeDesc, writeSampleDesc, writeSwapChainDesc, writeU32,
} from './structs.js';

/** @param {number} [size] */
function createMemory(size = 0x400){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} source */
        writeMemory: (address, source)=>bytes.set(source, address),
    };
}

test('the sample description is two counts and nothing else', ()=>{
    assert.equal(DXGI_SAMPLE_DESC.Count, 0x00);
    assert.equal(DXGI_SAMPLE_DESC.Quality, 0x04);
    assert.equal(DXGI_SAMPLE_DESC.SIZE, 0x08);
});

/**
 * The refresh rate is a fraction, not a number, so every field after it in the
 * mode description sits eight bytes further along than a reader who counted
 * fields would put it. That is the one offset in this structure worth an
 * assertion of its own.
 */
test('the mode description leaves room for both halves of the refresh rate', ()=>{
    assert.equal(DXGI_MODE_DESC.Width, 0x00);
    assert.equal(DXGI_MODE_DESC.Height, 0x04);
    assert.equal(DXGI_MODE_DESC.RefreshRate, 0x08);
    assert.equal(DXGI_MODE_DESC.Format, 0x10);
    assert.equal(DXGI_MODE_DESC.ScanlineOrdering, 0x14);
    assert.equal(DXGI_MODE_DESC.Scaling, 0x18);
    assert.equal(DXGI_MODE_DESC.SIZE, 0x1c);
});

test('the swap chain description begins with a whole mode description', ()=>{
    assert.equal(DXGI_SWAP_CHAIN_DESC.BufferDesc, 0x00);
    assert.equal(DXGI_SWAP_CHAIN_DESC.SampleDesc, DXGI_MODE_DESC.SIZE);
    assert.equal(DXGI_SWAP_CHAIN_DESC.BufferUsage, 0x24);
    assert.equal(DXGI_SWAP_CHAIN_DESC.BufferCount, 0x28);
    assert.equal(DXGI_SWAP_CHAIN_DESC.OutputWindow, 0x2c);
    assert.equal(DXGI_SWAP_CHAIN_DESC.Windowed, 0x30);
    assert.equal(DXGI_SWAP_CHAIN_DESC.SwapEffect, 0x34);
    assert.equal(DXGI_SWAP_CHAIN_DESC.Flags, 0x38);
    assert.equal(DXGI_SWAP_CHAIN_DESC.SIZE, 0x3c);
});

test('a DWORD round trips, and the high bit stays unsigned', ()=>{
    const memory = createMemory();
    writeU32(memory, 0x40, 0xdeadbeef);
    assert.equal(readU32(memory, 0x40), 0xdeadbeef);
    writeU32(memory, 0x40, 0xffffffff);
    assert.equal(readU32(memory, 0x40), 4294967295);
});

test('a sample description round trips', ()=>{
    const memory = createMemory();
    writeSampleDesc(memory, 0x20, { count: 4, quality: 2 });
    assert.deepEqual(readSampleDesc(memory, 0x20), { count: 4, quality: 2 });
});

test('a mode description round trips, refresh rate included', ()=>{
    const memory = createMemory();
    const mode = {
        width: 800,
        height: 600,
        refreshNumerator: 60,
        refreshDenominator: 1,
        format: DXGI_FORMAT.R8G8B8A8_UNORM,
        scanlineOrdering: DXGI_MODE_SCANLINE_ORDER.PROGRESSIVE,
        scaling: DXGI_MODE_SCALING.STRETCHED,
    };
    writeModeDesc(memory, 0x80, mode);
    assert.deepEqual(readModeDesc(memory, 0x80), mode);

    // The format really is at 0x10, not at 0x08 where a reader who took the
    // rational for one field would look for it.
    assert.equal(readU32(memory, 0x80 + 0x10), DXGI_FORMAT.R8G8B8A8_UNORM);
    assert.equal(readU32(memory, 0x80 + 0x08), 60);
});

test('a swap chain description round trips through guest memory', ()=>{
    const memory = createMemory();
    const desc = {
        bufferDesc: {
            width: 1280,
            height: 720,
            refreshNumerator: 60,
            refreshDenominator: 1,
            format: DXGI_FORMAT.B8G8R8A8_UNORM,
            scanlineOrdering: DXGI_MODE_SCANLINE_ORDER.UNSPECIFIED,
            scaling: DXGI_MODE_SCALING.UNSPECIFIED,
        },
        sampleDesc: { count: 1, quality: 0 },
        bufferUsage: DXGI_USAGE.RENDER_TARGET_OUTPUT,
        bufferCount: 2,
        outputWindow: 0x00010004,
        windowed: true,
        swapEffect: DXGI_SWAP_EFFECT.SEQUENTIAL,
        flags: 0,
    };
    writeSwapChainDesc(memory, 0x100, desc);
    assert.deepEqual(readSwapChainDesc(memory, 0x100), desc);
});

test('a windowed flag is a BOOL, so any non-zero value means true', ()=>{
    const memory = createMemory();
    writeSwapChainDesc(memory, 0x100, {
        bufferDesc: {
            width: 640,
            height: 480,
            refreshNumerator: 0,
            refreshDenominator: 0,
            format: DXGI_FORMAT.R8G8B8A8_UNORM,
            scanlineOrdering: 0,
            scaling: 0,
        },
        sampleDesc: { count: 1, quality: 0 },
        bufferUsage: 0,
        bufferCount: 1,
        outputWindow: 1,
        windowed: false,
        swapEffect: DXGI_SWAP_EFFECT.DISCARD,
        flags: 0,
    });
    assert.equal(readSwapChainDesc(memory, 0x100).windowed, false);

    writeU32(memory, 0x100 + DXGI_SWAP_CHAIN_DESC.Windowed, 0xffffffff);
    assert.equal(readSwapChainDesc(memory, 0x100).windowed, true);
    writeU32(memory, 0x100 + DXGI_SWAP_CHAIN_DESC.Windowed, 2);
    assert.equal(readSwapChainDesc(memory, 0x100).windowed, true);
});

test('writing a description touches nothing outside it', ()=>{
    const memory = createMemory();
    const base = 0x100;
    memory.bytes.fill(0xcd);
    writeSwapChainDesc(memory, base, {
        bufferDesc: {
            width: 1,
            height: 1,
            refreshNumerator: 0,
            refreshDenominator: 0,
            format: 0,
            scanlineOrdering: 0,
            scaling: 0,
        },
        sampleDesc: { count: 1, quality: 0 },
        bufferUsage: 0,
        bufferCount: 1,
        outputWindow: 0,
        windowed: false,
        swapEffect: DXGI_SWAP_EFFECT.DISCARD,
        flags: 0,
    });
    assert.equal(memory.bytes[base - 1], 0xcd, 'the byte before the structure');
    assert.equal(memory.bytes[base + DXGI_SWAP_CHAIN_DESC.SIZE], 0xcd, 'the byte after it');
});
