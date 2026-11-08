/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX 10: the helper library a Direct3D 10 program links as `d3dx10_NN.dll`.
 *
 * Its mathematics is D3DX 9's -- the same functions under the same names --
 * so those come from that table. What is its own is the image loaders, which
 * make a texture on the program's device through the device's own methods,
 * as D3DX itself does (`CreateTexture2D` with the levels as initial data),
 * and the shader compiler, which this build does not have: a compile is
 * refused with an error blob saying so, which is what a program that ships
 * its shaders compiled (and compiles only what its cache lacks) is told.
 */

import { createDeviceCalls } from '../d3dx9/device.js';
import { ImageError } from '../d3dx9/images.js';
import { NotRead, readImage10 } from './image10.js';
import { D3DX10_DEFAULT, planTexture } from './load.js';
import { DIMENSION } from './dds10.js';
import { createComObject } from '../ole32/objects.js';
import { createDataLoaders, publishBare } from './loaders.js';

const S_OK = 0;
const E_FAIL = 0x80004005;
const E_INVALIDARG = 0x80070057;
const E_NOTIMPL = 0x80004001;
const E_OUTOFMEMORY = 0x8007000e;
/** D3DX10_ERR_INVALID_DATA. */
const D3DX10_ERR_INVALID_DATA = 0x88760b59;

/** IID_ID3D10Blob, which is IID_ID3DXBuffer's number too. */
const IID_ID3D10BLOB = '{8BA5FB08-5195-40E2-AC58-0D989C3A0102}';

/** D3D10_SDK_VERSION, which D3DX10CheckVersion holds a program's to. */
const D3D10_SDK_VERSION = 29;

/**
 * ID3D10Device's methods used here, by vtable slot (d3d10.h; the device's
 * table is `graphics/d3d10/slots.js`): the creates the loaders call, and the
 * setters D3DX10UnsetAllDeviceObjects calls.
 */
const DEVICE = Object.freeze({ CreateTexture1D: 72, CreateTexture2D: 73, CreateTexture3D: 74,
    CreateShaderResourceView: 75,
    VSSetConstantBuffers: 3, PSSetShaderResources: 4, PSSetShader: 5, PSSetSamplers: 6,
    VSSetShader: 7, PSSetConstantBuffers: 10, IASetInputLayout: 11, IASetVertexBuffers: 12,
    IASetIndexBuffer: 13, GSSetConstantBuffers: 16, GSSetShader: 17, VSSetShaderResources: 19,
    VSSetSamplers: 20, GSSetShaderResources: 22, GSSetSamplers: 23, OMSetRenderTargets: 24,
    OMSetBlendState: 25, OMSetDepthStencilState: 26, SOSetTargets: 27, RSSetState: 29,
    SetPredication: 21,
});

/** Each shader stage's constant buffers, resources, samplers and shader. */
const STAGE_SLOTS = [
    [DEVICE.VSSetConstantBuffers, DEVICE.VSSetShaderResources, DEVICE.VSSetSamplers,
        DEVICE.VSSetShader],
    [DEVICE.PSSetConstantBuffers, DEVICE.PSSetShaderResources, DEVICE.PSSetSamplers,
        DEVICE.PSSetShader],
    [DEVICE.GSSetConstantBuffers, DEVICE.GSSetShaderResources, DEVICE.GSSetSamplers,
        DEVICE.GSSetShader],
];

/** D3D10's slot counts: the common shader's, the input assembler's, stream output's, the OM's. */
const CONSTANT_BUFFER_SLOTS = 14;
const RESOURCE_SLOTS = 128;
const SAMPLER_SLOTS = 16;
const VERTEX_BUFFER_SLOTS = 16;
const STREAM_OUTPUT_SLOTS = 4;
const RENDER_TARGET_SLOTS = 8;
const DXGI_FORMAT_R32_UINT = 42;

const UNKNOWN_RELEASE = 2;
/** RT_RCDATA: where D3DX looks for a resource it is named. */
const RT_RCDATA = 10;

/** D3D10_RESOURCE_MISC_TEXTURECUBE. */
const MISC_TEXTURECUBE = 0x4;
/** "DDS ", and the bytes of its headers with the DX10 one. */
const DDS_MAGIC = 0x20534444;
const DDS_HEADERS = 148;
/**
 * @typedef {Object} D3dx10Host
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} [readU32]
 * @property {(address: number, value: number) => void} [writeU32]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {{ publish: (object: any, interfaceId: string) => number,
 *     unpublish?: (object: any, interfaceId: string) => boolean }} [vtables]
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]
 * @property {() => any} [currentThread]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 * @property {() => Promise<number>} [compiler]
 *     Where this process's D3DCompile is (d3dcompiler_43's), or 0 for none.
 * @property {(module: number, name: string | number, type: number)
 *     => Uint8Array | null | Promise<Uint8Array | null>}
 *     [resource]  a module's resource, by name or number, and type
 */

/**
 * Which Direct3D a copy of the library works with: its functions' prefix, the
 * device's creates by vtable slot, and the SDK version it checks a program's
 * against. D3DX 10 and D3DX 11 are one library over two devices whose
 * texture descriptions, image information and load information are laid out
 * alike.
 *
 * @typedef {{ prefix: string, sdk: number, fileNotFound: number, device: {
 *     CreateTexture1D: number,
 *     CreateTexture2D: number, CreateTexture3D: number, CreateShaderResourceView: number } }}
 *     D3dxProfile
 */

/** D3DX 10, over ID3D10Device. @type {D3dxProfile} */
export const D3DX10_PROFILE = Object.freeze({ prefix: 'D3DX10', sdk: D3D10_SDK_VERSION,
    // D3D10_ERROR_FILE_NOT_FOUND.
    fileNotFound: 0x88790002 | 0,
    device: { CreateTexture1D: DEVICE.CreateTexture1D, CreateTexture2D: DEVICE.CreateTexture2D,
        CreateTexture3D: DEVICE.CreateTexture3D,
        CreateShaderResourceView: DEVICE.CreateShaderResourceView } });

/**
 * The library's own functions, with D3DX 9's mathematics laid under them by
 * the caller.
 *
 * @param {D3dx10Host} host
 * @param {number} version  the SDK version this copy of the library answers to
 * @param {D3dxProfile} [profile]  the Direct3D it works with: D3DX 10's by default
 */
export function createD3dx10Functions(host, version, profile = D3DX10_PROFILE){
    const { prefix } = profile;
    const { u32, putU32s, method, string } = createDeviceCalls(host);
    const blob = {
        id: IID_ID3D10BLOB,
        methods: [
            /** LPVOID GetBufferPointer() */
            { name: 'GetBufferPointer', argBytes: 4,
                invoke: (/** @type {any} */ object)=>object.state.data },
            /** SIZE_T GetBufferSize() */
            { name: 'GetBufferSize', argBytes: 4,
                invoke: (/** @type {any} */ object)=>object.state.size },
        ],
    };

    /**
     * An ID3D10Blob holding these bytes, its pointer written to `out`.
     *
     * @param {number} out @param {Uint8Array} bytes
     */
    const giveBlob = (out, bytes)=>{
        if (!host.heap || !host.vtables)
        {
            return E_OUTOFMEMORY;
        }
        const heap = host.heap;
        const data = heap.allocate(Math.max(bytes.length, 1));
        if (data === 0)
        {
            return E_OUTOFMEMORY;
        }
        host.writeMemory(data, bytes);
        const object = createComObject(IID_ID3D10BLOB, { interfaces: [blob],
            state: { data, size: bytes.length }, destroy: ()=>heap.free(data) });
        const pointer = host.vtables.publish(object, IID_ID3D10BLOB) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        putU32s(out, [pointer]);
        return S_OK;
    };

    /** @param {number} at @param {number} hr */
    const answer = (at, hr)=>{
        if ((at >>> 0) !== 0)
        {
            putU32s(at, [hr >>> 0]);
        }
        return hr;
    };

    /**
     * D3DX10_IMAGE_LOAD_INFO's fields, every one D3DX10_DEFAULT when the
     * program passes none, and pSrcInfo, where the file's information goes.
     *
     * @param {number} at
     * @returns {{ info: import('./load.js').LoadInfo, srcInfo: number }}
     */
    const loadInfoAt = at=>{
        if ((at >>> 0) === 0)
        {
            return { info: { width: D3DX10_DEFAULT, height: D3DX10_DEFAULT,
                depth: D3DX10_DEFAULT, firstMip: D3DX10_DEFAULT, mips: D3DX10_DEFAULT,
                usage: D3DX10_DEFAULT, bind: D3DX10_DEFAULT, cpu: D3DX10_DEFAULT,
                misc: D3DX10_DEFAULT, format: D3DX10_DEFAULT, filter: D3DX10_DEFAULT,
                mipFilter: D3DX10_DEFAULT }, srcInfo: 0 };
        }
        const [width, height, depth, firstMip, mips, usage, bind, cpu, misc, format, filter,
            mipFilter, srcInfo] = Array.from({ length: 13 }, (_, i)=>u32(at + i * 4));
        return { info: { width, height, depth, firstMip, mips, usage, bind, cpu, misc, format,
            filter, mipFilter }, srcInfo };
    };

    /**
     * The file's image as D3DX 10 reads it, or the HRESULT a program gets for
     * one it cannot read: E_FAIL, said where Windows would have read it.
     *
     * @param {string} api @param {Uint8Array} bytes @param {boolean} headerOnly
     * @returns {import('./dds10.js').DxgiImage | number}
     */
    const imageOf = (api, bytes, headerOnly)=>{
        try
        {
            return readImage10(bytes, { bc6and7: profile.prefix === 'D3DX11', headerOnly });
        }
        catch (e){
            if (e instanceof NotRead)
            {
                host.divergence?.(api, `answered E_FAIL: ${e.message}`);
            }
            if (e instanceof ImageError)
            {
                return E_FAIL;
            }
            throw e;
        }
    };

    /**
     * A planned texture made on the device: its description and its levels'
     * bytes as initial data, given to the device's own create.
     *
     * @param {number} device @param {import('./load.js').Plan} plan
     * @param {number} out  where the resource's pointer goes
     * @param {any} thread
     * @returns {Promise<number>}
     */
    const create = async(device, plan, out, thread)=>{
        const heap = /** @type {NonNullable<D3dx10Host['heap']>} */ (host.heap);
        const { subresources } = plan;
        const total = subresources.reduce((sum, { data })=>sum + data.length, 0);
        const descBytes = 0x2c;
        const dataBytes = subresources.length * 12;
        const block = heap.allocate(descBytes + dataBytes + total);
        if (block === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            const { width, height, depth, mips, arraySize, format, usage, bind, cpu, misc } = plan;
            putU32s(block, plan.dimension === DIMENSION.TEXTURE3D
                ? [width, height, depth, mips, format, usage, bind, cpu, misc]
                : plan.dimension === DIMENSION.TEXTURE1D
                    ? [width, mips, arraySize, format, usage, bind, cpu, misc]
                    : [width, height, mips, arraySize, format, 1, 0, usage, bind, cpu, misc]);
            let at = block + descBytes + dataBytes;
            /** @type {number[]} */
            const records = [];
            for (const { data, pitch, slice } of subresources)
            {
                host.writeMemory(at, data);
                records.push(at, pitch, slice);
                at += data.length;
            }
            putU32s(block + descBytes, records);
            return await method(thread, device,
                plan.dimension === DIMENSION.TEXTURE3D ? profile.device.CreateTexture3D
                    : plan.dimension === DIMENSION.TEXTURE1D ? profile.device.CreateTexture1D
                        : profile.device.CreateTexture2D,
                [block, block + descBytes, out]);
        }
        finally
        {
            heap.free(block);
        }
    };

    /**
     * D3DX10_IMAGE_INFO, as a file says it: Width, Height, Depth, ArraySize,
     * MipLevels, MiscFlags (only the cube flag), Format, ResourceDimension,
     * ImageFileFormat.
     *
     * @param {number} at @param {import('./dds10.js').DxgiImage} image
     */
    const writeInfo = (at, image)=>{
        putU32s(at, [image.width, image.height, image.depth ?? 1, image.arraySize,
            image.mipLevels, image.cube ? MISC_TEXTURECUBE : 0, image.dxgi, image.dimension,
            image.fileFormat]);
    };

    /**
     * Where a call's file comes from, as D3DX's loaders take it: an argument
     * the loader cannot be made of is answered at once (`early`, pHResult
     * left as it is), a file the loader then fails to read is answered as
     * the load's result (`hr`, pHResult written too).
     *
     * @typedef {{ bytes: Uint8Array } | { early: number } | { hr: number }} Found
     */

    /**
     * The program's bytes; with `headerOnly`, a DDS file's headers alone, as
     * D3DX reads no further for its information (the size a program gives is
     * not checked against the texels).
     *
     * @param {number} data @param {number} size @param {boolean} [headerOnly]
     * @returns {Found}
     */
    const fromMemory = (data, size, headerOnly = false)=>{
        if (data === 0)
        {
            return { early: E_FAIL };
        }
        if (size < 4 || u32(data) !== DDS_MAGIC)
        {
            return { bytes: host.readMemory(data, size).slice() };
        }
        const headers = host.readMemory(data, Math.min(size, DDS_HEADERS)).slice();
        if (headerOnly)
        {
            return { bytes: headers };
        }
        // A DDS file is read to where its texels end, as D3DX reads it: a program
        // may say it is longer than it is.
        let extent = size;
        try
        {
            extent = Math.min(size, readImage10(headers, { headerOnly: true,
                bc6and7: true }).extent ?? size);
        }
        catch (e){
            if (!(e instanceof ImageError))
            {
                throw e;
            }
        }
        return { bytes: host.readMemory(data, extent).slice() };
    };

    /** @param {number} at @param {boolean} wide @returns {Promise<Found>} */
    const fromFile = async(at, wide)=>{
        if (at === 0)
        {
            return { early: E_FAIL };
        }
        const bytes = host.readFile ? await host.readFile(string(at, wide, 260)) : null;
        return bytes ? { bytes } : { hr: profile.fileNotFound };
    };
    /**
     * A module's resource, as D3DX finds one: RT_RCDATA by name or number.
     *
     * @param {number} module @param {number} at @param {boolean} wide
     * @returns {Promise<Found>}
     */
    const fromResource = async(module, at, wide)=>{
        const name = at === 0 ? null : at < 0x10000 ? at : string(at, wide, 256);
        const bytes = name === null ? null : await host.resource?.(module, name, RT_RCDATA) ?? null;
        return bytes ? { bytes } : { early: D3DX10_ERR_INVALID_DATA };
    };

    /**
     * Where a call's file is, for a loader object a thread pump is handed:
     * the loader's creating function and its arguments.
     *
     * @typedef {{ kind: 'Memory', args: number[] } | { kind: 'File' | 'Resource',
     *     wide: boolean, args: number[] }} Source
     */

    /** @type {Record<string, any>} */
    const loaders = createDataLoaders(host, { prefix, fileNotFound: profile.fileNotFound,
        string });

    /** @param {Source} source @param {boolean} [headerOnly] @returns {Promise<Found>} */
    const found = (source, headerOnly)=>(source.kind === 'Memory' ? Promise.resolve(fromMemory(
        source.args[0], source.args[1], headerOnly))
        : source.kind === 'File' ? fromFile(source.args[0], source.wide)
            : fromResource(source.args[0], source.args[1], source.wide));

    /**
     * The work handed to a thread pump, as D3DX hands it: a loader of the
     * source and a processor, given to the pump's AddWorkItem with where the
     * result and the object go; the pump's answer is the call's.
     *
     * @param {any} thread @param {number} pump @param {Source} source
     * @param {(out: number) => number} makeProcessor
     * @param {number} hr @param {number} out
     */
    const pumped = async(thread, pump, source, makeProcessor, hr, out)=>{
        const heap = /** @type {NonNullable<D3dx10Host['heap']>} */ (host.heap);
        const pair = heap.allocate(8);
        if (pair === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            const name = `${prefix}CreateAsync${source.kind}Loader`
                + `${source.kind === 'Memory' ? '' : source.wide ? 'W' : 'A'}`;
            const made = await loaders[name].handler([...source.args, pair]) | 0;
            if (made !== S_OK)
            {
                return made;
            }
            const processor = makeProcessor(pair + 4) | 0;
            if (processor !== S_OK)
            {
                return processor;
            }
            // ID3DX10ThreadPump::AddWorkItem(loader, processor, pHResult, ppDeviceObject).
            return await method(thread, pump, 3, [u32(pair), u32(pair + 4), hr, out]);
        }
        finally
        {
            heap.free(pair);
        }
    };

    const PROCESSOR_ID = 'ID3DXDataProcessor';

    /**
     * A data processor published (ID3DX10DataProcessor, not COM): Process
     * reads the file's bytes, CreateDeviceObject makes its object of them.
     *
     * @param {(bytes: Uint8Array) => number} process
     * @param {(object: number, thread: any) => number | Promise<number>} makeObject
     * @param {number} out
     */
    const publishProcessor = (process, makeObject, out)=>{
        const pointer = publishBare(host, PROCESSOR_ID, [
            /** HRESULT Process(void *pData, SIZE_T cBytes) */
            { name: 'Process', argBytes: 12, invoke: (_self, [data, size])=>
                ((data >>> 0) === 0 || (size >>> 0) === 0 ? E_FAIL
                    : process(host.readMemory(data >>> 0, size >>> 0).slice())) },
            /** HRESULT CreateDeviceObject(void **ppDataObject) */
            { name: 'CreateDeviceObject', argBytes: 8, invoke: (_self, [object])=>
                makeObject(object >>> 0, host.currentThread?.()) },
        ], ()=>{});
        if (pointer === 0)
        {
            return E_OUTOFMEMORY;
        }
        putU32s(out, [pointer]);
        return S_OK;
    };

    /**
     * The texture (or with `view`, a shader-resource view of it) made of an
     * image, its pointer written to `out`.
     *
     * @param {string} api @param {number} device @param {boolean} view
     * @param {import('./dds10.js').DxgiImage} image
     * @param {{ info: import('./load.js').LoadInfo, srcInfo: number }} load
     * @param {number} out @param {any} thread
     */
    const deviceObject = async(api, device, view, image, load, out, thread)=>{
        const plan = planTexture(image, load.info, detail=>host.divergence?.(api, detail));
        return 'hr' in plan ? plan.hr : planned(device, view, plan, out, thread);
    };

    /**
     * The texture (or with `view`, a shader-resource view of it) made of a
     * plan, its pointer written to `out`.
     *
     * @param {number} device @param {boolean} view @param {import('./load.js').Plan} plan
     * @param {number} out @param {any} thread
     */
    const planned = async(device, view, plan, out, thread)=>{
        const heap = /** @type {NonNullable<D3dx10Host['heap']>} */ (host.heap);
        const held = view ? heap.allocate(4) : out;
        if (held === 0)
        {
            return E_OUTOFMEMORY;
        }
        try
        {
            let result = await create(device, plan, held, thread);
            if (view && result === S_OK)
            {
                const texture = u32(held);
                result = await method(thread, device, profile.device.CreateShaderResourceView,
                    [texture, 0, out]);
                await method(thread, texture, UNKNOWN_RELEASE, []);
            }
            return result;
        }
        finally
        {
            if (view)
            {
                heap.free(held);
            }
        }
    };

    /**
     * A processor making a texture (or view) of the bytes it is given, with
     * the load information it was made with.
     *
     * @param {string} api @param {number} device @param {boolean} view
     * @param {{ info: import('./load.js').LoadInfo, srcInfo: number }} load
     * @param {number} out
     */
    const textureProcessor = (api, device, view, load, out)=>{
        /** @type {import('./load.js').Plan | null} */
        let plan = null;
        return publishProcessor(bytes=>{
            const image = imageOf(api, bytes, false);
            if (typeof image === 'number')
            {
                return image;
            }
            if (load.srcInfo !== 0)
            {
                writeInfo(load.srcInfo, image);
            }
            // The load information is checked as the file is processed; the
            // device checks the rest when the texture is made.
            const made = planTexture(image, load.info, detail=>host.divergence?.(api, detail));
            if ('hr' in made)
            {
                return made.hr;
            }
            plan = made;
            return S_OK;
        }, (object, thread)=>(!plan || object === 0 ? E_FAIL
            : planned(device, view, plan, object, thread)), out);
    };

    /**
     * A texture-creating call: the device and out-pointer checked, the source
     * found, the image read and the texture (or view) made; or all of it
     * handed to the thread pump the program passes.
     *
     * @param {string} api @param {boolean} view
     * @param {(args: number[]) => { device: number, source: Source, info: number, pump: number,
     *     out: number, hr: number }} parse
     */
    const loader = (api, view, parse)=>async(/** @type {number[]} */ args)=>{
        const { device, source, info, pump, out, hr } = parse(args.map(a=>a >>> 0));
        if (device === 0 || out === 0 || !host.callGuest || !host.heap)
        {
            return E_INVALIDARG;
        }
        const thread = host.currentThread?.();
        const load = loadInfoAt(info);
        if (pump !== 0)
        {
            return pumped(thread, pump, source,
                at=>textureProcessor(api, device, view, load, at), hr, out);
        }
        const file = await found(source);
        if ('early' in file)
        {
            return file.early;
        }
        if ('hr' in file)
        {
            return answer(hr, file.hr);
        }
        const image = imageOf(api, file.bytes, false);
        if (typeof image === 'number')
        {
            return answer(hr, image);
        }
        if (load.srcInfo !== 0)
        {
            writeInfo(load.srcInfo, image);
        }
        return answer(hr, await deviceObject(api, device, view, image, load, out, thread));
    };

    /**
     * An image's information, read from the header alone where the file is a
     * DDS; or the work handed to the thread pump the program passes.
     *
     * @param {string} api @param {Source} source @param {number} pump
     * @param {number} infoAt @param {number} hr
     */
    const imageInfo = async(api, source, pump, infoAt, hr)=>{
        if (pump !== 0 && host.callGuest && host.heap)
        {
            return pumped(host.currentThread?.(), pump, source, at=>infoProcessor(api, infoAt, at),
                hr, 0);
        }
        const file = await found(source, true);
        if ('early' in file)
        {
            return file.early;
        }
        if ('hr' in file)
        {
            return answer(hr, file.hr);
        }
        const image = imageOf(api, file.bytes, true);
        if (typeof image === 'number')
        {
            return answer(hr, image);
        }
        if (infoAt !== 0)
        {
            writeInfo(infoAt, image);
        }
        return answer(hr, S_OK);
    };

    /**
     * A processor writing the information of the bytes it is given; it makes
     * no device object.
     *
     * @param {string} api @param {number} infoAt @param {number} out
     */
    const infoProcessor = (api, infoAt, out)=>publishProcessor(bytes=>{
        const image = imageOf(api, bytes, true);
        if (typeof image === 'number')
        {
            return image;
        }
        if (infoAt !== 0)
        {
            writeInfo(infoAt, image);
        }
        return S_OK;
    }, ()=>S_OK, out);

    /**
     * The include a compile from a file is given when the program gives none:
     * every #include read from the directory of the file compiled, whichever
     * file names it, as D3DX resolves them. An ID3DInclude published for the
     * compile and given back after it.
     *
     * @param {string} source  the compiled file's path
     * @returns {{ pointer: number, end: () => void } | null}
     */
    const fileInclude = source=>{
        if (!host.vtables || !host.heap)
        {
            return null;
        }
        const heap = host.heap;
        const cut = source.lastIndexOf('\\');
        const directory = cut < 0 ? '' : source.slice(0, cut + 1);
        /** @type {Set<number>} */
        const held = new Set();
        /**
         * @param {any} _self
         * @param {number[]} args
         */
        const open = async(_self, [, nameAt, , dataOut, bytesOut])=>{
            const file = string(nameAt >>> 0, false, 260);
            const path = /^([A-Za-z]:)?\\/.test(file) ? file : `${directory}${file}`;
            const bytes = host.readFile ? await host.readFile(path) : null;
            if (!bytes)
            {
                return E_FAIL;
            }
            const at = heap.allocate(Math.max(1, bytes.length));
            if (!at)
            {
                return E_OUTOFMEMORY;
            }
            host.writeMemory(at, bytes);
            held.add(at);
            putU32s(dataOut >>> 0, [at]);
            putU32s(bytesOut >>> 0, [bytes.length]);
            return S_OK;
        };
        /**
         * @param {any} _self
         * @param {number[]} args
         */
        const close = (_self, [data])=>{
            if (held.delete(data >>> 0))
            {
                heap.free(data >>> 0);
            }
            return S_OK;
        };
        /** @type {any} */
        const object = { interfaceFor: (/** @type {string} */ id)=>(id === 'ID3DInclude'
            ? record : null) };
        const record = Object.freeze({ object, id: 'ID3DInclude', methods: [
            /**
             * HRESULT Open(D3D_INCLUDE_TYPE, LPCSTR pFileName, LPCVOID pParentData,
             *     LPCVOID *ppData, UINT *pBytes)
             */
            { name: 'Open', argBytes: 24, invoke: open },
            /** HRESULT Close(LPCVOID pData) */
            { name: 'Close', argBytes: 8, invoke: close },
        ] });
        const pointer = host.vtables.publish(object, 'ID3DInclude') >>> 0;
        return pointer === 0 ? null : { pointer, end: ()=>{
            held.forEach(at=>heap.free(at));
            held.clear();
            host.vtables?.unpublish?.(object, 'ID3DInclude');
        } };
    };

    /**
     * Refused, saying why: what this build has no counterpart of.
     *
     * @param {string} api @param {number} argBytes @param {string} why
     * @param {number} [hrAt]  which argument is the HRESULT out-pointer
     */
    const refused = (api, argBytes, why, hrAt = -1)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            host.divergence?.(api, why);
            return hrAt >= 0 ? answer(args[hrAt], E_NOTIMPL) : E_NOTIMPL;
        },
    });

    /**
     * HRESULT D3DX10CompileFromMemory(LPCSTR pSrcData, SIZE_T SrcDataLen, LPCSTR pFileName,
     *     const D3D10_SHADER_MACRO*, LPD3D10INCLUDE, LPCSTR pFunctionName, LPCSTR pProfile,
     *     UINT Flags1, UINT Flags2, ID3DX10ThreadPump*, ID3D10Blob **ppShader,
     *     ID3D10Blob **ppErrorMsgs, HRESULT *pHResult)
     *
     * D3DCompile's work, as the library hands it to d3dcompiler_43: the source,
     * its name, defines, include handler, entry point, profile and flags, the
     * code and the messages. Asked of the D3DCompile this process finds, so the
     * compiler is whichever the process has. With none to ask, the program is
     * told the compile failed, with the reason in its error blob. A thread pump
     * is not used: the compile is done by the time the call returns, its answer
     * in pHResult as well.
     */
    const compile = async(/** @type {number[]} */ args)=>{
        const thread = host.currentThread?.();
        const [data, size, file, defines, include, entryAt, profileAt, flags1, flags2, ,
            shaderOut, errorsOut, hrAt] = args.map(a=>a >>> 0);
        const compiler = host.callGuest ? await host.compiler?.() ?? 0 : 0;
        if (compiler !== 0 && host.callGuest)
        {
            const hr = await host.callGuest({ entry: compiler,
                args: [data, size, file, defines, include, entryAt, profileAt, flags1, flags2,
                    shaderOut, errorsOut], ...(thread === undefined ? {} : { thread }) });
            return answer(hrAt, hr | 0);
        }
        const entry = entryAt === 0 ? '' : string(entryAt, false, 256);
        const target = profileAt === 0 ? '' : string(profileAt, false, 32);
        const reason = 'error X0000: this build has no HLSL compiler for'
            + ` ${target || 'this profile'} (${entry || 'no entry point'})`;
        host.divergence?.(`${prefix}CompileFromMemory`, `refused ${profile} ${entry}: no shader`
            + ' model 4 compiler');
        if (shaderOut !== 0)
        {
            putU32s(shaderOut, [0]);
        }
        if (errorsOut !== 0)
        {
            putU32s(errorsOut, [0]);
            giveBlob(errorsOut, Uint8Array.from([...reason, '\0'], c=>c.charCodeAt(0) & 0xff));
        }
        return answer(hrAt, E_FAIL);
    };

    return {
        ...loaders,
        /** BOOL D3DX10CheckVersion(UINT D3DSdkVersion, UINT D3DX10SdkVersion) */
        [`${prefix}CheckVersion`]: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([d3d, d3dx])=>((d3d >>> 0) === profile.sdk && (d3dx >>> 0) === version
                ? 1 : 0),
        },
        /**
         * HRESULT D3DX10CreateTextureFromMemory(ID3D10Device*, LPCVOID pSrcData,
         *     SIZE_T SrcDataSize, D3DX10_IMAGE_LOAD_INFO*, ID3DX10ThreadPump*,
         *     ID3D10Resource **ppTexture, HRESULT *pHResult), and the
         * shader-resource view made of one
         */
        ...Object.fromEntries([false, true].map(view=>{
            const api = `${prefix}Create${view ? 'ShaderResourceView' : 'Texture'}FromMemory`;
            return [api, { argBytes: 28, handler: loader(api, view,
                ([device, data, size, info, pump, out, hr])=>({ device,
                    source: { kind: 'Memory', args: [data, size] }, info, pump, out, hr })) }];
        })),
        /** The same, the image from a file: (device, file, info, pump, ppTexture, pHResult) */
        ...Object.fromEntries([false, true].flatMap(wide=>[false, true].map(view=>{
            const api = `${prefix}Create${view ? 'ShaderResourceView' : 'Texture'}FromFile`
                + `${wide ? 'W' : 'A'}`;
            return [api, { argBytes: 24, handler: loader(api, view,
                ([device, file, info, pump, out, hr])=>({ device,
                    source: { kind: 'File', wide, args: [file] }, info, pump, out, hr })) }];
        }))),
        /**
         * HRESULT D3DX10CreateTextureFromResource(device, HMODULE, LPCTSTR,
         *     D3DX10_IMAGE_LOAD_INFO*, ID3DX10ThreadPump*, ID3D10Resource**, HRESULT*),
         * and the shader-resource views made of one.
         */
        ...Object.fromEntries([false, true].flatMap(wide=>[false, true].map(view=>{
            const api = `${prefix}Create${view ? 'ShaderResourceView' : 'Texture'}FromResource`
                + `${wide ? 'W' : 'A'}`;
            return [api, { argBytes: 28, handler: loader(api, view,
                ([device, module, name, info, pump, out, hr])=>({ device,
                    source: { kind: 'Resource', wide, args: [module, name] }, info, pump, out,
                    hr })) }];
        }))),
        /**
         * HRESULT D3DX10GetImageInfoFromMemory(LPCVOID pSrcData, SIZE_T SrcDataSize,
         *     ID3DX10ThreadPump*, D3DX10_IMAGE_INFO*, HRESULT *pHResult)
         */
        [`${prefix}GetImageInfoFromMemory`]: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([data, size, pump, infoAt, hr])=>imageInfo(
                `${prefix}GetImageInfoFromMemory`, { kind: 'Memory', args: [data >>> 0,
                    size >>> 0] }, pump >>> 0, infoAt >>> 0, hr >>> 0),
        },
        /**
         * HRESULT D3DX10GetImageInfoFromFile(LPCTSTR pSrcFile, ID3DX10ThreadPump*,
         *     D3DX10_IMAGE_INFO *pSrcInfo, HRESULT *pHResult)
         */
        ...Object.fromEntries([false, true].map(wide=>{
            const api = `${prefix}GetImageInfoFromFile${wide ? 'W' : 'A'}`;
            return [api, { argBytes: 16, handler: (/** @type {number[]} */ [file, pump,
                infoAt, hr])=>imageInfo(api, { kind: 'File', wide, args: [file >>> 0] },
                pump >>> 0, infoAt >>> 0, hr >>> 0) }];
        })),
        /**
         * HRESULT D3DX10GetImageInfoFromResource(HMODULE, LPCTSTR pSrcResource,
         *     ID3DX10ThreadPump*, D3DX10_IMAGE_INFO*, HRESULT*)
         */
        ...Object.fromEntries([false, true].map(wide=>{
            const api = `${prefix}GetImageInfoFromResource${wide ? 'W' : 'A'}`;
            return [api, { argBytes: 20, handler: (/** @type {number[]} */ [module, name, pump,
                infoAt, hr])=>imageInfo(api, { kind: 'Resource', wide, args: [module >>> 0,
                name >>> 0] }, pump >>> 0, infoAt >>> 0, hr >>> 0) }];
        })),
        /**
         * HRESULT D3DX10CreateAsyncTextureInfoProcessor(D3DX10_IMAGE_INFO*,
         *     ID3DX10DataProcessor **ppDataProcessor)
         */
        [`${prefix}CreateAsyncTextureInfoProcessor`]: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([infoAt, out])=>((out >>> 0) === 0 ? E_INVALIDARG
                : infoProcessor(`${prefix}CreateAsyncTextureInfoProcessor`, infoAt >>> 0,
                    out >>> 0)),
        },
        /**
         * HRESULT D3DX10CreateAsyncTextureProcessor(ID3D10Device*, D3DX10_IMAGE_LOAD_INFO*,
         *     ID3DX10DataProcessor**), and the one that makes a shader-resource view
         */
        ...Object.fromEntries([false, true].map(view=>{
            const api = `${prefix}CreateAsync${view ? 'ShaderResourceView' : 'Texture'}Processor`;
            return [api, { argBytes: 12, handler: (/** @type {number[]} */ [device, info, out])=>
                ((device >>> 0) === 0 || (out >>> 0) === 0 || !host.heap ? E_INVALIDARG
                    : textureProcessor(api, device >>> 0, view, loadInfoAt(info >>> 0),
                        out >>> 0)) }];
        })),
        [`${prefix}CompileFromMemory`]: { argBytes: 52, handler: compile },
        /**
         * HRESULT D3DX10CompileFromFile(LPCTSTR pSrcFile, const D3D10_SHADER_MACRO*,
         *     LPD3D10INCLUDE, LPCSTR pFunctionName, LPCSTR pProfile, UINT Flags1, UINT Flags2,
         *     ID3DX10ThreadPump*, ID3D10Blob **ppShader, ID3D10Blob **ppErrorMsgs,
         *     HRESULT *pHResult)
         *
         * The file read and compiled as CompileFromMemory compiles its bytes, the
         * file's own name the source's; a file that is not there is
         * D3D10_ERROR_FILE_NOT_FOUND.
         */
        ...Object.fromEntries([false, true].map(wide=>{
            const api = `${prefix}CompileFromFile${wide ? 'W' : 'A'}`;
            return [api, { argBytes: 44, handler: async(/** @type {number[]} */ args)=>{
                const [file, defines, include, entry, target, flags1, flags2, pump, shaderOut,
                    errorsOut, hrAt] = args.map(a=>a >>> 0);
                if (shaderOut !== 0)
                {
                    putU32s(shaderOut, [0]);
                }
                if (errorsOut !== 0)
                {
                    putU32s(errorsOut, [0]);
                }
                const path = file === 0 ? '' : string(file, wide, 260);
                const bytes = file === 0 || !host.readFile ? null : await host.readFile(path);
                if (!bytes)
                {
                    return answer(hrAt, profile.fileNotFound);
                }
                const heap = host.heap;
                const source = heap?.allocate(bytes.length + 1) ?? 0;
                const name = heap?.allocate(path.length + 1) ?? 0;
                if (!heap || source === 0 || name === 0)
                {
                    return answer(hrAt, E_OUTOFMEMORY);
                }
                const files = include === 0 ? fileInclude(path) : null;
                try
                {
                    host.writeMemory(source, bytes);
                    host.writeMemory(name, Uint8Array.from([...path, '\0'],
                        c=>c.charCodeAt(0) & 0xff));
                    return await compile([source, bytes.length, name, defines,
                        files ? files.pointer : include, entry, target, flags1, flags2, pump,
                        shaderOut, errorsOut, hrAt]);
                }
                finally
                {
                    heap.free(source);
                    heap.free(name);
                    files?.end();
                }
            } }];
        })),
        /**
         * HRESULT D3DX10UnsetAllDeviceObjects(ID3D10Device *pDevice)
         *
         * Every object bound to the device unbound, through the device's own
         * methods (ID3D10Device's slots): each stage's constant buffers,
         * resources, samplers and shader, the input assembler's buffers and
         * layout, the stream-output targets, the render targets, the output
         * and rasterizer states and the predicate; each left as Windows leaves
         * it (Wine's d3dx10 test): an index format of R32_UINT, a sample mask
         * of 0, stream-output offsets of -1.
         */
        [`${prefix}UnsetAllDeviceObjects`]: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([device])=>{
                if ((device >>> 0) === 0 || !host.callGuest || !host.heap)
                {
                    return E_INVALIDARG;
                }
                const thread = host.currentThread?.();
                const nulls = host.heap.allocate(RESOURCE_SLOTS * 4 + STREAM_OUTPUT_SLOTS * 4);
                if (nulls === 0)
                {
                    return E_OUTOFMEMORY;
                }
                host.writeMemory(nulls, new Uint8Array(RESOURCE_SLOTS * 4));
                // Stream output's offsets: -1, append, as a target unbound reads.
                const appended = nulls + RESOURCE_SLOTS * 4;
                host.writeMemory(appended, new Uint8Array(STREAM_OUTPUT_SLOTS * 4).fill(0xff));
                /** @param {number} slot @param {number[]} rest */
                const call = (slot, ...rest)=>method(thread, device, slot, rest);
                try
                {
                    for (const [buffers, views, samplers, shader] of STAGE_SLOTS)
                    {
                        await call(buffers, 0, CONSTANT_BUFFER_SLOTS, nulls);
                        await call(views, 0, RESOURCE_SLOTS, nulls);
                        await call(samplers, 0, SAMPLER_SLOTS, nulls);
                        await call(shader, 0);
                    }
                    await call(DEVICE.IASetVertexBuffers, 0, VERTEX_BUFFER_SLOTS, nulls, nulls,
                        nulls);
                    await call(DEVICE.IASetIndexBuffer, 0, DXGI_FORMAT_R32_UINT, 0);
                    await call(DEVICE.IASetInputLayout, 0);
                    await call(DEVICE.SOSetTargets, STREAM_OUTPUT_SLOTS, nulls, appended);
                    await call(DEVICE.OMSetRenderTargets, RENDER_TARGET_SLOTS, nulls, 0);
                    // A blend factor of zeros, and a sample mask of none.
                    await call(DEVICE.OMSetBlendState, 0, nulls, 0);
                    await call(DEVICE.OMSetDepthStencilState, 0, 0);
                    await call(DEVICE.RSSetState, 0);
                    await call(DEVICE.SetPredication, 0, 0);
                    return S_OK;
                }
                finally
                {
                    host.heap.free(nulls);
                }
            },
        },
        /**
         * HRESULT D3DX10FilterTexture(ID3D10Resource *pTexture, UINT SrcLevel, UINT MipFilter)
         *
         * The levels below SrcLevel remade from it. The texture's levels are as
         * the loader made them - a loaded file comes with its chain - so they
         * are left as they are, and said.
         */
        [`${prefix}FilterTexture`]: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([texture])=>{
                if ((texture >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.divergence?.(`${prefix}FilterTexture`,
                    'the texture\'s levels are kept as loaded, not filtered again');
                return S_OK;
            },
        },
        /**
         * HRESULT D3DX10SaveTextureToFileA(ID3D10Resource*, D3DX10_IMAGE_FILE_FORMAT, LPCSTR):
         * refused; the texture's bytes are the GPU's and no read-back is made for it.
         */
        [`${prefix}SaveTextureToFileA`]: refused(`${prefix}SaveTextureToFileA`, 12,
            'refused: saving a Direct3D 10 texture to a file is not implemented'),
        [`${prefix}SaveTextureToFileW`]: refused(`${prefix}SaveTextureToFileW`, 12,
            'refused: saving a Direct3D 10 texture to a file is not implemented'),
    };
}
