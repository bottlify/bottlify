/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two ADPCM decoders a Windows install carries as ACM drivers, written
 * from the formats' published descriptions: IMA ADPCM (WAVE_FORMAT_IMA_ADPCM,
 * the IMA's Digital Audio Recommended Practices as Microsoft packs it into
 * blocks) and Microsoft ADPCM (WAVE_FORMAT_ADPCM). Each decodes whole blocks
 * into interleaved 16-bit samples.
 */

/** IMA ADPCM's quantiser steps, indexed by the running step index. */
const IMA_STEPS = Object.freeze([
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60,
    66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
    408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707,
    1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132,
    7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623,
    27086, 29794, 32767,
]);
/** How a code moves the step index. */
const IMA_INDEX = Object.freeze([-1, -1, -1, -1, 2, 4, 6, 8]);

/** Microsoft ADPCM's step adaptation, by code. */
const MS_ADAPT = Object.freeze([
    230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230,
]);
/** The seven predictor pairs a Microsoft ADPCM format names unless it names its own. */
export const MS_COEFFICIENTS = Object.freeze([
    [256, 0], [512, -256], [0, 0], [192, 64], [240, 0], [460, -208], [392, -232],
]);

/** @param {number} value */
const clamp16 = value=>(value > 32767 ? 32767 : value < -32768 ? -32768 : value);

/** @param {number} blockAlign @param {number} channels */
export const imaSamplesPerBlock = (blockAlign, channels)=>
    ((blockAlign - 4 * channels) * 8) / (4 * channels) + 1;

/** @param {number} blockAlign @param {number} channels */
export const msSamplesPerBlock = (blockAlign, channels)=>
    ((blockAlign - 7 * channels) * 2) / channels + 2;

/**
 * Decodes one IMA ADPCM block. Each channel opens with its first sample and
 * step index; after that the channels take turns, four bytes -- eight codes,
 * low nibble first -- at a time.
 *
 * @param {Uint8Array} block  `blockAlign` bytes
 * @param {number} channels
 * @param {number} samplesPerBlock  per channel
 * @param {Int16Array} out  `samplesPerBlock * channels`, interleaved
 */
export function decodeImaBlock(block, channels, samplesPerBlock, out){
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const predictor = new Int32Array(channels);
    const index = new Int32Array(channels);
    for (let channel = 0; channel < channels; channel++)
    {
        predictor[channel] = view.getInt16(channel * 4, true);
        index[channel] = Math.min(88, Math.max(0, block[channel * 4 + 2]));
        out[channel] = predictor[channel];
    }
    let at = 4 * channels;
    let sample = 1;
    while (sample < samplesPerBlock && at < block.length)
    {
        for (let channel = 0; channel < channels; channel++)
        {
            for (let byte = 0; byte < 4 && at < block.length; byte++, at++)
            {
                for (let half = 0; half < 2; half++)
                {
                    const code = half === 0 ? block[at] & 0x0f : block[at] >>> 4;
                    const step = IMA_STEPS[index[channel]];
                    let difference = step >> 3;
                    if (code & 1)
                    {
                        difference += step >> 2;
                    }
                    if (code & 2)
                    {
                        difference += step >> 1;
                    }
                    if (code & 4)
                    {
                        difference += step;
                    }
                    predictor[channel] = clamp16(code & 8
                        ? predictor[channel] - difference : predictor[channel] + difference);
                    index[channel] = Math.min(88,
                        Math.max(0, index[channel] + IMA_INDEX[code & 7]));
                    const position = sample + byte * 2 + half;
                    if (position < samplesPerBlock)
                    {
                        out[position * channels + channel] = predictor[channel];
                    }
                }
            }
        }
        sample += 8;
    }
}

/**
 * Decodes one Microsoft ADPCM block. The header gives each channel its
 * predictor pair, its step and its two most recent samples, the older of
 * which is the block's first output; after that the codes come high nibble
 * first, the channels alternating code by code.
 *
 * @param {Uint8Array} block
 * @param {number} channels
 * @param {number} samplesPerBlock  per channel
 * @param {readonly (readonly number[])[]} coefficients
 * @param {Int16Array} out
 */
export function decodeMsBlock(block, channels, samplesPerBlock, coefficients, out){
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const first = new Int32Array(channels);
    const second = new Int32Array(channels);
    const delta = new Int32Array(channels);
    const coef1 = new Int32Array(channels);
    const coef2 = new Int32Array(channels);
    for (let channel = 0; channel < channels; channel++)
    {
        const pair = coefficients[Math.min(block[channel], coefficients.length - 1)] ?? [0, 0];
        coef1[channel] = pair[0];
        coef2[channel] = pair[1];
        delta[channel] = view.getInt16(channels + channel * 2, true);
        first[channel] = view.getInt16(channels * 3 + channel * 2, true);
        second[channel] = view.getInt16(channels * 5 + channel * 2, true);
        out[channel] = second[channel];
        out[channels + channel] = first[channel];
    }
    let at = channels * 7;
    let written = 2 * channels;
    const total = samplesPerBlock * channels;
    while (written < total && at < block.length)
    {
        for (let half = 0; half < 2 && written < total; half++)
        {
            const channel = written % channels;
            const code = half === 0 ? block[at] >>> 4 : block[at] & 0x0f;
            const signed = code >= 8 ? code - 16 : code;
            const predicted =
                (first[channel] * coef1[channel] + second[channel] * coef2[channel]) >> 8;
            const value = clamp16(predicted + signed * delta[channel]);
            second[channel] = first[channel];
            first[channel] = value;
            delta[channel] = Math.max(16, (MS_ADAPT[code] * delta[channel]) >> 8);
            out[written++] = value;
        }
        at++;
    }
}
