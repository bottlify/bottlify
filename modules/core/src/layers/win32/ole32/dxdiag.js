/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DxDiag's provider, as dxdiagn serves it in process: CLSID_DxDiagProvider,
 * a tree of named containers, and the properties of the one a program reads
 * to learn which DirectX it runs on, DxDiag_SystemInfo.
 *
 * The DirectX SDK's own way of telling 9.0c from 9.0 goes through here: the
 * major and minor numbers and the release letter. Its fallback, when the
 * provider will not come up, reads file versions, and those only ever say
 * 9.0 -- so an installer that wants 9.0c refuses a machine without the
 * provider however new its files are. The numbers are the ones the registry
 * and every DirectX file carry. A container this build does not keep is
 * refused as an unknown one is, and said through the divergence reporter.
 */

import { DIRECTX_RELEASE, DIRECTX_VERSION } from '../advapi32/registry.js';
import { createComObject } from './objects.js';

export const CLSID_DXDIAG_PROVIDER = '{A65B8071-3BFE-4213-9A5B-491DA4461CA7}';
export const IID_IDXDIAG_PROVIDER = '{9C6B4CB0-23F8-49CC-A3ED-45A55000A6D2}';
export const IID_IDXDIAG_CONTAINER = '{7D0F462F-4064-4862-BC7F-933E5058C10F}';

/** The dxdiag.h an application was built with; Initialize takes this one. */
export const DXDIAG_DX9_SDK_VERSION = 111;
/** sizeof(DXDIAG_INIT_PARAMS): dwSize, the header version, bAllowWHQLChecks, pReserved. */
const INIT_PARAMS_SIZE = 16;

const S_OK = 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const CO_E_NOTINITIALIZED = 0x800401f0 | 0;
/** HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER). */
export const DXDIAG_E_INSUFFICIENT_BUFFER = 0x8007007a | 0;

const VT_UI4 = 19;
const VT_BOOL = 11;
const VT_BSTR = 8;

/** How far a container or property name is read. */
const MAX_NAME = 256;

/**
 * @typedef {{ vt: number, value: number | string }} DxDiagProperty
 * @typedef {{ properties: Map<string, DxDiagProperty>, children: Map<string, DxDiagNode> }}
 *     DxDiagNode
 */

/** @param {number} value @returns {DxDiagProperty} */
const u32 = value=>({ vt: VT_UI4, value });
/** @param {string} value @returns {DxDiagProperty} */
const text = value=>({ vt: VT_BSTR, value });
/** @param {boolean} value @returns {DxDiagProperty} */
const bool = value=>({ vt: VT_BOOL, value: value ? 0xffff : 0 });

/**
 * The tree the provider answers from. DxDiag's long form of the version pads
 * the release to four digits: 4.09.0000.0904.
 *
 * @param {import('../kernel32/versions.js').WindowsVersion} windows
 * @returns {DxDiagNode}
 */
export function dxDiagTree(windows){
    const [major, minor, release, build] = DIRECTX_VERSION.split('.');
    /** @type {Record<string, DxDiagProperty>} */
    const systemInfo = {
        dwOSMajorVersion: u32(windows.major),
        dwOSMinorVersion: u32(windows.minor),
        dwOSBuildNumber: u32(windows.build),
        dwOSPlatformID: u32(windows.platformId),
        dwDirectXVersionMajor: u32(DIRECTX_RELEASE.major),
        dwDirectXVersionMinor: u32(DIRECTX_RELEASE.minor),
        szDirectXVersionLetter: text(DIRECTX_RELEASE.letter),
        szDirectXVersionEnglish: text(`${major}.${minor}.${release.padStart(4, '0')}.${build}`),
        bDebug: bool(false),
        szWindowsDir: text('C:\\WINDOWS'),
    };
    /** @type {(properties: Record<string, DxDiagProperty>) => DxDiagNode} */
    const node = properties=>({ properties: new Map(Object.entries(properties)),
        children: new Map() });
    const root = node({});
    root.children.set('DxDiag_SystemInfo', node(systemInfo));
    return root;
}

/**
 * @typedef {Object} DxDiagHost
 * @property {import('./objects.js').ComRegistry} registry
 * @property {{ publish: (object: import('./objects.js').ComObject,
 *              interfaceId: string) => number }} vtables
 * @property {{ allocate: (bytes: number) => number }} heap
 *           The heap SysFreeString and VariantClear free a BSTR to.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {import('../kernel32/versions.js').WindowsVersion} windows
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Puts the provider where CoCreateInstance finds it.
 *
 * @param {DxDiagHost} host
 */
export function registerDxDiagClasses(host){
    const tree = dxDiagTree(host.windows);
    const writeU32 = (/** @type {number} */ address, /** @type {number} */ value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };
    /** @param {number} address @param {string} value  With its terminator. */
    const writeWide = (address, value)=>{
        const bytes = new Uint8Array(value.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < value.length; at++)
        {
            view.setUint16(at * 2, value.charCodeAt(at), true);
        }
        host.writeMemory(address, bytes);
    };

    /** @param {string} value @returns {number} a BSTR from the heap, or 0 */
    const allocateBstr = value=>{
        const block = host.heap.allocate(4 + value.length * 2 + 2);
        if (block === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array(4 + value.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, value.length * 2, true);
        for (let at = 0; at < value.length; at++)
        {
            view.setUint16(4 + at * 2, value.charCodeAt(at), true);
        }
        host.writeMemory(block, bytes);
        return block + 4;
    };

    /**
     * A name at an index, into a buffer of `size` characters: truncated to fit
     * and refused as too small when it did not, and an empty string for an
     * index past the end, as dxdiagn fills both enumerations.
     *
     * @param {string[]} names @param {number} index @param {number} out @param {number} size
     */
    const enumerate = (names, index, out, size)=>{
        if ((out >>> 0) === 0 || (size >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const name = names[index >>> 0];
        if (name === undefined)
        {
            writeWide(out >>> 0, '');
            return E_INVALIDARG;
        }
        writeWide(out >>> 0, name.slice(0, (size >>> 0) - 1));
        return name.length < (size >>> 0) ? S_OK : DXDIAG_E_INSUFFICIENT_BUFFER;
    };

    /** @param {number} address @returns {string} */
    const readName = address=>host.readWideString(address, MAX_NAME);

    /** @param {number} out @param {number} value */
    const count = (out, value)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        writeU32(out >>> 0, value);
        return S_OK;
    };

    /**
     * One IDxDiagContainer over a node of the tree, its pointer written to
     * `out`.
     *
     * @param {DxDiagNode} node @param {number} out
     */
    const publishContainer = (node, out)=>{
        const object = createComObject(CLSID_DXDIAG_PROVIDER,
            { interfaces: [container], state: node });
        const pointer = host.vtables.publish(object, IID_IDXDIAG_CONTAINER) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        writeU32(out, pointer);
        return S_OK;
    };

    /** @param {any} object @returns {DxDiagNode} */
    const nodeOf = object=>object.state;

    /** @type {import('./objects.js').ComInterfaceDescriptor} */
    const container = {
        id: IID_IDXDIAG_CONTAINER,
        methods: [
            /** HRESULT GetNumberOfChildContainers(DWORD *pdwCount) */
            { name: 'GetNumberOfChildContainers', argBytes: 8,
                invoke: (object, [out])=>count(out, nodeOf(object).children.size) },
            /** HRESULT EnumChildContainerNames(DWORD, LPWSTR, DWORD) */
            { name: 'EnumChildContainerNames', argBytes: 16,
                invoke: (object, [index, out, size])=>
                    enumerate([...nodeOf(object).children.keys()], index, out, size) },
            /**
             * HRESULT GetChildContainer(LPCWSTR pwszContainer, IDxDiagContainer **)
             *
             * A name may be a path, its parts joined by dots, each one a
             * level further down.
             */
            { name: 'GetChildContainer', argBytes: 12,
                invoke: (object, [name, out])=>{
                    if ((name >>> 0) === 0 || (out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    const path = readName(name >>> 0);
                    /** @type {DxDiagNode | undefined} */
                    let node = nodeOf(object);
                    for (const part of path.split('.'))
                    {
                        node = part === '' ? undefined : node?.children.get(part);
                    }
                    if (!node)
                    {
                        host.divergence?.('IDxDiagContainer::GetChildContainer',
                            `no container ${path}`);
                        return E_INVALIDARG;
                    }
                    return publishContainer(node, out >>> 0);
                } },
            /** HRESULT GetNumberOfProps(DWORD *pdwCount) */
            { name: 'GetNumberOfProps', argBytes: 8,
                invoke: (object, [out])=>count(out, nodeOf(object).properties.size) },
            /** HRESULT EnumPropNames(DWORD, LPWSTR, DWORD) */
            { name: 'EnumPropNames', argBytes: 16,
                invoke: (object, [index, out, size])=>
                    enumerate([...nodeOf(object).properties.keys()], index, out, size) },
            /**
             * HRESULT GetProp(LPCWSTR pwszPropName, VARIANT *pvarProp)
             *
             * A copy the caller owns: a string is a BSTR it frees with
             * VariantClear. The VARIANT is written over, as one a caller has
             * just initialised is.
             */
            { name: 'GetProp', argBytes: 12,
                invoke: (object, [name, out])=>{
                    if ((name >>> 0) === 0 || (out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    const key = readName(name >>> 0);
                    const property = nodeOf(object).properties.get(key);
                    if (!property)
                    {
                        host.divergence?.('IDxDiagContainer::GetProp', `no property ${key}`);
                        return E_INVALIDARG;
                    }
                    const variant = new Uint8Array(16);
                    const view = new DataView(variant.buffer);
                    view.setUint16(0, property.vt, true);
                    if (typeof property.value === 'string')
                    {
                        const bstr = allocateBstr(property.value);
                        if (bstr === 0)
                        {
                            return E_OUTOFMEMORY;
                        }
                        view.setUint32(8, bstr, true);
                    }
                    else
                    {
                        view.setUint32(8, property.value >>> 0, true);
                    }
                    host.writeMemory(out >>> 0, variant);
                    return S_OK;
                } },
        ],
    };

    host.registry.registerClass(CLSID_DXDIAG_PROVIDER, ()=>{
        let initialised = false;
        return {
            interfaces: [{
                id: IID_IDXDIAG_PROVIDER,
                methods: [
                    /**
                     * HRESULT Initialize(DXDIAG_INIT_PARAMS *pParams)
                     *
                     * The block has to be the size and the header version
                     * this provider knows; a second call is as good as the
                     * first.
                     */
                    { name: 'Initialize', argBytes: 8,
                        invoke: (_, [params])=>{
                            if ((params >>> 0) === 0)
                            {
                                return E_POINTER;
                            }
                            const block = new DataView(
                                host.readMemory(params >>> 0, 8).slice().buffer);
                            if (block.getUint32(0, true) !== INIT_PARAMS_SIZE
                                || block.getUint32(4, true) !== DXDIAG_DX9_SDK_VERSION)
                            {
                                return E_INVALIDARG;
                            }
                            initialised = true;
                            return S_OK;
                        } },
                    /** HRESULT GetRootContainer(IDxDiagContainer **ppInstance) */
                    { name: 'GetRootContainer', argBytes: 8,
                        invoke: (_, [out])=>{
                            if (!initialised)
                            {
                                return CO_E_NOTINITIALIZED;
                            }
                            if ((out >>> 0) === 0)
                            {
                                return E_INVALIDARG;
                            }
                            return publishContainer(tree, out >>> 0);
                        } },
                ],
            }],
        };
    });
}
