/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The filter registrations quartz.dll and qedit.dll write when they are
 * registered, as the filter mapper and the device enumerator find them on
 * Windows: each class's category, friendly name, merit and pins, the pins'
 * media types the ones IFilterMapper2::EnumMatchingFilters matches against.
 *
 * Intelligent connect (RenderFile, Render, Connect) and a program walking a
 * category both read these, so a class here is one a graph can choose. A
 * class the engine does not make is left out: a registration whose
 * CoCreateInstance fails is a filter the graph would try and fail on, where
 * Windows' would not.
 */

import { CLSID_ACTIVE_MOVIE_CATEGORIES, CLSID_LEGACY_AM_FILTER_CATEGORY } from '../devenum/devenum.js';
import { GUID_NULL, MEDIATYPE_AUDIO, MEDIATYPE_STREAM, MEDIATYPE_VIDEO } from './filter.js';
import { SOUND_ADAPTER_NAME, SOUND_DEVICE_GUID } from '../devices.js';
import { CLSID_ASYNC_READER } from './interfaces.js';

/** CLSID_AudioRendererCategory: where a program finds the machine's audio outputs. */
export const CLSID_AUDIO_RENDERER_CATEGORY = '{E0F158E1-CB04-11D0-BD4E-00A0C911CE86}';

/** The merits the SDK names. */
export const MERIT = {
    PREFERRED: 0x800000, NORMAL: 0x600000, UNLIKELY: 0x400000, DO_NOT_USE: 0x200000,
};

const MEDIASUBTYPE_AVI = '{E436EB88-524F-11CE-9F53-0020AF0BA770}';
const MEDIASUBTYPE_WAVE = '{E436EB8B-524F-11CE-9F53-0020AF0BA770}';
const MEDIASUBTYPE_AU = '{E436EB8C-524F-11CE-9F53-0020AF0BA770}';
const MEDIASUBTYPE_AIFF = '{E436EB8D-524F-11CE-9F53-0020AF0BA770}';
const MEDIASUBTYPE_PCM = '{00000001-0000-0010-8000-00AA00389B71}';
/** The RGB kinds the Color Space Converter registers for both its pins. */
const RGB_TYPES = /** @type {[string, string][]} */ ([
    '{E436EB7A-524F-11CE-9F53-0020AF0BA770}', '{E436EB7C-524F-11CE-9F53-0020AF0BA770}',
    '{E436EB7B-524F-11CE-9F53-0020AF0BA770}', '{E436EB7D-524F-11CE-9F53-0020AF0BA770}',
    '{E436EB7E-524F-11CE-9F53-0020AF0BA770}', '{773C9AC0-3274-11D0-B724-00AA006C1A01}',
].map(sub=>[MEDIATYPE_VIDEO, sub]));

/**
 * @param {string} name @param {boolean} output @param {[string, string][]} types
 * @param {{ renderer?: boolean, many?: boolean, zero?: boolean }} [flags]
 * @returns {import('../devenum/devenum.js').RegisteredPin}
 */
const pin = (name, output, types, flags = {})=>({ name, output, renderer: flags.renderer ?? false,
    zero: flags.zero ?? false, many: flags.many ?? false, types });

/**
 * One registration as DllRegisterServer writes it.
 *
 * @typedef {Object} WindowsRegistration
 * @property {string} clsid
 * @property {string} name
 * @property {number} merit
 * @property {import('../devenum/devenum.js').RegisteredPin[]} pins
 * @property {string} [category]  CLSID_LegacyAmFilterCategory where absent.
 * @property {string} [instance]  The class's CLSID where absent.
 * @property {boolean} [always]   Written whatever is made: a category is no class.
 * @property {string} [display]   Its moniker's name where it is not `@device:sw:`: a device
 *           devenum lists itself is `@device:cm:{category}\instance`.
 * @property {[string, string | number][]} [properties]  What its key holds besides.
 */

/**
 * The categories devenum registers, each an entry of CLSID_ActiveMovieCategories
 * named by its CLSID. A category may be empty: a machine with no capture
 * device has the category and nothing in it.
 *
 * @type {[string, string][]}
 */
const CATEGORIES = [
    [CLSID_LEGACY_AM_FILTER_CATEGORY, 'DirectShow Filters'],
    [CLSID_AUDIO_RENDERER_CATEGORY, 'Audio Renderers'],
    ['{33D9A760-90C8-11D0-BD43-00A0C911CE86}', 'Video Compressors'],
    ['{33D9A761-90C8-11D0-BD43-00A0C911CE86}', 'Audio Compressors'],
    ['{33D9A762-90C8-11D0-BD43-00A0C911CE86}', 'Audio Capture Sources'],
    ['{860BB310-5D01-11D0-BD3B-00A0C911CE86}', 'Video Capture Sources'],
    ['{4EFE2452-168A-11D1-BC76-00C04FB9453B}', 'Midi Renderers'],
];

/** @type {WindowsRegistration[]} */
export const WINDOWS_REGISTRATIONS = [
    ...CATEGORIES.map(([clsid, name])=>({ clsid, name, merit: MERIT.DO_NOT_USE, pins: [],
        category: CLSID_ACTIVE_MOVIE_CATEGORIES, instance: clsid, always: true })),
    {
        clsid: CLSID_ASYNC_READER, name: 'File Source (Async.)', merit: MERIT.UNLIKELY,
        pins: [pin('Output', true, [[MEDIATYPE_STREAM, GUID_NULL]])],
    },
    {
        clsid: '{1B544C20-FD0B-11CE-8C63-00AA0044B51E}', name: 'AVI Splitter', merit: MERIT.NORMAL,
        pins: [
            pin('input pin', false, [[MEDIATYPE_STREAM, MEDIASUBTYPE_AVI]]),
            pin('AVI Outputs', true, [[MEDIATYPE_VIDEO, GUID_NULL]], { zero: true, many: true }),
        ],
    },
    {
        clsid: '{D51BD5A1-7548-11CF-A520-0080C77EF58A}', name: 'Wave Parser', merit: MERIT.UNLIKELY,
        pins: [
            pin('Input', false, [[MEDIATYPE_STREAM, MEDIASUBTYPE_WAVE],
                [MEDIATYPE_STREAM, MEDIASUBTYPE_AU], [MEDIATYPE_STREAM, MEDIASUBTYPE_AIFF]]),
            pin('Output', true, [[MEDIATYPE_AUDIO, GUID_NULL]]),
        ],
    },
    {
        clsid: '{CF49D4E0-1115-11CE-B03A-0020AF0BA770}', name: 'AVI Decompressor',
        merit: MERIT.NORMAL - 16,
        pins: [
            pin('XForm In', false, [[MEDIATYPE_VIDEO, GUID_NULL]]),
            pin('XForm Out', true, [[MEDIATYPE_VIDEO, GUID_NULL]]),
        ],
    },
    {
        clsid: '{6A08CF80-0E18-11CF-A24D-0020AFD79767}', name: 'ACM Wrapper', merit: MERIT.NORMAL,
        pins: [
            pin('Input', false, [[MEDIATYPE_AUDIO, GUID_NULL]]),
            pin('Output', true, [[MEDIATYPE_AUDIO, MEDIASUBTYPE_PCM]]),
        ],
    },
    {
        clsid: '{1643E180-90F5-11CE-97D5-00AA0055595A}', name: 'Color Space Converter',
        merit: MERIT.UNLIKELY + 1,
        pins: [
            pin('Input', false, RGB_TYPES),
            pin('XForm Out', true, RGB_TYPES),
        ],
    },
    {
        clsid: '{70E102B0-5556-11CE-97C0-00AA0055595A}', name: 'Video Renderer',
        merit: MERIT.PREFERRED,
        pins: [pin('Input', false, [[MEDIATYPE_VIDEO, GUID_NULL]], { renderer: true })],
    },
    {
        clsid: '{79376820-07D0-11CF-A24D-0020AFD79767}', name: 'DirectSound Renderer',
        merit: MERIT.PREFERRED,
        pins: [pin('Audio Input pin (rendered)', false, [[MEDIATYPE_AUDIO, MEDIASUBTYPE_PCM]],
            { renderer: true })],
    },
    {
        clsid: '{C1F400A4-3F08-11D3-9F0B-006008039E37}', name: 'Null Renderer',
        merit: MERIT.DO_NOT_USE,
        pins: [pin('In', false, [[GUID_NULL, GUID_NULL]], { renderer: true })],
    },
];

/**
 * Writes the registrations of the classes this process makes into the store,
 * as registering quartz and qedit would have.
 *
 * @param {import('../devenum/devenum.js').FilterStore} store
 * @param {(clsid: string) => boolean} made  Whether CoCreateInstance makes the class here.
 * @param {WindowsRegistration[]} [registrations]
 */
export function registerWindowsFilters(store, made, registrations = WINDOWS_REGISTRATIONS){
    for (const entry of registrations)
    {
        if (!entry.always && !made(entry.clsid))
        {
            continue;
        }
        store.register({
            category: entry.category ?? CLSID_LEGACY_AM_FILTER_CATEGORY,
            instance: entry.instance ?? entry.clsid,
            clsid: entry.clsid,
            name: entry.name,
            merit: entry.merit,
            pins: entry.pins,
            properties: new Map(entry.properties ?? []),
            ...entry.display ? { display: entry.display } : {},
        });
    }
}

/** CLSID_VideoCompressorCategory: the installable compressors, each a device of its own. */
const CLSID_VIDEO_COMPRESSOR_CATEGORY = '{33D9A760-90C8-11D0-BD43-00A0C911CE86}';
/** CLSID_AVICo: the filter a video compressor's moniker binds to. */
const CLSID_AVI_CO = '{D76E2820-1563-11CF-AC98-00AA004C0FA9}';
const CLSID_AUDIO_RENDER = '{E30629D1-27E5-11CE-875D-00608CB78066}';
const CLSID_DSOUND_RENDER = '{79376820-07D0-11CF-A24D-0020AFD79767}';
const GUID_NULL_TEXT = '{00000000-0000-0000-0000-000000000000}';

/**
 * The devices devenum lists itself, as `@device:cm:` monikers: among the
 * audio renderers the default wave output (WaveOutId -1) and DirectSound
 * device (DSGuid GUID_NULL), then the machine's one sound adapter as each
 * (WaveOutId 0, its DirectSound GUID); and each installed video compressor,
 * by its FOURCC, under CLSID_AVICo, which a program reads the codecs off and
 * which is not a filter the graph connects with (its merit is DO_NOT_USE).
 *
 * @param {{ handler: number, description: string }[]} codecs  The installable compressors.
 * @returns {WindowsRegistration[]}
 */
export function deviceRegistrations(codecs){
    /** @param {string} category @param {string} instance */
    const display = (category, instance)=>`@device:cm:${category}\\${instance}`;
    const audioPin = pin('Audio Input pin (rendered)', false, [[MEDIATYPE_AUDIO, MEDIASUBTYPE_PCM]],
        { renderer: true });
    /** @param {number} handler */
    const fourcc = handler=>String.fromCharCode(handler & 0xff, handler >>> 8 & 0xff,
        handler >>> 16 & 0xff, handler >>> 24 & 0xff);
    return [
        {
            clsid: CLSID_AUDIO_RENDER, name: 'Default WaveOut Device', merit: MERIT.PREFERRED,
            category: CLSID_AUDIO_RENDERER_CATEGORY, instance: 'Default WaveOut Device',
            display: display(CLSID_AUDIO_RENDERER_CATEGORY, 'Default WaveOut Device'),
            properties: [['WaveOutId', -1]], pins: [audioPin],
        },
        {
            clsid: CLSID_DSOUND_RENDER, name: 'Default DirectSound Device', merit: MERIT.PREFERRED,
            category: CLSID_AUDIO_RENDERER_CATEGORY, instance: 'Default DirectSound Device',
            display: display(CLSID_AUDIO_RENDERER_CATEGORY, 'Default DirectSound Device'),
            properties: [['DSGuid', GUID_NULL_TEXT]], pins: [audioPin],
        },
        {
            clsid: CLSID_AUDIO_RENDER, name: SOUND_ADAPTER_NAME, merit: MERIT.NORMAL,
            category: CLSID_AUDIO_RENDERER_CATEGORY, instance: SOUND_ADAPTER_NAME,
            display: display(CLSID_AUDIO_RENDERER_CATEGORY, SOUND_ADAPTER_NAME),
            properties: [['WaveOutId', 0]], pins: [audioPin],
        },
        {
            clsid: CLSID_DSOUND_RENDER, name: `DirectSound: ${SOUND_ADAPTER_NAME}`,
            merit: MERIT.NORMAL, category: CLSID_AUDIO_RENDERER_CATEGORY,
            instance: `DirectSound: ${SOUND_ADAPTER_NAME}`,
            display: display(CLSID_AUDIO_RENDERER_CATEGORY, `DirectSound: ${SOUND_ADAPTER_NAME}`),
            properties: [['DSGuid', SOUND_DEVICE_GUID]], pins: [audioPin],
        },
        ...codecs.map(codec=>{
            const handler = fourcc(codec.handler);
            return {
                clsid: CLSID_AVI_CO, name: codec.description, merit: MERIT.DO_NOT_USE,
                category: CLSID_VIDEO_COMPRESSOR_CATEGORY, instance: handler,
                display: display(CLSID_VIDEO_COMPRESSOR_CATEGORY, handler),
                properties: /** @type {[string, string | number][]} */ ([['FccHandler', handler]]),
                pins: [], always: true,
            };
        }),
    ];
}
