/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import {
    chooseContextVersion, CREATE_CONTEXT_ERROR, DEFAULT_VERSION, IMPLEMENTED_VERSION, WGL_CONTEXT,
} from './version.js';

const { MAJOR_VERSION: MAJOR, MINOR_VERSION: MINOR, FLAGS, PROFILE_MASK: PROFILE } = WGL_CONTEXT;
/** An implementation of the whole of 4.6, to read the rules past what this one has. */
const ALL = { major: 4, minor: 6 };

test('a version that is not one, or past the implementation\'s, is refused', ()=>{
    for (const [major, minor] of [[1, 6], [2, 2], [3, 4], [4, 7], [5, 0], [0, 0], [1, -1]])
    {
        assert.deepEqual(chooseContextVersion([MAJOR, major, MINOR, minor], ALL),
            { error: CREATE_CONTEXT_ERROR.INVALID_VERSION }, `${major}.${minor}`);
    }
    assert.deepEqual(chooseContextVersion([MAJOR, 3, MINOR, 2], { major: 3, minor: 1 }),
        { error: CREATE_CONTEXT_ERROR.INVALID_VERSION });
    // Forward-compatible is a 3.0 idea.
    assert.deepEqual(chooseContextVersion([MAJOR, 2, MINOR, 1, FLAGS,
        WGL_CONTEXT.FORWARD_COMPATIBLE_BIT], ALL), { error: CREATE_CONTEXT_ERROR.INVALID_VERSION });
});

test('an attribute, a flag or a plane not known is refused, and a profile of 3.2 must be one',
    ()=>{
        assert.deepEqual(chooseContextVersion([0x2099, 1], ALL),
            { error: CREATE_CONTEXT_ERROR.INVALID_PARAMETER });
        assert.deepEqual(chooseContextVersion([FLAGS, 0x8], ALL),
            { error: CREATE_CONTEXT_ERROR.INVALID_PARAMETER });
        assert.deepEqual(chooseContextVersion([WGL_CONTEXT.LAYER_PLANE, 1], ALL),
            { error: CREATE_CONTEXT_ERROR.INVALID_PARAMETER });
        for (const mask of [0, 3, 4])
        {
            assert.deepEqual(chooseContextVersion([MAJOR, 3, MINOR, 2, PROFILE, mask], ALL),
                { error: CREATE_CONTEXT_ERROR.INVALID_PROFILE }, `mask ${mask}`);
        }
        // Before 3.2 the mask is not read.
        assert.ok('version' in chooseContextVersion([MAJOR, 3, MINOR, 1, PROFILE, 4], ALL));
    });

test('an earlier version, not forward-compatible and below 3.1, gets the implementation\'s with '
    + 'the compatibility profile', ()=>{
    for (const attributes of [[], [MAJOR, 1], [MAJOR, 2, MINOR, 1], [MAJOR, 3, MINOR, 0]])
    {
        assert.deepEqual(chooseContextVersion(attributes, ALL), { version: { major: 4, minor: 6,
            profile: GL.CONTEXT_COMPATIBILITY_PROFILE_BIT, flags: 0 } }, String(attributes));
    }
    // WGL's debug bit is GL's second.
    assert.deepEqual(chooseContextVersion([FLAGS, WGL_CONTEXT.DEBUG_BIT], ALL), { version: {
        major: 4, minor: 6, profile: GL.CONTEXT_COMPATIBILITY_PROFILE_BIT,
        flags: GL.CONTEXT_FLAG_DEBUG_BIT } });
});

test('3.1 and later, or forward-compatible, are the version asked for, core unless asked', ()=>{
    assert.deepEqual(chooseContextVersion([MAJOR, 3, MINOR, 0, FLAGS,
        WGL_CONTEXT.FORWARD_COMPATIBLE_BIT], ALL), { version: { major: 3, minor: 0, profile: 0,
        flags: GL.CONTEXT_FLAG_FORWARD_COMPATIBLE_BIT } });
    assert.deepEqual(chooseContextVersion([MAJOR, 3, MINOR, 1], ALL),
        { version: { major: 3, minor: 1, profile: 0, flags: 0 } });
    assert.deepEqual(chooseContextVersion([MAJOR, 3, MINOR, 2], ALL),
        { version: { major: 3, minor: 2, profile: GL.CONTEXT_CORE_PROFILE_BIT, flags: 0 } });
    assert.deepEqual(chooseContextVersion([MAJOR, 4, MINOR, 5, PROFILE,
        WGL_CONTEXT.COMPATIBILITY_PROFILE_BIT], ALL), { version: { major: 4, minor: 5,
        profile: GL.CONTEXT_COMPATIBILITY_PROFILE_BIT, flags: 0 } });
});

test('a context of 3.0 answers its version, extensions and flags; of 3.2 its profile too', ()=>{
    const extensions = ['GL_ARB_one', 'GL_EXT_two'];
    /** @param {any} version */
    const make = version=>/** @type {any} */ (createGlContext({ extensions, version }));
    const old = make(undefined);
    assert.equal(old.glGetString(GL.VERSION), `${IMPLEMENTED_VERSION.major}.`
        + `${IMPLEMENTED_VERSION.minor}`);
    assert.equal(old.version, DEFAULT_VERSION);
    for (const query of [GL.MAJOR_VERSION, GL.NUM_EXTENSIONS, GL.CONTEXT_PROFILE_MASK])
    {
        assert.equal(old.glGetIntegerv(query), null);
        assert.equal(old.glGetError(), GL.INVALID_ENUM);
    }

    const three = make({ major: 3, minor: 0, profile: 0, flags: 1 });
    assert.equal(three.glGetString(GL.VERSION), '3.0');
    assert.equal(three.glGetString(GL.SHADING_LANGUAGE_VERSION), '1.30');
    assert.deepEqual([GL.MAJOR_VERSION, GL.MINOR_VERSION, GL.NUM_EXTENSIONS, GL.CONTEXT_FLAGS]
        .map(query=>three.glGetIntegerv(query)), [[3], [0], [2], [1]]);
    assert.equal(three.glGetIntegerv(GL.CONTEXT_PROFILE_MASK), null);
    assert.equal(three.glGetError(), GL.INVALID_ENUM);

    const core = make({ major: 3, minor: 2, profile: GL.CONTEXT_CORE_PROFILE_BIT, flags: 0 });
    assert.deepEqual(core.glGetIntegerv(GL.CONTEXT_PROFILE_MASK), [GL.CONTEXT_CORE_PROFILE_BIT]);
    assert.equal(core.glGetString(GL.SHADING_LANGUAGE_VERSION), '1.50');

    assert.equal(core.glGetStringi(GL.EXTENSIONS, 1), 'GL_EXT_two');
    assert.equal(core.glGetError(), GL.NO_ERROR);
    assert.equal(core.glGetStringi(GL.EXTENSIONS, 2), null);
    assert.equal(core.glGetError(), GL.INVALID_VALUE);
    assert.equal(core.glGetStringi(GL.VERSION, 0), null);
    assert.equal(core.glGetError(), GL.INVALID_ENUM);
});
