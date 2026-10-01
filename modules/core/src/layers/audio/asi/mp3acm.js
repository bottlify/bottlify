/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The MPEG Layer-3 decoder Windows installs in the Audio Compression
 * Manager, which a sound engine of the era finds there: it enumerates the
 * drivers, asks for one that lists WAVE_FORMAT_MPEGLAYER3 and decodes its MP3
 * WAVs through a stream. An engine that finds no such driver may refuse to
 * start its sound at all, the uncompressed effects included.
 *
 * Decoding is minimp3's, a frame at a time through one decoder per stream,
 * so the bit reservoir carries from frame to frame.
 */

import { scanFrames, id3Length } from './mp3.js';
import { createMinimp3Decoder } from './minimp3.js';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_MPEGLAYER3 = 0x55;

/** MPEGLAYER3WAVEFORMAT's fields after WAVEFORMATEX, at their offsets in the extension. */
const MPEGLAYER3 = Object.freeze({ wID: 0, fdwFlags: 2, nBlockSize: 6, nFramesPerBlock: 8,
    nCodecDelay: 10, SIZE: 12 });
const MPEGLAYER3_ID_MPEG = 1;
const MPEGLAYER3_FLAG_PADDING_OFF = 2;
/** The decoder delay the Windows codec states for its formats. */
const CODEC_DELAY = 1393;

/** Samples per channel a frame carries: MPEG-1 rates, and the halved ones after it. */
/** @param {number} rate */
const samplesPerFrame = rate=>(rate >= 32000 ? 1152 : 576);

/**
 * The formats the driver lists: each rate MPEG audio has, mono and stereo, at
 * a bit rate typical of it.
 *
 * @returns {{ tag: number, channels: number, rate: number, bits: number,
 *     bytes: Uint8Array, name: string }[]}
 */
function listFormats(){
    const formats = [];
    for (const rate of [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000])
    {
        for (const channels of [1, 2])
        {
            const kbps = (rate >= 32000 ? 64 : rate >= 16000 ? 32 : 8) * channels;
            const bytes = new Uint8Array(18 + MPEGLAYER3.SIZE);
            const view = new DataView(bytes.buffer);
            view.setUint16(0, WAVE_FORMAT_MPEGLAYER3, true);
            view.setUint16(2, channels, true);
            view.setUint32(4, rate, true);
            view.setUint32(8, kbps * 1000 / 8, true);
            view.setUint16(12, 1, true);
            view.setUint16(14, 0, true);
            view.setUint16(16, MPEGLAYER3.SIZE, true);
            view.setUint16(18 + MPEGLAYER3.wID, MPEGLAYER3_ID_MPEG, true);
            view.setUint32(18 + MPEGLAYER3.fdwFlags, MPEGLAYER3_FLAG_PADDING_OFF, true);
            view.setUint16(18 + MPEGLAYER3.nBlockSize,
                Math.floor(samplesPerFrame(rate) / 8 * kbps * 1000 / rate), true);
            view.setUint16(18 + MPEGLAYER3.nFramesPerBlock, 1, true);
            view.setUint16(18 + MPEGLAYER3.nCodecDelay, CODEC_DELAY, true);
            formats.push({ tag: WAVE_FORMAT_MPEGLAYER3, channels, rate, bits: 0, bytes,
                name: `${kbps} kBit/s, ${rate} Hz, ${channels === 1 ? 'Mono' : 'Stereo'}` });
        }
    }
    return formats;
}

/**
 * @returns {import('../../win32/msacm32/functions.js').AcmCodec}
 */
export function createMp3AcmCodec(){
    const decoder = createMinimp3Decoder();
    return {
        tag: WAVE_FORMAT_MPEGLAYER3,
        short: 'MPEG Layer-3 Codec',
        long: 'MPEG Layer-3 Codec (decode only)',
        comp: 'l3ac',
        tagName: 'MPEG Layer-3',
        formats: listFormats(),
        // As the Windows codec: decode only, to 16-bit PCM of the stream's
        // own rate and channels.
        converts: (from, to)=>to.tag === WAVE_FORMAT_PCM && to.bits === 16
            && from.rate > 0 && to.rate === from.rate && to.channels === from.channels
            && (from.channels === 1 || from.channels === 2),
        open(from){
            /** @type {Int16Array[]} */
            const decoded = [];
            const stream = decoder.open({ version: from.rate >= 32000 ? 1 : 2, bitrate: 0,
                sampleRate: from.rate, channels: from.channels, length: 0,
                samples: samplesPerFrame(from.rate) }, pcm=>decoded.push(pcm), ()=>{});
            const frameOutput = samplesPerFrame(from.rate) * from.channels * 2;
            // A frame's size, from the format's block size or its byte rate.
            const declared = from.extra && from.extra.length >= MPEGLAYER3.SIZE
                ? new DataView(from.extra.buffer, from.extra.byteOffset)
                    .getUint16(MPEGLAYER3.nBlockSize, true) : 0;
            const frameBytes = Math.max(1, declared || Math.floor(
                samplesPerFrame(from.rate) * (from.averageBytes ?? 0) / from.rate) || 1);
            let first = true;
            // As the Windows codec: every byte handed in is taken, a cut frame
            // waits here for the rest of itself, and decoded samples that do
            // not fit the room wait for the next call. A streaming caller
            // that never reads cbSrcLengthUsed refills from where its file
            // read left off, and bytes handed back to it are lost.
            let pending = new Uint8Array(0);
            let owed = new Uint8Array(0);
            return {
                convert(source, room){
                    const joined = new Uint8Array(pending.length + source.length);
                    joined.set(pending);
                    joined.set(source, pending.length);
                    const start = first ? id3Length(joined) : 0;
                    first = false;
                    const { frames, next } = scanFrames(joined, start, joined.length, true);
                    /** @type {Uint8Array[]} */
                    const parts = [owed];
                    let length = owed.length;
                    for (const frame of frames)
                    {
                        const whole = frame.header.samples * frame.header.channels * 2;
                        decoded.length = 0;
                        stream.feed(
                            joined.subarray(frame.offset, frame.offset + frame.header.length),
                            frame.header);
                        for (const pcm of decoded)
                        {
                            const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset,
                                Math.min(whole, pcm.length * 2));
                            parts.push(bytes);
                            length += bytes.length;
                        }
                    }
                    pending = joined.slice(frames.length > 0
                        ? frames[frames.length - 1].offset + frames[frames.length - 1].header.length
                        : Math.max(start, next));
                    const all = new Uint8Array(length);
                    let at = 0;
                    for (const part of parts)
                    {
                        all.set(part, at);
                        at += part.length;
                    }
                    const output = all.slice(0, Math.min(room, length));
                    owed = all.slice(output.length);
                    return { consumed: source.length, output };
                },
                size: (bytes, toDestination)=>(toDestination
                    ? Math.ceil(bytes / frameBytes) * frameOutput
                    : Math.ceil(bytes / frameOutput) * (frameBytes + 1)),
            };
        },
    };
}
