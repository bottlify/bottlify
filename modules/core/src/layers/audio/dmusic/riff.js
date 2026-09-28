/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The RIFF shapes DirectMusic keeps its objects in.
 *
 * A segment (`.sgt`) is a RIFF file whose form is `DMSG`: a segment header, a
 * list of tracks, and inside one track the wave items. A wave is a RIFF
 * `WAVE` with a format and a data chunk. Both are read here and nothing here
 * knows about COM, guest memory or playback -- it takes bytes and answers a
 * description, which is what makes the hard part (the structures) testable on
 * their own.
 *
 * DirectMusic wrote these files with more than one SDK release, and the
 * header chunks grew fields between them: a `segh` is 48, 56 or 64 bytes
 * depending on the version that authored it, with every field this engine
 * needs in the part that never moved. Reading past the end of a chunk into
 * the next one would take a neighbouring chunk's bytes for a time, so every
 * read is bounded by the chunk's own size and a field the file did not carry
 * is zero.
 */

/** A four-character code as text, so a chunk reads as what a person calls it. */
const FOURCC = new TextDecoder('latin1');

/**
 * @typedef {Object} Chunk
 * @property {string} id      The four-character code.
 * @property {Uint8Array} data  The chunk's body; for RIFF/LIST, after the form.
 * @property {string} form    The form/list type of a RIFF/LIST chunk, else ''.
 * @property {Chunk[]} children  The chunks inside a RIFF/LIST, else [].
 */

/**
 * Reads the chunks in `[from, to)`, each bounded by its own declared size.
 *
 * A chunk whose size runs past the end is clamped rather than followed: a
 * truncated file is a file that failed to load, not one that walks off into
 * whatever memory follows it.
 *
 * @param {Uint8Array} bytes
 * @param {number} [from]
 * @param {number} [to]
 * @returns {Chunk[]}
 */
export function readChunks(bytes, from = 0, to = bytes.length){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const at = (/** @type {number} */ offset)=>offset + 4 <= to
        ? FOURCC.decode(bytes.subarray(offset, offset + 4))
        : '';
    /** @type {Chunk[]} */
    const chunks = [];
    let offset = from;
    while (offset + 8 <= to)
    {
        const id = at(offset);
        const size = view.getUint32(offset + 4, true);
        const bodyStart = offset + 8;
        const bodyEnd = Math.min(bodyStart + size, to);
        const body = bytes.subarray(bodyStart, bodyEnd);
        if (id === 'RIFF' || id === 'LIST')
        {
            const form = body.length >= 4 ? FOURCC.decode(body.subarray(0, 4)) : '';
            chunks.push({
                id,
                form,
                data: body,
                children: readChunks(bytes, bodyStart + 4, bodyEnd),
            });
        }
        else
        {
            chunks.push({ id, form: '', data: body, children: [] });
        }
        // RIFF chunks are two-byte aligned; an odd size is followed by a pad.
        offset = bodyStart + size + (size & 1);
    }
    return chunks;
}

/**
 * The first chunk with this id, or null.
 *
 * @param {Chunk[]} chunks @param {string} id
 * @returns {Chunk | null}
 */
export function chunkOf(chunks, id){
    return chunks.find(chunk=>chunk.id === id) ?? null;
}

/**
 * The first RIFF/LIST whose form is this, or null.
 *
 * @param {Chunk[]} chunks @param {string} form
 * @returns {Chunk | null}
 */
export function listOf(chunks, form){
    return chunks.find(chunk=>(chunk.id === 'RIFF' || chunk.id === 'LIST') && chunk.form === form)
        ?? null;
}

/** @param {Chunk | null} chunk @param {number} offset @returns {number} */
function dword(chunk, offset){
    if (!chunk || offset + 4 > chunk.data.length)
    {
        return 0;
    }
    return new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
        .getUint32(offset, true);
}

/**
 * A 64-bit field the way Windows lays one out: two little-endian dwords.
 *
 * The pair is read as unsigned and returned as a Number, which is exact to
 * 2^53 -- about three thousand years of 100-nanosecond units, so the fields
 * this parses stay well inside it.
 *
 * @param {Chunk | null} chunk @param {number} offset
 * @returns {number}
 */
function qword(chunk, offset){
    if (!chunk || offset + 8 > chunk.data.length)
    {
        return 0;
    }
    const view = new DataView(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;
}

/**
 * A wide string out of a chunk, up to its first terminator.
 *
 * @param {Chunk | null} chunk
 * @returns {string}
 */
export function wideString(chunk){
    if (!chunk)
    {
        return '';
    }
    const units = new Uint16Array(chunk.data.buffer, chunk.data.byteOffset,
        Math.floor(chunk.data.byteLength / 2));
    let end = units.indexOf(0);
    if (end === -1)
    {
        end = units.length;
    }
    return String.fromCharCode(...units.subarray(0, end));
}

/**
 * @typedef {Object} SegmentHeader
 * @property {number} repeats   0 plays once, `0xffffffff` loops for ever.
 * @property {number} length    Length in music time (PPQ ticks), 0 if absent.
 * @property {number} playStart
 * @property {number} loopStart
 * @property {number} loopEnd
 * @property {number} resolution
 * @property {number} refLength   Length in 100-nanosecond units, 0 if absent.
 */

/**
 * @typedef {Object} WaveItem
 * @property {number} volume     Attenuation in hundredths of a decibel, 0 = full.
 * @property {number} pitch
 * @property {number} start      Start, in music time (PPQ ticks) from segment start.
 * @property {number} startOffset  Where in the wave to begin, music time.
 * @property {number} duration   How long to play, music time; 0 = to the end.
 * @property {number} flags
 * @property {string} file       The wave file this item names, as the segment wrote it.
 */

/**
 * @typedef {Object} Tempo
 * @property {number} time   Music time the tempo takes effect.
 * @property {number} tempo  Beats per minute.
 */

/**
 * @typedef {Object} Segment
 * @property {SegmentHeader} header
 * @property {WaveItem[]} waves
 * @property {Tempo[]} tempo   Tempo changes from the `tetr` track, in time order.
 * @property {number} trackCount
 */

/**
 * The tick count DirectMusic divides a beat into, which every segment in the
 * wild was authored against and the only value a wave item's times mean
 * anything against.
 */
export const PPQ = 768;

/** A tempo a segment plays at until its own tempo track says otherwise. */
const DEFAULT_TEMPO = 120;

/**
 * A tempo track's items.
 *
 * The chunk's items are twenty bytes: a music time, a reserved dword pair and
 * a double. The dword pair is not read -- nothing here uses it, and reading it
 * as part of the double is exactly the field-alignment mistake that turns a
 * tempo of 100 into a subnormal.
 *
 * @param {Uint8Array} bytes
 * @returns {Tempo[]}
 */
export function parseTempo(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tempos = [];
    for (let at = 0; at + 20 <= bytes.length; at += 20)
    {
        tempos.push({ time: view.getInt32(at, true), tempo: view.getFloat64(at + 12, true) });
    }
    return tempos;
}

/**
 * Music time to milliseconds, through a segment's tempo map.
 *
 * A beat is PPQ ticks and the tempo says how many beats a minute; between two
 * tempo changes the rate is constant, so the piece is integrated one span at a
 * time rather than with a single tempo, which would put the end of a piece
 * that slows down or speeds up at the wrong moment.
 *
 * @param {Tempo[]} tempos @param {number} ticks
 * @returns {number}
 */
export function musicToMs(tempos, ticks){
    let tempo = DEFAULT_TEMPO;
    let last = 0;
    let ms = 0;
    const ordered = [...tempos].sort((a, b)=>a.time - b.time);
    for (const change of ordered)
    {
        if (change.time <= 0 || change.tempo <= 0)
        {
            tempo = change.tempo > 0 ? change.tempo : tempo;
            continue;
        }
        if (change.time >= ticks)
        {
            break;
        }
        ms += (change.time - last) * (60000 / (PPQ * tempo));
        last = change.time;
        tempo = change.tempo;
    }
    return ms + (ticks - last) * (60000 / (PPQ * tempo));
}

/** @param {Uint8Array} bytes */
export function isRiff(bytes){
    return bytes.length >= 12
        && FOURCC.decode(bytes.subarray(0, 4)) === 'RIFF';
}

/**
 * A DirectMusic segment: its header and the wave items of its wave tracks.
 *
 * A segment may carry many kinds of track -- tempo, time signature, sequence,
 * wave -- and only the wave track produces sound through this engine, so only
 * those items are collected. The track count is kept because a program that
 * reads a segment and is told it has no tracks concludes the file is empty.
 *
 * @param {Uint8Array} bytes
 * @returns {Segment}
 */
export function parseSegment(bytes){
    const root = chunkOf(readChunks(bytes), 'RIFF');
    const header = chunkOf(root?.children ?? [], 'segh');
    const waves = [];
    /** @type {Tempo[]} */
    const tempo = [];
    let trackCount = 0;

    const trackList = listOf(root?.children ?? [], 'trkl');
    for (const track of trackList?.children ?? [])
    {
        const trackChunks = track.id === 'RIFF' ? track.children : [];
        if (!chunkOf(trackChunks, 'trkh'))
        {
            continue;
        }
        trackCount++;
        const tempoChunk = chunkOf(trackChunks, 'tetr');
        if (tempoChunk)
        {
            tempo.push(...parseTempo(tempoChunk.data));
        }
        const waveList = listOf(trackChunks, 'wavt');
        if (!waveList)
        {
            continue;
        }
        for (const part of waveList.children)
        {
            if (part.form !== 'wavp')
            {
                continue;
            }
            for (const itemList of part.children)
            {
                if (itemList.form !== 'wavi')
                {
                    continue;
                }
                for (const wave of itemList.children)
                {
                    if (wave.form !== 'wave')
                    {
                        continue;
                    }
                    const info = chunkOf(wave.children, 'waih');
                    const reference = listOf(wave.children, 'DMRF');
                    waves.push({
                        volume: dword(info, 0) | 0,
                        pitch: dword(info, 4) | 0,
                        // The authored files carry music time here even though
                        // the runtime header names these fields reference
                        // times; a value like 6144 is sixteen beats at the
                        // default resolution, not the six hundred
                        // microseconds a REFERENCE_TIME would make of it.
                        start: qword(info, 16),
                        startOffset: qword(info, 24),
                        duration: qword(info, 40),
                        flags: dword(info, 60),
                        file: wideString(chunkOf(reference?.children ?? [], 'file')),
                    });
                }
            }
        }
    }

    return {
        header: {
            repeats: dword(header, 0),
            length: dword(header, 4) | 0,
            playStart: dword(header, 8) | 0,
            loopStart: dword(header, 12) | 0,
            loopEnd: dword(header, 16) | 0,
            resolution: dword(header, 20),
            refLength: qword(header, 24),
        },
        waves,
        tempo,
        trackCount,
    };
}

/**
 * @typedef {Object} WaveFile
 * @property {string} format     'pcm' or 'other'.
 * @property {number} formatTag  The WAVE format tag, which names the codec.
 * @property {number} channels
 * @property {number} sampleRate
 * @property {number} bitsPerSample
 * @property {number} blockAlign
 * @property {Uint8Array} data   The samples, or the compressed stream.
 */

/**
 * A `WAVE` file's format and samples.
 *
 * Only uncompressed PCM is answered as `pcm`. Anything else -- an ADPCM or
 * MPEG-encoded wave, which an authoring tool can leave in a segment -- is
 * described but its samples are not offered, because handing a program's
 * decoder compressed bytes as if they were samples is noise, not silence.
 *
 * @param {Uint8Array} bytes
 * @returns {WaveFile | null}
 */
export function parseWave(bytes){
    const root = chunkOf(readChunks(bytes), 'RIFF');
    if (!root || root.form !== 'WAVE')
    {
        return null;
    }
    const fmt = chunkOf(root.children, 'fmt ');
    const data = chunkOf(root.children, 'data');
    if (!fmt || !data)
    {
        return null;
    }
    const view = new DataView(fmt.data.buffer, fmt.data.byteOffset, fmt.data.byteLength);
    const tag = fmt.data.length >= 2 ? view.getUint16(0, true) : 0;
    const channels = fmt.data.length >= 4 ? view.getUint16(2, true) : 0;
    const sampleRate = fmt.data.length >= 8 ? view.getUint32(4, true) : 0;
    const blockAlign = fmt.data.length >= 14 ? view.getUint16(12, true) : 0;
    const bitsPerSample = fmt.data.length >= 16 ? view.getUint16(14, true) : 0;
    return {
        format: tag === 1 ? 'pcm' : 'other',
        formatTag: tag,
        channels,
        sampleRate,
        bitsPerSample,
        blockAlign,
        data: data.data,
    };
}
