/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The objects a context owns, and the group that owns them jointly.
 *
 * Objects do not belong to a context; they belong to a **share group**, and a
 * context names one. That is the whole content of `wglShareLists`, and getting
 * it wrong is invisible until a program creates a texture in one context and
 * draws it from another.
 *
 * Four properties of the group are contract and were established by
 * measurement:
 *
 * - **Namespaces are per object type.** Texture 1 and display list 1 are
 *   different things and both exist at once. Asking whether a texture name is
 *   a list is not an error; the answer is simply no.
 * - **Names are the lowest unused ones**, starting at one. Zero is never
 *   generated: it is the default object of each texture target.
 * - **A generated texture name is not yet a texture.** `glIsTexture` says no
 *   until the name has been bound, because binding is what brings the object
 *   into existence. Display lists are the opposite -- `glGenLists` creates
 *   them empty, and they answer yes immediately.
 * - **A group that has ever held an object can never be replaced.** Sharing
 *   into it fails, and it goes on failing after every object in it has been
 *   deleted, so the flag is "was ever used" and not "is empty now".
 *
 * The objects survive the context that created them for as long as any context
 * in the group is alive.
 */

import { GL } from './constants.js';

/**
 * An incomplete texture -- one whose minification filter wants mipmaps it
 * does not have -- is not an error and is not reported anywhere. Its unit
 * draws as if texturing were off, which is why an unfiltered upload shows up
 * as untextured white rather than as black or as a fault.
 */

/**
 * The four minification filters that need a complete mipmap pyramid. The
 * default, GL_NEAREST_MIPMAP_LINEAR, is one of them, which is why a texture
 * that was given a single level and no parameters samples black.
 */
/** @type {Set<number>} */
const MIPMAP_FILTERS = new Set([
    GL.NEAREST_MIPMAP_NEAREST,
    GL.LINEAR_MIPMAP_NEAREST,
    GL.NEAREST_MIPMAP_LINEAR,
    GL.LINEAR_MIPMAP_LINEAR,
]);

/**
 * @typedef {Object} TextureLevel
 * @property {number} width
 * @property {number} height
 * @property {number} internalFormat
 * @property {number} border
 * @property {number} baseFormat   what the internal format reduces to
 * @property {Uint8Array | null} texels   RGBA, or null when the level was
 *           given a shape and no data
 * @property {number} [compressedFormat]  the S3TC format the data arrived in
 * @property {number} [compressedBytes]   and how many bytes it took
 * @property {{ format: number, bytes: Uint8Array } | null} [compressed]
 *           the S3TC blocks as the guest gave them, kept alongside the
 *           decoded texels so a device that samples the blocks directly
 *           never has to decode what it can upload as-is
 * @property {number} [depth]  a 3D level's depth or an array level's layers; one if absent
 * @property {import('./formats.js').SizedFormat | null} [sized]  the format a level is
 *           kept as its own bytes in (`formats.js`), or absent for one kept as RGBA
 * @property {Uint8Array | null} [data]  that format's bytes, slices one after another,
 *           or null where this context keeps none
 * @property {TextureLevel} [source]  the level a texture view's level reads its bytes
 *           from (`texture-views.js`)
 */

/**
 * A rectangle of a level written since the GPU copy last read it, in the
 * level's own pixels. `null` (as the map's value, not this type) means the
 * whole level -- see `markDirty`.
 *
 * @typedef {Object} DirtyRect
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} TextureObject
 * @property {number} name
 * @property {number} target
 * @property {Map<number, number>} parameters
 * @property {number} parametersVersion  bumped by every `glTexParameter*` write,
 *           so a cache keyed on the texture can tell a stale sampler from a
 *           current one without re-deriving it
 * @property {number[]} borderColour
 * @property {Map<number, TextureLevel>} levels  keyed by `levelKey`
 * @property {{ buffer: number, internal: number, offset: number, size: number | null,
 *     version: number }} [store]  a buffer texture's (3.1): the buffer object its texels
 *           are, in which format, over which range (null: to its end), and the
 *           buffer's version the level was last made from
 * @property {{ samples: number, fixed: boolean }} [multisample]  a multisample texture's
 *           (3.2): the samples asked and whether their locations are fixed
 * @property {Map<number, DirtyRect[] | null>} dirty   the level keys written
 *           since a copy kept elsewhere last read them, each with the
 *           rectangles written or `null` for the whole level
 * @property {{ root: TextureObject, minLevel: number, numLevels: number, minLayer: number,
 *     numLayers: number, internal: number }} [view]  a texture view's (4.3): the
 *           texture whose storage it reads, the range of its levels and layers, and
 *           its own internal format (`texture-views.js`)
 */

/**
 * @typedef {Object} BufferObject
 * @property {number} name
 * @property {number} size
 * @property {number} usage
 * @property {number} access
 * @property {Uint8Array} data
 * @property {boolean} [captured]  transform feedback has written it on the device
 * @property {boolean} immutable  its store was made by glBufferStorage (4.4)
 * @property {number} storageFlags  GL_BUFFER_STORAGE_FLAGS: what the store may be
 *           mapped for and whether glBufferSubData may write it
 * @property {number} mapped  the guest address it is mapped at, or zero
 * @property {number} mapBlock  the guest memory the map was given, to give back
 * @property {number} accessFlags  the MAP_*_BIT a map asked for, zero when not mapped
 * @property {number} mapOffset  where the mapped range starts in the store
 * @property {number} mapLength  how many bytes are mapped
 * @property {{ start: number, end: number }[]} flushed  the ranges of an explicitly
 *           flushed map written back so far, relative to the store
 * @property {{ start: number, end: number } | null} written   the bytes the
 *           program has rewritten since a copy kept elsewhere last read them
 * @property {number} version  raised on every glBufferDataARB, glBufferSubDataARB
 *           or write-back unmap, so a reader of its bytes elsewhere -- the
 *           index scan cache in gpu.js -- can tell a redefined or rewritten
 *           buffer from the one it already scanned
 */

/** Cube map levels are kept in one map, six faces apart. */
export const FACE_STRIDE = 32;

/**
 * @param {number} level
 * @param {number} [face]  0..5 for a cube map
 * @returns {number}
 */
export function levelKey(level, face = 0){
    return face * FACE_STRIDE + level;
}

/**
 * @typedef {Object} ProgramObject
 * @property {number} name
 * @property {number} target   the target it belongs to; zero until first bound
 * @property {number} format   the format its string was given in; zero unloaded
 * @property {string} text     the program string as it was given
 * @property {import('./arb-program.js').ParsedProgram | null} parsed
 * @property {number} version  raised on every successful load, so a pipeline
 *           keyed on the object is rebuilt when its string is replaced
 * @property {Float32Array} local   the local parameters, four floats each
 * @property {number} localVersion  raised only when a local parameter write
 *           actually changes a value, never on one that repeats it
 */

/**
 * A program object: empty and targetless until it is bound, its string the
 * last one that loaded -- a failed load leaves what was there before.
 *
 * @param {number} name
 * @param {number} target
 * @param {number} localParameters
 * @returns {ProgramObject}
 */
export function createProgramObject(name, target, localParameters){
    return {
        name,
        target,
        format: 0,
        text: '',
        parsed: null,
        version: 0,
        local: new Float32Array(localParameters * 4),
        // Bumped only when a glProgramLocalParameter4fARB write actually
        // changes a value, never on a call that repeats it -- the uniform
        // cache in gpu.js reads this to skip a rebuild that would land the
        // same bytes it already has.
        localVersion: 0,
    };
}

/**
 * @typedef {Object} DisplayList
 * @property {number} name
 * @property {{ call: string, args: any[] }[]} commands
 */

/**
 * Per-object-type parameter defaults. GL_TEXTURE_MIN_FILTER is the one that
 * matters far more than the others.
 *
 * @type {ReadonlyArray<readonly [number, number]>}
 */
export const DEFAULT_TEXTURE_PARAMETERS = Object.freeze([
    [GL.TEXTURE_MIN_FILTER, GL.NEAREST_MIPMAP_LINEAR],
    [GL.TEXTURE_MAG_FILTER, GL.LINEAR],
    [GL.TEXTURE_WRAP_S, GL.REPEAT],
    [GL.TEXTURE_WRAP_T, GL.REPEAT],
    [GL.TEXTURE_WRAP_R, GL.REPEAT],
    [GL.TEXTURE_BASE_LEVEL, 0],
    [GL.TEXTURE_MAX_LEVEL, 1000],
    [GL.TEXTURE_MIN_LOD, -1000],
    [GL.TEXTURE_MAX_LOD, 1000],
    [GL.TEXTURE_LOD_BIAS, 0],
    [GL.TEXTURE_PRIORITY, 1],
    [GL.GENERATE_MIPMAP, 0],
    // OpenGL 1.4's depth textures (ARB_shadow, ARB_depth_texture): no
    // comparison, LEQUAL when there is one, a depth read as luminance.
    [0x884c, GL.NONE],
    [0x884d, GL.LEQUAL],
    [0x884b, GL.LUMINANCE],
    // OpenGL 4.6's anisotropy (EXT/ARB_texture_filter_anisotropic): none.
    [GL.TEXTURE_MAX_ANISOTROPY, 1],
    // OpenGL 3.3's swizzle (GL_ARB_texture_swizzle): each component its own.
    [GL.TEXTURE_SWIZZLE_R, GL.RED],
    [GL.TEXTURE_SWIZZLE_G, GL.GREEN],
    [GL.TEXTURE_SWIZZLE_B, GL.BLUE],
    [GL.TEXTURE_SWIZZLE_A, GL.ALPHA],
]);

/**
 * What a rectangle texture (3.1) starts with: one level, so a filter without
 * mipmaps, and coordinates clamped to its edges (3.1 section 3.8.8).
 *
 * @type {ReadonlyArray<readonly [number, number]>}
 */
const RECTANGLE_PARAMETERS = Object.freeze(DEFAULT_TEXTURE_PARAMETERS.map(([name, value])=>
    /** @type {const} */ ([name, name === GL.TEXTURE_MIN_FILTER ? GL.LINEAR
        : name === GL.TEXTURE_WRAP_S || name === GL.TEXTURE_WRAP_T || name === GL.TEXTURE_WRAP_R
            ? GL.CLAMP_TO_EDGE : value])));

/**
 * What a buffer texture (3.1) or a multisample one (3.2) holds of sampling
 * state: none a program can set; its one level is read texel by texel,
 * which these filters keep complete.
 *
 * @type {ReadonlyArray<readonly [number, number]>}
 */
const BUFFER_PARAMETERS = Object.freeze(DEFAULT_TEXTURE_PARAMETERS.map(([name, value])=>
    /** @type {const} */ ([name, name === GL.TEXTURE_MIN_FILTER || name === GL.TEXTURE_MAG_FILTER
        ? GL.NEAREST : value])));

/**
 * How wide a buffer texture's level is (3.1): its texels lie in rows of this
 * many, WebGPU's least 2D extent, the last row short of it.
 */
export const BUFFER_ROW = 8192;

/** The swizzle parameters, red to alpha. */
const SWIZZLES = [GL.TEXTURE_SWIZZLE_R, GL.TEXTURE_SWIZZLE_G, GL.TEXTURE_SWIZZLE_B,
    GL.TEXTURE_SWIZZLE_A];

/** What a swizzle source is called in a code: a component or a constant. */
/** @type {ReadonlyMap<number, string>} */
const SWIZZLE_LETTERS = new Map([[GL.RED, 'r'], [GL.GREEN, 'g'], [GL.BLUE, 'b'],
    [GL.ALPHA, 'a'], [GL.ZERO, '0'], [GL.ONE, '1']]);

/**
 * A texture's swizzle (3.3) as four letters, red's source to alpha's: `r`,
 * `g`, `b`, `a`, `0` or `1`; empty for the identity, which every reader
 * skips.
 *
 * @param {Map<number, number>} parameters
 * @returns {string}
 */
export function swizzleCode(parameters){
    const code = SWIZZLES.map(name=>SWIZZLE_LETTERS.get(parameters.get(name) ?? GL.RED) ?? 'r')
        .join('');
    return code === 'rgba' ? '' : code;
}

/**
 * A texel swizzled by a code: each component its source's, a constant zero
 * or `one` (1 for a normalised read, 255 for one of bytes).
 *
 * @param {readonly number[]} texel @param {string} code @param {number} one
 * @returns {number[]}
 */
export function swizzleTexel(texel, code, one){
    return [...code].map(letter=>(letter === '0' ? 0 : letter === '1' ? one
        : texel['rgba'.indexOf(letter)]));
}

/**
 * @param {number} name
 * @param {number} target
 * @returns {TextureObject}
 */
export function createTextureObject(name, target){
    return {
        name,
        target,
        parameters: new Map(target === GL.TEXTURE_RECTANGLE ? RECTANGLE_PARAMETERS
            : target === GL.TEXTURE_BUFFER || target === GL.TEXTURE_2D_MULTISAMPLE
                || target === GL.TEXTURE_2D_MULTISAMPLE_ARRAY ? BUFFER_PARAMETERS
                : DEFAULT_TEXTURE_PARAMETERS),
        parametersVersion: 0,
        borderColour: [0, 0, 0, 0],
        levels: new Map(),
        dirty: new Map(),
    };
}

/**
 * The smallest rectangle covering both.
 *
 * @param {DirtyRect} a
 * @param {DirtyRect} b
 * @returns {DirtyRect}
 */
export function unionRect(a, b){
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
}

/**
 * Records that a level's rectangle needs to reach the GPU copy. `null`
 * (a full redefine, or a rectangle wide enough to say "the whole level" would
 * be) always wins over a smaller rectangle recorded before or after it, so a
 * later small write never shrinks what an earlier full upload already
 * promised to send.
 *
 * Rectangles are kept apart, not joined into one around them: where the
 * device's copy is the only whole one (its texels let go here, or drawn on the
 * device), what lies between two writes is not this side's to send -- a font
 * atlas filled a glyph at a time would go up with every glyph before the last
 * one blanked. One inside another is dropped.
 *
 * @param {TextureObject} texture
 * @param {number} key
 * @param {DirtyRect | null} rect
 */
export function markDirty(texture, key, rect){
    const existing = texture.dirty.get(key);
    if (existing === null || rect === null)
    {
        texture.dirty.set(key, null);
        return;
    }
    if (existing === undefined)
    {
        texture.dirty.set(key, [rect]);
        return;
    }
    if (existing.some(held=>contains(held, rect)))
    {
        return;
    }
    texture.dirty.set(key, [...existing.filter(held=>!contains(rect, held)), rect]);
}

/**
 * @param {DirtyRect} outer @param {DirtyRect} inner
 * @returns {boolean}
 */
function contains(outer, inner){
    return inner.x >= outer.x && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height;
}

/**
 * @param {number} name
 * @returns {BufferObject}
 */
export function createBufferObject(name){
    return { name, size: 0, usage: GL.STATIC_DRAW, access: GL.READ_WRITE, data: new Uint8Array(0),
        immutable: false, storageFlags: 0, mapped: 0, mapBlock: 0, accessFlags: 0, mapOffset: 0,
        mapLength: 0, flushed: [], written: null,
        version: 1 };
}

/**
 * Whether a texture can be sampled at all (2.1 section 3.8.10): its base
 * level, GL_TEXTURE_BASE_LEVEL, defined; a cube's six base images square, of
 * one size, internal format and border; and, where the minification filter
 * wants mipmaps, every level from the base to the last the chain or
 * GL_TEXTURE_MAX_LEVEL allows, each half the one above (a border not
 * counted) in the base's format and border. Levels below the base are not
 * looked at.
 *
 * @param {TextureObject} texture
 * @returns {boolean}
 */
export function isTextureComplete(texture){
    const faces = texture.target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
    const first = texture.parameters.get(GL.TEXTURE_BASE_LEVEL) ?? 0;
    const base = texture.levels.get(levelKey(first));
    if (!base || base.width === 0 || base.height === 0)
    {
        return false;
    }
    const [width, height, depth] = interiorOf(texture.target, base);
    const mipmapped = MIPMAP_FILTERS.has(texture.parameters.get(GL.TEXTURE_MIN_FILTER) ?? 0);
    const last = texture.parameters.get(GL.TEXTURE_MAX_LEVEL) ?? 1000;
    if (mipmapped && first > last)
    {
        return false;
    }
    // A 3D texture's depth halves with its levels; an array's layers do not.
    const solid = texture.target === GL.TEXTURE_3D;
    const layeredRows = texture.target === 0x8c18;
    /** @param {TextureLevel | undefined} image @param {number[]} size */
    const matches = (image, size)=>!!image && image.internalFormat === base.internalFormat
        && (image.border ?? 0) === (base.border ?? 0)
        && interiorOf(texture.target, image).every((extent, k)=>extent === size[k]);
    for (let face = 0; face < faces; face++)
    {
        if (!matches(texture.levels.get(levelKey(first, face)), [width, height, depth])
            || (faces > 1 && width !== height))
        {
            return false;
        }
        if (!mipmapped)
        {
            continue;
        }
        // The chain ends at 1 on every axis that halves, or at MAX_LEVEL.
        const levels = Math.floor(Math.log2(Math.max(width, layeredRows ? 1 : height,
            solid ? depth : 1)));
        for (let step = 1; step <= Math.min(levels, last - first); step++)
        {
            const size = [Math.max(1, width >> step),
                layeredRows ? height : Math.max(1, height >> step),
                solid ? Math.max(1, depth >> step) : depth];
            if (!matches(texture.levels.get(levelKey(first + step, face)), size))
            {
                return false;
            }
        }
    }
    return true;
}

/**
 * The level a texture is sampled from first, GL_TEXTURE_BASE_LEVEL (3.8.8).
 *
 * @param {TextureObject} texture @param {number} [face]
 * @returns {TextureLevel | undefined}
 */
export function baseLevelOf(texture, face = 0){
    return texture.levels.get(levelKey(texture.parameters.get(GL.TEXTURE_BASE_LEVEL) ?? 0, face));
}

/**
 * A level's extent without its border (1.x, section 3.8.1): the border is
 * on both sides of each dimension the target has, so a 1D image's height
 * and an array's layers carry none.
 *
 * @param {number} target @param {TextureLevel} image
 * @returns {number[]} width, height and depth
 */
export function interiorOf(target, image){
    const border = image.border ?? 0;
    const flat = target === GL.TEXTURE_1D || target === 0x8c18;
    return [image.width - 2 * border, image.height - (flat ? 0 : 2 * border),
        (image.depth ?? 1) - (target === GL.TEXTURE_3D ? 2 * border : 0)];
}

/**
 * A namespace of names, handing out the lowest unused one. `reserved` holds
 * names that have been generated but do not name an object yet, which is the
 * state a texture name is in between glGenTextures and its first glBindTexture.
 */
function createNamespace(){
    /** @type {Map<number, any>} */
    const objects = new Map();
    /** @type {Set<number>} */
    const reserved = new Set();

    /** @returns {number} */
    const lowestUnused = ()=>{
        let name = 1;
        while (objects.has(name) || reserved.has(name))
        {
            name++;
        }
        return name;
    };

    return {
        objects,
        reserved,

        /** @param {number} count @returns {number[]} */
        reserve(count){
            /** @type {number[]} */
            const names = [];
            for (let i = 0; i < count; i++)
            {
                const name = lowestUnused();
                reserved.add(name);
                names.push(name);
            }
            return names;
        },

        /**
         * A contiguous run, which is what glGenLists promises and what a
         * program relies on when it adds a character code to the first name.
         *
         * @param {number} count
         * @returns {number}
         */
        reserveRange(count){
            let first = 1;
            for (;;)
            {
                let free = true;
                for (let i = 0; i < count; i++)
                {
                    if (objects.has(first + i) || reserved.has(first + i))
                    {
                        free = false;
                        break;
                    }
                }
                if (free)
                {
                    return first;
                }
                first++;
            }
        },

        /** @param {number} name @param {any} object */
        define(name, object){
            reserved.delete(name);
            objects.set(name, object);
        },

        /** @param {number} name */
        remove(name){
            objects.delete(name);
            reserved.delete(name);
        },
    };
}

/**
 * @typedef {ReturnType<typeof createShareGroup>} ShareGroup
 */

/**
 * @returns {{ textures: ReturnType<typeof createNamespace>,
 *             lists: ReturnType<typeof createNamespace>,
 *             buffers: ReturnType<typeof createNamespace>,
 *             programs: ReturnType<typeof createNamespace>,
 *             glsl: ReturnType<typeof createNamespace>,
 *             renderbuffers: ReturnType<typeof createNamespace>,
 *             framebuffers: Map<number, FramebufferObject | null>,
 *             contexts: number, used: boolean }}
 */
export function createShareGroup(){
    return {
        textures: createNamespace(),
        lists: createNamespace(),
        buffers: createNamespace(),
        programs: createNamespace(),
        // OpenGL 2.0's shaders and programs, which share one namespace.
        glsl: createNamespace(),
        renderbuffers: createNamespace(),
        /**
         * Framebuffer objects, as GL_EXT_framebuffer_object shares them; a
         * generated name holds null until it is first bound.
         *
         * @type {Map<number, FramebufferObject | null>}
         */
        framebuffers: new Map(),
        /** How many contexts name this group. The objects outlive all but the last. */
        contexts: 0,
        /**
         * Sticky: set the first time anything is created here, and never
         * cleared. wglShareLists refuses a destination whose group is used,
         * and goes on refusing after the objects are gone.
         */
        used: false,
    };
}

/**
 * @typedef {Object} RenderbufferObject
 * @property {number} name
 * @property {number} width
 * @property {number} height
 * @property {number} internalFormat  zero before its first storage
 * @property {number} samples
 * @property {number} version  raised by every glRenderbufferStorage
 */

/**
 * The array targets, whose layers are one level each (a 1D array's its
 * rows): GL_TEXTURE_1D_ARRAY, 2D_ARRAY, CUBE_MAP_ARRAY, 2D_MULTISAMPLE_ARRAY.
 *
 * @type {ReadonlySet<number>}
 */
export const LAYERED_TARGETS = new Set([0x8c18, 0x8c1a, 0x9009, 0x9102]);

/**
 * The level an attached texture image is in: a cube map's face its own, an
 * array's layer (`face`) one of its level's.
 *
 * @param {{ texture: TextureObject, level: number, face: number }} attachment
 */
export function attachedLevelKey(attachment){
    return LAYERED_TARGETS.has(attachment.texture.target) ? levelKey(attachment.level)
        : levelKey(attachment.level, attachment.face);
}

/**
 * A texture attachment is layered (3.2) when a cube map or an array was
 * attached whole: a geometry shader's gl_Layer chooses which face or layer a
 * primitive is drawn into, the first by default.
 *
 * @typedef {{ kind: 'texture', texture: TextureObject, level: number,
 *     face: number, layered?: boolean } | { kind: 'renderbuffer',
 *     renderbuffer: RenderbufferObject }} Attachment
 */

/**
 * How many layers an attachment is drawn into: a layered one's cube faces or
 * array layers, one for any other.
 *
 * @param {Attachment} attachment
 * @returns {number}
 */
export function attachmentLayers(attachment){
    if (attachment.kind !== 'texture' || !attachment.layered)
    {
        return 1;
    }
    if (attachment.texture.target === GL.TEXTURE_CUBE_MAP)
    {
        return 6;
    }
    return attachment.texture.levels.get(attachedLevelKey(attachment))?.depth ?? 1;
}

/**
 * A sampler object (3.3): its parameters as a texture keeps its own, so
 * whoever reads one reads the other the same way (`gpu.js` samplerFor).
 *
 * @typedef {{ name: number, parameters: Map<number, number>, parametersVersion: number,
 *     borderColour: number[] }} SamplerObject
 */

/**
 * @typedef {Object} FramebufferObject
 * @property {number} name
 * @property {Map<number, Attachment>} attachments  by attachment point
 * @property {number[]} drawBuffers  per draw buffer: an attachment point or GL_NONE
 * @property {number} readBuffer
 * @property {number} version  raised by every change of what it draws into
 * @property {{ width: number, height: number, layers: number, samples: number,
 *     fixed: number }} defaults  what it is without attachments
 *     (GL_ARB_framebuffer_no_attachments)
 */

/** The internal formats a renderbuffer takes, and what each holds. */
/** @type {Map<number, 'colour' | 'depth' | 'stencil' | 'depthStencil'>} */
export const RENDERBUFFER_FORMATS = new Map([
    [GL.RGBA, 'colour'], [GL.RGB, 'colour'], [GL.RGBA8, 'colour'], [GL.RGB8, 'colour'],
    [GL.RGBA4, 'colour'], [GL.RGB5_A1, 'colour'], [GL.RGB565, 'colour'],
    [GL.RGB10_A2, 'colour'], [GL.RGBA16, 'colour'], [GL.RGB16, 'colour'],
    [GL.DEPTH_COMPONENT, 'depth'], [GL.DEPTH_COMPONENT16, 'depth'],
    [GL.DEPTH_COMPONENT24, 'depth'], [GL.DEPTH_COMPONENT32, 'depth'],
    [GL.STENCIL_INDEX1, 'stencil'], [GL.STENCIL_INDEX4, 'stencil'],
    [GL.STENCIL_INDEX8, 'stencil'], [GL.STENCIL_INDEX16, 'stencil'],
    [GL.DEPTH_STENCIL, 'depthStencil'], [GL.DEPTH24_STENCIL8, 'depthStencil'],
]);

/**
 * What an attachment holds, by its image's format: colour, depth, stencil
 * or both, or null when it has no image.
 *
 * @param {Attachment} attachment
 * @returns {{ holds: 'colour' | 'depth' | 'stencil' | 'depthStencil', width: number,
 *     height: number, internalFormat: number } | null}
 */
export function attachmentImage(attachment){
    if (attachment.kind === 'renderbuffer')
    {
        const rb = attachment.renderbuffer;
        const holds = RENDERBUFFER_FORMATS.get(rb.internalFormat);
        return holds && rb.width > 0 && rb.height > 0
            ? { holds, width: rb.width, height: rb.height, internalFormat: rb.internalFormat }
            : null;
    }
    const level = attachment.texture.levels.get(attachedLevelKey(attachment));
    if (!level || level.width === 0 || level.height === 0)
    {
        return null;
    }
    if (level.compressed || level.internalFormat === GL.COMPRESSED_RGB_S3TC_DXT1_EXT)
    {
        return null;
    }
    const base = level.baseFormat;
    const holds = base === GL.DEPTH_COMPONENT ? 'depth' : base === GL.DEPTH_STENCIL
        ? 'depthStencil' : base === GL.STENCIL_INDEX ? 'stencil' : 'colour';
    return { holds, width: level.width, height: level.height,
        internalFormat: level.internalFormat };
}
