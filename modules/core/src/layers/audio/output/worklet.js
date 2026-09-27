/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The far end of the track table, running on the browser's audio thread.
 *
 * Loaded with `audioWorklet.addModule(<this file's URL>)` rather than imported:
 * an audio worklet has its own global scope, no DOM and no module graph shared
 * with the page, so this file has to stand alone. The region between the
 * `WORKLET-SHARED` markers below is a verbatim copy of the same markers in
 * `output/mix.js` -- `export ` stripped from each declaration, the one
 * unavoidable difference -- because importing across the worklet boundary is
 * not possible; `worklet.test.js` reads both files and asserts the regions
 * match once that difference is normalised away, so a change to one that is
 * not carried to the other fails a test rather than going quiet.
 *
 * The processor itself does the least work an audio callback can: read every
 * open slot, resample and sum it into the block. No allocation in `process()`
 * -- the per-slot seam state and the scratch block are made once in the
 * constructor -- and nothing that can throw, because a callback that overruns
 * its deadline is heard as a click by everyone listening.
 */

const SLOTS = 64;

/* WORKLET-SHARED:BEGIN */

/**
 * PCM ring per slot, in bytes. A power of two, so a byte offset wraps with a
 * mask rather than a modulo. 1.5 s of 22 kHz mono, 0.37 s of 44.1 kHz stereo --
 * comfortably past the 200 ms of backlog the policy below allows to build up.
 */
const SLOT_BYTES = 65536;
const PCM_MASK = SLOT_BYTES - 1;

/**
 * Ints in one slot's header. Twenty-one are named below; the rest are unused
 * padding that rounds the header to 128 bytes -- two cache lines -- so two
 * adjacent slots' headers, written by different threads, never share one.
 */
const SLOT_HEADER_INT32 = 32;
const SLOT_HEADER_BYTES = SLOT_HEADER_INT32 * 4;

/** Slot header fields. STATE and GENERATION and the format are engine-owned. */
const STATE = 0;
const GENERATION = 1;
const RATE = 2;
const CHANNELS = 3;
const BITS = 4;
/** Fixed point, ×`GAIN_SCALE` -- an integer so it reads and writes atomically
 * the same way every other field here does, rather than through a second,
 * non-atomic `Float32Array` view over the same bytes. */
const GAIN = 5;
const PAUSED = 6;
/** Bytes, engine-owned, monotonic: guest PCM written into the slot's ring. */
const WRITTEN = 7;
/** Bytes, reader-owned, monotonic: guest PCM the audio thread has consumed. */
const READ = 8;
/** Bytes, engine-owned: the backlog policy's "skip to here" instruction. */
const DROP_TO = 9;
/** Output frames, reader-owned: this slot's contribution so far. */
const MIXED_FRAMES = 10;
/** What each side loses, ×`GAIN_SCALE`, on top of `GAIN`: a sound panned to
 * one side. Stored as the loss rather than what is kept, so a header written
 * without them -- zeroed -- plays both sides whole. */
const LEFT_CUT = 11;
const RIGHT_CUT = 12;

/**
 * What the slot is. A queue (`KIND_QUEUE`, the default a zeroed header reads
 * as) is PCM pushed into the slot's own ring and played once, in order: a wave
 * device's buffers. A DMA voice (`KIND_DMA`) is a sound buffer the way a
 * sound card has one: a mirror of the program's whole buffer in the arena,
 * which the device reads on its own clock -- round and round while
 * `LOOPING`, to the end once otherwise -- moving `POSITION` as it goes,
 * whatever the engine thread is doing. The engine writes the mirror when the
 * program unlocks what it wrote, and reads `POSITION` as the play cursor.
 */
const KIND = 13;
const KIND_QUEUE = 0;
const KIND_DMA = 1;
/** Bytes, engine-owned: where the voice's mirror starts in the arena, and how long it is. */
const BASE = 14;
const LENGTH = 15;
/** Bytes into the mirror, device-owned while playing: the play cursor. */
const POSITION = 16;
/** Engine-owned: 1 to go round at the end, 0 to stop there. */
const LOOPING = 17;
/** 1 while playing. The engine sets it to play and clears it to stop; the
 * device clears it when a voice that does not loop reaches its end. */
const PLAYING = 18;
/** Device-owned counters: laps a looping voice has come round, and ends a
 * voice that does not loop has reached -- what a program's notifications and
 * status are told from. */
const LAPS = 19;
const ENDS = 20;

const STATE_FREE = 0;
const STATE_OPEN = 1;
/** Closed by the engine; the reader frees it (back to `STATE_FREE`) once it
 * has seen the mark, so the engine can never reuse a slot the reader has not
 * caught up on. */
const STATE_CLOSING = 2;

const GAIN_SCALE = 65536;

/**
 * The arena: the DMA voices' mirrors, after the last slot. Sixteen MiB holds
 * a generation's streaming buffers many times over (a sound library's is a
 * few hundred KiB) and a good many whole sounds; a buffer that does not fit
 * plays through the engine's queue as before.
 */
const ARENA_BYTES = 16 << 20;

/** Ints in the global header, ahead of the first slot. */
const GLOBAL_HEADER_INT32 = 8;
const GLOBAL_HEADER_BYTES = GLOBAL_HEADER_INT32 * 4;

const OUTPUT_RATE = 0;
const BLOCKS = 1;
const STARVED_BLOCKS = 2;
const STARVED_FRAMES = 3;

const SLOT_STRIDE = SLOT_HEADER_BYTES + SLOT_BYTES;

/** @param {number} slot @returns {number} byte offset of that slot's header */
function slotHeaderOffset(slot){
    return GLOBAL_HEADER_BYTES + slot * SLOT_STRIDE;
}

/** @param {number} slot @returns {number} byte offset of that slot's PCM ring */
function slotPcmOffset(slot){
    return slotHeaderOffset(slot) + SLOT_HEADER_BYTES;
}

/**
 * The resampler's seam between one output block and the next, kept per slot
 * by whoever calls {@link resampleInto} across many blocks.
 *
 * @typedef {Object} Seam
 * @property {number} pos          Next read position, in input frames from
 *                                  the slot's current `READ`. Negative reaches
 *                                  into `tail`.
 * @property {Float32Array | null} tail  The last input frame read before the
 *                                  ring ran dry, per output channel.
 * @property {number} generation   The slot `GENERATION` this seam was built
 *                                  against; a mismatch means start over.
 */

/** @returns {Seam} */
function createSeam(){
    return { pos: 0, tail: null, generation: -1 };
}

/**
 * Resamples one slot's queued PCM into an output block of interleaved stereo
 * float, adding into whatever is already there, and advances the slot's
 * `READ` and `MIXED_FRAMES` by exactly what it consumed and produced.
 *
 * A slot with less queued than the block needs contributes what it has and
 * leaves the rest of the block untouched -- silence, or another slot's sound.
 * A slot that is not open, or is paused, contributes nothing and touches
 * nothing.
 *
 * @param {Object} p
 * @param {Float32Array} p.block        Interleaved stereo, added into.
 * @param {number} p.blockFrames        Frames of `block` to fill, from 0.
 * @param {Int32Array} p.header         This slot's `SLOT_HEADER_INT32` ints.
 * @param {Uint8Array} p.pcm            This slot's `SLOT_BYTES` PCM ring.
 * @param {Uint8Array | null} [p.arena] The DMA voices' mirrors (`ARENA_BYTES`).
 * @param {number} p.outputRate
 * @param {Seam} p.seam
 * @returns {number} output frames this slot produced
 */
function resampleInto({ block, blockFrames, header, pcm, arena, outputRate, seam }){
    const state = Atomics.load(header, STATE);
    const kind = Atomics.load(header, KIND);
    if (state === STATE_OPEN && kind !== KIND_QUEUE)
    {
        // A voice, or a kind this reader does not know, which it leaves silent.
        return kind === KIND_DMA && arena
            ? playVoice({ block, blockFrames, header, arena, outputRate, seam }) : 0;
    }
    if (state === STATE_CLOSING)
    {
        // The engine is done feeding this slot; free it here, on the reader's
        // side, so the engine can never reuse a slot before the reader has
        // stopped touching its bytes.
        Atomics.store(header, STATE, STATE_FREE);
        return 0;
    }
    if (state !== STATE_OPEN || Atomics.load(header, PAUSED) !== 0)
    {
        return 0;
    }

    const generation = Atomics.load(header, GENERATION);
    if (generation !== seam.generation)
    {
        seam.generation = generation;
        seam.pos = 0;
        seam.tail = null;
        const dropTo = Atomics.load(header, DROP_TO);
        const read = Atomics.load(header, READ);
        if (dropTo > read)
        {
            Atomics.store(header, READ, dropTo);
        }
    }

    const rate = Atomics.load(header, RATE);
    const channels = Atomics.load(header, CHANNELS);
    const bits = Atomics.load(header, BITS);
    const gain = Atomics.load(header, GAIN) / GAIN_SCALE;
    const leftGain = gain * (1 - Atomics.load(header, LEFT_CUT) / GAIN_SCALE);
    const rightGain = gain * (1 - Atomics.load(header, RIGHT_CUT) / GAIN_SCALE);
    const bytesPerSample = bits === 8 ? 1 : 2;
    const stride = bytesPerSample * channels;

    const written = Atomics.load(header, WRITTEN);
    const read0 = Atomics.load(header, READ);
    // Formed as a wrapped 32-bit difference, not a plain subtraction of two
    // doubles: WRITTEN and READ are bytes and cross 2^31 in 3.4 hours of
    // continuous play at 44.1 kHz stereo, and past that point one of the two
    // loads is negative while the other is not, which a plain subtraction
    // reads as a huge span rather than the true, small one.
    const availableFrames = Math.max(0, Math.floor(((written - read0) | 0) / stride));
    if (availableFrames === 0)
    {
        return 0;
    }

    /** @param {number} frame @param {number} channel @returns {number} */
    const readSample = (frame, channel)=>{
        if (frame < 0)
        {
            return seam.tail ? seam.tail[channel] : readSample(0, channel);
        }
        const clamped = Math.min(frame, availableFrames - 1);
        const at = (read0 + clamped * stride + channel * bytesPerSample) & PCM_MASK;
        if (bytesPerSample === 1)
        {
            return (pcm[at] - 128) / 128;
        }
        const low = pcm[at];
        const high = pcm[(at + 1) & PCM_MASK];
        let value = low | (high << 8);
        if (value >= 0x8000)
        {
            value -= 0x10000;
        }
        return value / 32768;
    };

    /** @type {number} */
    let produced;
    /** @type {number} */
    let consumedFrames;

    if (rate === outputRate)
    {
        // No seam to carry: consecutive blocks already concatenate exactly.
        consumedFrames = Math.min(availableFrames, blockFrames);
        for (let frame = 0; frame < consumedFrames; frame++)
        {
            for (let channel = 0; channel < 2; channel++)
            {
                block[frame * 2 + channel] += readSample(frame, Math.min(channel, channels - 1))
                    * (channel === 0 ? leftGain : rightGain);
            }
        }
        produced = consumedFrames;
        seam.pos = 0;
        seam.tail = null;
    }
    else
    {
        const step = rate / outputRate;
        let pos = seam.pos;
        let frame = 0;
        while (frame < blockFrames && pos < availableFrames - 1)
        {
            const left = Math.floor(pos);
            const blend = pos - left;
            for (let channel = 0; channel < 2; channel++)
            {
                const which = Math.min(channel, channels - 1);
                block[frame * 2 + channel] +=
                    (readSample(left, which) * (1 - blend) + readSample(left + 1, which) * blend)
                    * (channel === 0 ? leftGain : rightGain);
            }
            pos += step;
            frame++;
        }
        produced = frame;

        if (pos < availableFrames - 1)
        {
            // The block filled before the ring ran dry: only the whole input
            // frames behind the read position are done with, so the fraction
            // in front of it stays in the ring for the next block to read.
            consumedFrames = Math.floor(pos);
            seam.pos = pos - consumedFrames;
        }
        else
        {
            // The ring ran dry before the block filled: everything available
            // is retired, and the last frame carries into the seam so the
            // interpolation across it is not lost.
            consumedFrames = availableFrames;
            seam.pos = pos - availableFrames;
            if (!seam.tail || seam.tail.length !== 2)
            {
                seam.tail = new Float32Array(2);
            }
            for (let channel = 0; channel < 2; channel++)
            {
                seam.tail[channel] =
                    readSample(availableFrames - 1, Math.min(channel, channels - 1));
            }
        }
    }

    if (consumedFrames > 0)
    {
        Atomics.store(header, READ, read0 + consumedFrames * stride);
    }
    if (produced > 0)
    {
        Atomics.add(header, MIXED_FRAMES, produced);
    }
    return produced;
}

/**
 * A DMA voice into an output block: the mirror read from `POSITION` at the
 * voice's rate, gained and panned, added into the block; `POSITION` moved by
 * what was read, round the mirror while it loops, and the voice stopped at the
 * end -- `PLAYING` cleared, `POSITION` back to 0, `ENDS` counted -- when it
 * does not. What the engine thread does meanwhile does not matter to it.
 *
 * @param {Object} p
 * @param {Float32Array} p.block @param {number} p.blockFrames
 * @param {Int32Array} p.header @param {Uint8Array} p.arena
 * @param {number} p.outputRate @param {Seam} p.seam
 * @returns {number} output frames this voice produced
 */
function playVoice({ block, blockFrames, header, arena, outputRate, seam }){
    if (Atomics.load(header, PLAYING) === 0)
    {
        return 0;
    }
    const generation = Atomics.load(header, GENERATION);
    if (generation !== seam.generation)
    {
        seam.generation = generation;
        seam.pos = 0;
        seam.tail = null;
    }
    const rate = Atomics.load(header, RATE);
    const channels = Atomics.load(header, CHANNELS);
    const bits = Atomics.load(header, BITS);
    const base = Atomics.load(header, BASE);
    const bytesPerSample = bits === 8 ? 1 : 2;
    const stride = bytesPerSample * channels;
    const frames = Math.floor(Atomics.load(header, LENGTH) / stride);
    if (rate <= 0 || frames <= 0)
    {
        return 0;
    }
    const looping = Atomics.load(header, LOOPING) !== 0;
    const gain = Atomics.load(header, GAIN) / GAIN_SCALE;
    const leftGain = gain * (1 - Atomics.load(header, LEFT_CUT) / GAIN_SCALE);
    const rightGain = gain * (1 - Atomics.load(header, RIGHT_CUT) / GAIN_SCALE);
    const start = Math.floor(Atomics.load(header, POSITION) / stride) % frames;

    /** @param {number} frame frames from `start` @param {number} channel @returns {number} */
    const sample = (frame, channel)=>{
        const at = base + ((start + frame) % frames) * stride + channel * bytesPerSample;
        if (bytesPerSample === 1)
        {
            return (arena[at] - 128) / 128;
        }
        let value = arena[at] | (arena[at + 1] << 8);
        if (value >= 0x8000)
        {
            value -= 0x10000;
        }
        return value / 32768;
    };

    // Past the last frame a voice that does not loop has nothing: the
    // interpolation holds that frame rather than reading round to the first.
    const last = looping ? Infinity : frames - 1 - start;
    const step = rate / outputRate;
    let pos = seam.pos;
    let produced = 0;
    let ended = false;
    while (produced < blockFrames)
    {
        const left = Math.floor(pos);
        if (left > last)
        {
            ended = true;
            break;
        }
        const blend = pos - left;
        const right = Math.min(left + 1, last);
        for (let channel = 0; channel < 2; channel++)
        {
            const which = Math.min(channel, channels - 1);
            block[produced * 2 + channel] +=
                (sample(left, which) * (1 - blend) + sample(right, which) * blend)
                * (channel === 0 ? leftGain : rightGain);
        }
        pos += step;
        produced++;
    }
    if (ended)
    {
        seam.pos = 0;
        Atomics.store(header, POSITION, 0);
        Atomics.store(header, PLAYING, 0);
        Atomics.add(header, ENDS, 1);
    }
    else
    {
        const consumed = Math.floor(pos);
        seam.pos = pos - consumed;
        const reached = start + consumed;
        if (reached >= frames)
        {
            Atomics.add(header, LAPS, Math.floor(reached / frames));
        }
        Atomics.store(header, POSITION, (reached % frames) * stride);
    }
    if (produced > 0)
    {
        Atomics.add(header, MIXED_FRAMES, produced);
    }
    return produced;
}

/**
 * One output block: every slot resampled and summed into it, the block and
 * starvation counters advanced.
 *
 * A block is starved -- the artifact a person hears as a click -- when no
 * slot had enough to fill it, exactly as the ring counted it before: an idle
 * title with nothing open counts too, because that is what the reader really
 * found.
 *
 * @param {Object} p
 * @param {Int32Array} p.global          The table's `GLOBAL_HEADER_INT32` ints.
 * @param {{ header: Int32Array, pcm: Uint8Array }[]} p.slots
 * @param {Seam[]} p.seams                One per slot, same order.
 * @param {Float32Array} p.block          Zeroed by the caller or not yet used.
 * @param {number} p.blockFrames
 * @param {number} p.outputRate
 * @param {Uint8Array | null} [p.arena] The DMA voices' mirrors.
 * @returns {number} the most any one slot produced
 */
function mixBlock({ global, slots, seams, block, blockFrames, outputRate, arena }){
    block.fill(0, 0, blockFrames * 2);
    Atomics.add(global, BLOCKS, 1);
    let maxProduced = 0;
    for (let slot = 0; slot < slots.length; slot++)
    {
        const produced = resampleInto({
            block, blockFrames, header: slots[slot].header, pcm: slots[slot].pcm, arena,
            outputRate, seam: seams[slot],
        });
        if (produced > maxProduced)
        {
            maxProduced = produced;
        }
    }
    if (maxProduced < blockFrames)
    {
        Atomics.add(global, STARVED_BLOCKS, 1);
        Atomics.add(global, STARVED_FRAMES, blockFrames - maxProduced);
    }
    return maxProduced;
}

/* WORKLET-SHARED:END */

class BottlifyOutput extends AudioWorkletProcessor {
    /** @param {any} options */
    constructor(options){
        super();
        const { table, channels } = options.processorOptions;
        this.global = new Int32Array(table, 0, GLOBAL_HEADER_INT32);
        this.channels = channels;
        /** @type {{ header: Int32Array, pcm: Uint8Array }[]} */
        this.slots = [];
        /** @type {Seam[]} */
        this.seams = [];
        for (let slot = 0; slot < SLOTS; slot++)
        {
            this.slots.push({
                header: new Int32Array(table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
                pcm: new Uint8Array(table, slotPcmOffset(slot), SLOT_BYTES),
            });
            this.seams.push(createSeam());
        }
        // The DMA voices' mirrors, after the last slot; a table made without
        // one plays its queues alone.
        const arenaAt = GLOBAL_HEADER_BYTES + SLOTS * SLOT_STRIDE;
        this.arena = table.byteLength >= arenaAt + ARENA_BYTES
            ? new Uint8Array(table, arenaAt, ARENA_BYTES) : null;
        // 128 is the largest block WebAudio has ever asked for; grown on a
        // bigger request rather than assumed, so a future engine's bigger
        // quantum does not overrun it.
        this.block = new Float32Array(128 * 2);
        this.running = true;
        this.port.onmessage = (/** @type {any} */ event)=>{
            if (event.data === 'stop')
            {
                this.running = false;
            }
        };
    }

    /**
     * @param {Float32Array[][]} _inputs
     * @param {Float32Array[][]} outputs
     * @returns {boolean}
     */
    process(_inputs, outputs){
        const output = outputs[0];
        if (!output || output.length === 0)
        {
            return this.running;
        }
        const blockFrames = output[0].length;
        if (this.block.length < blockFrames * 2)
        {
            this.block = new Float32Array(blockFrames * 2);
        }
        // The engine's own idea of its output rate, not the audio context's:
        // a mismatch between the two is a configuration error elsewhere, and
        // resampling against the rate the engine actually assumed is what
        // keeps this processor self-consistent regardless.
        const outputRate = Atomics.load(this.global, OUTPUT_RATE);
        mixBlock({
            global: this.global, slots: this.slots, seams: this.seams,
            block: this.block, blockFrames, outputRate, arena: this.arena,
        });
        for (let channel = 0; channel < output.length; channel++)
        {
            // A mono graph over a stereo mix takes the left side rather than
            // reading past the end of a frame.
            const which = Math.min(channel, this.channels - 1);
            for (let frame = 0; frame < blockFrames; frame++)
            {
                output[channel][frame] = this.block[frame * 2 + which];
            }
        }
        return this.running;
    }
}

registerProcessor('bottlify-output', BottlifyOutput);
