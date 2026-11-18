/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IAudioEndpointVolume, as IMMDevice::Activate hands it out: the endpoint's
 * master volume and mute, and each channel's, which every stream to the
 * endpoint plays at (`audio-client.js` multiplies a track's gain by them).
 *
 * The range is a speaker's of a common HD Audio codec, -65.25 dB to 0 dB in
 * steps of 0.75 dB; a level of the range's floor is silence. The scalar a
 * program reads and sets is the amplitude the level gives, 10^(dB/20), from 0
 * at the floor to 1 at 0 dB: the documentation has it a nonlinear,
 * audio-tapered mapping of the level, and leaves the curve to the endpoint
 * (decisions.md A265). The endpoint has no volume control of its own in
 * hardware (QueryHardwareSupport answers none). A program's change
 * notification is kept and not called: nothing outside the program changes
 * the volume here, and a change the program makes itself would be told to it
 * on a thread of the engine's, which there is none of - said once.
 */

export const IID_IAUDIO_ENDPOINT_VOLUME = '{5CDF2C82-841E-4546-9722-0CF74078229A}';

const S_OK = 0;
const S_FALSE = 1;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOTFOUND = 0x80070490 | 0;

/** The range of a level, in decibels, and its step. */
export const LEVEL_FLOOR = -65.25;
export const LEVEL_CEILING = 0;
export const LEVEL_STEP = 0.75;
/** How many steps VolumeStepUp walks, the floor and the ceiling both counted. */
const STEPS = Math.round((LEVEL_CEILING - LEVEL_FLOOR) / LEVEL_STEP) + 1;

/** A level's amplitude: 0 at the floor. @param {number} db */
export const scalarOf = db=>(db <= LEVEL_FLOOR ? 0 : 10 ** (db / 20));
/** An amplitude's level, the floor for none. @param {number} scalar */
export const levelOf = scalar=>(scalar <= 0 ? LEVEL_FLOOR
    : Math.max(LEVEL_FLOOR, Math.min(LEVEL_CEILING, 20 * Math.log10(scalar))));

/**
 * @typedef {Object} EndpointVolumeHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {number} channels
 * @property {() => void} changed  The endpoint's volume changed: streams play at it.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * The endpoint's volume, one for the endpoint however often it is activated.
 *
 * @param {EndpointVolumeHost} host
 */
export function createEndpointVolume(host){
    /** The endpoint's state: levels in decibels. */
    const state = {
        master: LEVEL_CEILING,
        /** @type {number[]} */
        channels: new Array(host.channels).fill(LEVEL_CEILING),
        muted: false,
        /** @type {number[]} */
        listeners: [],
    };
    let toldOfListeners = false;

    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** @param {number} at @param {number} value */
    const writeFloat = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(Float32Array.of(value).buffer));
    /** A float passed by value, as its bits arrive. @param {number} bits */
    const floatOf = bits=>new Float32Array(Uint32Array.of(bits >>> 0).buffer)[0];

    /** Sets a level and tells the streams; out of range is refused. @param {(db: number) => void} set @param {number} db */
    const setLevel = (set, db)=>{
        if (!(db >= LEVEL_FLOOR && db <= LEVEL_CEILING))
        {
            return E_INVALIDARG;
        }
        set(db);
        host.changed();
        return S_OK;
    };
    /** @param {number} channel */
    const knownChannel = channel=>(channel >>> 0) < host.channels;
    /** One step, up or down, of the master level. @param {number} direction */
    const step = direction=>{
        const index = Math.round((state.master - LEVEL_FLOOR) / LEVEL_STEP) + direction;
        state.master = LEVEL_FLOOR + Math.max(0, Math.min(STEPS - 1, index)) * LEVEL_STEP;
        host.changed();
        return S_OK;
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const descriptor = {
        id: IID_IAUDIO_ENDPOINT_VOLUME,
        methods: [
            /** HRESULT RegisterControlChangeNotify(IAudioEndpointVolumeCallback *pNotify) */
            { name: 'RegisterControlChangeNotify', argBytes: 8, invoke: (_, [notify])=>{
                if ((notify >>> 0) === 0)
                {
                    return E_POINTER;
                }
                state.listeners.push(notify >>> 0);
                if (!toldOfListeners)
                {
                    toldOfListeners = true;
                    host.divergence?.('IAudioEndpointVolume::RegisterControlChangeNotify',
                        'kept; no change of the endpoint\'s volume is told to it');
                }
                return S_OK;
            } },
            /** HRESULT UnregisterControlChangeNotify(IAudioEndpointVolumeCallback *pNotify) */
            { name: 'UnregisterControlChangeNotify', argBytes: 8, invoke: (_, [notify])=>{
                if ((notify >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const at = state.listeners.indexOf(notify >>> 0);
                if (at < 0)
                {
                    return E_NOTFOUND;
                }
                state.listeners.splice(at, 1);
                return S_OK;
            } },
            /** HRESULT GetChannelCount(UINT *pnChannelCount) */
            { name: 'GetChannelCount', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, host.channels);
                return S_OK;
            } },
            /** HRESULT SetMasterVolumeLevel(float fLevelDB, LPCGUID pguidEventContext) */
            { name: 'SetMasterVolumeLevel', argBytes: 12, floats: { 1: 'f32' },
                invoke: (_, [bits])=>setLevel(db=>{
                    state.master = db;
                }, floatOf(bits)) },
            /** HRESULT SetMasterVolumeLevelScalar(float fLevel, LPCGUID pguidEventContext) */
            { name: 'SetMasterVolumeLevelScalar', argBytes: 12, floats: { 1: 'f32' },
                invoke: (_, [bits])=>{
                    const scalar = floatOf(bits);
                    return scalar >= 0 && scalar <= 1 ? setLevel(db=>{
                        state.master = db;
                    }, levelOf(scalar)) : E_INVALIDARG;
                } },
            /** HRESULT GetMasterVolumeLevel(float *pfLevelDB) */
            { name: 'GetMasterVolumeLevel', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeFloat(out, state.master);
                return S_OK;
            } },
            /** HRESULT GetMasterVolumeLevelScalar(float *pfLevel) */
            { name: 'GetMasterVolumeLevelScalar', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeFloat(out, scalarOf(state.master));
                return S_OK;
            } },
            /** HRESULT SetChannelVolumeLevel(UINT nChannel, float fLevelDB, LPCGUID) */
            { name: 'SetChannelVolumeLevel', argBytes: 16, floats: { 2: 'f32' },
                invoke: (_, [channel, bits])=>(knownChannel(channel) ? setLevel(db=>{
                    state.channels[channel >>> 0] = db;
                }, floatOf(bits)) : E_INVALIDARG) },
            /** HRESULT SetChannelVolumeLevelScalar(UINT nChannel, float fLevel, LPCGUID) */
            { name: 'SetChannelVolumeLevelScalar', argBytes: 16, floats: { 2: 'f32' },
                invoke: (_, [channel, bits])=>{
                    const scalar = floatOf(bits);
                    return knownChannel(channel) && scalar >= 0 && scalar <= 1 ? setLevel(db=>{
                        state.channels[channel >>> 0] = db;
                    }, levelOf(scalar)) : E_INVALIDARG;
                } },
            /** HRESULT GetChannelVolumeLevel(UINT nChannel, float *pfLevelDB) */
            { name: 'GetChannelVolumeLevel', argBytes: 12, invoke: (_, [channel, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (!knownChannel(channel))
                {
                    return E_INVALIDARG;
                }
                writeFloat(out, state.channels[channel >>> 0]);
                return S_OK;
            } },
            /** HRESULT GetChannelVolumeLevelScalar(UINT nChannel, float *pfLevel) */
            { name: 'GetChannelVolumeLevelScalar', argBytes: 12, invoke: (_, [channel, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if (!knownChannel(channel))
                {
                    return E_INVALIDARG;
                }
                writeFloat(out, scalarOf(state.channels[channel >>> 0]));
                return S_OK;
            } },
            /** HRESULT SetMute(BOOL bMute, LPCGUID): S_FALSE when it already was so. */
            { name: 'SetMute', argBytes: 12, invoke: (_, [mute])=>{
                const wanted = mute !== 0;
                if (wanted === state.muted)
                {
                    return S_FALSE;
                }
                state.muted = wanted;
                host.changed();
                return S_OK;
            } },
            /** HRESULT GetMute(BOOL *pbMute) */
            { name: 'GetMute', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, state.muted ? 1 : 0);
                return S_OK;
            } },
            /** HRESULT GetVolumeStepInfo(UINT *pnStep, UINT *pnStepCount) */
            { name: 'GetVolumeStepInfo', argBytes: 12, invoke: (_, [current, count])=>{
                if ((current >>> 0) === 0 || (count >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(current, Math.round((state.master - LEVEL_FLOOR) / LEVEL_STEP));
                writeU32(count, STEPS);
                return S_OK;
            } },
            /** HRESULT VolumeStepUp(LPCGUID pguidEventContext) */
            { name: 'VolumeStepUp', argBytes: 8, invoke: ()=>step(1) },
            /** HRESULT VolumeStepDown(LPCGUID pguidEventContext) */
            { name: 'VolumeStepDown', argBytes: 8, invoke: ()=>step(-1) },
            /** HRESULT QueryHardwareSupport(DWORD *pdwHardwareSupportMask) */
            { name: 'QueryHardwareSupport', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                return S_OK;
            } },
            /** HRESULT GetVolumeRange(float *pflVolumeMindB, float *pflVolumeMaxdB, float *pflVolumeIncrementdB) */
            { name: 'GetVolumeRange', argBytes: 16, invoke: (_, [min, max, increment])=>{
                if ((min >>> 0) === 0 || (max >>> 0) === 0 || (increment >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeFloat(min, LEVEL_FLOOR);
                writeFloat(max, LEVEL_CEILING);
                writeFloat(increment, LEVEL_STEP);
                return S_OK;
            } },
        ],
    };

    return {
        descriptor,
        state,
        /**
         * The amplitude a stream's channel plays at: the master level's and
         * the channel's, none while muted.
         *
         * @param {number} channel
         */
        gain: channel=>(state.muted ? 0
            : scalarOf(state.master) * scalarOf(state.channels[channel] ?? LEVEL_CEILING)),
    };
}
