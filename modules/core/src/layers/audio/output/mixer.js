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
 * @param {() => void} [options.fill]
 *        Asked for more sound before each mix. A wave device pushes its audio
 *        in when the program hands a buffer over, but a DirectSound buffer is a
 *        region the program wrote into long ago and plays out of at its own
 *        pace: somebody has to read out the part its cursor has just passed,
 *        and the only moment that makes sense is just before mixing.
 */
export function createMixer(
    { sampleRate = OUTPUT_RATE, capacityFrames = CAPACITY_FRAMES, fill } = {})
{
    const ring = createRing({
        channels: OUTPUT_CHANNELS,
        capacityFrames,
    });

    /** @type {Set<any>} */
    const tracks = new Set();
    /** How many output frames have been handed to the ring. */
    let produced = 0;
    /**
     * Frames a track was mixed short by while another track was carrying the
     * block. A block is as long as the longest track has to give, so a track
     * with nothing ready has silence written into its own stream for the rest
     * of it -- a hole that arrives at the ear as a break in that one sound,
     * with the ring never running dry and nothing else showing it happened.
     */
    let shortfall = 0;
    /** Pumps that found nothing to write while at least one track was open. */
    let idlePumps = 0;
    let pumps = 0;

    return {
        sampleRate,
        channels: OUTPUT_CHANNELS,
        ring,
        /**
         * How far ahead a track may run before what it is handing over is worth
         * less than the memory it occupies.
         *
         * A source that pushes -- a wave device -- is bounded by the program
         * itself, which writes a buffer and waits for it back. A source that is
         * pulled at the rate of a clock has nothing bounding it: if the clock
         * outruns the device, every mix leaves more behind than it took, and the
         * queue grows for as long as the sound plays.
         */
        capacityFrames,

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
                /**
                 * Frames written as silence into this track s own stream while
                 * another track was carrying a longer block. A total across
                 * tracks cannot say whether that silence fell on the stream
                 * somebody is listening to or on one that had simply stopped,
                 * and those are opposite findings.
                 */
                short: 0,
                /** Of those, the ones the device has already played. */
                heard: 0,
                gain: 1,
                paused: false,

                /**
                 * The resampler's seam between the buffers streamed into this
                 * track, so the pieces of one continuous signal join without a
                 * discontinuity where they meet. One per track, because two
                 * tracks are two independent streams.
                 *
                 * @type {ResampleState}
                 */
                resample: { pos: 0, tail: null },

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
                    const frames = convert(pcm, format, sampleRate, track.resample);
                    if (frames.length > 0)
                    {
                        track.queue.push(frames);
                    }
                    // Credited for what it gave up, not for what came out of
                    // it. A buffer shorter than the resampler needs to reach
                    // its next output frame yields nothing now and is carried
                    // into the seam instead, so its samples are absorbed and
                    // it is finished with -- while a ledger that only counted
                    // emitted frames left it uncredited for ever. A program
                    // that probes a device with one frame and waits for it
                    // back then waits for ever, and every sound it would have
                    // made afterwards is never made.
                    if (pcm.length > 0)
                    {
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
            fill?.();
            pumps++;
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
                idlePumps++;
                return 0;
            }

            const block = new Float32Array(wanted * OUTPUT_CHANNELS);
            for (const track of tracks)
            {
                if (track.paused)
                {
                    continue;
                }
                const had = mixInto(block, track, wanted);
                shortfall += wanted - had;
                track.short += wanted - had;
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
            deviceBlocks: ring.starved().asked,
            starvedBlocks: ring.starved().blocks,
            starvedFrames: ring.starved().frames,
            shortfall,
            perTrack: [...tracks].map(t=>`short=${t.short} mixed=${t.mixed}`),
            idlePumps,
            pumps,
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
 * @returns {number} frames this track actually had
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
    return at;
}

/**
 * The state a track's resampler carries between the buffers a program streams.
 *
 * A stream is one continuous signal delivered in pieces, and the pieces do not
 * fall on output-sample boundaries: the read position lands part way between
 * two input frames at the end of one buffer and must resume there in the next,
 * reading across the seam. Restarting the read at zero for every buffer instead
 * -- which is what a stateless resample does -- both drops the fractional frame
 * at each seam and interpolates the first output of a buffer from that buffer's
 * own start rather than from where the last one left off. For a program that
 * streams thousands of small buffers a second that is a discontinuity per
 * buffer, heard as a continuous buzz over the sound rather than as one click.
 *
 * @typedef {Object} ResampleState
 * @property {number} pos    The next read position, in input frames, measured
 *                           from the start of the buffer being written now.
 *                           Negative reaches back into `tail`. Zero to begin.
 * @property {Float32Array | null} tail  The last input frame of the previous
 *                           buffer, per channel, so the seam interpolates.
 */

/**
 * One buffer of a stream's PCM as interleaved stereo float at the output's
 * rate, resampled continuously with the piece before it.
 *
 * Resampling is linear. It is not the last word on quality and is not meant to
 * be: what it has to be is cheap and free of discontinuities at a block
 * boundary, because a click is audible where a slightly soft high end is not --
 * and free of them across a boundary too, which is what `state` carries.
 *
 * @param {Uint8Array} pcm @param {PcmFormat} format @param {number} rate
 * @param {ResampleState} state  Read and advanced; the seam lives here.
 * @returns {Float32Array}
 */
function convert(pcm, format, rate, state){
    const bytesPerSample = format.bitsPerSample === 8 ? 1 : 2;
    const stride = bytesPerSample * format.channels;
    const inputFrames = Math.floor(pcm.length / stride);
    if (inputFrames === 0)
    {
        return new Float32Array(0);
    }

    const ratio = rate / format.sampleRate;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);

    /**
     * A channel of an input frame. Frame -1 is the previous buffer's last
     * frame, carried in `tail`; a first-ever buffer has none, so -1 reads the
     * buffer's own first frame, which is a flat start and not a click.
     *
     * @param {number} frame @param {number} channel
     * @returns {number}
     */
    const sample = (frame, channel)=>{
        if (frame < 0)
        {
            return state.tail ? state.tail[channel] : sample(0, channel);
        }
        const at = Math.min(frame, inputFrames - 1) * stride + channel * bytesPerSample;
        // Eight-bit wave audio is unsigned with silence at 128; sixteen-bit is
        // signed with silence at zero. Reading either as the other is not a
        // subtle difference -- it is a loud constant offset.
        return bytesPerSample === 1
            ? (view.getUint8(at) - 128) / 128
            : view.getInt16(at, true) / 32768;
    };

    // At the output's own rate there is nothing to resample: one input frame is
    // one output frame, consecutive buffers already concatenate exactly, and so
    // there is no seam to carry. A mono source is still spread across both
    // channels. Kept a separate path because the resampler below holds a
    // fractional frame back for the next buffer, which is right for a stream at
    // another rate and wrong for an exact copy -- it would delay every sample
    // by one and leave a program's one-buffer probe a frame short for ever.
    if (rate === format.sampleRate)
    {
        const out = new Float32Array(inputFrames * OUTPUT_CHANNELS);
        for (let frame = 0; frame < inputFrames; frame++)
        {
            for (let channel = 0; channel < OUTPUT_CHANNELS; channel++)
            {
                out[frame * OUTPUT_CHANNELS + channel] =
                    sample(frame, Math.min(channel, format.channels - 1));
            }
        }
        return out;
    }

    // Emit while the right interpolation neighbour is still inside this buffer;
    // the last fractional step is carried in `pos`, to resume across the seam.
    let pos = state.pos;
    const step = 1 / ratio;
    // A generous upper bound on the output frames, so the loop always ends on
    // the read position and never on the buffer running out under a rounding
    // error, which would drop a frame at the seam -- the very thing this fixes.
    const capacity = Math.max(0, Math.ceil((inputFrames - 1 - pos) / step)) + 2;
    const out = new Float32Array(capacity * OUTPUT_CHANNELS);
    let frame = 0;
    while (pos < inputFrames - 1 && frame < capacity)
    {
        const left = Math.floor(pos);
        const blend = pos - left;
        for (let channel = 0; channel < OUTPUT_CHANNELS; channel++)
        {
            // A mono source is heard from both sides rather than from one.
            const which = Math.min(channel, format.channels - 1);
            out[frame * OUTPUT_CHANNELS + channel] = sample(left, which) * (1 - blend)
                + sample(left + 1, which) * blend;
        }
        pos += step;
        frame++;
    }

    // Carry the seam into the next buffer, whose frame 0 is this buffer's frame
    // count: the read position and the last frame both shift back by that many.
    state.pos = pos - inputFrames;
    if (!state.tail || state.tail.length !== OUTPUT_CHANNELS)
    {
        state.tail = new Float32Array(OUTPUT_CHANNELS);
    }
    for (let channel = 0; channel < OUTPUT_CHANNELS; channel++)
    {
        state.tail[channel] = sample(inputFrames - 1, Math.min(channel, format.channels - 1));
    }
    return out.subarray(0, frame * OUTPUT_CHANNELS);
}
