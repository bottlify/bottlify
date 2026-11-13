/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Framebuffer and renderbuffer objects (GL_ARB_framebuffer_object, which
 * OpenGL 3.0 made core under the same names, and GL_EXT_framebuffer_object
 * with its suffixed ones): drawing into textures and renderbuffers instead
 * of the window, blitting between framebuffers, and generating mipmaps.
 *
 * The object rules:
 *
 * - **Renderbuffers and framebuffers live in the share group.** OpenGL 3.0
 *   shares no containers, but GL_EXT_framebuffer_object shares framebuffers
 *   and Windows' drivers go on sharing them between the contexts
 *   wglShareLists joins, under either spelling (Wine's opengl32
 *   test_sharelists).
 * - **A name glGenFramebuffers did not hand out cannot be bound** under the
 *   ARB names (GL_INVALID_OPERATION); the EXT names make the object on the
 *   first bind, as that extension does, to the draw and read targets as well
 *   (GL_EXT_framebuffer_blit).
 * - **Deleting what is bound unbinds it**, and deleting a renderbuffer or a
 *   texture detaches it from the framebuffer bound for drawing or reading.
 * - **The draw and read buffers belong to the framebuffer**: binding another
 *   framebuffer brings its own.
 *
 * What is complete (glCheckFramebufferStatus) is the specification's rules
 * plus this renderer's limits, which it reports as GL_FRAMEBUFFER_UNSUPPORTED,
 * the status the specification keeps for exactly that: attachments of
 * different sizes (a WebGPU pass is one size) and a depth and a stencil
 * attachment that are not one image (WebGPU has one depth-stencil
 * attachment).
 */

import { GL } from './constants.js';
import {
    LAYERED_TARGETS, RENDERBUFFER_FORMATS, attachedLevelKey, attachmentImage, levelKey,
} from './objects.js';
import { TEX, componentTypeOf } from './formats.js';
import { rgbaOf } from './texture-levels.js';
import { compressedBytes } from './texture.js';

/**
 * The targets glGenerateMipmap takes (3.0 section 3.8.8, and 4.0's cube map
 * arrays).
 *
 * @type {ReadonlySet<number>}
 */
const MIPMAP_TARGETS = new Set([GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D, GL.TEXTURE_CUBE_MAP,
    TEX.TEXTURE_1D_ARRAY, TEX.TEXTURE_2D_ARRAY, TEX.TEXTURE_CUBE_MAP_ARRAY]);

/**
 * @typedef {import('./objects.js').RenderbufferObject} RenderbufferObject
 * @typedef {import('./objects.js').Attachment} Attachment
 * @typedef {import('./objects.js').FramebufferObject} FramebufferObject
 */
import { GLSL_LIMITS } from './glsl-builtins.js';

/** The colour attachment points. */
export const COLOR_ATTACHMENTS = GLSL_LIMITS.drawBuffers;

/** The cube map faces, in the order a cube's levels are kept. */
const CUBE_FACES = [0x8515, 0x8516, 0x8517, 0x8518, 0x8519, 0x851a];

/** @param {number} point */
const isColour = point=>point >= GL.COLOR_ATTACHMENT0
    && point < GL.COLOR_ATTACHMENT0 + COLOR_ATTACHMENTS;

/**
 * Whether a framebuffer can be drawn, and why not.
 *
 * @param {FramebufferObject} fbo
 * @returns {number} GL_FRAMEBUFFER_COMPLETE or the reason it is not
 */
export function framebufferStatus(fbo){
    if (fbo.attachments.size === 0)
    {
        // Without attachments, its default size makes it one.
        return fbo.defaults.width > 0 && fbo.defaults.height > 0 ? GL.FRAMEBUFFER_COMPLETE
            : GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
    }
    /** @type {{ width: number, height: number }[]} */
    const sizes = [];
    for (const [point, attachment] of fbo.attachments)
    {
        const image = attachmentImage(attachment);
        if (!image)
        {
            return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        }
        const fits = isColour(point) ? image.holds === 'colour'
            : point === GL.DEPTH_ATTACHMENT ? image.holds === 'depth'
                || image.holds === 'depthStencil'
                : image.holds === 'stencil' || image.holds === 'depthStencil';
        if (!fits)
        {
            return GL.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
        }
        const sized = attachment.kind === 'texture'
            ? attachment.texture.levels.get(attachedLevelKey(attachment))?.sized
            : null;
        if (sized && (sized.compressed || sized.packing === 'rgb9e5'
            || (attachment.kind === 'texture' && attachment.texture.target === GL.TEXTURE_3D)))
        {
            // What this renderer cannot draw into: a shared exponent (WebGPU
            // renders none), a slice of a 3D texture.
            return GL.FRAMEBUFFER_UNSUPPORTED;
        }
        sizes.push(image);
    }
    for (const buffer of fbo.drawBuffers)
    {
        if (buffer !== GL.NONE && !fbo.attachments.has(buffer))
        {
            return GL.FRAMEBUFFER_INCOMPLETE_DRAW_BUFFER;
        }
    }
    if (fbo.readBuffer !== GL.NONE && !fbo.attachments.has(fbo.readBuffer)
        && [...fbo.attachments.keys()].some(isColour))
    {
        return GL.FRAMEBUFFER_INCOMPLETE_READ_BUFFER;
    }
    // Layered attachments (3.2 section 9.4.2) are all or none of them.
    const layered = [...fbo.attachments.values()].map(a=>a.kind === 'texture' && !!a.layered);
    if (layered.some(on=>on !== layered[0]))
    {
        return GL.FRAMEBUFFER_INCOMPLETE_LAYER_TARGETS;
    }
    if (sizes.some(size=>size.width !== sizes[0].width || size.height !== sizes[0].height))
    {
        return GL.FRAMEBUFFER_UNSUPPORTED;
    }
    const depth = fbo.attachments.get(GL.DEPTH_ATTACHMENT);
    const stencil = fbo.attachments.get(GL.STENCIL_ATTACHMENT);
    if (depth && stencil && !sameImage(depth, stencil))
    {
        return GL.FRAMEBUFFER_UNSUPPORTED;
    }
    return GL.FRAMEBUFFER_COMPLETE;
}

/** @param {Attachment} a @param {Attachment} b */
function sameImage(a, b){
    if (a.kind === 'renderbuffer' && b.kind === 'renderbuffer')
    {
        return a.renderbuffer === b.renderbuffer;
    }
    return a.kind === 'texture' && b.kind === 'texture' && a.texture === b.texture
        && a.level === b.level && a.face === b.face;
}

/** @returns {FramebufferObject} */
const createFramebufferObject = (/** @type {number} */ name)=>({
    name, attachments: new Map(), drawBuffers: [GL.COLOR_ATTACHMENT0, GL.NONE, GL.NONE, GL.NONE],
    readBuffer: GL.COLOR_ATTACHMENT0, version: 0,
    defaults: { width: 0, height: 0, layers: 0, samples: 0, fixed: GL.FALSE },
});

/**
 * The largest default size, layer count and sample count a framebuffer
 * without attachments takes: WebGPU's least 2D texture size and layer count,
 * and the samples a renderbuffer takes.
 */
const DEFAULT_LIMITS = Object.freeze({ width: 8192, height: 8192, layers: 256, samples: 4 });

/** The defaults' parameters, by name, and the limit of each. */
const DEFAULT_PARAMETERS = new Map(/** @type {[number, [string, number]][]} */ ([
    [GL.FRAMEBUFFER_DEFAULT_WIDTH, ['width', DEFAULT_LIMITS.width]],
    [GL.FRAMEBUFFER_DEFAULT_HEIGHT, ['height', DEFAULT_LIMITS.height]],
    [GL.FRAMEBUFFER_DEFAULT_LAYERS, ['layers', DEFAULT_LIMITS.layers]],
    [GL.FRAMEBUFFER_DEFAULT_SAMPLES, ['samples', DEFAULT_LIMITS.samples]],
    [GL.FRAMEBUFFER_DEFAULT_FIXED_SAMPLE_LOCATIONS, ['fixed', 1]],
]));

/**
 * The calls of this file a display list does not record: all of them, as
 * the extension says of its own and GL 3.0 of the rest.
 */
export const FRAMEBUFFER_CALLS_NOT_COMPILED = Object.freeze([
    'glGenFramebuffers', 'glDeleteFramebuffers', 'glIsFramebuffer', 'bindFramebuffer',
    'glCheckFramebufferStatus', 'framebufferTexture', 'glFramebufferRenderbuffer',
    'glGetFramebufferAttachmentParameteriv', 'glGenRenderbuffers', 'glDeleteRenderbuffers',
    'glIsRenderbuffer', 'bindRenderbuffer', 'glRenderbufferStorageMultisample',
    'glGetRenderbufferParameteriv', 'glGenerateMipmap', 'glBlitFramebuffer',
    'glCreateFramebuffers', 'glCreateRenderbuffers', 'framebufferParameter',
    'getFramebufferParameter', 'glGetFramebufferParameterivEXT',
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installFramebufferCalls(context, kernel){
    const { enter, setError, setState, diverge } = kernel;

    /**
     * The share group's framebuffers, by name; generated names hold null
     * until bound.
     *
     * @returns {Map<number, FramebufferObject | null>}
     */
    const framebuffers = ()=>kernel.shareGroup().framebuffers;
    /** @type {FramebufferObject | null} */
    let drawFbo = null;
    /** @type {FramebufferObject | null} */
    let readFbo = null;
    /** @type {RenderbufferObject | null} */
    let boundRenderbuffer = null;
    /** The default framebuffer's draw buffers, which glDrawBuffers sets while it is bound. */
    let defaultDrawBuffers = [GL.BACK, GL.NONE, GL.NONE, GL.NONE];

    const renderbuffers = ()=>kernel.shareGroup().renderbuffers;

    /** @param {number} target @returns {('draw' | 'read')[] | null} */
    const targetsOf = target=>(target === GL.FRAMEBUFFER ? ['draw', 'read']
        : target === GL.DRAW_FRAMEBUFFER ? ['draw'] : target === GL.READ_FRAMEBUFFER
            ? ['read'] : null);

    /** @param {number} query */
    const stateOf = query=>kernel.record(query)?.values?.[0] ?? 0;

    /**
     * glGetFramebufferAttachmentParameteriv of the default framebuffer: its
     * buffers by name (FRONT_LEFT, BACK_LEFT, the stereo ones, DEPTH,
     * STENCIL), each FRAMEBUFFER_DEFAULT where the pixel format has it and
     * NONE where not, its sizes the pixel format's as glGetIntegerv answers
     * them: what a windowing library reads the pixel format back with.
     *
     * @param {number} attachment @param {number} pname
     * @returns {number[] | null}
     */
    const defaultAttachmentParameter = (attachment, pname)=>{
        const kind = attachment === GL.FRONT_LEFT ? 'front'
            : attachment === GL.BACK_LEFT ? 'back'
                : attachment === GL.FRONT_RIGHT || attachment === GL.BACK_RIGHT ? 'stereo'
                    : attachment === GL.DEPTH ? 'depth' : attachment === GL.STENCIL ? 'stencil'
                        : null;
        if (!kind)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        const present = kind === 'front' || (kind === 'back' && stateOf(GL.DOUBLEBUFFER) !== 0)
            || (kind === 'depth' && stateOf(GL.DEPTH_BITS) > 0)
            || (kind === 'stencil' && stateOf(GL.STENCIL_BITS) > 0);
        if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE)
        {
            return [present ? GL.FRAMEBUFFER_DEFAULT : GL.NONE];
        }
        if (!present)
        {
            if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)
            {
                return [0];
            }
            setError(GL.INVALID_OPERATION);
            return null;
        }
        const colour = kind === 'front' || kind === 'back';
        switch (pname)
        {
            case GL.FRAMEBUFFER_ATTACHMENT_RED_SIZE:
                return [colour ? stateOf(GL.RED_BITS) : 0];
            case GL.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:
                return [colour ? stateOf(GL.GREEN_BITS) : 0];
            case GL.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:
                return [colour ? stateOf(GL.BLUE_BITS) : 0];
            case GL.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:
                return [colour ? stateOf(GL.ALPHA_BITS) : 0];
            case GL.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:
                return [kind === 'depth' ? stateOf(GL.DEPTH_BITS) : 0];
            case GL.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:
                return [kind === 'stencil' ? stateOf(GL.STENCIL_BITS) : 0];
            case GL.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE:
                return [kind === 'stencil' ? GL.UNSIGNED_INT : GL.UNSIGNED_NORMALIZED];
            case GL.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING:
                return [GL.LINEAR];
            default:
                setError(GL.INVALID_ENUM);
                return null;
        }
    };

    /** @param {number} target @returns {FramebufferObject | null | undefined} undefined: bad target */
    const boundTo = target=>{
        if (target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER)
        {
            return drawFbo;
        }
        return target === GL.READ_FRAMEBUFFER ? readFbo : undefined;
    };

    /**
     * Marks what the draw framebuffer has at `point` layered, when it is
     * `texture` (glFramebufferTexture of a cube map or an array, 3.2): told
     * after the texture was attached at its first face or layer.
     *
     * @param {number} point @param {object} texture
     */
    kernel.side.layerWhole = (point, texture)=>{
        const fbo = drawFbo;
        if (!fbo)
        {
            return;
        }
        /** @type {Map<Attachment, Attachment>} one layered copy a shared attachment */
        const made = new Map();
        for (const at of point === GL.DEPTH_STENCIL_ATTACHMENT
            ? [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT] : [point])
        {
            const held = fbo.attachments.get(at);
            if (held?.kind === 'texture' && held.texture === texture)
            {
                const layered = made.get(held) ?? { ...held, layered: true };
                made.set(held, layered);
                fbo.attachments.set(at, layered);
            }
        }
        fbo.version++;
    };

    /** @param {number} attachment */
    const validAttachment = attachment=>isColour(attachment) || attachment === GL.DEPTH_ATTACHMENT
        || attachment === GL.STENCIL_ATTACHMENT || attachment === GL.DEPTH_STENCIL_ATTACHMENT;

    /**
     * @param {FramebufferObject} fbo @param {number} point @param {Attachment | null} what
     */
    const attach = (fbo, point, what)=>{
        const points = point === GL.DEPTH_STENCIL_ATTACHMENT
            ? [GL.DEPTH_ATTACHMENT, GL.STENCIL_ATTACHMENT] : [point];
        for (const at of points)
        {
            if (what)
            {
                fbo.attachments.set(at, what);
            }
            else
            {
                fbo.attachments.delete(at);
            }
        }
        fbo.version++;
        publish();
    };

    /** The draw framebuffer's draw buffers, mirrored in the queries that read them. */
    const publish = ()=>{
        const buffers = drawFbo ? drawFbo.drawBuffers : defaultDrawBuffers;
        for (let k = 0; k < COLOR_ATTACHMENTS; k++)
        {
            setState(GL.DRAW_BUFFER0 + k, [buffers[k]]);
        }
        setState(GL.DRAW_BUFFER, [buffers[0]]);
        if (readFbo)
        {
            setState(GL.READ_BUFFER, [readFbo.readBuffer]);
        }
        setState(GL.FRAMEBUFFER_BINDING, [drawFbo?.name ?? 0]);
        setState(GL.READ_FRAMEBUFFER_BINDING, [readFbo?.name ?? 0]);
        setState(GL.RENDERBUFFER_BINDING, [boundRenderbuffer?.name ?? 0]);
    };

    /**
     * The levels from GL_TEXTURE_BASE_LEVEL + 1 down to the last the base's
     * size or GL_TEXTURE_MAX_LEVEL allows, each made from the base image in
     * its internal format (3.8.8): glGenerateMipmap's work, and
     * GL_GENERATE_MIPMAP's (1.4) on every target and every image call. A
     * cube map's faces are each their own chain; `only` names the one face
     * an image call changed. On a device the levels are drawn there, from
     * what it holds of the base - a framebuffer may have drawn it - except a
     * 3D texture's, which no 2D draw makes and are averaged here.
     *
     * @param {import('./objects.js').TextureObject} texture
     * @param {number} [only]  the face, where one face changed
     */
    function generateLevels(texture, only){
        const first = texture.parameters.get(GL.TEXTURE_BASE_LEVEL) ?? 0;
        const base = texture.levels.get(levelKey(first, only ?? 0));
        if (!base)
        {
            return;
        }
        if ((base.border ?? 0) !== 0)
        {
            kernel.lose('a mipmap of an image with a border was not made: its levels are not'
                + ' generated here');
            return;
        }
        const solid = texture.target === GL.TEXTURE_3D;
        const rows = texture.target === TEX.TEXTURE_1D_ARRAY;
        const extent = Math.max(base.width, rows ? 1 : base.height,
            solid ? base.depth ?? 1 : 1);
        const last = Math.min(first + Math.floor(Math.log2(extent)),
            texture.parameters.get(GL.TEXTURE_MAX_LEVEL) ?? 1000);
        const device = kernel.gpuBacked() && !solid;
        if (device && base.sized?.compressed)
        {
            kernel.lose(`the mipmap of a ${base.sized.name} texture was not made on the device:`
                + ' no draw writes blocks, and the device samples its base level alone');
        }
        const faces = only !== undefined ? [only]
            : texture.target === GL.TEXTURE_CUBE_MAP ? [0, 1, 2, 3, 4, 5] : [0];
        for (const face of faces)
        {
            const top = texture.levels.get(levelKey(first, face));
            if (!top)
            {
                continue;
            }
            for (let level = first + 1; level <= last; level++)
            {
                const made = derivedLevel(top, level - first, device, solid, rows);
                if (made.lost)
                {
                    kernel.lose(`a mipmap of ${top.sized?.name ?? 'a'} format made no texels on`
                        + ' the processor: only 8-bit components are averaged here');
                }
                texture.levels.set(levelKey(level, face), made.level);
                if (!device)
                {
                    texture.dirty.set(levelKey(level, face), null);
                }
            }
        }
        if (device && last > first)
        {
            kernel.generateMipmap?.(texture, only);
        }
    }
    kernel.side.generateLevels = generateLevels;

    Object.assign(kernel.side, {
        /**
         * What draws land in: the bound draw framebuffer, complete, with its
         * size; null for the window.
         *
         * @returns {{ fbo: FramebufferObject, width: number, height: number } | null}
         */
        drawTarget(){
            if (!drawFbo)
            {
                return null;
            }
            for (const attachment of drawFbo.attachments.values())
            {
                const image = attachmentImage(attachment);
                if (image)
                {
                    return { fbo: drawFbo, width: image.width, height: image.height };
                }
            }
            return { fbo: drawFbo, width: drawFbo.defaults.width, height: drawFbo.defaults.height };
        },
        /** @returns {FramebufferObject | null} */
        readFramebuffer: ()=>readFbo,
        /** Whether a draw or a clear may go ahead: the draw framebuffer is complete. */
        drawComplete(){
            return !drawFbo || framebufferStatus(drawFbo) === GL.FRAMEBUFFER_COMPLETE;
        },
        /** Whether a read may: the read framebuffer is complete. */
        readComplete(){
            return !readFbo || framebufferStatus(readFbo) === GL.FRAMEBUFFER_COMPLETE;
        },
        /**
         * glDrawBuffer and glDrawBuffers, into the bound framebuffer's state:
         * true when they were taken.
         *
         * @param {number[]} buffers
         */
        setDrawBuffers(buffers){
            const all = [...buffers, ...new Array(COLOR_ATTACHMENTS).fill(GL.NONE)]
                .slice(0, COLOR_ATTACHMENTS);
            if (drawFbo)
            {
                if (buffers.some((b, k)=>b !== GL.NONE && (!isColour(b)
                    || buffers.indexOf(b) !== k)))
                {
                    setError(buffers.some(b=>b !== GL.NONE && !isColour(b)
                        && b !== GL.BACK && b !== GL.FRONT) ? GL.INVALID_ENUM
                        : GL.INVALID_OPERATION);
                    return false;
                }
                drawFbo.drawBuffers = all;
                drawFbo.version++;
            }
            else
            {
                defaultDrawBuffers = all;
            }
            publish();
            return true;
        },
        /** @param {number} mode @returns {boolean} whether it was taken */
        setReadBuffer(mode){
            if (!readFbo)
            {
                return false;
            }
            if (mode !== GL.NONE && !isColour(mode))
            {
                setError(GL.INVALID_OPERATION);
                return true;
            }
            readFbo.readBuffer = mode;
            publish();
            return true;
        },
        /** A texture deleted: what any bound framebuffer attached of it goes. @param {any} texture */
        textureDeleted(texture){
            for (const fbo of [drawFbo, readFbo])
            {
                if (!fbo)
                {
                    continue;
                }
                for (const [point, attachment] of fbo.attachments)
                {
                    if (attachment.kind === 'texture' && attachment.texture === texture)
                    {
                        attach(fbo, point, null);
                    }
                }
            }
        },
    });

    /**
     * @param {string} call @param {number} target @param {number} name
     * @param {boolean} ext  the EXT spelling, which makes the object on bind
     */
    const bindFramebuffer = (call, target, name, ext)=>{
        const which = targetsOf(target);
        if (!which)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        /** @type {FramebufferObject | null} */
        let fbo = null;
        if (name !== 0)
        {
            if (!framebuffers().has(name) && !ext)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            fbo = objectNamed(name);
        }
        if (which.includes('draw'))
        {
            drawFbo = fbo;
        }
        if (which.includes('read'))
        {
            readFbo = fbo;
        }
        if (!readFbo)
        {
            setState(GL.READ_BUFFER, [record(GL.DOUBLEBUFFER).values[0] ? GL.BACK : GL.FRONT]);
        }
        publish();
    };
    const record = kernel.record;

    /**
     * A framebuffer name's object, made if the name was only generated.
     *
     * @param {number} name @returns {FramebufferObject}
     */
    const objectNamed = name=>{
        let fbo = framebuffers().get(name);
        if (!fbo)
        {
            fbo = createFramebufferObject(name);
            framebuffers().set(name, fbo);
            kernel.shareGroup().used = true;
        }
        return fbo;
    };

    /**
     * @param {number} target @param {number} attachment @param {number} textarget
     * @param {number} name @param {number} level
     */
    const framebufferTexture = (target, attachment, textarget, name, level)=>{
        const fbo = boundTo(target);
        if (fbo === undefined || !validAttachment(attachment))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (!fbo)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (name === 0)
        {
            attach(fbo, attachment, null);
            return;
        }
        const texture = kernel.shareGroup().textures.objects.get(name);
        if (!texture)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const face = CUBE_FACES.indexOf(textarget);
        const wanted = face >= 0 ? GL.TEXTURE_CUBE_MAP : textarget;
        // A rectangle (3.1) and a multisample texture (3.2) are attached as
        // the one level they have.
        const single = wanted === GL.TEXTURE_RECTANGLE || wanted === GL.TEXTURE_2D_MULTISAMPLE;
        if (wanted !== GL.TEXTURE_2D && wanted !== GL.TEXTURE_CUBE_MAP
            && wanted !== GL.TEXTURE_1D && !single)
        {
            setError(textarget === GL.TEXTURE_3D ? GL.INVALID_OPERATION : GL.INVALID_ENUM);
            return;
        }
        if (texture.target !== wanted)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const maxLevel = single ? 0 : Math.log2(record(GL.MAX_TEXTURE_SIZE).values[0]);
        if (level < 0 || level > maxLevel)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        attach(fbo, attachment, { kind: 'texture', texture, level, face: Math.max(0, face) });
    };

    Object.assign(context, {
        /** @param {number} count @returns {number[]} */
        glGenFramebuffers(count){
            if (!enter('glGenFramebuffers', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            /** @type {number[]} */
            const names = [];
            let next = 1;
            while (names.length < count)
            {
                if (!framebuffers().has(next))
                {
                    framebuffers().set(next, null);
                    kernel.shareGroup().used = true;
                    names.push(next);
                }
                next++;
            }
            return names;
        },

        /** @param {readonly number[]} names */
        glDeleteFramebuffers(names){
            if (!enter('glDeleteFramebuffers', [names]))
            {
                return;
            }
            for (const name of names)
            {
                if (name === 0 || !framebuffers().has(name))
                {
                    continue;
                }
                const fbo = framebuffers().get(name);
                if (fbo && fbo === drawFbo)
                {
                    drawFbo = null;
                }
                if (fbo && fbo === readFbo)
                {
                    readFbo = null;
                }
                framebuffers().delete(name);
            }
            publish();
        },

        /** @param {number} name @returns {number} */
        glIsFramebuffer(name){
            if (!enter('glIsFramebuffer', [name]))
            {
                return GL.FALSE;
            }
            return framebuffers().get(name) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} target @param {number} name @param {boolean} ext */
        bindFramebuffer(target, name, ext){
            if (enter('bindFramebuffer', [target, name, ext]))
            {
                bindFramebuffer('glBindFramebuffer', target, name, ext);
            }
        },

        /** @param {number} target @returns {number} */
        glCheckFramebufferStatus(target){
            if (!enter('glCheckFramebufferStatus', [target]))
            {
                return 0;
            }
            const fbo = boundTo(target);
            if (fbo === undefined)
            {
                setError(GL.INVALID_ENUM);
                return 0;
            }
            return fbo ? framebufferStatus(fbo) : GL.FRAMEBUFFER_COMPLETE;
        },

        /**
         * glFramebufferTexture1D, 2D and 3D in one.
         *
         * @param {number} target @param {number} attachment @param {number} textarget
         * @param {number} name @param {number} level
         */
        framebufferTexture(target, attachment, textarget, name, level){
            if (enter('framebufferTexture', [target, attachment, textarget, name, level]))
            {
                framebufferTexture(target, attachment, textarget, name, level);
            }
        },

        /**
         * glFramebufferTextureLayer (3.0): a layer of an array's level, a
         * cube map array's layer-face among them (4.0), drawn into as a 2D
         * image. A 3D texture's slice is not taken: GL_INVALID_OPERATION, as
         * a draw here reaches no slice of one.
         *
         * @param {number} target @param {number} attachment @param {number} name
         * @param {number} level @param {number} layer
         */
        glFramebufferTextureLayer(target, attachment, name, level, layer){
            if (!enter('glFramebufferTextureLayer', [target, attachment, name, level, layer]))
            {
                return;
            }
            const texture = name === 0 ? null : kernel.shareGroup().textures.objects.get(name);
            if (!texture)
            {
                // A detach, or a name that is no texture.
                framebufferTexture(target, attachment, name === 0 ? GL.TEXTURE_2D : GL.TEXTURE_3D,
                    name, level);
                return;
            }
            if (!LAYERED_TARGETS.has(texture.target))
            {
                const fbo = boundTo(target);
                setError(fbo === undefined || !validAttachment(attachment) ? GL.INVALID_ENUM
                    : GL.INVALID_OPERATION);
                return;
            }
            const maxLevel = Math.log2(record(GL.MAX_TEXTURE_SIZE).values[0]);
            // A layer past the texture's own makes the framebuffer incomplete;
            // past MAX_ARRAY_TEXTURE_LAYERS it is no layer at all.
            if (layer < 0 || layer >= record(TEX.MAX_ARRAY_TEXTURE_LAYERS).values[0]
                || level < 0 || level > maxLevel)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const fbo = boundTo(target);
            if (fbo === undefined || !validAttachment(attachment))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!fbo)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            attach(fbo, attachment, { kind: 'texture', texture, level, face: layer });
        },

        /**
         * @param {number} target @param {number} attachment @param {number} rbTarget
         * @param {number} name
         */
        glFramebufferRenderbuffer(target, attachment, rbTarget, name){
            if (!enter('glFramebufferRenderbuffer', [target, attachment, rbTarget, name]))
            {
                return;
            }
            const fbo = boundTo(target);
            if (fbo === undefined || !validAttachment(attachment)
                || (rbTarget !== GL.RENDERBUFFER && name !== 0))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!fbo)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (name === 0)
            {
                attach(fbo, attachment, null);
                return;
            }
            const renderbuffer = renderbuffers().objects.get(name);
            if (!renderbuffer)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            attach(fbo, attachment, { kind: 'renderbuffer', renderbuffer });
        },

        /**
         * @param {number} target @param {number} attachment @param {number} pname
         * @returns {number[] | null}
         */
        glGetFramebufferAttachmentParameteriv(target, attachment, pname){
            if (!enter('glGetFramebufferAttachmentParameteriv', [target, attachment, pname]))
            {
                return null;
            }
            const fbo = boundTo(target);
            if (fbo === undefined)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (!fbo)
            {
                return defaultAttachmentParameter(attachment, pname);
            }
            if (!validAttachment(attachment))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const point = attachment === GL.DEPTH_STENCIL_ATTACHMENT ? GL.DEPTH_ATTACHMENT
                : attachment;
            const attached = fbo.attachments.get(point);
            if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_TYPE)
            {
                return [attached ? (attached.kind === 'texture' ? GL.TEXTURE : GL.RENDERBUFFER)
                    : GL.NONE];
            }
            if (!attached)
            {
                if (pname === GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME)
                {
                    return [0];
                }
                setError(GL.INVALID_ENUM);
                return null;
            }
            const image = attachmentImage(attached);
            const colour = image?.holds === 'colour';
            // A texture kept as a sized format answers from its format.
            const sized = attached.kind === 'texture'
                ? attached.texture.levels.get(attachedLevelKey(attached))?.sized
                : null;
            const bits = /** @type {number[]} */ ([GL.FRAMEBUFFER_ATTACHMENT_RED_SIZE,
                GL.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE, GL.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE,
                GL.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE]).indexOf(pname);
            if (sized && bits >= 0)
            {
                return [sized.bits[bits]];
            }
            switch (pname)
            {
                case GL.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME:
                    return [attached.kind === 'texture' ? attached.texture.name
                        : attached.renderbuffer.name];
                case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LEVEL:
                    return attached.kind === 'texture' ? [attached.level] : (setError(
                        GL.INVALID_ENUM), null);
                case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_CUBE_MAP_FACE:
                    return attached.kind === 'texture'
                        ? [attached.texture.target === GL.TEXTURE_CUBE_MAP
                            ? CUBE_FACES[attached.face] : 0]
                        : (setError(GL.INVALID_ENUM), null);
                case GL.FRAMEBUFFER_ATTACHMENT_LAYERED:
                    return attached.kind === 'texture' ? [attached.layered ? GL.TRUE : GL.FALSE]
                        : (setError(GL.INVALID_ENUM), null);
                case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER:
                    return attached.kind === 'texture'
                        ? [LAYERED_TARGETS.has(attached.texture.target) ? attached.face : 0]
                        : (setError(GL.INVALID_ENUM), null);
                case GL.FRAMEBUFFER_ATTACHMENT_RED_SIZE:
                case GL.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:
                case GL.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:
                case GL.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:
                    return [colour ? 8 : 0];
                case GL.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:
                    return [sized ? sized.depth
                        : image && image.holds !== 'colour' && image.holds !== 'stencil' ? 24
                            : 0];
                case GL.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:
                    return [sized ? sized.stencil
                        : image && (image.holds === 'stencil' || image.holds === 'depthStencil')
                            ? 8 : 0];
                case GL.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE:
                    return [sized ? componentTypeOf(sized, colour ? 'colour' : 'depth')
                        : GL.UNSIGNED_NORMALIZED];
                case GL.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING:
                    return [sized?.srgb ? GL.SRGB : GL.LINEAR_COLOR];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        // --- parameters (GL_ARB_framebuffer_no_attachments, 4.5, EXT_direct_state_access) ---

        /**
         * glFramebufferParameteri and glNamedFramebufferParameteri: a
         * framebuffer object's size, layers and samples without attachments.
         *
         * @param {string} call
         * @param {FramebufferObject | null | undefined} fbo  undefined: no such target or name
         * @param {number} pname @param {number} param
         */
        framebufferParameter(call, fbo, pname, param){
            if (!enter('framebufferParameter', [call, fbo, pname, param]))
            {
                return;
            }
            const parameter = DEFAULT_PARAMETERS.get(pname);
            if (!parameter || (fbo === undefined && call === 'glFramebufferParameteri'))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (!fbo)
            {
                // No object by that name; or the default framebuffer, which
                // has no defaults to set.
                setError(GL.INVALID_OPERATION);
                return;
            }
            const [field, limit] = parameter;
            // Fixed sample locations is a boolean: any value is one.
            if (field !== 'fixed' && (param < 0 || param > limit))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            /** @type {Record<string, number>} */ (fbo.defaults)[field] = field === 'fixed'
                ? (param !== 0 ? GL.TRUE : GL.FALSE) : param;
            fbo.version++;
        },

        /**
         * glGetFramebufferParameteriv and glGetNamedFramebufferParameteriv: a
         * framebuffer's defaults, and since 4.5 what any framebuffer, the
         * default one included, says of itself.
         *
         * @param {string} call
         * @param {FramebufferObject | null | undefined} fbo  undefined: no such target or name
         * @param {number} pname
         * @returns {number[] | null}
         */
        getFramebufferParameter(call, fbo, pname){
            if (!enter('getFramebufferParameter', [call, fbo, pname]))
            {
                return null;
            }
            const parameter = DEFAULT_PARAMETERS.get(pname);
            const own = pname === GL.DOUBLEBUFFER || pname === GL.STEREO
                || pname === GL.SAMPLES || pname === GL.SAMPLE_BUFFERS
                || pname === GL.IMPLEMENTATION_COLOR_READ_FORMAT
                || pname === GL.IMPLEMENTATION_COLOR_READ_TYPE;
            if (!parameter && !own)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (fbo === undefined)
            {
                setError(call === 'glGetFramebufferParameteriv' ? GL.INVALID_ENUM
                    : GL.INVALID_OPERATION);
                return null;
            }
            if (parameter)
            {
                if (!fbo)
                {
                    setError(GL.INVALID_OPERATION);
                    return null;
                }
                const defaults = /** @type {Record<string, number>} */ (fbo.defaults);
                return [defaults[parameter[0]]];
            }
            switch (pname)
            {
                case GL.DOUBLEBUFFER:
                    return [fbo ? GL.FALSE : record(GL.DOUBLEBUFFER).values[0]];
                case GL.STEREO:
                    return [GL.FALSE];
                case GL.IMPLEMENTATION_COLOR_READ_FORMAT:
                    return [GL.RGBA];
                case GL.IMPLEMENTATION_COLOR_READ_TYPE:
                    return [GL.UNSIGNED_BYTE];
                default:
                    // Drawn single-sampled, every framebuffer here.
                    return [0];
            }
        },

        /**
         * EXT_direct_state_access' glGetFramebufferParameterivEXT: a
         * framebuffer's draw and read buffers, as the queries would answer
         * with it bound.
         *
         * @param {number} name @param {number} pname
         * @returns {number[] | null}
         */
        glGetFramebufferParameterivEXT(name, pname){
            if (!enter('glGetFramebufferParameterivEXT', [name, pname]))
            {
                return null;
            }
            const drawn = pname === GL.DRAW_BUFFER ? 0 : pname - GL.DRAW_BUFFER0;
            if (pname !== GL.READ_BUFFER && (drawn < 0 || drawn >= COLOR_ATTACHMENTS))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (name === 0)
            {
                if (pname === GL.READ_BUFFER)
                {
                    return [readFbo ? (record(GL.DOUBLEBUFFER).values[0] ? GL.BACK : GL.FRONT)
                        : record(GL.READ_BUFFER).values[0]];
                }
                return [defaultDrawBuffers[drawn]];
            }
            if (!framebuffers().has(name))
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            const fbo = objectNamed(name);
            return [pname === GL.READ_BUFFER ? fbo.readBuffer : fbo.drawBuffers[drawn]];
        },

        /**
         * The framebuffer a named call reaches: undefined for a name that is
         * no object (4.5 section 9.2.1), null for zero, the default one.
         *
         * @param {number} name @returns {FramebufferObject | null | undefined}
         */
        framebufferNamed(name){
            return name === 0 ? null : framebuffers().get(name) ?? undefined;
        },

        /** @param {number} target @returns {FramebufferObject | null | undefined} */
        framebufferBoundTo(target){
            return boundTo(target);
        },

        /** glCreateFramebuffers (4.5): names that are objects at once. @param {number} count */
        glCreateFramebuffers(count){
            if (!enter('glCreateFramebuffers', [count]))
            {
                return [];
            }
            const names = context.glGenFramebuffers(count);
            for (const name of names)
            {
                objectNamed(name);
            }
            return names;
        },

        // --- renderbuffers ---

        /** glCreateRenderbuffers (4.5): names that are objects at once. @param {number} count */
        glCreateRenderbuffers(count){
            if (!enter('glCreateRenderbuffers', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            const group = renderbuffers();
            const names = group.reserve(count);
            for (const name of names)
            {
                group.define(name, { name, width: 0, height: 0, internalFormat: GL.RGBA,
                    samples: 0, version: 0 });
            }
            kernel.shareGroup().used = true;
            return names;
        },

        /** @param {number} count @returns {number[]} */
        glGenRenderbuffers(count){
            if (!enter('glGenRenderbuffers', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            return renderbuffers().reserve(count);
        },

        /** @param {readonly number[]} names */
        glDeleteRenderbuffers(names){
            if (!enter('glDeleteRenderbuffers', [names]))
            {
                return;
            }
            for (const name of names)
            {
                const renderbuffer = renderbuffers().objects.get(name);
                if (renderbuffer)
                {
                    for (const fbo of [drawFbo, readFbo])
                    {
                        for (const [point, attachment] of fbo?.attachments ?? [])
                        {
                            if (attachment.kind === 'renderbuffer'
                                && attachment.renderbuffer === renderbuffer)
                            {
                                attach(/** @type {FramebufferObject} */ (fbo), point, null);
                            }
                        }
                    }
                    if (boundRenderbuffer === renderbuffer)
                    {
                        boundRenderbuffer = null;
                    }
                }
                if (name !== 0)
                {
                    renderbuffers().remove(name);
                }
            }
            publish();
        },

        /** @param {number} name @returns {number} */
        glIsRenderbuffer(name){
            if (!enter('glIsRenderbuffer', [name]))
            {
                return GL.FALSE;
            }
            return renderbuffers().objects.has(name) ? GL.TRUE : GL.FALSE;
        },

        /** @param {number} target @param {number} name @param {boolean} ext */
        bindRenderbuffer(target, name, ext){
            if (!enter('bindRenderbuffer', [target, name, ext]))
            {
                return;
            }
            if (target !== GL.RENDERBUFFER)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (name === 0)
            {
                boundRenderbuffer = null;
                publish();
                return;
            }
            const group = renderbuffers();
            let renderbuffer = group.objects.get(name);
            if (!renderbuffer)
            {
                if (!group.reserved.has(name) && !ext)
                {
                    setError(GL.INVALID_OPERATION);
                    return;
                }
                renderbuffer = { name, width: 0, height: 0, internalFormat: GL.RGBA, samples: 0,
                    version: 0 };
                group.define(name, renderbuffer);
                kernel.shareGroup().used = true;
            }
            boundRenderbuffer = renderbuffer;
            publish();
        },

        /**
         * glRenderbufferStorage, and the multisample form, whose samples are
         * kept and drawn single-sampled.
         *
         * @param {number} target @param {number} samples @param {number} internalFormat
         * @param {number} width @param {number} height
         */
        glRenderbufferStorageMultisample(target, samples, internalFormat, width, height){
            if (!enter('glRenderbufferStorageMultisample',
                [target, samples, internalFormat, width, height]))
            {
                return;
            }
            if (target !== GL.RENDERBUFFER || !RENDERBUFFER_FORMATS.has(internalFormat))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const max = record(GL.MAX_RENDERBUFFER_SIZE).values[0];
            if (width < 0 || height < 0 || width > max || height > max || samples < 0
                || samples > record(GL.MAX_SAMPLES).values[0])
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!boundRenderbuffer)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (samples > 1)
            {
                diverge('a renderbuffer was given multisampled storage and is drawn with one'
                    + ' sample: its edges are not antialiased');
            }
            Object.assign(boundRenderbuffer, { width, height, internalFormat, samples,
                version: boundRenderbuffer.version + 1 });
            for (const fbo of framebuffers().values())
            {
                if (fbo && [...fbo.attachments.values()].some(a=>a.kind === 'renderbuffer'
                    && a.renderbuffer === boundRenderbuffer))
                {
                    fbo.version++;
                }
            }
        },

        /** @param {number} target @param {number} pname @returns {number[] | null} */
        glGetRenderbufferParameteriv(target, pname){
            if (!enter('glGetRenderbufferParameteriv', [target, pname]))
            {
                return null;
            }
            if (target !== GL.RENDERBUFFER)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            if (!boundRenderbuffer)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            const rb = boundRenderbuffer;
            const holds = RENDERBUFFER_FORMATS.get(rb.internalFormat);
            const colour = holds === 'colour' && rb.width > 0;
            switch (pname)
            {
                case GL.RENDERBUFFER_WIDTH:
                    return [rb.width];
                case GL.RENDERBUFFER_HEIGHT:
                    return [rb.height];
                case GL.RENDERBUFFER_INTERNAL_FORMAT:
                    return [rb.internalFormat];
                case GL.RENDERBUFFER_SAMPLES:
                    return [rb.samples];
                case GL.RENDERBUFFER_RED_SIZE:
                case GL.RENDERBUFFER_GREEN_SIZE:
                case GL.RENDERBUFFER_BLUE_SIZE:
                case GL.RENDERBUFFER_ALPHA_SIZE:
                    return [colour ? 8 : 0];
                case GL.RENDERBUFFER_DEPTH_SIZE:
                    return [rb.width > 0 && (holds === 'depth' || holds === 'depthStencil') ? 24
                        : 0];
                case GL.RENDERBUFFER_STENCIL_SIZE:
                    return [rb.width > 0 && (holds === 'stencil' || holds === 'depthStencil') ? 8
                        : 0];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * The levels below the base level of the texture bound to `target`,
         * each half the one above, made from it (3.0 section 3.8.8).
         *
         * @param {number} target
         */
        glGenerateMipmap(target){
            if (!enter('glGenerateMipmap', [target]))
            {
                return;
            }
            if (!MIPMAP_TARGETS.has(target))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const unit = kernel.side.activeUnit();
            const texture = kernel.side.textureBoundAt(unit, target)
                ?? kernel.side.units[unit].defaults.get(target);
            const first = texture?.parameters.get(GL.TEXTURE_BASE_LEVEL) ?? 0;
            const base = texture?.levels.get(levelKey(first));
            if (!texture || !base)
            {
                return;
            }
            const square = base.width === base.height;
            if ((target === GL.TEXTURE_CUBE_MAP && (!square || [1, 2, 3, 4, 5].some(face=>{
                const image = texture.levels.get(levelKey(first, face));
                return !image || image.width !== base.width
                    || image.internalFormat !== base.internalFormat;
            }))) || (target === TEX.TEXTURE_CUBE_MAP_ARRAY && !square))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            generateLevels(texture);
        },

        /**
         * @param {number} srcX0 @param {number} srcY0 @param {number} srcX1
         * @param {number} srcY1 @param {number} dstX0 @param {number} dstY0
         * @param {number} dstX1 @param {number} dstY1 @param {number} mask
         * @param {number} filter
         */
        glBlitFramebuffer(srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1, mask, filter){
            if (!enter('glBlitFramebuffer', [srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1,
                dstY1, mask, filter]))
            {
                return;
            }
            const known = GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT;
            if ((mask & ~known) !== 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (filter !== GL.NEAREST && filter !== GL.LINEAR)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (filter === GL.LINEAR && (mask & (GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT)))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (!kernel.side.drawComplete() || !kernel.side.readComplete())
            {
                setError(GL.INVALID_FRAMEBUFFER_OPERATION);
                return;
            }
            if (mask & (GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT))
            {
                diverge('glBlitFramebuffer of depth or stencil copied nothing: only colour is'
                    + ' blitted');
            }
            if (mask & GL.COLOR_BUFFER_BIT)
            {
                kernel.blit?.({ srcX0, srcY0, srcX1, srcY1, dstX0, dstY0, dstX1, dstY1,
                    linear: filter === GL.LINEAR });
            }
        },
    });

    publish();
}

/**
 * A mipmap level made from a base level, `step` levels below it, in its
 * internal format: its bytes averaged from the base's where they are here
 * and the device does not make them. An array's layers (a 1D array's rows)
 * stay, a 3D texture's slices halve.
 *
 * @param {import('./objects.js').TextureLevel} top  the base level
 * @param {number} step @param {boolean} device  the levels are drawn on the device
 * @param {boolean} solid  a 3D texture @param {boolean} rows  a 1D array
 * @returns {{ level: import('./objects.js').TextureLevel, lost: boolean }}
 */
function derivedLevel(top, step, device, solid, rows){
    const width = Math.max(1, top.width >> step);
    const height = rows ? top.height : Math.max(1, top.height >> step);
    const layers = top.depth ?? 1;
    const depth = solid ? Math.max(1, layers >> step) : layers;
    const shape = { width, height, internalFormat: top.internalFormat, border: 0,
        baseFormat: top.baseFormat, compressed: null };
    /** @param {Uint8Array} bytes @param {number} channels */
    const average = (bytes, channels)=>downsampleBytes(bytes, top.width, top.height, layers,
        [step, rows ? 0 : step, solid ? step : 0], channels);
    const sized = top.sized ?? null;
    if (sized && !sized.compressed)
    {
        const channels = sized.packing === null && sized.depth === 0 && sized.stencil === 0
            && sized.bits.every(bits=>bits === 0 || bits === 8)
            ? sized.bits.filter(bits=>bits > 0).length : 0;
        const data = !device && top.data && channels > 0 ? average(top.data, channels) : null;
        return { level: { ...shape, depth, sized, data,
            texels: data ? rgbaOf(data, sized, width, height, depth) : null },
        lost: !device && !!top.data && !data };
    }
    // A legacy level, or one of blocks: averaged from its RGBA texels (the
    // blocks decoded), and kept as texels - no block is encoded here, so a
    // device samples the texture uncompressed.
    const texels = device ? null : top.texels ? average(top.texels, 4) : null;
    if (sized)
    {
        return { level: { ...shape, depth, sized: null, texels }, lost: false };
    }
    return { level: top.compressedFormat === undefined ? { ...shape, texels }
        : { ...shape, texels, compressedFormat: top.compressedFormat,
            compressedBytes: compressedBytes(top.compressedFormat, width, height) },
    lost: false };
}

/**
 * An image of `channels` bytes a texel and `depth` slices, each texel of
 * the result the mean of the box of 2^shift texels of each axis it covers.
 *
 * @param {Uint8Array} texels @param {number} width @param {number} height
 * @param {number} depth @param {number[]} shifts  of x, y and z
 * @param {number} channels
 * @returns {Uint8Array}
 */
function downsampleBytes(texels, width, height, depth, shifts, channels){
    const [sx, sy, sz] = shifts.map(shift=>1 << shift);
    const w = Math.max(1, width >> shifts[0]);
    const h = Math.max(1, height >> shifts[1]);
    const d = Math.max(1, depth >> shifts[2]);
    const out = new Uint8Array(w * h * d * channels);
    for (let z = 0; z < d; z++)
    {
        for (let y = 0; y < h; y++)
        {
            for (let x = 0; x < w; x++)
            {
                for (let c = 0; c < channels; c++)
                {
                    let sum = 0;
                    let count = 0;
                    for (let k = z * sz; k < Math.min(depth, (z + 1) * sz); k++)
                    {
                        for (let j = y * sy; j < Math.min(height, (y + 1) * sy); j++)
                        {
                            for (let i = x * sx; i < Math.min(width, (x + 1) * sx); i++)
                            {
                                sum += texels[((k * height + j) * width + i) * channels + c];
                                count++;
                            }
                        }
                    }
                    out[((z * h + y) * w + x) * channels + c] = Math.round(sum
                        / Math.max(1, count));
                }
            }
        }
    }
    return out;
}

