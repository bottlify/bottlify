/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU32 through the import, as a program calls it, with a context current:
 * gluPerspective, gluLookAt, gluOrtho2D and gluPickMatrix each over the
 * identity, read back with glGetDoublev; gluProject, gluUnProject and
 * gluUnProject4 of a point; gluCheckExtension, gluErrorString and a quadric
 * drawn. The matrices are held to the
 * arithmetic's source (the program runs under the control word a process
 * starts with, where the x87 computes in doubles as JavaScript does), and
 * none of the arithmetic's exports crosses into the host: only the GL calls
 * GLU makes do, and the quadric's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import {
    bytesOfHex, call, doubleWords, dumpAndExit, importsWith, setupCode, setupData, storeEax,
} from '../../../tools/gl-program.mjs';
import { guestMemory } from './layers/win32/msvcrt/guest-code.js';
import * as glu from './layers/graphics/glu/inguest.js';

const GL_MODELVIEW = 0x1700;
const GL_PROJECTION = 0x1701;
const GL_MODELVIEW_MATRIX = 0x0ba6;
const GL_PROJECTION_MATRIX = 0x0ba7;
const GL_INVALID_ENUM = 0x500;

/** @type {[number, number, number, number]} */
const PERSPECTIVE = [60, 4 / 3, 0.5, 250];
/** @type {[number, number, number, number, number, number, number, number, number]} */
const LOOK_AT = [3, -2, 5, 0.5, 1, -1, 0.2, 1, 0.1];
const ORTHO = [-2, 638, 479, -1];
/** @type {[number, number, number, number]} */
const PICK = [100.5, 80.25, 5, 7];
const VIEWPORT = [10, 20, 640, 480];
const POINT = [0.5, -0.75, -4];

/** The blob every answer is dumped from, and where each answer is in it. */
const OUT = { perspective: 0, lookAt: 128, ortho: 256, pick: 384, project: 512, unproject: 536,
    unproject4: 560, results: 592, error: 608, SIZE: 640 };

function program(){
    return buildExe({
        imports: importsWith({
            'OPENGL32.dll': ['glMatrixMode', 'glLoadIdentity', 'glGetDoublev'],
            'GLU32.dll': ['gluPerspective', 'gluLookAt', 'gluOrtho2D', 'gluPickMatrix',
                'gluProject', 'gluUnProject', 'gluUnProject4', 'gluCheckExtension',
                'gluErrorString', 'gluNewQuadric', 'gluSphere', 'gluDeleteQuadric'],
        }),
        codeSize: 0x800,
        data: {
            ...setupData(),
            out: new Array(OUT.SIZE).fill(0),
            hex: new Array(OUT.SIZE * 2).fill(0),
            viewport: VIEWPORT.flatMap(v=>[v & 0xff, v >>> 8 & 0xff, 0, 0]),
            name: [...'GL_EXT_bgra\0'].map(c=>c.charCodeAt(0)),
            string: [...'GL_ARB_multitexture GL_EXT_bgra\0'].map(c=>c.charCodeAt(0)),
        },
        code: ({ iat, at })=>{
            const out = (/** @type {number} */ offset)=>at('out') + offset;
            /** @param {number} mode @param {string} name @param {number[]} words @param {number} query @param {number} to */
            const matrix = (mode, name, words, query, to)=>[
                ...call(iat, 'glMatrixMode', [mode]),
                ...call(iat, 'glLoadIdentity'),
                ...call(iat, name, words),
                ...call(iat, 'glGetDoublev', [query, out(to)]),
            ];
            const copyError = [
                // The string gluErrorString answers, its first 32 bytes.
                0x89, 0xc6, 0xbf, ...u32le(out(OUT.error)), 0xb9, ...u32le(32), 0xf3, 0xa4,
            ];
            return [
                ...setupCode(iat, at),
                ...matrix(GL_PROJECTION, 'gluPerspective', PERSPECTIVE.flatMap(doubleWords),
                    GL_PROJECTION_MATRIX, OUT.perspective),
                ...matrix(GL_MODELVIEW, 'gluLookAt', LOOK_AT.flatMap(doubleWords),
                    GL_MODELVIEW_MATRIX, OUT.lookAt),
                ...matrix(GL_PROJECTION, 'gluOrtho2D', ORTHO.flatMap(doubleWords),
                    GL_PROJECTION_MATRIX, OUT.ortho),
                ...matrix(GL_PROJECTION, 'gluPickMatrix',
                    [...PICK.flatMap(doubleWords), at('viewport')], GL_PROJECTION_MATRIX, OUT.pick),
                ...call(iat, 'gluProject', [...POINT.flatMap(doubleWords), out(OUT.lookAt),
                    out(OUT.perspective), at('viewport'), out(OUT.project), out(OUT.project + 8),
                    out(OUT.project + 16)]),
                ...storeEax(out(OUT.results)),
                ...call(iat, 'gluUnProject', [...[100, 200, 0.25].flatMap(doubleWords),
                    out(OUT.lookAt), out(OUT.perspective), at('viewport'), out(OUT.unproject),
                    out(OUT.unproject + 8), out(OUT.unproject + 16)]),
                ...storeEax(out(OUT.results + 4)),
                ...call(iat, 'gluUnProject4', [...[100, 200, 0.25, 2].flatMap(doubleWords),
                    out(OUT.lookAt), out(OUT.perspective), at('viewport'),
                    ...[0.1, 0.9].flatMap(doubleWords), out(OUT.unproject4),
                    out(OUT.unproject4 + 8), out(OUT.unproject4 + 16), out(OUT.unproject4 + 24)]),
                ...storeEax(out(OUT.results + 8)),
                ...call(iat, 'gluCheckExtension', [at('name'), at('string')]),
                ...storeEax(out(OUT.results + 12)),
                ...call(iat, 'gluNewQuadric'),
                0x50,                                                  // push eax (for delete)
                0x6a, 0x04, 0x6a, 0x06,                                // stacks, slices
                0x68, ...u32le(doubleWords(1)[1]), 0x68, ...u32le(doubleWords(1)[0]), // radius
                0xff, 0x74, 0x24, 0x10,                                // push the quadric
                0xff, 0x15, ...u32le(iat('gluSphere')),
                0xff, 0x15, ...u32le(iat('gluDeleteQuadric')),         // the pushed quadric
                ...call(iat, 'gluErrorString', [GL_INVALID_ENUM]),
                ...copyError,
                ...dumpAndExit(iat, at, 'out', OUT.SIZE),
            ];
        },
    });
}

/** @param {number} value */
function u32le(value){
    return [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
}

async function run(){
    const app = await createApp({
        executable: program(),
        // Drawn on the processor with nothing rasterised: the state is what is read back.
        graphics: /** @type {any} */ ({ raster: false }),
    });
    /** @type {string[]} */
    const output = [];
    app.on('output', (/** @type {any} */ payload)=>output.push(payload.text));
    try
    {
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, 'the program exits 0');
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        return {
            out: bytesOfHex(output.join('')),
            crossed: new Map(/** @type {[string, number][]} */ (bridge?.metrics?.hot ?? [])),
        };
    }
    finally
    {
        await app.dispose();
    }
}

/** What the arithmetic answers, in a memory of its own. */
function expected(){
    const bytes = new Uint8Array(0x10000);
    const guest = guestMemory({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
    });
    const view = new DataView(bytes.buffer);
    /** @param {number} at */
    const doubles = (at, count = 16)=>Array.from({ length: count },
        (_, i)=>view.getFloat64(at + i * 8, true));
    glu.gluPerspectiveMatrix(guest, 0x100, ...PERSPECTIVE);
    glu.gluLookAtMatrix(guest, 0x200, ...LOOK_AT);
    VIEWPORT.forEach((v, i)=>view.setInt32(0x400 + i * 4, v, true));
    glu.gluPickMatrixArgs(guest, 0x500, ...PICK, 0x400);
    const [tx, ty, , sx, sy] = doubles(0x500, 6);
    const [l, r, b, t] = ORTHO;
    return {
        perspective: doubles(0x100),
        // The rotation, then the translation by the negated eye: its last
        // column is the rotation's rows dotted with it.
        lookAt: doubles(0x200),
        eye: doubles(0x280, 3),
        ortho: [2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -1, 0,
            -(r + l) / (r - l), -(t + b) / (t - b), -0, 1],
        pick: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, 1, 0, tx, ty, 0, 1],
    };
}

test(`GLU32 through the import`, { timeout: 120000 }, async()=>{
    const { out, crossed } = await run();
    const view = new DataView(out.buffer);
    /** @param {number} at @param {number} [count] */
    const doubles = (at, count = 16)=>Array.from({ length: count },
        (_, i)=>view.getFloat64(at + i * 8, true));
    const want = expected();
    /** Zeros of either sign alike: the product with the identity keeps no sign of zero. */
    const same = (/** @type {number[]} */ got, /** @type {number[]} */ wanted, /** @type {string} */ what)=>
        assert.deepEqual(got.map(v=>v + 0), wanted.map(v=>v + 0), what);
    same(doubles(OUT.perspective), want.perspective, 'gluPerspective over the identity');
    const look = doubles(OUT.lookAt);
    same(look.slice(0, 12), want.lookAt.slice(0, 12), 'gluLookAt\'s rotation');
    for (let row = 0; row < 3; row++)
    {
        const moved = want.lookAt[row] * want.eye[0] + want.lookAt[4 + row] * want.eye[1]
            + want.lookAt[8 + row] * want.eye[2];
        assert.ok(Math.abs(look[12 + row] - moved) < 1e-12, 'and its translation');
    }
    same(doubles(OUT.ortho), want.ortho, 'gluOrtho2D');
    same(doubles(OUT.pick), want.pick, 'gluPickMatrix');
    const results = [0, 1, 2, 3].map(i=>view.getUint32(OUT.results + i * 4, true));
    assert.deepEqual(results, [1, 1, 1, 1], 'project, unproject, unproject4, the extension');
    const win = doubles(OUT.project, 3);
    assert.ok(win[0] > 10 && win[0] < 650 && win[2] > 0 && win[2] < 1, `${win}`);
    const text = new TextDecoder().decode(out.subarray(OUT.error, OUT.error + 17));
    assert.equal(text, 'invalid enumerant');
    for (const name of ['gluPerspective', 'gluLookAt', 'gluOrtho2D', 'gluPickMatrix',
        'gluProject', 'gluUnProject', 'gluUnProject4', 'gluCheckExtension'])
    {
        assert.equal(crossed.get(`GLU32.dll!${name}`) ?? 0, 0, `${name} stays in the guest`);
    }
    assert.ok((crossed.get('GLU32.dll!gluSphere') ?? 0) > 0, 'the quadric is the host\'s');
});
