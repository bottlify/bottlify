/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 10's and 11's entry points as one object's methods, with what they draw
 * through bound in: what a program's DXGI factory and devices come from.
 *
 * Each is named as a recording knows a method that hands out an object
 * (`Create...`). As an object, it is what a recording wraps (`remote/d3d10.js`): every
 * device it makes, and everything that device makes, is then recorded and
 * played on a twin made from a root of its own -- the one in the graphics
 * worker, with a GPU behind it. A root made here with no backend keeps every
 * state and answers every call; one with a backend draws.
 */

import {
    D3D10CreateDevice, D3D10CreateDevice1, D3D10CreateDeviceAndSwapChain,
    D3D10CreateDeviceAndSwapChain1, D3D11CreateDevice, D3D11CreateDeviceAndSwapChain,
} from './device.js';
import { CreateDXGIFactory, CreateDXGIFactory1 } from './dxgi.js';

/**
 * @param {import('./device.js').DeviceOptions} options  what every device and factory it
 *     makes is made with
 */
export function createDirect3D10(options = {}){
    const factoryOptions = options.factoryOptions ?? {};
    return {
        /** What its devices are made with, as given. */
        options,
        /** @param {string} iid @param {{ object?: any }} out */
        CreateDXGIFactory: (iid, out)=>CreateDXGIFactory(iid, out, factoryOptions),
        /** @param {string} iid @param {{ object?: any }} out */
        CreateDXGIFactory1: (iid, out)=>CreateDXGIFactory1(iid, out, factoryOptions),
        /**
         * @param {any} adapter @param {number} driverType @param {any} software
         * @param {number} flags @param {number} sdkVersion @param {{ device?: any }} out
         */
        CreateDevice: (adapter, driverType, software, flags, sdkVersion, out)=>
            D3D10CreateDevice(adapter, driverType, software, flags, sdkVersion, out, options),
        /**
         * @param {any} adapter @param {number} driverType @param {any} software
         * @param {number} flags @param {number} featureLevel @param {number} sdkVersion
         * @param {{ device?: any } | null} out
         */
        CreateDevice1: (adapter, driverType, software, flags, featureLevel, sdkVersion,
            out)=>D3D10CreateDevice1(adapter, driverType, software, flags, featureLevel,
            sdkVersion, out, options),
        /**
         * @param {any} adapter @param {number} driverType @param {any} software
         * @param {number} flags @param {number} sdkVersion
         * @param {import('./structs.js').SwapChainFields | null} desc
         * @param {{ swapChain?: any }} chainOut @param {{ device?: any }} deviceOut
         */
        CreateDeviceAndSwapChain: (adapter, driverType, software, flags, sdkVersion, desc,
            chainOut, deviceOut)=>D3D10CreateDeviceAndSwapChain(adapter, driverType, software,
            flags, sdkVersion, desc, chainOut, deviceOut, options),
        /**
         * @param {any} adapter @param {number} driverType @param {any} software
         * @param {number} flags @param {number} featureLevel @param {number} sdkVersion
         * @param {import('./structs.js').SwapChainFields | null} desc
         * @param {{ swapChain?: any } | null} chainOut @param {{ device?: any } | null} deviceOut
         */
        CreateDeviceAndSwapChain1: (adapter, driverType, software, flags, featureLevel,
            sdkVersion, desc, chainOut, deviceOut)=>D3D10CreateDeviceAndSwapChain1(adapter,
            driverType, software, flags, featureLevel, sdkVersion, desc, chainOut, deviceOut,
            options),
        /**
         * Direct3D 11's: the same device, made at a feature level, with its
         * immediate context.
         *
         * @param {any} adapter @param {number} driverType @param {any} software
         * @param {number} flags @param {readonly number[] | null} levels
         * @param {import('./device.js').DeviceRequest11} out
         */
        CreateDevice11: (adapter, driverType, software, flags, levels, out)=>
            D3D11CreateDevice(adapter, driverType, software, flags, levels, out, options),
        /**
         * @param {any} adapter @param {number} driverType @param {any} software
         * @param {number} flags @param {readonly number[] | null} levels
         * @param {import('./structs.js').SwapChainFields | null} desc
         * @param {import('./device.js').DeviceRequest11 & { wantSwapChain: boolean,
         *     swapChain?: any }} out
         */
        CreateDeviceAndSwapChain11: (adapter, driverType, software, flags, levels, desc, out)=>
            D3D11CreateDeviceAndSwapChain(adapter, driverType, software, flags, levels, desc, out,
                options),
    };
}
