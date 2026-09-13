/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A RIFF WAVE image, read into PCM the mixer can take.
 *
 * Two encodings are understood: PCM as it is, and Microsoft's ADPCM, which is
 * what a program of this era ships a compressed sound in and what PlaySound
 * decodes through the audio compression manager. Anything else is refused,
 * and the refusal is the caller's to report.
 */

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_ADPCM = 2;

/** WAVEFORMATEX, and the ADPCM extension that follows it. */
const FORMAT = Object.freeze({
    wFormatTag: 0,
    nChannels: 2,
    nSamplesPerSec: 4,
    nBlockAlign: 12,
    wBitsPerSample: 14,
    size: 16,
    wSamplesPerBlock: 18,
    wNumCoef: 20,
    aCoef: 22,
});

/** How the step size adapts after each nibble, indexed by the nibble. */
const ADAPTATION = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];

/** The step never shrinks below this, or a quiet passage could never get loud again. */
const MIN_DELTA = 16;

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
 */

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
    switch (u16(fmt, FORMAT.wFormatTag)){
        case WAVE_FORMAT_PCM:
            return { format, pcm: data };
        case WAVE_FORMAT_ADPCM:
            return fmt.length >= FORMAT.aCoef
                ? { format: { ...format, bitsPerSample: 16 }, pcm: decodeAdpcm(fmt, data) }
                : null;
        default:
            return null;
    }
}

/**
 * Microsoft ADPCM to 16-bit PCM.
 *
 * A block opens with each channel's state -- which predictor it uses, its
 * step, and its last two samples -- and the two samples are emitted as they
 * are, oldest first. Every nibble after that is a correction to a prediction
 * made from the two before it, with the step scaled by the size of the nibble
 * so a loud passage takes larger steps. Stereo interleaves the channels a
 * nibble at a time, left in the high half of each byte.
 *
 * @param {Uint8Array} fmt   The format chunk, coefficient table included.
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function decodeAdpcm(fmt, data){
    const channels = u16(fmt, FORMAT.nChannels);
    const blockAlign = u16(fmt, FORMAT.nBlockAlign);
    const samplesPerBlock = u16(fmt, FORMAT.wSamplesPerBlock);
    const coefficientCount = u16(fmt, FORMAT.wNumCoef);
    const coefficients = [];
    for (let i = 0; i < coefficientCount && FORMAT.aCoef + i * 4 + 4 <= fmt.length; i++)
    {
        coefficients.push([i16(fmt, FORMAT.aCoef + i * 4), i16(fmt, FORMAT.aCoef + i * 4 + 2)]);
    }
    const headerSize = 7 * channels;
    if (channels < 1 || channels > 2 || blockAlign <= headerSize || samplesPerBlock < 2
        || coefficients.length === 0)
    {
        return new Uint8Array(0);
    }

    const blocks = Math.floor(data.length / blockAlign);
    const out = new Int16Array(blocks * samplesPerBlock * channels);
    let written = 0;
    for (let block = 0; block < blocks; block++)
    {
        const base = block * blockAlign;
        const state = [];
        for (let channel = 0; channel < channels; channel++)
        {
            const chosen = coefficients[Math.min(data[base + channel], coefficients.length - 1)];
            state.push({
                coef1: chosen[0],
                coef2: chosen[1],
                delta: i16(data, base + channels + channel * 2),
                sample1: i16(data, base + channels * 3 + channel * 2),
                sample2: i16(data, base + channels * 5 + channel * 2),
            });
        }
        for (const one of state)
        {
            out[written++] = one.sample2;
        }
        for (const one of state)
        {
            out[written++] = one.sample1;
        }
        const nibbles = (samplesPerBlock - 2) * channels;
        for (let n = 0, at = base + headerSize; n < nibbles && at < base + blockAlign; n++)
        {
            const nibble = (n & 1) === 0 ? data[at] >> 4 : data[at++] & 0x0f;
            const one = state[n % channels];
            const signed = nibble >= 8 ? nibble - 16 : nibble;
            let predicted = ((one.sample1 * one.coef1 + one.sample2 * one.coef2) >> 8)
                + signed * one.delta;
            predicted = Math.max(-32768, Math.min(32767, predicted));
            one.sample2 = one.sample1;
            one.sample1 = predicted;
            one.delta = Math.max(MIN_DELTA, (ADAPTATION[nibble] * one.delta) >> 8);
            out[written++] = predicted;
        }
    }
    return new Uint8Array(out.buffer, 0, written * 2);
}
