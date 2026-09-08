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
import { GL, PFD } from './constants.js';
import { PIXELFORMATDESCRIPTOR, encodePixelFormat } from './pixelformat.js';

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

    assert.equal(table.glFogf.argBytes, 8);
    assert.equal(table.glFogf.handler([GL.FOG_MODE, floatBits(1)]), 0);
    table.glFogf.handler([GL.FOG_MODE, floatBits(1)]);
    table.glLightfv.handler([0, 0, 0]);

    assert.deepEqual(opengl.diagnostics().unimplemented, { glFogf: 2, glLightfv: 1 },
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
