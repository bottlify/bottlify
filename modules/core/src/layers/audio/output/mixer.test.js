/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createMixer } from './mixer.js';
import {
    WRITTEN, DROP_TO, READ, STATE, STATE_FREE, SLOTS, MIXED_FRAMES, slotHeaderOffset, slotPcmOffset,
    SLOT_HEADER_INT32, SLOT_BYTES, RATE, createSeam, resampleInto, FRESH, STREAMING, BASE,
    STATE_OPEN, STATE_CLOSING, DEVICE_LEAD_MS,
} from './mix.js';

/**
 * A view of the sound output's table at `offset`, as the device makes one:
 * the table is a view of memory the run holds, so offsets count from its start.
 *
 * @template {Int32ArrayConstructor | Uint8ArrayConstructor} K
 * @param {K} Kind @param {Uint8Array} table @param {number} offset @param {number} length
 * @returns {InstanceType<K>}
 */
const tableView = (Kind, table, offset, length)=>/** @type {InstanceType<K>} */ (
    new Kind(/** @type {ArrayBuffer} */ (table.buffer), table.byteOffset + offset, length));

/** Sixteen-bit stereo at the output's own rate: no conversion in the way. */
const DIRECT = { sampleRate: 48000, channels: 2, bitsPerSample: 16 };

/** @param {number[]} samples signed 16-bit, interleaved */
const pcm16 = samples=>{
    const bytes = new Uint8Array(samples.length * 2);
    const view = new DataView(bytes.buffer);
    samples.forEach((value, at)=>view.setInt16(at * 2, value, true));
    return bytes;
};

/** @param {any} mixer @param {number} slot */
const slotView = (mixer, slot)=>({
    header: tableView(Int32Array, mixer.table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
    pcm: tableView(Uint8Array, mixer.table, slotPcmOffset(slot), SLOT_BYTES),
});

test('with a shared table, write puts the guest\'s own bytes into the slot', ()=>{
    // There is no `convert` in this backend's own module for a spy to catch --
    // its absence is the point -- so the assertion is on the observable
    // instead: the bytes that land in the slot are the bytes that went in,
    // unrounded, and `WRITTEN` moved by exactly that many.
    const mixer = createMixer();
    const track = mixer.open(DIRECT);
    const written = pcm16([1234, -1234, 5678, -5678]);

    // The return value is output frames, not bytes taken -- `DIRECT` is the
    // output's own rate, so two stereo input frames are two output frames.
    const taken = track.write(written);
    assert.equal(taken, 2, 'the whole buffer fit, as output frames');

    const { header, pcm } = slotView(mixer, track.slot);
    assert.equal(Atomics.load(header, WRITTEN), written.length,
        'WRITTEN moved by the guest\'s own bytes, unrounded');
    assert.deepEqual([...pcm.subarray(0, written.length)], [...written],
        'byte-equal: nothing converted it');
});

test('with a shared table, a retuned track tells the reader its new rate', ()=>{
    const mixer = createMixer({ sampleRate: 48000 });
    const track = mixer.open({ sampleRate: 22050, channels: 2, bitsPerSample: 16 });
    track.retune(44100);
    const { header } = slotView(mixer, track.slot);
    assert.equal(Atomics.load(header, RATE), 44100, 'the audio thread resamples from it');
    assert.equal(track.format.sampleRate, 44100);
    assert.equal(track.capacityFrames, 44100 / 5, 'two hundred milliseconds at the new rate');
    assert.equal(track.write(pcm16(new Array(882).fill(0))), 480,
        'what a write became is counted at the new rate too');
});

test('with a shared table, pump() allocates no Float32Array', ()=>{
    const seen = { count: 0 };
    class CountingFloat32Array extends Float32Array {
        /** @param {ConstructorParameters<typeof Float32Array>} args */
        constructor(...args){
            super(...args);
            seen.count++;
        }
    }
    const realFloat32Array = globalThis.Float32Array;
    globalThis.Float32Array = /** @type {any} */ (CountingFloat32Array);
    try
    {
        const mixer = createMixer();
        const track = mixer.open(DIRECT);
        track.write(pcm16([1000, 1000]));
        seen.count = 0;
        mixer.pump();
        assert.equal(seen.count, 0, 'no Float32Array was allocated by pump()');
    }
    finally
    {
        globalThis.Float32Array = realFloat32Array;
    }
});

test('with a shared table, playedBytes() credits a one-frame probe whole: held, once the '
    + 'reader\'s READ passes it; playing, at once, within the adapter\'s lead', ()=>{
    const mixer = createMixer();
    const track = mixer.open(DIRECT); // the output's own rate: no resampling in the way
    const probe = pcm16([1000, -1000]);
    track.paused = true;
    track.write(probe);
    assert.equal(track.playedBytes(), 0, 'not played until the reader has looked at it');

    // Stand in for the audio thread: advance READ the way resampleInto does.
    const { header } = slotView(mixer, track.slot);
    Atomics.store(header, READ, probe.length);

    assert.equal(track.playedBytes(), probe.length, 'credited whole once READ passed it');

    const playing = mixer.open(DIRECT);
    playing.write(probe);
    assert.equal(playing.playedBytes(), probe.length, 'playing: taken whole at once');
});

test('the audio adapter: a track tells what it took DEVICE_LEAD_MS ahead of the audio thread,'
    + ' never past what was written, never back, and not while it is held', ()=>{
    const lead = 48000 * DEVICE_LEAD_MS / 1000 * 4;
    const shared = createMixer();
    const table = shared.open(DIRECT);
    const { header } = slotView(shared, table.slot);
    table.paused = true;
    table.write(new Uint8Array(lead * 2));
    assert.equal(table.playedBytes(), 0, 'held, as a stream before its Start: not taken');
    table.paused = false;
    assert.equal(table.playedBytes(), lead, 'let go: the lead taken at once');
    Atomics.store(header, READ, 1000);
    assert.equal(table.playedBytes(), 1000 + lead, 'the lead ahead of what the reader read');
    Atomics.store(header, READ, lead * 2 - 4);
    assert.equal(table.playedBytes(), lead * 2, 'never past what was written');
    table.paused = true;
    Atomics.store(header, READ, lead);
    assert.equal(table.playedBytes(), lead * 2, 'never back');
    table.reset();
    assert.equal(table.playedBytes(), 0, 'from zero after a reset');
});

test('with a shared table, a backlog past the depth sets DROP_TO', ()=>{
    const mixer = createMixer({ sampleRate: 48000 });
    const track = mixer.open(DIRECT);
    // 12,000 frames (48,000 samples, stereo) -- past capacityFrames (9,600, 200
    // ms at 48 kHz) and still under one slot's 65,536-byte ring.
    track.write(pcm16(new Array(24000).fill(1000)));

    assert.ok(track.pending() > track.capacityFrames, 'the assumption under this test');
    track.reset();

    const { header } = slotView(mixer, track.slot);
    assert.equal(Atomics.load(header, DROP_TO), Atomics.load(header, WRITTEN),
        'DROP_TO caught up to WRITTEN');
    assert.equal(track.pending(), 0, 'and the track\'s own view agrees');
});

test('with a shared table, a closed slot is freed by the reader and reused', ()=>{
    // SLOTS slots (mix.js): fill them all, close one, and the next
    // open() must reuse it -- otherwise a game that opens and closes many
    // short-lived buffers over a session exhausts every slot and falls back
    // permanently.
    const mixer = createMixer();
    const tracks = [];
    for (let i = 0; i < SLOTS; i++)
    {
        tracks.push(mixer.open(DIRECT));
    }
    assert.equal(mixer.open(DIRECT).slot, -1, 'one track past them falls back: no free slot');

    const closing = tracks[5];
    const closedSlot = closing.slot;
    closing.close();

    // Only the reader (resampleInto, here standing in for the worklet) may
    // free the slot -- closing it alone must not make it reusable yet.
    assert.equal(mixer.open(DIRECT).slot, -1, 'still no free slot before the reader has run');

    const { header, pcm } = slotView(mixer, closedSlot);
    const block = new Float32Array(2);
    resampleInto({
        block, blockFrames: 1, header, pcm, outputRate: mixer.sampleRate, seam: createSeam(),
    });
    assert.equal(Atomics.load(header, STATE), STATE_FREE, 'the reader freed it');

    const reused = mixer.open(DIRECT);
    assert.equal(reused.slot, closedSlot, 'the next open() reuses the freed slot');
});

test('with a shared table, write() returns output frames, not bytes', ()=>{
    // 100 ms of 22,050 Hz stereo 16-bit is 8820 bytes and 4800 frames at the
    // output's 48 kHz: a caller that carries the figure into an arithmetic built
    // on frames (the DirectShow film sync, `PlaySound`'s loop) got a number
    // nearly double what it means when the answer was bytes.
    const format = { sampleRate: 22050, channels: 2, bitsPerSample: 16 };
    const pcm = pcm16(new Array(2205 * 2).fill(1000)); // 100 ms, stereo
    const frames = createMixer().open(format).write(pcm);
    // A flat ratio, not the real resampler, which holds a fractional frame
    // back at the tail for the seam.
    assert.ok(Math.abs(frames - 4800) <= 5, `${frames} frames for 100 ms`);
});
test('with a shared table, a fallback track\'s write() also answers in output frames', ()=>{
    const mixer = createMixer();
    for (let i = 0; i < SLOTS; i++)
    {
        mixer.open(DIRECT);
    }
    const format = { sampleRate: 22050, channels: 2, bitsPerSample: 16 };
    const fallback = mixer.open(format);
    assert.equal(fallback.slot, -1, 'the assumption under this test: no free slot left');

    const pcm = pcm16(new Array(2205 * 2).fill(1000));
    const frames = fallback.write(pcm);
    const expected = Math.round(pcm.length / 4 * mixer.sampleRate / format.sampleRate);
    assert.equal(frames, expected,
        `a fallback track counted in bytes rather than frames: ${frames}`);
});

test('a mixer that attaches to a table it did not open sweeps every inherited slot', ()=>{
    // A process replacement, not a device replacement: the parent's track
    // objects are gone, but nothing else was ever going to mark their slots
    // CLOSING. Without the sweep, every slot the parent had open is
    // permanently lost -- the child can never reuse it, however many
    // buffers the program that survives the replacement opens and closes.
    const parent = createMixer();
    for (let i = 0; i < SLOTS; i++)
    {
        parent.open(DIRECT);
    }

    const child = createMixer({ memory: parent.memory });
    assert.equal(child.open(DIRECT).slot, -1,
        'the sweep marks the inherited slots CLOSING, not FREE yet');

    // Only the reader (resampleInto, standing in for the worklet) frees a
    // CLOSING slot, exactly as it does for a track this same machine closed.
    for (let slot = 0; slot < SLOTS; slot++)
    {
        const { header, pcm } = slotView(child, slot);
        resampleInto({
            block: new Float32Array(2), blockFrames: 1, header, pcm,
            outputRate: child.sampleRate, seam: createSeam(),
        });
    }

    const reused = child.open(DIRECT);
    assert.notEqual(reused.slot, -1,
        'the reader freed an inherited slot, and the child reused it');
});

test('with a shared table, a backlog drop does not let write() overrun what the reader has not '
    + 'read', ()=>{
    // write()'s room must be sized against READ alone. DROP_TO is only the
    // reader's next instruction and does not take effect until the reader's
    // next block, so sizing room against it (as if the ring were already
    // empty) lets a write land on bytes the reader may still be mid-block
    // on -- a torn block, heard as a click, once per drop.
    const mixer = createMixer();
    const track = mixer.open(DIRECT); // the direct-copy path: 4 bytes/frame

    const quarter = SLOT_BYTES / 4;
    track.write(pcm16(new Array(3 * quarter / 2).fill(1000))); // three quarters full
    track.reset(); // DROP_TO catches up to WRITTEN; READ (the reader's own) does not move

    // Sized as though the ring were now empty, this would fit whole.
    track.write(pcm16(new Array(quarter / 2 + 100).fill(2000)));

    const { header } = slotView(mixer, track.slot);
    const written = Atomics.load(header, WRITTEN);
    const read = Atomics.load(header, READ);
    assert.ok(written - read <= SLOT_BYTES,
        `write() let the ring hold ${written - read} bytes queued, more than its `
                + `${SLOT_BYTES}`);
});

test('with a shared table, a film\'s owed-ms arithmetic does not inflate: write() and played() '
    + 'agree in one unit', ()=>{
    // app.js's film sync computes `owed = written - track.played()` in output
    // frames and turns it into milliseconds. Before this fix `write()`
    // answered in bytes: for a 22,050 Hz stereo film, `owed` grew by roughly
    // `bytesPerFrame * filmRate / outputRate` per real second (about 837 ms/s)
    // and the picture crawled at a fraction of real speed for the whole
    // cinematic. One second of sound, fully played, must leave `owed` near 0.
    const mixer = createMixer();
    const track = mixer.open({ sampleRate: 22050, channels: 2, bitsPerSample: 16 });

    let written = 0;
    // Ten 100 ms buffers, as app.js's showVideoFrame hands over one per tick.
    for (let i = 0; i < 10; i++)
    {
        written += track.write(pcm16(new Array(2205 * 2).fill(1000)));
    }
    // Stand in for the audio thread having genuinely played all of it: one
    // second of sound resampled to the output's 48 kHz is 48,000 output
    // frames, the true figure `played()` would show -- computed here from the
    // output rate, not from `written`, so this does not tautologically agree
    // with whatever unit `write()` happens to be using.
    const { header } = slotView(mixer, track.slot);
    Atomics.store(header, MIXED_FRAMES, mixer.sampleRate);

    const owed = Math.max(0, written - track.played());
    assert.ok(owed <= 5, `owed ${owed} output frames after a second fully played -- ` +
        'the film and its sound would be running at different speeds');
});

test('with a shared table, reset() restarts playedBytes() at zero, the way waveOutReset expects',
    ()=>{
        const mixer = createMixer();
        const track = mixer.open(DIRECT);
        track.write(pcm16([1000, 1000, 2000, 2000]));

        const { header } = slotView(mixer, track.slot);
        Atomics.store(header, READ, Atomics.load(header, WRITTEN)); // the reader consumed it
        assert.ok(track.playedBytes() > 0, 'the assumption under this test');

        track.reset();
        assert.equal(track.playedBytes(), 0,
            'what played before the reset is not owed to whatever comes after it');
    });

test('with a shared table, a short write drops what does not fit rather than queuing it '
    + 'for later', ()=>{
    // Unlike the engine ring's write(), whose only caller re-offers exactly
    // what a short write left over, this slot's only caller (`module.js`'s
    // `feedBuffers`) does not: a range drainPlayed() hands over is already in
    // the past by the time it is offered, so there is nothing later to offer
    // it again to. SLOT_BYTES is a second, harder cap behind the 200 ms
    // backlog policy, and what does not fit past it is dropped, not queued.
    const mixer = createMixer();
    const track = mixer.open(DIRECT);

    const almostFull = pcm16(new Array((SLOT_BYTES - 8) / 2).fill(1000));
    const firstTaken = track.write(almostFull);
    assert.ok(firstTaken > 0, 'the assumption under this test');

    // Only 8 bytes of room are left; this offers 20.
    track.write(pcm16([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    const { header } = slotView(mixer, track.slot);
    assert.equal(Atomics.load(header, WRITTEN), almostFull.length + 8,
        'only the room available fit; the remainder was dropped, not queued for a later write');
});

test('a voice written in sequence while it plays is a stream, and a jump moves it on', ()=>{
    const mixer = createMixer();
    const voice = mixer.openVoice({ ...DIRECT, bytes: 4000 });
    assert.ok(voice);
    const header = tableView(Int32Array, mixer.table,
        slotHeaderOffset(voice.slot), SLOT_HEADER_INT32);
    voice.play(true);
    voice.wrote(0, 4000);
    assert.equal(Atomics.load(header, STREAMING), 0, 'a buffer rewritten once is not one');
    voice.wrote(0, 400);
    assert.equal(Atomics.load(header, STREAMING), 1);
    assert.equal(Atomics.load(header, FRESH), 400);
    voice.wrote(1000, 400);
    assert.equal(Atomics.load(header, FRESH), 1400, 'a jump ahead moves it on');
    voice.wrote(0, 100);
    assert.equal(Atomics.load(header, FRESH), 1400, 'and it never moves back');
    voice.play(true);
    assert.equal(Atomics.load(header, STREAMING), 0, 'Play ends a stream');
});

test('a voice written whole again and again while it plays is no stream', ()=>{
    // Locked whole every few tens of milliseconds, to mix into part of it:
    // counted as a stream written to the end of the lap, the device waited
    // silent at every turn of the circle -- a tick a lap.
    const mixer = createMixer();
    const voice = mixer.openVoice({ ...DIRECT, bytes: 4000 });
    assert.ok(voice);
    const header = tableView(Int32Array, mixer.table,
        slotHeaderOffset(voice.slot), SLOT_HEADER_INT32);
    voice.play(true);
    for (let write = 0; write < 5; write++)
    {
        voice.wrote(0, 4000);
        assert.equal(Atomics.load(header, STREAMING), 0);
    }
    voice.wrote(0, 400);
    voice.wrote(400, 400);
    assert.equal(Atomics.load(header, STREAMING), 1, 'written in pieces after, it is one');
    voice.wrote(0, 4000);
    assert.equal(Atomics.load(header, STREAMING), 0, 'and a whole write ends it');
});

test('a mixer beside another on one table leaves the other\'s slots open, plays its voices in the'
    + ' span it was lent, and closes its own when it goes', ()=>{
    // Two processes at once on one thread: a child started beside its parent
    // is not the parent's replacement, and the parent goes on playing.
    const voice = { ...DIRECT, bytes: 4096 };
    const parent = createMixer();
    const theirs = /** @type {any} */ (parent.openVoice(voice));
    const base = (/** @type {any} */ mixer, /** @type {number} */ slot)=>
        Atomics.load(slotView(mixer, slot).header, BASE);
    const lent = 1 << 20;
    const span = parent.lend(lent);
    assert.ok(span >= 0, 'the parent had room to lend');

    const child = createMixer({ memory: parent.memory,
        beside: { arena: [span, lent] } });
    const state = (/** @type {number} */ slot)=>Atomics.load(slotView(parent, slot).header, STATE);
    assert.equal(state(theirs.slot), STATE_OPEN, 'the parent\'s voice still plays');

    const mine = /** @type {any} */ (child.openVoice(voice));
    assert.notEqual(mine.slot, theirs.slot);
    const at = base(child, mine.slot);
    assert.ok(at >= span && at + voice.bytes <= span + lent,
        'the child\'s mirror is in the span it was lent');
    const parents = base(parent, theirs.slot);
    assert.ok(at >= parents + voice.bytes || at + voice.bytes <= parents,
        'and nowhere in the parent\'s');

    child.close();
    assert.equal(state(mine.slot), STATE_CLOSING, 'what the child held goes with it');
    assert.equal(state(theirs.slot), STATE_OPEN, 'and the parent\'s does not');
    const free = parent.diagnostics().arenaFree;
    parent.takeBack(span, lent);
    assert.equal(parent.diagnostics().arenaFree, free + lent, 'the span is the parent\'s again');
});

test('a mixer pumps its own fill, once a mix', ()=>{
    let fills = 0;
    const mixer = createMixer({ fill: ()=>{
        fills++;
    } });
    mixer.open(DIRECT).write(pcm16([1, 2]));
    mixer.pump();
    mixer.pump();
    assert.equal(fills, 2);
});
