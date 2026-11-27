/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Buffer storage (OpenGL 4.4 section 6.2, GL_ARB_buffer_storage): stores
 * that are never redefined, their flags, and persistent maps the program
 * writes while GL draws from them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {{ gl: any, bytes: Uint8Array, view: DataView, freed: number[] }} */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    /** @type {number[]} */
    const freed = [];
    let next = 0x8000;
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 16) & ~15;
            return at;
        },
        free: (/** @type {number} */ at)=>freed.push(at),
    }, keepPrimitives: true });
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    return { gl, bytes, view: new DataView(bytes.buffer), freed };
}

/** @param {any} gl @returns {number} a bound array buffer's name */
function bound(gl){
    const [name] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, name);
    return name;
}

test('an immutable store keeps its size and flags, and refuses what its flags do not give', ()=>{
    const { gl } = fixture();
    bound(gl);
    gl.glBufferStorage(GL.ARRAY_BUFFER, 16, Uint8Array.of(1, 2, 3), GL.MAP_READ_BIT);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_IMMUTABLE_STORAGE),
        [1]);
    assert.deepEqual(gl.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_STORAGE_FLAGS),
        [GL.MAP_READ_BIT]);
    assert.deepEqual([...gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 0, 4)], [1, 2, 3, 0]);

    gl.glBufferDataARB(GL.ARRAY_BUFFER, 8, null, GL.STATIC_DRAW);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'never redefined');
    gl.glBufferStorage(GL.ARRAY_BUFFER, 8, null, 0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not even by itself');
    gl.glBufferSubDataARB(GL.ARRAY_BUFFER, 0, 1, Uint8Array.of(9));
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no DYNAMIC_STORAGE_BIT');
    gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 4, GL.MAP_WRITE_BIT);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not mapped for writing');
    gl.glMapBufferARB(GL.ARRAY_BUFFER, GL.READ_WRITE);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'nor by the old call');
    gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 4, GL.MAP_READ_BIT);
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    bound(gl);
    for (const flags of [0x400, GL.MAP_PERSISTENT_BIT,
        GL.MAP_COHERENT_BIT | GL.MAP_WRITE_BIT])
    {
        gl.glBufferStorage(GL.ARRAY_BUFFER, 4, null, flags);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE, `flags 0x${flags.toString(16)}`);
    }
    gl.glBufferStorage(GL.ARRAY_BUFFER, 0, null, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an empty store');

    bound(gl);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, 8, null, GL.STATIC_DRAW);
    assert.deepEqual(gl.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_STORAGE_FLAGS),
        [GL.MAP_READ_BIT | GL.MAP_WRITE_BIT | GL.DYNAMIC_STORAGE_BIT], 'a mutable one\'s');
    gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 4, GL.MAP_WRITE_BIT | GL.MAP_PERSISTENT_BIT);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a mutable store is never persistent');
});

test('a persistent map is drawn from while the program writes it, and sees what GL writes',
    ()=>{
        const { gl, bytes, view } = fixture();
        bound(gl);
        const flags = GL.MAP_READ_BIT | GL.MAP_WRITE_BIT | GL.MAP_PERSISTENT_BIT
            | GL.MAP_COHERENT_BIT | GL.DYNAMIC_STORAGE_BIT;
        gl.glBufferStorage(GL.ARRAY_BUFFER, 24, null, flags);
        const map = gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 24, flags & ~GL.DYNAMIC_STORAGE_BIT);
        assert.notEqual(map, 0);
        gl.glVertexPointer(2, GL.FLOAT, 0, 0);
        gl.glEnableClientState(GL.VERTEX_ARRAY);
        /** @param {number[]} values */
        const write = values=>values.forEach((v, i)=>view.setFloat32(map + i * 4, v, true));
        write([0, 0, 1, 0, 0, 1]);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        assert.equal(gl.glGetError(), GL.NO_ERROR, 'drawing from a mapped store');
        write([5, 0, 1, 0, 0, 1]);
        gl.glDrawArrays(GL.TRIANGLES, 0, 3);
        assert.deepEqual(gl.submittedPrimitives.map((/** @type {any} */ p)=>
            p.vertices[0].position[0]), [0, 5], 'each draw reads what the map holds then');

        gl.glBufferSubDataARB(GL.ARRAY_BUFFER, 0, 4, new Uint8Array(new Float32Array([7]).buffer));
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        assert.equal(view.getFloat32(map, true), 7, 'GL\'s writes reach the map');
        assert.equal(bytes[map + 4], 0, 'and nothing past them');
        assert.deepEqual([...gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 0, 4)],
            [...new Uint8Array(new Float32Array([7]).buffer)]);
        assert.equal(gl.glUnmapBufferARB(GL.ARRAY_BUFFER), GL.TRUE);

        // A map that is not persistent still keeps GL from the store.
        gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 4, GL.MAP_WRITE_BIT);
        gl.glBufferSubDataARB(GL.ARRAY_BUFFER, 0, 4, new Uint8Array(4));
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    });

test('deleting a mapped buffer ends its map', ()=>{
    const { gl, freed } = fixture();
    const name = bound(gl);
    gl.glBufferStorage(GL.ARRAY_BUFFER, 8, null, GL.MAP_WRITE_BIT | GL.MAP_PERSISTENT_BIT);
    gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 8, GL.MAP_WRITE_BIT | GL.MAP_PERSISTENT_BIT);
    gl.glDeleteBuffersARB([name]);
    assert.equal(freed.length, 1, 'its memory given back');
    gl.glDrawArrays(GL.POINTS, 0, 0);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});
