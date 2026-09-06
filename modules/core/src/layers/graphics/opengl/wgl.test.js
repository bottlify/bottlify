/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL, PFD, WIN32_ERROR } from './constants.js';
import { PIXELFORMATDESCRIPTOR, PIXEL_FORMATS, readPixelFormatDescriptor } from './pixelformat.js';
import { createWgl } from './wgl.js';

/** A window DC and a second one onto the same window; a memory DC; a stale handle. */
const WINDOW_DC = 0x10;
const OTHER_WINDOW_DC = 0x11;
const MEMORY_DC = 0x20;
const STALE_DC = 0x99;

const MAIN_THREAD = 1;
const OTHER_THREAD = 2;

const EXTENSIONS = {
    GL_ARB_multitexture: ['glActiveTextureARB', 'glMultiTexCoord2fARB'],
    GL_EXT_blend_func_separate: ['glBlendFuncSeparateEXT'],
};

/** @param {Record<string, string[]>} [extensions] */
function fixture(extensions = EXTENSIONS){
    const storage = new Uint8Array(0x400);
    const drawables = new Map([
        [WINDOW_DC, { key: 'window:1', width: 200, height: 150 }],
        [OTHER_WINDOW_DC, { key: 'window:1', width: 200, height: 150 }],
        [MEMORY_DC, { key: 'dc:0x20', width: 4, height: 4 }],
    ]);
    let thread = MAIN_THREAD;

    const wgl = createWgl({
        gdi: { describeDrawable: hdc=>drawables.get(hdc) ?? null },
        currentThread: ()=>thread,
        extensions,
        memory: {
            readMemory: (address, length)=>storage.subarray(address, address + length),
            writeMemory: (address, bytes)=>storage.set(bytes, address),
        },
    });

    return {
        wgl,
        storage,
        /** @param {number} id */
        onThread(id){
            thread = id;
        },
        /**
         * Every test ends here. A context still alive, or still current on any
         * thread that touched it, is a leak of exactly the kind this layer is
         * built to make visible.
         *
         * @param {any[]} contexts
         */
        assertAllReleased(...contexts){
            for (const id of [MAIN_THREAD, OTHER_THREAD])
            {
                thread = id;
                assert.equal(wgl.wglGetCurrentContext(), null,
                    `nothing is current on thread ${id}`);
                assert.equal(wgl.wglGetCurrentDC(), 0, `no DC is current on thread ${id}`);
            }
            thread = MAIN_THREAD;
            for (const context of contexts)
            {
                assert.equal(context.destroyed, true, 'the context was destroyed');
                assert.equal(context.shareGroup.contexts, 0,
                    'and its share group has no contexts left');
            }
        },
    };
}

/**
 * A complete request, built by overriding a described format: the structure is
 * the same one either way, and the fields not named here are the ones
 * ChoosePixelFormat is free to ignore.
 *
 * @param {Partial<import('./pixelformat.js').PixelFormat>} fields
 */
function request(fields = {}){
    return {
        ...PIXEL_FORMATS[0],
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER,
        cColorBits: 24,
        cDepthBits: 24,
        ...fields,
    };
}

/**
 * @param {ReturnType<typeof fixture>} f
 * @param {number} hdc
 * @returns {number} the format that was set
 */
function setUpFormat(f, hdc = WINDOW_DC){
    const index = f.wgl.ChoosePixelFormat(hdc, request());
    assert.ok(index > 0, 'the fixture request is answerable');
    assert.equal(f.wgl.SetPixelFormat(hdc, index), true);
    return index;
}

// --- the pixel format belongs to the drawable ---

test('a format set through one DC is the format of every DC on that window', ()=>{
    const f = fixture();
    const index = setUpFormat(f);

    assert.equal(f.wgl.GetPixelFormat(WINDOW_DC), index);
    assert.equal(f.wgl.GetPixelFormat(OTHER_WINDOW_DC), index,
        'a second DC for the same window carries it too');

    f.assertAllReleased();
});

test('a memory DC has a format of its own', ()=>{
    const f = fixture();
    setUpFormat(f, WINDOW_DC);

    assert.equal(f.wgl.GetPixelFormat(MEMORY_DC), 0, 'the window format did not reach it');
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_PIXEL_FORMAT);

    const bitmapFormat = f.wgl.ChoosePixelFormat(MEMORY_DC,
        request({ dwFlags: PFD.DRAW_TO_BITMAP | PFD.SUPPORT_OPENGL, cDepthBits: 0 }));
    assert.ok(bitmapFormat > 0);
    assert.equal(f.wgl.SetPixelFormat(MEMORY_DC, bitmapFormat), true);
    assert.equal(f.wgl.GetPixelFormat(MEMORY_DC), bitmapFormat);

    f.assertAllReleased();
});

test('a format can be set once, and setting the same one again is not a second time', ()=>{
    const f = fixture();
    const index = setUpFormat(f);

    assert.equal(f.wgl.SetPixelFormat(WINDOW_DC, index), true, 'the same format again');

    const other = PIXEL_FORMATS.findIndex((_, i)=>i + 1 !== index) + 1;
    assert.equal(f.wgl.SetPixelFormat(WINDOW_DC, other), false, 'a different one');
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_PIXEL_FORMAT);
    assert.equal(f.wgl.GetPixelFormat(WINDOW_DC), index, 'and the format did not move');

    assert.equal(f.wgl.SetPixelFormat(OTHER_WINDOW_DC, other), false,
        'nor through the window\'s other DC');

    f.assertAllReleased();
});

test('a stale device context fails every entry point with ERROR_INVALID_HANDLE', ()=>{
    const f = fixture();

    assert.equal(f.wgl.ChoosePixelFormat(STALE_DC, request()), 0);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    assert.equal(f.wgl.SetPixelFormat(STALE_DC, 1), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    assert.equal(f.wgl.DescribePixelFormat(STALE_DC, 0, 0), 0);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    assert.equal(f.wgl.SwapBuffers(STALE_DC), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    assert.equal(f.wgl.wglCreateContext(STALE_DC), null);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    // The one that reports a different code, and reports it for a bad handle
    // as well as for a DC that simply has no format yet.
    assert.equal(f.wgl.GetPixelFormat(STALE_DC), 0);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_PIXEL_FORMAT);

    f.assertAllReleased();
});

test('the format count is obtainable before any format is set', ()=>{
    const f = fixture();

    const count = f.wgl.DescribePixelFormat(MEMORY_DC, 0, 0);

    assert.ok(count > 1, 'more than one format is on offer');
    assert.equal(count, PIXEL_FORMATS.length);
    assert.equal(f.wgl.GetPixelFormat(MEMORY_DC), 0, 'and asking did not set one');

    f.assertAllReleased();
});

test('describing a format writes it and still answers with the count', ()=>{
    const f = fixture();

    const count = f.wgl.DescribePixelFormat(
        WINDOW_DC, 4, PIXELFORMATDESCRIPTOR.SIZE, 0x100);

    assert.equal(count, PIXEL_FORMATS.length);
    const written = readPixelFormatDescriptor({
        readMemory: (address, length)=>f.storage.subarray(address, address + length),
        writeMemory: ()=>{},
    }, 0x100);
    assert.equal(written.dwFlags, PIXEL_FORMATS[3].dwFlags);
    assert.equal(written.cDepthBits, PIXEL_FORMATS[3].cDepthBits);

    f.assertAllReleased();
});

// --- contexts ---

test('a device context with no pixel format cannot make a context', ()=>{
    const f = fixture();

    assert.equal(f.wgl.wglCreateContext(WINDOW_DC), null);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_PIXEL_FORMAT);

    f.assertAllReleased();
});

test('a context becomes current, reports its DC, and can be made current again', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);
    assert.notEqual(context, null);

    assert.equal(f.wgl.wglGetCurrentContext(), null, 'creating one does not make it current');
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);
    assert.equal(f.wgl.wglGetCurrentContext(), context);
    assert.equal(f.wgl.wglGetCurrentDC(), WINDOW_DC);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true, 'again on the same thread');

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});

test('releasing through a real DC always succeeds; through a null one only if held', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, null), true, 'with nothing current');
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, null), true, 'and again');

    assert.equal(f.wgl.wglMakeCurrent(0, null), false, 'a null DC with nothing to release');
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);
    assert.equal(f.wgl.wglMakeCurrent(0, null), true, 'but it does release what is held');
    assert.equal(f.wgl.wglGetCurrentContext(), null);

    assert.equal(f.wgl.wglMakeCurrent(0, null), false, 'and once released, fails again');
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});

test('a context held by one thread cannot be taken or deleted by another', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);

    f.onThread(OTHER_THREAD);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.BUSY,
        'busy, not invalid: the handle is fine, somebody else has it');
    assert.equal(f.wgl.wglDeleteContext(context), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.BUSY);
    assert.equal(f.wgl.wglGetCurrentContext(), null, 'and the other thread holds nothing');

    f.onThread(MAIN_THREAD);
    assert.equal(f.wgl.wglGetCurrentContext(), context, 'the holder still holds it');
    assert.equal(f.wgl.wglDeleteContext(context), true);

    f.assertAllReleased(context);
});

test('deleting a context makes it not current, and deleting it twice fails', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);

    assert.equal(f.wgl.wglDeleteContext(context), true);
    assert.equal(f.wgl.wglGetCurrentContext(), null, 'deletion released it here and now');

    assert.equal(f.wgl.wglDeleteContext(context), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);
    assert.equal(f.wgl.wglDeleteContext(null), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    f.assertAllReleased(context);
});

test('a context cannot be made current on a drawable with a different format', ()=>{
    const f = fixture();
    const windowFormat = setUpFormat(f, WINDOW_DC);
    const context = f.wgl.wglCreateContext(WINDOW_DC);

    const bitmapFormat = f.wgl.ChoosePixelFormat(MEMORY_DC,
        request({ dwFlags: PFD.DRAW_TO_BITMAP | PFD.SUPPORT_OPENGL, cDepthBits: 0 }));
    assert.notEqual(bitmapFormat, windowFormat, 'the fixture picks two different formats');
    assert.equal(f.wgl.SetPixelFormat(MEMORY_DC, bitmapFormat), true);

    assert.equal(f.wgl.wglMakeCurrent(MEMORY_DC, context), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_PIXEL_FORMAT);
    assert.equal(f.wgl.wglGetCurrentContext(), null, 'and the failed call made nothing current');

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});

test('the viewport comes from the drawable at the first attachment and stays', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);
    assert.deepEqual(context.glGetIntegerv(GL.VIEWPORT), [0, 0, 200, 150]);
    assert.deepEqual(context.glGetIntegerv(GL.SCISSOR_BOX), [0, 0, 200, 150]);

    context.glViewport(10, 20, 30, 40);
    assert.equal(f.wgl.wglMakeCurrent(0, null), true);
    assert.equal(f.wgl.wglMakeCurrent(OTHER_WINDOW_DC, context), true);
    assert.deepEqual(context.glGetIntegerv(GL.VIEWPORT), [10, 20, 30, 40],
        'a later attachment does not reset it');

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});

test('a double-buffered format draws to the back buffer, a single-buffered one to the front',
    ()=>{
        const f = fixture();
        setUpFormat(f, WINDOW_DC);
        const doubleBuffered = f.wgl.wglCreateContext(WINDOW_DC);
        assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, doubleBuffered), true);
        assert.deepEqual(doubleBuffered.glGetIntegerv(GL.DRAW_BUFFER), [GL.BACK]);
        assert.deepEqual(doubleBuffered.glGetIntegerv(GL.READ_BUFFER), [GL.BACK]);
        assert.equal(f.wgl.wglDeleteContext(doubleBuffered), true);

        const bitmapFormat = f.wgl.ChoosePixelFormat(MEMORY_DC,
            request({ dwFlags: PFD.DRAW_TO_BITMAP | PFD.SUPPORT_OPENGL, cDepthBits: 0 }));
        assert.equal(f.wgl.SetPixelFormat(MEMORY_DC, bitmapFormat), true);
        const single = f.wgl.wglCreateContext(MEMORY_DC);
        assert.equal(f.wgl.wglMakeCurrent(MEMORY_DC, single), true);
        assert.deepEqual(single.glGetIntegerv(GL.DRAW_BUFFER), [GL.FRONT]);
        assert.deepEqual(single.glGetIntegerv(GL.VIEWPORT), [0, 0, 4, 4],
            'and its viewport is the bitmap, not the window');
        assert.equal(f.wgl.wglDeleteContext(single), true);

        f.assertAllReleased(doubleBuffered, single);
    });

// --- sharing ---

test('sharing nothing with nothing fails', ()=>{
    const f = fixture();

    assert.equal(f.wgl.wglShareLists(null, null), false);
    assert.equal(f.wgl.getLastError(), WIN32_ERROR.INVALID_HANDLE);

    f.assertAllReleased();
});

test('the destination joins the source group, and sees what was made there', ()=>{
    const f = fixture();
    setUpFormat(f);
    const source = f.wgl.wglCreateContext(WINDOW_DC);
    const destination = f.wgl.wglCreateContext(WINDOW_DC);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, source), true);
    const [texture] = source.glGenTextures(1);
    source.glBindTexture(GL.TEXTURE_2D, texture);
    const list = source.glGenLists(1);

    assert.equal(f.wgl.wglShareLists(source, destination), true);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, destination), true);
    assert.equal(destination.glIsTexture(texture), GL.TRUE);
    assert.equal(destination.glIsList(list), GL.TRUE);
    assert.equal(destination.glIsTexture(texture + 1), GL.FALSE);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, source), true);
    assert.equal(source.glIsTexture(texture), GL.TRUE, 'and the source still has it');

    assert.equal(f.wgl.wglDeleteContext(source), true);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, destination), true);
    assert.equal(destination.glIsTexture(texture), GL.TRUE,
        'the object outlives the context that made it');
    assert.equal(f.wgl.wglDeleteContext(destination), true);

    f.assertAllReleased(source, destination);
});

test('a group that has ever held an object can never be shared into again', ()=>{
    const f = fixture();
    setUpFormat(f);
    const source = f.wgl.wglCreateContext(WINDOW_DC);
    const destination = f.wgl.wglCreateContext(WINDOW_DC);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, destination), true);
    const [texture] = destination.glGenTextures(1);
    destination.glBindTexture(GL.TEXTURE_2D, texture);

    assert.equal(f.wgl.wglShareLists(source, destination), false, 'its group is in use');

    destination.glDeleteTextures([texture]);
    assert.equal(destination.glIsTexture(texture), GL.FALSE);
    assert.equal(f.wgl.wglShareLists(source, destination), false,
        'and deleting everything in it does not make it shareable again');

    assert.equal(f.wgl.wglMakeCurrent(0, null), true);
    assert.equal(f.wgl.wglDeleteContext(source), true);
    assert.equal(f.wgl.wglDeleteContext(destination), true);

    f.assertAllReleased(source, destination);
});

test('sharing lists leaves both contexts state exactly where it was', ()=>{
    const f = fixture();
    setUpFormat(f);
    const source = f.wgl.wglCreateContext(WINDOW_DC);
    const destination = f.wgl.wglCreateContext(WINDOW_DC);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, source), true);
    source.glViewport(0, 0, 256, 256);
    source.glEnable(GL.DEPTH_TEST);
    source.glDisable(GL.DITHER);
    source.glDepthFunc(GL.LESS);
    source.glClearColor(0.1, 0.2, 0.3, 1.0);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, destination), true);
    destination.glViewport(0, 0, 128, 128);
    destination.glEnable(GL.DITHER);
    destination.glDepthFunc(GL.GREATER);
    destination.glShadeModel(GL.FLAT);
    destination.glClearColor(0.3, 0.2, 0.1, 1.0);

    assert.equal(f.wgl.wglShareLists(source, destination), true);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, source), true);
    assert.deepEqual(source.glGetIntegerv(GL.VIEWPORT), [0, 0, 256, 256]);
    assert.equal(source.glIsEnabled(GL.DEPTH_TEST), GL.TRUE);
    assert.equal(source.glIsEnabled(GL.DITHER), GL.FALSE);
    assert.deepEqual(source.glGetIntegerv(GL.DEPTH_FUNC), [GL.LESS]);
    assert.deepEqual(source.glGetIntegerv(GL.SHADE_MODEL), [GL.SMOOTH]);

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, destination), true);
    assert.deepEqual(destination.glGetIntegerv(GL.VIEWPORT), [0, 0, 128, 128]);
    assert.equal(destination.glIsEnabled(GL.DEPTH_TEST), GL.FALSE);
    assert.equal(destination.glIsEnabled(GL.DITHER), GL.TRUE);
    assert.deepEqual(destination.glGetIntegerv(GL.DEPTH_FUNC), [GL.GREATER]);
    assert.deepEqual(destination.glGetIntegerv(GL.SHADE_MODEL), [GL.FLAT]);

    assert.equal(f.wgl.wglMakeCurrent(0, null), true);
    assert.equal(f.wgl.wglDeleteContext(source), true);
    assert.equal(f.wgl.wglDeleteContext(destination), true);

    f.assertAllReleased(source, destination);
});

// --- extension lookup ---

test('a core entry point is never obtainable through wglGetProcAddress', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);

    assert.equal(f.wgl.wglGetProcAddress('glEnable'), null, 'without a context');
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);
    assert.equal(f.wgl.wglGetProcAddress('glEnable'), null, 'and with one');
    assert.equal(f.wgl.wglGetProcAddress('glBindTexture'), null);

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});

test('an extension table that overreaches cannot hand out a core entry point', ()=>{
    // A program reads a non-null pointer as proof the extension is there. An
    // extension list that names a function opengl32 exports itself must not be
    // able to turn that into a yes.
    const f = fixture({ GL_EXT_overreaching: ['glEnable', 'glActiveTextureARB'] });
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);

    assert.equal(f.wgl.wglGetProcAddress('glEnable'), null, 'core wins over the claim');
    assert.notEqual(f.wgl.wglGetProcAddress('glActiveTextureARB'), null,
        'and the rest of the claim still stands');

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});

test('an extension function needs a current context and is not aliased by name', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);

    assert.equal(f.wgl.wglGetProcAddress('glActiveTextureARB'), null, 'no context, no pointer');

    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);
    const address = f.wgl.wglGetProcAddress('glActiveTextureARB');
    assert.notEqual(address, null);
    assert.equal(f.wgl.wglGetProcAddress('glActiveTextureARB'), address,
        'and the same pointer every time, because programs compare them');

    assert.equal(f.wgl.wglGetProcAddress('glActiveTextureEXT'), null,
        'a different suffix is a different function nobody reported');
    assert.equal(f.wgl.wglGetProcAddress('glBlendFuncSeparateINGR'), null);
    assert.notEqual(f.wgl.wglGetProcAddress('glBlendFuncSeparateEXT'), null);

    assert.equal(context.glGetString(GL.EXTENSIONS),
        'GL_ARB_multitexture GL_EXT_blend_func_separate',
        'and the string reports exactly what is obtainable');

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});

// --- presentation ---

test('SwapBuffers counts against the drawable, not the device context', ()=>{
    const f = fixture();
    setUpFormat(f);
    const context = f.wgl.wglCreateContext(WINDOW_DC);
    assert.equal(f.wgl.wglMakeCurrent(WINDOW_DC, context), true);

    assert.equal(f.wgl.SwapBuffers(WINDOW_DC), true);
    assert.equal(f.wgl.SwapBuffers(OTHER_WINDOW_DC), true);

    assert.equal(f.wgl.swapCount(WINDOW_DC), 2);
    assert.equal(f.wgl.swapCount(MEMORY_DC), 0);

    assert.equal(f.wgl.wglDeleteContext(context), true);
    f.assertAllReleased(context);
});
