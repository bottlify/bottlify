/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Dynamic rings as a renderer streams them, as a gate: a vertex ring and an
 * index ring many pages long, written a batch at a time under NOOVERWRITE and
 * started over under DISCARD -- which the guest's lock answers by moving the
 * buffer onto another storage of its own (`d3d8/storages.js`) -- each batch
 * drawn indexed from where it was written, locks held across draws and calls
 * into the host, and frames left queued for the graphics worker while the
 * next ones are written. The frames gate (`frames-contract.itest.js`) streams
 * buffers of one page each; a ring of many pages is what a page's bookkeeping
 * -- what was written, sent, compared, uploaded -- meets at its edges.
 *
 * What is compared: every draw the GPU is given, as it would read it at its
 * submit (`gpuReads`), down the guest code against every call a trap, both
 * recorded for a twin that draws, as in a graphics worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3D9, HWND, OUT, SOFTWARE_VERTEXPROCESSING, machine, random }
    from './guest-machine.itest.js';
import { gpuReads, idle } from './frames-contract.itest.js';

/** @typedef {import('./guest-machine.itest.js').Call} Call */

const D3DUSAGE_WRITEONLY = 0x8;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DPOOL_DEFAULT = 0;
const D3DFMT_INDEX16 = 101;
const D3DLOCK_NOOVERWRITE = 0x1000;
const D3DLOCK_DISCARD = 0x2000;
const D3DPT_TRIANGLELIST = 4;
const D3DRS_LIGHTING = 137;
/** Position and colour. */
const FVF = 0x042;
const STRIDE = 16;
/** The rings: 24 pages of vertices, 8 of indices. */
const VERTEX_BYTES = 96 << 10;
const INDEX_BYTES = 32 << 10;
const UNIT = /** @type {const} */ ({ vertices: STRIDE, indices: 2 });
const TOTAL = /** @type {const} */ ({ vertices: VERTEX_BYTES / STRIDE, indices: INDEX_BYTES / 2 });

const DEVICE = '#1';
/** The program's names for the two rings, in the order it makes them. */
const NAME = /** @type {const} */ ({ vertices: '#2', indices: '#3' });

/**
 * @typedef {'vertices' | 'indices'} Ring
 *
 * @typedef {{ kind: 'lock', on: Ring, offset: number, size: number, flags: number,
 *     fill: number, reach: number }
 *     | { kind: 'hold', on: Ring, offset: number, size: number, flags: number }
 *     | { kind: 'write', on: Ring, offset: number, size: number, fill: number, reach: number }
 *     | { kind: 'release', on: Ring }
 *     | { kind: 'draw', base: number, min: number, count: number, start: number,
 *         triangles: number }
 *     | { kind: 'host' } | { kind: 'present' } | { kind: 'turns', count: number }} Step
 *
 * A lock is taken, written and let go of at once; a hold is a lock left held,
 * written through by the writes after it and let go of by a release. A write
 * of indices names vertices below `reach`, counted from the draw's base. A
 * draw names its vertices as MinIndex and NumVertices. `host` is a call the
 * host answers, which makes the ring's draws; `turns` lets the graphics
 * worker's chain run that many turns, replaying the frames queued so far.
 */

/**
 * What the program writes: each byte a function of the fill and its place,
 * so a byte left from another batch differs; indices below the reach.
 *
 * @param {Ring} on @param {number} offset @param {number} size
 * @param {number} fill @param {number} reach
 */
const bytesFor = (on, offset, size, fill, reach)=>(on === 'indices'
    ? new Uint8Array(Uint16Array.from({ length: size / 2 },
        (unused, i)=>(fill + i * 7 + (i % 3) * 11) % reach).buffer)
    : Uint8Array.from({ length: size }, (unused, i)=>(fill + (offset + i) * 13) & 0xff));

/**
 * A renderer's frames: batches of vertices and indices appended to the two
 * rings under NOOVERWRITE, each ring started over under DISCARD when a batch
 * does not fit, sometimes into a lock held for several batches, each batch
 * drawn indexed; calls into the host now and then, fewer in half the
 * programs, so that a ring goes round more than once before the host looks;
 * and turns of the graphics worker's chain after most presents, none after
 * some, so that frames queue. The promises a lock's flags make are kept: a
 * NOOVERWRITE lock writes only past what was drawn since the last DISCARD.
 *
 * @param {number} seed @param {number} frames  how many
 * @param {{ short?: boolean }} [options]  `short`: a draw names fewer vertices
 *     than its indices reach, as a program whose MinIndex and NumVertices are
 *     wrong does
 * @returns {Step[]}
 */
export function rings(seed, frames, options = {}){
    const { below } = random(seed);
    /** Where each ring's next unit goes. */
    const cursor = { vertices: 0, indices: 0 };
    /** The lock held of each ring, and its end in units. @type {Record<Ring, number | null>} */
    const held = { vertices: null, indices: null };
    /** @type {Step[]} */
    const steps = [];
    const calm = below(2) === 0;
    /**
     * Room for `units` more in a ring: in its held lock where it has room
     * left, written there; otherwise let go of, and locked anew after the
     * last batch or, where the batch does not fit, from the start.
     *
     * @param {Ring} on @param {number} units @param {number} fill @param {number} reach
     * @returns {number} the batch's first unit
     */
    const place = (on, units, fill, reach)=>{
        const unit = UNIT[on];
        const end = held[on];
        if (end !== null && cursor[on] + units <= end)
        {
            const first = cursor[on];
            steps.push({ kind: 'write', on, offset: first * unit, size: units * unit, fill,
                reach });
            cursor[on] = first + units;
            return first;
        }
        if (end !== null)
        {
            steps.push({ kind: 'release', on });
            held[on] = null;
        }
        let first = cursor[on];
        let flags = D3DLOCK_NOOVERWRITE;
        if (first + units > TOTAL[on])
        {
            first = 0;
            flags = D3DLOCK_DISCARD;
        }
        if (below(4) === 0)
        {
            const last = Math.min(TOTAL[on], first + units + below(TOTAL[on] >> 2));
            steps.push({ kind: 'hold', on, offset: first * unit, size: (last - first) * unit,
                flags });
            steps.push({ kind: 'write', on, offset: first * unit, size: units * unit, fill,
                reach });
            held[on] = last;
        }
        else
        {
            steps.push({ kind: 'lock', on, offset: first * unit, size: units * unit, flags, fill,
                reach });
        }
        cursor[on] = first + units;
        return first;
    };
    for (let frame = 0; frame < frames; frame++)
    {
        const batches = 2 + below(calm ? 40 : 12);
        for (let batch = 0; batch < batches; batch++)
        {
            const vertices = 3 + below(below(4) === 0 ? 1500 : 200);
            const triangles = 1 + below(Math.min(300, vertices * 2));
            const fill = 1 + below(250);
            const base = place('vertices', vertices, fill, 0);
            const start = place('indices', triangles * 3, fill, vertices);
            const count = options.short && below(2) === 0 ? 1 + below(vertices) : vertices;
            steps.push({ kind: 'draw', base, min: 0, count, start, triangles });
            if (below(calm ? 40 : 8) === 0)
            {
                steps.push({ kind: 'host' });
            }
        }
        steps.push({ kind: 'present' });
        if (below(3) !== 0)
        {
            steps.push({ kind: 'turns', count: below(4) });
        }
    }
    for (const on of /** @type {Ring[]} */ (['vertices', 'indices']))
    {
        if (held[on] !== null)
        {
            steps.push({ kind: 'release', on });
        }
    }
    return steps;
}

/**
 * The program run on one machine: what the GPU was given, and how often the
 * guest code moved a ring and took a call.
 *
 * @param {boolean} guestCode @param {Step[]} steps
 * @param {boolean} [worker]  whether the device records for a twin that draws, as in a
 *     graphics worker
 * @param {string[]} [traps]  the parts of the guest code kept as traps (`guestTraps`)
 */
export async function play(guestCode, steps, worker = true, traps = []){
    const m = machine(D3D9, guestCode, { gpu: true, worker, traps });
    const gpu = gpuReads(/** @type {any} */ (m.gpu));
    /** @param {string} method @param {any[]} [args] @returns {Call} */
    const device = (method, args = [])=>({ on: DEVICE, kind: 'device', method, args });
    let moves = 0;
    let hostCalls = 0;
    let inGuest = 0;
    /** @param {Call} call */
    const run = call=>{
        const answer = m.run(call);
        if (answer.traps.length === 0)
        {
            inGuest++;
        }
        return answer;
    };
    run({ on: '#0', kind: 'root', method: 'CreateDevice', args: [0, 1, HWND,
        SOFTWARE_VERTEXPROCESSING, { words: D3D9.presentParameters }, 'out'] });
    run(device('CreateVertexBuffer', [VERTEX_BYTES, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, FVF,
        D3DPOOL_DEFAULT, 'out', 0]));
    run(device('CreateIndexBuffer', [INDEX_BYTES, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY,
        D3DFMT_INDEX16, D3DPOOL_DEFAULT, 'out', 0]));
    run(device('SetRenderState', [D3DRS_LIGHTING, 0]));
    run(device('SetFVF', [FVF]));
    run(device('SetStreamSource', [0, NAME.vertices, 0, STRIDE]));
    run(device('SetIndices', [NAME.indices]));
    /** Where each ring's last lock put its first byte, for the writes after it. */
    const lockedAt = { vertices: 0, indices: 0 };
    /** @param {Ring} on @param {number} offset @param {number} size @param {number} flags */
    const lock = (on, offset, size, flags)=>{
        const answer = run({ on: NAME[on], kind: on, method: 'Lock',
            args: [offset, size, 'out', flags] });
        assert.equal(answer.eax, 0, `the ${on}' lock is taken`);
        const at = m.memory.readU32(OUT);
        if (answer.traps.length === 0 && at - offset !== m.countOf(NAME[on])?.base)
        {
            moves++;
        }
        lockedAt[on] = at - offset;
    };
    /** @param {Ring} on @param {number} offset @param {number} size @param {number} fill @param {number} reach */
    const write = (on, offset, size, fill, reach)=>m.memory.writeBytes(lockedAt[on] + offset,
        bytesFor(on, offset, size, fill, reach));
    /** @param {Ring} on */
    const unlock = on=>run({ on: NAME[on], kind: on, method: 'Unlock', args: [] });
    /** @param {number} base @param {number} min @param {number} count @param {number} start @param {number} triangles */
    const draw = (base, min, count, start, triangles)=>run(device('DrawIndexedPrimitive',
        [D3DPT_TRIANGLELIST, base, min, count, start, triangles]));
    const present = ()=>{
        run(device('EndScene'));
        run(device('Present', [0, 0, 0, 0]));
        run(device('BeginScene'));
    };

    // A frame to have the pipeline made before the frames compared: a draw
    // whose pipeline is not ready is left out of its frame.
    run(device('BeginScene'));
    lock('vertices', 0, 3 * STRIDE, D3DLOCK_DISCARD);
    write('vertices', 0, 3 * STRIDE, 1, 0);
    unlock('vertices');
    lock('indices', 0, 6, D3DLOCK_DISCARD);
    write('indices', 0, 6, 1, 3);
    unlock('indices');
    draw(0, 0, 3, 0, 1);
    present();
    await idle(m.gpu);
    gpu.length = 0;
    moves = 0;
    inGuest = 0;

    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            lock(step.on, step.offset, step.size, step.flags);
            write(step.on, step.offset, step.size, step.fill, step.reach);
            unlock(step.on);
        }
        else if (step.kind === 'hold')
        {
            lock(step.on, step.offset, step.size, step.flags);
        }
        else if (step.kind === 'write')
        {
            write(step.on, step.offset, step.size, step.fill, step.reach);
        }
        else if (step.kind === 'release')
        {
            unlock(step.on);
        }
        else if (step.kind === 'draw')
        {
            draw(step.base, step.min, step.count, step.start, step.triangles);
        }
        else if (step.kind === 'host')
        {
            if (run(device('ValidateDevice', ['out'])).traps.length > 0)
            {
                hostCalls++;
            }
        }
        else if (step.kind === 'present')
        {
            present();
        }
        else
        {
            for (let turn = 0; turn < step.count; turn++)
            {
                await new Promise(resolve=>setImmediate(resolve));
            }
        }
    }
    run(device('EndScene'));
    run(device('Present', [0, 0, 0, 0]));
    await idle(m.gpu);
    return { gpu, moves, hostCalls, inGuest };
}

/**
 * Where two runs part: the first draw that differs.
 *
 * @param {string[]} one @param {string[]} other
 */
const parting = (one, other)=>{
    const at = one.findIndex((line, i)=>line !== other[i]);
    if (at < 0 && one.length === other.length)
    {
        return null;
    }
    const index = at < 0 ? Math.min(one.length, other.length) : at;
    return `draw ${index} of ${one.length}/${other.length}: every call a trap gives `
        + `${(one[index] ?? 'nothing').slice(0, 300)}, the guest code `
        + `${(other[index] ?? 'nothing').slice(0, 300)}`;
};

test('Direct3D 9: rings of vertices and indices streamed a batch at a time, started over under'
    + ' DISCARD and drawn from frames left queued, give the GPU what every call a trap does,'
    + ' recorded for a graphics worker', async()=>{
    /** @type {string[]} */
    const wrong = [];
    let moves = 0;
    let hostCalls = 0;
    for (let seed = 1; seed <= 12 && wrong.length === 0; seed++)
    {
        const steps = rings(seed, 30);
        const trapped = await play(false, steps);
        const guest = await play(true, steps);
        moves += guest.moves;
        hostCalls += guest.hostCalls;
        const found = parting(trapped.gpu, guest.gpu);
        if (found)
        {
            wrong.push(`seed ${seed}: ${found}`);
        }
    }
    assert.deepEqual(wrong, []);
    assert.ok(moves > 20, `DISCARDs moved the rings onto storages of their own (${moves})`);
    assert.ok(hostCalls > 20, `calls into the host made the ring's draws (${hostCalls})`);
});

/**
 * A batch of vertices locked, written and let go of, counted in vertices.
 *
 * @param {number} offset @param {number} count @param {number} flags @param {number} fill
 */
const vertices = (offset, count, flags, fill)=>/** @type {Step} */ ({ kind: 'lock', on: 'vertices',
    offset: offset * STRIDE, size: count * STRIDE, flags, fill, reach: 0 });
/**
 * A batch of indices, counted in indices: from the start under DISCARD,
 * further on under NOOVERWRITE.
 *
 * @param {number} offset @param {number} count @param {number} fill @param {number} reach
 */
const indices = (offset, count, fill, reach)=>/** @type {Step} */ ({ kind: 'lock', on: 'indices',
    offset: offset * 2, size: count * 2,
    flags: offset === 0 ? D3DLOCK_DISCARD : D3DLOCK_NOOVERWRITE, fill, reach });
/** @param {number} base @param {number} count @param {number} start */
const draw = (base, count, start)=>/** @type {Step} */ ({ kind: 'draw', base, min: 0, count, start,
    triangles: 100 });
const HOST = /** @type {Step} */ ({ kind: 'host' });
const PRESENT = /** @type {Step} */ ({ kind: 'present' });

test('Direct3D 9: a ring started over in place and appended to before the host looks keeps the'
    + ' frames queued before it, recorded for a graphics worker', async()=>{
    // A frame drawn from the end of the ring's first lap is left queued. The
    // ring is started over under a DISCARD with no draw in the command ring
    // -- taken in place, in the guest -- and appended to under NOOVERWRITE
    // before the host looks, which replays the two as one lock: it has to
    // rename the GPU's copy as the DISCARD alone does. The second lap then
    // reaches the first one's end in a lock the guest holds, and its draw
    // sends what it wrote: the queued frame still draws the first lap.
    const steps = [vertices(0, 4096, D3DLOCK_DISCARD, 11), indices(0, 300, 11, 512),
        draw(3584, 512, 0), PRESENT,
        vertices(0, 512, D3DLOCK_DISCARD, 22), vertices(512, 64, D3DLOCK_NOOVERWRITE, 33),
        indices(300, 300, 22, 576), draw(0, 576, 300), HOST,
        /** @type {Step} */ ({ kind: 'hold', on: 'vertices', offset: 576 * STRIDE,
            size: 3584 * STRIDE, flags: D3DLOCK_NOOVERWRITE }),
        /** @type {Step} */ ({ kind: 'write', on: 'vertices', offset: 576 * STRIDE,
            size: 3584 * STRIDE, fill: 44, reach: 0 }),
        indices(600, 300, 44, 512), draw(3584, 512, 600), HOST,
        /** @type {Step} */ ({ kind: 'release', on: 'vertices' }), PRESENT,
        /** @type {Step} */ ({ kind: 'turns', count: 4 })];
    const trapped = await play(false, steps);
    const guest = await play(true, steps);
    assert.equal(parting(trapped.gpu, guest.gpu), null);
    assert.ok(guest.inGuest > 8, `the locks and draws were the guest's (${guest.inGuest})`);
});

test('Direct3D 9: a ring moved onto another storage draws what it wrote there past the lock the'
    + ' host holds for the guest, recorded for a graphics worker', async()=>{
    // A DISCARD under a draw comes to the host, which gives the ring a spare
    // storage; the next one moves the ring onto it in the guest, which writes
    // a long stretch more there before the ring's first draw from it reads
    // the start. On the GPU's side every page of the storage is the copy's
    // old bytes until a draw reaches it, and the unlock of a lock this long
    // sends only what was written since. Then a batch is let go of and the
    // next one held, so the host holds a lock for the guest's when it next
    // looks, and a draw of the stretch written before the first draw reads
    // it -- past the lock the host holds.
    const steps = [vertices(0, 256, D3DLOCK_DISCARD, 11), indices(0, 300, 11, 256),
        draw(0, 256, 0), vertices(0, 256, D3DLOCK_DISCARD, 12), indices(300, 300, 12, 256),
        draw(0, 256, 300), PRESENT, /** @type {Step} */ ({ kind: 'turns', count: 4 }),
        vertices(256, 256, D3DLOCK_NOOVERWRITE, 13), indices(600, 300, 13, 256),
        draw(256, 256, 600),
        vertices(0, 512, D3DLOCK_DISCARD, 14), vertices(512, 4096, D3DLOCK_NOOVERWRITE, 15),
        indices(900, 300, 14, 512), draw(0, 512, 900), HOST,
        vertices(4608, 64, D3DLOCK_NOOVERWRITE, 16),
        /** @type {Step} */ ({ kind: 'hold', on: 'vertices', offset: 4672 * STRIDE,
            size: 256 * STRIDE, flags: D3DLOCK_NOOVERWRITE }),
        /** @type {Step} */ ({ kind: 'write', on: 'vertices', offset: 4672 * STRIDE,
            size: 256 * STRIDE, fill: 17, reach: 0 }),
        indices(1200, 300, 15, 4096), draw(512, 4096, 1200), HOST,
        /** @type {Step} */ ({ kind: 'release', on: 'vertices' }), PRESENT];
    const trapped = await play(false, steps);
    const guest = await play(true, steps);
    assert.equal(parting(trapped.gpu, guest.gpu), null);
    assert.ok(guest.moves >= 1, `the guest moved the ring (${guest.moves})`);
});

test('Direct3D 9: the moves kept as traps (`guestTraps: [\'moves\']`) leave every DISCARD of a'
    + ' ring under draws to the host, and the GPU is given what every call a trap gives it',
async()=>{
    // The switch that tells a fault in the guest's moves from one elsewhere
    // in its locks: the locks stay the guest's, a DISCARD the guest would
    // have answered with a move comes to the host.
    let moves = 0;
    let inGuest = 0;
    for (let seed = 1; seed <= 4; seed++)
    {
        const steps = rings(seed, 30);
        const trapped = await play(false, steps);
        const kept = await play(true, steps, true, ['moves']);
        assert.equal(parting(trapped.gpu, kept.gpu), null, `seed ${seed}`);
        moves += kept.moves;
        inGuest += kept.inGuest;
    }
    assert.equal(moves, 0, 'no ring moved in the guest');
    assert.ok(inGuest > 100, `the locks and draws were still the guest's (${inGuest})`);
});
