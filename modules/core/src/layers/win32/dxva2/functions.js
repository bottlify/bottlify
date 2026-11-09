/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dxva2 - here, the monitor configuration API it carries: the physical
 * monitors behind a display monitor, and their settings over DDC/CI.
 *
 * The one display monitor is one physical monitor, a "Generic PnP Monitor".
 * It has no I2C bus to talk DDC/CI over - the page is no panel a program can
 * dim - so every query of its settings and every change fails as Windows
 * fails it for such a monitor, with ERROR_GRAPHICS_I2C_ERROR_TRANSMITTING_DATA.
 * A system-information tool asks them and reports what it could not read.
 */

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_GRAPHICS_I2C_ERROR_TRANSMITTING_DATA = 0xc0262582;

/** PHYSICAL_MONITOR: a HANDLE and a description of 128 WCHARs. */
const PHYSICAL_MONITOR_SIZE = 4 + 128 * 2;
const DESCRIPTION = 'Generic PnP Monitor';

/**
 * @typedef {Object} Dxva2Host
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {(monitor: number) => boolean} isMonitor  An HMONITOR this session handed out.
 */

/**
 * The monitor configuration calls that talk to the monitor, by their
 * argument bytes: each takes the physical monitor first.
 */
const DDC_CALLS = Object.freeze({
    GetMonitorCapabilities: 12,
    GetMonitorBrightness: 16,
    GetMonitorContrast: 16,
    GetMonitorColorTemperature: 8,
    GetMonitorTechnologyType: 8,
    GetMonitorRedGreenOrBlueDrive: 20,
    GetMonitorRedGreenOrBlueGain: 20,
    GetMonitorDisplayAreaSize: 20,
    GetMonitorDisplayAreaPosition: 20,
    SetMonitorBrightness: 8,
    SetMonitorContrast: 8,
    SetMonitorColorTemperature: 8,
    SetMonitorRedGreenOrBlueDrive: 12,
    SetMonitorRedGreenOrBlueGain: 12,
    SetMonitorDisplayAreaSize: 12,
    SetMonitorDisplayAreaPosition: 12,
    DegaussMonitor: 4,
    RestoreMonitorFactoryDefaults: 4,
    RestoreMonitorFactoryColorDefaults: 4,
    SaveCurrentMonitorSettings: 4,
    GetCapabilitiesStringLength: 8,
    CapabilitiesRequestAndCapabilitiesReply: 12,
    GetVCPFeatureAndVCPFeatureReply: 20,
    SetVCPFeature: 12,
    SaveCurrentSettings: 4,
    GetTimingReport: 8,
});

/** @param {Dxva2Host} host */
export function createDxva2Functions(host){
    /** The physical monitor handles handed out and not destroyed. */
    const open = new Set();
    let next = 0;

    /** @param {number} code */
    const fail = code=>{
        host.setLastError(code);
        return 0;
    };
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));
    /** @param {number} at */
    const readU32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer)
        .getUint32(0, true);

    /** @type {Record<string, { argBytes: number, handler: (args: number[]) => number }>} */
    const table = {
        /** BOOL GetNumberOfPhysicalMonitorsFromHMONITOR(HMONITOR, LPDWORD): one. */
        GetNumberOfPhysicalMonitorsFromHMONITOR: {
            argBytes: 8,
            handler: ([monitor, out])=>{
                if (!host.isMonitor(monitor >>> 0))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((out >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                putU32(out, 1);
                return 1;
            },
        },

        /**
         * BOOL GetPhysicalMonitorsFromHMONITOR(HMONITOR, DWORD dwPhysicalMonitorArraySize,
         *     LPPHYSICAL_MONITOR pPhysicalMonitorArray)
         *
         * The array must hold exactly the count asked before; each entry is a
         * new handle the caller destroys.
         */
        GetPhysicalMonitorsFromHMONITOR: {
            argBytes: 12,
            handler: ([monitor, count, array])=>{
                if (!host.isMonitor(monitor >>> 0))
                {
                    return fail(ERROR_INVALID_HANDLE);
                }
                if ((count >>> 0) !== 1 || (array >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                const entry = new Uint8Array(PHYSICAL_MONITOR_SIZE);
                const view = new DataView(entry.buffer);
                next += 1;
                open.add(next);
                view.setUint32(0, next, true);
                [...DESCRIPTION].forEach((char, at)=>view.setUint16(4 + at * 2,
                    char.charCodeAt(0), true));
                host.writeMemory(array >>> 0, entry);
                return 1;
            },
        },

        /** BOOL DestroyPhysicalMonitor(HANDLE hMonitor) */
        DestroyPhysicalMonitor: {
            argBytes: 4,
            handler: ([handle])=>(open.delete(handle >>> 0) ? 1 : fail(ERROR_INVALID_HANDLE)),
        },

        /** BOOL DestroyPhysicalMonitors(DWORD dwPhysicalMonitorArraySize, LPPHYSICAL_MONITOR) */
        DestroyPhysicalMonitors: {
            argBytes: 8,
            handler: ([count, array])=>{
                if ((count >>> 0) !== 0 && (array >>> 0) === 0)
                {
                    return fail(ERROR_INVALID_PARAMETER);
                }
                let all = true;
                for (let index = 0; index < (count >>> 0); index++)
                {
                    all = open.delete(readU32((array >>> 0) + index * PHYSICAL_MONITOR_SIZE))
                        && all;
                }
                return all ? 1 : fail(ERROR_INVALID_HANDLE);
            },
        },
    };

    for (const [name, argBytes] of Object.entries(DDC_CALLS))
    {
        table[name] = {
            argBytes,
            handler: ([handle])=>fail(open.has(handle >>> 0)
                ? ERROR_GRAPHICS_I2C_ERROR_TRANSMITTING_DATA : ERROR_INVALID_HANDLE),
        };
    }
    return table;
}
