/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WASAPI's render stream, IAudioClient as IMMDevice::Activate hands it out:
 * the way a program plays to an endpoint itself, and the way the sound
 * libraries a program ships do -- XAudio2's redistributable, FMOD, a game
 * engine's mixer -- on Vista and later, where DirectSound is itself a client
 * of this.
 *
 * Shared mode only. The engine's mix format is the endpoint's (32-bit float,
 * its rate and channels); a stream may differ from it in sample format but
 * not in rate or channels, unless it asked to have its rate adjusted or its
 * PCM converted, which are the rules Windows applies (`validateFormat`).
 * Exclusive mode is answered as on a machine whose user has not allowed it,
 * AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED: a program asks for it as a
 * preference and falls back to shared.
 *
 * The stream's buffer is a ring the program writes a stretch of at a time
 * (IAudioRenderClient::GetBuffer and ReleaseBuffer); what it released goes to
 * a track of the machine's mixer, the same one waveOut writes to, and what
 * the track has played is how far the stream has played: the padding a
 * program waits on and the sound a person hears are the same fact. With no
 * output the stream plays against the guest's clock at its own rate and
 * produces silence, as waveOut does. A stream that asked to be woken
 * (AUDCLNT_STREAMFLAGS_EVENTCALLBACK) has its event set every device period
 * from its first Start until it is released -- on through Stop and Reset, as
 * the engine keeps doing.
 */

import { createComObject } from './objects.js';
import { wholeAddress } from '../common/pointers.js';
import { utf16z } from '../common/utf16.js';
import { formatGuid } from '../../../system/guid.js';

export const IID_IAUDIO_CLIENT = '{1CB9AD4C-DBFA-4C32-B178-C2F568A703B2}';
const IID_IAUDIO_RENDER_CLIENT = '{F294ACFC-3146-4483-A7BF-ADDCA7C260E2}';
const IID_IAUDIO_CAPTURE_CLIENT = '{C8ADBD64-E71E-48A0-A4DE-185C395CD317}';
const IID_IAUDIO_CLOCK = '{CD63314F-3FBA-4A1B-812C-EF96358728E7}';
const IID_IAUDIO_CLOCK_ADJUSTMENT = '{F6E4C0A0-46D9-4FB8-BE21-57A3EF2B626C}';
const IID_ISIMPLE_AUDIO_VOLUME = '{87CE5498-68D6-44E5-9215-6DA47EF883D8}';
const IID_IAUDIO_STREAM_VOLUME = '{93014887-242D-4068-8A15-CF5E93B90FE3}';
const IID_ICHANNEL_AUDIO_VOLUME = '{1C158861-B533-4B30-B1CF-E853E51C59B8}';
const IID_IAUDIO_SESSION_CONTROL = '{F4B1A599-7266-4319-A8CA-E70ACB11E8CD}';
const IID_IAUDIO_SESSION_CONTROL2 = '{BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D}';
const GUID_NULL = '{00000000-0000-0000-0000-000000000000}';
export const IID_IAUDIO_SESSION_MANAGER = '{BFA971F1-4D5E-40BB-935E-967039BFBEE4}';
const IID_IAUDIO_SESSION_MANAGER2 = '{77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F}';
const IID_IAUDIO_SESSION_ENUMERATOR = '{E2F5BB11-0570-40CA-ACDD-3AA01277DEE8}';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** HRESULT_FROM_WIN32(ERROR_INVALID_NAME): an event handle set a second time. */
const E_EVENT_ALREADY_SET = 0x8007007b | 0;
/** HRESULT_FROM_WIN32(RPC_X_NULL_REF_POINTER): a session's calls are remote, and refuse a null. */
const E_NULL_REFERENCE = 0x800706f4 | 0;
/** HRESULT_FROM_WIN32(ERROR_NOT_FOUND). */
const E_NOT_FOUND = 0x80070490 | 0;
/** AudioSessionState. */
const SESSION_INACTIVE = 0;
const SESSION_ACTIVE = 1;

const AUDCLNT_E_NOT_INITIALIZED = 0x88890001 | 0;
const AUDCLNT_E_ALREADY_INITIALIZED = 0x88890002 | 0;
const AUDCLNT_E_WRONG_ENDPOINT_TYPE = 0x88890003 | 0;
const AUDCLNT_E_NOT_STOPPED = 0x88890005 | 0;
const AUDCLNT_E_BUFFER_TOO_LARGE = 0x88890006 | 0;
const AUDCLNT_E_OUT_OF_ORDER = 0x88890007 | 0;
const AUDCLNT_E_UNSUPPORTED_FORMAT = 0x88890008 | 0;
const AUDCLNT_E_INVALID_SIZE = 0x88890009 | 0;
const AUDCLNT_E_BUFFER_OPERATION_PENDING = 0x8889000b | 0;
const AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED = 0x8889000e | 0;
const AUDCLNT_E_ENDPOINT_CREATE_FAILED = 0x8889000f | 0;
const AUDCLNT_E_EVENTHANDLE_NOT_EXPECTED = 0x88890011 | 0;
const AUDCLNT_E_EVENTHANDLE_NOT_SET = 0x88890014 | 0;

const SHAREMODE_SHARED = 0;
const SHAREMODE_EXCLUSIVE = 1;

/** The stream and session flags Initialize takes; any other bit is refused. */
const STREAMFLAGS_LOOPBACK = 0x20000;
const STREAMFLAGS_EVENTCALLBACK = 0x40000;
const STREAMFLAGS_RATEADJUST = 0x100000;
const STREAMFLAGS_AUTOCONVERTPCM = 0x80000000;
const KNOWN_FLAGS = 0x10000 | STREAMFLAGS_LOOPBACK | STREAMFLAGS_EVENTCALLBACK | 0x80000
    | STREAMFLAGS_RATEADJUST | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000
    | STREAMFLAGS_AUTOCONVERTPCM;

const BUFFERFLAGS_SILENT = 0x2;

/** The most of a session's name or icon path read: MAX_PATH characters and more, in bytes. */
const NAME_BYTES = 1024 * 2;

/** The engine's period, in 100 ns units: 10 ms, the default Windows reports; and its least. */
export const DEFAULT_PERIOD = 100000;
const MINIMUM_PERIOD = 30000;
/**
 * The least buffer a shared stream is given, in periods. Chosen: a stream that
 * asks for none (a duration of 0, as an event-driven one usually does) is given
 * room for the engine's period and the one being written.
 */
const MINIMUM_PERIODS = 2;

/** timeSetEvent's flags: periodic, and setting an event rather than calling back. */
const TIME_PERIODIC = 0x1;
const TIME_CALLBACK_EVENT_SET = 0x10;

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** The bytes every KSDATAFORMAT_SUBTYPE GUID for a plain tag ends in, after its tag word. */
const SUBTYPE_TAIL = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/**
 * @typedef {Object} StreamFormat
 * @property {number} tag          WAVE_FORMAT_PCM or WAVE_FORMAT_IEEE_FLOAT, or another
 * @property {number} channels
 * @property {number} rate
 * @property {number} bytesPerSecond
 * @property {number} blockAlign
 * @property {number} bits
 * @property {number} validBits
 * @property {number} cbSize       0 for a plain WAVEFORMATEX
 * @property {boolean} extensible
 */

/**
 * A WAVEFORMATEX or WAVEFORMATEXTENSIBLE read from guest memory: the plain
 * header, and the extensible part where the tag says there is one.
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {number} at
 * @returns {StreamFormat}
 */
export function readStreamFormat(read, at){
    const head = read(wholeAddress(at), 18).slice();
    const view = new DataView(head.buffer);
    const tag = view.getUint16(0, true);
    const format = {
        tag,
        channels: view.getUint16(2, true),
        rate: view.getUint32(4, true),
        bytesPerSecond: view.getUint32(8, true),
        blockAlign: view.getUint16(12, true),
        bits: view.getUint16(14, true),
        validBits: view.getUint16(14, true),
        cbSize: tag === WAVE_FORMAT_PCM ? 0 : view.getUint16(16, true),
        extensible: false,
    };
    if (tag === WAVE_FORMAT_EXTENSIBLE)
    {
        format.extensible = true;
        if (format.cbSize >= 22)
        {
            const tail = read(wholeAddress(at) + 18, 22).slice();
            const ext = new DataView(tail.buffer);
            format.validBits = ext.getUint16(0, true);
            const sub = ext.getUint32(6, true);
            const plain = SUBTYPE_TAIL.every((byte, index)=>tail[10 + index] === byte);
            format.tag = plain && sub <= 0xffff ? sub : -1;
        }
    }
    return format;
}

/**
 * What Windows answers for a stream format in shared mode, as its own
 * conformance record has it: a plain tag reduced to its extensible form
 * (only PCM and float are formats here at all, and a plain one carries at
 * most two channels), then the header's own arithmetic, then the sample
 * types the engine takes -- 8, 16, 24 and 32-bit PCM with every bit valid,
 * or 24 valid in 32, and 32-bit float. A format that passes but is not
 * `compatible` with the mix (another rate or channel count) is unsupported.
 *
 * @param {StreamFormat} format @param {boolean} compatible
 * @returns {number} an HRESULT
 */
export function validateFormat(format, compatible){
    if (!format.extensible)
    {
        if (format.tag !== WAVE_FORMAT_PCM && format.tag !== WAVE_FORMAT_IEEE_FLOAT)
        {
            return AUDCLNT_E_UNSUPPORTED_FORMAT;
        }
        if (format.channels > 2)
        {
            return E_INVALIDARG;
        }
    }
    else if (format.cbSize < 22)
    {
        return E_INVALIDARG;
    }
    let answer;
    if (format.channels === 0 || format.rate === 0
        || format.blockAlign !== Math.floor(format.channels * format.bits / 8)
        || format.bytesPerSecond !== format.blockAlign * format.rate
        || format.validBits === 0 || format.validBits > format.bits)
    {
        answer = E_INVALIDARG;
    }
    else if (format.tag === WAVE_FORMAT_PCM)
    {
        answer = ![8, 16, 24, 32].includes(format.bits) ? E_INVALIDARG
            : format.bits === 32 && format.validBits === 24 ? S_OK
                : format.validBits !== format.bits ? AUDCLNT_E_UNSUPPORTED_FORMAT : S_OK;
    }
    else if (format.tag === WAVE_FORMAT_IEEE_FLOAT)
    {
        answer = format.bits !== 32 && format.bits !== 64 ? E_INVALIDARG
            : format.bits !== 32 || format.validBits !== 32 ? AUDCLNT_E_UNSUPPORTED_FORMAT : S_OK;
    }
    else
    {
        answer = AUDCLNT_E_UNSUPPORTED_FORMAT;
    }
    return !compatible && answer === S_OK ? AUDCLNT_E_UNSUPPORTED_FORMAT : answer;
}

/**
 * @typedef {Object} AudioClientHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {{ allocate: (bytes: number) => number }} heap  The task allocator's memory.
 * @property {{ publish: (object: import('./objects.js').ComObject, id: string) => number }} vtables
 * @property {(at: number, value: number) => void} writePointer
 * @property {() => number} now  The guest's clock, in milliseconds.
 * @property {() => any} [output]  The machine's mixer, when anything is listening.
 * @property {{ set: (delay: number, target: number, user: number, flags: number,
 *     when?: () => boolean) => number,
 *     kill: (id: number) => number }} [timers]  The multimedia timers, which set an event.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {() => number} [processId]  This process's id, which a session names.
 * @property {() => string} [program]  The program's path as the object manager names it,
 *     which a session's identifier carries.
 */

/**
 * The endpoint's audio clients, made by IMMDevice::Activate.
 *
 * @param {AudioClientHost} host
 * @param {{ id: string, rate: number, channels: number, mixFormat: () => Uint8Array,
 *     gain?: (channel: number) => number }} endpoint  `gain`: the endpoint's own volume
 *     of a channel (IAudioEndpointVolume), which every stream to it plays at
 */
export function createAudioClients(host, endpoint){
    /** Every stream handed out, for diagnostics. @type {Set<any>} */
    const streams = new Set();
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writeMemory(wholeAddress(at),
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** @param {number} at @param {number} value */
    const writeU64 = (at, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt(Math.max(0, Math.floor(value))), true);
        host.writeMemory(wholeAddress(at), bytes);
    };
    /** @param {number} at @param {number} value */
    const writeFloat = (at, value)=>host.writeMemory(wholeAddress(at),
        new Uint8Array(Float32Array.of(value).buffer));
    /** A float passed by value, as its bits arrive. @param {number} bits */
    const floatOf = bits=>new Float32Array(Uint32Array.of(bits >>> 0).buffer)[0];
    /** @param {number} at */
    const readFloat = at=>new Float32Array(host.readMemory(wholeAddress(at), 4).slice().buffer)[0];
    /** A copy of the mix format in task memory; 0 when none is left. */
    const taskMixFormat = ()=>{
        const bytes = endpoint.mixFormat();
        const at = host.heap.allocate(bytes.length);
        if (at !== 0)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };

    /** A string in task memory, the caller's to free; 0 when none is left. @param {string} text */
    const taskString = text=>{
        const at = host.heap.allocate(text.length * 2 + 2);
        if (at !== 0)
        {
            host.writeMemory(at, utf16z(text));
        }
        return at;
    };
    /** @param {number} out @param {string} text */
    const handOutString = (out, text)=>{
        const at = taskString(text);
        host.writePointer(out, at);
        return at === 0 ? E_OUTOFMEMORY : S_OK;
    };

    /**
     * The sessions of this process by the GUID a stream named in Initialize,
     * the default one under GUID_NULL: a session's volume and mute, and its
     * channels' volumes, apply to every stream in it, and what a program says
     * of it (its name, icon and grouping) is kept for it.
     *
     * @type {Map<string, any>}
     */
    const sessions = new Map();
    let nextGrouping = 1;
    /** @param {string} id */
    const sessionOf = id=>{
        let session = sessions.get(id);
        if (!session)
        {
            // A grouping is never GUID_NULL, as on Windows: one made per session.
            const grouping = new Uint8Array(16);
            new DataView(grouping.buffer).setUint32(0, nextGrouping++, true);
            grouping[15] = 0x5e;
            session = {
                id, volume: 1, muted: false,
                /** @type {number[]} */
                channels: new Array(endpoint.channels).fill(1),
                /** @type {Set<any>} */
                streams: new Set(),
                name: '', icon: '', grouping,
                /** @type {Set<number>} */
                listeners: new Set(),
            };
            sessions.set(id, session);
        }
        return session;
    };

    /** The gain and balance a stream's track is given. @param {any} stream */
    const applyVolume = stream=>{
        const track = stream.track;
        if (!track)
        {
            return;
        }
        const session = stream.session;
        track.gain = session.muted ? 0 : session.volume;
        const endpointGain = endpoint.gain ?? (()=>1);
        const left = (stream.volumes[0] ?? 1) * (session.channels[0] ?? 1) * endpointGain(0);
        const right = (stream.volumes[1] ?? stream.volumes[0] ?? 1)
            * (session.channels[1] ?? session.channels[0] ?? 1) * endpointGain(1);
        track.balance = [left, right];
    };

    /**
     * Hands the track as much of what the program released as it takes now,
     * or up to `most` bytes of it: a track holds a fifth of a second, and a
     * stream's buffer may be longer.
     *
     * @param {any} stream @param {number} [most]
     * @returns {number} the bytes handed over
     */
    const feed = (stream, most = Infinity)=>{
        const track = stream.track;
        if (!track)
        {
            return 0;
        }
        const room = track.capacityFrames ?? Math.round(stream.format.rate / 5);
        const block = stream.format.blockAlign;
        let given = 0;
        while (stream.queue.length > 0 && given < most)
        {
            const free = Math.min(Math.floor(room - track.pending()) * block, most - given);
            if (free <= 0)
            {
                break;
            }
            const head = stream.queue[0];
            if (head.length <= free)
            {
                track.write(stream.queue.shift());
                given += head.length;
            }
            else
            {
                track.write(head.subarray(0, free));
                stream.queue[0] = head.subarray(free);
                given += free;
            }
        }
        return given;
    };

    /** A period of the engine's, in the stream's frames. @param {any} stream */
    const periodFrames = stream=>Math.round(stream.rate * DEFAULT_PERIOD / 10_000_000);

    /**
     * Windows' engine, for a stream that asked to be woken: it sets the event
     * when the program has a period's room. The room is what the device took
     * (`played`), the device being the audio thread behind the adapter's lead
     * (`DEVICE_LEAD_MS`), and not the guest's clock, which is credited between
     * turns and drifts from it: waking once a guest's period, a device three
     * percent faster ran dry, 950 frames a second under a program writing a
     * period a wake. Looked at twice a period, so that wakes keep up with a
     * faster device.
     *
     * @param {any} stream
     * @returns {boolean} whether to set the event
     */
    const engineTick = stream=>stream.started
        && stream.bufferFrames - padding(stream) >= periodFrames(stream);

    /**
     * Frames the stream has played since it was last reset. From the track
     * where there is one, so that what the program is told and what is heard
     * agree; against the clock while started where there is none. Never past
     * what was released: an engine that ran dry plays silence, not the past.
     *
     * @param {any} stream
     */
    const played = stream=>{
        let frames;
        if (stream.track)
        {
            feed(stream);
            frames = Math.floor(stream.track.playedBytes() / stream.format.blockAlign);
        }
        else
        {
            const now = host.now();
            if (stream.started)
            {
                stream.clockFrames += (now - stream.since) * stream.rate / 1000;
            }
            stream.since = now;
            frames = Math.floor(stream.clockFrames);
        }
        if (frames > stream.written)
        {
            frames = stream.written;
            if (!stream.track)
            {
                stream.clockFrames = frames;
            }
        }
        return frames;
    };

    /** What the program has written and is still to be played. @param {any} stream */
    const padding = stream=>stream.written - played(stream);

    /** Closes what a stream held, when its client goes. @param {any} stream */
    const close = stream=>{
        if (stream.timer !== 0)
        {
            host.timers?.kill(stream.timer);
            stream.timer = 0;
        }
        stream.track?.close?.();
        stream.track = null;
        stream.session?.streams.delete(stream);
    };

    /**
     * An object over a stream, published and written to `out`. A service holds
     * a reference to the client it came from, as on Windows: releasing the
     * client while a service lives leaves it alive, and the stream goes with
     * the client.
     *
     * @param {any} stream @param {import('./objects.js').ComInterfaceDescriptor[]} interfaces
     * @param {number} out @param {import('./objects.js').ComObject} [parent]
     */
    const handOut = (stream, interfaces, out, parent)=>{
        parent?.addRef();
        const object = createComObject(IID_IAUDIO_CLIENT, {
            interfaces, state: stream,
            destroy: ()=>(parent ? parent.release() : close(stream)),
        });
        const pointer = host.vtables.publish(object, interfaces[0].id) >>> 0;
        if (pointer === 0)
        {
            object.release();
            host.writePointer(out, 0);
            return E_OUTOFMEMORY;
        }
        stream.made = object;
        host.writePointer(out, pointer);
        return S_OK;
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const renderClient = {
        id: IID_IAUDIO_RENDER_CLIENT,
        methods: [
            /** HRESULT GetBuffer(UINT32 NumFramesRequested, BYTE **ppData) */
            { name: 'GetBuffer', argBytes: 12, invoke: ({ state: stream }, [frames, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                host.writePointer(out, 0);
                if (stream.held !== null)
                {
                    return AUDCLNT_E_OUT_OF_ORDER;
                }
                if ((frames >>> 0) === 0)
                {
                    return S_OK;
                }
                stream.counts.gets++;
                if ((frames >>> 0) > stream.bufferFrames - padding(stream))
                {
                    stream.counts.refused++;
                    return AUDCLNT_E_BUFFER_TOO_LARGE;
                }
                const bytes = (frames >>> 0) * stream.format.blockAlign;
                host.writeMemory(stream.scratch, new Uint8Array(bytes).fill(stream.silence));
                stream.held = frames >>> 0;
                host.writePointer(out, stream.scratch);
                return S_OK;
            } },
            /** HRESULT ReleaseBuffer(UINT32 NumFramesWritten, DWORD dwFlags) */
            { name: 'ReleaseBuffer', argBytes: 12, invoke: ({ state: stream }, [frames, flags])=>{
                if (stream.held === null)
                {
                    return (frames >>> 0) === 0 ? S_OK : AUDCLNT_E_OUT_OF_ORDER;
                }
                if ((frames >>> 0) > stream.held)
                {
                    return AUDCLNT_E_INVALID_SIZE;
                }
                if (((flags >>> 0) & ~BUFFERFLAGS_SILENT) !== 0)
                {
                    return E_INVALIDARG;
                }
                stream.held = null;
                const bytes = (frames >>> 0) * stream.format.blockAlign;
                if (bytes > 0)
                {
                    const data = ((flags >>> 0) & BUFFERFLAGS_SILENT) !== 0
                        ? new Uint8Array(bytes).fill(stream.silence)
                        : host.readMemory(stream.scratch, bytes).slice();
                    stream.written += frames >>> 0;
                    if (stream.track)
                    {
                        stream.queue.push(data);
                        feed(stream);
                    }
                }
                return S_OK;
            } },
        ],
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const clock = {
        id: IID_IAUDIO_CLOCK,
        methods: [
            /** HRESULT GetFrequency(UINT64 *pu64Frequency): bytes a second, in shared mode. */
            { name: 'GetFrequency', argBytes: 8, invoke: ({ state: stream }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU64(out, stream.format.rate * stream.format.blockAlign);
                return S_OK;
            } },
            /** HRESULT GetPosition(UINT64 *pu64Position, UINT64 *pu64QPCPosition) */
            { name: 'GetPosition', argBytes: 12, invoke: ({ state: stream }, [out, qpc])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU64(out, played(stream) * stream.format.blockAlign);
                if ((qpc >>> 0) !== 0)
                {
                    // In 100 ns units, on the clock everything else reads.
                    writeU64(qpc, host.now() * 10000 + 1);
                }
                return S_OK;
            } },
            /** HRESULT GetCharacteristics(DWORD *pdwCharacteristics) */
            { name: 'GetCharacteristics', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 1); // AUDIOCLOCK_CHARACTERISTIC_FIXED_FREQ
                return S_OK;
            } },
        ],
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const simpleVolume = {
        id: IID_ISIMPLE_AUDIO_VOLUME,
        methods: [
            /** HRESULT SetMasterVolume(float fLevel, LPCGUID EventContext) */
            { name: 'SetMasterVolume', argBytes: 12, floats: { 1: 'f32' },
                invoke: ({ state: { session } }, [bits])=>{
                    const level = floatOf(bits);
                    if (!(level >= 0 && level <= 1))
                    {
                        return E_INVALIDARG;
                    }
                    session.volume = level;
                    session.streams.forEach(applyVolume);
                    return S_OK;
                } },
            /** HRESULT GetMasterVolume(float *pfLevel) */
            { name: 'GetMasterVolume', argBytes: 8, invoke: ({ state: { session } }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_NULL_REFERENCE;
                }
                writeFloat(out, session.volume);
                return S_OK;
            } },
            /** HRESULT SetMute(BOOL bMute, LPCGUID EventContext) */
            { name: 'SetMute', argBytes: 12, invoke: ({ state: { session } }, [mute])=>{
                session.muted = mute !== 0;
                session.streams.forEach(applyVolume);
                return S_OK;
            } },
            /** HRESULT GetMute(BOOL *pbMute) */
            { name: 'GetMute', argBytes: 8, invoke: ({ state: { session } }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_NULL_REFERENCE;
                }
                writeU32(out, session.muted ? 1 : 0);
                return S_OK;
            } },
        ],
    };

    /**
     * IAudioStreamVolume and IChannelAudioVolume: the same five calls over a
     * stream's own channels and over the session's. The session's takes an
     * event context after each level, and refuses a null as a remote call
     * does, where the stream's answers E_POINTER.
     *
     * @param {string} id @param {(stream: any) => number[]} levels @param {number} context
     * @param {number} nullError
     * @returns {import('./objects.js').ComInterfaceDescriptor}
     */
    const channelVolume = (id, levels, context, nullError)=>({
        id,
        methods: [
            /** HRESULT GetChannelCount(UINT32 *pdwCount) */
            { name: 'GetChannelCount', argBytes: 8, invoke: ({ state: stream }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return nullError;
                }
                writeU32(out, levels(stream).length);
                return S_OK;
            } },
            /** HRESULT SetChannelVolume(UINT32 dwIndex, const float fLevel[, LPCGUID]) */
            { name: 'SetChannelVolume', argBytes: 12 + context, invoke: (object, [index, bits])=>{
                const stream = object.state;
                const list = levels(stream);
                const level = floatOf(bits);
                if ((index >>> 0) >= list.length || !(level >= 0 && level <= 1))
                {
                    return E_INVALIDARG;
                }
                list[index >>> 0] = level;
                stream.session.streams.forEach(applyVolume);
                return S_OK;
            } },
            /** HRESULT GetChannelVolume(UINT32 dwIndex, float *pfLevel) */
            { name: 'GetChannelVolume', argBytes: 12, invoke: ({ state: stream }, [index, out])=>{
                const list = levels(stream);
                if ((out >>> 0) === 0)
                {
                    return nullError;
                }
                if ((index >>> 0) >= list.length)
                {
                    return E_INVALIDARG;
                }
                writeFloat(out, list[index >>> 0]);
                return S_OK;
            } },
            /** HRESULT SetAllVolumes(UINT32 dwCount, const float *pfVolumes[, LPCGUID]) */
            { name: 'SetAllVolumes', argBytes: 12 + context, invoke: (object, [count, at])=>{
                const stream = object.state;
                const list = levels(stream);
                if ((at >>> 0) === 0)
                {
                    return nullError;
                }
                if ((count >>> 0) !== list.length)
                {
                    return E_INVALIDARG;
                }
                const wanted = list.map((_, index)=>readFloat((at >>> 0) + index * 4));
                if (!wanted.every(level=>level >= 0 && level <= 1))
                {
                    return E_INVALIDARG;
                }
                wanted.forEach((level, index)=>{
                    list[index] = level;
                });
                stream.session.streams.forEach(applyVolume);
                return S_OK;
            } },
            /** HRESULT GetAllVolumes(UINT32 dwCount, float *pfVolumes) */
            { name: 'GetAllVolumes', argBytes: 12, invoke: ({ state: stream }, [count, at])=>{
                const list = levels(stream);
                if ((at >>> 0) === 0)
                {
                    return nullError;
                }
                if ((count >>> 0) !== list.length)
                {
                    return E_INVALIDARG;
                }
                list.forEach((level, index)=>writeFloat((at >>> 0) + index * 4, level));
                return S_OK;
            } },
        ],
    });
    const streamVolume = channelVolume(IID_IAUDIO_STREAM_VOLUME, stream=>stream.volumes, 0,
        E_POINTER);
    const sessionChannels = channelVolume(IID_ICHANNEL_AUDIO_VOLUME,
        stream=>stream.session.channels, 4, E_NULL_REFERENCE);


    /** A session's identifier. @param {any} session */
    const sessionName = session=>`${endpoint.id}|${host.program?.() ?? ''}%b${session.id}`;

    /**
     * IAudioSessionControl's calls, which IAudioSessionControl2 begins with.
     *
     * @type {import('./objects.js').ComMethod[]}
     */
    const controlMethods = [
        /** HRESULT GetState(AudioSessionState *pRetVal) */
        { name: 'GetState', argBytes: 8, invoke: ({ state: { session } }, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_NULL_REFERENCE;
            }
            const active = [...session.streams].some(one=>one.started);
            writeU32(out, active ? SESSION_ACTIVE : SESSION_INACTIVE);
            return S_OK;
        } },
        /** HRESULT GetDisplayName(LPWSTR *pRetVal) */
        { name: 'GetDisplayName', argBytes: 8,
            invoke: ({ state: { session } }, [out])=>((out >>> 0) === 0 ? E_POINTER
                : handOutString(out, session.name)) },
        /** HRESULT SetDisplayName(LPCWSTR Value, LPCGUID EventContext) */
        { name: 'SetDisplayName', argBytes: 12, invoke: ({ state: { session } }, [text])=>{
            if ((text >>> 0) === 0)
            {
                return E_NULL_REFERENCE;
            }
            session.name = host.readWideString(wholeAddress(text), NAME_BYTES);
            return S_OK;
        } },
        /** HRESULT GetIconPath(LPWSTR *pRetVal) */
        { name: 'GetIconPath', argBytes: 8,
            invoke: ({ state: { session } }, [out])=>((out >>> 0) === 0 ? E_POINTER
                : handOutString(out, session.icon)) },
        /** HRESULT SetIconPath(LPCWSTR Value, LPCGUID EventContext) */
        { name: 'SetIconPath', argBytes: 12, invoke: ({ state: { session } }, [text])=>{
            if ((text >>> 0) === 0)
            {
                return E_NULL_REFERENCE;
            }
            session.icon = host.readWideString(wholeAddress(text), NAME_BYTES);
            return S_OK;
        } },
        /** HRESULT GetGroupingParam(GUID *pRetVal) */
        { name: 'GetGroupingParam', argBytes: 8, invoke: ({ state: { session } }, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_NULL_REFERENCE;
            }
            host.writeMemory(wholeAddress(out), session.grouping);
            return S_OK;
        } },
        /** HRESULT SetGroupingParam(LPCGUID Override, LPCGUID EventContext) */
        { name: 'SetGroupingParam', argBytes: 12, invoke: ({ state: { session } }, [guid])=>{
            if ((guid >>> 0) === 0)
            {
                return E_NULL_REFERENCE;
            }
            session.grouping = host.readMemory(wholeAddress(guid), 16).slice();
            return S_OK;
        } },
        /**
         * HRESULT RegisterAudioSessionNotification(IAudioSessionEvents *NewNotifications):
         * kept; nothing outside the program changes its session here to be told of.
         */
        { name: 'RegisterAudioSessionNotification', argBytes: 8,
            invoke: ({ state: { session } }, [events])=>{
                if ((events >>> 0) === 0)
                {
                    return E_NULL_REFERENCE;
                }
                session.listeners.add(events >>> 0);
                return S_OK;
            } },
        /** HRESULT UnregisterAudioSessionNotification(IAudioSessionEvents *NewNotifications) */
        { name: 'UnregisterAudioSessionNotification', argBytes: 8,
            invoke: ({ state: { session } }, [events])=>{
                if ((events >>> 0) === 0)
                {
                    return E_NULL_REFERENCE;
                }
                return session.listeners.delete(events >>> 0) ? S_OK : E_NOT_FOUND;
            } },
    ];

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const sessionControl = { id: IID_IAUDIO_SESSION_CONTROL, methods: controlMethods };
    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const sessionControl2 = {
        id: IID_IAUDIO_SESSION_CONTROL2,
        methods: [...controlMethods,
            /**
             * HRESULT GetSessionIdentifier(LPWSTR *pRetVal): the endpoint, then the
             * program as the object manager names it and the session's GUID, as
             * Windows writes it.
             */
            { name: 'GetSessionIdentifier', argBytes: 8,
                invoke: ({ state: { session } }, [out])=>((out >>> 0) === 0 ? E_POINTER
                    : handOutString(out, sessionName(session))) },
            /** HRESULT GetSessionInstanceIdentifier(LPWSTR *pRetVal): that, and this process. */
            { name: 'GetSessionInstanceIdentifier', argBytes: 8,
                invoke: ({ state: { session } }, [out])=>((out >>> 0) === 0 ? E_POINTER
                    : handOutString(out,
                        `${sessionName(session)}|1%b${host.processId?.() ?? 0}`)) },
            /** HRESULT GetProcessId(DWORD *pRetVal) */
            { name: 'GetProcessId', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, host.processId?.() ?? 0);
                return S_OK;
            } },
            /** HRESULT IsSystemSoundsSession(void): a program's session never is. */
            { name: 'IsSystemSoundsSession', argBytes: 4, invoke: ()=>S_FALSE },
            /** HRESULT SetDuckingPreference(BOOL optOut) */
            { name: 'SetDuckingPreference', argBytes: 8, invoke: ()=>S_OK },
        ],
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const clockAdjustment = {
        id: IID_IAUDIO_CLOCK_ADJUSTMENT,
        methods: [
            /** HRESULT SetSampleRate(float flSampleRate) */
            { name: 'SetSampleRate', argBytes: 8, floats: { 1: 'f32' },
                invoke: ({ state: stream }, [bits])=>{
                    if (!stream.initialized)
                    {
                        return AUDCLNT_E_NOT_INITIALIZED;
                    }
                    if ((stream.flags & STREAMFLAGS_RATEADJUST) === 0)
                    {
                        return AUDCLNT_E_WRONG_ENDPOINT_TYPE;
                    }
                    const rate = floatOf(bits);
                    if (!(rate > 0))
                    {
                        return E_INVALIDARG;
                    }
                    played(stream);
                    stream.rate = rate;
                    stream.track?.retune?.(rate);
                    return S_OK;
                } },
        ],
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const client = {
        id: IID_IAUDIO_CLIENT,
        methods: [
            /**
             * HRESULT Initialize(AUDCLNT_SHAREMODE ShareMode, DWORD StreamFlags,
             *     REFERENCE_TIME hnsBufferDuration, REFERENCE_TIME hnsPeriodicity,
             *     const WAVEFORMATEX *pFormat, LPCGUID AudioSessionGuid)
             */
            { name: 'Initialize', argBytes: 36, quadwords: [3, 5], invoke: (object, args)=>{
                const stream = object.state;
                const [mode, flags, durationLow, durationHigh, , , format, session] = args;
                if ((format >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if ((mode >>> 0) > SHAREMODE_EXCLUSIVE || ((flags >>> 0) & ~KNOWN_FLAGS) !== 0)
                {
                    return E_INVALIDARG;
                }
                if ((mode >>> 0) === SHAREMODE_EXCLUSIVE
                    && ((flags >>> 0) & STREAMFLAGS_AUTOCONVERTPCM) !== 0)
                {
                    return E_INVALIDARG;
                }
                if (stream.initialized)
                {
                    return AUDCLNT_E_ALREADY_INITIALIZED;
                }
                if ((mode >>> 0) === SHAREMODE_EXCLUSIVE)
                {
                    return AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED;
                }
                if (((flags >>> 0) & STREAMFLAGS_LOOPBACK) !== 0)
                {
                    // Recording what the endpoint plays: nothing here records.
                    host.divergence?.('IAudioClient::Initialize',
                        'a loopback stream is refused: nothing records here');
                    return AUDCLNT_E_ENDPOINT_CREATE_FAILED;
                }
                const read = readStreamFormat(host.readMemory, format);
                const compatible = ((flags >>> 0) & STREAMFLAGS_AUTOCONVERTPCM) !== 0
                    || read.channels === endpoint.channels
                        && (read.rate === endpoint.rate
                            || ((flags >>> 0) & STREAMFLAGS_RATEADJUST) !== 0);
                const valid = validateFormat(read, compatible);
                if (valid !== S_OK)
                {
                    return valid;
                }
                const duration = Number(BigInt.asIntN(64,
                    (BigInt(durationHigh >>> 0) << 32n) | BigInt(durationLow >>> 0)));
                const least = Math.ceil(MINIMUM_PERIODS * DEFAULT_PERIOD * read.rate / 1e7);
                const frames = Math.max(least, Math.floor(Math.max(0, duration) * read.rate / 1e7));
                const scratch = host.heap.allocate(frames * read.blockAlign);
                if (scratch === 0)
                {
                    return E_OUTOFMEMORY;
                }
                Object.assign(stream, {
                    initialized: true, flags: flags >>> 0, format: read, rate: read.rate,
                    bufferFrames: frames, scratch, silence: read.bits === 8 ? 0x80 : 0,
                    volumes: new Array(read.channels).fill(1),
                });
                stream.track = host.output?.()?.open({
                    sampleRate: read.rate, channels: read.channels, bitsPerSample: read.bits,
                    ...read.tag === WAVE_FORMAT_IEEE_FLOAT ? { float: true } : {},
                }) ?? null;
                if (stream.track)
                {
                    stream.track.paused = true;
                }
                stream.session = sessionOf((session >>> 0) === 0 ? GUID_NULL
                    : guidAt(host.readMemory, session));
                stream.session.streams.add(stream);
                applyVolume(stream);
                return S_OK;
            } },
            /** HRESULT GetBufferSize(UINT32 *pNumBufferFrames) */
            { name: 'GetBufferSize', argBytes: 8, invoke: ({ state: stream }, [out])=>{
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, stream.bufferFrames);
                return S_OK;
            } },
            /** HRESULT GetStreamLatency(REFERENCE_TIME *phnsLatency) */
            { name: 'GetStreamLatency', argBytes: 8, invoke: ({ state: stream }, [out])=>{
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU64(out, DEFAULT_PERIOD);
                return S_OK;
            } },
            /** HRESULT GetCurrentPadding(UINT32 *pNumPaddingFrames) */
            { name: 'GetCurrentPadding', argBytes: 8, invoke: ({ state: stream }, [out])=>{
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const frames = padding(stream);
                stream.counts.paddings++;
                stream.counts.paddingSum += frames;
                writeU32(out, frames);
                return S_OK;
            } },
            /**
             * HRESULT IsFormatSupported(AUDCLNT_SHAREMODE ShareMode,
             *     const WAVEFORMATEX *pFormat, WAVEFORMATEX **ppClosestMatch)
             */
            { name: 'IsFormatSupported', argBytes: 16, invoke: (_, [mode, format, closest])=>{
                if ((closest >>> 0) !== 0)
                {
                    host.writePointer(closest, 0);
                }
                if ((format >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if ((mode >>> 0) === SHAREMODE_EXCLUSIVE)
                {
                    return AUDCLNT_E_EXCLUSIVE_MODE_NOT_ALLOWED;
                }
                if ((mode >>> 0) !== SHAREMODE_SHARED)
                {
                    return E_INVALIDARG;
                }
                if ((closest >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const read = readStreamFormat(host.readMemory, format);
                const valid = validateFormat(read, true);
                if (valid !== S_OK)
                {
                    return valid;
                }
                if (read.rate === endpoint.rate && read.channels === endpoint.channels)
                {
                    return S_OK;
                }
                const at = taskMixFormat();
                if (at === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writePointer(closest, at);
                return S_FALSE;
            } },
            /** HRESULT GetMixFormat(WAVEFORMATEX **ppDeviceFormat) */
            { name: 'GetMixFormat', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const at = taskMixFormat();
                host.writePointer(out, at);
                return at === 0 ? E_OUTOFMEMORY : S_OK;
            } },
            /**
             * HRESULT GetDevicePeriod(REFERENCE_TIME *phnsDefaultDevicePeriod,
             *     REFERENCE_TIME *phnsMinimumDevicePeriod)
             */
            { name: 'GetDevicePeriod', argBytes: 12, invoke: (_, [byDefault, least])=>{
                if ((byDefault >>> 0) === 0 && (least >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if ((byDefault >>> 0) !== 0)
                {
                    writeU64(byDefault, DEFAULT_PERIOD);
                }
                if ((least >>> 0) !== 0)
                {
                    writeU64(least, MINIMUM_PERIOD);
                }
                return S_OK;
            } },
            /** HRESULT Start(void) */
            { name: 'Start', argBytes: 4, invoke: ({ state: stream })=>{
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if (stream.started)
                {
                    return AUDCLNT_E_NOT_STOPPED;
                }
                if ((stream.flags & STREAMFLAGS_EVENTCALLBACK) !== 0 && stream.event === 0)
                {
                    return AUDCLNT_E_EVENTHANDLE_NOT_SET;
                }
                played(stream);
                stream.started = true;
                stream.since = host.now();
                if (stream.track)
                {
                    stream.track.paused = false;
                }
                if (stream.event !== 0 && stream.timer === 0)
                {
                    // Twice a period, the event set when a period's room is there
                    // (`engineTick`).
                    const half = Math.max(1, Math.round(DEFAULT_PERIOD / 20000));
                    stream.timer = host.timers?.set(half, stream.event, 0,
                        TIME_PERIODIC | TIME_CALLBACK_EVENT_SET, ()=>engineTick(stream)) ?? 0;
                    if (stream.timer === 0)
                    {
                        host.divergence?.('IAudioClient::Start',
                            'no timer was left to set the stream\'s event every period');
                    }
                }
                return S_OK;
            } },
            /** HRESULT Stop(void) */
            { name: 'Stop', argBytes: 4, invoke: ({ state: stream })=>{
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if (!stream.started)
                {
                    return S_FALSE;
                }
                played(stream);
                stream.started = false;
                if (stream.track)
                {
                    stream.track.paused = true;
                }
                return S_OK;
            } },
            /** HRESULT Reset(void) */
            { name: 'Reset', argBytes: 4, invoke: ({ state: stream })=>{
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if (stream.started)
                {
                    return AUDCLNT_E_NOT_STOPPED;
                }
                if (stream.held !== null)
                {
                    return AUDCLNT_E_BUFFER_OPERATION_PENDING;
                }
                stream.queue = [];
                stream.track?.reset?.();
                stream.written = 0;
                stream.clockFrames = 0;
                return S_OK;
            } },
            /** HRESULT SetEventHandle(HANDLE eventHandle) */
            { name: 'SetEventHandle', argBytes: 8, invoke: ({ state: stream }, [event])=>{
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if ((event >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if ((stream.flags & STREAMFLAGS_EVENTCALLBACK) === 0)
                {
                    return AUDCLNT_E_EVENTHANDLE_NOT_EXPECTED;
                }
                if (stream.event !== 0)
                {
                    return E_EVENT_ALREADY_SET;
                }
                stream.event = event >>> 0;
                return S_OK;
            } },
            /** HRESULT GetService(REFIID riid, void **ppv) */
            { name: 'GetService', argBytes: 12, invoke: (object, [iid, out])=>{
                const stream = object.state;
                if ((out >>> 0) !== 0)
                {
                    host.writePointer(out, 0);
                }
                if (!stream.initialized)
                {
                    return AUDCLNT_E_NOT_INITIALIZED;
                }
                if ((iid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const wanted = guidAt(host.readMemory, iid);
                const service = [renderClient, clock, simpleVolume, streamVolume, sessionChannels]
                    .find(one=>one.id === wanted);
                if (service)
                {
                    return handOut(stream, [service], out, object);
                }
                if (wanted === IID_IAUDIO_SESSION_CONTROL)
                {
                    // One control a client, handed out again while it lives: its
                    // session's volume and channels are interfaces of it too.
                    const held = stream.control;
                    if (held && !held.destroyed)
                    {
                        held.addRef();
                        host.writePointer(out,
                            host.vtables.publish(held, IID_IAUDIO_SESSION_CONTROL));
                        return S_OK;
                    }
                    const answer = handOut(stream, [sessionControl, sessionControl2, simpleVolume,
                        sessionChannels], out, object);
                    stream.control = answer === S_OK ? stream.made : null;
                    return answer;
                }
                if (wanted === IID_IAUDIO_CLOCK_ADJUSTMENT)
                {
                    // The client's own interface, there only for a stream whose
                    // rate may be adjusted.
                    if ((stream.flags & STREAMFLAGS_RATEADJUST) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    object.addRef();
                    host.writePointer(out,
                        host.vtables.publish(object, IID_IAUDIO_CLOCK_ADJUSTMENT));
                    return S_OK;
                }
                return wanted === IID_IAUDIO_CAPTURE_CLIENT ? AUDCLNT_E_WRONG_ENDPOINT_TYPE
                    : E_NOINTERFACE;
            } },
        ],
    };


    /**
     * An object over a session rather than a stream, as the session manager
     * hands them out: `state.session` is all its calls read.
     *
     * @param {any} session @param {import('./objects.js').ComInterfaceDescriptor[]} interfaces
     * @param {number} out
     */
    const handOutSession = (session, interfaces, out)=>{
        const object = createComObject(IID_IAUDIO_CLIENT, { interfaces, state: { session } });
        const pointer = host.vtables.publish(object, interfaces[0].id) >>> 0;
        if (pointer === 0)
        {
            object.release();
            host.writePointer(out, 0);
            return E_OUTOFMEMORY;
        }
        host.writePointer(out, pointer);
        return S_OK;
    };
    /** The session a manager's call names: GUID_NULL, or none, is the default one. @param {number} at */
    const namedSession = at=>sessionOf((at >>> 0) === 0 ? GUID_NULL : guidAt(host.readMemory, at));
    /** The session interfaces a control is made of, whoever hands it out. */
    const controlInterfaces = ()=>[sessionControl, sessionControl2, simpleVolume, sessionChannels];

    /**
     * IAudioSessionManager's calls, which IAudioSessionManager2 begins with.
     *
     * @type {import('./objects.js').ComMethod[]}
     */
    const managerMethods = [
        /**
         * HRESULT GetAudioSessionControl(LPCGUID AudioSessionGuid, DWORD StreamFlags,
         *     IAudioSessionControl **SessionControl)
         */
        { name: 'GetAudioSessionControl', argBytes: 16,
            invoke: (_, [guid, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return handOutSession(namedSession(guid), controlInterfaces(), out);
            } },
        /**
         * HRESULT GetSimpleAudioVolume(LPCGUID AudioSessionGuid, DWORD StreamFlags,
         *     ISimpleAudioVolume **AudioVolume)
         */
        { name: 'GetSimpleAudioVolume', argBytes: 16,
            invoke: (_, [guid, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return handOutSession(namedSession(guid), [simpleVolume], out);
            } },
    ];

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const sessionEnumerator = {
        id: IID_IAUDIO_SESSION_ENUMERATOR,
        methods: [
            /** HRESULT GetCount(int *SessionCount) */
            { name: 'GetCount', argBytes: 8, invoke: ({ state }, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, state.session.length);
                return S_OK;
            } },
            /** HRESULT GetSession(int SessionCount, IAudioSessionControl **Session) */
            { name: 'GetSession', argBytes: 12, invoke: ({ state }, [index, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if ((index >>> 0) >= state.session.length)
                {
                    host.writePointer(out, 0);
                    return E_INVALIDARG;
                }
                return handOutSession(state.session[index >>> 0], controlInterfaces(), out);
            } },
        ],
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const sessionManager = { id: IID_IAUDIO_SESSION_MANAGER, methods: managerMethods };
    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const sessionManager2 = {
        id: IID_IAUDIO_SESSION_MANAGER2,
        methods: [...managerMethods,
            /**
             * HRESULT GetSessionEnumerator(IAudioSessionEnumerator **SessionEnum): the
             * sessions as they are now; one made later is not in it.
             */
            { name: 'GetSessionEnumerator', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return handOutSession([...sessions.values()], [sessionEnumerator], out);
            } },
            /** HRESULT RegisterSessionNotification(IAudioSessionNotification *SessionNotification) */
            { name: 'RegisterSessionNotification', argBytes: 8,
                invoke: (_, [sink])=>((sink >>> 0) === 0 ? E_POINTER : S_OK) },
            /** HRESULT UnregisterSessionNotification(IAudioSessionNotification *SessionNotification) */
            { name: 'UnregisterSessionNotification', argBytes: 8,
                invoke: (_, [sink])=>((sink >>> 0) === 0 ? E_POINTER : S_OK) },
            /** HRESULT RegisterDuckNotification(LPCWSTR sessionID, IAudioVolumeDuckNotification *) */
            { name: 'RegisterDuckNotification', argBytes: 12,
                invoke: (_, [, sink])=>((sink >>> 0) === 0 ? E_POINTER : S_OK) },
            /** HRESULT UnregisterDuckNotification(IAudioVolumeDuckNotification *duckNotification) */
            { name: 'UnregisterDuckNotification', argBytes: 8,
                invoke: (_, [sink])=>((sink >>> 0) === 0 ? E_POINTER : S_OK) },
        ],
    };

    return {
        /** Every stream's track played at the volumes again: the endpoint's changed. */
        refreshVolumes(){
            for (const session of sessions.values())
            {
                session.streams.forEach(applyVolume);
            }
        },
        /**
         * The endpoint's session manager written to `out`.
         *
         * @param {number} out
         */
        manager: out=>handOutSession(null, [sessionManager, sessionManager2], out),
        /**
         * A new, uninitialized client written to `out`.
         *
         * @param {number} out
         */
        activate(out){
            const stream = {
                initialized: false, started: false, flags: 0, format: null, rate: 0,
                bufferFrames: 0, scratch: 0, silence: 0, held: null, written: 0,
                clockFrames: 0, since: 0, event: 0, timer: 0, track: null,
                /** GetBuffer asked and refused for room, GetCurrentPadding asked and what it summed. */
                counts: { gets: 0, refused: 0, paddings: 0, paddingSum: 0 },
                /** @type {Uint8Array[]} */
                queue: [],
                /** @type {number[]} */
                volumes: [],
                /** @type {any} */
                session: null,
                /** The session control this client handed out. @type {any} */
                control: null,
                /** @type {any} */
                made: null,
            };
            streams.add(stream);
            return handOut(stream, [client, clockAdjustment], out);
        },

        /**
         * Each initialized stream: its rate and buffer, what was released and
         * played, what waits for the track, and how the program asked for room.
         */
        diagnostics: ()=>[...streams].filter(stream=>stream.initialized).map(stream=>({
            rate: stream.format.rate, bufferFrames: stream.bufferFrames,
            event: stream.event !== 0, started: stream.started, written: stream.written,
            played: stream.track ? Math.floor(stream.track.playedBytes()
                / stream.format.blockAlign) : Math.floor(stream.clockFrames),
            trackPending: stream.track?.pending() ?? null,
            queuedBytes: stream.queue.reduce((/** @type {number} */ sum,
                /** @type {Uint8Array} */ chunk)=>sum + chunk.length, 0),
            ...stream.counts,
        })),
    };
}

/**
 * A GUID at an address, in the registry's form.
 *
 * @param {(address: number, length: number) => Uint8Array} read
 * @param {number} at
 */
export function guidAt(read, at){
    return formatGuid(read(wholeAddress(at), 16));
}
