/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WMI, as far as a program asking about its machine goes: CLSID_WbemLocator,
 * the namespace it connects to, and the instances of the classes programs read
 * to size themselves or to describe the machine in a report --
 * Win32_VideoController, Win32_SoundDevice, Win32_Processor, Win32_BIOS,
 * Win32_BaseBoard, the physical memory and its array, a slot and a disk. Every figure is the one
 * the machine gives the same program another way: the processor's CPUID and
 * speed, the physical memory GlobalMemoryStatus reports, the video memory
 * Direct3D's GetAvailableTextureMem reports, the computer's name.
 *
 * A program that is refused the locator does not fail; it assumes the least
 * hardware it supports and chooses its settings for that, quietly. Every other
 * class enumerates empty and every other method is refused, each through the
 * divergence reporter, so a program that asks for more says what it asked.
 */

import { createComObject } from './objects.js';
import { COMPUTER_NAME } from '../kernel32/drives.js';
import { CPUID, PROCESSOR, PROCESSOR_IDENTIFIER } from '../kernel32/processor.js';
import { SOUND_ADAPTER_NAME, VIDEO_ADAPTER_NAME } from '../devices.js';

export const CLSID_WBEM_LOCATOR = '{4590F811-1D3A-11D0-891F-00AA004B2E24}';
export const IID_IWBEM_LOCATOR = '{DC12A687-737F-11CF-884D-00AA004B2E24}';
export const IID_IWBEM_SERVICES = '{9556DC99-828C-11CF-A37E-00AA003240C7}';
export const IID_IENUM_WBEM_CLASS_OBJECT = '{027947E1-D731-11CE-A357-000000000001}';
export const IID_IWBEM_CLASS_OBJECT = '{DC12A681-737F-11CF-884D-00AA004B2E24}';

const S_OK = 0;
const WBEM_S_FALSE = 1;
const E_OUTOFMEMORY = 0x8007000e | 0;
const WBEM_E_INVALID_PARAMETER = 0x80041008 | 0;
const WBEM_E_NOT_SUPPORTED = 0x8004100c | 0;
const WBEM_E_INVALID_NAMESPACE = 0x8004100e | 0;
const WBEM_E_INVALID_QUERY_TYPE = 0x80041038 | 0;

const VT_I4 = 3;
const VT_NULL = 1;
const VT_BSTR = 8;
const VT_BOOL = 11;
const VT_ARRAY = 0x2000;
const CIM_STRING = 8;
const CIM_BOOLEAN = 11;
const CIM_UINT16 = 18;
const CIM_UINT32 = 19;
const CIM_UINT64 = 21;
const CIM_DATETIME = 101;
const CIM_REFERENCE = 102;
const CIM_FLAG_ARRAY = 0x2000;

/** How far a namespace, class name or query is read. */
const MAX_WBEM_STRING = 1024;

/** The video memory reported, the figure GetAvailableTextureMem also gives. */
export const ADAPTER_RAM = 256 << 20;
export const ADAPTER_NAME = VIDEO_ADAPTER_NAME;

/**
 * A property: its CIM type and its value. WMI hands every integer of 32 bits
 * or less over as VT_I4, a 64-bit one as a string, an array as a SAFEARRAY of
 * VT_I4, a boolean as VT_BOOL.
 *
 * @typedef {[number, number | string | boolean | number[]]} WbemProperty
 */

/**
 * Each kept class's instances, each instance its properties keyed in lower
 * case, as WMI matches names without regard to it.
 *
 * @param {{ physicalMemory?: number,
 *     windows?: import('../kernel32/versions.js').WindowsVersion }} machine
 * @returns {Record<string, Record<string, WbemProperty>[]>}
 */
function machineClasses({ physicalMemory = 0, windows }){
    const hex = (/** @type {number} */ value)=>(value >>> 0).toString(16).toUpperCase()
        .padStart(8, '0');
    // A reference names its instance by the computer, the namespace, the
    // class and its key, as an association's ends are written.
    const reference = (/** @type {string} */ path)=>`\\\\${COMPUTER_NAME}\\root\\cimv2:${path}`;
    const memory = Math.max(physicalMemory, 0);
    // The one operating system, as the process is told it is elsewhere --
    // GetVersionEx, the registry's ProductName: a program reads it without
    // asking whether there is one, since there always is.
    /** @type {Record<string, Record<string, WbemProperty>[]>} */
    const system = windows ? {
        win32_operatingsystem: [{
            caption: [CIM_STRING, windows.productName.startsWith('Microsoft')
                ? `${windows.productName}${windows.major === 5 ? ' Professional' : ''}`
                : `Microsoft ${windows.productName}`],
            version: [CIM_STRING, `${windows.major}.${windows.minor}.${windows.build}`],
            buildnumber: [CIM_STRING, String(windows.build)],
            csdversion: [CIM_STRING, windows.csdVersion],
            servicepackmajorversion: [CIM_UINT16, windows.servicePackMajor],
            servicepackminorversion: [CIM_UINT16, windows.servicePackMinor],
            manufacturer: [CIM_STRING, 'Microsoft Corporation'],
            ostype: [CIM_UINT16, 18], // WINNT
            producttype: [CIM_UINT32, windows.productType],
            systemdirectory: [CIM_STRING, 'C:\\WINDOWS\\system32'],
            windowsdirectory: [CIM_STRING, 'C:\\WINDOWS'],
            systemdrive: [CIM_STRING, 'C:'],
            csname: [CIM_STRING, COMPUTER_NAME],
            oslanguage: [CIM_UINT32, 1033],
            countrycode: [CIM_STRING, '1'],
            locale: [CIM_STRING, '0409'],
            codeset: [CIM_STRING, '1252'],
            totalvisiblememorysize: [CIM_UINT64, String(Math.floor(memory / 1024))],
            freephysicalmemory: [CIM_UINT64, String(Math.floor(memory / 2048))],
            numberofprocesses: [CIM_UINT32, 1],
            numberofusers: [CIM_UINT32, 1],
            primary: [CIM_BOOLEAN, true],
            status: [CIM_STRING, 'OK'],
        }],
    } : {};
    return {
        ...system,
        win32_videocontroller: [{
            adapterram: [CIM_UINT32, ADAPTER_RAM],
            name: [CIM_STRING, ADAPTER_NAME],
            caption: [CIM_STRING, ADAPTER_NAME],
            description: [CIM_STRING, ADAPTER_NAME],
            videoprocessor: [CIM_STRING, ADAPTER_NAME],
        }],
        win32_sounddevice: [{
            deviceid: [CIM_STRING, 'BOTTLIFY\\SOUND\\0000'],
            name: [CIM_STRING, SOUND_ADAPTER_NAME],
            productname: [CIM_STRING, SOUND_ADAPTER_NAME],
            caption: [CIM_STRING, SOUND_ADAPTER_NAME],
            description: [CIM_STRING, SOUND_ADAPTER_NAME],
            manufacturer: [CIM_STRING, 'Bottlify'],
            status: [CIM_STRING, 'OK'],
            statusinfo: [CIM_UINT16, 3], // enabled
        }],
        win32_processor: [{
            deviceid: [CIM_STRING, 'CPU0'],
            manufacturer: [CIM_STRING, PROCESSOR.vendor],
            name: [CIM_STRING, PROCESSOR_IDENTIFIER],
            caption: [CIM_STRING, PROCESSOR_IDENTIFIER],
            description: [CIM_STRING, PROCESSOR_IDENTIFIER],
            // CPUID leaf 1's EDX, then its EAX.
            processorid: [CIM_STRING, hex(CPUID.edx) + hex(CPUID.signature)],
            maxclockspeed: [CIM_UINT32, PROCESSOR.mhz],
            currentclockspeed: [CIM_UINT32, PROCESSOR.mhz],
            extclock: [CIM_UINT32, 100],
            processortype: [CIM_UINT16, 3], // a central processor
            upgrademethod: [CIM_UINT16, 2], // unknown
            family: [CIM_UINT16, 2], // unknown
            architecture: [CIM_UINT16, 0], // x86
            level: [CIM_UINT16, PROCESSOR.family],
            revision: [CIM_UINT16, PROCESSOR.model << 8 | PROCESSOR.stepping],
            addresswidth: [CIM_UINT16, 32],
            datawidth: [CIM_UINT16, 32],
            socketdesignation: [CIM_STRING, 'CPU 1'],
        }],
        win32_bios: [{
            manufacturer: [CIM_STRING, 'Bottlify'],
            name: [CIM_STRING, 'Bottlify BIOS'],
            version: [CIM_STRING, 'BTLFY - 1'],
            smbiosbiosversion: [CIM_STRING, '1.0'],
            serialnumber: [CIM_STRING, '0'],
            releasedate: [CIM_DATETIME, '20260101000000.000000+000'],
            // PCI, plug and play, upgradeable, shadowing, boot from CD,
            // selectable boot, EDD, the floppy and print services.
            bioscharacteristics: [CIM_UINT16 | CIM_FLAG_ARRAY,
                [7, 9, 11, 12, 15, 16, 19, 26, 27, 28, 29, 30, 32, 33]],
        }],
        win32_baseboard: [{
            tag: [CIM_STRING, 'Base Board'],
            manufacturer: [CIM_STRING, 'Bottlify'],
            product: [CIM_STRING, 'Bottlify Board'],
            version: [CIM_STRING, '1.0'],
            serialnumber: [CIM_STRING, '0'],
        }],
        win32_physicalmemoryarray: [{
            tag: [CIM_STRING, 'Physical Memory Array 0'],
            location: [CIM_UINT16, 3], // the system board
            use: [CIM_UINT16, 3], // system memory
            memoryerrorcorrection: [CIM_UINT16, 3], // none
            maxcapacity: [CIM_UINT32, Math.floor(memory / 1024)],
            memorydevices: [CIM_UINT16, 1],
        }],
        win32_physicalmemory: [{
            tag: [CIM_STRING, 'Physical Memory 0'],
            capacity: [CIM_UINT64, String(memory)],
            devicelocator: [CIM_STRING, 'DIMM 1'],
            banklabel: [CIM_STRING, 'BANK 0'],
            datawidth: [CIM_UINT16, 64],
            totalwidth: [CIM_UINT16, 64],
            formfactor: [CIM_UINT16, 8], // a DIMM
            memorytype: [CIM_UINT16, 17], // SDRAM
            typedetail: [CIM_UINT16, 128], // synchronous
            speed: [CIM_UINT32, 133],
        }],
        win32_memorydevicelocation: [{
            antecedent: [CIM_REFERENCE,
                reference('Win32_PhysicalMemoryArray.Tag="Physical Memory Array 0"')],
            dependent: [CIM_REFERENCE, reference('Win32_PhysicalMemory.Tag="Physical Memory 0"')],
        }],
        win32_systemslot: [{
            tag: [CIM_STRING, 'System Slot 0'],
            slotdesignation: [CIM_STRING, 'AGP'],
            currentusage: [CIM_UINT16, 5], // in use
            maxdatawidth: [CIM_UINT16, 2], // 32 bits
            supportshotplug: [CIM_BOOLEAN, false],
            connectortype: [CIM_UINT16 | CIM_FLAG_ARRAY, [2]], // other
        }],
        win32_diskdrive: [{
            deviceid: [CIM_STRING, '\\\\.\\PHYSICALDRIVE0'],
            index: [CIM_UINT32, 0],
            model: [CIM_STRING, 'Bottlify Virtual Disk'],
            caption: [CIM_STRING, 'Bottlify Virtual Disk'],
            manufacturer: [CIM_STRING, '(Standard disk drives)'],
            interfacetype: [CIM_STRING, 'IDE'],
            mediatype: [CIM_STRING, 'Fixed hard disk media'],
            size: [CIM_UINT64, String(64 * 1024 ** 3)],
            bytespersector: [CIM_UINT32, 512],
            partitions: [CIM_UINT32, 1],
        }],
    };
}

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
 * @property {number} [physicalMemory]  What GlobalMemoryStatus reports as physical memory.
 * @property {import('../kernel32/versions.js').WindowsVersion} [windows]
 *           The Windows the process is told it runs on.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * Puts the locator where CoCreateInstance finds it.
 *
 * @param {WbemHost} host
 */
export function registerWbemClasses(host){
    const CLASSES = machineClasses({ physicalMemory: host.physicalMemory, windows: host.windows });
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
     * A SAFEARRAY of VT_I4 over the values, laid out and allocated as
     * SafeArrayCreate lays out its own -- so SafeArrayDestroy and VariantClear
     * free it -- or 0.
     *
     * @param {number[]} values @returns {number}
     */
    const allocateArray = values=>{
        const descriptor = host.heap.allocate(24);
        const data = host.heap.allocate(Math.max(1, values.length * 4));
        if (descriptor === 0 || data === 0)
        {
            return 0;
        }
        const header = new Uint8Array(24);
        const view = new DataView(header.buffer);
        view.setUint16(0, 1, true); // one dimension
        view.setUint32(4, 4, true); // four bytes an element
        view.setUint32(12, data, true);
        view.setUint32(16, values.length, true); // its count, from a lower bound of 0
        host.writeMemory(descriptor, header);
        const elements = new Uint8Array(values.length * 4);
        values.forEach((value, index)=>new DataView(elements.buffer)
            .setUint32(index * 4, value >>> 0, true));
        host.writeMemory(data, elements);
        return descriptor;
    };

    /**
     * IWbemClassObject over one instance: Get reads a property, the rest is
     * refused. A property this build keeps no value for reads as VT_NULL, as
     * one the machine has no value for does in WMI -- a client tells a value
     * from none by VT_NULL, and an empty VARIANT reads to it as a string it
     * was given -- and it is said.
     *
     * @param {Record<string, WbemProperty>} properties
     * @param {number} out
     */
    const publishInstance = (properties, out)=>publish(CLSID_WBEM_LOCATOR, {
        interfaces: [describe(IID_IWBEM_CLASS_OBJECT, 'IWbemClassObject', SLOTS.object, {
            Get: ([name, , value, type, flavor])=>{
                const key = readString(name >>> 0);
                const property = properties[key.toLowerCase()];
                if (!property)
                {
                    diverge('IWbemClassObject::Get', `no value kept for ${key}; it reads as NULL`);
                    if ((value >>> 0) !== 0)
                    {
                        const variant = new Uint8Array(16);
                        new DataView(variant.buffer).setUint16(0, VT_NULL, true);
                        host.writeMemory(value >>> 0, variant);
                    }
                    if ((type >>> 0) !== 0)
                    {
                        writeU32(type >>> 0, CIM_STRING);
                    }
                    if ((flavor >>> 0) !== 0)
                    {
                        writeU32(flavor >>> 0, 0);
                    }
                    return S_OK;
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
                    else if (typeof content === 'boolean')
                    {
                        view.setUint16(0, VT_BOOL, true);
                        view.setUint16(8, content ? 0xffff : 0, true);
                    }
                    else if (Array.isArray(content))
                    {
                        const array = allocateArray(content);
                        if (array === 0)
                        {
                            return E_OUTOFMEMORY;
                        }
                        view.setUint16(0, VT_ARRAY | VT_I4, true);
                        view.setUint32(8, array, true);
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
     * @param {Record<string, WbemProperty>[]} instances
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
        const instances = CLASSES[name.toLowerCase()];
        if (!instances)
        {
            diverge(api, `class ${name} has no instances here; enumerated empty`);
            return [];
        }
        return instances;
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
