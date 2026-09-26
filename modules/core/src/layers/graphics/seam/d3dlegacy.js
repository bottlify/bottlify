/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D of DirectX 3, 5 and 6, between a guest call and the objects
 * of `d3d7/legacy.js`.
 *
 * Like Direct3D 7 it has no entry point: IDirect3D3 is another table on the
 * DirectDraw object, and IDirect3DTexture2 another on a surface. So this seam
 * publishes no root either; it hands the DirectDraw seam one descriptor for
 * the object and the texture descriptors for its surfaces, and answers
 * through them.
 *
 * Three things are this version's own. Most structures carry a size, and
 * the size is the version -- a device description is read and written only
 * as far as the size the caller gave. The objects a program makes are
 * several interfaces with one count: a viewport answers IDirect3DViewport,
 * 2 and 3, a material its three generations. And the calls whose arguments
 * did not change since are the Direct3D 7 seam's own translations, handed
 * the device underneath.
 */

import { describe } from './vtables.js';
import {
    IDIRECT3D2_SLOTS, IDIRECT3D3_SLOTS, IDIRECT3DDEVICE2_SLOTS, IDIRECT3DDEVICE3_SLOTS,
    IDIRECT3DLIGHT_SLOTS, IDIRECT3DMATERIAL2_SLOTS,
    IDIRECT3DMATERIAL3_SLOTS, IDIRECT3DMATERIAL_SLOTS, IDIRECT3DTEXTURE2_SLOTS,
    IDIRECT3DTEXTURE_SLOTS, IDIRECT3DVERTEXBUFFER_SLOTS, IDIRECT3DVIEWPORT2_SLOTS,
    IDIRECT3DVIEWPORT3_SLOTS, IDIRECT3DVIEWPORT_SLOTS,
} from './vtables-ddraw.js';
import {
    IID_IDirect3D2, IID_IDirect3D3, IID_IDirect3DDevice2, IID_IDirect3DDevice3,
    IID_IDirect3DLight, IID_IDirect3DMaterial,
    IID_IDirect3DMaterial2, IID_IDirect3DMaterial3, IID_IDirect3DTexture, IID_IDirect3DTexture2,
    IID_IDirect3DVertexBuffer, IID_IDirect3DViewport, IID_IDirect3DViewport2,
    IID_IDirect3DViewport3, IID_IDirectDrawSurface, IID_IDirectDrawSurface4,
} from './iids.js';
import { D3DPRIMCAPS, D3DRECT, D3DVERTEXBUFFERDESC, createFields } from './structs.js';
import {
    D3DDEVICEDESC, D3DFINDDEVICERESULT, D3DFINDDEVICESEARCH, D3DLIGHT, D3DMATERIAL, D3DSTATS,
    D3DVIEWPORT, D3DVIEWPORT2,
} from './structs-legacy.js';
import { readGuid } from './ddraw.js';
import { DDSURFACEDESC, writeSurfaceDesc } from '../ddraw/structs.js';
import { pixelFormatForDepth } from '../ddraw/objects.js';
import { guidBytes } from './d3d7.js';
import {
    D3DCOLOR_RGB, D3DDD, D3DDEVCAPS_DRAWPRIMITIVES2EX, D3DDEVCAPS_FLOATTLVERTEX,
    D3DERR_INVALIDVERTEXTYPE, D3DFVF_LVERTEX, D3DFVF_TLVERTEX, D3DFVF_VERTEX, D3DVT,
    D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWTRANSFORMANDLIGHT, D3DFDS_GUID, D3DFDS_HARDWARE,
    D3DLIGHTCAPS_DIRECTIONAL, D3DLIGHTCAPS_PARALLELPOINT, D3DLIGHTCAPS_POINT, D3DLIGHTCAPS_SPOT,
    D3DLIGHTINGMODEL_RGB, D3DPTEXTURECAPS_POW2, D3DTRANSFORMCAPS_CLIP, D3D_OK,
    DDERR_ALREADYINITIALIZED, DDERR_INVALIDPARAMS, DDERR_NOTFOUND, DEVICE_IDS,
} from '../d3d7/constants.js';
import {
    CLASS_E_NOAGGREGATION, DDSCAPS_TEXTURE, DDSD_CAPS, DDSD_PIXELFORMAT,
} from '../ddraw/constants.js';
import { createLegacyDirect3D, createTextureHandles } from '../d3d7/legacy.js';
import { loadTexture } from '../d3d7/load.js';

/** What an enumeration callback answers to stop. */
const D3DENUMRET_CANCEL = 0;

/** The three sizes a D3DDEVICEDESC has had, oldest first. */
const DESC_SIZES = /** @type {readonly number[]} */ (
    Object.freeze([D3DDEVICEDESC.SIZE_V1, D3DDEVICEDESC.SIZE_V2, D3DDEVICEDESC.SIZE]));

/** A D3DFINDDEVICERESULT's size for a description of each size: a size, a GUID, two of them. */
const findResultSize = (/** @type {number} */ desc)=>D3DFINDDEVICERESULT.ddHwDesc + 2 * desc;

/** The nested structures' own sizes, which even an empty description carries. */
const D3DTRANSFORMCAPS_SIZE = 8;
const D3DLIGHTINGCAPS_SIZE = 16;
const TRANSFORM_CAPS = 0x10;
const LIGHTING_CAPS = 0x1c;

/** What the lighting of these versions can do, on either side. */
const LIGHT_KINDS = D3DLIGHTCAPS_POINT | D3DLIGHTCAPS_SPOT | D3DLIGHTCAPS_DIRECTIONAL
    | D3DLIGHTCAPS_PARALLELPOINT;

/** The most vertices one draw names, which is what a description reports. */
const MAX_VERTEX_COUNT = 0xffff;

/** Every D3DDD bit: which fields a full description fills. */
const ALL_FIELDS = Object.values(D3DDD).reduce((all, bit)=>all | bit, 0);

/** The fields the software side of the hardware device fills. */
const HEL_OF_HAL_FIELDS = D3DDD.COLORMODEL | D3DDD.DEVCAPS | D3DDD.TRANSFORMCAPS
    | D3DDD.LIGHTINGCAPS | D3DDD.BCLIPPING;

/**
 * @typedef {'full' | 'minimal' | 'empty'} DescriptionKind
 *     What one side of a device's description holds: all it can do, the
 *     little the software side of a hardware device reports, or nothing.
 */

/**
 * @typedef {Object} LegacyDeps
 * @property {any} publisher
 * @property {any} memory
 * @property {any} d3d7  The Direct3D 7 seam's `shared`.
 * @property {(call: { entry: number, args: number[], thread?: any })
 *              => Promise<number>} [callGuest]
 * @property {() => any} [currentThread]
 * @property {{ allocate: (bytes: number) => number }} [scratch]
 */

/**
 * @param {LegacyDeps} deps
 */
export function createLegacyDirect3DSeam(
    { publisher, memory, d3d7, callGuest, currentThread, scratch })
{
    const fields = createFields(memory);
    const { deviceMethods, bufferMethods, d3dMethods, readArray, readFloats, strideOf } = d3d7;

    /** Texture handles belong to surfaces, so there is one table for every object. */
    const textureHandles = createTextureHandles();

    /** One legacy object per DirectDraw object, over its Direct3D 7 object. */
    /** @type {WeakMap<object, any>} */
    const objects = new WeakMap();
    /** @param {any} root */
    const legacyFor = root=>{
        let made = objects.get(root);
        if (!made)
        {
            made = createLegacyDirect3D(d3d7.d3dFor(root), textureHandles);
            objects.set(root, made);
        }
        return made;
    };

    /** Guest memory for what an enumeration callback is shown, taken once. */
    let block = 0;
    const scratchBlock = ()=>{
        if (block === 0 && scratch)
        {
            // A GUID, two strings and two descriptions of the largest size.
            block = scratch.allocate(0x400);
        }
        return block;
    };
    const canEnumerate = ()=>callGuest !== undefined && scratchBlock() !== 0;

    /** @param {number} pointer @param {any} object @param {any[]} interfaces @param {string} id */
    const handBack = (pointer, object, interfaces, id)=>{
        fields.writeU32(pointer >>> 0, publisher.publish(object, interfaces, id));
    };

    /**
     * An interface pointer to an object the program already holds another
     * interface of, with a reference for the caller: the object's descriptors
     * were given when it was first published.
     *
     * @param {any} object @param {string} id
     */
    const pointerTo = (object, id)=>publisher.publish(object, [], id);

    /** @param {number} count @param {number} pointer @returns {any[] | null} D3DRECTs, signed */
    const readRects = (count, pointer)=>((pointer >>> 0) === 0
        ? null
        : Array.from({ length: count >>> 0 }, (_, index)=>{
            const raw = fields.readStruct((pointer >>> 0) + index * D3DRECT.SIZE, D3DRECT);
            return { x1: raw.x1 | 0, y1: raw.y1 | 0, x2: raw.x2 | 0, y2: raw.y2 | 0 };
        }));

    /** @param {number} at @returns {{ r: number, g: number, b: number, a: number }} */
    const readColour = at=>{
        const f = readFloats(at, 4);
        return { r: f[0], g: f[1], b: f[2], a: f[3] };
    };
    /** @param {number} at @param {{ r: number, g: number, b: number, a: number }} c */
    const writeColour = (at, c)=>{
        [c.r, c.g, c.b, c.a].forEach((value, index)=>fields.writeF32(at + index * 4, value));
    };
    /** @param {number} at @returns {{ x: number, y: number, z: number }} */
    const readVector = at=>{
        const f = readFloats(at, 3);
        return { x: f[0], y: f[1], z: f[2] };
    };
    /** @param {number} at @param {{ x: number, y: number, z: number }} v */
    const writeVector = (at, v)=>{
        [v.x, v.y, v.z].forEach((value, index)=>fields.writeF32(at + index * 4, value));
    };

    // --- device descriptions ---

    /**
     * One D3DDEVICEDESC: `size` bytes of it, whose own dwSize says `declared`.
     *
     * @param {number} pointer
     * @param {number} size
     * @param {number} declared
     * @param {DescriptionKind} kind
     * @param {any} device  A Direct3D 7 device description.
     */
    const writeDescription = (pointer, size, declared, kind, device)=>{
        const at = pointer >>> 0;
        memory.writeMemory(at, new Uint8Array(size));
        fields.writeU32(at + D3DDEVICEDESC.dwSize, declared);
        fields.writeU32(at + TRANSFORM_CAPS, D3DTRANSFORMCAPS_SIZE);
        fields.writeU32(at + LIGHTING_CAPS, D3DLIGHTINGCAPS_SIZE);
        fields.writeU32(at + D3DDEVICEDESC.dpcLineCaps, D3DPRIMCAPS.SIZE);
        fields.writeU32(at + D3DDEVICEDESC.dpcTriCaps, D3DPRIMCAPS.SIZE);
        if (kind === 'empty')
        {
            return;
        }
        const caps = device.caps;
        const software = device.id !== DEVICE_IDS.HAL;
        const lighting = (/** @type {number} */ lights)=>{
            fields.writeU32(at + TRANSFORM_CAPS + 4, D3DTRANSFORMCAPS_CLIP);
            fields.writeU32(at + D3DDEVICEDESC.bClipping, 1);
            fields.writeU32(at + LIGHTING_CAPS + 4, LIGHT_KINDS);
            fields.writeU32(at + LIGHTING_CAPS + 8, D3DLIGHTINGMODEL_RGB);
            fields.writeU32(at + LIGHTING_CAPS + 12, lights);
            fields.writeU32(at + D3DDEVICEDESC.dwMaxVertexCount, MAX_VERTEX_COUNT);
        };
        if (kind === 'minimal')
        {
            fields.writeU32(at + D3DDEVICEDESC.dwFlags, HEL_OF_HAL_FIELDS);
            fields.writeU32(at + D3DDEVICEDESC.dwDevCaps, D3DDEVCAPS_FLOATTLVERTEX);
            lighting(0);
            return;
        }
        // DirectX 7's own capabilities, and the hardware ones on the software
        // device, are not this device's to claim.
        const devCaps = caps.devCaps & ~D3DDEVCAPS_HWTRANSFORMANDLIGHT
            & ~(software ? D3DDEVCAPS_HWRASTERIZATION | D3DDEVCAPS_DRAWPRIMITIVES2EX : 0);
        fields.writeStruct(at, D3DDEVICEDESC, {
            dwFlags: ALL_FIELDS,
            dcmColorModel: D3DCOLOR_RGB,
            dwDevCaps: devCaps,
            dwDeviceRenderBitDepth: caps.deviceRenderBitDepth,
            dwDeviceZBufferBitDepth: caps.deviceZBufferBitDepth,
        });
        lighting(caps.maxActiveLights);
        for (const [offset, primitive] of /** @type {const} */ ([
            [D3DDEVICEDESC.dpcLineCaps, caps.lineCaps], [D3DDEVICEDESC.dpcTriCaps, caps.triCaps],
        ]))
        {
            fields.writeStruct(at + offset, D3DPRIMCAPS, {
                dwMiscCaps: primitive.miscCaps,
                dwRasterCaps: primitive.rasterCaps,
                dwZCmpCaps: primitive.zCmpCaps,
                dwSrcBlendCaps: primitive.srcBlendCaps,
                dwDestBlendCaps: primitive.destBlendCaps,
                dwAlphaCmpCaps: primitive.alphaCmpCaps,
                dwShadeCaps: primitive.shadeCaps,
                dwTextureCaps: primitive.textureCaps | (software ? D3DPTEXTURECAPS_POW2 : 0),
                dwTextureFilterCaps: primitive.textureFilterCaps,
                dwTextureBlendCaps: primitive.textureBlendCaps,
                dwTextureAddressCaps: primitive.textureAddressCaps,
                dwStippleWidth: primitive.stippleWidth,
                dwStippleHeight: primitive.stippleHeight,
            });
        }
        if (size >= D3DDEVICEDESC.SIZE_V2)
        {
            fields.writeStruct(at, D3DDEVICEDESC, {
                dwMinTextureWidth: caps.minTextureWidth,
                dwMinTextureHeight: caps.minTextureHeight,
                dwMaxTextureWidth: caps.maxTextureWidth,
                dwMaxTextureHeight: caps.maxTextureHeight,
            });
        }
        if (size >= D3DDEVICEDESC.SIZE)
        {
            fields.writeStruct(at, D3DDEVICEDESC, {
                dwMaxTextureRepeat: caps.maxTextureRepeat,
                dwMaxTextureAspectRatio: caps.maxTextureAspectRatio,
                dwMaxAnisotropy: caps.maxAnisotropy,
                dvGuardBandLeft: caps.guardBandLeft,
                dvGuardBandTop: caps.guardBandTop,
                dvGuardBandRight: caps.guardBandRight,
                dvGuardBandBottom: caps.guardBandBottom,
                dvExtentsAdjust: caps.extentsAdjust,
                dwStencilCaps: caps.stencilCaps,
                dwFVFCaps: caps.fvfCaps,
                dwTextureOpCaps: caps.textureOpCaps,
            }, ['dvGuardBandLeft', 'dvGuardBandTop', 'dvGuardBandRight', 'dvGuardBandBottom',
                'dvExtentsAdjust']);
            // Two WORDs, low one first.
            fields.writeU32(at + D3DDEVICEDESC.wMaxTextureBlendStages,
                (caps.maxTextureBlendStages & 0xffff) | (caps.maxSimultaneousTextures << 16));
        }
    };

    /**
     * A device's two descriptions: the hardware one is filled for the HAL and
     * empty for the software device, the software one the other way round --
     * save that the HAL's software side reports a little (Wine's ddraw4.c
     * test_enum_devices_caps_callback).
     *
     * @param {any} device @param {number} hal @param {number} halSize
     * @param {number} hel @param {number} helSize @param {number} declared
     */
    const writeDescriptions = (device, hal, halSize, hel, helSize, declared)=>{
        const hardware = device.id === DEVICE_IDS.HAL;
        writeDescription(hal, halSize, declared, hardware ? 'full' : 'empty', device);
        writeDescription(hel, helSize, declared, hardware ? 'minimal' : 'full', device);
    };

    /**
     * EnumDevices of any version: the software device, then the hardware
     * one, each with its descriptions at the size this version's header has.
     *
     * @param {any} root @param {number} callback @param {number} context @param {number} size
     */
    const enumerateDevices = (root, callback, context, size)=>{
        if ((callback >>> 0) === 0)
        {
            return DDERR_INVALIDPARAMS;
        }
        if (!canEnumerate())
        {
            return D3D_OK;
        }
        const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
        // Whose call this is, before the loop awaits anything: only the first
        // callback of an enumeration runs on the thread standing here.
        const asked = currentThread?.();
        const devices = legacyFor(root).devices();
        return (async()=>{
            for (const device of devices)
            {
                const at = scratchBlock();
                const text = at + 0x10;
                const name = at + 0x60;
                const hal = at + 0x80;
                const hel = hal + D3DDEVICEDESC.SIZE;
                memory.writeMemory(at, guidBytes(device.id));
                d3d7.writeString(text, device.text);
                d3d7.writeString(name, device.name);
                writeDescriptions(device, hal, size, hel, size, size);
                const answer = await call({ entry: callback >>> 0,
                    args: [at, text, name, hal, hel, context >>> 0], thread: asked });
                if ((answer >>> 0) === D3DENUMRET_CANCEL)
                {
                    break;
                }
            }
            return D3D_OK;
        })();
    };

    /**
     * FindDevice of any version. The search names a device by GUID or by
     * whether it is hardware; its other criteria are not what picks one, the
     * colour model least of all (Wine's ddraw4.c test_find_device). The
     * result's size says how large its two descriptions are, while each
     * description's dwSize says this version's size.
     *
     * @param {any} root @param {number} search @param {number} result @param {number} declared
     */
    const findDevice = (root, search, result, declared)=>{
        if ((search >>> 0) === 0 || (result >>> 0) === 0)
        {
            return DDERR_INVALIDPARAMS;
        }
        const resultSize = fields.readU32(result >>> 0);
        const size = DESC_SIZES.find(desc=>findResultSize(desc) === resultSize);
        if (fields.readU32(search >>> 0) !== D3DFINDDEVICESEARCH.SIZE || size === undefined)
        {
            return DDERR_INVALIDPARAMS;
        }
        const flags = fields.readU32((search >>> 0) + D3DFINDDEVICESEARCH.dwFlags);
        const guid = (flags & D3DFDS_GUID) !== 0
            ? readGuid(memory, (search >>> 0) + D3DFINDDEVICESEARCH.guid)
            : null;
        const hardware = (flags & D3DFDS_HARDWARE) !== 0
            ? fields.readU32((search >>> 0) + D3DFINDDEVICESEARCH.bHardware) !== 0
            : null;
        const device = legacyFor(root).devices().find((/** @type {any} */ candidate)=>
            (guid === null || candidate.id === guid)
            && (hardware === null || (candidate.id === DEVICE_IDS.HAL) === hardware));
        if (!device)
        {
            return DDERR_NOTFOUND;
        }
        memory.writeMemory((result >>> 0) + D3DFINDDEVICERESULT.guid, guidBytes(device.id));
        const hal = (result >>> 0) + D3DFINDDEVICERESULT.ddHwDesc;
        writeDescriptions(device, hal, size, hal + size, size, declared);
        return D3D_OK;
    };

    // --- lights ---

    const lightMethods = {
        Initialize: ()=>DDERR_ALREADYINITIALIZED,

        /**
         * A D3DLIGHT or, by its size, a D3DLIGHT2 with flags.
         *
         * @param {any} light @param {number[]} args
         */
        SetLight: (light, [pointer])=>{
            const at = pointer >>> 0;
            const size = at === 0 ? 0 : fields.readU32(at);
            if (size !== D3DLIGHT.SIZE && size !== D3DLIGHT.SIZE2)
            {
                return DDERR_INVALIDPARAMS;
            }
            return light.setLight({
                type: fields.readU32(at + D3DLIGHT.dltType),
                color: readColour(at + D3DLIGHT.dcvColor),
                position: readVector(at + D3DLIGHT.dvPosition),
                direction: readVector(at + D3DLIGHT.dvDirection),
                range: fields.readF32(at + D3DLIGHT.dvRange),
                falloff: fields.readF32(at + D3DLIGHT.dvFalloff),
                attenuation0: fields.readF32(at + D3DLIGHT.dvAttenuation0),
                attenuation1: fields.readF32(at + D3DLIGHT.dvAttenuation1),
                attenuation2: fields.readF32(at + D3DLIGHT.dvAttenuation2),
                theta: fields.readF32(at + D3DLIGHT.dvTheta),
                phi: fields.readF32(at + D3DLIGHT.dvPhi),
                flags: size === D3DLIGHT.SIZE2 ? fields.readU32(at + D3DLIGHT.dwFlags) : 0,
            }, size === D3DLIGHT.SIZE2);
        },

        /** @param {any} light @param {number[]} args */
        GetLight: (light, [pointer])=>{
            const at = pointer >>> 0;
            const size = at === 0 ? 0 : fields.readU32(at);
            if (size !== D3DLIGHT.SIZE && size !== D3DLIGHT.SIZE2)
            {
                return DDERR_INVALIDPARAMS;
            }
            memory.writeMemory(at + 4, new Uint8Array(size - 4));
            const data = light.getLight();
            if (data)
            {
                fields.writeU32(at + D3DLIGHT.dltType, data.type);
                writeColour(at + D3DLIGHT.dcvColor, data.color);
                writeVector(at + D3DLIGHT.dvPosition, data.position);
                writeVector(at + D3DLIGHT.dvDirection, data.direction);
                fields.writeStruct(at, D3DLIGHT, {
                    dvRange: data.range, dvFalloff: data.falloff,
                    dvAttenuation0: data.attenuation0, dvAttenuation1: data.attenuation1,
                    dvAttenuation2: data.attenuation2, dvTheta: data.theta, dvPhi: data.phi,
                }, ['dvRange', 'dvFalloff', 'dvAttenuation0', 'dvAttenuation1', 'dvAttenuation2',
                    'dvTheta', 'dvPhi']);
                if (size === D3DLIGHT.SIZE2)
                {
                    fields.writeU32(at + D3DLIGHT.dwFlags, data.flags);
                }
            }
            return D3D_OK;
        },
    };
    const lightInterfaces = [describe(IID_IDirect3DLight, IDIRECT3DLIGHT_SLOTS, lightMethods)];

    // --- materials ---

    const materialMethods = {
        Initialize: ()=>DDERR_ALREADYINITIALIZED,

        /** @param {any} material @param {number[]} args */
        SetMaterial: (material, [pointer])=>{
            const at = pointer >>> 0;
            if (at === 0 || fields.readU32(at) !== D3DMATERIAL.SIZE)
            {
                return DDERR_INVALIDPARAMS;
            }
            return material.setMaterial({
                diffuse: readColour(at + D3DMATERIAL.diffuse),
                ambient: readColour(at + D3DMATERIAL.ambient),
                specular: readColour(at + D3DMATERIAL.specular),
                emissive: readColour(at + D3DMATERIAL.emissive),
                power: fields.readF32(at + D3DMATERIAL.power),
                texture: fields.readU32(at + D3DMATERIAL.hTexture),
                rampSize: fields.readU32(at + D3DMATERIAL.dwRampSize),
            });
        },

        /** @param {any} material @param {number[]} args */
        GetMaterial: (material, [pointer])=>{
            const at = pointer >>> 0;
            if (at === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const data = material.data;
            fields.writeU32(at, D3DMATERIAL.SIZE);
            writeColour(at + D3DMATERIAL.diffuse, data.diffuse);
            writeColour(at + D3DMATERIAL.ambient, data.ambient);
            writeColour(at + D3DMATERIAL.specular, data.specular);
            writeColour(at + D3DMATERIAL.emissive, data.emissive);
            fields.writeF32(at + D3DMATERIAL.power, data.power);
            fields.writeU32(at + D3DMATERIAL.hTexture, data.texture);
            fields.writeU32(at + D3DMATERIAL.dwRampSize, data.rampSize);
            return D3D_OK;
        },

        /**
         * The handle a light state or a background names the material by.
         * The device it is asked through must be one.
         *
         * @param {any} material @param {number[]} args
         */
        GetHandle: (material, [device, out])=>{
            if (!publisher.objectAt(device) || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, material.getHandle());
            return D3D_OK;
        },

        // A palette reservation is the ramp driver's, which is not made here.
        Reserve: ()=>D3D_OK,
        Unreserve: ()=>D3D_OK,
    };
    const materialInterfaces = [
        describe(IID_IDirect3DMaterial3, IDIRECT3DMATERIAL3_SLOTS, materialMethods),
        describe(IID_IDirect3DMaterial2, IDIRECT3DMATERIAL2_SLOTS, materialMethods),
        describe(IID_IDirect3DMaterial, IDIRECT3DMATERIAL_SLOTS, materialMethods),
    ];

    // --- viewports ---

    /**
     * A D3DVIEWPORT or D3DVIEWPORT2 whose size must be exactly its own:
     * Windows refuses one a byte larger or smaller (Wine's ddraw4.c
     * test_viewport_object, which marks Wine's own leniency todo).
     *
     * @param {number} pointer
     */
    const viewportAt = pointer=>((pointer >>> 0) !== 0
        && fields.readU32(pointer >>> 0) === D3DVIEWPORT.SIZE);

    const VIEWPORT_FLOATS = ['dvScaleX', 'dvScaleY', 'dvMaxX', 'dvMaxY', 'dvMinZ', 'dvMaxZ'];
    const VIEWPORT2_FLOATS = ['dvClipX', 'dvClipY', 'dvClipWidth', 'dvClipHeight', 'dvMinZ',
        'dvMaxZ'];

    /**
     * @param {number} pointer
     * @param {any} surface
     * @param {string} id  The surface generation to hand it back as.
     * @param {number} valid
     */
    const writeDepth = (pointer, surface, id, valid)=>{
        fields.writeU32(pointer >>> 0, surface ? pointerTo(surface, id) : 0);
        fields.writeU32(valid >>> 0, surface ? 1 : 0);
    };

    const viewportMethods = {
        Initialize: ()=>DDERR_ALREADYINITIALIZED,

        /** @param {any} viewport @param {number[]} args */
        GetViewport: (viewport, [pointer])=>{
            if (!viewportAt(pointer))
            {
                return DDERR_INVALIDPARAMS;
            }
            const { hr, viewport: v } = viewport.getViewport();
            if (hr === D3D_OK && v)
            {
                fields.writeStruct(pointer >>> 0, D3DVIEWPORT, {
                    dwX: v.x, dwY: v.y, dwWidth: v.width, dwHeight: v.height,
                    dvScaleX: v.scaleX, dvScaleY: v.scaleY, dvMaxX: v.maxX, dvMaxY: v.maxY,
                    dvMinZ: v.minZ, dvMaxZ: v.maxZ,
                }, VIEWPORT_FLOATS);
            }
            return hr;
        },

        /** @param {any} viewport @param {number[]} args */
        SetViewport: (viewport, [pointer])=>{
            if (!viewportAt(pointer))
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(pointer >>> 0, D3DVIEWPORT, VIEWPORT_FLOATS);
            return viewport.setViewport({
                x: raw.dwX, y: raw.dwY, width: raw.dwWidth, height: raw.dwHeight,
                scaleX: raw.dvScaleX, scaleY: raw.dvScaleY, maxX: raw.dvMaxX, maxY: raw.dvMaxY,
                minZ: raw.dvMinZ, maxZ: raw.dvMaxZ,
            });
        },

        /** @param {any} viewport @param {number[]} args */
        SetBackground: (viewport, [handle])=>viewport.setBackground(handle >>> 0),

        /** @param {any} viewport @param {number[]} args */
        GetBackground: (viewport, [out, valid])=>{
            if ((out >>> 0) === 0 || (valid >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const background = viewport.getBackground();
            fields.writeU32(out >>> 0, background.handle);
            fields.writeU32(valid >>> 0, background.valid ? 1 : 0);
            return D3D_OK;
        },

        /** @param {any} viewport @param {number[]} args */
        SetBackgroundDepth: (viewport, [surface])=>
            viewport.setBackgroundDepth(publisher.objectAt(surface)),

        /** @param {any} viewport @param {number[]} args */
        GetBackgroundDepth: (viewport, [out, valid])=>{
            if ((out >>> 0) === 0 || (valid >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const { surface } = viewport.getBackgroundDepth();
            writeDepth(out, surface, IID_IDirectDrawSurface, valid);
            return D3D_OK;
        },

        /** @param {any} viewport @param {number[]} args */
        Clear: (viewport, [count, rects, flags])=>
            viewport.clear(readRects(count, rects), flags >>> 0),

        /** @param {any} viewport @param {number[]} args */
        AddLight: (viewport, [light])=>viewport.addLight(publisher.objectAt(light)),

        /** @param {any} viewport @param {number[]} args */
        DeleteLight: (viewport, [light])=>viewport.deleteLight(publisher.objectAt(light)),

        /** @param {any} viewport @param {number[]} args */
        NextLight: (viewport, [from, out, flags])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const { hr, found } = viewport.nextLight(publisher.objectAt(from), flags >>> 0);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, pointerTo(found, IID_IDirect3DLight));
            }
            return hr;
        },

        /** @param {any} viewport @param {number[]} args */
        GetViewport2: (viewport, [pointer])=>{
            if (!viewportAt(pointer))
            {
                return DDERR_INVALIDPARAMS;
            }
            const { hr, viewport: v } = viewport.getViewport2();
            if (hr === D3D_OK && v)
            {
                fields.writeStruct(pointer >>> 0, D3DVIEWPORT2, {
                    dwX: v.x, dwY: v.y, dwWidth: v.width, dwHeight: v.height,
                    dvClipX: v.clipX, dvClipY: v.clipY, dvClipWidth: v.clipWidth,
                    dvClipHeight: v.clipHeight, dvMinZ: v.minZ, dvMaxZ: v.maxZ,
                }, VIEWPORT2_FLOATS);
            }
            return hr;
        },

        /** @param {any} viewport @param {number[]} args */
        SetViewport2: (viewport, [pointer])=>{
            if (!viewportAt(pointer))
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(pointer >>> 0, D3DVIEWPORT2, VIEWPORT2_FLOATS);
            return viewport.setViewport2({
                x: raw.dwX, y: raw.dwY, width: raw.dwWidth, height: raw.dwHeight,
                clipX: raw.dvClipX, clipY: raw.dvClipY, clipWidth: raw.dvClipWidth,
                clipHeight: raw.dvClipHeight, minZ: raw.dvMinZ, maxZ: raw.dvMaxZ,
            });
        },

        /** @param {any} viewport @param {number[]} args */
        SetBackgroundDepth2: (viewport, [surface])=>
            viewport.setBackgroundDepth(publisher.objectAt(surface)),

        /** @param {any} viewport @param {number[]} args */
        GetBackgroundDepth2: (viewport, [out, valid])=>{
            if ((out >>> 0) === 0 || (valid >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const { surface } = viewport.getBackgroundDepth();
            writeDepth(out, surface, IID_IDirectDrawSurface4, valid);
            return D3D_OK;
        },

        // Z arrives as a float in a slot read as a dword.
        /** @param {any} viewport @param {number[]} args */
        Clear2: (viewport, [count, rects, flags, colour, z, stencil])=>viewport.clear2(
            readRects(count, rects), flags >>> 0, colour >>> 0, fields.asFloat(z),
            stencil >>> 0),
    };
    const viewportInterfaces = [
        describe(IID_IDirect3DViewport3, IDIRECT3DVIEWPORT3_SLOTS, viewportMethods),
        describe(IID_IDirect3DViewport2, IDIRECT3DVIEWPORT2_SLOTS, viewportMethods),
        describe(IID_IDirect3DViewport, IDIRECT3DVIEWPORT_SLOTS, viewportMethods),
    ];

    // --- textures, on surfaces ---

    const textureMethods = {
        /** @param {any} surface @param {number[]} args */
        GetHandle: (surface, [device, out])=>{
            if (!publisher.objectAt(device) || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            fields.writeU32(out >>> 0, textureHandles.handleOf(surface));
            return D3D_OK;
        },

        // The palette is read at each upload; there is nothing to refresh.
        PaletteChanged: ()=>D3D_OK,

        /**
         * The whole source, every level of it, into this texture. A source
         * without a colour key leaves this one's (Wine's ddraw4.c
         * test_texture_load_ckey).
         *
         * @param {any} surface @param {number[]} args
         */
        Load: (surface, [source])=>loadTexture({
            memory, dest: surface, destPoint: null, src: publisher.objectAt(source), srcRect: null,
            keepDestinationKey: true,
        }),

        Initialize: ()=>DDERR_ALREADYINITIALIZED,
        Unload: ()=>D3D_OK,
    };
    const textureInterfaces = [
        describe(IID_IDirect3DTexture2, IDIRECT3DTEXTURE2_SLOTS, textureMethods),
        describe(IID_IDirect3DTexture, IDIRECT3DTEXTURE_SLOTS, textureMethods),
    ];

    // --- vertex buffers ---

    const bufferInterfaces = [
        describe(IID_IDirect3DVertexBuffer, IDIRECT3DVERTEXBUFFER_SLOTS, bufferMethods),
    ];

    // --- devices ---

    /**
     * The interfaces a device of each version answers: its own generation
     * and the older ones, with one count (Wine's ddraw4.c and ddraw2.c
     * test_device_qi).
     *
     * @type {Record<number, import('./com.js').InterfaceDescriptor[]>}
     */
    const deviceInterfaces = {};

    /**
     * What a call through each device generation hands its objects back as.
     * It is the generation of the table the call came through, not of the
     * device: a program reads what it is given through that table's types,
     * and an IDirectDrawSurface4 read as an IDirectDrawSurface takes the
     * wrong size of descriptor.
     */
    const IDS = Object.freeze({
        3: {
            d3d: IID_IDirect3D3, surface: IID_IDirectDrawSurface4,
            viewport: IID_IDirect3DViewport3, texture: IID_IDirect3DTexture2,
        },
        2: {
            d3d: IID_IDirect3D2, surface: IID_IDirectDrawSurface,
            viewport: IID_IDirect3DViewport2, texture: IID_IDirect3DTexture2,
        },
    });

    /**
     * The vertex formats IDirect3DDevice2 names by D3DVERTEXTYPE: a vertex
     * to be transformed and lit, one lit already, and one transformed too.
     *
     * @type {Readonly<Record<number, number>>}
     */
    const VERTEX_TYPES = Object.freeze({
        [D3DVT.VERTEX]: D3DFVF_VERTEX, [D3DVT.LVERTEX]: D3DFVF_LVERTEX,
        [D3DVT.TLVERTEX]: D3DFVF_TLVERTEX,
    });

    /**
     * A call Direct3D 7 translates the same way, made on the device underneath.
     *
     * @param {string} name
     */
    const onInner = name=>(/** @type {any} */ device, /** @type {number[]} */ args)=>
        deviceMethods[name](device.inner, args);

    /** @param {number} pointer @param {number} size @returns {boolean} */
    const descriptionAt = (pointer, size)=>(pointer >>> 0) !== 0 && DESC_SIZES.includes(size);

    /**
     * The methods the second and third generations share: the same names
     * and arguments, save that a vertex format is an FVF in the third and a
     * D3DVERTEXTYPE in the second, and that what they hand back is their own
     * generation's interface.
     *
     * @param {typeof IDS[3]} ids
     * @param {(value: number) => number} formatOf  The argument as an FVF, or zero for none.
     */
    const sharedDeviceMethods = (ids, formatOf)=>{
        /**
         * @param {number} value
         * @param {(fvf: number) => number} run
         */
        const withFormat = (value, run)=>{
            const fvf = formatOf(value >>> 0);
            return fvf === 0 ? D3DERR_INVALIDVERTEXTYPE : run(fvf);
        };
        return {
            /**
             * The device's two descriptions, each as large as its caller's
             * dwSize says, which has to be one of the three sizes.
             *
             * @param {any} device @param {number[]} args
             */
            GetCaps: (device, [hal, hel])=>{
                const halSize = (hal >>> 0) === 0 ? 0 : fields.readU32(hal >>> 0);
                const helSize = (hel >>> 0) === 0 ? 0 : fields.readU32(hel >>> 0);
                if (!descriptionAt(hal, halSize) || !descriptionAt(hel, helSize))
                {
                    return DDERR_INVALIDPARAMS;
                }
                const description = device.inner.description;
                const hardware = description.id === DEVICE_IDS.HAL;
                writeDescription(hal, halSize, halSize, hardware ? 'full' : 'empty', description);
                writeDescription(hel, helSize, helSize, hardware ? 'minimal' : 'full',
                    description);
                return D3D_OK;
            },

            /** @param {any} device @param {number[]} args */
            GetStats: (device, [pointer])=>{
                if ((pointer >>> 0) === 0 || fields.readU32(pointer >>> 0) !== D3DSTATS.SIZE)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const stats = device.getStats();
                fields.writeStruct(pointer >>> 0, D3DSTATS, {
                    dwTrianglesDrawn: stats.triangles, dwLinesDrawn: stats.lines,
                    dwPointsDrawn: stats.points, dwSpansDrawn: 0,
                    dwVerticesProcessed: stats.vertices,
                });
                return D3D_OK;
            },

            /** @param {any} device @param {number[]} args */
            AddViewport: (device, [viewport])=>device.addViewport(publisher.objectAt(viewport)),

            /** @param {any} device @param {number[]} args */
            DeleteViewport: (device, [viewport])=>
                device.deleteViewport(publisher.objectAt(viewport)),

            /** @param {any} device @param {number[]} args */
            NextViewport: (device, [from, out, flags])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const { hr, found } = device.nextViewport(publisher.objectAt(from), flags >>> 0);
                if (hr === D3D_OK)
                {
                    fields.writeU32(out >>> 0, pointerTo(found, ids.viewport));
                }
                return hr;
            },

            /** @param {any} device */
            BeginScene: (/** @type {any} */ device)=>device.BeginScene(),
            /** @param {any} device */
            EndScene: (/** @type {any} */ device)=>device.EndScene(),

            /**
             * The Direct3D object is the DirectDraw object the device was
             * made through, under this generation's table and with its count.
             *
             * @param {any} device @param {number[]} args
             */
            GetDirect3D: (device, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                device.root.addRef(ids.d3d);
                fields.writeU32(out >>> 0, pointerTo(device.root, ids.d3d));
                return D3D_OK;
            },

            /** @param {any} device @param {number[]} args */
            SetCurrentViewport: (device, [viewport])=>
                device.setCurrentViewport(publisher.objectAt(viewport)),

            /**
             * No current viewport is an error before the pointer is looked
             * at, and the pointer is left alone (Wine's ddraw4.c
             * test_viewport_object).
             *
             * @param {any} device @param {number[]} args
             */
            GetCurrentViewport: (device, [out])=>{
                const { hr, viewport } = device.getCurrentViewport();
                if (hr !== D3D_OK)
                {
                    return hr;
                }
                if ((out >>> 0) === 0)
                {
                    viewport.release();
                    return DDERR_INVALIDPARAMS;
                }
                fields.writeU32(out >>> 0, pointerTo(viewport, ids.viewport));
                return D3D_OK;
            },

            /** @param {any} device @param {number[]} args */
            SetRenderTarget: (device, [surface])=>
                device.setRenderTarget(publisher.objectAt(surface)),

            /** @param {any} device @param {number[]} args */
            GetRenderTarget: (device, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                /** @type {{ surface?: any }} */
                const held = {};
                device.inner.GetRenderTarget(held);
                fields.writeU32(out >>> 0, pointerTo(held.surface, ids.surface));
                return D3D_OK;
            },

            /** @param {any} device @param {number[]} args */
            Begin: (device, [type, format, flags])=>withFormat(format,
                fvf=>device.begin(type >>> 0, fvf, flags >>> 0)),

            /** @param {any} device @param {number[]} args */
            BeginIndexed: (device, [type, format, vertices, count, flags])=>withFormat(format,
                fvf=>device.beginIndexed(type >>> 0, fvf,
                    readArray(vertices, (count >>> 0) * strideOf(fvf)), flags >>> 0)),

            /** @param {any} device @param {number[]} args */
            Vertex: (device, [vertex])=>{
                const stride = device.beginStride;
                const bytes = stride > 0 ? readArray(vertex, stride) : null;
                return bytes || stride === 0 ? device.vertex(bytes) : DDERR_INVALIDPARAMS;
            },

            /** @param {any} device @param {number[]} args */
            Index: (device, [index])=>device.index(index & 0xffff),

            /** @param {any} device */
            End: (/** @type {any} */ device)=>device.end(),

            /** @param {any} device @param {number[]} args */
            GetRenderState: (device, [state, out])=>{
                /** @type {{ value?: number }} */
                const held = {};
                const hr = device.getRenderState(state >>> 0, held);
                if (hr === D3D_OK && (out >>> 0) !== 0)
                {
                    fields.writeU32(out >>> 0, held.value ?? 0);
                }
                return hr;
            },

            /** @param {any} device @param {number[]} args */
            SetRenderState: (device, [state, value])=>
                device.setRenderState(state >>> 0, value >>> 0),

            /** @param {any} device @param {number[]} args */
            GetLightState: (device, [state, out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                /** @type {{ value?: number }} */
                const held = {};
                const hr = device.getLightState(state >>> 0, held);
                if (hr === D3D_OK)
                {
                    fields.writeU32(out >>> 0, held.value ?? 0);
                }
                return hr;
            },

            /** @param {any} device @param {number[]} args */
            SetLightState: (device, [state, value])=>
                device.setLightState(state >>> 0, value >>> 0),

            /** @param {any} device @param {number[]} args */
            SetTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
                ? DDERR_INVALIDPARAMS
                : device.setTransform(type >>> 0, readFloats(matrix, 16))),

            /** @param {any} device @param {number[]} args */
            GetTransform: (device, [type, out])=>{
                if ((out >>> 0) === 0)
                {
                    return DDERR_INVALIDPARAMS;
                }
                /** @type {{ matrix?: Float32Array }} */
                const held = {};
                const hr = device.getTransform(type >>> 0, held);
                if (hr === D3D_OK && held.matrix)
                {
                    held.matrix.forEach((value, index)=>
                        fields.writeF32((out >>> 0) + index * 4, value));
                }
                return hr;
            },

            /** @param {any} device @param {number[]} args */
            MultiplyTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
                ? DDERR_INVALIDPARAMS
                : device.multiplyTransform(type >>> 0, readFloats(matrix, 16))),

            /** @param {any} device @param {number[]} args */
            DrawPrimitive: (device, [type, format, vertices, count, flags])=>withFormat(format,
                fvf=>device.drawPrimitive(type >>> 0, fvf,
                    readArray(vertices, (count >>> 0) * strideOf(fvf)), count >>> 0,
                    flags >>> 0)),

            /** @param {any} device @param {number[]} args */
            DrawIndexedPrimitive: (device,
                [type, format, vertices, count, indices, indexCount, flags])=>withFormat(format,
                fvf=>device.drawIndexedPrimitive(type >>> 0, fvf,
                    readArray(vertices, (count >>> 0) * strideOf(fvf)), count >>> 0,
                    readArray(indices, (indexCount >>> 0) * 2), indexCount >>> 0,
                    flags >>> 0)),

            SetClipStatus: onInner('SetClipStatus'),
            GetClipStatus: onInner('GetClipStatus'),
        };
    };

    /**
     * The texture formats as IDirect3DDevice and IDirect3DDevice2 name them:
     * a DDSURFACEDESC each, carrying the pixel format, where the third
     * generation hands over the DDPIXELFORMAT alone.
     *
     * @param {number} callback @param {number} context
     */
    const enumerateTextureDescs = (callback, context)=>{
        if ((callback >>> 0) === 0)
        {
            return DDERR_INVALIDPARAMS;
        }
        if (!canEnumerate())
        {
            return D3D_OK;
        }
        const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
        // Whose call this is, before the loop awaits anything.
        const asked = currentThread?.();
        return (async()=>{
            for (const depth of d3d7.textureDepths)
            {
                const at = scratchBlock();
                memory.writeMemory(at, new Uint8Array(DDSURFACEDESC.SIZE));
                writeSurfaceDesc(memory, at, DDSURFACEDESC, {
                    flags: DDSD_CAPS | DDSD_PIXELFORMAT, width: 0, height: 0, pitch: 0,
                    backBufferCount: 0, mipMapCount: 0, caps: DDSCAPS_TEXTURE, caps2: 0,
                    pixelFormat: /** @type {any} */ (pixelFormatForDepth(depth)),
                });
                const answer = await call({ entry: callback >>> 0, args: [at, context >>> 0],
                    thread: asked });
                if ((answer >>> 0) === D3DENUMRET_CANCEL)
                {
                    break;
                }
            }
            return D3D_OK;
        })();
    };

    const device3Methods = {
        ...sharedDeviceMethods(IDS[3], fvf=>fvf),

        EnumTextureFormats: onInner('EnumTextureFormats'),

        /** @param {any} device @param {number[]} args */
        DrawPrimitiveStrided: (device, [type, fvf, data, count, flags])=>device.drawPrimitive(
            type >>> 0, fvf >>> 0, d3d7.gatherStrided(data, fvf, count >>> 0), count >>> 0,
            flags >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveStrided: (device,
            [type, fvf, data, count, indices, indexCount, flags])=>device.drawIndexedPrimitive(
            type >>> 0, fvf >>> 0, d3d7.gatherStrided(data, fvf, count >>> 0), count >>> 0,
            readArray(indices, (indexCount >>> 0) * 2), indexCount >>> 0, flags >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawPrimitiveVB: (device, [type, buffer, start, count, flags])=>device.drawPrimitiveVB(
            type >>> 0, publisher.objectAt(buffer), start >>> 0, count >>> 0, flags >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveVB: (device, [type, buffer, indices, indexCount, flags])=>
            device.drawIndexedPrimitiveVB(type >>> 0, publisher.objectAt(buffer), indices >>> 0,
                indexCount >>> 0, flags >>> 0),

        ComputeSphereVisibility: onInner('ComputeSphereVisibility'),

        /** @param {any} device @param {number[]} args */
        GetTexture: (device, [stage, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.inner.GetTexture(stage >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0,
                    held.surface ? pointerTo(held.surface, IDS[3].texture) : 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetTexture: (device, [stage, texture])=>
            device.setTexture(stage >>> 0, publisher.objectAt(texture)),

        GetTextureStageState: onInner('GetTextureStageState'),

        /** @param {any} device @param {number[]} args */
        SetTextureStageState: (device, [stage, type, value])=>
            device.setTextureStageState(stage >>> 0, type >>> 0, value >>> 0),

        ValidateDevice: onInner('ValidateDevice'),
    };

    /**
     * Two textures trade handles; each must have been given one already
     * (Wine's ddraw2.c test_multiple_devices: E_INVALIDARG until both have).
     *
     * @param {any} device @param {number[]} args
     */
    const swapTextureHandles = (device, [first, second])=>{
        const a = publisher.objectAt(first);
        const b = publisher.objectAt(second);
        return a && b ? textureHandles.swap(a, b) : DDERR_INVALIDPARAMS;
    };

    const device2Methods = {
        ...sharedDeviceMethods(IDS[2], type=>VERTEX_TYPES[type] ?? 0),
        SwapTextureHandles: swapTextureHandles,
        /** @param {any} device @param {number[]} args */
        EnumTextureFormats: (device, [callback, context])=>
            enumerateTextureDescs(callback, context),
    };

    const device3 = describe(IID_IDirect3DDevice3, IDIRECT3DDEVICE3_SLOTS, device3Methods);
    const device2 = describe(IID_IDirect3DDevice2, IDIRECT3DDEVICE2_SLOTS, device2Methods);
    deviceInterfaces[3] = [device3, device2];
    deviceInterfaces[2] = [device2];

    // --- the Direct3D objects, on the DirectDraw object ---

    /**
     * An object made by the Direct3D object: no aggregation, an out-pointer,
     * and the new object published with the reference it was made with.
     *
     * @param {number} out @param {number} outer
     * @param {() => any} make @param {any[]} interfaces @param {string} id
     */
    const create = (out, outer, make, interfaces, id)=>{
        if ((out >>> 0) === 0)
        {
            return DDERR_INVALIDPARAMS;
        }
        if ((outer >>> 0) !== 0)
        {
            return CLASS_E_NOAGGREGATION;
        }
        handBack(out, make(), interfaces, id);
        return D3D_OK;
    };

    /**
     * A device on a render target, for any version, published as `id`.
     *
     * @param {any} root @param {number} riid @param {number} surface @param {number} out
     * @param {1 | 2 | 3} version @param {string} id
     */
    const createDevice = (root, riid, surface, out, version, id)=>{
        if ((riid >>> 0) === 0 || (out >>> 0) === 0)
        {
            return DDERR_INVALIDPARAMS;
        }
        const made = legacyFor(root).createDevice(readGuid(memory, riid >>> 0),
            publisher.objectAt(surface), version);
        if (made.hr !== D3D_OK)
        {
            fields.writeU32(out >>> 0, 0);
            return made.hr;
        }
        made.device.root = root;
        handBack(out, made.device, deviceInterfaces[version], id);
        return D3D_OK;
    };

    const direct3D3Methods = {
        /** @param {any} root @param {number[]} args */
        EnumDevices: (root, [callback, context])=>
            enumerateDevices(root, callback, context, D3DDEVICEDESC.SIZE),

        /** @param {any} root @param {number[]} args */
        CreateLight: (root, [out, outer])=>create(out, outer,
            ()=>legacyFor(root).createLight(), lightInterfaces, IID_IDirect3DLight),

        /** @param {any} root @param {number[]} args */
        CreateMaterial: (root, [out, outer])=>create(out, outer,
            ()=>legacyFor(root).createMaterial(), materialInterfaces, IID_IDirect3DMaterial3),

        /** @param {any} root @param {number[]} args */
        CreateViewport: (root, [out, outer])=>create(out, outer,
            ()=>legacyFor(root).createViewport(), viewportInterfaces, IID_IDirect3DViewport3),

        /** @param {any} root @param {number[]} args */
        FindDevice: (root, [search, result])=>
            findDevice(root, search, result, D3DDEVICEDESC.SIZE),

        /** @param {any} root @param {number[]} args */
        CreateDevice: (root, [riid, surface, out, outer])=>((outer >>> 0) !== 0
            ? CLASS_E_NOAGGREGATION
            : createDevice(root, riid, surface, out, 3, IID_IDirect3DDevice3)),

        /**
         * The flags say whether the buffer is clipped, which a buffer of
         * vertices that the renderer clips anyway does not need to know.
         *
         * @param {any} root @param {number[]} args
         */
        CreateVertexBuffer: (root, [desc, out, , outer])=>{
            if ((desc >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if ((outer >>> 0) !== 0)
            {
                return CLASS_E_NOAGGREGATION;
            }
            const raw = fields.readStruct(desc >>> 0, D3DVERTEXBUFFERDESC);
            if (raw.dwSize !== D3DVERTEXBUFFERDESC.SIZE)
            {
                return DDERR_INVALIDPARAMS;
            }
            const made = legacyFor(root).createVertexBuffer({
                caps: raw.dwCaps, fvf: raw.dwFVF, numVertices: raw.dwNumVertices,
            });
            if (made.hr !== D3D_OK)
            {
                return made.hr;
            }
            handBack(out, made.buffer, bufferInterfaces, IID_IDirect3DVertexBuffer);
            return D3D_OK;
        },

        EnumZBufferFormats: d3dMethods.EnumZBufferFormats,
        EvictManagedTextures: ()=>D3D_OK,
    };

    /**
     * DirectX 5's object: the same calls with its own descriptions' size,
     * its own generations of what they make, and a device made on an
     * IDirectDrawSurface with no outer unknown to refuse.
     */
    const direct3D2Methods = {
        /** @param {any} root @param {number[]} args */
        EnumDevices: (root, [callback, context])=>
            enumerateDevices(root, callback, context, D3DDEVICEDESC.SIZE_V2),

        CreateLight: direct3D3Methods.CreateLight,

        /** @param {any} root @param {number[]} args */
        CreateMaterial: (root, [out, outer])=>create(out, outer,
            ()=>legacyFor(root).createMaterial(), materialInterfaces, IID_IDirect3DMaterial2),

        /** @param {any} root @param {number[]} args */
        CreateViewport: (root, [out, outer])=>create(out, outer,
            ()=>legacyFor(root).createViewport(), viewportInterfaces, IID_IDirect3DViewport2),

        /** @param {any} root @param {number[]} args */
        FindDevice: (root, [search, result])=>
            findDevice(root, search, result, D3DDEVICEDESC.SIZE_V2),

        /** @param {any} root @param {number[]} args */
        CreateDevice: (root, [riid, surface, out])=>
            createDevice(root, riid, surface, out, 2, IID_IDirect3DDevice2),
    };

    return {
        /** The descriptors the DirectDraw seam puts beside its own generations. */
        interfaces: [
            describe(IID_IDirect3D3, IDIRECT3D3_SLOTS, direct3D3Methods),
            describe(IID_IDirect3D2, IDIRECT3D2_SLOTS, direct3D2Methods),
        ],

        /** And beside a surface's. */
        surfaceInterfaces: textureInterfaces,

        /** For tests, which have no guest to call through. */
        objects: {
            device: deviceInterfaces, viewport: viewportInterfaces, light: lightInterfaces,
            material: materialInterfaces, buffer: bufferInterfaces, texture: textureInterfaces,
        },
    };
}
