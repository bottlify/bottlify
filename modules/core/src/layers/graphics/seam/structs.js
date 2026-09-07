/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D structures a guest call passes by pointer.
 *
 * Every offset is spelled out rather than counted, for the reason the
 * DirectDraw structures give: a field read one slot early is a plausible
 * number, and a plausible number is what makes this class of mistake survive
 * into a picture that is merely wrong rather than into a crash.
 *
 * D3DPRESENT_PARAMETERS is the one that matters most and the one that differs
 * between versions. Direct3D 8 has no `Flags` before the refresh rate and no
 * `PresentationInterval` at the end in the place 9 puts them, so the two
 * layouts are declared separately rather than shared with an offset table --
 * reading a 9 structure with 8's offsets finds the windowed flag in the depth
 * format's field, which is a boolean that happens to be true.
 */

/** D3DPRESENT_PARAMETERS as Direct3D 8 declares it. */
export const D3DPRESENT_PARAMETERS8 = Object.freeze({
    BackBufferWidth: 0x00,
    BackBufferHeight: 0x04,
    BackBufferFormat: 0x08,
    BackBufferCount: 0x0c,
    MultiSampleType: 0x10,
    SwapEffect: 0x14,
    hDeviceWindow: 0x18,
    Windowed: 0x1c,
    EnableAutoDepthStencil: 0x20,
    AutoDepthStencilFormat: 0x24,
    Flags: 0x28,
    FullScreen_RefreshRateInHz: 0x2c,
    FullScreen_PresentationInterval: 0x30,
    SIZE: 0x34,
});

/**
 * D3DPRESENT_PARAMETERS as Direct3D 9 declares it.
 *
 * MultiSampleQuality is inserted after MultiSampleType, and the trailing pair
 * is renamed -- windowed presentation gained an interval, so the field is no
 * longer full-screen only.
 */
export const D3DPRESENT_PARAMETERS9 = Object.freeze({
    BackBufferWidth: 0x00,
    BackBufferHeight: 0x04,
    BackBufferFormat: 0x08,
    BackBufferCount: 0x0c,
    MultiSampleType: 0x10,
    MultiSampleQuality: 0x14,
    SwapEffect: 0x18,
    hDeviceWindow: 0x1c,
    Windowed: 0x20,
    EnableAutoDepthStencil: 0x24,
    AutoDepthStencilFormat: 0x28,
    Flags: 0x2c,
    FullScreen_RefreshRateInHz: 0x30,
    PresentationInterval: 0x34,
    SIZE: 0x38,
});

/** D3DDISPLAYMODE. The same in both versions. */
export const D3DDISPLAYMODE = Object.freeze({
    Width: 0x00,
    Height: 0x04,
    RefreshRate: 0x08,
    Format: 0x0c,
    SIZE: 0x10,
});

/** D3DVIEWPORT8. Six dwords, the last two of which are floats. */
export const D3DVIEWPORT8 = Object.freeze({
    X: 0x00,
    Y: 0x04,
    Width: 0x08,
    Height: 0x0c,
    MinZ: 0x10,
    MaxZ: 0x14,
    SIZE: 0x18,
});

/** D3DRECT: four longs, and the order is left, top, right, bottom. */
export const D3DRECT = Object.freeze({
    x1: 0x00,
    y1: 0x04,
    x2: 0x08,
    y2: 0x0c,
    SIZE: 0x10,
});

/** POINT, which CopyRects takes an array of. */
export const POINT = Object.freeze({ x: 0x00, y: 0x04, SIZE: 0x08 });

/**
 * D3DLOCKED_RECT, written back by a lock: the row stride first, then the
 * address of the first byte. A caller that reads them the other way round
 * treats a pointer as a pitch and walks off the surface on its second row.
 */
export const D3DLOCKED_RECT = Object.freeze({ Pitch: 0x00, pBits: 0x04, SIZE: 0x08 });

/** D3DSURFACE_DESC as Direct3D 8 declares it. */
export const D3DSURFACE_DESC8 = Object.freeze({
    Format: 0x00,
    Type: 0x04,
    Usage: 0x08,
    Pool: 0x0c,
    Size: 0x10,
    MultiSampleType: 0x14,
    Width: 0x18,
    Height: 0x1c,
    SIZE: 0x20,
});

/**
 * Where D3DCAPS8's few interesting fields sit.
 *
 * The structure is long and almost all of it is capability bits a program
 * either tests or ignores; only the handful listed are ever written with
 * anything but zero here. The size is what a caller allocates, so it has to be
 * right even where the contents are not.
 */
export const D3DCAPS8 = Object.freeze({
    DeviceType: 0x00,
    AdapterOrdinal: 0x04,
    Caps: 0x08,
    Caps2: 0x0c,
    Caps3: 0x10,
    PresentationIntervals: 0x14,
    DevCaps: 0x1c,
    MaxTextureWidth: 0x64,
    MaxTextureHeight: 0x68,
    MaxTextureBlendStages: 0x84,
    MaxSimultaneousTextures: 0x88,
    MaxActiveLights: 0x94,
    MaxUserClipPlanes: 0x9c,
    MaxVertexBlendMatrices: 0xa0,
    MaxPointSize: 0xb0,
    MaxPrimitiveCount: 0xb4,
    MaxStreams: 0xbc,
    VertexShaderVersion: 0xc4,
    PixelShaderVersion: 0xcc,
    SIZE: 0xd4,
});

/**
 * Reading and writing dwords through the memory service, in one place.
 *
 * @param {any} memory  readMemory/writeMemory, as the graphics services give them.
 */
export function createFields(memory){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = memory.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        memory.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** A float shares its four bytes with a dword; only the reading differs. */
    const scratch = new DataView(new ArrayBuffer(4));

    return {
        readU32,
        writeU32,
        /** @param {number} address */
        readF32(address){
            scratch.setUint32(0, readU32(address), true);
            return scratch.getFloat32(0, true);
        },

        /**
         * A float that arrived in a stack slot rather than through memory: an
         * argument declared float is pushed as its four bytes, and this seam
         * reads every slot as a dword before it knows which is which.
         *
         * @param {number} bits
         */
        asFloat(bits){
            scratch.setUint32(0, bits >>> 0, true);
            return scratch.getFloat32(0, true);
        },
        /** @param {number} address @param {number} value */
        writeF32(address, value){
            scratch.setFloat32(0, value, true);
            writeU32(address, scratch.getUint32(0, true));
        },

        /**
         * A whole structure as named fields, given its offset table.
         *
         * @param {number} address
         * @param {Record<string, number>} layout
         * @param {string[]} [floats]  Fields to read as floats rather than dwords.
         * @returns {Record<string, number>}
         */
        readStruct(address, layout, floats = []){
            /** @type {Record<string, number>} */
            const out = {};
            for (const [name, offset] of Object.entries(layout))
            {
                if (name === 'SIZE')
                {
                    continue;
                }
                out[name] = floats.includes(name)
                    ? scratchFloat(readU32(address + offset))
                    : readU32(address + offset);
            }
            return out;
        },

        /**
         * @param {number} address
         * @param {Record<string, number>} layout
         * @param {Record<string, number>} values  Only the named fields are written.
         * @param {string[]} [floats]
         */
        writeStruct(address, layout, values, floats = []){
            for (const [name, value] of Object.entries(values))
            {
                const offset = layout[name];
                if (offset === undefined)
                {
                    continue;
                }
                if (floats.includes(name))
                {
                    scratch.setFloat32(0, value, true);
                    writeU32(address + offset, scratch.getUint32(0, true));
                }
                else
                {
                    writeU32(address + offset, value);
                }
            }
        },
    };

    /** @param {number} bits */
    function scratchFloat(bits){
        scratch.setUint32(0, bits, true);
        return scratch.getFloat32(0, true);
    }
}
