/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { formatGuid } from '../../../system/guid.js';

/**
 * DirectSound's standard effects - gargle, chorus, flanger, echo,
 * distortion, compressor, parametric equalizer, I3DL2 and Waves reverb - as
 * the DMOs a buffer's SetFX makes: classes CoCreateInstance finds by the
 * GUID_DSFX_* a program names, each an IMediaObject, an IMediaObjectInPlace
 * and its own parameter interface. Parameters are kept and checked against
 * the ranges dsound.h gives; the sound passes through unchanged
 * (decisions.md A264), which each effect says once.
 */

/** @typedef {'f' | 'l' | 'u'} FieldType  FLOAT, LONG, DWORD */
/** @typedef {{ name: string, type: FieldType, min: number, max: number, value: number }} Field */

export const IID_IMediaObject = '{D8AD0F58-5494-4102-97C5-EC798E59BCF4}';
export const IID_IMediaObjectInPlace = '{651B9AD0-0FC7-4AA9-9538-D89931010741}';

export const MEDIATYPE_Audio = '{73647561-0000-0010-8000-00AA00389B71}';
export const MEDIASUBTYPE_PCM = '{00000001-0000-0010-8000-00AA00389B71}';
export const MEDIASUBTYPE_IEEE_FLOAT = '{00000003-0000-0010-8000-00AA00389B71}';
export const FORMAT_WaveFormatEx = '{05589F81-C356-11CE-BF01-00AA0055595A}';

const S_OK = 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const DMO_E_INVALIDSTREAMINDEX = 0x80040201 | 0;
const DMO_E_TYPE_NOT_SET = 0x80040203 | 0;
const DMO_E_TYPE_NOT_ACCEPTED = 0x80040205 | 0;
const DMO_E_NO_MORE_ITEMS = 0x80040206 | 0;
const DMO_SET_TYPEF_TEST_ONLY = 1;
const DMO_SET_TYPEF_CLEAR = 2;
const DMO_INPUT_STATUSF_ACCEPT_DATA = 1;
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;

/** @param {string} name @param {FieldType} type @param {number} min @param {number} max @param {number} value */
const field = (name, type, min, max, value)=>({ name, type, min, max, value });

/**
 * The I3DL2 environments, in the order of the DSFX_I3DL2_ENVIRONMENT_PRESET_*
 * enumeration: room, room HF, rolloff, decay time, decay HF ratio,
 * reflections, reflections delay, reverb, reverb delay, diffusion, density,
 * HF reference (the I3DL2_ENVIRONMENT_PRESET_* values of dsound.h).
 */
const I3DL2_PRESETS = Object.freeze([
    [-1000, -100, 0, 1.49, 0.83, -2602, 0.007, 200, 0.011, 100, 100, 5000],
    [-1000, -100, 0, 1.49, 0.83, -2602, 0.007, 200, 0.011, 100, 100, 5000],
    [-1000, -6000, 0, 0.17, 0.10, -1204, 0.001, 207, 0.002, 100, 100, 5000],
    [-1000, -454, 0, 0.40, 0.83, -1646, 0.002, 53, 0.003, 100, 100, 5000],
    [-1000, -1200, 0, 1.49, 0.54, -370, 0.007, 1030, 0.011, 100, 60, 5000],
    [-1000, -6000, 0, 0.50, 0.10, -1376, 0.003, -1104, 0.004, 100, 100, 5000],
    [-1000, -300, 0, 2.31, 0.64, -711, 0.012, 83, 0.017, 100, 100, 5000],
    [-1000, -476, 0, 4.32, 0.59, -789, 0.020, -289, 0.030, 100, 100, 5000],
    [-1000, -500, 0, 3.92, 0.70, -1230, 0.020, -2, 0.029, 100, 100, 5000],
    [-1000, 0, 0, 2.91, 1.30, -602, 0.015, -302, 0.022, 100, 100, 5000],
    [-1000, -698, 0, 7.24, 0.33, -1166, 0.020, 16, 0.030, 100, 100, 5000],
    [-1000, -1000, 0, 10.05, 0.23, -602, 0.020, 198, 0.030, 100, 100, 5000],
    [-1000, -4000, 0, 0.30, 0.10, -1831, 0.002, -1630, 0.030, 100, 100, 5000],
    [-1000, -300, 0, 1.49, 0.59, -1219, 0.007, 441, 0.011, 100, 100, 5000],
    [-1000, -237, 0, 2.70, 0.79, -1214, 0.013, 395, 0.020, 100, 100, 5000],
    [-1000, -270, 0, 1.49, 0.86, -1204, 0.007, -4, 0.011, 100, 100, 5000],
    [-1000, -3300, 0, 1.49, 0.54, -2560, 0.162, -613, 0.088, 79, 100, 5000],
    [-1000, -800, 0, 1.49, 0.67, -2273, 0.007, 2217, 0.011, 50, 100, 5000],
    [-1000, -2500, 0, 1.49, 0.21, -2780, 0.300, -2014, 0.100, 27, 100, 5000],
    [-1000, -1000, 0, 1.49, 0.83, -10000, 0.061, 500, 0.025, 100, 100, 5000],
    [-1000, -2000, 0, 1.49, 0.50, -2466, 0.179, -2514, 0.100, 21, 100, 5000],
    [-1000, 0, 0, 1.65, 1.50, -1363, 0.008, -1153, 0.012, 100, 100, 5000],
    [-1000, -1000, 0, 2.81, 0.14, 429, 0.014, 648, 0.011, 80, 60, 5000],
    [-1000, -4000, 0, 1.49, 0.10, -449, 0.007, 1700, 0.011, 100, 100, 5000],
    [-1000, -600, 0, 1.10, 0.83, -400, 0.005, 500, 0.010, 100, 100, 5000],
    [-1000, -600, 0, 1.30, 0.83, -1000, 0.010, -200, 0.020, 100, 100, 5000],
    [-1000, -600, 0, 1.50, 0.83, -1600, 0.020, -1000, 0.040, 100, 100, 5000],
    [-1000, -600, 0, 1.80, 0.70, -1300, 0.015, -800, 0.030, 100, 100, 5000],
    [-1000, -600, 0, 1.80, 0.70, -2000, 0.030, -1400, 0.060, 100, 100, 5000],
    [-1000, -200, 0, 1.30, 0.90, 0, 0.002, 0, 0.010, 100, 75, 5000],
]);

/**
 * The standard effects: the class a program names, its parameter
 * interface and that interface's structure, field by field, with the range
 * dsound.h gives and the value a new effect starts with.
 *
 * @type {readonly { name: string, clsid: string, iid: string, fields: Field[] }[]}
 */
export const STANDARD_EFFECTS = Object.freeze([
    { name: 'Gargle', clsid: '{DAFD8210-5711-4B91-9FE3-F75B7AE279BF}',
        iid: '{D616F352-D622-11CE-AAC5-0020AF0B99A3}', fields: [
            field('dwRateHz', 'u', 1, 1000, 20), field('dwWaveShape', 'u', 0, 1, 0)] },
    { name: 'Chorus', clsid: '{EFE6629C-81F7-4281-BD91-C9D604A95AF6}',
        iid: '{880842E3-145F-43E6-A934-A71806E50547}', fields: [
            field('fWetDryMix', 'f', 0, 100, 50), field('fDepth', 'f', 0, 100, 10),
            field('fFeedback', 'f', -99, 99, 25), field('fFrequency', 'f', 0, 10, 1.1),
            field('lWaveform', 'l', 0, 1, 1), field('fDelay', 'f', 0, 20, 16),
            field('lPhase', 'l', 0, 4, 3)] },
    { name: 'Flanger', clsid: '{EFCA3D92-DFD8-4672-A603-7420894BAD98}',
        iid: '{903E9878-2C92-4072-9B2C-EA68F5396783}', fields: [
            field('fWetDryMix', 'f', 0, 100, 50), field('fDepth', 'f', 0, 100, 100),
            field('fFeedback', 'f', -99, 99, -50), field('fFrequency', 'f', 0, 10, 0.25),
            field('lWaveform', 'l', 0, 1, 1), field('fDelay', 'f', 0, 4, 2),
            field('lPhase', 'l', 0, 4, 2)] },
    { name: 'Echo', clsid: '{EF3E932C-D40B-4F51-8CCF-3F98F1B29D5D}',
        iid: '{8BD28EDF-50DB-4E92-A2BD-445488D1ED42}', fields: [
            field('fWetDryMix', 'f', 0, 100, 50), field('fFeedback', 'f', 0, 100, 50),
            field('fLeftDelay', 'f', 1, 2000, 500), field('fRightDelay', 'f', 1, 2000, 500),
            field('lPanDelay', 'l', 0, 1, 0)] },
    { name: 'Distortion', clsid: '{EF114C90-CD1D-484E-96E5-09CFAF912A21}',
        iid: '{8ECF4326-455F-4D8B-BDA9-8D5D3E9E3E0B}', fields: [
            field('fGain', 'f', -60, 0, -18), field('fEdge', 'f', 0, 100, 15),
            field('fPostEQCenterFrequency', 'f', 100, 8000, 2400),
            field('fPostEQBandwidth', 'f', 100, 8000, 2400),
            field('fPreLowpassCutoff', 'f', 100, 8000, 8000)] },
    { name: 'Compressor', clsid: '{EF011F79-4000-406D-87AF-BFFB3FC39D57}',
        iid: '{4BBD1154-62F6-4E2C-A15C-D3B6C417F7A0}', fields: [
            field('fGain', 'f', -60, 60, 0), field('fAttack', 'f', 0.01, 500, 10),
            field('fRelease', 'f', 50, 3000, 200), field('fThreshold', 'f', -60, 0, -20),
            field('fRatio', 'f', 1, 100, 3), field('fPredelay', 'f', 0, 4, 4)] },
    { name: 'ParamEq', clsid: '{120CED89-3BF4-4173-A132-3CB406CF3231}',
        iid: '{C03CA9FE-FE90-4204-8078-82334CD177DA}', fields: [
            field('fCenter', 'f', 80, 16000, 8000), field('fBandwidth', 'f', 1, 36, 12),
            field('fGain', 'f', -15, 15, 0)] },
    { name: 'I3DL2Reverb', clsid: '{EF985E71-D5C7-42D4-BA4D-2D073E2E96F4}',
        iid: '{4B166A6A-0D66-43F3-80E3-EE6280DEE1A4}', fields: [
            field('lRoom', 'l', -10000, 0, -1000), field('lRoomHF', 'l', -10000, 0, -100),
            field('flRoomRolloffFactor', 'f', 0, 10, 0),
            field('flDecayTime', 'f', 0.1, 20, 1.49), field('flDecayHFRatio', 'f', 0.1, 2, 0.83),
            field('lReflections', 'l', -10000, 1000, -2602),
            field('flReflectionsDelay', 'f', 0, 0.3, 0.007),
            field('lReverb', 'l', -10000, 2000, 200), field('flReverbDelay', 'f', 0, 0.1, 0.011),
            field('flDiffusion', 'f', 0, 100, 100), field('flDensity', 'f', 0, 100, 100),
            field('flHFReference', 'f', 20, 20000, 5000)] },
    { name: 'WavesReverb', clsid: '{87FC0268-9A55-4360-95AA-004A1D9DE26C}',
        iid: '{46858C3A-0DC6-45E3-B760-D4EEF16CB325}', fields: [
            field('fInGain', 'f', -96, 0, 0), field('fReverbMix', 'f', -96, 0, 0),
            field('fReverbTime', 'f', 0.001, 3000, 1000),
            field('fHighFreqRTRatio', 'f', 0.001, 0.999, 0.001)] },
]);

const I3DL2_QUALITY_MAX = 3;
const I3DL2_QUALITY_DEFAULT = 2;

/**
 * @typedef {Object} EffectsHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, bytes: 4 | 8) => number} readPointer  a pointer whole,
 *     the memory layer's reader
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * A DMO_MEDIA_TYPE's audio format, or null for one an effect does not take:
 * audio, PCM of 8 or 16 bits or 32-bit float, described by a WAVEFORMATEX.
 *
 * @param {EffectsHost} host @param {number} at @param {4 | 8} pointerSize
 * @returns {{ tag: number, channels: number, rate: number, block: number, bits: number } | null}
 */
function readAudioType(host, at, pointerSize){
    const guid = (/** @type {number} */ offset)=>formatGuid(host.readMemory(at + offset, 16));
    const long = pointerSize === 8;
    const cbFormat = new DataView(host.readMemory(at + (long ? 72 : 64), 4).slice().buffer)
        .getUint32(0, true);
    const pbFormat = host.readPointer(at + (long ? 80 : 68), pointerSize);
    if (guid(0) !== MEDIATYPE_Audio || guid(44) !== FORMAT_WaveFormatEx
        || cbFormat < 16 || pbFormat === 0)
    {
        return null;
    }
    const wave = new DataView(host.readMemory(pbFormat, 16).slice().buffer);
    const format = { tag: wave.getUint16(0, true), channels: wave.getUint16(2, true),
        rate: wave.getUint32(4, true), block: wave.getUint16(12, true),
        bits: wave.getUint16(14, true) };
    const subtype = guid(16);
    const pcm = subtype === MEDIASUBTYPE_PCM && format.tag === WAVE_FORMAT_PCM
        && (format.bits === 8 || format.bits === 16);
    const float = subtype === MEDIASUBTYPE_IEEE_FLOAT && format.tag === WAVE_FORMAT_IEEE_FLOAT
        && format.bits === 32;
    return (pcm || float) && format.channels > 0 && format.channels <= 2 && format.rate > 0
        ? format : null;
}


/**
 * A parameter structure out of guest memory, or null when a field is out of
 * its range.
 *
 * @param {EffectsHost} host @param {number} at @param {Field[]} fields
 * @returns {number[] | null}
 */
function readParameters(host, at, fields){
    const view = new DataView(host.readMemory(at, fields.length * 4).slice().buffer);
    const values = fields.map((entry, index)=>(entry.type === 'f'
        ? view.getFloat32(index * 4, true)
        : entry.type === 'l' ? view.getInt32(index * 4, true) : view.getUint32(index * 4, true)));
    return values.every((value, index)=>value >= fields[index].min - 1e-6
        && value <= fields[index].max + 1e-6) ? values : null;
}

/** @param {EffectsHost} host @param {number} at @param {Field[]} fields @param {number[]} values */
function writeParameters(host, at, fields, values){
    const view = new DataView(new ArrayBuffer(fields.length * 4));
    fields.forEach((entry, index)=>{
        if (entry.type === 'f')
        {
            view.setFloat32(index * 4, values[index], true);
        }
        else
        {
            view.setInt32(index * 4, values[index] | 0, true);
        }
    });
    host.writeMemory(at, new Uint8Array(view.buffer));
}

/** @param {EffectsHost} host @param {number} at @param {number} value */
function writeU32(host, at, value){
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, value >>> 0, true);
    host.writeMemory(at >>> 0, new Uint8Array(view.buffer));
}

/**
 * Registers the standard effects as COM classes.
 *
 * @param {{ registerClass: (clsid: string, factory: () => any) => void }} registry
 * @param {EffectsHost} host
 * @param {4 | 8} [pointerSize]
 */
export function registerStandardEffects(registry, host, pointerSize = 4){
    /** @type {Set<string>} */
    const said = new Set();
    for (const effect of STANDARD_EFFECTS)
    {
        registry.registerClass(effect.clsid, ()=>createEffect(effect, host, pointerSize, said));
    }
}

/**
 * One effect's object.
 *
 * @param {(typeof STANDARD_EFFECTS)[number]} effect @param {EffectsHost} host
 * @param {4 | 8} pointerSize @param {Set<string>} said
 */
function createEffect(effect, host, pointerSize, said){
    let parameters = effect.fields.map(entry=>entry.value);
    let preset = 0;
    let quality = I3DL2_QUALITY_DEFAULT;
    /** @type {ReturnType<typeof readAudioType>} */
    let input = null;
    /** @type {ReturnType<typeof readAudioType>} */
    let output = null;
    const reverb = effect.name === 'I3DL2Reverb';

    /** @param {number} index */
    const stream = index=>(index >>> 0) === 0;

    const mediaObject = [
        { name: 'GetStreamCount', argBytes: 12, invoke: (/** @type {any} */ _, /** @type {number[]} */ [ins, outs])=>{
            if ((ins >>> 0) === 0 || (outs >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(host, ins, 1);
            writeU32(host, outs, 1);
            return S_OK;
        } },
        ...['GetInputStreamInfo', 'GetOutputStreamInfo'].map(name=>({ name, argBytes: 12,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index, flags])=>{
                if (!stream(index))
                {
                    return DMO_E_INVALIDSTREAMINDEX;
                }
                if ((flags >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(host, flags, 0);
                return S_OK;
            } })),
        // The types an effect would list: it takes any of a range, so it
        // lists none, and a caller proposes its own.
        ...['GetInputType', 'GetOutputType'].map(name=>({ name, argBytes: 16,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index])=>
                (stream(index) ? DMO_E_NO_MORE_ITEMS : DMO_E_INVALIDSTREAMINDEX) })),
        { name: 'SetInputType', argBytes: 16,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index, type, flags])=>{
                if (!stream(index))
                {
                    return DMO_E_INVALIDSTREAMINDEX;
                }
                if (((flags >>> 0) & DMO_SET_TYPEF_CLEAR) !== 0)
                {
                    input = null;
                    return S_OK;
                }
                const format = (type >>> 0) === 0 ? null : readAudioType(host, type >>> 0,
                    pointerSize);
                if (!format)
                {
                    return DMO_E_TYPE_NOT_ACCEPTED;
                }
                if (((flags >>> 0) & DMO_SET_TYPEF_TEST_ONLY) === 0)
                {
                    input = format;
                }
                return S_OK;
            } },
        { name: 'SetOutputType', argBytes: 16,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index, type, flags])=>{
                if (!stream(index))
                {
                    return DMO_E_INVALIDSTREAMINDEX;
                }
                if (((flags >>> 0) & DMO_SET_TYPEF_CLEAR) !== 0)
                {
                    output = null;
                    return S_OK;
                }
                const format = (type >>> 0) === 0 ? null : readAudioType(host, type >>> 0,
                    pointerSize);
                // An effect changes no format: what comes out is what went in.
                if (!format || !input || JSON.stringify(format) !== JSON.stringify(input))
                {
                    return DMO_E_TYPE_NOT_ACCEPTED;
                }
                if (((flags >>> 0) & DMO_SET_TYPEF_TEST_ONLY) === 0)
                {
                    output = format;
                }
                return S_OK;
            } },
        // The current type's block would be the caller's to free, and no
        // effect here makes one: said, not pretended.
        ...['GetInputCurrentType', 'GetOutputCurrentType'].map((name, index)=>({ name,
            argBytes: 12, invoke: (/** @type {any} */ _, /** @type {number[]} */ [stream0])=>{
                if (!stream(stream0))
                {
                    return DMO_E_INVALIDSTREAMINDEX;
                }
                if (!(index === 0 ? input : output))
                {
                    return DMO_E_TYPE_NOT_SET;
                }
                host.divergence?.(`IMediaObject::${name}`, 'the type is not copied out');
                return E_NOTIMPL;
            } })),
        { name: 'GetInputSizeInfo', argBytes: 20,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index, size, lookahead, align])=>{
                if (!stream(index))
                {
                    return DMO_E_INVALIDSTREAMINDEX;
                }
                if (!input)
                {
                    return DMO_E_TYPE_NOT_SET;
                }
                writeU32(host, size, input.block);
                writeU32(host, lookahead, 0);
                writeU32(host, align, 1);
                return S_OK;
            } },
        { name: 'GetOutputSizeInfo', argBytes: 16,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index, size, align])=>{
                if (!stream(index))
                {
                    return DMO_E_INVALIDSTREAMINDEX;
                }
                if (!output)
                {
                    return DMO_E_TYPE_NOT_SET;
                }
                writeU32(host, size, output.block);
                writeU32(host, align, 1);
                return S_OK;
            } },
        { name: 'GetInputMaxLatency', argBytes: 12, invoke: ()=>E_NOTIMPL },
        { name: 'SetInputMaxLatency', argBytes: 16, invoke: ()=>E_NOTIMPL },
        { name: 'Flush', argBytes: 4, invoke: ()=>S_OK },
        { name: 'Discontinuity', argBytes: 8,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index])=>
                (stream(index) ? S_OK : DMO_E_INVALIDSTREAMINDEX) },
        { name: 'AllocateStreamingResources', argBytes: 4, invoke: ()=>S_OK },
        { name: 'FreeStreamingResources', argBytes: 4, invoke: ()=>S_OK },
        { name: 'GetInputStatus', argBytes: 12,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [index, flags])=>{
                if (!stream(index))
                {
                    return DMO_E_INVALIDSTREAMINDEX;
                }
                writeU32(host, flags, DMO_INPUT_STATUSF_ACCEPT_DATA);
                return S_OK;
            } },
        // DirectSound runs an effect in place; the streaming form is not
        // hosted here.
        ...['ProcessInput', 'ProcessOutput'].map(name=>({ name,
            argBytes: name === 'ProcessInput' ? 32 : 20, invoke: ()=>{
                host.divergence?.(`IMediaObject::${name}`, 'an effect runs only in place');
                return E_NOTIMPL;
            } })),
        { name: 'Lock', argBytes: 8, invoke: ()=>S_OK },
    ];

    const inPlace = [
        { name: 'Process', argBytes: 24, invoke: ()=>{
            if (!said.has(effect.name))
            {
                said.add(effect.name);
                host.divergence?.(`DirectSound ${effect.name}`,
                    'its parameters are kept and the sound passes through unchanged');
            }
            return S_OK;
        } },
        { name: 'Clone', argBytes: 8, invoke: ()=>E_NOTIMPL },
        { name: 'GetLatency', argBytes: 8,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [latency])=>{
                if ((latency >>> 0) === 0)
                {
                    return E_POINTER;
                }
                host.writeMemory(latency >>> 0, new Uint8Array(8));
                return S_OK;
            } },
    ];

    const parameterMethods = [
        { name: 'SetAllParameters', argBytes: 8,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [at])=>{
                if ((at >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const read = readParameters(host, at >>> 0, effect.fields);
                if (!read)
                {
                    return E_INVALIDARG;
                }
                parameters = read;
                return S_OK;
            } },
        { name: 'GetAllParameters', argBytes: 8,
            invoke: (/** @type {any} */ _, /** @type {number[]} */ [at])=>{
                if ((at >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeParameters(host, at >>> 0, effect.fields, parameters);
                return S_OK;
            } },
        ...reverb ? [
            { name: 'SetPreset', argBytes: 8,
                invoke: (/** @type {any} */ _, /** @type {number[]} */ [chosen])=>{
                    const values = I3DL2_PRESETS[chosen >>> 0];
                    if (!values)
                    {
                        return E_INVALIDARG;
                    }
                    preset = chosen >>> 0;
                    parameters = [...values];
                    return S_OK;
                } },
            { name: 'GetPreset', argBytes: 8,
                invoke: (/** @type {any} */ _, /** @type {number[]} */ [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    writeU32(host, out, preset);
                    return S_OK;
                } },
            { name: 'SetQuality', argBytes: 8,
                invoke: (/** @type {any} */ _, /** @type {number[]} */ [value])=>{
                    if ((value | 0) < 0 || (value | 0) > I3DL2_QUALITY_MAX)
                    {
                        return E_INVALIDARG;
                    }
                    quality = value | 0;
                    return S_OK;
                } },
            { name: 'GetQuality', argBytes: 8,
                invoke: (/** @type {any} */ _, /** @type {number[]} */ [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    writeU32(host, out, quality);
                    return S_OK;
                } },
        ] : [],
    ];

    return {
        interfaces: [
            { id: IID_IMediaObject, methods: mediaObject },
            { id: IID_IMediaObjectInPlace, methods: inPlace },
            { id: effect.iid, methods: parameterMethods },
        ],
    };
}
