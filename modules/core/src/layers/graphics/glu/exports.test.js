/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLU32's table: every export at its stack size, the routines placed as code
 * where OPENGL32 is there to call and handed to their handlers where it is
 * not, and the host's half -- quadrics, the tessellator, images and strings --
 * through a context that records what it is told.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLU_ARGUMENT_BYTES, createGlu } from './exports.js';
import { GLU } from './quadric.js';
import { TESS } from './tess.js';
import { nearestPower, resample } from './images.js';
import * as inGuest from './inguest.js';
import { guestMemory } from '../../win32/msvcrt/guest-code.js';
import { doubleWords } from '../../../../scripts/guest-code/equivalence.mjs';
import { GL } from '../opengl/constants.js';

/** A context that records every call made on it, and answers the pixel store. */
function recordingContext(){
    /** @type {[string, ...any[]][]} */
    const calls = [];
    /** @type {Map<number, number>} */
    const store = new Map([[GL.UNPACK_ALIGNMENT, 4], [GL.PACK_ALIGNMENT, 4],
        [GL.MAX_TEXTURE_SIZE, 64]]);
    const context = new Proxy({}, {
        get: (_, name)=>{
            if (name === 'glGetIntegerv')
            {
                return (/** @type {number} */ query)=>[store.get(query) ?? 0];
            }
            if (name === 'glPixelStorei')
            {
                return (/** @type {number} */ query, /** @type {number} */ value)=>{
                    store.set(query, value);
                    calls.push(['glPixelStorei', query, value]);
                };
            }
            return (/** @type {any[]} */ ...args)=>calls.push([String(name), ...args]);
        },
    });
    return { context, calls, store };
}

/** @param {{ exportAddress?: (name: string) => number }} [options] */
function world({ exportAddress = ()=>0 } = {}){
    const ram = new Uint8Array(1 << 20);
    let next = 0x80000;
    /** @type {{ entry: number, args: number[] }[]} */
    const called = [];
    const { context, calls, store } = recordingContext();
    const table = createGlu({
        memory: {
            readMemory: (address, length)=>ram.subarray(address, address + length),
            writeMemory: (address, bytes)=>ram.set(bytes, address),
        },
        exportAddress,
        withContext: body=>body(context),
        allocate: bytes=>{
            const at = next;
            next += (bytes + 15) & ~15;
            return at;
        },
        callGuest: async call=>{
            called.push({ entry: call.entry, args: call.args });
            return 0;
        },
        currentThread: ()=>1,
    });
    const guest = guestMemory({
        readMemory: (address, length)=>ram.subarray(address, address + length),
        writeMemory: (address, bytes)=>ram.set(bytes, address),
    });
    /** @param {string} name @param {number[]} args */
    const call = (name, args = [])=>table[name].handler(args);
    return { ram, table, call, calls, called, guest, store };
}

test('every export is bound at its stack size, and the routines are code only where'
    + ' OPENGL32 is placed', ()=>{
    const { table } = world();
    for (const [name, bytes] of Object.entries(GLU_ARGUMENT_BYTES))
    {
        assert.equal(table[name].argBytes, bytes, name);
        assert.equal(table[name].lastError, false, `${name} leaves the last error alone`);
    }
    /** @type {{ at: number, target: number }[]} */
    const jumps = [];
    const builder = { register: ()=>0x1234, jump: (/** @type {number} */ at,
        /** @type {number} */ target)=>jumps.push({ at, target }) };
    assert.deepEqual([...table.gluPerspective.code(builder)], [0xe9, 0, 0, 0, 0],
        'no OPENGL32: a jump to the handler');
    assert.deepEqual(jumps, [{ at: 1, target: 0x1234 }]);
    const placed = world({ exportAddress: ()=>0x7000 }).table;
    for (const name of ['gluPerspective', 'gluLookAt', 'gluOrtho2D', 'gluPickMatrix'])
    {
        const code = placed[name].code(builder);
        assert.ok(code.length > 16, `${name} is code of its own`);
        assert.ok(code.includes(0x70), `${name} calls into OPENGL32`);
    }
    assert.ok(placed.gluUnProject.code().length > 100);
    assert.ok(placed.gluProject.code().length > 100);
});

test('the handlers multiply the current matrix as the code does', ()=>{
    const { call, calls, guest } = world();
    call('gluPerspective', [60, 4 / 3, 1, 100].flatMap(doubleWords));
    inGuest.gluPerspectiveMatrix(guest, 0x1000, 60, 4 / 3, 1, 100);
    assert.equal(calls[0][0], 'glMultMatrixf');
    assert.deepEqual([...calls[0][1]], [...new Float64Array(guest.f64 ? Array.from({ length: 16 },
        (_, i)=>guest.f64(0x1000 + i * 8)) : [])]);
    assert.ok(Math.abs(calls[0][1][5] - 1 / Math.tan(Math.PI / 6)) < 1e-12, 'f = cot(fovy / 2)');
    assert.equal(calls[0][1][11], -1);
    calls.length = 0;
    call('gluPerspective', [60, 0, 1, 100].flatMap(doubleWords));
    assert.deepEqual(calls, [], 'an aspect of zero leaves the matrix alone');
    call('gluOrtho2D', [0, 640, 480, 0].flatMap(doubleWords));
    assert.deepEqual(calls, [['glOrtho', 0, 640, 480, 0, -1, 1]]);
    calls.length = 0;
    call('gluLookAt', [0, 0, 5, 0, 0, 0, 0, 1, 0].flatMap(doubleWords));
    assert.deepEqual(calls.map(c=>c[0]), ['glMultMatrixf', 'glTranslatef']);
    const rotation = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.ok(rotation.every((v, i)=>calls[0][1][i] === v), 'the identity rotation');
    assert.ok([0, 0, -5].every((v, i)=>calls[1][1 + i] === v), 'the eye negated');
});

test('gluProject and gluUnProject round-trip a point, and gluCheckExtension finds words', ()=>{
    const { ram, call } = world();
    const view = new DataView(ram.buffer);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    identity.forEach((v, i)=>view.setFloat64(0x100 + i * 8, v, true));
    [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -2, 0]
        .forEach((v, i)=>view.setFloat64(0x200 + i * 8, v, true));
    [0, 0, 640, 480].forEach((v, i)=>view.setInt32(0x300 + i * 4, v, true));
    assert.equal(call('gluProject', [...[0.25, -0.5, -3].flatMap(doubleWords), 0x100, 0x200, 0x300,
        0x400, 0x408, 0x410]), 1);
    const win = [0, 1, 2].map(i=>view.getFloat64(0x400 + i * 8, true));
    assert.equal(call('gluUnProject', [...win.flatMap(doubleWords), 0x100, 0x200, 0x300, 0x500,
        0x508, 0x510]), 1);
    const back = [0, 1, 2].map(i=>view.getFloat64(0x500 + i * 8, true));
    back.forEach((v, i)=>assert.ok(Math.abs(v - [0.25, -0.5, -3][i]) < 1e-9, `${v}`));
    ram.set(new TextEncoder().encode('GL_EXT\0'), 0x600);
    ram.set(new TextEncoder().encode('GL_EXT_bgra GL_EXT\0'), 0x700);
    assert.equal(call('gluCheckExtension', [0x600, 0x700]), 1);
    ram.set(new TextEncoder().encode('GL_EX\0'), 0x600);
    assert.equal(call('gluCheckExtension', [0x600, 0x700]), 0);
});

/**
 * The faces a recorded quad strip draws, each as the normal its winding makes
 * and the normal handed with its last vertex.
 *
 * @param {[string, ...any[]][]} calls
 */
function stripFaces(calls){
    /** @type {{ winding: number[], normal: number[] }[]} */
    const faces = [];
    /** @type {{ p: number[], n: number[] }[]} */
    let strip = [];
    let normal = [0, 0, 0];
    for (const [name, ...args] of calls)
    {
        if (name === 'glBegin')
        {
            strip = [];
        }
        else if (name === 'glNormal3f')
        {
            normal = args;
        }
        else if (name === 'glVertex3f')
        {
            strip.push({ p: args, n: normal });
            if (strip.length >= 4 && strip.length % 2 === 0)
            {
                const [a, b, d, c] = strip.slice(-4);
                // A quad strip's quad is a, b, c, d in that order round.
                const u = [c.p[0] - a.p[0], c.p[1] - a.p[1], c.p[2] - a.p[2]];
                const v = [d.p[0] - b.p[0], d.p[1] - b.p[1], d.p[2] - b.p[2]];
                faces.push({ winding: [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2],
                    u[0] * v[1] - u[1] * v[0]], normal: c.n });
            }
        }
    }
    return faces;
}

test('quadrics: the shapes on their surfaces, faces wound outward or inward, errors to the'
    + ' callback', async()=>{
    const { call, calls, called } = world();
    const q = call('gluNewQuadric');
    assert.notEqual(q, 0);
    call('gluSphere', [q, ...doubleWords(2), 8, 6]);
    const vertices = calls.filter(c=>c[0] === 'glVertex3f');
    assert.equal(vertices.length, 6 * 9 * 2);
    for (const [, x, y, z] of vertices)
    {
        assert.ok(Math.abs(Math.hypot(x, y, z) - 2) < 1e-6);
    }
    for (const face of stripFaces(calls))
    {
        const dot = face.winding.reduce((sum, w, i)=>sum + w * face.normal[i], 0);
        assert.ok(dot >= 0, 'a sphere wound outward, as its normals point');
    }
    for (const [orientation, sign] of [[GLU.OUTSIDE, 1], [GLU.INSIDE, -1]])
    {
        calls.length = 0;
        call('gluQuadricOrientation', [q, orientation]);
        call('gluCylinder', [q, ...doubleWords(1), ...doubleWords(0.5), ...doubleWords(3), 12, 2]);
        const faces = stripFaces(calls);
        assert.equal(faces.length, 24);
        for (const face of faces)
        {
            const dot = face.winding.reduce((sum, w, i)=>sum + w * face.normal[i], 0);
            assert.ok(dot > 0, 'the winding faces where the normal points');
            // Outward: away from the axis.
            const radial = face.normal[0] * face.normal[0] + face.normal[1] * face.normal[1];
            assert.ok(radial > 0);
        }
        const first = calls.find(c=>c[0] === 'glNormal3f');
        const vertex = calls.find(c=>c[0] === 'glVertex3f');
        assert.ok(first && vertex);
        assert.equal(Math.sign(first[1] * vertex[1] + first[2] * vertex[2]), sign,
            'normals away from the axis outside, towards it inside');
    }
    call('gluQuadricOrientation', [q, GLU.OUTSIDE]);
    call('gluQuadricTexture', [q, 0x101]);
    calls.length = 0;
    call('gluDisk', [q, ...doubleWords(0), ...doubleWords(2), 4, 1]);
    const coords = calls.filter(c=>c[0] === 'glTexCoord2f').map(c=>[c[1], c[2]]);
    const points = calls.filter(c=>c[0] === 'glVertex3f');
    points.forEach(([, x, y], i)=>{
        assert.ok(Math.abs(coords[i][0] - (0.5 + x / 4)) < 1e-6);
        assert.ok(Math.abs(coords[i][1] - (0.5 + y / 4)) < 1e-6);
    });
    for (const face of stripFaces(calls))
    {
        assert.ok(face.winding[2] >= 0, 'a disk faces +z');
    }
    // The first slice starts at +y and goes towards +x.
    assert.ok(Math.abs(points[0][1]) < 1e-6 && points[0][2] > 1.9);
    assert.ok(points[2][1] > 1.9);

    calls.length = 0;
    call('gluQuadricDrawStyle', [q, GLU.SILHOUETTE]);
    call('gluPartialDisk', [q, ...doubleWords(1), ...doubleWords(2), 4, 3, ...doubleWords(0),
        ...doubleWords(90)]);
    assert.deepEqual(calls.filter(c=>c[0] === 'glBegin').map(c=>c[1]),
        [GL.LINE_STRIP, GL.LINE_STRIP, GL.LINE_STRIP, GL.LINE_STRIP],
        'the two arcs and the two radii of the cut');

    call('gluQuadricCallback', [q, GLU.ERROR, 0x4000]);
    assert.equal(call('gluQuadricDrawStyle', [q, 7]) instanceof Promise, true);
    await call('gluSphere', [q, ...doubleWords(1), 1, 4]);
    await call('gluQuadricNormals', [q, 12345]);
    assert.deepEqual(called, [{ entry: 0x4000, args: [GLU.INVALID_ENUM] },
        { entry: 0x4000, args: [GLU.INVALID_VALUE] }, { entry: 0x4000, args: [GLU.INVALID_ENUM] }]);
    call('gluDeleteQuadric', [q]);
    calls.length = 0;
    call('gluSphere', [q, ...doubleWords(1), 8, 8]);
    assert.deepEqual(calls, [], 'a deleted quadric draws nothing');
});

/**
 * Runs a tessellation through the table, the vertices given as [x, y] at
 * z = 0, each one's data its index; answers the callbacks' calls.
 *
 * @param {number[][][]} contours @param {Record<number, number>} [properties]
 * @param {number[]} [callbacks]
 */
async function tessellate(contours, properties = {}, callbacks = [TESS.BEGIN, TESS.VERTEX,
    TESS.END, TESS.ERROR])
{
    const { call, called, ram } = world();
    const t = call('gluNewTess');
    for (const which of callbacks)
    {
        call('gluTessCallback', [t, which, which]);
    }
    for (const [which, value] of Object.entries(properties))
    {
        call('gluTessProperty', [t, Number(which), ...doubleWords(value)]);
    }
    call('gluTessBeginPolygon', [t, 0x99]);
    const view = new DataView(ram.buffer);
    let index = 0;
    /** @type {number[][]} */
    const at = [];
    for (const contour of contours)
    {
        call('gluTessBeginContour', [t]);
        for (const [x, y] of contour)
        {
            const where = 0x1000 + index * 24;
            view.setFloat64(where, x, true);
            view.setFloat64(where + 8, y, true);
            view.setFloat64(where + 16, 0, true);
            at.push([x, y]);
            call('gluTessVertex', [t, where, index++]);
        }
        call('gluTessEndContour', [t]);
    }
    await call('gluTessEndPolygon', [t]);
    return { called, at };
}

/** The area the triangles cover, and each triangle's winding. @param {{ entry: number, args: number[] }[]} called @param {number[][]} at */
function triangles(called, at){
    const vertices = called.filter(c=>c.entry === TESS.VERTEX).map(c=>at[c.args[0]]);
    let area = 0;
    for (let i = 0; i < vertices.length; i += 3)
    {
        const [a, b, c] = vertices.slice(i, i + 3);
        const twice = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        assert.ok(twice > 0, 'counter-clockwise about +z');
        area += twice / 2;
    }
    return { area, count: vertices.length / 3 };
}

test('the tessellator: a concave polygon, a hole, nested contours under two rules, the'
    + ' boundary, and crossings', async()=>{
    const concave = [[0, 0], [4, 0], [4, 4], [2, 1], [0, 4]];
    const one = await tessellate([concave]);
    assert.deepEqual(one.called[0], { entry: TESS.BEGIN, args: [GL.TRIANGLES] });
    assert.deepEqual(triangles(one.called, one.at), { area: 10, count: 3 });

    const square = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const hole = [[3, 3], [3, 7], [7, 7], [7, 3]];
    const holed = await tessellate([square, hole]);
    assert.equal(triangles(holed.called, holed.at).area, 84);

    // The same orientation twice: a hole under ODD, filled under NONZERO.
    const inner = [[3, 3], [7, 3], [7, 7], [3, 7]];
    assert.equal(triangles((await tessellate([square, inner])).called,
        (await tessellate([square, inner])).at).area, 84);
    const nonzero = await tessellate([square, inner],
        { [TESS.WINDING_RULE]: TESS.WINDING_NONZERO });
    assert.equal(triangles(nonzero.called, nonzero.at).area, 100);
    const two = await tessellate([square, inner],
        { [TESS.WINDING_RULE]: TESS.WINDING_ABS_GEQ_TWO });
    assert.equal(triangles(two.called, two.at).area, 16);

    const boundary = await tessellate([square, hole], { [TESS.BOUNDARY_ONLY]: 1 });
    assert.deepEqual(boundary.called.filter(c=>c.entry === TESS.BEGIN).map(c=>c.args),
        [[GL.LINE_LOOP], [GL.LINE_LOOP]]);

    const flagged = await tessellate([square, hole], {}, [TESS.BEGIN, TESS.VERTEX, TESS.END,
        TESS.EDGE_FLAG]);
    const flags = flagged.called.filter(c=>c.entry === TESS.EDGE_FLAG).map(c=>c.args[0]);
    assert.ok(flags.includes(0) && flags.includes(1), 'drawn edges and diagonals told apart');

    const bow = [[0, 0], [4, 4], [4, 0], [0, 4]];
    const crossed = await tessellate([bow]);
    assert.deepEqual(crossed.called, [{ entry: TESS.ERROR, args: [TESS.NEED_COMBINE_CALLBACK] }]);

    const data = await tessellate([concave], {},
        [TESS.BEGIN_DATA, TESS.VERTEX_DATA, TESS.END_DATA]);
    assert.deepEqual(data.called[0], { entry: TESS.BEGIN_DATA, args: [GL.TRIANGLES, 0x99] });
    assert.deepEqual(data.called.at(-1), { entry: TESS.END_DATA, args: [0x99] });
});

test('the tessellator reports calls out of order and goes on', async()=>{
    const { call, called, ram } = world();
    const t = call('gluNewTess');
    call('gluTessCallback', [t, TESS.ERROR, 0x55]);
    new DataView(ram.buffer).setFloat64(0x1000, 1, true);
    await call('gluTessVertex', [t, 0x1000, 1]);
    assert.deepEqual(called.map(c=>c.args[0]), [TESS.MISSING_BEGIN_POLYGON,
        TESS.MISSING_BEGIN_CONTOUR]);
    await call('gluTessProperty', [t, TESS.WINDING_RULE, ...doubleWords(7)]);
    assert.equal(called.at(-1)?.args[0], GLU.INVALID_VALUE);
    call('gluGetTessProperty', [t, TESS.WINDING_RULE, 0x2000]);
    assert.equal(new DataView(ram.buffer).getFloat64(0x2000, true), TESS.WINDING_ODD);
});

test('images: the nearest power, resampling, gluScaleImage, and the mipmap levels', ()=>{
    assert.deepEqual([1, 2, 3, 5, 6, 7, 12, 100].map(nearestPower), [1, 2, 4, 4, 8, 8, 16, 128]);
    const four = Uint8Array.from([0, 0, 0, 0, 100, 100, 100, 100, 50, 50, 50, 50, 250, 250, 250,
        250]);
    assert.deepEqual([...resample(four, 2, 2, 1, 1)], [100, 100, 100, 100]);
    assert.deepEqual([...resample(four, 2, 2, 2, 2)], [...four]);

    const { call, calls, ram, store } = world();
    // A 3x1 RGB image, unpacked under an alignment of 4, scaled to 6x1 as RGBA.
    ram.set([10, 20, 30, 40, 50, 60, 70, 80, 90], 0x100);
    assert.equal(call('gluScaleImage', [GL.RGB, 3, 1, GL.UNSIGNED_BYTE, 0x100, 6, 1,
        GL.UNSIGNED_BYTE, 0x200]), 0);
    assert.deepEqual([...ram.subarray(0x200, 0x212)], [10, 20, 30, 10, 20, 30, 40, 50, 60, 40, 50,
        60, 70, 80, 90, 70, 80, 90]);
    assert.equal(call('gluScaleImage', [GL.RGB, -1, 1, GL.UNSIGNED_BYTE, 0x100, 6, 1,
        GL.UNSIGNED_BYTE, 0x200]), GLU.INVALID_VALUE);
    assert.equal(call('gluScaleImage', [0x1234, 3, 1, GL.UNSIGNED_BYTE, 0x100, 6, 1,
        GL.UNSIGNED_BYTE, 0x200]), GLU.INVALID_ENUM);

    store.set(GL.UNPACK_ALIGNMENT, 8);
    assert.equal(call('gluBuild2DMipmaps', [GL.TEXTURE_2D, 4, 3, 5, GL.RGBA, GL.UNSIGNED_BYTE,
        0x1000]), 0);
    const uploads = calls.filter(c=>c[0] === 'glTexImage2D');
    assert.deepEqual(uploads.map(c=>[c[2], c[4], c[5]]), [[0, 4, 4], [1, 2, 2], [2, 1, 1]],
        'level, width and height: powers of two down to one texel');
    assert.equal(store.get(GL.UNPACK_ALIGNMENT), 8, 'the program\'s unpack state put back');
    assert.equal(call('gluBuild2DMipmaps', [GL.TEXTURE_2D, 4, 0, 5, GL.RGBA, GL.UNSIGNED_BYTE,
        0x1000]), GLU.INVALID_VALUE);
    calls.length = 0;
    assert.equal(call('gluBuild2DMipmapLevels', [GL.TEXTURE_2D, 4, 4, 4, GL.RGBA,
        GL.UNSIGNED_BYTE, 1, 2, 3, 0x1000]), 0);
    assert.deepEqual(calls.filter(c=>c[0] === 'glTexImage2D').map(c=>[c[2], c[4]]),
        [[2, 2], [3, 1]]);
    assert.equal(call('gluBuild2DMipmapLevels', [GL.TEXTURE_2D, 4, 3, 4, GL.RGBA,
        GL.UNSIGNED_BYTE, 0, 0, 3, 0x1000]), GLU.INVALID_VALUE);
});

test('strings: the errors, the version and the extensions', ()=>{
    const { call, ram } = world();
    /** @param {number} at */
    const read = at=>{
        const end = ram.indexOf(0, at);
        return new TextDecoder().decode(ram.subarray(at, end));
    };
    assert.equal(read(call('gluErrorString', [GL.INVALID_ENUM])), 'invalid enumerant');
    assert.equal(read(call('gluErrorString', [GLU.INVALID_VALUE])), 'invalid value');
    assert.equal(call('gluErrorString', [0x12345]), 0);
    assert.equal(call('gluErrorString', [GL.OUT_OF_MEMORY]),
        call('gluErrorString', [GL.OUT_OF_MEMORY]), 'one string, kept');
    assert.equal(read(call('gluGetString', [GLU.VERSION])), '1.3');
    assert.equal(read(call('gluGetString', [GLU.EXTENSIONS])), 'GL_EXT_bgra');
    const wide = call('gluErrorUnicodeStringEXT', [GL.STACK_OVERFLOW]);
    assert.equal(new TextDecoder('utf-16le').decode(ram.subarray(wide, wide + 28)),
        'stack overflow');
});
