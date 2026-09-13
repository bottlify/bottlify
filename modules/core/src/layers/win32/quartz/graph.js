/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz.dll's filter graph: the object a program gets from
 * `CoCreateInstance(CLSID_FilterGraph, ...)` and drives a cinematic with.
 *
 * **Why a graph that refuses is the implementation and not a stub.** A filter
 * graph builds a chain of filters for a file and cannot do it when the machine
 * has no filter for the format -- a codec that was never installed, a decoder
 * shipped with something else. That is an ordinary state of a Windows machine,
 * and quartz has an exact vocabulary for it: `RenderFile` answers
 * VFW_E_CANNOT_RENDER, and a graph told to `Run` that cannot produce a frame
 * raises EC_ERRORABORT. Every program that plays optional media already handles
 * it, because on real hardware it happens. So this is not "a stub that returns
 * an error until the real thing exists" -- it is one of the two answers the real
 * thing gives, given honestly, and a program that takes the failing path takes
 * the path it was written to take rather than one we invented for it.
 *
 * The alternative -- succeeding and then never signalling anything -- is what
 * hangs a modal player loop forever, because a loop that exits on a completion
 * event is owed a completion event whichever way the graph ends.
 *
 * There is exactly one place that decides whether media can be opened, and
 * everything else reads its answer: `openMedia`. Handed a decoder it opens the
 * file and the graph carries a real clip -- its size, its length, its position;
 * handed none it keeps answering the way a machine with no filter for the
 * format answers, which is the paragraph above.
 *
 * Nothing here presents anything. `tick` decodes as far as the clock says and
 * hands the frame back; where it goes is the caller's business, because win32
 * may not reach the graphics layer and a filter graph has no opinion about
 * where a window's pixels live.
 */

import {
    CLSID_FILTER_GRAPH, CLSID_FILTER_GRAPH_NO_THREAD, CLSID_FILTER_MAPPER2,
    IBASIC_AUDIO_SLOTS, IBASIC_VIDEO_SLOTS, IFILTER_GRAPH_SLOTS, IFILTER_MAPPER2_SLOTS,
    IGRAPH_BUILDER_SLOTS, IID_IBASIC_AUDIO, IID_IBASIC_VIDEO, IID_IFILTER_GRAPH,
    IID_IFILTER_MAPPER2, IID_IGRAPH_BUILDER, IID_IMEDIA_CONTROL, IID_IMEDIA_EVENT,
    IID_IMEDIA_EVENT_EX, IID_IMEDIA_POSITION, IID_IMEDIA_SEEKING, IID_IVIDEO_WINDOW,
    IMEDIA_CONTROL_SLOTS, IMEDIA_EVENT_EX_SLOTS, IMEDIA_EVENT_SLOTS, IMEDIA_POSITION_SLOTS,
    IMEDIA_SEEKING_SLOTS, IVIDEO_WINDOW_SLOTS,
} from './interfaces.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_NOTIMPL = 0x80004001;
const E_POINTER = 0x80004003;
const E_ABORT = 0x80004004;
const E_INVALIDARG = 0x80070057;
const VFW_E_NOT_FOUND = 0x80040216;
const VFW_E_CANNOT_CONNECT = 0x80040217;
const VFW_E_CANNOT_RENDER = 0x80040218;
const VFW_E_WRONG_STATE = 0x80040227;
const VFW_E_CANNOT_LOAD_SOURCE_FILTER = 0x80040241;

/** Event codes. All three end a playback loop; only the reason differs. */
const EC_COMPLETE = 0x01;
const EC_ERRORABORT = 0x03;

/** OAFilterState, which GetState reports. */
const STATE_STOPPED = 0;
const STATE_PAUSED = 1;
const STATE_RUNNING = 2;

/** SetNotifyFlags' one flag: notifications are registered but not posted. */
const AM_MEDIAEVENT_NONOTIFY = 0x01;

/** The volume range IBasicAudio is defined over: hundredths of a decibel. */
const VOLUME_MIN = -10000;
const VOLUME_MAX = 0;

/**
 * What IBasicVideo reports for a stream nothing decoded.
 *
 * A program sizes its window from this before playback starts, so answering
 * with a failure would leave it computing a rectangle from an uninitialised
 * pair. These are the dimensions of the mode this era of program assumes when
 * it has nothing better.
 */
const DEFAULT_VIDEO_WIDTH = 640;
const DEFAULT_VIDEO_HEIGHT = 480;

/** A file name no longer than Windows would hand a filter graph. */
const MAX_PATH = 260;

/**
 * How many frames one tick may decode, and how many decoder steps it may take
 * to find them.
 *
 * ponytail: a fixed catch-up budget rather than dropping frames to keep the
 * clock. A run that stalls for a second falls behind and the film plays slower
 * instead of skipping; correcting that needs a decoder that can seek, and this
 * one decodes forward only.
 */
const FRAMES_PER_TICK = 4;
const STEPS_PER_TICK = 16;

/**
 * How far the picture may be decoded past the sound that has been heard.
 *
 * A frame is shown the moment it is decoded, so this is also how far the
 * picture leads the sound. It is a lead rather than nothing because the sound
 * decoded with those frames is what keeps a device fed through a turn that took
 * a while, and a device left with nothing is heard at once where a frame a
 * fifth of a second early is not.
 */
const SOUND_LEAD_MS = 200;

/**
 * How long the sound may fail to move before the film stops following it.
 *
 * Nothing may be draining what the mixer writes -- a build with no device, a
 * context a browser has suspended -- and a film that follows a sound which has
 * stopped is a still picture. Once nothing has been heard for this long the
 * picture goes back to the host clock alone, and says so.
 */
const SOUND_STALL_MS = 500;

/** A REFERENCE_TIME is a hundred nanoseconds. */
const TICKS_PER_SECOND = 10_000_000;

/** IVideoWindow's long properties, each with a put_ and a get_ slot. */
const WINDOW_PROPERTIES = [
    'WindowStyle', 'WindowStyleEx', 'AutoShow', 'WindowState', 'BackgroundPalette',
    'Visible', 'Left', 'Width', 'Top', 'Height', 'Owner', 'MessageDrain',
    'BorderColor', 'FullScreenMode',
];

/** IBasicAudio's, the same shape. */
const AUDIO_PROPERTIES = ['Volume', 'Balance'];

/**
 * @typedef {Object} VideoClip
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {number} frameCount
 * @property {boolean} hasVideo
 * @property {boolean} hasAudio
 * @property {number} sampleRate  The film's own rate, not the device's.
 * @property {number} channels
 * @property {() => 'frame' | 'audio' | 'end'} decode
 * @property {() => Uint8Array | null} frame
 *           The current frame as BGRA. A view into the decoder's own memory,
 *           valid until the next call into it.
 * @property {(() => Int16Array | null) | undefined} [readAudio]
 *           Whatever PCM the decoder is holding, and null when it holds none.
 *           `decode` stops early to have this taken, and it is also read on its
 *           own to take what the decoder has not stopped for yet.
 * @property {() => void} close
 */

/**
 * @typedef {Object} GraphEvent
 * @property {number} code    EC_COMPLETE, EC_USERABORT or EC_ERRORABORT.
 * @property {number} param1
 * @property {number} param2
 */

/**
 * @typedef {Object} NotifyTarget
 * @property {number} hwnd      Zero once nothing is registered.
 * @property {number} message   The private message the window expects.
 * @property {number} instance  Handed back as the message's lParam.
 * @property {number} flags
 */

/**
 * @typedef {Object} FilterGraphState
 * @property {number} state         One of the STATE_ constants.
 * @property {boolean} loaded       Whether a stream was actually rendered.
 * @property {number} failure       Why not, for the event Run raises.
 * @property {NotifyTarget} notify
 * @property {GraphEvent[]} events
 * @property {Record<string, number>} window
 * @property {Record<string, number>} audio
 * @property {{ width: number, height: number }} video
 * @property {VideoClip | null} clip   What RenderFile opened, when it opened one.
 * @property {number} film             Which clip this is, so that whoever plays
 *                                     the sound can tell one from the next.
 * @property {number} shown            Frames decoded and handed over so far.
 * @property {number} soundMs
 *           Milliseconds of this film's own sound handed over so far, which is
 *           where the sound has reached in the film -- as against where it has
 *           reached in the room, which is this less what is still owed.
 * @property {number} heardMs
 *           The furthest the sound has been heard, in milliseconds of the film.
 *           Monotonic: a position that went backwards would take the picture
 *           back with it.
 * @property {number | null} soundMovedAt
 *           Host milliseconds the sound was last seen making progress. Null
 *           while nothing is reporting it at all.
 * @property {number | null} startedAt
 *           Host milliseconds the present run began, moved forward by whatever
 *           a pause or a decode that could not keep up cost. Null until the
 *           first tick after Run, so that Run needs no clock of its own.
 * @property {boolean} finished        Whether EC_COMPLETE has been raised.
 */

/**
 * The one decision about whether media can be played.
 *
 * Nothing here decodes anything yet, so a graph is built with no filters in it
 * at all: it renders a presentation of no length, which finishes the instant it
 * is run. That is a real state, not a pretence -- an empty graph is exactly
 * what Windows leaves you with when every stream in a file has been rendered to
 * nothing -- and `Run` reports it the way that state is reported, with
 * EC_COMPLETE.
 *
 * Refusing outright was tried first and is worse, for a reason worth recording.
 * A program that plays optional media checks RenderFile, releases the graph it
 * cannot use, and carries on -- and then its own hundred-millisecond caption
 * timer, armed unconditionally a moment earlier, reads the pointer it has just
 * released. A refusal that is handled correctly by the program still ends in
 * the program dereferencing nothing. Completing at once takes the same path
 * that finishing a real film takes, which is a path the program is written for.
 *
 * With a decoder the answer is a real one, and the empty-graph reasoning above
 * applies only to what it cannot open.
 *
 * @param {QuartzHost} host
 * @param {number} path  Guest address of the wide file name, or zero.
 * @returns {VideoClip | Promise<VideoClip | null> | null}
 */
function openMedia(host, path){
    const name = host.video && (path >>> 0) !== 0
        ? host.readWideString?.(path >>> 0, MAX_PATH) ?? ''
        : '';
    return name === '' ? null : host.video?.open(name) ?? null;
}

/** @returns {FilterGraphState} */
function newGraphState(){
    return {
        state: STATE_STOPPED,
        loaded: false,
        failure: VFW_E_CANNOT_RENDER,
        notify: { hwnd: 0, message: 0, instance: 0, flags: 0 },
        events: [],
        window: {
            ...Object.fromEntries(WINDOW_PROPERTIES.map(name=>[name, 0])),
            // A video window is shown by default and sized to the stream; a
            // program reads these back before it has set anything.
            AutoShow: 1,
            Visible: 1,
            WindowState: 1, // SW_SHOWNORMAL
            Width: DEFAULT_VIDEO_WIDTH,
            Height: DEFAULT_VIDEO_HEIGHT,
        },
        audio: Object.fromEntries(AUDIO_PROPERTIES.map(name=>[name, 0])),
        video: { width: DEFAULT_VIDEO_WIDTH, height: DEFAULT_VIDEO_HEIGHT },
        clip: null,
        film: 0,
        shown: 0,
        soundMs: 0,
        heardMs: 0,
        soundMovedAt: null,
        startedAt: null,
        finished: false,
    };
}

/**
 * Builds an interface descriptor from `[name, dwords]` pairs.
 *
 * The count excludes the interface pointer, because that is how a header reads
 * and transcribing a header is what the slot lists are; `argBytes` adds it back
 * because that is how the bridge counts. A slot with no implementation keeps
 * its place and answers E_NOTIMPL.
 *
 * @template S
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (state: S, args: number[]) => number | Promise<number>>} [implemented]
 *        A method may answer with a promise: the bridge parks the calling
 *        thread until it settles, which is what building a graph over a file
 *        that has to be fetched needs.
 * @returns {import('../ole32/objects.js').ComInterfaceDescriptor}
 */
function describe(id, slots, implemented = {}){
    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const methods = slots.map(([name, dwords])=>{
        const method = implemented[name];
        return {
            name,
            argBytes: 4 + dwords * 4,
            invoke: method ? (object, args)=>method(object.state, args) : undefined,
        };
    });
    return { id, methods };
}

/**
 * @typedef {Object} QuartzHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(message: { hwnd: number, message: number,
 *                        wParam: number, lParam: number }) => void} post
 *           Puts a message in the thread's queue, which is how a graph reaches
 *           the window a program gave it.
 * @property {((address: number, maxLength: number) => string) | undefined}
 *           [readWideString]  The file name RenderFile was given.
 * @property {{ open: (path: string) => VideoClip | Promise<VideoClip | null> | null }
 *           | undefined} [video]
 *           Where a file becomes a clip. Absent in a build assembled without a
 *           decoder, and then every graph is the empty one.
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 *           Where "this call succeeded and did not do all of what it promises"
 *           goes, once per distinct difference.
 */

/**
 * Every class quartz.dll implements, ready to be registered.
 *
 * @param {QuartzHost} host
 */
export function createQuartz(host){
    /** @param {number} address @param {number} value @returns {number} an HRESULT */
    const writeLong = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return E_POINTER;
        }
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setInt32(0, value | 0, true);
        host.writeMemory(address >>> 0, bytes);
        return S_OK;
    };

    /** REFTIME, which is a double in seconds. @param {number} address @param {number} value */
    const writeDouble = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return E_POINTER;
        }
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value, true);
        host.writeMemory(address >>> 0, bytes);
        return S_OK;
    };

    /** REFERENCE_TIME, which is a LONGLONG. @param {number} address @param {number} value */
    const writeLongLong = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return E_POINTER;
        }
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigInt64(0, BigInt(value), true);
        host.writeMemory(address >>> 0, bytes);
        return S_OK;
    };

    /** @param {number} seconds @returns {number} the same in REFERENCE_TIME units */
    const reference = seconds=>Math.round(seconds * TICKS_PER_SECOND);

    /**
     * Several out-parameters at once, the shape most of the getters below have.
     * Every one is filled even if an earlier one could not be, because a caller
     * that passed four pointers reads all four; the answer is the first failure.
     *
     * @param {(address: number, value: number) => number} write
     * @param {[number, number][]} outputs  address and value, in argument order.
     */
    const writeEach = (write, outputs)=>outputs.reduce(
        (result, [address, value])=>{
            const written = write(address, value);
            return result === S_OK ? written : result;
        }, S_OK);

    /**
     * Reports a failure having zeroed the pointer it refused to fill: a program
     * checks the pointer at least as often as the HRESULT, and one left holding
     * whatever was on the stack is a pointer it will call through.
     *
     * @param {number} out @param {number} result
     */
    const refuse = (out, result)=>{
        if ((out >>> 0) !== 0)
        {
            writeLong(out, 0);
        }
        return result;
    };

    /**
     * Queues an event and tells the notify window there is one.
     *
     * The window is only ever told that something happened -- the event itself
     * is collected with GetEvent -- so wParam is zero and lParam carries the
     * instance data the program registered, which is what quartz posts.
     *
     * @param {FilterGraphState} graph
     * @param {number} code @param {number} param1 @param {number} param2
     */
    const raise = (graph, code, param1, param2)=>{
        graph.events.push({ code, param1: param1 >>> 0, param2: param2 >>> 0 });
        const { hwnd, message, instance, flags } = graph.notify;
        if (hwnd !== 0 && (flags & AM_MEDIAEVENT_NONOTIFY) === 0)
        {
            host.post({ hwnd, message, wParam: 0, lParam: instance });
        }
    };

    /** Graphs with a clip that are running, so `tick` knows what to advance. */
    /** @type {Set<FilterGraphState>} */
    const playing = new Set();

    /** @param {FilterGraphState} graph @returns {number} seconds, zero without a clip */
    const duration = graph=>(graph.clip && graph.clip.fps > 0
        ? graph.clip.frameCount / graph.clip.fps
        : 0);

    /** @param {FilterGraphState} graph @returns {number} seconds shown so far */
    const position = graph=>(graph.clip && graph.clip.fps > 0
        ? graph.shown / graph.clip.fps
        : 0);

    /**
     * The one event a playback loop is owed, raised once.
     *
     * DirectShow hands each event out exactly once and a program drains the
     * queue with `while (SUCCEEDED(GetEvent))`; raising completion again on the
     * next tick would refill the queue as fast as the program empties it and
     * the loop would never end.
     *
     * @param {FilterGraphState} graph
     */
    const complete = graph=>{
        if (graph.finished)
        {
            return;
        }
        graph.finished = true;
        playing.delete(graph);
        raise(graph, EC_COMPLETE, S_OK, 0);
    };

    /**
     * Running is where a graph that could not be built has to say so: building
     * it failed earlier, and a program that ignored that HRESULT is still owed
     * the event its playback loop waits for.
     *
     * @param {FilterGraphState} graph
     */
    const run = graph=>{
        graph.state = STATE_RUNNING;
        if (!graph.loaded)
        {
            raise(graph, EC_ERRORABORT, graph.failure, 0);
            return S_OK;
        }
        if (graph.clip)
        {
            // The clock starts at the first tick rather than here, so that Run
            // needs no clock of its own and a graph run before anything drives
            // it does not lose the time in between.
            graph.startedAt = null;
            playing.add(graph);
            return S_OK;
        }
        // A graph with nothing in it has already reached the end of what it
        // had to present, so it says so at once -- the same event a whole film
        // ends with, and the path every program is written for.
        complete(graph);
        return S_OK;
    };

    /** @param {FilterGraphState} graph @param {number} result */
    const recordFailure = (graph, result)=>{
        graph.loaded = false;
        graph.failure = result;
        return result;
    };

    /**
     * Which film any of these graphs is on. Handed out rather than counted per
     * graph, so that whoever plays the sound of one can tell it apart from the
     * next without knowing which graph it came from.
     */
    let films = 0;

    /** @param {FilterGraphState} graph @param {number} path */
    const render = (graph, path)=>{
        graph.clip?.close();
        graph.loaded = true;
        graph.clip = null;
        graph.film = ++films;
        graph.shown = 0;
        graph.soundMs = 0;
        graph.heardMs = 0;
        graph.soundMovedAt = null;
        graph.startedAt = null;
        graph.finished = false;

        /** @param {VideoClip | null} clip */
        const took = clip=>{
            graph.clip = clip;
            if (clip)
            {
                graph.video.width = clip.width;
                graph.video.height = clip.height;
                graph.window.Width = clip.width;
                graph.window.Height = clip.height;
            }
            return S_OK;
        };

        // Opening reads a file, and reading one may mean waiting for it: a
        // bundle answers in blocks over the network. The bridge parks the
        // calling thread on a promise the same way it does for any other call
        // that cannot answer yet, and a real graph is no quicker -- building
        // one opens the file and reads its headers before it returns.
        const opened = openMedia(host, path);
        return typeof (/** @type {any} */ (opened))?.then === 'function'
            ? /** @type {Promise<VideoClip | null>} */ (opened).then(took, ()=>took(null))
            : took(/** @type {VideoClip | null} */ (opened));
    };

    /**
     * Stopping ends the presentation and lets the clip go.
     *
     * Rewinding is what a real graph does here, and this decoder only reads
     * forward: a program that stops and runs again gets what is left, which is
     * usually nothing. Said out loud rather than silently replayed from the
     * middle.
     *
     * @param {FilterGraphState} graph
     */
    const stopGraph = graph=>{
        graph.state = STATE_STOPPED;
        playing.delete(graph);
        if (graph.clip && graph.shown > 0 && !graph.finished)
        {
            host.divergence?.('DirectShow',
                'IMediaControl::Stop cannot rewind: this decoder reads forward only,'
                + ' so running the same graph again resumes rather than restarting');
        }
        return S_OK;
    };

    /**
     * Advances every running clip as far as the clock says, and as far as its
     * own sound has been heard.
     *
     * Driven from outside because a filter graph has no thread here and win32
     * may not reach the layer that would show a frame. What comes back is the
     * newest frame decoded this tick -- a view into the decoder's memory, good
     * until the next call into it -- and whatever sound came with it.
     *
     * A film has one timeline and used to be advanced along it by two clocks:
     * the picture was decoded at the rate the host counted seconds, the sound
     * played at the rate a device consumed it, and whatever the difference was
     * accumulated for as long as the film ran. The host clock still moves the
     * film -- it is the one thing that cannot stop -- but the picture waits
     * whenever the sound it has already produced has not been heard yet, which
     * is what keeps the two together. Waiting rather than following outright:
     * a sound clock that stops because a device starved would otherwise stop
     * the film with it, and the film would play in slow motion.
     *
     * @param {number} nowMs  The host clock, which the film advances against.
     * @param {number | null} [soundOwedMs]
     *        Milliseconds of the running film's own sound handed over and not
     *        played yet. Null where nothing can say -- no mixer, nothing
     *        draining it, a film that has produced no sound yet -- and then
     *        nothing holds the picture back and the graph says so.
     * @returns {{ hwnd: number, width: number, height: number,
     *             bgra: Uint8Array | null, audio: Int16Array[],
     *             sampleRate: number, channels: number,
     *             positionMs: number, film: number } | null}
     */
    const tick = (nowMs, soundOwedMs = null)=>{
        /** @type {ReturnType<typeof tick>} */
        let shown = null;
        for (const graph of [...playing])
        {
            const clip = graph.clip;
            if (!clip)
            {
                playing.delete(graph);
                continue;
            }
            if (graph.startedAt === null)
            {
                graph.startedAt = nowMs;
            }
            // Where the sound has reached in the room: everything handed over,
            // less what is still waiting to be played.
            if (soundOwedMs === null)
            {
                // Nothing is reporting the sound, so nothing about it has stood
                // still: the wait is armed again from whenever a first report
                // arrives. What has been handed over is emphatically not
                // credited as heard here -- that would place the picture
                // against sound nobody has played.
                graph.soundMovedAt = nowMs;
            }
            else
            {
                const heard = Math.max(0, graph.soundMs - soundOwedMs);
                if (graph.soundMovedAt === null || heard > graph.heardMs)
                {
                    graph.heardMs = heard;
                    graph.soundMovedAt = nowMs;
                }
            }
            // A sound that has not moved for this long is one nothing is
            // playing -- a device that stopped, or one that cannot keep up
            // while the machine decodes. The film must not wait on either: it
            // goes back to the host clock, because a film at half speed is a
            // worse fault than one whose sound is late.
            const moving = soundOwedMs !== null
                && nowMs - graph.soundMovedAt < SOUND_STALL_MS;
            if (!moving && clip.hasAudio)
            {
                host.divergence?.('DirectShow',
                    soundOwedMs === null
                        ? 'a film is running on the host clock alone because nothing is'
                            + ' reporting its sound: the picture may drift against it'
                        : 'a film is running on the host clock alone because its sound has'
                            + ' stopped moving: the picture may drift against it');
            }
            // The whole of the synchronisation: the picture is decoded to just
            // ahead of the sound a person is actually hearing -- far enough
            // ahead to keep a device fed through a turn that took a while, and
            // no further. The host clock is only the fallback.
            const want = moving
                ? Math.floor((graph.heardMs + SOUND_LEAD_MS) * clip.fps / 1000)
                : Math.floor((nowMs - graph.startedAt) * clip.fps / 1000);
            /** @type {Int16Array[]} */
            const audio = [];
            /** @type {Uint8Array | null} */
            let frame = null;
            let decoded = 0;
            let steps = 0;
            while (graph.shown < want && decoded < FRAMES_PER_TICK && steps++ < STEPS_PER_TICK)
            {
                const what = clip.decode();
                if (what === 'frame')
                {
                    graph.shown++;
                    decoded++;
                    frame = clip.frame();
                    continue;
                }
                if (what === 'audio')
                {
                    const block = clip.readAudio?.() ?? null;
                    if (block)
                    {
                        audio.push(block);
                    }
                    continue;
                }
                complete(graph);
                break;
            }
            // Whatever sound the decoder is still holding goes now, rather than
            // waiting for a tick that wants another frame: it belongs with
            // pictures already shown, and every tick it waits inside is a tick
            // it is heard late by.
            const residue = clip.readAudio?.();
            if (residue)
            {
                audio.push(residue);
            }
            for (const block of audio)
            {
                graph.soundMs += block.length / clip.channels * 1000 / clip.sampleRate;
            }
            // Whatever the budget could not reach is time the film does not get
            // to have: the clock is moved up to what was actually shown, so a
            // stall slows playback rather than throwing frames away. A wait on
            // the sound is credited the same way -- time the clock kept while
            // the film was held would be spent on frames the moment it resumed,
            // and the wait would have bought nothing.
            if (moving || graph.shown < want)
            {
                graph.startedAt = nowMs - (graph.shown * 1000 / clip.fps);
            }
            if (frame || audio.length > 0)
            {
                shown = {
                    hwnd: graph.window.Owner >>> 0,
                    width: clip.width,
                    height: clip.height,
                    bgra: frame,
                    audio,
                    // Where this frame sits in the film, so that whoever plays
                    // the sound can say how far apart the two have got.
                    positionMs: graph.shown * 1000 / clip.fps,
                    // Which film it belongs to: the sound of the last one is
                    // not played over this one, and the clock the picture
                    // follows starts again at zero.
                    film: graph.film,
                    // The film's own rate, which is its own and not the
                    // device's: whoever plays it has to open a track for it
                    // rather than assume the mixer's.
                    sampleRate: clip.sampleRate,
                    channels: clip.channels,
                };
            }
        }
        return shown;
    };

    /**
     * put_X and get_X over a record of longs, which is the whole of IBasicAudio
     * and most of IVideoWindow.
     *
     * @param {string[]} names
     * @param {(graph: FilterGraphState) => Record<string, number>} bag
     * @param {(name: string, value: number) => number} [validate]
     * @returns {Record<string,
     *           (graph: FilterGraphState, args: number[]) => number | Promise<number>>}
     */
    const properties = (names, bag, validate)=>{
        /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
        const table = {};
        for (const name of names)
        {
            table[`put_${name}`] = (graph, [value])=>{
                const refused = validate?.(name, value | 0) ?? S_OK;
                if (refused !== S_OK)
                {
                    return refused;
                }
                bag(graph)[name] = value | 0;
                return S_OK;
            };
            table[`get_${name}`] = (graph, [out])=>writeLong(out, bag(graph)[name]);
        }
        return table;
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const graphBuilder = {
        /** HRESULT EnumFilters(IEnumFilters **ppEnum) */
        EnumFilters: (graph, [out])=>refuse(out, E_NOTIMPL),

        /** HRESULT FindFilterByName(LPCWSTR pName, IBaseFilter **ppFilter) */
        FindFilterByName: (graph, [, out])=>refuse(out, VFW_E_NOT_FOUND),

        /** HRESULT SetDefaultSyncSource(void) */
        SetDefaultSyncSource: ()=>S_OK,

        /** HRESULT Connect(IPin *ppinOut, IPin *ppinIn) */
        Connect: ()=>VFW_E_CANNOT_CONNECT,

        /** HRESULT Render(IPin *ppinOut) */
        Render: graph=>recordFailure(graph, VFW_E_CANNOT_RENDER),

        /** HRESULT RenderFile(LPCWSTR lpcwstrFile, LPCWSTR lpcwstrPlayList) */
        RenderFile: (graph, [path])=>render(graph, path),

        /** HRESULT AddSourceFilter(LPCWSTR, LPCWSTR, IBaseFilter **ppFilter) */
        AddSourceFilter: (graph, [, , out])=>
            refuse(out, recordFailure(graph, VFW_E_CANNOT_LOAD_SOURCE_FILTER)),

        /** HRESULT Abort(void) */
        Abort: ()=>S_OK,

        /**
         * HRESULT ShouldOperationContinue(void)
         *
         * S_FALSE means stop. Nothing here has an operation in progress, so
         * there is nothing for a filter asking this to continue with.
         */
        ShouldOperationContinue: ()=>S_FALSE,
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const mediaControl = {
        /** HRESULT Run(void) */
        Run: graph=>run(graph),

        /**
         * HRESULT Pause(void)
         *
         * Taken out of the playing set rather than flagged: what stops is the
         * clock, and the frames already decoded stay where they are.
         */
        Pause: graph=>{
            graph.state = STATE_PAUSED;
            playing.delete(graph);
            return S_OK;
        },

        /** HRESULT Stop(void) */
        Stop: graph=>stopGraph(graph),

        /** HRESULT StopWhenReady(void) */
        StopWhenReady: graph=>stopGraph(graph),

        /** HRESULT GetState(LONG msTimeout, OAFilterState *pfs) */
        GetState: (graph, [, out])=>writeLong(out, graph.state),

        /** HRESULT RenderFile(BSTR strFilename) — a BSTR is wide, like the other one. */
        RenderFile: (graph, [path])=>render(graph, path),

        /** HRESULT AddSourceFilter(BSTR strFilename, IDispatch **ppUnk) */
        AddSourceFilter: (graph, [, out])=>
            refuse(out, recordFailure(graph, VFW_E_CANNOT_LOAD_SOURCE_FILTER)),

        /** HRESULT get_FilterCollection(IDispatch **ppUnk) */
        get_FilterCollection: (graph, [out])=>refuse(out, E_NOTIMPL),

        /** HRESULT get_RegFilterCollection(IDispatch **ppUnk) */
        get_RegFilterCollection: (graph, [out])=>refuse(out, E_NOTIMPL),
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const mediaEvent = {
        /**
         * HRESULT GetEventHandle(OAEVENT *hEvent)
         *
         * The other way to learn an event is waiting: a handle the program
         * waits on itself. There is no event object behind this graph, and
         * handing out a handle that never signals would be worse than saying
         * so -- a program told this fails uses the notify window instead.
         */
        GetEventHandle: (graph, [out])=>refuse(out, E_NOTIMPL),

        /**
         * HRESULT GetEvent(long *lEventCode, LONG_PTR *lParam1, LONG_PTR *lParam2,
         *                  long msTimeout)
         *
         * E_ABORT for an empty queue is what quartz answers once the timeout has
         * expired, and an event pump written against it treats that as "nothing
         * more for now" rather than as an error. Nothing here waits, so the
         * timeout is not consulted: every event this graph produces is already
         * queued by the time the program is told to come and look.
         */
        GetEvent: (graph, [codeOut, firstOut, secondOut])=>{
            if ((codeOut >>> 0) === 0 || (firstOut >>> 0) === 0 || (secondOut >>> 0) === 0)
            {
                return E_POINTER;
            }
            const event = graph.events.shift();
            if (!event)
            {
                return E_ABORT;
            }
            writeLong(codeOut, event.code);
            writeLong(firstOut, event.param1);
            writeLong(secondOut, event.param2);
            return S_OK;
        },

        /**
         * HRESULT WaitForCompletion(long msTimeout, long *pEvCode)
         *
         * The alternative to a pump: a program blocks here instead of watching
         * its message queue. Nothing waits, so this answers only from what is
         * already queued.
         */
        WaitForCompletion: (graph, [, out])=>{
            if (graph.state !== STATE_RUNNING)
            {
                return VFW_E_WRONG_STATE;
            }
            const event = graph.events.shift();
            if (!event)
            {
                return E_ABORT;
            }
            return writeLong(out, event.code);
        },

        /** HRESULT FreeEventParams(long lEvCode, LONG_PTR lParam1, LONG_PTR lParam2) */
        FreeEventParams: ()=>S_OK,

        /** HRESULT CancelDefaultHandling(long lEvCode) */
        CancelDefaultHandling: ()=>S_OK,

        /** HRESULT RestoreDefaultHandling(long lEvCode) */
        RestoreDefaultHandling: ()=>S_OK,

        /** HRESULT SetNotifyWindow(OAHWND hwnd, long lMsg, LONG_PTR lInstanceData) */
        SetNotifyWindow: (graph, [hwnd, message, instance])=>{
            graph.notify.hwnd = hwnd >>> 0;
            graph.notify.message = message >>> 0;
            graph.notify.instance = instance >>> 0;
            return S_OK;
        },

        /** HRESULT SetNotifyFlags(long lNoNotifyFlags) */
        SetNotifyFlags: (graph, [flags])=>{
            if ((flags >>> 0) !== 0 && (flags >>> 0) !== AM_MEDIAEVENT_NONOTIFY)
            {
                return E_INVALIDARG;
            }
            graph.notify.flags = flags >>> 0;
            return S_OK;
        },

        /** HRESULT GetNotifyFlags(long *lplNoNotifyFlags) */
        GetNotifyFlags: (graph, [out])=>writeLong(out, graph.notify.flags),
    };

    /** @param {FilterGraphState} graph @param {number[]} outputs */
    const windowPosition = (graph, [left, top, width, height])=>writeEach(writeLong, [
        [left, graph.window.Left], [top, graph.window.Top],
        [width, graph.window.Width], [height, graph.window.Height],
    ]);

    /** @param {FilterGraphState} graph @param {number[]} outputs */
    const videoSize = (graph, [width, height])=>writeEach(writeLong, [
        [width, graph.video.width], [height, graph.video.height],
    ]);

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const videoWindow = {
        ...properties(WINDOW_PROPERTIES, graph=>graph.window),

        /**
         * HRESULT put_Caption(BSTR strCaption)
         *
         * Accepted and dropped. get_Caption is left unimplemented instead of
         * handing the string back: the caller would own and free whatever it
         * received, and there is no BSTR here to give it.
         */
        put_Caption: ()=>S_OK,

        /** HRESULT SetWindowPosition(long Left, long Top, long Width, long Height) */
        SetWindowPosition: (graph, [left, top, width, height])=>{
            Object.assign(graph.window, {
                Left: left | 0, Top: top | 0, Width: width | 0, Height: height | 0,
            });
            return S_OK;
        },

        /** HRESULT GetWindowPosition(long *pLeft, long *pTop, long *pWidth, long *pHeight) */
        GetWindowPosition: (graph, args)=>windowPosition(graph, args),

        /**
         * HRESULT GetRestorePosition(long *pLeft, long *pTop, long *pWidth, long *pHeight)
         *
         * Where the window would go if it left full screen. Nothing here ever
         * enters full screen, so that is where it already is.
         */
        GetRestorePosition: (graph, args)=>windowPosition(graph, args),

        /** HRESULT GetMinIdealImageSize(long *pWidth, long *pHeight) */
        GetMinIdealImageSize: (graph, args)=>videoSize(graph, args),

        /** HRESULT GetMaxIdealImageSize(long *pWidth, long *pHeight) */
        GetMaxIdealImageSize: (graph, args)=>videoSize(graph, args),

        /** HRESULT SetWindowForeground(long Focus) */
        SetWindowForeground: ()=>S_OK,

        /** HRESULT NotifyOwnerMessage(OAHWND hwnd, long uMsg, LONG_PTR wParam, LONG_PTR lParam) */
        NotifyOwnerMessage: ()=>S_OK,

        /** HRESULT HideCursor(long HideCursor) */
        HideCursor: ()=>S_OK,

        /** HRESULT IsCursorHidden(long *CursorHidden) */
        IsCursorHidden: (graph, [out])=>writeLong(out, 0),
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const basicVideo = {
        /** HRESULT get_VideoWidth(long *pVideoWidth) */
        get_VideoWidth: (graph, [out])=>writeLong(out, graph.video.width),

        /** HRESULT get_VideoHeight(long *pVideoHeight) */
        get_VideoHeight: (graph, [out])=>writeLong(out, graph.video.height),

        /** HRESULT GetVideoSize(long *pWidth, long *pHeight) */
        GetVideoSize: (graph, args)=>videoSize(graph, args),

        /** HRESULT IsUsingDefaultSource(void) */
        IsUsingDefaultSource: ()=>S_OK,

        /** HRESULT IsUsingDefaultDestination(void) */
        IsUsingDefaultDestination: ()=>S_OK,
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const basicAudio = properties(AUDIO_PROPERTIES, graph=>graph.audio,
        // Both are defined over the same range, and a value outside it is the
        // one documented failure either setter has.
        (name, value)=>(value >= VOLUME_MIN && value <= VOLUME_MAX ? S_OK : E_INVALIDARG));

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const mediaPosition = {
        /** HRESULT get_Duration(REFTIME *plength) */
        get_Duration: (graph, [out])=>writeDouble(out, duration(graph)),

        /**
         * HRESULT get_CurrentPosition(REFTIME *pllTime)
         *
         * Counted in frames handed over rather than in wall clock: a program
         * that waits for the position to reach the duration is waiting for the
         * film to have been shown, not for the time to have passed.
         */
        get_CurrentPosition: (graph, [out])=>writeDouble(out, position(graph)),

        /** HRESULT get_StopTime(REFTIME *pllTime) */
        get_StopTime: (graph, [out])=>writeDouble(out, duration(graph)),

        /** HRESULT get_PrerollTime(REFTIME *pllTime) */
        get_PrerollTime: (graph, [out])=>writeDouble(out, 0),

        /**
         * HRESULT put_CurrentPosition(REFTIME llTime)
         *
         * Accepted and not acted on: this decoder reads forward only. Refusing
         * would be worse -- a program seeking to zero before playing is asking
         * for what it is about to get anyway -- but it is not a seek.
         */
        put_CurrentPosition: graph=>{
            if (graph.clip)
            {
                host.divergence?.('DirectShow',
                    'IMediaPosition::put_CurrentPosition is accepted and does not seek:'
                    + ' this decoder reads forward only');
            }
            return S_OK;
        },

        /** HRESULT put_StopTime(REFTIME llTime) */
        put_StopTime: ()=>S_OK,

        /** HRESULT put_PrerollTime(REFTIME llTime) */
        put_PrerollTime: ()=>S_OK,

        /** HRESULT put_Rate(double dRate) — accepted; a clip plays at its own rate. */
        put_Rate: graph=>{
            if (graph.clip)
            {
                host.divergence?.('DirectShow',
                    'IMediaPosition::put_Rate is accepted and ignored:'
                    + ' a clip is decoded at the rate it was recorded at');
            }
            return S_OK;
        },

        /** HRESULT get_Rate(double *pdRate) */
        get_Rate: (graph, [out])=>writeDouble(out, 1),

        /** HRESULT CanSeekForward(LONG *pCanSeekForward) — OAFALSE is zero. */
        CanSeekForward: (graph, [out])=>writeLong(out, 0),

        /** HRESULT CanSeekBackward(LONG *pCanSeekBackward) */
        CanSeekBackward: (graph, [out])=>writeLong(out, 0),
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number | Promise<number>>} */
    const mediaSeeking = {
        /**
         * HRESULT GetCapabilities(DWORD *pCapabilities)
         *
         * None. A program that reads this before seeking learns not to, which
         * is why the time-format methods below it can stay unimplemented.
         */
        GetCapabilities: (graph, [out])=>writeLong(out, 0),

        /** HRESULT GetDuration(LONGLONG *pDuration) */
        GetDuration: (graph, [out])=>writeLongLong(out, reference(duration(graph))),

        /** HRESULT GetStopPosition(LONGLONG *pStop) */
        GetStopPosition: (graph, [out])=>writeLongLong(out, reference(duration(graph))),

        /** HRESULT GetCurrentPosition(LONGLONG *pCurrent) */
        GetCurrentPosition: (graph, [out])=>writeLongLong(out, reference(position(graph))),

        /** HRESULT GetPreroll(LONGLONG *pllPreroll) */
        GetPreroll: (graph, [out])=>writeLongLong(out, 0),

        /** HRESULT GetPositions(LONGLONG *pCurrent, LONGLONG *pStop) */
        GetPositions: (graph, [current, stop])=>writeEach(writeLongLong,
            [[current, reference(position(graph))], [stop, reference(duration(graph))]]),

        /** HRESULT SetPositions(LONGLONG *pCurrent, DWORD, LONGLONG *pStop, DWORD) */
        SetPositions: ()=>S_OK,

        /** HRESULT SetRate(double dRate) */
        SetRate: ()=>S_OK,

        /** HRESULT GetRate(double *pdRate) */
        GetRate: (graph, [out])=>writeDouble(out, 1),
    };

    /**
     * IFilterMapper2, which is where a filter DLL's DllRegisterServer announces
     * itself. Nothing here builds graphs out of registered filters, so the
     * registration is accepted and forgotten -- which is what a filter that
     * registers successfully and is never chosen looks like from inside.
     *
     * @type {Record<string, (state: null, args: number[]) => number>}
     */
    const filterMapper = {
        /** HRESULT CreateCategory(REFCLSID, DWORD dwMerit, LPCWSTR Description) */
        CreateCategory: ()=>S_OK,

        /** HRESULT UnregisterFilter(const CLSID *, const OLECHAR *, REFCLSID) */
        UnregisterFilter: ()=>S_OK,

        /**
         * HRESULT RegisterFilter(REFCLSID, LPCWSTR, IMoniker **ppMoniker,
         *                        const CLSID *, const OLECHAR *, const REGFILTER2 *)
         *
         * The moniker is the one thing that cannot be faked: a caller passing a
         * pointer for it owns and releases whatever comes back. Callers that
         * only want to register pass NULL, which is the case that succeeds.
         */
        RegisterFilter: (state, [, , moniker])=>{
            if ((moniker >>> 0) === 0)
            {
                return S_OK;
            }
            return refuse(moniker, E_NOTIMPL);
        },
    };

    /** @returns {import('../ole32/objects.js').ComClassDefinition} */
    const filterGraph = ()=>{
        const state = newGraphState();
        return {
            state,
            /**
             * Releasing the last reference tears the graph down, and tearing a
             * graph down stops it: a program that skips a film by dropping the
             * graph rather than stopping it first must not leave the film
             * decoding. What was left running kept being ticked and kept being
             * presented, so its frames went on covering whatever the program
             * drew next -- and the file it was reading stayed open for the rest
             * of the run.
             */
            destroy: ()=>{
                playing.delete(state);
                state.clip?.close();
                state.clip = null;
            },
            interfaces: [
                describe(IID_IFILTER_GRAPH, IFILTER_GRAPH_SLOTS, graphBuilder),
                describe(IID_IGRAPH_BUILDER, IGRAPH_BUILDER_SLOTS, graphBuilder),
                describe(IID_IMEDIA_CONTROL, IMEDIA_CONTROL_SLOTS, mediaControl),
                describe(IID_IMEDIA_EVENT, IMEDIA_EVENT_SLOTS, mediaEvent),
                describe(IID_IMEDIA_EVENT_EX, IMEDIA_EVENT_EX_SLOTS, mediaEvent),
                describe(IID_IVIDEO_WINDOW, IVIDEO_WINDOW_SLOTS, videoWindow),
                describe(IID_IBASIC_VIDEO, IBASIC_VIDEO_SLOTS, basicVideo),
                describe(IID_IBASIC_AUDIO, IBASIC_AUDIO_SLOTS, basicAudio),
                describe(IID_IMEDIA_POSITION, IMEDIA_POSITION_SLOTS, mediaPosition),
                describe(IID_IMEDIA_SEEKING, IMEDIA_SEEKING_SLOTS, mediaSeeking),
            ],
        };
    };

    /** @returns {import('../ole32/objects.js').ComClassDefinition} */
    const filterMapper2 = ()=>({
        state: null,
        interfaces: [describe(IID_IFILTER_MAPPER2, IFILTER_MAPPER2_SLOTS, filterMapper)],
    });

    return { filterGraph, filterMapper2, tick };
}

/**
 * Puts quartz's classes where CoCreateInstance will find them.
 *
 * CLSID_FilterGraphNoThread is the same object built without quartz's own
 * worker thread. There is no thread either way here, so it answers with the
 * same class rather than being a CLSID a program is told does not exist.
 *
 * `tick` comes back because a filter graph has no thread of its own here and
 * nothing inside win32 may reach the layer that would show a frame. Whoever
 * assembles the process drives it and decides where the picture goes.
 *
 * @param {import('../ole32/objects.js').ComRegistry} registry
 * @param {QuartzHost} host
 * @returns {{ tick: (nowMs: number, soundOwedMs?: number | null) =>
 *             ReturnType<ReturnType<typeof createQuartz>['tick']> }}
 */
export function registerQuartzClasses(registry, host){
    const quartz = createQuartz(host);
    registry.registerClass(CLSID_FILTER_GRAPH, quartz.filterGraph);
    registry.registerClass(CLSID_FILTER_GRAPH_NO_THREAD, quartz.filterGraph);
    registry.registerClass(CLSID_FILTER_MAPPER2, quartz.filterMapper2);
    return { tick: quartz.tick };
}
