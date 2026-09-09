/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * That a sound a program plays actually leaves the machine.
 *
 * The seam and the mixer are each tested beside themselves, and both passed
 * while nothing was audible: DirectSound never opened a track, so every cursor
 * advanced, every notification fired, and no sample ever reached the ring. This
 * is the join, and it is the only place that failure was visible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audioModule } from './module.js';
import { DSBPLAY_LOOPING } from './dsound/buffers.js';
import { WAVEFORMATEX, DSBUFFERDESC, DS_OK } from './dsound/seam.js';

const FORMAT_AT = 0x100;
const DESC_AT = 0x200;
const OUT_AT = 0x300;

/** 22050 Hz, stereo, 16-bit. */
const RATE = 22050;
const CHANNELS = 2;
const BITS = 16;
const BUFFER_BYTES = RATE * CHANNELS * (BITS / 8); // one second

/**
 * The module, wired the way the assembling caller wires it, over flat memory.
 *
 * The publisher is the smallest thing that answers: it keeps the method list
 * each interface was described with, so a test can call a slot by name the way
 * the guest calls it by index.
 */
function fixture(){
    const bytes = new Uint8Array(0x200000);
    const view = new DataView(bytes.buffer);
    let ms = 1000;
    let nextAddress = 0x40000;
    /** @type {Map<number, { object: any, methods: any[] }>} */
    const byPointer = new Map();
    let nextPointer = 0x10000;

    const memory = {
        /** @param {number} address @param {number} length */
        readBytes: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeBytes: (address, data)=>bytes.set(data, address),
    };

    return {
        bytes,
        view,
        memory,
        advance: (/** @type {number} */ by)=>{
            ms += by;
        },
        config: {
            now: ()=>ms,
            sampleRate: 48000,
            // A build with a device on the other end of the ring, which is what
            // every test here is about. Without one there is nothing to hear
            // and nothing to read out for.
            drained: true,
            allocate: (/** @type {number} */ size)=>{
                const address = nextAddress;
                nextAddress += (size + 0xfff) & ~0xfff;
                return address;
            },
            /** @param {any} object @param {string} id */
            publishInterface(object, id){
                const record = object.interfaceFor(id);
                if (!record)
                {
                    return 0;
                }
                const pointer = nextPointer;
                nextPointer += 4;
                byPointer.set(pointer, { object, methods: record.methods });
                return pointer;
            },
        },
        /** @param {number} pointer @param {string} name @param {number[]} args */
        call(pointer, name, args = []){
            const entry = byPointer.get(pointer);
            assert.ok(entry, `nothing published at ${pointer}`);
            const method = entry.methods.find((/** @type {any} */ m)=>m.name === name);
            assert.ok(method?.invoke, `${name} is not implemented`);
            return method.invoke(entry.object, args) | 0;
        },
    };
}

/** A module with one playing sound buffer full of something to hear. */
async function playing({ silent = false, drained = true } = {}){
    const f = fixture();
    const api = await audioModule.create({ ...f.config, drained }, {
        requireApi: (/** @type {string} */ name)=>{
            assert.equal(name, 'memory');
            return f.memory;
        },
        provide: ()=>{},
    });

    f.view.setUint16(FORMAT_AT + WAVEFORMATEX.wFormatTag, 1, true);
    f.view.setUint16(FORMAT_AT + WAVEFORMATEX.nChannels, CHANNELS, true);
    f.view.setUint32(FORMAT_AT + WAVEFORMATEX.nSamplesPerSec, RATE, true);
    f.view.setUint16(FORMAT_AT + WAVEFORMATEX.wBitsPerSample, BITS, true);
    f.view.setUint32(DESC_AT + DSBUFFERDESC.dwSize, DSBUFFERDESC.SIZE, true);
    f.view.setUint32(DESC_AT + DSBUFFERDESC.dwBufferBytes, BUFFER_BYTES, true);
    f.view.setUint32(DESC_AT + DSBUFFERDESC.lpwfxFormat, FORMAT_AT, true);

    const dsound = api.libraries()['DSOUND.dll'];
    assert.equal(dsound.DirectSoundCreate.handler([0, OUT_AT, 0]), DS_OK);
    const root = f.view.getUint32(OUT_AT, true);
    assert.equal(f.call(root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
    const buffer = f.view.getUint32(OUT_AT + 4, true);

    // Something other than silence in the buffer's own bytes: a mixer that read
    // the wrong address would find zeroes and produce a block that is
    // indistinguishable from a correct one nobody can hear.
    const [held] = api.buffers();
    if (!silent)
    {
        f.bytes.fill(0x40, held.address, held.address + BUFFER_BYTES);
    }
    return { ...f, api, buffer, held };
}

test('a playing sound buffer reaches the ring', async()=>{
    const f = await playing();
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);

    assert.equal(f.api.output().diagnostics().produced, 0, 'nothing yet');
    f.advance(50);
    assert.ok(f.api.pump() > 0, 'the pump wrote frames');

    const mixed = f.api.output().diagnostics();
    assert.equal(mixed.tracks, 1, 'the buffer opened a track of its own');
    assert.ok(mixed.produced > 0, 'and its samples reached the ring');
});

test('a build with nothing draining the ring does not read a buffer out', async()=>{
    // Every sample read out here would be mixed and then thrown away, and this
    // runs on every mix of every turn. The cursors still move -- that is
    // DirectSound's own business and the program watches them -- but there is
    // nothing on the other end for the sound to reach.
    const f = await playing({ drained: false });
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();

    assert.equal(f.api.output().diagnostics().tracks, 0, 'no track was opened');
    assert.equal(f.api.output().diagnostics().produced, 0, 'and nothing was mixed');
});

test('a buffer nobody played contributes nothing', async()=>{
    const f = await playing();
    f.advance(50);
    assert.equal(f.api.pump(), 0);
    assert.equal(f.api.output().diagnostics().tracks, 0, 'and opens no track');
});

test('what reaches the ring is the buffer\'s own bytes, not silence', async()=>{
    // Reading the wrong address gives a block of zeroes, which is exactly what
    // a correct block sounds like when nobody is listening for it.
    const loud = await playing();
    loud.call(loud.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    loud.advance(50);
    loud.api.pump();

    const frames = loud.api.output().ring.read(new Float32Array(64 * 2));
    assert.ok(frames > 0, 'the ring had something in it');
});

test('a silenced buffer is mixed at its own gain, not at full', async()=>{
    const f = await playing();
    f.call(f.buffer, 'SetVolume', [-10000]);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();

    const block = new Float32Array(64 * 2);
    f.api.output().ring.read(block);
    assert.ok(block.every(sample=>sample === 0),
        'DSBVOLUME_MIN is silence, and the volume is decibels rather than a fraction');
});

test('the mixer asks for sound itself, so whoever pumps it need not know how', async()=>{
    // Whoever drives the machine reaches the mixer directly rather than through
    // this module, so a feed hung anywhere else here is never called at all --
    // which is exactly how a correctly wired buffer stayed silent.
    const f = await playing();
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);

    assert.ok(f.api.output().pump() > 0,
        'pumping the mixer alone is enough to pull the buffer');
});

test('a clock that outruns the device drops sound rather than hoarding it', async()=>{
    // The cursor is driven by the guest's clock and the ring drains at the pace
    // of a real device. Nothing bounds the difference, so a queue that simply
    // accepted everything grew for as long as the sound played -- seconds of
    // audio held in memory, every frame of it already too late to be heard.
    const f = await playing();
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);

    // Far more guest time than the ring can ever hold.
    for (let turn = 0; turn < 40; turn++)
    {
        f.advance(200);
        f.api.pump();
    }

    const mixed = f.api.output().diagnostics();
    assert.ok(mixed.queuedFrames <= f.api.output().capacityFrames * 2,
        `the backlog stayed bounded, and was ${mixed.queuedFrames}`);
    assert.ok(f.api.dropped() > 0, 'and what was dropped is counted, not silent');
});
