/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MMDevAPI's device enumerator, CLSID_MMDeviceEnumerator: the machine's audio
 * endpoints as Windows Vista on lists them, which a program walks to find the
 * device it plays to -- its name, its id, the format its engine mixes in.
 * There is one, a render endpoint: the speakers the page plays through. Nothing
 * here records, so there is no capture endpoint, and the default one of that
 * flow is not found, as on a machine with no microphone.
 *
 * Playing straight to the endpoint (IMMDevice::Activate for IAudioClient) is not
 * here: a program plays through XAudio2 or DirectSound, which this machine has,
 * and is told E_NOINTERFACE, said once as a divergence.
 */

import { createComObject } from './objects.js';

export const CLSID_MMDEVICE_ENUMERATOR = '{BCDE0395-E52F-467C-8E3D-C4579291692E}';
export const IID_IMMDEVICE_ENUMERATOR = '{A95664D2-9614-4F35-A746-DE8DB63617E6}';
export const IID_IMMDEVICE_COLLECTION = '{0BD7A1BE-7A1A-44DB-8397-CC5392387B5E}';
export const IID_IMMDEVICE = '{D666063F-1587-4E43-81F1-B948E807363F}';
export const IID_IMMENDPOINT = '{1BE09788-6894-4089-8586-9A2A6C265AC5}';
export const IID_IPROPERTY_STORE = '{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}';

const S_OK = 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** HRESULT_FROM_WIN32(ERROR_NOT_FOUND): no endpoint of that flow, or by that id. */
export const E_NOTFOUND = 0x80070490 | 0;
/** STG_E_ACCESSDENIED: the store opened to read is written. */
const STG_E_ACCESSDENIED = 0x80030005 | 0;

/** EDataFlow, and DEVICE_STATE_ACTIVE (DEVICE_STATEMASK_ALL is 0xf). */
const E_RENDER = 0;
const E_CAPTURE = 1;
const E_ALL = 2;
const DEVICE_STATE_ACTIVE = 0x1;
/** ERole's three: eConsole, eMultimedia, eCommunications. */
const ROLES = 3;

/** PROPVARIANT's types written here. */
const VT_EMPTY = 0;
const VT_UI4 = 19;
const VT_LPWSTR = 31;
const VT_BLOB = 65;

/** The one endpoint: its id is the shape Windows gives a render endpoint's. */
const SPEAKERS = Object.freeze({
    id: '{0.0.0.00000000}.{b0f6ea1c-5a4d-4e2f-8b3e-9c7d2a61f001}',
    name: 'Speakers',
    adapter: 'High Definition Audio Device',
    channels: 2,
    rate: 48000,
});

/**
 * The properties a program reads of an endpoint, by PROPERTYKEY (`{fmtid} pid`):
 * the friendly name and description, the adapter's name, the form factor
 * (Speakers, 1) and the format the engine mixes in, a WAVEFORMATEXTENSIBLE of
 * 32-bit float at the endpoint's rate and channels.
 */
const KEYS = Object.freeze({
    FRIENDLY_NAME: '{A45C254E-DF1C-4EFD-8020-67D146A850E0} 14',
    DEVICE_DESC: '{A45C254E-DF1C-4EFD-8020-67D146A850E0} 2',
    INTERFACE_FRIENDLY_NAME: '{026E516E-B814-414B-83CD-856D6FEF4822} 2',
    FORM_FACTOR: '{1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E} 0',
    DEVICE_FORMAT: '{F19F064D-082C-4E27-BC73-6882A1BB8E4C} 0',
});

/** KSDATAFORMAT_SUBTYPE_IEEE_FLOAT's bytes. */
const SUBTYPE_IEEE_FLOAT = Uint8Array.of(0x03, 0, 0, 0, 0, 0, 0x10, 0,
    0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71);

/** The engine's mix format: WAVEFORMATEXTENSIBLE, float, front left and right. */
function mixFormat(){
    const bytes = new Uint8Array(40);
    const view = new DataView(bytes.buffer);
    const block = SPEAKERS.channels * 4;
    view.setUint16(0, 0xfffe, true); // WAVE_FORMAT_EXTENSIBLE
    view.setUint16(2, SPEAKERS.channels, true);
    view.setUint32(4, SPEAKERS.rate, true);
    view.setUint32(8, SPEAKERS.rate * block, true);
    view.setUint16(12, block, true);
    view.setUint16(14, 32, true);
    view.setUint16(16, 22, true); // cbSize
    view.setUint16(18, 32, true); // wValidBitsPerSample
    view.setUint32(20, 0x3, true); // SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT
    bytes.set(SUBTYPE_IEEE_FLOAT, 24);
    return bytes;
}

/**
 * @typedef {Object} MmDevApiHost
 * @property {import('./objects.js').ComRegistry} registry
 * @property {{ publish: (object: import('./objects.js').ComObject,
 *     id: string) => number }} vtables
 * @property {{ allocate: (bytes: number) => number }} heap  The task allocator's memory.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {4 | 8} [pointerSize]  8 in a 64-bit process, whose pointers and
 *     PROPVARIANT are wider
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {MmDevApiHost} host */
export function registerMmDevApiClasses(host){
    const pointerSize = host.pointerSize ?? 4;
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0,
        new Uint8Array(Uint32Array.of(value >>> 0).buffer));
    /** An interface or a block written to an out pointer, whole. @param {number} at @param {number} value */
    const writePointer = (at, value)=>{
        const bytes = new Uint8Array(pointerSize);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(at >>> 0, bytes);
    };
    /** A string in task memory, its terminator after it; 0 when none is left. @param {string} text */
    const taskString = text=>{
        const at = host.heap.allocate(text.length * 2 + 2);
        if (at !== 0)
        {
            host.writeMemory(at, new Uint8Array(Uint16Array.from(`${text}\0`,
                c=>c.charCodeAt(0)).buffer));
        }
        return at;
    };
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>{
        if (!said.has(api))
        {
            said.add(api);
            host.divergence?.(api, detail);
        }
    };

    /**
     * An object of these interfaces published, its pointer written to `out`.
     *
     * @param {import('./objects.js').ComInterfaceDescriptor[]} interfaces
     * @param {string} id @param {any} state @param {number} out
     */
    const handOut = (interfaces, id, state, out)=>{
        const object = createComObject(CLSID_MMDEVICE_ENUMERATOR, { interfaces, state });
        const pointer = host.vtables.publish(object, id) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        writePointer(out, pointer);
        return S_OK;
    };

    /** A PROPERTYKEY at an address, as `{fmtid} pid`. @param {number} at */
    const readKey = at=>{
        const bytes = host.readMemory(at >>> 0, 20).slice();
        const view = new DataView(bytes.buffer);
        const hex = (/** @type {number} */ value, /** @type {number} */ width)=>
            value.toString(16).toUpperCase().padStart(width, '0');
        const tail = [...bytes.subarray(8, 16)].map(byte=>hex(byte, 2)).join('');
        return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-`
            + `${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}} `
            + `${view.getUint32(16, true)}`;
    };

    /**
     * A PROPVARIANT written: its type, and at 8 its value -- a number, a pointer to
     * task memory, or a BLOB's size and pointer (the pointer on its own boundary).
     *
     * @param {number} out @param {string} key
     */
    const writeProperty = (out, key)=>{
        const variant = new Uint8Array(pointerSize === 8 ? 24 : 16);
        const view = new DataView(variant.buffer);
        const text = key === KEYS.FRIENDLY_NAME ? `${SPEAKERS.name} (${SPEAKERS.adapter})`
            : key === KEYS.DEVICE_DESC ? SPEAKERS.name
                : key === KEYS.INTERFACE_FRIENDLY_NAME ? SPEAKERS.adapter : null;
        if (text !== null)
        {
            const at = taskString(text);
            if (at === 0)
            {
                return E_OUTOFMEMORY;
            }
            view.setUint16(0, VT_LPWSTR, true);
            view.setUint32(8, at, true);
        }
        else if (key === KEYS.FORM_FACTOR)
        {
            view.setUint16(0, VT_UI4, true);
            view.setUint32(8, 1, true);
        }
        else if (key === KEYS.DEVICE_FORMAT)
        {
            const format = mixFormat();
            const at = host.heap.allocate(format.length);
            if (at === 0)
            {
                return E_OUTOFMEMORY;
            }
            host.writeMemory(at, format);
            view.setUint16(0, VT_BLOB, true);
            view.setUint32(8, format.length, true);
            view.setUint32(8 + pointerSize, at, true);
        }
        else
        {
            // A property the endpoint does not have: VT_EMPTY, and S_OK, as Windows.
            view.setUint16(0, VT_EMPTY, true);
        }
        host.writeMemory(out >>> 0, variant);
        return S_OK;
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const propertyStore = {
        id: IID_IPROPERTY_STORE,
        methods: [
            /** HRESULT GetCount(DWORD *cProps) */
            { name: 'GetCount', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, Object.keys(KEYS).length);
                return S_OK;
            } },
            /** HRESULT GetAt(DWORD iProp, PROPERTYKEY *pkey) */
            { name: 'GetAt', argBytes: 12, invoke: ()=>E_INVALIDARG },
            /** HRESULT GetValue(REFPROPERTYKEY key, PROPVARIANT *pv) */
            { name: 'GetValue', argBytes: 12, invoke: (_, [key, out])=>{
                if ((key >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return writeProperty(out, readKey(key));
            } },
            /** HRESULT SetValue(REFPROPERTYKEY key, REFPROPVARIANT propvar) */
            { name: 'SetValue', argBytes: 12, invoke: ()=>STG_E_ACCESSDENIED },
            /** HRESULT Commit(void) */
            { name: 'Commit', argBytes: 4, invoke: ()=>STG_E_ACCESSDENIED },
        ],
    };

    /** @type {import('./objects.js').ComInterfaceDescriptor[]} */
    const device = [{
        id: IID_IMMDEVICE,
        methods: [
            /**
             * HRESULT Activate(REFIID iid, DWORD dwClsCtx, PROPVARIANT *pActivationParams,
             *     void **ppInterface)
             */
            { name: 'Activate', argBytes: 20, invoke: (_, [, , , out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writePointer(out, 0);
                diverge('IMMDevice::Activate',
                    'no interface of an endpoint is activated: a program plays through XAudio2'
                    + ' or DirectSound');
                return E_NOINTERFACE;
            } },
            /** HRESULT OpenPropertyStore(DWORD stgmAccess, IPropertyStore **ppProperties) */
            { name: 'OpenPropertyStore', argBytes: 12, invoke: (_, [, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                return handOut([propertyStore], IID_IPROPERTY_STORE, null, out);
            } },
            /** HRESULT GetId(LPWSTR *ppstrId): in task memory, the caller's to free. */
            { name: 'GetId', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                const at = taskString(SPEAKERS.id);
                if (at === 0)
                {
                    return E_OUTOFMEMORY;
                }
                writePointer(out, at);
                return S_OK;
            } },
            /** HRESULT GetState(DWORD *pdwState) */
            { name: 'GetState', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, DEVICE_STATE_ACTIVE);
                return S_OK;
            } },
        ],
    }, {
        id: IID_IMMENDPOINT,
        methods: [
            /** HRESULT GetDataFlow(EDataFlow *pDataFlow) */
            { name: 'GetDataFlow', argBytes: 8, invoke: (_, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, E_RENDER);
                return S_OK;
            } },
        ],
    }];

    /** The endpoint, handed out to `out`. @param {number} out */
    const handOutDevice = out=>handOut(device, IID_IMMDEVICE, SPEAKERS, out);

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const collection = {
        id: IID_IMMDEVICE_COLLECTION,
        methods: [
            /** HRESULT GetCount(UINT *pcDevices) */
            { name: 'GetCount', argBytes: 8, invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, object.state.length);
                return S_OK;
            } },
            /** HRESULT Item(UINT nDevice, IMMDevice **ppDevice) */
            { name: 'Item', argBytes: 12, invoke: (object, [index, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if ((index >>> 0) >= object.state.length)
                {
                    writePointer(out, 0);
                    return E_INVALIDARG;
                }
                return handOutDevice(out);
            } },
        ],
    };

    host.registry.registerClass(CLSID_MMDEVICE_ENUMERATOR, ()=>{
        /** The notification clients registered, by pointer. @type {Set<number>} */
        const clients = new Set();
        return {
            interfaces: [{
                id: IID_IMMDEVICE_ENUMERATOR,
                methods: [
                    /**
                     * HRESULT EnumAudioEndpoints(EDataFlow dataFlow, DWORD dwStateMask,
                     *     IMMDeviceCollection **ppDevices)
                     */
                    { name: 'EnumAudioEndpoints', argBytes: 16, invoke: (_, [flow, mask, out])=>{
                        if ((out >>> 0) === 0)
                        {
                            return E_POINTER;
                        }
                        if ((flow >>> 0) > E_ALL || ((mask >>> 0) & ~0xf) !== 0)
                        {
                            return E_INVALIDARG;
                        }
                        const listed = (flow >>> 0) !== E_CAPTURE
                            && ((mask >>> 0) & DEVICE_STATE_ACTIVE) !== 0 ? [SPEAKERS] : [];
                        return handOut([collection], IID_IMMDEVICE_COLLECTION, listed, out);
                    } },
                    /**
                     * HRESULT GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role,
                     *     IMMDevice **ppEndpoint)
                     */
                    { name: 'GetDefaultAudioEndpoint', argBytes: 16,
                        invoke: (_, [flow, role, out])=>{
                            if ((out >>> 0) === 0)
                            {
                                return E_POINTER;
                            }
                            writePointer(out, 0);
                            if ((flow >>> 0) >= E_ALL || (role >>> 0) >= ROLES)
                            {
                                return E_INVALIDARG;
                            }
                            return (flow >>> 0) === E_RENDER ? handOutDevice(out) : E_NOTFOUND;
                        } },
                    /** HRESULT GetDevice(LPCWSTR pwstrId, IMMDevice **ppDevice) */
                    { name: 'GetDevice', argBytes: 12, invoke: (_, [id, out])=>{
                        if ((id >>> 0) === 0 || (out >>> 0) === 0)
                        {
                            return E_POINTER;
                        }
                        writePointer(out, 0);
                        return host.readWideString(id >>> 0, 128 * 2) === SPEAKERS.id
                            ? handOutDevice(out) : E_NOTFOUND;
                    } },
                    /** HRESULT RegisterEndpointNotificationCallback(IMMNotificationClient *) */
                    { name: 'RegisterEndpointNotificationCallback', argBytes: 8,
                        invoke: (_, [client])=>{
                            if ((client >>> 0) === 0)
                            {
                                return E_POINTER;
                            }
                            // No endpoint ever comes or goes here: nothing is sent.
                            clients.add(client >>> 0);
                            return S_OK;
                        } },
                    /** HRESULT UnregisterEndpointNotificationCallback(IMMNotificationClient *) */
                    { name: 'UnregisterEndpointNotificationCallback', argBytes: 8,
                        invoke: (_, [client])=>{
                            if ((client >>> 0) === 0)
                            {
                                return E_POINTER;
                            }
                            return clients.delete(client >>> 0) ? S_OK : E_NOTFOUND;
                        } },
                ],
            }],
        };
    });
}
