/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a program reaches DirectSound: the library it links against, the vtables
 * it calls through, and the structures that cross between.
 *
 * The shape here is the one the drawing layer's seam already uses -- interfaces
 * declared as an ordered list of slots, one adapter per object so that identity
 * survives, and a DLL table shaped like a win32 library's so the caller
 * assembling the process binds it with no special case. It is not *imported*
 * from there: this layer declares `win32`, `bridge` and `memory` in its
 * requires and not `graphics`, so reaching into that directory would be a
 * dependency the module graph does not admit. The adapter below is the twenty
 * lines that duplication costs.
 *
 * Two rules carry over unchanged, and both are enforced by the tests beside
 * this file:
 *
 * - **Every slot is listed, including the ones nothing implements.** A method
 *   with no implementation answers an error a program handles; a method left
 *   out shifts every later slot up one and breaks all of them silently.
 * - **`argBytes` counts the interface pointer.** A COM method is stdcall,
 *   and the bridge has the
 *   callee pop everything but `this`, so a miscount returns to a wrong address
 *   rather than returning a wrong value.
 */

import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { createSoundBuffer, normaliseFormat, DSBSTATUS_PLAYING } from './buffers.js';

export const DS_OK = 0;
const DS_UNCERTIFIED = 1;
const DSERR_INVALIDPARAM = 0x80070057 | 0;
const DSERR_OUTOFMEMORY = 0x8007000e | 0;
const DSERR_UNSUPPORTED = 0x80004001 | 0;
const DSERR_INVALIDCALL = 0x88780032 | 0;
const DSERR_CONTROLUNAVAIL = 0x8878001e | 0;

/** DSBCAPS flags a program sets when it describes a buffer it wants. */
const DSBCAPS_PRIMARYBUFFER = 0x00000001;
const DSBCAPS_LOCHARDWARE = 0x00000004;
const DSBCAPS_LOCSOFTWARE = 0x00000008;
const DSBCAPS_CTRL3D = 0x00000010;
const DSBCAPS_CTRLFREQUENCY = 0x00000020;
const DSBCAPS_CTRLPAN = 0x00000040;
const DSBCAPS_CTRLVOLUME = 0x00000080;
const DSBCAPS_CTRLPOSITIONNOTIFY = 0x00000100;
const DSBCAPS_CTRLFX = 0x00000200;

/** Interface identifiers. Facts about somebody else's ABI; there is no partial credit. */
export const IID_IDirectSound = '{279AFA83-4981-11CE-A521-0020AF0BE560}';
export const IID_IDirectSound8 = '{C50A7E93-F395-4834-9EF6-7FA99DE50966}';
export const IID_IDirectSoundBuffer = '{279AFA85-4981-11CE-A521-0020AF0BE560}';
export const IID_IDirectSoundBuffer8 = '{6825A449-7524-4D82-920F-50E36AB3AB1E}';
export const IID_IDirectSoundNotify = '{B0210783-89CD-11D0-AF08-00A0C925CD16}';
export const IID_IDirectSound3DListener = '{279AFA84-4981-11CE-A521-0020AF0BE560}';
export const IID_IDirectSound3DBuffer = '{279AFA86-4981-11CE-A521-0020AF0BE560}';

/** WAVEFORMATEX. The two-byte fields are why this is not a table of dwords. */
export const WAVEFORMATEX = Object.freeze({
    wFormatTag: 0x00,
    nChannels: 0x02,
    nSamplesPerSec: 0x04,
    nAvgBytesPerSec: 0x08,
    nBlockAlign: 0x0c,
    wBitsPerSample: 0x0e,
    cbSize: 0x10,
    SIZE: 0x12,
});

/**
 * DSBUFFERDESC.
 *
 * DirectX 8 appends a 3D algorithm GUID, so the structure is either twenty
 * bytes or thirty-six and the caller says which in its first field. Nothing
 * before that moves, so both are read the same way and only the trailing field
 * is conditional.
 */
export const DSBUFFERDESC = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwBufferBytes: 0x08,
    dwReserved: 0x0c,
    lpwfxFormat: 0x10,
    guid3DAlgorithm: 0x14,
    SIZE: 0x14,
    SIZE_DX8: 0x24,
});

/** DSBCAPS, which a program reads back to learn what it actually got. */
export const DSBCAPS = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwBufferBytes: 0x08,
    dwUnlockTransferRate: 0x0c,
    dwPlayCpuOverhead: 0x10,
    SIZE: 0x14,
});

/**
 * DSCAPS. Only the first few fields are filled; the rest exist to place them.
 *
 * Twenty-four dwords, which is ninety-six bytes and not a hundred. The size is
 * the one field a program fills in before the call, and it is checked against
 * this: too large a figure here refuses every correctly-filled structure, which
 * is what a sound library reads as "there is no DirectSound on this machine".
 */
export const DSCAPS = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwMinSecondarySampleRate: 0x08,
    dwMaxSecondarySampleRate: 0x0c,
    dwPrimaryBuffers: 0x10,
    dwMaxHwMixingAllBuffers: 0x14,
    dwMaxHwMixingStaticBuffers: 0x18,
    dwMaxHwMixingStreamingBuffers: 0x1c,
    dwFreeHwMixingAllBuffers: 0x20,
    dwFreeHwMixingStaticBuffers: 0x24,
    dwFreeHwMixingStreamingBuffers: 0x28,
    dwMaxHw3DAllBuffers: 0x2c,
    dwMaxHw3DStaticBuffers: 0x30,
    dwMaxHw3DStreamingBuffers: 0x34,
    dwFreeHw3DAllBuffers: 0x38,
    dwFreeHw3DStaticBuffers: 0x3c,
    dwFreeHw3DStreamingBuffers: 0x40,
    dwTotalHwMemBytes: 0x44,
    dwFreeHwMemBytes: 0x48,
    dwMaxContigFreeHwMemBytes: 0x4c,
    dwUnlockTransferRateHwBuffers: 0x50,
    dwPlayCpuOverheadSwBuffers: 0x54,
    dwReserved1: 0x58,
    dwReserved2: 0x5c,
    SIZE: 0x60,
});

/**
 * DSCAPS.dwFlags -- what the device says it can play.
 *
 * A program reads these before it decides how to open anything, so a device
 * that names none of them has said it can play neither mono nor stereo,
 * neither eight bits nor sixteen. There is nothing left for a caller to ask
 * for, and a sound library reads that as a device it cannot drive.
 */
export const DSCAPS_FLAGS = Object.freeze({
    PRIMARYMONO: 0x00000001,
    PRIMARYSTEREO: 0x00000002,
    PRIMARY8BIT: 0x00000004,
    PRIMARY16BIT: 0x00000008,
    CONTINUOUSRATE: 0x00000010,
    EMULDRIVER: 0x00000020,
    CERTIFIED: 0x00000040,
    SECONDARYMONO: 0x00000100,
    SECONDARYSTEREO: 0x00000200,
    SECONDARY8BIT: 0x00000400,
    SECONDARY16BIT: 0x00000800,
});

/**
 * The DSCAPS fields this device reports as zero.
 *
 * Everything about hardware mixing and hardware sound memory: there is none,
 * and a program that asks is entitled to be told so rather than to read
 * whatever its own stack happened to hold.
 */
const ZEROED_CAPS = Object.freeze([
    DSCAPS.dwMaxHwMixingAllBuffers, DSCAPS.dwMaxHwMixingStaticBuffers,
    DSCAPS.dwMaxHwMixingStreamingBuffers, DSCAPS.dwFreeHwMixingAllBuffers,
    DSCAPS.dwFreeHwMixingStaticBuffers, DSCAPS.dwFreeHwMixingStreamingBuffers,
    DSCAPS.dwMaxHw3DAllBuffers, DSCAPS.dwMaxHw3DStaticBuffers,
    DSCAPS.dwMaxHw3DStreamingBuffers, DSCAPS.dwFreeHw3DAllBuffers,
    DSCAPS.dwFreeHw3DStaticBuffers, DSCAPS.dwFreeHw3DStreamingBuffers,
    DSCAPS.dwTotalHwMemBytes, DSCAPS.dwFreeHwMemBytes,
    DSCAPS.dwMaxContigFreeHwMemBytes, DSCAPS.dwUnlockTransferRateHwBuffers,
    DSCAPS.dwPlayCpuOverheadSwBuffers, DSCAPS.dwReserved1, DSCAPS.dwReserved2,
]);

/**
 * Which ordinal is which export, for a program that links DSOUND.dll by
 * number: Windows' own, and only for the entry points this table has -- a
 * number bound to nothing is a call that binds and then jumps into nowhere.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const DSOUND_ORDINALS = Object.freeze({
    1: 'DirectSoundCreate',
    2: 'DirectSoundEnumerateA',
    3: 'DirectSoundEnumerateW',
    6: 'DirectSoundCaptureCreate',
    11: 'DirectSoundCreate8',
    12: 'DirectSoundCaptureCreate8',
});

/** DSBPOSITIONNOTIFY, one per position a program wants to be told about. */
export const DSBPOSITIONNOTIFY = Object.freeze({
    dwOffset: 0x00,
    hEventNotify: 0x04,
    SIZE: 0x08,
});

/** IDirectSound, after IUnknown's three. */
export const IDIRECTSOUND_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateSoundBuffer', 3],
    ['GetCaps', 1],
    ['DuplicateSoundBuffer', 2],
    ['SetCooperativeLevel', 2],
    ['Compact', 0],
    ['GetSpeakerConfig', 1],
    ['SetSpeakerConfig', 1],
    ['Initialize', 1],
]);

/** IDirectSound8 is IDirectSound with one appended. */
export const IDIRECTSOUND8_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTSOUND_SLOTS,
    ['VerifyCertification', 1],
]);

/**
 * IDirectSoundBuffer, after IUnknown's three.
 *
 * The order is alphabetical for the getters and then not, which looks like a
 * mistake and is not: it is the order the header declares, and the header is
 * what a program was compiled against.
 */
export const IDIRECTSOUNDBUFFER_SLOTS = /** @type {[string, number][]} */ ([
    ['GetCaps', 1],
    ['GetCurrentPosition', 2],
    ['GetFormat', 3],
    ['GetVolume', 1],
    ['GetPan', 1],
    ['GetFrequency', 1],
    ['GetStatus', 1],
    ['Initialize', 2],
    ['Lock', 7],
    ['Play', 3],
    ['SetCurrentPosition', 1],
    ['SetFormat', 1],
    ['SetVolume', 1],
    ['SetPan', 1],
    ['SetFrequency', 1],
    ['Stop', 0],
    ['Unlock', 4],
    ['Restore', 0],
]);

/** IDirectSoundBuffer8 is the same interface with three appended. */
export const IDIRECTSOUNDBUFFER8_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTSOUNDBUFFER_SLOTS,
    ['SetFX', 3],
    ['AcquireResources', 3],
    ['GetObjectInPath', 4],
]);

/** IDirectSoundNotify, after IUnknown's three. */
export const IDIRECTSOUNDNOTIFY_SLOTS = /** @type {[string, number][]} */ ([
    ['SetNotificationPositions', 2],
]);

/**
 * Builds an interface descriptor from `[name, argumentCount]` pairs.
 *
 * The count excludes `this`, because that is how a header reads and
 * transcribing a header is what these lists are.
 *
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (target: any, args: number[]) => number>} [implemented]
 */
export function describe(id, slots, implemented = {}){
    return {
        id,
        methods: slots.map(([name, args])=>({
            name,
            argBytes: 4 + args * 4,
            invoke: implemented[name],
        })),
    };
}

/**
 * One method list per interface descriptor, shared by every object that
 * exposes it, as a compiled program shares one vtable among all instances of
 * a class. The publisher keys its table of stubs by the list's identity, so a
 * list built afresh for each object was a table of stubs per object -- and
 * the stubs come out of a table of sixteen thousand, which a program making a
 * thousand textures had used up. Each method is reached through the adapter
 * the call arrived on, which is what makes one list serve every object.
 *
 * @type {WeakMap<any, any[]>}
 */
const methodLists = new WeakMap();
/** IUnknown alone, one list for everyone: it names no method of the object's own. */
const IUNKNOWN_ONLY = Object.freeze([...IUNKNOWN_METHODS]);

/** @param {any} descriptor */
function methodsFor(descriptor){
    let methods = methodLists.get(descriptor);
    if (!methods)
    {
        methods = [
            ...IUNKNOWN_METHODS,
            ...descriptor.methods.map((/** @type {any} */ method)=>({
                name: method.name,
                argBytes: method.argBytes,
                invoke: method.invoke
                    ? (/** @type {any} */ adapter, /** @type {number[]} */ args)=>
                        method.invoke(adapter.api, args) ?? 0
                    : undefined,
            })),
        ];
        methodLists.set(descriptor, methods);
    }
    return methods;
}


/**
 * One adapter per object, so that one object is one identity.
 *
 * The publisher memoises by object reference; two adapters for one buffer are
 * two identities, and a program comparing interface pointers then believes it
 * holds two buffers.
 *
 * @param {Object} deps
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 */
export function createPublisher({ publishInterface }){
    const adapters = new WeakMap();
    /** @type {Map<number, any>} */
    const byPointer = new Map();
    let published = 0;
    /**
     * Interfaces asked for and not answered, by id. A program that wanted
     * one it did not get takes another path silently, and which one it wanted
     * is the only trace of that decision.
     *
     * @type {Record<string, number>}
     */
    const refused = {};

    /** @param {any} api @param {any[]} interfaces */
    const adapterFor = (api, interfaces)=>{
        let adapter = adapters.get(api);
        if (!adapter)
        {
            const declared = new Map(interfaces.map(entry=>[entry.id, entry]));
            adapter = {
                api,
                /** @param {string} id */
                interfaceFor(id){
                    if (id === IID_IUNKNOWN)
                    {
                        return { id, methods: IUNKNOWN_ONLY };
                    }
                    const descriptor = declared.get(id);
                    if (!descriptor)
                    {
                        refused[id] = (refused[id] ?? 0) + 1;
                        return null;
                    }
                    return { id, methods: methodsFor(descriptor) };
                },
                addRef: ()=>api.addRef?.() ?? 1,
                release: ()=>api.release?.() ?? 0,
                // Whether the bridge keeps the pointer at a count of zero: a
                // primary buffer lives as long as its device does.
                reachable: ()=>api.reachable?.() ?? false,
                // One count for every interface an object answers to, so its
                // last reference ends them all; `reachable` still keeps each.
                get destroyed(){
                    return api.destroyed === true;
                },
            };
            adapters.set(api, adapter);
        }
        return adapter;
    };

    return {
        /** @param {any} api @param {any[]} interfaces @param {string} id */
        publish(api, interfaces, id){
            const pointer = publishInterface(adapterFor(api, interfaces), id);
            if (pointer !== 0)
            {
                byPointer.set(pointer >>> 0, api);
                published++;
            }
            return pointer;
        },
        /** @param {number} pointer */
        objectAt: pointer=>((pointer >>> 0) === 0
            ? null
            : byPointer.get(pointer >>> 0) ?? null),
        count: ()=>published,
        /** Interface ids asked for and refused, with counts. */
        refused: ()=>({ ...refused }),
    };
}

/**
 * The DirectSound library and everything behind it.
 *
 * @param {Object} deps
 * @param {any} deps.memory   readMemory/writeMemory over guest memory.
 * @param {(bytes: number) => number} deps.allocate  Guest memory for a buffer's samples.
 * @param {() => number} deps.now   The guest's clock, in milliseconds.
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 * @param {(event: number) => void} [deps.signal]  Signals an event a notification names.
 * @param {(entry: number, args: number[], thread?: any) => Promise<number>} [deps.callGuest]
 *        Runs a guest routine and answers with what it returned. A sound
 *        library of this era hands the system a callback and expects it run
 *        before the call returns, so a table without this route cannot answer
 *        those calls truthfully.
 * @param {() => unknown} [deps.callerThread]
 *        Whose call `EnumDevices` is answering, named before the loop's first
 *        await: a second callback is a call made after that await, by when
 *        the thread on the processor may no longer be this one.
 */
export function createDirectSound(
    { memory, allocate, now, publishInterface, signal, callGuest, callerThread },
)
{
    const publisher = createPublisher({ publishInterface });

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = memory.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address */
    const readU16 = address=>{
        const bytes = memory.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return;
        }
        memory.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @type {any[]} */
    const buffers = [];
    // How often a program drove each buffer method. A sound that is never heard
    // and a sound that is played and dropped on the way to the mixer look the
    // same from outside, and this is the first thing that tells them apart.
    /** @type {Record<string, number>} */
    const calls = {};
    // The last calls in order, with the detail that says why a sound starts and
    // dies: Play's loop flag, what GetCurrentPosition handed back, where Stop
    // left the cursor. Totals cannot show a sequence, and the sequence is what
    // a program's own sound engine decided.
    /** @type {string[]} */
    const events = [];
    /** Every buffer asked for, with its flags and the answer; kept whole. */
    /** @type {string[]} */
    const creations = [];
    /** @param {string} line */
    const record = line=>{
        events.push(line);
        if (events.length > 48)
        {
            events.shift();
        }
    };
    /**
     * The last level a program asked for. DSSCL_NORMAL is 1, and the levels
     * above it are what Windows requires before the primary format may be set.
     */
    let cooperativeLevel = 0;

    /**
     * Delivers whatever notifications a buffer's cursor has passed.
     *
     * Called from every entry point that touches a buffer rather than from a
     * timer, for the reason the streaming path already has: a program that
     * polls instead of waiting never reaches a timer, and its notifications
     * would never fire.
     *
     * @param {any} buffer
     */
    const deliver = buffer=>{
        for (const event of buffer.drainNotifications())
        {
            signal?.(event);
        }
    };

    /** @param {number} address @returns {import('./buffers.js').SoundFormat | null} */
    const readFormat = address=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        return normaliseFormat({
            channels: readU16(address + WAVEFORMATEX.nChannels),
            sampleRate: readU32(address + WAVEFORMATEX.nSamplesPerSec),
            bitsPerSample: readU16(address + WAVEFORMATEX.wBitsPerSample),
        });
    };

    /** @param {number} address @param {import('./buffers.js').SoundFormat} format */
    const writeFormat = (address, format)=>{
        const bytes = new Uint8Array(WAVEFORMATEX.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(WAVEFORMATEX.wFormatTag, 1, true); // WAVE_FORMAT_PCM
        view.setUint16(WAVEFORMATEX.nChannels, format.channels, true);
        view.setUint32(WAVEFORMATEX.nSamplesPerSec, format.sampleRate, true);
        view.setUint32(WAVEFORMATEX.nAvgBytesPerSec,
            format.sampleRate * format.blockAlign, true);
        view.setUint16(WAVEFORMATEX.nBlockAlign, format.blockAlign, true);
        view.setUint16(WAVEFORMATEX.wBitsPerSample, format.bitsPerSample, true);
        view.setUint16(WAVEFORMATEX.cbSize, 0, true);
        memory.writeMemory(address >>> 0, bytes);
    };

    // Described once: the bridge shares one table of stubs per method list, and
    // a list per buffer was a table per buffer. Built on first use, because the
    // methods it names are defined below.
    /** @type {{ buffer: any, buffer8: any, notify: any } | null} */
    let describedBuffer = null;
    const bufferDescriptors = ()=>describedBuffer ??= {
        buffer: describe(IID_IDirectSoundBuffer, IDIRECTSOUNDBUFFER_SLOTS, bufferMethods),
        buffer8: describe(IID_IDirectSoundBuffer8, IDIRECTSOUNDBUFFER8_SLOTS, bufferMethods),
        notify: describe(IID_IDirectSoundNotify, IDIRECTSOUNDNOTIFY_SLOTS, notifyMethods),
    };
    /**
     * What one buffer answers QueryInterface for. IDirectSoundNotify only when
     * it was created to notify: a program asks for it to learn which kind of
     * buffer it holds, and E_NOINTERFACE is the answer for one that is not.
     *
     * IID_IDirectSound3DBuffer is deliberately absent: nothing here positions
     * a sound, and an interface declared with no methods answers
     * QueryInterface with a table that ends after IUnknown -- the program then
     * calls slot 3 and jumps off the end of it. E_NOINTERFACE is an answer a
     * program handles; a short vtable is not.
     *
     * @param {any} buffer
     */
    const bufferInterfaces = buffer=>{
        const { buffer: base, buffer8, notify } = bufferDescriptors();
        return [
            base,
            // The primary buffer is the one IDirectSoundBuffer8 is not.
            ...buffer.primary ? [] : [buffer8],
            ...(buffer.capabilities & DSBCAPS_CTRLPOSITIONNOTIFY) !== 0 ? [notify] : [],
        ];
    };

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const notifyMethods = {
        /** HRESULT SetNotificationPositions(DWORD count, LPCDSBPOSITIONNOTIFY) */
        SetNotificationPositions(buffer, [count, array]){
            const wanted = count >>> 0;
            if (wanted > 0 && (array >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            const positions = [];
            for (let at = 0; at < wanted; at++)
            {
                const entry = (array >>> 0) + at * DSBPOSITIONNOTIFY.SIZE;
                positions.push({
                    offset: readU32(entry + DSBPOSITIONNOTIFY.dwOffset),
                    event: readU32(entry + DSBPOSITIONNOTIFY.hEventNotify),
                });
            }
            buffer.setNotifications(positions);
            return DS_OK;
        },
    };

    /**
     * Whether a buffer has a control: only if it was created with it, which is
     * what a program checks GetCaps for before touching one. The primary
     * buffer is the device's output and has no rate of its own to change.
     *
     * @param {any} buffer @param {number} flag
     */
    const hasControl = (buffer, flag)=>(buffer.capabilities & flag) !== 0
        && !(buffer.primary && flag === DSBCAPS_CTRLFREQUENCY);

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const bufferMethods = {
        /** HRESULT GetCurrentPosition(LPDWORD play, LPDWORD write) */
        GetCurrentPosition(buffer, [play, write]){
            calls.GetCurrentPosition = (calls.GetCurrentPosition || 0) + 1;
            deliver(buffer);
            const { play: at, write: ahead } = buffer.cursors();
            writeU32(play, at);
            writeU32(write, ahead);
            record(`b${buffers.indexOf(buffer)} GetPos p=${at} w=${ahead} st=${buffer.status()}`);
            return DS_OK;
        },

        /** HRESULT GetStatus(LPDWORD status) */
        GetStatus(buffer, [status]){
            deliver(buffer);
            if ((status >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(status, buffer.status());
            return DS_OK;
        },

        /** HRESULT Play(DWORD reserved, DWORD priority, DWORD flags) */
        Play(buffer, [, , flags]){
            calls.Play = (calls.Play || 0) + 1;
            record(`b${buffers.indexOf(buffer)} Play loop=${(flags >>> 0) & 1} n=${buffer.bytes}`);
            buffer.play(flags >>> 0);
            return DS_OK;
        },

        /** HRESULT Stop(void) */
        Stop(buffer){
            calls.Stop = (calls.Stop || 0) + 1;
            buffer.stop();
            // After the stop, so the call itself sets DSBPN_OFFSETSTOP: a
            // program stops a buffer and at once waits to be told it has.
            deliver(buffer);
            record(`b${buffers.indexOf(buffer)} Stop cursor=${buffer.cursors().play}`);
            return DS_OK;
        },

        /** HRESULT SetCurrentPosition(DWORD position) */
        SetCurrentPosition(buffer, [position]){
            buffer.setCurrentPosition(position);
            record(`b${buffers.indexOf(buffer)} SetPos ${position >>> 0}`);
            return DS_OK;
        },

        /**
         * HRESULT Lock(DWORD offset, DWORD bytes, LPVOID* p1, LPDWORD n1,
         *              LPVOID* p2, LPDWORD n2, DWORD flags)
         */
        Lock(buffer, [offset, bytes, p1, n1, p2, n2, flags]){
            calls.Lock = (calls.Lock || 0) + 1;
            record(`b${buffers.indexOf(buffer)} Lock off=${offset >>> 0} bytes=${bytes >>> 0}`);
            if ((p1 >>> 0) === 0 || (n1 >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            deliver(buffer);
            const { first, second } = buffer.lockRange(offset, bytes, flags >>> 0);
            writeU32(p1, first.address);
            writeU32(n1, first.bytes);
            // The second range is written whenever the caller offered somewhere
            // to put it, zero included: a caller that passed pointers and reads
            // a stale value there splices audio from a previous lock.
            writeU32(p2, second.address);
            writeU32(n2, second.bytes);
            return DS_OK;
        },

        /** HRESULT Unlock(LPVOID p1, DWORD n1, LPVOID p2, DWORD n2) */
        Unlock(buffer){
            record(`b${buffers.indexOf(buffer)} Unlock`);
            return buffer.unlock() ? DS_OK : DSERR_INVALIDCALL;
        },

        /** HRESULT GetCaps(LPDSBCAPS caps) */
        GetCaps(buffer, [caps]){
            if ((caps >>> 0) === 0 || readU32(caps + DSBCAPS.dwSize) < DSBCAPS.SIZE)
            {
                return DSERR_INVALIDPARAM;
            }
            // What the program asked for, which is what it branches on before
            // touching a control, and where the buffer is mixed. That is in
            // software unless it asked for hardware and was given it: a
            // buffer is in one place or the other, never neither.
            writeU32(caps + DSBCAPS.dwFlags, buffer.primary
                || (buffer.capabilities & DSBCAPS_LOCHARDWARE) !== 0
                ? buffer.capabilities
                : buffer.capabilities | DSBCAPS_LOCSOFTWARE);
            writeU32(caps + DSBCAPS.dwBufferBytes, buffer.bytes);
            writeU32(caps + DSBCAPS.dwUnlockTransferRate, 0);
            writeU32(caps + DSBCAPS.dwPlayCpuOverhead, 0);
            return DS_OK;
        },

        /**
         * HRESULT SetFormat(LPCWAVEFORMATEX)
         *
         * How a program says what the mix should run at, and it is asked of the
         * primary buffer alone -- a secondary one's format is fixed when it is
         * created, and DirectSound refuses this on one. Refusing it on the
         * primary as well is what a sound library reads as a device it cannot
         * drive: it releases everything and falls back to wave-out, which is
         * how a game ends up with no DirectSound at all.
         */
        SetFormat(buffer, [format]){
            if (!buffer.primary)
            {
                return DSERR_INVALIDCALL;
            }
            const wanted = readFormat(format);
            if (!wanted)
            {
                return DSERR_INVALIDPARAM;
            }
            buffer.setFormat(wanted);
            return DS_OK;
        },

        /** HRESULT GetFormat(LPWAVEFORMATEX, DWORD size, LPDWORD written) */
        GetFormat(buffer, [format, size, written]){
            if ((format >>> 0) !== 0)
            {
                if ((size >>> 0) < WAVEFORMATEX.SIZE)
                {
                    return DSERR_INVALIDPARAM;
                }
                writeFormat(format, buffer.format);
            }
            // Optional, and a caller that wants only the structure passes null
            // for it -- which is what Miles passes. Writing through it anyway
            // puts four bytes at address zero.
            if ((written >>> 0) !== 0)
            {
                writeU32(written, WAVEFORMATEX.SIZE);
            }
            return DS_OK;
        },

        /** HRESULT GetVolume(LPLONG) */
        GetVolume(buffer, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (!hasControl(buffer, DSBCAPS_CTRLVOLUME))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            writeU32(out, buffer.volume);
            return DS_OK;
        },
        /** HRESULT SetVolume(LONG) */
        SetVolume(buffer, [value]){
            if (!hasControl(buffer, DSBCAPS_CTRLVOLUME))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            buffer.setVolume(value | 0);
            return DS_OK;
        },
        /** HRESULT GetPan(LPLONG) */
        GetPan(buffer, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (!hasControl(buffer, DSBCAPS_CTRLPAN))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            writeU32(out, buffer.pan);
            return DS_OK;
        },
        /** HRESULT SetPan(LONG) */
        SetPan(buffer, [value]){
            if (!hasControl(buffer, DSBCAPS_CTRLPAN))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            buffer.setPan(value | 0);
            return DS_OK;
        },
        /** HRESULT GetFrequency(LPDWORD) */
        GetFrequency(buffer, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (!hasControl(buffer, DSBCAPS_CTRLFREQUENCY))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            writeU32(out, buffer.frequency);
            return DS_OK;
        },
        /** HRESULT SetFrequency(DWORD) */
        SetFrequency(buffer, [hz]){
            if (!hasControl(buffer, DSBCAPS_CTRLFREQUENCY))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            buffer.setFrequency(hz >>> 0);
            return DS_OK;
        },

        /**
         * HRESULT SetFX(DWORD count, LPDSEFFECTDESC effects, LPDWORD results)
         *
         * Effects are a control like volume and pan, and a buffer created
         * without it refuses them as it would refuse either. With it, the
         * arguments are checked and clearing a chain that was never set is
         * done; setting one answers E_NOTIMPL, because no effect is hosted.
         */
        SetFX(buffer, [count, effects, results]){
            if ((buffer.capabilities & DSBCAPS_CTRLFX) === 0)
            {
                return DSERR_CONTROLUNAVAIL;
            }
            // A count names that many descriptions; none names none, and a
            // result array with nothing to report on is a caller's mistake.
            if ((count >>> 0) === 0
                ? (effects >>> 0) !== 0 || (results >>> 0) !== 0
                : (effects >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (buffer.locked || (buffer.status() & DSBSTATUS_PLAYING) !== 0)
            {
                return DSERR_INVALIDCALL;
            }
            return (count >>> 0) === 0 ? DS_OK : DSERR_UNSUPPORTED;
        },

        /**
         * HRESULT Restore(void)
         *
         * Nothing here loses a buffer -- the samples are in guest memory and
         * stay there -- so this succeeds. It exists because a program that has
         * seen DSBSTATUS_BUFFERLOST calls it before writing again, and one that
         * never sees that status still calls it after regaining focus.
         */
        Restore(){
            return DS_OK;
        },
    };

    /** @param {any} buffer */
    const publishBuffer = buffer=>
        publisher.publish(buffer, bufferInterfaces(buffer), IID_IDirectSoundBuffer);

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const soundMethods = {
        /** HRESULT CreateSoundBuffer(LPCDSBUFFERDESC, LPDIRECTSOUNDBUFFER*, IUnknown*) */
        CreateSoundBuffer(root, [descriptor, out]){
            if ((descriptor >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            // One of the two layouts, or a caller that disagrees with us about
            // where every later field is.
            const size = readU32(descriptor + DSBUFFERDESC.dwSize);
            if (size !== DSBUFFERDESC.SIZE && size !== DSBUFFERDESC.SIZE_DX8)
            {
                writeU32(out, 0);
                return DSERR_INVALIDPARAM;
            }
            const flags = readU32(descriptor + DSBUFFERDESC.dwFlags);
            const primary = (flags & DSBCAPS_PRIMARYBUFFER) !== 0;
            const wanted = readU32(descriptor + DSBUFFERDESC.dwBufferBytes);
            const formatAt = readU32(descriptor + DSBUFFERDESC.lpwfxFormat);
            const format = readFormat(formatAt);
            const asked = `CreateSoundBuffer flags=0x${(flags >>> 0).toString(16)} bytes=${wanted}`
                + ` fmt=${format ? `${format.sampleRate}/${format.bitsPerSample}/${format.channels}` : '-'}`;
            record(asked);
            creations.push(asked);

            // The primary buffer's format is the device's, set afterwards
            // through SetFormat; a description that names one is refused.
            if (primary && formatAt !== 0)
            {
                writeU32(out, 0);
                return DSERR_INVALIDPARAM;
            }

            // A device has one primary buffer, and asking again hands it out
            // again with its count raised; the new description is ignored, as
            // DirectSound's own debug output says it is.
            if (primary && root.primary)
            {
                root.primary.addRef();
                writeU32(out, publishBuffer(root.primary));
                return DS_OK;
            }

            // A primary buffer names no size and no format: it is the mix
            // target, and a program creates one only to set the format the
            // hardware runs at. A secondary one without a size is a caller's
            // mistake.
            if (!primary && (wanted === 0 || !format))
            {
                writeU32(out, 0);
                return DSERR_INVALIDPARAM;
            }
            // DirectSound 8's rule, not the older interface's, which makes
            // both: a sound placed in space is one point, so it is mono and
            // has no pan of its own.
            if (root.eight && !primary && (flags & DSBCAPS_CTRL3D) !== 0
                && ((flags & DSBCAPS_CTRLPAN) !== 0 || format?.channels !== 1))
            {
                writeU32(out, 0);
                return DSERR_INVALIDPARAM;
            }

            const resolved = format ?? normaliseFormat({});
            // Up to a whole frame, as DirectSound does: every cursor and every
            // read is frame-aligned, and a lap that ends part way through a
            // frame starts the next one reading its samples out of step.
            const bytes = primary
                ? resolved.blockAlign * resolved.sampleRate
                : Math.ceil(wanted / resolved.blockAlign) * resolved.blockAlign;
            const address = allocate(bytes);
            if (address === 0)
            {
                writeU32(out, 0);
                return DSERR_OUTOFMEMORY;
            }

            const buffer = createSoundBuffer({
                bytes, address, format: resolved, now, primary, capabilities: flags,
                // The device's own, which the program can ask for again after
                // releasing every reference it had.
                kept: primary ? ()=>root.references > 0 : undefined,
            });
            buffers.push(buffer);
            if (primary)
            {
                root.primary = buffer;
            }
            writeU32(out, publishBuffer(buffer));
            return DS_OK;
        },

        /** HRESULT DuplicateSoundBuffer(LPDIRECTSOUNDBUFFER, LPDIRECTSOUNDBUFFER*) */
        DuplicateSoundBuffer(root, [original, out]){
            const source = publisher.objectAt(original);
            if (!source || (out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            // The primary buffer is the device's output, and there is one.
            if (source.primary)
            {
                return DSERR_INVALIDCALL;
            }
            // A duplicate shares its original's samples and has its own
            // cursors and volume. Sharing the address is the whole point: a
            // program duplicates a sound to play it twice at once without
            // paying for the audio twice.
            const copy = createSoundBuffer({
                bytes: source.bytes,
                address: source.address,
                format: source.format,
                now,
                capabilities: source.capabilities,
            });
            buffers.push(copy);
            writeU32(out, publishBuffer(copy));
            return DS_OK;
        },

        /**
         * HRESULT SetCooperativeLevel(HWND, DWORD)
         *
         * Which program owns the device, on a machine where only one program
         * runs. Recorded and otherwise inert.
         */
        SetCooperativeLevel(root, [, level]){
            cooperativeLevel = level >>> 0;
            record(`SetCooperativeLevel ${cooperativeLevel}`);
            // Recorded and not enforced. Windows refuses SetFormat on the
            // primary buffer below DSSCL_PRIORITY and this does not: a program
            // that sets the mix format without asking for the right to gets it
            // anyway. Nothing here is shared with another program, so the
            // permission it is really asking for is not ours to withhold -- but
            // it is a difference from the real thing, and this layer has no
            // reporter to say so through yet.
            return DS_OK;
        },

        /** HRESULT GetCaps(LPDSCAPS) */
        GetCaps(root, [caps]){
            record('GetCaps');
            if ((caps >>> 0) === 0 || readU32(caps + DSCAPS.dwSize) < DSCAPS.SIZE)
            {
                return DSERR_INVALIDPARAM;
            }
            // What this device can play, which is everything: the mixer behind
            // it converts whatever a program opens. Naming none of these -- as
            // this did -- says the opposite, that it can play neither mono nor
            // stereo and neither eight bits nor sixteen, and a sound library
            // reading that has nothing left to ask for. Miles asked, was told
            // there was nothing, and went away without opening a single buffer.
            writeU32(caps + DSCAPS.dwFlags,
                DSCAPS_FLAGS.PRIMARYMONO | DSCAPS_FLAGS.PRIMARYSTEREO
                | DSCAPS_FLAGS.PRIMARY8BIT | DSCAPS_FLAGS.PRIMARY16BIT
                | DSCAPS_FLAGS.SECONDARYMONO | DSCAPS_FLAGS.SECONDARYSTEREO
                | DSCAPS_FLAGS.SECONDARY8BIT | DSCAPS_FLAGS.SECONDARY16BIT
                // Any rate, because resampling is what the mixer does anyway.
                //
                // Not EMULDRIVER. That flag meant the wave-out emulation of a
                // system with no DirectSound driver at all, and no working
                // device of the last two decades reports it. A sound
                // middleware reading it concludes DirectSound is not really
                // there, mixes through wave-out instead, and refuses every
                // positional provider that needs the DirectSound path -- which
                // is the whole of a title's effects, silently.
                | DSCAPS_FLAGS.CONTINUOUSRATE);
            writeU32(caps + DSCAPS.dwMinSecondarySampleRate, 100);
            writeU32(caps + DSCAPS.dwMaxSecondarySampleRate, 100000);
            writeU32(caps + DSCAPS.dwPrimaryBuffers, 1);
            // Every remaining field written, because a field left alone is one
            // the caller reads out of its own uninitialised memory. Zero is the
            // honest answer to all of them: nothing here is mixed in hardware,
            // so there are no hardware voices and no sound memory to report.
            for (const field of ZEROED_CAPS)
            {
                writeU32(caps + field, 0);
            }
            return DS_OK;
        },

        /** HRESULT Compact(void) */
        Compact(){
            return DS_OK;
        },

        /** HRESULT GetSpeakerConfig(LPDWORD) */
        GetSpeakerConfig(root, [out]){
            record('GetSpeakerConfig');
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(out, 0x00000002); // DSSPEAKER_STEREO
            return DS_OK;
        },
        /** HRESULT SetSpeakerConfig(DWORD) */
        SetSpeakerConfig(){
            return DS_OK;
        },
        /** HRESULT Initialize(LPCGUID) */
        Initialize(){
            return DS_OK;
        },

        /**
         * HRESULT VerifyCertification(LPDWORD)
         *
         * DS_UNCERTIFIED, the answer GetCaps already gives by leaving out
         * DSCAPS_CERTIFIED: there is no driver behind this device to certify.
         */
        VerifyCertification(root, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(out, DS_UNCERTIFIED);
            return DS_OK;
        },
    };

    const soundInterfaces = [describe(IID_IDirectSound, IDIRECTSOUND_SLOTS, soundMethods)];
    const sound8Interfaces = [
        ...soundInterfaces,
        describe(IID_IDirectSound8, IDIRECTSOUND8_SLOTS, soundMethods),
    ];

    /**
     * A new object for every call, as on Windows, each counting its own
     * references. DirectSoundCreate's is IDirectSound and refuses
     * IDirectSound8; DirectSoundCreate8's is both, published as the one the
     * entry point promises, so a program calls it through IDirectSound8's
     * table, slot eleven included, without asking for it again.
     *
     * The count is a real one: the bridge frees an interface pointer whose
     * release answers zero, so a zero while the program holds another
     * reference frees a pointer it is still using.
     *
     * @param {number} out @param {boolean} eight
     */
    const createInto = (out, eight)=>{
        if ((out >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        let references = 1;
        const device = {
            addRef: ()=>++references,
            release: ()=>(references = Math.max(0, references - 1)),
            get references(){
                return references;
            },
            get destroyed(){
                return references === 0;
            },
            eight,
            /**
             * This object's primary buffer, once asked for: another object's
             * is another buffer (Wine's dsound test_primary_independent).
             *
             * @type {any}
             */
            primary: null,
        };
        writeU32(out, eight
            ? publisher.publish(device, sound8Interfaces, IID_IDirectSound8)
            : publisher.publish(device, soundInterfaces, IID_IDirectSound));
        return DS_OK;
    };

    /**
     * Puts a string where guest code can read it, in the width the caller of
     * the A or W entry point expects, and answers with its address.
     *
     * @param {string} text @param {boolean} wide
     * @returns {number}
     */
    const stringForGuest = (text, wide)=>{
        const units = wide ? 2 : 1;
        const bytes = new Uint8Array((text.length + 1) * units);
        for (let index = 0; index < text.length; index++)
        {
            const code = text.charCodeAt(index);
            bytes[index * units] = code & 0xff;
            if (wide)
            {
                bytes[index * units + 1] = code >>> 8 & 0xff;
            }
        }
        const address = allocate(bytes.length);
        memory.writeMemory(address, bytes);
        return address;
    };

    /** How many times a program has asked what sound devices there are. */
    let enumerations = 0;

    /**
     * Describes the devices to a program's own callback, as Windows does.
     *
     * The primary driver comes first and always, with a null GUID -- that entry
     * is what a program takes as "this machine can play sound", and a machine
     * with hardware then describes each device after it. One device follows
     * here because that is what this engine has: a single output that whoever
     * assembles it opened.
     *
     * The callback is guest code, so answering means running the guest from
     * inside a host call; the bridge parks the caller while that happens, and
     * this returns a promise it hands back rather than a value.
     *
     * @param {number} callback @param {number} context @param {boolean} wide
     */
    const enumerate = (callback, context, wide)=>{
        if ((callback >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        enumerations++;
        if (!callGuest)
        {
            // No route to guest code -- a test harness, or an engine assembled
            // without a bridge. Saying so is better than reporting no devices,
            // which a program reads as a machine that cannot play sound.
            return DS_OK;
        }
        const primary = stringForGuest('Primary Sound Driver', wide);
        const blank = stringForGuest('', wide);
        const device = stringForGuest('Bottlify Audio', wide);
        // A GUID is sixteen bytes and a program keeps it to open that device by
        // name later; every guid opens the same output here, so its contents
        // only have to be stable and not null.
        const guid = allocate(16);
        memory.writeMemory(guid, new Uint8Array([
            0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        ]));
        // Named once, before the loop's first await -- see the parameter doc.
        const thread = callerThread?.();
        return (async()=>{
            // TRUE asks for the next one, and a program that has seen enough
            // says FALSE -- so a caller that stops early is obeyed rather than
            // handed a list it did not want.
            const more = await callGuest(
                callback >>> 0, [0, primary, blank, context >>> 0], thread);
            if ((more | 0) !== 0)
            {
                await callGuest(callback >>> 0, [guid, device, blank, context >>> 0], thread);
            }
            return DS_OK;
        })();
    };

    return {
        publisher,
        /** How many times a program asked what sound devices there are. */
        enumerations: ()=>enumerations,
        /** For tests and for whoever wants to look at a buffer without a guest. */
        buffers: ()=>buffers,

        /**
         * Drops every buffer the program has fully released (`references`
         * reached zero, and for a primary buffer its device gone as well)
         * from the walk. Without this, a buffer a program
         * created, played and released stays in this array for the rest of
         * the session -- harmless on its own, but every caller that walks
         * `buffers()` once a turn was walking a list that only ever grew.
         */
        pruneReleased(){
            for (let at = buffers.length - 1; at >= 0; at--)
            {
                if (!buffers[at].reachable())
                {
                    buffers.splice(at, 1);
                }
            }
        },

        /** What a program last asked for, for whoever is measuring. */
        cooperativeLevel: ()=>cooperativeLevel,

        libraries: {
            'DSOUND.dll': {
                /** HRESULT DirectSoundCreate(LPCGUID, LPDIRECTSOUND*, IUnknown*) */
                DirectSoundCreate: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([, out])=>createInto(out, false),
                },
                /** HRESULT DirectSoundCreate8(LPCGUID, LPDIRECTSOUND8*, IUnknown*) */
                DirectSoundCreate8: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([, out])=>createInto(out, true),
                },
                /**
                 * HRESULT DirectSoundEnumerateA(LPDSENUMCALLBACKA, LPVOID)
                 *
                 * Windows always describes the primary driver first, with a
                 * null GUID, before any device of its own -- so a program that
                 * counts the callbacks and gets none concludes the machine has
                 * no sound hardware at all. Succeeding while calling back never
                 * is therefore not a harmless simplification: it is an answer,
                 * and the answer is "there is nothing here".
                 */
                DirectSoundEnumerateA: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([callback, context])=>enumerate(callback, context, false),
                },
                DirectSoundEnumerateW: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([callback, context])=>enumerate(callback, context, true),
                },
                /** HRESULT DirectSoundCaptureCreate(...) — there is no capture device. */
                DirectSoundCaptureCreate: { argBytes: 12, handler: ()=>DSERR_UNSUPPORTED },
                DirectSoundCaptureCreate8: { argBytes: 12, handler: ()=>DSERR_UNSUPPORTED },
                /** HRESULT DllGetClassObject / DllCanUnloadNow, which COM asks for. */
                DllCanUnloadNow: { argBytes: 0, handler: ()=>DS_OK },
            },
        },

        /** The numbers `libraries` is imported by, keyed the same way. */
        ordinals: { 'DSOUND.dll': DSOUND_ORDINALS },

        diagnostics: ()=>({
            buffers: buffers.length,
            calls,
            events: [...events],
            refusedInterfaces: publisher.refused(),
            creations: [...creations],
            cooperativeLevel,
            // Asking what devices there are and being told none is how a
            // program concludes the machine cannot play sound, so how often it
            // asked is worth seeing beside what it did next.
            enumerations,
            playing: buffers.filter(buffer=>(buffer.status() & 1) !== 0).length,
            published: publisher.count(),
            // Bytes the mixer was handed that the program had not written
            // since they were last played: a looping buffer whose refill came
            // late, heard as a short repeat. Per buffer as well, because the
            // one that streams music is the one that matters.
            staleBytes: buffers.reduce((sum, buffer)=>sum + buffer.stale.bytes, 0),
            staleDrains: buffers.reduce((sum, buffer)=>sum + buffer.stale.drains, 0),
            staleByBuffer: buffers.map(buffer=>buffer.stale.bytes),
            // The host times of the last ones, merged across buffers.
            staleAt: buffers.flatMap(buffer=>buffer.stale.at).sort((a, b)=>a - b).slice(-64),
            // The last repeat of the buffer that repeated most, with the
            // unlocks that led up to it (`buffers.js`, `trail`).
            staleTrail: [...buffers].sort((a, b)=>b.stale.bytes - a.stale.bytes)[0]
                ?.stale.trail ?? [],
            // And the cause, counted where it happens: a refill that began
            // past where the previous one ended, leaving a lap-old region in
            // between for the mixer to play.
            skippedBytes: buffers.reduce((sum, buffer)=>sum + buffer.skipped.bytes, 0),
            skips: buffers.reduce((sum, buffer)=>sum + buffer.skipped.count, 0),
        }),
    };
}
