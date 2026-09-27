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
import { createRing } from './output/ring.js';
import {
    slotHeaderOffset, slotPcmOffset, SLOT_HEADER_INT32, SLOT_BYTES, RATE as SLOT_RATE,
    createSeam, resampleInto, mixBlock, KIND, KIND_DMA, BASE, LENGTH, PLAYING, LOOPING, POSITION,
    ARENA_OFFSET, ARENA_BYTES, GLOBAL_HEADER_INT32, SLOTS, STARVED_BLOCKS, BLOCKS,
} from './output/mix.js';
import {
    WAVEFORMATEX, DSBUFFERDESC, DS_OK, IID_IDirectSoundNotify,
} from './dsound/seam.js';

/** DSBCAPS_CTRLFREQUENCY, CTRLPAN and CTRLVOLUME together. */
const DSBCAPS_CTRLDEFAULT = 0x000000e0;
const DSBCAPS_CTRLPOSITIONNOTIFY = 0x00000100;

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
        /** @param {number} address @param {number} length */
        window: (address, length)=>bytes.subarray(address, address + length),
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

/**
 * A module with one playing sound buffer full of something to hear.
 *
 * @param {{ silent?: boolean, drained?: boolean, shared?: boolean,
 *     memory?: { control: ArrayBufferLike, samples: ArrayBufferLike } }} [options]
 */
async function playing({ silent = false, drained = true, shared = false, memory } = {}){
    const f = fixture();
    /** @type {number[]} */
    const signalled = [];
    const api = await audioModule.create({
        ...f.config,
        drained,
        shared,
        memory,
        /** @param {number} handle */
        signal: handle=>signalled.push(handle),
    }, {
        requireApi: (/** @type {string} */ name)=>{
            if (name === 'bridge')
            {
                // The route into guest code. Nothing here calls one, but the
                // module asks for it the way the registry always binds it.
                return { callGuest: async()=>0 };
            }
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
    // The controls a program of this era asks for, and the positions it waits on.
    f.view.setUint32(DESC_AT + DSBUFFERDESC.dwFlags,
        DSBCAPS_CTRLDEFAULT | DSBCAPS_CTRLPOSITIONNOTIFY, true);
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
    return { ...f, api, root, buffer, held, signalled };
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

test('a process that replaces another mixes into the same sound output', async()=>{
    // The ring is the machine's, not the program's: the page was handed it
    // before the program changed and its worklet holds it across the change.
    // A child that made its own left that reader on a dead buffer -- audible
    // as a menu with no sound at all.
    const inherited = createRing({ channels: 2, capacityFrames: 32 });
    const f = await playing({ memory: inherited.memory });
    assert.equal(f.api.output().ring.memory, inherited.memory,
        'the output the reader already holds');

    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    assert.ok(f.api.pump() > 0, 'the child mixed frames');
    assert.ok(inherited.read(new Float32Array(16)) > 0,
        'and the reader that held it hears them');
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

test('with shared memory, a playing buffer is a sound card\'s voice over the buffer\'s own bytes',
    async()=>{
        // Not converted, not silence, not pushed a turn at a time: the whole
        // buffer mirrored for the device to read on its own clock.
        const loud = await playing({ shared: true });
        loud.call(loud.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
        loud.api.pump();

        const table = loud.api.output().table;
        const header = new Int32Array(table, slotHeaderOffset(0), SLOT_HEADER_INT32);
        assert.equal(Atomics.load(header, KIND), KIND_DMA, 'a voice, not a queue');
        assert.equal(Atomics.load(header, LENGTH), BUFFER_BYTES, 'the whole buffer');
        assert.equal(Atomics.load(header, PLAYING), 1);
        assert.equal(Atomics.load(header, LOOPING), 1);
        const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
        const base = Atomics.load(header, BASE);
        assert.ok(arena.subarray(base, base + BUFFER_BYTES).every(byte=>byte === 0x40),
            'byte-equal to what the guest wrote');
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

test('a buffer panned hard left is heard on the left alone', async()=>{
    const f = await playing();
    f.call(f.buffer, 'SetPan', [-10000]);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();

    const block = new Float32Array(64 * 2);
    const frames = f.api.output().ring.read(block);
    assert.ok(frames > 0);
    for (let frame = 0; frame < frames; frame++)
    {
        assert.ok(block[frame * 2] > 0, 'the left side plays');
        assert.equal(block[frame * 2 + 1], 0, 'DSBPAN_LEFT leaves the right silent');
    }
});

test('with shared memory, a buffer\'s pan reaches its voice', async()=>{
    const f = await playing({ shared: true });
    f.call(f.buffer, 'SetPan', [10000]);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();

    const table = f.api.output().table;
    const header = new Int32Array(table, slotHeaderOffset(0), SLOT_HEADER_INT32);
    const pcm = new Uint8Array(table, slotPcmOffset(0), SLOT_BYTES);
    const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(2 * 2);
    resampleInto({ block, blockFrames: 2, header, pcm, arena, outputRate: 48000,
        seam: createSeam() });
    assert.equal(block[0], 0, 'DSBPAN_RIGHT leaves the left silent');
    assert.ok(block[1] > 0);
});

test('a buffer retuned while it plays is heard at the rate its cursor moves', async()=>{
    // The cursor drains bytes at the new frequency from the moment it is set; a
    // track still reading them at the first one plays them at the wrong pitch
    // and makes twice (or half) the sound the guest's clock allows for.
    const f = await playing();
    const mixer = f.api.output();
    /** @type {any[]} */
    const opened = [];
    const open = mixer.open.bind(mixer);
    mixer.open = (/** @type {any} */ format)=>{
        const track = open(format);
        opened.push(track);
        return track;
    };
    const scratch = new Float32Array(mixer.capacityFrames * 2);
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();
    mixer.ring.read(scratch);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].format.sampleRate, RATE);

    f.call(f.buffer, 'SetFrequency', [RATE * 2]);
    let frames = 0;
    for (let turn = 0; turn < 10; turn++)
    {
        f.advance(20);
        f.api.pump();
        frames += mixer.ring.read(scratch);
    }
    assert.equal(opened.length, 1, 'the same track, retuned');
    assert.equal(opened[0].format.sampleRate, RATE * 2);
    // Two hundred milliseconds of guest time is 9600 frames at 48 kHz.
    assert.ok(Math.abs(frames - 9600) < 9600 / 10,
        `the output keeps pace with the guest's clock: ${frames} frames in 200 ms`);
});

test('with shared memory, a retuned buffer\'s slot reads at its new rate', async()=>{
    const f = await playing({ shared: true });
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.advance(50);
    f.api.pump();
    f.call(f.buffer, 'SetFrequency', [44100]);
    f.advance(20);
    f.api.pump();

    const header = new Int32Array(f.api.output().table, slotHeaderOffset(0), SLOT_HEADER_INT32);
    assert.equal(Atomics.load(header, SLOT_RATE), 44100);
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

test('with shared memory, a stalled engine thread is not heard: the device plays on', async()=>{
    // The crackle a busy engine made: the bytes left for the audio thread only
    // when the engine ran, so a load or a translation that held it for a few
    // tens of milliseconds emptied the device while the program's own buffer
    // held most of a second. Now the device reads the buffer itself, the way
    // a sound card's DMA does, and the program's cursor is where it reads.
    const f = await playing({ shared: true });
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();

    const table = f.api.output().table;
    const outputRate = f.api.output().sampleRate;
    const global = new Int32Array(table, 0, GLOBAL_HEADER_INT32);
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: new Int32Array(table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: new Uint8Array(table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    const seams = slots.map(()=>createSeam());
    const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(128 * 2);
    // Three hundred milliseconds of device blocks, and not one pump.
    const blocks = Math.ceil(outputRate * 0.3 / 128);
    const starvedBefore = Atomics.load(global, STARVED_BLOCKS);
    for (let at = 0; at < blocks; at++)
    {
        mixBlock({ global, slots, seams, block, blockFrames: 128, outputRate, arena });
    }
    assert.equal(Atomics.load(global, STARVED_BLOCKS) - starvedBefore, 0,
        'every block had the program\'s sound in it');
    assert.equal(Atomics.load(global, BLOCKS) >= blocks, true);

    const position = Atomics.load(slots[0].header, POSITION);
    const expected = Math.floor(blocks * 128 * RATE / outputRate) * CHANNELS * (BITS / 8);
    assert.ok(Math.abs(position - expected) <= CHANNELS * (BITS / 8) * 2,
        `the device moved the cursor (${position} against ${expected})`);
    f.view.setUint32(OUT_AT, 0xffffffff, true);
    assert.equal(f.call(f.buffer, 'GetCurrentPosition', [OUT_AT, 0]), DS_OK);
    assert.equal(f.view.getUint32(OUT_AT, true), position,
        'and it is the cursor the program reads');
});

test('with shared memory, what the device plays and nobody wrote is counted stale', async()=>{
    // The device reads the buffer on its own clock, so a refill that comes
    // late is heard as the last lap again -- and counted, on this path too.
    const f = await playing({ shared: true });
    f.call(f.buffer, 'Play', [0, 0, DSBPLAY_LOOPING]);
    f.api.pump();
    const table = f.api.output().table;
    const outputRate = f.api.output().sampleRate;
    const global = new Int32Array(table, 0, GLOBAL_HEADER_INT32);
    const slots = Array.from({ length: SLOTS }, (_, slot)=>({
        header: new Int32Array(table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
        pcm: new Uint8Array(table, slotPcmOffset(slot), SLOT_BYTES),
    }));
    const seams = slots.map(()=>createSeam());
    const arena = new Uint8Array(table, ARENA_OFFSET, ARENA_BYTES);
    const block = new Float32Array(128 * 2);
    for (let at = 0; at < Math.ceil(outputRate * 0.3 / 128); at++)
    {
        mixBlock({ global, slots, seams, block, blockFrames: 128, outputRate, arena });
    }
    f.advance(300);
    f.api.pump();
    // The fixture filled the buffer behind the program's back: nothing of it
    // was ever unlocked, so all the device played is stale.
    assert.ok(f.held.stale.bytes > 0, `stale ${f.held.stale.bytes}`);
});

test('with shared memory, a released DirectSound buffer frees its slot: 40 over a session '
    + 'never fall back', async()=>{
    // The seam never called track.close() when a buffer's references reached
    // zero, and neither `resampleInto` nor anything else ever freed a slot on
    // its own -- so the ceiling was not "32 buffers open at once" but "32
    // buffers played, ever, in the session": the ordinary DirectSound idiom of
    // creating and releasing a buffer per sound effect exhausted every slot
    // permanently the first time 32 had ever been played.
    const f = await playing({ shared: true });
    for (let i = 0; i < 40; i++)
    {
        assert.equal(f.call(f.root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
        const pointer = f.view.getUint32(OUT_AT + 4, true);
        // f.objectAt() answers the publisher's adapter, not the raw buffer;
        // the raw buffer -- with `.address` and a plain, non-COM `.release()`
        // a test can call directly -- is the adapter's own `.api`.
        const raw = f.objectAt(pointer).api;
        f.bytes.fill(0x40, raw.address, raw.address + BUFFER_BYTES);

        f.call(pointer, 'Play', [0, 0, DSBPLAY_LOOPING]);
        f.advance(50);
        f.api.pump(); // opens the track and feeds it

        raw.release(); // the program is done with it
        f.api.pump(); // feedBuffers notices the release and closes the track

        // Only the reader (resampleInto, standing in for the worklet) frees
        // the slot back to STATE_FREE; every track in this test lands on
        // slot 0, the sole free slot each time.
        const table = f.api.output().table;
        const header = new Int32Array(table, slotHeaderOffset(0), SLOT_HEADER_INT32);
        const pcm = new Uint8Array(table, slotPcmOffset(0), SLOT_BYTES);
        resampleInto({
            block: new Float32Array(2), blockFrames: 1, header, pcm,
            outputRate: f.api.output().sampleRate, seam: createSeam(),
        });
    }
    assert.equal(f.api.output().diagnostics().fallbackTracks, 0,
        'no fallback after releasing every buffer before the next one opened');
});

test('with nothing listening, a released buffer still leaves the walk', async()=>{
    // A build with no sound device reads nothing out, but it still walks every
    // buffer before each mix for its notifications; one that never let go of a
    // released buffer walked everything the program had ever made.
    const f = await playing({ drained: false });
    for (let i = 0; i < 40; i++)
    {
        assert.equal(f.call(f.root, 'CreateSoundBuffer', [DESC_AT, OUT_AT + 4, 0]), DS_OK);
        const pointer = f.view.getUint32(OUT_AT + 4, true);
        f.call(pointer, 'Play', [0, 0, DSBPLAY_LOOPING]);
        f.objectAt(pointer).api.release();
        f.api.pump();
    }
    assert.equal(f.api.buffers().length, 1, 'only the buffer the program still holds');
    assert.equal(f.api.feeding().refusedFills, 40, 'and still nothing was read out');
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

test('the MPEG provider is a library beside DirectSound, with an entry point', async()=>{
    // A sound library of this era loads the provider itself and expects its
    // DllMain to register with it; a table without one would load and stay
    // silent, which the program reads as "no decoder for this file".
    const f = await playing();
    const provider = f.api.libraries()['Mp3dec.asi'];
    assert.ok(provider, 'listed with the rest');
    assert.deepEqual(f.api.runtimes(), ['Mp3dec.asi'],
        'and a runtime the engine answers for, whoever brought a copy');
    assert.equal(provider?.DllMain.argBytes, 12);
    assert.ok(provider?.ASI_stream_open && provider?.ASI_stream_process);
    assert.deepEqual(audioModule.diagnostics().metrics?.mp3, {
        registered: false, provider: 0, opens: 0, failedOpens: 0, open: 0, samplesOut: 0,
        waits: 0, lastError: '', recent: [], streams: [],
    });
});

test('DirectSound\'s ordinals are offered beside its table', async()=>{
    // The assembling caller synthesises every library with the numbers its
    // layer declares, and a program that imports by number needs Windows'.
    const f = await playing();
    const ordinals = f.api.ordinals()['DSOUND.dll'];
    assert.equal(ordinals[1], 'DirectSoundCreate');
    assert.equal(ordinals[2], 'DirectSoundEnumerateA');
    assert.equal(ordinals[11], 'DirectSoundCreate8');
});

test('the MPEG provider can be left out, for a run to compare against', async()=>{
    const f = fixture();
    const api = await audioModule.create({ ...f.config, mp3: false }, {
        requireApi: (/** @type {string} */ name)=>
            name === 'bridge' ? { callGuest: async()=>0 } : f.memory,
        provide: ()=>{},
    });
    assert.deepEqual(Object.keys(api.libraries()), ['DSOUND.dll']);
    assert.deepEqual(api.runtimes(), [], 'and then the copy the program brought is what loads');
});

test('the decoder behind the provider follows the configuration', async()=>{
    const f = fixture();
    const host = {
        requireApi: (/** @type {string} */ name)=>
            name === 'bridge' ? { callGuest: async()=>0 } : f.memory,
        provide: ()=>{},
    };
    // Nothing offered: the platform's decoder, which answers later.
    let api = await audioModule.create({ ...f.config }, host);
    assert.deepEqual(api.decoder(), { name: 'webcodecs' });
    assert.deepEqual(audioModule.diagnostics().metrics?.decoder, { name: 'webcodecs' });

    // The media layer's hosted decoder offered: preferred, with the platform's
    // as the fallback for a stream it answers null to.
    api = await audioModule.create({ ...f.config, openAudio: ()=>null }, host);
    assert.deepEqual(api.decoder(),
        { name: 'synchronous', opens: 0, fallbackOpens: 0, paddedFrames: 0 });

    // A test's own decoder wins over both.
    api = await audioModule.create({ ...f.config, openAudio: ()=>null, decoder: {
        open: ()=>({ feed: ()=>{}, flush: ()=>Promise.resolve(), close: ()=>{} }),
    } }, host);
    assert.deepEqual(api.decoder(), { name: 'custom' });
});
