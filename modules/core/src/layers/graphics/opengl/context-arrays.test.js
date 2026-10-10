/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/**
 * A context whose renderer records the draws it is handed, so a test reads
 * the arrays a draw actually gets: the aliasing table's pairs are one array,
 * whichever of the two entry points wrote it last.
 */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    /** @type {any[]} */
    const requests = [];
    /** @type {any} */
    const gpu = {
        attach: ()=>{},
        attached: ()=>true,
        drawArrays: (/** @type {any} */ unused, /** @type {any} */ request)=>{
            requests.push(request);
            return true;
        },
        draw: ()=>{},
        clear: ()=>{},
        copyToTexture: ()=>{},
        present: ()=>null,
        settled: ()=>Promise.resolve(),
        diagnostics: ()=>({}),
    };
    /** @type {any} */
    const context = createGlContext({
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
        },
        gpu,
    });
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    const program = ()=>{
        const text = '!!ARBvp1.0\nTEMP r0;\nMOV result.position, vertex.position;\nEND\n';
        bytes.set(new TextEncoder().encode(text), 0x3000);
        context.glGenProgramsARB(1);
        context.glBindProgramARB(GL.VERTEX_PROGRAM_ARB, 1);
        context.glProgramStringARB(GL.VERTEX_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
            text.length, 0x3000);
        context.glEnable(GL.VERTEX_PROGRAM_ARB);
        assert.equal(context.glGetError(), GL.NO_ERROR);
    };
    /** @returns {any} the arrays of one draw */
    const draw = ()=>{
        requests.length = 0;
        context.glDrawArrays(GL.TRIANGLES, 0, 3);
        assert.equal(requests.length, 1, 'the draw reached the renderer as arrays');
        return requests[0];
    };
    return { context, program, draw };
}

test('a generic attribute and the conventional array it aliases are one array', ()=>{
    const { context, program, draw } = fixture();
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 48, 0x10);
    context.glEnableClientState(GL.TEXTURE_COORD_ARRAY);
    context.glTexCoordPointer(2, GL.FLOAT, 48, 0xa0);
    program();
    // The generic write is the later one, so it is the pointer the draw reads,
    // exactly as a title that sets its conventional arrays in one pass and its
    // generic ones in the next expects.
    context.glVertexAttribPointerARB(8, 2, GL.FLOAT, 0, 48, 0xb0);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(
        context.glGetVertexAttribPointervARB(8, GL.VERTEX_ATTRIB_ARRAY_POINTER_ARB), [0xb0]);
    assert.deepEqual(context.glGetPointerv(GL.TEXTURE_COORD_ARRAY_POINTER), [0xb0],
        'the conventional query answers the generic write');
    const coord = draw().arrays.find((/** @type {any} */ a)=>a.name === 'texCoord0');
    assert.equal(coord.pointer.pointer, 0xb0, 'the draw reads the last pointer written');
    // The other order: the conventional write wins.
    context.glTexCoordPointer(2, GL.FLOAT, 48, 0xc0);
    assert.deepEqual(
        context.glGetVertexAttribPointervARB(8, GL.VERTEX_ATTRIB_ARRAY_POINTER_ARB), [0xc0],
        'and the generic query answers the conventional write');
    assert.equal(draw().arrays.find((/** @type {any} */ a)=>a.name === 'texCoord0')
        .pointer.pointer, 0xc0);
});

test('enabling through either entry point enables the one array', ()=>{
    const { context, program, draw } = fixture();
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 32, 0);
    context.glVertexAttribPointerARB(8, 2, GL.FLOAT, 0, 32, 8);
    program();
    context.glEnableVertexAttribArrayARB(8);
    assert.deepEqual(context.glGetIntegerv(GL.TEXTURE_COORD_ARRAY), [1],
        'the generic enable is the conventional array\'s enable');
    assert.ok(draw().arrays.some((/** @type {any} */ a)=>a.name === 'texCoord0'),
        'and the array the generic entry point enabled is drawn');
    context.glDisableClientState(GL.TEXTURE_COORD_ARRAY);
    assert.deepEqual(context.glGetVertexAttribfvARB(8,
        GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB), [0],
    'the conventional disable is seen through the generic query');
    assert.ok(!draw().arrays.some((/** @type {any} */ a)=>a.name === 'texCoord0'));
});

test('the aliasing table\'s other pairs are one array too', ()=>{
    const { context } = fixture();
    /** @type {[number, number, number][]} */
    const pairs = [
        [0, GL.VERTEX_ARRAY, GL.VERTEX_ARRAY_POINTER],
        [2, GL.NORMAL_ARRAY, GL.NORMAL_ARRAY_POINTER],
        [3, GL.COLOR_ARRAY, GL.COLOR_ARRAY_POINTER],
    ];
    for (const [index, cap, query] of pairs)
    {
        context.glVertexAttribPointerARB(index, 3, GL.FLOAT, 0, 32, 0x40 + index);
        assert.deepEqual(context.glGetPointerv(query), [0x40 + index],
            `the conventional query answers attribute ${index}`);
        context.glEnableVertexAttribArrayARB(index);
        assert.deepEqual(context.glGetIntegerv(cap), [1],
            `the generic enable is attribute ${index}'s conventional enable`);
        context.glDisableClientState(cap);
        assert.deepEqual(context.glGetVertexAttribfvARB(index,
            GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB), [0],
        `and the conventional disable reaches attribute ${index}`);
    }
    // The indices the table leaves generic keep their own state.
    context.glVertexAttribPointerARB(7, 4, GL.FLOAT, 0, 32, 0x80);
    context.glEnableVertexAttribArrayARB(7);
    assert.deepEqual(context.side.programs.genericArrays()
        .map((/** @type {any} */ a)=>a.name), ['attrib7']);
});

test('a lit draw reaches the device as it is, with the lighting its shader lights it by', ()=>{
    // The device's vertex stage lights a draw (`wgsl.js` lightingFunction).
    // Lit here as well, each vertex was assembled and lit on the program's
    // thread on every draw -- and lit twice once the device lit it again.
    /** @type {any[][]} */
    const drawn = [];
    /** @type {any[]} */
    const scenes = [];
    /** @type {any[]} */
    const arrays = [];
    /** @type {any} */
    const gpu = {
        attach: ()=>{}, attached: ()=>true,
        drawArrays: (/** @type {any} */ c, /** @type {any} */ request,
            /** @type {() => any} */ scene)=>
        {
            arrays.push(scene());
            return true;
        },
        draw: (/** @type {any} */ c, /** @type {() => any} */ scene, /** @type {number} */ m,
            /** @type {any[]} */ vertices)=>
        {
            drawn.push(vertices);
            scenes.push(scene());
        },
        clear: ()=>{}, copyToTexture: ()=>{}, present: ()=>null,
        settled: ()=>Promise.resolve(), diagnostics: ()=>({}),
    };
    /** @type {any} */
    const context = createGlContext({
        memory: { read: ()=>new Uint8Array(64), write: ()=>{} }, gpu,
    });
    context.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    context.glEnable(GL.LIGHTING);
    context.glEnable(GL.LIGHT0);
    context.glColor4f(0, 0, 0, 1);
    context.glBegin(GL.TRIANGLES);
    context.glNormal3f(0, 0, 1);
    context.glVertex3f(0, 0, 0);
    context.glVertex3f(1, 0, 0);
    context.glVertex3f(0, 1, 0);
    context.glEnd();
    assert.equal(drawn.length, 1);
    assert.deepEqual(drawn[0][0].color, [0, 0, 0, 1], 'its own colour, not one lit here');
    assert.deepEqual(drawn[0][0].normal, [0, 0, 1], 'and its normal, for the shader');
    assert.equal(scenes[0].lighting.lights.length, 1, 'the scene lights it by LIGHT0');

    // A draw by arrays is the device's too, lit or not.
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 0, 0);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(arrays.length, 1, 'taken as arrays, not assembled vertex by vertex');
    assert.notEqual(arrays[0].lighting, null);
});

test('a draw assembled vertex by vertex is counted, with why it was', ()=>{
    // The road a lit draw took for every frame of a game, unseen: the
    // renderer counts what reaches it that way.
    /** @type {[string, number][]} */
    const noted = [];
    /** @type {any} */
    const gpu = {
        attach: ()=>{}, attached: ()=>true, drawArrays: ()=>false, draw: ()=>{},
        /** @param {string} why @param {number} vertices */
        noteAssembled: (why, vertices)=>noted.push([why, vertices]),
        clear: ()=>{}, copyToTexture: ()=>{}, present: ()=>null,
        settled: ()=>Promise.resolve(), diagnostics: ()=>({}),
    };
    /** @type {any} */
    const context = createGlContext({
        memory: { read: ()=>new Uint8Array(64), write: ()=>{} }, gpu,
    });
    context.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 0, 0);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    context.glBegin(GL.TRIANGLES);
    context.glVertex3f(0, 0, 0);
    context.glVertex3f(1, 0, 0);
    context.glVertex3f(0, 1, 0);
    context.glEnd();
    assert.deepEqual(noted, [['refused', 3], ['immediate', 3]]);
});

test('an immediate vertex keeps the attributes current at its glVertex, whatever comes after', ()=>{
    // It holds the current values by reference, which is right only while a
    // change replaces them whole: a write in place would repaint the vertices
    // before it.
    /** @type {any[][]} */
    const drawn = [];
    /** @type {any} */
    const gpu = {
        attach: ()=>{}, attached: ()=>true, drawArrays: ()=>false,
        draw: (/** @type {any} */ c, /** @type {any} */ s, /** @type {number} */ m,
            /** @type {any[]} */ vertices)=>drawn.push(vertices),
        clear: ()=>{}, copyToTexture: ()=>{}, present: ()=>null,
        settled: ()=>Promise.resolve(), diagnostics: ()=>({}),
    };
    /** @type {any} */
    const context = createGlContext({
        memory: { read: ()=>new Uint8Array(0), write: ()=>{} }, gpu,
    });
    context.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    context.glBegin(GL.TRIANGLES);
    context.glColor4f(1, 0, 0, 1);
    context.glTexCoord2f(0.25, 0.5);
    context.glVertex3f(0, 0, 0);
    context.glColor4f(0, 1, 0, 1);
    context.glTexCoord2f(0.75, 1);
    context.glVertex3f(1, 0, 0);
    context.glVertex3f(0, 1, 0);
    context.glEnd();
    const [first, second, third] = drawn[0];
    assert.deepEqual([...first.color], [1, 0, 0, 1]);
    assert.deepEqual([...first.texCoords[0]].slice(0, 2), [0.25, 0.5]);
    assert.deepEqual([...second.color], [0, 1, 0, 1]);
    assert.deepEqual([...second.texCoords[0]].slice(0, 2), [0.75, 1]);
    assert.equal(third.color, second.color, 'unchanged between them: the same values, shared');
});
