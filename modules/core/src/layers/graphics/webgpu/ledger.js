/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a WebGPU device holds: every buffer and texture made on it and not yet
 * let go, counted and weighed, by the label it was made with.
 *
 * The GPU process's memory is the one part of a run nothing else in the
 * engine accounts for, and a run whose GPU process grows by gigabytes is either
 * a game streaming its art in or resources made and never destroyed; the two
 * look the same from outside. Here each one is weighed when it is made and
 * taken off when it is destroyed -- or, for one dropped without destroy(),
 * when the collector takes its wrapper, which is when the browser frees it,
 * and counted apart: memory held until a collection the engine does not
 * control.
 *
 * A texture's weight is its texels at every level and layer at the format's
 * size, times its samples; a compressed format by its block's bytes. A format
 * not listed is weighed at four bytes a texel and said so (`unweighed`).
 */

/** Bytes a texel, or a block's bytes over its texels for a compressed format. */
const FORMAT_BYTES = Object.freeze({
    r8unorm: 1, r8snorm: 1, r8uint: 1, r8sint: 1, stencil8: 1,
    r16uint: 2, r16sint: 2, r16float: 2, rg8unorm: 2, rg8snorm: 2, rg8uint: 2, rg8sint: 2,
    depth16unorm: 2,
    r32uint: 4, r32sint: 4, r32float: 4, rg16uint: 4, rg16sint: 4, rg16float: 4,
    rgba8unorm: 4, 'rgba8unorm-srgb': 4, rgba8snorm: 4, rgba8uint: 4, rgba8sint: 4,
    bgra8unorm: 4, 'bgra8unorm-srgb': 4, rgb10a2unorm: 4, rgb10a2uint: 4, rg11b10ufloat: 4,
    rgb9e5ufloat: 4, depth24plus: 4, 'depth24plus-stencil8': 4, depth32float: 4,
    'depth32float-stencil8': 5,
    rg32uint: 8, rg32sint: 8, rg32float: 8, rgba16uint: 8, rgba16sint: 8, rgba16float: 8,
    rgba32uint: 16, rgba32sint: 16, rgba32float: 16,
    'bc1-rgba-unorm': 0.5, 'bc1-rgba-unorm-srgb': 0.5, 'bc4-r-unorm': 0.5, 'bc4-r-snorm': 0.5,
    'bc2-rgba-unorm': 1, 'bc2-rgba-unorm-srgb': 1, 'bc3-rgba-unorm': 1, 'bc3-rgba-unorm-srgb': 1,
    'bc5-rg-unorm': 1, 'bc5-rg-snorm': 1, 'bc6h-rgb-ufloat': 1, 'bc6h-rgb-float': 1,
    'bc7-rgba-unorm': 1, 'bc7-rgba-unorm-srgb': 1,
});

/**
 * @typedef {{ count: number, bytes: number }} Weight
 */

/**
 * The texture's bytes, every level and layer.
 *
 * @param {any} descriptor
 * @returns {{ bytes: number, weighed: boolean }}
 */
export function textureBytes(descriptor){
    const size = descriptor?.size ?? {};
    const width = Number(Array.isArray(size) ? size[0] : size.width) || 1;
    const height = Number(Array.isArray(size) ? size[1] : size.height) || 1;
    const layers = Number(Array.isArray(size) ? size[2] : size.depthOrArrayLayers) || 1;
    const levels = Number(descriptor?.mipLevelCount) || 1;
    const samples = Number(descriptor?.sampleCount) || 1;
    const perTexel = FORMAT_BYTES[/** @type {keyof typeof FORMAT_BYTES} */ (descriptor?.format)];
    const compressed = perTexel !== undefined && perTexel < 1 || /^(bc|etc2|eac|astc)/.test(
        String(descriptor?.format ?? ''));
    let texels = 0;
    for (let level = 0; level < levels; level++)
    {
        const w = Math.max(1, width >> level);
        const h = Math.max(1, height >> level);
        // A compressed level is whole 4x4 blocks however small it gets.
        texels += compressed ? Math.ceil(w / 4) * 4 * Math.ceil(h / 4) * 4 : w * h;
    }
    const depth = descriptor?.dimension === '3d' ? layers : 1;
    const arrays = descriptor?.dimension === '3d' ? 1 : layers;
    // A 3d texture's depth halves with each level as its sides do; counted
    // whole at every level, which overstates a mipmapped volume and nothing else.
    return { bytes: texels * depth * arrays * samples * (perTexel ?? 4),
        weighed: perTexel !== undefined };
}

/**
 * Starts weighing what the device makes. The device's own createBuffer and
 * createTexture are wrapped on the instance; nothing else about it changes.
 *
 * @param {any} device
 */
export function trackDevice(device){
    /** @type {Map<string, Weight>} */
    const buffers = new Map();
    /** @type {Map<string, Weight>} */
    const textures = new Map();
    const dropped = { buffers: 0, bufferBytes: 0, textures: 0, textureBytes: 0 };
    const made = { buffers: 0, textures: 0, unweighed: 0 };

    /** @param {Map<string, Weight>} into @param {string} label @param {number} bytes @param {number} sign */
    const weigh = (into, label, bytes, sign)=>{
        const held = into.get(label) ?? { count: 0, bytes: 0 };
        held.count += sign;
        held.bytes += sign * bytes;
        if (held.count <= 0)
        {
            into.delete(label);
        }
        else
        {
            into.set(label, held);
        }
    };

    /** @typedef {{ kind: 'buffer' | 'texture', label: string, bytes: number, gone: boolean }} Held */
    const collected = new FinalizationRegistry((/** @type {Held} */ held)=>{
        if (held.gone)
        {
            return;
        }
        held.gone = true;
        weigh(held.kind === 'buffer' ? buffers : textures, held.label, held.bytes, -1);
        if (held.kind === 'buffer')
        {
            dropped.buffers++;
            dropped.bufferBytes += held.bytes;
        }
        else
        {
            dropped.textures++;
            dropped.textureBytes += held.bytes;
        }
    });

    /** @param {any} resource @param {Held} held */
    const follow = (resource, held)=>{
        weigh(held.kind === 'buffer' ? buffers : textures, held.label, held.bytes, 1);
        collected.register(resource, held);
        const destroy = resource.destroy;
        resource.destroy = function(){
            if (!held.gone)
            {
                held.gone = true;
                weigh(held.kind === 'buffer' ? buffers : textures, held.label, held.bytes, -1);
            }
            return destroy.call(this);
        };
        return resource;
    };

    const createBuffer = device.createBuffer.bind(device);
    device.createBuffer = (/** @type {any} */ descriptor)=>{
        made.buffers++;
        return follow(createBuffer(descriptor), { kind: 'buffer',
            label: String(descriptor?.label || `usage 0x${(descriptor?.usage ?? 0).toString(16)}`),
            bytes: Number(descriptor?.size) || 0, gone: false });
    };
    const createTexture = device.createTexture.bind(device);
    device.createTexture = (/** @type {any} */ descriptor)=>{
        made.textures++;
        const { bytes, weighed } = textureBytes(descriptor);
        if (!weighed)
        {
            made.unweighed++;
        }
        return follow(createTexture(descriptor), { kind: 'texture',
            label: String(descriptor?.label || descriptor?.format || 'texture'), bytes,
            gone: false });
    };

    /** @param {Map<string, Weight>} from */
    const total = from=>[...from.values()].reduce((sum, held)=>({
        count: sum.count + held.count, bytes: sum.bytes + held.bytes }), { count: 0, bytes: 0 });
    /** @param {Map<string, Weight>} from */
    const heaviest = from=>[...from].sort((a, b)=>b[1].bytes - a[1].bytes).slice(0, 12)
        .map(([label, held])=>`${label}: ${held.count} ${(held.bytes / 2 ** 20).toFixed(1)} MB`);

    return {
        device,
        /** Live buffers and textures by count and bytes, the heaviest labels, and what was dropped. */
        diagnostics: ()=>({
            buffers: total(buffers),
            textures: total(textures),
            heaviestBuffers: heaviest(buffers),
            heaviestTextures: heaviest(textures),
            made: { ...made },
            droppedWithoutDestroy: { ...dropped },
        }),
    };
}
