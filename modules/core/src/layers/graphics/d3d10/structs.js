/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The DXGI structures a program hands to `CreateSwapChain`, laid out the way it
 * compiled them.
 *
 * These are easier than the older APIs' descriptors in exactly one way and
 * harder in another. Easier: there are no unions and no `dwSize` version tag,
 * because DXGI never shipped a second layout for any of them -- a later
 * revision got a new structure and a new interface instead. Harder: they nest,
 * and the nesting is what the offsets have to get right. `DXGI_SWAP_CHAIN_DESC`
 * begins with a whole `DXGI_MODE_DESC`, which itself begins with two counts and
 * then a `DXGI_RATIONAL`, so `Format` sits sixteen bytes in rather than eight,
 * and a reader who counted the mode description as four fields puts every
 * following field one slot early.
 *
 * Every member of all three is a 32-bit quantity on the 32-bit ABI these run
 * under, so no field needs padding and the sizes are exactly the sums.
 */

/** DXGI_RATIONAL: the refresh rate, as a fraction rather than a number. */
export const DXGI_RATIONAL = Object.freeze({
    Numerator: 0x00,
    Denominator: 0x04,
    SIZE: 0x08,
});

export const DXGI_SAMPLE_DESC = Object.freeze({
    Count: 0x00,
    Quality: 0x04,
    SIZE: 0x08,
});

export const DXGI_MODE_DESC = Object.freeze({
    Width: 0x00,
    Height: 0x04,
    RefreshRate: 0x08,
    Format: 0x10,
    ScanlineOrdering: 0x14,
    Scaling: 0x18,
    SIZE: 0x1c,
});

export const DXGI_SWAP_CHAIN_DESC = Object.freeze({
    BufferDesc: 0x00,
    SampleDesc: 0x1c,
    BufferUsage: 0x24,
    BufferCount: 0x28,
    OutputWindow: 0x2c,
    Windowed: 0x30,
    SwapEffect: 0x34,
    Flags: 0x38,
    SIZE: 0x3c,
});

/**
 * @typedef {Object} GuestMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @returns {number} the DWORD at that address, unsigned
 */
export function readU32(memory, address){
    const bytes = memory.readMemory(address, 4);
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @param {number} value
 */
export function writeU32(memory, address, value){
    const word = value >>> 0;
    memory.writeMemory(address, new Uint8Array([
        word & 0xff,
        (word >>> 8) & 0xff,
        (word >>> 16) & 0xff,
        (word >>> 24) & 0xff,
    ]));
}

/**
 * @typedef {Object} SampleFields
 * @property {number} count
 * @property {number} quality
 */

/**
 * @typedef {Object} ModeFields
 * @property {number} width
 * @property {number} height
 * @property {number} refreshNumerator
 * @property {number} refreshDenominator
 * @property {number} format
 * @property {number} scanlineOrdering
 * @property {number} scaling
 */

/**
 * @typedef {Object} SwapChainFields
 * @property {ModeFields} bufferDesc
 * @property {SampleFields} sampleDesc
 * @property {number} bufferUsage
 * @property {number} bufferCount
 * @property {number} outputWindow
 * @property {boolean} windowed
 * @property {number} swapEffect
 * @property {number} flags
 */

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @returns {SampleFields}
 */
export function readSampleDesc(memory, address){
    return {
        count: readU32(memory, address + DXGI_SAMPLE_DESC.Count),
        quality: readU32(memory, address + DXGI_SAMPLE_DESC.Quality),
    };
}

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @param {SampleFields} sample
 */
export function writeSampleDesc(memory, address, sample){
    writeU32(memory, address + DXGI_SAMPLE_DESC.Count, sample.count);
    writeU32(memory, address + DXGI_SAMPLE_DESC.Quality, sample.quality);
}

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @returns {ModeFields}
 */
export function readModeDesc(memory, address){
    const rate = address + DXGI_MODE_DESC.RefreshRate;
    return {
        width: readU32(memory, address + DXGI_MODE_DESC.Width),
        height: readU32(memory, address + DXGI_MODE_DESC.Height),
        refreshNumerator: readU32(memory, rate + DXGI_RATIONAL.Numerator),
        refreshDenominator: readU32(memory, rate + DXGI_RATIONAL.Denominator),
        format: readU32(memory, address + DXGI_MODE_DESC.Format),
        scanlineOrdering: readU32(memory, address + DXGI_MODE_DESC.ScanlineOrdering),
        scaling: readU32(memory, address + DXGI_MODE_DESC.Scaling),
    };
}

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @param {ModeFields} mode
 */
export function writeModeDesc(memory, address, mode){
    const rate = address + DXGI_MODE_DESC.RefreshRate;
    writeU32(memory, address + DXGI_MODE_DESC.Width, mode.width);
    writeU32(memory, address + DXGI_MODE_DESC.Height, mode.height);
    writeU32(memory, rate + DXGI_RATIONAL.Numerator, mode.refreshNumerator);
    writeU32(memory, rate + DXGI_RATIONAL.Denominator, mode.refreshDenominator);
    writeU32(memory, address + DXGI_MODE_DESC.Format, mode.format);
    writeU32(memory, address + DXGI_MODE_DESC.ScanlineOrdering, mode.scanlineOrdering);
    writeU32(memory, address + DXGI_MODE_DESC.Scaling, mode.scaling);
}

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @returns {SwapChainFields}
 */
export function readSwapChainDesc(memory, address){
    return {
        bufferDesc: readModeDesc(memory, address + DXGI_SWAP_CHAIN_DESC.BufferDesc),
        sampleDesc: readSampleDesc(memory, address + DXGI_SWAP_CHAIN_DESC.SampleDesc),
        bufferUsage: readU32(memory, address + DXGI_SWAP_CHAIN_DESC.BufferUsage),
        bufferCount: readU32(memory, address + DXGI_SWAP_CHAIN_DESC.BufferCount),
        outputWindow: readU32(memory, address + DXGI_SWAP_CHAIN_DESC.OutputWindow),
        // BOOL is a 32-bit int and any non-zero value is true; a program that
        // sets it from a comparison may well pass something other than one.
        windowed: readU32(memory, address + DXGI_SWAP_CHAIN_DESC.Windowed) !== 0,
        swapEffect: readU32(memory, address + DXGI_SWAP_CHAIN_DESC.SwapEffect),
        flags: readU32(memory, address + DXGI_SWAP_CHAIN_DESC.Flags),
    };
}

/**
 * @param {GuestMemory} memory
 * @param {number} address
 * @param {SwapChainFields} desc
 */
export function writeSwapChainDesc(memory, address, desc){
    writeModeDesc(memory, address + DXGI_SWAP_CHAIN_DESC.BufferDesc, desc.bufferDesc);
    writeSampleDesc(memory, address + DXGI_SWAP_CHAIN_DESC.SampleDesc, desc.sampleDesc);
    writeU32(memory, address + DXGI_SWAP_CHAIN_DESC.BufferUsage, desc.bufferUsage);
    writeU32(memory, address + DXGI_SWAP_CHAIN_DESC.BufferCount, desc.bufferCount);
    writeU32(memory, address + DXGI_SWAP_CHAIN_DESC.OutputWindow, desc.outputWindow);
    writeU32(memory, address + DXGI_SWAP_CHAIN_DESC.Windowed, desc.windowed ? 1 : 0);
    writeU32(memory, address + DXGI_SWAP_CHAIN_DESC.SwapEffect, desc.swapEffect);
    writeU32(memory, address + DXGI_SWAP_CHAIN_DESC.Flags, desc.flags);
}
