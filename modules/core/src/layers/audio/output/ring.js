/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The one place sound crosses out of the engine.
 *
 * A browser's audio thread cannot ask the emulator for samples: it runs in a
 * different thread on a deadline of a millisecond or so, and the emulator may
 * be in the middle of a guest instruction that will not finish for longer than
 * that. So nothing pulls. The engine writes ahead into a ring in shared memory
 * and the audio thread reads out of it, and the two never wait for each other.
 *
 * The read index is the whole feedback channel. It says how many frames the
 * device has actually consumed, which is what a program's play cursor has to
 * be built on: a cursor advanced by the clock instead drifts against the sound
 * a person hears, and every buffer a program refills on that signal arrives
 * early or late by however far it has drifted.
 *
 * Indices are monotonic rather than wrapped, and the difference between them is
 * the fill. Wrapping them would make an empty ring and a full one look the same
 * -- the classic ambiguity -- and cost a slot to avoid.
 */

/** Where the two indices live in the shared control block. */
const WRITTEN = 0;
const READ = 1;

/**
 * A ring of interleaved float32 frames.
 *
 * @param {Object} options
 * @param {number} options.channels
 * @param {number} options.capacityFrames  Rounded up to a power of two.
 * @param {{ control: ArrayBufferLike, samples: ArrayBufferLike }} [options.memory]
 *        Existing storage, for the reader on the other side of the boundary.
 */
export function createRing({ channels, capacityFrames, memory }){
    const capacity = memory
        ? memory.samples.byteLength / 4 / channels
        : nextPowerOfTwo(capacityFrames);
    if (!Number.isInteger(capacity) || capacity <= 0)
    {
        throw new Error('audio: a ring needs a whole number of frames');
    }

    const shared = memory ?? {
        // Shared when the environment allows it, ordinary memory when it does
        // not. A build without cross-origin isolation still has to make sound;
        // what it loses is the second thread, not the audio.
        control: allocate(8),
        samples: allocate(capacity * channels * 4),
    };
    const control = new Int32Array(shared.control);
    const samples = new Float32Array(shared.samples);
    const mask = capacity - 1;

    return {
        channels,
        capacity,

        /** The storage, to hand to whoever reads on the other side. */
        memory: shared,

        /** Frames written but not yet consumed. */
        filled(){
            return Atomics.load(control, WRITTEN) - Atomics.load(control, READ);
        },

        /** Room for this many more frames. */
        room(){
            return capacity - this.filled();
        },

        /** Frames the reader has taken since the ring was made. */
        consumed(){
            return Atomics.load(control, READ);
        },

        /**
         * Appends interleaved frames, as many as fit.
         *
         * A short write is not an error and is not retried here: the caller
         * tops the ring up every turn and will offer the rest on the next one.
         * Blocking instead would hold a guest thread, which is the one cost
         * this engine will not pay for sound.
         *
         * @param {Float32Array} frames  channels * n samples
         * @returns {number} frames actually written
         */
        write(frames){
            const offered = Math.floor(frames.length / channels);
            const taken = Math.min(offered, this.room());
            const written = Atomics.load(control, WRITTEN);
            for (let frame = 0; frame < taken; frame++)
            {
                const at = (written + frame & mask) * channels;
                const from = frame * channels;
                for (let channel = 0; channel < channels; channel++)
                {
                    samples[at + channel] = frames[from + channel];
                }
            }
            // Published last, and with a store that cannot be reordered before
            // the samples: a reader that saw the index move first would read
            // frames that had not been written yet.
            Atomics.store(control, WRITTEN, written + taken);
            return taken;
        },

        /**
         * Takes up to `into.length / channels` frames. What is not there is
         * silence rather than a short read, because the caller is a device that
         * must produce exactly one block however little the engine managed.
         *
         * @param {Float32Array} into
         * @returns {number} frames that were real rather than silence
         */
        read(into){
            const wanted = Math.floor(into.length / channels);
            const read = Atomics.load(control, READ);
            const have = Math.min(wanted, Atomics.load(control, WRITTEN) - read);
            for (let frame = 0; frame < wanted; frame++)
            {
                const to = frame * channels;
                if (frame >= have)
                {
                    into.fill(0, to, to + channels);
                    continue;
                }
                const at = (read + frame & mask) * channels;
                for (let channel = 0; channel < channels; channel++)
                {
                    into[to + channel] = samples[at + channel];
                }
            }
            // Only what was really there is counted as consumed. Counting the
            // silence would run the play cursor through a gap the program never
            // filled, and it would refill against a position sound never
            // reached.
            Atomics.store(control, READ, read + have);
            return have;
        },

        /** Throws away everything queued, as stopping a device does. */
        clear(){
            Atomics.store(control, READ, Atomics.load(control, WRITTEN));
        },
    };
}

/** @param {number} bytes */
function allocate(bytes){
    return typeof SharedArrayBuffer === 'function'
        ? new SharedArrayBuffer(bytes)
        : new ArrayBuffer(bytes);
}

/** @param {number} value */
function nextPowerOfTwo(value){
    let size = 1;
    while (size < value)
    {
        size *= 2;
    }
    return size;
}
