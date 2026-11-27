/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The WebBrowser control's interfaces as exdisp.h, oleidl.h, ocidl.h and
 * docobj.h publish them: each IID and its methods after IUnknown's, in
 * vtable order, with the bytes a stdcall call to each pops (`this`
 * included; a VARIANT by value sixteen). Data, not behaviour: `browser.js`
 * gives the methods their meaning.
 */

/**
 * @typedef {{ iid: string, methods: [string, number][], aliases?: string[] }} BrowserInterface
 */

/** IDispatch's four, which IWebBrowser2 begins with. */
const DISPATCH = /** @type {[string, number][]} */ ([['GetTypeInfoCount', 8],
    ['GetTypeInfo', 16], ['GetIDsOfNames', 24], ['Invoke', 36]]);

/** IOleWindow's two, which the in-place interfaces begin with. */
const OLE_WINDOW = /** @type {[string, number][]} */ ([['GetWindow', 8],
    ['ContextSensitiveHelp', 8]]);

/** @type {Record<string, BrowserInterface>} */
export const INTERFACES = {
    IWebBrowser2: {
        iid: '{D30C1661-CDAF-11D0-8A3E-00C04FC9E26E}',
        // IWebBrowser and IWebBrowserApp are its first parts, and IDispatch
        // its first four methods: one table answers for all four.
        aliases: ['{EAB22AC1-30C1-11CF-A7EB-0000C05BAE0B}',
            '{0002DF05-0000-0000-C000-000000000046}', '{00020400-0000-0000-C000-000000000046}'],
        methods: [...DISPATCH,
            ['GoBack', 4], ['GoForward', 4], ['GoHome', 4], ['GoSearch', 4], ['Navigate', 24],
            ['Refresh', 4], ['Refresh2', 8], ['Stop', 4], ['get_Application', 8],
            ['get_Parent', 8], ['get_Container', 8], ['get_Document', 8],
            ['get_TopLevelContainer', 8], ['get_Type', 8], ['get_Left', 8], ['put_Left', 8],
            ['get_Top', 8], ['put_Top', 8], ['get_Width', 8], ['put_Width', 8],
            ['get_Height', 8], ['put_Height', 8], ['get_LocationName', 8],
            ['get_LocationURL', 8], ['get_Busy', 8], ['Quit', 4], ['ClientToWindow', 12],
            ['PutProperty', 24], ['GetProperty', 12], ['get_Name', 8], ['get_HWND', 8],
            ['get_FullName', 8], ['get_Path', 8], ['get_Visible', 8], ['put_Visible', 8],
            ['get_StatusBar', 8], ['put_StatusBar', 8], ['get_StatusText', 8],
            ['put_StatusText', 8], ['get_ToolBar', 8], ['put_ToolBar', 8], ['get_MenuBar', 8],
            ['put_MenuBar', 8], ['get_FullScreen', 8], ['put_FullScreen', 8],
            ['Navigate2', 24], ['QueryStatusWB', 12], ['ExecWB', 20], ['ShowBrowserBar', 16],
            ['get_ReadyState', 8], ['get_Offline', 8], ['put_Offline', 8], ['get_Silent', 8],
            ['put_Silent', 8], ['get_RegisterAsBrowser', 8], ['put_RegisterAsBrowser', 8],
            ['get_RegisterAsDropTarget', 8], ['put_RegisterAsDropTarget', 8],
            ['get_TheaterMode', 8], ['put_TheaterMode', 8], ['get_AddressBar', 8],
            ['put_AddressBar', 8], ['get_Resizable', 8], ['put_Resizable', 8]],
    },
    IOleObject: {
        iid: '{00000112-0000-0000-C000-000000000046}',
        methods: [['SetClientSite', 8], ['GetClientSite', 8], ['SetHostNames', 12], ['Close', 8],
            ['SetMoniker', 12], ['GetMoniker', 16], ['InitFromData', 16],
            ['GetClipboardData', 12], ['DoVerb', 28], ['EnumVerbs', 8], ['Update', 4],
            ['IsUpToDate', 4], ['GetUserClassID', 8], ['GetUserType', 12], ['SetExtent', 12],
            ['GetExtent', 12], ['Advise', 12], ['Unadvise', 8], ['EnumAdvise', 8],
            ['GetMiscStatus', 12], ['SetColorScheme', 8]],
    },
    IOleInPlaceObject: {
        iid: '{00000113-0000-0000-C000-000000000046}',
        aliases: ['{00000114-0000-0000-C000-000000000046}'],
        methods: [...OLE_WINDOW, ['InPlaceDeactivate', 4], ['UIDeactivate', 4],
            ['SetObjectRects', 12], ['ReactivateAndUndo', 4]],
    },
    IOleInPlaceActiveObject: {
        iid: '{00000117-0000-0000-C000-000000000046}',
        methods: [...OLE_WINDOW, ['TranslateAccelerator', 8], ['OnFrameWindowActivate', 8],
            ['OnDocWindowActivate', 8], ['ResizeBorder', 16], ['EnableModeless', 8]],
    },
    IOleControl: {
        iid: '{B196B288-BAB4-101A-B69C-00AA00341D07}',
        methods: [['GetControlInfo', 8], ['OnMnemonic', 8], ['OnAmbientPropertyChange', 8],
            ['FreezeEvents', 8]],
    },
    IViewObject2: {
        iid: '{00000127-0000-0000-C000-000000000046}',
        aliases: ['{0000010D-0000-0000-C000-000000000046}'],
        methods: [['Draw', 44], ['GetColorSet', 28], ['Freeze', 20], ['Unfreeze', 8],
            ['SetAdvise', 16], ['GetAdvise', 16], ['GetExtent', 20]],
    },
    IPersistStreamInit: {
        iid: '{7FD52380-4E07-101B-AE2D-08002B2EC713}',
        aliases: ['{0000010C-0000-0000-C000-000000000046}'],
        methods: [['GetClassID', 8], ['IsDirty', 4], ['Load', 8], ['Save', 12],
            ['GetSizeMax', 8], ['InitNew', 4]],
    },
    IPersistStorage: {
        iid: '{0000010A-0000-0000-C000-000000000046}',
        methods: [['GetClassID', 8], ['IsDirty', 4], ['InitNew', 8], ['Load', 8], ['Save', 12],
            ['SaveCompleted', 8], ['HandsOffStorage', 4]],
    },
    IProvideClassInfo2: {
        iid: '{A6BC3AC0-DBAA-11CE-9DE3-00AA004BB851}',
        aliases: ['{B196B283-BAB4-101A-B69C-00AA00341D07}'],
        methods: [['GetClassInfo', 8], ['GetGUID', 12]],
    },
    IConnectionPointContainer: {
        iid: '{B196B284-BAB4-101A-B69C-00AA00341D07}',
        methods: [['EnumConnectionPoints', 8], ['FindConnectionPoint', 12]],
    },
    IServiceProvider: {
        iid: '{6D5140C1-7436-11CE-8034-00AA006009FA}',
        methods: [['QueryService', 16]],
    },
    IOleCommandTarget: {
        iid: '{B722BCCB-4E68-101B-A2BC-00AA00404770}',
        methods: [['QueryStatus', 20], ['Exec', 24]],
    },
};

/** IConnectionPoint, each of the control's event sources. */
export const CONNECTION_POINT = /** @type {BrowserInterface} */ ({
    iid: '{B196B286-BAB4-101A-B69C-00AA00341D07}',
    methods: [['GetConnectionInterface', 8], ['GetConnectionPointContainer', 8],
        ['Advise', 12], ['Unadvise', 8], ['EnumConnections', 8]],
});

/** The classes: the control, and the version 1 control IE 3 made. */
export const CLSID_WEB_BROWSER = '{8856F961-340A-11D0-A96B-00C04FD705A2}';
export const CLSID_WEB_BROWSER_V1 = '{EAB22AC3-30C1-11CF-A7EB-0000C05BAE0B}';

/** The event interfaces a sink is advised on. */
export const DIID_DWEB_BROWSER_EVENTS2 = '{34A715A0-6587-11D0-924A-0020AFC7AC4D}';
export const DIID_DWEB_BROWSER_EVENTS = '{EAB22AC2-30C1-11CF-A7EB-0000C05BAE0B}';
export const IID_IPROPERTY_NOTIFY_SINK = '{9BFBBC02-EFF1-101A-84ED-00AA00341D07}';

/** The client site's interfaces the control asks for. */
export const IID_IOLE_IN_PLACE_SITE = '{00000119-0000-0000-C000-000000000046}';
export const IID_IDISPATCH = '{00020400-0000-0000-C000-000000000046}';

export const IID_IOLE_WINDOW = '{00000114-0000-0000-C000-000000000046}';
export const IID_IOLE_CONTROL_SITE = '{B196B289-BAB4-101A-B69C-00AA00341D07}';
export const IID_IOLE_COMMAND_TARGET = '{B722BCCB-4E68-101B-A2BC-00AA00404770}';

/** The in-place site's methods by vtable slot (IOleWindow's first). */
export const IN_PLACE_SITE = Object.freeze({ GetWindow: 3, CanInPlaceActivate: 5,
    OnInPlaceActivate: 6, OnUIActivate: 7, GetWindowContext: 8, OnUIDeactivate: 10,
    OnInPlaceDeactivate: 11 });

/** The client site's, the frame's (and the document window's) and the control site's. */
export const CLIENT_SITE = Object.freeze({ GetContainer: 5, ShowObject: 6 });
export const IN_PLACE_FRAME = Object.freeze({ GetWindow: 3, SetActiveObject: 8, SetMenu: 10,
    SetStatusText: 12, EnableModeless: 13 });
export const CONTROL_SITE = Object.freeze({ OnFocus: 8 });

/** The ambient properties the control reads of its site when it is given one. */
export const DISPID_AMBIENT = Object.freeze({ USERMODE: -709, OFFLINEIFNOTCONNECTED: -5501,
    SILENT: -5502 });

/** DWebBrowserEvents2's DISPIDs (exdispid.h). */
export const DISPID = Object.freeze({
    STATUSTEXTCHANGE: 102,
    DOWNLOADCOMPLETE: 104,
    COMMANDSTATECHANGE: 105,
    DOWNLOADBEGIN: 106,
    PROGRESSCHANGE: 108,
    TITLECHANGE: 113,
    BEFORENAVIGATE2: 250,
    NAVIGATECOMPLETE2: 252,
    DOCUMENTCOMPLETE: 259,
    // DWebBrowserEvents, version 1's.
    BEFORENAVIGATE: 100,
    NAVIGATECOMPLETE: 101,
    // IPropertyNotifySink's subject: the ready state.
    READYSTATE: -525,
});
