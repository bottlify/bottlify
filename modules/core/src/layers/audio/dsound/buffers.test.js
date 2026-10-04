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
    DSBVOLUME_MIN, DSBVOLUME_MAX, DSBPAN_LEFT, DSBPAN_RIGHT, DSBPN_OFFSETSTOP,
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
    const { first, second } = sound.lockRange(4000, 200, 0) ?? assert.fail();
    assert.deepEqual(first, { address: 0x40000000 + 4000, bytes: 96 });
    assert.deepEqual(second, { address: 0x40000000, bytes: 104 },
        'the remainder continues at the start, or the program writes off the end');
    assert.equal(first.bytes + second.bytes, 200);
});

test('a lock that fits comes back as one, with an empty second', ()=>{
    const { sound } = buffer({ bytes: 4096 });
    const { first, second } = sound.lockRange(0, 100, 0) ?? assert.fail();
    assert.equal(first.bytes, 100);
    assert.deepEqual(second, { address: 0, bytes: 0 });
});

test('DSBLOCK_ENTIREBUFFER locks a whole lap from the offset, wrapping', ()=>{
    const { sound } = buffer({ bytes: 4096, address: 0x40000000 });
    assert.deepEqual(sound.lockRange(1234, 7, DSBLOCK_ENTIREBUFFER), {
        first: { address: 0x40000000 + 1234, bytes: 4096 - 1234 },
        second: { address: 0x40000000, bytes: 1234 },
    });
});

test('DSBLOCK_FROMWRITECURSOR starts where the write cursor is', ()=>{
    const { sound, time } = buffer({ bytes: 4096, address: 0x40000000 });
    sound.play(DSBPLAY_LOOPING);
    time.advance(10);
    const write = sound.cursors().write;
    const { first } = sound.lockRange(0, 16, DSBLOCK_FROMWRITECURSOR) ?? assert.fail();
    assert.equal(first.address, 0x40000000 + write, 'the offset argument is ignored');
});

test('a lock of nothing, past the end, longer than the buffer or over a held one is refused', ()=>{
    const { sound } = buffer({ bytes: 4096 });
    assert.equal(sound.lockRange(0, 4097, 0), null);
    assert.equal(sound.lockRange(100, 0, 0), null);
    assert.equal(sound.lockRange(4096, 8, 0), null);
    assert.ok(sound.lockRange(0, 4096, 0));
    assert.equal(sound.lockRange(0, 0, DSBLOCK_ENTIREBUFFER), null, 'over a range still held');
    assert.equal(sound.unlock(), true);
    assert.ok(sound.lockRange(0, 1024, 0));
    assert.ok(sound.lockRange(1024, 1024, 0), 'locks side by side');
    assert.equal(sound.lockRange(1000, 100, 0), null);
});

test('unlock reports what was held, and only once', ()=>{
    const { sound } = buffer({ bytes: 4096 });
    sound.lockRange(0, 100, 0);
    assert.equal(sound.locked, true);
    assert.ok(sound.unlock());
    assert.equal(sound.locked, false);
    assert.equal(sound.unlock(), false, 'a second unlock has nothing to report');
});

test('each range of a wrapped lock is let go of by its own pointer', ()=>{
    const { sound } = buffer({ bytes: 4096, address: 0x40000000 });
    sound.lockRange(3000, 2000, 0);
    assert.equal(sound.unlock([0x12345678]), false, 'a pointer the lock never handed out');
    assert.equal(sound.unlock([0x40000000 + 3000]), true);
    assert.equal(sound.locked, true, 'the range at the start is still held');
    assert.equal(sound.unlock([0x40000000 + 3000]), false);
    assert.equal(sound.unlock([0x40000000]), true);
    assert.equal(sound.locked, false);
    assert.ok(sound.lockRange(0, 8, 0));
    // Handed a held range and then one that is not, the first is let go of.
    sound.lockRange(100, 8, 0);
    assert.equal(sound.unlock([0x40000000 + 100, 0x12345678]), false);
    assert.equal(sound.unlock([0x40000000]), true);
    assert.equal(sound.locked, false);
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

test('a position where playback starts is passed first, as the cursor leaves it', ()=>{
    // Wine's dsound test_notifications, which Windows passes: positions at 0
    // and half way in a looping half-second buffer come in the order 0, half,
    // 0, half -- the start is the first thing playback passes.
    const { sound, time } = buffer({ bytes: SECOND / 2 });
    sound.setNotifications([
        { offset: 0, event: 10 },
        { offset: aligned(SECOND / 4), event: 20 },
    ]);
    sound.play(DSBPLAY_LOOPING);
    /** @type {number[]} */
    const heard = [];
    for (let step = 0; step < 30; step++)
    {
        time.advance(50);
        heard.push(...sound.drainNotifications());
    }
    assert.deepEqual(heard, [10, 20, 10, 20, 10, 20]);
});

test('a one-shot passes its first position as it starts and its last as it ends', ()=>{
    // Wine's dsound test_notifications_noloop: the position at 0 while the
    // buffer is still playing, the one at its last frame once it has stopped,
    // and the start not a second time when the cursor reads zero again.
    const bytes = SECOND / 2;
    const { sound, time } = buffer({ bytes });
    sound.setNotifications([
        { offset: 0, event: 1 },
        { offset: bytes - FORMAT.blockAlign, event: 2 },
    ]);
    sound.play(0);
    time.advance(20);
    assert.deepEqual(sound.drainNotifications(), [1]);
    assert.equal(sound.status(), DSBSTATUS_PLAYING);
    time.advance(600);
    assert.deepEqual(sound.drainNotifications(), [2]);
    assert.equal(sound.status(), 0);
    time.advance(100);
    assert.deepEqual(sound.drainNotifications(), []);
});

test('a one-shot that ends and starts again between two looks passes both runs', ()=>{
    // A tenth of a second: short enough to end and be played again between
    // two turns of the machine.
    const bytes = SECOND / 10;
    const { sound, time } = buffer({ bytes });
    sound.setNotifications([
        { offset: aligned(bytes / 4), event: 4 },
        { offset: aligned(bytes * 3 / 4), event: 6 },
    ]);
    sound.play(0);
    time.advance(40);
    assert.deepEqual(sound.drainNotifications(), [4]);
    time.advance(60);
    sound.play(0);
    time.advance(30);
    assert.deepEqual(sound.drainNotifications(), [6, 4],
        'the rest of the first run and then the start of the second, in that order');
});

test('DSBPN_OFFSETSTOP fires when playback stops, and not while a loop goes round', ()=>{
    // dsound.h defines it as -1: a marker for the stop, not a place in the
    // buffer. A streaming thread waits on it to learn its sound has ended, and
    // one woken on every lap would take a playing buffer for a stopped one.
    const { sound, time } = buffer({ bytes: SECOND / 2 });
    sound.setNotifications([{ offset: DSBPN_OFFSETSTOP, event: 9 }]);
    sound.play(DSBPLAY_LOOPING);
    for (let lap = 0; lap < 6; lap++)
    {
        time.advance(200);
        assert.deepEqual(sound.drainNotifications(), [], `still playing at ${lap * 200 + 200} ms`);
    }
    // Wine's dsound test_notify and dsound8 test_effects: Play, Stop, and the
    // event is set.
    sound.stop();
    assert.deepEqual(sound.drainNotifications(), [9]);
    assert.deepEqual(sound.drainNotifications(), [], 'once');
});

test('a one-shot that plays to its end has stopped, and says so once', ()=>{
    const { sound, time } = buffer({ bytes: SECOND / 2 });
    sound.setNotifications([{ offset: DSBPN_OFFSETSTOP, event: 9 }]);
    sound.play(0);
    time.advance(200);
    assert.deepEqual(sound.drainNotifications(), []);
    time.advance(400);
    assert.deepEqual(sound.drainNotifications(), [9]);
    sound.stop();
    assert.deepEqual(sound.drainNotifications(), [],
        'a Stop after the end stops nothing that was playing');
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

/**
 * How many times each byte of a buffer has been handed over, across a
 * sequence of drains: the property under test is that no byte is heard twice.
 *
 * @param {ReturnType<typeof createSoundBuffer>} sound
 */
function coverage(sound){
    const counts = new Uint8Array(sound.bytes);
    return {
        drain(){
            const ranges = sound.drainPlayed();
            for (const range of ranges)
            {
                for (let at = range.from; at < range.from + range.bytes; at++)
                {
                    counts[at]++;
                }
            }
            return ranges;
        },
        twice: ()=>counts.filter(count=>count > 1).length,
    };
}

test('a stop and a resume hand every byte over once', ()=>{
    // The lead ahead of the play cursor was already given to the mixer when
    // the program stopped, and the mixer cannot give it back: it is heard
    // then. Handing it over again on resume plays those bytes twice, which
    // for a pause between two sounds is the end of the first one repeated.
    const { sound, time } = buffer();
    const handed = coverage(sound);
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    handed.drain();
    const fed = sound.cursors().write;
    sound.stop();
    assert.deepEqual(handed.drain(), [], 'a stopped buffer reads nothing');
    assert.equal(sound.cursors().play, aligned(SECOND / 4), 'the cursor reads where it stopped');

    sound.play(DSBPLAY_LOOPING);
    assert.equal(sound.cursors().play, aligned(SECOND / 4), 'and resumes from there');
    assert.deepEqual(handed.drain(), [], 'the lead was handed over before the stop');
    time.advance(100);
    const [range] = handed.drain();
    assert.equal(range.from, fed, 'the read continues where it had got to');
    assert.equal(range.from + range.bytes, sound.cursors().write, 'up to the write cursor');
    assert.equal(handed.twice(), 0);
});

test('lowering the rate does not hand over a lap', ()=>{
    // The lead shrinks with the rate, so the read stands past the cursor and
    // its new lead; a distance read as a wrap is nearly the whole buffer.
    const { sound, time } = buffer();
    const handed = coverage(sound);
    sound.play(DSBPLAY_LOOPING);
    time.advance(250);
    handed.drain();
    const fed = sound.cursors().write;
    sound.setFrequency(FORMAT.sampleRate / 4);
    assert.deepEqual(handed.drain(), [], 'nothing new was played');
    time.advance(400);
    const [range] = handed.drain();
    assert.equal(range.from, fed, 'the read continues where it had got to');
    assert.equal(handed.twice(), 0);
});

test('a one-shot stopped after it ended hands over its tail, not the whole sound', ()=>{
    // Reaching the end puts the cursor back at zero; a program that then
    // calls Stop -- before letting go of the buffer, say -- must not make
    // the next drain start from zero too, or everything already heard is
    // heard again.
    const { sound, time } = buffer();
    const handed = coverage(sound);
    sound.play(0);
    time.advance(400);
    handed.drain();
    const fed = sound.cursors().write;
    time.advance(1000);
    assert.equal(sound.status() & DSBSTATUS_PLAYING, 0, 'it finished');
    sound.stop();
    const [tail] = handed.drain();
    assert.equal(tail.from, fed, 'from where the read had got to');
    assert.equal(tail.from + tail.bytes, SECOND, 'to the end');
    assert.deepEqual(handed.drain(), [], 'and nothing more');
    assert.equal(handed.twice(), 0);
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

test('pan takes decibels off the far side and leaves the near one whole', ()=>{
    // IDirectSoundBuffer::SetPan: hundredths of a decibel, like volume, off the
    // side the sound is panned away from; DSBPAN_LEFT leaves the right silent.
    const { sound } = buffer();
    assert.deepEqual(sound.balance, [1, 1], 'centred, both sides at full');

    sound.setPan(DSBPAN_LEFT);
    assert.deepEqual(sound.balance, [1, 0]);
    sound.setPan(DSBPAN_RIGHT);
    assert.deepEqual(sound.balance, [0, 1]);

    sound.setPan(2000);
    assert.ok(Math.abs(sound.balance[0] - 0.1) < 1e-9, 'twenty decibels off the left');
    assert.equal(sound.balance[1], 1);
    sound.setPan(-600);
    assert.equal(sound.balance[0], 1);
    assert.ok(Math.abs(sound.balance[1] - 0.5) < 0.01, 'six off the right');
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

test('a refill that resumes past where it left off plays a lap-old region, and that is stale', ()=>{
    // A streaming loop as a sound library runs it: 44100 Hz stereo 16-bit,
    // a buffer of 136704 bytes, refilled in 1424-byte pieces kept about
    // 90 ms ahead of the play cursor, with the mixer draining every 20 ms.
    const format = normaliseFormat({ channels: 2, sampleRate: 44100, bitsPerSample: 16 });
    const rate = format.sampleRate * format.blockAlign;
    const bytes = 136704;
    const piece = 1424;
    const time = clock();
    const sound = createSoundBuffer({ bytes, address: 0x40000000, format, now: time.now });
    sound.lockRange(0, 0, DSBLOCK_ENTIREBUFFER);
    sound.unlock();
    sound.play(DSBPLAY_LOOPING);
    let elapsed = 0;
    let end = 0;
    const refill = ()=>{
        const target = Math.floor(elapsed * rate / 1000) + Math.floor(rate * 0.09);
        while (end < target)
        {
            sound.lockRange(end % bytes, piece, 0);
            sound.unlock();
            end += piece;
        }
    };
    const run = (/** @type {number} */ ms)=>{
        for (let at = 0; at < ms; at += 20)
        {
            time.advance(20);
            elapsed += 20;
            refill();
            sound.drainPlayed();
        }
    };
    run(2000);
    assert.equal(sound.stale.bytes, 0, 'a refill that keeps ahead has nothing stale');
    assert.deepEqual(sound.skipped, { bytes: 0, count: 0 });

    // A stall: neither the refill nor the drain runs for 100 ms, and on
    // resuming the refill continues six pieces past where it stopped, never
    // coming back for what it passed over.
    time.advance(100);
    elapsed += 100;
    end += 6 * piece;
    refill();
    assert.deepEqual(sound.skipped, { bytes: 6 * piece, count: 1 });
    run(400);
    assert.equal(sound.stale.bytes, 6 * piece,
        'the six pieces passed over play as they were a lap ago');
});

test('a lock from the write cursor or over the whole buffer is not a skip', ()=>{
    const { sound, time } = buffer();
    sound.lockRange(0, 0, DSBLOCK_ENTIREBUFFER);
    sound.unlock();
    sound.play(DSBPLAY_LOOPING);
    time.advance(100);
    sound.lockRange(0, 4096, DSBLOCK_FROMWRITECURSOR);
    sound.unlock();
    time.advance(100);
    sound.lockRange(0, 0, DSBLOCK_ENTIREBUFFER);
    sound.unlock();
    // Behind the stream is a rewrite of what was already written, not a jump.
    sound.lockRange(SECOND / 2, 4096, 0);
    sound.unlock();
    assert.deepEqual(sound.skipped, { bytes: 0, count: 0 });
    // Ahead of it, and only what lies between counts.
    sound.lockRange(SECOND / 2 + 4096 + 512, 4096, 0);
    sound.unlock();
    assert.deepEqual(sound.skipped, { bytes: 512, count: 1 });
});

/**
 * A pump that skips the buffers that say they are idle, beside one that
 * visits every buffer every turn: whatever a program does with a buffer --
 * plays it once or round, stops it, moves its cursor or its rate, sets
 * positions to be woken at, locks and unlocks it, and lets time pass between
 * -- the two hand out the same wakes and the same bytes, and the program sees
 * the same cursors and status.
 */
test('a buffer that says it is idle gives a visit nothing, whatever a program did with it', ()=>{
    const BYTES = 4096;
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++)
    {
        let state = seed;
        const below = (/** @type {number} */ n)=>{
            state = (state * 1103515245 + 12345) >>> 0;
            return (state >>> 8) % n;
        };
        const twins = [buffer({ bytes: BYTES }), buffer({ bytes: BYTES })];
        /** @type {string[][]} */
        const seen = [[], []];
        let idle = 0;
        for (let step = 0; step < 300; step++)
        {
            const roll = below(10);
            const at = below(BYTES / 4) * 4;
            const looping = below(2) === 1;
            const wait = below(30);
            for (const { sound, time } of twins)
            {
                if (roll === 0)
                {
                    sound.play(looping ? DSBPLAY_LOOPING : 0);
                }
                else if (roll === 1)
                {
                    sound.stop();
                }
                else if (roll === 2)
                {
                    sound.setCurrentPosition(at);
                }
                else if (roll === 3)
                {
                    sound.setFrequency(11025 + at);
                }
                else if (roll === 4)
                {
                    sound.setNotifications([{ offset: at, event: 1 },
                        { offset: (at + 1024) % BYTES, event: 2 },
                        { offset: DSBPN_OFFSETSTOP, event: 3 }]);
                }
                else if (roll === 5)
                {
                    sound.lockRange(at, 256, 0);
                    sound.unlock();
                }
                else
                {
                    time.advance(wait);
                }
            }
            twins.forEach(({ sound }, which)=>{
                const skipped = which === 1 && sound.idle();
                if (skipped)
                {
                    idle++;
                    return;
                }
                seen[which].push(`${step} wake ${sound.drainNotifications().join(',')} play ${
                    JSON.stringify(sound.drainPlayed())}`);
            });
            const [one, other] = twins.map(({ sound })=>JSON.stringify({ ...sound.cursors(),
                status: sound.status() }));
            assert.equal(other, one, `seed ${seed} step ${step}: what the program reads`);
        }
        // A visit that hands nothing out is what a skipped one is.
        const handed = seen.map(lines=>lines.filter(line=>!line.endsWith('wake  play []')));
        assert.deepEqual(handed[1], handed[0], `seed ${seed}: what the visits handed out`);
        checked += idle;
    }
    assert.ok(checked > 10000, `buffers skipped as idle: ${checked}`);
});
