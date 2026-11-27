/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTargetReads, playedAtOnce } from './direct3d.js';
import { WAIT } from './wire.js';

/** A surface as `answeredByRenderer` asks it: its description says what it is. */
const surface = (/** @type {number} */ usage)=>({
    GetDesc: (/** @type {any} */ out)=>{
        out.desc = { Usage: usage };
    },
});
const target = ()=>surface(1);

/** A device that counts what was drawn into each surface, as the Direct3D 8 one does. */
const counting = ()=>{
    const drawn = new Map();
    return {
        drawnInto: (/** @type {object} */ one)=>drawn.get(one) ?? 0,
        draw: (/** @type {object} */ one)=>drawn.set(one, (drawn.get(one) ?? 0) + 1),
    };
};

test('a copy out of a target nothing has drawn into since its last read-back is made here', ()=>{
    const reads = createTargetReads();
    const fence = target();
    const image = surface(0);
    const device = counting();
    const copy = ()=>reads.answered(device, 'CopyRects', [fence, null, 0, image, null]);

    assert.equal(copy(), true, 'the first is the renderer');
    assert.equal(copy(), false, 'the second has its answer in the target already');
    device.draw(image);
    assert.equal(copy(), false, 'drawing into another surface leaves it');
    device.draw(fence);
    assert.equal(copy(), true, 'drawn into: asked again');
    assert.equal(copy(), false);

    reads.observe(device, 'CopyRects', [image, null, 0, fence, null]);
    assert.equal(copy(), true, 'copied into: asked again');
    reads.observe(fence, 'LockRect', [{}, null, 0]);
    assert.equal(copy(), true, 'locked to write: asked again');
    reads.observe(fence, 'LockRect', [{}, null, 0x10]);
    assert.equal(copy(), false, 'a lock to read changes nothing');
    reads.observe(device, 'Reset', [{}]);
    assert.equal(copy(), true, 'a Reset forgets every target');
});

test('a device that counts nothing has every copy answered by the renderer', ()=>{
    const reads = createTargetReads();
    const fence = target();
    const copy = ()=>reads.answered({}, 'CopyRects', [fence, null, 0, surface(0), null]);
    assert.equal(copy(), true);
    assert.equal(copy(), true);
});

test('a copy out of what is not a render target is never the renderer\'s', ()=>{
    const reads = createTargetReads();
    assert.equal(reads.answered({}, 'CopyRects', [surface(0), null, 0, surface(0), null]),
        false);
});

/**
 * A played side that reads nothing and gives a batch back when told:
 * what `playedAtOnce` hands it, batch by batch.
 */
const watchedPlayed = ()=>{
    /** @type {ArrayBuffer[]} */
    const read = [];
    /** @type {(() => void)[]} */
    const held = [];
    let holding = false;
    return {
        read, held,
        hold: (/** @type {boolean} */ on)=>{
            holding = on;
        },
        played: {
            read: (/** @type {ArrayBuffer} */ buffer)=>{
                read.push(buffer);
                return undefined;
            },
            play: ()=>undefined,
            spent: (/** @type {ArrayBuffer} */ _buffer, /** @type {() => void} */ give)=>{
                if (holding)
                {
                    held.push(give);
                }
                else
                {
                    give();
                }
            },
        },
    };
};

test('a call played where it is made reads the writer\'s own buffer, given back for the next', ()=>{
    const watched = watchedPlayed();
    const transport = playedAtOnce(/** @type {any} */ (watched.played));
    for (let n = 0; n < 50; n++)
    {
        transport.writer.u32(n);
        transport.called(WAIT.NONE, 'Test');
    }
    assert.equal(watched.read.length, 50);
    // The one read and the one written on next alternate.
    assert.equal(new Set(watched.read).size, 2, 'two buffers for every batch, not a copy of each');
});

test('a batch the played side still keeps a view of is not written over', ()=>{
    const watched = watchedPlayed();
    const transport = playedAtOnce(/** @type {any} */ (watched.played));
    watched.hold(true);
    transport.writer.u32(1);
    transport.called(WAIT.NONE, 'Test');
    watched.hold(false);
    for (const n of [2, 3, 4])
    {
        transport.writer.u32(n);
        transport.called(WAIT.NONE, 'Test');
    }
    assert.ok(watched.read.slice(1).every(buffer=>buffer !== watched.read[0]),
        'the kept one is not written on');
    assert.equal(new Uint32Array(watched.read[0], 0, 1)[0], 1, 'its bytes are as they were');
    for (const give of watched.held)
    {
        give();
    }
    for (let n = 5; n < 50; n++)
    {
        transport.writer.u32(n);
        transport.called(WAIT.NONE, 'Test');
    }
    assert.equal(new Set(watched.read).size, 3, 'a buffer given back is written on again');
});
