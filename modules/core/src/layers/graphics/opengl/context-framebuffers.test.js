/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Framebuffer and renderbuffer objects against GL_ARB_framebuffer_object
 * (OpenGL 3.0's section 4.4) and GL_EXT_framebuffer_object: binding,
 * attaching, completeness, the queries, and the state that is the
 * framebuffer's own. What a draw into one gives the device is `gpu-fbo.test.js`'s.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    return context;
}

/** A texture with a 32x16 level 0 and no data, bound to unit 0. @param {any} gl */
function texture(gl, width = 32, height = 16){
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, width, height, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    return name;
}

test('a framebuffer name binds once generated; the EXT spelling makes one on the bind', ()=>{
    const gl = fixture();
    gl.bindFramebuffer(GL.FRAMEBUFFER, 7, false);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'ARB: not generated');
    gl.bindFramebuffer(GL.FRAMEBUFFER, 7, true);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'EXT: made on the bind');
    assert.equal(gl.glIsFramebuffer(7), GL.TRUE);
    const [name] = gl.glGenFramebuffers(1);
    assert.equal(gl.glIsFramebuffer(name), GL.FALSE, 'a generated name is not yet one');
    gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, name, false);
    assert.deepEqual(gl.glGetIntegerv(GL.FRAMEBUFFER_BINDING), [name]);
    assert.deepEqual(gl.glGetIntegerv(GL.READ_FRAMEBUFFER_BINDING), [7],
        'the draw binding alone moved');
    gl.bindFramebuffer(0x1234, 0, false);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glDeleteFramebuffers([name, 7]);
    assert.deepEqual(gl.glGetIntegerv(GL.FRAMEBUFFER_BINDING), [0], 'deleting unbinds');
    assert.deepEqual(gl.glGetIntegerv(GL.READ_FRAMEBUFFER_BINDING), [0]);
});

test('completeness is the specification\'s, and this renderer\'s limits are'
    + ' GL_FRAMEBUFFER_UNSUPPORTED', ()=>{
    const gl = fixture();
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE,
        'the window is complete');
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER),
        GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT);
    const colour = texture(gl);
    gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);

    const [rb] = gl.glGenRenderbuffers(1);
    gl.bindRenderbuffer(GL.RENDERBUFFER, rb, false);
    gl.glFramebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, rb);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER),
        GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT, 'a renderbuffer without storage');
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.DEPTH_COMPONENT24, 32, 16);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.DEPTH_COMPONENT24, 64, 16);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_UNSUPPORTED,
        'attachments of different sizes: a WebGPU pass is one size');

    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.RGBA8, 32, 16);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER),
        GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT, 'colour where depth is wanted');
    gl.glFramebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.RENDERBUFFER, 0);

    gl.glDrawBuffers([GL.COLOR_ATTACHMENT0, GL.COLOR_ATTACHMENT0 + 1]);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER),
        GL.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER, 'a draw buffer with nothing attached');
    gl.glDrawBuffers([GL.COLOR_ATTACHMENT0]);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
});

test('drawing into an incomplete framebuffer is GL_INVALID_FRAMEBUFFER_OPERATION', ()=>{
    const gl = fixture();
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    assert.equal(gl.glGetError(), GL.INVALID_FRAMEBUFFER_OPERATION);
    gl.glBegin(GL.TRIANGLES);
    gl.glVertex2f(0, 0);
    gl.glVertex2f(1, 0);
    gl.glVertex2f(0, 1);
    gl.glEnd();
    assert.equal(gl.glGetError(), GL.INVALID_FRAMEBUFFER_OPERATION);
});

test('attachments: a texture of the target named, a level in range, and what they answer',
    ()=>{
        const gl = fixture();
        const [fbo] = gl.glGenFramebuffers(1);
        gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 1, 0);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no framebuffer bound');
        gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
        const colour = texture(gl);
        gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_CUBE_MAP_POSITIVE_X,
            colour, 0);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a 2D texture is not a cube face');
        gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 40);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE);
        gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + 9, GL.TEXTURE_2D, colour, 0);
        assert.equal(gl.glGetError(), GL.INVALID_ENUM);
        gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
        const query = (/** @type {number} */ pname)=>
            gl.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, pname);
        assert.deepEqual(query(GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE), [GL.TEXTURE]);
        assert.deepEqual(query(GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME), [colour]);
        assert.deepEqual(query(GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL), [0]);
        assert.deepEqual(query(GL.FRAMEBUFFER_ATTACHMENT_RED_SIZE), [8]);
        assert.deepEqual(gl.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER,
            GL.DEPTH_ATTACHMENT, GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE), [GL.NONE]);
        // Deleting the texture detaches it from the framebuffer bound.
        gl.glDeleteTextures([colour]);
        assert.deepEqual(query(GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE), [GL.NONE]);
    });

test('a renderbuffer\'s storage and its queries; DEPTH_STENCIL attaches to both points', ()=>{
    const gl = fixture();
    const [rb] = gl.glGenRenderbuffers(1);
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.RGBA8, 4, 4);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'none bound');
    gl.bindRenderbuffer(GL.RENDERBUFFER, 99, false);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'ARB: not generated');
    gl.bindRenderbuffer(GL.RENDERBUFFER, rb, false);
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, 0x1234, 4, 4);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.DEPTH24_STENCIL8, 4096, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past GL_MAX_RENDERBUFFER_SIZE');
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.DEPTH24_STENCIL8, 16, 8);
    const query = (/** @type {number} */ pname)=>
        gl.glGetRenderbufferParameteriv(GL.RENDERBUFFER, pname);
    assert.deepEqual([query(GL.RENDERBUFFER_WIDTH), query(GL.RENDERBUFFER_HEIGHT),
        query(GL.RENDERBUFFER_INTERNAL_FORMAT), query(GL.RENDERBUFFER_DEPTH_SIZE),
        query(GL.RENDERBUFFER_STENCIL_SIZE), query(GL.RENDERBUFFER_RED_SIZE)],
    [[16], [8], [GL.DEPTH24_STENCIL8], [24], [8], [0]]);
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    gl.glFramebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER, rb);
    for (const point of [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT])
    {
        assert.deepEqual(gl.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER, point,
            GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME), [rb]);
    }
    gl.glDeleteRenderbuffers([rb]);
    assert.deepEqual(gl.glGetIntegerv(GL.RENDERBUFFER_BINDING), [0]);
    assert.deepEqual(gl.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER,
        GL.DEPTH_ATTACHMENT, GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE), [GL.NONE],
    'deleting detaches it from the framebuffer bound');
});

test('the draw and read buffers are the framebuffer\'s own', ()=>{
    const gl = fixture();
    assert.deepEqual(gl.glGetIntegerv(GL.DRAW_BUFFER0), [GL.BACK]);
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    assert.deepEqual(gl.glGetIntegerv(GL.DRAW_BUFFER0), [GL.COLOR_ATTACHMENT0]);
    assert.deepEqual(gl.glGetIntegerv(GL.READ_BUFFER), [GL.COLOR_ATTACHMENT0]);
    gl.glDrawBuffer(GL.BACK);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a framebuffer object has no back buffer');
    gl.glDrawBuffers([GL.COLOR_ATTACHMENT0 + 1, GL.NONE, GL.COLOR_ATTACHMENT0]);
    assert.deepEqual([GL.DRAW_BUFFER0, GL.DRAW_BUFFER1, GL.DRAW_BUFFER2, GL.DRAW_BUFFER3]
        .map(q=>gl.glGetIntegerv(q)[0]),
    [GL.COLOR_ATTACHMENT0 + 1, GL.NONE, GL.COLOR_ATTACHMENT0, GL.NONE]);
    gl.glDrawBuffers([GL.COLOR_ATTACHMENT0, GL.COLOR_ATTACHMENT0]);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'one attachment twice');
    gl.glReadBuffer(GL.COLOR_ATTACHMENT0 + 2);
    assert.deepEqual(gl.glGetIntegerv(GL.READ_BUFFER), [GL.COLOR_ATTACHMENT0 + 2]);
    gl.bindFramebuffer(GL.FRAMEBUFFER, 0, false);
    assert.deepEqual(gl.glGetIntegerv(GL.DRAW_BUFFER0), [GL.BACK], 'the window\'s are its own');
    assert.deepEqual(gl.glGetIntegerv(GL.READ_BUFFER), [GL.BACK]);
});

test('glGenerateMipmap makes the levels the base level\'s size calls for', ()=>{
    const gl = fixture();
    const name = texture(gl, 8, 4);
    gl.glGenerateMipmap(GL.TEXTURE_2D);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    const sizes = [0, 1, 2, 3].map(level=>[
        gl.glGetTexLevelParameteriv(GL.TEXTURE_2D, level, GL.TEXTURE_WIDTH)[0],
        gl.glGetTexLevelParameteriv(GL.TEXTURE_2D, level, GL.TEXTURE_HEIGHT)[0]]);
    assert.deepEqual(sizes, [[8, 4], [4, 2], [2, 1], [1, 1]]);
    assert.ok(name > 0);
    gl.glGenerateMipmap(GL.TEXTURE_1D);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});

test('glBlitFramebuffer\'s arguments are checked before anything moves', ()=>{
    const gl = fixture();
    gl.glBlitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, 0x80000000, GL.NEAREST);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glBlitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, GL.COLOR_BUFFER_BIT, 0x1234);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glBlitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, GL.DEPTH_BUFFER_BIT, GL.LINEAR);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'depth is not filtered');
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, fbo, false);
    gl.glBlitFramebuffer(0, 0, 1, 1, 0, 0, 1, 1, GL.COLOR_BUFFER_BIT, GL.NEAREST);
    assert.equal(gl.glGetError(), GL.INVALID_FRAMEBUFFER_OPERATION, 'an incomplete read');
});
