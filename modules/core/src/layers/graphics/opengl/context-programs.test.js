/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { PROGRAM_LIMITS } from './arb-program.js';
import { createGlContext } from './context.js';

const VP = GL.VERTEX_PROGRAM_ARB;
const FP = GL.FRAGMENT_PROGRAM_ARB;

/** A context with guest memory to hand program texts and pointers through. */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    let next = 0x1000;
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const context = createGlContext({ memory });
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    /** @param {string} text */
    const put = text=>{
        const at = next;
        bytes.set(new TextEncoder().encode(text), at);
        next += (text.length + 16) & ~15;
        return { at, length: text.length };
    };
    return { context, bytes, put };
}

const GOOD = '!!ARBvp1.0\nTEMP r0;\nMOV result.position, vertex.position;\nEND\n';

test('program objects live and die like texture objects', ()=>{
    const { context } = fixture();
    assert.deepEqual(context.glGenProgramsARB(2), [1, 2]);
    assert.equal(context.glIsProgramARB(1), GL.FALSE,
        'a generated name is not a program until it is bound');
    context.glBindProgramARB(VP, 1);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.equal(context.glIsProgramARB(1), GL.TRUE);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_BINDING_ARB), [1]);

    // An object belongs to the target it was first bound to.
    context.glBindProgramARB(FP, 1);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION);
    assert.deepEqual(context.glGetProgramivARB(FP, GL.PROGRAM_BINDING_ARB), [0],
        'a refused bind leaves the target as it was');
    context.glBindProgramARB(FP, 2);
    assert.equal(context.glGetError(), GL.NO_ERROR, 'a fresh name binds to either target');

    context.glDeleteProgramsARB([1, 0, 99]);
    assert.equal(context.glIsProgramARB(1), GL.FALSE);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_BINDING_ARB), [0],
        'deleting the bound program rebinds the default');
    assert.equal(context.glGetError(), GL.NO_ERROR, 'unused names are ignored');

    context.glBindProgramARB(GL.TEXTURE_2D, 3);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glGenProgramsARB(-1);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
});

test('a program string loads, and the queries report what it holds', ()=>{
    const { context, put } = fixture();
    const text = put(GOOD);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(VP, 1);
    context.glProgramStringARB(VP, GL.PROGRAM_FORMAT_ASCII_ARB, text.length, text.at);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetIntegerv(GL.PROGRAM_ERROR_POSITION_ARB), [-1]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_LENGTH_ARB), [text.length]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_FORMAT_ARB),
        [GL.PROGRAM_FORMAT_ASCII_ARB]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_INSTRUCTIONS_ARB), [1]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_TEMPORARIES_ARB), [1]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_PARAMETERS_ARB), [0]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_ATTRIBS_ARB), [1]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_UNDER_NATIVE_LIMITS_ARB), [1]);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.MAX_PROGRAM_INSTRUCTIONS_ARB),
        [PROGRAM_LIMITS.vertex.instructions]);
    const loaded = context.glGetProgramStringARB(VP, GL.PROGRAM_STRING_ARB);
    assert.equal(new TextDecoder().decode(loaded), GOOD);
    // The default object of a target with nothing loaded answers zero.
    assert.deepEqual(context.glGetProgramivARB(FP, GL.PROGRAM_LENGTH_ARB), [0]);
    assert.deepEqual(context.glGetProgramStringARB(FP, GL.PROGRAM_STRING_ARB),
        new Uint8Array(0));
    context.glGetProgramStringARB(VP, GL.PROGRAM_LENGTH_ARB);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

test('a failed load reports the position, names the error, and changes nothing', ()=>{
    const { context, put } = fixture();
    const good = put(GOOD);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(VP, 1);
    context.glProgramStringARB(VP, GL.PROGRAM_FORMAT_ASCII_ARB, good.length, good.at);
    assert.equal(context.glGetError(), GL.NO_ERROR);

    const badText = '!!ARBvp1.0\nTEMP r0;\nFROB r0, r0;\nEND\n';
    const bad = put(badText);
    context.glProgramStringARB(VP, GL.PROGRAM_FORMAT_ASCII_ARB, bad.length, bad.at);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION);
    assert.deepEqual(context.glGetIntegerv(GL.PROGRAM_ERROR_POSITION_ARB),
        [badText.indexOf('FROB')]);
    assert.match(context.glGetString(GL.PROGRAM_ERROR_STRING_ARB), /not a vertex program/);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_LENGTH_ARB), [good.length],
        'the previous string survives the failed load');
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_BINDING_ARB), [1],
        'and the binding is untouched');

    // A fragment program handed to the vertex target is refused at the header.
    const wrong = put('!!ARBfp1.0\nMOV result.color, fragment.color;\nEND\n');
    context.glProgramStringARB(VP, GL.PROGRAM_FORMAT_ASCII_ARB, wrong.length, wrong.at);
    assert.equal(context.glGetError(), GL.INVALID_OPERATION);
    assert.deepEqual(context.glGetIntegerv(GL.PROGRAM_ERROR_POSITION_ARB), [0]);
    assert.match(context.glGetString(GL.PROGRAM_ERROR_STRING_ARB), /fragment program/);

    context.glProgramStringARB(VP, GL.RGBA, 1, wrong.at);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glProgramStringARB(GL.TEXTURE_2D, GL.PROGRAM_FORMAT_ASCII_ARB, 1, wrong.at);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glProgramStringARB(VP, GL.PROGRAM_FORMAT_ASCII_ARB, -1, wrong.at);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
});

test('environment parameters are per target, local parameters per object', ()=>{
    const { context } = fixture();
    context.glGenProgramsARB(2);
    context.glBindProgramARB(VP, 1);
    context.glProgramEnvParameter4fARB(VP, 3, [1, 2, 3, 4]);
    context.glProgramLocalParameter4fARB(VP, 2, [5, 6, 7, 8]);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetProgramEnvParameterfvARB(VP, 3), [1, 2, 3, 4]);
    assert.deepEqual(context.glGetProgramLocalParameterfvARB(VP, 2), [5, 6, 7, 8]);

    // The environment of a target is shared by every program of that target;
    // the fragment target keeps its own file.
    context.glBindProgramARB(VP, 2);
    assert.deepEqual(context.glGetProgramEnvParameterfvARB(VP, 3), [1, 2, 3, 4]);
    assert.deepEqual(context.glGetProgramEnvParameterfvARB(FP, 3), [0, 0, 0, 0]);
    // Local parameters travelled with object 1, not with the binding.
    assert.deepEqual(context.glGetProgramLocalParameterfvARB(VP, 2), [0, 0, 0, 0]);
    context.glBindProgramARB(VP, 1);
    assert.deepEqual(context.glGetProgramLocalParameterfvARB(VP, 2), [5, 6, 7, 8]);

    context.glProgramEnvParameter4fARB(VP, PROGRAM_LIMITS.vertex.envParameters, [0, 0, 0, 0]);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glProgramLocalParameter4fARB(GL.TEXTURE_2D, 0, [0, 0, 0, 0]);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    assert.equal(context.glGetProgramEnvParameterfvARB(VP, -1 >>> 0), null);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
});

test('the program enables, the limits and the attribute count answer as advertised', ()=>{
    const { context } = fixture();
    for (const cap of [VP, FP, GL.VERTEX_PROGRAM_POINT_SIZE_ARB, GL.VERTEX_PROGRAM_TWO_SIDE_ARB])
    {
        assert.equal(context.glIsEnabled(cap), GL.FALSE);
        context.glEnable(cap);
        assert.equal(context.glIsEnabled(cap), GL.TRUE);
        context.glDisable(cap);
        assert.equal(context.glIsEnabled(cap), GL.FALSE);
    }
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetIntegerv(GL.MAX_VERTEX_ATTRIBS_ARB), [16]);
    const minima = [
        [GL.MAX_PROGRAM_INSTRUCTIONS_ARB, 128],
        [GL.MAX_PROGRAM_TEMPORARIES_ARB, 12],
        [GL.MAX_PROGRAM_PARAMETERS_ARB, 96],
        [GL.MAX_PROGRAM_ENV_PARAMETERS_ARB, 96],
        [GL.MAX_PROGRAM_LOCAL_PARAMETERS_ARB, 96],
        [GL.MAX_PROGRAM_ALU_INSTRUCTIONS_ARB, 72],
        [GL.MAX_PROGRAM_TEX_INSTRUCTIONS_ARB, 24],
        [GL.MAX_PROGRAM_ADDRESS_REGISTERS_ARB, 1],
    ];
    for (const [query, minimum] of minima)
    {
        const [value] = /** @type {number[]} */ (context.glGetIntegerv(query));
        assert.ok(value >= minimum, `query 0x${query.toString(16)} reports ${value}`);
    }
    // GetProgramivARB answers the fragment target's own limits.
    assert.deepEqual(context.glGetProgramivARB(FP, GL.MAX_PROGRAM_TEMPORARIES_ARB),
        [PROGRAM_LIMITS.fragment.temporaries]);
    assert.deepEqual(context.glGetProgramivARB(FP, GL.MAX_PROGRAM_ADDRESS_REGISTERS_ARB), [0],
        'a fragment program has no address registers');
    context.glGetProgramivARB(GL.TEXTURE_2D, GL.PROGRAM_LENGTH_ARB);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glGetProgramivARB(VP, GL.TEXTURE_WIDTH);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
});

test('generic attribute current values, arrays and their queries', ()=>{
    const { context } = fixture();
    context.glVertexAttrib4fARB(3, 0.25, 0.5, 0.75, 1);
    assert.deepEqual(context.glGetVertexAttribfvARB(3, GL.CURRENT_VERTEX_ATTRIB_ARB),
        [0.25, 0.5, 0.75, 1]);
    assert.deepEqual(context.glGetVertexAttribfvARB(3, GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB), [0],
        'the array starts disabled, whatever the current value is');

    context.glVertexAttribPointerARB(3, 3, GL.UNSIGNED_BYTE, 1, 24, 0x100);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    assert.deepEqual(context.glGetVertexAttribfvARB(3, GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB), [3]);
    assert.deepEqual(context.glGetVertexAttribfvARB(3, GL.VERTEX_ATTRIB_ARRAY_TYPE_ARB),
        [GL.UNSIGNED_BYTE]);
    assert.deepEqual(context.glGetVertexAttribfvARB(3, GL.VERTEX_ATTRIB_ARRAY_NORMALIZED_ARB),
        [1]);
    assert.deepEqual(context.glGetVertexAttribfvARB(3, GL.VERTEX_ATTRIB_ARRAY_STRIDE_ARB), [24]);
    assert.deepEqual(
        context.glGetVertexAttribPointervARB(3, GL.VERTEX_ATTRIB_ARRAY_POINTER_ARB), [0x100]);
    context.glEnableVertexAttribArrayARB(3);
    assert.deepEqual(context.glGetVertexAttribfvARB(3, GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB), [1]);
    assert.deepEqual(
        context.side.programs.genericArrays()
            .map((/** @type {{ name: string }} */ a)=>a.name), ['color'],
        'attribute 3 is the primary colour, by the aliasing table');
    context.glDisableVertexAttribArrayARB(3);
    assert.deepEqual(context.side.programs.genericArrays(), []);

    // A pointer set while a buffer object is bound reads from the buffer.
    context.glGenBuffersARB(1);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 1);
    context.glVertexAttribPointerARB(9, 2, GL.FLOAT, 0, 0, 12);
    const nine = context.side.programs.attribArrays[9];
    assert.equal(nine.buffer, 1);
    assert.equal(nine.pointer, 12);

    context.glEnableVertexAttribArrayARB(16);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glVertexAttribPointerARB(0, 5, GL.FLOAT, 0, 0, 0);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glVertexAttribPointerARB(0, 4, GL.RGBA, 0, 0, 0);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, -4, 0);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    assert.equal(context.glGetVertexAttribfvARB(20, GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB), null);
    assert.equal(context.glGetError(), GL.INVALID_VALUE);
    context.glGetVertexAttribfvARB(0, GL.TEXTURE_WIDTH);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);
    context.glGetVertexAttribPointervARB(0, GL.CURRENT_VERTEX_ATTRIB_ARB);
    assert.equal(context.glGetError(), GL.INVALID_ENUM);

    // A current value is legal between glBegin and glEnd, like glVertex.
    context.glBegin(GL.TRIANGLES);
    context.glVertexAttrib4fARB(0, 1, 2, 3, 4);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    context.glEnd();
});

test('the attribute stacks save the program state under their bits', ()=>{
    const { context } = fixture();
    context.glVertexAttrib4fARB(1, 1, 2, 3, 4);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(VP, 1);
    context.glEnableVertexAttribArrayARB(2);
    context.glVertexAttribPointerARB(2, 4, GL.FLOAT, 0, 0, 0x200);

    context.glPushAttrib(GL.CURRENT_BIT | GL.TRANSFORM_BIT | GL.ENABLE_BIT);
    context.glEnable(VP);
    context.glVertexAttrib4fARB(1, 9, 8, 7, 6);
    context.glBindProgramARB(VP, 0);
    context.glPopAttrib();
    assert.deepEqual(context.glGetVertexAttribfvARB(1, GL.CURRENT_VERTEX_ATTRIB_ARB),
        [1, 2, 3, 4], 'CURRENT_BIT saved the generic attribute');
    assert.equal(context.glIsEnabled(VP), GL.FALSE, 'ENABLE_BIT saved the enable');
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_BINDING_ARB), [1],
        'TRANSFORM_BIT saved the binding');

    context.glPushClientAttrib(GL.CLIENT_VERTEX_ARRAY_BIT);
    context.glDisableVertexAttribArrayARB(2);
    context.glVertexAttribPointerARB(2, 2, GL.SHORT, 0, 8, 0x300);
    context.glPopClientAttrib();
    assert.deepEqual(context.glGetVertexAttribfvARB(2, GL.VERTEX_ATTRIB_ARRAY_ENABLED_ARB), [1]);
    assert.deepEqual(context.glGetVertexAttribfvARB(2, GL.VERTEX_ATTRIB_ARRAY_SIZE_ARB), [4]);
    assert.deepEqual(
        context.glGetVertexAttribPointervARB(2, GL.VERTEX_ATTRIB_ARRAY_POINTER_ARB), [0x200]);
});

test('program objects are the share group\'s, and both contexts bind the same one', ()=>{
    const { context, put } = fixture();
    const text = put(GOOD);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(VP, 1);
    context.glProgramStringARB(VP, GL.PROGRAM_FORMAT_ASCII_ARB, text.length, text.at);

    const bytes = new Uint8Array(0x1000);
    /** @type {any} */
    const other = createGlContext({
        shareGroup: context.shareGroup,
        memory: {
            read: (at, length)=>bytes.subarray(at, at + length),
            write: (at, value)=>bytes.set(value, at),
        },
    });
    other.attach({ width: 8, height: 8, doubleBuffered: false });
    assert.equal(other.glIsProgramARB(1), GL.TRUE, 'the object is the group\'s');
    other.glBindProgramARB(VP, 1);
    assert.deepEqual(other.glGetProgramivARB(VP, GL.PROGRAM_LENGTH_ARB), [text.length],
        'and what it holds is visible from either context');
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_BINDING_ARB), [1],
        'the binding is per context');
    other.glBindProgramARB(VP, 0);
    assert.deepEqual(context.glGetProgramivARB(VP, GL.PROGRAM_BINDING_ARB), [1]);
});
