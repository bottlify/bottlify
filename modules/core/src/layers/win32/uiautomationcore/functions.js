/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * UIAutomationCore - UI Automation's core, the provider side a program's
 * framework talks to (WPF's automation peers, a toolkit's accessibility).
 *
 * No UI Automation client runs beside a program here - no screen reader, no
 * test driver - so there is no one to hand a provider to: clients are never
 * listening, an event raised reaches nobody, which is what Windows does with
 * one no client subscribed to, and a window answers WM_GETOBJECT with nothing
 * for UI Automation. What a provider asks of the core itself is answered: the
 * identifiers by their GUIDs (UiaLookupId, the table `tools/generators/uia-ids.mjs`
 * writes), the two reserved values, and the provider Windows hosts a window
 * with.
 */

import { createComObject } from '../ole32/objects.js';
import { canonicalGuid } from '../ole32/guid.js';
import { UIA_IDS } from './ids.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057;
const E_POINTER = 0x80004003;
const E_OUTOFMEMORY = 0x8007000e;

/** IRawElementProviderSimple. */
const IID_RAW_ELEMENT_PROVIDER_SIMPLE = '{D6DD68D1-86FD-4332-8666-9ABEDEA2D24C}';
/** ProviderOptions_ClientSideProvider: one the system made, not the window's own. */
const PROVIDER_OPTIONS_CLIENT_SIDE = 0x1;
/** UIA_NativeWindowHandlePropertyId, the one property a window's host knows. */
const NATIVE_WINDOW_HANDLE = 30020;
/** VARIANT's types: VT_EMPTY, VT_I4. */
const VT_EMPTY = 0;
const VT_I4 = 3;
const VARIANT_SIZE = 16;

/**
 * @typedef {Object} UiaHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ publish: (object: any, iid: string) => number }} vtables
 * @property {(hwnd: number) => boolean} isWindow
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * The identifier's number by type and GUID, from the table.
 *
 * @type {Map<string, number>}
 */
const NUMBERS = new Map(UIA_IDS.map(([type, guid, id])=>[`${type}:${guid}`, id]));

/** @param {UiaHost} host */
export function createUiaFunctions(host){
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));

    /** The kinds UiaLookupId was asked a GUID of that the table does not hold. */
    const unknownTypes = new Set();

    /** A GUID in guest memory as its canonical text. @param {number} at */
    const guidAt = at=>{
        const raw = host.readMemory(at >>> 0, 16);
        const view = new DataView(raw.buffer, raw.byteOffset, 16);
        const hex = (/** @type {number} */ value, /** @type {number} */ digits)=>value
            .toString(16).toUpperCase().padStart(digits, '0');
        const tail = [...raw.subarray(8)].map(byte=>hex(byte, 2)).join('');
        return canonicalGuid(`{${hex(view.getUint32(0, true), 8)}-`
            + `${hex(view.getUint16(4, true), 4)}-${hex(view.getUint16(6, true), 4)}-`
            + `${tail.slice(0, 4)}-${tail.slice(4)}}`) ?? '';
    };

    /**
     * The two reserved values, each one object for the process: a provider
     * answers them for an attribute that is mixed over a range, or one it
     * does not support, and a client compares the pointer.
     *
     * @type {Record<'mixed' | 'notSupported', any>}
     */
    const reserved = {
        mixed: createComObject('{00000000-0000-0000-C000-000000000046}', { interfaces: [] }),
        notSupported: createComObject('{00000000-0000-0000-C000-000000000046}',
            { interfaces: [] }),
    };
    // The process holds both for good: a program's last release leaves them.
    reserved.mixed.addRef();
    reserved.notSupported.addRef();

    /** @param {'mixed' | 'notSupported'} which */
    const reservedValue = which=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const object = reserved[which];
            const pointer = host.vtables.publish(object, '{00000000-0000-0000-C000-000000000046}');
            if (pointer === 0)
            {
                putU32(out, 0);
                return E_OUTOFMEMORY;
            }
            object.addRef();
            putU32(out, pointer);
            return S_OK;
        },
    });

    /** The provider Windows hosts a window with: its handle, and nothing else known. */
    /** @type {import('../ole32/objects.js').ComInterfaceDescriptor} */
    const hostDescriptor = { id: IID_RAW_ELEMENT_PROVIDER_SIMPLE, methods: [
        /** HRESULT get_ProviderOptions(enum ProviderOptions *pRetVal) */
        { name: 'get_ProviderOptions', argBytes: 8, invoke: (object, [out])=>{
            void object;
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32(out, PROVIDER_OPTIONS_CLIENT_SIDE);
            return S_OK;
        } },
        /** HRESULT GetPatternProvider(PATTERNID patternId, IUnknown **pRetVal): none. */
        { name: 'GetPatternProvider', argBytes: 12, invoke: (object, [, out])=>{
            void object;
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32(out, 0);
            return S_OK;
        } },
        /** HRESULT GetPropertyValue(PROPERTYID propertyId, VARIANT *pRetVal) */
        { name: 'GetPropertyValue', argBytes: 12, invoke: (object, [property, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const variant = new Uint8Array(VARIANT_SIZE);
            const view = new DataView(variant.buffer);
            view.setUint16(0, VT_EMPTY, true);
            if ((property >>> 0) === NATIVE_WINDOW_HANDLE)
            {
                view.setUint16(0, VT_I4, true);
                view.setUint32(8, /** @type {any} */ (object).state.hwnd, true);
            }
            host.writeMemory(out >>> 0, variant);
            return S_OK;
        } },
        /** HRESULT get_HostRawElementProvider(IRawElementProviderSimple **pRetVal): none above. */
        { name: 'get_HostRawElementProvider', argBytes: 8, invoke: (object, [out])=>{
            void object;
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32(out, 0);
            return S_OK;
        } },
    ] };

    /** An event raised: S_OK, as no client listens. @param {number} argBytes */
    const raised = argBytes=>({
        argBytes,
        /** @param {number[]} args */
        handler: ([provider])=>((provider >>> 0) === 0 ? E_INVALIDARG : S_OK),
    });

    return {
        /** int UiaLookupId(enum AutomationIdentifierType type, const GUID *pGuid) */
        UiaLookupId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([type, guid])=>{
                if ((guid >>> 0) === 0)
                {
                    return 0;
                }
                const found = NUMBERS.get(`${type >>> 0}:${guidAt(guid)}`);
                if (found === undefined && !unknownTypes.has(type >>> 0))
                {
                    unknownTypes.add(type >>> 0);
                    host.divergence?.('UiaLookupId', `identifiers of type ${type >>> 0} are not`
                        + ' known past the properties, patterns, events and control types');
                }
                return found ?? 0;
            },
        },

        /** BOOL UiaClientsAreListening(void): none ever is. */
        UiaClientsAreListening: { argBytes: 0, handler: ()=>0 },

        /** HRESULT UiaGetReservedMixedAttributeValue(IUnknown **punkMixedAttributeValue) */
        UiaGetReservedMixedAttributeValue: reservedValue('mixed'),
        /** HRESULT UiaGetReservedNotSupportedValue(IUnknown **punkNotSupportedValue) */
        UiaGetReservedNotSupportedValue: reservedValue('notSupported'),

        /**
         * HRESULT UiaHostProviderFromHwnd(HWND hwnd, IRawElementProviderSimple **ppProvider)
         *
         * A provider of the window's own: its handle as NativeWindowHandle,
         * nothing else. No window is E_INVALIDARG.
         */
        UiaHostProviderFromHwnd: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwnd, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                putU32(out, 0);
                if (!host.isWindow(hwnd >>> 0))
                {
                    return E_INVALIDARG;
                }
                const object = createComObject(IID_RAW_ELEMENT_PROVIDER_SIMPLE, {
                    interfaces: [hostDescriptor], state: { hwnd: hwnd >>> 0 } });
                const pointer = host.vtables.publish(object, IID_RAW_ELEMENT_PROVIDER_SIMPLE);
                if (pointer === 0)
                {
                    return E_OUTOFMEMORY;
                }
                putU32(out, pointer);
                return S_OK;
            },
        },

        /**
         * LRESULT UiaReturnRawElementProvider(HWND hwnd, WPARAM wParam, LPARAM lParam,
         *     IRawElementProviderSimple *el)
         *
         * What a window answers WM_GETOBJECT with: nothing, as no client asked.
         */
        UiaReturnRawElementProvider: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>(void args, 0),
        },

        /** HRESULT UiaRaiseAutomationEvent(IRawElementProviderSimple *, EVENTID) */
        UiaRaiseAutomationEvent: raised(8),
        /** HRESULT UiaRaiseAutomationPropertyChangedEvent(provider, PROPERTYID, VARIANT, VARIANT) */
        UiaRaiseAutomationPropertyChangedEvent: raised(8 + 2 * VARIANT_SIZE),
        /** HRESULT UiaRaiseStructureChangedEvent(provider, StructureChangeType, int *, int) */
        UiaRaiseStructureChangedEvent: raised(16),
        /** HRESULT UiaRaiseAsyncContentLoadedEvent(provider, AsyncContentLoadedState, double) */
        UiaRaiseAsyncContentLoadedEvent: raised(16),
        /** HRESULT UiaRaiseNotificationEvent(provider, kind, processing, BSTR, BSTR) */
        UiaRaiseNotificationEvent: raised(20),
        /** HRESULT UiaRaiseTextEditTextChangedEvent(provider, TextEditChangeType, SAFEARRAY *) */
        UiaRaiseTextEditTextChangedEvent: raised(12),
        /** HRESULT UiaRaiseChangesEvent(provider, int, UiaChangeInfo *) */
        UiaRaiseChangesEvent: raised(12),
        /** HRESULT UiaRaiseActiveTextPositionChangedEvent(provider, ITextRangeProvider *) */
        UiaRaiseActiveTextPositionChangedEvent: raised(8),

        /** HRESULT UiaDisconnectProvider(IRawElementProviderSimple *): none is connected. */
        UiaDisconnectProvider: raised(4),
        /** HRESULT UiaDisconnectAllProviders(void) */
        UiaDisconnectAllProviders: { argBytes: 0, handler: ()=>S_OK },

        /** BOOL UiaHasServerSideProvider(HWND hwnd): the core keeps none. */
        UiaHasServerSideProvider: { argBytes: 4, handler: ()=>0 },

        /** BOOL UiaGetErrorDescription(BSTR *pDescription): no error has one. */
        UiaGetErrorDescription: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) !== 0)
                {
                    putU32(out, 0);
                }
                return 0;
            },
        },
    };
}
