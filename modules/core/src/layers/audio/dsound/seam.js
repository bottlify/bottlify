/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
 * - **`argBytes` counts `this`.** These are thiscall, and the bridge has the
 *   callee pop everything but `this`, so a miscount returns to a wrong address
 *   rather than returning a wrong value.
 */

import { IUNKNOWN_METHODS, IID_IUNKNOWN } from '../../win32/ole32/objects.js';
import { createSoundBuffer, normaliseFormat } from './buffers.js';

export const DS_OK = 0;
const DSERR_INVALIDPARAM = 0x80070057 | 0;
const DSERR_OUTOFMEMORY = 0x8007000e | 0;
const DSERR_UNSUPPORTED = 0x80004001 | 0;
const DSERR_INVALIDCALL = 0x88780032 | 0;

/** DSBCAPS flags a program sets when it describes a buffer it wants. */
const DSBCAPS_PRIMARYBUFFER = 0x00000001;

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

/** DSCAPS. Only the first few fields are filled; the rest exist to place them. */
export const DSCAPS = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwMinSecondarySampleRate: 0x08,
    dwMaxSecondarySampleRate: 0x0c,
    dwPrimaryBuffers: 0x10,
    dwMaxHwMixingAllBuffers: 0x14,
    SIZE: 0x64,
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
                    const descriptor = id === IID_IUNKNOWN
                        ? { id, methods: [] }
                        : declared.get(id);
                    if (!descriptor)
                    {
                        return null;
                    }
                    return {
                        id,
                        methods: [
                            ...IUNKNOWN_METHODS,
                            ...descriptor.methods.map((/** @type {any} */ method)=>({
                                name: method.name,
                                argBytes: method.argBytes,
                                invoke: method.invoke
                                    ? (/** @type {any} */ unused, /** @type {number[]} */ args)=>
                                        method.invoke(api, args)
                                    : undefined,
                            })),
                        ],
                    };
                },
                addRef: ()=>api.addRef?.() ?? 1,
                release: ()=>api.release?.() ?? 0,
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
 */
export function createDirectSound({ memory, allocate, now, publishInterface, signal }){
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

    const bufferInterfaces = ()=>[
        describe(IID_IDirectSoundBuffer, IDIRECTSOUNDBUFFER_SLOTS, bufferMethods),
        describe(IID_IDirectSoundBuffer8, IDIRECTSOUNDBUFFER8_SLOTS, bufferMethods),
        describe(IID_IDirectSoundNotify, IDIRECTSOUNDNOTIFY_SLOTS, notifyMethods),
        // IID_IDirectSound3DBuffer is deliberately absent: nothing here
        // positions a sound, and an interface declared with no methods answers
        // QueryInterface with a table that ends after IUnknown -- the program
        // then calls slot 3 and jumps off the end of it. E_NOINTERFACE is an
        // answer a program handles; a short vtable is not.
    ];

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const notifyMethods = {
        /** HRESULT SetNotificationPositions(DWORD count, LPCDSBPOSITIONNOTIFY) */
        SetNotificationPositions(buffer, [, count, array]){
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

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const bufferMethods = {
        /** HRESULT GetCurrentPosition(LPDWORD play, LPDWORD write) */
        GetCurrentPosition(buffer, [, play, write]){
            deliver(buffer);
            const { play: at, write: ahead } = buffer.cursors();
            writeU32(play, at);
            writeU32(write, ahead);
            return DS_OK;
        },

        /** HRESULT GetStatus(LPDWORD status) */
        GetStatus(buffer, [, status]){
            deliver(buffer);
            if ((status >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(status, buffer.status());
            return DS_OK;
        },

        /** HRESULT Play(DWORD reserved, DWORD priority, DWORD flags) */
        Play(buffer, [, , , flags]){
            buffer.play(flags >>> 0);
            return DS_OK;
        },

        /** HRESULT Stop(void) */
        Stop(buffer){
            deliver(buffer);
            buffer.stop();
            return DS_OK;
        },

        /** HRESULT SetCurrentPosition(DWORD position) */
        SetCurrentPosition(buffer, [, position]){
            buffer.setCurrentPosition(position);
            return DS_OK;
        },

        /**
         * HRESULT Lock(DWORD offset, DWORD bytes, LPVOID* p1, LPDWORD n1,
         *              LPVOID* p2, LPDWORD n2, DWORD flags)
         */
        Lock(buffer, [, offset, bytes, p1, n1, p2, n2, flags]){
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
            return buffer.unlock() ? DS_OK : DSERR_INVALIDCALL;
        },

        /** HRESULT GetCaps(LPDSBCAPS caps) */
        GetCaps(buffer, [, caps]){
            if ((caps >>> 0) === 0 || readU32(caps + DSBCAPS.dwSize) < DSBCAPS.SIZE)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(caps + DSBCAPS.dwFlags, buffer.primary ? DSBCAPS_PRIMARYBUFFER : 0);
            writeU32(caps + DSBCAPS.dwBufferBytes, buffer.bytes);
            writeU32(caps + DSBCAPS.dwUnlockTransferRate, 0);
            writeU32(caps + DSBCAPS.dwPlayCpuOverhead, 0);
            return DS_OK;
        },

        /** HRESULT GetFormat(LPWAVEFORMATEX, DWORD size, LPDWORD written) */
        GetFormat(buffer, [, format, size, written]){
            if ((format >>> 0) !== 0)
            {
                if ((size >>> 0) < WAVEFORMATEX.SIZE)
                {
                    return DSERR_INVALIDPARAM;
                }
                writeFormat(format, buffer.format);
            }
            writeU32(written, WAVEFORMATEX.SIZE);
            return DS_OK;
        },

        /** HRESULT GetVolume(LPLONG) */
        GetVolume(buffer, [, out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(out, buffer.volume);
            return DS_OK;
        },
        /** HRESULT SetVolume(LONG) */
        SetVolume(buffer, [, value]){
            buffer.setVolume(value | 0);
            return DS_OK;
        },
        /** HRESULT GetPan(LPLONG) */
        GetPan(buffer, [, out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(out, buffer.pan);
            return DS_OK;
        },
        /** HRESULT SetPan(LONG) */
        SetPan(buffer, [, value]){
            buffer.setPan(value | 0);
            return DS_OK;
        },
        /** HRESULT GetFrequency(LPDWORD) */
        GetFrequency(buffer, [, out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(out, buffer.frequency);
            return DS_OK;
        },
        /** HRESULT SetFrequency(DWORD) */
        SetFrequency(buffer, [, hz]){
            buffer.setFrequency(hz >>> 0);
            return DS_OK;
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
        publisher.publish(buffer, bufferInterfaces(), IID_IDirectSoundBuffer);

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const soundMethods = {
        /** HRESULT CreateSoundBuffer(LPCDSBUFFERDESC, LPDIRECTSOUNDBUFFER*, IUnknown*) */
        CreateSoundBuffer(root, [, descriptor, out]){
            if ((descriptor >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            const flags = readU32(descriptor + DSBUFFERDESC.dwFlags);
            const primary = (flags & DSBCAPS_PRIMARYBUFFER) !== 0;
            const wanted = readU32(descriptor + DSBUFFERDESC.dwBufferBytes);
            const format = readFormat(readU32(descriptor + DSBUFFERDESC.lpwfxFormat));

            // A primary buffer names no size and no format: it is the mix
            // target, and a program creates one only to set the format the
            // hardware runs at. A secondary one without a size is a caller's
            // mistake.
            if (!primary && (wanted === 0 || !format))
            {
                writeU32(out, 0);
                return DSERR_INVALIDPARAM;
            }

            const resolved = format ?? normaliseFormat({});
            const bytes = primary ? resolved.blockAlign * resolved.sampleRate : wanted;
            const address = allocate(bytes);
            if (address === 0)
            {
                writeU32(out, 0);
                return DSERR_OUTOFMEMORY;
            }

            const buffer = createSoundBuffer({
                bytes, address, format: resolved, now, primary,
            });
            buffers.push(buffer);
            writeU32(out, publishBuffer(buffer));
            return DS_OK;
        },

        /** HRESULT DuplicateSoundBuffer(LPDIRECTSOUNDBUFFER, LPDIRECTSOUNDBUFFER*) */
        DuplicateSoundBuffer(root, [, original, out]){
            const source = publisher.objectAt(original);
            if (!source || (out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
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
        SetCooperativeLevel(){
            return DS_OK;
        },

        /** HRESULT GetCaps(LPDSCAPS) */
        GetCaps(root, [, caps]){
            if ((caps >>> 0) === 0 || readU32(caps + DSCAPS.dwSize) < DSCAPS.SIZE)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(caps + DSCAPS.dwFlags, 0);
            writeU32(caps + DSCAPS.dwMinSecondarySampleRate, 100);
            writeU32(caps + DSCAPS.dwMaxSecondarySampleRate, 100000);
            writeU32(caps + DSCAPS.dwPrimaryBuffers, 1);
            writeU32(caps + DSCAPS.dwMaxHwMixingAllBuffers, 0);
            return DS_OK;
        },

        /** HRESULT Compact(void) */
        Compact(){
            return DS_OK;
        },

        /** HRESULT GetSpeakerConfig(LPDWORD) */
        GetSpeakerConfig(root, [, out]){
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
    };

    /**
     * The one object a program is handed by the entry point.
     *
     * There is only ever one: DirectSoundCreate on a machine with one device
     * hands out the same device, and a program that creates two and compares
     * them is entitled to find them equal.
     */
    const root = { addRef: ()=>1, release: ()=>0 };
    const rootInterfaces = [
        describe(IID_IDirectSound, IDIRECTSOUND_SLOTS, soundMethods),
        // Same shape: IDirectSound8's first eight slots are IDirectSound's, and
        // it adds VerifyCertification, which nothing here needs to answer.
        describe(IID_IDirectSound8, IDIRECTSOUND_SLOTS, soundMethods),
    ];

    /** @param {number} out */
    const createInto = out=>{
        if ((out >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        writeU32(out, publisher.publish(root, rootInterfaces, IID_IDirectSound));
        return DS_OK;
    };

    return {
        root,
        publisher,
        /** For tests and for whoever wants to look at a buffer without a guest. */
        buffers: ()=>buffers,

        libraries: {
            'DSOUND.dll': {
                /** HRESULT DirectSoundCreate(LPCGUID, LPDIRECTSOUND*, IUnknown*) */
                DirectSoundCreate: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([, out])=>createInto(out),
                },
                /** HRESULT DirectSoundCreate8(LPCGUID, LPDIRECTSOUND8*, IUnknown*) */
                DirectSoundCreate8: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([, out])=>createInto(out),
                },
                /**
                 * HRESULT DirectSoundEnumerateA(LPDSENUMCALLBACKA, LPVOID)
                 *
                 * Succeeds having enumerated nothing: the callback is guest
                 * code and calling it needs a route this table does not have.
                 * A program that finds no devices falls back to the default,
                 * which is what DirectSoundCreate gives it.
                 */
                DirectSoundEnumerateA: { argBytes: 8, handler: ()=>DS_OK },
                DirectSoundEnumerateW: { argBytes: 8, handler: ()=>DS_OK },
                /** HRESULT DirectSoundCaptureCreate(...) — there is no capture device. */
                DirectSoundCaptureCreate: { argBytes: 12, handler: ()=>DSERR_UNSUPPORTED },
                DirectSoundCaptureCreate8: { argBytes: 12, handler: ()=>DSERR_UNSUPPORTED },
                /** HRESULT DllGetClassObject / DllCanUnloadNow, which COM asks for. */
                DllCanUnloadNow: { argBytes: 0, handler: ()=>DS_OK },
            },
        },

        diagnostics: ()=>({
            buffers: buffers.length,
            playing: buffers.filter(buffer=>(buffer.status() & 1) !== 0).length,
            published: publisher.count(),
            // No device, and saying so is the point: everything above behaves
            // and nothing is heard.
            device: null,
        }),
    };
}
