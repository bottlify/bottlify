/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The far space's direct part (`far-space.js`): a wide window's RAM past 4 GiB,
 * whose chunks are their own frames. A reservation there is placed around what
 * the process already has there, says itself to the process's map, takes no
 * frame from the arena and no entry in the table, charges a chunk the first time
 * it is committed and zeroes it only when it is committed again; past `direct`
 * the table's frames are given as before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFarSpace } from './far-space.js';

const GiB = 2 ** 30;
const CHUNK = 0x10000;

/** @param {{ direct?: number, top?: number, image?: [number, number] }} options */
function space({ direct = 8 * GiB, top = 8 * GiB, image } = {}){
    /** @type {any[]} */
    const said = [];
    let next = 0x100000;
    const far = createFarSpace({
        space: { base: 4 * GiB, top, chunk: CHUNK, direct },
        allocator: {
            allocate: bytes=>{
                said.push(['frame', next]);
                next += bytes;
                return next - bytes;
            },
            free: address=>said.push(['free', address]),
        },
        mapFar: (address, frame)=>said.push(['map', address, frame]),
        room: ()=>true,
        charge: bytes=>{
            said.push(['charge', bytes]);
            return true;
        },
        inTheWay: (from, to)=>(image && image[0] < to && image[1] > from ? image[1] : 0),
        held: (base, span, held)=>said.push(['held', base, span, held]),
        fill: (address, value, length)=>said.push(['fill', address, length]),
    });
    return { far, said };
}

test('a reservation of the direct part is placed past what the process has there', ()=>{
    const image = /** @type {[number, number]} */ ([4 * GiB + 0x40000000, 4 * GiB + 0x40006000]);
    const { far, said } = space({ image });
    const first = far.reserve(0x40000000, 4);
    const second = far.reserve(0x20000000, 4);
    assert.equal(first, 4 * GiB);
    assert.equal(second, 4 * GiB + 0x40010000, 'past the image, on a granule');
    assert.deepEqual(said, [['held', first, 0x40000000, true],
        ['held', second, 0x20000000, true]]);
    assert.equal(far.reserveAt(image[0] - CHUNK, 2 * CHUNK, 4), false, 'over the image');
});

test('a chunk of the direct part is its own frame: charged once, zeroed only when used again',
    ()=>{
        const { far, said } = space();
        const base = far.reserve(4 * CHUNK, 4);
        const made = /** @type {any} */ (far.find(base));
        said.length = 0;
        assert.ok(far.commit(made, base, base + 2 * CHUNK, 4));
        assert.deepEqual(said, [['charge', CHUNK], ['charge', CHUNK]], 'no frame, no entry');
        assert.deepEqual([...made.frames], [[0, base], [1, base + CHUNK]]);
        said.length = 0;
        far.decommit(made, base, base + 2 * CHUNK);
        assert.deepEqual(said, [], 'nothing given back to the arena or the table');
        assert.ok(far.commit(made, base, base + CHUNK, 4));
        assert.deepEqual(said, [['fill', base, CHUNK]], 'charged before, zeroed now');
        said.length = 0;
        far.release(made);
        assert.deepEqual(said, [['held', base, 4 * CHUNK, false]]);
    });

test('past the direct part the table\'s frames are given as before', ()=>{
    const { far, said } = space({ direct: 6 * GiB, top: 16 * GiB });
    const base = /** @type {number} */ (far.reserve(3 * GiB, 4));
    assert.equal(base, 4 * GiB);
    const made = /** @type {any} */ (far.find(base));
    said.length = 0;
    const past = base + 2 * GiB;
    assert.ok(far.commit(made, past, past + CHUNK, 4));
    assert.deepEqual(said, [['frame', 0x100000], ['fill', 0x100000, CHUNK],
        ['map', past, 0x100000]]);
});
