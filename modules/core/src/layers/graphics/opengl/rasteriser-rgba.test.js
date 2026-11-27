/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the RGBA the processor's rasteriser samples, held in the run's
 * cache (`context-textures.js` `rgbaCache`, `ContextKernel.holdTexels`):
 * seeded programs of textures in several kinds - sized red-green and RGBA
 * levels made into RGBA from their data, S3TC levels decoded from their
 * blocks, RGTC levels converted - written whole and in part between draws
 * that sample them, deleted and made again, drawn on the processor with the
 * RGBA held in a roomy cache and in one too small for all of it, whose blocks
 * come back full of what an earlier holder left there (another pattern than
 * the roomy one's) and are taken by other holders between draws. Every pixel
 * each draw leaves and every level a read-back answers must be the same.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createGlContext } from './context.js';
import { createScratches } from '../../cache/scratch.js';
import { freshSpace, testCache } from '../../cache/testing.fixture.js';

/** @param {number} seed @returns {() => number} 0 up to 2^32 */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

/**
 * The kinds of texture a program makes: its level, given whole, and a part
 * of it written again.
 *
 * @type {{ name: string, make: (gl: any, side: number, bytes: (n: number) => Uint8Array) => void,
 *     write: (gl: any, side: number, next: () => number, bytes: (n: number) => Uint8Array)
 *     => void }[]}
 */
const KINDS = [
    { name: 'rg8',
        make: (gl, side, bytes)=>gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RG8, side, side, 0,
            TEX.RG, GL.UNSIGNED_BYTE, bytes(side * side * 2)),
        write: (gl, side, next, bytes)=>{
            const width = 1 + next() % side;
            const height = 1 + next() % side;
            gl.glTexSubImage2D(GL.TEXTURE_2D, 0, next() % (side - width + 1),
                next() % (side - height + 1), width, height, TEX.RG, GL.UNSIGNED_BYTE,
                bytes(width * height * 2));
        } },
    { name: 'rgba16f',
        make: (gl, side, bytes)=>gl.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, side, side, 0,
            GL.RGBA, GL.UNSIGNED_BYTE, bytes(side * side * 4)),
        write: (gl, side, next, bytes)=>{
            const height = 1 + next() % side;
            gl.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, next() % (side - height + 1), side, height,
                GL.RGBA, GL.UNSIGNED_BYTE, bytes(side * height * 4));
        } },
    { name: 'dxt1',
        make: (gl, side, bytes)=>gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, side, side, 0, side * side / 2,
            bytes(side * side / 2)),
        write: (gl, side, next, bytes)=>gl.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 0,
            4 * (next() % (side / 4)), 4 * (next() % (side / 4)), 4, 4,
            GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, 8, bytes(8)) },
    { name: 'dxt5',
        make: (gl, side, bytes)=>gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, side, side, 0, side * side, bytes(side * side)),
        // A whole level of blocks given again: decoded anew from them.
        write: (gl, side, next, bytes)=>gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, side, side, 0, side * side, bytes(side * side)) },
    { name: 'rgtc2',
        make: (gl, side, bytes)=>gl.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            TEX.COMPRESSED_RG_RGTC2, side, side, 0, side * side, bytes(side * side)),
        write: (gl, side, next, bytes)=>gl.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 0,
            4 * (next() % (side / 4)), 4 * (next() % (side / 4)), 4, 4,
            TEX.COMPRESSED_RG_RGTC2, 16, bytes(16)) },
];

/**
 * Memory held through `space`, each block handed out full of `fill`: what a
 * level reads of its RGBA before writing it shows in the pixels.
 *
 * @param {import('../../cache/module.js').CacheSpace} space @param {number} fill
 * @returns {import('../../cache/scratch.js').Hold}
 */
const filled = (space, fill)=>(key, length)=>{
    const got = space.hold?.(key, length) ?? null;
    got?.bytes.fill(fill);
    return got;
};

/**
 * One seeded program: every draw's pixels and every read-back, in order.
 *
 * @param {number} seed @param {'roomy' | 'cramped'} where
 * @param {{ shared?: boolean }} [options]  `shared`: every level's RGBA in one room, which
 *     the gate must see
 */
async function run(seed, where, { shared = false } = {}){
    const next = random(seed);
    let hold = filled(freshSpace('scratch'), 0x33);
    let others = ()=>{};
    if (where === 'cramped')
    {
        const small = await testCache({ budget: 128 << 10, segmentBytes: 64 << 10 });
        hold = filled(small.space('scratch'), 0xcd);
        let other = 0;
        others = ()=>{
            small.keeper.sweep();
            const taken = [];
            for (let size = 4096; size <= 16384; size *= 2)
            {
                const got = hold(`other/${++other}`, size);
                if (got)
                {
                    got.bytes.fill(0x5a);
                    taken.push(got);
                }
            }
            taken.forEach(got=>got.release());
        };
    }
    const rooms = createScratches(hold);
    const one = rooms.scratch('gl/rgba');
    const guest = new Uint8Array(1 << 16);
    const gl = /** @type {any} */ (createGlContext({
        memory: {
            read: (at, length)=>guest.slice(at, at + length),
            write: (at, value)=>guest.set(value, at),
        },
        holds: shared
            ? (name, length)=>({ bytes: one.bytes(length), release: ()=>{} })
            : (name, length)=>rooms.hold(name, length),
    }));
    gl.attach({ width: 24, height: 24, doubleBuffered: false, depthBits: 0 });
    gl.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    gl.glPixelStorei(GL.PACK_ALIGNMENT, 1);
    gl.glEnable(GL.TEXTURE_2D);
    gl.glTexEnvi(GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE, GL.REPLACE);
    /** @param {number} n */
    const bytes = n=>Uint8Array.from({ length: n }, ()=>next() & 0xff);
    /** @type {{ name: number, kind: typeof KINDS[number], side: number }[]} */
    const textures = [];
    const make = ()=>{
        const [name] = gl.glGenTextures(1);
        const kind = KINDS[next() % KINDS.length];
        const side = 8 << (next() % 3);
        gl.glBindTexture(GL.TEXTURE_2D, name);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER,
            next() % 2 === 0 ? GL.NEAREST : GL.LINEAR);
        kind.make(gl, side, bytes);
        return { name, kind, side };
    };
    for (let made = 0; made < 4; made++)
    {
        textures.push(make());
    }
    /** @type {string[]} */
    const seen = [];
    let heldMost = 0;
    for (let draw = 0; draw < 40; draw++)
    {
        const at = next() % textures.length;
        const texture = textures[at];
        gl.glBindTexture(GL.TEXTURE_2D, texture.name);
        const pick = next() % 8;
        if (pick < 3)
        {
            texture.kind.write(gl, texture.side, next, bytes);
        }
        else if (pick === 3)
        {
            gl.glDeleteTextures([texture.name]);
            textures[at] = make();
        }
        gl.glBindTexture(GL.TEXTURE_2D, textures[at].name);
        others();
        const x = (next() % 100) / 100 - 1;
        const y = (next() % 100) / 100 - 1;
        gl.glBegin(GL.QUADS);
        gl.glTexCoord2f(0, 0);
        gl.glVertex2f(x, y);
        gl.glTexCoord2f(1.5, 0);
        gl.glVertex2f(x + 1, y);
        gl.glTexCoord2f(1.5, 1.5);
        gl.glVertex2f(x + 1, y + 1);
        gl.glTexCoord2f(0, 1.5);
        gl.glVertex2f(x, y + 1);
        gl.glEnd();
        heldMost = Math.max(heldMost, rooms.figures().held);
        seen.push(`${textures[at].kind.name} ${gl.glGetError()} `
            + [...gl.framebuffer.bytes].join(','));
        if (next() % 5 === 0)
        {
            const answer = gl.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
            seen.push(`read ${[...(answer instanceof Uint8Array ? answer : answer.packed)]}`);
        }
    }
    return { seen, heldMost, figures: rooms.figures() };
}

test('the processor\'s rasteriser samples RGBA held in a cramped cache as in a roomy one',
    { timeout: 300_000 }, async()=>{
        let cramped = 0;
        for (const seed of [1, 2, 3, 4, 5, 6, 7, 8])
        {
            const roomy = await run(seed, 'roomy');
            const small = await run(seed, 'cramped');
            assert.equal(small.seen.length, roomy.seen.length, `seed ${seed}`);
            for (let at = 0; at < roomy.seen.length; at++)
            {
                assert.equal(small.seen[at], roomy.seen[at], `seed ${seed}: answer ${at}`);
            }
            assert.ok(roomy.heldMost > 0, `seed ${seed}: levels' RGBA held in the roomy cache`);
            assert.equal(roomy.figures.refused, 0, `seed ${seed}`);
            assert.ok(new Set(roomy.seen).size > roomy.seen.length / 2,
                `seed ${seed}: draws differ`);
            cramped += small.heldMost;
        }
        assert.ok(cramped > 0, 'levels\' RGBA held in the cramped cache');
    });

test('the gate sees levels whose RGBA shares one room', { timeout: 300_000 }, async()=>{
    let differed = 0;
    for (const seed of [1, 2, 3])
    {
        const roomy = await run(seed, 'roomy');
        const shared = await run(seed, 'cramped', { shared: true });
        differed += shared.seen.some((answer, at)=>answer !== roomy.seen[at]) ? 1 : 0;
    }
    assert.ok(differed > 0, 'a level sampled with another\'s RGBA');
});
