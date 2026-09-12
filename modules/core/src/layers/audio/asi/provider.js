/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The MPEG Layer 3 provider a sound library of this era loads beside a program.
 *
 * The library scans a directory for providers, loads each with LoadLibrary and
 * expects its DllMain to register two interfaces -- "ASI codec" and
 * "ASI stream" -- through the library's own RIB entry points, then calls the
 * registered functions directly. Nothing is exported; the tables are the
 * whole contract, down to the numbers: the entry types, the attribute tokens
 * and the data subtypes are what the library compares against, so they are
 * the ones the redistributable decoder registers, not ones chosen here.
 *
 * The decoding happens on the host. A stream is read through the fetch
 * callback as the library asks for samples, cut into frames, and each frame is
 * handed to the decoder as it arrives. A decoder that answers in the call --
 * the ordinary one -- has every fed frame's samples ready before the request
 * that read it returns, which is how the real provider behaves; a decoder that
 * answers later leaves a request that ran ahead of it waiting rather than
 * answering short, and that wait is counted, because it holds the guest
 * thread and whatever lock the library took before asking.
 */

import { id3Length, scanFrames } from './mp3.js';

/** The provider's file name, which is how the library finds it. */
export const PROVIDER_LIBRARY = 'Mp3dec.asi';
/** Whose entry points the provider registers through. */
const SOUND_LIBRARY = 'mss32.dll';

/** RIB_ENTRY_TYPE, as the library numbers it. */
const RIB_FUNCTION = 0;
const RIB_ATTRIBUTE = 1;
const RIB_PREFERENCE = 2;

/** RIB_DATA_SUBTYPE. */
const RIB_NONE = 0;
const RIB_DEC = 2;
const RIB_HEX = 3;
const RIB_PERCENT = 5;
const RIB_STRING = 7;

/** Attribute tokens: the codec's. */
export const ATTRIB = Object.freeze({
    NAME: -100,
    VERSION: -101,
    INPUT_FILE_TYPES: 0,
    INPUT_WAVE_TAG: 1,
    OUTPUT_FILE_TYPES: 2,
    MAXIMUM_FRAME_SIZE: 3,
    INPUT_BIT_RATE: 4,
    INPUT_SAMPLE_RATE: 5,
    INPUT_SAMPLE_WIDTH: 6,
    INPUT_CHANNELS: 7,
    OUTPUT_BIT_RATE: 8,
    OUTPUT_SAMPLE_RATE: 9,
    OUTPUT_SAMPLE_WIDTH: 10,
    OUTPUT_CHANNELS: 11,
    POSITION: 12,
    PERCENT_DONE: 13,
    MINIMUM_INPUT_BLOCK_SIZE: 14,
    MPEG_VERSION: 15,
    MPEG_LAYER: 16,
    REQUESTED_SAMPLE_RATE: 17,
    REQUESTED_BIT_WIDTH: 18,
    REQUESTED_CHANNELS: 19,
});

const PROVIDER_NAME = 'MSS MPEG Layer 3 Audio Decoder';
const PROVIDER_VERSION = 0x100;
/** A file-type list is a description and a pattern, each NUL-terminated, then a NUL. */
const INPUT_FILE_TYPES = 'MPEG Layer 3 audio files\0*.MP3\0';
const OUTPUT_FILE_TYPES = 'Raw PCM files\0*.RAW\0';
/** WAVE_FORMAT_MPEGLAYER3. */
const INPUT_WAVE_TAG = 0x55;
const MAXIMUM_FRAME_SIZE = 0x1000;
const OUTPUT_SAMPLE_WIDTH = 16;

const ASI_NOERR = 0;
const DLL_PROCESS_ATTACH = 1;
const DLL_PROCESS_DETACH = 0;

/** A RIB_INTERFACE_ENTRY: type, name, token, subtype. */
const ENTRY_SIZE = 16;
/** Compressed bytes are fetched through the guest this many at a time. */
const FETCH_CHUNK = 0x10000;
/** How far into a stream the first frame is looked for before giving up on it. */
const OPEN_PROBE_BYTES = 0x40000;
/**
 * Frames decoded ahead of what the library has taken.
 *
 * The decoder answers on its own schedule -- measured at up to a second
 * between an output and the next while a title starts -- and a request that
 * finds nothing decoded holds the guest thread, and with it whatever lock that
 * thread took before asking, until the output arrives. A lead is decoded before
 * a stream is handed over and kept in front of the position, so the ordinary
 * request is answered from what is already here and the guest waits only when
 * the decoder has fallen this far behind.
 */
const LEAD_FRAMES = 8;

/**
 * @typedef {Object} TableEntry
 * @property {number} type
 * @property {string} name
 * @property {number | string} token   a function's export name, or an attribute token
 * @property {number} subtype
 */

/** @param {string} name */
const fn = name=>({ type: RIB_FUNCTION, name, token: name, subtype: RIB_NONE });
/** @param {string} name @param {number} token @param {number} subtype */
const attribute = (name, token, subtype)=>({ type: RIB_ATTRIBUTE, name, token, subtype });
/** @param {string} name @param {number} token */
const preference = (name, token)=>({ type: RIB_PREFERENCE, name, token, subtype: RIB_DEC });

/** @type {TableEntry[]} */
const CODEC_TABLE = [
    fn('PROVIDER_query_attribute'),
    attribute('Name', ATTRIB.NAME, RIB_STRING),
    attribute('Version', ATTRIB.VERSION, RIB_HEX),
    attribute('Input file types', ATTRIB.INPUT_FILE_TYPES, RIB_STRING),
    attribute('Input wave tag', ATTRIB.INPUT_WAVE_TAG, RIB_DEC),
    attribute('Output file types', ATTRIB.OUTPUT_FILE_TYPES, RIB_STRING),
    attribute('Maximum frame size', ATTRIB.MAXIMUM_FRAME_SIZE, RIB_DEC),
    fn('ASI_startup'),
    fn('ASI_error'),
    fn('ASI_shutdown'),
];

/** @type {TableEntry[]} */
const STREAM_TABLE = [
    fn('ASI_stream_open'),
    fn('ASI_stream_process'),
    fn('ASI_stream_attribute'),
    fn('ASI_stream_set_preference'),
    fn('ASI_stream_seek'),
    fn('ASI_stream_close'),
    attribute('Input bit rate', ATTRIB.INPUT_BIT_RATE, RIB_DEC),
    attribute('Input sample rate', ATTRIB.INPUT_SAMPLE_RATE, RIB_DEC),
    attribute('Input sample width', ATTRIB.INPUT_SAMPLE_WIDTH, RIB_DEC),
    attribute('Input channels', ATTRIB.INPUT_CHANNELS, RIB_DEC),
    attribute('Output bit rate', ATTRIB.OUTPUT_BIT_RATE, RIB_DEC),
    attribute('Output sample rate', ATTRIB.OUTPUT_SAMPLE_RATE, RIB_DEC),
    attribute('Output sample width', ATTRIB.OUTPUT_SAMPLE_WIDTH, RIB_DEC),
    attribute('Output channels', ATTRIB.OUTPUT_CHANNELS, RIB_DEC),
    attribute('Position', ATTRIB.POSITION, RIB_DEC),
    attribute('Percent done', ATTRIB.PERCENT_DONE, RIB_PERCENT),
    attribute('Minimum input block size', ATTRIB.MINIMUM_INPUT_BLOCK_SIZE, RIB_DEC),
    attribute('MPEG version', ATTRIB.MPEG_VERSION, RIB_DEC),
    attribute('MPEG layer', ATTRIB.MPEG_LAYER, RIB_DEC),
    preference('Requested sample rate', ATTRIB.REQUESTED_SAMPLE_RATE),
    preference('Requested bit width', ATTRIB.REQUESTED_BIT_WIDTH),
    preference('Requested # of channels', ATTRIB.REQUESTED_CHANNELS),
];

/**
 * @typedef {Object} ProviderHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(entry: number, args: number[], thread: any) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {(library: string, name: string) => number | null} resolveImport
 *           An export's guest address, of the sound library or of this provider.
 * @property {import('./mp3.js').Decoder} decoder
 * @property {(text: string) => void} [warn]
 */

/**
 * @typedef {Object} Stream
 * @property {number} handle
 * @property {number} user
 * @property {number} fetch          the library's fetch callback
 * @property {number} totalSize      what the library said at open; advisory, see readMore
 * @property {Uint8Array} input      compressed bytes read so far
 * @property {number} inputAt        how many of them
 * @property {boolean} inputDone     the callback had nothing more
 * @property {number} scannedAt      where the frame scan resumes
 * @property {number} discard        bytes of the next reads to drop: the library
 *                                   re-serves them after a seek back into what is held
 * @property {import('./mp3.js').Frame[]} frames
 * @property {import('./mp3.js').FrameHeader} first
 * @property {import('./mp3.js').DecoderStream} decoder
 * @property {number} fed            samples (all channels) the fed frames hold
 * @property {Int16Array} pcm        every decoded sample, interleaved
 * @property {number} decoded        samples (all channels) decoded so far
 * @property {boolean} flushing
 * @property {boolean} done          nothing more will be decoded
 * @property {number} position       the next sample (all channels) to hand over
 * @property {(() => void)[]} waiting
 * @property {Map<number, number>} preferences
 */

/**
 * @param {ProviderHost} host
 */
export function createMp3Provider(host){
    const { readMemory, writeMemory, allocate, callGuest, currentThread, resolveImport } = host;
    const encoder = new TextEncoder();

    /** Where the strings and tables live, once something needed them. */
    /** @type {{ codec: number, stream: number, names: Map<string, number> } | null} */
    let guestData = null;
    let provider = 0;
    let registered = false;
    /** The last failure, for ASI_error; a guest string once asked for. */
    let lastError = '';
    let errorAt = 0;

    /** @type {Map<number, Stream>} */
    const streams = new Map();
    let nextHandle = 1;
    let scratch = 0;
    let opens = 0;
    let failedOpens = 0;
    let samplesOut = 0;
    let waits = 0;
    /**
     * The last few things the library asked, in order, so a stream that fell
     * silent can be read back to the request that ended it.
     *
     * @type {string[]}
     */
    const recent = [];
    /** @param {string} line */
    const note = line=>{
        recent.push(line);
        if (recent.length > 24)
        {
            recent.shift();
        }
    };

    /**
     * Puts the strings and both tables into guest memory.
     *
     * Function tokens are the provider's own export addresses, which exist
     * because the module was synthesised with them; nothing about the tables
     * depends on when this runs, so they are written once, on first need.
     */
    const ensureGuestData = ()=>{
        if (guestData)
        {
            return guestData;
        }
        const texts = ['ASI codec', 'ASI stream', PROVIDER_NAME, INPUT_FILE_TYPES,
            OUTPUT_FILE_TYPES,
            ...new Set([...CODEC_TABLE, ...STREAM_TABLE].map(entry=>entry.name))];
        const tableBytes = (CODEC_TABLE.length + STREAM_TABLE.length) * ENTRY_SIZE;
        const textBytes = texts.reduce((sum, text)=>sum + text.length + 1, 0);
        const base = allocate(tableBytes + textBytes);
        const bytes = new Uint8Array(tableBytes + textBytes);
        const view = new DataView(bytes.buffer);

        /** @type {Map<string, number>} */
        const names = new Map();
        let cursor = tableBytes;
        for (const text of texts)
        {
            names.set(text, base + cursor);
            bytes.set(encoder.encode(text), cursor);
            cursor += text.length + 1;
        }

        /** @param {TableEntry[]} table @param {number} at */
        const writeTable = (table, at)=>{
            table.forEach((entry, index)=>{
                const offset = at + index * ENTRY_SIZE;
                const token = typeof entry.token === 'string'
                    ? resolveImport(PROVIDER_LIBRARY, entry.token) ?? 0
                    : entry.token;
                view.setUint32(offset, entry.type, true);
                view.setUint32(offset + 4, names.get(entry.name) ?? 0, true);
                view.setInt32(offset + 8, token | 0, true);
                view.setUint32(offset + 12, entry.subtype, true);
            });
        };
        writeTable(CODEC_TABLE, 0);
        writeTable(STREAM_TABLE, CODEC_TABLE.length * ENTRY_SIZE);
        writeMemory(base, bytes);
        guestData = { codec: base, stream: base + CODEC_TABLE.length * ENTRY_SIZE, names };
        return guestData;
    };

    /** @param {string} text */
    const fail = text=>{
        lastError = text;
        errorAt = 0;
        host.warn?.(`${PROVIDER_LIBRARY}: ${text}`);
    };

    /**
     * Registers or unregisters both interfaces through the sound library.
     *
     * @param {boolean} up
     * @param {any} thread
     */
    const register = async(up, thread)=>{
        const handleOf = resolveImport(SOUND_LIBRARY, '_RIB_provider_library_handle@0');
        const entry = resolveImport(SOUND_LIBRARY,
            up ? 'RIB_register_interface' : 'RIB_unregister_interface');
        if (handleOf === null || entry === null)
        {
            fail('the sound library has no RIB entry points');
            return;
        }
        const data = ensureGuestData();
        if (up)
        {
            provider = await callGuest(handleOf, [], thread);
        }
        const codecName = /** @type {number} */ (data.names.get('ASI codec'));
        const streamName = /** @type {number} */ (data.names.get('ASI stream'));
        await callGuest(entry, [provider, codecName, CODEC_TABLE.length, data.codec], thread);
        await callGuest(entry, [provider, streamName, STREAM_TABLE.length, data.stream], thread);
        registered = up;
    };

    /** @param {Stream} stream */
    const wake = stream=>{
        const waiting = stream.waiting;
        stream.waiting = [];
        waiting.forEach(resolve=>resolve());
    };

    /**
     * Reads the next piece of the stream through the library's fetch callback
     * and feeds the decoder every frame that piece completes.
     *
     * The size given at open is not a limit. The library was measured naming
     * its own read buffer there -- four kilobytes for a stream of megabytes --
     * and it answers each read with at most that much, so the stream is read
     * until a read answers nothing. Every read continues from where the last
     * one stopped (an offset of -1): the callback takes a named offset only
     * inside the window it holds, and past that window it was measured
     * copying a negative count -- hundreds of megabytes over the end of the
     * guest's memory.
     *
     * @param {Stream} stream @param {any} thread
     */
    const readMore = async(stream, thread)=>{
        if (scratch === 0)
        {
            scratch = allocate(FETCH_CHUNK);
        }
        const read = (await callGuest(stream.fetch,
            [stream.user, scratch, FETCH_CHUNK, -1], thread)) | 0;
        if (read <= 0)
        {
            stream.inputDone = true;
        }
        else
        {
            const skip = Math.min(stream.discard, read);
            stream.discard -= skip;
            const fresh = read - skip;
            if (stream.inputAt + fresh > stream.input.length)
            {
                const grown = new Uint8Array(
                    Math.max(stream.input.length * 2, stream.inputAt + fresh));
                grown.set(stream.input.subarray(0, stream.inputAt));
                stream.input = grown;
            }
            stream.input.set(readMemory(scratch + skip, fresh), stream.inputAt);
            stream.inputAt += fresh;
        }
        const from = stream.scannedAt === 0 ? id3Length(stream.input.subarray(0, stream.inputAt))
            : stream.scannedAt;
        const scan = scanFrames(stream.input, from, stream.inputAt, stream.inputDone);
        stream.scannedAt = scan.next;
        for (const frame of scan.frames)
        {
            stream.frames.push(frame);
            if (stream.decoder)
            {
                stream.decoder.feed(
                    stream.input.slice(frame.offset, frame.offset + frame.header.length),
                    frame.header);
                stream.fed += frame.header.samples * frame.header.channels;
            }
        }
    };

    /**
     * Opens the decoder for a stream whose first frame is known.
     *
     * @param {Stream} stream
     */
    const startDecoding = stream=>{
        stream.decoder = host.decoder.open(stream.first, samples=>{
            if (stream.decoded + samples.length > stream.pcm.length)
            {
                const grown = new Int16Array(Math.max(stream.pcm.length * 2,
                    stream.decoded + samples.length));
                grown.set(stream.pcm);
                stream.pcm = grown;
            }
            stream.pcm.set(samples, stream.decoded);
            stream.decoded += samples.length;
            wake(stream);
        }, error=>{
            fail(`decoding failed: ${error?.message ?? error}`);
            stream.done = true;
            wake(stream);
        });
        for (const frame of stream.frames)
        {
            stream.decoder.feed(
                stream.input.slice(frame.offset, frame.offset + frame.header.length), frame.header);
            stream.fed += frame.header.samples * frame.header.channels;
        }
    };

    /** @param {Stream} stream */
    const leadSamples = stream=>LEAD_FRAMES * stream.first.samples * stream.first.channels;

    /**
     * Parks the caller until the decoder has produced more, or the stream is
     * over. Only a decoder that answers later ever brings a caller here: one
     * that answers in the call has already produced everything it was fed.
     *
     * @param {Stream} stream
     */
    const waitForDecoder = stream=>
        new Promise(resolve=>stream.waiting.push(()=>resolve(undefined)));

    /**
     * Waits until `target` samples have been decoded, or the stream is over.
     *
     * @param {Stream} stream @param {number} target
     */
    const decodedUpTo = async(stream, target)=>{
        while (!stream.done && stream.decoded < target)
        {
            await waitForDecoder(stream);
        }
    };

    /**
     * Makes `wanted` samples past the position available, or as many as the
     * stream has: reading more input while the decoder has not been fed enough
     * -- a lead past the request, so a decoder that answers later is also
     * given what later requests are answered from -- flushing it once the
     * input is spent, and waiting on it only when it has been fed enough and
     * has not yet answered.
     *
     * @param {Stream} stream @param {number} wanted @param {any} thread
     */
    const ensure = async(stream, wanted, thread)=>{
        let parked = false;
        while (!stream.done && stream.decoded - stream.position < wanted)
        {
            if (stream.fed - stream.position < wanted + leadSamples(stream) && !stream.inputDone)
            {
                await readMore(stream, thread);
                continue;
            }
            if (stream.inputDone && !stream.flushing)
            {
                stream.flushing = true;
                try
                {
                    await stream.decoder.flush();
                }
                catch (e){
                    fail(`decoding failed: ${e instanceof Error ? e.message : String(e)}`);
                }
                stream.done = true;
                wake(stream);
                continue;
            }
            // Fed enough and not yet answered: a request parked here holds the
            // guest thread, so each one is counted, once, however many times
            // it is woken before it has what it asked for.
            if (!parked)
            {
                parked = true;
                waits++;
            }
            await waitForDecoder(stream);
        }
    };

    /** @param {number} handle */
    const streamOf = handle=>streams.get(handle >>> 0) ?? null;

    /**
     * The frame the stream's next sample belongs to, for the position it reports.
     *
     * @param {Stream} stream
     */
    const frameAt = stream=>{
        const perFrame = stream.first.samples * stream.first.channels;
        const index = Math.min(stream.frames.length - 1, Math.floor(stream.position / perFrame));
        return stream.frames[Math.max(0, index)];
    };

    /**
     * @param {Stream} stream @param {number} attrib
     */
    const streamAttribute = (stream, attrib)=>{
        const first = stream.first;
        switch (attrib | 0)
        {
            case ATTRIB.INPUT_BIT_RATE: return first.bitrate;
            case ATTRIB.INPUT_SAMPLE_RATE: return first.sampleRate;
            case ATTRIB.INPUT_SAMPLE_WIDTH: return OUTPUT_SAMPLE_WIDTH;
            case ATTRIB.INPUT_CHANNELS: return first.channels;
            case ATTRIB.OUTPUT_BIT_RATE:
                return first.sampleRate * first.channels * OUTPUT_SAMPLE_WIDTH;
            case ATTRIB.OUTPUT_SAMPLE_RATE: return first.sampleRate;
            case ATTRIB.OUTPUT_SAMPLE_WIDTH: return OUTPUT_SAMPLE_WIDTH;
            case ATTRIB.OUTPUT_CHANNELS: return first.channels;
            case ATTRIB.POSITION: return frameAt(stream).offset;
            case ATTRIB.PERCENT_DONE: {
                // Against the size given when it is believable, else against
                // what has been read, which is all that is known.
                const whole = Math.max(stream.totalSize, stream.inputAt);
                return whole === 0 ? 0
                    : Math.min(100, Math.floor(frameAt(stream).offset * 100 / whole));
            }
            case ATTRIB.MINIMUM_INPUT_BLOCK_SIZE: return MAXIMUM_FRAME_SIZE;
            case ATTRIB.MPEG_VERSION: return first.version === 2.5 ? 25 : first.version;
            case ATTRIB.MPEG_LAYER: return 3;
            case ATTRIB.REQUESTED_SAMPLE_RATE:
            case ATTRIB.REQUESTED_BIT_WIDTH:
            case ATTRIB.REQUESTED_CHANNELS:
                return stream.preferences.get(attrib | 0) ?? 0;
            default: return 0;
        }
    };

    const libraries = {
        [PROVIDER_LIBRARY]: {
            /** BOOL DllMain(HINSTANCE, DWORD fdwReason, LPVOID) */
            DllMain: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([, reason])=>{
                    const thread = currentThread();
                    if (reason === DLL_PROCESS_ATTACH && !registered)
                    {
                        return register(true, thread).then(()=>1);
                    }
                    if (reason === DLL_PROCESS_DETACH && registered)
                    {
                        return register(false, thread).then(()=>1);
                    }
                    return 1;
                },
            },

            /** U32 PROVIDER_query_attribute(HATTRIB) */
            PROVIDER_query_attribute: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([attrib])=>{
                    const names = ensureGuestData().names;
                    switch (attrib | 0)
                    {
                        case ATTRIB.NAME: return names.get(PROVIDER_NAME) ?? 0;
                        case ATTRIB.VERSION: return PROVIDER_VERSION;
                        case ATTRIB.INPUT_FILE_TYPES: return names.get(INPUT_FILE_TYPES) ?? 0;
                        case ATTRIB.INPUT_WAVE_TAG: return INPUT_WAVE_TAG;
                        case ATTRIB.OUTPUT_FILE_TYPES: return names.get(OUTPUT_FILE_TYPES) ?? 0;
                        case ATTRIB.MAXIMUM_FRAME_SIZE: return MAXIMUM_FRAME_SIZE;
                        default: return 0;
                    }
                },
            },

            /** ASIRESULT ASI_startup(void) */
            ASI_startup: { argBytes: 0, handler: ()=>ASI_NOERR },
            /** ASIRESULT ASI_shutdown(void) */
            ASI_shutdown: { argBytes: 0, handler: ()=>ASI_NOERR },

            /** C8 *ASI_error(void) */
            ASI_error: {
                argBytes: 0,
                handler: ()=>{
                    if (lastError === '')
                    {
                        return 0;
                    }
                    if (errorAt === 0)
                    {
                        const bytes = encoder.encode(`${lastError}\0`);
                        errorAt = allocate(bytes.length);
                        writeMemory(errorAt, bytes);
                    }
                    return errorAt;
                },
            },

            /** HASISTREAM ASI_stream_open(U32 user, AILASIFETCHCB fetch_CB, U32 total_size) */
            ASI_stream_open: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([user, fetch, totalSize])=>{
                    const thread = currentThread();
                    opens++;
                    /** @type {Stream} */
                    const stream = {
                        handle: nextHandle++,
                        user: user >>> 0,
                        fetch: fetch >>> 0,
                        totalSize: totalSize >>> 0,
                        input: new Uint8Array(FETCH_CHUNK),
                        inputAt: 0,
                        inputDone: false,
                        scannedAt: 0,
                        discard: 0,
                        frames: [],
                        first: /** @type {any} */ (null),
                        decoder: /** @type {any} */ (null),
                        fed: 0,
                        pcm: new Int16Array(0),
                        decoded: 0,
                        flushing: false,
                        done: false,
                        position: 0,
                        waiting: [],
                        preferences: new Map(),
                    };
                    return (async()=>{
                        // Enough to find the first frame, which shapes the
                        // decoder; a stream with none in its first stretch
                        // is not one this provider can play.
                        while (stream.frames.length === 0 && !stream.inputDone
                            && stream.inputAt < OPEN_PROBE_BYTES)
                        {
                            await readMore(stream, thread);
                        }
                        if (stream.frames.length === 0)
                        {
                            failedOpens++;
                            fail('MPEG audio header not found or is badly formatted');
                            note(`open failed after ${stream.inputAt} bytes`);
                            return 0;
                        }
                        stream.first = stream.frames[0].header;
                        const perFrame = stream.first.samples * stream.first.channels;
                        const expected = Math.max(64,
                            Math.ceil(stream.totalSize / stream.first.length));
                        stream.pcm = new Int16Array(expected * perFrame);
                        try
                        {
                            startDecoding(stream);
                        }
                        catch (e){
                            failedOpens++;
                            fail(`no decoder: ${/** @type {Error} */ (e).message}`);
                            return 0;
                        }
                        streams.set(stream.handle, stream);
                        // The lead, out of what the first read fed: the wait
                        // for it is paid here, once, and not by every request
                        // the library makes while the decoder is warming up.
                        await decodedUpTo(stream, Math.min(leadSamples(stream), stream.fed));
                        note(`open #${stream.handle} size=${stream.totalSize}`
                            + ` read=${stream.inputAt} frames=${stream.frames.length}`
                            + ` decoded=${stream.decoded}`
                            + ` ${stream.first.sampleRate}Hz x${stream.first.channels}`);
                        return stream.handle;
                    })();
                },
            },

            /** S32 ASI_stream_process(HASISTREAM, void *buffer, S32 request_size) */
            ASI_stream_process: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([handle, buffer, request])=>{
                    const stream = streamOf(handle);
                    if (!stream)
                    {
                        return 0;
                    }
                    const thread = currentThread();
                    const wanted = Math.floor((request | 0) / 2);
                    const deliver = ()=>{
                        const at = stream.position;
                        const count = Math.max(0, Math.min(wanted, stream.decoded - at));
                        const samples = stream.pcm.subarray(at, at + count);
                        writeMemory(buffer, new Uint8Array(samples.buffer, samples.byteOffset,
                            samples.byteLength));
                        stream.position += count;
                        samplesOut += count;
                        note(`process #${stream.handle} asked=${request | 0} gave=${count * 2}`
                            + ` read=${stream.inputAt} decoded=${stream.decoded}`
                            + ` done=${stream.done}`);
                        return count * 2;
                    };
                    if (stream.done || stream.decoded - stream.position >= wanted)
                    {
                        return deliver();
                    }
                    // Past what is decoded: read on rather than answer short,
                    // because a short answer is the end of the stream.
                    return ensure(stream, wanted, thread).then(deliver);
                },
            },

            /** ASIRESULT ASI_stream_seek(HASISTREAM, S32 stream_offset) */
            ASI_stream_seek: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([handle, offset])=>{
                    const stream = streamOf(handle);
                    // -1 asks for the decoder's state to be dropped and nothing
                    // else, and there is no state here to drop.
                    if (!stream || (offset | 0) === -1)
                    {
                        return ASI_NOERR;
                    }
                    const target = offset >>> 0;
                    const land = ()=>{
                        let index = stream.frames.findIndex(frame=>frame.offset >= target);
                        if (index < 0)
                        {
                            index = stream.frames.length;
                        }
                        stream.position = index * stream.first.samples * stream.first.channels;
                        note(`seek #${stream.handle} to=${target} frame=${index}`);
                        return ASI_NOERR;
                    };
                    // The library has moved its own stream to the byte named
                    // and serves from there: what it re-serves of the bytes
                    // already held is dropped on arrival, and a seek past
                    // what is held leaves the bytes between unread -- the
                    // next read starts at the byte named, and so does the
                    // frame scan.
                    if (target > stream.inputAt && !stream.inputDone)
                    {
                        if (target > stream.input.length)
                        {
                            const grown = new Uint8Array(Math.max(stream.input.length * 2, target));
                            grown.set(stream.input.subarray(0, stream.inputAt));
                            stream.input = grown;
                        }
                        stream.inputAt = target;
                        stream.scannedAt = target;
                        stream.discard = 0;
                        return land();
                    }
                    stream.discard = Math.max(0, stream.inputAt - target);
                    return land();
                },
            },

            /** ASIRESULT ASI_stream_close(HASISTREAM) */
            ASI_stream_close: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: ([handle])=>{
                    const stream = streamOf(handle);
                    if (stream)
                    {
                        streams.delete(stream.handle);
                        stream.done = true;
                        stream.decoder?.close();
                        wake(stream);
                        note(`close #${stream.handle}`);
                    }
                    return ASI_NOERR;
                },
            },

            /** S32 ASI_stream_attribute(HASISTREAM, HATTRIB) */
            ASI_stream_attribute: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([handle, attrib])=>{
                    const stream = streamOf(handle);
                    return stream ? streamAttribute(stream, attrib) : 0;
                },
            },

            /** S32 ASI_stream_set_preference(HASISTREAM, HATTRIB, void const *value) */
            ASI_stream_set_preference: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([handle, which, value])=>{
                    const stream = streamOf(handle);
                    if (!stream)
                    {
                        return 0;
                    }
                    const previous = stream.preferences.get(which | 0) ?? 0;
                    const bytes = readMemory(value >>> 0, 4);
                    stream.preferences.set(which | 0,
                        new DataView(bytes.buffer, bytes.byteOffset, 4).getInt32(0, true));
                    return previous;
                },
            },
        },
    };

    return {
        libraries,
        /** For whoever is measuring. */
        diagnostics: ()=>({
            registered, provider, opens, failedOpens, open: streams.size, samplesOut, waits,
            lastError, recent: [...recent],
            // Each open stream as it stands: what was read, how far the decoder
            // and the library each got. A stream the library stops asking about
            // is told apart here from one the decoder stopped feeding.
            streams: [...streams.values()].map(stream=>({
                handle: stream.handle, size: stream.totalSize, read: stream.inputAt,
                inputDone: stream.inputDone, frames: stream.frames.length,
                rate: stream.first.sampleRate, channels: stream.first.channels,
                fed: stream.fed, decoded: stream.decoded, done: stream.done,
                position: stream.position, preferences: Object.fromEntries(stream.preferences),
            })),
        }),
        /** For tests: the streams as the provider holds them. */
        streams: ()=>streams,
    };
}
