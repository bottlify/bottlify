/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BUFFER, FLAG_SLOW_PATH, SHADOW, createShadow, lockCode, setIndicesCode,
    setRenderStateCode, setStreamSourceCode, setTransformCode, setVertexShaderCode,
    transformSlot, transformType, unlockCode,
} from './shadow.js';

/**
 * A buffer that remembers its locks and refuses a second one, as the device's does.
 *
 * @param {number} base @param {number} length
 */
function fakeBuffer(base, length){
    /** @type {string[]} */
    const calls = [];
    let locked = false;
    return {
        base, length, calls, refCount: 1, name: '', type: 0,
        release: ()=>0,
        /**
         * @param {number} offset @param {number} size
         * @param {{ pBits?: number }} out @param {number} [flags]
         */
        Lock(offset, size, out, flags = 0){
            calls.push(`lock ${offset}+${size} 0x${flags.toString(16)}`);
            if (locked)
            {
                return -1;
            }
            locked = true;
            out.pBits = base + offset;
            return 0;
        },
        Unlock(){
            calls.push('unlock');
            if (!locked)
            {
                return -1;
            }
            locked = false;
            return 0;
        },
    };
}

/** A device that remembers what it was told and refuses one state and one type. */
function fakeDevice(){
    /** @type {Map<number, number>} */
    const states = new Map([[7, 1], [8, 3], [14, 0]]);
    /** @type {Map<number, Float32Array>} */
    const transforms = new Map([[2, Float32Array.from({ length: 16 }, (unused, i)=>i)]]);
    /** @type {Map<number, { buffer: any, stride: number }>} */
    const streams = new Map();
    /** @type {string[]} */
    const calls = [];
    const device = {
        states, transforms, calls, streams,
        indices: /** @type {any} */ (null), baseVertexIndex: 0, shader: 0x102,
        /** @param {number} state @param {number} value */
        SetRenderState(state, value){
            calls.push(`rs ${state}=${value}`);
            if (!states.has(state))
            {
                return -1;
            }
            states.set(state, value);
            return 0;
        },
        /** @param {number} state @param {{ value?: number }} out */
        GetRenderState(state, out){
            if (!states.has(state))
            {
                return -1;
            }
            out.value = states.get(state);
            return 0;
        },
        /** @param {number} type @param {ArrayLike<number>} matrix */
        SetTransform(type, matrix){
            calls.push(`tr ${type}=${Array.from(matrix).slice(0, 2).join(',')}`);
            if (type === 5)
            {
                return -1;
            }
            transforms.set(type, Float32Array.from(matrix));
            return 0;
        },
        /** @param {number} type @param {{ matrix?: ArrayLike<number> }} out */
        GetTransform(type, out){
            out.matrix = transforms.get(type) ?? new Float32Array(16);
            return 0;
        },
        /** @param {number} index @param {any} buffer @param {number} stride */
        SetStreamSource(index, buffer, stride){
            calls.push(`stream ${index}=${buffer ? buffer.name : 'none'}/${stride}`);
            const record = streams.get(index) ?? { buffer: null, stride: 0 };
            record.buffer = buffer;
            if (buffer)
            {
                record.stride = stride;
            }
            streams.set(index, record);
            return 0;
        },
        /** @param {number} index @param {{ buffer?: any, stride?: number }} out */
        GetStreamSource(index, out){
            const record = streams.get(index);
            out.buffer = record?.buffer ?? null;
            out.stride = record?.stride ?? 0;
            return 0;
        },
        /** @param {any} buffer @param {number} base */
        SetIndices(buffer, base){
            calls.push(`indices=${buffer ? buffer.name : 'none'}+${base}`);
            device.indices = buffer;
            device.baseVertexIndex = base;
            return 0;
        },
        /** @param {{ buffer?: any, baseVertexIndex?: number }} out */
        GetIndices(out){
            out.buffer = device.indices;
            out.baseVertexIndex = device.baseVertexIndex;
            return 0;
        },
        /** @param {number} handle */
        SetVertexShader(handle){
            calls.push(`shader=0x${handle.toString(16)}`);
            if (handle === 0xbad0)
            {
                return -1;
            }
            device.shader = handle;
            return 0;
        },
        /** @param {{ handle?: number }} out */
        GetVertexShader(out){
            out.handle = device.shader;
            return 0;
        },
    };
    return device;
}

function machine(){
    const memory = new Uint8Array(0x20000);
    let free = 0x1008;
    const device = fakeDevice();
    /** @type {string[]} */
    const divergences = [];
    /**
     * The objects the guest may name, by the pointer each is published as.
     *
     * @type {Map<number, any>}
     */
    const published = new Map();
    const shadow = createShadow({
        allocate: bytes=>{
            const at = free;
            free += bytes;
            return at;
        },
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        device,
        objectAt: pointer=>published.get(pointer) ?? null,
        pointerOf: buffer=>{
            for (const [pointer, object] of published)
            {
                if (object === buffer)
                {
                    return pointer;
                }
            }
            return 0;
        },
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
    });
    const view = new DataView(memory.buffer);
    return {
        memory, device, shadow, divergences, published,
        /** @param {number} at */
        u32: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        put32: (at, value)=>view.setUint32(at, value >>> 0, true),
        /** @param {number} at @param {number} value */
        putF32: (at, value)=>view.setFloat32(at, value, true),
        /** A counter the guest routine would have raised. @param {number} at */
        bump(at){
            view.setUint32(at, view.getUint32(at, true) + 1, true);
        },
    };
}

test('the transform slots cover the types a device holds and refuse the rest', ()=>{
    assert.equal(transformSlot(2), 2, 'VIEW');
    assert.equal(transformSlot(23), 23, 'TEXTURE7');
    assert.equal(transformSlot(256), 24, 'WORLD');
    assert.equal(transformSlot(259), 27, 'WORLD3');
    assert.equal(transformSlot(24), -1);
    assert.equal(transformSlot(260), -1);
    for (let slot = 0; slot < SHADOW.TRANSFORM_SLOTS; slot++)
    {
        assert.equal(transformSlot(transformType(slot)), slot);
    }
});

test('the block fits its page and its regions follow one another', ()=>{
    assert.ok(SHADOW.SIZE <= 4096);
    assert.equal(SHADOW.RING + SHADOW.RING_CAPACITY * 4, SHADOW.SIZE);
    assert.equal(SHADOW.STREAMS + SHADOW.STREAM_COUNT * 8, SHADOW.INDICES);
    assert.equal(SHADOW.TRANSFORMS + SHADOW.TRANSFORM_SLOTS * 64, SHADOW.BINDING_CALLS);
    assert.equal(BUFFER.SIZE, 32);
});

test('the routines end in a jump to their own trap, and check the flag first', ()=>{
    const rs = setRenderStateCode(0x20000, 0x105000);
    assert.deepEqual([...rs.slice(0, 7)], [0x8b, 0x4c, 0x24, 0x04, 0x8b, 0x49, 0x04],
        'this, then the block one word past it');
    assert.deepEqual([...rs.slice(7, 9)], [0x85, 0xc9], 'a block at all');
    assert.equal(rs[9], 0x74, 'jz to the slow path');
    assert.deepEqual([...rs.slice(11, 17)], [0xf7, 0x01, FLAG_SLOW_PATH, 0, 0, 0], 'the flag');
    assert.equal(rs[17], 0x75, 'jnz to the slow path');
    assert.equal(rs[rs.length - 5], 0xe9);
    const rel = new DataView(rs.buffer).getInt32(rs.length - 4, true);
    assert.equal(0x20000 + rs.length + rel, 0x105000, 'the jump lands on the trap');
    // Every short branch lands inside the routine, at an instruction boundary
    // the assembler laid out: the slow label is the jump at the end.
    const slow = rs.length - 5;
    assert.equal(9 + 2 + rs[10], slow, 'jz reaches the slow path');
    assert.equal(17 + 2 + rs[18], slow, 'jnz reaches the slow path');

    // Each routine pops exactly its arguments, which is the one thing a
    // wrong count does silently: the caller returns into an argument.
    /** @type {Record<string, [Uint8Array, number]>} */
    const rets = {
        transform: [setTransformCode(0x20100, 0x105010), 12],
        lock: [lockCode(0x20200, 0x105020), 20],
        unlock: [unlockCode(0x20300, 0x105030), 4],
        stream: [setStreamSourceCode(0x20400, 0x105040), 16],
        indices: [setIndicesCode(0x20500, 0x105050), 12],
        shader: [setVertexShaderCode(0x20600, 0x105060), 8],
    };
    for (const [name, [code, popped]] of Object.entries(rets))
    {
        assert.equal(code[code.length - 5], 0xe9, `${name} ends in the jump`);
        assert.deepEqual([...code.slice(code.length - 10, code.length - 5)],
            [0x31, 0xc0, 0xc2, popped, 0x00], `${name} answers D3D_OK and pops ${popped}`);
        assert.deepEqual([...code.slice(0, 7)], [...rs.slice(0, 7)], `${name} starts the same`);
    }
    const lock = rets.lock[0];
    assert.equal(lock[lock.length - 11], 0x5b, 'the lock pops what it pushed first');
});

test('the block is made on first use and mirrors what the device holds', ()=>{
    const m = machine();
    assert.equal(m.shadow.diagnostics().placed, 0);
    const vb = fakeBuffer(0x8000, 0x100);
    m.published.set(0x5100, vb);
    m.device.SetStreamSource(0, vb, 24);
    m.device.calls.length = 0;

    const at = m.shadow.address();

    assert.notEqual(at, 0);
    assert.equal(m.shadow.address(), at, 'once');
    assert.equal(at & 0xfff, 0, 'on a page boundary, whatever the heap handed out');
    assert.ok(at + 0x1000 <= 0x1008 + 0x2000, 'the whole page is inside what was taken');
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 8 * 4), 3, 'state 8 as the device holds it');
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 7 * 4), 1);
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 9 * 4), 0, 'a state the device has not got');
    const view = new DataView(m.memory.buffer);
    assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 2 * 64 + 4, true), 1, 'VIEW[1]');
    assert.equal(m.u32(at + SHADOW.STREAMS), 0x5100, 'stream 0 as the pointer the program knows');
    assert.equal(m.u32(at + SHADOW.STREAMS + 4), 24);
    assert.equal(m.u32(at + SHADOW.INDICES), 0);
    assert.equal(m.u32(at + SHADOW.VERTEX_SHADER), 0x102);
    assert.equal(m.u32(at + SHADOW.FLAGS), 0);
    assert.deepEqual(m.device.calls, [], 'mirroring is reading the device, not setting it');
});

test('what the guest wrote is adopted on entry, through the device\'s own setters', ()=>{
    const m = machine();
    const at = m.shadow.address();

    m.put32(at + SHADOW.RENDER_STATES + 8 * 4, 5);
    m.bump(at + SHADOW.RENDER_STATE_CALLS);
    m.putF32(at + SHADOW.TRANSFORMS + 24 * 64, 42);   // WORLD[0]
    m.bump(at + SHADOW.TRANSFORM_CALLS);
    m.shadow.sync();

    assert.deepEqual(m.device.calls, ['rs 8=5', 'tr 256=42,0']);
    assert.equal(m.device.states.get(8), 5);
    assert.equal(m.device.transforms.get(256)?.[0], 42);
    assert.equal(m.shadow.diagnostics().renderStateCalls, 1);
    assert.equal(m.shadow.diagnostics().transformCalls, 1);

    m.shadow.sync();
    assert.equal(m.device.calls.length, 2, 'nothing changed, nothing set again');
});

test('an entry with the counters unchanged does not read the block', ()=>{
    const m = machine();
    const at = m.shadow.address();
    m.shadow.sync();
    assert.equal(m.shadow.diagnostics().skipped, 1, 'the counters said nothing moved');

    // A write without a count is a write not made by the routines, and the
    // routines are the only writer of the block that the fast path knows.
    m.put32(at + SHADOW.RENDER_STATES + 8 * 4, 5);
    m.shadow.sync();
    assert.deepEqual(m.device.calls, [], 'not adopted until a routine counts');
    m.bump(at + SHADOW.RENDER_STATE_CALLS);
    m.shadow.sync();
    assert.deepEqual(m.device.calls, ['rs 8=5']);
    assert.equal(m.shadow.diagnostics().synced, 1);
    assert.equal(m.shadow.diagnostics().skipped, 2);
});

test('a value the device refuses is reported once and not set again', ()=>{
    const m = machine();
    const at = m.shadow.address();

    m.put32(at + SHADOW.RENDER_STATES + 9 * 4, 1);    // state 9: not the device's
    m.putF32(at + SHADOW.TRANSFORMS + 5 * 64, 1);     // type 5: refused
    m.bump(at + SHADOW.RENDER_STATE_CALLS);
    m.shadow.sync();
    m.bump(at + SHADOW.RENDER_STATE_CALLS);
    m.shadow.sync();

    assert.equal(m.device.calls.length, 2, 'each tried once');
    assert.equal(m.divergences.length, 2);
    assert.match(m.divergences[0], /SetRenderState.*state 9 set to 1/);
    assert.match(m.divergences[1], /SetTransform.*type 5/);
    assert.equal(m.shadow.diagnostics().refused, 2);
});

test('the slow-path flag is the host\'s, and a re-mirror brings the block to the device', ()=>{
    const m = machine();
    const at = m.shadow.address();

    m.shadow.slowPath(true);
    assert.equal(m.u32(at + SHADOW.FLAGS), FLAG_SLOW_PATH);
    assert.equal(m.shadow.diagnostics().slowPath, 1);
    m.shadow.slowPath(false);
    assert.equal(m.u32(at + SHADOW.FLAGS), 0);

    // The host changed state on its own: a state block applied, a reset.
    m.device.states.set(8, 77);
    m.device.transforms.set(3, Float32Array.from({ length: 16 }, ()=>9));
    m.device.shader = 0x104;
    m.shadow.remirror();

    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 8 * 4), 77);
    const view = new DataView(m.memory.buffer);
    assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 3 * 64, true), 9);
    assert.equal(m.u32(at + SHADOW.VERTEX_SHADER), 0x104);
    m.bump(at + SHADOW.RENDER_STATE_CALLS);
    m.shadow.sync();
    assert.deepEqual(m.device.calls, [], 'and the block agrees with the device again');
});

test('bindings the guest wrote reach the device as the objects the pointers name', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const vb = fakeBuffer(0x8000, 0x100);
    vb.name = 'vb';
    const ib = fakeBuffer(0x9000, 0x100);
    ib.name = 'ib';
    m.published.set(0x5100, vb);
    m.published.set(0x5200, ib);

    m.put32(at + SHADOW.STREAMS, 0x5100);
    m.put32(at + SHADOW.STREAMS + 4, 32);
    m.put32(at + SHADOW.INDICES, 0x5200);
    m.put32(at + SHADOW.BASE_VERTEX, 7);
    m.put32(at + SHADOW.VERTEX_SHADER, 0x112);
    m.bump(at + SHADOW.BINDING_CALLS);
    m.shadow.sync();

    assert.deepEqual(m.device.calls, ['stream 0=vb/32', 'indices=ib+7', 'shader=0x112']);
    assert.equal(m.shadow.diagnostics().bindingCalls, 1);

    // Unbinding keeps the stride, as the device's own setter does; a pointer
    // that names nothing is a divergence, reported once, and the device is
    // left with what it had.
    m.put32(at + SHADOW.STREAMS, 0);
    m.put32(at + SHADOW.INDICES, 0x5300);
    m.put32(at + SHADOW.VERTEX_SHADER, 0xbad0);
    m.bump(at + SHADOW.BINDING_CALLS);
    m.shadow.sync();
    m.bump(at + SHADOW.BINDING_CALLS);
    m.shadow.sync();

    assert.deepEqual(m.device.calls.slice(3), ['stream 0=none/32', 'shader=0xbad0']);
    assert.equal(m.device.indices, ib);
    assert.equal(m.divergences.length, 2);
    assert.match(m.divergences[0], /SetIndices.*0x5300.*not an interface/);
    assert.match(m.divergences[1], /SetVertexShader.*0xbad0/);
});

test('a buffer gets a block on its own page, naming its bytes and its device', ()=>{
    const m = machine();
    const vb = fakeBuffer(0x8000, 0x100);
    const ib = fakeBuffer(0x9000, 0x40);

    const block = m.shadow.attachBuffer(vb);
    assert.notEqual(block, 0);
    assert.equal(m.shadow.attachBuffer(vb), block, 'once');
    assert.equal(block & 0xfff, 0, 'the first of its page');
    assert.notEqual(block >>> 12, m.shadow.address() >>> 12, 'not the device\'s page');
    assert.equal(m.u32(block + BUFFER.BASE), 0x8000);
    assert.equal(m.u32(block + BUFFER.LENGTH), 0x100);
    assert.equal(m.u32(block + BUFFER.LOCKED), 0);
    assert.equal(m.u32(block + BUFFER.DEVICE), m.shadow.address());
    assert.equal(m.shadow.attachBuffer(ib), block + BUFFER.SIZE, 'the next carved from the page');
    assert.equal(m.shadow.diagnostics().buffers, 2);
});

test('a lock and unlock taken in the guest are replayed before the host goes on', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const vb = fakeBuffer(0x8000, 0x100);
    const block = m.shadow.attachBuffer(vb);

    // What the guest routines leave behind: a range, its flags, and the
    // block on the ring once the lock is released.
    m.put32(block + BUFFER.FROM, 16);
    m.put32(block + BUFFER.TO, 48);
    m.put32(block + BUFFER.LOCK_FLAGS, 0x2000);
    m.bump(at + SHADOW.LOCK_CALLS);
    m.put32(at + SHADOW.RING, block);
    m.put32(at + SHADOW.RING_HEAD, 1);
    m.bump(at + SHADOW.UNLOCK_CALLS);
    m.shadow.sync();

    assert.deepEqual(vb.calls, ['lock 16+32 0x2000', 'unlock']);
    assert.equal(m.u32(at + SHADOW.RING_HEAD), 0, 'the ring is the host\'s to empty');
    assert.equal(m.u32(block + BUFFER.FROM), 0, 'and the range is spent');
    assert.equal(m.u32(block + BUFFER.TO), 0);
    assert.equal(m.u32(block + BUFFER.LOCK_FLAGS), 0);
    assert.equal(m.shadow.diagnostics().lockCalls, 1);
    assert.equal(m.shadow.diagnostics().unlockCalls, 1);

    // The same block twice on the ring, from two lock-unlock pairs between
    // entries: one replay of the union, and the second entry finds nothing.
    m.put32(block + BUFFER.FROM, 0);
    m.put32(block + BUFFER.TO, 0x100);
    m.put32(at + SHADOW.RING, block);
    m.put32(at + SHADOW.RING + 4, block);
    m.put32(at + SHADOW.RING_HEAD, 2);
    m.bump(at + SHADOW.UNLOCK_CALLS);
    m.shadow.sync();
    assert.deepEqual(vb.calls.slice(2), ['lock 0+256 0x0', 'unlock']);
});

test('a lock the guest holds across an entry is held by the host until the guest lets go', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const vb = fakeBuffer(0x8000, 0x100);
    const block = m.shadow.attachBuffer(vb);

    // Locked in the guest, then a crossing: the host locks too, and a lock
    // through the host's own path is refused as the real interface would.
    m.put32(block + BUFFER.LOCKED, 1);
    m.put32(block + BUFFER.FROM, 0);
    m.put32(block + BUFFER.TO, 64);
    m.bump(at + SHADOW.LOCK_CALLS);
    m.shadow.settleBuffer(vb);
    assert.deepEqual(vb.calls, ['lock 0+64 0x0']);
    assert.equal(vb.Lock(0, 0, {}), -1, 'the real buffer is locked');
    vb.calls.length = 0;

    // Unlocked in the guest, re-locked, unlocked again, all before the next
    // entry: the held lock ends, the new range is replayed, and nothing is
    // held after.
    m.put32(block + BUFFER.LOCKED, 0);
    m.put32(block + BUFFER.FROM, 64);
    m.put32(block + BUFFER.TO, 128);
    m.put32(at + SHADOW.RING, block);
    m.put32(at + SHADOW.RING_HEAD, 1);
    m.bump(at + SHADOW.UNLOCK_CALLS);
    m.shadow.sync();
    assert.deepEqual(vb.calls, ['unlock', 'lock 64+64 0x0', 'unlock']);
    assert.equal(vb.Lock(0, 0, {}), 0, 'free again');
    vb.Unlock();
});

test('a lock the host took itself is one the guest routine sees', ()=>{
    const m = machine();
    const vb = fakeBuffer(0x8000, 0x100);
    const block = m.shadow.attachBuffer(vb);

    m.shadow.noteLocked(vb, true);
    assert.equal(m.u32(block + BUFFER.LOCKED), 1, 'the guest routine will refuse a second lock');
    m.shadow.noteLocked(vb, false);
    assert.equal(m.u32(block + BUFFER.LOCKED), 0);

    // A buffer the program released with an unlock still on the ring is
    // left alone: its storage is gone.
    const at = m.shadow.address();
    vb.refCount = 0;
    m.put32(block + BUFFER.FROM, 0);
    m.put32(block + BUFFER.TO, 16);
    m.put32(at + SHADOW.RING, block);
    m.put32(at + SHADOW.RING_HEAD, 1);
    m.bump(at + SHADOW.UNLOCK_CALLS);
    m.shadow.sync();
    assert.deepEqual(vb.calls, []);
    assert.equal(m.shadow.diagnostics().buffers, 0);
});

test('a sync before the block exists is nothing', ()=>{
    const m = machine();
    m.shadow.sync();
    m.shadow.remirror();
    m.shadow.slowPath(true);
    m.shadow.settleBuffer(fakeBuffer(0, 16));
    m.shadow.noteLocked(fakeBuffer(0, 16), true);
    assert.deepEqual(m.device.calls, []);
    assert.equal(m.shadow.diagnostics().placed, 0);
});
