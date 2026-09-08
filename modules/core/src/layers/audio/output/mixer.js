/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRing } from './ring.js';

/**
 * Several programs' worth of sound, made into one stream.
 *
 * A game of this era opens one wave device and writes to it, or opens a handful
 * of DirectSound buffers and plays them at once, and expects the machine to add
 * them together. There is exactly one device underneath, so the adding happens
 * here.
 *
 * Each track keeps its own queue of frames already converted to the output's
 * format. Converting on write rather than on mix is deliberate: a write happens
 * once per buffer a program hands over, and a mix happens for every block the
 * device asks for, so the expensive half belongs on the rarer path.
 *
 * There is no clock here. A track's position is what the ring says was consumed
 * and nothing else, so a program's cursor and the sound a person hears are the
 * same number rather than two numbers that agree at first.
 */

/** What comes out: the rate a browser's audio graph runs at anyway. */
const OUTPUT_RATE = 48000;
const OUTPUT_CHANNELS = 2;

/** Two hundred milliseconds of slack before a write is refused. */
const CAPACITY_FRAMES = OUTPUT_RATE / 5;

/**
 * @typedef {Object} PcmFormat
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample  8 (unsigned) or 16 (signed), as Win32 has it.
 */

/**
 * @param {Object} [options]
 * @param {number} [options.sampleRate]
 * @param {number} [options.capacityFrames]
 */
export function createMixer(
    { sampleRate = OUTPUT_RATE, capacityFrames = CAPACITY_FRAMES } = {})
{
    const ring = createRing({
        channels: OUTPUT_CHANNELS,
        capacityFrames,
    });

    /** @type {Set<any>} */
    const tracks = new Set();
    /** How many output frames have been handed to the ring. */
    let produced = 0;

    return {
        sampleRate,
        channels: OUTPUT_CHANNELS,
        ring,

        /**
         * A source of sound: one wave device, or one sound buffer.
         *
         * @param {PcmFormat} format
         */
        open(format){
            if (!(format.sampleRate > 0) || !(format.channels > 0))
            {
                throw new Error('audio: a track needs a rate and a channel count');
            }
            const track = {
                format,
                /**
                 * Output frames waiting to be mixed. A flat array of
                 * interleaved stereo, appended to and consumed from the front.
                 *
                 * @type {Float32Array[]}
                 */
                queue: [],
                /** Frames of `queue[0]` already mixed. */
                offset: 0,
                /**
                 * What each queued buffer cost the guest, in the guest's own
                 * bytes, in the order they were mixed.
                 *
                 * Kept because converting frames back into guest bytes by the
                 * rate ratio does not round-trip: the conversion floors, so a
                 * buffer that has been played in full reports back as slightly
                 * fewer bytes than the guest wrote. Over a stream the shortfall
                 * is covered by the next buffer, but a program that writes one
                 * small buffer and waits for it -- which is how a sound library
                 * probes a device -- waits for ever.
                 *
                 * @type {{ frames: number, bytes: number }[]}
                 */
                ledger: [],
                /**
                 * What the ledger no longer holds.
                 *
                 * The cursor only moves forward, so an entry behind it is never
                 * read again. Dropping those and carrying their totals is what
                 * keeps `playedBytes` from walking every buffer the program has
                 * ever written -- and it is called from every winmm entry point,
                 * so a ledger that only grew made a game that streams sound get
                 * steadily slower for as long as it played.
                 */
                retiredFrames: 0,
                retiredBytes: 0,
                /** Output frames this track has contributed to the ring. */
                mixed: 0,
                /** Of those, the ones the device has already played. */
                heard: 0,
                gain: 1,
                paused: false,

                /** The rate `played()` counts in. */
                rate: sampleRate,

                /**
                 * Output frames of this track the device has actually played.
                 *
                 * Everything mixed, less whatever is still sitting in the ring.
                 * That is exact for one track and close for several -- they are
                 * mixed into the same blocks, so they drain together -- and it
                 * is the only figure tied to the sound rather than to a clock.
                 * Held monotonic, because a cursor that went backwards would be
                 * read by a program as the buffer wrapping.
                 */
                played(){
                    track.heard = Math.max(track.heard, track.mixed - ring.filled());
                    return track.heard;
                },

                /**
                 * Converts and queues one buffer of the guest's own PCM.
                 *
                 * @param {Uint8Array} pcm
                 * @returns {number} output frames this became
                 */
                write(pcm){
                    const frames = convert(pcm, format, sampleRate);
                    if (frames.length > 0)
                    {
                        track.queue.push(frames);
                        track.ledger.push({
                            frames: frames.length / OUTPUT_CHANNELS,
                            bytes: pcm.length,
                        });
                    }
                    return frames.length / OUTPUT_CHANNELS;
                },

                /**
                 * Guest bytes this track has actually played.
                 *
                 * Exact by construction rather than reconstructed from a rate:
                 * when the last frame a buffer became has been heard, the whole
                 * of that buffer's byte count is credited, so a caller waiting
                 * for a buffer to come back is never left a fraction short.
                 */
                playedBytes(){
                    let remaining = track.played() - track.retiredFrames;
                    while (track.ledger.length > 0
                        && remaining >= track.ledger[0].frames)
                    {
                        const done = /** @type {{ frames: number, bytes: number }} */
                            (track.ledger.shift());
                        track.retiredFrames += done.frames;
                        track.retiredBytes += done.bytes;
                        remaining -= done.frames;
                    }
                    const head = track.ledger[0];
                    // Part-way through a buffer: credit the same share of its
                    // bytes, so the cursor moves smoothly inside one.
                    return track.retiredBytes
                        + (head ? head.bytes * (remaining / head.frames) : 0);
                },

                /** Frames of output this track still has to give. */
                pending(){
                    let total = -track.offset;
                    for (const block of track.queue)
                    {
                        total += block.length / OUTPUT_CHANNELS;
                    }
                    return Math.max(0, total);
                },

                /** Drops everything queued; the device was stopped. */
                reset(){
                    track.queue = [];
                    track.ledger = [];
                    track.retiredFrames = 0;
                    track.retiredBytes = 0;
                    track.offset = 0;
                    track.mixed = 0;
                    track.heard = 0;
                },

                close(){
                    track.reset();
                    tracks.delete(track);
                },
            };
            tracks.add(track);
            return track;
        },

        /** How many output frames the device has actually played. */
        consumed: ()=>ring.consumed(),

        /**
         * Mixes up to `frames` of every open track into the ring.
         *
         * Called once a scheduler turn by whoever is driving the machine, which
         * is the only place that knows a turn has happened. It writes ahead
         * rather than on demand -- the device reads on its own thread and must
         * never find the ring empty because the emulator was busy.
         *
         * @param {number} [frames]  Ceiling; the ring's room is the real one.
         * @returns {number} frames written
         */
        pump(frames = ring.room()){
            const room = Math.min(frames, ring.room());
            if (room <= 0 || tracks.size === 0)
            {
                return 0;
            }
            let wanted = 0;
            for (const track of tracks)
            {
                if (!track.paused)
                {
                    wanted = Math.max(wanted, Math.min(room, track.pending()));
                }
            }
            if (wanted === 0)
            {
                return 0;
            }

            const block = new Float32Array(wanted * OUTPUT_CHANNELS);
            for (const track of tracks)
            {
                if (track.paused)
                {
                    continue;
                }
                mixInto(block, track, wanted);
            }
            const written = ring.write(block);
            produced += written;
            return written;
        },

        /** For a report: what is open and how far ahead the ring is. */
        diagnostics: ()=>({
            tracks: tracks.size,
            queuedFrames: [...tracks].reduce((sum, track)=>sum + track.pending(), 0),
            ringFilled: ring.filled(),
            produced,
            consumed: ring.consumed(),
        }),
    };
}

/**
 * Adds one track's next `frames` into a block, and remembers how far it got.
 *
 * A track with less than that left contributes what it has and the rest of the
 * block keeps whatever the other tracks put there. Padding it with silence
 * would be the same thing written more slowly.
 *
 * @param {Float32Array} block @param {any} track @param {number} frames
 */
function mixInto(block, track, frames){
    let at = 0;
    while (at < frames && track.queue.length > 0)
    {
        const head = track.queue[0];
        const available = head.length / OUTPUT_CHANNELS - track.offset;
        const take = Math.min(available, frames - at);
        const from = track.offset * OUTPUT_CHANNELS;
        const to = at * OUTPUT_CHANNELS;
        for (let sample = 0; sample < take * OUTPUT_CHANNELS; sample++)
        {
            block[to + sample] += head[from + sample] * track.gain;
        }
        at += take;
        track.offset += take;
        if (track.offset * OUTPUT_CHANNELS >= head.length)
        {
            track.queue.shift();
            track.offset = 0;
        }
    }
    track.mixed += at;
}

/**
 * One buffer of guest PCM as interleaved stereo float at the output's rate.
 *
 * Resampling is linear. It is not the last word on quality and is not meant to
 * be: what it has to be is cheap and free of discontinuities at a block
 * boundary, because a click is audible where a slightly soft high end is not.
 *
 * @param {Uint8Array} pcm @param {PcmFormat} format @param {number} rate
 * @returns {Float32Array}
 */
function convert(pcm, format, rate){
    const bytesPerSample = format.bitsPerSample === 8 ? 1 : 2;
    const stride = bytesPerSample * format.channels;
    const inputFrames = Math.floor(pcm.length / stride);
    if (inputFrames === 0)
    {
        return new Float32Array(0);
    }

    const ratio = rate / format.sampleRate;
    const outputFrames = Math.max(1, Math.floor(inputFrames * ratio));
    const out = new Float32Array(outputFrames * OUTPUT_CHANNELS);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

    /** @param {number} frame @param {number} channel */
    const sample = (frame, channel)=>{
        const at = frame * stride + channel * bytesPerSample;
        // Eight-bit wave audio is unsigned with silence at 128; sixteen-bit is
        // signed with silence at zero. Reading either as the other is not a
        // subtle difference -- it is a loud constant offset.
        return bytesPerSample === 1
            ? (view.getUint8(at) - 128) / 128
            : view.getInt16(at, true) / 32768;
    };

    for (let frame = 0; frame < outputFrames; frame++)
    {
        const source = frame / ratio;
        const left = Math.min(inputFrames - 1, Math.floor(source));
        const right = Math.min(inputFrames - 1, left + 1);
        const blend = source - left;
        for (let channel = 0; channel < OUTPUT_CHANNELS; channel++)
        {
            // A mono source is heard from both sides rather than from one.
            const which = Math.min(channel, format.channels - 1);
            const value = sample(left, which) * (1 - blend)
                + sample(right, which) * blend;
            out[frame * OUTPUT_CHANNELS + channel] = value;
        }
    }
    return out;
}
