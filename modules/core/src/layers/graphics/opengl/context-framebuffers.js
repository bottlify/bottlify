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
 * - **Renderbuffers live in the share group, framebuffers in the context.**
 *   A framebuffer is a container of attachments and the specification does
 *   not share containers.
 * - **A name glGenFramebuffers did not hand out cannot be bound** under the
 *   ARB names (GL_INVALID_OPERATION); the EXT names make the object on the
 *   first bind, as that extension does.
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
import { RENDERBUFFER_FORMATS, attachmentImage, levelKey } from './objects.js';

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
        return GL.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT;
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
        if (point === GL.DEPTH_ATTACHMENT && image.holds === 'depth'
            && attachment.kind === 'texture')
        {
            // A depth texture this renderer cannot sample after drawing it.
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
});

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
]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installFramebufferCalls(context, kernel){
    const { enter, setError, setState, diverge } = kernel;

    /** The context's framebuffers, by name; generated names hold null until bound. */
    /** @type {Map<number, FramebufferObject | null>} */
    const framebuffers = new Map();
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

    /** @param {number} target @returns {FramebufferObject | null | undefined} undefined: bad target */
    const boundTo = target=>{
        if (target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER)
        {
            return drawFbo;
        }
        return target === GL.READ_FRAMEBUFFER ? readFbo : undefined;
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
            return { fbo: drawFbo, width: 0, height: 0 };
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
        if (!which || (ext && target !== GL.FRAMEBUFFER))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        /** @type {FramebufferObject | null} */
        let fbo = null;
        if (name !== 0)
        {
            if (!framebuffers.has(name) && !ext)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            fbo = framebuffers.get(name) ?? null;
            if (!fbo)
            {
                fbo = createFramebufferObject(name);
                framebuffers.set(name, fbo);
            }
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
        if (wanted !== GL.TEXTURE_2D && wanted !== GL.TEXTURE_CUBE_MAP
            && wanted !== GL.TEXTURE_1D)
        {
            setError(textarget === GL.TEXTURE_3D ? GL.INVALID_OPERATION : GL.INVALID_ENUM);
            return;
        }
        if (texture.target !== wanted)
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        const maxLevel = Math.log2(record(GL.MAX_TEXTURE_SIZE).values[0]);
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
                if (!framebuffers.has(next))
                {
                    framebuffers.set(next, null);
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
                if (name === 0 || !framebuffers.has(name))
                {
                    continue;
                }
                const fbo = framebuffers.get(name);
                if (fbo && fbo === drawFbo)
                {
                    drawFbo = null;
                }
                if (fbo && fbo === readFbo)
                {
                    readFbo = null;
                }
                framebuffers.delete(name);
            }
            publish();
        },

        /** @param {number} name @returns {number} */
        glIsFramebuffer(name){
            if (!enter('glIsFramebuffer', [name]))
            {
                return GL.FALSE;
            }
            return framebuffers.get(name) ? GL.TRUE : GL.FALSE;
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
                setError(GL.INVALID_OPERATION);
                return null;
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
                case GL.FRAMEBUFFER_ATTACHMENT_TEXTURE_LAYER:
                    return attached.kind === 'texture' ? [0] : (setError(GL.INVALID_ENUM), null);
                case GL.FRAMEBUFFER_ATTACHMENT_RED_SIZE:
                case GL.FRAMEBUFFER_ATTACHMENT_GREEN_SIZE:
                case GL.FRAMEBUFFER_ATTACHMENT_BLUE_SIZE:
                case GL.FRAMEBUFFER_ATTACHMENT_ALPHA_SIZE:
                    return [colour ? 8 : 0];
                case GL.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE:
                    return [image && image.holds !== 'colour' && image.holds !== 'stencil' ? 24
                        : 0];
                case GL.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE:
                    return [image && (image.holds === 'stencil' || image.holds === 'depthStencil')
                        ? 8 : 0];
                case GL.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE:
                    return [GL.UNSIGNED_NORMALIZED];
                case GL.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING:
                    return [GL.LINEAR_COLOR];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        // --- renderbuffers ---

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
            for (const fbo of framebuffers.values())
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
         * each half the one above, made from it on the device.
         *
         * @param {number} target
         */
        glGenerateMipmap(target){
            if (!enter('glGenerateMipmap', [target]))
            {
                return;
            }
            if (target !== GL.TEXTURE_2D && target !== GL.TEXTURE_CUBE_MAP)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const unit = kernel.side.activeUnit();
            const texture = kernel.side.textureBoundAt(unit, target)
                ?? kernel.side.units[unit].defaults.get(target);
            const faces = target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
            const base = texture?.levels.get(levelKey(0));
            if (!texture || !base)
            {
                return;
            }
            if (faces === 6 && (base.width !== base.height
                || [1, 2, 3, 4, 5].some(face=>!texture.levels.get(levelKey(0, face)))))
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const levels = Math.floor(Math.log2(Math.max(base.width, base.height))) + 1;
            for (let face = 0; face < faces; face++)
            {
                const top = texture.levels.get(levelKey(0, face));
                for (let level = 1; level < levels; level++)
                {
                    texture.levels.set(levelKey(level, face), {
                        width: Math.max(1, base.width >> level),
                        height: Math.max(1, base.height >> level),
                        internalFormat: top.internalFormat, border: 0,
                        baseFormat: top.baseFormat,
                        // On a device the levels are made there, from what it holds.
                        texels: kernel.gpuBacked() ? null
                            : downsample(top.texels, base.width, base.height, level),
                        compressed: null,
                    });
                }
            }
            kernel.generateMipmap?.(texture);
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
 * A mipmap level's texels made from the base level's by averaging, where
 * the context keeps the base level's: the processor's half of
 * glGenerateMipmap. A level rendered on the device has none here, and is
 * made there.
 *
 * @param {Uint8Array | null} texels @param {number} width @param {number} height
 * @param {number} level
 * @returns {Uint8Array | null}
 */
function downsample(texels, width, height, level){
    if (!texels)
    {
        return null;
    }
    const w = Math.max(1, width >> level);
    const h = Math.max(1, height >> level);
    const step = 1 << level;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
    {
        for (let x = 0; x < w; x++)
        {
            for (let c = 0; c < 4; c++)
            {
                let sum = 0;
                let count = 0;
                for (let dy = 0; dy < step && y * step + dy < height; dy++)
                {
                    for (let dx = 0; dx < step && x * step + dx < width; dx++)
                    {
                        sum += texels[((y * step + dy) * width + x * step + dx) * 4 + c];
                        count++;
                    }
                }
                out[(y * w + x) * 4 + c] = Math.round(sum / Math.max(1, count));
            }
        }
    }
    return out;
}

