/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MPEG Layer 3 streams: where the frames are, and a decoder for them.
 *
 * A stream decoder is asked for its frames one at a time, so the file has to
 * be cut at frame boundaries before anything can decode it; the cut is made
 * here, from the headers alone. The decoding itself is the platform's
 * (WebCodecs), reached through a small contract so a test can stand in for it.
 */

/** Kilobits per second by header index, for layer III. */
const BITRATES_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

/** Sample rates by header index, per MPEG version (1, 2, 2.5). */
const RATES = {
    1: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    2.5: [11025, 12000, 8000],
};

const LAYER_III = 1;
const CHANNEL_MODE_MONO = 3;

/**
 * @typedef {Object} FrameHeader
 * @property {number} version      1, 2 or 2.5
 * @property {number} bitrate      bits per second
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} length       whole frame, header included, in bytes
 * @property {number} samples      per channel
 */

/**
 * The header at `at`, or null when the bytes there are not a layer III frame.
 *
 * @param {Uint8Array} bytes
 * @param {number} at
 * @returns {FrameHeader | null}
 */
export function parseFrameHeader(bytes, at){
    if (at + 4 > bytes.length || bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0)
    {
        return null;
    }
    const versionBits = (bytes[at + 1] >> 3) & 3;
    const layer = (bytes[at + 1] >> 1) & 3;
    const bitrateIndex = bytes[at + 2] >> 4;
    const rateIndex = (bytes[at + 2] >> 2) & 3;
    const padding = (bytes[at + 2] >> 1) & 1;
    const mode = bytes[at + 3] >> 6;
    if (versionBits === 1 || layer !== LAYER_III || bitrateIndex === 0 || bitrateIndex === 15
        || rateIndex === 3)
    {
        return null;
    }
    const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
    const bitrate = (version === 1 ? BITRATES_MPEG1 : BITRATES_MPEG2)[bitrateIndex] * 1000;
    const sampleRate = RATES[version][rateIndex];
    // Layer III has 1152 samples a frame in MPEG-1 and half that afterwards;
    // the slot count follows, which is what the length formula says.
    const samples = version === 1 ? 1152 : 576;
    const length = Math.floor((samples / 8) * bitrate / sampleRate) + padding;
    return {
        version, bitrate, sampleRate, length, samples,
        channels: mode === CHANNEL_MODE_MONO ? 1 : 2,
    };
}

/**
 * How many bytes of ID3v2 tag stand at the front, zero when none.
 *
 * @param {Uint8Array} bytes
 */
export function id3Length(bytes){
    if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33)
    {
        return 0;
    }
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14)
        | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const footer = (bytes[5] & 0x10) !== 0 ? 10 : 0;
    return 10 + size + footer;
}

/**
 * @typedef {Object} Frame
 * @property {number} offset   where the frame starts in the stream
 * @property {FrameHeader} header
 */

/**
 * The frames that can be confirmed between `from` and `end`, and where to
 * resume scanning once more bytes are in.
 *
 * A frame is believed only when the frame it says follows it is a frame too,
 * or the stream ends there: a sync pattern also occurs inside audio data, and
 * a false frame would carry the cut off the grid for the rest of the file. So
 * the last frame of a partial buffer waits for the bytes after it, and `next`
 * points at it rather than past it.
 *
 * @param {Uint8Array} bytes
 * @param {number} from
 * @param {number} end       how much of `bytes` is filled in
 * @param {boolean} complete whether `end` is the end of the stream
 * @returns {{ frames: Frame[], next: number }}
 */
export function scanFrames(bytes, from, end, complete){
    /** @type {Frame[]} */
    const frames = [];
    let at = from;
    while (at + 4 <= end)
    {
        const header = parseFrameHeader(bytes, at);
        if (header === null)
        {
            at++;
            continue;
        }
        const next = at + header.length;
        if (next + 4 > end)
        {
            // Cannot see past it yet. Complete streams take it when it fits.
            if (complete && next <= end)
            {
                frames.push({ offset: at, header });
                at = next;
                continue;
            }
            if (!complete)
            {
                return { frames, next: at };
            }
            break;
        }
        if (parseFrameHeader(bytes, next) === null)
        {
            at++;
            continue;
        }
        frames.push({ offset: at, header });
        at = next;
    }
    return { frames, next: at };
}

/**
 * Every frame in a whole stream, in order.
 *
 * @param {Uint8Array} bytes
 * @returns {Frame[]}
 */
export function splitFrames(bytes){
    return scanFrames(bytes, id3Length(bytes), bytes.length, true).frames;
}

/**
 * @typedef {Object} DecoderStream
 * @property {(bytes: Uint8Array, header: FrameHeader) => void} feed  One frame, in order.
 * @property {() => Promise<void>} flush   Resolves once every fed frame has come out.
 * @property {() => void} close
 */

/**
 * @typedef {Object} Decoder
 * @property {(header: FrameHeader, onPcm: (samples: Int16Array) => void,
 *     onError: (error: Error) => void) => DecoderStream} open
 *   A stream shaped like its first frame. Samples come out interleaved,
 *   16-bit, as the decoder produces them -- later than they went in, and
 *   not necessarily one frame's worth at a time.
 */

/**
 * @param {any} data       an AudioData
 * @returns {Int16Array}   interleaved 16-bit samples
 */
export function interleave16(data){
    const channels = data.numberOfChannels;
    const frames = data.numberOfFrames;
    const out = new Int16Array(frames * channels);
    /** @type {string} */
    const format = data.format ?? 'f32-planar';
    const planar = format.endsWith('-planar');
    const float = format.startsWith('f32');
    const planes = planar ? channels : 1;
    const perPlane = planar ? frames : frames * channels;
    for (let plane = 0; plane < planes; plane++)
    {
        const buffer = float ? new Float32Array(perPlane) : new Int16Array(perPlane);
        data.copyTo(buffer, { planeIndex: plane });
        for (let index = 0; index < perPlane; index++)
        {
            const value = float
                ? Math.max(-32768, Math.min(32767, Math.round(buffer[index] * 32767)))
                : buffer[index];
            out[planar ? index * channels + plane : index] = value;
        }
    }
    return out;
}

/**
 * The platform's decoder, reached through WebCodecs.
 *
 * @param {any} [AudioDecoderClass]   the constructor; the global by default
 * @param {any} [EncodedAudioChunkClass]
 * @returns {Decoder}
 */
export function createWebCodecsDecoder(AudioDecoderClass, EncodedAudioChunkClass){
    const AudioDecoderImpl = AudioDecoderClass ?? /** @type {any} */ (globalThis).AudioDecoder;
    const ChunkImpl = EncodedAudioChunkClass ?? /** @type {any} */ (globalThis).EncodedAudioChunk;
    return {
        open(header, onPcm, onError){
            if (!AudioDecoderImpl || !ChunkImpl)
            {
                throw new Error('no MPEG audio decoder on this platform');
            }
            const decoder = new AudioDecoderImpl({
                /** @param {any} data */
                output: data=>{
                    onPcm(interleave16(data));
                    data.close();
                },
                error: onError,
            });
            decoder.configure({
                codec: 'mp3', sampleRate: header.sampleRate, numberOfChannels: header.channels,
            });
            let timestamp = 0;
            return {
                feed(bytes, frame){
                    decoder.decode(new ChunkImpl({
                        type: 'key', timestamp: Math.round(timestamp), data: bytes,
                    }));
                    timestamp += frame.samples * 1e6 / frame.sampleRate;
                },
                flush: ()=>decoder.flush(),
                close: ()=>{
                    if (decoder.state !== 'closed')
                    {
                        decoder.close();
                    }
                },
            };
        },
    };
}
