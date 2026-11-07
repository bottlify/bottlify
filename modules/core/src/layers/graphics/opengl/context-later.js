/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The smaller calls of OpenGL 4.0 to 4.5 that change what a program may
 * assume rather than what is drawn.
 *
 * - **Invalidation drops nothing** (4.3 sections 6.5, 8.20, 9.2.8): a
 *   buffer's, a texture's or an attachment's contents become undefined, and
 *   the contents they keep are among the undefined ones; the checks are made.
 * - **Barriers wait for nothing** (4.2's glMemoryBarrier, 4.5's
 *   glTextureBarrier): every command reaches the device in the order it was
 *   made and each draw is replayed after the one before, so what a barrier
 *   orders is ordered already; the bits are checked.
 * - **Sample shading is kept and does nothing** (4.0): every framebuffer
 *   here is drawn with one sample a pixel, which is already shaded once each.
 * - **glGetInternalformativ** answers what each format is here: the sample
 *   counts up to GL_MAX_SAMPLES (4.2), and whether a format is one at all.
 */

import { GL } from './constants.js';
import { SIZED_FORMATS } from './formats.js';

/** The calls of this file a display list does not record: all but the sample shading. */
export const LATER_CALLS_NOT_COMPILED = Object.freeze([
    'glInvalidateFramebuffer', 'glInvalidateBufferData', 'glInvalidateTexImage',
    'glMemoryBarrier', 'glTextureBarrier', 'glGetInternalformativ', 'glGetGraphicsResetStatus',
    'glBindSamplers', 'glBindBuffers',
]);

/** Every barrier bit of 4.4 (table 7.4), and GL_ALL_BARRIER_BITS. */
const BARRIER_BITS = 0xffff;
const ALL_BARRIER_BITS = 0xffffffff;

/** The bits glMemoryBarrierByRegion takes (4.5). */
const REGION_BARRIER_BITS = 0x0004 | 0x0008 | 0x0020 | 0x0400 | 0x2000 | 0x0800;

/**
 * The indexed buffer targets glBindBuffers takes, each with the query of how
 * many points it has; the targets later installers add join through
 * `kernel.side.bufferBindingLimits`.
 *
 * @type {Map<number, number>}
 */
const BINDING_LIMITS = new Map([
    [GL.UNIFORM_BUFFER, GL.MAX_UNIFORM_BUFFER_BINDINGS],
    [GL.TRANSFORM_FEEDBACK_BUFFER, GL.MAX_TRANSFORM_FEEDBACK_BUFFERS],
]);

/** glGetInternalformativ's names (4.2, 4.3). */
const FORMAT_QUERY = Object.freeze({
    NUM_SAMPLE_COUNTS: 0x9380,
    SAMPLES: 0x80a9,
    INTERNALFORMAT_SUPPORTED: 0x826f,
    INTERNALFORMAT_PREFERRED: 0x8270,
});

/** The base formats glGetInternalformativ also takes. */
/** @type {ReadonlySet<number>} */
const BASE_FORMATS = new Set([GL.RGB, GL.RGBA, GL.ALPHA, GL.LUMINANCE, GL.LUMINANCE_ALPHA,
    GL.RED, 0x8227, GL.DEPTH_COMPONENT, GL.DEPTH_STENCIL, GL.STENCIL_INDEX]);

/** The targets glGetInternalformativ takes (4.3 table 22.3). */
/** @type {ReadonlySet<number>} */
const FORMAT_TARGETS = new Set([GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D,
    GL.TEXTURE_CUBE_MAP, 0x8c18 /* 1D_ARRAY */, 0x8c1a /* 2D_ARRAY */,
    0x9009 /* CUBE_MAP_ARRAY */, 0x84f5 /* RECTANGLE */, 0x8c2a /* BUFFER */,
    // 2D_MULTISAMPLE and 2D_MULTISAMPLE_ARRAY.
    GL.RENDERBUFFER, 0x9100, 0x9102]);

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installLaterCalls(context, kernel){
    const { enter, setError, setState, record } = kernel;

    /** @param {number} name @returns {import('./objects.js').BufferObject | undefined} */
    const bufferNamed = name=>(name === 0 ? undefined
        : kernel.shareGroup().buffers.objects.get(name));

    Object.assign(context, {
        /**
         * glInvalidateFramebuffer and glInvalidateSubFramebuffer: the named
         * form's, on the framebuffer bound to `target`.
         *
         * @param {number} target @param {number} count @param {readonly number[]} attachments
         * @param {{ width: number, height: number } | null} box
         */
        glInvalidateFramebuffer(target, count, attachments, box){
            if (!enter('glInvalidateFramebuffer', [target, count, attachments, box]))
            {
                return;
            }
            const query = target === GL.READ_FRAMEBUFFER ? GL.READ_FRAMEBUFFER_BINDING
                : target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER
                    ? GL.FRAMEBUFFER_BINDING : 0;
            if (query === 0)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            context.glInvalidateNamedFramebuffer(record(query).values[0], count, attachments,
                box);
        },

        /**
         * glInvalidateBufferData and glInvalidateBufferSubData.
         *
         * @param {number} name @param {number | null} offset  null for the whole
         * @param {number} length
         */
        glInvalidateBufferData(name, offset, length){
            if (!enter('glInvalidateBufferData', [name, offset, length]))
            {
                return;
            }
            const buffer = bufferNamed(name);
            if (!buffer || (offset !== null
                && (offset < 0 || length < 0 || offset + length > buffer.size)))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (buffer.mapped !== 0 && (buffer.accessFlags & GL.MAP_PERSISTENT_BIT) === 0)
            {
                setError(GL.INVALID_OPERATION);
            }
        },

        /**
         * glInvalidateTexImage and glInvalidateTexSubImage.
         *
         * @param {number} name @param {number} level
         * @param {{ x: number, y: number, z: number, width: number, height: number,
         *     depth: number } | null} box  null for the whole level
         */
        glInvalidateTexImage(name, level, box){
            if (!enter('glInvalidateTexImage', [name, level, box]))
            {
                return;
            }
            const texture = name === 0 ? undefined
                : kernel.shareGroup().textures.objects.get(name);
            if (!texture || level < 0 || level > 30
                || (box && (box.width < 0 || box.height < 0 || box.depth < 0
                    || box.x < 0 || box.y < 0 || box.z < 0)))
            {
                setError(GL.INVALID_VALUE);
            }
        },

        /**
         * glMemoryBarrier, and glMemoryBarrierByRegion (4.5) when `region`.
         *
         * @param {number} barriers @param {boolean} region
         */
        glMemoryBarrier(barriers, region){
            if (!enter('glMemoryBarrier', [barriers, region]))
            {
                return;
            }
            const allowed = region ? REGION_BARRIER_BITS : BARRIER_BITS;
            if (barriers >>> 0 !== ALL_BARRIER_BITS && (barriers & ~allowed) !== 0)
            {
                setError(GL.INVALID_VALUE);
            }
        },

        glTextureBarrier(){
            enter('glTextureBarrier', []);
        },

        /**
         * glGetGraphicsResetStatus (4.5, KHR_robustness): no context here is
         * ever lost to a reset the program could see.
         *
         * @returns {number}
         */
        glGetGraphicsResetStatus(){
            return enter('glGetGraphicsResetStatus', []) ? GL.NO_ERROR : GL.NO_ERROR;
        },

        /**
         * glBindSamplers (4.4): each unit from `first` its sampler, or none;
         * a name that is no sampler is refused and the rest still bound.
         *
         * @param {number} first @param {number} count @param {readonly number[] | null} names
         */
        glBindSamplers(first, count, names){
            if (!enter('glBindSamplers', [first, count, names]))
            {
                return;
            }
            if (first + count > record(GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS).values[0])
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            for (let k = 0; k < count; k++)
            {
                const name = names?.[k] ?? 0;
                if (name !== 0 && context.glIsSampler(name) !== GL.TRUE)
                {
                    setError(GL.INVALID_OPERATION);
                    continue;
                }
                context.glBindSampler(first + k, name);
            }
        },

        /**
         * glBindBuffersBase and glBindBuffersRange (4.4): each binding point
         * from `first` its buffer, or none; one refused leaves the rest bound.
         *
         * @param {number} target @param {number} first @param {number} count
         * @param {readonly number[] | null} names
         * @param {{ offsets: readonly number[], sizes: readonly number[] } | null} ranges
         */
        glBindBuffers(target, first, count, names, ranges){
            if (!enter('glBindBuffers', [target, first, count, names, ranges]))
            {
                return;
            }
            const limit = BINDING_LIMITS.get(target)
                ?? kernel.side.bufferBindingLimits?.get(target);
            if (limit === undefined)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (first + count > record(limit).values[0])
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            for (let k = 0; k < count; k++)
            {
                const name = names?.[k] ?? 0;
                if (name !== 0 && context.glIsBufferARB(name) !== GL.TRUE)
                {
                    setError(GL.INVALID_OPERATION);
                    continue;
                }
                if (ranges && name !== 0)
                {
                    // An offset or size refused is glBindBufferRange's error.
                    context.glBindBufferRange(target, first + k, name, ranges.offsets[k],
                        ranges.sizes[k]);
                }
                else
                {
                    context.glBindBufferBase(target, first + k, name);
                }
            }
        },

        /** @param {number} value */
        glMinSampleShading(value){
            if (enter('glMinSampleShading', [value]))
            {
                setState(GL.MIN_SAMPLE_SHADING_VALUE, [Math.min(1, Math.max(0, value))]);
            }
        },

        /**
         * @param {number} target @param {number} internal @param {number} pname
         * @returns {number[] | null}
         */
        glGetInternalformativ(target, internal, pname){
            if (!enter('glGetInternalformativ', [target, internal, pname]))
            {
                return null;
            }
            if (!FORMAT_TARGETS.has(target))
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            const known = SIZED_FORMATS.has(internal) || BASE_FORMATS.has(internal);
            const most = record(GL.MAX_SAMPLES).values[0];
            const counts = [];
            for (let count = most; count > 1; count >>= 1)
            {
                counts.push(count);
            }
            const multisampled = target === GL.RENDERBUFFER || target === 0x9100
                || target === 0x9102;
            switch (pname)
            {
                case FORMAT_QUERY.NUM_SAMPLE_COUNTS:
                    return [known && multisampled ? counts.length : 0];
                case FORMAT_QUERY.SAMPLES:
                    return known && multisampled ? counts : [];
                case FORMAT_QUERY.INTERNALFORMAT_SUPPORTED:
                    return [known ? GL.TRUE : GL.FALSE];
                case FORMAT_QUERY.INTERNALFORMAT_PREFERRED:
                    return [known ? internal : GL.NONE];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },
    });
}
