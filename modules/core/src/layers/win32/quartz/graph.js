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
 * everything else reads its answer: adding a decoder means changing
 * `openMedia`, not the interfaces or the state machine around them.
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

/** IVideoWindow's long properties, each with a put_ and a get_ slot. */
const WINDOW_PROPERTIES = [
    'WindowStyle', 'WindowStyleEx', 'AutoShow', 'WindowState', 'BackgroundPalette',
    'Visible', 'Left', 'Width', 'Top', 'Height', 'Owner', 'MessageDrain',
    'BorderColor', 'FullScreenMode',
];

/** IBasicAudio's, the same shape. */
const AUDIO_PROPERTIES = ['Volume', 'Balance'];

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
 */

/**
 * The one decision about whether media can be played.
 *
 * Nothing here decodes anything yet, so every file is a file this machine has
 * no filter for -- which is a state Windows itself is regularly in and reports
 * exactly this way. A decoder arriving replaces this function's answer; every
 * method below reads it rather than repeating it.
 *
 * @returns {{ loaded: boolean, failure: number }}
 */
function openMedia(){
    return { loaded: false, failure: VFW_E_CANNOT_RENDER };
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
 * @param {Record<string, (state: S, args: number[]) => number>} [implemented]
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
        }
        return S_OK;
    };

    /** @param {FilterGraphState} graph @param {number} result */
    const recordFailure = (graph, result)=>{
        graph.loaded = false;
        graph.failure = result;
        return result;
    };

    /** @param {FilterGraphState} graph */
    const render = graph=>{
        const { loaded, failure } = openMedia();
        graph.loaded = loaded;
        return loaded ? S_OK : recordFailure(graph, failure);
    };

    /**
     * put_X and get_X over a record of longs, which is the whole of IBasicAudio
     * and most of IVideoWindow.
     *
     * @param {string[]} names
     * @param {(graph: FilterGraphState) => Record<string, number>} bag
     * @param {(name: string, value: number) => number} [validate]
     * @returns {Record<string, (graph: FilterGraphState, args: number[]) => number>}
     */
    const properties = (names, bag, validate)=>{
        /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
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

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
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
        RenderFile: graph=>render(graph),

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

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
    const mediaControl = {
        /** HRESULT Run(void) */
        Run: graph=>run(graph),

        /** HRESULT Pause(void) */
        Pause: graph=>{
            graph.state = STATE_PAUSED;
            return S_OK;
        },

        /** HRESULT Stop(void) */
        Stop: graph=>{
            graph.state = STATE_STOPPED;
            return S_OK;
        },

        /** HRESULT StopWhenReady(void) */
        StopWhenReady: graph=>{
            graph.state = STATE_STOPPED;
            return S_OK;
        },

        /** HRESULT GetState(LONG msTimeout, OAFilterState *pfs) */
        GetState: (graph, [, out])=>writeLong(out, graph.state),

        /** HRESULT RenderFile(BSTR strFilename) */
        RenderFile: graph=>render(graph),

        /** HRESULT AddSourceFilter(BSTR strFilename, IDispatch **ppUnk) */
        AddSourceFilter: (graph, [, out])=>
            refuse(out, recordFailure(graph, VFW_E_CANNOT_LOAD_SOURCE_FILTER)),

        /** HRESULT get_FilterCollection(IDispatch **ppUnk) */
        get_FilterCollection: (graph, [out])=>refuse(out, E_NOTIMPL),

        /** HRESULT get_RegFilterCollection(IDispatch **ppUnk) */
        get_RegFilterCollection: (graph, [out])=>refuse(out, E_NOTIMPL),
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
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

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
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

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
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

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
    const basicAudio = properties(AUDIO_PROPERTIES, graph=>graph.audio,
        // Both are defined over the same range, and a value outside it is the
        // one documented failure either setter has.
        (name, value)=>(value >= VOLUME_MIN && value <= VOLUME_MAX ? S_OK : E_INVALIDARG));

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
    const mediaPosition = {
        /** HRESULT get_Duration(REFTIME *plength) */
        get_Duration: (graph, [out])=>writeDouble(out, 0),

        /** HRESULT get_CurrentPosition(REFTIME *pllTime) */
        get_CurrentPosition: (graph, [out])=>writeDouble(out, 0),

        /** HRESULT get_StopTime(REFTIME *pllTime) */
        get_StopTime: (graph, [out])=>writeDouble(out, 0),

        /** HRESULT get_PrerollTime(REFTIME *pllTime) */
        get_PrerollTime: (graph, [out])=>writeDouble(out, 0),

        /** HRESULT put_CurrentPosition(REFTIME llTime) */
        put_CurrentPosition: ()=>S_OK,

        /** HRESULT put_StopTime(REFTIME llTime) */
        put_StopTime: ()=>S_OK,

        /** HRESULT put_PrerollTime(REFTIME llTime) */
        put_PrerollTime: ()=>S_OK,

        /** HRESULT put_Rate(double dRate) */
        put_Rate: ()=>S_OK,

        /** HRESULT get_Rate(double *pdRate) */
        get_Rate: (graph, [out])=>writeDouble(out, 1),

        /** HRESULT CanSeekForward(LONG *pCanSeekForward) — OAFALSE is zero. */
        CanSeekForward: (graph, [out])=>writeLong(out, 0),

        /** HRESULT CanSeekBackward(LONG *pCanSeekBackward) */
        CanSeekBackward: (graph, [out])=>writeLong(out, 0),
    };

    /** @type {Record<string, (graph: FilterGraphState, args: number[]) => number>} */
    const mediaSeeking = {
        /**
         * HRESULT GetCapabilities(DWORD *pCapabilities)
         *
         * None. A program that reads this before seeking learns not to, which
         * is why the time-format methods below it can stay unimplemented.
         */
        GetCapabilities: (graph, [out])=>writeLong(out, 0),

        /** HRESULT GetDuration(LONGLONG *pDuration) */
        GetDuration: (graph, [out])=>writeLongLong(out, 0),

        /** HRESULT GetStopPosition(LONGLONG *pStop) */
        GetStopPosition: (graph, [out])=>writeLongLong(out, 0),

        /** HRESULT GetCurrentPosition(LONGLONG *pCurrent) */
        GetCurrentPosition: (graph, [out])=>writeLongLong(out, 0),

        /** HRESULT GetPreroll(LONGLONG *pllPreroll) */
        GetPreroll: (graph, [out])=>writeLongLong(out, 0),

        /** HRESULT GetPositions(LONGLONG *pCurrent, LONGLONG *pStop) */
        GetPositions: (graph, [current, stop])=>
            writeEach(writeLongLong, [[current, 0], [stop, 0]]),

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
    const filterGraph = ()=>({
        state: newGraphState(),
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
    });

    /** @returns {import('../ole32/objects.js').ComClassDefinition} */
    const filterMapper2 = ()=>({
        state: null,
        interfaces: [describe(IID_IFILTER_MAPPER2, IFILTER_MAPPER2_SLOTS, filterMapper)],
    });

    return { filterGraph, filterMapper2 };
}

/**
 * Puts quartz's classes where CoCreateInstance will find them.
 *
 * CLSID_FilterGraphNoThread is the same object built without quartz's own
 * worker thread. There is no thread either way here, so it answers with the
 * same class rather than being a CLSID a program is told does not exist.
 *
 * @param {import('../ole32/objects.js').ComRegistry} registry
 * @param {QuartzHost} host
 */
export function registerQuartzClasses(registry, host){
    const quartz = createQuartz(host);
    registry.registerClass(CLSID_FILTER_GRAPH, quartz.filterGraph);
    registry.registerClass(CLSID_FILTER_GRAPH_NO_THREAD, quartz.filterGraph);
    registry.registerClass(CLSID_FILTER_MAPPER2, quartz.filterMapper2);
}
