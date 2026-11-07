/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A core profile (OpenGL 3.2 appendix E.2): what the compatibility profile
 * adds is refused, and a context made for debugging starts debugging.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @param {{ profile: number, flags?: number }} kind @returns {any} */
function context({ profile, flags = 0 }){
    const gl = createGlContext({ version: { major: 3, minor: 2, profile, flags },
        extensions: ['GL_ARB_one'] });
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    return gl;
}

const CORE = GL.CONTEXT_CORE_PROFILE_BIT;
const COMPATIBILITY = GL.CONTEXT_COMPATIBILITY_PROFILE_BIT;

test('a core profile refuses the calls it removed and draws only from a vertex array object',
    ()=>{
        const gl = context({ profile: CORE });
        gl.glBegin(GL.TRIANGLES);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no immediate mode');
        gl.glMatrixMode(GL.MODELVIEW);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no matrix stack');
        gl.glClientActiveTextureARB(GL.TEXTURE0);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'an ARB spelling too');
        gl.glClearColor(0, 0, 0, 1);
        assert.equal(gl.glGetError(), GL.NO_ERROR, 'what it kept');

        assert.equal(gl.glGetString(GL.EXTENSIONS), null);
        assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'extensions one by one');
        assert.equal(gl.glGetStringi(GL.EXTENSIONS, 0), 'GL_ARB_one');

        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no vertex array object bound');
        const [vao] = gl.glGenVertexArrays(1);
        gl.glBindVertexArray(vao);
        gl.glDrawArrays(GL.QUADS, 0, 4);
        assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'no quads');
        gl.glDrawArrays(GL.TRIANGLES, 0, 0);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        assert.deepEqual(gl.glGetIntegerv(GL.CONTEXT_PROFILE_MASK), [CORE]);
    });

test('a compatibility profile keeps everything, and a debug context starts debugging', ()=>{
    const gl = context({ profile: COMPATIBILITY, flags: GL.CONTEXT_FLAG_DEBUG_BIT });
    gl.glMatrixMode(GL.MODELVIEW);
    gl.glDrawArrays(GL.QUADS, 0, 0);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.equal(gl.glGetString(GL.EXTENSIONS), 'GL_ARB_one');
    assert.equal(gl.glIsEnabled(GL.DEBUG_OUTPUT), GL.TRUE);
    assert.equal(context({ profile: COMPATIBILITY }).glIsEnabled(GL.DEBUG_OUTPUT), GL.FALSE);

    const forward = createGlContext({ version: { major: 3, minor: 0, profile: 0,
        flags: GL.CONTEXT_FLAG_FORWARD_COMPATIBLE_BIT } });
    forward.attach({ width: 4, height: 4, doubleBuffered: true });
    /** @type {any} */ (forward).glBegin(GL.TRIANGLES);
    assert.equal(forward.glGetError(), GL.INVALID_OPERATION,
        'a forward-compatible 3.0 has none of what 3.0 deprecated');
});
