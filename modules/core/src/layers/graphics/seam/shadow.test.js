/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BUFFER, FLAG_SLOW_PATH, SHADOW, STALE_POINTER, TEXTURE, createShadow, getSurfaceLevelCode,
    lockCode, materialFloats, materialOf, setIndicesCode, setMaterialCode, setRenderStateCode,
    setStreamSourceCode, setTextureCode, setTextureStageStateCode, setTransformCode,
    setVertexShaderCode, transformSlot, transformType, unlockCode,
} from './shadow.js';
import { D3DTSS } from '../d3d8/constants.js';

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
    /** @type {Map<number, any>} */
    const textures = new Map();
    /**
     * Three stage states per stage, of the device's own choosing.
     *
     * @type {Map<number, number>[]}
     */
    const stageStates = Array.from({ length: 8 }, (unused, stage)=>new Map([
        [D3DTSS.COLOROP, stage === 0 ? 4 : 1], [D3DTSS.COLORARG1, 2], [D3DTSS.MAGFILTER, 1],
    ]));
    let material = materialOf(Float32Array.from({ length: 17 }, (unused, i)=>i / 16));
    /** @type {string[]} */
    const calls = [];
    const device = {
        states, transforms, calls, streams, textures, stageStates,
        get material(){
            return material;
        },
        /** @param {number} stage @param {any} texture */
        SetTexture(stage, texture){
            calls.push(`tex ${stage}=${texture ? texture.name : 'none'}`);
            if (stage >= 8)
            {
                return -1;
            }
            if (texture)
            {
                textures.set(stage, texture);
            }
            else
            {
                textures.delete(stage);
            }
            return 0;
        },
        /** @param {number} stage @param {number} type @param {number} value */
        SetTextureStageState(stage, type, value){
            calls.push(`tss ${stage}.${type}=${value}`);
            if (stage >= 8 || !stageStates[stage].has(type))
            {
                return -1;
            }
            stageStates[stage].set(type, value);
            return 0;
        },
        /** @param {number} stage @param {number} type @param {{ value?: number }} out */
        GetTextureStageState(stage, type, out){
            if (stage >= 8 || !stageStates[stage].has(type))
            {
                return -1;
            }
            out.value = stageStates[stage].get(type);
            return 0;
        },
        /** @param {import('./shadow.js').ShadowMaterial} value */
        SetMaterial(value){
            calls.push(`mat ${value.Diffuse.r},${value.Power}`);
            material = value;
            return 0;
        },
        /** @param {{ material?: import('./shadow.js').ShadowMaterial }} out */
        GetMaterial(out){
            out.material = material;
            return 0;
        },
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

/** @param {{ readU32?: boolean }} [options] */
function machine(options = {}){
    const memory = new Uint8Array(0x20000);
    /** How often the block was copied out, and which regions of it, by offset. */
    const reads = { memory: 0, regions: /** @type {[number, number][]} */ ([]) };
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
        readMemory: (address, length)=>{
            reads.memory++;
            reads.regions.push([address - shadow.address(), length]);
            return memory.slice(address, address + length);
        },
        readU32: options.readU32 ? address=>view.getUint32(address, true) : undefined,
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
        reads,
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

test('the block fits its two pages and its regions follow one another', ()=>{
    assert.ok(SHADOW.SIZE > 4096, 'the stage states pushed it past one page');
    assert.ok(SHADOW.SIZE <= 2 * 4096);
    assert.equal(SHADOW.RING + SHADOW.RING_CAPACITY * 4, SHADOW.TEXTURE_CALLS);
    assert.equal(SHADOW.STREAMS + SHADOW.STREAM_COUNT * 8, SHADOW.INDICES);
    assert.equal(SHADOW.TRANSFORMS + SHADOW.TRANSFORM_SLOTS * 64, SHADOW.BINDING_CALLS);
    assert.equal(SHADOW.TEXTURES + SHADOW.STAGE_COUNT * 4, SHADOW.MATERIAL);
    assert.equal(SHADOW.MATERIAL + SHADOW.MATERIAL_WORDS * 4, SHADOW.STAGE_STATES);
    assert.equal(SHADOW.STAGE_STATES + SHADOW.STAGE_COUNT * SHADOW.STAGE_STATE_STRIDE * 4,
        SHADOW.SIZE);
    assert.equal(BUFFER.SIZE, 32);
    assert.equal(TEXTURE.LEVELS + TEXTURE.LEVEL_SLOTS * 4, TEXTURE.SIZE);
    // Enough for the longest chain a texture of this era can have: a 32768
    // texel side is sixteen levels, and no device of the era reports one.
    assert.ok(TEXTURE.LEVEL_SLOTS >= 14);
    assert.ok(TEXTURE.SIZE <= 4096, 'a texture block comes out of one page with others');
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
        material: [setMaterialCode(0x20700, 0x105070), 8],
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

    // The level getter refuses a level the texture has not got where the two
    // setters refuse a stage, and reads the count out of the block rather
    // than assuming the table's length is it.
    const level = getSurfaceLevelCode(0x20a00, 0x1050a0);
    assert.deepEqual([...level.slice(0, 7)], [...rs.slice(0, 7)],
        'the level getter starts the same');
    assert.deepEqual([...level.slice(11, 17)], [0xf7, 0x01, FLAG_SLOW_PATH, 0, 0, 0]);
    assert.deepEqual([...level.slice(19, 26)],
        [0x8b, 0x44, 0x24, 0x08, 0x3b, 0x41, TEXTURE.LEVEL_COUNT],
        'the level, against the count in the block');
    assert.deepEqual([...level.slice(level.length - 13, level.length - 5)],
        [0xb8, 0x6c, 0x08, 0x76, 0x88, 0xc2, 12, 0x00],
        'D3DERR_INVALIDCALL for a level the texture has not got');
    assert.deepEqual([...level.slice(level.length - 18, level.length - 13)],
        [0x31, 0xc0, 0xc2, 12, 0x00], 'D3D_OK, popping its three arguments');
    assert.equal(level[level.length - 5], 0xe9);
    assert.equal(0x20a00 + level.length
        + new DataView(level.buffer).getInt32(level.length - 4, true), 0x1050a0,
    'the jump lands on the trap');

    // The two that refuse a stage themselves end in that refusal, after the
    // D3D_OK tail, and pop the same count either way.
    /** @type {Record<string, [Uint8Array, number]>} */
    const staged = {
        texture: [setTextureCode(0x20800, 0x105080), 12],
        stageState: [setTextureStageStateCode(0x20900, 0x105090), 16],
    };
    for (const [name, [code, popped]] of Object.entries(staged))
    {
        assert.equal(code[code.length - 5], 0xe9, `${name} ends in the jump`);
        assert.deepEqual([...code.slice(code.length - 13, code.length - 5)],
            [0xb8, 0x6c, 0x08, 0x76, 0x88, 0xc2, popped, 0x00],
            `${name} answers D3DERR_INVALIDCALL for a stage past the last`);
        assert.deepEqual([...code.slice(code.length - 18, code.length - 13)],
            [0x31, 0xc0, 0xc2, popped, 0x00], `${name} answers D3D_OK and pops ${popped}`);
        assert.deepEqual([...code.slice(0, 7)], [...rs.slice(0, 7)], `${name} starts the same`);
    }
    // The stage-state routine takes exactly this version's types: a bit per
    // type, tested before the stage.
    const tss = staged.stageState[0];
    const mask = Object.values(D3DTSS).reduce((bits, type)=>bits | (1 << type), 0) >>> 0;
    const at = [...tss].findIndex((byte, i)=>byte === 0xba
        && new DataView(tss.buffer).getUint32(i + 1, true) === mask);
    assert.notEqual(at, -1, 'the mask is an immediate in the routine');
    assert.deepEqual([...tss.slice(at + 5, at + 8)], [0x0f, 0xa3, 0xc2], 'bt edx, eax');
    assert.equal(tss[at + 8], 0x73, 'jnc to the slow path');
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
    assert.ok(at + 0x2000 <= 0x1008 + 0x3000, 'both pages are inside what was taken');
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
    for (let stage = 0; stage < SHADOW.STAGE_COUNT; stage++)
    {
        assert.equal(m.u32(at + SHADOW.TEXTURES + stage * 4), STALE_POINTER,
            'a stage is stale until the program writes it, whatever the device holds');
    }
    const tss = (/** @type {number} */ stage, /** @type {number} */ type)=>
        m.u32(at + SHADOW.STAGE_STATES + (stage * SHADOW.STAGE_STATE_STRIDE + type) * 4);
    assert.equal(tss(0, D3DTSS.COLOROP), 4, 'stage 0 as the device holds it');
    assert.equal(tss(3, D3DTSS.COLOROP), 1);
    assert.equal(tss(3, D3DTSS.MAGFILTER), 1);
    assert.equal(tss(3, D3DTSS.ADDRESSU), 0, 'a type the device has not got');
    assert.equal(view.getFloat32(at + SHADOW.MATERIAL + 16 * 4, true), 1, 'Power');
    assert.equal(view.getFloat32(at + SHADOW.MATERIAL + 5 * 4, true), 5 / 16, 'Ambient.g');
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
    m.bump(at + SHADOW.TRANSFORM_CALLS);
    m.shadow.sync();
    m.bump(at + SHADOW.RENDER_STATE_CALLS);
    m.bump(at + SHADOW.TRANSFORM_CALLS);
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

test('a call that changed nothing reads nine words in place and copies none', ()=>{
    // The block is looked at on every device call; with a dword reader the
    // unchanged case costs nine reads, one per counter, and no view of the block.
    const m = machine({ readU32: true });
    m.shadow.address();
    m.shadow.sync();
    const before = m.reads.memory;
    m.shadow.sync();
    m.shadow.sync();
    assert.equal(m.reads.memory, before, 'no copy of the block for a call that changed nothing');
    m.put32(m.shadow.address() + SHADOW.RENDER_STATES + 8 * 4, 5);
    m.bump(m.shadow.address() + SHADOW.RENDER_STATE_CALLS);
    m.shadow.sync();
    assert.ok(m.reads.memory > before, 'a change is read out of the block');
    assert.equal(m.device.states.get(8), 5);
});

test('a sync reads the groups whose counters moved, and no other', ()=>{
    const m = machine({ readU32: true });
    const at = m.shadow.address();
    m.shadow.sync();
    /** The regions read by the next sync, as [offset, bytes]. */
    const regionsOf = (/** @type {() => void} */ change)=>{
        m.reads.regions.length = 0;
        change();
        m.shadow.sync();
        return m.reads.regions.slice();
    };

    assert.deepEqual(regionsOf(()=>{
        m.put32(at + SHADOW.RENDER_STATES + 8 * 4, 5);
        m.bump(at + SHADOW.RENDER_STATE_CALLS);
    }), [[SHADOW.RENDER_STATES, SHADOW.RENDER_STATE_COUNT * 4]], 'one state: the states');
    assert.deepEqual(regionsOf(()=>{
        m.putF32(at + SHADOW.TRANSFORMS + 24 * 64, 42);
        m.bump(at + SHADOW.TRANSFORM_CALLS);
    }), [[SHADOW.TRANSFORMS, SHADOW.TRANSFORM_SLOTS * 64]], 'one transform: the transforms');
    assert.deepEqual(regionsOf(()=>{
        m.put32(at + SHADOW.TEXTURES, 0);
        m.bump(at + SHADOW.TEXTURE_CALLS);
    }), [[SHADOW.TEXTURES, SHADOW.STAGE_COUNT * 4]], 'one texture: the textures');
    assert.deepEqual(regionsOf(()=>{
        m.put32(at + SHADOW.STAGE_STATES + D3DTSS.COLOROP * 4, 7);
        m.bump(at + SHADOW.STAGE_STATE_CALLS);
    }), [[SHADOW.STAGE_STATES, SHADOW.STAGE_COUNT * SHADOW.STAGE_STATE_STRIDE * 4]]);
    assert.deepEqual(regionsOf(()=>{
        m.putF32(at + SHADOW.MATERIAL + 16 * 4, 8);
        m.bump(at + SHADOW.MATERIAL_CALLS);
    }), [[SHADOW.MATERIAL, SHADOW.MATERIAL_WORDS * 4]], 'a material: the material');
    assert.deepEqual(regionsOf(()=>{
        m.put32(at + SHADOW.VERTEX_SHADER, 0x112);
        m.bump(at + SHADOW.BINDING_CALLS);
    }), [[SHADOW.STREAMS, (SHADOW.STREAM_COUNT * 2 + 3) * 4]], 'a binding: the bindings');
    assert.deepEqual(regionsOf(()=>{
        m.bump(at + SHADOW.LOCK_CALLS);
    }), [], 'a lock held across the entry reads nothing of the device\'s block');
    assert.deepEqual(m.device.calls,
        ['rs 8=5', 'tr 256=42,0', 'tex 0=none', 'tss 0.1=7', 'mat 0,8', 'shader=0x112']);
});

test('textures the guest bound reach the device as the objects the pointers name', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const grass = { name: 'grass' };
    const stone = { name: 'stone' };
    m.published.set(0x6100, grass);
    m.published.set(0x6200, stone);

    m.put32(at + SHADOW.TEXTURES, 0x6100);
    m.put32(at + SHADOW.TEXTURES + 4, 0x6200);
    m.bump(at + SHADOW.TEXTURE_CALLS);
    m.shadow.sync();
    assert.deepEqual(m.device.calls, ['tex 0=grass', 'tex 1=stone']);
    assert.equal(m.device.textures.get(0), grass);
    assert.equal(m.shadow.diagnostics().textureCalls, 1);

    // Unbinding is a null pointer; a pointer that names nothing is a
    // divergence, reported once, and the device keeps what it had.
    m.put32(at + SHADOW.TEXTURES, 0);
    m.put32(at + SHADOW.TEXTURES + 4, 0x6300);
    m.bump(at + SHADOW.TEXTURE_CALLS);
    m.shadow.sync();
    m.bump(at + SHADOW.TEXTURE_CALLS);
    m.shadow.sync();
    assert.deepEqual(m.device.calls.slice(2), ['tex 0=none']);
    assert.equal(m.device.textures.get(1), stone);
    assert.equal(m.divergences.length, 1);
    assert.match(m.divergences[0], /SetTexture.*stage 1.*0x6300.*not an interface/);
});

test('a texture the program let go of stays bound, and its pointer\'s next use is a change', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const grass = { name: 'grass' };
    const vb = fakeBuffer(0x8000, 0x100);
    vb.name = 'vb';
    m.published.set(0x6100, grass);
    m.published.set(0x5100, vb);
    m.put32(at + SHADOW.TEXTURES + 2 * 4, 0x6100);
    m.bump(at + SHADOW.TEXTURE_CALLS);
    m.put32(at + SHADOW.STREAMS, 0x5100);
    m.put32(at + SHADOW.STREAMS + 4, 32);
    m.put32(at + SHADOW.INDICES, 0x5100);
    m.bump(at + SHADOW.BINDING_CALLS);
    m.shadow.sync();
    m.device.calls.length = 0;

    // The last reference went: the seam adopts what was pending, then
    // forgets the pointer. The slots read stale, the device is not told.
    m.published.delete(0x6100);
    m.published.delete(0x5100);
    m.shadow.forgetPointer(0x6100);
    m.shadow.forgetPointer(0x5100);
    assert.equal(m.u32(at + SHADOW.TEXTURES + 2 * 4), STALE_POINTER);
    assert.equal(m.u32(at + SHADOW.STREAMS), STALE_POINTER);
    assert.equal(m.u32(at + SHADOW.INDICES), STALE_POINTER);
    assert.equal(m.u32(at + SHADOW.STREAMS + 4), 32, 'the stride is not a pointer');
    m.bump(at + SHADOW.TEXTURE_CALLS);
    m.bump(at + SHADOW.BINDING_CALLS);
    m.shadow.sync();
    assert.deepEqual(m.device.calls, [], 'the device keeps the texture it had bound');
    assert.equal(m.device.textures.get(2), grass);
    assert.deepEqual(m.divergences, []);

    // A new object published at the old pointer, and the program binds it:
    // the slot changed from stale, so the new object is what gets bound.
    const stone = { name: 'stone' };
    m.published.set(0x6100, stone);
    m.put32(at + SHADOW.TEXTURES + 2 * 4, 0x6100);
    m.bump(at + SHADOW.TEXTURE_CALLS);
    m.shadow.sync();
    assert.deepEqual(m.device.calls, ['tex 2=stone']);

    // A pointer nobody bound is nothing to forget, and a block not yet made
    // has nothing to forget it from.
    m.shadow.forgetPointer(0x7777);
    machine().shadow.forgetPointer(0x6100);
});

test('stage states the guest wrote reach the device by stage and type', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const slot = (/** @type {number} */ stage, /** @type {number} */ type)=>
        at + SHADOW.STAGE_STATES + (stage * SHADOW.STAGE_STATE_STRIDE + type) * 4;

    m.put32(slot(0, D3DTSS.COLOROP), 7);
    m.put32(slot(5, D3DTSS.MAGFILTER), 2);
    m.put32(slot(7, D3DTSS.ADDRESSU), 3);   // a type this device has not got
    m.bump(at + SHADOW.STAGE_STATE_CALLS);
    m.shadow.sync();
    m.bump(at + SHADOW.STAGE_STATE_CALLS);
    m.shadow.sync();

    assert.deepEqual(m.device.calls, ['tss 0.1=7', 'tss 5.16=2', 'tss 7.13=3']);
    assert.equal(m.device.stageStates[5].get(D3DTSS.MAGFILTER), 2);
    assert.equal(m.divergences.length, 1);
    assert.match(m.divergences[0], /SetTextureStageState.*stage 7 state 13 set to 3/);
    assert.equal(m.shadow.diagnostics().stageStateCalls, 2);
});

test('a material the guest wrote reaches the device as its seventeen floats', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const floats = Float32Array.from({ length: 17 }, (unused, i)=>i + 0.5);
    m.memory.set(new Uint8Array(floats.buffer), at + SHADOW.MATERIAL);
    m.bump(at + SHADOW.MATERIAL_CALLS);
    m.shadow.sync();

    assert.deepEqual(m.device.calls, ['mat 0.5,16.5']);
    assert.deepEqual([...materialFloats(m.device.material)], [...floats]);
    assert.deepEqual(m.device.material.Specular, { r: 8.5, g: 9.5, b: 10.5, a: 11.5 });
    assert.equal(m.shadow.diagnostics().materialCalls, 1);

    // Set again with the same contents, as programs do: counted, not set.
    m.bump(at + SHADOW.MATERIAL_CALLS);
    m.shadow.sync();
    assert.equal(m.device.calls.length, 1);
    assert.equal(m.shadow.diagnostics().materialCalls, 2);
});

/**
 * A texture and its levels, sharing one count as the device's do: what makes
 * a reference taken in the guest and given back through a level's surface the
 * same reference.
 *
 * @param {number} levels
 */
function fakeTexture(levels){
    let count = 1;
    return {
        levels,
        get refCount(){
            return count;
        },
        addRef: ()=>++count,
        release: ()=>--count,
    };
}

test('a texture block says how many levels it has and holds a pointer for each', ()=>{
    const m = machine();
    const texture = fakeTexture(3);
    const block = m.shadow.attachTexture(texture);

    assert.notEqual(block, 0);
    assert.equal(m.shadow.attachTexture(texture), block, 'once');
    assert.equal(m.u32(block + TEXTURE.LEVEL_COUNT), 3);
    assert.equal(m.u32(block + TEXTURE.REFS), 0);
    for (let level = 0; level < TEXTURE.LEVEL_SLOTS; level++)
    {
        assert.equal(m.u32(block + TEXTURE.LEVELS + level * 4), 0,
            'no level answers until the host has published one');
    }

    m.shadow.noteLevel(texture, 1, 0x7100);
    assert.equal(m.u32(block + TEXTURE.LEVELS + 4), 0x7100);
    assert.equal(m.u32(block + TEXTURE.LEVELS), 0, 'and only that level');
    // A level past the table leaves the table alone rather than writing past it.
    m.shadow.noteLevel(texture, TEXTURE.LEVEL_SLOTS, 0x7200);
    assert.equal(m.u32(block + TEXTURE.SIZE), 0);
});

test('the references the guest took on levels are charged before any is given back', ()=>{
    const m = machine();
    const texture = fakeTexture(2);
    const block = m.shadow.attachTexture(texture);
    m.shadow.noteLevel(texture, 0, 0x7100);

    // What the guest routine does: hand the pointer back, count the reference.
    m.bump(block + TEXTURE.REFS);
    m.bump(block + TEXTURE.REFS);
    assert.equal(texture.refCount, 1, 'the host has not been told yet');

    m.shadow.settleTexture(texture);
    assert.equal(texture.refCount, 3, 'two references the program owns');
    assert.equal(m.shadow.diagnostics().surfaceLevelCalls, 2);

    // Settling again charges nothing: the count is the one already charged.
    m.shadow.settleTexture(texture);
    assert.equal(texture.refCount, 3);
    m.bump(block + TEXTURE.REFS);
    m.shadow.settleTexture(texture);
    assert.equal(texture.refCount, 4);
    assert.equal(m.shadow.diagnostics().surfaceLevelCalls, 3);

    // A texture nobody attached a block to is not an error: a build with no
    // block at all still has a working GetSurfaceLevel through the host.
    m.shadow.settleTexture(fakeTexture(1));
    assert.equal(m.shadow.diagnostics().surfaceLevelCalls, 3);
});
