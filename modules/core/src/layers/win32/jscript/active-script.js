/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CLSID_JScript, ProgID "JScript": the engine as a program hosts it, through
 * IActiveScript and IActiveScriptParse (activscp.h), with IObjectSafety
 * beside them as a browser-era host asks for it.
 *
 * The life of one, as the interfaces lay it down: InitNew and SetScriptSite
 * make it initialized; text parsed then is kept until SetScriptState starts
 * the script, and text parsed after runs at once. A name the host added
 * with AddNamedItem is looked up through the site's GetItemInfo the first
 * time a script uses it, and with SCRIPTITEM_GLOBALMEMBERS its members are
 * global names too. GetScriptDispatch hands the program the script's global
 * object. A script error goes to the site's OnScriptError as an
 * IActiveScriptError and the call answers SCRIPT_E_REPORTED; with no site,
 * the EXCEPINFO the caller passed is filled and the call answers
 * DISP_E_EXCEPTION. ActiveXObject creates its class through CLSIDFromProgID
 * and CoCreateInstance, as the engine's own process would.
 *
 * Not done, each refused soundly: AddScriptlet (E_NOTIMPL), Clone
 * (E_NOTIMPL), AddTypeLib's constants (accepted, nothing imported, said
 * through the divergence reporter), and a named item's own script context
 * (code parsed for an item runs in the global one, said the same way).
 */

import { GUID_SIZE, formatGuid, parseGuid } from '../ole32/guid.js';
import { createComObject } from '../ole32/objects.js';
import { ExternalError, deferredExternal } from '../script/external.js';
import { IID_IDISPATCH } from '../script/guest-dispatch.js';
import { createScriptCom, objectTarget } from './dispatch.js';
import { JScriptError, ScriptAbort, createJScriptEngine } from './engine.js';

/**
 * @typedef {import('../script/values.js').Value} Value
 * @typedef {import('../ole32/objects.js').ComInterfaceDescriptor} ComInterfaceDescriptor
 * @typedef {import('../ole32/objects.js').ComClassDefinition} ComClassDefinition
 */

export const CLSID_JSCRIPT = '{F414C260-6AC0-11CF-B6D1-00AA00BBBB58}';
export const PROGID_JSCRIPT = 'JScript';
export const IID_IACTIVESCRIPT = '{BB1A2AE1-A4F9-11CF-8F20-00805F2CD064}';
export const IID_IACTIVESCRIPTPARSE32 = '{BB1A2AE2-A4F9-11CF-8F20-00805F2CD064}';
export const IID_IACTIVESCRIPTSITE = '{DB01A1E3-A42B-11CF-8F20-00805F2CD064}';
export const IID_IACTIVESCRIPTERROR = '{EAE1BA61-A4ED-11CF-8F20-00805F2CD064}';
export const IID_IOBJECTSAFETY = '{CB5BDC81-93C1-11CF-8F20-00805F2CD064}';

/** SCRIPTSTATE. */
export const SCRIPTSTATE_UNINITIALIZED = 0;
export const SCRIPTSTATE_STARTED = 1;
export const SCRIPTSTATE_CONNECTED = 2;
export const SCRIPTSTATE_DISCONNECTED = 3;
export const SCRIPTSTATE_CLOSED = 4;
export const SCRIPTSTATE_INITIALIZED = 5;

/** AddNamedItem's flags. */
export const SCRIPTITEM_ISVISIBLE = 0x2;
export const SCRIPTITEM_GLOBALMEMBERS = 0x8;
/** ParseScriptText's flags. */
export const SCRIPTTEXT_ISEXPRESSION = 0x20;
/** GetItemInfo's mask. */
const SCRIPTINFO_IUNKNOWN = 1;
/** SCRIPTTHREADSTATE. */
const SCRIPTTHREADSTATE_NOTINSCRIPT = 0;
const SCRIPTTHREADSTATE_RUNNING = 1;

/** IActiveScriptSite's slots after IUnknown's. */
const SITE_GET_ITEM_INFO = 4;
const SITE_ON_STATE_CHANGE = 7;
const SITE_ON_SCRIPT_ERROR = 8;
const SITE_ON_ENTER_SCRIPT = 9;
const SITE_ON_LEAVE_SCRIPT = 10;
const ADD_REF = 1;
const RELEASE = 2;

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_POINTER = 0x80004003 | 0;
const E_ABORT = 0x80004004 | 0;
const E_FAIL = 0x80004005 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const DISP_E_EXCEPTION = 0x80020009 | 0;
/** The site was told of the error; the caller has nothing more to do. */
export const SCRIPT_E_REPORTED = 0x80020101 | 0;
const REGDB_E_CLASSNOTREG = 0x80040154 | 0;
const CLSCTX_INPROC_SERVER = 0x1;
const CLSCTX_LOCAL_SERVER = 0x4;
/** What IObjectSafety may be told: safe for untrusted callers and data. */
const INTERFACESAFE_SUPPORTED = 0x1 | 0x2;
/** How far a name a program passes is read. */
const MAX_NAME = 1024;
/** A script text is read in pieces of this many characters. */
const TEXT_PIECE = 4096;

/**
 * @typedef {Object} ActiveScriptHost
 * @property {import('../ole32/objects.js').ComRegistry} registry
 * @property {(object: import('../ole32/objects.js').ComObject, iid: string) => number} publish
 * @property {import('../script/variant.js').GuestCom} com
 * @property {(library: string, name: string, args: number[], thread?: unknown)
 *     => number | Promise<number> | null} [system]
 *     Another library's export, as its import is called: ole32.dll's
 *     CLSIDFromProgID and CoCreateInstance, for ActiveXObject.
 * @property {() => number} [threadId]  The calling thread's id, for
 *     GetCurrentScriptThreadID.
 * @property {import('./realm.js').EngineVersion} [version]
 * @property {() => number} [now]
 * @property {(utc: number) => number} [localOffset]
 * @property {() => void | Promise<void>} [checkpoint]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Puts CLSID_JScript where CoCreateInstance finds it.
 *
 * @param {ActiveScriptHost} host
 */
export function registerJScriptClass(host){
    host.registry.registerClass(CLSID_JSCRIPT, ()=>activeScript(host));
}

/**
 * One engine instance as a COM object.
 *
 * @param {ActiveScriptHost} host @returns {ComClassDefinition}
 */
export function activeScript(host){
    const engine = createJScriptEngine({
        version: host.version,
        now: host.now,
        localOffset: host.localOffset,
        checkpoint: host.checkpoint,
        divergence: host.divergence,
        createObject: progId=>createObject(progId),
    });
    const crossing = createScriptCom(engine, { com: host.com, publish: host.publish,
        clsid: CLSID_JSCRIPT });
    const { bridge, server } = crossing;
    const memory = bridge.codec.memory;

    let site = 0;
    let state = SCRIPTSTATE_UNINITIALIZED;
    let initialized = false;
    let running = 0;
    let safetyEnabled = 0;
    /** Text parsed before the script started, run when it does. */
    /** @type {import('./parser.js').FunctionNode[]} */
    const queued = [];
    /** @type {Map<string, { flags: number, value: Value | undefined }>} */
    const items = new Map();

    // Only a visible item is a name the script can use; an item that only
    // lends its members is reached through them.
    engine.setNameResolver(name=>{
        const item = items.get(name);
        return item !== undefined && (item.flags & SCRIPTITEM_ISVISIBLE) !== 0
            ? itemObject(name) : undefined;
    });

    /** @param {number} address @returns {string} a terminated wide string, read whole */
    const readText = address=>{
        let text = '';
        for (let at = address >>> 0; ; at += TEXT_PIECE * 2)
        {
            const piece = memory.readWideString(at, TEXT_PIECE);
            text += piece;
            if (piece.length < TEXT_PIECE)
            {
                return text;
            }
        }
    };

    /**
     * Scratch memory for one call, freed afterwards.
     *
     * @template T
     * @param {number} bytes @param {(block: number) => Promise<T>} use
     * @returns {Promise<T>}
     */
    const lend = async(bytes, use)=>{
        const block = host.com.allocate(bytes) >>> 0;
        if (block === 0)
        {
            throw new ExternalError(E_OUTOFMEMORY);
        }
        try
        {
            return await use(block);
        }
        finally
        {
            host.com.free(block);
        }
    };

    /** @param {number} slot @param {number[]} args @returns {Promise<number>} */
    const callSite = (slot, args)=>(site === 0
        ? Promise.resolve(E_UNEXPECTED) : bridge.callMethod(site, slot, args));

    /**
     * A named item's object, asked of the site the first time.
     *
     * @param {string} name @returns {Promise<Value>}
     */
    const itemObject = async name=>{
        const item = /** @type {{ flags: number, value: Value | undefined }} */ (
            items.get(name));
        if (item.value !== undefined)
        {
            return item.value;
        }
        const value = await lend(name.length * 2 + 6, async block=>{
            const out = block;
            const text = block + 4;
            memory.writeU32(out, 0);
            memory.writeWide(text, name, true);
            const hr = await callSite(SITE_GET_ITEM_INFO, [text, SCRIPTINFO_IUNKNOWN, out, 0]);
            if (hr < 0)
            {
                throw new ExternalError(hr);
            }
            const pointer = memory.u32(out);
            return pointer === 0 ? null : bridge.importInterface(pointer, 'unknown', true);
        });
        item.value = value;
        return value;
    };

    /**
     * ActiveXObject's class: CLSIDFromProgID, then CoCreateInstance for
     * IDispatch, the two the engine's own process would call.
     *
     * @param {string} progId @returns {Promise<Value>}
     */
    const createObject = progId=>lend(progId.length * 2 + 2 + GUID_SIZE * 2 + 4, async block=>{
        const system = host.system;
        if (!system)
        {
            throw new ExternalError(REGDB_E_CLASSNOTREG);
        }
        const clsid = block;
        const iid = clsid + GUID_SIZE;
        const out = iid + GUID_SIZE;
        const name = out + 4;
        memory.writeWide(name, progId, true);
        host.com.writeMemory(iid, /** @type {Uint8Array} */ (parseGuid(IID_IDISPATCH)));
        memory.writeU32(out, 0);
        const found = (await system('ole32.dll', 'CLSIDFromProgID', [name, clsid],
            bridge.thread)) ?? REGDB_E_CLASSNOTREG;
        if ((found | 0) < 0)
        {
            throw new ExternalError(found | 0);
        }
        const made = (await system('ole32.dll', 'CoCreateInstance',
            [clsid, 0, CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER, iid, out], bridge.thread))
            ?? REGDB_E_CLASSNOTREG;
        if ((made | 0) < 0)
        {
            throw new ExternalError(made | 0);
        }
        return bridge.importInterface(memory.u32(out), 'dispatch', true);
    });

    /** @param {number} next */
    const changeState = async next=>{
        state = next;
        if (site !== 0)
        {
            await callSite(SITE_ON_STATE_CHANGE, [next]);
        }
    };

    /** @type {ComInterfaceDescriptor} */
    const errorInterface = {
        id: IID_IACTIVESCRIPTERROR,
        methods: [
            /** HRESULT GetExceptionInfo(EXCEPINFO *pexcepinfo) */
            { name: 'GetExceptionInfo', argBytes: 8,
                invoke: async(object, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    await fillExcepinfo(out >>> 0, object.state);
                    return S_OK;
                } },
            /**
             * HRESULT GetSourcePosition(DWORD *pdwSourceContext,
             *     ULONG *pulLineNumber, LONG *plCharacterPosition)
             */
            { name: 'GetSourcePosition', argBytes: 16,
                invoke: (object, [context, line, column])=>{
                    /** @type {JScriptError} */
                    const failure = object.state;
                    for (const [out, value] of [[context, failure.context],
                        [line, failure.line], [column, failure.column]])
                    {
                        if ((out >>> 0) !== 0)
                        {
                            memory.writeU32(out >>> 0, value);
                        }
                    }
                    return S_OK;
                } },
            /** HRESULT GetSourceLineText(BSTR *pbstrSourceLine) */
            { name: 'GetSourceLineText', argBytes: 8,
                invoke: async(object, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    memory.writeU32(out >>> 0,
                        await bridge.codec.allocateBstr(object.state.lineText));
                    return S_OK;
                } },
        ],
    };

    /** @param {number} excepinfo @param {JScriptError} failure */
    const fillExcepinfo = async(excepinfo, failure)=>{
        memory.zero(excepinfo, 32);
        memory.writeU32(excepinfo + 4, await bridge.codec.allocateBstr(failure.source));
        memory.writeU32(excepinfo + 8, await bridge.codec.allocateBstr(failure.description));
        memory.writeU32(excepinfo + 28, failure.number);
    };

    /**
     * What a failed script answers: the site told through OnScriptError, or
     * the caller's EXCEPINFO filled.
     *
     * @param {unknown} failure @param {number} excepinfo @returns {Promise<number>}
     */
    const report = async(failure, excepinfo)=>{
        if (failure instanceof ScriptAbort)
        {
            return E_ABORT;
        }
        if (!(failure instanceof JScriptError))
        {
            throw failure;
        }
        if (site !== 0)
        {
            const error = createComObject(CLSID_JSCRIPT, { interfaces: [errorInterface],
                state: failure });
            const pointer = host.publish(error, IID_IACTIVESCRIPTERROR) >>> 0;
            if (pointer !== 0)
            {
                await callSite(SITE_ON_SCRIPT_ERROR, [pointer]);
            }
            error.release();
            return SCRIPT_E_REPORTED;
        }
        if ((excepinfo >>> 0) !== 0)
        {
            await fillExcepinfo(excepinfo >>> 0, failure);
        }
        return DISP_E_EXCEPTION;
    };

    /**
     * Runs parsed text, the site told the script is entered and left.
     *
     * @param {import('./parser.js').FunctionNode} program @returns {Promise<Value>}
     */
    const execute = async program=>{
        running++;
        await callSite(SITE_ON_ENTER_SCRIPT, []);
        try
        {
            return await engine.execute(program);
        }
        finally
        {
            await callSite(SITE_ON_LEAVE_SCRIPT, []);
            running--;
        }
    };

    /** @returns {boolean} whether parsed text runs at once */
    const started = ()=>state === SCRIPTSTATE_STARTED || state === SCRIPTSTATE_CONNECTED
        || state === SCRIPTSTATE_DISCONNECTED;

    const runQueued = async()=>{
        while (queued.length > 0)
        {
            const program = /** @type {import('./parser.js').FunctionNode} */ (queued.shift());
            try
            {
                await execute(program);
            }
            catch (e){
                await report(e, 0);
            }
        }
    };

    let closed = false;
    const close = async()=>{
        if (closed)
        {
            return;
        }
        closed = true;
        queued.length = 0;
        items.clear();
        await bridge.releaseAll();
        if (site !== 0)
        {
            const old = site;
            await changeState(SCRIPTSTATE_CLOSED);
            site = 0;
            await bridge.callMethod(old, RELEASE, []);
        }
        state = SCRIPTSTATE_CLOSED;
    };

    /**
     * @param {number} pointer @returns {string | null} the GUID a REFIID points at
     */
    const guidAt = pointer=>((pointer >>> 0) === 0
        ? null : formatGuid(host.com.readMemory(pointer >>> 0, GUID_SIZE).slice()));

    /** @type {ComInterfaceDescriptor} */
    const activeScriptInterface = {
        id: IID_IACTIVESCRIPT,
        methods: [
            /** HRESULT SetScriptSite(IActiveScriptSite *pass) */
            { name: 'SetScriptSite', argBytes: 8,
                invoke: async(_object, [pass])=>{
                    bridge.enter();
                    if ((pass >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    if (site !== 0 || closed)
                    {
                        return E_UNEXPECTED;
                    }
                    site = pass >>> 0;
                    await bridge.callMethod(site, ADD_REF, []);
                    if (initialized && state === SCRIPTSTATE_UNINITIALIZED)
                    {
                        await changeState(SCRIPTSTATE_INITIALIZED);
                    }
                    return S_OK;
                } },
            /** HRESULT GetScriptSite(REFIID riid, void **ppvObject) */
            { name: 'GetScriptSite', argBytes: 12,
                invoke: async(_object, [riid, out])=>{
                    bridge.enter();
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    memory.writeU32(out >>> 0, 0);
                    const iid = guidAt(riid);
                    if (site === 0)
                    {
                        return S_FALSE;
                    }
                    if (iid === null)
                    {
                        return E_INVALIDARG;
                    }
                    const pointer = await bridge.queryInterface(site, iid);
                    memory.writeU32(out >>> 0, pointer);
                    return pointer === 0 ? E_NOINTERFACE : S_OK;
                } },
            /** HRESULT SetScriptState(SCRIPTSTATE ss) */
            { name: 'SetScriptState', argBytes: 8,
                invoke: async(_object, [next])=>{
                    bridge.enter();
                    if (closed)
                    {
                        return E_UNEXPECTED;
                    }
                    switch (next)
                    {
                        case SCRIPTSTATE_STARTED:
                        case SCRIPTSTATE_CONNECTED:
                            if (!initialized || site === 0)
                            {
                                return E_UNEXPECTED;
                            }
                            await changeState(next);
                            await runQueued();
                            return S_OK;
                        case SCRIPTSTATE_DISCONNECTED:
                        case SCRIPTSTATE_INITIALIZED:
                            if (!initialized)
                            {
                                return E_UNEXPECTED;
                            }
                            await changeState(next);
                            return S_OK;
                        case SCRIPTSTATE_UNINITIALIZED:
                            await changeState(next);
                            return S_OK;
                        case SCRIPTSTATE_CLOSED:
                            await close();
                            return S_OK;
                        default:
                            return E_INVALIDARG;
                    }
                } },
            /** HRESULT GetScriptState(SCRIPTSTATE *pssState) */
            { name: 'GetScriptState', argBytes: 8,
                invoke: (_object, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    memory.writeU32(out >>> 0, state);
                    return S_OK;
                } },
            /** HRESULT Close(void) */
            { name: 'Close', argBytes: 4,
                invoke: async()=>{
                    bridge.enter();
                    await close();
                    return S_OK;
                } },
            /** HRESULT AddNamedItem(LPCOLESTR pstrName, DWORD dwFlags) */
            { name: 'AddNamedItem', argBytes: 12,
                invoke: (_object, [pstrName, flags])=>{
                    if ((pstrName >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    if (closed)
                    {
                        return E_UNEXPECTED;
                    }
                    const name = memory.readWideString(pstrName >>> 0, MAX_NAME);
                    items.set(name, { flags: flags >>> 0, value: undefined });
                    if ((flags & SCRIPTITEM_GLOBALMEMBERS) !== 0)
                    {
                        engine.addGlobalMembers(deferredExternal(()=>itemObject(name)));
                    }
                    return S_OK;
                } },
            /** HRESULT AddTypeLib(REFGUID, DWORD dwMajor, DWORD dwMinor, DWORD dwFlags) */
            { name: 'AddTypeLib', argBytes: 20,
                invoke: (_object, [rguid])=>{
                    host.divergence?.('IActiveScript::AddTypeLib',
                        `${guidAt(rguid) ?? 'NULL'}: its constants are not imported`);
                    return S_OK;
                } },
            /** HRESULT GetScriptDispatch(LPCOLESTR pstrItemName, IDispatch **ppdisp) */
            { name: 'GetScriptDispatch', argBytes: 12,
                invoke: (_object, [pstrItemName, out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    if (!initialized || closed)
                    {
                        memory.writeU32(out >>> 0, 0);
                        return E_UNEXPECTED;
                    }
                    if ((pstrItemName >>> 0) !== 0)
                    {
                        host.divergence?.('IActiveScript::GetScriptDispatch',
                            `item "${memory.readWideString(pstrItemName >>> 0, MAX_NAME)}":`
                            + ' answered with the global object');
                    }
                    const global = engine.global;
                    const pointer = server.export(global, ()=>objectTarget(engine, global));
                    memory.writeU32(out >>> 0, pointer);
                    return pointer === 0 ? E_OUTOFMEMORY : S_OK;
                } },
            /** HRESULT GetCurrentScriptThreadID(SCRIPTTHREADID *pstidThread) */
            { name: 'GetCurrentScriptThreadID', argBytes: 8,
                invoke: (_object, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    memory.writeU32(out >>> 0, host.threadId?.() ?? 0);
                    return S_OK;
                } },
            /** HRESULT GetScriptThreadID(DWORD dwWin32ThreadId, SCRIPTTHREADID *pstidThread) */
            { name: 'GetScriptThreadID', argBytes: 12,
                invoke: (_object, [threadId, out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    memory.writeU32(out >>> 0, threadId >>> 0);
                    return S_OK;
                } },
            /** HRESULT GetScriptThreadState(SCRIPTTHREADID, SCRIPTTHREADSTATE *) */
            { name: 'GetScriptThreadState', argBytes: 12,
                invoke: (_object, [, out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    memory.writeU32(out >>> 0, running > 0
                        ? SCRIPTTHREADSTATE_RUNNING : SCRIPTTHREADSTATE_NOTINSCRIPT);
                    return S_OK;
                } },
            /** HRESULT InterruptScriptThread(SCRIPTTHREADID, const EXCEPINFO *, DWORD) */
            { name: 'InterruptScriptThread', argBytes: 16,
                invoke: ()=>{
                    if (running > 0)
                    {
                        engine.interrupt('InterruptScriptThread');
                    }
                    return S_OK;
                } },
            /** HRESULT Clone(IActiveScript **ppscript) */
            { name: 'Clone', argBytes: 8,
                invoke: (_object, [out])=>{
                    if ((out >>> 0) !== 0)
                    {
                        memory.writeU32(out >>> 0, 0);
                    }
                    return E_NOTIMPL;
                } },
        ],
    };

    /** @type {ComInterfaceDescriptor} */
    const parseInterface = {
        id: IID_IACTIVESCRIPTPARSE32,
        methods: [
            /** HRESULT InitNew(void) */
            { name: 'InitNew', argBytes: 4,
                invoke: async()=>{
                    bridge.enter();
                    if (initialized || closed)
                    {
                        return E_UNEXPECTED;
                    }
                    initialized = true;
                    if (site !== 0)
                    {
                        await changeState(SCRIPTSTATE_INITIALIZED);
                    }
                    return S_OK;
                } },
            /**
             * HRESULT AddScriptlet(LPCOLESTR, LPCOLESTR, LPCOLESTR, LPCOLESTR,
             *     LPCOLESTR, LPCOLESTR, DWORD, ULONG, DWORD, BSTR *, EXCEPINFO *)
             */
            { name: 'AddScriptlet', argBytes: 48,
                invoke: (_object, args)=>{
                    const out = args[9] >>> 0;
                    if (out !== 0)
                    {
                        memory.writeU32(out, 0);
                    }
                    host.divergence?.('IActiveScriptParse::AddScriptlet', 'not implemented');
                    return E_NOTIMPL;
                } },
            /**
             * HRESULT ParseScriptText(LPCOLESTR pstrCode, LPCOLESTR pstrItemName,
             *     IUnknown *punkContext, LPCOLESTR pstrDelimiter,
             *     DWORD dwSourceContextCookie, ULONG ulStartingLineNumber,
             *     DWORD dwFlags, VARIANT *pvarResult, EXCEPINFO *pexcepinfo)
             */
            { name: 'ParseScriptText', argBytes: 40,
                invoke: async(_object, [code, item, , , cookie, line, flags, result, excepinfo])=>{
                    bridge.enter();
                    if (!initialized || closed)
                    {
                        return E_UNEXPECTED;
                    }
                    if ((item >>> 0) !== 0)
                    {
                        host.divergence?.('IActiveScriptParse::ParseScriptText',
                            `code for item "${memory.readWideString(item >>> 0, MAX_NAME)}"`
                            + ' runs in the global context');
                    }
                    const expression = (flags & SCRIPTTEXT_ISEXPRESSION) !== 0;
                    const text = (code >>> 0) === 0 ? '' : readText(code >>> 0);
                    let program;
                    try
                    {
                        program = engine.parse(text, { expression, line: line >>> 0,
                            context: cookie >>> 0 });
                    }
                    catch (e){
                        return report(e, excepinfo);
                    }
                    if (!expression && !started())
                    {
                        queued.push(program);
                        return S_OK;
                    }
                    try
                    {
                        const value = await execute(program);
                        if (expression && (result >>> 0) !== 0)
                        {
                            await bridge.codec.write(result >>> 0, value);
                        }
                        return S_OK;
                    }
                    catch (e){
                        return report(e, excepinfo);
                    }
                } },
        ],
    };

    /** @type {ComInterfaceDescriptor} */
    const safetyInterface = {
        id: IID_IOBJECTSAFETY,
        methods: [
            /** HRESULT GetInterfaceSafetyOptions(REFIID, DWORD *pdwSupported, DWORD *pdwEnabled) */
            { name: 'GetInterfaceSafetyOptions', argBytes: 16,
                invoke: (_object, [, supported, enabled])=>{
                    if ((supported >>> 0) === 0 || (enabled >>> 0) === 0)
                    {
                        return E_POINTER;
                    }
                    memory.writeU32(supported >>> 0, INTERFACESAFE_SUPPORTED);
                    memory.writeU32(enabled >>> 0, safetyEnabled);
                    return S_OK;
                } },
            /** HRESULT SetInterfaceSafetyOptions(REFIID, DWORD dwOptionSetMask, DWORD dwEnabledOptions) */
            { name: 'SetInterfaceSafetyOptions', argBytes: 16,
                invoke: (_object, [, mask, enabled])=>{
                    if ((mask & ~INTERFACESAFE_SUPPORTED) !== 0)
                    {
                        return E_FAIL;
                    }
                    safetyEnabled = (safetyEnabled & ~mask) | (enabled & mask);
                    return S_OK;
                } },
        ],
    };

    return {
        interfaces: [activeScriptInterface, parseInterface, safetyInterface],
        state: { engine },
        destroy: ()=>{
            // A program that released the engine without closing it: its
            // references go now, on whichever thread last called in.
            close().catch(e=>host.divergence?.('IActiveScript::Release',
                `closing on release failed: ${e instanceof Error ? e.message : String(e)}`));
        },
    };
}
