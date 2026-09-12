/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseFrameHeader, id3Length, splitFrames, scanFrames, interleave16, createWebCodecsDecoder,
    createSynchronousDecoder,
} from './mp3.js';

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo: 417 bytes a frame. */
const MPEG1_HEADER = [0xff, 0xfb, 0x90, 0x00];
/** MPEG-2 layer III, 64 kbit/s, 22.05 kHz, mono, padded: 208 + 1 bytes. */
const MPEG2_HEADER = [0xff, 0xf3, 0x82, 0xc0];

/**
 * A stream of `count` frames, each filled with its own index.
 *
 * @param {number} count @param {number[]} header @param {number} length
 */
function stream(count, header = MPEG1_HEADER, length = 417){
    const bytes = new Uint8Array(count * length);
    for (let index = 0; index < count; index++)
    {
        bytes.fill(index + 1, index * length, (index + 1) * length);
        bytes.set(header, index * length);
    }
    return bytes;
}

test('a header says how long its frame is and what is in it', ()=>{
    const one = parseFrameHeader(new Uint8Array(MPEG1_HEADER), 0);
    assert.deepEqual(one, {
        version: 1, bitrate: 128000, sampleRate: 44100, channels: 2, length: 417, samples: 1152,
    });
    const two = parseFrameHeader(new Uint8Array(MPEG2_HEADER), 0);
    assert.deepEqual(two, {
        version: 2, bitrate: 64000, sampleRate: 22050, channels: 1, length: 209, samples: 576,
    });
});

test('what is not a layer III header is refused', ()=>{
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb]), 0), null, 'too short');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfd, 0x90, 0]), 0), null, 'layer II');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0xf0, 0]), 0), null, 'bad bitrate');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xfb, 0x9c, 0]), 0), null, 'bad rate');
    assert.equal(parseFrameHeader(new Uint8Array([0xff, 0xeb, 0x90, 0]), 0), null,
        'the reserved version');
});

test('an ID3v2 tag at the front is stepped over', ()=>{
    const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0x02, 0x01]);
    assert.equal(id3Length(tag), 10 + 257);
    const withFooter = Uint8Array.from(tag);
    withFooter[5] = 0x10;
    assert.equal(id3Length(withFooter), 10 + 257 + 10);
    assert.equal(id3Length(new Uint8Array(MPEG1_HEADER)), 0);
});

test('the stream is cut at its frames, and a false sync inside one is not a frame', ()=>{
    const bytes = stream(3);
    // A sync pattern in the middle of frame two, where audio data may carry one.
    bytes.set(MPEG1_HEADER, 417 + 100);
    const frames = splitFrames(bytes);
    assert.deepEqual(frames.map(frame=>frame.offset), [0, 417, 834]);
    assert.equal(frames[0].header.length, 417);
});

test('a tag in front and a truncated frame at the end are both left out', ()=>{
    const tag = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
    const bytes = new Uint8Array([...tag, ...stream(2), ...MPEG1_HEADER, 0, 0]);
    assert.deepEqual(splitFrames(bytes).map(frame=>frame.offset), [15, 15 + 417]);
});

/** An AudioData with two planes of floats. */
function planarData(){
    const planes = [Float32Array.of(0, 0.5, -1), Float32Array.of(1, -0.5, 0.25)];
    return {
        format: 'f32-planar', numberOfChannels: 2, numberOfFrames: 3,
        /** @param {Float32Array} buffer @param {{ planeIndex: number }} options */
        copyTo: (buffer, { planeIndex })=>buffer.set(planes[planeIndex]),
        close: ()=>{},
    };
}

test('planar floats become interleaved 16-bit samples, clamped', ()=>{
    assert.deepEqual([...interleave16(planarData())],
        [0, 32767, 16384, -16383, -32767, 8192]);
    const interleaved = {
        format: 's16', numberOfChannels: 2, numberOfFrames: 2,
        /** @param {Int16Array} buffer */
        copyTo: buffer=>buffer.set([1, 2, 3, 4]),
    };
    assert.deepEqual([...interleave16(interleaved)], [1, 2, 3, 4]);
});

test('a partial buffer yields only the frames it can confirm, and says where to resume', ()=>{
    const bytes = stream(3);
    // Two frames and most of a third: the second is confirmed by the third's
    // header, the third waits for what follows it.
    const partial = scanFrames(bytes, 0, 417 * 2 + 300, false);
    assert.deepEqual(partial.frames.map(frame=>frame.offset), [0, 417]);
    assert.equal(partial.next, 834, 'resume at the unconfirmed frame, not past it');
    const rest = scanFrames(bytes, partial.next, bytes.length, true);
    assert.deepEqual(rest.frames.map(frame=>frame.offset), [834]);
    assert.equal(rest.next, bytes.length);
    // Fewer bytes than a header: nothing yet, and nothing consumed.
    assert.deepEqual(scanFrames(bytes, 0, 3, false), { frames: [], next: 0 });
});

test('the platform decoder is shaped by the first frame, fed by the frame, flushed', async()=>{
    /** @type {any[]} */
    const chunks = [];
    /** @type {any} */
    let configured = null;
    let closed = false;
    /** @type {any} */
    let sink = null;
    class FakeDecoder {
        state = 'unconfigured';
        /** @param {any} init */
        constructor(init){
            sink = init;
        }
        /** @param {any} config */
        configure(config){
            configured = config;
            this.state = 'configured';
        }
        /** @param {any} chunk */
        decode(chunk){
            chunks.push(chunk);
            sink.output(planarData());
        }
        flush(){
            return Promise.resolve();
        }
        close(){
            closed = true;
            this.state = 'closed';
        }
    }
    class FakeChunk {
        /** @param {any} init */
        constructor(init){
            Object.assign(this, init);
        }
    }
    const bytes = stream(2);
    const frames = splitFrames(bytes);
    const decoder = createWebCodecsDecoder(FakeDecoder, FakeChunk);
    /** @type {Int16Array[]} */
    const out = [];
    const open = decoder.open(frames[0].header, samples=>out.push(samples), ()=>{});
    for (const frame of frames)
    {
        open.feed(bytes.subarray(frame.offset, frame.offset + frame.header.length), frame.header);
    }
    await open.flush();
    open.close();
    open.close();

    assert.deepEqual(configured, { codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 });
    assert.deepEqual(chunks.map(chunk=>[chunk.type, chunk.timestamp, chunk.data.length]),
        [['key', 0, 417], ['key', 26122, 417]]);
    assert.equal(chunks[1].data[0], 0xff, 'each chunk starts at its own header');
    assert.equal(out.length, 2);
    assert.ok(closed, 'closed once, and closing again is harmless');
});

test('a platform without the decoder refuses to open rather than answering silence', ()=>{
    const decoder = createWebCodecsDecoder(undefined, undefined);
    const header = splitFrames(stream(1))[0].header;
    assert.throws(()=>decoder.open(header, ()=>{}, ()=>{}), /no MPEG audio decoder/);
});

/**
 * A hosted stream that turns each frame into samples carrying the frame's
 * first data byte, and records what was asked of it.
 *
 * @param {{ short?: boolean, failing?: boolean }} [options]
 */
function hostedStream(options = {}){
    /** @type {any[]} */
    const calls = [];
    let closed = false;
    return {
        calls,
        closed: ()=>closed,
        /** @param {{ formatTag: number, sampleRate: number, channels: number }} shape */
        openAudio: shape=>{
            calls.push(shape);
            return {
                sampleRate: shape.sampleRate,
                channels: shape.channels,
                /** @param {Uint8Array} bytes */
                feed: bytes=>{
                    calls.push(['feed', bytes.length]);
                    if (options.failing)
                    {
                        throw new Error('the decoded audio was not taken away');
                    }
                    return options.short ? new Int16Array(0)
                        : new Int16Array(1152 * 2).fill(bytes[4]);
                },
                flush: ()=>{
                    calls.push(['flush']);
                    return Int16Array.of(7, 7);
                },
                close: ()=>{
                    closed = true;
                },
            };
        },
    };
}

/** A fallback that must not be reached. */
const NEVER = {
    open: ()=>{
        throw new Error('the fallback was used');
    },
};

test('the hosted decoder answers inside feed, flushes the rest in the call, and closes', async()=>{
    const hosted = hostedStream();
    const decoder = createSynchronousDecoder(hosted.openAudio, NEVER);
    const bytes = stream(2);
    const frames = splitFrames(bytes);
    /** @type {Int16Array[]} */
    const out = [];
    const open = decoder.open(frames[0].header, samples=>out.push(samples), ()=>{
        assert.fail('nothing failed');
    });
    assert.deepEqual(hosted.calls[0], { formatTag: 0x55, sampleRate: 44100, channels: 2 });

    open.feed(bytes.subarray(0, 417), frames[0].header);
    assert.equal(out.length, 1, 'the samples were delivered before feed returned');
    assert.equal(out[0].length, 1152 * 2);
    assert.equal(out[0][0], 1);
    open.feed(bytes.subarray(417, 834), frames[1].header);
    assert.equal(out[1][0], 2);

    const flushed = open.flush();
    assert.equal(out.length, 3, 'what the decoder still held came out before flush returned');
    assert.deepEqual([...out[2]], [7, 7]);
    await flushed;
    open.close();
    assert.ok(hosted.closed());
    assert.deepEqual(decoder.diagnostics?.(),
        { name: 'synchronous', opens: 1, fallbackOpens: 0, paddedFrames: 0 });
});

test('a frame the hosted decoder answers short is made up with silence', ()=>{
    const hosted = hostedStream({ short: true });
    const decoder = createSynchronousDecoder(hosted.openAudio, NEVER);
    const bytes = stream(1);
    const [frame] = splitFrames(bytes);
    /** @type {Int16Array[]} */
    const out = [];
    const open = decoder.open(frame.header, samples=>out.push(samples), ()=>{});
    open.feed(bytes, frame.header);
    // What came out accounts for what went in: a request is never left
    // waiting for samples that will not arrive.
    assert.equal(out.length, 1);
    assert.equal(out[0].length, 1152 * 2);
    assert.ok(out[0].every(sample=>sample === 0));
    assert.equal(decoder.diagnostics?.()?.paddedFrames, 1);
});

test('a hosted stream that fails reports it rather than hanging the caller', ()=>{
    const hosted = hostedStream({ failing: true });
    const decoder = createSynchronousDecoder(hosted.openAudio, NEVER);
    const bytes = stream(1);
    const [frame] = splitFrames(bytes);
    /** @type {Error | null} */
    let failure = null;
    const open = decoder.open(frame.header, ()=>{
        assert.fail('no samples from a failed feed');
    }, error=>{
        failure = error;
    });
    open.feed(bytes, frame.header);
    assert.match(/** @type {any} */ (failure)?.message, /not taken away/);
});

test('without a hosted stream the platform decoder takes the stream', ()=>{
    /** @type {any[]} */
    const opened = [];
    const fallback = {
        /** @type {import('./mp3.js').Decoder['open']} */
        open: header=>{
            opened.push(header);
            return { feed: ()=>{}, flush: ()=>Promise.resolve(), close: ()=>{} };
        },
    };
    const decoder = createSynchronousDecoder(()=>null, fallback);
    const header = splitFrames(stream(1))[0].header;
    decoder.open(header, ()=>{}, ()=>{});
    assert.deepEqual(opened, [header]);
    assert.deepEqual(decoder.diagnostics?.(),
        { name: 'synchronous', opens: 0, fallbackOpens: 1, paddedFrames: 0 });
});
