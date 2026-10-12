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
/** Not zero while playing: the engine sets it to play, to a number of that
 * Play's own, and clears it to stop; the device clears it when a voice that
 * does not loop reaches the end of the Play it holds. */
const PLAYING = 18;
/** Device-owned counters: laps a looping voice has come round, and ends a
 * voice that does not loop has reached -- what a program's notifications and
 * status are told from. */
const LAPS = 19;
const ENDS = 20;
/**
 * A stream: a buffer the program writes into while it plays. Engine-owned:
 * `STREAMING` 1 once it is one, and `FRESH` the absolute byte -- laps times
 * the length, plus the offset, in 32 bits that wrap -- the program has written
 * up to. The device plays a stream no further than that and waits there,
 * silent, as a stream waits for its data: played on round the circle it would
 * replay the lap before whenever the program's writer was late. Device-owned
 * `HELD`: the output frames it has waited so.
 */
const FRESH = 21;
const STREAMING = 22;
const HELD = 23;
/**
 * How long a stream is waited for before it is played on regardless: this, or
 * a whole lap of the buffer if that is longer. Until the writer has been gone
 * a lap, everything past what it wrote is the lap before -- played, it is the
 * same passage heard twice; a writer silent for a whole lap has stopped.
 */
const GIVE_UP_SECONDS = 0.25;

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
 * @property {number} held         Output frames a stream has waited, unbroken.
 */

/** @returns {Seam} */
function createSeam(){
    return { pos: 0, tail: null, generation: -1, held: 0 };
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
    // Which Play this is: the engine stores a new number at every one, so
    // the end of this block can tell its own Play from one made during it.
    const playing = Atomics.load(header, PLAYING);
    if (playing === 0)
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
    const cursor = Atomics.load(header, POSITION);
    const start = Math.floor(cursor / stride) % frames;

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
    const end = looping ? Infinity : frames - 1 - start;
    // And a stream has nothing past what was written of it.
    let written = Infinity;
    if (Atomics.load(header, STREAMING) !== 0)
    {
        const readAt = (Atomics.load(header, LAPS) * frames + start) * stride;
        const ahead = (Atomics.load(header, FRESH) - readAt) | 0;
        written = Math.floor(Math.max(ahead, 0) / stride) - 1;
    }
    const last = Math.min(end, written);
    const step = rate / outputRate;
    let pos = seam.pos;
    let produced = 0;
    let ended = false;
    while (produced < blockFrames)
    {
        const left = Math.floor(pos);
        if (left > last)
        {
            ended = left > end;
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
    // A block can fill on a one-shot's last frame. The next frame to read is
    // then past the end as surely as if the loop had come round to it, and
    // read as a lap it starts the sound again from the beginning.
    if (!ended && Math.floor(pos) > end)
    {
        ended = true;
    }
    if (!ended && produced < blockFrames)
    {
        Atomics.add(header, HELD, blockFrames - produced);
        // A writer gone this long has stopped streaming, not fallen behind:
        // the buffer plays on round the circle, as the hardware would.
        seam.held += blockFrames - produced;
        if (seam.held > outputRate * Math.max(GIVE_UP_SECONDS, frames / rate))
        {
            Atomics.store(header, STREAMING, 0);
            seam.held = 0;
        }
    }
    else
    {
        seam.held = 0;
    }
    // The engine runs while this block is made. Each write below is over
    // what the block read and nothing newer: a Play or a SetCurrentPosition
    // made meanwhile stands, and is what the next block plays.
    if (ended)
    {
        seam.pos = 0;
        if (Atomics.compareExchange(header, PLAYING, playing, 0) === playing)
        {
            Atomics.compareExchange(header, POSITION, cursor, 0);
            Atomics.add(header, ENDS, 1);
        }
    }
    else
    {
        const consumed = Math.floor(pos);
        seam.pos = pos - consumed;
        const reached = start + consumed;
        const next = (reached % frames) * stride;
        if (Atomics.compareExchange(header, POSITION, cursor, next) === cursor
            && reached >= frames)
        {
            Atomics.add(header, LAPS, Math.floor(reached / frames));
        }
    }
    if (produced > 0)
    {
        Atomics.add(header, MIXED_FRAMES, produced);
    }
    return produced;
}

/**
 * One table's part of an output block: every slot resampled and added into it,
 * its block and starvation counters advanced. The caller zeroes the block once
 * and adds each process's table in turn, as two films playing at once meet only
 * at the speaker.
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
 * @param {Float32Array} p.block          Added into; zeroed by the caller.
 * @param {number} p.blockFrames
 * @param {number} p.outputRate
 * @param {Uint8Array | null} [p.arena] The DMA voices' mirrors.
 * @returns {number} the most any one slot produced
 */
function mixBlock({ global, slots, seams, block, blockFrames, outputRate, arena }){
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

/**
 * The audio thread's end of a ring it cannot share: on a page without shared
 * memory the engine posts the frames it mixed, in chunks, each tagged with the
 * frame of the ring it starts at, and this plays them in order. `position` is
 * that same count for the frame played last, so what the audio thread reports
 * back is a place in the ring rather than a number of its own, and a chunk that
 * starts further on -- the engine cleared the ring -- is played from where it
 * says rather than shifted back to close the gap.
 *
 * @typedef {{ chunks: { at: number, frames: Float32Array }[], offset: number,
 *     position: number, blocks: number, starvedBlocks: number,
 *     starvedFrames: number }} Feed
 * @returns {Feed}
 */
function createFeed(){
    return { chunks: [], offset: 0, position: 0, blocks: 0, starvedBlocks: 0, starvedFrames: 0 };
}

/**
 * One block out of a feed, interleaved stereo as `mixBlock` makes it, with
 * silence where nothing has come yet.
 *
 * @param {Feed} feed
 * @param {Float32Array} block
 * @param {number} blockFrames
 * @returns {number} the frames that were sound rather than silence
 */
function playFeed(feed, block, blockFrames){
    feed.blocks++;
    let frame = 0;
    while (frame < blockFrames && feed.chunks.length > 0)
    {
        const chunk = feed.chunks[0];
        if (feed.offset === 0 && chunk.at > feed.position)
        {
            feed.position = chunk.at;
        }
        const take = Math.min(chunk.frames.length / 2 - feed.offset, blockFrames - frame);
        block.set(chunk.frames.subarray(feed.offset * 2, (feed.offset + take) * 2), frame * 2);
        frame += take;
        feed.offset += take;
        feed.position += take;
        if (feed.offset * 2 >= chunk.frames.length)
        {
            feed.chunks.shift();
            feed.offset = 0;
        }
    }
    if (frame < blockFrames)
    {
        block.fill(0, frame * 2, blockFrames * 2);
        feed.starvedBlocks++;
        feed.starvedFrames += blockFrames - frame;
    }
    return frame;
}

/* WORKLET-SHARED:END */

/**
 * @typedef {{ global: Int32Array, slots: { header: Int32Array, pcm: Uint8Array }[],
 *     seams: Seam[], arena: Uint8Array | null }} PlayedTable
 */

/**
 * A track table as the output reads it: its header, its slots, and the DMA
 * voices' mirrors after the last slot -- a table made without them plays its
 * queues alone.
 *
 * @param {ArrayBufferLike} table
 * @returns {PlayedTable}
 */
function playedTable(table){
    const slots = [];
    const seams = [];
    for (let slot = 0; slot < SLOTS; slot++)
    {
        slots.push({
            header: new Int32Array(table, slotHeaderOffset(slot), SLOT_HEADER_INT32),
            pcm: new Uint8Array(table, slotPcmOffset(slot), SLOT_BYTES),
        });
        seams.push(createSeam());
    }
    const arenaAt = GLOBAL_HEADER_BYTES + SLOTS * SLOT_STRIDE;
    return {
        global: new Int32Array(table, 0, GLOBAL_HEADER_INT32),
        slots,
        seams,
        arena: table.byteLength >= arenaAt + ARENA_BYTES
            ? new Uint8Array(table, arenaAt, ARENA_BYTES) : null,
    };
}

/**
 * Blocks between two reports of a feed's progress: about ten milliseconds at
 * 48 kHz, so the engine hears often enough to keep the feed topped up, and the
 * audio thread posts a hundred small messages a second rather than one a block.
 */
const REPORT_BLOCKS = 4;

class BottlifyOutput extends AudioWorkletProcessor {
    /** @param {any} options */
    constructor(options){
        super();
        const { table, channels } = options.processorOptions;
        this.channels = channels;
        // 128 is the largest block WebAudio has ever asked for; grown on a
        // bigger request rather than assumed, so a future engine's bigger
        // quantum does not overrun it.
        this.block = new Float32Array(128 * 2);
        this.running = true;
        /** @type {Feed | null} */
        this.feed = null;
        /** @type {MessagePort | null} */
        this.feedPort = null;
        this.port.onmessage = (/** @type {any} */ event)=>{
            if (event.data === 'stop')
            {
                this.running = false;
            }
            else if (event.data?.type === 'table' && event.data.table && !this.feed)
            {
                this.tables.set(event.data.id, playedTable(event.data.table));
            }
            else if (event.data?.type === 'untable')
            {
                this.tables.delete(event.data.id);
            }
            else if (event.data?.type === 'feed')
            {
                // The engine's own end of a channel the page made, so the
                // frames come straight from the engine's thread rather than
                // through the page's, which a busy interface would hold up.
                const port = event.data.port;
                port.onmessage = (/** @type {any} */ message)=>{
                    this.feed?.chunks.push(message.data);
                };
                this.feedPort = port;
            }
        };
        /**
         * Every table this output plays: the run's, and one for each process
         * running beside another, which the page hands over as it starts and
         * takes back as it goes. Each process's sound is its own, as two
         * films playing at once are, and they meet only here.
         *
         * @type {Map<string | number, PlayedTable>}
         */
        this.tables = new Map();
        if (!table)
        {
            // No shared memory to read a table from: the engine mixes on its
            // own thread and posts the mix.
            this.feed = createFeed();
            return;
        }
        this.tables.set('run', playedTable(table));
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
        if (this.feed)
        {
            const feed = this.feed;
            playFeed(feed, this.block, blockFrames);
            if (feed.blocks % REPORT_BLOCKS === 0)
            {
                this.feedPort?.postMessage({
                    played: feed.position, blocks: feed.blocks,
                    starvedBlocks: feed.starvedBlocks, starvedFrames: feed.starvedFrames,
                });
            }
        }
        else
        {
            // The engine's own idea of its output rate, not the audio
            // context's: a mismatch between the two is a configuration error
            // elsewhere, and resampling against the rate the engine actually
            // assumed is what keeps this processor self-consistent regardless.
            this.block.fill(0, 0, blockFrames * 2);
            for (const played of this.tables.values())
            {
                mixBlock({ ...played, block: this.block, blockFrames,
                    outputRate: Atomics.load(played.global, OUTPUT_RATE) });
            }
        }
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
