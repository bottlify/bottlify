/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Debug output (OpenGL 4.3 chapter 20): the log, the rules, the groups and
 * the labels.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { DEBUG } from './context-debug.js';

/** @returns {any} */
function context(){
    const gl = createGlContext({});
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    return gl;
}

const APP = DEBUG.SOURCE_APPLICATION;

test('messages are logged only while debug output is on, as many as the log holds', ()=>{
    const gl = context();
    gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 1, DEBUG.SEVERITY_HIGH, 'off');
    assert.deepEqual(gl.glGetIntegerv(DEBUG.DEBUG_LOGGED_MESSAGES), [0], 'off by default');
    gl.glEnable(DEBUG.DEBUG_OUTPUT);
    for (let k = 0; k < 70; k++)
    {
        gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, k, DEBUG.SEVERITY_HIGH, `m${k}`);
    }
    assert.deepEqual(gl.glGetIntegerv(DEBUG.DEBUG_LOGGED_MESSAGES), [64]);
    assert.deepEqual(gl.glGetIntegerv(DEBUG.DEBUG_NEXT_LOGGED_MESSAGE_LENGTH), [3]);
    const taken = gl.glGetDebugMessageLog(10, 7);
    assert.deepEqual(taken.map((/** @type {any} */ m)=>m.text), ['m0', 'm1'],
        'as many as fit the text asked for');
    assert.deepEqual(gl.glGetIntegerv(DEBUG.DEBUG_LOGGED_MESSAGES), [62]);

    gl.glDebugMessageInsert(DEBUG.SOURCE_API, DEBUG.TYPE_OTHER, 1, DEBUG.SEVERITY_HIGH, 'x');
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'only the program and third parties insert');
    gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 1, DEBUG.SEVERITY_HIGH, 'x'.repeat(1024));
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
});

test('the rules decide, the last that matches; low severity starts off; groups keep their own',
    ()=>{
        const gl = context();
        gl.glEnable(DEBUG.DEBUG_OUTPUT);
        const count = ()=>gl.glGetIntegerv(DEBUG.DEBUG_LOGGED_MESSAGES)[0];
        gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 1, DEBUG.SEVERITY_LOW, 'low');
        assert.equal(count(), 0, 'low severity is off at first');
        gl.glDebugMessageControl(DEBUG.DONT_CARE, DEBUG.DONT_CARE, DEBUG.SEVERITY_LOW, [], true);
        gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 1, DEBUG.SEVERITY_LOW, 'low');
        assert.equal(count(), 1);
        gl.glDebugMessageControl(APP, DEBUG.TYPE_OTHER, DEBUG.DONT_CARE, [5], false);
        gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 5, DEBUG.SEVERITY_HIGH, 'five');
        gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 6, DEBUG.SEVERITY_HIGH, 'six');
        assert.equal(count(), 2, 'id 5 is off, 6 is not');
        gl.glDebugMessageControl(DEBUG.DONT_CARE, DEBUG.TYPE_OTHER, DEBUG.DONT_CARE, [5], true);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'ids need a source and a type');

        gl.glPushDebugGroup(APP, 9, 'group');
        assert.deepEqual(gl.glGetIntegerv(DEBUG.DEBUG_GROUP_STACK_DEPTH), [2]);
        gl.glDebugMessageControl(DEBUG.DONT_CARE, DEBUG.DONT_CARE, DEBUG.DONT_CARE, [], false);
        gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 6, DEBUG.SEVERITY_HIGH, 'muted');
        gl.glPopDebugGroup();
        gl.glDebugMessageInsert(APP, DEBUG.TYPE_OTHER, 6, DEBUG.SEVERITY_HIGH, 'heard');
        const texts = gl.glGetDebugMessageLog(10, null).map((/** @type {any} */ m)=>m.text);
        assert.deepEqual(texts, ['low', 'six', 'group', 'group', 'heard'],
            'the push and the pop heard under the rules outside the group, the inside muted');
        gl.glPopDebugGroup();
        assert.equal(gl.glGetError(), GL.STACK_UNDERFLOW);
    });

test('labels are kept on the objects they name, and refused for names that are none', ()=>{
    const gl = context();
    const [buffer] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, buffer);
    gl.glObjectLabel(DEBUG.BUFFER, buffer, 'vertices');
    assert.equal(gl.glGetObjectLabel(DEBUG.BUFFER, buffer), 'vertices');
    gl.glDeleteBuffersARB([buffer]);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, buffer);
    assert.equal(gl.glGetObjectLabel(DEBUG.BUFFER, buffer), '', 'a new object, no label');
    const program = gl.glCreateProgram();
    gl.glObjectLabel(DEBUG.PROGRAM, program, 'shade');
    assert.equal(gl.glGetObjectLabel(DEBUG.PROGRAM, program), 'shade');
    gl.glObjectLabel(DEBUG.PROGRAM, program, null);
    assert.equal(gl.glGetObjectLabel(DEBUG.PROGRAM, program), '');
    gl.glObjectLabel(DEBUG.BUFFER, 999, 'none');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glObjectLabel(0x1234, 1, 'what');
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glObjectLabel(DEBUG.PROGRAM, program, 'x'.repeat(256));
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
});
