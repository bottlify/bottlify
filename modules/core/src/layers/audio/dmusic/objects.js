/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectMusic's objects: the loader, a segment, a play state, an audio path
 * and the performance that drives them.
 *
 * The engine answers the part of DirectMusic a game of this era actually
 * uses: loading a segment and playing its wave tracks. A segment whose music
 * is written as notes -- a MIDI port, a DLS instrument -- is a different
 * machine and is not built here; the methods that would reach it refuse with
 * E_NOTIMPL, which is an answer a program handles by taking another path.
 *
 * The pieces talk to each other through the context below, and to the outside
 * world through what the assembling caller hands in: guest memory, the mixer
 * the music plays through, a way to read a file, and a way to decode it. That
 * division is what makes a segment's parsing, its schedule and the loader's
 * search testable with no guest at all.
 */

import { createComObject } from '../../win32/ole32/objects.js';
import { readGuid, writeGuid, GUID_NULL } from '../../win32/ole32/guid.js';
import { parseSegment, parseWave, musicToMs, PPQ } from './riff.js';
import { createPlayer, volumeToGain } from './player.js';
import {
    WAVEFORMATEX, IID_IDirectSoundBuffer, IID_IDirectSoundBuffer8, IID_IKsPropertySet,
} from '../dsound/seam.js';
import * as ids from './ids.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_POINTER = 0x80004003 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_FAIL = 0x80004005 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const CLASS_E_NOAGGREGATION = 0x80040110 | 0;
/** No port of the class a program asked for (dmerror.h). */
const DMUS_E_DRIVER_FAILED = 0x88781101 | 0;

/** WAVE_FORMAT_MPEG and WAVE_FORMAT_MPEGLAYER3, the compressed wave tags. */
const WAVE_FORMAT_MPEG = 0x50;
const WAVE_FORMAT_MPEGLAYER3 = 0x55;

/** IStream's Read and Seek, and the two origins this uses. */
const SLOT_STREAM_READ = 3;
const SLOT_STREAM_SEEK = 5;
const STREAM_SEEK_SET = 0;
const STREAM_SEEK_END = 2;

/**
 * One vtable slot as a table declares it: its name, the bytes it pops
 * including the interface pointer, and the handler that answers it.
 *
 * @typedef {[string, number, ((object: any, args: number[]) => any)?]} ComMethodEntry
 */

/**
 * @typedef {Object} DmusicHost
 * @property {import('../../win32/ole32/objects.js').ComRegistry} registry
 * @property {{ readBytes: (address: number, length: number) => Uint8Array,
 *              writeBytes: (address: number, bytes: Uint8Array) => void }} memory
 * @property {(object: any, iid: string) => number} [publishInterface]
 * @property {(pointer: number) => any} [objectAt]  The bridge's pointer lookup.
 * @property {() => any} [output]        The mixer the music plays through.
 * @property {() => number} [now]        The guest's clock, in milliseconds.
 * @property {(bytes: number) => number} [allocate]  Guest memory.
 * @property {(address: number) => void} [free]      Gives it back.
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} [callGuest]
 * @property {() => any} [callerThread]
 * @property {(path: string) => Promise<Uint8Array | null>} [readFile]
 * @property {(bytes: Uint8Array, shape: { formatTag: number, sampleRate: number,
 *     channels: number }) => Promise<{ samples: Int16Array, sampleRate: number,
 *     channels: number } | null>} [decodeWave]
 * @property {(handle: number) => void} [signal]  Sets a guest event.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {number} value */
function u32(value){
    return new Uint8Array([value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
        value >>> 24 & 0xff]);
}

/**
 * @param {string} id
 * @param {ComMethodEntry[]} methods
 * @returns {import('../../win32/ole32/objects.js').ComInterfaceDescriptor}
 */
function describe(id, methods){
    return {
        id,
        methods: methods.map(([name, argBytes, invoke])=>({ name, argBytes, invoke })),
    };
}

/** @param {DmusicHost} host */
export function createDirectMusic(host){
    const memory = host.memory;
    /** @type {{ readMemory: (a: number, l: number) => Uint8Array,
     *           writeMemory: (a: number, b: Uint8Array) => void }} */
    const guidMemory = {
        readMemory: (a, l)=>memory.readBytes(a >>> 0, l),
        writeMemory: (a, b)=>memory.writeBytes(a >>> 0, b),
    };
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = memory.readBytes(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            memory.writeBytes(address >>> 0, u32(value));
        }
    };
    /** @param {number} address @param {number} value  A REFERENCE_TIME. */
    const writeU64 = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            memory.writeBytes(address >>> 0, u32(value % 0x100000000));
            memory.writeBytes((address >>> 0) + 4, u32(Math.floor(value / 0x100000000)));
        }
    };
    /** @param {number} address @param {number} maxChars */
    const readWide = (address, maxChars)=>{
        if ((address >>> 0) === 0)
        {
            return '';
        }
        let text = '';
        for (let at = 0; at < maxChars; at++)
        {
            const unit = memory.readBytes((address >>> 0) + at * 2, 2);
            const value = unit[0] | unit[1] << 8;
            if (value === 0)
            {
                break;
            }
            text += String.fromCharCode(value);
        }
        return text;
    };
    /** @param {number} address @param {string} text */
    const writeWide = (address, text)=>{
        if ((address >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        memory.writeBytes(address >>> 0, bytes);
    };
    /** @param {number} address @returns {string | null} */
    const guidAt = address=>(address >>> 0) === 0 ? null : readGuid(guidMemory, address >>> 0);

    const now = host.now ?? (()=>Date.now());
    const player = createPlayer({ now, output: ()=>host.output?.() ?? null });

    /**
     * Interface pointers this engine handed out, back to the object each one
     * names. A performance is handed a segment as a pointer and has to find
     * the object behind it; the bridge keeps the guest's map, this one is
     * ours.
     *
     * @type {Map<number, any>}
     */
    const objects = new Map();
    /** @param {any} object @param {string} iid @returns {number} */
    const publish = (object, iid)=>{
        const pointer = (host.publishInterface?.(object, iid) ?? 0) >>> 0;
        if (pointer !== 0 && !host.objectAt)
        {
            objects.set(pointer, object);
        }
        return pointer;
    };
    /** @param {number} pointer @returns {any} */
    const objectAt = pointer=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        // The bridge's map is the live one: a pointer released to zero is
        // handed out again for another object, and this module's own map
        // would go on naming the first. It is only the answer where there is
        // no bridge to ask.
        if (host.objectAt)
        {
            return host.objectAt(pointer) ?? null;
        }
        return objects.get(pointer >>> 0) ?? null;
    };
    /**
     * Whether a published object is a segment, rather than a wave or one of
     * the other DirectMusic objects. A segment's parsed state carries the
     * wave items a wave file does not, and that is what tells them apart
     * without either class having to name the other.
     *
     * @param {any} object
     */
    const isSegmentObject = object=>Array.isArray(object?.state?.parsed?.waves);

    /**
     * The implementation behind an interface pointer. A published COM object
     * carries the piece that knows how to play it as `dmusic`, so a method
     * handed a pointer resolves it to what it can actually ask.
     *
     * @param {number} pointer @returns {any}
     */
    const apiOf = pointer=>{
        const object = objectAt(pointer);
        if (!object)
        {
            return null;
        }
        if (object.dmusic)
        {
            return object.dmusic;
        }
        if (isSegmentObject(object))
        {
            return segmentApiFor(object);
        }
        // A DirectSoundWave a program loaded itself is playable through
        // PlaySegmentEx, so it answers the same calls a segment does.
        if (object.state && 'bytes' in object.state)
        {
            return waveApiFor(object);
        }
        return object;
    };

    /**
     * What a pointer handed to `PlaySegment` actually names, for a divergence
     * a program's refusal has to be understood from: a performance is given
     * the wrong interface often enough (a segment state, an audio path, a
     * pointer whose object this engine never published) that "not a segment"
     * alone does not say which.
     *
     * @param {number} pointer
     */
    const describeSource = pointer=>{
        const object = objectAt(pointer);
        if (!object)
        {
            return 'no object is behind the pointer';
        }
        if (isSegmentObject(object))
        {
            return 'a segment';
        }
        if (object.state && 'bytes' in object.state)
        {
            return 'a wave';
        }
        const api = object.dmusic;
        if (api && 'segment' in api && 'voice' in api)
        {
            return 'a segment state';
        }
        if (api && 'gain' in api)
        {
            return 'an audio path';
        }
        return 'an object with no playable face';
    };

    /** The directory a program named with SetSearchDirectory. */
    let searchDirectory = '';

    /** @param {string} directory @param {string} file */
    const joinPath = (directory, file)=>{
        if (directory === '')
        {
            return file;
        }
        const trimmed = /[\\/]$/.test(directory) ? directory.slice(0, -1) : directory;
        return `${trimmed}\\${file}`;
    };

    /**
     * The bytes behind a wave reference: the file beside the segment, then in
     * the search directory, then wherever the name alone points. Async,
     * because a file read is, and the bridge parks the calling thread until
     * it settles rather than the read happening behind the program's back.
     *
     * @param {string} file @param {string} beside
     * @returns {Promise<Uint8Array | null>}
     */
    const loadFile = async(file, beside)=>{
        if (!file)
        {
            return null;
        }
        const candidates = /^[a-zA-Z]:[\\/]|^\\\\/.test(file)
            ? [file]
            : [...(beside ? [joinPath(beside, file)] : []),
                ...(searchDirectory ? [joinPath(searchDirectory, file)] : []), file];
        for (const candidate of candidates)
        {
            const bytes = await host.readFile?.(candidate);
            if (bytes)
            {
                return bytes;
            }
        }
        return null;
    };

    /**
     * A wave file's samples as 16-bit PCM, or null when nothing here can
     * decode it.
     *
     * A wave that is already PCM is handed over as it stands. Anything else
     * is the file's own compressed stream -- very often MPEG-in-WAV -- run
     * through the same decoder the program's sound library would have used;
     * a build with no decoder answers null, which is silence for that one
     * sound and not a failed segment.
     *
     * @param {Uint8Array} bytes
     * @returns {Promise<{ samples: Uint8Array | null, sampleRate: number,
     *     channels: number, formatTag: number } | null>}
     */
    const waveSamples = async bytes=>{
        const wav = parseWave(bytes);
        if (!wav)
        {
            return null;
        }
        if (wav.format === 'pcm' && wav.bitsPerSample === 16)
        {
            return { samples: wav.data, sampleRate: wav.sampleRate, channels: wav.channels,
                formatTag: wav.formatTag };
        }
        if ((wav.formatTag === WAVE_FORMAT_MPEG || wav.formatTag === WAVE_FORMAT_MPEGLAYER3)
            && host.decodeWave)
        {
            const decoded = await host.decodeWave(wav.data, {
                formatTag: wav.formatTag, sampleRate: wav.sampleRate, channels: wav.channels,
            });
            if (decoded)
            {
                return {
                    samples: new Uint8Array(decoded.samples.buffer, decoded.samples.byteOffset,
                        decoded.samples.byteLength),
                    sampleRate: decoded.sampleRate,
                    channels: decoded.channels,
                    formatTag: wav.formatTag,
                };
            }
        }
        return { samples: null, sampleRate: wav.sampleRate, channels: wav.channels,
            formatTag: wav.formatTag };
    };

    /**
     * A segment's waves decoded into what the mixer plays.
     *
     * @param {import('./riff.js').Segment} parsed @param {string} beside
     * @param {any} state @param {any} [thread]
     * @returns {Promise<import('./player.js').WaveProgram>}
     */
    const resolveProgram = async(parsed, beside, state, thread)=>{
        /** @type {import('./player.js').WaveProgramItem[]} */
        const items = [];
        for (const wave of parsed.waves)
        {
            const bytes = (state.loader ? await waveFromLoader(state, wave.file, thread) : null)
                ?? await loadFile(wave.file, beside);
            if (!bytes)
            {
                continue;
            }
            const decoded = await waveSamples(bytes);
            if (!decoded || !decoded.samples || decoded.samples.length === 0)
            {
                host.divergence?.('IDirectMusicSegment::Download',
                    `no decoder for wave tag 0x${(decoded?.formatTag ?? 0).toString(16)}`
                    + ` (${wave.file})`);
                continue;
            }
            items.push({
                timeMs: Math.max(0, musicToMs(parsed.tempo, wave.start)),
                samples: decoded.samples.slice(),
                sampleRate: decoded.sampleRate,
                channels: decoded.channels,
                gain: volumeToGain(wave.volume),
            });
        }
        let lengthMs = parsed.header.length > 0
            ? musicToMs(parsed.tempo, parsed.header.length)
            : 0;
        if (!lengthMs)
        {
            for (const item of items)
            {
                const seconds = item.samples.length / (item.channels * 2) / item.sampleRate;
                lengthMs = Math.max(lengthMs, item.timeMs + seconds * 1000);
            }
        }
        return { items, lengthMs };
    };

    /**
     * Every byte a guest IStream has to give, read through the stream's own
     * `Read` and `Seek`.
     *
     * A program that loaded a segment's file itself hands the segment an
     * IStream and expects it parsed; the bytes are only reachable by calling
     * the stream, which is guest code, so the bridge runs it and this reads
     * what it wrote.
     *
     * The stream's size is asked for first, and every read asks for exactly
     * what is left. A DirectMusic file stream refuses a read longer than the
     * bytes remaining -- its `Read` answers E_FAIL rather than a short count --
     * so a reader that assumes a stream tolerates an over-long request gets an
     * empty segment and no music. A stream that will not seek is read in chunks
     * and expected to answer a short read at the end, as IStream promises.
     *
     * @param {number} stream @param {any} thread
     * @returns {Promise<Uint8Array | null>}
     */
    const readStream = async(stream, thread)=>{
        if ((stream >>> 0) === 0 || !host.callGuest)
        {
            host.divergence?.('IPersistStream::Load',
                `stream=0x${(stream >>> 0).toString(16)} no callGuest=${!host.callGuest}`);
            return null;
        }
        const vtable = readU32(stream);
        if (vtable === 0)
        {
            host.divergence?.('IPersistStream::Load', `stream 0x${(stream >>> 0).toString(16)}`
                + ' has no vtable');
            return null;
        }
        const readFn = readU32(vtable + SLOT_STREAM_READ * 4);
        const seekFn = readU32(vtable + SLOT_STREAM_SEEK * 4);
        const chunk = 1 << 16;
        // The count Read writes and the 64-bit position Seek writes, past the
        // sample buffer.
        const countAt = chunk;
        const positionAt = chunk + 4;
        const scratch = (host.allocate?.(chunk + 16) ?? 0) >>> 0;
        if (scratch === 0)
        {
            host.divergence?.('IPersistStream::Load', 'no room for a read buffer');
            return null;
        }
        // What the stream holds, from where it stands now; -1 when it will not
        // seek and the length has to be found by reading.
        let remaining = -1;
        if (seekFn !== 0)
        {
            const hr = (await host.callGuest(seekFn,
                [stream, 0, 0, STREAM_SEEK_END, scratch + positionAt], thread)) | 0;
            if (hr >= 0)
            {
                const size = readU32(scratch + positionAt)
                    + readU32(scratch + positionAt + 4) * 0x100000000;
                // A nonsense size is no size: read until the stream says stop.
                if (size >= 0 && size < 0x40000000)
                {
                    remaining = size;
                    await host.callGuest(seekFn,
                        [stream, 0, 0, STREAM_SEEK_SET, scratch + positionAt], thread);
                }
            }
        }
        /** @type {Uint8Array[]} */
        const parts = [];
        let total = 0;
        try
        {
            for (;;)
            {
                const want = remaining < 0 ? chunk : Math.min(chunk, remaining - total);
                if (want <= 0)
                {
                    break;
                }
                writeU32(scratch + countAt, 0);
                const hr = (await host.callGuest(readFn,
                    [stream, scratch, want, scratch + countAt], thread)) | 0;
                const got = Math.min(readU32(scratch + countAt), want);
                if (got > 0)
                {
                    parts.push(memory.readBytes(scratch, got).slice());
                    total += got;
                }
                if (hr < 0 || got < want)
                {
                    host.divergence?.('IPersistStream::Load',
                        `read hr=0x${(hr >>> 0).toString(16)} bytes=${got} of ${want}`);
                    break;
                }
            }
        }
        finally
        {
            host.free?.(scratch);
        }
        if (total === 0)
        {
            return null;
        }
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const part of parts)
        {
            bytes.set(part, at);
            at += part.length;
        }
        return bytes;
    };

    /**
     * A segment's per-object state, shared by every interface it answers to.
     * A segment made by the loader has bytes; one a program makes by class id
     * has none but the same state, and can still be fed through its stream.
     *
     * @param {Uint8Array | null} data @param {string} dir
     */
    const segmentState = (data, dir)=>{
        const parsed = data ? parseSegment(data) : emptySegment();
        return {
            parsed,
            dir,
            repeats: parsed.header.repeats,
            startPoint: 0,
            loopStart: parsed.header.loopStart | 0,
            loopEnd: parsed.header.loopEnd | 0,
            resolution: parsed.header.resolution || PPQ,
            lengthOverride: 0,
            /** @type {Promise<import('./player.js').WaveProgram> | null} */
            program: null,
        };
    };

    /** @type {WeakMap<any, any>} */
    const segmentApis = new WeakMap();
    /** @param {any} object @returns {any} */
    const segmentApiFor = object=>{
        let api = segmentApis.get(object);
        if (api)
        {
            return api;
        }
        const state = object.state;
        api = {
            object,
            /** @param {Uint8Array | null} data @param {string} dir */
            load(data, dir){
                state.parsed = data ? parseSegment(data) : emptySegment();
                state.dir = dir;
                state.repeats = state.parsed.header.repeats;
                state.startPoint = 0;
                state.loopStart = state.parsed.header.loopStart | 0;
                state.loopEnd = state.parsed.header.loopEnd | 0;
                state.resolution = state.parsed.header.resolution || PPQ;
                state.program = null;
            },
            /** @param {number} loader */
            attachLoader(loader){
                state.loader = loader >>> 0;
            },
            /** @param {any} [thread] @returns {Promise<import('./player.js').WaveProgram>} */
            resolve(thread){
                state.program ??= resolveProgram(state.parsed, state.dir, state, thread);
                return state.program;
            },
            plays: ()=>state.repeats === 0xffffffff ? Infinity : (state.repeats | 0) + 1,
            repeats: ()=>state.repeats,
            startPoint: ()=>state.startPoint,
            loop: ()=>({ start: state.loopStart, end: state.loopEnd }),
            resolution: ()=>state.resolution,
        };
        segmentApis.set(object, api);
        (/** @type {any} */ (object)).dmusic = api;
        return api;
    };

    /** @type {WeakMap<any, any>} */
    const waveApis = new WeakMap();

    /**
     * A wave a program plays directly, as a one-item program.
     *
     * DX8 lets a program hand `PlaySegmentEx` an `IDirectSoundWave` -- a wave
     * it loaded itself -- and the engine plays its samples as though they were
     * a segment holding one wave at time zero. The bytes are what the loader's
     * `CLSID_DirectSoundWave` object holds, and nothing else about it is
     * observable, so a wave with no bytes is refused and a wave with them
     * plays.
     *
     * @param {any} object
     * @returns {Promise<import('./player.js').WaveProgram | null>}
     */
    const resolveWaveObject = async object=>{
        const bytes = object.state?.bytes;
        if (!bytes)
        {
            return null;
        }
        const decoded = await waveSamples(bytes);
        if (!decoded || !decoded.samples || decoded.samples.length === 0)
        {
            return null;
        }
        const seconds = decoded.samples.length / (decoded.channels * 2) / decoded.sampleRate;
        return {
            items: [{
                timeMs: 0,
                samples: decoded.samples.slice(),
                sampleRate: decoded.sampleRate,
                channels: decoded.channels,
                gain: 1,
            }],
            lengthMs: seconds * 1000,
        };
    };

    /**
     * The playable face of a wave object, shaped like a segment's API so
     * `PlaySegment` treats the two the same.
     *
     * @param {any} object @returns {any}
     */
    const waveApiFor = object=>{
        let api = waveApis.get(object);
        if (api)
        {
            return api;
        }
        api = {
            object,
            load(){},
            resolve: ()=>resolveWaveObject(object),
            plays: ()=>1,
            repeats: ()=>0,
            startPoint: ()=>0,
            loop: ()=>({ start: 0, end: 0 }),
            resolution: ()=>PPQ,
        };
        waveApis.set(object, api);
        (/** @type {any} */ (object)).dmusic = api;
        return api;
    };

    /**
     * The loader a segment's stream names through `IDirectMusicGetLoader`.
     *
     * A program that loads a segment from its own stream answers that stream
     * for the loader that reads the files the segment references, so the wave
     * track can reach a wave by name without knowing where the program keeps
     * its archives. Zero when the stream does not answer it.
     *
     * @param {number} stream @param {any} thread
     * @returns {Promise<number>}
     */
    const streamLoader = async(stream, thread)=>{
        if (!host.callGuest || (stream >>> 0) === 0)
        {
            return 0;
        }
        const vtable = readU32(stream);
        const block = (host.allocate?.(32) ?? 0) >>> 0;
        if (block === 0)
        {
            return 0;
        }
        try
        {
            writeGuid(guidMemory, block, ids.IID_DIRECTMUSIC_GETLOADER);
            writeU32(block + 16, 0);
            const hr = (await host.callGuest(readU32(vtable),
                [stream, block, block + 16], thread)) | 0;
            const getLoader = readU32(block + 16);
            if (hr < 0 || getLoader === 0)
            {
                return 0;
            }
            const glVtable = readU32(getLoader);
            writeU32(block + 20, 0);
            const loaded = (await host.callGuest(readU32(glVtable + 12),
                [getLoader, block + 20], thread)) | 0;
            // The interface was taken for this one call and goes back now.
            await host.callGuest(readU32(glVtable + 8), [getLoader], thread);
            return loaded >= 0 ? readU32(block + 20) : 0;
        }
        finally
        {
            host.free?.(block);
        }
    };

    /**
     * A wave's bytes, asked of the loader the segment's stream named.
     *
     * The loader is a program's own object: it resolves the file name against
     * whatever the program mounted -- a game's archive -- and hands back a
     * `CLSID_DirectSoundWave` object, which is this module's, so the bytes it
     * was fed with are read straight out of its state. Null when there is no
     * loader, or it cannot find the wave.
     *
     * @param {any} state @param {string} file @param {any} thread
     * @returns {Promise<Uint8Array | null>}
     */
    const waveFromLoader = async(state, file, thread)=>{
        if (!state.loader || !host.callGuest || !file)
        {
            return null;
        }
        const block = (host.allocate?.(ids.DMUS_OBJECTDESC.SIZE + 20) ?? 0) >>> 0;
        if (block === 0)
        {
            return null;
        }
        try
        {
            memory.writeBytes(block, new Uint8Array(ids.DMUS_OBJECTDESC.SIZE));
            writeU32(block + ids.DMUS_OBJECTDESC.dwSize, ids.DMUS_OBJECTDESC.SIZE);
            writeU32(block + ids.DMUS_OBJECTDESC.dwValidData,
                ids.DMUS_OBJ.CLASS | ids.DMUS_OBJ.NAME | ids.DMUS_OBJ.FILENAME);
            writeGuid(guidMemory, block + ids.DMUS_OBJECTDESC.guidClass,
                ids.CLSID_DIRECTSOUND_WAVE);
            writeWide(block + ids.DMUS_OBJECTDESC.wszFileName, file);
            writeWide(block + ids.DMUS_OBJECTDESC.wszName, file.replace(/\.[^.]*$/, ''));
            const riidAt = block + ids.DMUS_OBJECTDESC.SIZE;
            const outAt = riidAt + 16;
            writeGuid(guidMemory, riidAt, ids.IID_DIRECTMUSIC_OBJECT);
            writeU32(outAt, 0);
            const vtable = readU32(state.loader);
            const hr = (await host.callGuest(readU32(vtable + 3 * 4),
                [state.loader, block, riidAt, outAt], thread)) | 0;
            const object = readU32(outAt);
            if (hr < 0 || object === 0)
            {
                return null;
            }
            return objectAt(object)?.state?.bytes ?? null;
        }
        finally
        {
            host.free?.(block);
        }
    };

    /**
     * A DirectMusic wave: the bytes a program's loader fed it.
     *
     * A segment names its waves; the loader the segment's stream names makes
     * one of these for each and loads the file into it, so this is where a
     * wave's bytes arrive and where the wave track reads them from. Nothing
     * else about the object is observable to a program -- it is made by class
     * id and never asked anything but to hold its samples.
     *
     * @returns {import('../../win32/ole32/objects.js').ComClassDefinition}
     */
    const waveDefinition = ()=>({
        interfaces: [
            describe(ids.IID_DIRECTMUSIC_OBJECT, [
                ['GetDescriptor', 8, (object, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    const state = object.state;
                    writeU32(out + ids.DMUS_OBJECTDESC.dwSize, ids.DMUS_OBJECTDESC.SIZE);
                    writeU32(out + ids.DMUS_OBJECTDESC.dwValidData,
                        ids.DMUS_OBJ.CLASS | (state.file ? ids.DMUS_OBJ.FILENAME : 0)
                        | (state.name ? ids.DMUS_OBJ.NAME : 0));
                    writeGuid(guidMemory, out + ids.DMUS_OBJECTDESC.guidClass,
                        ids.CLSID_DIRECTSOUND_WAVE);
                    writeWide(out + ids.DMUS_OBJECTDESC.wszFileName, state.file);
                    writeWide(out + ids.DMUS_OBJECTDESC.wszName, state.name);
                    return S_OK;
                }],
                ['SetDescriptor', 8, (object, [desc])=>{
                    if ((desc >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    const valid = readU32(desc + ids.DMUS_OBJECTDESC.dwValidData);
                    if ((valid & ids.DMUS_OBJ.FILENAME) !== 0)
                    {
                        object.state.file = readWide(desc + ids.DMUS_OBJECTDESC.wszFileName, 260);
                    }
                    if ((valid & ids.DMUS_OBJ.NAME) !== 0)
                    {
                        object.state.name = readWide(desc + ids.DMUS_OBJECTDESC.wszName, 260);
                    }
                    return S_OK;
                }],
                ['ParseDescriptor', 12, ()=>E_NOTIMPL],
            ]),
            describe(ids.IID_IPERSIST_STREAM, [
                ['GetClassID', 8, (_, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    writeGuid(guidMemory, out, ids.CLSID_DIRECTSOUND_WAVE);
                    return S_OK;
                }],
                ['IsDirty', 4, ()=>S_FALSE],
                ['Load', 8, (object, [stream])=>{
                    const thread = host.callerThread?.();
                    return readStream(stream, thread).then(bytes=>{
                        const wav = bytes ? parseWave(bytes) : null;
                        if (!wav)
                        {
                            return E_FAIL;
                        }
                        object.state.bytes = bytes;
                        object.state.parsed = wav;
                        return S_OK;
                    });
                }],
                ['Save', 12, ()=>E_NOTIMPL],
                ['GetSizeMax', 8, ()=>E_NOTIMPL],
            ]),
        ],
        state: { bytes: null, parsed: null, name: '', file: '' },
    });

    /**
     * @param {Uint8Array | null} data @param {string} dir
     * @returns {import('../../win32/ole32/objects.js').ComClassDefinition}
     */
    const segmentDefinition = (data, dir = '')=>({
        interfaces: [
            describe(ids.IID_DIRECTMUSIC_SEGMENT8, segmentMethods(true)),
            describe(ids.IID_DIRECTMUSIC_SEGMENT, segmentMethods(false)),
            describe(ids.IID_DIRECTMUSIC_OBJECT, [
                ['GetDescriptor', 8, (_, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    writeU32(out + ids.DMUS_OBJECTDESC.dwSize, ids.DMUS_OBJECTDESC.SIZE);
                    writeU32(out + ids.DMUS_OBJECTDESC.dwValidData, ids.DMUS_OBJ.CLASS);
                    writeGuid(guidMemory, out + ids.DMUS_OBJECTDESC.guidClass,
                        ids.CLSID_DIRECTMUSIC_SEGMENT);
                    return S_OK;
                }],
                // A descriptor is how a program hands a segment the bytes it
                // loaded itself: a stream is not read here, but the in-memory
                // form is, because that is the bytes already in guest memory.
                ['SetDescriptor', 8, (object, [desc])=>{
                    if ((desc >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    const valid = readU32(desc + ids.DMUS_OBJECTDESC.dwValidData);
                    if ((valid & ids.DMUS_OBJ.MEMORY) !== 0)
                    {
                        const length = readU32(desc + ids.DMUS_OBJECTDESC.llMemLength)
                            + readU32(desc + ids.DMUS_OBJECTDESC.llMemLength + 4) * 0x100000000;
                        const dataAt = readU32(desc + ids.DMUS_OBJECTDESC.pbMemData);
                        if (dataAt !== 0 && length > 0)
                        {
                            segmentApiFor(object).load(
                                memory.readBytes(dataAt, length).slice(), '');
                            return S_OK;
                        }
                    }
                    host.divergence?.('IDirectMusicObject::SetDescriptor',
                        'only an in-memory descriptor is read');
                    return E_NOTIMPL;
                }],
                ['ParseDescriptor', 12, (_, [stream, out])=>
                    (stream >>> 0) === 0 || (out >>> 0) === 0 ? E_POINTER : S_OK],
            ]),
            describe(ids.IID_IPERSIST_STREAM, [
                ['GetClassID', 8, (_, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    writeGuid(guidMemory, out, ids.CLSID_DIRECTMUSIC_SEGMENT);
                    return S_OK;
                }],
                ['IsDirty', 4, ()=>S_FALSE],
                ['Load', 8, (object, [stream])=>{
                    const thread = host.callerThread?.();
                    return streamLoader(stream, thread).then(loader=>{
                        if (loader !== 0)
                        {
                            segmentApiFor(object).attachLoader(loader);
                        }
                        return readStream(stream, thread);
                    }).then(bytes=>{
                        if (!bytes)
                        {
                            return E_FAIL;
                        }
                        segmentApiFor(object).load(bytes, '');
                        return S_OK;
                    });
                }],
                ['Save', 12, ()=>E_NOTIMPL],
                ['GetSizeMax', 8, ()=>E_NOTIMPL],
            ]),
        ],
        state: segmentState(data, dir),
    });

    /**
     * @param {Uint8Array | null} data @param {string} [dir]
     * @returns {any}
     */
    const createSegmentObject = (data, dir = '')=>{
        const object = createComObject(ids.CLSID_DIRECTMUSIC_SEGMENT,
            segmentDefinition(data, dir));
        return segmentApiFor(object);
    };

    /** @param {boolean} eight */
    function segmentMethods(eight){
        const methods = /** @type {ComMethodEntry[]} */ ([
            ['GetLength', 8, (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const state = object.state;
                writeU32(out, state.lengthOverride || state.parsed.header.length | 0);
                return S_OK;
            }],
            ['SetLength', 8, (object, [value])=>{
                object.state.lengthOverride = value | 0;
                return S_OK;
            }],
            ['GetRepeats', 8, (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, object.state.repeats);
                return S_OK;
            }],
            ['SetRepeats', 8, (object, [value])=>{
                object.state.repeats = value >>> 0;
                return S_OK;
            }],
            ['GetDefaultResolution', 8, (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, object.state.resolution);
                return S_OK;
            }],
            ['SetDefaultResolution', 8, ()=>S_OK],
            ['GetTrack', 20, ()=>E_NOTIMPL],
            ['GetTrackGroup', 12, ()=>E_NOTIMPL],
            ['InsertTrack', 12, ()=>E_NOTIMPL],
            ['RemoveTrack', 8, ()=>S_OK],
            ['InitPlay', 16, (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const state = createSegmentState(object, ()=>object.state.startPoint,
                    { voice: null });
                writeU32(out, publish(state.object, ids.IID_DIRECTMUSIC_SEGMENTSTATE8));
                return S_OK;
            }],
            ['GetGraph', 8, ()=>E_NOTIMPL],
            ['SetGraph', 8, ()=>E_NOTIMPL],
            ['AddNotificationType', 8, ()=>S_OK],
            ['RemoveNotificationType', 8, ()=>S_OK],
            ['GetParam', 28, ()=>E_NOTIMPL],
            ['SetParam', 24, ()=>E_NOTIMPL],
            // A program clones a segment to keep one playing while it changes
            // the other -- a level that swaps a wave track, a manager that
            // holds a spare. DirectMusic answers with a real segment, so a
            // source this engine has no other way to make would otherwise be
            // played as the pointer a refusing call left behind.
            ['Clone', 16, (object, [, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const copy = createSegmentObject(null, object.state.dir);
                const state = copy.object.state;
                state.parsed = object.state.parsed;
                state.repeats = object.state.repeats;
                state.startPoint = object.state.startPoint;
                state.loopStart = object.state.loopStart;
                state.loopEnd = object.state.loopEnd;
                state.resolution = object.state.resolution;
                state.lengthOverride = object.state.lengthOverride;
                if (object.state.loader)
                {
                    copy.attachLoader(object.state.loader);
                }
                writeU32(out, publish(copy.object, ids.IID_DIRECTMUSIC_SEGMENT8));
                return S_OK;
            }],
            ['SetStartPoint', 8, (object, [value])=>{
                object.state.startPoint = value | 0;
                return S_OK;
            }],
            ['GetStartPoint', 8, (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, object.state.startPoint);
                return S_OK;
            }],
            ['SetLoopPoints', 12, (object, [start, end])=>{
                object.state.loopStart = start | 0;
                object.state.loopEnd = end | 0;
                return S_OK;
            }],
            ['GetLoopPoints', 12, (object, [start, end])=>{
                writeU32(start, object.state.loopStart);
                writeU32(end, object.state.loopEnd);
                return S_OK;
            }],
            ['SetPChannelsUsed', 12, ()=>S_OK],
        ]);
        if (eight)
        {
            methods.push(
                ['SetTrackConfig', 24, ()=>E_NOTIMPL],
                ['GetAudioPathConfig', 8, ()=>E_NOTIMPL],
                ['Compose', 20, ()=>E_NOTIMPL],
                ['Download', 8, object=>segmentApiFor(object)
                    .resolve(host.callerThread?.()).then(()=>S_OK)],
                ['Unload', 8, ()=>S_OK],
            );
        }
        return methods;
    }

    /**
     * @param {any} segmentObject @param {() => number} startPoint
     * @param {{ voice: any }} voiceRef
     */
    const createSegmentState = (segmentObject, startPoint, voiceRef)=>{
        const object = createComObject(ids.CLSID_DIRECTMUSIC_SEGMENTSTATE, {
            interfaces: [
                describe(ids.IID_DIRECTMUSIC_SEGMENTSTATE8,
                    stateMethods(segmentObject, startPoint, voiceRef, true)),
                describe(ids.IID_DIRECTMUSIC_SEGMENTSTATE,
                    stateMethods(segmentObject, startPoint, voiceRef, false)),
            ],
        });
        const state = { object, voice: voiceRef?.voice ?? null, segment: segmentObject };
        (/** @type {any} */ (object)).dmusic = state;
        return state;
    };

    /**
     * @param {any} segmentObject @param {() => number} startPoint
     * @param {{ voice: any }} voiceRef @param {boolean} eight
     */
    function stateMethods(segmentObject, startPoint, voiceRef, eight){
        const getSegment = /** @type {ComMethodEntry} */ (['GetSegment', 8, (_, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, publish(segmentObject, ids.IID_DIRECTMUSIC_SEGMENT8));
            return S_OK;
        }]);
        const methods = /** @type {ComMethodEntry[]} */ ([
            ['GetRepeats', 8, (_, [out])=>{
                writeU32(out, voiceRef.voice ? 1 : 0);
                return S_OK;
            }],
            getSegment,
            ['GetStartTime', 8, (_, [out])=>{
                writeU32(out, 0);
                return S_OK;
            }],
            ['GetSeek', 8, (_, [out])=>{
                writeU32(out, 0);
                return S_OK;
            }],
            ['GetStartPoint', 8, (_, [out])=>{
                writeU32(out, startPoint());
                return S_OK;
            }],
        ]);
        if (eight)
        {
            methods.push(
                ['SetTrackConfig', 24, ()=>E_NOTIMPL],
                ['GetObjectInPath', 32, ()=>E_NOTIMPL],
            );
        }
        return methods;
    }

    /**
     * The buffer a program reaches the audio path's own output through.
     *
     * A program of this era asks the path for an IDirectSoundBuffer8 and sets
     * its volume, which is how it makes the music quieter or louder from the
     * same code that would control any buffer. The path has no DirectSound
     * buffer of its own -- the mixer's tracks are where its sound leaves --
     * so what is handed back is a buffer-shaped object: the volume it is told
     * becomes the gain of every wave the path plays, and the calls that move
     * samples around answer the way a buffer that is playing does.
     *
     * @param {any} path
     */
    const createPathBuffer = path=>{
        const writeWaveFormat = (/** @type {number} */ address)=>{
            if ((address >>> 0) === 0)
            {
                return;
            }
            const bytes = new Uint8Array(WAVEFORMATEX.SIZE);
            const view = new DataView(bytes.buffer);
            view.setUint16(WAVEFORMATEX.wFormatTag, 1, true);
            view.setUint16(WAVEFORMATEX.nChannels, 2, true);
            view.setUint32(WAVEFORMATEX.nSamplesPerSec, 44100, true);
            view.setUint32(WAVEFORMATEX.nAvgBytesPerSec, 44100 * 4, true);
            view.setUint16(WAVEFORMATEX.nBlockAlign, 4, true);
            view.setUint16(WAVEFORMATEX.wBitsPerSample, 16, true);
            memory.writeBytes(address >>> 0, bytes);
        };
        const methods = /** @type {ComMethodEntry[]} */ ([
            ['GetCaps', 8, ()=>S_OK],
            ['GetCurrentPosition', 12, (_, [play, write])=>{
                writeU32(play, 0);
                writeU32(write, 0);
                return S_OK;
            }],
            ['GetFormat', 16, (_, [format, size, written])=>{
                if ((format >>> 0) !== 0 && (size >>> 0) >= WAVEFORMATEX.SIZE)
                {
                    writeWaveFormat(format);
                }
                writeU32(written, WAVEFORMATEX.SIZE);
                return S_OK;
            }],
            ['GetVolume', 8, (_, [out])=>{
                writeU32(out, path.volume);
                return S_OK;
            }],
            ['GetPan', 8, (_, [out])=>{
                writeU32(out, path.pan);
                return S_OK;
            }],
            ['GetFrequency', 8, (_, [out])=>{
                writeU32(out, path.frequency);
                return S_OK;
            }],
            ['GetStatus', 8, (_, [out])=>{
                writeU32(out, 1); // DSBSTATUS_PLAYING
                return S_OK;
            }],
            ['Initialize', 12, ()=>S_OK],
            // Nothing locks the path's buffer: its samples are mixed, not
            // written by the program, and a lock is answered as the call a
            // program must not make rather than by handing it memory.
            ['Lock', 32, ()=>E_NOTIMPL],
            ['Play', 16, ()=>S_OK],
            ['SetCurrentPosition', 8, ()=>S_OK],
            ['SetFormat', 8, ()=>S_OK],
            ['SetVolume', 8, (_, [value])=>{
                path.volume = value | 0;
                path.gain = volumeToGain(path.volume);
                return S_OK;
            }],
            ['SetPan', 8, (_, [value])=>{
                path.pan = value | 0;
                return S_OK;
            }],
            ['SetFrequency', 8, (_, [value])=>{
                path.frequency = value >>> 0;
                return S_OK;
            }],
            ['Stop', 4, ()=>S_OK],
            ['Unlock', 20, ()=>S_OK],
            ['Restore', 4, ()=>S_OK],
        ]);
        const eightMethods = /** @type {ComMethodEntry[]} */ ([
            ['SetFX', 16, ()=>E_NOTIMPL],
            ['AcquireResources', 16, ()=>S_OK],
            ['GetObjectInPath', 20, ()=>E_NOINTERFACE],
        ]);
        return createComObject(IID_IDirectSoundBuffer, {
            interfaces: [
                describe(IID_IDirectSoundBuffer8, [...methods, ...eightMethods]),
                describe(IID_IDirectSoundBuffer, methods),
                describe(IID_IKsPropertySet, [
                    ['Get', 32, ()=>0x80070490], // E_PROP_ID_UNSUPPORTED
                    ['Set', 28, ()=>S_OK],
                    ['QuerySupport', 16, (_, [, , out])=>{
                        writeU32(out, 0);
                        return S_OK;
                    }],
                ]),
            ],
        });
    };

    /**
     * The path a performance's music plays through. It names the mixer's
     * default output, which is where a segment's tracks already go, so this is
     * an object a program can hold and ask questions of.
     *
     * @param {number} type @param {number} channels
     */
    const createAudioPath = (type, channels)=>{
        const path = {
            /** @type {any} */
            object: null,
            /** @type {any} */
            buffer: null,
            /** Master volume in hundredths of a decibel, 0 = full. */
            volume: 0,
            pan: 0,
            frequency: 44100,
            gain: 1,
        };
        path.object = createComObject(ids.IID_DIRECTMUSIC_AUDIOPATH, {
            interfaces: [describe(ids.IID_DIRECTMUSIC_AUDIOPATH, [
                // The buffer a stage names is where a program sets the music's
                // volume; anything else is a part of the graph this engine
                // does not build, and is refused by name so the program can
                // tell the two apart.
                ['GetObjectInPath', 32, (_, [, stage, , , , iid, out])=>{
                    const wanted = guidAt(iid);
                    if (wanted === IID_IDirectSoundBuffer8 || wanted === IID_IDirectSoundBuffer)
                    {
                        path.buffer ??= createPathBuffer(path);
                        writeU32(out, publish(path.buffer, wanted));
                        return S_OK;
                    }
                    if (wanted === ids.IID_DIRECTMUSIC_AUDIOPATH || wanted === GUID_NULL)
                    {
                        writeU32(out, publish(path.object, ids.IID_DIRECTMUSIC_AUDIOPATH));
                        return S_OK;
                    }
                    if ((out >>> 0) !== 0)
                    {
                        writeU32(out, 0);
                    }
                    host.divergence?.('IDirectMusicAudioPath::GetObjectInPath',
                        `stage=0x${(stage >>> 0).toString(16)} iid=${wanted ?? '-'}`);
                    return E_NOINTERFACE;
                }],
                ['Activate', 8, ()=>S_OK],
                ['SetVolume', 8, (_, [value])=>{
                    path.volume = value | 0;
                    path.gain = volumeToGain(path.volume);
                    return S_OK;
                }],
                ['ConvertPChannel', 12, (_, [, out])=>{
                    writeU32(out, 0);
                    return S_OK;
                }],
            ])],
            state: { type, channels },
        });
        (/** @type {any} */ (path.object)).dmusic = path;
        return path;
    };

    /**
     * The one port there is: the software synthesizer every Windows with
     * DirectMusic has, as dmusic.h's DMUS_PORTCAPS describes it. A program
     * asks for the default port, creates it, adds it to its performance and
     * activates it without checking each answer, so a system with no port
     * would leave it calling through a null pointer. What it plays still goes
     * through the performance, so the port itself only answers.
     *
     * @param {number} at
     */
    const writePortCaps = at=>{
        if ((at >>> 0) === 0 || readU32(at) < ids.DMUS_PORTCAPS.SIZE)
        {
            return E_POINTER;
        }
        memory.writeBytes(at + 4, new Uint8Array(ids.DMUS_PORTCAPS.SIZE - 4));
        writeU32(at + ids.DMUS_PORTCAPS.dwFlags, ids.DMUS_PC_SOFTWARESYNTH
            | ids.DMUS_PC_DLS | ids.DMUS_PC_DIRECTSOUND);
        writeGuid(guidMemory, at + ids.DMUS_PORTCAPS.guidPort, ids.CLSID_DIRECTMUSIC_SYNTH);
        writeU32(at + ids.DMUS_PORTCAPS.dwClass, ids.DMUS_PC_OUTPUTCLASS);
        writeU32(at + ids.DMUS_PORTCAPS.dwType, ids.DMUS_PORT_USER_MODE_SYNTH);
        writeU32(at + ids.DMUS_PORTCAPS.dwMemorySize, ids.DMUS_PC_SYSTEMMEMORY);
        writeU32(at + ids.DMUS_PORTCAPS.dwMaxChannelGroups, 1000);
        writeU32(at + ids.DMUS_PORTCAPS.dwMaxVoices, 1000);
        writeU32(at + ids.DMUS_PORTCAPS.dwMaxAudioChannels, 2);
        writeWide(at + ids.DMUS_PORTCAPS.wszDescription, 'Microsoft Synthesizer');
        return S_OK;
    };

    const createPort = ()=>{
        const port = { active: false, channelGroups: 1 };
        const object = createComObject(ids.IID_DIRECTMUSIC_PORT, {
            interfaces: [describe(ids.IID_DIRECTMUSIC_PORT, [
                ['PlayBuffer', 8, ()=>S_OK],
                ['SetReadNotificationHandle', 8, ()=>E_NOTIMPL],
                ['Read', 8, ()=>E_NOTIMPL],
                ['DownloadInstrument', 20, ()=>E_NOTIMPL],
                ['UnloadInstrument', 8, ()=>E_NOTIMPL],
                ['GetLatencyClock', 8, ()=>E_NOTIMPL],
                ['GetRunningStats', 8, ()=>E_NOTIMPL],
                ['Compact', 4, ()=>S_OK],
                ['GetCaps', 8, (_, [at])=>writePortCaps(at)],
                ['DeviceIoControl', 32, ()=>E_NOTIMPL],
                ['SetNumChannelGroups', 8, (_, [count])=>{
                    port.channelGroups = count >>> 0;
                    return S_OK;
                }],
                ['GetNumChannelGroups', 8, (_, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    writeU32(out, port.channelGroups);
                    return S_OK;
                }],
                ['Activate', 8, (_, [active])=>{
                    port.active = active !== 0;
                    return S_OK;
                }],
                ['SetChannelPriority', 16, ()=>S_OK],
                ['GetChannelPriority', 16, (_, [, , out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    writeU32(out, ids.DAUD_STANDARD_VOICE_PRIORITY);
                    return S_OK;
                }],
                ['SetDirectSound', 12, ()=>S_OK],
                ['GetFormat', 16, ()=>E_NOTIMPL],
            ])],
            state: port,
        });
        return object;
    };

    /** The DirectMusic object itself, for a program that asks for one. */
    const directMusicDefinition = ()=>{
        const methods = /** @type {ComMethodEntry[]} */ ([
            ['EnumPort', 12, (_, [index, caps])=>
                (index >>> 0) === 0 ? writePortCaps(caps) : S_FALSE],
            ['CreateMusicBuffer', 16, ()=>E_NOTIMPL],
            ['CreatePort', 20, (_, [clsid, , out, outer])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                if ((outer >>> 0) !== 0)
                {
                    return CLASS_E_NOAGGREGATION;
                }
                const wanted = guidAt(clsid);
                if (wanted !== GUID_NULL && wanted !== ids.CLSID_DIRECTMUSIC_SYNTH)
                {
                    return DMUS_E_DRIVER_FAILED;
                }
                writeU32(out, publish(createPort(), ids.IID_DIRECTMUSIC_PORT));
                return S_OK;
            }],
            ['EnumMasterClock', 12, ()=>S_FALSE],
            ['GetMasterClock', 12, ()=>E_NOTIMPL],
            ['SetMasterClock', 8, ()=>E_NOTIMPL],
            ['Activate', 8, ()=>S_OK],
            ['GetDefaultPort', 8, (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeGuid(guidMemory, out, ids.CLSID_DIRECTMUSIC_SYNTH);
                return S_OK;
            }],
            ['SetDirectSound', 12, ()=>S_OK],
        ]);
        const eight = [...methods, /** @type {ComMethodEntry} */ (
            ['SetExternalMasterClock', 8, ()=>E_NOTIMPL])];
        return {
            interfaces: [
                describe(ids.IID_DIRECTMUSIC8, eight),
                describe(ids.IID_DIRECTMUSIC, methods),
            ],
        };
    };

    /**
     * The performance: what a program plays segments through. One definition
     * per create, so each holds its own default path and volume.
     */
    const performanceDefinition = ()=>{
        /** @type {any} */
        let defaultPath = null;
        /** Master volume in hundredths of a decibel, 0 = full. */
        let masterVolume = 0;
        const masterGain = ()=>volumeToGain(masterVolume);

        /** @param {number} lo @param {number} hi */
        const join64 = (lo, hi)=>(lo >>> 0) + (hi >>> 0) * 0x100000000;

        /**
         * DMUS_SEGF_*: whether a segment joins what plays or replaces it, and
         * whether the replacement waits for the current one to end.
         *
         * A program of this era changes its music by naming the segment that
         * should play and when; the flags are how it says whether the new
         * piece is secondary (plays alongside), the next default boundary, or
         * queued behind the piece already playing.
         */
        const SEG_SECONDARY = 0x80;
        const SEG_QUEUE = 0x100;
        const SEG_DEFAULT = 0x4000;
        const SEG_MEASURE = 0x2000;
        const SEG_BEAT = 0x1000;
        const SEG_GRID = 0x800;
        const SEG_SEGMENTEND = 0x800000;

        /**
         * The performance's notification state.
         *
         * DirectMusic tells a program that a segment started, looped, is
         * nearly over or has ended by queueing a DMUS_NOTIFICATION_PMSG and
         * setting the event the program gave `SetNotificationHandle`; the
         * program wakes, reads the messages with `GetNotificationPMsg`, and
         * frees each with `FreePMsg`. A music manager of this era chains its
         * pieces exactly this way, so none of these is a stub.
         */
        const notifications = {
            /** The guest event to set when a message is queued. */
            handle: 0,
            /** @type {Set<string>} */
            types: new Set(),
            /** @type {{ guid: string, option: number, voice: any }[]} */
            queue: [],
            /** @type {Set<number>} */
            allocated: new Set(),
        };

        /** How long before a segment's end it is reported as nearly over. */
        let prepareTime = 1000;

        /** The primary voice, replaced rather than added to by name. */
        /** @type {any} */
        let primary = null;

        /**
         * A segment reached a point worth reporting. Queued and the program's
         * event set on the audio tick; a program waiting on the handle cannot
         * be the one to poll for it.
         *
         * @param {string} kind @param {any} voice
         */
        const onEvent = (kind, voice)=>{
            if (!notifications.handle
                || !notifications.types.has(ids.GUID_NOTIFICATION_SEGMENT))
            {
                return;
            }
            const option = kind === 'start' ? ids.DMUS_NOTIFICATION_SEGSTART
                : kind === 'end' ? ids.DMUS_NOTIFICATION_SEGEND
                    : kind === 'almostEnd' ? ids.DMUS_NOTIFICATION_SEGALMOSTEND
                        : ids.DMUS_NOTIFICATION_SEGLOOP;
            notifications.queue.push({ guid: ids.GUID_NOTIFICATION_SEGMENT, option, voice });
            host.signal?.(notifications.handle);
        };

        /**
         * How much of a voice is left to play, for a segment queued behind it.
         *
         * @param {any} voice
         */
        const remainingMs = voice=>{
            const length = voice?.program?.lengthMs ?? 0;
            if (!(length > 0))
            {
                return 0;
            }
            const elapsed = now() - voice.startedAt - voice.delayMs;
            const total = voice.plays === Infinity ? length : length * voice.plays;
            return Math.max(0, total - elapsed);
        };

        /**
         * Plays a segment, or a wave a program loaded itself, now or behind
         * the primary one.
         *
         * Never throws: a source that is not a segment or a wave is answered
         * with the error DirectMusic answers, because the program's next line
         * must run rather than the call ending the session.
         *
         * @param {number} source @param {any} segment @param {number} flags
         * @param {number} start @param {number} out @param {any} [thread]
         */
        const playSegment = async(source, segment, flags, start, out, thread)=>{
            // The state a program asks for is written before anything can
            // fail, so a play that is refused leaves null rather than whatever
            // the program's local held. DirectMusic's own manager reads this
            // output whatever the result, and a stale pointer there is followed
            // as though it named a segment state.
            if ((out >>> 0) !== 0)
            {
                writeU32(out, 0);
            }
            if (!segment || typeof segment.resolve !== 'function')
            {
                host.divergence?.('IDirectMusicPerformance::PlaySegment',
                    `the source is neither a segment nor a wave that can be played`
                    + ` (0x${(source >>> 0).toString(16)} is ${describeSource(source)})`);
                return E_INVALIDARG;
            }
            /** @type {import('./player.js').WaveProgram | null} */
            let program;
            try
            {
                program = await segment.resolve(thread);
            }
            catch (e){
                host.divergence?.('IDirectMusicPerformance::PlaySegment',
                    `the source could not be resolved: ${e instanceof Error ? e.message : e}`);
                return E_FAIL;
            }
            if (!program)
            {
                host.divergence?.('IDirectMusicPerformance::PlaySegment',
                    'the source has no samples to play');
                return E_INVALIDARG;
            }
            const secondary = (flags & SEG_SECONDARY) !== 0;
            const queued = (flags & (SEG_SEGMENTEND | SEG_QUEUE)) !== 0;
            let delayMs = start > 0 ? start : 0;
            // A piece queued behind the primary one begins where the primary
            // ends. Without measures to align to, its end is the boundary a
            // program of this era queues against.
            if (!secondary && queued && primary)
            {
                delayMs = Math.max(delayMs, remainingMs(primary));
            }
            if (!secondary && !queued && primary)
            {
                player.stop(primary);
            }
            const frame = { voice: null };
            const state = createSegmentState(segment.object, ()=>segment.startPoint(), frame);
            const voice = player.start(program, {
                delayMs,
                plays: segment.plays(),
                volume: masterGain() * (defaultPath?.gain ?? 1),
                segment,
                state,
                prepareMs: prepareTime,
                onEvent,
            });
            frame.voice = voice;
            state.voice = voice;
            voice.state = state;
            if (!secondary)
            {
                primary = voice;
            }
            void (flags & (SEG_DEFAULT | SEG_MEASURE | SEG_BEAT | SEG_GRID));
            if ((out >>> 0) !== 0)
            {
                writeU32(out, publish(state.object, ids.IID_DIRECTMUSIC_SEGMENTSTATE8));
            }
            return S_OK;
        };

        /**
         * Allocates one guest DMUS_NOTIFICATION_PMSG for the next queued
         * event, or 0 when nothing is waiting.
         */
        const nextNotification = ()=>{
            const event = notifications.queue.shift();
            if (!event)
            {
                return 0;
            }
            const size = ids.DMUS_NOTIFICATION_PMSG.SIZE;
            const address = (host.allocate?.(size) ?? 0) >>> 0;
            if (address === 0)
            {
                return 0;
            }
            notifications.allocated.add(address);
            memory.writeBytes(address, new Uint8Array(size));
            writeU32(address + ids.DMUS_NOTIFICATION_PMSG.dwSize, size);
            const ms = now();
            writeU64(address + ids.DMUS_NOTIFICATION_PMSG.rtTime, Math.round(ms * 10000));
            writeU32(address + ids.DMUS_NOTIFICATION_PMSG.mtTime, Math.round(ms * PPQ * 2 / 1000));
            writeU32(address + ids.DMUS_NOTIFICATION_PMSG.dwFlags,
                ids.DMUS_PMSGF_REFTIME | ids.DMUS_PMSGF_MUSICTIME);
            writeU32(address + ids.DMUS_NOTIFICATION_PMSG.dwType, ids.DMUS_PMSGT_NOTIFICATION);
            const state = event.voice?.state;
            writeU32(address + ids.DMUS_NOTIFICATION_PMSG.punkUser,
                state ? publish(state.object, ids.IID_DIRECTMUSIC_SEGMENTSTATE8) : 0);
            writeGuid(guidMemory, address + ids.DMUS_NOTIFICATION_PMSG.guidNotificationType,
                event.guid);
            writeU32(address + ids.DMUS_NOTIFICATION_PMSG.dwNotificationOption, event.option);
            return address;
        };

        const methods = /** @type {ComMethodEntry[]} */ ([
            ['Init', 16, ()=>{
                return S_OK;
            }],
            ['PlaySegment', 24, (_, [source, flags, lo, hi, out])=>playSegment(
                source, apiOf(source), flags >>> 0, join64(lo, hi), out,
                host.callerThread?.())],
            ['Stop', 20, (_, [source, state])=>{
                if ((state >>> 0) !== 0)
                {
                    return stopVoice(apiOf(state));
                }
                if ((source >>> 0) !== 0)
                {
                    return stopVoice(apiOf(source));
                }
                // Neither named: the primary segment is the one meant.
                const stopped = player.playing((/** @type {any} */ v)=>v === primary);
                player.stopWhere((/** @type {any} */ v)=>v === primary);
                primary = null;
                return stopped ? S_OK : S_FALSE;
            }],
            ['GetSegmentState', 12, (_, [out])=>{
                const voice = player.voices()[0];
                if (!voice || (out >>> 0) === 0)
                {
                    return E_FAIL;
                }
                writeU32(out, publish(voice.state.object, ids.IID_DIRECTMUSIC_SEGMENTSTATE8));
                return S_OK;
            }],
            ['SetPrepareTime', 8, (_, [value])=>{
                prepareTime = value >>> 0;
                return S_OK;
            }],
            ['GetPrepareTime', 8, (_, [out])=>{
                writeU32(out, prepareTime);
                return S_OK;
            }],
            ['SetBumperLength', 8, ()=>S_OK],
            ['GetBumperLength', 8, (_, [out])=>{
                writeU32(out, 0);
                return S_OK;
            }],
            ['SendPMsg', 8, ()=>S_OK],
            ['MusicToReferenceTime', 12, (_, [mt, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU64(out, mt * 10000);
                return S_OK;
            }],
            ['ReferenceToMusicTime', 16, (_, [lo, hi, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, Math.floor(join64(lo, hi) / 10000));
                return S_OK;
            }],
            ['IsPlaying', 12, (_, [segment, state])=>{
                const a = (state >>> 0) !== 0 ? apiOf(state) : null;
                const b = (segment >>> 0) !== 0 ? apiOf(segment) : null;
                if (!a && !b)
                {
                    return player.voices().length > 0 ? S_OK : S_FALSE;
                }
                const hit = player.playing((/** @type {any} */ v)=>
                    v.state === a || v.segment === a || v.state === b || v.segment === b);
                return hit ? S_OK : S_FALSE;
            }],
            ['GetTime', 12, (_, [reference, music])=>{
                const ms = now();
                if ((reference >>> 0) !== 0)
                {
                    writeU64(reference, Math.round(ms * 10000));
                }
                if ((music >>> 0) !== 0)
                {
                    writeU32(music, Math.round(ms * PPQ * 2 / 1000));
                }
                return S_OK;
            }],
            ['AllocPMsg', 12, (_, [size, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const bytes = (size >>> 0) || ids.DMUS_NOTIFICATION_PMSG.SIZE;
                const address = (host.allocate?.(bytes) ?? 0) >>> 0;
                if (address === 0)
                {
                    return E_OUTOFMEMORY;
                }
                memory.writeBytes(address, new Uint8Array(bytes));
                writeU32(address + ids.DMUS_NOTIFICATION_PMSG.dwSize, bytes);
                notifications.allocated.add(address);
                writeU32(out, address);
                return S_OK;
            }],
            ['FreePMsg', 8, (_, [message])=>{
                if ((message >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (notifications.allocated.delete(message >>> 0))
                {
                    host.free?.(message >>> 0);
                }
                return S_OK;
            }],
            ['GetGraph', 8, ()=>E_FAIL],
            ['SetGraph', 8, ()=>E_NOTIMPL],
            ['SetNotificationHandle', 16, (_, [handle])=>{
                notifications.handle = handle >>> 0;
                return S_OK;
            }],
            ['GetNotificationPMsg', 8, (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const address = nextNotification();
                writeU32(out, address);
                return address !== 0 ? S_OK : S_FALSE;
            }],
            ['AddNotificationType', 8, (_, [guid])=>{
                const type = guidAt(guid);
                if (type)
                {
                    notifications.types.add(type);
                }
                return S_OK;
            }],
            ['RemoveNotificationType', 8, (_, [guid])=>{
                const type = guidAt(guid);
                if (type)
                {
                    notifications.types.delete(type);
                }
                return S_OK;
            }],
            ['AddPort', 8, ()=>S_OK],
            ['RemovePort', 8, ()=>S_OK],
            ['AssignPChannelBlock', 16, ()=>S_OK],
            ['AssignPChannel', 20, ()=>S_OK],
            ['PChannelInfo', 20, ()=>E_INVALIDARG],
            ['DownloadInstrument', 36, ()=>E_NOTIMPL],
            ['Invalidate', 12, ()=>S_OK],
            ['GetParam', 28, ()=>E_NOTIMPL],
            ['SetParam', 24, ()=>E_NOTIMPL],
            ['GetGlobalParam', 16, (_, [guid, out])=>{
                if (guidAt(guid) === ids.GUID_PERF_MASTER_VOLUME && (out >>> 0) !== 0)
                {
                    writeU32(out, masterVolume);
                }
                return S_OK;
            }],
            ['SetGlobalParam', 16, (_, [guid, param])=>{
                if (guidAt(guid) === ids.GUID_PERF_MASTER_VOLUME && (param >>> 0) !== 0)
                {
                    masterVolume = readU32(param) | 0;
                }
                return S_OK;
            }],
            ['GetLatencyTime', 8, (_, [out])=>{
                writeU64(out, 0);
                return S_OK;
            }],
            ['GetQueueTime', 8, (_, [out])=>{
                writeU64(out, 0);
                return S_OK;
            }],
            ['AdjustTime', 12, (_, [lo, hi, out])=>{
                writeU64(out, join64(lo, hi));
                return S_OK;
            }],
            ['CloseDown', 4, ()=>{
                player.stopAll();
                primary = null;
                return S_OK;
            }],
            ['GetResolvedTime', 20, (_, [lo, hi, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU64(out, join64(lo, hi));
                return S_OK;
            }],
            ['MIDIToMusic', 24, ()=>E_NOTIMPL],
            ['MusicToMIDI', 24, ()=>E_NOTIMPL],
            ['TimeToRhythm', 28, ()=>E_NOTIMPL],
            ['RhythmToTime', 28, ()=>E_NOTIMPL],
        ]);

        const eightMethods = /** @type {ComMethodEntry[]} */ ([
            ['InitAudio', 32, (_, [music, sound, , type, channels])=>{
                defaultPath = createAudioPath(type >>> 0, channels >>> 0);
                // The objects the caller asked for are the ones DirectMusic
                // would have made. The DirectSound half is not this layer's
                // to make -- the layer that answers for DirectSound is a
                // different one -- so it is left null.
                if ((music >>> 0) !== 0)
                {
                    const made = createComObject(ids.CLSID_DIRECTMUSIC, directMusicDefinition());
                    writeU32(music, publish(made, ids.IID_DIRECTMUSIC8));
                }
                if ((sound >>> 0) !== 0)
                {
                    writeU32(sound, 0);
                }
                return S_OK;
            }],
            ['PlaySegmentEx', 40, (_, [source, , , flags, lo, hi, out])=>playSegment(
                source, apiOf(source), flags >>> 0, join64(lo, hi), out,
                host.callerThread?.())],
            ['StopEx', 20, (_, [item])=>{
                if ((item >>> 0) === 0)
                {
                    player.stopAll();
                    primary = null;
                    return S_OK;
                }
                return stopVoice(apiOf(item));
            }],
            ['ClonePMsg', 12, ()=>E_NOTIMPL],
            ['CreateAudioPath', 16, (_, [, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const path = createAudioPath(0, 0);
                writeU32(out, publish(path.object, ids.IID_DIRECTMUSIC_AUDIOPATH));
                return S_OK;
            }],
            ['CreateStandardAudioPath', 20, (_, [type, channels, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const path = createAudioPath(type >>> 0, channels >>> 0);
                writeU32(out, publish(path.object, ids.IID_DIRECTMUSIC_AUDIOPATH));
                return S_OK;
            }],
            ['SetDefaultAudioPath', 8, (_, [path])=>{
                defaultPath = apiOf(path);
                return S_OK;
            }],
            ['GetDefaultAudioPath', 8, (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, defaultPath
                    ? publish(defaultPath.object, ids.IID_DIRECTMUSIC_AUDIOPATH) : 0);
                return S_OK;
            }],
            ['GetParamEx', 32, ()=>E_NOTIMPL],
        ]);

        /** @param {any} target */
        const stopVoice = target=>{
            if (!target)
            {
                return S_FALSE;
            }
            let stopped = false;
            let stoppedPrimary = false;
            player.stopWhere((/** @type {any} */ voice)=>{
                const hit = voice.segment === target || voice.state === target;
                stopped ||= hit;
                stoppedPrimary ||= hit && voice === primary;
                return hit;
            });
            if (stoppedPrimary)
            {
                primary = null;
            }
            return stopped ? S_OK : S_FALSE;
        };

        return {
            interfaces: [
                describe(ids.IID_DIRECTMUSIC_PERFORMANCE8, [...methods, ...eightMethods]),
                describe(ids.IID_DIRECTMUSIC_PERFORMANCE, methods),
            ],
        };
    };

    /** The loader a program asks for objects by name or descriptor. */
    const loaderDefinition = ()=>{
        /** @type {Map<string, any>} */
        const cache = new Map();
        /** @param {string} path */
        const dirOf = path=>{
            const at = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
            return at <= 0 ? '' : path.slice(0, at);
        };
        /** @param {number} address */
        const readDescriptor = address=>({
            name: readWide(address + ids.DMUS_OBJECTDESC.wszName, 64),
            filename: readWide(address + ids.DMUS_OBJECTDESC.wszFileName, 260),
            memLength: readU32(address + ids.DMUS_OBJECTDESC.llMemLength)
                + readU32(address + ids.DMUS_OBJECTDESC.llMemLength + 4) * 0x100000000,
            memData: readU32(address + ids.DMUS_OBJECTDESC.pbMemData),
            stream: readU32(address + ids.DMUS_OBJECTDESC.pStream),
        });

        /**
         * @param {number} iid @param {Uint8Array} bytes @param {string} dir
         * @param {number} out
         */
        const finishLoad = (iid, bytes, dir, out)=>{
            const wanted = (iid >>> 0) === 0 ? ids.IID_DIRECTMUSIC_SEGMENT8 : guidAt(iid);
            const allowed = [ids.IID_DIRECTMUSIC_SEGMENT, ids.IID_DIRECTMUSIC_SEGMENT8,
                ids.IID_DIRECTMUSIC_OBJECT, ids.IID_IPERSIST_STREAM, GUID_NULL];
            if (!allowed.includes(/** @type {string} */ (wanted)))
            {
                return E_NOINTERFACE;
            }
            const segment = createSegmentObject(bytes, dir);
            const chosen = wanted === GUID_NULL ? ids.IID_DIRECTMUSIC_SEGMENT8
                : /** @type {string} */ (wanted);
            const pointer = publish(segment.object, chosen);
            if (pointer === 0)
            {
                return E_OUTOFMEMORY;
            }
            writeU32(out, pointer);
            return S_OK;
        };

        const methods = /** @type {ComMethodEntry[]} */ ([
            ['GetObject', 16, (_, [descriptor, iid, out])=>{
                if ((descriptor >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                const desc = readDescriptor(descriptor >>> 0);
                if (desc.memData !== 0 && desc.memLength > 0)
                {
                    return finishLoad(iid, memory.readBytes(desc.memData, desc.memLength).slice(),
                        '', out);
                }
                if (desc.filename !== '')
                {
                    return loadFile(desc.filename, '')
                        .then(bytes=>bytes ? finishLoad(iid, bytes, dirOf(desc.filename), out)
                            : E_FAIL);
                }
                if (desc.name !== '')
                {
                    return loadFile(desc.name, '')
                        .then(bytes=>bytes ? finishLoad(iid, bytes, '', out) : E_FAIL);
                }
                if (desc.stream !== 0)
                {
                    host.divergence?.('IDirectMusicLoader::GetObject',
                        'loading from an IStream is not implemented');
                    return E_NOTIMPL;
                }
                return E_INVALIDARG;
            }],
            ['SetObject', 8, ()=>S_OK],
            ['SetSearchDirectory', 16, (_, [guid, path])=>{
                void guid;
                if ((path >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const wanted = readWide(path, 260);
                const changed = wanted !== searchDirectory;
                searchDirectory = wanted;
                return changed ? S_OK : S_FALSE;
            }],
            ['ScanDirectory', 16, ()=>S_FALSE],
            ['CacheObject', 8, ()=>S_OK],
            ['ReleaseObject', 8, ()=>S_OK],
            ['ClearCache', 8, ()=>{
                cache.clear();
                return S_OK;
            }],
            ['EnableCache', 12, ()=>S_FALSE],
            ['EnumObject', 20, ()=>S_FALSE],
        ]);
        const eightMethods = /** @type {ComMethodEntry[]} */ ([
            ['CollectGarbage', 4, ()=>S_OK],
            ['ReleaseObjectByUnknown', 8, ()=>S_OK],
            ['LoadObjectFromFile', 20, (_, [, iid, path, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                if ((path >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const name = readWide(path, 260);
                return loadFile(name, '')
                    .then(bytes=>bytes ? finishLoad(iid, bytes, dirOf(name), out) : E_FAIL);
            }],
        ]);
        return {
            interfaces: [
                describe(ids.IID_DIRECTMUSIC_LOADER8, [...methods, ...eightMethods]),
                describe(ids.IID_DIRECTMUSIC_LOADER, methods),
            ],
        };
    };

    return {
        performance: performanceDefinition,
        loader: loaderDefinition,
        directMusic: directMusicDefinition,
        /** A wave the loader makes for a segment's reference. */
        wave: waveDefinition,
        /** An empty segment, for a program that makes one by class id. */
        segment: ()=>segmentDefinition(null, ''),
        /** One turn of the clock for every performance's voices. */
        tick: ()=>player.tick(),
        diagnostics: ()=>({ ...player.diagnostics() }),
        /** A segment made by the loader, kept for tests and for the report. */
        createSegment: createSegmentObject,
    };
}

/** A segment with nothing in it, for a segment made by class id alone. */
function emptySegment(){
    return {
        header: { repeats: 0, length: 0, playStart: 0, loopStart: 0, loopEnd: 0,
            resolution: PPQ, refLength: 0 },
        waves: [],
        tempo: [],
        trackCount: 0,
    };
}
