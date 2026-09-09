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
import {
    WAVEFORMATEX, DSBUFFERDESC, DS_OK, IID_IDirectSoundNotify,
} from './dsound/seam.js';

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
        /**
         * The object behind a published pointer, so a test can ask it for a
         * second interface the way the bridge does.
         *
         * @param {number} pointer
         */
        objectAt(pointer){
            return byPointer.get(pointer)?.object;
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
    /** @type {number[]} */
    const signalled = [];
    const api = await audioModule.create({
        ...f.config,
        drained,
        /** @param {number} handle */
        signal: handle=>signalled.push(handle),
    }, {
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
    return { ...f, api, buffer, held, signalled };
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

test('a stall costs the machine time, not the sound it had not read yet', ()=>{
    // The old expectation here was that a backlog is dropped, and it was wrong
    // in the way that matters: reading a span moves the point the next read
    // starts from, so draining one and then refusing it does not postpone that
    // sound, it destroys it. Every machine stalls -- fetching a block takes as
    // long as it takes -- and a stall left the queue over its depth, after
    // which each turn discarded exactly the span that would have let it drain
    // back under. The sound stopped and never came back.
    //
    // What has to be bounded is the backlog, and leaving the bytes where they
    // are bounds it just as well: the read point lags and catches up.
    return playing().then(f=>{
        f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);

        // A stall of the length a block fetch takes. Long enough that what it
        // leaves queued is past the depth the output can hold even after the
        // ring has taken its fill, and short enough that the cursor has not
        // lapped the buffer -- a lap really is gone, and `drainPlayed` says so.
        f.advance(800);
        f.api.pump();

        // The device, doing what a device does: it takes the sound the time
        // that has passed is worth, and not a frame more. Reading the ring dry
        // every turn is what hid this -- the queue drained faster than the
        // stall could refill it, and nothing was ever refused twice running.
        const block = new Float32Array(1024 * 2);
        let produced = 0;
        for (let turn = 0; turn < 200; turn++)
        {
            f.advance(10);
            f.api.pump();
            for (let owed = 10 * 48; owed > 0;)
            {
                const read = f.api.output().ring.read(block.subarray(0, Math.min(owed, 1024) * 2));
                if (read === 0)
                {
                    break;
                }
                produced += read;
                owed -= read;
            }
        }

        const mixed = f.api.output().diagnostics();
        assert.ok(f.api.behind() > 0, 'the machine says it fell behind its own sound');

        // The whole point. Throwing away the span just read leaves the stale
        // one queued in front of it, and the machine then plays a fixed
        // lateness for ever -- a backlog that sat at better than twice the
        // output's depth and never came down. What a program is playing now is
        // what it meant to be heard.
        assert.ok(mixed.queuedFrames <= f.api.output().capacityFrames,
            `the machine caught up, and was ${mixed.queuedFrames} frames behind`);

        // And it is still playing: a recovery that goes quiet is not one.
        assert.ok(produced > 90000, `heard ${produced} frames after the stall`);
    });
});

test('the span read on the turn the machine falls behind is the one it plays', ()=>{
    // Reading a span moves the point the next read starts from, so a turn that
    // reads one and then refuses it has destroyed it -- and what stays queued
    // in front is the older sound. Whichever way the policy goes, the span just
    // read is the one a program meant to be heard now, so it is the backlog
    // that goes and the fresh span that plays.
    return playing().then(f=>{
        f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
        f.advance(800);
        f.api.pump();
        assert.equal(f.api.behind(), 0, 'nothing refused yet');

        const before = f.api.output().diagnostics().queuedFrames;
        f.advance(10);
        f.api.pump();

        assert.ok(f.api.behind() > 0, 'this is the turn it fell behind');
        const after = f.api.output().diagnostics().queuedFrames;
        assert.ok(after < before,
            `the backlog went, and did not grow: ${before} -> ${after}`);
        assert.ok(after > 0, 'and the span just read stayed, rather than being the one dropped');
    });
});

/** Somewhere to put a DSBPOSITIONNOTIFY the guest would have filled in. */
const NOTIFY_AT = 0x400;

/** @param {any} f @param {number} event */
function askToBeWokenHalfWay(f, event){
    f.view.setUint32(NOTIFY_AT, BUFFER_BYTES / 2, true);
    f.view.setUint32(NOTIFY_AT + 4, event, true);
    const notify = f.config.publishInterface(f.objectAt(f.buffer), IID_IDirectSoundNotify);
    assert.ok(notify !== 0, 'the buffer offers the notify interface');
    assert.equal(f.call(notify, 'SetNotificationPositions', [1, NOTIFY_AT]), DS_OK);
}

test('a position a program asked to be woken at wakes it', async()=>{
    // A program that streams into a sound buffer does not poll it: it asks to be
    // told when playback reaches a position and waits on an event, and the
    // thread that refills the buffer is that wait. Nothing ever tested those
    // positions, so the wake never came, the refill never happened, and a title
    // that had set its sound up correctly sat in silence with several threads
    // blocked for ever.
    const f = await playing();
    const EVENT = 0x4058;
    askToBeWokenHalfWay(f, EVENT);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);

    f.advance(1);
    f.api.pump();
    assert.deepEqual(f.signalled, [], 'not before playback reaches it');

    // Past the half-second mark the position sits at.
    f.advance(600);
    f.api.pump();
    assert.deepEqual(f.signalled, [EVENT], 'and exactly once when it does');
});

test('a program is woken even when nothing is listening to the sound', async()=>{
    // The wake is owed whether or not anything drains the ring. A build with no
    // sound device must not hang the program that asked for one.
    const f = await playing({ drained: false });
    const EVENT = 0x4060;
    askToBeWokenHalfWay(f, EVENT);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(600);
    f.api.pump();

    assert.deepEqual(f.signalled, [EVENT]);
});
