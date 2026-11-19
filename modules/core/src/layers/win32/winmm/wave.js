/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A RIFF WAVE image, read into PCM the mixer can take.
 *
 * The encodings understood are the ones a Windows install plays through
 * PlaySound and MCI without anything added: PCM of 8, 16, 24 or 32 bits and
 * IEEE float, whether the format chunk names them with the plain tag or the
 * extensible one; A-law and mu-law (G.711); and the two ADPCM codecs the
 * audio compression manager carries, Microsoft's and IMA's, decoded by the
 * same block decoders msacm32 converts with (`msacm32/codecs.js`). Anything
 * else is refused, and the refusal is the caller's to report.
 */

import { decodeImaBlock, decodeMsBlock, imaSamplesPerBlock, msSamplesPerBlock,
    MS_COEFFICIENTS } from '../msacm32/codecs.js';

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_ADPCM = 2;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_ALAW = 6;
const WAVE_FORMAT_MULAW = 7;
const WAVE_FORMAT_IMA_ADPCM = 0x11;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

/**
 * The tail of every KSDATAFORMAT_SUBTYPE GUID that stands for a plain format
 * tag: the tag itself is the GUID's first dword, PCM's 1 and float's 3.
 */
const SUBTYPE_TAIL = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/** WAVEFORMATEX, and the extensions that follow it. */
const FORMAT = Object.freeze({
    wFormatTag: 0,
    nChannels: 2,
    nSamplesPerSec: 4,
    nBlockAlign: 12,
    wBitsPerSample: 14,
    size: 16,
    /** Microsoft ADPCM's: samples per block, then its own predictor pairs. */
    wSamplesPerBlock: 18,
    wNumCoef: 20,
    aCoef: 22,
    /** WAVEFORMATEXTENSIBLE's sub-format GUID, and where the structure ends. */
    SubFormat: 24,
    extensibleSize: 40,
});

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/** @param {Uint8Array} bytes @param {number} at */
const u16 = (bytes, at)=>bytes[at] | bytes[at + 1] << 8;

/** @param {Uint8Array} bytes @param {number} at */
const i16 = (bytes, at)=>(u16(bytes, at) << 16) >> 16;

/**
 * @typedef {Object} WaveFormat
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} bitsPerSample
 * @property {boolean} [float]  IEEE float samples, of 32 bits
 */

/**
 * The format tag a format chunk stands for. An extensible format names its
 * encoding by a GUID after the header rather than by the tag; PCM's and
 * float's sub-formats are those tags however many channels or bits they
 * carry. Only those two are read through it: another encoding's own
 * extension would sit where the extensible fields are.
 *
 * @param {Uint8Array} fmt
 * @returns {number}
 */
function formatTag(fmt){
    const tag = u16(fmt, FORMAT.wFormatTag);
    if (tag !== WAVE_FORMAT_EXTENSIBLE || fmt.length < FORMAT.extensibleSize
        || !SUBTYPE_TAIL.every((byte, at)=>fmt[FORMAT.SubFormat + 4 + at] === byte))
    {
        return tag;
    }
    const sub = u32(fmt, FORMAT.SubFormat);
    return sub === WAVE_FORMAT_PCM || sub === WAVE_FORMAT_IEEE_FLOAT ? sub : tag;
}

/**
 * One G.711 byte as the 16-bit sample it stands for: A-law's or mu-law's
 * eight-bit logarithmic code expanded (ITU-T G.711), which the mapper does
 * for a stream of either before the device sees it.
 *
 * @param {number} byte @param {boolean} alaw
 */
export function expandG711(byte, alaw){
    if (alaw)
    {
        const code = byte ^ 0x55;
        const exponent = (code >> 4) & 7;
        const mantissa = code & 0x0f;
        const magnitude = exponent === 0 ? (mantissa << 4) + 8
            : ((mantissa << 4) + 0x108) << (exponent - 1);
        return (code & 0x80) !== 0 ? magnitude : -magnitude;
    }
    const code = ~byte & 0xff;
    const exponent = (code >> 4) & 7;
    const magnitude = ((((code & 0x0f) << 3) + 0x84) << exponent) - 0x84;
    return (code & 0x80) !== 0 ? -magnitude : magnitude;
}

/** @param {Int16Array} samples */
const bytesOf = samples=>new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);

/**
 * Whole blocks of an ADPCM stream through one block decoder, into
 * interleaved 16-bit samples; a short block at the end is not decoded.
 *
 * @param {Uint8Array} data @param {number} blockAlign @param {number} channels
 * @param {number} samplesPerBlock
 * @param {(block: Uint8Array, out: Int16Array) => void} decode
 */
function decodeBlocks(data, blockAlign, channels, samplesPerBlock, decode){
    const blocks = Math.floor(data.length / blockAlign);
    const perBlock = samplesPerBlock * channels;
    const out = new Int16Array(blocks * perBlock);
    for (let block = 0; block < blocks; block++)
    {
        decode(data.subarray(block * blockAlign, (block + 1) * blockAlign),
            out.subarray(block * perBlock, (block + 1) * perBlock));
    }
    return bytesOf(out);
}

/**
 * Microsoft ADPCM to 16-bit PCM: each block opens with every channel's
 * predictor, step and last two samples, and every nibble after is a
 * correction to a prediction from the two before it. The format chunk names
 * its predictor pairs; one that names none uses the seven standard ones.
 *
 * @param {Uint8Array} fmt   The format chunk, coefficient table included.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function decodeAdpcm(fmt, data){
    const channels = u16(fmt, FORMAT.nChannels);
    const blockAlign = u16(fmt, FORMAT.nBlockAlign);
    const samplesPerBlock = fmt.length >= FORMAT.wNumCoef
        ? u16(fmt, FORMAT.wSamplesPerBlock) : msSamplesPerBlock(blockAlign, channels);
    /** @type {number[][]} */
    const coefficients = [];
    const count = fmt.length >= FORMAT.aCoef ? u16(fmt, FORMAT.wNumCoef) : 0;
    for (let i = 0; i < count && FORMAT.aCoef + i * 4 + 4 <= fmt.length; i++)
    {
        coefficients.push([i16(fmt, FORMAT.aCoef + i * 4), i16(fmt, FORMAT.aCoef + i * 4 + 2)]);
    }
    if (channels < 1 || channels > 2 || blockAlign <= 7 * channels || samplesPerBlock < 2)
    {
        return new Uint8Array(0);
    }
    const pairs = coefficients.length > 0 ? coefficients : MS_COEFFICIENTS;
    return decodeBlocks(data, blockAlign, channels, samplesPerBlock,
        (block, out)=>decodeMsBlock(block, channels, samplesPerBlock, pairs, out));
}

/**
 * IMA ADPCM to 16-bit PCM, block by block as Microsoft packs it.
 *
 * @param {Uint8Array} fmt @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function decodeIma(fmt, data){
    const channels = u16(fmt, FORMAT.nChannels);
    const blockAlign = u16(fmt, FORMAT.nBlockAlign);
    if (channels < 1 || channels > 2 || blockAlign <= 4 * channels)
    {
        return new Uint8Array(0);
    }
    const samplesPerBlock = imaSamplesPerBlock(blockAlign, channels);
    return decodeBlocks(data, blockAlign, channels, samplesPerBlock,
        (block, out)=>decodeImaBlock(block, channels, samplesPerBlock, out));
}

/**
 * The PCM inside a RIFF WAVE image, or null when it is not one this can play.
 *
 * @param {Uint8Array} bytes
 * @returns {{ format: WaveFormat, pcm: Uint8Array } | null}
 */
export function parseWave(bytes){
    const tag = (/** @type {number} */ at)=>String.fromCharCode(...bytes.subarray(at, at + 4));
    if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    {
        return null;
    }
    let fmt = null;
    let data = null;
    for (let at = 12; at + 8 <= bytes.length;)
    {
        const size = u32(bytes, at + 4);
        const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
        if (tag(at) === 'fmt ' && body.length >= FORMAT.size)
        {
            fmt = body;
        }
        else if (tag(at) === 'data')
        {
            data = body;
        }
        // Chunks are word-aligned; an odd-sized one is followed by a pad byte.
        at += 8 + size + (size & 1);
    }
    if (!fmt || !data)
    {
        return null;
    }
    const format = {
        sampleRate: u32(fmt, FORMAT.nSamplesPerSec),
        channels: u16(fmt, FORMAT.nChannels),
        bitsPerSample: u16(fmt, FORMAT.wBitsPerSample),
    };
    if (!(format.sampleRate > 0) || !(format.channels > 0))
    {
        return null;
    }
    const sixteen = { ...format, bitsPerSample: 16 };
    const encoding = formatTag(fmt);
    switch (encoding){
        case WAVE_FORMAT_PCM:
            return [8, 16, 24, 32].includes(format.bitsPerSample) ? { format, pcm: data } : null;
        case WAVE_FORMAT_IEEE_FLOAT:
            return format.bitsPerSample === 32
                ? { format: { ...format, float: true }, pcm: data } : null;
        case WAVE_FORMAT_ALAW:
        case WAVE_FORMAT_MULAW:
            return format.bitsPerSample === 8
                ? { format: sixteen, pcm: bytesOf(Int16Array.from(data,
                    byte=>expandG711(byte, encoding === WAVE_FORMAT_ALAW))) }
                : null;
        case WAVE_FORMAT_ADPCM:
            return { format: sixteen, pcm: decodeAdpcm(fmt, data) };
        case WAVE_FORMAT_IMA_ADPCM:
            return { format: sixteen, pcm: decodeIma(fmt, data) };
        default:
            return null;
    }
}
