/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ABI of OPENGL32.dll.
 *
 * Most of what is checked here is arithmetic about the stack, because that is
 * where this library can go wrong without saying anything: these are stdcall
 * entry points, the callee cleans up, and a count that is one word out leaves
 * the caller returning to an address it never pushed. Nothing about the picture
 * says which call did it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARGUMENT_WORDS, createOpengl } from './exports.js';
import { GL, PFD, WGL } from './constants.js';
import { PIXELFORMATDESCRIPTOR, PIXEL_FORMATS, encodePixelFormat } from './pixelformat.js';

/** The dword a guest pushes for a GLfloat. @param {number} value */
function floatBits(value){
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
}

/** The two dwords a guest pushes for a GLdouble, low word first. @param {number} value */
function doubleBits(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
}

/** A guest address space, and somewhere to allocate in it. */
function machine(){
    const bytes = new Uint8Array(0x40000);
    let next = 0x100;
    return {
        bytes,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
            bytes.set(value, at),
        scratch: {
            allocate: (/** @type {number} */ size)=>{
                const at = next;
                next += size + 16 & ~15;
                return at;
            },
        },
    };
}

/**
 * A library over a 4x4 screen, with whatever it presented recorded.
 *
 * @param {{ present?: boolean }} [options]
 */
function library(options = {}){
    const box = machine();
    /** @type {any[]} */
    const presented = [];
    const opengl = createOpengl({
        readMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        present: options.present === false ? undefined : (/** @type {any} */ s)=>presented.push(s),
    });
    return { box, opengl, presented, table: opengl.table };
}

test('no export is declared twice, and every one takes a whole number of words', ()=>{
    // A name in two groups takes whichever count is read last, silently. That
    // is the one mistake this table can make that no other test would see.
    /** @type {Map<string, number>} */
    const seen = new Map();
    for (const [words, names] of Object.entries(ARGUMENT_WORDS))
    {
        for (const name of names)
        {
            assert.equal(seen.get(name), undefined,
                `${name} is declared in two groups (${seen.get(name)} and ${words})`);
            seen.set(name, Number(words));
        }
    }
    assert.ok(seen.size > 300, `only ${seen.size} exports declared`);

    const { table } = library();
    for (const [name, entry] of Object.entries(table))
    {
        assert.equal(entry.argBytes % 4, 0, `${name} takes a fraction of a word`);
        assert.equal(typeof entry.handler, 'function', `${name} has no handler`);
    }
});

test('a double-precision entry point takes twice the stack of its float twin', ()=>{
    // The whole reason the sizes are written out rather than derived: a
    // GLdouble is two words, and every derivation from a JavaScript parameter
    // list says one.
    const { table } = library();

    assert.equal(table.glVertex3f.argBytes, 12);
    assert.equal(table.glVertex3d.argBytes, 24);
    assert.equal(table.glTranslatef.argBytes, 12);
    assert.equal(table.glTranslated.argBytes, 24);
    assert.equal(table.glClearDepth.argBytes, 8, 'its one argument is a GLclampd');
    assert.equal(table.glDepthRange.argBytes, 16, 'and its two are as well, so four words');
    assert.equal(table.glOrtho.argBytes, 48);
    assert.equal(table.glMap2d.argBytes, 56, 'the largest of them');
});

test('an argument list is the C one, not the implementation\'s', ()=>{
    const { table } = library();

    // glGenTextures answers with an array here and takes an out-pointer there.
    assert.equal(table.glGenTextures.argBytes, 8);
    // The descriptor SetPixelFormat never reads is still on the stack.
    assert.equal(table.wglSetPixelFormat.argBytes, 12);
    // Nine arguments, the last of them the pixels.
    assert.equal(table.glTexImage2D.argBytes, 36);
    assert.equal(table.glReadPixels.argBytes, 28);
    assert.equal(table.wglUseFontOutlinesA.argBytes, 32);
});

test('a float argument is the bits of one, not the word', ()=>{
    // A handler that takes the dword as it stands reads 1.0 as 1065353216 and
    // clamps it to white. Every colour in the program then comes out saturated,
    // which looks like a blending fault and is a marshalling one.
    const { table, box } = library();
    startDrawing(table);

    table.glClearColor.handler(
        [floatBits(0.25), floatBits(0.5), floatBits(0.75), floatBits(1)]);
    table.glClear.handler([GL.COLOR_BUFFER_BIT]);

    const out = 0x2000;
    table.glGetFloatv.handler([GL.COLOR_CLEAR_VALUE, out]);
    const read = new DataView(box.bytes.buffer, out, 16);
    assert.equal(read.getFloat32(0, true), 0.25);
    assert.equal(read.getFloat32(4, true), 0.5);
    assert.equal(read.getFloat32(8, true), 0.75);
    assert.equal(read.getFloat32(12, true), 1);
});

test('a GLboolean argument is its low byte, not the word', ()=>{
    // A compiler answers a comparison in a byte register and pushes the whole
    // register, so FALSE arrives as 0x100 with whatever the upper bytes held.
    // Read as a word that is TRUE, and a mask meant to keep a channel closed
    // writes into it: a light pass meant for the alpha channel lands in red.
    const { table, box } = library();
    startDrawing(table);

    table.glColorMask.handler([0x100, 0x1, 0x200, 0x101]);
    const out = 0x2000;
    table.glGetIntegerv.handler([GL.COLOR_WRITEMASK, out]);
    const mask = new DataView(box.bytes.buffer, out, 16);
    assert.deepEqual([0, 1, 2, 3].map(k=>mask.getInt32(k * 4, true)), [0, 1, 0, 1]);

    table.glDepthMask.handler([0x100]);
    table.glGetIntegerv.handler([GL.DEPTH_WRITEMASK, out]);
    assert.equal(mask.getInt32(0, true), 0, 'and the depth mask reads the same byte');
});

test('a double argument is the bits of two words, low word first', ()=>{
    const { table, box } = library();
    startDrawing(table);

    const [low, high] = doubleBits(0.25);
    table.glClearDepth.handler([low, high]);

    const out = 0x2000;
    table.glGetFloatv.handler([GL.DEPTH_CLEAR_VALUE, out]);
    assert.equal(new DataView(box.bytes.buffer, out, 4).getFloat32(0, true), 0.25);
});

test('a query writes the type it was asked for, and leaves an unknown one alone', ()=>{
    const { table, box } = library();
    startDrawing(table);

    // GL_DITHER is the one capability that starts on, so a booleanv that reads
    // as zero here is not a default that happens to be right.
    const out = 0x2000;
    box.bytes[out] = 0xcc;
    table.glGetBooleanv.handler([GL.DITHER, out]);
    assert.equal(box.bytes[out], 1, 'one byte per boolean, not one word');

    box.bytes[out] = 0xcc;
    table.glGetIntegerv.handler([0x1234, out]);
    assert.equal(box.bytes[out], 0xcc, 'an unknown query leaves the buffer untouched');
    assert.equal(table.glGetError.handler([]), GL.INVALID_ENUM);
});

test('glGetString answers with a pointer into guest memory', ()=>{
    // A program stores what it was given and parses it later, so the string has
    // to be somewhere the guest can read for as long as the context lives --
    // and asking twice has to give the same pointer rather than leak one.
    const { table, box } = library();
    startDrawing(table);

    const address = table.glGetString.handler([GL.VENDOR]);
    assert.notEqual(address, 0);
    assert.equal(table.glGetString.handler([GL.VENDOR]), address);

    const end = box.bytes.indexOf(0, address);
    const text = new TextDecoder().decode(box.bytes.subarray(address, end));
    assert.equal(text, 'Bottlify Project');
});

test('an unimplemented export cleans its stack, answers zero, and is counted', ()=>{
    const { table, opengl } = library();
    startDrawing(table);

    // The evaluators are the one part of GL 1.1 nothing here implements.
    assert.equal(table.glMap1f.argBytes, 24);
    assert.equal(table.glMap1f.handler([0, floatBits(0), floatBits(1), 3, 4, 0]), 0);
    table.glMap1f.handler([0, floatBits(0), floatBits(1), 3, 4, 0]);
    table.glEvalCoord1f.handler([floatBits(0.5)]);

    assert.deepEqual(opengl.diagnostics().unimplemented, { glMap1f: 2, glEvalCoord1f: 1 },
        'which entry points a program reached for is what a run that drew nothing has to say');
});

test('wglGetProcAddress refuses a core entry point', ()=>{
    // A program uses a non-null answer as proof that an extension is present.
    // This build advertises none, so the honest answer to everything is null.
    const { table } = library();
    startDrawing(table);

    assert.equal(table.wglGetProcAddress.handler([0x1000]), 0);
});

test('the whole path: choose a format, make a context, clear, swap', ()=>{
    const { table, box, presented } = library();

    // ChoosePixelFormat reads a descriptor out of guest memory.
    const request = 0x1000;
    box.writeMemory(request, encodePixelFormat(/** @type {any} */ ({
        nSize: PIXELFORMATDESCRIPTOR.SIZE,
        nVersion: 1,
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER,
        iPixelType: PFD.TYPE_RGBA,
        cColorBits: 32,
        cDepthBits: 16,
        cStencilBits: 0,
        cAlphaBits: 0,
        cAccumBits: 0,
        cAuxBuffers: 0,
        iLayerType: PFD.MAIN_PLANE,
    })));

    const hdc = 0x900d;
    const format = table.wglChoosePixelFormat.handler([hdc, request]);
    assert.ok(format > 0, 'a format was offered');
    assert.equal(table.wglSetPixelFormat.handler([hdc, format, request]), 1);
    assert.equal(table.wglGetPixelFormat.handler([hdc]), format);

    // A context cannot be made before a format is set, and this one can.
    const context = table.wglCreateContext.handler([hdc]);
    assert.notEqual(context, 0);
    assert.equal(table.wglGetCurrentContext.handler([]), 0, 'not current merely by existing');
    assert.equal(table.wglMakeCurrent.handler([hdc, context]), 1);
    assert.equal(table.wglGetCurrentContext.handler([]), context);
    assert.equal(table.wglGetCurrentDC.handler([]), hdc);

    table.glClearColor.handler(
        [floatBits(1), floatBits(0), floatBits(0), floatBits(1)]);
    table.glClear.handler([GL.COLOR_BUFFER_BIT]);
    assert.equal(table.wglSwapBuffers.handler([hdc]), 1);

    assert.equal(presented.length, 1);
    const frame = presented[0];
    assert.equal(frame.width, 4);
    assert.equal(frame.height, 4);
    assert.equal(frame.pitch, 16);
    assert.equal(frame.bitCount, 32);
    // BGRX: red is the third byte of the pixel, and the frame the presenter is
    // shown is the one in guest memory rather than a copy that stayed here.
    assert.deepEqual([...box.bytes.subarray(frame.buffer, frame.buffer + 4)],
        [0, 0, 255, 255]);

    assert.equal(table.wglMakeCurrent.handler([hdc, 0]), 1, 'and it can be released');
    assert.equal(table.wglDeleteContext.handler([context]), 1);
    assert.equal(table.wglDeleteContext.handler([context]), 0, 'but only once');
});

test('a context cannot be made for a device context with no pixel format', ()=>{
    // The failure a program hits when it forgets SetPixelFormat. It has to be a
    // failure rather than a default, because the default would be wrong.
    const { table } = library();

    assert.equal(table.wglCreateContext.handler([0x900d]), 0);
    assert.equal(table.wglCreateContext.handler([0]), 0, 'and not for a null one either');
});

/**
 * Gets a context current on a 4x4 drawable, so that the GL half of the table
 * has somewhere to act.
 *
 * @param {any} table
 */
function startDrawing(table){
    const hdc = 0x900d;
    assert.equal(table.wglSetPixelFormat.handler([hdc, 1, 0]), 1);
    const context = table.wglCreateContext.handler([hdc]);
    assert.notEqual(context, 0);
    assert.equal(table.wglMakeCurrent.handler([hdc, context]), 1);
    return context;
}

// --- the typed variants and the memory paths ---

/**
 * A 4x4 drawable with a pixel-per-unit projection, through the table.
 *
 * @param {any} table
 */
function pixelProjection(table){
    const [ll, lh] = doubleBits(0);
    const [rl, rh] = doubleBits(4);
    const [nl, nh] = doubleBits(-1);
    const [fl, fh] = doubleBits(1);
    table.glMatrixMode.handler([GL.PROJECTION]);
    table.glLoadIdentity.handler([]);
    table.glOrtho.handler([ll, lh, rl, rh, ll, lh, rl, rh, nl, nh, fl, fh]);
    table.glMatrixMode.handler([GL.MODELVIEW]);
    table.glLoadIdentity.handler([]);
}

test('an integer colour is normalised and an integer vertex is not', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const out = 0x2000;

    table.glColor3ub.handler([255, 128, 0]);
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    const colour = new DataView(box.bytes.buffer, out, 16);
    assert.equal(colour.getFloat32(0, true), 1);
    assert.equal(colour.getFloat32(4, true), Math.fround(128 / 255));
    assert.equal(colour.getFloat32(12, true), 1, 'three components imply an alpha of one');

    // glColor4b: -128 maps to (2 * -128 + 1) / 255, which is below zero.
    table.glColor4b.handler([127, 0x80, 0, 127]);
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    assert.equal(colour.getFloat32(0, true), 1);
    assert.equal(colour.getFloat32(4, true), Math.fround(-255 / 255));

    // glColor3usv reads three shorts.
    box.bytes.set([0xff, 0xff, 0, 0x80, 0, 0], 0x3000);
    table.glColor3usv.handler([0x3000]);
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    assert.equal(colour.getFloat32(0, true), 1);
    assert.equal(colour.getFloat32(4, true), Math.fround(0x8000 / 65535));

    // glVertex3i keeps its integers and glVertex3d reads doubles: a point at
    // (3, 2) -- which covers the pixel whose centre is within half a pixel of
    // it, the third from the left -- and one at (1.5, 1.5), on a 4x4 frame.
    pixelProjection(table);
    table.glColor3f.handler([floatBits(1), floatBits(1), floatBits(1)]);
    table.glBegin.handler([GL.POINTS]);
    table.glVertex3i.handler([3, 2, 0]);
    const [xl, xh] = doubleBits(1.5);
    const [zl, zh] = doubleBits(0);
    table.glVertex3d.handler([xl, xh, xl, xh, zl, zh]);
    table.glEnd.handler([]);
    table.glReadPixels.handler([0, 0, 4, 4, GL.RED, GL.UNSIGNED_BYTE, out]);
    const rows = [0, 1, 2, 3].map(y=>[...box.bytes.subarray(out + y * 4, out + y * 4 + 4)]);
    assert.deepEqual(rows, [
        [0, 0, 0, 0],
        [0, 255, 0, 0],
        [0, 0, 255, 0],
        [0, 0, 0, 0],
    ]);
});

test('a texture is read out of guest memory through the unpack state', ()=>{
    const { table, box } = library();
    startDrawing(table);
    pixelProjection(table);
    // A 2x1 RGB texture: six bytes, one row, so the alignment does not bite.
    box.bytes.set([255, 0, 0, 0, 0, 255], 0x3000);
    const names = 0x3100;
    table.glGenTextures.handler([1, names]);
    table.glBindTexture.handler([GL.TEXTURE_2D, box.bytes[names]]);
    table.glTexImage2D.handler([GL.TEXTURE_2D, 0, GL.RGB, 2, 1, 0, GL.RGB, GL.UNSIGNED_BYTE,
        0x3000]);
    table.glTexParameteri.handler([GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST]);
    table.glTexParameteri.handler([GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST]);
    table.glEnable.handler([GL.TEXTURE_2D]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);

    table.glBegin.handler([GL.QUADS]);
    table.glTexCoord2f.handler([floatBits(0), floatBits(0)]);
    table.glVertex2f.handler([floatBits(0), floatBits(0)]);
    table.glTexCoord2f.handler([floatBits(1), floatBits(0)]);
    table.glVertex2f.handler([floatBits(4), floatBits(0)]);
    table.glTexCoord2f.handler([floatBits(1), floatBits(1)]);
    table.glVertex2f.handler([floatBits(4), floatBits(4)]);
    table.glTexCoord2f.handler([floatBits(0), floatBits(1)]);
    table.glVertex2f.handler([floatBits(0), floatBits(4)]);
    table.glEnd.handler([]);

    // Read back through glReadPixels into guest memory: bottom row first.
    const out = 0x4000;
    table.glReadPixels.handler([0, 0, 4, 1, GL.RGBA, GL.UNSIGNED_BYTE, out]);
    assert.deepEqual([...box.bytes.subarray(out, out + 4)], [255, 0, 0, 255]);
    assert.deepEqual([...box.bytes.subarray(out + 12, out + 16)], [0, 0, 255, 255]);
});

test('glDrawElements and glGetIntegerv cross guest memory both ways', ()=>{
    const { table, box } = library();
    startDrawing(table);
    pixelProjection(table);
    const view = new DataView(box.bytes.buffer);
    [0, 0, 4, 0, 0, 4].forEach((value, i)=>view.setFloat32(0x3000 + i * 4, value, true));
    box.bytes.set([0, 1, 2], 0x3100);
    table.glVertexPointer.handler([2, GL.FLOAT, 0, 0x3000]);
    table.glEnableClientState.handler([GL.VERTEX_ARRAY]);
    table.glColor3f.handler([floatBits(1), floatBits(1), floatBits(1)]);
    table.glDrawElements.handler([GL.TRIANGLES, 3, GL.UNSIGNED_BYTE, 0x3100]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
    const out = 0x4000;
    table.glReadPixels.handler([0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE, out]);
    assert.deepEqual([...box.bytes.subarray(out, out + 4)], [255, 255, 255, 255]);

    table.glGetIntegerv.handler([GL.MAX_TEXTURE_UNITS, out]);
    assert.equal(view.getInt32(out, true), 4);
    table.glGetPointerv.handler([GL.VERTEX_ARRAY_POINTER, out]);
    assert.equal(view.getUint32(out, true), 0x3000);
});

test('an integer light colour is normalised and an integer position is not', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    [0x7fffffff, 0, 0, 0x7fffffff].forEach((value, i)=>view.setInt32(0x3000 + i * 4, value, true));
    table.glLightiv.handler([GL.LIGHT0, GL.DIFFUSE, 0x3000]);
    [1, 2, 3, 1].forEach((value, i)=>view.setInt32(0x3000 + i * 4, value, true));
    table.glLightiv.handler([GL.LIGHT0, GL.POSITION, 0x3000]);
    const out = 0x4000;
    table.glGetLightfv.handler([GL.LIGHT0, GL.DIFFUSE, out]);
    assert.equal(view.getFloat32(out, true), 1);
    assert.equal(view.getFloat32(out + 4, true), Math.fround(1 / 4294967295));
    table.glGetLightfv.handler([GL.LIGHT0, GL.POSITION, out]);
    assert.deepEqual([0, 4, 8, 12].map(k=>view.getFloat32(out + k, true)), [1, 2, 3, 1]);
    table.glGetLightiv.handler([GL.LIGHT0, GL.DIFFUSE, out]);
    assert.equal(view.getInt32(out, true), 0x7fffffff, 'and reads back onto the integer range');
});

test('a mapped buffer lives in guest memory the program writes through', ()=>{
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    const names = 0x3000;
    table.glGenBuffersARB.handler([1, names]);
    const name = view.getUint32(names, true);
    assert.ok(name > 0);
    table.glBindBufferARB.handler([GL.ARRAY_BUFFER, name]);
    table.glBufferDataARB.handler([GL.ARRAY_BUFFER, 8, 0, GL.DYNAMIC_DRAW]);
    const address = table.glMapBufferARB.handler([GL.ARRAY_BUFFER, GL.WRITE_ONLY]);
    assert.notEqual(address, 0);
    box.bytes.set([1, 2, 3, 4, 5, 6, 7, 8], address);
    assert.equal(table.glUnmapBufferARB.handler([GL.ARRAY_BUFFER]), 1);
    const out = 0x4000;
    table.glGetBufferSubDataARB.handler([GL.ARRAY_BUFFER, 4, 4, out]);
    assert.deepEqual([...box.bytes.subarray(out, out + 4)], [5, 6, 7, 8]);
    table.glGetBufferParameterivARB.handler([GL.ARRAY_BUFFER, GL.BUFFER_SIZE, out]);
    assert.equal(view.getInt32(out, true), 8);
});

test('WGL_ARB_pixel_format answers attributes and chooses by them', ()=>{
    const { table, box } = library();
    const view = new DataView(box.bytes.buffer);
    const hdc = 0x900d;
    const attributes = 0x3000;
    [WGL.NUMBER_PIXEL_FORMATS_ARB, WGL.COLOR_BITS_ARB, WGL.DOUBLE_BUFFER_ARB]
        .forEach((value, i)=>view.setUint32(attributes + i * 4, value, true));
    const out = 0x4000;
    assert.equal(table.wglGetPixelFormatAttribivARB.handler([hdc, 1, 0, 3, attributes, out]), 1);
    assert.equal(view.getInt32(out, true), PIXEL_FORMATS.length);
    assert.equal(view.getInt32(out + 4, true), PIXEL_FORMATS[0].cColorBits);
    assert.equal(view.getInt32(out + 8, true),
        (PIXEL_FORMATS[0].dwFlags & PFD.DOUBLEBUFFER) ? 1 : 0);
    view.setUint32(attributes, 0xdead, true);
    assert.equal(table.wglGetPixelFormatAttribivARB.handler([hdc, 1, 0, 1, attributes, out]), 0,
        'an unknown attribute fails the whole query');

    const request = 0x3100;
    [WGL.DRAW_TO_WINDOW_ARB, 1, WGL.SUPPORT_OPENGL_ARB, 1, WGL.DOUBLE_BUFFER_ARB, 1,
        WGL.COLOR_BITS_ARB, 32, WGL.DEPTH_BITS_ARB, 24, 0, 0]
        .forEach((value, i)=>view.setInt32(request + i * 4, value, true));
    const formats = 0x4100;
    const count = 0x4200;
    assert.equal(table.wglChoosePixelFormatARB.handler([hdc, request, 0, 1, formats, count]), 1);
    assert.equal(view.getUint32(count, true), 1);
    const chosen = view.getUint32(formats, true);
    assert.ok(chosen >= 1 && chosen <= PIXEL_FORMATS.length);
    assert.ok(PIXEL_FORMATS[chosen - 1].dwFlags & PFD.DOUBLEBUFFER, 'double buffered as asked');
    assert.ok(PIXEL_FORMATS[chosen - 1].cDepthBits >= 24);
});

test('the swap interval is remembered', ()=>{
    const { table } = library();
    assert.equal(table.wglGetSwapIntervalEXT.handler([]), 1);
    assert.equal(table.wglSwapIntervalEXT.handler([0]), 1);
    assert.equal(table.wglGetSwapIntervalEXT.handler([]), 0);
    assert.equal(table.wglSwapIntervalEXT.handler([-1]), 0);
});

test('a vector argument is decoded from the window over guest memory, not from a copy', ()=>{
    // The `*v` entry points read a handful of floats the guest points at --
    // four for a program parameter, sixteen for a matrix -- and consume them
    // before the handler returns, so nothing about them outlives the guest's
    // next instruction. A copy buys nothing there, and a title's frame makes
    // thousands of these: four program parameters and a matrix per draw.
    const box = machine();
    let copies = 0;
    let windows = 0;
    // The window is the graphics module's own service for exactly this (a
    // block read on every call); the library does not take it yet.
    /** @type {any} */
    const services = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>{
            copies++;
            return box.readMemory(at, length);
        },
        windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>{
            windows++;
            return box.readMemory(at, length);
        },
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
    };
    const { table } = createOpengl(services);
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    [1.5, -2, 0.25, 8].forEach((value, i)=>view.setFloat32(0x3000 + i * 4, value, true));
    for (let i = 0; i < 16; i++)
    {
        view.setFloat32(0x3100 + i * 4, i + 1, true);
    }
    [0.5, 0.25, 1, 0].forEach((value, i)=>view.setFloat32(0x3200 + i * 4, value, true));
    copies = 0;
    windows = 0;

    table.glProgramEnvParameter4fvARB.handler([GL.VERTEX_PROGRAM_ARB, 3, 0x3000]);
    table.glMatrixMode.handler([GL.MODELVIEW]);
    table.glLoadMatrixf.handler([0x3100]);
    table.glColor4fv.handler([0x3200]);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
    assert.equal(copies, 0, 'no vector argument was copied out of guest memory');
    assert.equal(windows, 3, 'each was read through the window, once');

    // And the values arrived whole, which is what the window has to keep true.
    const out = 0x4000;
    table.glGetProgramEnvParameterfvARB.handler([GL.VERTEX_PROGRAM_ARB, 3, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [1.5, -2, 0.25, 8]);
    table.glGetFloatv.handler([GL.MODELVIEW_MATRIX, out]);
    assert.deepEqual([...Array(16).keys()].map(i=>view.getFloat32(out + i * 4, true)),
        [...Array(16).keys()].map(i=>i + 1));
    table.glGetFloatv.handler([GL.CURRENT_COLOR, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [0.5, 0.25, 1, 0]);
});

test('two consecutive glProgramEnvParameter4fvARB calls hand the context the same array '
    + 'object, with the second call\'s values, and construct zero DataViews', ()=>{
    // The env-parameter and matrix readers decode into one reused Float32Array
    // scratch per count instead of a fresh array per call; correctness rests
    // on the context copying out of it (`env.set`) before the next call
    // overwrites it, which the readback below proves.
    const box = machine();
    const view = new DataView(box.bytes.buffer);
    const opengl = createOpengl({
        readMemory: box.readMemory,
        writeMemory: box.writeMemory,
        screen: ()=>({ width: 4, height: 4 }),
        scratch: box.scratch,
        // The memory layer's own reader, decoding straight off the pre-existing
        // view above: no window, no per-call `DataView`, the shape the real
        // accessor takes.
        readF32sInto: (/** @type {number} */ at, /** @type {number} */ count,
            /** @type {Float32Array} */ into)=>
        {
            for (let i = 0; i < count; i++)
            {
                into[i] = view.getFloat32(at + i * 4, true);
            }
        },
    });
    const { table } = opengl;
    startDrawing(table);
    [1.5, -2, 0.25, 8].forEach((value, i)=>view.setFloat32(0x3000 + i * 4, value, true));
    [4, 5, 6, 7].forEach((value, i)=>view.setFloat32(0x3100 + i * 4, value, true));

    const RealSet = Float32Array.prototype.set;
    const RealDataView = globalThis.DataView;
    /** @type {any[]} */
    const setOn = [];
    let dataViews = 0;
    globalThis.DataView = /** @type {any} */ (class extends RealDataView {
        constructor(/** @type {any[]} */ ...args){
            dataViews++;
            super(.../** @type {[ArrayBufferLike, number?, number?]} */ (args));
        }
    });
    Float32Array.prototype.set = /** @type {any} */ (
        function(/** @type {any} */ source, /** @type {number} */ offset){
            setOn.push(source);
            return RealSet.call(this, source, offset);
        });
    try
    {
        table.glProgramEnvParameter4fvARB.handler([GL.VERTEX_PROGRAM_ARB, 0, 0x3000]);
        table.glProgramEnvParameter4fvARB.handler([GL.VERTEX_PROGRAM_ARB, 1, 0x3100]);
    }
    finally
    {
        Float32Array.prototype.set = RealSet;
        globalThis.DataView = RealDataView;
    }

    assert.equal(setOn.length, 2, 'the context copied out of the scratch both times');
    assert.equal(setOn[0], setOn[1], 'the same array object, mutated for the second call');
    assert.equal(dataViews, 0, 'no DataView constructed by either read');

    const out = 0x4000;
    table.glGetProgramEnvParameterfvARB.handler([GL.VERTEX_PROGRAM_ARB, 0, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [1.5, -2, 0.25, 8],
        'the first call\'s own values, not overwritten by the second');
    table.glGetProgramEnvParameterfvARB.handler([GL.VERTEX_PROGRAM_ARB, 1, out]);
    assert.deepEqual([0, 1, 2, 3].map(i=>view.getFloat32(out + i * 4, true)), [4, 5, 6, 7]);
});

test('glDeleteBuffersARB still answers two independent lists, not a shared scratch', ()=>{
    // readU32s is the variable-count reader glDeleteBuffersARB goes through;
    // this pins that it stayed a fresh array per call while the two
    // fixed-count float readers above moved to a reused one.
    const { table, box } = library();
    startDrawing(table);
    const view = new DataView(box.bytes.buffer);
    const namesA = 0x3000;
    const namesB = 0x3100;
    table.glGenBuffersARB.handler([2, namesA]);
    table.glGenBuffersARB.handler([2, namesB]);
    const [a0, a1] = [view.getUint32(namesA, true), view.getUint32(namesA + 4, true)];
    const [b0, b1] = [view.getUint32(namesB, true), view.getUint32(namesB + 4, true)];
    [a0, a1, b0, b1].forEach(name=>table.glBindBufferARB.handler([GL.ARRAY_BUFFER, name]));

    table.glDeleteBuffersARB.handler([2, namesA]);
    assert.equal(table.glIsBufferARB.handler([a0]), GL.FALSE);
    assert.equal(table.glIsBufferARB.handler([a1]), GL.FALSE);
    assert.equal(table.glIsBufferARB.handler([b0]), GL.TRUE, 'the second list is untouched');
    assert.equal(table.glIsBufferARB.handler([b1]), GL.TRUE);

    table.glDeleteBuffersARB.handler([2, namesB]);
    assert.equal(table.glIsBufferARB.handler([b0]), GL.FALSE);
    assert.equal(table.glIsBufferARB.handler([b1]), GL.FALSE);
});
