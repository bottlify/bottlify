/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which OpenGL a context is: its version, profile and flags, and how
 * wglCreateContextAttribsARB's attributes choose them (WGL_ARB_create_context,
 * WGL_ARB_create_context_profile).
 *
 * - **The version is the implementation's** (`IMPLEMENTED_VERSION`): the
 *   highest one whose every entry point is here. A context asked for an
 *   earlier version that is not forward-compatible, below 3.1, gets this one
 *   with the compatibility profile, which keeps everything the earlier one
 *   had; one asked for 3.1 or later, or forward-compatible, gets exactly what
 *   it asked for, as the drivers Wine's tests measured answer. A version past
 *   this implementation's is refused.
 * - **What a version adds to the queries** (`versionState`): 3.0 answers
 *   GL_MAJOR_VERSION, GL_MINOR_VERSION, GL_NUM_EXTENSIONS and
 *   GL_CONTEXT_FLAGS, and glGetStringi; 3.2 GL_CONTEXT_PROFILE_MASK.
 *   Below them they are GL_INVALID_ENUM, as in a driver of that version.
 */

import { GL } from './constants.js';

/** The highest version every entry point of which is implemented. */
export const IMPLEMENTED_VERSION = Object.freeze({ major: 2, minor: 1 });

/** The versions OpenGL has: a minor version past its major's last is no version. */
const LAST_MINOR = Object.freeze(/** @type {Record<number, number>} */ ({ 1: 5, 2: 1, 3: 3, 4: 6 }));

/** Each version's GLSL, as GL_SHADING_LANGUAGE_VERSION names it. */
const GLSL_OF = Object.freeze(/** @type {Record<string, string>} */ ({
    '2.0': '1.10', '2.1': '1.20', '3.0': '1.30', '3.1': '1.40', '3.2': '1.50', '3.3': '3.30',
    '4.0': '4.00', '4.1': '4.10', '4.2': '4.20', '4.3': '4.30', '4.4': '4.40', '4.5': '4.50',
    '4.6': '4.60',
}));

/** WGL_ARB_create_context's attributes and bits. */
export const WGL_CONTEXT = Object.freeze({
    MAJOR_VERSION: 0x2091,
    MINOR_VERSION: 0x2092,
    LAYER_PLANE: 0x2093,
    FLAGS: 0x2094,
    PROFILE_MASK: 0x9126,
    DEBUG_BIT: 0x1,
    FORWARD_COMPATIBLE_BIT: 0x2,
    CORE_PROFILE_BIT: 0x1,
    COMPATIBILITY_PROFILE_BIT: 0x2,
});

/** The errors wglCreateContextAttribsARB sets beyond Win32's own. */
export const CREATE_CONTEXT_ERROR = Object.freeze({
    INVALID_VERSION: 0x2095,
    INVALID_PROFILE: 0x2096,
    INVALID_PARAMETER: 87,
});

/**
 * @typedef {object} ContextVersion
 * @property {number} major
 * @property {number} minor
 * @property {number} profile  GL_CONTEXT_PROFILE_MASK's bits: 1 core, 2 compatibility
 * @property {number} flags  GL_CONTEXT_FLAGS' bits: 1 forward-compatible, 2 debug
 */

/** What a context made without attributes is: wglCreateContext's. */
export const DEFAULT_VERSION = Object.freeze(/** @type {ContextVersion} */ ({
    ...IMPLEMENTED_VERSION, profile: GL.CONTEXT_COMPATIBILITY_PROFILE_BIT, flags: 0,
}));

/**
 * @param {{ major: number, minor: number }} version
 * @param {number} major @param {number} minor
 */
export function versionAtLeast(version, major, minor){
    return version.major > major || (version.major === major && version.minor >= minor);
}

/** @param {{ major: number, minor: number }} version @returns {string} GL_VERSION */
export function versionString(version){
    return `${version.major}.${version.minor}`;
}

/** @param {{ major: number, minor: number }} version @returns {string} */
export function shadingLanguageVersion(version){
    return GLSL_OF[versionString(version)] ?? '1.10';
}

/**
 * The context wglCreateContextAttribsARB's attributes ask for.
 *
 * @param {readonly number[]} attributes  name and value pairs, the list's terminator dropped
 * @param {{ major: number, minor: number }} [implemented]
 * @returns {{ version: ContextVersion } | { error: number }}
 */
export function chooseContextVersion(attributes, implemented = IMPLEMENTED_VERSION){
    let major = 1;
    let minor = 0;
    let flags = 0;
    let profile = /** @type {number} */ (WGL_CONTEXT.CORE_PROFILE_BIT);
    for (let at = 0; at + 1 < attributes.length; at += 2)
    {
        const value = attributes[at + 1];
        switch (attributes[at])
        {
            case WGL_CONTEXT.MAJOR_VERSION: major = value; break;
            case WGL_CONTEXT.MINOR_VERSION: minor = value; break;
            case WGL_CONTEXT.FLAGS: flags = value; break;
            case WGL_CONTEXT.PROFILE_MASK: profile = value; break;
            case WGL_CONTEXT.LAYER_PLANE:
                // The main plane is the only one a pixel format here has.
                if (value !== 0)
                {
                    return { error: CREATE_CONTEXT_ERROR.INVALID_PARAMETER };
                }
                break;
            default:
                return { error: CREATE_CONTEXT_ERROR.INVALID_PARAMETER };
        }
    }
    const known = WGL_CONTEXT.DEBUG_BIT | WGL_CONTEXT.FORWARD_COMPATIBLE_BIT;
    if ((flags & ~known) !== 0)
    {
        return { error: CREATE_CONTEXT_ERROR.INVALID_PARAMETER };
    }
    const forward = (flags & WGL_CONTEXT.FORWARD_COMPATIBLE_BIT) !== 0;
    if (!(major in LAST_MINOR) || minor < 0 || minor > LAST_MINOR[major]
        || (forward && major < 3))
    {
        return { error: CREATE_CONTEXT_ERROR.INVALID_VERSION };
    }
    const asked = { major, minor };
    // A profile is asked of 3.2 and later; before it the mask is not read.
    const profiled = versionAtLeast(asked, 3, 2);
    if (profiled && profile !== WGL_CONTEXT.CORE_PROFILE_BIT
        && profile !== WGL_CONTEXT.COMPATIBILITY_PROFILE_BIT)
    {
        return { error: CREATE_CONTEXT_ERROR.INVALID_PROFILE };
    }
    if (!versionAtLeast(implemented, major, minor))
    {
        return { error: CREATE_CONTEXT_ERROR.INVALID_VERSION };
    }
    const glFlags = (forward ? GL.CONTEXT_FLAG_FORWARD_COMPATIBLE_BIT : 0)
        | ((flags & WGL_CONTEXT.DEBUG_BIT) !== 0 ? GL.CONTEXT_FLAG_DEBUG_BIT : 0);
    if (!forward && !versionAtLeast(asked, 3, 1))
    {
        return { version: { ...implemented, profile: GL.CONTEXT_COMPATIBILITY_PROFILE_BIT,
            flags: glFlags } };
    }
    return { version: { major, minor, flags: glFlags,
        profile: !profiled ? 0
            : profile === WGL_CONTEXT.CORE_PROFILE_BIT ? GL.CONTEXT_CORE_PROFILE_BIT
                : GL.CONTEXT_COMPATIBILITY_PROFILE_BIT } };
}

/**
 * The queries a context's version adds, as state records.
 *
 * @param {ContextVersion} version
 * @param {number} extensionCount
 * @returns {{ query: number, kind: 'int', values: number[] }[]}
 */
export function versionState(version, extensionCount){
    if (!versionAtLeast(version, 3, 0))
    {
        return [];
    }
    /** @type {{ query: number, kind: 'int', values: number[] }[]} */
    const entries = [
        { query: GL.MAJOR_VERSION, kind: 'int', values: [version.major] },
        { query: GL.MINOR_VERSION, kind: 'int', values: [version.minor] },
        { query: GL.NUM_EXTENSIONS, kind: 'int', values: [extensionCount] },
        { query: GL.CONTEXT_FLAGS, kind: 'int', values: [version.flags] },
    ];
    if (versionAtLeast(version, 3, 2))
    {
        entries.push({ query: GL.CONTEXT_PROFILE_MASK, kind: 'int', values: [version.profile] });
    }
    return entries;
}
