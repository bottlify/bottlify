/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL 3.0's mapped buffer ranges and 3.1's buffer copies against the
 * specification (section 2.9.3 and 2.9.5): the errors in the order they are
 * listed, the state a map sets, what an unmap and an explicit flush write
 * back, and the guest memory a map takes and gives back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {{ gl: any, bytes: Uint8Array, held: Set<number> }} */
function fixture(){
    const bytes = new Uint8Array(0x10000);
    let next = 0x8000;
    /** The addresses a map holds. */
    const held = new Set();
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
        allocate: (/** @type {number} */ size)=>{
            const at = next;
            next += (size + 16) & ~15;
            held.add(at);
            return at;
        },
        free: (/** @type {number} */ at)=>{
            assert.ok(held.delete(at), `${at} was not handed out`);
        },
    } });
    gl.attach({ width: 8, height: 8, doubleBuffered: false, depthBits: 24 });
    return { gl, bytes, held };
}

/** @param {any} gl @param {number} size @returns {number} a bound array buffer of 0..size-1 */
function filled(gl, size){
    const [name] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.ARRAY_BUFFER, name);
    gl.glBufferDataARB(GL.ARRAY_BUFFER, size, Uint8Array.from({ length: size }, (_, i)=>i),
        GL.DYNAMIC_DRAW);
    return name;
}

test('glMapBufferRange refuses what section 2.9.3 lists, in its order', ()=>{
    const { gl } = fixture();
    filled(gl, 64);
    const W = GL.MAP_WRITE_BIT;
    const R = GL.MAP_READ_BIT;
    /** @type {[number, number, number, number][]} offset, length, access, error */
    const cases = [
        [-1, 4, W, GL.INVALID_VALUE], [0, -4, W, GL.INVALID_VALUE], [60, 8, W, GL.INVALID_VALUE],
        [0, 4, W | 0x100, GL.INVALID_VALUE],
        [0, 0, W, GL.INVALID_OPERATION], [0, 4, 0, GL.INVALID_OPERATION],
        [0, 4, R | GL.MAP_INVALIDATE_RANGE_BIT, GL.INVALID_OPERATION],
        [0, 4, R | GL.MAP_INVALIDATE_BUFFER_BIT, GL.INVALID_OPERATION],
        [0, 4, R | GL.MAP_UNSYNCHRONIZED_BIT, GL.INVALID_OPERATION],
        [0, 4, R | GL.MAP_FLUSH_EXPLICIT_BIT, GL.INVALID_OPERATION],
    ];
    for (const [offset, length, access, error] of cases)
    {
        assert.equal(gl.glMapBufferRange(GL.ARRAY_BUFFER, offset, length, access), 0);
        assert.equal(gl.glGetError(), error, `${offset} ${length} ${access.toString(16)}`);
    }
    assert.notEqual(gl.glMapBufferRange(GL.ARRAY_BUFFER, 8, 8, W), 0);
    gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 4, W);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'mapped already');
    gl.glBindBufferARB(GL.ARRAY_BUFFER, 0);
    gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 4, W);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no buffer bound');
    gl.glMapBufferRange(0x1234, 0, 4, W);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'no such target');
});

test('a mapped range holds the store\'s bytes there, and the queries say what was mapped', ()=>{
    const { gl, bytes } = fixture();
    filled(gl, 64);
    const access = GL.MAP_READ_BIT | GL.MAP_WRITE_BIT;
    const at = gl.glMapBufferRange(GL.ARRAY_BUFFER, 16, 8, access);
    assert.deepEqual([...bytes.subarray(at, at + 8)], [16, 17, 18, 19, 20, 21, 22, 23]);
    const query = (/** @type {number} */ pname)=>gl.glGetBufferParameterivARB(GL.ARRAY_BUFFER,
        pname)[0];
    assert.equal(query(GL.BUFFER_MAPPED), 1);
    assert.equal(query(GL.BUFFER_ACCESS_FLAGS), access);
    assert.equal(query(GL.BUFFER_ACCESS), GL.READ_WRITE);
    assert.equal(query(GL.BUFFER_MAP_OFFSET), 16);
    assert.equal(query(GL.BUFFER_MAP_LENGTH), 8);
    assert.deepEqual(gl.glGetBufferPointervARB(GL.ARRAY_BUFFER, GL.BUFFER_MAP_POINTER), [at]);
    bytes[at] = 99;
    assert.equal(gl.glUnmapBufferARB(GL.ARRAY_BUFFER), GL.TRUE);
    assert.deepEqual([...gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 15, 3)], [15, 99, 17]);
    assert.equal(query(GL.BUFFER_ACCESS_FLAGS), 0, 'unmapped, nothing is mapped');
    assert.equal(query(GL.BUFFER_MAP_LENGTH), 0);
    assert.equal(query(GL.BUFFER_MAPPED), 0);
});

test('a read-only map writes nothing back, and an explicit flush only what it flushed', ()=>{
    const { gl, bytes } = fixture();
    filled(gl, 32);
    let at = gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 8, GL.MAP_READ_BIT);
    bytes[at] = 77;
    gl.glUnmapBufferARB(GL.ARRAY_BUFFER);
    assert.deepEqual([...gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 0, 1)], [0]);

    at = gl.glMapBufferRange(GL.ARRAY_BUFFER, 8, 8,
        GL.MAP_WRITE_BIT | GL.MAP_FLUSH_EXPLICIT_BIT);
    bytes.fill(50, at, at + 8);
    gl.glFlushMappedBufferRange(GL.ARRAY_BUFFER, 2, 2);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glFlushMappedBufferRange(GL.ARRAY_BUFFER, 6, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the mapped range');
    gl.glUnmapBufferARB(GL.ARRAY_BUFFER);
    assert.deepEqual([...gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 8, 8)],
        [8, 9, 50, 50, 12, 13, 14, 15], 'the flushed two bytes alone');

    gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 4, GL.MAP_WRITE_BIT);
    gl.glFlushMappedBufferRange(GL.ARRAY_BUFFER, 0, 4);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a map not flushed explicitly');
    gl.glUnmapBufferARB(GL.ARRAY_BUFFER);
});

test('an invalidating map does not copy the store out, and every map gives its memory back', ()=>{
    const { gl, bytes, held } = fixture();
    filled(gl, 16);
    const probe = gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 16, GL.MAP_WRITE_BIT);
    gl.glUnmapBufferARB(GL.ARRAY_BUFFER);
    assert.equal(held.size, 0, 'the unmap gave the range back');
    // The fixture hands out memory past the last block: what lies there
    // before the map is what an invalidating map leaves.
    bytes.fill(0xee, probe, probe + 0x400);
    const at = gl.glMapBufferRange(GL.ARRAY_BUFFER, 0, 16,
        GL.MAP_WRITE_BIT | GL.MAP_INVALIDATE_BUFFER_BIT);
    assert.ok(at > probe && at < probe + 0x400 - 16);
    assert.equal(bytes[at + 3], 0xee, 'nothing of the store was copied over it');
    gl.glUnmapBufferARB(GL.ARRAY_BUFFER);
    gl.glMapBufferARB(GL.ARRAY_BUFFER, GL.READ_ONLY);
    assert.equal(gl.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_ACCESS_FLAGS)[0],
        GL.MAP_READ_BIT, 'glMapBuffer\'s access as bits');
    gl.glUnmapBufferARB(GL.ARRAY_BUFFER);
    assert.equal(held.size, 0);
});

test('glCopyBufferSubData copies between its two targets and refuses an overlap', ()=>{
    const { gl } = fixture();
    const source = filled(gl, 16);
    const [target] = gl.glGenBuffersARB(1);
    gl.glBindBufferARB(GL.COPY_READ_BUFFER, source);
    gl.glBindBufferARB(GL.COPY_WRITE_BUFFER, target);
    gl.glBufferDataARB(GL.COPY_WRITE_BUFFER, 8, null, GL.STATIC_DRAW);
    assert.deepEqual(gl.glGetIntegerv(GL.COPY_READ_BUFFER), [source]);
    gl.glCopyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_WRITE_BUFFER, 4, 2, 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual([...gl.glGetBufferSubDataARB(GL.COPY_WRITE_BUFFER, 0, 8)],
        [0, 0, 4, 5, 6, 7, 0, 0]);
    gl.glCopyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_WRITE_BUFFER, 0, 6, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the destination\'s end');
    gl.glCopyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_READ_BUFFER, 0, 2, 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'overlapping in one buffer');
    gl.glCopyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_READ_BUFFER, 0, 8, 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'apart in one buffer');
    gl.glMapBufferRange(GL.COPY_WRITE_BUFFER, 0, 4, GL.MAP_WRITE_BIT);
    gl.glCopyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_WRITE_BUFFER, 0, 0, 4);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a mapped destination');
});

test('a map starts on a 64-byte boundary past its range\'s offset, and gives its block back', ()=>{
    const { gl, bytes, held } = fixture();
    filled(gl, 200);
    // The fixture's blocks are 16 bytes apart in step: most are off a
    // 64-byte boundary, and the map moves itself onto one.
    for (const offset of [0, 3, 66, 130, 17])
    {
        const at = gl.glMapBufferRange(GL.ARRAY_BUFFER, offset, 10, GL.MAP_READ_BIT);
        assert.equal(at % 64, offset % 64, `from ${offset}`);
        assert.equal(bytes[at], offset);
        assert.equal(gl.glUnmapBufferARB(GL.ARRAY_BUFFER), GL.TRUE);
        assert.equal(held.size, 0, 'the block went back, not the map\'s address');
    }
    const whole = gl.glMapBufferARB(GL.ARRAY_BUFFER, GL.READ_ONLY);
    assert.equal(whole % 64, 0);
    assert.equal(bytes[whole + 7], 7);
});
