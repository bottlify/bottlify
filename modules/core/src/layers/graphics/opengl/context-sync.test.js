/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { SYNC, TIMEOUT_IGNORED } from './context-sync.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @param {boolean} device @returns {{ gl: any, renderer: any }} */
function fixture(device){
    const gpu = createFakeDevice();
    const renderer = device ? createGpuRenderer({
        backend: createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} }),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
    }) : null;
    const gl = /** @type {any} */ (createGlContext(renderer ? { gpu: renderer } : {}));
    gl.attach({ width: 8, height: 4, doubleBuffered: true, depthBits: 24 });
    return { gl, renderer };
}

test('a fence\'s errors, names and queries, as section 5.2 lists them', ()=>{
    const { gl } = fixture(false);
    assert.equal(gl.glFenceSync(0x1234, 0), 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.equal(gl.glFenceSync(SYNC.SYNC_GPU_COMMANDS_COMPLETE, 1), 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    const sync = gl.glFenceSync(SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0);
    assert.notEqual(sync, 0);
    assert.equal(gl.glIsSync(sync), GL.TRUE);
    assert.deepEqual([SYNC.OBJECT_TYPE, SYNC.SYNC_CONDITION, SYNC.SYNC_FLAGS, SYNC.SYNC_STATUS]
        .map(pname=>gl.glGetSynciv(sync, pname)[0]),
    [SYNC.SYNC_FENCE, SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0, SYNC.SIGNALED],
    'without a device everything has run when the call returns');
    assert.equal(gl.glClientWaitSync(sync, 0, 0), SYNC.ALREADY_SIGNALED);
    assert.equal(gl.glGetSynciv(sync, GL.DEPTH_FUNC), null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.equal(gl.glClientWaitSync(sync, 2, 0), SYNC.WAIT_FAILED);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a flag not the flush bit');
    gl.glWaitSync(sync, 0, 5);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a timeout not GL_TIMEOUT_IGNORED');
    gl.glWaitSync(sync, 1, TIMEOUT_IGNORED);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a flag');
    gl.glWaitSync(sync, 0, TIMEOUT_IGNORED);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glDeleteSync(0);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'zero is silently ignored');
    gl.glDeleteSync(sync);
    assert.equal(gl.glIsSync(sync), GL.FALSE);
    gl.glDeleteSync(sync);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no longer a sync');
    assert.equal(gl.glClientWaitSync(sync, 0, 0), SYNC.WAIT_FAILED);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    assert.deepEqual(gl.glGetInteger64v(SYNC.MAX_SERVER_WAIT_TIMEOUT), [0]);
});

test('a fence is its share group\'s object: the group has held one, the sharing see it '
    + '(Wine\'s opengl32 test_sharelists, "sync")', ()=>{
    const first = fixture(false).gl;
    const second = fixture(false).gl;
    const third = fixture(false).gl;
    assert.equal(first.shareGroup.used, false);
    const sync = first.glFenceSync(SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0);
    assert.equal(first.shareGroup.used, true, 'a group that held a sync shares no other');
    second.shareLists(first);
    assert.equal(second.glIsSync(sync), GL.TRUE, 'seen where the group is shared');
    assert.equal(third.glIsSync(sync), GL.FALSE, 'and nowhere else');
});

test('on a device a fence is signalled once what was recorded before it has been replayed, '
    + 'a wait flushing it', async()=>{
    const { gl, renderer } = fixture(true);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    const sync = gl.glFenceSync(SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    assert.deepEqual(gl.glGetSynciv(sync, SYNC.SYNC_STATUS), [SYNC.UNSIGNALED]);
    assert.equal(gl.glClientWaitSync(sync, 0, 0), SYNC.TIMEOUT_EXPIRED, 'a wait of zero asks');
    await renderer.settled();
    assert.deepEqual(gl.glGetSynciv(sync, SYNC.SYNC_STATUS), [SYNC.UNSIGNALED],
        'not flushed: its frame is not swapped');
    const waited = gl.glClientWaitSync(sync, 0, 1e9);
    assert.ok(waited instanceof Promise);
    assert.equal(await waited, SYNC.CONDITION_SATISFIED);
    assert.deepEqual(gl.glGetSynciv(sync, SYNC.SYNC_STATUS), [SYNC.SIGNALED]);
    assert.equal(gl.glClientWaitSync(sync, 0, 0), SYNC.ALREADY_SIGNALED);

    // The flush bit with a wait of zero replays them, for a later ask to find done.
    const second = gl.glFenceSync(SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.glClear(GL.COLOR_BUFFER_BIT);
    const third = gl.glFenceSync(SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0);
    assert.equal(gl.glClientWaitSync(second, SYNC.SYNC_FLUSH_COMMANDS_BIT, 0),
        SYNC.TIMEOUT_EXPIRED);
    await renderer.settled();
    assert.equal(gl.glClientWaitSync(second, 0, 0), SYNC.ALREADY_SIGNALED);
    assert.equal(gl.glClientWaitSync(third, 0, 0), SYNC.ALREADY_SIGNALED,
        'the same recording, replayed once');
    // A swap replays a fence's frame as well.
    gl.glClear(GL.COLOR_BUFFER_BIT);
    const fourth = gl.glFenceSync(SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0);
    renderer.present(gl);
    await renderer.settled();
    assert.equal(gl.glClientWaitSync(fourth, 0, 0), SYNC.ALREADY_SIGNALED);
});

test('the sync exports read a 64-bit timeout from its two words and write what glGetSynciv '
    + 'answers within the size given', async()=>{
    const { createOpengl } = await import('./exports.js');
    const bytes = new Uint8Array(0x1000);
    const opengl = createOpengl({
        readMemory: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
        screen: ()=>({ width: 4, height: 4 }),
        scratch: { allocate: ()=>0x800 },
        describeDrawable: (/** @type {number} */ hdc)=>({ key: `dc:${hdc}`, width: 4, height: 4 }),
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        opengl.table);
    table.wglSetPixelFormat.handler([0x900d, 1, 0]);
    table.wglMakeCurrent.handler([0x900d, table.wglCreateContext.handler([0x900d])]);
    const sync = table.glFenceSync.handler([SYNC.SYNC_GPU_COMMANDS_COMPLETE, 0]);
    assert.notEqual(sync, 0);
    assert.equal(await table.glClientWaitSync.handler([sync, 0, 0, 1]), SYNC.ALREADY_SIGNALED);
    table.glWaitSync.handler([sync, 0, 0xffffffff, 0xffffffff]);
    table.glWaitSync.handler([sync, 0, 0xffffffff, 0]);
    const errors = opengl.withContext((/** @type {any} */ context)=>context.glGetError());
    assert.equal(errors, GL.INVALID_VALUE, 'the second is not GL_TIMEOUT_IGNORED');
    const view = new DataView(bytes.buffer);
    view.setUint32(0x100, 0xdead, true);
    table.glGetSynciv.handler([sync, SYNC.SYNC_STATUS, 0, 0x100, 0x104]);
    assert.equal(view.getUint32(0x100, true), 0, 'nothing fits in no room');
    table.glGetSynciv.handler([sync, SYNC.SYNC_STATUS, 4, 0x100, 0x104]);
    assert.deepEqual([view.getUint32(0x100, true), view.getUint32(0x104, true)],
        [1, SYNC.SIGNALED]);
});
