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
 * swap chain reports a request it cannot honour -- no window, a buffer count
 * its swap effect does not take -- as `DXGI_ERROR_INVALID_CALL`, while a
 * format or sample count nothing could show, and reading a description into
 * a null pointer, report `E_INVALIDARG`, the plain bad-argument code.
 * Programs do distinguish them.
 *
 * The machine arrives injected: adapters, outputs and the size of a window are
 * configuration, so the whole of this file runs headless in a test.
 */

import { attachCom } from './com.js';
import {
    DXGI_ERROR_INVALID_CALL, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_UNSUPPORTED, DXGI_FORMAT,
    DXGI_MODE_SCALING, DXGI_MODE_SCANLINE_ORDER, DXGI_SWAP_CHAIN_FLAG, DXGI_SWAP_EFFECT, DXGI_USAGE,
    E_INVALIDARG, E_NOINTERFACE, IID, S_OK,
} from './constants.js';
import {
    DISPLAY_FORMATS, backBufferUsage, highestAccessibleBuffer, swapChainDescResult,
} from './validity.js';
import { displayModes, refreshOf } from '../../win32/user32/display.js';
import { VIDEO_ADAPTER_NAME } from '../../win32/devices.js';

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
 * The modes an output of this size lists in one format: the sizes user32's
 * EnumDisplaySettings lists for the same display, at the one rate a browser
 * presents at, progressive, ordered by width, then height.
 *
 * @param {{ width: number, height: number, displayWidth?: number,
 *           displayHeight?: number, refresh?: number }} size  The mode in effect, and
 *     the display's own size and rate.
 * @param {number} format
 * @returns {ModeFields[]}
 */
export function outputModes(size, format){
    if (!DISPLAY_FORMATS.has(format))
    {
        return [];
    }
    return displayModes({ width: size.width, height: size.height, bitsPerPixel: 32,
        ...(size.displayWidth ? { displayWidth: size.displayWidth } : {}),
        ...(size.displayHeight ? { displayHeight: size.displayHeight } : {}),
        ...(size.refresh ? { refresh: size.refresh } : {}) })
        .filter(mode=>mode.refresh === refreshOf(size))
        .map(mode=>({
            width: mode.width,
            height: mode.height,
            refreshNumerator: refreshOf(size),
            refreshDenominator: 1,
            format,
            scanlineOrdering: DXGI_MODE_SCANLINE_ORDER.PROGRESSIVE,
            scaling: DXGI_MODE_SCALING.UNSPECIFIED,
        }));
}

/** The user-mode driver's version, 1.0.0.0: its high dword, then its low one. */
const DRIVER_VERSION = Object.freeze({ high: 0x00010000, low: 0 });

/** DXGI_PRESENT_TEST: a present that only asks whether it would be shown. */
const DXGI_PRESENT_TEST = 0x1;

/** DXGI_MODE_ROTATION_IDENTITY: buffers shown as they are. */
const DXGI_MODE_ROTATION_IDENTITY = 1;
/** DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709: sRGB, the one a present shows. */
const DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 = 0;
/** DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT. */
const FRAME_LATENCY_WAITABLE = 0x40;
/** The most frames SetMaximumFrameLatency takes (DXGI_MAX_SWAP_CHAIN_BUFFERS). */
const MAX_FRAME_LATENCY = 16;
/** The flip model's swap effects: FLIP_SEQUENTIAL and FLIP_DISCARD. */
const FLIP_EFFECTS = new Set([3, 4]);

/**
 * @typedef {Object} OutputConfig
 * @property {string} deviceName
 * @property {{ left: number, top: number, right: number, bottom: number }} [desktopCoordinates]
 * @property {() => { width: number, height: number, displayWidth?: number,
 *                     displayHeight?: number, refresh?: number }} [desktop]
 *     The desktop's size, read when asked, in place of fixed coordinates, and
 *     the display's own when that is larger.
 * @property {number} [monitor]  The HMONITOR the output's description names.
 */

/**
 * @typedef {Object} AdapterConfig
 * @property {string} description
 * @property {number | (() => number)} [vendorId]
 * @property {number} [deviceId]
 * @property {OutputConfig[]} [outputs]
 * @property {boolean} [software]  A software rasteriser (DXGI_ADAPTER_FLAG_SOFTWARE).
 */

/**
 * @typedef {Object} FactoryOptions
 * @property {AdapterConfig[]} [adapters]  Every adapter, outright; the machine's one otherwise.
 * @property {(window: number) => { width: number, height: number }} [windowClientSize]
 * @property {() => { width: number, height: number, displayWidth?: number,
 *                     displayHeight?: number, refresh?: number }} [display]
 *     The desktop the machine's one output shows, as user32 reports it.
 * @property {() => number} [vendorId]
 *     The PCI vendor of the machine's one adapter, as Direct3D 9 reports it.
 * @property {number} [creationFlags]  What CreateDXGIFactory2 was given (GetCreationFlags).
 * @property {(options: { manualReset: boolean, signalled: boolean }) => number} [createEvent]
 *     A kernel event, as the handle a program waits on: a swap chain's frame
 *     latency object.
 * @property {(width: number, height: number,
 *             where: { window: number, fullscreen: boolean, announce?: boolean }) => void}
 *     [resolution]
 *     Told the mode a swap chain takes the screen at, and the window it takes
 *     with it, as a Direct3D 9 device tells it: the reported display becomes
 *     that mode, and a fullscreen window is placed over it.
 */

/**
 * The display's name and handle as user32 gives them -- EnumDisplayDevices'
 * DeviceName and what MonitorFromWindow answers -- and Direct3D 9's adapter
 * identifier repeats: a program matches an output to a monitor by them, and
 * GetMonitorInfo refuses any other handle.
 */
const DISPLAY_DEVICE_NAME = '\\\\.\\DISPLAY1';
const PRIMARY_MONITOR = 0x00010001;

/**
 * What a machine with one adapter and one output looks like: the adapter by
 * the name and vendor every other API reports, the output showing the
 * desktop user32 reports, read when asked so a mode change is seen.
 *
 * @param {FactoryOptions} options
 * @returns {AdapterConfig[]}
 */
function machineAdapters(options){
    return [{
        description: VIDEO_ADAPTER_NAME,
        vendorId: options.vendorId,
        deviceId: 0,
        outputs: [{
            deviceName: DISPLAY_DEVICE_NAME,
            monitor: PRIMARY_MONITOR,
            desktop: options.display ?? (()=>({ width: 640, height: 480 })),
        }],
    }];
}

/**
 * @param {string} iid
 * @param {{ object?: any }} out
 * @param {FactoryOptions} [options]
 * @returns {number} S_OK or E_NOINTERFACE
 */
export function CreateDXGIFactory(iid, out, options = {}){
    // Deliberately not IDXGIFactory1: this entry point is the first version of
    // DXGI, and a program uses exactly this refusal to tell the two apart.
    // Asked for a later one, it makes the factory of today's DXGI
    // (test_create_factory).
    const later = LATER_FACTORIES.includes(iid);
    if (iid !== IID.IUnknown && iid !== IID.IDXGIObject && iid !== IID.IDXGIFactory && !later)
    {
        out.object = null;
        return E_NOINTERFACE;
    }
    out.object = createFactory(options, later);
    return S_OK;
}

/** The factories after the first two, which today's DXGI's factory is all of. */
const LATER_FACTORIES = /** @type {readonly string[]} */ (Object.freeze([IID.IDXGIFactory2, IID.IDXGIFactory3, IID.IDXGIFactory4,
    IID.IDXGIFactory5, IID.IDXGIFactory6, IID.IDXGIFactory7]));

/** DXGI_CREATE_FACTORY_DEBUG: the one flag CreateDXGIFactory2 takes. */
const DXGI_CREATE_FACTORY_DEBUG = 0x1;

/**
 * DXGI 1.3's entry point: the factory of every version, made with flags.
 *
 * @param {number} flags
 * @param {string} iid
 * @param {{ object?: any }} out
 * @param {FactoryOptions} [options]
 * @returns {number}
 */
export function CreateDXGIFactory2(flags, iid, out, options = {}){
    if ((flags & ~DXGI_CREATE_FACTORY_DEBUG) !== 0)
    {
        out.object = null;
        return E_INVALIDARG;
    }
    if (iid !== IID.IUnknown && iid !== IID.IDXGIObject && iid !== IID.IDXGIFactory
        && iid !== IID.IDXGIFactory1 && !LATER_FACTORIES.includes(iid))
    {
        out.object = null;
        return E_NOINTERFACE;
    }
    out.object = createFactory({ ...options, creationFlags: flags }, true);
    return S_OK;
}

/**
 * DXGI 1.1's entry point: the same factory, answering as IDXGIFactory1 too.
 * Only a factory made here does; one made by the first entry point, or
 * implicitly for a device, stays a first-version factory.
 *
 * @param {string} iid
 * @param {{ object?: any }} out
 * @param {FactoryOptions} [options]
 * @returns {number}
 */
export function CreateDXGIFactory1(iid, out, options = {}){
    if (iid !== IID.IUnknown && iid !== IID.IDXGIObject && iid !== IID.IDXGIFactory
        && iid !== IID.IDXGIFactory1 && !LATER_FACTORIES.includes(iid))
    {
        out.object = null;
        return E_NOINTERFACE;
    }
    out.object = createFactory(options, true);
    return S_OK;
}

/**
 * @param {FactoryOptions} [options]
 * @param {boolean} [secondVersion]  Whether it answers as IDXGIFactory1 and every
 *     version after it, as today's DXGI's does: a first-version factory is one
 *     only CreateDXGIFactory makes.
 */
export function createFactory(options = {}, secondVersion = false){
    const configs = options.adapters ?? machineAdapters(options);
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
            // A buffer nothing could show is a bad argument rather than a bad
            // call (test_create_swapchain, dxgi.c:2100-2108).
            if (!DISPLAY_FORMATS.has(desc.bufferDesc.format))
            {
                out.swapChain = null;
                return E_INVALIDARG;
            }
            // The back buffers are textures of the device: a sample count the
            // device cannot make a texture at is one the swap chain cannot have.
            /** @type {{ levels?: number }} */
            const levels = {};
            if (desc.sampleDesc.count !== 1
                && (device.CheckMultisampleQualityLevels(desc.bufferDesc.format,
                    desc.sampleDesc.count, levels) !== S_OK
                    || desc.sampleDesc.quality >= (levels.levels ?? 0)))
            {
                out.swapChain = null;
                return E_INVALIDARG;
            }
            out.swapChain = createSwapChain(desc, device, factory, {
                windowClientSize, resolution: options.resolution, display: options.display,
                createEvent: options.createEvent,
            });
            return S_OK;
        },

        /**
         * @param {number} index
         * @param {{ adapter?: any }} out
         * @returns {number}
         */
        EnumAdapters1(index, out){
            return factory.EnumAdapters(index, out);
        },

        /**
         * Whether the adapters enumerated are still the system's: nothing
         * here is ever plugged in or out.
         *
         * @returns {boolean}
         */
        IsCurrent(){
            return true;
        },

        /** @returns {number} how many adapters this factory reports */
        adapterCount(){
            return adapters.length;
        },

        /**
         * DXGI 1.2's swap chain of a window: the description in two halves,
         * put together as the first version's, and a size of zero the
         * window's own.
         *
         * @param {any} device
         * @param {number} window
         * @param {import('./structs.js').SwapChainFields | null} desc
         * @param {any} restrict  the output it is held to, or null
         * @param {{ swapChain?: any }} out
         * @returns {number}
         */
        CreateSwapChainForHwnd(device, window, desc, restrict, out){
            out.swapChain = null;
            if (!device || !desc || window === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            // Stereo needs a display that shows it; a window's alpha is not
            // blended with the desktop (DXGI_ALPHA_MODE_UNSPECIFIED or IGNORE).
            if (desc.stereo || ((desc.alphaMode ?? 0) !== 0 && desc.alphaMode !== 3))
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            const sized = { ...desc, outputWindow: window, bufferDesc: { ...desc.bufferDesc,
                ...extentFromWindow(desc.bufferDesc.width, desc.bufferDesc.height,
                    ()=>windowClientSize(window)) } };
            const hr = factory.CreateSwapChain(device, sized, out);
            if (hr === S_OK)
            {
                out.swapChain.restrictedTo(restrict);
            }
            return hr;
        },

        /** @returns {number} what CreateDXGIFactory2 was given */
        GetCreationFlags(){
            return options.creationFlags ?? 0;
        },

        /**
         * DXGI_FEATURE_PRESENT_ALLOW_TEARING, the one feature there is: a
         * present without vsync is shown at once here.
         *
         * @param {number} feature @param {number} size
         * @returns {{ hr: number, value?: number }}
         */
        CheckFeatureSupport(feature, size){
            return feature === 0 && size === 4 ? { hr: S_OK, value: 1 } : { hr: E_INVALIDARG };
        },

        /**
         * The adapter whose locally unique identifier this is.
         *
         * @param {number} low @param {number} high @param {{ adapter?: any }} out
         * @returns {number}
         */
        EnumAdapterByLuid(low, high, out){
            const index = adapters.findIndex((_, at)=>adapterLuid(at).low === low
                && adapterLuid(at).high === high);
            if (index < 0)
            {
                out.adapter = null;
                return DXGI_ERROR_NOT_FOUND;
            }
            return factory.EnumAdapters(index, out);
        },

        /**
         * The software rasteriser every Windows has: here it draws through
         * the same GPU as the rest.
         *
         * @param {{ adapter?: any }} out
         * @returns {number}
         */
        EnumWarpAdapter(out){
            warp ??= createAdapter(WARP_ADAPTER, factory, adapterLuid(adapters.length));
            warp.addRef();
            out.adapter = warp;
            return S_OK;
        },

        /**
         * Notices of stereo, occlusion and adapter changes, by cookie: none of
         * them ever happens here, so a registration is kept and never fired.
         *
         * @returns {number} the cookie
         */
        register(){
            return nextCookie++;
        },

        /** @returns {boolean} whether a window shows stereo: none does */
        IsWindowedStereoEnabled(){
            return false;
        },
    }, {
        interfaces: [IID.IDXGIObject, IID.IDXGIFactory,
            ...(secondVersion ? [IID.IDXGIFactory1, ...LATER_FACTORIES] : [])],
        parent: null,
    });
    /** @type {any} */
    let warp = null;
    let nextCookie = 1;

    adapters = configs.map((config, index)=>createAdapter(config, factory, adapterLuid(index)));
    return factory;
}

/**
 * An adapter's locally unique identifier, by its place: the first is the
 * one every description has reported (1, 0).
 *
 * @param {number} index
 * @returns {{ low: number, high: number }}
 */
export function adapterLuid(index){
    return { low: index + 1, high: 0 };
}

/** Windows's software rasteriser, as its description names it. */
const WARP_ADAPTER = Object.freeze({ description: 'Microsoft Basic Render Driver',
    vendorId: 0x1414, deviceId: 0x8c, outputs: [], software: true });

/**
 * @param {AdapterConfig} config
 * @param {any} factory
 * @param {{ low: number, high: number }} luid
 */
function createAdapter(config, factory, luid){
    /** What a program reserved of each memory segment group (QueryVideoMemoryInfo). */
    const reserved = [0, 0];
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
                VendorId: (typeof config.vendorId === 'function'
                    ? config.vendorId()
                    : config.vendorId) ?? 0,
                DeviceId: config.deviceId ?? 0,
                SubSysId: 0,
                Revision: 0,
                AdapterLuid: { ...luid },
                // DXGI_ADAPTER_FLAG_SOFTWARE for the software rasteriser.
                Flags: config.software ? 2 : 0,
            };
            return S_OK;
        },

        /**
         * A memory segment group's budget: the local one is what the adapter
         * reports as its own memory, the other none.
         *
         * @param {number} node @param {number} group
         * @param {number} memory  the adapter's own, in bytes
         * @returns {{ hr: number, info?: { budget: number, usage: number,
         *     reservable: number, reserved: number } }}
         */
        QueryVideoMemoryInfo(node, group, memory){
            if (node !== 0 || group > 1)
            {
                return { hr: E_INVALIDARG };
            }
            const budget = group === 0 ? memory : 0;
            return { hr: S_OK, info: { budget, usage: 0, reservable: Math.floor(budget / 2),
                reserved: reserved[group] } };
        },

        /**
         * @param {number} node @param {number} group @param {number} bytes
         * @returns {number}
         */
        SetVideoMemoryReservation(node, group, bytes){
            if (node !== 0 || group > 1)
            {
                return E_INVALIDARG;
            }
            reserved[group] = bytes;
            return S_OK;
        },

        /** @returns {number} a notice's cookie: none is ever sent */
        register(){
            return factory.register();
        },

        /**
         * Which device interfaces a device made on this adapter answers to,
         * and the user-mode driver's version for them: Direct3D 10 and 10.1
         * and the DXGI device every one of them is, at the version Direct3D
         * 9's adapter identifier gives the same driver. Anything else is
         * unsupported, and its version left as the caller had it
         * (test_check_interface_support, dxgi.c:1270-1304).
         *
         * @param {string} iid
         * @param {{ version?: { low: number, high: number } }} out
         * @returns {number}
         */
        CheckInterfaceSupport(iid, out){
            if (iid !== IID.IDXGIDevice && iid !== IID.ID3D10Device
                && iid !== IID.ID3D10Device1)
            {
                return DXGI_ERROR_UNSUPPORTED;
            }
            out.version = { ...DRIVER_VERSION };
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
        interfaces: [IID.IDXGIObject, IID.IDXGIAdapter, IID.IDXGIAdapter1, IID.IDXGIAdapter2,
            IID.IDXGIAdapter3, IID.IDXGIAdapter4],
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
    /** @returns {{ left: number, top: number, right: number, bottom: number }} */
    const coordinates = ()=>{
        if (config.desktop)
        {
            const { width, height } = config.desktop();
            return { left: 0, top: 0, right: width, bottom: height };
        }
        return config.desktopCoordinates ?? { left: 0, top: 0, right: 0, bottom: 0 };
    };
    /**
     * @returns {{ width: number, height: number, displayWidth?: number,
     *             displayHeight?: number, refresh?: number }}
     */
    const sizeOf = ()=>{
        const desktop = coordinates();
        const display = config.desktop?.();
        return {
            width: desktop.right - desktop.left || 640,
            height: desktop.bottom - desktop.top || 480,
            ...(display?.displayWidth ? { displayWidth: display.displayWidth } : {}),
            ...(display?.displayHeight ? { displayHeight: display.displayHeight } : {}),
            ...(display?.refresh ? { refresh: display.refresh } : {}),
        };
    };
    return attachCom({
        /**
         * @param {number} format
         * @returns {ModeFields[]} every mode listed in that format
         */
        GetDisplayModeList(format){
            return outputModes(sizeOf(), format);
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
            const size = sizeOf();
            const modes = outputModes(size, format);
            if (modes.length === 0)
            {
                return DXGI_ERROR_NOT_FOUND;
            }
            const target = wanted.width === 0 ? size : wanted;
            const rate = wanted.refreshDenominator === 0
                ? refreshOf(size)
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
            return sizeOf();
        },

        /** @param {{ desc?: any }} out */
        GetDesc(out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.desc = {
                DeviceName: config.deviceName,
                DesktopCoordinates: coordinates(),
                AttachedToDesktop: true,
                // DXGI_MODE_ROTATION_IDENTITY: a desktop that is not turned.
                Rotation: 1,
                Monitor: config.monitor ?? 0,
            };
            return S_OK;
        },
    }, {
        interfaces: [IID.IDXGIObject, IID.IDXGIOutput, IID.IDXGIOutput1, IID.IDXGIOutput2,
            IID.IDXGIOutput3, IID.IDXGIOutput4, IID.IDXGIOutput5, IID.IDXGIOutput6],
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
        // DXGI 1.2's description says three things more.
        ...(desc.stereo !== undefined ? { stereo: desc.stereo } : {}),
        ...(desc.scaling1 !== undefined ? { scaling1: desc.scaling1 } : {}),
        ...(desc.alphaMode !== undefined ? { alphaMode: desc.alphaMode } : {}),
    };
}

/**
 * A back buffer's extent where either side was asked for as zero: that side of
 * the window's client area, and eight where the client area has none -- a
 * window of no size still gets a swap chain (dxgi.c test_create_swapchain).
 *
 * @param {number} width
 * @param {number} height
 * @param {() => { width: number, height: number }} client  Measured only if needed.
 * @returns {{ width: number, height: number }}
 */
function extentFromWindow(width, height, client){
    if (width !== 0 && height !== 0)
    {
        return { width, height };
    }
    const measured = client();
    return {
        width: width !== 0 ? width : measured.width || 8,
        height: height !== 0 ? height : measured.height || 8,
    };
}

/**
 * @param {import('./structs.js').SwapChainFields} requested
 * @param {any} device
 * @param {any} factory
 * @param {{ windowClientSize: (window: number) => { width: number, height: number },
 *           resolution?: FactoryOptions['resolution'],
 *           display?: FactoryOptions['display'],
 *           createEvent?: FactoryOptions['createEvent'] }} services
 */
function createSwapChain(requested, device, factory, services){
    const { windowClientSize } = services;
    const asked = copySwapChainDesc(requested);
    let desc = {
        ...asked,
        bufferDesc: {
            ...asked.bufferDesc,
            ...extentFromWindow(asked.bufferDesc.width, asked.bufferDesc.height,
                ()=>windowClientSize(asked.outputWindow)),
        },
    };
    /**
     * The desktop's mode before the swap chain took the screen, given back
     * when it leaves.
     *
     * @type {{ width: number, height: number } | null}
     */
    let desktop = null;

    /**
     * Fullscreen the way this engine has it, which is the way a Direct3D 9
     * device has it: the reported display is the mode, and the window is
     * placed over all of it and told its size. The page shows that window
     * whole; nothing is taken from the browser.
     *
     * @param {number} width @param {number} height
     */
    const takeScreen = (width, height)=>{
        if (desktop === null)
        {
            const shown = services.display?.();
            desktop = shown ? { width: shown.width, height: shown.height } : null;
        }
        services.resolution?.(width, height, { window: desc.outputWindow, fullscreen: true,
            announce: true });
    };
    if (!desc.windowed)
    {
        takeScreen(desc.bufferDesc.width, desc.bufferDesc.height);
    }
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
            index,
            width: desc.bufferDesc.width,
            height: desc.bufferDesc.height,
            format: desc.bufferDesc.format,
            sampleDesc: desc.sampleDesc,
            usage: backBufferUsage(desc.bufferUsage, index),
            gdiCompatible: (desc.flags & DXGI_SWAP_CHAIN_FLAG.GDI_COMPATIBLE) !== 0,
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

    /** @type {any} */
    let parked = null;
    /**
     * After a present the buffers move down one, the shown one to the end:
     * buffer 1 is the new buffer 0, buffer 0 the last (test_swapchain_flip).
     * Each buffer stays the object a program holds, so their contents move,
     * copied on the GPU; only where a buffer past the first is read at all.
     */
    const rotate = ()=>{
        const last = highestAccessibleBuffer(desc.swapEffect, desc.bufferCount);
        if (last === 0 || ![...buffers.keys()].some(index=>index > 0))
        {
            return;
        }
        parked ??= device.createSwapChainBuffer({ index: -1, width: desc.bufferDesc.width,
            height: desc.bufferDesc.height, format: desc.bufferDesc.format,
            sampleDesc: desc.sampleDesc, usage: desc.bufferUsage, gdiCompatible: false });
        device.CopyResource(parked, bufferFor(0));
        for (let index = 0; index < last; index++)
        {
            device.CopyResource(bufferFor(index), bufferFor(index + 1));
        }
        device.CopyResource(bufferFor(last), parked);
    };

    /** @type {any} */
    let restriction = null;
    let background = [0, 0, 0, 0];
    let rotation_ = DXGI_MODE_ROTATION_IDENTITY;
    /** @type {{ width: number, height: number } | null} */
    let source = null;
    let frameLatency = 1;

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
         * @returns {number | Promise<number>}
         */
        Present(syncInterval, flags){
            if (syncInterval > 4 || flags < 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            // A test asks only whether a present would be shown: nothing is
            // presented, counted or rotated, and the window is never occluded
            // here.
            if ((flags & DXGI_PRESENT_TEST) !== 0)
            {
                return S_OK;
            }
            presentCount++;
            currentBuffer = (currentBuffer + 1) % Math.max(1, desc.bufferCount);
            // Buffer zero is the one a program draws into whatever the swap
            // effect, so it is the one shown.
            const held = device.frameQueued?.(device.present(bufferFor(0))) ?? null;
            rotate();
            return held ? held.then(()=>S_OK) : S_OK;
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
            const next = {
                ...desc,
                bufferDesc: {
                    ...desc.bufferDesc,
                    ...extentFromWindow(width, height, ()=>windowClientSize(desc.outputWindow)),
                    format: format === DXGI_FORMAT.UNKNOWN ? desc.bufferDesc.format : format,
                },
                bufferCount: bufferCount === 0 ? desc.bufferCount : bufferCount,
                flags,
            };
            if (swapChainDescResult(next) !== S_OK)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            if (!DISPLAY_FORMATS.has(next.bufferDesc.format))
            {
                return E_INVALIDARG;
            }
            desc = next;
            // Every buffer is rebuilt, so the ones handed out before this call
            // are no longer the swap chain's -- which is exactly why the call
            // refuses to run while one is still held.
            buffers = new Map();
            parked = null;
            currentBuffer = 0;
            return S_OK;
        },

        /**
         * Fullscreen takes the screen at the back buffer's size, on this
         * adapter's one output; windowed gives the desktop's mode back. The
         * window stays where fullscreen placed it: nothing here keeps the
         * rectangle it had before.
         *
         * @param {boolean} fullscreen
         * @param {any} [target]  An output, or null for the containing one.
         * @returns {number}
         */
        SetFullscreenState(fullscreen, target = null){
            if (fullscreen && target)
            {
                /** @type {{ output?: any }} */
                const held = {};
                device.adapter().EnumOutputs(0, held);
                held.output?.release();
                if (target !== held.output)
                {
                    return DXGI_ERROR_INVALID_CALL;
                }
            }
            if (fullscreen === !desc.windowed)
            {
                return S_OK;
            }
            desc = { ...desc, windowed: !fullscreen };
            if (fullscreen)
            {
                takeScreen(desc.bufferDesc.width, desc.bufferDesc.height);
            }
            else if (desktop)
            {
                services.resolution?.(desktop.width, desktop.height,
                    { window: desc.outputWindow, fullscreen: false });
                desktop = null;
            }
            return S_OK;
        },

        /**
         * A new mode for the target: fullscreen, the screen is taken at it;
         * windowed, the window would be resized to it, which nothing here can
         * do yet.
         *
         * @param {ModeFields} mode
         * @returns {number}
         */
        ResizeTarget(mode){
            if (!mode)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            if (!desc.windowed)
            {
                takeScreen(mode.width || desc.bufferDesc.width,
                    mode.height || desc.bufferDesc.height);
                return S_OK;
            }
            device.diverge('ResizeTarget on a windowed swap chain leaves its window the'
                + ' size it is');
            return S_OK;
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
            out.fullscreen = !desc.windowed;
            out.target = null;
            if (out.fullscreen)
            {
                /** @type {{ output?: any }} */
                const held = {};
                device.adapter().EnumOutputs(0, held);
                out.target = held.output ?? null;
            }
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

        // --- DXGI 1.2 to 1.5 ---

        /** @param {{ desc?: any }} out */
        GetDesc1(out){
            out.desc = { ...copySwapChainDesc(desc), stereo: !!desc.stereo,
                scaling1: desc.scaling1 ?? 0, alphaMode: desc.alphaMode ?? 0 };
            return S_OK;
        },

        /** @param {any} output  the output a swap chain is held to, or null */
        restrictedTo(output){
            restriction = output ?? null;
        },

        /** @param {{ output?: any }} out */
        GetRestrictToOutput(out){
            restriction?.addRef();
            out.output = restriction;
            return S_OK;
        },

        /** @returns {boolean} whether a stereo chain could show one eye: none is stereo */
        IsTemporaryMonoSupported(){
            return false;
        },

        /** @param {number[] | null} rgba */
        SetBackgroundColor(rgba){
            if (!rgba)
            {
                return E_INVALIDARG;
            }
            background = [...rgba];
            return S_OK;
        },

        /** @param {{ rgba?: number[] }} out */
        GetBackgroundColor(out){
            out.rgba = [...background];
            return S_OK;
        },

        /**
         * A flip chain's buffers turned for the display: only as they are
         * here; a blit chain's never (DXGI_ERROR_INVALID_CALL).
         *
         * @param {number} rotation
         */
        SetRotation(rotation){
            if (!FLIP_EFFECTS.has(desc.swapEffect))
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            if (rotation !== DXGI_MODE_ROTATION_IDENTITY)
            {
                device.diverge('a flip swap chain turned for its display is shown unturned');
            }
            rotation_ = rotation;
            return S_OK;
        },

        /** @param {{ rotation?: number }} out */
        GetRotation(out){
            out.rotation = rotation_;
            return S_OK;
        },

        /**
         * The part of the buffers a present shows, from their top left.
         *
         * @param {number} width @param {number} height
         */
        SetSourceSize(width, height){
            if (width === 0 || height === 0 || width > desc.bufferDesc.width
                || height > desc.bufferDesc.height)
            {
                return E_INVALIDARG;
            }
            if (width !== desc.bufferDesc.width || height !== desc.bufferDesc.height)
            {
                device.diverge('a swap chain\'s source size smaller than its buffers is shown'
                    + ' whole');
            }
            source = { width, height };
            return S_OK;
        },

        /** @param {{ width?: number, height?: number }} out */
        GetSourceSize(out){
            out.width = source?.width ?? desc.bufferDesc.width;
            out.height = source?.height ?? desc.bufferDesc.height;
            return S_OK;
        },

        /**
         * How many frames a program may queue before its waitable object
         * holds it: a chain made with one only.
         *
         * @param {number} frames
         */
        SetMaximumFrameLatency(frames){
            if ((desc.flags & FRAME_LATENCY_WAITABLE) === 0 || frames === 0
                || frames > MAX_FRAME_LATENCY)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            frameLatency = frames;
            return S_OK;
        },

        /** @param {{ frames?: number }} out */
        GetMaximumFrameLatency(out){
            if ((desc.flags & FRAME_LATENCY_WAITABLE) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            out.frames = frameLatency;
            return S_OK;
        },

        /**
         * The event a program waits on before it draws a frame: signalled, as
         * a present here already waits for the GPU to take the frame
         * (`webgpu/internal/latency.js`), so a wait on it never holds.
         *
         * @returns {number} its handle, or zero for a chain made without one
         */
        GetFrameLatencyWaitableObject(){
            if ((desc.flags & FRAME_LATENCY_WAITABLE) === 0 || !services.createEvent)
            {
                return 0;
            }
            return services.createEvent({ manualReset: true, signalled: true });
        },

        /** @returns {number} the buffer drawn into: Direct3D 10 and 11 draw into buffer 0 */
        GetCurrentBackBufferIndex(){
            return 0;
        },

        /**
         * The colour spaces a present shows: sRGB only.
         *
         * @param {number} colorSpace
         * @returns {number} DXGI_SWAP_CHAIN_COLOR_SPACE_SUPPORT flags
         */
        CheckColorSpaceSupport(colorSpace){
            return colorSpace === DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 ? 1 : 0;
        },

        /** @param {number} colorSpace */
        SetColorSpace1(colorSpace){
            return colorSpace === DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709 ? S_OK : E_INVALIDARG;
        },

        /**
         * HDR metadata for the display: none is shown in HDR here.
         *
         * @param {number} type  DXGI_HDR_METADATA_TYPE
         */
        SetHDRMetaData(type){
            if (type > 1)
            {
                return E_INVALIDARG;
            }
            if (type !== 0)
            {
                device.diverge('HDR10 metadata is kept, and the picture shown in SDR');
            }
            return S_OK;
        },

        /** @returns {number} how many back-buffer references are outstanding */
        outstandingBuffers(){
            return outstanding;
        },
    }, {
        interfaces: [IID.IDXGIObject, IID.IDXGIDeviceSubObject, IID.IDXGISwapChain,
            IID.IDXGISwapChain1, IID.IDXGISwapChain2, IID.IDXGISwapChain3, IID.IDXGISwapChain4],
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

/**
 * The description a device fills in when a program supplies nothing.
 *
 * @returns {import('./structs.js').SwapChainFields}
 */
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
