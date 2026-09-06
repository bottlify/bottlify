/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PFD } from './constants.js';
import {
    PIXELFORMATDESCRIPTOR,
    PIXEL_FORMATS,
    choosePixelFormat,
    readPixelFormatDescriptor,
    writePixelFormatDescriptor,
} from './pixelformat.js';

/**
 * These are the only tests in this directory with no context to tear down:
 * a structure layout and a scoring rule are decided before anything is
 * created, and every test that does create one asserts it was destroyed.
 */

/** @param {number} bytes */
function memoryOf(bytes){
    const storage = new Uint8Array(bytes);
    return {
        storage,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>storage.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>storage.set(data, address),
    };
}

/** @param {Partial<import('./pixelformat.js').PixelFormat>} fields */
function request(fields){
    return {
        nSize: PIXELFORMATDESCRIPTOR.SIZE,
        nVersion: 1,
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL,
        iPixelType: PFD.TYPE_RGBA,
        cColorBits: 0,
        cRedBits: 0,
        cRedShift: 0,
        cGreenBits: 0,
        cGreenShift: 0,
        cBlueBits: 0,
        cBlueShift: 0,
        cAlphaBits: 0,
        cAlphaShift: 0,
        cAccumBits: 0,
        cAccumRedBits: 0,
        cAccumGreenBits: 0,
        cAccumBlueBits: 0,
        cAccumAlphaBits: 0,
        cDepthBits: 0,
        cStencilBits: 0,
        cAuxBuffers: 0,
        iLayerType: PFD.MAIN_PLANE,
        bReserved: 0,
        dwLayerMask: 0,
        dwVisibleMask: 0,
        dwDamageMask: 0,
        ...fields,
    };
}

/** @param {Partial<import('./pixelformat.js').PixelFormat>} fields */
function chosen(fields){
    const index = choosePixelFormat(request(fields));
    assert.ok(index > 0, 'a format was found');
    return PIXEL_FORMATS[index - 1];
}

// --- the structure ---

test('the descriptor is forty bytes with twenty single-byte fields in the middle', ()=>{
    assert.equal(PIXELFORMATDESCRIPTOR.SIZE, 40);
    assert.equal(PIXELFORMATDESCRIPTOR.dwFlags, 4);
    assert.equal(PIXELFORMATDESCRIPTOR.iPixelType, 8);
    assert.equal(PIXELFORMATDESCRIPTOR.cDepthBits, 23);
    assert.equal(PIXELFORMATDESCRIPTOR.cStencilBits, 24);
    assert.equal(PIXELFORMATDESCRIPTOR.dwLayerMask, 28);
});

test('a descriptor written into memory reads back field for field', ()=>{
    const memory = memoryOf(0x200);
    const format = PIXEL_FORMATS[3];

    writePixelFormatDescriptor(memory, 0x40, format, PIXELFORMATDESCRIPTOR.SIZE);
    const read = readPixelFormatDescriptor(memory, 0x40);

    assert.equal(read.nSize, PIXELFORMATDESCRIPTOR.SIZE);
    assert.equal(read.dwFlags, format.dwFlags);
    assert.equal(read.cColorBits, format.cColorBits);
    assert.equal(read.cRedShift, format.cRedShift);
    assert.equal(read.cDepthBits, format.cDepthBits);
    assert.equal(read.cStencilBits, format.cStencilBits);
    assert.equal(read.iLayerType, format.iLayerType);
});

test('a descriptor is truncated to the size the caller said it had', ()=>{
    const memory = memoryOf(0x200);
    memory.storage.fill(0xcd);

    writePixelFormatDescriptor(memory, 0x40, PIXEL_FORMATS[3], 11);

    assert.equal(memory.storage[0x40 + PIXELFORMATDESCRIPTOR.cRedBits], 8,
        'the last field that fits was written');
    assert.equal(memory.storage[0x40 + 11], 0xcd, 'and nothing past the eleventh byte was');
});

// --- what ChoosePixelFormat answers ---

test('a request naming nothing but the two support flags is answerable', ()=>{
    assert.ok(choosePixelFormat(request({})) > 0);
});

test('an unrecognised pixel type still returns an RGBA format', ()=>{
    for (const type of [15, 32, 33])
    {
        assert.equal(chosen({ iPixelType: type }).iPixelType, PFD.TYPE_RGBA,
            `pixel type ${type}`);
    }
});

test('an auxiliary buffer nobody offers does not make the request unanswerable', ()=>{
    assert.ok(choosePixelFormat(request({ cAuxBuffers: 1 })) > 0);
});

test('a thirty-two bit request gets eight bits per channel at the documented shifts', ()=>{
    const format = chosen({ cColorBits: 32 });

    assert.equal(format.cColorBits, 32);
    assert.equal(format.cRedBits, 8);
    assert.equal(format.cGreenBits, 8);
    assert.equal(format.cBlueBits, 8);
    assert.equal(format.cRedShift, 16);
    assert.equal(format.cGreenShift, 8);
    assert.equal(format.cBlueShift, 0);
    assert.equal(format.cAlphaShift, 24);
    assert.ok(format.cDepthBits > 0, 'asking for no depth does not get a format without one');
});

test('depth is satisfied by at least as much, never by less', ()=>{
    assert.ok(chosen({ cDepthBits: 16 }).cDepthBits >= 16);
    assert.ok(chosen({ cDepthBits: 8, cStencilBits: 8 }).cDepthBits >= 8);
    assert.ok(chosen({ cDepthBits: 24, cStencilBits: 8 }).cDepthBits >= 24);
    assert.ok(chosen({ cDepthBits: 32, cStencilBits: 8 }).cDepthBits >= 24);
});

test('a stencil request is answered exactly, whatever the depth request was', ()=>{
    assert.equal(chosen({ cStencilBits: 8 }).cStencilBits, 8);
    assert.equal(chosen({ cDepthBits: 16, cStencilBits: 8 }).cStencilBits, 8);
    assert.equal(chosen({ cDepthBits: 1, cStencilBits: 8 }).cStencilBits, 8);
});

test('PFD_DEPTH_DONTCARE is the only way to ask for no depth buffer', ()=>{
    const format = chosen({
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DEPTH_DONTCARE,
        cDepthBits: 24,
    });

    assert.equal(format.cDepthBits, 0);
});

test('PFD_DEPTH_DONTCARE does not outrank a stencil request', ()=>{
    const format = chosen({
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DEPTH_DONTCARE,
        cDepthBits: 24,
        cStencilBits: 8,
    });

    assert.equal(format.cStencilBits, 8);
    assert.ok(format.cDepthBits === 0 || format.cDepthBits === 24,
        `depth ${format.cDepthBits} is one of the two the request leaves open`);
});

test('double buffering is matched in both directions unless told not to', ()=>{
    const single = chosen({});
    assert.equal(single.dwFlags & PFD.DOUBLEBUFFER, 0, 'not asking for it excludes it');

    const double = chosen({
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER,
    });
    assert.notEqual(double.dwFlags & PFD.DOUBLEBUFFER, 0);

    assert.ok(choosePixelFormat(request({
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER_DONTCARE,
    })) > 0, 'and the DONTCARE bit leaves both on the table');
});

test('a flag that is not requested does not exclude the formats that have it', ()=>{
    const index = choosePixelFormat(request({
        dwFlags: PFD.DRAW_TO_BITMAP | PFD.SUPPORT_OPENGL,
    }));

    assert.ok(index > 0);
    const format = PIXEL_FORMATS[index - 1];
    assert.notEqual(format.dwFlags & PFD.DRAW_TO_BITMAP, 0, 'the requested flag is present');
    assert.notEqual(format.dwFlags & PFD.DRAW_TO_WINDOW, 0,
        'and one that was never mentioned did not disqualify it');
});

test('every advertised format is a bitmap format only alongside GDI support', ()=>{
    for (const format of PIXEL_FORMATS)
    {
        assert.notEqual(format.dwFlags & PFD.SUPPORT_OPENGL, 0);
        assert.equal(format.nSize, PIXELFORMATDESCRIPTOR.SIZE);
        if (format.dwFlags & PFD.DRAW_TO_BITMAP)
        {
            assert.notEqual(format.dwFlags & PFD.SUPPORT_GDI, 0);
            assert.equal(format.dwFlags & PFD.DOUBLEBUFFER, 0,
                'a bitmap has no second buffer to swap with');
        }
    }
});
