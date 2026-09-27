/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL, PFD } from './constants.js';
import { PIXEL_FORMATS } from './pixelformat.js';
import { DEFAULT_ENABLES, DEFAULT_STATE, readState, resolveStateDefault } from './state.js';
import { createWgl } from './wgl.js';

const WINDOW_DC = 0x10;
const WIDTH = 640;
const HEIGHT = 480;

/**
 * A context obtained the way a program obtains one, so that the state under
 * test is the state a real make-current produced. `done` is the teardown every
 * test in this file ends with.
 */
function fixture(){
    const drawables = new Map([[WINDOW_DC, { key: 'window:1', width: WIDTH, height: HEIGHT }]]);
    const wgl = createWgl({
        gdi: { describeDrawable: hdc=>drawables.get(hdc) ?? null },
        currentThread: ()=>1,
        keepPrimitives: true,
    });
    const index = wgl.ChoosePixelFormat(WINDOW_DC, {
        ...PIXEL_FORMATS[0],
        dwFlags: PFD.DRAW_TO_WINDOW | PFD.SUPPORT_OPENGL | PFD.DOUBLEBUFFER,
        cColorBits: 24,
        cDepthBits: 24,
    });
    assert.ok(index > 0, 'the fixture request is answerable');
    assert.equal(wgl.SetPixelFormat(WINDOW_DC, index), true);
    const gl = wgl.wglCreateContext(WINDOW_DC);
    assert.notEqual(gl, null, 'the fixture context was created');
    assert.equal(wgl.wglMakeCurrent(WINDOW_DC, gl), true);

    return {
        wgl,
        gl,
        done(){
            assert.equal(wgl.wglDeleteContext(gl), true, 'the context was deleted');
            assert.equal(gl.destroyed, true, 'and reports itself destroyed');
            assert.equal(wgl.wglGetCurrentContext(), null, 'and nothing is left current');
        },
    };
}

// --- the default state ---

test('a fresh context reads back the documented default of every state', ()=>{
    const { gl, done } = fixture();
    // The fixture asked for a 24-bit depth buffer, and the depth bits it
    // reads back are the format's, not a constant.
    const inputs = { width: WIDTH, height: HEIGHT, doubleBuffered: true, depthBits: 24 };

    // A repeated query would silently drop one of the two entries, and the one
    // that survives is whichever the table happens to list second.
    assert.equal(new Set(DEFAULT_STATE.map(entry=>entry.query)).size, DEFAULT_STATE.length,
        'no query appears twice in the table');

    for (const entry of DEFAULT_STATE)
    {
        const expected = { kind: entry.kind, values: resolveStateDefault(entry, inputs),
            normalised: entry.normalised };
        assert.deepEqual(gl.glGetFloatv(entry.query), readState(expected, 'float'),
            `default of ${entry.name}`);
        assert.deepEqual(gl.glGetIntegerv(entry.query), readState(expected, 'int'),
            `default of ${entry.name} as an integer`);
    }
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'and reading them all raised nothing');

    done();
});

test('GL_DITHER is the one capability that starts enabled', ()=>{
    const { gl, done } = fixture();

    for (const entry of DEFAULT_ENABLES)
    {
        const expected = entry.query === GL.DITHER ? GL.TRUE : GL.FALSE;
        assert.equal(gl.glIsEnabled(entry.query), expected, entry.name);
    }

    done();
});

test('the unpack alignment starts at four', ()=>{
    const { gl, done } = fixture();

    assert.deepEqual(gl.glGetIntegerv(GL.UNPACK_ALIGNMENT), [4]);
    assert.deepEqual(gl.glGetIntegerv(GL.PACK_ALIGNMENT), [4]);

    gl.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    assert.deepEqual(gl.glGetIntegerv(GL.UNPACK_ALIGNMENT), [1]);

    gl.glPixelStorei(GL.UNPACK_ALIGNMENT, 3);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'three is not a power of two up to eight');
    assert.deepEqual(gl.glGetIntegerv(GL.UNPACK_ALIGNMENT), [1], 'and the refused call did not');

    done();
});

test('a boolean read as a float is one, not the raw bit', ()=>{
    const { gl, done } = fixture();

    assert.deepEqual(gl.glGetFloatv(GL.DITHER), [1]);
    assert.deepEqual(gl.glGetIntegerv(GL.DITHER), [1]);
    assert.deepEqual(gl.glGetBooleanv(GL.DITHER), [1]);

    gl.glDepthMask(0);
    assert.deepEqual(gl.glGetFloatv(GL.DEPTH_WRITEMASK), [0]);

    done();
});

test('a float read as an integer rounds, and a colour maps onto the integer range', ()=>{
    const { gl, done } = fixture();

    gl.glClearDepth(0.75);
    assert.deepEqual(gl.glGetFloatv(GL.DEPTH_CLEAR_VALUE), [0.75]);
    assert.deepEqual(gl.glGetIntegerv(GL.DEPTH_CLEAR_VALUE), [1], 'rounded, not truncated');

    gl.glClearColor(1, 0, 0.5, 1);
    assert.deepEqual(gl.glGetFloatv(GL.COLOR_CLEAR_VALUE), [1, 0, 0.5, 1]);
    assert.deepEqual(gl.glGetIntegerv(GL.COLOR_CLEAR_VALUE),
        [0x7fffffff, 0, Math.round(0x7fffffff * 0.5), 0x7fffffff]);
    assert.deepEqual(gl.glGetBooleanv(GL.COLOR_CLEAR_VALUE), [1, 0, 1, 1],
        'and as a boolean it is only whether the component is non-zero');

    done();
});

test('an enum read back as a float is the enumerant, unmapped', ()=>{
    const { gl, done } = fixture();

    assert.deepEqual(gl.glGetIntegerv(GL.DEPTH_FUNC), [GL.LESS]);
    assert.deepEqual(gl.glGetFloatv(GL.DEPTH_FUNC), [GL.LESS]);
    assert.deepEqual(gl.glGetIntegerv(GL.CULL_FACE_MODE), [GL.BACK]);
    assert.deepEqual(gl.glGetIntegerv(GL.FRONT_FACE), [GL.CCW]);
    assert.deepEqual(gl.glGetIntegerv(GL.SHADE_MODEL), [GL.SMOOTH]);
    assert.deepEqual(gl.glGetIntegerv(GL.BLEND_SRC), [GL.ONE]);
    assert.deepEqual(gl.glGetIntegerv(GL.BLEND_DST), [GL.ZERO]);
    assert.deepEqual(gl.glGetIntegerv(GL.MATRIX_MODE), [GL.MODELVIEW]);

    done();
});

// --- the error flag ---

test('an error is reported once and only the first is kept', ()=>{
    const { gl, done } = fixture();

    assert.equal(gl.glGetError(), GL.NO_ERROR);

    gl.glGetIntegerv(0xdeadbeef);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'reading it cleared it');

    gl.glGetIntegerv(0xdeadbeef);
    gl.glViewport(0, 0, -1, -1);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'the second error did not displace the first');
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'and it was not queued behind it either');

    gl.glViewport(0, 0, -1, -1);
    gl.glGetIntegerv(0xdeadbeef);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'the other order reports the other one');
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

test('a call that fails does nothing else', ()=>{
    const { gl, done } = fixture();

    gl.glDepthFunc(GL.GREATER);
    gl.glDepthFunc(0xdeadbeef);

    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetIntegerv(GL.DEPTH_FUNC), [GL.GREATER], 'the state did not move');

    gl.glViewport(1, 2, 3, 4);
    gl.glViewport(9, 9, -1, 9);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    assert.deepEqual(gl.glGetIntegerv(GL.VIEWPORT), [1, 2, 3, 4]);

    done();
});

test('a query that is not one leaves the caller nothing at all', ()=>{
    const { gl, done } = fixture();

    assert.equal(gl.glGetIntegerv(0xdeadbeef), null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.equal(gl.glGetString(0xdeadbeef), null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.equal(gl.glIsEnabled(GL.DEPTH_FUNC), GL.FALSE, 'a query is not a capability');
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);

    done();
});

// --- the matrix stacks ---

test('each matrix mode has its own stack, and its own depth', ()=>{
    const { gl, done } = fixture();

    gl.glMatrixMode(GL.MODELVIEW);
    gl.glTranslatef(1, 2, 3);
    gl.glMatrixMode(GL.PROJECTION);
    gl.glTranslatef(4, 5, 6);
    gl.glMatrixMode(GL.TEXTURE);

    assert.equal(gl.glGetError(), GL.NO_ERROR);
    const modelview = gl.glGetFloatv(GL.MODELVIEW_MATRIX);
    const projection = gl.glGetFloatv(GL.PROJECTION_MATRIX);
    const texture = gl.glGetFloatv(GL.TEXTURE_MATRIX);

    assert.deepEqual(modelview.slice(12, 15), [1, 2, 3]);
    assert.deepEqual(projection.slice(12, 15), [4, 5, 6]);
    assert.deepEqual(texture.slice(12, 15), [0, 0, 0], 'untouched by either');

    done();
});

test('a fresh stack is one deep, because the depth counts the current matrix', ()=>{
    const { gl, done } = fixture();

    assert.deepEqual(gl.glGetIntegerv(GL.MODELVIEW_STACK_DEPTH), [1]);
    gl.glPushMatrix();
    assert.deepEqual(gl.glGetIntegerv(GL.MODELVIEW_STACK_DEPTH), [2]);
    gl.glPopMatrix();
    assert.deepEqual(gl.glGetIntegerv(GL.MODELVIEW_STACK_DEPTH), [1]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

test('the projection stack overflows where the modelview stack still has room', ()=>{
    const { gl, done } = fixture();

    gl.glMatrixMode(GL.PROJECTION);
    gl.glPushMatrix();
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'the first push fits');
    gl.glPushMatrix();
    assert.equal(gl.glGetError(), GL.STACK_OVERFLOW, 'the second does not');
    assert.deepEqual(gl.glGetIntegerv(GL.PROJECTION_STACK_DEPTH), [2],
        'and the refused push did not deepen it');

    gl.glMatrixMode(GL.MODELVIEW);
    for (let i = 0; i < 31; i++)
    {
        gl.glPushMatrix();
    }
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'thirty-one pushes fit in the modelview stack');
    gl.glPushMatrix();
    assert.equal(gl.glGetError(), GL.STACK_OVERFLOW);

    done();
});

test('popping past the bottom underflows and leaves the matrix alone', ()=>{
    const { gl, done } = fixture();

    gl.glTranslatef(7, 8, 9);
    gl.glPopMatrix();

    assert.equal(gl.glGetError(), GL.STACK_UNDERFLOW);
    assert.deepEqual(gl.glGetFloatv(GL.MODELVIEW_MATRIX).slice(12, 15), [7, 8, 9]);

    done();
});

test('a push and pop restore the matrix element for element', ()=>{
    const { gl, done } = fixture();

    gl.glTranslatef(1, 0, 0);
    gl.glPushMatrix();
    gl.glScalef(5, 5, 5);
    gl.glTranslatef(0, 2, 0);
    assert.notDeepEqual(gl.glGetFloatv(GL.MODELVIEW_MATRIX).slice(12, 15), [1, 0, 0]);
    gl.glPopMatrix();

    assert.deepEqual(gl.glGetFloatv(GL.MODELVIEW_MATRIX).slice(12, 15), [1, 0, 0]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

test('the transformation calls compose in the order the specification gives them', ()=>{
    const { gl, done } = fixture();

    gl.glLoadIdentity();
    gl.glTranslatef(10, 0, 0);
    gl.glScalef(2, 2, 2);

    // The scale was applied to the current matrix on the right, so a vertex is
    // scaled first and then moved -- the translation is not itself doubled.
    const m = gl.glGetFloatv(GL.MODELVIEW_MATRIX);
    assert.deepEqual(m.slice(12, 15), [10, 0, 0]);
    assert.equal(m[0], 2);
    assert.equal(m[5], 2);
    assert.equal(m[10], 2);

    done();
});

test('a loaded matrix is stored exactly as it was handed over', ()=>{
    const { gl, done } = fixture();
    const m = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

    gl.glLoadMatrixf(m);

    assert.deepEqual(gl.glGetFloatv(GL.MODELVIEW_MATRIX), m,
        'column major in, column major out, with no transposition on the way');

    done();
});

test('an unknown matrix mode is refused and the current one stands', ()=>{
    const { gl, done } = fixture();

    gl.glMatrixMode(GL.PROJECTION);
    gl.glMatrixMode(0xdeadbeef);

    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetIntegerv(GL.MATRIX_MODE), [GL.PROJECTION]);

    done();
});

// --- texture objects ---

test('a generated texture name is not a texture until it is bound', ()=>{
    const { gl, done } = fixture();

    const names = gl.glGenTextures(3);

    assert.deepEqual(names, [1, 2, 3], 'the lowest unused names, starting at one');
    assert.equal(gl.glIsTexture(names[0]), GL.FALSE, 'reserved, but not yet an object');
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'and asking is not an error');

    gl.glBindTexture(GL.TEXTURE_2D, names[0]);
    assert.equal(gl.glIsTexture(names[0]), GL.TRUE);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D), [names[0]]);
    assert.equal(gl.glIsTexture(names[1]), GL.FALSE);

    done();
});

test('a texture name belongs to the target it was first bound to', ()=>{
    const { gl, done } = fixture();
    const [name] = gl.glGenTextures(1);

    gl.glBindTexture(GL.TEXTURE_2D, name);
    gl.glBindTexture(GL.TEXTURE_1D, name);

    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_1D), [0], 'and nothing was bound there');

    done();
});

test('deleting the bound texture rebinds the default object', ()=>{
    const { gl, done } = fixture();
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);

    gl.glDeleteTextures([name]);

    assert.equal(gl.glIsTexture(name), GL.FALSE);
    assert.deepEqual(gl.glGetIntegerv(GL.TEXTURE_BINDING_2D), [0]);
    gl.glDeleteTextures([0, name, 4242]);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'and deleting zero or a stranger is ignored');

    done();
});

test('a texture with one level and the default filter is incomplete', ()=>{
    const { gl, done } = fixture();
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);

    assert.deepEqual(gl.glGetTexParameteriv(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER),
        [GL.NEAREST_MIPMAP_LINEAR], 'the default minification filter wants a mipmap chain');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.equal(gl.isTextureComplete(GL.TEXTURE_2D), false,
        'so a single level is not enough and the texture samples black');

    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    assert.equal(gl.isTextureComplete(GL.TEXTURE_2D), true, 'a filter without mipmaps fixes it');

    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_LINEAR);
    gl.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.isTextureComplete(GL.TEXTURE_2D), false, 'an incomplete chain is no better');
    gl.glTexImage2D(GL.TEXTURE_2D, 2, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.isTextureComplete(GL.TEXTURE_2D), true, 'and a complete one is');
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

test('glTexImage2D checks its enums, its packed types and its numbers in that order', ()=>{
    const { gl, done } = fixture();
    const [name] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, name);

    gl.glTexImage2D(GL.TEXTURE_1D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'the wrong target');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, 0xdead, GL.UNSIGNED_BYTE);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'an unknown format');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.BITMAP);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'GL_BITMAP without GL_COLOR_INDEX');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_SHORT_5_6_5);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION,
        'a five-six-five type carries three components, not four');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGB, 4, 4, 0, GL.RGB, GL.UNSIGNED_SHORT_5_6_5);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'and with three it is fine');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, 0xdead, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an internal format is a value, not an enum');

    gl.glTexImage2D(GL.TEXTURE_2D, -1, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a negative level');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 2, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a border of two');

    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 99999, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'wider than the reported maximum');

    done();
});

test('a texture name and a display list name of the same number are different objects', ()=>{
    const { gl, done } = fixture();

    const list = gl.glGenLists(1);
    assert.equal(gl.glIsList(list), GL.TRUE);
    assert.equal(gl.glIsTexture(list), GL.FALSE, 'the namespaces do not overlap');

    const [texture] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    assert.equal(texture, list, 'and both handed out the same number');
    assert.equal(gl.glIsTexture(texture), GL.TRUE);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

// --- display lists ---

test('a compiled list records its calls and runs none of them until it is called', ()=>{
    const { gl, done } = fixture();
    const list = gl.glGenLists(1);

    gl.glNewList(list, GL.COMPILE);
    assert.deepEqual(gl.glGetIntegerv(GL.LIST_INDEX), [list], 'a query is answered now, not later');
    assert.deepEqual(gl.glGetIntegerv(GL.LIST_MODE), [GL.COMPILE]);
    gl.glDepthFunc(GL.GREATER);
    gl.glEnable(GL.DEPTH_TEST);
    gl.glEndList();

    assert.deepEqual(gl.glGetIntegerv(GL.DEPTH_FUNC), [GL.LESS], 'nothing took effect');
    assert.equal(gl.glIsEnabled(GL.DEPTH_TEST), GL.FALSE);
    assert.deepEqual(gl.glGetIntegerv(GL.LIST_INDEX), [0]);

    gl.glCallList(list);
    assert.deepEqual(gl.glGetIntegerv(GL.DEPTH_FUNC), [GL.GREATER], 'and now it all did');
    assert.equal(gl.glIsEnabled(GL.DEPTH_TEST), GL.TRUE);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

test('a list compiled for execution takes effect twice', ()=>{
    const { gl, done } = fixture();
    const list = gl.glGenLists(1);

    gl.glNewList(list, GL.COMPILE_AND_EXECUTE);
    gl.glTranslatef(1, 0, 0);
    gl.glEndList();

    assert.deepEqual(gl.glGetFloatv(GL.MODELVIEW_MATRIX).slice(12, 15), [1, 0, 0],
        'it ran as it was compiled');
    gl.glCallList(list);
    assert.deepEqual(gl.glGetFloatv(GL.MODELVIEW_MATRIX).slice(12, 15), [2, 0, 0],
        'and again when called');

    done();
});

test('a compiled list snapshots a float-vector argument, so a caller reusing its own scratch '
    + 'after recording does not corrupt what was recorded', ()=>{
    // A caller that hands over a scratch it reuses on its next call (the
    // exports layer's fixed-count vector readers do exactly this) must not
    // have this call's recorded arguments overwritten by the one after it,
    // let alone by whatever the scratch holds by the time the list is
    // finally played back.
    const { gl, done } = fixture();
    const list = gl.glGenLists(1);
    const scratch = new Float32Array(4);

    gl.glNewList(list, GL.COMPILE);
    scratch.set([1, 2, 3, 4]);
    gl.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 0, scratch);
    scratch.set([5, 6, 7, 8]);
    gl.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 1, scratch);
    gl.glEndList();

    scratch.set([9, 9, 9, 9]); // overwritten again, well before the list is ever run

    gl.glCallList(list);
    assert.deepEqual(gl.glGetProgramEnvParameterfvARB(GL.VERTEX_PROGRAM_ARB, 0), [1, 2, 3, 4],
        'the first call kept the values it had when it was recorded');
    assert.deepEqual(gl.glGetProgramEnvParameterfvARB(GL.VERTEX_PROGRAM_ARB, 1), [5, 6, 7, 8],
        'and the second kept its own, not the scratch\'s later contents');

    done();
});

test('a list refuses to be opened twice, closed unopened, or named zero', ()=>{
    const { gl, done } = fixture();
    const list = gl.glGenLists(1);

    gl.glEndList();
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'closing what was never opened');

    gl.glNewList(0, GL.COMPILE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'list zero does not exist');

    gl.glNewList(list, 0xdead);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'an unknown compile mode');

    gl.glNewList(list, GL.COMPILE);
    gl.glNewList(list, GL.COMPILE);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'and opening a second one');
    gl.glEndList();
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'the first is still the one that closes');

    done();
});

test('calling a name that is not a list is ignored rather than refused', ()=>{
    const { gl, done } = fixture();

    gl.glCallList(4242);

    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

test('generated lists are contiguous and exist before anything is compiled into them', ()=>{
    const { gl, done } = fixture();

    const first = gl.glGenLists(4);

    assert.ok(first > 0);
    for (let i = 0; i < 4; i++)
    {
        assert.equal(gl.glIsList(first + i), GL.TRUE, `list ${first + i}`);
    }
    assert.equal(gl.glIsList(first + 4), GL.FALSE);

    gl.glDeleteLists(first, 4);
    assert.equal(gl.glIsList(first), GL.FALSE);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    done();
});

// --- immediate mode ---

test('a primitive accumulates the vertices submitted between begin and end', ()=>{
    const { gl, done } = fixture();

    gl.glColor4f(1, 0, 0, 1);
    gl.glBegin(GL.TRIANGLES);
    gl.glVertex3f(0, 0, 0);
    gl.glColor4f(0, 1, 0, 1);
    gl.glTexCoord2f(0.5, 0.25);
    gl.glVertex3f(1, 0, 0);
    gl.glVertex3f(0, 1, 0);
    gl.glEnd();

    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.equal(gl.submittedPrimitives.length, 1);
    const primitive = gl.submittedPrimitives[0];
    assert.equal(primitive.mode, GL.TRIANGLES);
    assert.equal(primitive.vertices.length, 3);
    assert.deepEqual(primitive.vertices[0].color, [1, 0, 0, 1],
        'each vertex kept the colour that was current when it was submitted');
    assert.deepEqual(primitive.vertices[1].color, [0, 1, 0, 1]);
    assert.deepEqual(primitive.vertices[1].texCoord, [0.5, 0.25, 0, 1]);
    assert.deepEqual(primitive.vertices[2].position, [0, 1, 0, 1]);

    done();
});

test('an unpaired end, a nested begin and an unknown mode each fail on their own terms', ()=>{
    const { gl, done } = fixture();

    gl.glEnd();
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'an end with nothing open');

    gl.glBegin(0xdead);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'a mode that is not a primitive');
    gl.glEnd();
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'and the refused begin opened nothing');

    gl.glBegin(GL.QUADS);
    gl.glBegin(GL.QUADS);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a nested begin');
    gl.glEnd();
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'and one end still closes the one that opened');
    assert.equal(gl.submittedPrimitives.length, 1);

    done();
});

test('a call that is illegal inside a primitive fails and changes nothing', ()=>{
    const { gl, done } = fixture();

    gl.glBegin(GL.TRIANGLE_STRIP);
    gl.glVertex3f(0, 0, 0);
    gl.glEnable(GL.DEPTH_TEST);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'glEnable is not one of the twelve');
    gl.glDepthFunc(GL.GREATER);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    gl.glVertex3f(1, 0, 0);
    gl.glEnd();

    assert.equal(gl.glIsEnabled(GL.DEPTH_TEST), GL.FALSE, 'neither refused call took effect');
    assert.deepEqual(gl.glGetIntegerv(GL.DEPTH_FUNC), [GL.LESS]);
    assert.equal(gl.submittedPrimitives[0].vertices.length, 2,
        'and the vertices around them were kept');

    done();
});

test('nothing was drawn: the submitted primitives are the whole record', ()=>{
    const { gl, done } = fixture();

    gl.glBegin(GL.POINTS);
    gl.glVertex3f(0, 0, 0);
    gl.glEnd();
    gl.glBegin(GL.LINES);
    gl.glVertex3f(0, 0, 0);
    gl.glVertex3f(1, 1, 1);
    gl.glEnd();

    assert.deepEqual(gl.submittedPrimitives.map(/** @param {any} p */ p=>p.mode), [GL.POINTS, GL.LINES]);
    assert.equal(gl.currentPrimitive, null);

    done();
});
