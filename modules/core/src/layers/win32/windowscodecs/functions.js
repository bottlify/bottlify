/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * windowscodecs.dll: the Windows Imaging Component's exports and COM classes.
 * WICCreateImagingFactory_Proxy and CoCreateInstance of CLSID_WICImagingFactory
 * give the factory (objects.js); WICConvertBitmapSource and
 * WICCreateBitmapFromSection(Ex) are its helpers; every `<Interface>_<Method>_Proxy`
 * export calls that method of the object it is handed - the call .NET's
 * PresentationCore makes for every WIC method - straight into our object when
 * it is ours, through its vtable when the program implemented it.
 */

import { createCodecs } from './objects.js';
import { flatten } from './kit.js';
import { INTERFACES } from './layout.js';

const E_NOTIMPL = 0x80004001 | 0;
const S_FALSE = 1;

/**
 * The proxy exports windowscodecs.dll has, by interface and method; the
 * export is `${interface}_${method}_Proxy` (GetDataPointer's is
 * `IWICBitmapLock_GetDataPointer_STA_Proxy`).
 */
const PROXIES = Object.freeze({
    IWICBitmapClipper: ['Initialize'],
    IWICBitmapCodecInfo: ['DoesSupportAnimation', 'DoesSupportLossless', 'DoesSupportMultiframe',
        'GetContainerFormat', 'GetDeviceManufacturer', 'GetDeviceModels', 'GetFileExtensions',
        'GetMimeTypes'],
    IWICBitmapDecoder: ['CopyPalette', 'GetColorContexts', 'GetDecoderInfo', 'GetFrameCount',
        'GetFrame', 'GetMetadataQueryReader', 'GetPreview', 'GetThumbnail'],
    IWICBitmapEncoder: ['Commit', 'CreateNewFrame', 'GetEncoderInfo', 'GetMetadataQueryWriter',
        'Initialize', 'SetPalette', 'SetThumbnail'],
    IWICBitmapFlipRotator: ['Initialize'],
    IWICBitmapFrameDecode: ['GetColorContexts', 'GetMetadataQueryReader', 'GetThumbnail'],
    IWICBitmapFrameEncode: ['Commit', 'GetMetadataQueryWriter', 'Initialize', 'SetColorContexts',
        'SetResolution', 'SetSize', 'SetThumbnail', 'WriteSource'],
    IWICBitmapLock: ['GetDataPointer', 'GetStride'],
    IWICBitmapScaler: ['Initialize'],
    IWICBitmapSource: ['CopyPalette', 'CopyPixels', 'GetPixelFormat', 'GetResolution', 'GetSize'],
    IWICBitmap: ['Lock', 'SetPalette', 'SetResolution'],
    IWICColorContext: ['InitializeFromMemory'],
    IWICComponentFactory: ['CreateMetadataWriterFromReader', 'CreateQueryWriterFromBlockWriter'],
    IWICComponentInfo: ['GetAuthor', 'GetCLSID', 'GetFriendlyName', 'GetSpecVersion', 'GetVersion'],
    IWICFormatConverter: ['Initialize'],
    IWICImagingFactory: ['CreateBitmapClipper', 'CreateBitmapFlipRotator',
        'CreateBitmapFromHBITMAP', 'CreateBitmapFromHICON', 'CreateBitmapFromMemory',
        'CreateBitmapFromSource', 'CreateBitmapScaler', 'CreateBitmap', 'CreateComponentInfo',
        'CreateDecoderFromFileHandle', 'CreateDecoderFromFilename', 'CreateDecoderFromStream',
        'CreateEncoder', 'CreateFastMetadataEncoderFromDecoder',
        'CreateFastMetadataEncoderFromFrameDecode', 'CreateFormatConverter', 'CreatePalette',
        'CreateQueryWriterFromReader', 'CreateQueryWriter', 'CreateStream'],
    IWICMetadataQueryReader: ['GetContainerFormat', 'GetEnumerator', 'GetLocation',
        'GetMetadataByName'],
    IWICPalette: ['GetColorCount', 'GetColors', 'GetType', 'HasAlpha', 'InitializeCustom',
        'InitializeFromBitmap', 'InitializeFromPalette', 'InitializePredefined'],
    IWICPixelFormatInfo: ['GetBitsPerPixel', 'GetChannelCount', 'GetChannelMask'],
    IWICStream: ['InitializeFromIStream', 'InitializeFromMemory'],
});

/**
 * Proxies of interfaces wincodecsdk.h declares and this build makes no object
 * of: the program's own objects, reached by slot (IUnknown's three first).
 */
const FOREIGN = Object.freeze({
    IWICFastMetadataEncoder_Commit: [3, 4],
    IWICFastMetadataEncoder_GetMetadataQueryWriter: [4, 8],
    IWICMetadataBlockReader_GetCount: [4, 8],
    IWICMetadataBlockReader_GetReaderByIndex: [5, 12],
    IWICMetadataQueryWriter_SetMetadataByName: [7, 12],
    IWICMetadataQueryWriter_RemoveMetadataByName: [8, 8],
    IPropertyBag2_Write: [4, 16],
});

/**
 * @typedef {Object} ExportHost
 * @property {(name: string) => { handler: (args: number[]) => any } | undefined} gdi32
 * @property {(name: string) => { handler: (args: number[]) => any } | undefined} user32
 */

/**
 * An HBITMAP's and an HICON's pixels through gdi32's and user32's own calls:
 * GetObject for the size, GetDIBits into a top-down 32-bit DIB, GetIconInfo
 * for an icon's colour and mask bitmaps.
 *
 * @param {import('./kit.js').CodecsHost} host @param {ExportHost} system
 */
export function gdiPixels(host, system){
    /** @param {'gdi32' | 'user32'} library @param {string} name @param {number[]} args */
    const call = (library, name, args)=>{
        const fn = system[library](name);
        return fn ? fn.handler(args) | 0 : 0;
    };
    /** @param {number} at @param {number} bytes */
    const view = (at, bytes)=>new DataView(host.readMemory(at >>> 0, bytes).slice().buffer);

    /** @param {number} handle */
    const bitmapOf = handle=>{
        const at = host.heap.allocate(64) >>> 0;
        if (at === 0)
        {
            return null;
        }
        try
        {
            host.writeMemory(at, new Uint8Array(64));
            if (call('gdi32', 'GetObjectW', [handle, 24, at]) === 0)
            {
                return null;
            }
            const object = view(at, 24);
            const width = object.getInt32(4, true);
            const height = Math.abs(object.getInt32(8, true));
            const bits = object.getUint16(18, true);
            const header = new DataView(new ArrayBuffer(40));
            header.setUint32(0, 40, true);
            header.setInt32(4, width, true);
            header.setInt32(8, -height, true);
            header.setUint16(12, 1, true);
            header.setUint16(14, 32, true);
            host.writeMemory(at + 24, new Uint8Array(header.buffer));
            const pixels = host.heap.allocate(width * height * 4) >>> 0;
            const dc = call('gdi32', 'CreateCompatibleDC', [0]);
            try
            {
                const lines = call('gdi32', 'GetDIBits',
                    [dc, handle, 0, height, pixels, at + 24, 0]);
                if (lines === 0)
                {
                    return null;
                }
                return { width, height, bgra: host.readMemory(pixels, width * height * 4).slice(),
                    alpha: bits === 32 };
            }
            finally
            {
                call('gdi32', 'DeleteDC', [dc]);
                host.heap.free(pixels);
            }
        }
        finally
        {
            host.heap.free(at);
        }
    };

    /** @param {number} handle */
    const iconOf = handle=>{
        const at = host.heap.allocate(20) >>> 0;
        if (at === 0)
        {
            return null;
        }
        try
        {
            if (call('user32', 'GetIconInfo', [handle, at]) === 0)
            {
                return null;
            }
            const info = view(at, 20);
            const maskHandle = info.getUint32(12, true);
            const colourHandle = info.getUint32(16, true);
            const mask = maskHandle ? bitmapOf(maskHandle) : null;
            const colour = colourHandle ? bitmapOf(colourHandle) : null;
            for (const h of [maskHandle, colourHandle])
            {
                if (h)
                {
                    call('gdi32', 'DeleteObject', [h]);
                }
            }
            if (!mask)
            {
                return null;
            }
            // A monochrome icon's mask is twice its height: AND above, XOR below.
            const width = mask.width;
            const height = colour ? colour.height : mask.height >> 1;
            const bgra = colour ? colour.bgra : mask.bgra.slice(width * height * 4);
            const hasAlpha = colour !== null && bgra.some((v, i)=>(i & 3) === 3 && v !== 0);
            if (!hasAlpha)
            {
                for (let i = 0; i < width * height; i++)
                {
                    bgra[i * 4 + 3] = mask.bgra[i * 4] ? 0 : 255;
                }
            }
            return { width, height, bgra };
        }
        finally
        {
            host.heap.free(at);
        }
    };
    return { bitmapOf, iconOf };
}

/**
 * The exports, and the classes registered with COM.
 *
 * @param {import('./kit.js').CodecsHost} host
 * @returns {Record<string, { argBytes: number, handler: (args: number[]) => any }>}
 */
export function createWindowscodecs(host){
    const codecs = createCodecs(host);
    const { kit } = codecs;
    for (const [clsid, maker] of codecs.classes)
    {
        host.registry.registerClass(clsid, ()=>kit.definitionOf(maker()));
    }

    /**
     * A proxy: the method of the object in the first argument.
     *
     * @param {string} iface @param {string} name
     */
    const proxy = (iface, name)=>{
        const { methods } = flatten(iface);
        const slot = methods.findIndex(([m])=>m === name);
        const argBytes = methods[slot][1];
        return {
            argBytes,
            /** @param {number[]} args */
            handler: ([pointer, ...rest])=>{
                const object = pointer ? host.objectAt(pointer >>> 0) : null;
                const record = object?.interfaceFor?.(INTERFACES[iface].iid);
                const method = record?.methods.find((/** @type {any} */ m)=>m.name === name);
                if (method?.invoke)
                {
                    return method.invoke(object, rest.slice(0, argBytes / 4 - 1));
                }
                if (!pointer)
                {
                    return 0x80070057 | 0;
                }
                return kit.method(host.currentThread(), pointer, 3 + slot,
                    rest.slice(0, argBytes / 4 - 1));
            },
        };
    };

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => any }>} */
    const exports = {};
    for (const [iface, names] of Object.entries(PROXIES))
    {
        for (const name of names)
        {
            const exported = name === 'GetDataPointer' ? 'GetDataPointer_STA' : name;
            exports[`${iface}_${exported}_Proxy`] = proxy(iface, name);
        }
    }
    for (const [name, [slot, argBytes]] of Object.entries(FOREIGN))
    {
        exports[`${name}_Proxy`] = { argBytes, handler: ([pointer, ...rest])=>(pointer
            ? kit.method(host.currentThread(), pointer, slot, rest.slice(0, argBytes / 4 - 1))
            : 0x80070057 | 0) };
    }

    /** @param {string} name @param {number} argBytes */
    const refused = (name, argBytes)=>({ argBytes, handler: ()=>{
        kit.diverge(name, 'not provided');
        return E_NOTIMPL;
    } });

    return {
        ...exports,
        /** HRESULT WICCreateImagingFactory_Proxy(UINT SDKVersion, IWICImagingFactory **) */
        WICCreateImagingFactory_Proxy: { argBytes: 8,
            handler: (/** @type {number[]} */ [, out])=>kit.hand(codecs.makeFactory(),
                'IWICImagingFactory', out >>> 0) },
        /** HRESULT WICConvertBitmapSource(REFWICPixelFormatGUID, IWICBitmapSource *, IWICBitmapSource **) */
        WICConvertBitmapSource: { argBytes: 12,
            handler: (/** @type {number[]} */ [format, source, out])=>
                codecs.convertBitmapSource(format >>> 0, source >>> 0, out >>> 0) },
        WICCreateBitmapFromSection: { argBytes: 28,
            handler: (/** @type {number[]} */ args)=>codecs.bitmapFromSection(args.map(a=>a >>> 0)) },
        WICCreateBitmapFromSectionEx: { argBytes: 32,
            handler: (/** @type {number[]} */ args)=>codecs.bitmapFromSection(args.map(a=>a >>> 0)) },
        /** HRESULT WICCreateColorContext_Proxy(IWICImagingFactory *, IWICColorContext **) */
        WICCreateColorContext_Proxy: { argBytes: 8,
            handler: (/** @type {number[]} */ [factory, out])=>(factory === 0 ? 0x80070057 | 0
                : kit.hand(codecs.makeColorContext(), 'IWICColorContext', out >>> 0)) },
        WICMapGuidToShortName: refused('WICMapGuidToShortName', 16),
        WICMapSchemaToName: refused('WICMapSchemaToName', 20),
        WICMapShortNameToGuid: refused('WICMapShortNameToGuid', 8),
        WICSetEncoderFormat_Proxy: refused('WICSetEncoderFormat_Proxy', 16),
        DllCanUnloadNow: { argBytes: 0, handler: ()=>S_FALSE },
        DllRegisterServer: { argBytes: 0, handler: ()=>0 },
        DllUnregisterServer: { argBytes: 0, handler: ()=>0 },
    };
}
