/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ABI of the entry points past OpenGL 1.1 that marshal more than words:
 * a shader's source strings and their lengths, an info log copied out to the
 * size the caller gave, a name and its size and type, a pointer array a
 * pointer's width apart in a 64-bit process, and a uniform's floats.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createOpengl } from './exports.js';

/**
 * A library over guest memory with a context current, the pointers of the
 * process's width.
 *
 * @param {4 | 8} [pointerSize]
 */
function library(pointerSize = 4){
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
        pointerSize,
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        opengl.table);
    assert.equal(table.wglSetPixelFormat.handler([0x900d, 1, 0]), 1);
    assert.equal(table.wglMakeCurrent.handler([0x900d, table.wglCreateContext.handler([0x900d])]),
        1);
    /** @param {string} name @param {number[]} args */
    const gl = (name, ...args)=>table[name].handler(args);
    /** @param {Uint8Array | number[]} data @returns {number} */
    const put = data=>{
        const at = next;
        bytes.set(data instanceof Uint8Array ? data : new Uint8Array(new Uint32Array(data).buffer),
            at);
        next += (data.length * (data instanceof Uint8Array ? 1 : 4) + 16) & ~15;
        return at;
    };
    /** @param {string} text */
    const string = text=>put(new TextEncoder().encode(`${text}\0`));
    /** @param {number} at @param {number} length */
    const read = (at, length)=>new TextDecoder().decode(bytes.subarray(at, at + length));
    /** @param {number} at */
    const word = at=>new DataView(bytes.buffer).getInt32(at, true);
    return { gl, put, string, read, word, bytes };
}

test('a shader\'s strings: to their terminator, or of the lengths given, below zero meaning'
    + ' terminated', ()=>{
    const { gl, put, string, read, word } = library();
    const shader = gl('glCreateShader', GL.FRAGMENT_SHADER);
    const parts = [string('void main() '),
        put(new TextEncoder().encode('{ gl_FragColor = vec4(1.0); } trailing junk')),
        string('// end\n')];
    const lengths = put([-1, 29, -1]);
    gl('glShaderSource', shader, 3, put(parts), lengths);
    gl('glCompileShader', shader);
    const status = put([7]);
    gl('glGetShaderiv', shader, GL.COMPILE_STATUS, status);
    assert.equal(word(status), 1);
    const source = put(new Array(32).fill(0));
    const length = put([0]);
    gl('glGetShaderSource', shader, 128, length, source);
    assert.equal(read(source, word(length)), 'void main() { gl_FragColor = vec4(1.0); }// end\n');
});

test('an info log is copied out to the size the caller gave, terminated, its length beside'
    + ' it', ()=>{
    const { gl, put, string, read, word, bytes } = library();
    const shader = gl('glCreateShader', GL.VERTEX_SHADER);
    gl('glShaderSource', shader, 1, put([string('void main() { nothing; }')]), 0);
    gl('glCompileShader', shader);
    const out = put(new Array(16).fill(0x41414141));
    const length = put([99]);
    gl('glGetShaderInfoLog', shader, 10, length, out);
    assert.equal(word(length), 9);
    assert.equal(read(out, 9), 'ERROR: 0:');
    assert.equal(bytes[out + 9], 0, 'terminated within the size');
    assert.equal(bytes[out + 10], 0x41, 'and nothing past it');
    gl('glGetShaderInfoLog', shader, 0, length, out);
    assert.equal(word(length), 0, 'a size of zero copies nothing');
});

test('a uniform\'s name, size and type; a location of a name not there is -1', ()=>{
    const { gl, put, string, read, word } = library();
    const shader = gl('glCreateShader', GL.FRAGMENT_SHADER);
    gl('glShaderSource', shader, 1, put([string('uniform vec3 tints[4];\n'
        + 'void main() { gl_FragColor = vec4(tints[3], 1.0); }')]), 0);
    gl('glCompileShader', shader);
    const program = gl('glCreateProgram');
    gl('glAttachShader', program, shader);
    gl('glLinkProgram', program);
    const [length, size, type, name] = [put([0]), put([0]), put([0]), put(new Array(8).fill(0))];
    gl('glGetActiveUniform', program, 0, 32, length, size, type, name);
    assert.deepEqual([read(name, word(length)), word(size), word(type)],
        ['tints[0]', 4, GL.FLOAT_VEC3]);
    assert.equal(gl('glGetUniformLocation', program, string('tints[2]')), 2);
    assert.equal(gl('glGetUniformLocation', program, string('absent')), -1);
});

test('a uniform\'s floats arrive as the words a 32-bit caller pushes', ()=>{
    const { gl, put, string, bytes } = library();
    const shader = gl('glCreateShader', GL.FRAGMENT_SHADER);
    gl('glShaderSource', shader, 1, put([string('uniform vec2 at;\n'
        + 'void main() { gl_FragColor = vec4(at, 0.0, 1.0); }')]), 0);
    gl('glCompileShader', shader);
    const program = gl('glCreateProgram');
    gl('glAttachShader', program, shader);
    gl('glLinkProgram', program);
    gl('glUseProgram', program);
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat32(0, 0.25, true);
    bits.setFloat32(4, -8, true);
    gl('glUniform2f', 0, bits.getUint32(0, true), bits.getUint32(4, true));
    const out = put([0, 0]);
    gl('glGetUniformfv', program, 0, out);
    const view = new DataView(bytes.buffer);
    assert.deepEqual([view.getFloat32(out, true), view.getFloat32(out + 4, true)], [0.25, -8]);
});

test('in a 64-bit process the strings\' pointers are eight bytes apart', ()=>{
    const { gl, put, string, read, word } = library(8);
    const shader = gl('glCreateShader', GL.FRAGMENT_SHADER);
    const first = string('void main() { gl_FragColor = ');
    const second = string('vec4(0.5); }');
    gl('glShaderSource', shader, 2, put([first, 0, second, 0]), 0);
    gl('glCompileShader', shader);
    const status = put([7]);
    gl('glGetShaderiv', shader, GL.COMPILE_STATUS, status);
    assert.equal(word(status), 1);
    const source = put(new Array(16).fill(0));
    const length = put([0]);
    gl('glGetShaderSource', shader, 64, length, source);
    assert.equal(read(source, word(length)), 'void main() { gl_FragColor = vec4(0.5); }');
});
