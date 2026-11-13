/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * hid.dll: the HID class driver's user-mode side, on a machine with no HID
 * device but the keyboard and mouse the system owns.
 *
 * A program finds HID devices through SetupAPI with the class GUID this hands
 * out, and the device-interface enumeration finds none, so the calls that act
 * on an open device are reached only with a handle that is no device's: each
 * answers as Windows does for one, FALSE with ERROR_INVALID_HANDLE, and
 * HidP_GetCaps, which takes no handle, rejects data no device parsed.
 */

/** GUID_DEVINTERFACE_HID, {4D1E55B2-F16F-11CF-88CB-001111000030}. */
const HID_GUID = Uint8Array.from([
    0xb2, 0x55, 0x1e, 0x4d, 0x6f, 0xf1, 0xcf, 0x11, 0x88, 0xcb, 0x00, 0x11, 0x11, 0x00, 0x00, 0x30,
]);
const ERROR_INVALID_HANDLE = 6;
const HIDP_STATUS_INVALID_PREPARSED_DATA = 0xc0110001;

/**
 * @param {{ writeMemory: (address: number, bytes: Uint8Array) => void,
 *           setLastError: (code: number) => void }} host
 */
export function createHidFunctions(host){
    /** @param {number} argBytes */
    const noDevice = argBytes=>({
        argBytes,
        handler: ()=>{
            host.setLastError(ERROR_INVALID_HANDLE);
            return 0;
        },
    });

    return {
        /** void HidD_GetHidGuid(LPGUID HidGuid) */
        HidD_GetHidGuid: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([guid])=>{
                if ((guid >>> 0) !== 0)
                {
                    host.writeMemory(guid >>> 0, HID_GUID);
                }
                return 0;
            },
        },

        /** BOOLEAN HidD_GetAttributes(HANDLE, PHIDD_ATTRIBUTES) */
        HidD_GetAttributes: noDevice(8),
        /** BOOLEAN HidD_GetPreparsedData(HANDLE, PHIDP_PREPARSED_DATA *) */
        HidD_GetPreparsedData: noDevice(8),
        /** BOOLEAN HidD_FreePreparsedData(PHIDP_PREPARSED_DATA) -- none was ever handed out */
        HidD_FreePreparsedData: { argBytes: 4, handler: ()=>0 },
        /** BOOLEAN HidD_GetProductString(HANDLE, PVOID, ULONG) */
        HidD_GetProductString: noDevice(12),
        /** BOOLEAN HidD_GetManufacturerString(HANDLE, PVOID, ULONG) */
        HidD_GetManufacturerString: noDevice(12),
        /** BOOLEAN HidD_GetSerialNumberString(HANDLE, PVOID, ULONG) */
        HidD_GetSerialNumberString: noDevice(12),
        /** BOOLEAN HidD_GetFeature(HANDLE, PVOID, ULONG) */
        HidD_GetFeature: noDevice(12),
        /** BOOLEAN HidD_SetFeature(HANDLE, PVOID, ULONG) */
        HidD_SetFeature: noDevice(12),
        // The rest of what hid.dll exports and a HID library binds all at once: SDL's
        // HIDAPI takes hid.dll as missing when one of its names does not resolve, and
        // tries again at every look for a controller - a LoadLibrary, eight
        // GetProcAddress and a FreeLibrary each frame of a game's loading screen.
        /** BOOLEAN HidD_GetIndexedString(HANDLE, ULONG StringIndex, PVOID, ULONG) */
        HidD_GetIndexedString: noDevice(16),
        /** BOOLEAN HidD_GetPhysicalDescriptor(HANDLE, PVOID, ULONG) */
        HidD_GetPhysicalDescriptor: noDevice(12),
        /** BOOLEAN HidD_GetInputReport(HANDLE, PVOID, ULONG) */
        HidD_GetInputReport: noDevice(12),
        /** BOOLEAN HidD_SetOutputReport(HANDLE, PVOID, ULONG) */
        HidD_SetOutputReport: noDevice(12),
        /** BOOLEAN HidD_GetNumInputBuffers(HANDLE, PULONG) */
        HidD_GetNumInputBuffers: noDevice(8),
        /** BOOLEAN HidD_SetNumInputBuffers(HANDLE, ULONG) */
        HidD_SetNumInputBuffers: noDevice(8),
        /** BOOLEAN HidD_FlushQueue(HANDLE) */
        HidD_FlushQueue: noDevice(4),

        /** NTSTATUS HidP_GetCaps(PHIDP_PREPARSED_DATA, PHIDP_CAPS) */
        HidP_GetCaps: { argBytes: 8, handler: ()=>HIDP_STATUS_INVALID_PREPARSED_DATA },
    };
}
