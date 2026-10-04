/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The OpenGL calls a program makes most go into its context's command ring
 * and reach the context in order, before anything that reads it: the program
 * loops setting a colour, a capability, a program parameter and a matrix
 * through the ring's routines, and reads the colour back through the host on
 * every iteration, counting the readings that are not the colour it just
 * set. At the end it gives a buffer object data through the ring -- a count
 * of bytes that is not whole dwords, data over it, a store with none -- and
 * reads back the rest and the error flag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import {
    bytesOfHex, call, dumpAndExit, floatBits, importsWith, setupCode, setupData, storeEax, u32,
} from '../../../tools/gl-program.mjs';

const GL_BLEND = 0x0be2;
const GL_CURRENT_COLOR = 0x0b00;
const GL_MODELVIEW_MATRIX = 0x0ba6;
const GL_VERTEX_PROGRAM_ARB = 0x8620;

const ITERATIONS = 3000;
const COLOURS = [[0.25, 0.5, 0.75, 1], [1, 0.125, 0, 0.5]];
const PARAMETER = [1.5, -2, 3.25, 4];
const MATRIX = Array.from({ length: 16 }, (unused, i)=>i + 0.5);

const GL_ARRAY_BUFFER = 0x8892;
const GL_STATIC_DRAW = 0x88e4;
const GL_BUFFER_SIZE = 0x8764;

/** Where each answer is in the dumped blob. */
const OUT = { mismatches: 0, error: 4, blend: 8, colour: 16, parameter: 32, matrix: 48, read: 112,
    name: 128, buffer: 132, bufferSize: 144, SIZE: 160 };

/** `push imm32` @param {number} value */
const pushOf = value=>[0x68, ...u32(value)];

function program(){
    return buildExe({
        imports: importsWith({
            'OPENGL32.dll': ['glColor4fv', 'glEnable', 'glDisable', 'glProgramEnvParameter4fvARB',
                'glLoadMatrixf', 'glGetFloatv', 'glGetError', 'glIsEnabled',
                'glGetProgramEnvParameterfvARB', 'glGenBuffersARB', 'glBindBufferARB',
                'glBufferDataARB', 'glBufferSubDataARB', 'glGetBufferSubDataARB',
                'glGetBufferParameterivARB'],
        }),
        codeSize: 0x800,
        data: {
            ...setupData(),
            out: new Array(OUT.SIZE).fill(0),
            hex: new Array(OUT.SIZE * 2).fill(0),
            colours: COLOURS.flat().flatMap(value=>u32(floatBits(value))),
            parameter: PARAMETER.flatMap(value=>u32(floatBits(value))),
            matrix: MATRIX.flatMap(value=>u32(floatBits(value))),
            bytes: Array.from({ length: 16 }, (unused, i)=>i + 1),
        },
        code: ({ iat, at })=>{
            const out = (/** @type {number} */ offset)=>at('out') + offset;
            // EDI counts down; bit 0 picks the colour and whether BLEND is on.
            const iteration = [
                0x89, 0xf8, 0x83, 0xe0, 0x01, 0xc1, 0xe0, 0x04,      // mov eax, edi; and 1; shl 4
                // add eax, colours; mov esi, eax; push eax
                0x05, ...u32(at('colours')), 0x89, 0xc6, 0x50,
                0xff, 0x15, ...u32(iat('glColor4fv')),
                0xf7, 0xc7, 0x01, 0x00, 0x00, 0x00,                    // test edi, 1
                0x74, 0x0d,                                            // jz +13
                ...call(iat, 'glEnable', [GL_BLEND]),                  // 11 bytes
                0xeb, 0x0b,                                            // jmp +11
                ...call(iat, 'glDisable', [GL_BLEND]),
                ...call(iat, 'glProgramEnvParameter4fvARB',
                    [GL_VERTEX_PROGRAM_ARB, 3, at('parameter')]),
                ...call(iat, 'glLoadMatrixf', [at('matrix')]),
                ...call(iat, 'glGetFloatv', [GL_CURRENT_COLOR, out(OUT.read)]),
                0x8b, 0x06,                                            // mov eax, [esi]
                0x3b, 0x05, ...u32(out(OUT.read)),                     // cmp eax, [read]
                0x74, 0x06,                                            // je +6
                0xff, 0x05, ...u32(out(OUT.mismatches)),               // inc dword [mismatches]
                0x4f,                                                  // dec edi
            ];
            return [
                ...setupCode(iat, at),
                0xbf, ...u32(ITERATIONS),                              // mov edi, ITERATIONS
                ...iteration,
                0x0f, 0x85, ...u32(-(iteration.length + 6)),           // jnz loop
                ...call(iat, 'glIsEnabled', [GL_BLEND]),
                ...storeEax(out(OUT.blend)),
                ...call(iat, 'glGetFloatv', [GL_CURRENT_COLOR, out(OUT.colour)]),
                ...call(iat, 'glGetProgramEnvParameterfvARB',
                    [GL_VERTEX_PROGRAM_ARB, 3, out(OUT.parameter)]),
                ...call(iat, 'glGetFloatv', [GL_MODELVIEW_MATRIX, out(OUT.matrix)]),
                // A buffer's data through the ring: ten bytes, five more over
                // them, then a store of six with no data.
                ...call(iat, 'glGenBuffersARB', [1, out(OUT.name)]),
                0xff, 0x35, ...u32(out(OUT.name)), ...pushOf(GL_ARRAY_BUFFER), //  name, target
                0xff, 0x15, ...u32(iat('glBindBufferARB')),
                ...call(iat, 'glBufferDataARB', [GL_ARRAY_BUFFER, 10, at('bytes'), GL_STATIC_DRAW]),
                ...call(iat, 'glBufferSubDataARB', [GL_ARRAY_BUFFER, 3, 5, at('bytes') + 8]),
                ...call(iat, 'glGetBufferSubDataARB', [GL_ARRAY_BUFFER, 0, 10, out(OUT.buffer)]),
                ...call(iat, 'glBufferDataARB', [GL_ARRAY_BUFFER, 6, 0, GL_STATIC_DRAW]),
                ...call(iat, 'glGetBufferParameterivARB',
                    [GL_ARRAY_BUFFER, GL_BUFFER_SIZE, out(OUT.bufferSize)]),
                ...call(iat, 'glGetError'),
                ...storeEax(out(OUT.error)),
                ...dumpAndExit(iat, at, 'out', OUT.SIZE),
            ];
        },
    });
}

test('the calls the ring carries reach the context in order, before anything reads it',
    { timeout: 120000 }, async()=>{
        const app = await createApp({
            executable: program(),
            graphics: /** @type {any} */ ({ raster: false }),
        });
        /** @type {string[]} */
        const output = [];
        app.on('output', (/** @type {any} */ payload)=>output.push(payload.text));
        try
        {
            assert.equal(await app.run({ timeoutMs: 100000 }), 0, 'the program exits 0');
            const out = bytesOfHex(output.join(''));
            const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
            /** @param {number} at @param {number} count */
            const floats = (at, count)=>Array.from({ length: count },
                (unused, i)=>view.getFloat32(at + i * 4, true));
            assert.equal(view.getUint32(OUT.mismatches, true), 0,
                'every colour read back was the one set just before');
            assert.equal(view.getUint32(OUT.error, true), 0, 'no error raised');
            // The last iteration has EDI 1: the second colour, BLEND on.
            assert.equal(view.getUint32(OUT.blend, true), 1);
            assert.deepEqual(floats(OUT.colour, 4), COLOURS[1]);
            assert.deepEqual(floats(OUT.parameter, 4), PARAMETER);
            assert.deepEqual(floats(OUT.matrix, 16), MATRIX);
            assert.deepEqual([...out.subarray(OUT.buffer, OUT.buffer + 10)],
                [1, 2, 3, 9, 10, 11, 12, 13, 9, 10], 'the data and the data over it');
            assert.equal(view.getUint32(OUT.bufferSize, true), 6, 'a store with no data');
            const graphics = app.diagnostics().find((/** @type {any} */ layer)=>
                layer.name === 'graphics');
            const carried = graphics?.metrics?.seam?.openglCommandCalls ?? 0;
            assert.ok(carried >= ITERATIONS * 4 * 0.9,
                `${carried} calls carried by the ring, of ${ITERATIONS * 4}`);
            const bridge = app.diagnostics().find((/** @type {any} */ layer)=>
                layer.name === 'bridge');
            /** @type {string[]} */
            const byFunction = bridge?.metrics?.byFunction ?? [];
            assert.deepEqual(byFunction.filter(line=>/glBuffer(Sub)?DataARB /.test(line)), [],
                'the buffer\'s data went through the ring');
        }
        finally
        {
            await app.dispose();
        }
    });
