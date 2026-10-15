/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    BUFFER, COMMAND, COMMAND_RING_BYTES, FLAG_SLOW_PATH, FLAG_STALE, SHADOW, TEXTURE,
    createCommandReader, createShadow, getRenderStateCode,
    getSurfaceLevelCode, getTextureStageStateCode, getTransformCode, lockCode, transformSlot,
    transformType, unlockCode,
} from './shadow.js';
import { D3DTSS } from '../d3d8/constants.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { D3DFMT as D3DFMT9, D3DRS as D3DRS9, D3DSWAPEFFECT as D3DSWAPEFFECT9 } from '../d3d9/constants.js';
import { D3DTSS9 } from '../d3d9/samplerstates.js';

/** Direct3D 8's stage state types, a bit each. */
const STAGE_STATE_TYPES = Object.values(D3DTSS).reduce((mask, type)=>mask | (1 << type), 0) >>> 0;

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

/** A device that answers for some render states, one transform and three stage states a stage. */
function fakeDevice(){
    /** @type {Map<number, number>} */
    const states = new Map([[7, 1], [8, 3], [14, 0]]);
    /** @type {Map<number, Float32Array>} */
    const transforms = new Map([[2, Float32Array.from({ length: 16 }, (unused, i)=>i)]]);
    /** @type {Map<number, number>[]} */
    const stageStates = Array.from({ length: 8 }, (unused, stage)=>new Map([
        [D3DTSS.COLOROP, stage === 0 ? 4 : 1], [D3DTSS.COLORARG1, 2], [D3DTSS.MAGFILTER, 1],
    ]));
    return {
        states, transforms, stageStates,
        /** @param {number} state @param {{ value?: number }} out */
        GetRenderState(state, out){
            if (!states.has(state))
            {
                return -1;
            }
            out.value = states.get(state);
            return 0;
        },
        /** @param {number} type @param {{ matrix?: ArrayLike<number> }} out */
        GetTransform(type, out){
            out.matrix = transforms.get(type) ?? new Float32Array(16);
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
    };
}

/**
 * @param {{ readU32?: boolean, commands?: boolean,
 *     phases?: import('./shadow.js').ShadowPhases }} [options]
 */
function machine(options = {}){
    const memory = new Uint8Array(0x40000);
    /**
     * How often guest memory was copied out, which regions of it relative to
     * the block, and which words were read in place.
     */
    const reads = {
        memory: 0,
        regions: /** @type {[number, number][]} */ ([]),
        words: /** @type {number[]} */ ([]),
    };
    let free = 0x1008;
    const device = fakeDevice();
    /** @type {string[]} */
    const divergences = [];
    /** Each run of records the host was handed, as dwords, and when. @type {number[][]} */
    const taken = [];
    /** What happened, in order: the buffers' calls and the runs taken. @type {string[]} */
    const order = [];
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
        readU32: options.readU32
            ? address=>{
                reads.words.push(address - shadow.address());
                return view.getUint32(address, true);
            }
            : undefined,
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        device,
        divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        commands: options.commands
            ? {
                take: records=>{
                    const words = [...new Uint32Array(records.slice().buffer)];
                    taken.push(words);
                    order.push(`take ${words.length}`);
                    let made = 0;
                    for (let at = 0; at < words.length; at += words[at + 1] >>> 2)
                    {
                        made++;
                    }
                    return made;
                },
            }
            : undefined,
        phases: options.phases,
    });
    const view = new DataView(memory.buffer);
    return {
        reads, taken, order,
        memory, device, shadow, divergences,
        /** @param {number} at */
        u32: at=>view.getUint32(at, true),
        /** @param {number} at @param {number} value */
        put32: (at, value)=>view.setUint32(at, value >>> 0, true),
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
    assert.ok(SHADOW.SIZE > 4096, 'the stage states push it past one page');
    assert.ok(SHADOW.SIZE <= 2 * 4096);
    // The words every entry may look at, together at the start.
    assert.equal(SHADOW.FLAGS, 0);
    assert.equal(SHADOW.FLAGS + 4, SHADOW.COMMANDS);
    assert.equal(SHADOW.COMMANDS + 4, SHADOW.COMMAND_BYTES);
    assert.equal(SHADOW.COMMAND_BYTES + 4, SHADOW.COMMAND_HEAD);
    assert.equal(SHADOW.COMMAND_HEAD + 4, SHADOW.DRAWS_PENDING);
    assert.equal(SHADOW.DRAWS_PENDING + 4, SHADOW.LOCK_CALLS);
    // The two counts, the ring's head and the ring in one run, which the
    // host reads in one go when the ring holds something.
    assert.equal(SHADOW.LOCK_CALLS + 4, SHADOW.UNLOCK_CALLS);
    assert.equal(SHADOW.UNLOCK_CALLS + 4, SHADOW.RING_HEAD);
    assert.equal(SHADOW.RING_HEAD + 4, SHADOW.RING);
    assert.equal(SHADOW.RING + SHADOW.RING_CAPACITY * 4, SHADOW.RENDER_STATES);
    assert.equal(SHADOW.RENDER_STATES + SHADOW.RENDER_STATE_COUNT * 4, SHADOW.RENDER_STATE_VALID);
    assert.equal(SHADOW.RENDER_STATE_VALID + SHADOW.RENDER_STATE_COUNT / 8, SHADOW.TRANSFORMS);
    assert.equal(SHADOW.TRANSFORMS + SHADOW.TRANSFORM_SLOTS * 64, SHADOW.STAGE_STATES);
    assert.equal(SHADOW.STAGE_STATES + SHADOW.STAGE_COUNT * SHADOW.STAGE_STATE_STRIDE * 4,
        SHADOW.VIEWPORT);
    assert.equal(SHADOW.VIEWPORT + 6 * 4, SHADOW.SAMPLER_STATES);
    assert.equal(SHADOW.SAMPLER_STATES
        + SHADOW.SAMPLER_COUNT * SHADOW.SAMPLER_STATE_STRIDE * 4, SHADOW.DRAWABLE);
    // What the command routines check a call against, written by the host in one go.
    assert.equal(SHADOW.DRAWABLE + 4, SHADOW.TARGET_WIDTH);
    assert.equal(SHADOW.TARGET_WIDTH + 4, SHADOW.TARGET_HEIGHT);
    assert.equal(SHADOW.TARGET_HEIGHT + 4, SHADOW.CLIP_PLANES);
    assert.equal(SHADOW.CLIP_PLANES + 4, SHADOW.VALIDATED);
    assert.equal(SHADOW.VALIDATED + SHADOW.VALIDATED_TABLES * SHADOW.VALIDATED_SLOTS * 4,
        SHADOW.SIZE);
    assert.equal(BUFFER.SIZE, 36);
    assert.equal(TEXTURE.LEVELS + TEXTURE.LEVEL_SLOTS * 4, TEXTURE.SIZE);
    // Enough for the longest chain a texture of this era can have: a 32768
    // texel side is sixteen levels, and no device of the era reports one.
    assert.ok(TEXTURE.LEVEL_SLOTS >= 14);
    assert.ok(TEXTURE.SIZE <= 4096, 'a texture block comes out of one page with others');
});

test('the routines end in a jump to their own trap, and check the flag first', ()=>{
    const rs = getRenderStateCode(0x20000, 0x105000);
    assert.deepEqual([...rs.slice(0, 7)], [0x8b, 0x4c, 0x24, 0x04, 0x8b, 0x49, 0x04],
        'this, then the block one word past it');
    assert.deepEqual([...rs.slice(7, 9)], [0x85, 0xc9], 'a block at all');
    assert.equal(rs[9], 0x74, 'jz to the slow path');
    assert.deepEqual([...rs.slice(11, 17)], [0xf7, 0x01, FLAG_SLOW_PATH | FLAG_STALE, 0, 0, 0],
        'the flags: a getter waits for the host while what it reads may be stale');
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
        renderState: [rs, 12],
        transform: [getTransformCode(0x20100, 0x105010), 12],
        lock: [lockCode(0x20200, 0x105020), 20],
        unlock: [unlockCode(0x20300, 0x105030), 4],
        stageState: [getTextureStageStateCode(0x20400, 0x105040, STAGE_STATE_TYPES), 16],
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

    // The two buffer routines count the call last, in the device's block:
    // through EBX for the lock, EDX for the unlock, each holding it.
    const unlock = rets.unlock[0];
    assert.deepEqual([...lock.slice(lock.length - 17, lock.length - 11)],
        [0xff, 0x83, ...new Uint8Array(Uint32Array.of(SHADOW.LOCK_CALLS).buffer)],
        'the lock counts the call last');
    assert.deepEqual([...unlock.slice(unlock.length - 16, unlock.length - 10)],
        [0xff, 0x82, ...new Uint8Array(Uint32Array.of(SHADOW.UNLOCK_CALLS).buffer)],
        'the unlock counts the call last');

    // The level getter refuses a level the texture has not got, and reads
    // the count out of the block rather than assuming the table's length is it.
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

    // The stage-state getter answers exactly the types it is given: a bit
    // per type, tested before the stage.
    const tss = rets.stageState[0];
    const at = [...tss].findIndex((byte, i)=>byte === 0xba
        && new DataView(tss.buffer).getUint32(i + 1, true) === STAGE_STATE_TYPES);
    assert.notEqual(at, -1, 'the mask is an immediate in the routine');
    assert.deepEqual([...tss.slice(at + 5, at + 8)], [0x0f, 0xa3, 0xc2], 'bt edx, eax');
    assert.equal(tss[at + 8], 0x73, 'jnc to the slow path');
});

test('the block is made on first use and mirrors what the device holds', ()=>{
    const m = machine();
    assert.equal(m.shadow.diagnostics().placed, 0);

    const at = m.shadow.address();

    assert.notEqual(at, 0);
    assert.equal(m.shadow.address(), at, 'once');
    assert.equal(at & 0xfff, 0, 'on a page boundary, whatever the heap handed out');
    assert.ok(at + 0x2000 <= 0x1008 + 0x3000, 'both pages are inside what was taken');
    assert.equal(m.shadow.diagnostics().placed, 1);
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 8 * 4), 3, 'state 8 as the device holds it');
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 7 * 4), 1);
    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 9 * 4), 0, 'a state the device has not got');
    assert.equal(m.u32(at + SHADOW.RENDER_STATE_VALID), 1 << 7 | 1 << 8 | 1 << 14,
        'and a bit for each state the device answers for, so the getter leaves the rest');
    for (let word = 1; word < SHADOW.RENDER_STATE_COUNT / 32; word++)
    {
        assert.equal(m.u32(at + SHADOW.RENDER_STATE_VALID + word * 4), 0);
    }
    const view = new DataView(m.memory.buffer);
    assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 2 * 64 + 4, true), 1, 'VIEW[1]');
    assert.equal(m.u32(at + SHADOW.FLAGS), 0);
    const tss = (/** @type {number} */ stage, /** @type {number} */ type)=>
        m.u32(at + SHADOW.STAGE_STATES + (stage * SHADOW.STAGE_STATE_STRIDE + type) * 4);
    assert.equal(tss(0, D3DTSS.COLOROP), 4, 'stage 0 as the device holds it');
    assert.equal(tss(3, D3DTSS.COLOROP), 1);
    assert.equal(tss(3, D3DTSS.MAGFILTER), 1);
    assert.equal(tss(3, D3DTSS.ADDRESSU), 0, 'a type the device has not got');
    assert.equal(m.u32(at + SHADOW.COMMANDS), 0, 'a device without commands has no ring');
});

test('the slow-path flag is the host\'s, and a re-mirror brings the block to the device', ()=>{
    const m = machine();
    const at = m.shadow.address();

    m.shadow.slowPath(true);
    assert.equal(m.u32(at + SHADOW.FLAGS), FLAG_SLOW_PATH);
    assert.equal(m.shadow.diagnostics().slowPath, 1);
    m.shadow.slowPath(false);
    assert.equal(m.u32(at + SHADOW.FLAGS), 0);
    assert.equal(m.shadow.diagnostics().slowPath, 0);

    // The host changed state on its own: a state block applied, a reset.
    m.device.states.set(8, 77);
    m.device.transforms.set(3, Float32Array.from({ length: 16 }, ()=>9));
    m.device.stageStates[1].set(D3DTSS.COLOROP, 6);
    m.shadow.remirror();

    assert.equal(m.u32(at + SHADOW.RENDER_STATES + 8 * 4), 77);
    const view = new DataView(m.memory.buffer);
    assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 3 * 64, true), 9);
    assert.equal(m.u32(at + SHADOW.STAGE_STATES
        + (SHADOW.STAGE_STATE_STRIDE + D3DTSS.COLOROP) * 4), 6);
});

test('a re-mirror of what a block named, or a transform the host multiplied, reads only that',
    ()=>{
        const m = machine();
        const at = m.shadow.address();
        /** @type {string[]} */
        const asked = [];
        const { GetRenderState, GetTransform, GetTextureStageState } = m.device;
        /** @param {number} state @param {{ value?: number }} out */
        m.device.GetRenderState = (state, out)=>{
            asked.push(`rs ${state}`);
            return GetRenderState(state, out);
        };
        /** @param {number} type @param {{ matrix?: ArrayLike<number> }} out */
        m.device.GetTransform = (type, out)=>{
            asked.push(`tr ${type}`);
            return GetTransform(type, out);
        };
        /** @param {number} stage @param {number} type @param {{ value?: number }} out */
        m.device.GetTextureStageState = (stage, type, out)=>{
            asked.push(`tss ${stage}.${type}`);
            return GetTextureStageState(stage, type, out);
        };
        const view = new DataView(m.memory.buffer);
        const tss = (/** @type {number} */ stage, /** @type {number} */ type)=>
            m.u32(at + SHADOW.STAGE_STATES + (stage * SHADOW.STAGE_STATE_STRIDE + type) * 4);

        // The host changed states of each kind; a block names one of each.
        m.device.states.set(7, 5);
        m.device.states.set(8, 6);
        m.device.transforms.set(256, Float32Array.from({ length: 16 }, ()=>2));
        m.device.transforms.set(2, Float32Array.from({ length: 16 }, ()=>3));
        m.device.stageStates[2].set(D3DTSS.COLOROP, 9);
        m.device.stageStates[4].set(D3DTSS.COLOROP, 5);
        const before = tss(4, D3DTSS.COLOROP);
        m.shadow.remirror({
            renderStates: [8, 300],
            transforms: [256, 260],
            stageStates: [(2 << 8) | D3DTSS.COLOROP, (8 << 8) | D3DTSS.COLOROP],
        });
        assert.deepEqual(asked, ['rs 8', 'tr 256', `tss 2.${D3DTSS.COLOROP}`],
            'one read each, and none for what the block has no room for');
        assert.equal(m.u32(at + SHADOW.RENDER_STATES + 8 * 4), 6, 'the state named');
        assert.equal(m.u32(at + SHADOW.RENDER_STATES + 7 * 4), 1, 'a state not named');
        assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 24 * 64, true), 2, 'WORLD');
        assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 2 * 64 + 4, true), 1,
            'VIEW not read');
        assert.equal(tss(2, D3DTSS.COLOROP), 9);
        assert.equal(tss(4, D3DTSS.COLOROP), before, 'a stage state not named');

        // A transform the host multiplied on its own.
        asked.length = 0;
        m.shadow.refreshTransform(2);
        m.shadow.refreshTransform(24);
        assert.deepEqual(asked, ['tr 2'], 'a type the block has no slot for is not read');
        assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + 2 * 64 + 60, true), 3);

        // Every stage state, when that is what is asked.
        asked.length = 0;
        m.shadow.remirror({ stageStates: true });
        assert.equal(asked.length, SHADOW.STAGE_COUNT * SHADOW.STAGE_STATE_STRIDE);
        assert.equal(tss(4, D3DTSS.COLOROP), 5);
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
    m.put32(at + SHADOW.LOCK_CALLS, 1);
    m.put32(at + SHADOW.RING, block);
    m.put32(at + SHADOW.RING_HEAD, 1);
    m.put32(at + SHADOW.UNLOCK_CALLS, 1);
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
    m.put32(at + SHADOW.UNLOCK_CALLS, 2);
    m.shadow.sync();
    assert.deepEqual(vb.calls.slice(2), ['lock 0+256 0x0', 'unlock']);
    assert.equal(m.shadow.diagnostics().unlockCalls, 2);
});

test('a lock the guest holds across an entry is held by the host until the guest lets go', ()=>{
    const m = machine();
    const at = m.shadow.address();
    const vb = fakeBuffer(0x8000, 0x100);
    const block = m.shadow.attachBuffer(vb);

    // Locked in the guest, then a crossing: what the range held reaches the
    // buffer now, for the draws that read it, and the host locks again,
    // keeping it, so that a lock through the host's own path is refused as
    // the real interface would.
    m.put32(block + BUFFER.LOCKED, 1);
    m.put32(block + BUFFER.FROM, 0);
    m.put32(block + BUFFER.TO, 64);
    m.put32(at + SHADOW.LOCK_CALLS, 1);
    m.shadow.settleBuffer(vb);
    assert.deepEqual(vb.calls, ['lock 0+64 0x0', 'unlock', 'lock 0+64 0x1000']);
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
    m.put32(at + SHADOW.UNLOCK_CALLS, 1);
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
    m.shadow.sync();
    assert.deepEqual(vb.calls, []);
    assert.equal(m.shadow.diagnostics().buffers, 0);
});


test('a sync before the block exists is nothing', ()=>{
    const m = machine({ commands: true });
    m.shadow.sync();
    m.shadow.remirror();
    m.shadow.refreshTransform(256);
    m.shadow.slowPath(true);
    m.shadow.settleBuffer(fakeBuffer(0, 16));
    m.shadow.noteLocked(fakeBuffer(0, 16), true);
    assert.equal(m.reads.memory, 0);
    assert.deepEqual(m.taken, []);
    assert.equal(m.shadow.diagnostics().placed, 0);
});

test('an entry with nothing to do reads its few words in place and copies none', ()=>{
    // The block is looked at on every device call; with a dword reader an
    // entry after nothing was unlocked or recorded costs the ring's head,
    // the draw flag and the command ring's head, and no view.
    const m = machine({ readU32: true, commands: true });
    m.shadow.address();
    const before = m.reads.memory;
    m.shadow.sync();
    m.shadow.sync();
    assert.equal(m.reads.memory, before, 'no copy of the block for a call that changed nothing');
    assert.deepEqual(m.reads.words, [
        SHADOW.RING_HEAD, SHADOW.DRAWS_PENDING, SHADOW.COMMAND_HEAD,
        SHADOW.RING_HEAD, SHADOW.DRAWS_PENDING, SHADOW.COMMAND_HEAD,
    ]);

    // Without a ring, the ring's head is all.
    const bare = machine({ readU32: true });
    bare.shadow.address();
    bare.shadow.sync();
    assert.deepEqual(bare.reads.words, [SHADOW.RING_HEAD]);

    // A buffer let go of: the counts and the ring in one read.
    const vb = fakeBuffer(0x8000, 0x100);
    const block = bare.shadow.attachBuffer(vb);
    const at = bare.shadow.address();
    bare.put32(block + BUFFER.FROM, 0);
    bare.put32(block + BUFFER.TO, 16);
    bare.put32(at + SHADOW.RING, block);
    bare.put32(at + SHADOW.RING_HEAD, 1);
    bare.reads.regions.length = 0;
    bare.shadow.sync();
    assert.deepEqual(bare.reads.regions[0], [SHADOW.LOCK_CALLS, 16]);
    assert.deepEqual(vb.calls, ['lock 0+16 0x0', 'unlock']);
});

/**
 * A record as a command routine writes it: the slot, the length, the arguments.
 *
 * @param {number} slot @param {number[]} args
 */
const record = (slot, args)=>[slot, COMMAND.ARGS + 4 * args.length, ...args];

test('the command ring is made with the block, and its whole records are taken in order', ()=>{
    const m = machine({ commands: true });
    const at = m.shadow.address();
    const ring = m.u32(at + SHADOW.COMMANDS);
    assert.notEqual(ring, 0, 'a device with commands has a ring');
    assert.equal(ring & 0xfff, 0, 'on pages of its own');
    assert.notEqual(ring >>> 12, at >>> 12);
    const bytes = m.u32(at + SHADOW.COMMAND_BYTES);
    assert.ok(bytes >= 0x8000);

    /** @param {number} from @param {number[]} words */
    const write = (from, words)=>words.forEach((word, i)=>m.put32(ring + from + i * 4, word));
    // Two records, then one whose space was taken and whose length is not
    // there yet: a routine another thread is in the middle of.
    const first = record(7, [1, 2]);
    const second = record(9, [3]);
    const third = record(11, [4, 5, 6]);
    write(0, first);
    write(16, second);
    write(28, [third[0], 0, ...third.slice(2)]);
    m.put32(at + SHADOW.COMMAND_HEAD, 28 + 20);
    m.put32(at + SHADOW.DRAWS_PENDING, 1);
    m.shadow.sync();
    assert.deepEqual(m.taken, [[...first, ...second]], 'the whole ones, in order');
    assert.equal(m.u32(at + SHADOW.DRAWS_PENDING), 0, 'the draws are the host\'s now');
    assert.equal(m.shadow.diagnostics().commandCalls, 2);

    m.shadow.sync();
    assert.equal(m.taken.length, 1, 'the one not yet whole is left');
    m.put32(ring + 28 + COMMAND.BYTES, third[1]);
    m.shadow.sync();
    assert.deepEqual(m.taken[1], third, 'and taken once it is');
    assert.equal(m.shadow.diagnostics().commandCalls, 3);
    assert.deepEqual(m.divergences, []);

    // A head that went back is no head the routines leave.
    m.put32(at + SHADOW.COMMAND_HEAD, 16);
    m.shadow.sync();
    assert.equal(m.taken.length, 2);
    assert.match(m.divergences[0], /commands.*head went back/);
    assert.equal(m.shadow.diagnostics().refused, 1);
});

test('a buffer the guest holds locked is sent only when the ring has calls that may read it', ()=>{
    // Sent at every entry, the held range was read again at each of
    // thousands of host calls a frame.
    const m = machine({ commands: true });
    const vb = Object.assign(fakeBuffer(0x8000, 0x100), { usage: 0x200 });
    const block = m.shadow.attachBuffer(vb);
    const at = m.shadow.address();
    // As the lock routine leaves it: the range, the flag, and its count.
    m.put32(block + BUFFER.LOCKED, 1);
    m.put32(block + BUFFER.FROM, 0);
    m.put32(block + BUFFER.TO, 16);
    m.put32(at + SHADOW.LOCK_CALLS, 1);
    m.shadow.sync();
    m.shadow.sync();
    assert.deepEqual(vb.calls, [], 'nothing in the ring: nothing to send');
    const ring = m.u32(at + SHADOW.COMMANDS);
    record(7, [1, 2]).forEach((word, i)=>m.put32(ring + i * 4, word));
    m.put32(at + SHADOW.COMMAND_HEAD, 16);
    // The counts equal, as after an unlock the routines made: nothing is held.
    m.put32(at + SHADOW.UNLOCK_CALLS, 1);
    m.shadow.sync();
    assert.deepEqual(vb.calls, [], 'no lock held: none looked at');
    record(7, [1, 2]).forEach((word, i)=>m.put32(ring + 16 + i * 4, word));
    m.put32(at + SHADOW.COMMAND_HEAD, 32);
    m.put32(at + SHADOW.LOCK_CALLS, 2);
    m.shadow.sync();
    assert.deepEqual(vb.calls, ['lock 0+16 0x0', 'unlock'], 'sent before the calls in the ring');
    assert.equal(m.taken.length, 2);
});

test('the ring starts over once the host has read up to a head near its end', ()=>{
    const m = machine({ commands: true });
    const at = m.shadow.address();
    const ring = m.u32(at + SHADOW.COMMANDS);
    const bytes = m.u32(at + SHADOW.COMMAND_BYTES);
    // One record that fills the ring to a little short of its end.
    const length = bytes - 1024;
    m.put32(ring, 5);
    m.put32(ring + COMMAND.BYTES, length);
    m.put32(at + SHADOW.COMMAND_HEAD, length);
    m.shadow.sync();
    assert.equal(m.taken.length, 1);
    assert.equal(m.u32(at + SHADOW.COMMAND_HEAD), 0, 'the head back at the start');
    assert.equal(m.u32(ring + COMMAND.BYTES), 0, 'and what was read zeroed, so no length is stale');

    const next = record(6, [1]);
    next.forEach((word, i)=>m.put32(ring + i * 4, word));
    m.put32(at + SHADOW.COMMAND_HEAD, next[1]);
    m.shadow.sync();
    assert.deepEqual(m.taken[1], next);
});

test('the buffers the guest let go of are settled before the ring\'s calls are made', ()=>{
    // A draw in the ring reads what the program wrote into a buffer it
    // unlocked before the draw: the bytes reach the buffer first.
    const m = machine({ commands: true });
    const at = m.shadow.address();
    const ring = m.u32(at + SHADOW.COMMANDS);
    const vb = fakeBuffer(0x8000, 0x100);
    const { Lock } = vb;
    /**
     * @param {number} offset @param {number} size
     * @param {{ pBits?: number }} out @param {number} [flags]
     */
    vb.Lock = (offset, size, out, flags)=>{
        m.order.push('lock');
        return Lock(offset, size, out, flags);
    };
    const block = m.shadow.attachBuffer(vb);
    m.put32(block + BUFFER.FROM, 0);
    m.put32(block + BUFFER.TO, 64);
    m.put32(at + SHADOW.RING, block);
    m.put32(at + SHADOW.RING_HEAD, 1);
    record(3, [0, 2]).forEach((word, i)=>m.put32(ring + i * 4, word));
    m.put32(at + SHADOW.COMMAND_HEAD, 16);
    m.shadow.sync();
    assert.deepEqual(m.order, ['lock', 'take 4']);
});


/**
 * One entry with a buffer let go of, one still held and a call in the ring;
 * what the buffers and the ring were given, in order.
 *
 * @param {import('./shadow.js').ShadowPhases} [phases]
 */
function entryWithEverything(phases){
    const m = machine({ commands: true, phases });
    const at = m.shadow.address();
    const ring = m.u32(at + SHADOW.COMMANDS);
    const unlocked = fakeBuffer(0x8000, 0x100);
    const held = Object.assign(fakeBuffer(0x9000, 0x100), { usage: 0x200 });
    const first = m.shadow.attachBuffer(unlocked);
    const second = m.shadow.attachBuffer(held);
    m.put32(first + BUFFER.FROM, 0);
    m.put32(first + BUFFER.TO, 64);
    m.put32(at + SHADOW.RING, first);
    m.put32(at + SHADOW.RING_HEAD, 1);
    m.put32(second + BUFFER.LOCKED, 1);
    m.put32(second + BUFFER.FROM, 0);
    m.put32(second + BUFFER.TO, 16);
    // Two locks taken by the routines, one let go of: one is held.
    m.put32(at + SHADOW.LOCK_CALLS, 2);
    m.put32(at + SHADOW.UNLOCK_CALLS, 1);
    record(3, [0, 2]).forEach((word, i)=>m.put32(ring + i * 4, word));
    m.put32(at + SHADOW.COMMAND_HEAD, 16);
    m.shadow.sync();
    return { unlocked: unlocked.calls, held: held.calls, taken: m.taken, order: m.order };
}

test('a timed entry opens its parts as phases inside ring-sync, as an untimed one acts', ()=>{
    // The work an entry does before the device method is the cost a profile
    // found only with a browser's trace: each part is a phase of its own
    // when the host call is one being timed. Timed or not, the guest's
    // buffers and the ring are given the same things in the same order.
    /** @type {string[]} */
    const opened = [];
    const timed = entryWithEverything({
        begin: name=>(opened.push(`begin ${name}`), 32),
        end: (name, weight)=>opened.push(`end ${name} x${weight}`),
    });
    assert.deepEqual(opened, [
        'begin ring-sync',
        'begin ring-unlocked', 'end ring-unlocked x32',
        'begin ring-take',
        'begin ring-held', 'end ring-held x32',
        'end ring-take x32',
        'end ring-sync x32',
    ]);

    opened.length = 0;
    const untimed = entryWithEverything({
        begin: name=>(opened.push(`begin ${name}`), 0),
        end: name=>opened.push(`end ${name}`),
    });
    assert.deepEqual(opened, ['begin ring-sync'], 'an untimed call asks once and opens nothing');
    assert.deepEqual(untimed, timed);
    assert.deepEqual(entryWithEverything(), timed, 'nor does a shadow with no phases differ');
    assert.ok(timed.held.length > 0 && timed.unlocked.length > 0 && timed.taken.length === 1,
        'the entry had all three parts to do');
});

test('a timed entry with nothing let go of and no ring opens ring-sync alone', ()=>{
    /** @type {string[]} */
    const opened = [];
    const m = machine({ phases: {
        begin: name=>(opened.push(`begin ${name}`), 32),
        end: name=>opened.push(`end ${name}`),
    } });
    assert.notEqual(m.shadow.address(), 0, 'the block made, so the entry has one to look at');
    m.shadow.sync();
    assert.deepEqual(opened, ['begin ring-sync', 'end ring-sync']);
});

/** @param {number} levels */
const fakeTexture = levels=>({ levels });

test('a texture block says how many levels it has, where its count is, and holds a pointer'
    + ' for each', ()=>{
    const m = machine();
    const texture = fakeTexture(3);
    const block = m.shadow.attachTexture(texture, 0x7000);

    assert.notEqual(block, 0);
    assert.equal(m.shadow.attachTexture(texture, 0x7000), block, 'once');
    assert.equal(m.u32(block + TEXTURE.LEVEL_COUNT), 3);
    assert.equal(m.u32(block + TEXTURE.COUNT), 0x7000);
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

    // A texture whose count the host keeps has no word for the routine.
    assert.equal(m.u32(m.shadow.attachTexture(fakeTexture(1)) + TEXTURE.COUNT), 0);
});

test('a Direct3D 9 device\'s render states, stage states and transforms are mirrored for its'
    + ' getters', ()=>{
    // The same block as Direct3D 8's, over a device of the other version:
    // what its getters in the guest read is what the device holds.
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(createDirect3D9({}).CreateDevice({
        swapEffect: D3DSWAPEFFECT9.DISCARD, backBufferCount: 1, backBufferWidth: 64,
        backBufferHeight: 64, backBufferFormat: D3DFMT9.X8R8G8B8,
    }, out), 0);
    const device = out.device;
    assert.equal(device.SetTextureStageState(1, D3DTSS9.COLOROP, 2), 0);
    assert.equal(device.SetTransform(256, Float32Array.from({ length: 16 }, (unused, i)=>i)), 0);
    const memory = new Uint8Array(0x20000);
    const view = new DataView(memory.buffer);
    let free = 0x1008;
    const shadow = createShadow({
        allocate: bytes=>{
            const at = free;
            free += bytes;
            return at;
        },
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        device,
        name: 'IDirect3DDevice9',
    });
    const at = shadow.address();
    assert.equal(view.getUint32(at + SHADOW.RENDER_STATES + D3DRS9.CULLMODE * 4, true), 3,
        'the render states of the device are mirrored');
    assert.ok(view.getUint32(at + SHADOW.RENDER_STATE_VALID, true) & 1 << D3DRS9.CULLMODE);
    assert.equal(view.getUint32(at + SHADOW.STAGE_STATES
        + (SHADOW.STAGE_STATE_STRIDE + D3DTSS9.COLOROP) * 4, true), 2);
    assert.equal(view.getFloat32(at + SHADOW.TRANSFORMS + transformSlot(256) * 64 + 12 * 4,
        true), 12);
});

test('a ring started over keeps the record a routine on another executor took space for meanwhile',
    ()=>{
        // The host has read every record up to a head past the point where it
        // starts the ring over; between its read and the start over, a routine
        // on another executor takes the next eight bytes and writes a record.
        const memory = new Uint8Array(0x20000);
        const words = new DataView(memory.buffer);
        const block = 0x1000;
        const ring = 0x2000;
        const head = COMMAND_RING_BYTES - 1024;
        /** @param {number} at @param {number} slot */
        const write = (at, slot)=>{
            words.setUint32(ring + at + COMMAND.SLOT, slot, true);
            words.setUint32(ring + at + COMMAND.BYTES, 8, true);
        };
        for (let at = 0; at < head; at += 8)
        {
            write(at, 1);
        }
        words.setUint32(block + SHADOW.COMMAND_HEAD, head, true);
        let raced = false;
        /** @type {number[]} */
        const slots = [];
        const reader = createCommandReader({
            block, ring,
            readWord: address=>words.getUint32(address, true),
            readWords: (address, count)=>new Uint32Array(memory.slice(address, address + count * 4)
                .buffer),
            writeMemory: (address, bytes)=>memory.set(bytes, address),
            compareExchangeU32: (address, expected, value)=>{
                if (!raced)
                {
                    raced = true;
                    write(head, 2);
                    words.setUint32(block + SHADOW.COMMAND_HEAD, head + 8, true);
                }
                const held = words.getUint32(address, true);
                if (held === expected)
                {
                    words.setUint32(address, value, true);
                }
                return held;
            },
            take: records=>{
                const taken = new Uint32Array(records.buffer, records.byteOffset,
                    records.byteLength >>> 2);
                for (let i = 0; i < taken.length; i += 2)
                {
                    slots.push(taken[i]);
                }
                return taken.length / 2;
            },
            refuse: detail=>assert.fail(detail),
        });
        reader.take();
        reader.take();
        assert.equal(raced, true, 'the host started the ring over');
        assert.equal(slots.length, head / 8 + 1, 'every record, the raced one with them');
        assert.equal(slots[slots.length - 1], 2);
        // And once nothing took space past it, the ring starts over.
        reader.take();
        assert.equal(words.getUint32(block + SHADOW.COMMAND_HEAD, true), 0);
    });
