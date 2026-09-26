/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRing } from './ring.js';
import {
    SLOTS, SLOT_BYTES, PCM_MASK, SLOT_HEADER_INT32, GLOBAL_HEADER_INT32, TABLE_BYTES,
    STATE, GENERATION, RATE, CHANNELS, BITS, GAIN, PAUSED, WRITTEN, READ, DROP_TO, MIXED_FRAMES,
    LEFT_CUT, RIGHT_CUT,
    STATE_FREE, STATE_OPEN, STATE_CLOSING, GAIN_SCALE,
    OUTPUT_RATE, BLOCKS, STARVED_BLOCKS, STARVED_FRAMES,
    slotHeaderOffset, slotPcmOffset,
} from './mix.js';

/**
 * Several programs' worth of sound, made into one stream.
 *
 * A game of this era opens one wave device and writes to it, or opens a handful
 * of DirectSound buffers and plays them at once, and expects the machine to add
 * them together. There is exactly one device underneath, so the adding happens
 * here.
 *
 * Two backends share one surface (`open`, `pump`, `consumed`, `diagnostics`,
 * a track's `write`, `played`, `playedBytes`, `pending`, `reset`, `close`,
 * `gain`, `balance`, `paused`, `retune`), chosen by `shared`:
 *
 * - Without it (the default, and what every caller that does not ask
 *   otherwise gets): `createEngineMixer`, unchanged from before this file grew
 *   a second backend. Every source converts to float on write and is mixed
 *   into one ring on the engine thread; a reader without shared memory -- the
 *   test-page harness, any page that is not cross-origin isolated -- can only
 *   read on that same thread, so this is the only backend it can use.
 * - With it: `createSharedMixer`. Every source's raw guest PCM goes into its
 *   own ring inside one shared "track table"; converting and mixing happen on
 *   the audio thread instead, in `worklet.js`, which is the only place that
 *   was ever measured costing anything (B12, superseded by the measurement
 *   this file was built for).
 *
 * Which one an assembling caller gets is an environment question -- shared
 * memory is what a worklet needs to read the far end at all -- not a mixer
 * question, so it is asked for explicitly rather than guessed from
 * `typeof SharedArrayBuffer`: guessing would flip every existing test in this
 * file onto the new backend the moment it ran somewhere `SharedArrayBuffer`
 * happens to exist, such as Node.
 */

/** What comes out: the rate a browser's audio graph runs at anyway. */
const OUTPUT_RATE_DEFAULT = 48000;
const OUTPUT_CHANNELS = 2;

/** Two hundred milliseconds of slack before a write is refused. */
const CAPACITY_FRAMES = OUTPUT_RATE_DEFAULT / 5;

/**
 * @typedef {Object} PcmFormat
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample  8 (unsigned) or 16 (signed), as Win32 has it.
 */

/**
 * @overload
 * @param {Object} [options]
 * @param {number} [options.sampleRate]
 * @param {number} [options.capacityFrames]
 * @param {() => void} [options.fill]
 * @param {{ control: ArrayBufferLike, samples: ArrayBufferLike }} [options.memory]
 * @param {false} [options.shared]
 * @returns {ReturnType<typeof createEngineMixer>}
 */
/**
 * @overload
 * @param {Object} options
 * @param {number} [options.sampleRate]
 * @param {() => void} [options.fill]
 * @param {{ table: ArrayBufferLike }} [options.memory]
 * @param {true} options.shared
 * @returns {ReturnType<typeof createSharedMixer>}
 */
/**
 * Picks a backend by `options.shared` (default `false`) -- see the file
 * comment above for what each one is and why the choice is made here rather
 * than guessed from `typeof SharedArrayBuffer`.
 *
 * `fill` is asked for more sound before each mix in both backends. A wave
 * device pushes its audio in when the program hands a buffer over, but a
 * DirectSound buffer is a region the program wrote into long ago and plays
 * out of at its own pace: somebody has to read out the part its cursor has
 * just passed, and the only moment that makes sense is just before mixing.
 *
 * `memory` is the storage of the output an earlier machine made -- `{
 * control, samples }` for the engine backend, `{ table }` for the shared one.
 * Given, this mixer's output is that same storage rather than a new one: the
 * process was replaced, not the device, and whoever reads the far end -- a
 * worklet, a person's own sound card, this same thread -- still holds it.
 *
 * @param {any} [options]
 */
export function createMixer(options = {}){
    return options.shared ? createSharedMixer(options) : createEngineMixer(options);
}

/**
 * @param {Object} [options]
 * @param {number} [options.sampleRate]
 * @param {number} [options.capacityFrames]
 * @param {() => void} [options.fill]
 * @param {{ control: ArrayBufferLike, samples: ArrayBufferLike }} [options.memory]
 */
function createEngineMixer(
    { sampleRate = OUTPUT_RATE_DEFAULT, capacityFrames = CAPACITY_FRAMES, fill, memory } = {})
{
    const ring = createRing({
        channels: OUTPUT_CHANNELS,
        capacityFrames,
        memory,
    });

    /** @type {Set<any>} */
    const tracks = new Set();
    /**
     * How many output frames have been handed to the ring. A machine that
     * replaced another starts from what the shared storage already holds, so
     * this is the device's count rather than one mixer's.
     */
    let produced = ring.written();
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
        memory: ring.memory,
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
                capacityFrames,
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
                /** Each side's share of `gain`, left then right: a pan. */
                balance: [1, 1],
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
                    const frames = convert(pcm, track.format, sampleRate, track.resample);
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

                /**
                 * Reads what is written from now on as recorded at another
                 * rate. What is queued was converted already and stays as it
                 * was, so the change is heard exactly where the bytes change.
                 *
                 * @param {number} rate
                 */
                retune(rate){
                    // A track at the output's rate copies and leaves the seam
                    // alone, so what it holds is from before that and is no
                    // place to resume a resample from.
                    if (track.format.sampleRate === sampleRate)
                    {
                        track.resample = { pos: 0, tail: null };
                    }
                    track.format = { ...track.format, sampleRate: rate };
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
        const left = track.gain * track.balance[0];
        const right = track.gain * track.balance[1];
        for (let sample = 0; sample < take * OUTPUT_CHANNELS; sample += OUTPUT_CHANNELS)
        {
            block[to + sample] += head[from + sample] * left;
            block[to + sample + 1] += head[from + sample + 1] * right;
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
 * Exported for `mix.test.js`: the shared backend's `resampleInto` resamples
 * the same signal off a byte ring instead of a flat buffer, and is checked
 * against this, sample for sample, rather than against a second hand-written
 * expectation.
 *
 * @param {Uint8Array} pcm @param {PcmFormat} format @param {number} rate
 * @param {ResampleState} state  Read and advanced; the seam lives here.
 * @returns {Float32Array}
 */
export function convert(pcm, format, rate, state){
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

/**
 * The shared-table backend: the engine writes raw guest PCM into a per-track
 * ring inside one `SharedArrayBuffer`, and does no converting or mixing at
 * all -- `worklet.js` does both, on the audio thread, from the same table.
 *
 * @param {Object} [options]
 * @param {number} [options.sampleRate]
 * @param {() => void} [options.fill]
 * @param {{ table: ArrayBufferLike }} [options.memory]
 */
function createSharedMixer({ sampleRate = OUTPUT_RATE_DEFAULT, fill, memory } = {}){
    const buffer = memory?.table ?? allocateTable();
    const isFresh = !memory?.table;
    const global = new Int32Array(buffer, 0, GLOBAL_HEADER_INT32);
    if (isFresh)
    {
        Atomics.store(global, OUTPUT_RATE, sampleRate);
    }

    /** @type {{ header: Int32Array, pcm: Uint8Array }[]} */
    const slots = [];
    for (let slot = 0; slot < SLOTS; slot++)
    {
        slots.push({
            header: new Int32Array(buffer, slotHeaderOffset(slot), SLOT_HEADER_INT32),
            pcm: new Uint8Array(buffer, slotPcmOffset(slot), SLOT_BYTES),
        });
    }
    if (!isFresh)
    {
        // A process replacement, not a device replacement: the parent's track
        // objects are gone with it, but their slots are still STATE_OPEN with
        // nothing left to ever mark them CLOSING. This machine is that slot's
        // only writer now, so every slot it did not itself open is closed
        // here, and the reader frees it at its next block -- the same handoff
        // a released track gets.
        for (const { header } of slots)
        {
            if (Atomics.load(header, STATE) !== STATE_FREE)
            {
                Atomics.add(header, GENERATION, 1);
                Atomics.store(header, STATE, STATE_CLOSING);
            }
        }
    }

    /** @type {Set<any>} */
    const openTracks = new Set();
    let fallbackTracks = 0;
    let pumps = 0;
    let idlePumps = 0;

    const capacityFrames = Math.round(sampleRate / 5);

    return {
        sampleRate,
        channels: OUTPUT_CHANNELS,
        table: buffer,
        memory: { table: buffer },
        capacityFrames,

        /** @param {PcmFormat} format */
        open(format){
            if (!(format.sampleRate > 0) || !(format.channels > 0))
            {
                throw new Error('audio: a track needs a rate and a channel count');
            }
            const slot = slots.findIndex(s=>Atomics.load(s.header, STATE) === STATE_FREE);
            const track = slot === -1
                ? createFallbackTrack(format)
                : createSlotTrack(format, slot, slots[slot]);
            if (slot === -1)
            {
                fallbackTracks++;
            }
            openTracks.add(track);
            return track;
        },

        /** Not meaningful for a table with no single output cursor. */
        consumed: ()=>Atomics.load(global, BLOCKS),

        /**
         * Calls `fill` -- the DirectSound feed -- and nothing else: no
         * converting, no mixing, no `Float32Array` allocated. `worklet.js`
         * does all of that now, on the audio thread, from this same table.
         */
        pump(){
            fill?.();
            pumps++;
            if (openTracks.size === 0)
            {
                idlePumps++;
            }
            return 0;
        },

        diagnostics: ()=>({
            tracks: openTracks.size,
            queuedFrames: [...openTracks].reduce((sum, track)=>sum + track.pending(), 0),
            ringFilled: [...openTracks].reduce((sum, track)=>sum + track.pending(), 0),
            produced: [...openTracks].reduce((sum, track)=>sum + track.played(), 0),
            consumed: [...openTracks].reduce((sum, track)=>sum + track.played(), 0),
            deviceBlocks: Atomics.load(global, BLOCKS),
            starvedBlocks: Atomics.load(global, STARVED_BLOCKS),
            starvedFrames: Atomics.load(global, STARVED_FRAMES),
            shortfall: 0,
            perTrack: [...openTracks].map(t=>`pending=${t.pending()} played=${t.played()}`),
            idlePumps,
            pumps,
            fallbackTracks,
        }),
    };

    /**
     * @param {PcmFormat} format @param {number} slot
     * @param {{ header: Int32Array, pcm: Uint8Array }} view
     */
    function createSlotTrack(format, slot, view){
        const { header, pcm } = view;
        const bytesPerSample = format.bitsPerSample === 8 ? 1 : 2;
        const stride = bytesPerSample * format.channels;

        Atomics.store(header, RATE, format.sampleRate);
        Atomics.store(header, CHANNELS, format.channels);
        Atomics.store(header, BITS, format.bitsPerSample);
        Atomics.store(header, GAIN, GAIN_SCALE);
        Atomics.store(header, LEFT_CUT, 0);
        Atomics.store(header, RIGHT_CUT, 0);
        Atomics.store(header, PAUSED, 0);
        Atomics.store(header, WRITTEN, 0);
        Atomics.store(header, READ, 0);
        Atomics.store(header, DROP_TO, 0);
        Atomics.store(header, MIXED_FRAMES, 0);
        Atomics.add(header, GENERATION, 1);
        Atomics.store(header, STATE, STATE_OPEN);

        // Reset() restarts what playedBytes()/played() report without moving
        // READ/MIXED_FRAMES themselves -- both are reader-owned and monotonic
        // over the slot's whole life, including a track this slot held before
        // a previous reset. The bases below are what gets subtracted back off.
        let bytesBase = 0;
        let framesBase = 0;

        const track = {
            format,
            slot,
            // In this backend `pending()` counts guest frames at the track's
            // own rate, not the output's, so the 200 ms the policy allows is
            // 200 ms of that rate -- the mixer-wide `capacityFrames` above is
            // in output frames and would be the wrong unit to compare it to.
            capacityFrames: Math.round(format.sampleRate / 5),
            rate: sampleRate,

            get gain(){
                return Atomics.load(header, GAIN) / GAIN_SCALE;
            },
            set gain(value){
                Atomics.store(header, GAIN, Math.round(value * GAIN_SCALE));
            },
            /** @returns {number[]} */
            get balance(){
                return [1 - Atomics.load(header, LEFT_CUT) / GAIN_SCALE,
                    1 - Atomics.load(header, RIGHT_CUT) / GAIN_SCALE];
            },
            set balance([left, right]){
                Atomics.store(header, LEFT_CUT, Math.round((1 - left) * GAIN_SCALE));
                Atomics.store(header, RIGHT_CUT, Math.round((1 - right) * GAIN_SCALE));
            },
            get paused(){
                return Atomics.load(header, PAUSED) !== 0;
            },
            set paused(value){
                Atomics.store(header, PAUSED, value ? 1 : 0);
            },

            /**
             * Copies the guest's own bytes into the slot's ring, as many as
             * fit. A short write is not an error -- but unlike the engine
             * ring's `write()`, whose caller re-offers exactly what a short
             * write left over, this slot's only caller (`module.js`'s
             * `feedBuffers`) does not: what does not fit here is dropped, not
             * queued. The slot's `SLOT_BYTES` (65,536) is a second, harder cap
             * behind the 200 ms backlog policy, reached only when a turn's
             * backlog is already near that policy's own limit.
             *
             * Room is sized against `READ` alone, never `DROP_TO`: `DROP_TO`
             * is only the reader's next instruction and takes effect a whole
             * block later, so sizing against it lets a write land on bytes
             * the reader is still mid-block on -- a torn block, heard as a
             * click, once per drop. The real room reappears only once the
             * reader has actually caught up.
             *
             * @param {Uint8Array} data
             * @returns {number} output frames the guest's bytes became -- the
             *          same unit `played()`/`pending()` count in, not bytes
             */
            write(data){
                const written = Atomics.load(header, WRITTEN);
                const read = Atomics.load(header, READ);
                const room = Math.max(0, SLOT_BYTES - ((written - read) | 0));
                const take = Math.min(data.length, room);
                for (let i = 0; i < take; i++)
                {
                    pcm[(written + i) & PCM_MASK] = data[i];
                }
                Atomics.store(header, WRITTEN, written + take);
                return Math.round(take / stride * sampleRate / track.format.sampleRate);
            },

            /**
             * Tells the reader the rate to resample from. It applies to what
             * is still unread in the slot as well, a turn's worth at most,
             * because the slot has one rate and no marker in its bytes.
             *
             * @param {number} rate
             */
            retune(rate){
                track.format = { ...track.format, sampleRate: rate };
                track.capacityFrames = Math.round(rate / 5);
                Atomics.store(header, RATE, rate);
            },

            /** Output frames the audio thread has actually mixed from this slot. */
            played(){
                return Math.max(0, (Atomics.load(header, MIXED_FRAMES) - framesBase) | 0);
            },

            /**
             * Guest bytes played. `READ` is exactly that by construction: the
             * audio thread only advances it over bytes it has resampled or
             * folded into its seam, so a program waiting for one small buffer
             * back is credited it whole the moment the audio thread has
             * looked at it, not when a ledger decides to retire an entry.
             *
             * Less `bytesBase`, which `reset()` moves up to `WRITTEN` at the
             * moment it is called: `READ` itself stays monotonic over the
             * slot's whole life, including whatever this track played before
             * a previous reset, and a caller like `waveOutReset` expects the
             * cursor to restart at zero, the way its own `trackBytes` does.
             */
            playedBytes(){
                return Math.max(0, (Atomics.load(header, READ) - bytesBase) | 0);
            },

            /** Guest frames of this track still queued, by its own rate. */
            pending(){
                const written = Atomics.load(header, WRITTEN);
                const effectiveRead =
                    Math.max(Atomics.load(header, READ), Atomics.load(header, DROP_TO));
                return Math.max(0, Math.floor(((written - effectiveRead) | 0) / stride));
            },

            /**
             * Drops the backlog: the audio thread skips ahead to what is
             * written now rather than working through what is behind. The
             * track stays open on its slot; only the automatic policy below
             * and a caller that wants the same thing use this.
             */
            reset(){
                bytesBase = Atomics.load(header, WRITTEN);
                framesBase = Atomics.load(header, MIXED_FRAMES);
                Atomics.store(header, DROP_TO, bytesBase);
                Atomics.add(header, GENERATION, 1);
            },

            /**
             * Marks the slot closing; the audio thread is the only one that
             * may free it (`STATE_FREE`), once it has seen the mark and
             * stopped touching the slot's bytes, so the engine can never
             * reuse a slot the reader has not caught up on.
             */
            close(){
                Atomics.add(header, GENERATION, 1);
                Atomics.store(header, STATE, STATE_CLOSING);
                openTracks.delete(track);
            },
        };
        return track;
    }

    /**
     * Every slot already taken. A game of this era opens a handful of
     * buffers, so this is not expected to be reached; when it is, this
     * track's sound is silently dropped rather than mixed, which is the same
     * choice a build with nothing draining the ring makes -- a program is
     * never held up by a device that is not really there.
     *
     * @param {PcmFormat} format
     */
    function createFallbackTrack(format){
        let writtenBytes = 0;
        let localGain = 1;
        let localPaused = false;
        const bytesPerSample = format.bitsPerSample === 8 ? 1 : 2;
        const stride = bytesPerSample * format.channels;
        const track = {
            format,
            slot: -1,
            capacityFrames: Math.round(format.sampleRate / 5),
            rate: sampleRate,
            get gain(){
                return localGain;
            },
            set gain(value){
                localGain = value;
            },
            /** @type {number[]} */
            balance: [1, 1],
            get paused(){
                return localPaused;
            },
            set paused(value){
                localPaused = value;
            },
            /**
             * @param {Uint8Array} data
             * @returns {number} output frames the guest's bytes became, the
             *          same unit the real slot track's `write()` answers in
             */
            write(data){
                writtenBytes += data.length;
                return Math.round(data.length / stride * sampleRate / track.format.sampleRate);
            },
            /** @param {number} rate */
            retune(rate){
                track.format = { ...track.format, sampleRate: rate };
                track.capacityFrames = Math.round(rate / 5);
            },
            played: ()=>0,
            playedBytes: ()=>writtenBytes,
            pending: ()=>0,
            reset(){
                writtenBytes = 0;
            },
            close(){
                openTracks.delete(track);
            },
        };
        return track;
    }
}

/** @returns {ArrayBufferLike} a fresh, zeroed track table. */
function allocateTable(){
    return typeof SharedArrayBuffer === 'function'
        ? new SharedArrayBuffer(TABLE_BYTES)
        : new ArrayBuffer(TABLE_BYTES);
}
