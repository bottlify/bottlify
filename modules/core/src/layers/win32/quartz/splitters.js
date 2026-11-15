/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz's parsers on the filter base: the WAVE Parser and the AVI Splitter -
 * the filters a graph puts after File Source for a .wav or an .avi.
 *
 * Both are one mechanism, written once: an input pin that takes a byte stream
 * and pulls it through the IAsyncReader of the pin it connects to, a parse of
 * the file's headers when that connection is made, an output pin for each
 * stream the headers describe, made then and taken away when the input pin is
 * disconnected, and a streaming loop that runs while the filter is paused or
 * running, reading each packet in file order and pushing it out of its
 * stream's pin with its time stamps, then the end of every stream. What makes
 * each parser itself is only what it reads out of the file: the stream's
 * media type and its packets. The rules are the DirectShow documentation's:
 * a parser's input pin is the one a source connects to, its output pins exist
 * only while it has a file, and a sample's times are the stream's own clock.
 */

import { formatGuid, parseGuid } from '../ole32/guid.js';
import { describe } from './describe.js';
import {
    IID_IMEDIA_POSITION, IID_IMEDIA_SEEKING, IMEDIA_POSITION_SLOTS, IMEDIA_SEEKING_SLOTS,
} from './interfaces.js';
import {
    FORMAT_VIDEO_INFO, FORMAT_WAVE_FORMAT_EX, GUID_NULL, MEDIATYPE_AUDIO, MEDIATYPE_STREAM,
    MEDIATYPE_VIDEO, STATE_STOPPED,
} from './filter.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const VFW_E_INVALID_FILE_FORMAT = 0x8004022f | 0;

export const CLSID_WAVE_PARSER = '{D51BD5A1-7548-11CF-A520-0080C77EF58A}';
export const CLSID_AVI_SPLITTER = '{1B544C20-FD0B-11CE-8C63-00AA0044B51E}';

export const MEDIASUBTYPE_WAVE = '{E436EB8B-524F-11CE-9F53-0020AF0BA770}';
export const MEDIASUBTYPE_AVI = '{E436EB88-524F-11CE-9F53-0020AF0BA770}';

const IID_IASYNC_READER = '{56A868AA-0AD4-11CE-B03A-0020AF0BA770}';
/** IPin::Disconnect's slot. */
const PIN_DISCONNECT = 5;
/** IAsyncReader's slots, IUnknown's three counted. */
const READER = { SyncRead: 7, Length: 8 };

const TIME_FORMAT_NONE = GUID_NULL;
const TIME_FORMAT_MEDIA_TIME = '{7B785574-8C82-11CF-BC0C-00AA00AC74F6}';
const TIME_FORMAT_SAMPLE = '{7B785572-8C82-11CF-BC0C-00AA00AC74F6}';

/**
 * AM_SEEKING_SEEKING_CAPABILITIES a parser's pins have: absolute, either way,
 * the stop position, the duration and segments - not the current position,
 * which a parser upstream of the renderers does not know.
 */
const CAPABILITIES = 0x01 | 0x02 | 0x04 | 0x10 | 0x20 | 0x80;
/** AM_SEEKING_SEEKING_FLAGS: how a position is given, and what is asked back. */
const AM_SEEKING_POSITIONING_BITS = 0x3;
const AM_SEEKING_NO_POSITIONING = 0;
const AM_SEEKING_ABSOLUTE = 1;
const AM_SEEKING_RELATIVE = 2;
const AM_SEEKING_INCREMENTAL = 3;
const AM_SEEKING_RETURN_TIME = 0x8;

/** A REFERENCE_TIME is a hundred nanoseconds. */
const UNITS = 10_000_000;

/** AVIINDEXENTRY::dwFlags: the chunk is a key frame. */
const AVIIF_KEYFRAME = 0x10;

/** How many buffers an output pin asks for: enough that a slow peer does not stall the others. */
const BUFFERS = 8;

/** A WAVE Parser sample: this many of a second's bytes. */
const WAVE_SAMPLE_FRACTION = 4;

/**
 * One stream a parser found: its media type, and its packets in file order.
 *
 * @typedef {Object} ParsedStream
 * @property {string} name      Its output pin's name, as Windows names it.
 * @property {import('./filter.js').MediaType} type
 * @property {number} largest   The largest packet, which the allocator is asked to hold.
 */

/**
 * A packet of a stream, where it lies in the file and when it plays.
 *
 * @typedef {Object} Packet
 * @property {number} stream    The index of its stream.
 * @property {number} offset
 * @property {number} length
 * @property {number} start     REFERENCE_TIME.
 * @property {number} stop
 * @property {boolean} sync
 */

/**
 * @typedef {Object} ParsedFile
 * @property {ParsedStream[]} streams
 * @property {Packet[]} packets  Every stream's, in the order they lie in the file.
 * @property {number} duration   REFERENCE_TIME.
 * @property {Record<string, number>} [units]  The time formats beside media
 *           time its seeking speaks, by GUID: REFERENCE_TIME a unit of each.
 */

/** @param {string} guid */
const guidBytes = guid=>/** @type {Uint8Array} */ (parseGuid(guid));

/** @param {Uint8Array} bytes @param {number} at */
const fourcc = (bytes, at)=>String.fromCharCode(...bytes.subarray(at, at + 4));

/** @param {Uint8Array} bytes */
const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.length);

/**
 * The audio subtype a WAVEFORMATEX tag names: the tag in the first word of
 * the base GUID, as Microsoft's FOURCCMap does.
 *
 * @param {number} tag
 */
export const audioSubtype = tag=>formatGuid(new Uint8Array([
    tag & 0xff, tag >>> 8 & 0xff, 0, 0, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
]));

/** The video subtypes of uncompressed bitmaps, by bits per pixel. */
const RGB_SUBTYPES = /** @type {Record<number, string>} */ ({
    1: '{E436EB78-524F-11CE-9F53-0020AF0BA770}',
    4: '{E436EB79-524F-11CE-9F53-0020AF0BA770}',
    8: '{E436EB7A-524F-11CE-9F53-0020AF0BA770}',
    16: '{E436EB7C-524F-11CE-9F53-0020AF0BA770}',
    24: '{E436EB7D-524F-11CE-9F53-0020AF0BA770}',
    32: '{E436EB7E-524F-11CE-9F53-0020AF0BA770}',
});

/**
 * The video subtype of a BITMAPINFOHEADER's compression: RGB by its depth, a
 * FOURCC in the base GUID otherwise.
 *
 * @param {number} compression @param {number} bits
 */
export const videoSubtype = (compression, bits)=>{
    if (compression === 0)
    {
        return RGB_SUBTYPES[bits] ?? GUID_NULL;
    }
    return formatGuid(new Uint8Array([
        compression & 0xff, compression >>> 8 & 0xff, compression >>> 16 & 0xff,
        compression >>> 24 & 0xff, 0x00, 0x00, 0x10, 0x00,
        0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71,
    ]));
};

/**
 * A WAVEFORMATEX as a stream's format block: the bytes the file gave, at least
 * the eighteen of WAVEFORMATEX with cbSize what follows them.
 *
 * @param {Uint8Array} format
 */
const waveFormat = format=>{
    if (format.length >= 18)
    {
        return format.slice();
    }
    const whole = new Uint8Array(18);
    whole.set(format);
    return whole;
};

/**
 * An audio stream's media type from its WAVEFORMATEX.
 *
 * @param {Uint8Array} format
 * @returns {import('./filter.js').MediaType}
 */
export function audioType(format){
    const block = waveFormat(format);
    const view = viewOf(block);
    return {
        major: MEDIATYPE_AUDIO, sub: audioSubtype(view.getUint16(0, true)), fixed: true,
        temporal: false, sampleSize: view.getUint16(12, true),
        formatType: FORMAT_WAVE_FORMAT_EX, format: block,
    };
}

/**
 * Reads a RIFF WAVE file's headers: its format, and its data cut into packets
 * of a quarter of a second each, whole blocks.
 *
 * @param {(offset: number, length: number) => Promise<Uint8Array>} read
 * @param {number} size
 * @returns {Promise<ParsedFile | null>}
 */
export async function parseWave(read, size){
    const head = await read(0, Math.min(size, 12));
    if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'WAVE')
    {
        return null;
    }
    /** @type {Uint8Array | null} */
    let format = null;
    let data = -1;
    let dataLength = 0;
    for (let at = 12; at + 8 <= size;)
    {
        const chunk = await read(at, 8);
        const id = fourcc(chunk, 0);
        const length = viewOf(chunk).getUint32(4, true);
        if (id === 'fmt ')
        {
            format = await read(at + 8, length);
        }
        else if (id === 'data')
        {
            data = at + 8;
            dataLength = Math.min(length, size - data);
            break;
        }
        at += 8 + length + (length & 1);
    }
    if (!format || data < 0 || format.length < 16)
    {
        return null;
    }
    const type = audioType(format);
    const view = viewOf(type.format);
    const perSecond = view.getUint32(8, true);
    const block = Math.max(1, view.getUint16(12, true));
    if (perSecond === 0)
    {
        return null;
    }
    const step = Math.max(block, Math.floor(perSecond / WAVE_SAMPLE_FRACTION / block) * block);
    /** @type {Packet[]} */
    const packets = [];
    for (let done = 0; done < dataLength; done += step)
    {
        const length = Math.min(step, dataLength - done);
        packets.push({ stream: 0, offset: data + done, length,
            start: Math.round(done * UNITS / perSecond),
            stop: Math.round((done + length) * UNITS / perSecond), sync: true });
    }
    const rate = view.getUint32(4, true);
    return { streams: [{ name: 'output', type, largest: step }], packets,
        duration: Math.round(dataLength * UNITS / perSecond),
        units: rate > 0 ? { [TIME_FORMAT_SAMPLE]: UNITS / rate } : {} };
}

/**
 * A video stream's media type from its AVI stream header and BITMAPINFOHEADER:
 * a VIDEOINFOHEADER with the frame time the header's rate gives.
 *
 * @param {Uint8Array} bitmap  The stream format, a BITMAPINFOHEADER and what follows.
 * @param {number} frameTime   REFERENCE_TIME a frame.
 * @param {number} bitRate
 * @param {number} [sampleSize]  The image's size where absent.
 * @returns {import('./filter.js').MediaType}
 */
export function videoType(bitmap, frameTime, bitRate, sampleSize){
    const format = new Uint8Array(0x30 + bitmap.length);
    const view = viewOf(format);
    format.set(bitmap, 0x30);
    const header = viewOf(bitmap);
    view.setUint32(0x20, bitRate >>> 0, true);
    view.setUint32(0x28, Math.round(frameTime) % 0x1_0000_0000 >>> 0, true);
    view.setUint32(0x2c, Math.floor(Math.round(frameTime) / 0x1_0000_0000) >>> 0, true);
    const compression = header.getUint32(16, true);
    const bits = header.getUint16(14, true);
    // The splitter says nothing of how the frames are compressed: no temporal
    // compression, a sample the size of the image, as Windows' does.
    return {
        major: MEDIATYPE_VIDEO, sub: videoSubtype(compression, bits),
        fixed: compression === 0, temporal: false,
        sampleSize: sampleSize ?? header.getUint32(20, true),
        formatType: FORMAT_VIDEO_INFO, format,
    };
}

/**
 * Reads an AVI file's headers - the streams of its hdrl list and the chunks
 * of its movi list, by its idx1 index where it has one and by walking the
 * list where it does not - into streams and packets in file order.
 *
 * @param {(offset: number, length: number) => Promise<Uint8Array>} read
 * @param {number} size
 * @returns {Promise<ParsedFile | null>}
 */
export async function parseAvi(read, size){
    const head = await read(0, Math.min(size, 12));
    if (head.length < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'AVI ')
    {
        return null;
    }
    /** @type {{ kind: string, scale: number, rate: number, sampleSize: number,
     *     format: Uint8Array, start: number, suggested: number }[]} */
    const headers = [];
    let movi = -1;
    let moviEnd = -1;
    let index = -1;
    let indexLength = 0;
    for (let at = 12; at + 8 <= size;)
    {
        const chunk = await read(at, 12);
        const id = fourcc(chunk, 0);
        const length = viewOf(chunk).getUint32(4, true);
        if (id === 'LIST' && fourcc(chunk, 8) === 'hdrl')
        {
            const list = await read(at + 12, length - 4);
            for (let inner = 0; inner + 8 <= list.length;)
            {
                const innerLength = viewOf(list).getUint32(inner + 4, true);
                if (fourcc(list, inner) === 'LIST' && fourcc(list, inner + 8) === 'strl')
                {
                    const strl = list.subarray(inner + 12, inner + 8 + innerLength);
                    /** @type {any} */
                    const stream = { kind: '', scale: 1, rate: 1, sampleSize: 0,
                        format: new Uint8Array(0), start: 0, suggested: 0 };
                    for (let part = 0; part + 8 <= strl.length;)
                    {
                        const partLength = viewOf(strl).getUint32(part + 4, true);
                        const body = strl.subarray(part + 8, part + 8 + partLength);
                        if (fourcc(strl, part) === 'strh' && body.length >= 48)
                        {
                            const h = viewOf(body);
                            stream.kind = fourcc(body, 0);
                            stream.scale = h.getUint32(20, true) || 1;
                            stream.rate = h.getUint32(24, true) || 1;
                            stream.start = h.getUint32(28, true);
                            stream.suggested = h.getUint32(36, true);
                            stream.sampleSize = h.getUint32(44, true);
                        }
                        else if (fourcc(strl, part) === 'strf')
                        {
                            stream.format = body.slice();
                        }
                        part += 8 + partLength + (partLength & 1);
                    }
                    headers.push(stream);
                }
                inner += 8 + innerLength + (innerLength & 1);
            }
        }
        else if (id === 'LIST' && fourcc(chunk, 8) === 'movi')
        {
            movi = at + 8;
            moviEnd = at + 8 + length;
        }
        else if (id === 'idx1')
        {
            index = at + 8;
            indexLength = length;
        }
        at += 8 + length + (length & 1);
    }
    if (headers.length === 0 || movi < 0)
    {
        return null;
    }
    /** @type {{ id: string, flags: number, offset: number, length: number }[]} */
    const chunks = [];
    if (index >= 0)
    {
        const entries = await read(index, indexLength);
        const view = viewOf(entries);
        // An index's offsets are from the movi list's 'movi' tag, or, in some
        // writers', from the file's start: the first entry says which.
        const first = entries.length >= 16 ? view.getUint32(8, true) : 0;
        const base = first >= movi ? 0 : movi;
        for (let at = 0; at + 16 <= entries.length; at += 16)
        {
            chunks.push({ id: fourcc(entries, at), flags: view.getUint32(at + 4, true),
                offset: base + view.getUint32(at + 8, true) + 8,
                length: view.getUint32(at + 12, true) });
        }
    }
    else
    {
        for (let at = movi + 4; at + 8 <= moviEnd;)
        {
            const chunk = await read(at, 12);
            const id = fourcc(chunk, 0);
            const length = viewOf(chunk).getUint32(4, true);
            if (id === 'LIST')
            {
                at += 12;
                continue;
            }
            chunks.push({ id, flags: AVIIF_KEYFRAME, offset: at + 8, length });
            at += 8 + length + (length & 1);
        }
    }
    /** @type {ParsedStream[]} */
    const streams = [];
    /** @type {number[]} which parsed stream each AVI stream number is, -1 for none */
    const streamOf = [];
    for (const [number, header] of headers.entries())
    {
        const name = `Stream ${String(number).padStart(2, '0')}`;
        if (header.kind === 'vids' && header.format.length >= 40)
        {
            const frameTime = header.scale * UNITS / header.rate;
            streamOf.push(streams.length);
            streams.push({ name, type: videoType(header.format, frameTime, 0, header.suggested),
                largest: header.suggested });
        }
        else if (header.kind === 'auds' && header.format.length >= 16)
        {
            streamOf.push(streams.length);
            streams.push({ name, type: audioType(header.format), largest: header.suggested });
        }
        else
        {
            streamOf.push(-1);
        }
    }
    /** @type {Packet[]} */
    const packets = [];
    /** What each stream has delivered: frames for video, bytes for audio. */
    const position = headers.map(header=>header.start);
    let duration = 0;
    for (const chunk of chunks)
    {
        const number = Number.parseInt(chunk.id.slice(0, 2), 10);
        const target = streamOf[number] ?? -1;
        if (Number.isNaN(number) || target < 0)
        {
            continue;
        }
        const header = headers[number];
        const stream = streams[target];
        stream.largest = Math.max(stream.largest, chunk.length);
        let start;
        let stop;
        if (header.kind === 'auds')
        {
            const perSecond = viewOf(stream.type.format).getUint32(8, true) || 1;
            start = Math.round(position[number] * UNITS / perSecond);
            position[number] += chunk.length;
            stop = Math.round(position[number] * UNITS / perSecond);
        }
        else
        {
            const frameTime = header.scale * UNITS / header.rate;
            start = Math.round(position[number] * frameTime);
            position[number] += 1;
            stop = Math.round(position[number] * frameTime);
        }
        duration = Math.max(duration, stop);
        packets.push({ stream: target, offset: chunk.offset, length: chunk.length, start, stop,
            sync: header.kind === 'auds' || (chunk.flags & AVIIF_KEYFRAME) !== 0
                || stream.type.sub === RGB_SUBTYPES[24] });
    }
    return { streams, packets, duration };
}

/**
 * @typedef {Object} ParserSpec
 * @property {string} clsid
 * @property {string} subtype   The byte stream's subtype it takes.
 * @property {(read: (offset: number, length: number) => Promise<Uint8Array>, size: number)
 *     => Promise<ParsedFile | null>} parse
 */

/** @type {ParserSpec[]} */
export const PARSERS = [
    { clsid: CLSID_WAVE_PARSER, subtype: MEDIASUBTYPE_WAVE, parse: parseWave },
    { clsid: CLSID_AVI_SPLITTER, subtype: MEDIASUBTYPE_AVI, parse: parseAvi },
];

/**
 * The parsers' classes over the filter base, by CLSID.
 *
 * @param {ReturnType<typeof import('./filter.js').createFilterBase>} base
 * @param {import('./filter.js').FilterHost} host
 * @returns {Map<string, () => import('../ole32/objects.js').ComClassDefinition>}
 */
export function createParsers(base, host){
    /**
     * @typedef {Object} ParserState
     * @property {number} reader     The source pin's IAsyncReader, one reference held.
     * @property {ParsedFile | null} file
     * @property {boolean} streaming
     * @property {Promise<void> | null} loop
     * @property {number} current   Where streaming starts, REFERENCE_TIME.
     * @property {number} stop      Where it ends.
     * @property {number} rate
     * @property {string} format    The time format the seeking interface speaks.
     */

    /** @param {import('./filter.js').Filter} filter @returns {ParserState} */
    const stateOf = filter=>filter.state2;

    /**
     * Reads from the source through its IAsyncReader, on the thread asking or
     * on the streaming thread.
     *
     * @param {number} reader @param {boolean} streaming
     */
    const reading = (reader, streaming)=>
        /** @param {number} offset @param {number} length @returns {Promise<Uint8Array>} */
        async(offset, length)=>{
            if (length <= 0)
            {
                return new Uint8Array(0);
            }
            const buffer = host.allocate(length);
            const args = [offset % 0x1_0000_0000 >>> 0, Math.floor(offset / 0x1_0000_0000) >>> 0,
                length, buffer];
            const answer = streaming ? await base.callStreaming(reader, READER.SyncRead, args)
                : await base.call(reader, READER.SyncRead, args);
            const bytes = (answer | 0) < 0 ? new Uint8Array(0)
                : host.readMemory(buffer, length).slice();
            host.free(buffer);
            return bytes;
        };

    /** The source's length, in bytes. @param {number} reader */
    const lengthOf = async reader=>{
        const slot = host.allocate(16);
        host.writeMemory(slot, new Uint8Array(16));
        await base.call(reader, READER.Length, [slot, slot + 8]);
        const total = host.readU32(slot) + host.readU32(slot + 4) * 0x1_0000_0000;
        host.free(slot);
        return total;
    };

    /**
     * Pushes every packet out of its stream's pin in file order, then the end
     * of every stream; stops early when the filter stops or a peer refuses.
     *
     * @param {import('./filter.js').Filter} filter
     */
    const stream = async filter=>{
        const state = stateOf(filter);
        const file = /** @type {ParsedFile} */ (state.file);
        const outputs = filter.pins.filter(pin=>pin.spec.direction === 'output');
        const read = reading(state.reader, true);
        /** @type {Set<number>} streams a peer refused */
        const done = new Set();
        const from = state.current;
        const to = state.stop;
        for (const pin of outputs)
        {
            await base.deliverNewSegment(pin, from, to, state.rate);
        }
        // A seek starts each stream at the sync point at or before its
        // position; the times that follow are the segment's, from zero.
        const startAt = file.streams.map((parsed, number)=>{
            let at = 0;
            file.packets.forEach((packet, index)=>{
                if (packet.stream === number && packet.sync && packet.start <= from)
                {
                    at = index;
                }
            });
            return at;
        });
        for (const [index, packet] of file.packets.entries())
        {
            if (!state.streaming)
            {
                return;
            }
            if (index < startAt[packet.stream] || packet.start >= to)
            {
                continue;
            }
            const pin = outputs[packet.stream];
            if (!pin || pin.peer === 0 || done.has(packet.stream))
            {
                continue;
            }
            const data = await read(packet.offset, packet.length);
            const answer = await base.deliver(pin, { data, start: packet.start - from,
                stop: packet.stop - from, sync: packet.sync });
            if (answer !== S_OK)
            {
                done.add(packet.stream);
            }
        }
        if (!state.streaming)
        {
            return;
        }
        for (const pin of outputs)
        {
            await base.deliverEndOfStream(pin);
        }
    };

    /** @param {number} address */
    const readQuad = address=>host.readU32(address)
        + (host.readU32(address + 4) | 0) * 0x1_0000_0000;
    /** @param {number} address @param {number} value */
    const writeQuad = (address, value)=>{
        const whole = Math.trunc(value);
        const bytes = new Uint8Array(8);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, whole % 0x1_0000_0000 >>> 0, true);
        view.setUint32(4, Math.floor(whole / 0x1_0000_0000) >>> 0, true);
        host.writeMemory(address, bytes);
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };
    /** @param {number} address */
    const formatAt = address=>formatGuid(host.readMemory(address >>> 0, 16));
    /**
     * REFERENCE_TIME a unit of a time format is, for a filter's file; undefined
     * for a format it does not speak. TIME_FORMAT_NONE is media time.
     *
     * @param {import('./filter.js').Filter} filter @param {string} format
     */
    const unitOf = (filter, format)=>(
        format === TIME_FORMAT_MEDIA_TIME || format === TIME_FORMAT_NONE
            ? 1 : stateOf(filter).file?.units?.[format]);
    /** A position in the filter's format, from media time. @param {import('./filter.js').Filter} filter @param {number} ticks */
    const outward = (filter, ticks)=>Math.round(
        ticks / (unitOf(filter, stateOf(filter).format) ?? 1));
    /** Media time, from a position in the filter's format. @param {import('./filter.js').Filter} filter @param {number} value */
    const inward = (filter, value)=>Math.round(
        value * (unitOf(filter, stateOf(filter).format) ?? 1));

    /**
     * Streaming started again from the filter's position: stopped, the
     * downstream flushed of what it holds, and begun anew - what a seek on a
     * streaming parser does.
     *
     * @param {import('./filter.js').Filter} filter
     */
    const restart = async filter=>{
        const state = stateOf(filter);
        if (!state.streaming)
        {
            return;
        }
        state.streaming = false;
        const outputs = filter.pins.filter(pin=>pin.spec.direction === 'output');
        for (const pin of outputs)
        {
            await base.deliverFlush(pin, true);
        }
        await state.loop;
        for (const pin of outputs)
        {
            await base.deliverFlush(pin, false);
        }
        state.streaming = true;
        state.loop = stream(filter).catch(()=>{});
    };

    /**
     * IMediaSeeking on a parser's output pins: the file's one position, stop,
     * duration and rate, in media time, as the documentation has it.
     *
     * @param {import('./filter.js').Filter} filter
     * @returns {Record<string, (pin: any, args: number[]) => number | Promise<number>>}
     */
    const seeking = filter=>({
        GetCapabilities: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out >>> 0, CAPABILITIES);
            return S_OK;
        },
        CheckCapabilities: (pin, [caps])=>{
            if ((caps >>> 0) === 0)
            {
                return E_POINTER;
            }
            const asked = host.readU32(caps >>> 0);
            const have = asked & CAPABILITIES;
            writeU32(caps >>> 0, have);
            if (have === asked)
            {
                return S_OK;
            }
            return have !== 0 ? S_FALSE : E_FAIL;
        },
        IsFormatSupported: (pin, [format])=>{
            if ((format >>> 0) === 0)
            {
                return E_POINTER;
            }
            const asked = formatAt(format);
            return asked !== TIME_FORMAT_NONE && unitOf(filter, asked) !== undefined
                ? S_OK : S_FALSE;
        },
        QueryPreferredFormat: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, guidBytes(TIME_FORMAT_MEDIA_TIME));
            return S_OK;
        },
        GetTimeFormat: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            host.writeMemory(out >>> 0, guidBytes(stateOf(filter).format));
            return S_OK;
        },
        IsUsingTimeFormat: (pin, [format])=>{
            if ((format >>> 0) === 0)
            {
                return E_POINTER;
            }
            return formatAt(format) === stateOf(filter).format ? S_OK : S_FALSE;
        },
        SetTimeFormat: (pin, [format])=>{
            if ((format >>> 0) === 0)
            {
                return E_POINTER;
            }
            const asked = formatAt(format);
            if (unitOf(filter, asked) === undefined)
            {
                return E_INVALIDARG;
            }
            stateOf(filter).format = asked === TIME_FORMAT_NONE ? TIME_FORMAT_MEDIA_TIME : asked;
            return S_OK;
        },
        GetDuration: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeQuad(out >>> 0, outward(filter, stateOf(filter).file?.duration ?? 0));
            return S_OK;
        },
        GetStopPosition: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeQuad(out >>> 0, outward(filter, stateOf(filter).stop));
            return S_OK;
        },
        GetCurrentPosition: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeQuad(out >>> 0, outward(filter, stateOf(filter).current));
            return S_OK;
        },
        ConvertTimeFormat: (pin, [target, targetFormat, low, high, sourceFormat])=>{
            if ((target >>> 0) === 0)
            {
                return E_POINTER;
            }
            const using = stateOf(filter).format;
            const into = (targetFormat >>> 0) === 0 ? using : formatAt(targetFormat);
            const from = (sourceFormat >>> 0) === 0 ? using : formatAt(sourceFormat);
            const intoUnit = unitOf(filter, into);
            const fromUnit = unitOf(filter, from);
            if (intoUnit === undefined || fromUnit === undefined)
            {
                return E_INVALIDARG;
            }
            const value = (low >>> 0) + (high | 0) * 0x1_0000_0000;
            writeQuad(target >>> 0, into === from ? value
                : Math.round(value * fromUnit / intoUnit));
            return S_OK;
        },
        SetPositions: async(pin, [current, currentFlags, stop, stopFlags])=>{
            const state = stateOf(filter);
            const duration = state.file?.duration ?? 0;
            /** @param {number} at @param {number} flags @param {number} now */
            const position = (at, flags, now)=>{
                switch (flags & AM_SEEKING_POSITIONING_BITS)
                {
                    case AM_SEEKING_ABSOLUTE:
                        return inward(filter, readQuad(at >>> 0));
                    case AM_SEEKING_RELATIVE:
                    case AM_SEEKING_INCREMENTAL:
                        return now + inward(filter, readQuad(at >>> 0));
                    default:
                        return now;
                }
            };
            const moving = (currentFlags & AM_SEEKING_POSITIONING_BITS)
                !== AM_SEEKING_NO_POSITIONING;
            const stopping = (stopFlags & AM_SEEKING_POSITIONING_BITS)
                !== AM_SEEKING_NO_POSITIONING;
            if ((moving && (current >>> 0) === 0) || (stopping && (stop >>> 0) === 0))
            {
                return E_POINTER;
            }
            state.current = Math.max(0, Math.min(duration, position(current, currentFlags,
                state.current)));
            state.stop = Math.max(0, Math.min(duration, position(stop, stopFlags, state.stop)));
            if ((currentFlags & AM_SEEKING_RETURN_TIME) !== 0 && (current >>> 0) !== 0)
            {
                writeQuad(current >>> 0, outward(filter, state.current));
            }
            if ((stopFlags & AM_SEEKING_RETURN_TIME) !== 0 && (stop >>> 0) !== 0)
            {
                writeQuad(stop >>> 0, outward(filter, state.stop));
            }
            if (moving)
            {
                await restart(filter);
            }
            return S_OK;
        },
        GetPositions: (pin, [current, stop])=>{
            const state = stateOf(filter);
            if ((current >>> 0) !== 0)
            {
                writeQuad(current >>> 0, outward(filter, state.current));
            }
            if ((stop >>> 0) !== 0)
            {
                writeQuad(stop >>> 0, outward(filter, state.stop));
            }
            return S_OK;
        },
        GetAvailable: (pin, [earliest, latest])=>{
            if ((earliest >>> 0) !== 0)
            {
                writeQuad(earliest >>> 0, 0);
            }
            if ((latest >>> 0) !== 0)
            {
                writeQuad(latest >>> 0, outward(filter, stateOf(filter).file?.duration ?? 0));
            }
            return S_OK;
        },
        SetRate: (pin, [low, high])=>{
            const view = new DataView(new ArrayBuffer(8));
            view.setUint32(0, low >>> 0, true);
            view.setUint32(4, high >>> 0, true);
            const rate = view.getFloat64(0, true);
            if (!(rate > 0))
            {
                return E_INVALIDARG;
            }
            stateOf(filter).rate = rate;
            return S_OK;
        },
        GetRate: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const view = new DataView(new ArrayBuffer(8));
            view.setFloat64(0, stateOf(filter).rate, true);
            host.writeMemory(out >>> 0, new Uint8Array(view.buffer));
            return S_OK;
        },
        GetPreroll: (pin, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeQuad(out >>> 0, 0);
            return S_OK;
        },
    });

    /** @param {number} low @param {number} high a double's two words */
    const doubleOf = (low, high)=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, low >>> 0, true);
        view.setUint32(4, high >>> 0, true);
        return view.getFloat64(0, true);
    };
    /** @param {number} address @param {number} value */
    const writeDouble = (address, value)=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, value, true);
        host.writeMemory(address, new Uint8Array(view.buffer));
    };

    /**
     * IMediaPosition on a parser's output pins: the same position as its
     * IMediaSeeking, in seconds, as the older interface speaks it.
     *
     * @param {import('./filter.js').Filter} filter
     * @returns {Record<string, (pin: any, args: number[]) => number | Promise<number>>}
     */
    const position = filter=>{
        /** @param {number} out @param {number} value */
        const give = (out, value)=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeDouble(out >>> 0, value);
            return S_OK;
        };
        /** @param {number} out @param {number} value */
        const giveLong = (out, value)=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out >>> 0, value);
            return S_OK;
        };
        return {
            GetTypeInfoCount: (pin, [out])=>giveLong(out, 0),
            GetTypeInfo: ()=>E_NOTIMPL,
            GetIDsOfNames: ()=>E_NOTIMPL,
            Invoke: ()=>E_NOTIMPL,
            get_Duration: (pin, [out])=>give(out, (stateOf(filter).file?.duration ?? 0) / UNITS),
            put_CurrentPosition: async(pin, [low, high])=>{
                const state = stateOf(filter);
                state.current = Math.max(0, Math.min(state.file?.duration ?? 0,
                    Math.round(doubleOf(low, high) * UNITS)));
                await restart(filter);
                return S_OK;
            },
            get_CurrentPosition: (pin, [out])=>give(out, stateOf(filter).current / UNITS),
            get_StopTime: (pin, [out])=>give(out, stateOf(filter).stop / UNITS),
            put_StopTime: (pin, [low, high])=>{
                const state = stateOf(filter);
                state.stop = Math.max(0, Math.min(state.file?.duration ?? 0,
                    Math.round(doubleOf(low, high) * UNITS)));
                return S_OK;
            },
            get_PrerollTime: (pin, [out])=>give(out, 0),
            put_PrerollTime: ()=>S_OK,
            put_Rate: (pin, [low, high])=>{
                const rate = doubleOf(low, high);
                if (!(rate > 0))
                {
                    return E_INVALIDARG;
                }
                stateOf(filter).rate = rate;
                return S_OK;
            },
            get_Rate: (pin, [out])=>give(out, stateOf(filter).rate),
            CanSeekForward: (pin, [out])=>giveLong(out, 0xffffffff),
            CanSeekBackward: (pin, [out])=>giveLong(out, 0xffffffff),
        };
    };

    /**
     * The output pins of a parsed file's streams.
     *
     * @param {import('./filter.js').Filter} filter @param {ParsedStream} parsed
     * @returns {import('./filter.js').PinSpec}
     */
    const outputPin = (filter, parsed)=>({
        name: parsed.name,
        direction: 'output',
        types: ()=>[parsed.type],
        // The stream's own type and no other: a parser converts nothing.
        accepts: (pin, type)=>type.major === parsed.type.major && type.sub === parsed.type.sub
            && type.formatType === parsed.type.formatType
            && type.format.length === parsed.type.format.length
            && type.format.every((byte, at)=>byte === parsed.type.format[at]),
        allocator: { buffers: BUFFERS, size: Math.max(1, parsed.largest), align: 1, prefix: 0 },
        interfaces: [describe(IID_IMEDIA_SEEKING, IMEDIA_SEEKING_SLOTS, seeking(filter)),
            describe(IID_IMEDIA_POSITION, IMEDIA_POSITION_SLOTS, position(filter))],
    });

    /**
     * Takes a file's output pins away, each disconnected first.
     *
     * @param {import('./filter.js').Filter} filter
     */
    const dropOutputs = async filter=>{
        for (const pin of filter.pins.filter(each=>each.spec.direction === 'output'))
        {
            if (pin.peer !== 0)
            {
                // The peer lets go of this pin as a graph's Disconnect would
                // have it, then this pin of its peer.
                await base.call(pin.peer, PIN_DISCONNECT);
                await base.dropConnection(pin);
            }
        }
        filter.pins = filter.pins.filter(each=>each.spec.direction !== 'output');
    };

    /** @param {ParserSpec} spec */
    const define = spec=>base.defineFilter({
        clsid: spec.clsid,
        state: ()=>({ reader: 0, file: null, streaming: false, loop: null, current: 0, stop: 0,
            rate: 1, format: TIME_FORMAT_MEDIA_TIME }),
        pins: ()=>[{
            name: 'input pin',
            direction: 'input',
            pull: true,
            accepts: (pin, type)=>type.major === MEDIATYPE_STREAM && type.sub === spec.subtype,
            connected: async(pin, type, peer)=>{
                const reader = await base.queryInterface(peer, IID_IASYNC_READER);
                if (reader === 0)
                {
                    return E_NOINTERFACE;
                }
                const file = await spec.parse(reading(reader, false), await lengthOf(reader));
                if (!file || file.streams.length === 0)
                {
                    await base.release(reader);
                    return VFW_E_INVALID_FILE_FORMAT;
                }
                const state = stateOf(pin.filter);
                state.reader = reader;
                state.file = file;
                state.current = 0;
                state.stop = file.duration;
                // The streams' pins come before the input pin, as Windows lists
                // a parser's pins.
                pin.filter.pins.unshift(...file.streams.map(parsed=>
                    base.makePin(pin.filter, outputPin(pin.filter, parsed))));
                return S_OK;
            },
            disconnected: async pin=>{
                const state = stateOf(pin.filter);
                await dropOutputs(pin.filter);
                state.file = null;
                if (state.reader !== 0)
                {
                    const reader = state.reader;
                    state.reader = 0;
                    await base.release(reader);
                }
            },
        }],
        changed: async(filter, from, to)=>{
            const state = stateOf(filter);
            if (from === STATE_STOPPED && to !== STATE_STOPPED && state.file && !state.streaming)
            {
                state.streaming = true;
                state.loop = stream(filter).catch(()=>{});
            }
            else if (to === STATE_STOPPED && state.streaming)
            {
                state.streaming = false;
                const loop = state.loop;
                state.loop = null;
                await loop;
            }
            return S_OK;
        },
    });

    return new Map(PARSERS.map(spec=>[spec.clsid, define(spec)]));
}

