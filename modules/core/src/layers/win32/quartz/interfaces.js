/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * quartz.dll's identifiers and vtable layouts, transcribed from the published
 * `strmif.h` and `control.odl` declarations.
 *
 * Nothing here decides anything: an interface's method order is a fact about
 * the binaries a program was compiled against, and a slot in the wrong place
 * calls the wrong function with the wrong arguments -- a failure that shows up
 * as a crash somewhere else entirely. So every slot is listed, including the
 * ones nothing implements, and a slot that is not implemented answers E_NOTIMPL
 * rather than being left out.
 *
 * Two things about these lists are easy to get wrong and are called out where
 * they occur:
 *
 * - **Most of these interfaces derive from IDispatch, not from IUnknown.** They
 *   are the Automation half of DirectShow, so their own methods begin at slot
 *   seven: IUnknown's three, then IDispatch's four. IGraphBuilder is the
 *   exception -- it derives from IFilterGraph, which derives from IUnknown, so
 *   its own methods begin at slot three.
 * - **The counts below are dwords, not arguments.** REFTIME is a `double`, so a
 *   program calling `put_CurrentPosition` pushes two words for one argument,
 *   and a slot that counted it as one pops four bytes too few on return.
 */

/** The class a program asks CoCreateInstance for to get a filter graph. */
export const CLSID_FILTER_GRAPH = '{E436EBB3-524F-11CE-9F53-0020AF0BA770}';

/** The same object without quartz's own worker thread; the ABI is identical. */
export const CLSID_FILTER_GRAPH_NO_THREAD = '{E436EBB8-524F-11CE-9F53-0020AF0BA770}';

/** Where a filter DLL's DllRegisterServer goes to announce itself. */
export const CLSID_FILTER_MAPPER2 = '{CDA42200-BD88-11D0-BD4E-00A0C911CE86}';

export const IID_IFILTER_GRAPH = '{56A8689F-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IGRAPH_BUILDER = '{56A868A9-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEDIA_CONTROL = '{56A868B1-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEDIA_POSITION = '{56A868B2-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IBASIC_AUDIO = '{56A868B3-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IVIDEO_WINDOW = '{56A868B4-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IBASIC_VIDEO = '{56A868B5-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEDIA_EVENT = '{56A868B6-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEDIA_EVENT_EX = '{56A868C0-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEDIA_SEEKING = '{36B73880-C2C8-11CF-8B46-00805F6CEF60}';
export const IID_IFILTER_MAPPER2 = '{B79BB0B0-33C1-11D1-ABE1-00A0C905F375}';

/**
 * IDispatch, which every dual interface below carries between IUnknown's three
 * and its own. `Invoke` takes eight words: `wFlags` is a WORD in the header and
 * still occupies a whole stack slot.
 *
 * @type {[string, number][]}
 */
export const IDISPATCH_SLOTS = [
    ['GetTypeInfoCount', 1],
    ['GetTypeInfo', 3],
    ['GetIDsOfNames', 5],
    ['Invoke', 8],
];

/** IFilterGraph, which IGraphBuilder extends. IUnknown-derived. @type {[string, number][]} */
export const IFILTER_GRAPH_SLOTS = [
    ['AddFilter', 2],
    ['RemoveFilter', 1],
    ['EnumFilters', 1],
    ['FindFilterByName', 2],
    ['ConnectDirect', 3],
    ['Reconnect', 1],
    ['Disconnect', 1],
    ['SetDefaultSyncSource', 0],
];

/** @type {[string, number][]} */
export const IGRAPH_BUILDER_SLOTS = [
    ...IFILTER_GRAPH_SLOTS,
    ['Connect', 2],
    ['Render', 1],
    ['RenderFile', 2],
    ['AddSourceFilter', 3],
    ['SetLogFile', 1],
    ['Abort', 0],
    ['ShouldOperationContinue', 0],
];

/** @type {[string, number][]} */
export const IMEDIA_CONTROL_SLOTS = [
    ...IDISPATCH_SLOTS,
    ['Run', 0],
    ['Pause', 0],
    ['Stop', 0],
    ['GetState', 2],
    ['RenderFile', 1],
    ['AddSourceFilter', 2],
    ['get_FilterCollection', 1],
    ['get_RegFilterCollection', 1],
    ['StopWhenReady', 0],
];

/** @type {[string, number][]} */
export const IMEDIA_EVENT_SLOTS = [
    ...IDISPATCH_SLOTS,
    ['GetEventHandle', 1],
    ['GetEvent', 4],
    ['WaitForCompletion', 2],
    ['CancelDefaultHandling', 1],
    ['RestoreDefaultHandling', 1],
    ['FreeEventParams', 3],
];

/** @type {[string, number][]} */
export const IMEDIA_EVENT_EX_SLOTS = [
    ...IMEDIA_EVENT_SLOTS,
    ['SetNotifyWindow', 3],
    ['SetNotifyFlags', 1],
    ['GetNotifyFlags', 1],
];

/**
 * IVideoWindow.
 *
 * The put/get pairs are declared put-first throughout except for BorderColor
 * and FullScreenMode, which are declared get-first. That looks like a
 * transcription slip and is not: it is the order in `control.odl`, and the
 * order in `control.odl` is the vtable.
 *
 * @type {[string, number][]}
 */
export const IVIDEO_WINDOW_SLOTS = [
    ...IDISPATCH_SLOTS,
    ['put_Caption', 1],
    ['get_Caption', 1],
    ['put_WindowStyle', 1],
    ['get_WindowStyle', 1],
    ['put_WindowStyleEx', 1],
    ['get_WindowStyleEx', 1],
    ['put_AutoShow', 1],
    ['get_AutoShow', 1],
    ['put_WindowState', 1],
    ['get_WindowState', 1],
    ['put_BackgroundPalette', 1],
    ['get_BackgroundPalette', 1],
    ['put_Visible', 1],
    ['get_Visible', 1],
    ['put_Left', 1],
    ['get_Left', 1],
    ['put_Width', 1],
    ['get_Width', 1],
    ['put_Top', 1],
    ['get_Top', 1],
    ['put_Height', 1],
    ['get_Height', 1],
    ['put_Owner', 1],
    ['get_Owner', 1],
    ['put_MessageDrain', 1],
    ['get_MessageDrain', 1],
    ['get_BorderColor', 1],
    ['put_BorderColor', 1],
    ['get_FullScreenMode', 1],
    ['put_FullScreenMode', 1],
    ['SetWindowForeground', 1],
    ['NotifyOwnerMessage', 4],
    ['SetWindowPosition', 4],
    ['GetWindowPosition', 4],
    ['GetMinIdealImageSize', 2],
    ['GetMaxIdealImageSize', 2],
    ['GetRestorePosition', 4],
    ['HideCursor', 1],
    ['IsCursorHidden', 1],
];

/** @type {[string, number][]} */
export const IBASIC_VIDEO_SLOTS = [
    ...IDISPATCH_SLOTS,
    ['get_AvgTimePerFrame', 1],
    ['get_BitRate', 1],
    ['get_BitErrorRate', 1],
    ['get_VideoWidth', 1],
    ['get_VideoHeight', 1],
    ['put_SourceLeft', 1],
    ['get_SourceLeft', 1],
    ['put_SourceWidth', 1],
    ['get_SourceWidth', 1],
    ['put_SourceTop', 1],
    ['get_SourceTop', 1],
    ['put_SourceHeight', 1],
    ['get_SourceHeight', 1],
    ['put_DestinationLeft', 1],
    ['get_DestinationLeft', 1],
    ['put_DestinationWidth', 1],
    ['get_DestinationWidth', 1],
    ['put_DestinationTop', 1],
    ['get_DestinationTop', 1],
    ['put_DestinationHeight', 1],
    ['get_DestinationHeight', 1],
    ['SetSourcePosition', 4],
    ['GetSourcePosition', 4],
    ['SetDefaultSourcePosition', 0],
    ['SetDestinationPosition', 4],
    ['GetDestinationPosition', 4],
    ['SetDefaultDestinationPosition', 0],
    ['GetVideoSize', 2],
    ['GetVideoPaletteEntries', 4],
    ['GetCurrentImage', 2],
    ['IsUsingDefaultSource', 0],
    ['IsUsingDefaultDestination', 0],
];

/** @type {[string, number][]} */
export const IBASIC_AUDIO_SLOTS = [
    ...IDISPATCH_SLOTS,
    ['put_Volume', 1],
    ['get_Volume', 1],
    ['put_Balance', 1],
    ['get_Balance', 1],
];

/**
 * IMediaPosition. Every REFTIME and every `double` here is two words, which is
 * why the setters count two and the getters -- which take a pointer -- count one.
 *
 * @type {[string, number][]}
 */
export const IMEDIA_POSITION_SLOTS = [
    ...IDISPATCH_SLOTS,
    ['get_Duration', 1],
    ['put_CurrentPosition', 2],
    ['get_CurrentPosition', 1],
    ['get_StopTime', 1],
    ['put_StopTime', 2],
    ['get_PrerollTime', 1],
    ['put_PrerollTime', 2],
    ['put_Rate', 2],
    ['get_Rate', 1],
    ['CanSeekForward', 1],
    ['CanSeekBackward', 1],
];

/**
 * IMediaSeeking. The odd one out among the seeking interfaces: it derives
 * straight from IUnknown, so its methods begin at slot three and there is no
 * IDispatch block. LONGLONG positions travel by pointer, except the one
 * `ConvertTimeFormat` takes by value; `SetRate` takes a double by value.
 *
 * @type {[string, number][]}
 */
export const IMEDIA_SEEKING_SLOTS = [
    ['GetCapabilities', 1],
    ['CheckCapabilities', 1],
    ['IsFormatSupported', 1],
    ['QueryPreferredFormat', 1],
    ['GetTimeFormat', 1],
    ['IsUsingTimeFormat', 1],
    ['SetTimeFormat', 1],
    ['GetDuration', 1],
    ['GetStopPosition', 1],
    ['GetCurrentPosition', 1],
    ['ConvertTimeFormat', 5],
    ['SetPositions', 4],
    ['GetPositions', 2],
    ['GetAvailable', 2],
    ['SetRate', 2],
    ['GetRate', 1],
    ['GetPreroll', 1],
];

/** IFilterMapper2, which is IUnknown-derived. @type {[string, number][]} */
export const IFILTER_MAPPER2_SLOTS = [
    ['CreateCategory', 3],
    ['UnregisterFilter', 3],
    ['RegisterFilter', 6],
    ['EnumMatchingFilters', 15],
];

/*
 * The streaming half: the interfaces a filter a program wrote itself -- a
 * renderer that copies frames into a texture, built on the SDK's base classes
 * -- is joined to a graph and fed through. All IUnknown-derived.
 */

export const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
export const IID_IMEDIA_FILTER = '{56A86899-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IBASE_FILTER = '{56A86895-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IPIN = '{56A86891-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEM_INPUT_PIN = '{56A8689D-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEM_ALLOCATOR = '{56A8689C-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEDIA_SAMPLE = '{56A8689A-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IMEDIA_EVENT_SINK = '{56A868A2-0AD4-11CE-B03A-0020AF0BA770}';

/** The class this file's source filter reports from IPersist::GetClassID: File Source (Async.). */
export const CLSID_ASYNC_READER = '{E436EBB5-524F-11CE-9F53-0020AF0BA770}';

/** IMediaFilter, which IBaseFilter extends after IPersist's one. `Run` takes a REFERENCE_TIME. @type {[string, number][]} */
export const IMEDIA_FILTER_SLOTS = [
    ['GetClassID', 1],
    ['Stop', 0],
    ['Pause', 0],
    ['Run', 2],
    ['GetState', 2],
    ['SetSyncSource', 1],
    ['GetSyncSource', 1],
];

/** @type {[string, number][]} */
export const IBASE_FILTER_SLOTS = [
    ...IMEDIA_FILTER_SLOTS,
    ['EnumPins', 1],
    ['FindPin', 2],
    ['QueryFilterInfo', 1],
    ['JoinFilterGraph', 2],
    ['QueryVendorInfo', 1],
];

/** IPin. `NewSegment` takes two REFERENCE_TIMEs and a double: six words. @type {[string, number][]} */
export const IPIN_SLOTS = [
    ['Connect', 2],
    ['ReceiveConnection', 2],
    ['Disconnect', 0],
    ['ConnectedTo', 1],
    ['ConnectionMediaType', 1],
    ['QueryPinInfo', 1],
    ['QueryDirection', 1],
    ['QueryId', 1],
    ['QueryAccept', 1],
    ['EnumMediaTypes', 1],
    ['QueryInternalConnections', 2],
    ['EndOfStream', 0],
    ['BeginFlush', 0],
    ['EndFlush', 0],
    ['NewSegment', 6],
];

/** Slot numbers in a vtable, IUnknown's three counted, for calling a program's own objects. */
export const VTABLE = {
    AddRef: 1,
    Release: 2,
    QueryInterface: 0,
    /** IBaseFilter */
    FilterStop: 4,
    FilterPause: 5,
    FilterRun: 6,
    FilterSetSyncSource: 8,
    FilterJoinGraph: 13,
    /** IPin */
    PinReceiveConnection: 4,
    PinDisconnect: 5,
    PinEndOfStream: 14,
    PinBeginFlush: 15,
    PinEndFlush: 16,
    /** IMemInputPin */
    MemNotifyAllocator: 4,
    MemReceive: 6,
};

/** @type {[string, number][]} */
export const IMEM_ALLOCATOR_SLOTS = [
    ['SetProperties', 2],
    ['GetProperties', 1],
    ['Commit', 0],
    ['Decommit', 0],
    ['GetBuffer', 4],
    ['ReleaseBuffer', 1],
];

/**
 * IMediaSample. `GetSize` and `GetActualDataLength` answer the number itself
 * rather than an HRESULT, which is how the header declares them.
 *
 * @type {[string, number][]}
 */
export const IMEDIA_SAMPLE_SLOTS = [
    ['GetPointer', 1],
    ['GetSize', 0],
    ['GetTime', 2],
    ['SetTime', 2],
    ['IsSyncPoint', 0],
    ['SetSyncPoint', 1],
    ['IsPreroll', 0],
    ['SetPreroll', 1],
    ['GetActualDataLength', 0],
    ['SetActualDataLength', 1],
    ['GetMediaType', 1],
    ['SetMediaType', 1],
    ['IsDiscontinuity', 0],
    ['SetDiscontinuity', 1],
    ['GetMediaTime', 2],
    ['SetMediaTime', 2],
];

/** What a filter tells its graph through: `Notify(EventCode, Param1, Param2)`. @type {[string, number][]} */
export const IMEDIA_EVENT_SINK_SLOTS = [
    ['Notify', 3],
];
