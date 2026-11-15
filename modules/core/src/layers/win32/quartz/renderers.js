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
import { describe } from './describe.js';
import { IID_IREFERENCE_CLOCK, IREFERENCE_CLOCK_SLOTS } from './interfaces.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const VFW_S_STATE_INTERMEDIATE = 0x00040237;
const INFINITE = 0xffffffff;
const E_POINTER = 0x80004003 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
/** IQualProp: a video renderer's frame counts. */
const IID_IQUAL_PROP = '{1BD0ECB0-F8E2-11CE-AAC6-0020AF0B99A3}';
/** @type {[string, number][]} */
const IQUAL_PROP_SLOTS = [['get_FramesDroppedInRenderer', 1], ['get_FramesDrawn', 1],
    ['get_AvgFrameRate', 1], ['get_Jitter', 1], ['get_AvgSyncOffset', 1],
    ['get_DevSyncOffset', 1]];
const CLSID_SYSTEM_CLOCK = '{E436EBB1-524F-11CE-9F53-0020AF0BA770}';
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
 * @property {boolean} [video]  Counts its frames (IQualProp), as a video renderer.
 * @property {boolean} [clock]  Exposes a reference clock, as the audio renderer does.
 * @property {boolean} [quality]  Answers IQualityControl, as quartz's renderers do.
 */

/** @type {RendererSpec[]} */
export const RENDERERS = [
    {
        clsid: CLSID_VIDEO_RENDERER, pin: 'Input', id: 'In', video: true, quality: true,
        accepts: type=>type.major === MEDIATYPE_VIDEO && type.formatType === FORMAT_VIDEO_INFO,
    },
    {
        clsid: CLSID_DSOUND_RENDER, pin: 'Audio Input pin (rendered)', clock: true,
        quality: true,
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
 * @param {ReturnType<typeof import('./passthru.js').createPassThru>} passThru
 * @returns {Map<string, () => import('../ole32/objects.js').ComClassDefinition>}
 */
export function createRenderers(base, host, passThru){
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

    /**
     * What every renderer here does with time, as the SDK's base renderer
     * documents it: paused, it holds the first sample it is given - the
     * picture a paused film shows - and its Receive does not return until the
     * filter runs, stops or is flushed; until that sample (or the end of the
     * stream) has come, Pause answers S_FALSE and GetState
     * VFW_S_STATE_INTERMEDIATE. The end of the stream reaches the graph as
     * EC_COMPLETE once the filter runs, at once if it is running.
     *
     * @typedef {Object} RendererState
     * @property {boolean} sample   The sample of this pause has come.
     * @property {boolean} ended    The end of the stream has come.
     * @property {boolean} told     EC_COMPLETE is sent for this run.
     * @property {(() => void)[]} held     Receives waiting to return.
     * @property {(() => void)[]} waiting  GetStates waiting for a sample.
     * @property {number} drawn    Samples rendered since the filter was made.
     * @property {number} clock    The reference clock it exposes, one reference
     *     held; 0 not made yet.
     */

    /** @param {import('./filter.js').Filter} filter @returns {RendererState} */
    const stateOf = filter=>filter.state2;

    /** Lets every held Receive return. @param {RendererState} state */
    const releaseHeld = state=>state.held.splice(0).forEach(done=>done());
    /** Wakes every GetState waiting. @param {RendererState} state */
    const wake = state=>state.waiting.splice(0).forEach(done=>done());

    /** @param {import('./filter.js').Filter} filter */
    const connected = filter=>filter.pins[0]?.peer !== 0;

    /** @param {import('./filter.js').Filter} filter */
    const ready = filter=>!connected(filter) || stateOf(filter).sample || stateOf(filter).ended;

    /** EC_COMPLETE once a run. @param {import('./filter.js').Filter} filter */
    const tellEnd = async filter=>{
        const state = stateOf(filter);
        if (state.ended && !state.told)
        {
            state.told = true;
            await complete(filter);
        }
    };

    /**
     * @param {import('./filter.js').Filter} filter @param {number} from @param {number} to
     */
    const changed = async(filter, from, to)=>{
        const state = stateOf(filter);
        if (to === base.STATE_STOPPED)
        {
            state.sample = false;
            state.ended = false;
            state.told = false;
            releaseHeld(state);
            wake(state);
            return S_OK;
        }
        if (to === base.STATE_RUNNING)
        {
            releaseHeld(state);
            filter.state = to;
            await tellEnd(filter);
            return S_OK;
        }
        if (from === base.STATE_STOPPED)
        {
            state.sample = false;
            state.ended = false;
            state.told = false;
        }
        return ready(filter) ? S_OK : S_FALSE;
    };

    /**
     * GetState: paused with nothing yet, wait up to the time given for a
     * sample or the end of the stream.
     *
     * @param {import('./filter.js').Filter} filter @param {number} timeout
     */
    const stateAnswer = async(filter, timeout)=>{
        if (filter.state !== base.STATE_PAUSED || ready(filter))
        {
            return S_OK;
        }
        if (timeout > 0)
        {
            const state = stateOf(filter);
            await new Promise(done=>{
                state.waiting.push(()=>done(undefined));
                if (timeout !== INFINITE)
                {
                    setTimeout(()=>done(undefined), Math.min(timeout, 0x7fffffff));
                }
            });
        }
        return ready(filter) || filter.state !== base.STATE_PAUSED ? S_OK
            : VFW_S_STATE_INTERMEDIATE;
    };

    /** @param {number} out @param {number} value */
    const writeLong = (out, value)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(out >>> 0, bytes);
        return S_OK;
    };

    /**
     * The renderer's own faces: seeking is passed to the pin feeding it, the
     * video and audio renderers take quality messages, a video renderer counts
     * its frames, the audio renderer has a clock - the system clock, which it
     * is driven by. None of them answers IAMFilterMiscFlags, as Windows'
     * renderers do not: the graph knows a renderer by its pins.
     *
     * @param {RendererSpec} spec @param {import('./filter.js').Filter} filter
     */
    const faces = (spec, filter)=>[
        ...spec.quality ? [base.qualityControl] : [],
        ...passThru.seekingFaces(()=>filter.pins[0]?.peer ?? 0),
        ...spec.video ? [describe(IID_IQUAL_PROP, IQUAL_PROP_SLOTS, {
            // Every sample is drawn as it comes, so none is dropped and none
            // is late: the counts are the frames drawn and zeros.
            get_FramesDroppedInRenderer: (_f, [out])=>writeLong(out, 0),
            get_FramesDrawn: (_f, [out])=>writeLong(out, stateOf(filter).drawn),
            get_AvgFrameRate: (_f, [out])=>writeLong(out, 0),
            get_Jitter: (_f, [out])=>writeLong(out, 0),
            get_AvgSyncOffset: (_f, [out])=>writeLong(out, 0),
            get_DevSyncOffset: (_f, [out])=>writeLong(out, 0),
        })] : [],
        ...spec.clock ? [describe(IID_IREFERENCE_CLOCK, IREFERENCE_CLOCK_SLOTS,
            Object.fromEntries(IREFERENCE_CLOCK_SLOTS.map(([name], index)=>[name,
                async(/** @type {any} */ _f, /** @type {number[]} */ args)=>{
                    const state = stateOf(filter);
                    if (state.clock === 0)
                    {
                        state.clock = await host.createInstance(CLSID_SYSTEM_CLOCK,
                            IID_IREFERENCE_CLOCK);
                    }
                    return state.clock === 0 ? E_UNEXPECTED
                        : base.call(state.clock, 3 + index, args);
                }])))] : [],
    ];

    return new Map(RENDERERS.map(spec=>[spec.clsid, base.defineFilter({
        clsid: spec.clsid,
        state: ()=>/** @type {RendererState} */ ({ sample: false, ended: false, told: false,
            held: [], waiting: [], drawn: 0, clock: 0 }),
        interfaces: filter=>faces(spec, filter),
        destroy: filter=>{
            if (stateOf(filter).clock !== 0)
            {
                void base.release(stateOf(filter).clock);
            }
        },
        changed,
        stateAnswer,
        pins: ()=>[{
            name: spec.pin,
            id: spec.id,
            direction: 'input',
            types: ()=>[],
            accepts: (_pin, type)=>type.major !== GUID_NULL && spec.accepts(type),
            receive: pin=>{
                const filter = pin.filter;
                const state = stateOf(filter);
                state.sample = true;
                state.drawn++;
                wake(state);
                if (filter.state !== base.STATE_PAUSED)
                {
                    return S_OK;
                }
                // Held until the filter runs, stops or is flushed.
                return new Promise(done=>state.held.push(()=>done(S_OK)));
            },
            endOfStream: async pin=>{
                const filter = pin.filter;
                const state = stateOf(filter);
                state.ended = true;
                wake(state);
                if (filter.state === base.STATE_RUNNING)
                {
                    await tellEnd(filter);
                }
                return S_OK;
            },
            flush: (pin, begin)=>{
                const state = stateOf(pin.filter);
                if (begin)
                {
                    releaseHeld(state);
                }
                else
                {
                    // A flushed renderer waits for a sample again.
                    state.sample = false;
                    state.ended = false;
                    state.told = false;
                }
                return S_OK;
            },
        }],
    })]));
}
