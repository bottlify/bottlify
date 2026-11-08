/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtime's own hosting interfaces, ICorRuntimeHost (the .NET 1-2 one a
 * setup engine's managed UI and older hosts use) and ICLRRuntimeHost (the 2.0
 * and 4 one), over the bottle's Mono runtime (`runtime.js`).
 *
 * An application domain is a managed AppDomain handed out as COM through
 * Mono's own interop: the host asks it for `_AppDomain` and calls it as on
 * .NET. What a host asks for that is not done here -- logical thread state,
 * mapped files, domain enumeration, evidence, unloading -- is refused with
 * E_NOTIMPL and said.
 */

import { createComObject } from '../ole32/objects.js';
import { CLSID, IID } from './hosting.js';

const S_OK = 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
/** A managed exception the call threw. */
const COR_E_EXCEPTION = 0x80131500 | 0;
const CLR_E_SHIM_RUNTIME = 0x80131700 | 0;

const COR_RUNTIME_HOST_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateLogicalThreadState', 0], ['DeleteLogicalThreadState', 0],
    ['SwitchInLogicalThreadState', 1], ['SwitchOutLogicalThreadState', 1],
    ['LocksHeldByLogicalThread', 1], ['MapFile', 2], ['GetConfiguration', 1], ['Start', 0],
    ['Stop', 0], ['CreateDomain', 3], ['GetDefaultDomain', 1], ['EnumDomains', 1],
    ['NextDomain', 2], ['CloseEnum', 1], ['CreateDomainEx', 4], ['CreateDomainSetup', 1],
    ['CreateEvidence', 1], ['UnloadDomain', 1], ['CurrentDomain', 1]]);
const CLR_RUNTIME_HOST_SLOTS = /** @type {[string, number][]} */ ([['Start', 0], ['Stop', 0],
    ['SetHostControl', 1], ['GetCLRControl', 1], ['UnloadAppDomain', 2],
    ['ExecuteInAppDomain', 3], ['GetCurrentAppDomainId', 1], ['ExecuteApplication', 6],
    ['ExecuteInDefaultAppDomain', 5]]);

/**
 * @typedef {Object} CorHostHost
 * @property {ReturnType<typeof import('./runtime.js').createMonoRuntime>} runtime
 * @property {(object: any, iid: string) => number} publish
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {() => string} imagePath  the process's executable, the root domain's name
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * @param {CorHostHost} host
 */
export function createRuntimeHosts(host){
    const { runtime } = host;
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** @param {number} at */
    const wideAt = at=>((at >>> 0) === 0 ? null : host.readWideString(at >>> 0, 1024 * 2));
    /** @type {Set<string>} */
    const refused = new Set();

    /** @param {string} api @param {Record<string, Function>} handlers @param {[string, number][]} slots */
    const methods = (api, handlers, slots)=>slots.map(([name, words])=>({
        name, argBytes: 4 + words * 4,
        invoke: (/** @type {any} */ _self, /** @type {number[]} */ args)=>{
            if (handlers[name])
            {
                return handlers[name](args);
            }
            if (!refused.has(`${api}::${name}`))
            {
                refused.add(`${api}::${name}`);
                host.divergence?.(`${api}::${name}`, 'not done here');
            }
            return E_NOTIMPL;
        },
    }));

    /**
     * A managed call's object handed out as COM to `out`: its IUnknown, or why
     * not -- the exception it threw, or a class library without the method.
     *
     * @param {string} api @param {number} out
     * @param {() => Promise<{ result: number } | { thrown: number } | { missing: string }>} make
     * @param {(object: number) => Promise<number>} [asUnknown]  how the object is handed out
     */
    const handOut = async(api, out, make, asUnknown = runtime.unknownFor)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        writeU32(out, 0);
        if (await runtime.attached() === null)
        {
            return E_FAIL;
        }
        const made = await make();
        if ('thrown' in made)
        {
            return COR_E_EXCEPTION;
        }
        if ('missing' in made)
        {
            host.divergence?.(api, `the class library has no ${made.missing}`, 'loss');
            return E_FAIL;
        }
        const unknown = await asUnknown(made.result);
        if (!unknown)
        {
            host.divergence?.(api, 'the managed object could not be handed out as COM', 'loss');
            return E_FAIL;
        }
        writeU32(out, unknown);
        return S_OK;
    };

    const currentDomain = (/** @type {string} */ api)=>(/** @type {number[]} */ [out])=>
        handOut(api, out, ()=>runtime.invoke('System', 'AppDomain', 'get_CurrentDomain', 0, []));

    const corRuntimeHost = createComObject(CLSID.COR_RUNTIME_HOST, { owned: true, interfaces: [
        { id: IID.COR_RUNTIME_HOST, methods: methods('ICorRuntimeHost', {
            Start: async()=>('domain' in await runtime.start(host.imagePath()) ? S_OK : E_FAIL),
            Stop: ()=>S_OK,
            GetDefaultDomain: currentDomain('ICorRuntimeHost::GetDefaultDomain'),
            CurrentDomain: currentDomain('ICorRuntimeHost::CurrentDomain'),
            CreateDomain: async(/** @type {number[]} */ [nameAt, , out])=>{
                const name = wideAt(nameAt);
                if (name === null)
                {
                    return E_POINTER;
                }
                return handOut('ICorRuntimeHost::CreateDomain', out, async()=>
                    runtime.invoke('System', 'AppDomain', 'CreateDomain', 0,
                        [await runtime.string(name)]), runtime.unknownForDomain);
            },
            CreateDomainSetup: (/** @type {number[]} */ [out])=>handOut(
                'ICorRuntimeHost::CreateDomainSetup', out, async()=>{
                    const setup = await runtime.construct('System', 'AppDomainSetup');
                    return setup ? { result: setup } : { missing: 'System.AppDomainSetup' };
                }),
            CreateDomainEx: async(/** @type {number[]} */ [nameAt, setupAt, evidenceAt, out])=>{
                const name = wideAt(nameAt);
                if (name === null)
                {
                    return E_POINTER;
                }
                return handOut('ICorRuntimeHost::CreateDomainEx', out, async()=>{
                    const setup = await runtime.objectFor(setupAt >>> 0);
                    const evidence = await runtime.objectFor(evidenceAt >>> 0);
                    return runtime.invoke('System', 'AppDomain', 'CreateDomain', 0,
                        [await runtime.string(name), evidence, setup]);
                }, runtime.unknownForDomain);
            },
        }, COR_RUNTIME_HOST_SLOTS) },
    ] });

    const clrRuntimeHost = createComObject(CLSID.CLR_RUNTIME_HOST, { owned: true, interfaces: [
        { id: IID.CLR_RUNTIME_HOST, methods: methods('ICLRRuntimeHost', {
            Start: async()=>('domain' in await runtime.start(host.imagePath()) ? S_OK : E_FAIL),
            Stop: ()=>S_OK,
            GetCurrentAppDomainId: (/** @type {number[]} */ [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                // The root domain is the first, and the only one a host is in here.
                writeU32(out, 1);
                return S_OK;
            },
            ExecuteInDefaultAppDomain: async(/** @type {number[]} */ [pathAt, typeAt, methodAt,
                argAt, resultAt])=>{
                const [path, type, method] = [wideAt(pathAt), wideAt(typeAt), wideAt(methodAt)];
                if (path === null || type === null || method === null)
                {
                    return E_POINTER;
                }
                const ran = await runtime.executeMethod(path, type, method, wideAt(argAt) ?? '');
                if ('thrown' in ran)
                {
                    return COR_E_EXCEPTION;
                }
                if ('failed' in ran)
                {
                    host.divergence?.('ICLRRuntimeHost::ExecuteInDefaultAppDomain', ran.failed);
                    return E_FAIL;
                }
                if (resultAt >>> 0)
                {
                    writeU32(resultAt, ran.value);
                }
                return S_OK;
            },
        }, CLR_RUNTIME_HOST_SLOTS) },
    ] });

    /**
     * The runtime's interface a CLSID names, the runtime started for it.
     *
     * @param {string} clsid @param {string} iid
     * @returns {Promise<{ pointer: number } | { failed: number }>}
     */
    return async(clsid, iid)=>{
        const object = clsid === CLSID.COR_RUNTIME_HOST ? corRuntimeHost
            : clsid === CLSID.CLR_RUNTIME_HOST ? clrRuntimeHost : null;
        if (!object)
        {
            host.divergence?.('ICLRRuntimeInfo::GetInterface', `the class ${clsid} is not made`);
            return { failed: 0x80040111 | 0 };
        }
        if (!object.interfaceFor(iid))
        {
            return { failed: E_NOINTERFACE };
        }
        const started = await runtime.start(host.imagePath());
        if ('failed' in started)
        {
            host.divergence?.('ICLRRuntimeInfo::GetInterface',
                `the runtime does not start: ${started.failed}`, 'loss');
            return { failed: CLR_E_SHIM_RUNTIME };
        }
        await runtime.attached();
        return { pointer: host.publish(object, iid) };
    };
}
