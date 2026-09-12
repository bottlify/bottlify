/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    createSoundBuffer, normaliseFormat,
    DSBSTATUS_PLAYING, DSBSTATUS_LOOPING, DSBPLAY_LOOPING,
    DSBLOCK_FROMWRITECURSOR, DSBLOCK_ENTIREBUFFER,
    DSBVOLUME_MIN, DSBVOLUME_MAX, DSBPAN_LEFT, DSBPAN_RIGHT,
} from './buffers.js';

/** 22050 Hz, stereo, 16-bit: 4 bytes a frame, 88200 a second. */
const FORMAT = normaliseFormat({ channels: 2, sampleRate: 22050, bitsPerSample: 16 });
const SECOND = FORMAT.sampleRate * FORMAT.blockAlign;

/**
 * A cursor never splits a frame, so an expectation in bytes has to be rounded
 * the way the buffer rounds it -- a quarter of a second here is 22050 bytes,
 * which is not a whole number of four-byte frames.
 *
 * @param {number} bytes
 */
const aligned = bytes=>bytes - bytes % FORMAT.blockAlign;

/** A clock the test moves by hand, because the arithmetic is what is under test. */
function clock(){
    let ms = 1000;
    return { now: ()=>ms, advance: (/** @type {number} */ by)=>{
        ms += by;
    } };
}

/** @param {any} [options] */
const buffer = (options = {})=>{
    const time = clock();
    return {
        time,
        sound: createSoundBuffer({
            bytes: options.bytes ?? SECOND,
            address: options.address ?? 0x40000000,
            format: FORMAT,
            now: time.now,
            primary: options.primary ?? false,
        }),
    };
};

test('the frame size is derived from the format, not taken from the caller', ()=>{
    // A WAVEFORMATEX whose nBlockAlign disagrees with its channels and depth is
    // common, and every cursor here is in bytes.
    assert.equal(normaliseFormat({ channels: 2, bitsPerSample: 16 }).blockAlign, 4);
    assert.equal(normaliseFormat({ channels: 1, bitsPerSample: 8 }).blockAlign, 1);
    assert.equal(normaliseFormat({ channels: 1, bitsPerSample: 16 }).blockAlign, 2);
});

test('a stopped buffer keeps its cursor where it is', ()=>{
    const { sound, time } = buffer();
    assert.equal(sound.cursors().play, 0);
    time.advance(500);
    assert.equal(sound.cursors().play, 0, 'time passing moves nothing that is not playing');
});

test('the play cursor advances at the format\'s byte rate', ()=>{
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    assert.equal(sound.cursors().play, aligned(SECOND / 4));
    time.advance(250);
    assert.equal(sound.cursors().play, SECOND / 2);
});

test('the write cursor leads the play cursor while playing', ()=>{
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(100);
    const { play, write } = sound.cursors();
    // A program writes ahead of the write cursor; behind the play cursor there
    // is nothing left to write into.
    assert.ok(write > play, `write ${write} must lead play ${play}`);
    assert.ok(write - play < SECOND / 2, 'and not by half the buffer');
});

test('a stopped buffer is almost entirely writable from its write cursor', ()=>{
    const { sound } = buffer();
    const { play, write } = sound.cursors();
    assert.equal(play, 0);
    assert.notEqual(write, play, 'equal cursors read as an empty buffer, not a full one');
    assert.ok(write > SECOND * 0.9, `${write} leaves nearly the whole buffer ahead`);
});

test('a looping buffer wraps; a one-shot stops at the end and says so', ()=>{
    const looping = buffer();
    looping.sound.play(DSBPLAY_LOOPING);
    looping.time.advance(1500);
    assert.equal(looping.sound.cursors().play, SECOND / 2);
    assert.equal(looping.sound.status(), DSBSTATUS_PLAYING | DSBSTATUS_LOOPING);

    const once = buffer();
    once.sound.play(0);
    assert.equal(once.sound.status(), DSBSTATUS_PLAYING);
    once.time.advance(1500);
    assert.equal(once.sound.status(), 0, 'a program waiting on this would wait for ever');
});

test('stopping keeps the position, and playing again continues from it', ()=>{
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    sound.stop();
    assert.equal(sound.cursors().play, aligned(SECOND / 4));
    time.advance(1000);
    assert.equal(sound.cursors().play, aligned(SECOND / 4), 'stopped time does not advance it');
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    assert.equal(sound.cursors().play, aligned(aligned(SECOND / 4) + SECOND / 4),
        'it resumes from where it stopped, not from the beginning');
});

test('changing the frequency changes the rate without moving playback', ()=>{
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    const before = sound.cursors().play;
    sound.setFrequency(FORMAT.sampleRate * 2);
    assert.equal(sound.cursors().play, before, 'the cursor stays where it was');
    time.advance(100);
    assert.equal(sound.cursors().play - before, SECOND / 5, 'and then runs twice as fast');
});

test('a frequency of zero means the format\'s own rate', ()=>{
    const { sound } = buffer();
    sound.setFrequency(11025);
    assert.equal(sound.frequency, 11025);
    sound.setFrequency(0);
    assert.equal(sound.frequency, FORMAT.sampleRate);
});

test('a lock that runs off the end comes back as two ranges', ()=>{
    const { sound } = buffer({ bytes: 4096, address: 0x40000000 });
    const { first, second } = sound.lockRange(4000, 200, 0);
    assert.deepEqual(first, { address: 0x40000000 + 4000, bytes: 96 });
    assert.deepEqual(second, { address: 0x40000000, bytes: 104 },
        'the remainder continues at the start, or the program writes off the end');
    assert.equal(first.bytes + second.bytes, 200);
});

test('a lock that fits comes back as one, with an empty second', ()=>{
    const { sound } = buffer({ bytes: 4096 });
    const { first, second } = sound.lockRange(0, 100, 0);
    assert.equal(first.bytes, 100);
    assert.deepEqual(second, { address: 0, bytes: 0 });
});

test('DSBLOCK_ENTIREBUFFER locks the whole buffer from its beginning', ()=>{
    const { sound, time } = buffer({ bytes: 4096 });
    sound.play(DSBPLAY_LOOPING);
    time.advance(20);
    const { first, second } = sound.lockRange(1234, 7, DSBLOCK_ENTIREBUFFER);
    assert.equal(first.bytes, 4096, 'not a buffer-sized span from wherever the cursor is');
    assert.equal(second.bytes, 0);
});

test('DSBLOCK_FROMWRITECURSOR starts where the write cursor is', ()=>{
    const { sound, time } = buffer({ bytes: 4096, address: 0x40000000 });
    sound.play(DSBPLAY_LOOPING);
    time.advance(10);
    const write = sound.cursors().write;
    const { first } = sound.lockRange(0, 16, DSBLOCK_FROMWRITECURSOR);
    assert.equal(first.address, 0x40000000 + write, 'the offset argument is ignored');
});

test('a request longer than the buffer is clamped to it', ()=>{
    const { sound } = buffer({ bytes: 4096 });
    const { first, second } = sound.lockRange(0, 999999, 0);
    assert.equal(first.bytes + second.bytes, 4096);
});

test('unlock reports what was held, and only once', ()=>{
    const { sound } = buffer({ bytes: 4096 });
    sound.lockRange(0, 100, 0);
    assert.equal(sound.locked, true);
    assert.ok(sound.unlock());
    assert.equal(sound.locked, false);
    assert.equal(sound.unlock(), null, 'a second unlock has nothing to report');
});

test('notifications fire once, in the order the cursor passed them', ()=>{
    const { sound, time } = buffer();
    sound.setNotifications([
        { offset: SECOND / 4, event: 11 },
        { offset: SECOND / 2, event: 22 },
        { offset: (SECOND / 4) * 3, event: 33 },
    ]);
    sound.play(DSBPLAY_LOOPING);
    time.advance(600);
    assert.deepEqual(sound.drainNotifications(), [11, 22]);
    assert.deepEqual(sound.drainNotifications(), [], 'draining twice does not repeat them');
    time.advance(200);
    assert.deepEqual(sound.drainNotifications(), [33]);
});

test('a notification behind the cursor fires when the buffer wraps past it', ()=>{
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(800);
    sound.drainNotifications();
    sound.setNotifications([{ offset: SECOND / 8, event: 7 }]);
    time.advance(400); // past the end, round to 200ms
    assert.deepEqual(sound.drainNotifications(), [7],
        'comparing offsets instead of testing the crossing would miss this');
});

test('volume and pan are clamped to their documented bounds', ()=>{
    const { sound } = buffer();
    assert.equal(sound.volume, DSBVOLUME_MAX, 'a new buffer is at full volume');
    sound.setVolume(-99999);
    assert.equal(sound.volume, DSBVOLUME_MIN);
    sound.setVolume(500);
    assert.equal(sound.volume, DSBVOLUME_MAX);
    sound.setPan(-99999);
    assert.equal(sound.pan, DSBPAN_LEFT);
    sound.setPan(99999);
    assert.equal(sound.pan, DSBPAN_RIGHT);
});

test('references are counted and never go below zero', ()=>{
    const { sound } = buffer();
    assert.equal(sound.references, 1);
    assert.equal(sound.addRef(), 2);
    assert.equal(sound.release(), 1);
    assert.equal(sound.release(), 0);
    assert.equal(sound.release(), 0);
});

test('every cursor lands on a frame boundary', ()=>{
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    for (const step of [1, 3, 7, 13, 29])
    {
        time.advance(step);
        const { play, write } = sound.cursors();
        assert.equal(play % FORMAT.blockAlign, 0, `play ${play} splits a frame`);
        assert.equal(write % FORMAT.blockAlign, 0, `write ${write} splits a frame`);
    }
});

test('setting the position moves the cursor and does not fire what it passed', ()=>{
    const { sound } = buffer();
    sound.setNotifications([{ offset: SECOND / 2, event: 5 }]);
    sound.setCurrentPosition(SECOND * 0.75);
    assert.equal(sound.cursors().play, aligned(SECOND * 0.75));
    assert.deepEqual(sound.drainNotifications(), [],
        'a seek is not playback, and nothing was heard on the way');
});

test('the bytes playback passed are read out, which is what makes it audible', ()=>{
    // Every cursor moved and every notification fired while nothing was ever
    // read out of the buffer, so a program behaved correctly and was silent.
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);

    // The read runs to the write cursor, not the play cursor: the span between
    // them is what a real device has fetched already, and fetched here it is
    // what the ring holds against a turn longer than one device block. Read
    // only to the play cursor, every such turn was heard as a click.
    const lead = sound.cursors().write;
    assert.ok(lead > 0, 'the write cursor leads');
    assert.deepEqual(sound.drainPlayed(), [{ from: 0, bytes: lead }], 'the lead, at once');
    time.advance(250);
    assert.deepEqual(sound.drainPlayed(), [{ from: lead, bytes: aligned(SECOND / 4) }],
        'then exactly what playback advanced by');
    assert.deepEqual(sound.drainPlayed(), [], 'and it is not handed over twice');
    assert.equal(lead + aligned(SECOND / 4), sound.cursors().write, 'up to the write cursor');
});

test('stopping and playing again resumes the read from the cursor', ()=>{
    // What was read ahead of the stop is already on its way to the device; a
    // resume reads it again rather than leaving a hole the length of the lead
    // between where the program sees the cursor and where the read had got.
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    sound.drainPlayed();
    sound.stop();
    assert.deepEqual(sound.drainPlayed(), [], 'a stopped buffer reads nothing');

    sound.play(DSBPLAY_LOOPING);
    const [range] = sound.drainPlayed();
    assert.equal(range.from, sound.cursors().play, 'from the cursor');
    assert.equal(range.from + range.bytes, sound.cursors().write, 'to the lead');
});

test('a span that runs off the end comes back as the two ranges it is', ()=>{
    // The buffer is circular; one range would silently drop the wrap.
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(900);
    sound.drainPlayed();

    time.advance(200);
    const ranges = sound.drainPlayed();
    assert.equal(ranges.length, 2);
    assert.equal(ranges[0].from + ranges[0].bytes, SECOND, 'the first runs to the end');
    assert.equal(ranges[1].from, 0, 'and the second continues at the start');
});

test('a buffer that ran to its end hands over its tail, not nothing', ()=>{
    // A one-shot stops and its cursor reads zero again. Comparing cursors alone
    // would call that no progress and drop everything after the last look.
    const { sound, time } = buffer();
    sound.play(0);
    time.advance(400);
    sound.drainPlayed();

    const read = sound.cursors().write;

    time.advance(1000);
    assert.equal(sound.status() & DSBSTATUS_PLAYING, 0, 'it finished');
    const [tail] = sound.drainPlayed();
    assert.equal(tail.from, read, 'from where the read had got to');
    assert.equal(tail.from + tail.bytes, SECOND, 'the rest of the buffer');
    assert.deepEqual(sound.drainPlayed(), [], 'and nothing more');
});

test('putting the cursor somewhere does not play everything in between', ()=>{
    const { sound, time } = buffer();
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    sound.drainPlayed();

    sound.setCurrentPosition(aligned(SECOND * 0.75));
    const [range] = sound.drainPlayed();
    assert.equal(range.from, aligned(SECOND * 0.75), 'only from the new position');
    assert.equal(range.from + range.bytes, sound.cursors().write, 'and only the lead');
});

test('volume is decibels, and a gain is what a mixer can use', ()=>{
    // Hundredths of a decibel, zero being full. Read as a fraction, every quiet
    // sound plays at nearly full volume.
    const { sound } = buffer();
    assert.equal(sound.gain, 1);

    sound.setVolume(-600);
    assert.ok(Math.abs(sound.gain - 0.5) < 0.01, 'six decibels down is about half');

    sound.setVolume(DSBVOLUME_MIN);
    assert.equal(sound.gain, 0, 'and the floor is silence, not almost silence');
});

test('a one-shot that finishes before it is ever drained still hands over its sound', ()=>{
    // A menu click is short enough to play out between two fills of the ring.
    // Draining sees the cursor back at zero, and the whole sound must not be
    // dropped as no progress.
    const { sound, time } = buffer();
    sound.play(0);
    time.advance(1500);
    assert.equal(sound.status() & DSBSTATUS_PLAYING, 0, 'it finished');
    const ranges = sound.drainPlayed();
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].from, 0, 'from the beginning');
    assert.equal(ranges[0].bytes, SECOND, 'the whole buffer, once');
    assert.deepEqual(sound.drainPlayed(), [], 'and not a second time');
});

test('a lap replayed because the refill was late is counted as stale', ()=>{
    // Everything a program can observe is right when its refill is late: the
    // cursor moves on and the bytes it passes are handed over as usual. What
    // is heard is the previous lap again, and this is the only count of it.
    const { sound, time } = buffer();
    sound.lockRange(0, SECOND / 2, 0);
    sound.unlock();
    sound.play(DSBPLAY_LOOPING);
    const lead = sound.cursors().write;
    for (let quarter = 0; quarter < 4; quarter++)
    {
        time.advance(250);
        sound.drainPlayed();
    }
    // The half that was never written, plus the write lead that ran past the
    // end of the lap into bytes already handed over once.
    assert.equal(sound.stale.bytes, SECOND / 2 + lead);
    assert.equal(sound.stale.drains, 3, 'the first quarter was written; the rest were not');
});

test('a buffer refilled ahead of the cursor has nothing stale', ()=>{
    const { sound, time } = buffer();
    sound.lockRange(0, 0, DSBLOCK_ENTIREBUFFER);
    sound.unlock();
    sound.play(DSBPLAY_LOOPING);
    // Two laps, each quarter refilled from the write cursor just before the
    // drain that hands it over -- the streaming loop every program runs. A
    // little past the quarter, as a program does: a quarter of a second is
    // not a whole number of frames, and the cursor rounds each one its way.
    for (let quarter = 0; quarter < 8; quarter++)
    {
        time.advance(250);
        sound.lockRange(0, aligned(SECOND / 4) + 64, DSBLOCK_FROMWRITECURSOR);
        sound.unlock();
        sound.drainPlayed();
    }
    assert.equal(sound.stale.bytes, 0);
    assert.equal(sound.stale.drains, 0);
});
