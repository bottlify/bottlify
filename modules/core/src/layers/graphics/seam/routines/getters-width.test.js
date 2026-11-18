/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every getter built for a 64-bit process (`X64`) on cork's long-mode
 * machine, called as the x64 convention calls: the answer and the
 * out-structure are what the block holds - what the i386 copies out of the
 * same words - an interface pointer it hands out is eight bytes with its
 * upper half zero and the reference it owes taken, and each case it leaves
 * to the host reaches the trap with RCX, RDX, R8, R9 and RSP as at the entry,
 * which the bridge's 64-bit trap reads the call from.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_64, KEPT_64, STACK_64, argumentOf, callLong, longMachine }
    from '../../../../../scripts/guest-code/long.mjs';
import { X64 } from './assemble.js';
import {
    getLevelDescCode, getSamplerStateCode, getShaderCode, getSurfaceDescCode, getSurfaceLevelCode,
    getTargetCode, getTextureStageStateCode, getTransformCode, getViewportCode,
} from './getters.js';
import { FLAG_SLOW_PATH, SHADOW, SURFACE, TEXTURE } from '../block.js';

const TRAP = 0x0e00;
const RETURN = 0x0f00;
const THIS = 0x200000;
const BLOCK = 0x210000;
const OUT = 0x230000;
const COUNT = 0x240000;
const SURFACE_THIS = 0x250000;
const SURFACE_BLOCK = 0x260000;
const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c;
const D3DERR_NOTFOUND = 0x88760866;
/** A pointer above 4 GiB: its low half the out-structure's address. */
const HIGH_OUT = BigInt(OUT) | 1n << 32n;

/** @param {ReturnType<typeof longMachine>} m @param {number} at @param {number[]} words */
const writeWords = (m, at, words)=>{
    const bytes = new Uint8Array(words.length * 4);
    const view = new DataView(bytes.buffer);
    words.forEach((word, i)=>view.setUint32(i * 4, word >>> 0, true));
    m.write(at, bytes);
};
/** @param {ReturnType<typeof longMachine>} m @param {number} at @param {number} count */
const readWords = (m, at, count)=>{
    const bytes = m.read(at, count * 4);
    const view = new DataView(bytes.buffer);
    return Array.from({ length: count }, (_, i)=>view.getUint32(i * 4, true));
};
/** A run of words of their own, one per place. @param {number} seed @param {number} count */
const pattern = (seed, count)=>Array.from({ length: count },
    (_, i)=>(Math.imul(seed + i, 0x9e3779b1) ^ 0x5a5a0000 + i) >>> 0);

/**
 * A machine with the routine at CODE_64, an interface at THIS whose block is
 * BLOCK, and the out-structure prefilled with a pattern.
 *
 * @param {Uint8Array} code @param {(m: ReturnType<typeof longMachine>) => void} [fill]
 */
const world = (code, fill)=>{
    const m = longMachine();
    m.write(TRAP, [0xf4]);
    m.write(RETURN, [0xf4]);
    m.write(CODE_64, code);
    m.setQuad(THIS, 0x7000n);
    m.setQuad(THIS + 8, BigInt(BLOCK));
    m.write(OUT, new Uint8Array(128).fill(0xee));
    fill?.(m);
    return m;
};

/**
 * Runs a call that the routine answers: it returns to the caller with RSP
 * popped of the return address and every register the convention keeps kept.
 *
 * @param {ReturnType<typeof longMachine>} m @param {bigint[]} args
 */
const answered = (m, args)=>{
    const call = callLong(m, CODE_64, { args, returnTo: RETURN });
    assert.equal(m.rip(), RETURN + 1, 'returned to the caller');
    assert.equal(m.reg('rsp'), BigInt(STACK_64 + 8));
    for (const name of KEPT_64.filter(n=>n !== 'rsp'))
    {
        assert.equal(m.reg(name), call.entry[name], name);
    }
    return Number(m.reg('rax') & 0xffffffffn) >>> 0;
};

/**
 * Runs a call the routine leaves to the host: at the trap with the call as
 * it came, and the out-structure untouched.
 *
 * @param {ReturnType<typeof longMachine>} m @param {bigint[]} args
 */
const leftToHost = (m, args)=>{
    const before = m.read(OUT, 128);
    const call = callLong(m, CODE_64, { args, returnTo: RETURN });
    assert.equal(m.rip(), TRAP + 1, 'reached the trap');
    for (const name of ['rcx', 'rdx', 'r8', 'r9', 'rsp'])
    {
        assert.equal(m.reg(name), call.entry[name], name);
    }
    assert.deepEqual(m.read(OUT, 128), before, 'the out-structure untouched');
    assert.equal(readWords(m, BLOCK + SHADOW.HELD, 1)[0], 0, 'the device lock let go');
};

const THIS_ARG = BigInt(THIS);
const OUT_ARG = BigInt(OUT);

test('GetTransform: a type the device answers, its matrix copied out; a world matrix too', ()=>{
    const matrices = pattern(1, 16 * SHADOW.TRANSFORM_SLOTS);
    const fill = (/** @type {any} */ m)=>writeWords(m, BLOCK + SHADOW.TRANSFORMS, matrices);
    for (const [type, slot] of [[2, 2], [3, 3], [17, 17], [256, 24], [259, 27]])
    {
        const m = world(getTransformCode(CODE_64, TRAP, false, X64), fill);
        assert.equal(answered(m, [THIS_ARG, argumentOf(type, 1), OUT_ARG]), D3D_OK);
        assert.deepEqual(readWords(m, OUT, 16), matrices.slice(slot * 16, slot * 16 + 16));
    }
    for (const args of [[THIS_ARG, argumentOf(0, 1), OUT_ARG],
        [THIS_ARG, argumentOf(260, 1), OUT_ARG], [THIS_ARG, argumentOf(2, 1), 0n],
        [THIS_ARG, argumentOf(2, 1), HIGH_OUT]])
    {
        leftToHost(world(getTransformCode(CODE_64, TRAP, false, X64), fill), args);
    }
});

test('GetTextureStageState and GetSamplerState: the value out of its place in the block', ()=>{
    const stages = pattern(2, 8 * SHADOW.STAGE_STATE_STRIDE);
    const samplers = pattern(3, 16 * SHADOW.SAMPLER_STATE_STRIDE);
    const fill = (/** @type {any} */ m)=>{
        writeWords(m, BLOCK + SHADOW.STAGE_STATES, stages);
        writeWords(m, BLOCK + SHADOW.SAMPLER_STATES, samplers);
    };
    const stage = ()=>world(getTextureStageStateCode(CODE_64, TRAP, 0x3fffffe, X64), fill);
    const m = stage();
    assert.equal(answered(m, [THIS_ARG, argumentOf(5, 1), argumentOf(3, 2), OUT_ARG]), D3D_OK);
    assert.equal(readWords(m, OUT, 1)[0], stages[5 * 32 + 3]);
    leftToHost(stage(), [THIS_ARG, argumentOf(8, 1), argumentOf(3, 2), OUT_ARG]);
    leftToHost(stage(), [THIS_ARG, argumentOf(1, 1), argumentOf(0, 2), OUT_ARG]);
    leftToHost(stage(), [THIS_ARG, argumentOf(1, 1), argumentOf(3, 2), HIGH_OUT]);
    const sampler = ()=>world(getSamplerStateCode(CODE_64, TRAP, X64), fill);
    const s = sampler();
    assert.equal(answered(s, [THIS_ARG, argumentOf(15, 1), argumentOf(13, 2), OUT_ARG]), D3D_OK);
    assert.equal(readWords(s, OUT, 1)[0], samplers[15 * 16 + 13]);
    leftToHost(sampler(), [THIS_ARG, argumentOf(16, 1), argumentOf(1, 2), OUT_ARG]);
    leftToHost(sampler(), [THIS_ARG, argumentOf(0, 1), argumentOf(14, 2), OUT_ARG]);
    leftToHost(sampler(), [THIS_ARG, argumentOf(0, 1), argumentOf(1, 2), 0n]);
    leftToHost(sampler(), [THIS_ARG, argumentOf(0, 1), argumentOf(1, 2), HIGH_OUT]);
});

test('GetViewport and Direct3D 8\'s GetVertexShader: copied out of the block', ()=>{
    const viewport = pattern(4, 6);
    const view = ()=>world(getViewportCode(CODE_64, TRAP, X64),
        m=>writeWords(m, BLOCK + SHADOW.VIEWPORT, viewport));
    const m = view();
    assert.equal(answered(m, [THIS_ARG, OUT_ARG]), D3D_OK);
    assert.deepEqual(readWords(m, OUT, 7), [...viewport, 0xeeeeeeee]);
    leftToHost(view(), [THIS_ARG, 0n]);
    leftToHost(view(), [THIS_ARG, HIGH_OUT]);
    leftToHost(world(getViewportCode(CODE_64, TRAP, X64), w=>w.write(BLOCK, [FLAG_SLOW_PATH])),
        [THIS_ARG, OUT_ARG]);
    const shader = ()=>world(getShaderCode(CODE_64, TRAP, 1, X64), w=>writeWords(w,
        BLOCK + SHADOW.SHADERS, [0x11, 0x22, 1]));
    const s = shader();
    assert.equal(answered(s, [THIS_ARG, OUT_ARG]), D3D_OK);
    assert.deepEqual(readWords(s, OUT, 2), [0x22, 0xeeeeeeee]);
    leftToHost(world(getShaderCode(CODE_64, TRAP, 1, X64)), [THIS_ARG, OUT_ARG]);
});

/** A device block whose pair (target or depth) names `pointer` counted in COUNT at `count`. */
const targets = (/** @type {boolean} */ depth, /** @type {number} */ pointer,
    /** @type {number} */ count)=>(/** @type {any} */ m)=>{
    writeWords(m, BLOCK + SHADOW.TARGETS + (depth ? 8 : 0), [pointer, pointer ? COUNT : 0]);
    writeWords(m, BLOCK + SHADOW.TARGETS_VALID, [depth ? 2 : 1]);
    writeWords(m, COUNT, [count]);
};

test('GetRenderTarget: the surface\'s pointer, eight bytes, and the reference it owes', ()=>{
    const code = getTargetCode(CODE_64, TRAP, { depth: false, indexed: true }, X64);
    const m = world(code, targets(false, 0x00345678, 3));
    assert.equal(answered(m, [THIS_ARG, argumentOf(0, 1), OUT_ARG]), D3D_OK);
    assert.equal(m.quad(OUT), 0x00345678n);
    assert.equal(readWords(m, COUNT, 1)[0], 4);
    assert.equal(readWords(m, BLOCK + SHADOW.HELD, 1)[0], 0);
    leftToHost(world(code, targets(false, 0x00345678, 3)), [THIS_ARG, argumentOf(1, 1), OUT_ARG]);
    leftToHost(world(code, targets(false, 0x00345678, 0)), [THIS_ARG, argumentOf(0, 1), OUT_ARG]);
    leftToHost(world(code, targets(false, 0, 0)), [THIS_ARG, argumentOf(0, 1), OUT_ARG]);
    leftToHost(world(code, targets(false, 0x00345678, 3)), [THIS_ARG, argumentOf(0, 1), 0n]);
    leftToHost(world(code, targets(false, 0x00345678, 3)), [THIS_ARG, argumentOf(0, 1), HIGH_OUT]);
    leftToHost(world(code), [THIS_ARG, argumentOf(0, 1), OUT_ARG]);
});

test('GetDepthStencilSurface: none is a null pointer, eight bytes of it, and NOTFOUND', ()=>{
    const code = getTargetCode(CODE_64, TRAP, { depth: true, indexed: false }, X64);
    const m = world(code, targets(true, 0, 0));
    assert.equal(answered(m, [THIS_ARG, OUT_ARG]), D3DERR_NOTFOUND);
    assert.equal(m.quad(OUT), 0n);
    const d = world(code, targets(true, 0x00456789, 1));
    assert.equal(answered(d, [THIS_ARG, OUT_ARG]), D3D_OK);
    assert.equal(d.quad(OUT), 0x00456789n);
    assert.equal(readWords(d, COUNT, 1)[0], 2);
    leftToHost(world(code, targets(true, 0, 0)), [THIS_ARG, HIGH_OUT]);
});

test('a surface\'s GetDesc: the description out of the surface\'s block', ()=>{
    const desc = pattern(5, SURFACE.DESC_WORDS);
    const surface = ()=>world(getSurfaceDescCode(CODE_64, TRAP, X64),
        m=>writeWords(m, BLOCK + SURFACE.DESC, desc));
    const m = surface();
    assert.equal(answered(m, [THIS_ARG, OUT_ARG]), D3D_OK);
    assert.deepEqual(readWords(m, OUT, SURFACE.DESC_WORDS + 1), [...desc, 0xeeeeeeee]);
    leftToHost(surface(), [THIS_ARG, 0n]);
    leftToHost(surface(), [THIS_ARG, HIGH_OUT]);
});

/** A texture block of three levels, the second published as SURFACE_THIS, counted in COUNT. */
const texture = (/** @type {any} */ m)=>{
    writeWords(m, BLOCK + TEXTURE.LEVEL_COUNT, [3]);
    writeWords(m, BLOCK + TEXTURE.COUNT, [COUNT]);
    writeWords(m, BLOCK + TEXTURE.LEVELS, [SURFACE_THIS, SURFACE_THIS, 0]);
    writeWords(m, COUNT, [5]);
    m.setQuad(SURFACE_THIS, 0x7100n);
    m.setQuad(SURFACE_THIS + 8, BigInt(SURFACE_BLOCK));
    writeWords(m, SURFACE_BLOCK + SURFACE.DESC, pattern(6, SURFACE.DESC_WORDS));
};

test('a texture\'s GetSurfaceLevel: the level\'s pointer, eight bytes, and a reference', ()=>{
    const code = getSurfaceLevelCode(CODE_64, TRAP, X64);
    const m = world(code, texture);
    assert.equal(answered(m, [THIS_ARG, argumentOf(1, 1), OUT_ARG]), D3D_OK);
    assert.equal(m.quad(OUT), BigInt(SURFACE_THIS));
    assert.equal(readWords(m, COUNT, 1)[0], 6);
    const past = world(code, texture);
    assert.equal(answered(past, [THIS_ARG, argumentOf(3, 1), OUT_ARG]), D3DERR_INVALIDCALL);
    leftToHost(world(code, texture), [THIS_ARG, argumentOf(2, 1), OUT_ARG]);
    leftToHost(world(code, texture), [THIS_ARG, argumentOf(1, 1), 0n]);
    leftToHost(world(code, texture), [THIS_ARG, argumentOf(1, 1), HIGH_OUT]);
});

test('a texture\'s GetLevelDesc: read through the level\'s block, eight bytes past it', ()=>{
    const code = getLevelDescCode(CODE_64, TRAP, X64);
    const m = world(code, texture);
    assert.equal(answered(m, [THIS_ARG, argumentOf(0, 1), OUT_ARG]), D3D_OK);
    assert.deepEqual(readWords(m, OUT, SURFACE.DESC_WORDS), pattern(6, SURFACE.DESC_WORDS));
    const past = world(code, texture);
    assert.equal(answered(past, [THIS_ARG, argumentOf(3, 1), OUT_ARG]), D3DERR_INVALIDCALL);
    leftToHost(world(code, texture), [THIS_ARG, argumentOf(2, 1), OUT_ARG]);
    leftToHost(world(code, texture), [THIS_ARG, argumentOf(0, 1), HIGH_OUT]);
    leftToHost(world(code, m2=>{
        texture(m2);
        m2.write(SURFACE_BLOCK, [FLAG_SLOW_PATH]);
    }), [THIS_ARG, argumentOf(0, 1), OUT_ARG]);
});
