/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DXGI: the factory, the adapters and outputs it enumerates, and the swap
 * chain a device presents through.
 *
 * Presentation left Direct3D with this version of the API, and what came back
 * is an ownership graph rather than a device method. Getting that graph wrong
 * is the expensive mistake here, so it is stated rather than discovered:
 *
 * - **Everything has a parent, and asking for it takes a reference.** A swap
 *   chain's parent is the *factory*, not the device that draws into it; an
 *   output's is its adapter; an adapter's is the factory. The factory itself
 *   has no parent, and asking for one fails rather than answering null-and-ok.
 * - **A swap chain holds both ends.** Creating one takes a reference on the
 *   factory and on the device, and releasing it gives both back. A layer that
 *   only counts the device lets the factory die under a live swap chain.
 * - **A held back buffer blocks a resize.** `ResizeBuffers` fails outright
 *   while any buffer the program obtained from `GetBuffer` is still
 *   outstanding, and -- this is the part worth testing -- it leaves the
 *   description completely untouched when it does. Programs read the
 *   description back after a resize without checking the result.
 * - **`CreateDXGIFactory` is a version gate.** It answers for `IDXGIFactory`
 *   and refuses `IDXGIFactory1`, which is how a program discovers which DXGI it
 *   is talking to. Answering for both makes that test meaningless.
 *
 * One more asymmetry that looks like an inconsistency and is not: creating a
 * swap chain reports its refusals as `DXGI_ERROR_INVALID_CALL`, while reading a
 * description into a null pointer reports `E_INVALIDARG`. The first is DXGI
 * saying the request cannot be honoured, the second is the plain
 * bad-argument code, and programs do distinguish them.
 *
 * The machine arrives injected: adapters, outputs and the size of a window are
 * configuration, so the whole of this file runs headless in a test.
 */

import { attachCom } from './com.js';
import {
    DXGI_ERROR_INVALID_CALL, DXGI_ERROR_NOT_FOUND, DXGI_FORMAT, DXGI_MODE_SCALING,
    DXGI_MODE_SCANLINE_ORDER, DXGI_SWAP_EFFECT, DXGI_USAGE, E_INVALIDARG, E_NOINTERFACE, IID, S_OK,
} from './constants.js';
import { backBufferUsage, highestAccessibleBuffer, swapChainDescResult } from './validity.js';
import { REFRESH_HZ, displayModes } from '../../win32/user32/display.js';

/** DXGI_ERROR_NOT_CURRENTLY_AVAILABLE: what the browser has no way to give. */
const DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = 0x887a0022;

/**
 * The formats an output lists modes in: the ones a swap chain's buffer is
 * shown from.
 *
 * @type {ReadonlySet<number>}
 */
const DISPLAY_FORMATS = new Set([
    DXGI_FORMAT.R8G8B8A8_UNORM, DXGI_FORMAT.R8G8B8A8_UNORM_SRGB, DXGI_FORMAT.B8G8R8A8_UNORM,
    DXGI_FORMAT.B8G8R8A8_UNORM_SRGB,
]);

/**
 * @typedef {Object} ModeFields
 * @property {number} width
 * @property {number} height
 * @property {number} refreshNumerator
 * @property {number} refreshDenominator
 * @property {number} format
 * @property {number} scanlineOrdering
 * @property {number} scaling
 */

/**
 * The modes an output of this size lists in one format: the sizes every
 * other path of this build lists, at the one rate a browser presents at,
 * progressive, ordered by width, then height.
 *
 * @param {{ width: number, height: number }} size
 * @param {number} format
 * @returns {ModeFields[]}
 */
export function outputModes(size, format){
    if (!DISPLAY_FORMATS.has(format))
    {
        return [];
    }
    return displayModes({ width: size.width, height: size.height, bitsPerPixel: 32 })
        .filter(mode=>mode.refresh === REFRESH_HZ)
        .map(mode=>({
            width: mode.width,
            height: mode.height,
            refreshNumerator: REFRESH_HZ,
            refreshDenominator: 1,
            format,
            scanlineOrdering: DXGI_MODE_SCANLINE_ORDER.PROGRESSIVE,
            scaling: DXGI_MODE_SCALING.UNSPECIFIED,
        }));
}

/**
 * @typedef {Object} OutputConfig
 * @property {string} deviceName
 * @property {{ left: number, top: number, right: number, bottom: number }} [desktopCoordinates]
 */

/**
 * @typedef {Object} AdapterConfig
 * @property {string} description
 * @property {number} [vendorId]
 * @property {number} [deviceId]
 * @property {OutputConfig[]} [outputs]
 */

/**
 * @typedef {Object} FactoryOptions
 * @property {AdapterConfig[]} [adapters]
 * @property {(window: number) => { width: number, height: number }} [windowClientSize]
 */

/**
 * What a machine with one adapter and one output looks like.
 *
 * @type {readonly AdapterConfig[]}
 */
const DEFAULT_ADAPTERS = Object.freeze([{
    description: 'Bottlify Rendering Adapter',
    vendorId: 0,
    deviceId: 0,
    outputs: [{
        deviceName: 'Bottlify Output 0',
        desktopCoordinates: { left: 0, top: 0, right: 1920, bottom: 1080 },
    }],
}]);

/**
 * @param {string} iid
 * @param {{ object?: any }} out
 * @param {FactoryOptions} [options]
 * @returns {number} S_OK or E_NOINTERFACE
 */
export function CreateDXGIFactory(iid, out, options = {}){
    // Deliberately not IDXGIFactory1: this entry point is the first version of
    // DXGI, and a program uses exactly this refusal to tell the two apart.
    if (iid !== IID.IUnknown && iid !== IID.IDXGIObject && iid !== IID.IDXGIFactory)
    {
        out.object = null;
        return E_NOINTERFACE;
    }
    out.object = createFactory(options);
    return S_OK;
}

/**
 * @param {FactoryOptions} [options]
 */
export function createFactory(options = {}){
    const configs = options.adapters ?? DEFAULT_ADAPTERS;
    const windowClientSize = options.windowClientSize ?? (()=>({ width: 640, height: 480 }));

    /** @type {any[]} */
    let adapters = [];

    const factory = attachCom({
        /**
         * @param {number} index
         * @param {{ adapter?: any }} out
         * @returns {number}
         */
        EnumAdapters(index, out){
            if (index >= adapters.length)
            {
                out.adapter = null;
                return DXGI_ERROR_NOT_FOUND;
            }
            adapters[index].addRef();
            out.adapter = adapters[index];
            return S_OK;
        },

        /**
         * A null device, a null description, a missing out pointer and a
         * description naming no window are all the same failure.
         *
         * @param {any} device
         * @param {import('./structs.js').SwapChainFields} desc
         * @param {{ swapChain?: any }} out
         * @returns {number}
         */
        CreateSwapChain(device, desc, out){
            if (!device || !desc || !out)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            if (swapChainDescResult(desc) !== S_OK)
            {
                out.swapChain = null;
                return DXGI_ERROR_INVALID_CALL;
            }
            out.swapChain = createSwapChain(desc, device, factory, windowClientSize);
            return S_OK;
        },

        /** @returns {number} how many adapters this factory reports */
        adapterCount(){
            return adapters.length;
        },
    }, { interfaces: [IID.IDXGIObject, IID.IDXGIFactory], parent: null });

    adapters = configs.map(config=>createAdapter(config, factory));
    return factory;
}

/**
 * @param {AdapterConfig} config
 * @param {any} factory
 */
function createAdapter(config, factory){
    /** @type {any[]} */
    let outputs = [];

    // An adapter is the factory's, not the caller's: its first reference takes
    // one on the factory and its last gives it back, so a factory cannot die
    // while a program still holds an adapter enumerated out of it.
    const adapter = attachCom({
        /** @param {{ desc?: any }} out */
        GetDesc(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.desc = {
                Description: config.description,
                VendorId: config.vendorId ?? 0,
                DeviceId: config.deviceId ?? 0,
                SubSysId: 0,
                Revision: 0,
            };
            return S_OK;
        },

        /**
         * @param {number} index
         * @param {{ output?: any }} out
         * @returns {number}
         */
        EnumOutputs(index, out){
            if (index >= outputs.length)
            {
                out.output = null;
                return DXGI_ERROR_NOT_FOUND;
            }
            outputs[index].addRef();
            out.output = outputs[index];
            return S_OK;
        },
    }, {
        interfaces: [IID.IDXGIObject, IID.IDXGIAdapter, IID.IDXGIAdapter1],
        parent: factory,
        implicit: true,
        onFirstRef: ()=>factory.addRef(),
        onLastRef: ()=>factory.release(),
    });

    outputs = (config.outputs ?? []).map(output=>createOutput(output, adapter));
    return adapter;
}

/**
 * @param {OutputConfig} config
 * @param {any} adapter
 */
function createOutput(config, adapter){
    const desktop = config.desktopCoordinates ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const size = {
        width: desktop.right - desktop.left || 640,
        height: desktop.bottom - desktop.top || 480,
    };
    return attachCom({
        /**
         * @param {number} format
         * @returns {ModeFields[]} every mode listed in that format
         */
        GetDisplayModeList(format){
            return outputModes(size, format);
        },

        /**
         * The listed mode nearest the one asked for: the size nearest it, and
         * among those the rate nearest it. Any field left zero matches
         * anything, but a size is both halves or neither, and a format is
         * needed unless a device says which.
         *
         * @param {ModeFields} wanted
         * @param {boolean} hasDevice
         * @param {{ mode?: ModeFields }} out
         * @returns {number}
         */
        FindClosestMatchingMode(wanted, hasDevice, out){
            if ((wanted.width === 0) !== (wanted.height === 0))
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            if (wanted.format === DXGI_FORMAT.UNKNOWN && !hasDevice)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            const format = wanted.format === DXGI_FORMAT.UNKNOWN
                ? DXGI_FORMAT.R8G8B8A8_UNORM
                : wanted.format;
            const modes = outputModes(size, format);
            if (modes.length === 0)
            {
                return DXGI_ERROR_NOT_FOUND;
            }
            const target = wanted.width === 0 ? size : wanted;
            const rate = wanted.refreshDenominator === 0
                ? REFRESH_HZ
                : wanted.refreshNumerator / wanted.refreshDenominator;
            /** @param {ModeFields} mode */
            const distance = mode=>Math.abs(mode.width - target.width)
                + Math.abs(mode.height - target.height);
            let best = modes[0];
            for (const mode of modes)
            {
                const nearer = distance(mode) - distance(best)
                    || Math.abs(mode.refreshNumerator / mode.refreshDenominator - rate)
                        - Math.abs(best.refreshNumerator / best.refreshDenominator - rate);
                if (nearer < 0)
                {
                    best = mode;
                }
            }
            out.mode = { ...best };
            return S_OK;
        },

        /** @returns {{ width: number, height: number }} the desktop this output shows */
        size(){
            return { ...size };
        },

        /** @param {{ desc?: any }} out */
        GetDesc(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.desc = {
                DeviceName: config.deviceName,
                DesktopCoordinates: config.desktopCoordinates
                    ?? { left: 0, top: 0, right: 0, bottom: 0 },
                AttachedToDesktop: true,
                Rotation: 0,
            };
            return S_OK;
        },
    }, {
        interfaces: [IID.IDXGIObject, IID.IDXGIOutput],
        parent: adapter,
        implicit: true,
        onFirstRef: ()=>adapter.addRef(),
        onLastRef: ()=>adapter.release(),
    });
}

/**
 * @param {import('./structs.js').SwapChainFields} desc
 * @returns {import('./structs.js').SwapChainFields} a copy, so the caller's
 *          structure and the swap chain's cannot drift into each other
 */
function copySwapChainDesc(desc){
    return {
        bufferDesc: {
            width: desc.bufferDesc.width,
            height: desc.bufferDesc.height,
            refreshNumerator: desc.bufferDesc.refreshNumerator,
            refreshDenominator: desc.bufferDesc.refreshDenominator,
            format: desc.bufferDesc.format,
            scanlineOrdering: desc.bufferDesc.scanlineOrdering
                ?? DXGI_MODE_SCANLINE_ORDER.UNSPECIFIED,
            scaling: desc.bufferDesc.scaling ?? DXGI_MODE_SCALING.UNSPECIFIED,
        },
        sampleDesc: { count: desc.sampleDesc.count, quality: desc.sampleDesc.quality },
        bufferUsage: desc.bufferUsage,
        bufferCount: desc.bufferCount,
        outputWindow: desc.outputWindow,
        windowed: desc.windowed,
        swapEffect: desc.swapEffect,
        flags: desc.flags,
    };
}

/**
 * @param {import('./structs.js').SwapChainFields} requested
 * @param {any} device
 * @param {any} factory
 * @param {(window: number) => { width: number, height: number }} windowClientSize
 */
function createSwapChain(requested, device, factory, windowClientSize){
    // Nothing here takes the display for itself, so a swap chain asked for
    // fullscreen is made windowed and says so, as one made while fullscreen
    // is unavailable is.
    let desc = { ...copySwapChainDesc(requested), windowed: true };
    /** @type {Map<number, any>} */
    let buffers = new Map();
    let outstanding = 0;
    let presentCount = 0;
    let currentBuffer = 0;

    /**
     * A back buffer belongs to the swap chain, so it starts at zero references
     * and is handed out rather than made. While a program holds one the swap
     * chain cannot rebuild its buffers, which is what `outstanding` counts.
     *
     * @param {number} index
     */
    const bufferFor = index=>{
        const existing = buffers.get(index);
        if (existing)
        {
            return existing;
        }
        const buffer = device.createSwapChainBuffer({
            width: desc.bufferDesc.width,
            height: desc.bufferDesc.height,
            format: desc.bufferDesc.format,
            sampleDesc: desc.sampleDesc,
            usage: backBufferUsage(desc.bufferUsage, index),
            onFirstRef: ()=>{
                outstanding++;
                swapChain.addRef();
            },
            onLastRef: ()=>{
                outstanding--;
                swapChain.release();
            },
        });
        buffers.set(index, buffer);
        return buffer;
    };

    const swapChain = attachCom({
        factory,

        /** @param {{ desc?: any }} out */
        GetDesc(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.desc = copySwapChainDesc(desc);
            return S_OK;
        },

        /**
         * @param {number} index
         * @param {string} iid
         * @param {{ buffer?: any }} out
         * @returns {number}
         */
        GetBuffer(index, iid, out){
            if (index > highestAccessibleBuffer(desc.swapEffect, desc.bufferCount))
            {
                out.buffer = null;
                return DXGI_ERROR_INVALID_CALL;
            }
            const buffer = bufferFor(index);
            if (!buffer.supports(iid))
            {
                out.buffer = null;
                return E_NOINTERFACE;
            }
            buffer.addRef();
            out.buffer = buffer;
            return S_OK;
        },

        /**
         * @param {number} syncInterval
         * @param {number} flags
         * @returns {number}
         */
        Present(syncInterval, flags){
            if (syncInterval > 4 || flags < 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            presentCount++;
            currentBuffer = (currentBuffer + 1) % Math.max(1, desc.bufferCount);
            // Buffer zero is the one a program draws into whatever the swap
            // effect, so it is the one shown.
            device.present(bufferFor(0));
            return S_OK;
        },

        /**
         * Zero means "keep what you have" for the count and the format, and
         * "take it from the window" for the extent -- three meanings for one
         * argument value, spelled out here rather than defaulted at the call
         * site.
         *
         * @param {number} bufferCount
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {number} flags
         * @returns {number}
         */
        ResizeBuffers(bufferCount, width, height, format, flags){
            if (outstanding > 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            const client = windowClientSize(desc.outputWindow);
            const next = {
                ...desc,
                bufferDesc: {
                    ...desc.bufferDesc,
                    width: width === 0 ? client.width : width,
                    height: height === 0 ? client.height : height,
                    format: format === DXGI_FORMAT.UNKNOWN ? desc.bufferDesc.format : format,
                },
                bufferCount: bufferCount === 0 ? desc.bufferCount : bufferCount,
                flags,
            };
            if (swapChainDescResult(next) !== S_OK)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            desc = next;
            // Every buffer is rebuilt, so the ones handed out before this call
            // are no longer the swap chain's -- which is exactly why the call
            // refuses to run while one is still held.
            buffers = new Map();
            currentBuffer = 0;
            return S_OK;
        },

        /**
         * Going fullscreen is refused the way DXGI refuses it when the display
         * cannot be had just now; going windowed is where the swap chain
         * already is.
         *
         * @param {boolean} fullscreen
         * @returns {number}
         */
        SetFullscreenState(fullscreen){
            return fullscreen ? DXGI_ERROR_NOT_CURRENTLY_AVAILABLE : S_OK;
        },

        /**
         * The output the window is on: the device's adapter's first.
         *
         * @param {{ output?: any }} out
         * @returns {number}
         */
        GetContainingOutput(out){
            return device.adapter().EnumOutputs(0, out);
        },

        /**
         * @param {{ fullscreen?: boolean, target?: any }} out
         * @returns {number}
         */
        GetFullscreenState(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            // Nothing here goes exclusive: a browser has no mode to set, so the
            // answer is windowed and there is no target output to report.
            out.fullscreen = false;
            out.target = null;
            return S_OK;
        },

        /** @param {{ count?: number }} out */
        GetLastPresentCount(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.count = presentCount;
            return S_OK;
        },

        /** @returns {number} the buffer the next present will consume */
        currentBackBufferIndex(){
            return currentBuffer;
        },

        /** @returns {number} how many back-buffer references are outstanding */
        outstandingBuffers(){
            return outstanding;
        },
    }, {
        interfaces: [IID.IDXGIObject, IID.IDXGIDeviceSubObject, IID.IDXGISwapChain],
        parent: factory,
        onFirstRef: ()=>{
            factory.addRef();
            device.addRef();
        },
        onLastRef: ()=>{
            factory.release();
            device.release();
        },
    });
    return swapChain;
}

/** The description a device fills in when a program supplies nothing. */
export function defaultSwapChainDesc(){
    return {
        bufferDesc: {
            width: 640,
            height: 480,
            refreshNumerator: 60,
            refreshDenominator: 1,
            format: DXGI_FORMAT.R8G8B8A8_UNORM,
            scanlineOrdering: DXGI_MODE_SCANLINE_ORDER.UNSPECIFIED,
            scaling: DXGI_MODE_SCALING.UNSPECIFIED,
        },
        sampleDesc: { count: 1, quality: 0 },
        bufferUsage: DXGI_USAGE.RENDER_TARGET_OUTPUT,
        bufferCount: 1,
        outputWindow: 0,
        windowed: true,
        swapEffect: DXGI_SWAP_EFFECT.DISCARD,
        flags: 0,
    };
}
