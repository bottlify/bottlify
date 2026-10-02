/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WMI, as far as a program asking about its machine goes: CLSID_WbemLocator,
 * the namespace it connects to, and the instances of the one class programs
 * read to size themselves, Win32_VideoController.
 *
 * A program that is refused the locator does not fail; it assumes the least
 * hardware it supports and chooses its settings for that, quietly. The
 * figure it reads is AdapterRAM, so the controller answers with the same
 * video memory Direct3D's GetAvailableTextureMem reports. Every other class
 * enumerates empty and every other method is refused, each through the
 * divergence reporter, so a program that asks for more says what it asked.
 */

import { createComObject } from './objects.js';

export const CLSID_WBEM_LOCATOR = '{4590F811-1D3A-11D0-891F-00AA004B2E24}';
export const IID_IWBEM_LOCATOR = '{DC12A687-737F-11CF-884D-00AA004B2E24}';
export const IID_IWBEM_SERVICES = '{9556DC99-828C-11CF-A37E-00AA003240C7}';
export const IID_IENUM_WBEM_CLASS_OBJECT = '{027947E1-D731-11CE-A357-000000000001}';
export const IID_IWBEM_CLASS_OBJECT = '{DC12A681-737F-11CF-884D-00AA004B2E24}';

const S_OK = 0;
const WBEM_S_FALSE = 1;
const E_OUTOFMEMORY = 0x8007000e | 0;
const WBEM_E_NOT_FOUND = 0x80041002 | 0;
const WBEM_E_INVALID_PARAMETER = 0x80041008 | 0;
const WBEM_E_NOT_SUPPORTED = 0x8004100c | 0;
const WBEM_E_INVALID_NAMESPACE = 0x8004100e | 0;
const WBEM_E_INVALID_QUERY_TYPE = 0x80041038 | 0;

const VT_I4 = 3;
const VT_BSTR = 8;
const CIM_STRING = 8;
const CIM_UINT32 = 19;

/** How far a namespace, class name or query is read. */
const MAX_WBEM_STRING = 1024;

/** The video memory reported, the figure GetAvailableTextureMem also gives. */
export const ADAPTER_RAM = 256 << 20;
export const ADAPTER_NAME = 'Bottlify WebGPU Display Adapter';

/**
 * A class's properties as `name -> [cimType, value]`; the keys are matched
 * without regard to case, as WMI matches them.
 *
 * @type {Record<string, Record<string, [number, number | string]>>}
 */
const CLASSES = {
    win32_videocontroller: {
        adapterram: [CIM_UINT32, ADAPTER_RAM],
        name: [CIM_STRING, ADAPTER_NAME],
        caption: [CIM_STRING, ADAPTER_NAME],
        description: [CIM_STRING, ADAPTER_NAME],
        videoprocessor: [CIM_STRING, ADAPTER_NAME],
    },
};

/**
 * Slots after IUnknown's three, `[name, argBytes]` with `this` counted.
 *
 * @type {Record<string, [string, number][]>}
 */
const SLOTS = {
    services: [
        ['OpenNamespace', 24], ['CancelAsyncCall', 8], ['QueryObjectSink', 12],
        ['GetObject', 24], ['GetObjectAsync', 20], ['PutClass', 20], ['PutClassAsync', 20],
        ['DeleteClass', 20], ['DeleteClassAsync', 20], ['CreateClassEnum', 20],
        ['CreateClassEnumAsync', 20], ['PutInstance', 20], ['PutInstanceAsync', 20],
        ['DeleteInstance', 20], ['DeleteInstanceAsync', 20], ['CreateInstanceEnum', 20],
        ['CreateInstanceEnumAsync', 20], ['ExecQuery', 24], ['ExecQueryAsync', 24],
        ['ExecNotificationQuery', 24], ['ExecNotificationQueryAsync', 24],
        ['ExecMethod', 32], ['ExecMethodAsync', 28],
    ],
    enumerator: [['Reset', 4], ['Next', 20], ['NextAsync', 12], ['Clone', 8], ['Skip', 12]],
    object: [
        ['GetQualifierSet', 8], ['Get', 24], ['Put', 20], ['Delete', 8], ['GetNames', 20],
        ['BeginEnumeration', 8], ['Next', 24], ['EndEnumeration', 4],
        ['GetPropertyQualifierSet', 12], ['Clone', 8], ['GetObjectText', 12],
        ['SpawnDerivedClass', 12], ['SpawnInstance', 12], ['CompareTo', 12],
        ['GetPropertyOrigin', 12], ['InheritsFrom', 8], ['GetMethod', 20], ['PutMethod', 20],
        ['DeleteMethod', 8], ['BeginMethodEnumeration', 8], ['NextMethod', 20],
        ['EndMethodEnumeration', 4], ['GetMethodQualifierSet', 12], ['GetMethodOrigin', 12],
    ],
};

/**
 * @typedef {Object} WbemHost
 * @property {import('./objects.js').ComRegistry} registry
 * @property {{ publish: (object: import('./objects.js').ComObject,
 *              interfaceId: string) => number }} vtables
 * @property {{ allocate: (bytes: number) => number }} heap
 *           The heap SysFreeString and VariantClear free a BSTR to.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Puts the locator where CoCreateInstance finds it.
 *
 * @param {WbemHost} host
 */
export function registerWbemClasses(host){
    const diverge = (/** @type {string} */ api, /** @type {string} */ detail)=>
        host.divergence?.(api, detail);
    const writeU32 = (/** @type {number} */ address, /** @type {number} */ value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };
    const readString = (/** @type {number} */ address)=>
        address === 0 ? '' : host.readWideString(address, MAX_WBEM_STRING);

    /**
     * An object of ours, published, its pointer written to `out`.
     *
     * @param {string} clsid
     * @param {import('./objects.js').ComClassDefinition} definition
     * @param {string} iid
     * @param {number} out
     * @returns {number} an HRESULT
     */
    const publish = (clsid, definition, iid, out)=>{
        const object = createComObject(clsid, definition);
        const pointer = host.vtables.publish(object, iid) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        writeU32(out, pointer);
        return S_OK;
    };

    /**
     * An interface whose named slots do something and whose others are
     * refused and reported.
     *
     * @param {string} id
     * @param {string} label
     * @param {[string, number][]} slots
     * @param {Record<string, (args: number[]) => number>} handlers
     * @returns {import('./objects.js').ComInterfaceDescriptor}
     */
    const describe = (id, label, slots, handlers)=>({
        id,
        methods: slots.map(([name, argBytes])=>({
            name, argBytes,
            invoke: (/** @type {any} */ object, /** @type {number[]} */ args)=>{
                const handler = handlers[name];
                if (handler)
                {
                    return handler(args);
                }
                diverge(`${label}::${name}`, 'not implemented; refused');
                return WBEM_E_NOT_SUPPORTED;
            },
        })),
    });

    /** @param {string} text @returns {number} a BSTR from the heap, or 0 */
    const allocateBstr = text=>{
        const block = host.heap.allocate(4 + text.length * 2 + 2);
        if (block === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array(4 + text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, text.length * 2, true);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(4 + at * 2, text.charCodeAt(at), true);
        }
        host.writeMemory(block, bytes);
        return block + 4;
    };

    /**
     * IWbemClassObject over one instance: Get reads a property, the rest is
     * refused.
     *
     * @param {Record<string, [number, number | string]>} properties
     * @param {number} out
     */
    const publishInstance = (properties, out)=>publish(CLSID_WBEM_LOCATOR, {
        interfaces: [describe(IID_IWBEM_CLASS_OBJECT, 'IWbemClassObject', SLOTS.object, {
            Get: ([name, , value, type, flavor])=>{
                const key = readString(name >>> 0);
                const property = properties[key.toLowerCase()];
                if (!property)
                {
                    diverge('IWbemClassObject::Get', `no property ${key}`);
                    return WBEM_E_NOT_FOUND;
                }
                const [cimType, content] = property;
                if ((value >>> 0) !== 0)
                {
                    const variant = new Uint8Array(16);
                    const view = new DataView(variant.buffer);
                    if (typeof content === 'string')
                    {
                        const bstr = allocateBstr(content);
                        if (bstr === 0)
                        {
                            return E_OUTOFMEMORY;
                        }
                        view.setUint16(0, VT_BSTR, true);
                        view.setUint32(8, bstr, true);
                    }
                    else
                    {
                        // WMI hands a uint32 over as VT_I4.
                        view.setUint16(0, VT_I4, true);
                        view.setUint32(8, content >>> 0, true);
                    }
                    host.writeMemory(value >>> 0, variant);
                }
                if ((type >>> 0) !== 0)
                {
                    writeU32(type >>> 0, cimType);
                }
                if ((flavor >>> 0) !== 0)
                {
                    writeU32(flavor >>> 0, 0);
                }
                return S_OK;
            },
        })],
    }, IID_IWBEM_CLASS_OBJECT, out);

    /**
     * IEnumWbemClassObject over the instances of one class.
     *
     * @param {Record<string, [number, number | string]>[]} instances
     * @param {number} out
     * @returns {number} an HRESULT
     */
    const publishEnumerator = (instances, out)=>{
        let index = 0;
        return publish(CLSID_WBEM_LOCATOR, {
            interfaces: [describe(IID_IENUM_WBEM_CLASS_OBJECT, 'IEnumWbemClassObject',
                SLOTS.enumerator, {
                    Reset: ()=>{
                        index = 0;
                        return S_OK;
                    },
                    Next: ([, count, objects, returned])=>{
                        if ((objects >>> 0) === 0 || (returned >>> 0) === 0)
                        {
                            return WBEM_E_INVALID_PARAMETER;
                        }
                        let fetched = 0;
                        while (fetched < (count >>> 0) && index < instances.length)
                        {
                            const hr = publishInstance(instances[index],
                                (objects >>> 0) + fetched * 4);
                            if (hr !== S_OK)
                            {
                                break;
                            }
                            index++;
                            fetched++;
                        }
                        writeU32(returned >>> 0, fetched);
                        return fetched === (count >>> 0) ? S_OK : WBEM_S_FALSE;
                    },
                    Skip: ([, count])=>{
                        const left = instances.length - index;
                        index = Math.min(instances.length, index + (count >>> 0));
                        return (count >>> 0) <= left ? S_OK : WBEM_S_FALSE;
                    },
                })],
        }, IID_IENUM_WBEM_CLASS_OBJECT, out);
    };

    /**
     * The instances of a class by name; none, and said, for one not kept.
     *
     * @param {string} name
     * @param {string} api
     */
    const instancesOf = (name, api)=>{
        const properties = CLASSES[name.toLowerCase()];
        if (!properties)
        {
            diverge(api, `class ${name} has no instances here; enumerated empty`);
            return [];
        }
        return [properties];
    };

    const services = describe(IID_IWBEM_SERVICES, 'IWbemServices', SLOTS.services, {
        CreateInstanceEnum: ([filter, , , out])=>{
            if ((out >>> 0) === 0)
            {
                return WBEM_E_INVALID_PARAMETER;
            }
            writeU32(out >>> 0, 0);
            return publishEnumerator(
                instancesOf(readString(filter >>> 0), 'IWbemServices::CreateInstanceEnum'),
                out >>> 0);
        },
        ExecQuery: ([language, query, , , out])=>{
            if ((out >>> 0) === 0)
            {
                return WBEM_E_INVALID_PARAMETER;
            }
            writeU32(out >>> 0, 0);
            if (readString(language >>> 0).toUpperCase() !== 'WQL')
            {
                return WBEM_E_INVALID_QUERY_TYPE;
            }
            const text = readString(query >>> 0);
            const from = /\bfrom\s+(\w+)/i.exec(text);
            if (!from)
            {
                diverge('IWbemServices::ExecQuery', `cannot read the class in "${text}"`);
                return WBEM_E_NOT_SUPPORTED;
            }
            if (/\bwhere\b/i.test(text))
            {
                diverge('IWbemServices::ExecQuery', `the condition in "${text}" is ignored`);
            }
            return publishEnumerator(instancesOf(from[1], 'IWbemServices::ExecQuery'),
                out >>> 0);
        },
    });

    const locator = describe(IID_IWBEM_LOCATOR, 'IWbemLocator', [['ConnectServer', 36]], {
        ConnectServer: ([resource, , , , , , , out])=>{
            if ((out >>> 0) === 0)
            {
                return WBEM_E_INVALID_PARAMETER;
            }
            writeU32(out >>> 0, 0);
            const namespace = readString(resource >>> 0);
            // `\\.\root\cimv2`, `root\cimv2` or `//./root/cimv2`: the local
            // default namespace is the only one kept.
            if (!/(^|[\\/])root[\\/]cimv2$/i.test(namespace))
            {
                diverge('IWbemLocator::ConnectServer', `no namespace ${namespace}`);
                return WBEM_E_INVALID_NAMESPACE;
            }
            return publish(CLSID_WBEM_LOCATOR, { interfaces: [services] },
                IID_IWBEM_SERVICES, out >>> 0);
        },
    });

    host.registry.registerClass(CLSID_WBEM_LOCATOR, ()=>({ interfaces: [locator] }));
}
