/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msacm32 -- the Audio Compression Manager, with the drivers a Windows
 * install has from the start: the PCM converter, Microsoft ADPCM and IMA
 * ADPCM.
 *
 * Sound engines of the era keep their effects ADPCM-compressed and find a
 * decoder by asking the manager: they enumerate the drivers, read each one's
 * details, open the one they want and convert through a stream. A manager
 * with no drivers leaves such an engine with nothing it can play, which is
 * what it does then -- silently. The ADPCM drivers here decode (`codecs.js`);
 * none of them encodes, and a conversion that would need it is refused as
 * Windows refuses one no installed driver can do.
 */

import {
    MS_COEFFICIENTS, decodeImaBlock, decodeMsBlock, imaSamplesPerBlock, msSamplesPerBlock,
} from './codecs.js';

const MMSYSERR_NOERROR = 0;
const MMSYSERR_INVALHANDLE = 5;
const MMSYSERR_NOTSUPPORTED = 8;
const MMSYSERR_INVALFLAG = 10;
const MMSYSERR_INVALPARAM = 11;
/** ACMERR_NOTPOSSIBLE: no driver can perform the requested conversion. */
const ACMERR_NOTPOSSIBLE = 0x200 + 3;
const ACMERR_UNPREPARED = 0x200 + 2;

/** The manager reports itself as version 4.0 with no driver-specific build. */
const ACM_VERSION = 0x04000000;

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_ADPCM = 2;
const WAVE_FORMAT_IMA_ADPCM = 0x11;

/** WAVEFORMATEX, and the ADPCM formats' extra fields after it. */
const WAVEFORMATEX = Object.freeze({
    wFormatTag: 0, nChannels: 2, nSamplesPerSec: 4, nAvgBytesPerSec: 8, nBlockAlign: 12,
    wBitsPerSample: 14, cbSize: 16, SIZE: 18, wSamplesPerBlock: 18, wNumCoef: 20, aCoef: 22,
});

/** ACMDRIVERDETAILS, its strings in the width of the A or W entry point. */
const DETAILS = Object.freeze({
    cbStruct: 0, fccType: 4, fccComp: 8, wMid: 12, wPid: 14, vdwACM: 16, vdwDriver: 20,
    fdwSupport: 24, cFormatTags: 28, cFilterTags: 32, hicon: 36, strings: 40,
});
const DETAIL_STRINGS = Object.freeze([32, 128, 80, 128, 512]);

/** ACMSTREAMHEADER. */
const HEADER = Object.freeze({
    cbStruct: 0, fdwStatus: 4, pbSrc: 12, cbSrcLength: 16, cbSrcLengthUsed: 20, pbDst: 28,
    cbDstLength: 32, cbDstLengthUsed: 36, SIZE: 84,
});
const ACMSTREAMHEADER_STATUSF_DONE = 0x00010000;
const ACMSTREAMHEADER_STATUSF_PREPARED = 0x00020000;
const ACMSTREAMHEADER_STATUSF_INQUEUE = 0x00100000;

const ACMDRIVERDETAILS_SUPPORTF_CODEC = 0x00000001;
const ACMDRIVERDETAILS_SUPPORTF_CONVERTER = 0x00000002;
const ACM_STREAMOPENF_QUERY = 0x00000001;
const ACM_STREAMSIZEF_DESTINATION = 0x00000001;
const ACM_FORMATSUGGESTF_WFORMATTAG = 0x00010000;
const ACM_FORMATSUGGESTF_NCHANNELS = 0x00020000;
const ACM_FORMATSUGGESTF_NSAMPLESPERSEC = 0x00040000;
const ACM_FORMATSUGGESTF_WBITSPERSAMPLE = 0x00080000;

/** acmMetrics' questions this manager answers. */
const METRIC = Object.freeze({
    COUNT_DRIVERS: 1, COUNT_CODECS: 2, COUNT_CONVERTERS: 3, COUNT_FILTERS: 4,
    COUNT_DISABLED: 5, COUNT_HARDWARE: 6, COUNT_LOCAL_DRIVERS: 20, COUNT_LOCAL_CODECS: 21,
    COUNT_LOCAL_CONVERTERS: 22, COUNT_LOCAL_FILTERS: 23, COUNT_LOCAL_DISABLED: 24,
    HARDWARE_WAVE_INPUT: 30, HARDWARE_WAVE_OUTPUT: 31, MAX_SIZE_FORMAT: 50,
    MAX_SIZE_FILTER: 51, DRIVER_SUPPORT: 100, DRIVER_PRIORITY: 101,
});

/** @param {string} text @returns {number} */
const fourcc = text=>[...text.padEnd(4, ' ')].reduce(
    (value, character, index)=>value | (character.charCodeAt(0) << (index * 8)), 0) >>> 0;

/**
 * The installed drivers, in the order Windows enumerates its own.
 *
 * @type {readonly { id: number, tag: number, support: number, short: string,
 *     long: string, comp: string }[]}
 */
const DRIVERS = Object.freeze([
    { id: 0x41c00001, tag: WAVE_FORMAT_ADPCM, support: ACMDRIVERDETAILS_SUPPORTF_CODEC,
        short: 'MS-ADPCM', long: 'Microsoft ADPCM CODEC', comp: 'msad' },
    { id: 0x41c00002, tag: WAVE_FORMAT_IMA_ADPCM, support: ACMDRIVERDETAILS_SUPPORTF_CODEC,
        short: 'IMA ADPCM', long: 'Microsoft IMA ADPCM CODEC', comp: 'imad' },
    { id: 0x41c00003, tag: WAVE_FORMAT_PCM, support: ACMDRIVERDETAILS_SUPPORTF_CONVERTER,
        short: 'MS-PCM', long: 'Microsoft PCM Converter', comp: 'pcm ' },
]);

/** ACMFORMATDETAILS, its name in the width of the entry point. */
const FORMAT_DETAILS = Object.freeze({
    cbStruct: 0, dwFormatIndex: 4, dwFormatTag: 8, fdwSupport: 12, pwfx: 16, cbwfx: 20,
    szFormat: 24, NAME_CHARS: 128,
});
/** ACMFORMATTAGDETAILS. */
const TAG_DETAILS = Object.freeze({
    cbStruct: 0, dwFormatTagIndex: 4, dwFormatTag: 8, cbFormatSize: 12, fdwSupport: 16,
    cStandardFormats: 20, szFormatTag: 24, NAME_CHARS: 48,
});
const ACM_FORMATENUMF_WFORMATTAG = 0x00010000;
const ACM_FORMATENUMF_NCHANNELS = 0x00020000;
const ACM_FORMATENUMF_NSAMPLESPERSEC = 0x00040000;
const ACM_FORMATENUMF_WBITSPERSAMPLE = 0x00080000;
const ACM_FORMATDETAILSF_INDEX = 0x00000000;
const ACM_FORMATTAGDETAILSF_INDEX = 0x00000000;
const ACM_FORMATTAGDETAILSF_FORMATTAG = 0x00000001;
const ACM_FORMATTAGDETAILSF_LARGESTSIZE = 0x00000002;
const ACM_FORMATDETAILSF_FORMAT = 0x00000001;

/** The rates the drivers list a format at, as Windows' own do. */
const STANDARD_RATES = Object.freeze([8000, 11025, 22050, 44100]);

/**
 * One format a driver lists: the WAVEFORMATEX bytes and a name.
 *
 * @typedef {{ tag: number, channels: number, rate: number, bits: number,
 *     bytes: Uint8Array, name: string }} ListedFormat
 */

/**
 * The format of a tag at a rate and channel count, as its driver lays it out.
 *
 * @param {number} tag @param {number} channels @param {number} rate @param {number} bits
 * @returns {ListedFormat}
 */
function listedFormat(tag, channels, rate, bits){
    const perChannel = rate <= 11025 ? 256 : rate <= 22050 ? 512 : 1024;
    const extra = tag === WAVE_FORMAT_ADPCM ? 4 + 7 * 4 : tag === WAVE_FORMAT_IMA_ADPCM ? 2 : 0;
    const bytes = new Uint8Array(WAVEFORMATEX.SIZE + extra);
    const view = new DataView(bytes.buffer);
    let blockAlign = channels * (bits / 8);
    let samplesPerBlock = 1;
    if (tag === WAVE_FORMAT_IMA_ADPCM)
    {
        blockAlign = perChannel * channels;
        samplesPerBlock = imaSamplesPerBlock(blockAlign, channels);
    }
    else if (tag === WAVE_FORMAT_ADPCM)
    {
        blockAlign = perChannel * channels;
        samplesPerBlock = msSamplesPerBlock(blockAlign, channels);
    }
    view.setUint16(WAVEFORMATEX.wFormatTag, tag, true);
    view.setUint16(WAVEFORMATEX.nChannels, channels, true);
    view.setUint32(WAVEFORMATEX.nSamplesPerSec, rate, true);
    view.setUint32(WAVEFORMATEX.nAvgBytesPerSec,
        Math.floor(rate * blockAlign / samplesPerBlock), true);
    view.setUint16(WAVEFORMATEX.nBlockAlign, blockAlign, true);
    view.setUint16(WAVEFORMATEX.wBitsPerSample, bits, true);
    view.setUint16(WAVEFORMATEX.cbSize, extra, true);
    if (extra > 0)
    {
        view.setUint16(WAVEFORMATEX.wSamplesPerBlock, samplesPerBlock, true);
    }
    if (tag === WAVE_FORMAT_ADPCM)
    {
        view.setUint16(WAVEFORMATEX.wNumCoef, MS_COEFFICIENTS.length, true);
        MS_COEFFICIENTS.forEach(([first, second], index)=>{
            view.setInt16(WAVEFORMATEX.aCoef + index * 4, first, true);
            view.setInt16(WAVEFORMATEX.aCoef + index * 4 + 2, second, true);
        });
    }
    const khz = (rate / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
    const name = `${khz} kHz, ${bits} Bit, ${channels === 1 ? 'Mono' : 'Stereo'}`;
    return { tag, channels, rate, bits, bytes, name };
}

/**
 * Every format a driver lists, tag by tag: a codec its compressed tag and the
 * PCM it decodes to, the converter PCM alone.
 *
 * @param {typeof DRIVERS[number]} driver
 * @returns {{ tag: number, name: string, formats: ListedFormat[] }[]}
 */
function tagsOf(/** @type {typeof DRIVERS[number] & { codec?: AcmCodec }} */ driver){
    /** @param {number} tag @param {number[]} widths */
    const all = (tag, widths)=>STANDARD_RATES.flatMap(rate=>[1, 2].flatMap(
        channels=>widths.map(bits=>listedFormat(tag, channels, rate, bits))));
    const pcm = { tag: WAVE_FORMAT_PCM, name: 'PCM', formats: all(WAVE_FORMAT_PCM, [8, 16]) };
    if (driver.tag === WAVE_FORMAT_PCM)
    {
        return [pcm];
    }
    if (driver.codec)
    {
        return [pcm,
            { tag: driver.tag, name: driver.codec.tagName, formats: driver.codec.formats }];
    }
    return [pcm, { tag: driver.tag, name: driver.tag === WAVE_FORMAT_ADPCM
        ? 'Microsoft ADPCM' : 'IMA ADPCM', formats: all(driver.tag, [4]) }];
}

/**
 * @typedef {Object} WaveFormat
 * @property {number} tag
 * @property {number} channels
 * @property {number} rate
 * @property {number} blockAlign
 * @property {number} bits
 * @property {number} samplesPerBlock
 * @property {number[][]} coefficients
 * @property {number} [averageBytes]
 * @property {Uint8Array} [extra]  The bytes after WAVEFORMATEX, as cbSize counts them.
 */

/**
 * A driver another layer installs: a codec from its own tag to PCM, as
 * Windows installs one for MPEG Layer-3 beside the ADPCM ones.
 *
 * @typedef {Object} AcmCodec
 * @property {number} tag
 * @property {string} short
 * @property {string} long
 * @property {string} comp      the driver's four-character code
 * @property {string} tagName   what acmFormatTagDetails calls its tag
 * @property {ListedFormat[]} formats  its own tag's formats
 * @property {(from: WaveFormat, to: WaveFormat) => boolean} converts
 * @property {(from: WaveFormat, to: WaveFormat) => AcmCodecStream} open
 */

/**
 * One conversion through an installed codec.
 *
 * @typedef {Object} AcmCodecStream
 * @property {(source: Uint8Array, room: number)
 *     => { consumed: number, output: Uint8Array }} convert
 *     As much of `source` as fits `room` bytes of output.
 * @property {(bytes: number, toDestination: boolean) => number} size
 */

/**
 * @param {Object} host
 * @param {(address: number, length: number) => Uint8Array} host.readMemory
 * @param {(address: number, bytes: Uint8Array) => void} host.writeMemory
 * @param {(entry: number, args: number[], thread?: any) => Promise<number>} [host.callGuest]
 * @param {() => any} [host.currentThread]
 * @param {(api: string, detail: string) => void} [host.divergence]
 * @param {() => readonly AcmCodec[]} [host.codecs]  Drivers other layers installed.
 */
export function createAcmFunctions(host = /** @type {any} */ ({})){
    const { readMemory, writeMemory } = host;

    /**
     * Every driver, Windows' own first and then the installed ones, each of
     * those numbered after them.
     *
     * @returns {(typeof DRIVERS[number] & { codec?: AcmCodec })[]}
     */
    const allDrivers = ()=>[...DRIVERS, ...(host.codecs?.() ?? []).map((codec, index)=>({
        id: 0x41c00004 + index, tag: codec.tag, support: ACMDRIVERDETAILS_SUPPORTF_CODEC,
        short: codec.short, long: codec.long, comp: codec.comp, codec,
    }))];
    /** The installed codec that decodes a tag. @param {number} tag */
    const codecFor = tag=>(host.codecs?.() ?? []).find(codec=>codec.tag === tag) ?? null;

    /** @param {number} address */
    const u32 = address=>{
        const b = readMemory(address >>> 0, 4);
        return (b[0] | b[1] << 8 | b[2] << 16 | b[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const put32 = (address, value)=>writeMemory(address >>> 0, new Uint8Array(
        [value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff]));

    /**
     * @param {number} address
     * @returns {WaveFormat | null}
     */
    const readFormat = address=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        const head = readMemory(address >>> 0, WAVEFORMATEX.SIZE);
        const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
        const tag = view.getUint16(WAVEFORMATEX.wFormatTag, true);
        const channels = view.getUint16(WAVEFORMATEX.nChannels, true);
        const blockAlign = view.getUint16(WAVEFORMATEX.nBlockAlign, true);
        const extra = tag === WAVE_FORMAT_PCM ? 0 : view.getUint16(WAVEFORMATEX.cbSize, true);
        /** @type {WaveFormat} */
        const format = {
            tag, channels, blockAlign,
            rate: view.getUint32(WAVEFORMATEX.nSamplesPerSec, true),
            bits: view.getUint16(WAVEFORMATEX.wBitsPerSample, true),
            samplesPerBlock: 0,
            coefficients: [],
            averageBytes: view.getUint32(WAVEFORMATEX.nAvgBytesPerSec, true),
            extra: extra > 0 ? readMemory(address + WAVEFORMATEX.SIZE, Math.min(extra, 64)).slice()
                : new Uint8Array(0),
        };
        if (channels === 0 || channels > 2)
        {
            return format;
        }
        if (tag === WAVE_FORMAT_IMA_ADPCM)
        {
            format.samplesPerBlock = extra >= 2
                ? new DataView(readMemory(address + WAVEFORMATEX.wSamplesPerBlock, 2)
                    .slice().buffer).getUint16(0, true)
                : imaSamplesPerBlock(blockAlign, channels);
        }
        if (tag === WAVE_FORMAT_ADPCM)
        {
            const fields = extra >= 4
                ? readMemory(address + WAVEFORMATEX.wSamplesPerBlock, 4) : null;
            const fieldView = fields ? new DataView(fields.slice().buffer) : null;
            format.samplesPerBlock = fieldView?.getUint16(0, true)
                ?? msSamplesPerBlock(blockAlign, channels);
            const count = fieldView?.getUint16(2, true) ?? 0;
            if (count > 0 && extra >= 4 + count * 4)
            {
                const table = new DataView(readMemory(address + WAVEFORMATEX.aCoef, count * 4)
                    .slice().buffer);
                format.coefficients = Array.from({ length: count },
                    (_, index)=>[table.getInt16(index * 4, true),
                        table.getInt16(index * 4 + 2, true)]);
            }
            else
            {
                format.coefficients = MS_COEFFICIENTS.map(pair=>[...pair]);
            }
        }
        return format;
    };

    /** Opened drivers, by handle. @type {Map<number, ReturnType<typeof allDrivers>[number]>} */
    const opened = new Map();
    let nextDriver = 0x41d00001;
    /**
     * Open conversion streams, by handle.
     *
     * @type {Map<number, { from: WaveFormat, to: WaveFormat,
     *     carry: { position: number, previous: number[] }, codec?: AcmCodecStream }>}
     */
    const streams = new Map();
    let nextStream = 0x41e00001;

    /** A driver named by its id or by an opened handle. @param {number} handle */
    const driverOf = handle=>allDrivers().find(driver=>driver.id === (handle >>> 0))
        ?? opened.get(handle >>> 0) ?? null;

    /** @param {WaveFormat} format */
    const isPcm = format=>format.tag === WAVE_FORMAT_PCM
        && (format.bits === 8 || format.bits === 16)
        && (format.channels === 1 || format.channels === 2);

    /**
     * Whether a driver here can take `from` to `to`: an ADPCM format decoded
     * to 16-bit PCM of its rate and channels, as the codecs do, or PCM to PCM
     * of any width, channel count and rate, as the PCM converter does.
     *
     * @param {WaveFormat} from @param {WaveFormat} to
     */
    const convertible = (from, to)=>{
        if (!isPcm(to) || from.rate === 0 || to.rate === 0)
        {
            return false;
        }
        if (from.tag === WAVE_FORMAT_IMA_ADPCM || from.tag === WAVE_FORMAT_ADPCM)
        {
            return to.bits === 16 && to.channels === from.channels && to.rate === from.rate
                && from.blockAlign > 0 && from.samplesPerBlock > 0;
        }
        const codec = codecFor(from.tag);
        return codec ? codec.converts(from, to) : isPcm(from);
    };

    /** @param {WaveFormat} format */
    const describe = format=>`tag 0x${format.tag.toString(16)} ${format.rate} Hz`
        + ` ${format.bits} bit x${format.channels}`;

    /** Bytes of PCM a block decodes to. @param {WaveFormat} from */
    const blockOutput = from=>from.samplesPerBlock * from.channels * 2;

    /**
     * PCM to PCM: width, channel count and rate. A change of rate is linear
     * between neighbouring frames and carries across calls -- where the next
     * output frame falls and the frame before the next source -- so a stream
     * converted a piece at a time joins up.
     *
     * @param {Uint8Array} source @param {WaveFormat} from @param {WaveFormat} to
     * @param {number} frames  source frames given
     * @param {number} room  output frames there is room for
     * @param {{ position: number, previous: number[] }} carry
     * @returns {{ output: Uint8Array, consumed: number }}
     */
    const convertPcm = (source, from, to, frames, room, carry)=>{
        const inView = new DataView(source.buffer, source.byteOffset, source.byteLength);
        const inStride = from.channels * (from.bits / 8);
        /** @param {number} frame @returns {number[]} */
        const read = frame=>{
            if (frame < 0)
            {
                return carry.previous;
            }
            /** @param {number} channel */
            const sample = channel=>{
                const at = frame * inStride
                    + Math.min(channel, from.channels - 1) * (from.bits / 8);
                return from.bits === 16 ? inView.getInt16(at, true) : (source[at] - 128) << 8;
            };
            return [sample(0), sample(1)];
        };
        const step = from.rate / to.rate;
        /** @type {number[][]} */
        const produced = [];
        let position = carry.position;
        if (step === 1)
        {
            for (let frame = 0; frame < Math.min(frames, room); frame++)
            {
                produced.push(read(frame));
            }
        }
        else
        {
            while (produced.length < room)
            {
                const index = Math.floor(position);
                if (index + 1 >= frames)
                {
                    break;
                }
                const fraction = position - index;
                const [l0, r0] = read(index);
                const [l1, r1] = read(index + 1);
                produced.push([l0 + (l1 - l0) * fraction, r0 + (r1 - r0) * fraction]);
                position += step;
            }
        }
        const consumed = step === 1 ? produced.length
            : Math.max(0, Math.min(frames, Math.floor(position) + 1));
        if (step !== 1 && consumed > 0)
        {
            carry.previous = read(consumed - 1);
            carry.position = position - consumed;
        }
        const out = new Uint8Array(produced.length * to.channels * (to.bits / 8));
        const outView = new DataView(out.buffer);
        produced.forEach(([left, right], frame)=>{
            const values = to.channels === 1 && from.channels === 2
                ? [(left + right) / 2] : to.channels === 2 ? [left, right] : [left];
            values.forEach((value, channel)=>{
                const at = (frame * to.channels + channel) * (to.bits / 8);
                const whole = Math.max(-32768, Math.min(32767, Math.round(value)));
                if (to.bits === 16)
                {
                    outView.setInt16(at, whole, true);
                }
                else
                {
                    out[at] = (whole >> 8) + 128;
                }
            });
        });
        return { output: out, consumed };
    };

    /**
     * Writes a WAVEFORMATEX for 16-bit (or the asked width) PCM.
     *
     * @param {number} address @param {number} room
     * @param {{ channels: number, rate: number, bits: number }} pcm
     */
    const writePcmFormat = (address, room, pcm)=>{
        const bytes = new Uint8Array(WAVEFORMATEX.SIZE);
        const view = new DataView(bytes.buffer);
        const blockAlign = pcm.channels * (pcm.bits / 8);
        view.setUint16(WAVEFORMATEX.wFormatTag, WAVE_FORMAT_PCM, true);
        view.setUint16(WAVEFORMATEX.nChannels, pcm.channels, true);
        view.setUint32(WAVEFORMATEX.nSamplesPerSec, pcm.rate, true);
        view.setUint32(WAVEFORMATEX.nAvgBytesPerSec, pcm.rate * blockAlign, true);
        view.setUint16(WAVEFORMATEX.nBlockAlign, blockAlign, true);
        view.setUint16(WAVEFORMATEX.wBitsPerSample, pcm.bits, true);
        writeMemory(address >>> 0, bytes.subarray(0, Math.min(room, WAVEFORMATEX.SIZE)));
    };

    /**
     * ACMDRIVERDETAILS in the caller's width and no further than it said.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const driverDetails = ([handle, details], wide)=>{
        const driver = driverOf(handle);
        if (!driver)
        {
            return MMSYSERR_INVALHANDLE;
        }
        if ((details >>> 0) === 0)
        {
            return MMSYSERR_INVALPARAM;
        }
        const room = u32(details);
        const units = wide ? 2 : 1;
        const size = DETAILS.strings
            + DETAIL_STRINGS.reduce((sum, length)=>sum + length, 0) * units;
        if (room < DETAILS.strings)
        {
            return MMSYSERR_INVALPARAM;
        }
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint32(DETAILS.cbStruct, Math.min(room, size), true);
        view.setUint32(DETAILS.fccType, fourcc('audc'), true);
        view.setUint32(DETAILS.fccComp, fourcc(driver.comp), true);
        view.setUint16(DETAILS.wMid, 1, true);
        view.setUint16(DETAILS.wPid, driver.tag === WAVE_FORMAT_PCM ? 38 : 36, true);
        // An installed codec answers as one more driver, without a vendor's ids.
        if ('codec' in driver)
        {
            view.setUint16(DETAILS.wMid, 0, true);
            view.setUint16(DETAILS.wPid, 0, true);
        }
        view.setUint32(DETAILS.vdwACM, ACM_VERSION, true);
        view.setUint32(DETAILS.vdwDriver, ACM_VERSION, true);
        view.setUint32(DETAILS.fdwSupport, driver.support, true);
        view.setUint32(DETAILS.cFormatTags, driver.tag === WAVE_FORMAT_PCM ? 1 : 2, true);
        let at = DETAILS.strings;
        const texts = [driver.short, driver.long, 'Copyright (C) Microsoft Corp.', '', ''];
        texts.forEach((text, index)=>{
            for (let character = 0; character < text.length; character++)
            {
                bytes[at + character * units] = text.charCodeAt(character) & 0xff;
            }
            at += DETAIL_STRINGS[index] * units;
        });
        writeMemory(details >>> 0, bytes.subarray(0, Math.min(room, size)));
        return MMSYSERR_NOERROR;
    };

    /**
     * @param {number} address @param {string} text @param {number} chars @param {boolean} wide
     */
    const writeName = (address, text, chars, wide)=>{
        const units = wide ? 2 : 1;
        const bytes = new Uint8Array(chars * units);
        for (let index = 0; index < Math.min(text.length, chars - 1); index++)
        {
            bytes[index * units] = text.charCodeAt(index) & 0xff;
        }
        writeMemory(address >>> 0, bytes);
    };

    /**
     * Fills an ACMFORMATDETAILS with one listed format, its WAVEFORMATEX
     * where the caller's pwfx points and no further than cbwfx.
     *
     * @param {number} details @param {ListedFormat} format @param {number} index
     * @param {number} support @param {boolean} wide
     */
    const fillFormatDetails = (details, format, index, support, wide)=>{
        put32(details + FORMAT_DETAILS.dwFormatIndex, index);
        put32(details + FORMAT_DETAILS.dwFormatTag, format.tag);
        put32(details + FORMAT_DETAILS.fdwSupport, support);
        const into = u32(details + FORMAT_DETAILS.pwfx);
        const room = u32(details + FORMAT_DETAILS.cbwfx);
        writeMemory(into, format.bytes.subarray(0, Math.min(room, format.bytes.length)));
        if (u32(details + FORMAT_DETAILS.cbStruct) > FORMAT_DETAILS.szFormat)
        {
            writeName(details + FORMAT_DETAILS.szFormat, format.name, FORMAT_DETAILS.NAME_CHARS,
                wide);
        }
    };

    /**
     * acmFormatEnum: the formats of one driver, or of every driver when none
     * is named, that the filter flags let through, each to the program's
     * callback with the details filled.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const formatEnum = ([handle, details, callback, instance, flags], wide)=>{
        if ((details >>> 0) === 0 || (callback >>> 0) === 0
            || u32(details + FORMAT_DETAILS.cbStruct) < FORMAT_DETAILS.szFormat
            || u32(details + FORMAT_DETAILS.pwfx) === 0)
        {
            return MMSYSERR_INVALPARAM;
        }
        const drivers = (handle >>> 0) === 0 ? allDrivers() : [driverOf(handle)];
        if (drivers.some(driver=>!driver))
        {
            return MMSYSERR_INVALHANDLE;
        }
        const wanted = readFormat(u32(details + FORMAT_DETAILS.pwfx));
        /** @param {ListedFormat} format */
        const passes = format=>!wanted
            || (((flags & ACM_FORMATENUMF_WFORMATTAG) === 0 || format.tag === wanted.tag)
                && ((flags & ACM_FORMATENUMF_NCHANNELS) === 0
                    || format.channels === wanted.channels)
                && ((flags & ACM_FORMATENUMF_NSAMPLESPERSEC) === 0 || format.rate === wanted.rate)
                && ((flags & ACM_FORMATENUMF_WBITSPERSAMPLE) === 0 || format.bits === wanted.bits));
        const run = host.callGuest;
        if (!run)
        {
            return MMSYSERR_NOERROR;
        }
        const thread = host.currentThread?.();
        return (async()=>{
            for (const driver of /** @type {ReturnType<typeof allDrivers>} */ (drivers))
            {
                for (const tag of tagsOf(driver))
                {
                    for (const [index, format] of tag.formats.entries())
                    {
                        if (!passes(format))
                        {
                            continue;
                        }
                        fillFormatDetails(details, format, index, driver.support, wide);
                        const more = await run(callback >>> 0,
                            [driver.id, details >>> 0, instance >>> 0, driver.support], thread);
                        if ((more | 0) === 0)
                        {
                            return MMSYSERR_NOERROR;
                        }
                    }
                }
            }
            return MMSYSERR_NOERROR;
        })();
    };

    /**
     * acmFormatTagDetails: a driver's tag by index, by tag, or the tag whose
     * format is largest.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const formatTagDetails = ([handle, details, flags], wide)=>{
        if ((details >>> 0) === 0 || u32(details + TAG_DETAILS.cbStruct) < TAG_DETAILS.szFormatTag)
        {
            return MMSYSERR_INVALPARAM;
        }
        const tags = ((handle >>> 0) === 0 ? allDrivers() : [driverOf(handle)])
            .flatMap(driver=>(driver ? tagsOf(driver).map(tag=>({ ...tag, driver })) : []));
        const query = flags & 0xf;
        let found;
        if (query === ACM_FORMATTAGDETAILSF_INDEX)
        {
            found = tags[u32(details + TAG_DETAILS.dwFormatTagIndex)];
        }
        else if (query === ACM_FORMATTAGDETAILSF_FORMATTAG)
        {
            found = tags.find(tag=>tag.tag === u32(details + TAG_DETAILS.dwFormatTag));
        }
        else if (query === ACM_FORMATTAGDETAILSF_LARGESTSIZE)
        {
            const asked = u32(details + TAG_DETAILS.dwFormatTag);
            found = tags.filter(tag=>asked === 0 || tag.tag === asked).sort(
                (a, b)=>b.formats[0].bytes.length - a.formats[0].bytes.length)[0];
        }
        else
        {
            return MMSYSERR_INVALFLAG;
        }
        if (!found)
        {
            return ACMERR_NOTPOSSIBLE;
        }
        put32(details + TAG_DETAILS.dwFormatTagIndex, tagsOf(found.driver)
            .findIndex(tag=>tag.tag === found.tag));
        put32(details + TAG_DETAILS.dwFormatTag, found.tag);
        put32(details + TAG_DETAILS.cbFormatSize, found.formats[0].bytes.length);
        put32(details + TAG_DETAILS.fdwSupport, found.driver.support);
        put32(details + TAG_DETAILS.cStandardFormats, found.formats.length);
        if (u32(details + TAG_DETAILS.cbStruct) > TAG_DETAILS.szFormatTag)
        {
            writeName(details + TAG_DETAILS.szFormatTag, found.name, TAG_DETAILS.NAME_CHARS, wide);
        }
        return MMSYSERR_NOERROR;
    };

    /**
     * acmFormatDetails: a driver's format of a tag by index, or the name of
     * the format the caller holds.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const formatDetails = ([handle, details, flags], wide)=>{
        if ((details >>> 0) === 0
            || u32(details + FORMAT_DETAILS.cbStruct) < FORMAT_DETAILS.szFormat
            || u32(details + FORMAT_DETAILS.pwfx) === 0)
        {
            return MMSYSERR_INVALPARAM;
        }
        const tag = u32(details + FORMAT_DETAILS.dwFormatTag);
        const listed = ((handle >>> 0) === 0 ? allDrivers() : [driverOf(handle)])
            .flatMap(driver=>(driver ? tagsOf(driver) : []))
            .find(entry=>entry.tag === tag);
        if (!listed)
        {
            return ACMERR_NOTPOSSIBLE;
        }
        if ((flags & 0xf) === ACM_FORMATDETAILSF_INDEX)
        {
            const index = u32(details + FORMAT_DETAILS.dwFormatIndex);
            const format = listed.formats[index];
            if (!format)
            {
                return MMSYSERR_INVALPARAM;
            }
            fillFormatDetails(details, format, index, ACMDRIVERDETAILS_SUPPORTF_CODEC, wide);
            return MMSYSERR_NOERROR;
        }
        if ((flags & 0xf) === ACM_FORMATDETAILSF_FORMAT)
        {
            const held = readFormat(u32(details + FORMAT_DETAILS.pwfx));
            const format = listed.formats.find(candidate=>held
                && candidate.channels === held.channels
                && candidate.rate === held.rate && candidate.bits === held.bits);
            writeName(details + FORMAT_DETAILS.szFormat, format?.name ?? '',
                FORMAT_DETAILS.NAME_CHARS, wide);
            return format ? MMSYSERR_NOERROR : ACMERR_NOTPOSSIBLE;
        }
        return MMSYSERR_INVALFLAG;
    };

    /** An entry point answering `result`. @param {number} argCount @param {number} result */
    const answers = (argCount, result)=>({ argBytes: argCount * 4, handler: ()=>result });

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */
    const functions = {
        /** DWORD acmGetVersion(void) */
        acmGetVersion: answers(0, ACM_VERSION),

        /** MMRESULT acmMetrics(HACMOBJ hao, UINT uMetric, LPVOID pMetric) */
        acmMetrics: {
            argBytes: 12,
            handler: ([object, metric, out])=>{
                if ((out >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const drivers = allDrivers();
                const codecs = drivers.filter(
                    driver=>driver.support & ACMDRIVERDETAILS_SUPPORTF_CODEC);
                /** @type {Record<number, number>} */
                const counts = {
                    [METRIC.COUNT_DRIVERS]: drivers.length,
                    [METRIC.COUNT_CODECS]: codecs.length,
                    [METRIC.COUNT_CONVERTERS]: drivers.length - codecs.length,
                    [METRIC.COUNT_FILTERS]: 0,
                    [METRIC.COUNT_DISABLED]: 0,
                    [METRIC.COUNT_HARDWARE]: 0,
                    [METRIC.COUNT_LOCAL_DRIVERS]: 0,
                    [METRIC.COUNT_LOCAL_CODECS]: 0,
                    [METRIC.COUNT_LOCAL_CONVERTERS]: 0,
                    [METRIC.COUNT_LOCAL_FILTERS]: 0,
                    [METRIC.COUNT_LOCAL_DISABLED]: 0,
                    // An ADPCM format with the seven standard pairs after it.
                    [METRIC.MAX_SIZE_FORMAT]: WAVEFORMATEX.aCoef + 7 * 4,
                    [METRIC.MAX_SIZE_FILTER]: 0,
                };
                if (metric === METRIC.DRIVER_SUPPORT || metric === METRIC.DRIVER_PRIORITY)
                {
                    const driver = driverOf(object);
                    if (!driver)
                    {
                        return MMSYSERR_INVALHANDLE;
                    }
                    put32(out, metric === METRIC.DRIVER_SUPPORT
                        ? driver.support : drivers.findIndex(one=>one.id === driver.id) + 1);
                    return MMSYSERR_NOERROR;
                }
                if (counts[metric] === undefined)
                {
                    return MMSYSERR_NOTSUPPORTED;
                }
                put32(out, counts[metric]);
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT acmDriverEnum(ACMDRIVERENUMCB fnCallback, DWORD_PTR dwInstance,
         *     DWORD fdwEnum)
         *
         * Each driver's id and support flags to the program's callback, which
         * is guest code, until it answers FALSE.
         */
        acmDriverEnum: {
            argBytes: 12,
            handler: ([callback, instance])=>{
                if ((callback >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const run = host.callGuest;
                if (!run)
                {
                    return MMSYSERR_NOERROR;
                }
                const thread = host.currentThread?.();
                return (async()=>{
                    for (const driver of allDrivers())
                    {
                        const more = await run(callback >>> 0,
                            [driver.id, instance >>> 0, driver.support], thread);
                        if ((more | 0) === 0)
                        {
                            break;
                        }
                    }
                    return MMSYSERR_NOERROR;
                })();
            },
        },
        /** MMRESULT acmDriverOpen(LPHACMDRIVER phad, HACMDRIVERID hadid, DWORD fdwOpen) */
        acmDriverOpen: {
            argBytes: 12,
            handler: ([out, id, flags])=>{
                if ((out >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                if ((flags >>> 0) !== 0)
                {
                    return MMSYSERR_INVALFLAG;
                }
                const driver = allDrivers().find(candidate=>candidate.id === (id >>> 0));
                if (!driver)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                const handle = nextDriver++;
                opened.set(handle, driver);
                put32(out, handle);
                return MMSYSERR_NOERROR;
            },
        },
        /** MMRESULT acmDriverClose(HACMDRIVER had, DWORD fdwClose) */
        acmDriverClose: {
            argBytes: 8,
            handler: ([handle])=>(opened.delete(handle >>> 0)
                ? MMSYSERR_NOERROR : MMSYSERR_INVALHANDLE),
        },
        /** MMRESULT acmDriverID(HACMOBJ hao, LPHACMDRIVERID phadid, DWORD fdwDriverID) */
        acmDriverID: {
            argBytes: 12,
            handler: ([object, out])=>{
                const driver = driverOf(object);
                if (!driver)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if ((out >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                put32(out, driver.id);
                return MMSYSERR_NOERROR;
            },
        },
        acmDriverMessage: answers(4, MMSYSERR_NOTSUPPORTED),
        acmDriverPriority: answers(3, MMSYSERR_NOTSUPPORTED),
        acmDriverRemove: answers(2, MMSYSERR_NOTSUPPORTED),

        /**
         * MMRESULT acmFormatSuggest(HACMDRIVER had, LPWAVEFORMATEX pwfxSrc,
         *     LPWAVEFORMATEX pwfxDst, DWORD cbwfxDst, DWORD fdwSuggest)
         *
         * What a driver here would turn the source into: 16-bit PCM of its
         * rate and channels for ADPCM, the same PCM for PCM -- with whatever of
         * the destination the flags say the caller has fixed.
         */
        acmFormatSuggest: {
            argBytes: 20,
            handler: ([, source, destination, room, flags])=>{
                const from = readFormat(source);
                if (!from || (destination >>> 0) === 0 || room < 16)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const fixed = (destination >>> 0) !== 0 ? readFormat(destination) : null;
                const tag = (flags & ACM_FORMATSUGGESTF_WFORMATTAG) && fixed
                    ? fixed.tag : WAVE_FORMAT_PCM;
                if (tag !== WAVE_FORMAT_PCM)
                {
                    return ACMERR_NOTPOSSIBLE;
                }
                const pcm = {
                    channels: (flags & ACM_FORMATSUGGESTF_NCHANNELS) && fixed
                        ? fixed.channels : from.channels,
                    rate: (flags & ACM_FORMATSUGGESTF_NSAMPLESPERSEC) && fixed
                        ? fixed.rate : from.rate,
                    bits: (flags & ACM_FORMATSUGGESTF_WBITSPERSAMPLE) && fixed
                        ? fixed.bits : from.tag === WAVE_FORMAT_PCM ? from.bits : 16,
                };
                if (!convertible(from, { ...pcm, tag, blockAlign: 0, samplesPerBlock: 0,
                    coefficients: [] }))
                {
                    return ACMERR_NOTPOSSIBLE;
                }
                writePcmFormat(destination, room, pcm);
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT acmStreamOpen(LPHACMSTREAM phas, HACMDRIVER had, LPWAVEFORMATEX pwfxSrc,
         *     LPWAVEFORMATEX pwfxDst, LPWAVEFILTER pwfltr, DWORD_PTR dwCallback,
         *     DWORD_PTR dwInstance, DWORD fdwOpen)
         */
        acmStreamOpen: {
            argBytes: 32,
            handler: ([out, , source, destination, filter, , , flags])=>{
                const from = readFormat(source);
                const to = readFormat(destination);
                if (!from || !to || (filter >>> 0) !== 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                if (!convertible(from, to))
                {
                    host.divergence?.('acmStreamOpen', `no driver here converts ${describe(from)}`
                        + ` to ${describe(to)}`);
                    return ACMERR_NOTPOSSIBLE;
                }
                if ((flags & ACM_STREAMOPENF_QUERY) !== 0)
                {
                    return MMSYSERR_NOERROR;
                }
                if ((out >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const handle = nextStream++;
                streams.set(handle, { from, to, carry: { position: 0, previous: [0, 0] },
                    codec: codecFor(from.tag)?.open(from, to) });
                put32(out, handle);
                return MMSYSERR_NOERROR;
            },
        },
        /** MMRESULT acmStreamClose(HACMSTREAM has, DWORD fdwClose) */
        acmStreamClose: {
            argBytes: 8,
            handler: ([handle])=>(streams.delete(handle >>> 0)
                ? MMSYSERR_NOERROR : MMSYSERR_INVALHANDLE),
        },
        /**
         * MMRESULT acmStreamSize(HACMSTREAM has, DWORD cbInput, LPDWORD pdwOutputBytes,
         *     DWORD fdwSize)
         *
         * From the source, what it converts to; from the destination, the
         * source that fills it. ADPCM goes in whole blocks.
         */
        acmStreamSize: {
            argBytes: 16,
            handler: ([handle, input, out, flags])=>{
                const stream = streams.get(handle >>> 0);
                if (!stream)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if ((out >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const { from, to } = stream;
                const toDestination = (flags & ACM_STREAMSIZEF_DESTINATION) === 0;
                let size;
                if (stream.codec)
                {
                    size = stream.codec.size(input >>> 0, toDestination);
                }
                else if (from.tag === WAVE_FORMAT_PCM)
                {
                    const inFrame = from.channels * (from.bits / 8);
                    const outFrame = to.channels * (to.bits / 8);
                    size = toDestination
                        ? Math.floor(Math.floor(input / inFrame) * to.rate / from.rate) * outFrame
                        : Math.ceil(Math.ceil(input / outFrame) * from.rate / to.rate) * inFrame;
                }
                else
                {
                    size = toDestination ? Math.floor(input / from.blockAlign) * blockOutput(from)
                        : Math.ceil(input / blockOutput(from)) * from.blockAlign;
                }
                put32(out, size);
                return MMSYSERR_NOERROR;
            },
        },
        /** MMRESULT acmStreamPrepareHeader(HACMSTREAM has, LPACMSTREAMHEADER pash, DWORD) */
        acmStreamPrepareHeader: {
            argBytes: 12,
            handler: ([handle, header])=>{
                if (!streams.has(handle >>> 0))
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if ((header >>> 0) === 0 || u32(header + HEADER.cbStruct) < HEADER.SIZE)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const status = u32(header + HEADER.fdwStatus);
                put32(header + HEADER.fdwStatus, (status | ACMSTREAMHEADER_STATUSF_PREPARED)
                    & ~(ACMSTREAMHEADER_STATUSF_DONE | ACMSTREAMHEADER_STATUSF_INQUEUE));
                return MMSYSERR_NOERROR;
            },
        },
        /** MMRESULT acmStreamUnprepareHeader(HACMSTREAM has, LPACMSTREAMHEADER pash, DWORD) */
        acmStreamUnprepareHeader: {
            argBytes: 12,
            handler: ([handle, header])=>{
                if (!streams.has(handle >>> 0))
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if ((header >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const status = u32(header + HEADER.fdwStatus);
                if ((status & ACMSTREAMHEADER_STATUSF_PREPARED) === 0)
                {
                    return ACMERR_UNPREPARED;
                }
                put32(header + HEADER.fdwStatus, status & ~ACMSTREAMHEADER_STATUSF_PREPARED);
                return MMSYSERR_NOERROR;
            },
        },
        /**
         * MMRESULT acmStreamConvert(HACMSTREAM has, LPACMSTREAMHEADER pash, DWORD fdwConvert)
         *
         * As much of the source as fits the destination, ADPCM in whole
         * blocks, done in the call: the header says how much of each was used.
         */
        acmStreamConvert: {
            argBytes: 12,
            handler: ([handle, header])=>{
                const stream = streams.get(handle >>> 0);
                if (!stream)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if ((header >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const status = u32(header + HEADER.fdwStatus);
                if ((status & ACMSTREAMHEADER_STATUSF_PREPARED) === 0)
                {
                    return ACMERR_UNPREPARED;
                }
                const { from, to } = stream;
                const sourceAt = u32(header + HEADER.pbSrc);
                const sourceLength = u32(header + HEADER.cbSrcLength);
                const destinationAt = u32(header + HEADER.pbDst);
                const destinationLength = u32(header + HEADER.cbDstLength);
                let used;
                /** @type {Uint8Array} */
                let output;
                if (stream.codec)
                {
                    const converted = stream.codec.convert(
                        readMemory(sourceAt, sourceLength).slice(), destinationLength);
                    used = converted.consumed;
                    output = converted.output;
                }
                else if (from.tag === WAVE_FORMAT_PCM)
                {
                    const inFrame = from.channels * (from.bits / 8);
                    const outFrame = to.channels * (to.bits / 8);
                    const frames = Math.floor(sourceLength / inFrame);
                    const converted = convertPcm(readMemory(sourceAt, frames * inFrame).slice(),
                        from, to, frames, Math.floor(destinationLength / outFrame),
                        stream.carry);
                    used = converted.consumed * inFrame;
                    output = converted.output;
                }
                else
                {
                    const blocks = Math.min(Math.floor(sourceLength / from.blockAlign),
                        Math.floor(destinationLength / blockOutput(from)));
                    used = blocks * from.blockAlign;
                    const samples = new Int16Array(blocks * from.samplesPerBlock * from.channels);
                    const source = readMemory(sourceAt, used).slice();
                    for (let block = 0; block < blocks; block++)
                    {
                        const bytes = source.subarray(block * from.blockAlign,
                            (block + 1) * from.blockAlign);
                        const into = samples.subarray(block * from.samplesPerBlock * from.channels,
                            (block + 1) * from.samplesPerBlock * from.channels);
                        if (from.tag === WAVE_FORMAT_IMA_ADPCM)
                        {
                            decodeImaBlock(bytes, from.channels, from.samplesPerBlock, into);
                        }
                        else
                        {
                            decodeMsBlock(bytes, from.channels, from.samplesPerBlock,
                                from.coefficients, into);
                        }
                    }
                    output = new Uint8Array(samples.buffer);
                }
                if (output.length > 0)
                {
                    writeMemory(destinationAt, output);
                }
                put32(header + HEADER.cbSrcLengthUsed, used);
                put32(header + HEADER.cbDstLengthUsed, output.length);
                put32(header + HEADER.fdwStatus, (status | ACMSTREAMHEADER_STATUSF_DONE)
                    & ~ACMSTREAMHEADER_STATUSF_INQUEUE);
                return MMSYSERR_NOERROR;
            },
        },
        acmStreamMessage: answers(4, MMSYSERR_NOTSUPPORTED),
        /** MMRESULT acmStreamReset(HACMSTREAM has, DWORD fdwReset): nothing is ever pending. */
        acmStreamReset: {
            argBytes: 8,
            handler: ([handle])=>(streams.has(handle >>> 0)
                ? MMSYSERR_NOERROR : MMSYSERR_INVALHANDLE),
        },
        acmDriverDetailsA: { argBytes: 12, handler: args=>driverDetails(args, false) },
        acmDriverDetailsW: { argBytes: 12, handler: args=>driverDetails(args, true) },
        acmFormatEnumA: { argBytes: 20, handler: args=>formatEnum(args, false) },
        acmFormatEnumW: { argBytes: 20, handler: args=>formatEnum(args, true) },
        acmFormatTagDetailsA: { argBytes: 12, handler: args=>formatTagDetails(args, false) },
        acmFormatTagDetailsW: { argBytes: 12, handler: args=>formatTagDetails(args, true) },
        acmFormatDetailsA: { argBytes: 12, handler: args=>formatDetails(args, false) },
        acmFormatDetailsW: { argBytes: 12, handler: args=>formatDetails(args, true) },
    };
    for (const [base, argCount] of /** @type {[string, number][]} */ ([
        ['acmDriverAdd', 5], ['acmFormatChoose', 1], ['acmFormatTagEnum', 5],
        ['acmFilterChoose', 1], ['acmFilterDetails', 3], ['acmFilterEnum', 5],
        ['acmFilterTagDetails', 3], ['acmFilterTagEnum', 5],
    ]))
    {
        functions[`${base}A`] = answers(argCount, MMSYSERR_NOTSUPPORTED);
        functions[`${base}W`] = answers(argCount, MMSYSERR_NOTSUPPORTED);
    }
    return functions;
}
