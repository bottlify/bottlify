/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct state access (OpenGL 4.5): each named call does its bound form's
 * work on the object it names, leaves every binding as it was, and raises
 * GL_INVALID_OPERATION for a name that is no object; the glCreate* calls
 * make objects at once. Through the exports, the words and boxes arrive as
 * the bound forms' do.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createOpengl } from './exports.js';
import { TEX } from './formats.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 8, height: 4, doubleBuffered: true });
    context.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    context.glPixelStorei(GL.PACK_ALIGNMENT, 1);
    return context;
}

/** @param {any} gl @param {number} expected @param {string} [why] */
const error = (gl, expected, why)=>assert.equal(gl.glGetError(), expected, why);

/** @param {number} width @param {number} height @param {number} [depth] */
const all = (width, height, depth = 1)=>({ x: 0, y: 0, z: 0, width, height, depth });

test('glCreateTextures makes textures of their target at once, bound nowhere', ()=>{
    const gl = fixture();
    const names = gl.glCreateTextures(GL.TEXTURE_CUBE_MAP, 2);
    assert.equal(names.length, 2);
    assert.deepEqual(names.map((/** @type {number} */ name)=>gl.glIsTexture(name)),
        [GL.TRUE, GL.TRUE], 'objects before any bind');
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_CUBE_MAP), [0]);
    gl.glBindTexture(GL.TEXTURE_2D, names[0]);
    error(gl, GL.INVALID_OPERATION, 'a cube map\'s name for life');
    gl.glCreateTextures(0x9009, 1);
    error(gl, GL.NO_ERROR, 'a cube map array texture (4.0)');
    gl.glCreateTextures(0x900b, 1);
    error(gl, GL.INVALID_ENUM, 'a proxy target makes no texture');
    gl.glCreateTextures(GL.TEXTURE_2D, -1);
    error(gl, GL.INVALID_VALUE);
});

test('a texture\'s named calls work on it, the bound one untouched', ()=>{
    const gl = fixture();
    const [bound] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, bound);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA8, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        Uint8Array.from([9, 9, 9, 9]));
    const [named] = gl.glCreateTextures(GL.TEXTURE_2D, 1);
    gl.textureStorage(2, named, 2, TEX.R8, 2, 2, 1);
    gl.textureSubImage(2, named, 0, { x: 1, y: 1, z: 0, width: 1, height: 1, depth: 1 }, GL.RED,
        GL.UNSIGNED_BYTE, Uint8Array.from([77]));
    gl.textureParameter(named, GL.TEXTURE_MIN_FILTER, [GL.NEAREST]);
    gl.textureParameterI(named, GL.TEXTURE_BORDER_COLOR, [1, 2, 3, 4]);
    error(gl, GL.NO_ERROR);
    assert.deepEqual(gl.getTextureParameter(named, GL.TEXTURE_MIN_FILTER), [GL.NEAREST]);
    assert.deepEqual(gl.getTextureParameter(named, GL.TEXTURE_BORDER_COLOR), [1, 2, 3, 4]);
    assert.deepEqual(gl.getTextureParameter(named, 0x82df), [2], 'its storage\'s levels');
    assert.deepEqual(gl.glGetTextureLevelParameter(named, 1, GL.TEXTURE_WIDTH), [1]);
    assert.deepEqual(Array.from(gl.glGetTextureImage(named, 0, GL.RED, GL.UNSIGNED_BYTE, 4)),
        [0, 0, 0, 77]);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D), [bound], 'still bound');
    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER),
        [GL.NEAREST_MIPMAP_LINEAR], 'the bound texture\'s own');
    assert.deepEqual(gl.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, GL.TEXTURE_INTERNAL_FORMAT),
        [GL.RGBA8]);
    gl.copyTextureSubImage(2, named, 0, 0, 0, 0, 0, 0, 1, 1);
    error(gl, GL.NO_ERROR, 'a copy from the framebuffer into it');
});

test('a texture\'s named calls refuse a name that is none, and a target it is not', ()=>{
    const gl = fixture();
    const [generated] = gl.glGenTextures(1);
    gl.textureParameter(generated, GL.TEXTURE_MIN_FILTER, [GL.NEAREST]);
    error(gl, GL.INVALID_OPERATION, 'generated, never bound: no object yet');
    gl.textureStorage(2, 0, 1, GL.RGBA8, 1, 1, 1);
    error(gl, GL.INVALID_OPERATION, 'zero');
    const [solid] = gl.glCreateTextures(GL.TEXTURE_3D, 1);
    gl.textureStorage(2, solid, 1, GL.RGBA8, 1, 1, 1);
    error(gl, GL.INVALID_OPERATION, 'a 2D call on a 3D texture');
    gl.textureSubImage(1, solid, 0, all(1, 1), GL.RGBA, GL.UNSIGNED_BYTE, null);
    error(gl, GL.INVALID_OPERATION, 'a 1D call on it');
    const [cube] = gl.glCreateTextures(GL.TEXTURE_CUBE_MAP, 1);
    gl.compressedTextureSubImage(2, cube, 0, all(4, 4), TEX.COMPRESSED_RED_RGTC1, 8, null);
    error(gl, GL.INVALID_OPERATION, 'a cube map\'s faces are a 3D call\'s');
    gl.glGetTextureImage(99, 0, GL.RGBA, GL.UNSIGNED_BYTE, 64);
    error(gl, GL.INVALID_OPERATION, 'glGetTextureImage: no such texture');
    gl.glGetTextureSubImage(99, 0, all(1, 1), GL.RGBA, GL.UNSIGNED_BYTE, 64);
    error(gl, GL.INVALID_VALUE, 'its sub-image form says it otherwise (8.11.4)');
});

test('a cube map\'s faces are a 3D call\'s z, each image from the next of the client\'s', ()=>{
    const gl = fixture();
    const [cube] = gl.glCreateTextures(GL.TEXTURE_CUBE_MAP, 1);
    gl.textureStorage(2, cube, 1, TEX.R8, 2, 2, 1);
    gl.glPixelStorei(GL.UNPACK_ALIGNMENT, 4);
    // Rows of two bytes padded to four: an image of two rows is eight bytes.
    gl.textureSubImage(3, cube, 0, { x: 0, y: 0, z: 3, width: 2, height: 2, depth: 2 }, GL.RED,
        GL.UNSIGNED_BYTE, Uint8Array.from([1, 2, 0, 0, 3, 4, 0, 0, 5, 6, 0, 0, 7, 8, 0, 0]));
    error(gl, GL.NO_ERROR);
    assert.deepEqual(Array.from(gl.glGetTextureSubImage(cube, 0, { x: 0, y: 0, z: 3, width: 2,
        height: 2, depth: 2 }, GL.RED, GL.UNSIGNED_BYTE, 8)), [1, 2, 3, 4, 5, 6, 7, 8]);
    gl.textureSubImage(3, cube, 0, { x: 0, y: 0, z: 5, width: 1, height: 1, depth: 2 }, GL.RED,
        GL.UNSIGNED_BYTE, Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0]));
    error(gl, GL.INVALID_VALUE, 'past the sixth face');
    gl.copyTextureSubImage(3, cube, 0, 0, 0, 6, 0, 0, 1, 1);
    error(gl, GL.INVALID_VALUE, 'a copy into a seventh');
    gl.copyTextureSubImage(3, cube, 0, 0, 0, 5, 0, 0, 1, 1);
    error(gl, GL.NO_ERROR);
    assert.deepEqual(gl.glGetTextureLevelParameter(cube, 0, GL.TEXTURE_WIDTH), [2],
        'a cube map answers for its first face');
});

test('glBindTextureUnit binds on the texture\'s own target, zero unbinding every one', ()=>{
    const gl = fixture();
    const [flat] = gl.glCreateTextures(GL.TEXTURE_2D, 1);
    const [cube] = gl.glCreateTextures(GL.TEXTURE_CUBE_MAP, 1);
    gl.glBindTextureUnit(2, flat);
    gl.glBindTextureUnit(2, cube);
    gl.glActiveTextureARB(GL.TEXTURE0 + 2);
    assert.deepEqual([gl.glGetIntegerv(GL.TEXTURE_BINDING_2D)[0],
        gl.glGetIntegerv(GL.TEXTURE_BINDING_CUBE_MAP)[0]], [flat, cube]);
    gl.glBindTextureUnit(2, 0);
    assert.deepEqual([gl.glGetIntegerv(GL.TEXTURE_BINDING_2D)[0],
        gl.glGetIntegerv(GL.TEXTURE_BINDING_CUBE_MAP)[0]], [0, 0]);
    gl.glBindTextureUnit(2, 99);
    error(gl, GL.INVALID_OPERATION);
    gl.glBindTextureUnit(1000, flat);
    error(gl, GL.INVALID_VALUE);
});

test('a buffer\'s named calls work on it, the copy bindings put back', ()=>{
    const gl = fixture();
    const [held] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.COPY_WRITE_BUFFER, held);
    const [a, b] = gl.glCreateBuffers(2);
    assert.equal(gl.glIsBufferARB(a), GL.TRUE, 'an object at once');
    gl.namedBuffer('glBufferDataARB', a, [4, Uint8Array.from([1, 2, 3, 4]), GL.STATIC_DRAW]);
    gl.namedBuffer('glBufferDataARB', b, [4, null, GL.STATIC_DRAW]);
    gl.glCopyNamedBufferSubData(a, b, 1, 0, 2);
    error(gl, GL.NO_ERROR);
    assert.deepEqual(Array.from(gl.namedBuffer('glGetBufferSubDataARB', b, [0, 4])),
        [2, 3, 0, 0]);
    assert.deepEqual(gl.namedBuffer('glGetBufferParameterivARB', a, [GL.BUFFER_SIZE]), [4]);
    assert.deepEqual(gl.glGetIntegerv(GL.COPY_WRITE_BUFFER), [held], 'still bound');
    assert.deepEqual(gl.glGetIntegerv(GL.COPY_READ_BUFFER), [0]);
    gl.namedBuffer('glBufferSubDataARB', a, [3, 4, Uint8Array.from([0, 0, 0, 0])]);
    error(gl, GL.INVALID_VALUE, 'the bound form\'s own errors');
    const [generated] = gl.glGenBuffersARB(1);
    gl.namedBuffer('glBufferDataARB', generated, [4, null, GL.STATIC_DRAW]);
    error(gl, GL.INVALID_OPERATION, 'generated, never bound');
    gl.glCopyNamedBufferSubData(a, 99, 0, 0, 1);
    error(gl, GL.INVALID_OPERATION);
});

test('a framebuffer\'s named calls work on it, the bindings and the window\'s read buffer'
    + ' put back', ()=>{
    const gl = fixture();
    gl.glReadBuffer(GL.FRONT);
    const [fbo] = gl.glCreateFramebuffers(1);
    const [colour] = gl.glCreateTextures(GL.TEXTURE_2D, 1);
    gl.textureStorage(2, colour, 1, GL.RGBA8, 4, 4, 1);
    gl.namedFramebufferTexture(fbo, GL.COLOR_ATTACHMENT0, colour, 0, null);
    assert.equal(gl.glCheckNamedFramebufferStatus(fbo, GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    gl.namedFramebuffer('glReadBuffer', fbo, true, false, [GL.COLOR_ATTACHMENT0]);
    error(gl, GL.NO_ERROR);
    assert.deepEqual(gl.namedFramebuffer('glGetFramebufferAttachmentParameteriv', fbo, false,
        true, [GL.COLOR_ATTACHMENT0, GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME]), [colour]);
    assert.deepEqual([gl.glGetIntegerv(GL.FRAMEBUFFER_BINDING)[0],
        gl.glGetIntegerv(GL.READ_FRAMEBUFFER_BINDING)[0], gl.glGetIntegerv(GL.READ_BUFFER)[0]],
    [0, 0, GL.FRONT], 'the window bound, its read buffer the program\'s');
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, fbo, false);
    assert.deepEqual(gl.glGetIntegerv(GL.READ_BUFFER), [GL.COLOR_ATTACHMENT0],
        'the framebuffer kept what the named call set');
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, 0, false);
    gl.glCheckNamedFramebufferStatus(fbo, GL.TEXTURE_2D);
    error(gl, GL.INVALID_ENUM);
    const [generated] = gl.glGenFramebuffers(1);
    gl.namedFramebufferTexture(generated, GL.COLOR_ATTACHMENT0, colour, 0, null);
    error(gl, GL.INVALID_OPERATION, 'generated, never bound');
    gl.namedFramebufferTexture(fbo, GL.COLOR_ATTACHMENT0, 99, 0, null);
    error(gl, GL.INVALID_OPERATION, 'no such texture');
    gl.namedFramebufferTexture(fbo, GL.COLOR_ATTACHMENT0, colour, 0, 1);
    error(gl, GL.INVALID_OPERATION, 'a layer of a 2D texture');
    gl.glInvalidateNamedFramebuffer(fbo, 1, [GL.COLOR_ATTACHMENT0], null);
    error(gl, GL.NO_ERROR);
    gl.glInvalidateNamedFramebuffer(fbo, 1, [GL.BACK_LEFT], null);
    error(gl, GL.INVALID_ENUM, 'a window\'s buffer on a framebuffer object');
    gl.glInvalidateNamedFramebuffer(0, 1, [GL.BACK_LEFT], { width: -1, height: 1 });
    error(gl, GL.INVALID_VALUE);
});

test('a renderbuffer\'s named calls work on it, its binding put back', ()=>{
    const gl = fixture();
    const [bound, named] = gl.glCreateRenderbuffers(2);
    gl.bindRenderbuffer(GL.RENDERBUFFER, bound, false);
    gl.namedRenderbuffer('glRenderbufferStorageMultisample', named, [0, GL.RGBA8, 3, 2]);
    error(gl, GL.NO_ERROR);
    assert.deepEqual(gl.namedRenderbuffer('glGetRenderbufferParameteriv', named,
        [GL.RENDERBUFFER_WIDTH]), [3]);
    assert.deepEqual(gl.glGetIntegerv(GL.RENDERBUFFER_BINDING), [bound]);
    assert.deepEqual(gl.glGetRenderbufferParameteriv(GL.RENDERBUFFER, GL.RENDERBUFFER_WIDTH),
        [0]);
    gl.namedRenderbuffer('glRenderbufferStorageMultisample', 99, [0, GL.RGBA8, 3, 2]);
    error(gl, GL.INVALID_OPERATION);
});

test('a named call runs as it is reached, a display list open or not', ()=>{
    const gl = fixture();
    const [named] = gl.glCreateTextures(GL.TEXTURE_2D, 1);
    const list = gl.glGenLists(1);
    gl.glNewList(list, GL.COMPILE);
    gl.textureParameter(named, GL.TEXTURE_MIN_FILTER, [GL.NEAREST]);
    gl.glEndList();
    assert.deepEqual(gl.getTextureParameter(named, GL.TEXTURE_MIN_FILTER), [GL.NEAREST],
        'made at once');
    gl.textureParameter(named, GL.TEXTURE_MIN_FILTER, [GL.LINEAR]);
    gl.glCallList(list);
    assert.deepEqual(gl.getTextureParameter(named, GL.TEXTURE_MIN_FILTER), [GL.LINEAR],
        'and not again by the list');
});

test('through the exports: names written out, words and boxes as the bound forms take them',
    ()=>{
        const bytes = new Uint8Array(0x20000);
        let next = 0x100;
        const opengl = createOpengl({
            readMemory: (at, length)=>bytes.subarray(at, at + length),
            writeMemory: (at, value)=>bytes.set(value, at),
            screen: ()=>({ width: 4, height: 4 }),
            scratch: { allocate: size=>{
                const at = next;
                next += (size + 16) & ~15;
                return at;
            } },
            exportAddress: ()=>0x7000_0000,
        });
        const table = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
            opengl.table);
        table.wglSetPixelFormat.handler([0x900d, 1, 0]);
        table.wglMakeCurrent.handler([0x900d, table.wglCreateContext.handler([0x900d])]);
        /** @param {string} name @param {number[]} args */
        const gl = (name, ...args)=>table[name].handler(args);
        /** @param {number[]} data */
        const put = data=>{
            const at = next;
            bytes.set(data, at);
            next += (data.length + 16) & ~15;
            return at;
        };
        const out = put(new Array(16).fill(0xee));
        gl('glPixelStorei', GL.UNPACK_ALIGNMENT, 1);
        gl('glPixelStorei', GL.PACK_ALIGNMENT, 1);
        gl('glCreateTextures', GL.TEXTURE_2D, 2, out);
        const [a, b] = [bytes[out], bytes[out + 4]];
        assert.deepEqual([a > 0, b > a], [true, true], 'two names written out');
        gl('glTextureStorage2D', a, 1, TEX.R8, 2, 2);
        gl('glTextureSubImage2D', a, 0, 0, 0, 2, 2, GL.RED, GL.UNSIGNED_BYTE, put([1, 2, 3, 4]));
        gl('glTexStorage2D', GL.TEXTURE_2D, 1, TEX.R8, 2, 2);
        assert.equal(gl('glGetError'), GL.INVALID_OPERATION, 'nothing bound but the default');
        gl('glTextureStorage2D', b, 1, TEX.R8, 2, 2);
        gl('glCopyImageSubData', a, GL.TEXTURE_2D, 0, 1, 0, 0, b, GL.TEXTURE_2D, 0, 0, 1, 0, 1, 1,
            1);
        gl('glClearTexSubImage', b, 0, 1, 0, 0, 1, 1, 1, GL.RED, GL.UNSIGNED_BYTE, put([9]));
        gl('glGetTextureSubImage', b, 0, 0, 0, 0, 2, 2, 1, GL.RED, GL.UNSIGNED_BYTE, 4, out);
        assert.equal(gl('glGetError'), GL.NO_ERROR);
        assert.deepEqual(Array.from(bytes.subarray(out, out + 4)), [0, 9, 2, 0],
            'a\'s texel (1, 0) at b\'s (0, 1), and a cleared texel');
        gl('glGetTextureImage', b, 0, GL.RED, GL.UNSIGNED_BYTE, 3, out);
        assert.equal(gl('glGetError'), GL.INVALID_OPERATION, 'too small a buffer');
        gl('glCreateBuffers', 1, out);
        const buffer = bytes[out];
        gl('glNamedBufferData', buffer, 4, put([5, 6, 7, 8]), GL.STATIC_DRAW);
        gl('glGetNamedBufferSubData', buffer, 1, 2, out);
        assert.deepEqual(Array.from(bytes.subarray(out, out + 2)), [6, 7]);
        gl('glGetNamedBufferParameteri64v', buffer, GL.BUFFER_SIZE, out);
        assert.deepEqual(Array.from(bytes.subarray(out, out + 8)), [4, 0, 0, 0, 0, 0, 0, 0]);
        gl('glTextureParameteri', a, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
        gl('glGetTextureParameteriv', a, GL.TEXTURE_MAG_FILTER, out);
        assert.equal(new DataView(bytes.buffer).getInt32(out, true), GL.NEAREST);
        assert.equal(gl('glGetError'), GL.NO_ERROR);
    });

test('glFramebufferTexture (3.2) attaches a texture of one image a level as its target names it',
    ()=>{
        const gl = fixture();
        const [fbo] = gl.glCreateFramebuffers(1);
        const [plain, rectangle] = [gl.glCreateTextures(GL.TEXTURE_2D, 1)[0],
            gl.glCreateTextures(GL.TEXTURE_RECTANGLE, 1)[0]];
        gl.textureStorage(2, plain, 1, GL.RGBA8, 4, 4, 1);
        gl.textureStorage(2, rectangle, 1, GL.RGBA8, 4, 4, 1);
        gl.glFramebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, plain, 0);
        error(gl, GL.INVALID_OPERATION, 'the window takes no texture');
        gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
        gl.glFramebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, plain, 0);
        gl.glFramebufferTexture(GL.DRAW_FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + 1, rectangle, 0);
        error(gl, GL.NO_ERROR);
        const ask = (/** @type {number} */ attachment, /** @type {number} */ pname)=>
            gl.namedFramebuffer('glGetFramebufferAttachmentParameteriv', fbo, false, true,
                [attachment, pname]);
        assert.deepEqual(ask(GL.COLOR_ATTACHMENT0, GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME),
            [plain]);
        assert.deepEqual(ask(GL.COLOR_ATTACHMENT0 + 1, GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME),
            [rectangle], 'a rectangle as itself');
        assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
        gl.glFramebufferTexture(GL.TEXTURE_2D, GL.COLOR_ATTACHMENT0, plain, 0);
        error(gl, GL.INVALID_ENUM);
    });

test('many bound at once (4.4): textures, samplers and buffers, a refused one leaving the rest',
    ()=>{
        const gl = fixture();
        const [a, b] = gl.glCreateTextures(GL.TEXTURE_2D, 2);
        gl.glBindTextures(1, 3, [a, 999, b]);
        error(gl, GL.INVALID_OPERATION, 'a name that is no texture');
        gl.glActiveTextureARB(GL.TEXTURE0 + 1);
        assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D), [a]);
        gl.glActiveTextureARB(GL.TEXTURE0 + 3);
        assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D), [b], 'the rest still bound');
        gl.glBindTextures(1, 3, null);
        assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D), [0], 'null unbinds each');
        gl.glBindTextures(7, 2, null);
        error(gl, GL.INVALID_OPERATION, 'past the last unit');

        const [s] = gl.glGenSamplers(1);
        gl.glBindSamplers(0, 2, [s, 77]);
        error(gl, GL.INVALID_OPERATION);
        gl.glActiveTextureARB(GL.TEXTURE0);
        assert.deepEqual(gl.glGetIntegerv(0x8919 /* SAMPLER_BINDING */), [s]);

        const [u, v] = gl.glCreateBuffers(2);
        gl.namedBuffer('glBufferDataARB', u, [512, null, GL.STATIC_DRAW]);
        gl.namedBuffer('glBufferDataARB', v, [64, null, GL.STATIC_DRAW]);
        gl.glBindBuffers(GL.UNIFORM_BUFFER, 2, 2, [u, v], null);
        assert.deepEqual(gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_BINDING, 3), [v]);
        gl.glBindBuffers(GL.UNIFORM_BUFFER, 0, 1, [u], { offsets: [256], sizes: [32] });
        assert.deepEqual(gl.glGetIntegeri_v(0x8a29 /* UNIFORM_BUFFER_START */, 0), [256]);
        gl.glBindBuffers(GL.UNIFORM_BUFFER, 0, 1, [u], { offsets: [0], sizes: [0] });
        error(gl, GL.INVALID_VALUE, 'a range of no bytes');
        gl.glBindBuffers(GL.ARRAY_BUFFER, 0, 1, [u], null);
        error(gl, GL.INVALID_ENUM, 'no indexed points');
        gl.glBindBuffers(GL.UNIFORM_BUFFER, 1000, 1, [u], null);
        error(gl, GL.INVALID_OPERATION, 'past the last point');
    });

test('buffer and multisample textures by name (4.5), and a bound texture read into a size',
    ()=>{
        const gl = fixture();
        const [buffer] = gl.glCreateBuffers(1);
        gl.namedBuffer('glBufferDataARB', buffer, [16, null, GL.STATIC_DRAW]);
        const [texel] = gl.glCreateTextures(GL.TEXTURE_BUFFER, 1);
        gl.glTextureBuffer(texel, GL.RGBA8, buffer, { offset: 4, size: 8 });
        error(gl, GL.NO_ERROR);
        gl.glActiveTextureARB(GL.TEXTURE0);
        gl.glBindTexture(GL.TEXTURE_BUFFER, texel);
        assert.deepEqual(gl.glGetTexLevelParameteriv(GL.TEXTURE_BUFFER, 0,
            GL.TEXTURE_BUFFER_OFFSET), [4]);
        const [plain] = gl.glCreateTextures(GL.TEXTURE_2D, 1);
        gl.glTextureBuffer(plain, GL.RGBA8, buffer, null);
        error(gl, GL.INVALID_OPERATION, 'not a buffer texture');
        const [ms] = gl.glCreateTextures(GL.TEXTURE_2D_MULTISAMPLE, 1);
        gl.glTextureStorageMultisample(ms, 4, GL.RGBA8, 4, 4, 1, 1);
        error(gl, GL.NO_ERROR);

        gl.textureStorage(2, plain, 1, GL.RGBA8, 2, 2, 1);
        gl.glBindTexture(GL.TEXTURE_2D, plain);
        assert.equal(gl.getnTexImage(false, GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE, 15), null);
        error(gl, GL.INVALID_OPERATION, 'sixteen bytes do not fit fifteen');
        assert.equal(gl.getnTexImage(false, GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            16).length, 16);
        gl.getnTexImage(false, GL.TEXTURE_CUBE_MAP, 0, GL.RGBA, GL.UNSIGNED_BYTE, 16);
        error(gl, GL.INVALID_ENUM, 'a cube map is read a face at a time');
    });
