/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Segment and wave bytes for the tests beside this file, built to the same
 * chunk layout the tools wrote: enough of a `DMSG` to exercise the reader,
 * without a game's own bytes in the repository.
 */

/** @param {string} text @returns {Uint8Array} */
export function ascii(text){
    return new Uint8Array([...text].map(character=>character.charCodeAt(0)));
}

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
export function concat(parts){
    const total = parts.reduce((sum, part)=>sum + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * A RIFF chunk with its size filled in from its body, two-byte padded as the
 * format requires.
 *
 * @param {string} id @param {Uint8Array[]} parts
 * @returns {Uint8Array}
 */
export function chunk(id, ...parts){
    const body = concat(parts);
    const bytes = new Uint8Array(8 + body.length + (body.length & 1));
    bytes.set(ascii(id), 0);
    new DataView(bytes.buffer).setUint32(4, body.length, true);
    bytes.set(body, 8);
    return bytes;
}

/** @param {number} value @returns {Uint8Array} */
export function u32(value){
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
}

/** @param {number} value @returns {Uint8Array} */
export function u64(value){
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, value >>> 0, true);
    view.setUint32(4, Math.floor(value / 0x100000000) >>> 0, true);
    return bytes;
}

/** @param {number} value @returns {Uint8Array} */
export function i32(value){
    return u32(value | 0);
}

/** @param {string} text @returns {Uint8Array} */
export function wide(text){
    const bytes = new Uint8Array(text.length * 2 + 2);
    const view = new DataView(bytes.buffer);
    for (let at = 0; at < text.length; at++)
    {
        view.setUint16(at * 2, text.charCodeAt(at), true);
    }
    return bytes;
}

/**
 * @typedef {Object} WaveItemFixture
 * @property {number} [volume]
 * @property {number} [pitch]
 * @property {number} [variations]
 * @property {number} [time]
 * @property {number} [startOffset]
 * @property {number} [duration]
 * @property {number} [flags]
 * @property {string} [file]
 */

/**
 * @typedef {Object} SegmentHeaderFixture
 * @property {number} [repeats]
 * @property {number} [length]
 * @property {number} [playStart]
 * @property {number} [refLength]
 * @property {{ time: number, tempo: number }} [tempo]
 */

/**
 * A `waih` as the authoring tools wrote it: reference-time-named fields that
 * actually carry music time, padded to the header's eight-byte alignment.
 *
 * @param {WaveItemFixture} [item]
 * @returns {Uint8Array}
 */
export function waih(item = {}){
    const { volume = 0, pitch = 0, variations = 0xffffffff, time = 0,
        startOffset = 0, duration = 0, flags = 0 } = item;
    const bytes = new Uint8Array(72);
    const view = new DataView(bytes.buffer);
    view.setInt32(0, volume, true);
    view.setInt32(4, pitch, true);
    view.setUint32(8, variations >>> 0, true);
    view.setBigUint64(16, BigInt(time), true);
    view.setBigUint64(24, BigInt(startOffset), true);
    view.setBigUint64(40, BigInt(duration), true);
    view.setUint32(60, flags >>> 0, true);
    return bytes;
}

/**
 * A reference chunk naming a wave file, as `DMRF` carries one.
 *
 * @param {string} file
 * @returns {Uint8Array}
 */
export function dmrf(file){
    return chunk('LIST', ascii('DMRF'),
        chunk('refh', concat([new Uint8Array(16), u32(0x17)])),
        chunk('guid', new Uint8Array(16)),
        chunk('name', wide(file.replace(/\.wav$/i, ''))),
        chunk('file', wide(file)));
}

/**
 * A tempo item, twenty bytes as the tools wrote them.
 *
 * @param {number} time @param {number} tempo
 * @returns {Uint8Array}
 */
export function tempoItem(time, tempo){
    const bytes = new Uint8Array(20);
    new DataView(bytes.buffer).setInt32(0, time, true);
    new DataView(bytes.buffer).setFloat64(12, tempo, true);
    return bytes;
}

/**
 * A whole DMSG segment with one wave track carrying the given items.
 *
 * @param {WaveItemFixture[]} items @param {SegmentHeaderFixture} [header]
 * @returns {Uint8Array}
 */
export function dmsgSegment(items, header = {}){
    const itemsList = items.map(item=>
        chunk('LIST', ascii('wave'), chunk('waih', waih(item)), dmrf(item.file ?? '')));
    const waveList = chunk('LIST', ascii('wavt'),
        chunk('wath', concat([i32(0), u32(2)])),
        chunk('LIST', ascii('wavp'),
            chunk('waph', concat([i32(0), i32(-1), u32(2), u32(0), u32(1), u32(0)])),
            chunk('LIST', ascii('wavi'), ...itemsList)));
    const track = chunk('RIFF', ascii('DMTK'),
        chunk('trkh', new Uint8Array(32)),
        chunk('trkx', u64(0x10)),
        ...(header.tempo ? [chunk('tetr', tempoItem(header.tempo.time, header.tempo.tempo))] : []),
        waveList);
    const segh = new Uint8Array(56);
    const view = new DataView(segh.buffer);
    view.setUint32(0, header.repeats ?? 0, true);
    view.setInt32(4, header.length ?? 0, true);
    view.setInt32(8, header.playStart ?? 0, true);
    view.setBigUint64(24, BigInt(header.refLength ?? 0), true);
    return chunk('RIFF', ascii('DMSG'), chunk('segh', segh),
        chunk('LIST', ascii('trkl'), track));
}

/**
 * A `WAVE` file of 16-bit PCM.
 *
 * @param {Int16Array} samples @param {{ sampleRate?: number, channels?: number }} [format]
 * @returns {Uint8Array}
 */
export function wavFile(samples, { sampleRate = 44100, channels = 2 } = {}){
    const blockAlign = channels * 2;
    const fmt = concat([new Uint8Array([1, 0]), new Uint8Array([channels, 0]),
        u32(sampleRate), u32(sampleRate * blockAlign), new Uint8Array([blockAlign, 0, 16, 0])]);
    const data = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    return chunk('RIFF', ascii('WAVE'), chunk('fmt ', fmt), chunk('data', data));
}
