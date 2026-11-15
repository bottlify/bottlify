/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz's renderers and qedit's Null Renderer on the filter base: the Video
 * Renderer, the DirectSound Renderer, and the renderer that takes anything and
 * keeps nothing. The Video Mixing Renderers are not here: a program configures
 * one through IVMRFilterConfig before it connects, and a class without it is
 * one the program cannot use.
 *
 * A renderer is a filter with one input pin and no output: what makes each one
 * itself is the media type its pin takes, the name Windows gives that pin, and
 * the end of the stream, which a renderer passes on to the graph as EC_COMPLETE
 * through IMediaEventSink, the graph counting one per renderer. What a
 * renderer draws or plays belongs to the graph's own playback path; a sample a
 * program's source pushes into one of these is taken and let go.
 */

import {
    FORMAT_VIDEO_INFO, FORMAT_WAVE_FORMAT_EX, GUID_NULL, MEDIATYPE_AUDIO, MEDIATYPE_VIDEO,
} from './filter.js';

const S_OK = 0x00000000;
const IID_IMEDIA_EVENT_SINK = '{56A868A2-0AD4-11CE-B03A-0020AF0BA770}';
const EC_COMPLETE = 0x01;
/** IMediaEventSink::Notify's slot. */
const NOTIFY = 3;

export const CLSID_VIDEO_RENDERER = '{70E102B0-5556-11CE-97C0-00AA0055595A}';
export const CLSID_DSOUND_RENDER = '{79376820-07D0-11CF-A24D-0020AFD79767}';
export const CLSID_NULL_RENDERER = '{C1F400A4-3F08-11D3-9F0B-006008039E37}';

const MEDIASUBTYPE_PCM = '{00000001-0000-0010-8000-00AA00389B71}';
const MEDIASUBTYPE_IEEE_FLOAT = '{00000003-0000-0010-8000-00AA00389B71}';

/**
 * @typedef {Object} RendererSpec
 * @property {string} clsid
 * @property {string} pin       The input pin's name, as Windows names it.
 * @property {string} [id]      Its id, where it is not the name.
 * @property {(type: import('./filter.js').MediaType) => boolean} accepts
 */

/** @type {RendererSpec[]} */
export const RENDERERS = [
    {
        clsid: CLSID_VIDEO_RENDERER, pin: 'Input', id: 'In',
        accepts: type=>type.major === MEDIATYPE_VIDEO && type.formatType === FORMAT_VIDEO_INFO,
    },
    {
        clsid: CLSID_DSOUND_RENDER, pin: 'Audio Input pin (rendered)',
        accepts: type=>type.major === MEDIATYPE_AUDIO && type.formatType === FORMAT_WAVE_FORMAT_EX
            && (type.sub === MEDIASUBTYPE_PCM || type.sub === MEDIASUBTYPE_IEEE_FLOAT),
    },
    // qedit's: anything at all, nothing kept.
    { clsid: CLSID_NULL_RENDERER, pin: 'In', accepts: ()=>true },
];

/**
 * The renderers' classes over the filter base, by CLSID.
 *
 * @param {ReturnType<typeof import('./filter.js').createFilterBase>} base
 * @param {import('./filter.js').FilterHost} host
 * @returns {Map<string, () => import('../ole32/objects.js').ComClassDefinition>}
 */
export function createRenderers(base, host){
    /**
     * EC_COMPLETE to the graph the filter is in, which counts one per renderer.
     *
     * @param {import('./filter.js').Filter} filter
     */
    const complete = async filter=>{
        if (filter.graph === 0)
        {
            return;
        }
        const sink = await base.queryInterface(filter.graph, IID_IMEDIA_EVENT_SINK);
        if (sink === 0)
        {
            return;
        }
        const self = host.publish(/** @type {any} */ (filter.object),
            '{56A86895-0AD4-11CE-B03A-0020AF0BA770}');
        await base.call(sink, NOTIFY, [EC_COMPLETE, S_OK, self]);
        await base.release(sink);
    };

    return new Map(RENDERERS.map(spec=>[spec.clsid, base.defineFilter({
        clsid: spec.clsid,
        pins: ()=>[{
            name: spec.pin,
            id: spec.id,
            direction: 'input',
            types: ()=>[],
            accepts: (_pin, type)=>type.major !== GUID_NULL && spec.accepts(type),
            receive: ()=>S_OK,
            endOfStream: async pin=>{
                await complete(pin.filter);
                return S_OK;
            },
        }],
    })]));
}
