/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMp3Provider, PROVIDER_LIBRARY, ATTRIB } from './provider.js';

const RIB_HANDLE = 0x7100;
const RIB_REGISTER = 0x7200;
const RIB_UNREGISTER = 0x7300;
const FETCH = 0x7400;
const PROVIDER_HANDLE = 0xbeef;
/** Where the provider's own exports are said to be. */
const EXPORTS_AT = 0x8000;

/** MPEG-1 layer III, 128 kbit/s, 44.1 kHz, stereo: 417 bytes a frame. */
const MPEG1_HEADER = [0xff, 0xfb, 0x90, 0x00];

/**
 * A stream of `count` frames, each filled with its own index.
 *
 * @param {number} count
 */
function mp3Stream(count){
    const bytes = new Uint8Array(count * 417);
    for (let index = 0; index < count; index++)
    {
        bytes.fill(index + 1, index * 417, (index + 1) * 417);
        bytes.set(MPEG1_HEADER, index * 417);
    }
    return bytes;
}

/**
 * A flat guest, a sound library that records what the provider tells it and
 * answers a fetch a chunk at a time, and a decoder that turns every frame into
 * samples carrying the frame's index -- when the test lets it.
 *
 * @param {{ file?: Uint8Array, chunk?: number, open?: import('./mp3.js').Decoder['open'],
 *     held?: boolean, slowFetch?: boolean }} [options]
 */
function fixture(options = {}){
    const bytes = new Uint8Array(0x100000);
    const view = new DataView(bytes.buffer);
    let nextAddress = 0x10000;
    const file = options.file ?? mp3Stream(4);
    // What the library hands back to one read: its own buffer's worth.
    const chunk = options.chunk ?? 4096;
    /** @type {{ entry: number, args: number[], thread: any }[]} */
    const calls = [];
    /** Where the library's own stream stands. */
    let fileAt = 0;
    /** @type {Map<string, number>} */
    const exports = new Map();
    let nextExport = EXPORTS_AT;

    /** Frames fed and not yet turned into samples. */
    /** @type {{ header: import('./mp3.js').FrameHeader, index: number }[]} */
    const pending = [];
    let fedCount = 0;
    /** @type {((samples: Int16Array) => void) | null} */
    let emit = null;
    let flushed = false;
    let closed = false;
    // Held back, a fed frame comes out only when the test releases it.
    const held = options.held ?? false;
    /** @type {import('./mp3.js').Decoder['open']} */
    const open = options.open ?? ((header, onPcm)=>{
        emit = onPcm;
        return {
            feed: (_bytes, frame)=>{
                pending.push({ header: frame, index: fedCount++ });
                if (!held)
                {
                    release(1);
                }
            },
            flush: ()=>{
                flushed = true;
                release(Infinity);
                return Promise.resolve();
            },
            close: ()=>{
                closed = true;
            },
        };
    });
    /** Lets the decoder turn up to `count` fed frames into samples. */
    const release = (/** @type {number} */ count)=>{
        while (pending.length > 0 && count-- > 0)
        {
            const { header, index } = /** @type {any} */ (pending.shift());
            emit?.(new Int16Array(header.samples * header.channels).fill(index + 1));
        }
    };

    const provider = createMp3Provider({
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        writeMemory: (address, data)=>bytes.set(data, address),
        allocate: size=>{
            const address = nextAddress;
            nextAddress += (size + 0xf) & ~0xf;
            return address;
        },
        callGuest: (entry, args, thread)=>{
            calls.push({ entry, args, thread });
            if (entry === RIB_HANDLE)
            {
                return Promise.resolve(PROVIDER_HANDLE);
            }
            if (entry === FETCH)
            {
                const [, dest, ask, offset] = args;
                // The library's own convention: -1 continues, and a named
                // offset repositions its stream.
                if (offset !== -1)
                {
                    fileAt = offset;
                }
                const part = file.subarray(fileAt, fileAt + Math.min(ask, chunk));
                bytes.set(part, dest);
                fileAt += part.length;
                // The guest copies at once, and the call answers later.
                return options.slowFetch
                    ? new Promise(resolve=>setImmediate(()=>resolve(part.length)))
                    : Promise.resolve(part.length);
            }
            return Promise.resolve(0);
        },
        currentThread: ()=>'t1',
        resolveImport: (library, name)=>{
            if (library === 'mss32.dll')
            {
                return { '_RIB_provider_library_handle@0': RIB_HANDLE,
                    RIB_register_interface: RIB_REGISTER,
                    RIB_unregister_interface: RIB_UNREGISTER }[name] ?? null;
            }
            assert.equal(library, PROVIDER_LIBRARY);
            if (!exports.has(name))
            {
                exports.set(name, nextExport);
                nextExport += 0x10;
            }
            return /** @type {number} */ (exports.get(name));
        },
        decoder: { open },
    });
    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */
    const table = provider.libraries[PROVIDER_LIBRARY];

    return {
        bytes, view, calls, provider, table, exports, file,
        fetches: ()=>calls.filter(call=>call.entry === FETCH)
            .map(call=>[call.args[2], call.args[3]]),
        /** Repositions the library's stream, as it does itself before a seek. */
        reposition: (/** @type {number} */ at)=>{
            fileAt = at;
        },
        release,
        fed: ()=>fedCount,
        flushed: ()=>flushed,
        closed: ()=>closed,
        /** @param {string} name @param {number[]} args */
        call: (name, args)=>table[name].handler(args),
        /** @param {number} address */
        string: address=>{
            let end = address;
            while (bytes[end] !== 0)
            {
                end++;
            }
            return new TextDecoder().decode(bytes.subarray(address, end));
        },
        /** @param {number} at @param {number} count */
        entries: (at, count)=>Array.from({ length: count }, (_, index)=>{
            const offset = at + index * 16;
            return {
                type: view.getUint32(offset, true),
                name: view.getUint32(offset + 4, true),
                token: view.getInt32(offset + 8, true),
                subtype: view.getUint32(offset + 12, true),
            };
        }),
    };
}

test('attaching registers both interfaces through the sound library, as it expects them', async()=>{
    const f = fixture();
    assert.equal(await f.call('DllMain', [0x26f00000, 1, 0]), 1);

    assert.deepEqual(f.calls.map(call=>call.entry), [RIB_HANDLE, RIB_REGISTER, RIB_REGISTER]);
    assert.ok(f.calls.every(call=>call.thread === 't1'), 'on the thread that loaded the library');
    const [, codec, streams] = f.calls;
    assert.equal(codec.args[0], PROVIDER_HANDLE);
    assert.equal(f.string(codec.args[1]), 'ASI codec');
    assert.equal(codec.args[2], 10);
    assert.equal(f.string(streams.args[1]), 'ASI stream');
    assert.equal(streams.args[2], 22);

    // The codec table: a function, six attributes, three functions -- typed
    // and numbered as the redistributable decoder registers them.
    const codecEntries = f.entries(codec.args[3], 10);
    assert.deepEqual(codecEntries.map(entry=>[entry.type, f.string(entry.name), entry.subtype]), [
        [0, 'PROVIDER_query_attribute', 0],
        [1, 'Name', 7], [1, 'Version', 3], [1, 'Input file types', 7], [1, 'Input wave tag', 2],
        [1, 'Output file types', 7], [1, 'Maximum frame size', 2],
        [0, 'ASI_startup', 0], [0, 'ASI_error', 0], [0, 'ASI_shutdown', 0],
    ]);
    assert.deepEqual(codecEntries.slice(1, 7).map(entry=>entry.token), [-100, -101, 0, 1, 2, 3]);
    assert.equal(codecEntries[0].token, f.exports.get('PROVIDER_query_attribute'),
        'a function token is the export the library will call');

    const streamEntries = f.entries(streams.args[3], 22);
    assert.deepEqual(streamEntries.slice(0, 6).map(entry=>f.string(entry.name)), [
        'ASI_stream_open', 'ASI_stream_process', 'ASI_stream_attribute',
        'ASI_stream_set_preference', 'ASI_stream_seek', 'ASI_stream_close',
    ]);
    assert.deepEqual(streamEntries.slice(6).map(entry=>[entry.type, entry.token, entry.subtype]), [
        [1, 4, 2], [1, 5, 2], [1, 6, 2], [1, 7, 2], [1, 8, 2], [1, 9, 2], [1, 10, 2], [1, 11, 2],
        [1, 12, 2], [1, 13, 5], [1, 14, 2], [1, 15, 2], [1, 16, 2],
        [2, 17, 2], [2, 18, 2], [2, 19, 2],
    ]);
    assert.equal(f.provider.diagnostics().registered, true);

    // A second attach is not a second registration; detaching takes them back.
    await f.call('DllMain', [0x26f00000, 1, 0]);
    assert.equal(f.calls.length, 3);
    await f.call('DllMain', [0x26f00000, 0, 0]);
    assert.deepEqual(f.calls.slice(3).map(call=>call.entry), [RIB_UNREGISTER, RIB_UNREGISTER]);
    assert.equal(f.provider.diagnostics().registered, false);
});

test('the codec answers for itself: name, version, file types, wave tag, frame size', ()=>{
    const f = fixture();
    assert.equal(f.string(f.call('PROVIDER_query_attribute', [ATTRIB.NAME])),
        'MSS MPEG Layer 3 Audio Decoder');
    assert.equal(f.call('PROVIDER_query_attribute', [ATTRIB.VERSION]), 0x100);
    const types = f.call('PROVIDER_query_attribute', [ATTRIB.INPUT_FILE_TYPES]);
    assert.equal(f.string(types), 'MPEG Layer 3 audio files');
    assert.equal(f.string(types + 'MPEG Layer 3 audio files'.length + 1), '*.MP3');
    assert.equal(f.bytes[types + 'MPEG Layer 3 audio files\0*.MP3\0'.length], 0,
        'a list ends twice');
    assert.equal(f.string(f.call('PROVIDER_query_attribute', [ATTRIB.OUTPUT_FILE_TYPES])),
        'Raw PCM files');
    assert.equal(f.call('PROVIDER_query_attribute', [ATTRIB.INPUT_WAVE_TAG]), 0x55);
    assert.equal(f.call('PROVIDER_query_attribute', [ATTRIB.MAXIMUM_FRAME_SIZE]), 0x1000);
    assert.equal(f.call('PROVIDER_query_attribute', [42]), 0);
    assert.equal(f.call('ASI_startup', []), 0);
    assert.equal(f.call('ASI_shutdown', []), 0);
    assert.equal(f.call('ASI_error', []), 0, 'nothing has gone wrong');
});

test('opening a stream reads until its first frame and describes it', async()=>{
    const f = fixture();
    // The size word is the library's buffer, not the stream: measured at 4096
    // for a stream of megabytes, so it must not cap the reads.
    const handle = await f.call('ASI_stream_open', [0x55, FETCH, 4096]);
    assert.equal(handle, 1);
    assert.deepEqual(f.fetches(), [[10, -1], [417 + 4 - 10, -1]],
        'the size of a tag header, then the first frame and the header that confirms it');
    assert.equal(f.calls.find(call=>call.entry === FETCH)?.args[0], 0x55, 'the user word');
    assert.equal(f.fed(), 1, 'nothing past the first frame is read');

    const attribute = (/** @type {number} */ which)=>f.call('ASI_stream_attribute', [handle, which]);
    assert.equal(attribute(ATTRIB.INPUT_BIT_RATE), 128000);
    assert.equal(attribute(ATTRIB.INPUT_SAMPLE_RATE), 44100);
    assert.equal(attribute(ATTRIB.INPUT_CHANNELS), 2);
    assert.equal(attribute(ATTRIB.OUTPUT_SAMPLE_RATE), 44100);
    assert.equal(attribute(ATTRIB.OUTPUT_SAMPLE_WIDTH), 16);
    assert.equal(attribute(ATTRIB.OUTPUT_CHANNELS), 2);
    assert.equal(attribute(ATTRIB.OUTPUT_BIT_RATE), 44100 * 2 * 16);
    assert.equal(attribute(ATTRIB.MPEG_VERSION), 1);
    assert.equal(attribute(ATTRIB.MPEG_LAYER), 3);
    assert.equal(attribute(ATTRIB.POSITION), 0);
    assert.equal(attribute(ATTRIB.PERCENT_DONE), 0);
    assert.equal(attribute(ATTRIB.MINIMUM_INPUT_BLOCK_SIZE), 0x1000);
});

test('the rest of a stream is read as samples are asked for, continuing each time', async()=>{
    const file = mp3Stream(40); // 16680 bytes: five chunks of 4096
    const f = fixture({ file, held: true });
    // Opening waits for the lead to be decoded out of the first chunk.
    const opening = f.call('ASI_stream_open', [1, FETCH, 4096]);
    await new Promise(resolve=>setImmediate(resolve));
    f.release(8);
    const handle = await opening;
    const buffer = 0x80000;
    const perFrame = 1152 * 2 * 2;

    // Nine frames fit the first chunk; asking for twelve reads on, and waits
    // for the decoder to catch up rather than answering short.
    const pending = f.call('ASI_stream_process', [handle, buffer, perFrame * 12]);
    assert.ok(pending instanceof Promise);
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(f.fed() >= 12, `fed ${f.fed()} frames to cover the request`);
    f.release(12);
    assert.equal(await pending, perFrame * 12);
    assert.equal(f.view.getInt16(buffer, true), 1);
    assert.equal(f.view.getInt16(buffer + perFrame * 11, true), 12);
    assert.ok(f.fetches().every(([, offset])=>offset === -1),
        'no read names an offset: the library serves sequentially');

    // Everything else: the reads reach the end, the decoder is flushed, and the
    // stream ends with a zero.
    f.release(Infinity);
    const rest = f.call('ASI_stream_process', [handle, buffer, perFrame * 100]);
    await new Promise(resolve=>setImmediate(resolve));
    f.release(Infinity);
    assert.equal(await rest, perFrame * 28);
    assert.ok(f.flushed(), 'input spent: the decoder was flushed');
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame]), 0);
    assert.equal(f.call('ASI_stream_attribute', [handle, ATTRIB.PERCENT_DONE]), 97,
        'against what was read, since the size word was not the stream');
    assert.equal(f.fetches().at(-1)?.[1], -1, 'the read that answered nothing');
    assert.equal(f.provider.diagnostics().samplesOut, 40 * 1152 * 2);
});

test('a lead is decoded before a stream is handed over, and requests come out of it', async()=>{
    const file = mp3Stream(40);
    const f = fixture({ file, held: true });
    const buffer = 0x80000;
    const perFrame = 1152 * 2 * 2;

    // The first frame has not come back, so the decoder answers later: the
    // open reads a lead of eight and waits for it, once, rather than every
    // request waiting.
    const opening = f.call('ASI_stream_open', [1, FETCH, 4096]);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.fed(), 8);
    let opened = false;
    opening.then(()=>{
        opened = true;
    });
    f.release(7);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(opened, false, 'seven of eight is not the lead');
    f.release(1);
    const handle = await opening;
    assert.equal(f.provider.streams().get(handle)?.decoded, 8 * 1152 * 2);

    // Answered at once, without a promise, for as long as the lead covers it.
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame * 3]), perFrame * 3);
    assert.equal(f.view.getInt16(buffer, true), 1);
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame * 5]), perFrame * 5);
    assert.equal(f.view.getInt16(buffer + perFrame * 4, true), 8);
    assert.equal(f.provider.diagnostics().waits, 0);

    // Past the lead the request waits -- and the read that answers it runs a
    // lead ahead of the request, so the wait that follows restores it.
    const pending = f.call('ASI_stream_process', [handle, buffer, perFrame * 2]);
    assert.ok(pending instanceof Promise);
    await new Promise(resolve=>setImmediate(resolve));
    assert.ok(f.fed() >= 8 + 2 + 8, `fed ${f.fed()}: the request and a lead past it`);
    f.release(Infinity);
    assert.equal(await pending, perFrame * 2);
    assert.equal(f.view.getInt16(buffer, true), 9);
    assert.equal(f.provider.diagnostics().waits, 1);
});

test('a request the decoder has already answered is answered at once', async()=>{
    const f = fixture();
    const handle = await f.call('ASI_stream_open', [1, FETCH, f.file.length]);
    const buffer = 0x80000;
    const perFrame = 1152 * 2 * 2;
    // Half a frame past the first: the second frame is read and decoded whole.
    assert.equal(await f.call('ASI_stream_process', [handle, buffer, perFrame * 1.5]),
        perFrame * 1.5);
    assert.equal(f.view.getInt16(buffer, true), 1);
    assert.equal(f.view.getInt16(buffer + perFrame, true), 2);
    // Its other half is here already: answered in the call.
    assert.equal(f.call('ASI_stream_attribute', [handle, ATTRIB.POSITION]), 417);
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame / 2]), perFrame / 2);
    assert.equal(f.view.getInt16(buffer, true), 2);
    assert.equal(f.call('ASI_stream_attribute', [handle, ATTRIB.PERCENT_DONE]), 25);
    assert.equal(f.provider.diagnostics().waits, 0);
});

test('seeking names a byte of the input, and lands on the frame that holds it', async()=>{
    const f = fixture();
    const handle = await f.call('ASI_stream_open', [1, FETCH, f.file.length]);
    const buffer = 0x80000;
    const perFrame = 1152 * 2 * 2;
    assert.equal(await f.call('ASI_stream_process', [handle, buffer, perFrame * 4]), perFrame * 4);
    assert.equal(await f.call('ASI_stream_seek', [handle, 417 * 2 + 5]), 0);
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame]), perFrame);
    assert.equal(f.view.getInt16(buffer, true), 4, 'the frame after the byte named');
    assert.equal(await f.call('ASI_stream_seek', [handle, -1]), 0, 'a reset with nothing to reset');
    assert.equal(await f.call('ASI_stream_seek', [handle, 0]), 0);
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame]), perFrame);
    assert.equal(f.view.getInt16(buffer, true), 1);
    assert.equal(f.call('ASI_stream_close', [handle]), 0);
    assert.ok(f.closed());
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame]), 0, 'closed');
    assert.equal(f.provider.diagnostics().open, 0);
});

test('a seek past what is held continues from the byte named; back to the start replays', async()=>{
    const file = mp3Stream(40);
    const f = fixture({ file });
    const handle = await f.call('ASI_stream_open', [1, FETCH, file.length]);
    // The library has moved its stream to the byte named before asking, and
    // serves from there: the bytes between are never seen.
    f.reposition(417 * 30);
    assert.equal(f.call('ASI_stream_seek', [handle, 417 * 30]), 0);
    const buffer = 0x80000;
    const pending = f.call('ASI_stream_process', [handle, buffer, 1152 * 4]);
    assert.equal(await pending, 1152 * 4);
    // The second frame fed, and it is the one at the byte named.
    assert.equal(f.view.getInt16(buffer, true), 2);
    assert.equal(f.provider.streams().get(1)?.frames[1]?.offset, 417 * 30);
    assert.ok(f.fetches().every(([, offset])=>offset === -1), 'every read continued');
    // To the end, then back to the start: what is held replays, and the bytes
    // the library serves again are dropped rather than appended.
    assert.equal(await f.call('ASI_stream_process', [handle, buffer, 1152 * 4 * 60]), 1152 * 4 * 9);
    const held = f.provider.streams().get(1)?.frames.length;
    f.reposition(0);
    assert.equal(f.call('ASI_stream_seek', [handle, 0]), 0);
    assert.equal(f.call('ASI_stream_process', [handle, buffer, 1152 * 4]), 1152 * 4);
    assert.equal(f.view.getInt16(buffer, true), 1);
    assert.equal(await f.call('ASI_stream_process', [handle, buffer, 1152 * 4 * 60]),
        1152 * 4 * ((held ?? 0) - 1));
    assert.equal(f.provider.streams().get(1)?.frames.length, held, 'no frame twice');
});

test('a preference is kept and its previous value returned', async()=>{
    const f = fixture();
    const handle = await f.call('ASI_stream_open', [1, FETCH, f.file.length]);
    f.view.setInt32(0x90000, 22050, true);
    const rate = ATTRIB.REQUESTED_SAMPLE_RATE;
    assert.equal(f.call('ASI_stream_set_preference', [handle, rate, 0x90000]), 0);
    assert.equal(f.call('ASI_stream_attribute', [handle, rate]), 22050);
    f.view.setInt32(0x90000, 11025, true);
    assert.equal(f.call('ASI_stream_set_preference', [handle, rate, 0x90000]), 22050);
});

test('a preference passed by value, as an older Miles passes it, is taken as the value', async()=>{
    // 0x5622 is 22050 itself: an address in the low 64 KiB is never mapped.
    const f = fixture();
    const handle = await f.call('ASI_stream_open', [1, FETCH, f.file.length]);
    const rate = ATTRIB.REQUESTED_SAMPLE_RATE;
    assert.equal(f.call('ASI_stream_set_preference', [handle, rate, 0x5622]), 0);
    assert.equal(f.call('ASI_stream_attribute', [handle, rate]), 22050);
});

test('a stream with no frames in it does not open, and says why', async()=>{
    const f = fixture({ file: new Uint8Array(1000).fill(7) });
    assert.equal(await f.call('ASI_stream_open', [1, FETCH, 1000]), 0);
    assert.equal(f.string(f.call('ASI_error', [])),
        'MPEG audio header not found or is badly formatted');
    assert.equal(f.provider.diagnostics().failedOpens, 1);
});

test('a decoder that fails ends the stream instead of hanging the caller', async()=>{
    /** @type {(error: Error) => void} */
    let failWith = ()=>{};
    const f = fixture({ open: (_header, _onPcm, onError)=>{
        failWith = onError;
        return { feed: ()=>{}, flush: ()=>Promise.resolve(), close: ()=>{} };
    } });
    // The open is waiting for its lead when the decoder gives up; it opens
    // anyway, as a stream that is over, and every request answers zero.
    const opening = f.call('ASI_stream_open', [1, FETCH, f.file.length]);
    await new Promise(resolve=>setImmediate(resolve));
    failWith(new Error('no codec'));
    const handle = await opening;
    assert.equal(f.call('ASI_stream_process', [handle, 0x80000, 4608]), 0);
    assert.match(f.provider.diagnostics().lastError, /no codec/);
});

test('a platform that cannot open a decoder refuses the stream', async()=>{
    const f = fixture({ open: ()=>{
        throw new Error('no MPEG audio decoder on this platform');
    } });
    assert.equal(await f.call('ASI_stream_open', [1, FETCH, f.file.length]), 0);
    assert.match(f.provider.diagnostics().lastError, /no decoder/);
});

test('a decoder that answers in the call never parks a request', async()=>{
    const file = mp3Stream(40);
    let fed = 0;
    // Shaped like the hosted decoder: the samples for a frame are delivered
    // inside feed, and nothing is left pending anywhere.
    const f = fixture({ file, open: (_header, onPcm)=>({
        feed: (_bytes, frame)=>onPcm(new Int16Array(frame.samples * frame.channels).fill(++fed)),
        flush: ()=>Promise.resolve(),
        close: ()=>{},
    }) });
    const handle = await f.call('ASI_stream_open', [1, FETCH, 4096]);
    assert.equal(f.provider.diagnostics().waits, 0, 'the open did not wait for its lead');
    const buffer = 0x80000;
    const perFrame = 1152 * 2 * 2;

    // Read for as the request needs it; the decoder answers inside the read.
    assert.equal(await f.call('ASI_stream_process', [handle, buffer, perFrame * 9]), perFrame * 9);
    assert.equal(f.view.getInt16(buffer + perFrame * 8, true), 9);

    // Past it: the read through the library's callback is the only thing the
    // request waits on, and the count comes back whole.
    assert.equal(await f.call('ASI_stream_process', [handle, buffer, perFrame * 12]),
        perFrame * 12);
    assert.equal(f.view.getInt16(buffer, true), 10);
    assert.equal(f.view.getInt16(buffer + perFrame * 11, true), 21);
    assert.equal(await f.call('ASI_stream_process', [handle, buffer, perFrame * 100]),
        perFrame * 19);
    assert.equal(f.call('ASI_stream_process', [handle, buffer, perFrame]), 0, 'the end');
    assert.equal(f.provider.diagnostics().waits, 0, 'no request was ever parked on the decoder');
    assert.equal(f.provider.diagnostics().samplesOut, 40 * 1152 * 2);
});

test('requests that overlap on one stream read its input once each, in order', async()=>{
    const file = mp3Stream(60);
    const f = fixture({ file, slowFetch: true, open: (_header, onPcm)=>({
        feed: (bytes, frame)=>onPcm(new Int16Array(frame.samples * frame.channels).fill(bytes[8])),
        flush: ()=>Promise.resolve(),
        close: ()=>{},
    }) });
    const handle = await f.call('ASI_stream_open', [1, FETCH, 4096]);
    const perFrame = 1152 * 2 * 2;
    const a = 0x80000;
    const b = 0x90000;
    // The service thread and the main thread both ask, past what is decoded.
    const [first, second] = await Promise.all([
        f.call('ASI_stream_process', [handle, a, perFrame * 14]),
        f.call('ASI_stream_process', [handle, b, perFrame * 14]),
    ]);
    assert.equal(first, perFrame * 14);
    assert.equal(second, perFrame * 14);
    const frames = [];
    for (const at of [a, b])
    {
        for (let index = 0; index < 14; index++)
        {
            frames.push(f.view.getInt16(at + index * perFrame, true));
        }
    }
    assert.deepEqual(frames, Array.from({ length: 28 }, (_, index)=>index + 1));
});

test('a stream is read no further ahead of the program than the frame it is taking', async()=>{
    // The library keeps a sample's place by what has been fetched, and a read
    // far ahead of playback was measured coming back with the first bytes again.
    const file = mp3Stream(40);
    const f = fixture({ file });
    const handle = await f.call('ASI_stream_open', [1, FETCH, file.length]);
    const buffer = 0x80000;
    const perFrame = 1152 * 2;
    const request = 356 * 2 * 2;
    // What was asked for; past the end the library answers the asks for the
    // next header with nothing.
    const read = ()=>f.fetches().reduce((sum, [ask])=>sum + ask, 0);
    let taken = 0;
    for (;;)
    {
        const count = await f.call('ASI_stream_process', [handle, buffer, request]);
        taken += count / 2;
        const frames = Math.ceil(taken / perFrame);
        assert.ok(read() <= Math.min(file.length + 4, (frames + 1) * 417) + 4,
            `${read()} bytes read with ${frames} frames begun`);
        if (count < request)
        {
            break;
        }
    }
    assert.equal(taken, 40 * perFrame);
});
