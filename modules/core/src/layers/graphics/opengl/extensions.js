/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The extensions this implementation reports, and the entry points each one
 * adds.
 *
 * The list is the contract with a program in two directions at once. A name
 * in `glGetString(GL_EXTENSIONS)` is a promise that every function the
 * extension defines is obtainable through wglGetProcAddress; a program that
 * finds the name and then a null pointer crashes on the first call. And a
 * name absent from the string is a promise that the pointer is null, which
 * a program uses to choose a slower path. So what is listed here is exactly
 * what `context.js` implements and `exports.js` marshals, no more, and the
 * test checks all three agree.
 *
 * Extension functions are exported from the same synthesised module as the
 * core ones -- a module is the only thing that has addresses -- so their
 * stack sizes are written down here in the same form as the core table, and
 * for the same reason: a wrong count is a process lost far from the call.
 *
 * Names are never aliased. `glActiveTextureARB` is what GL_ARB_multitexture
 * defines and is the name that is answered; an unsuffixed `glActiveTexture`
 * belongs to a version this implementation does not claim.
 */

/** GL extensions: name -> the functions it defines. */
export const GL_EXTENSIONS = Object.freeze({
    GL_ARB_multitexture: [
        'glActiveTextureARB', 'glClientActiveTextureARB',
        'glMultiTexCoord1dARB', 'glMultiTexCoord1dvARB', 'glMultiTexCoord1fARB',
        'glMultiTexCoord1fvARB', 'glMultiTexCoord1iARB', 'glMultiTexCoord1ivARB',
        'glMultiTexCoord1sARB', 'glMultiTexCoord1svARB',
        'glMultiTexCoord2dARB', 'glMultiTexCoord2dvARB', 'glMultiTexCoord2fARB',
        'glMultiTexCoord2fvARB', 'glMultiTexCoord2iARB', 'glMultiTexCoord2ivARB',
        'glMultiTexCoord2sARB', 'glMultiTexCoord2svARB',
        'glMultiTexCoord3dARB', 'glMultiTexCoord3dvARB', 'glMultiTexCoord3fARB',
        'glMultiTexCoord3fvARB', 'glMultiTexCoord3iARB', 'glMultiTexCoord3ivARB',
        'glMultiTexCoord3sARB', 'glMultiTexCoord3svARB',
        'glMultiTexCoord4dARB', 'glMultiTexCoord4dvARB', 'glMultiTexCoord4fARB',
        'glMultiTexCoord4fvARB', 'glMultiTexCoord4iARB', 'glMultiTexCoord4ivARB',
        'glMultiTexCoord4sARB', 'glMultiTexCoord4svARB',
    ],
    GL_ARB_texture_env_add: [],
    GL_EXT_texture_env_add: [],
    GL_ARB_texture_env_combine: [],
    GL_EXT_texture_env_combine: [],
    GL_ARB_texture_env_dot3: [],
    GL_ARB_texture_compression: [
        'glCompressedTexImage1DARB', 'glCompressedTexImage2DARB', 'glCompressedTexImage3DARB',
        'glCompressedTexSubImage1DARB', 'glCompressedTexSubImage2DARB',
        'glCompressedTexSubImage3DARB', 'glGetCompressedTexImageARB',
    ],
    GL_EXT_texture_compression_s3tc: [],
    GL_ARB_vertex_buffer_object: [
        'glBindBufferARB', 'glDeleteBuffersARB', 'glGenBuffersARB', 'glIsBufferARB',
        'glBufferDataARB', 'glBufferSubDataARB', 'glGetBufferSubDataARB', 'glMapBufferARB',
        'glUnmapBufferARB', 'glGetBufferParameterivARB', 'glGetBufferPointervARB',
    ],
    GL_EXT_compiled_vertex_array: ['glLockArraysEXT', 'glUnlockArraysEXT'],
    GL_ARB_texture_cube_map: [],
    GL_EXT_texture_cube_map: [],
    GL_EXT_secondary_color: [
        'glSecondaryColor3bEXT', 'glSecondaryColor3bvEXT', 'glSecondaryColor3dEXT',
        'glSecondaryColor3dvEXT', 'glSecondaryColor3fEXT', 'glSecondaryColor3fvEXT',
        'glSecondaryColor3iEXT', 'glSecondaryColor3ivEXT', 'glSecondaryColor3sEXT',
        'glSecondaryColor3svEXT', 'glSecondaryColor3ubEXT', 'glSecondaryColor3ubvEXT',
        'glSecondaryColor3uiEXT', 'glSecondaryColor3uivEXT', 'glSecondaryColor3usEXT',
        'glSecondaryColor3usvEXT', 'glSecondaryColorPointerEXT',
    ],
    GL_EXT_fog_coord: [
        'glFogCoordfEXT', 'glFogCoordfvEXT', 'glFogCoorddEXT', 'glFogCoorddvEXT',
        'glFogCoordPointerEXT',
    ],
    GL_EXT_draw_range_elements: ['glDrawRangeElementsEXT'],
    GL_EXT_bgra: [],
    GL_EXT_packed_pixels: [],
    GL_EXT_texture_edge_clamp: [],
    GL_SGIS_texture_edge_clamp: [],
    GL_ARB_texture_mirrored_repeat: [],
    GL_EXT_rescale_normal: [],
    GL_EXT_separate_specular_color: [],
});

/** WGL extensions: name -> the functions it defines. */
export const WGL_EXTENSIONS = Object.freeze({
    WGL_ARB_extensions_string: ['wglGetExtensionsStringARB'],
    WGL_EXT_extensions_string: ['wglGetExtensionsStringEXT'],
    WGL_ARB_pixel_format: [
        'wglGetPixelFormatAttribivARB', 'wglGetPixelFormatAttribfvARB', 'wglChoosePixelFormatARB',
    ],
    WGL_EXT_swap_control: ['wglSwapIntervalEXT', 'wglGetSwapIntervalEXT'],
});

/**
 * Every extension function, grouped by how many stack words it takes -- the
 * same form as the core table, for the same reason.
 *
 * @type {Readonly<Record<number, readonly string[]>>}
 */
export const EXTENSION_WORDS = Object.freeze({
    0: ['glUnlockArraysEXT', 'wglGetExtensionsStringEXT', 'wglGetSwapIntervalEXT'],
    1: [
        'glActiveTextureARB', 'glClientActiveTextureARB', 'glIsBufferARB', 'glUnmapBufferARB',
        'glSecondaryColor3bvEXT', 'glSecondaryColor3dvEXT', 'glSecondaryColor3fvEXT',
        'glSecondaryColor3ivEXT', 'glSecondaryColor3svEXT', 'glSecondaryColor3ubvEXT',
        'glSecondaryColor3uivEXT', 'glSecondaryColor3usvEXT', 'glFogCoordfEXT',
        'glFogCoordfvEXT', 'glFogCoorddvEXT', 'wglGetExtensionsStringARB', 'wglSwapIntervalEXT'
    ],
    2: [
        'glMultiTexCoord1fARB', 'glMultiTexCoord1iARB', 'glMultiTexCoord1sARB',
        'glMultiTexCoord1dvARB', 'glMultiTexCoord1fvARB', 'glMultiTexCoord1ivARB',
        'glMultiTexCoord1svARB', 'glMultiTexCoord2dvARB', 'glMultiTexCoord2fvARB',
        'glMultiTexCoord2ivARB', 'glMultiTexCoord2svARB', 'glMultiTexCoord3dvARB',
        'glMultiTexCoord3fvARB', 'glMultiTexCoord3ivARB', 'glMultiTexCoord3svARB',
        'glMultiTexCoord4dvARB', 'glMultiTexCoord4fvARB', 'glMultiTexCoord4ivARB',
        'glMultiTexCoord4svARB', 'glBindBufferARB', 'glDeleteBuffersARB', 'glGenBuffersARB',
        'glMapBufferARB', 'glLockArraysEXT', 'glFogCoorddEXT'
    ],
    3: [
        'glMultiTexCoord1dARB', 'glMultiTexCoord2fARB', 'glMultiTexCoord2iARB',
        'glMultiTexCoord2sARB', 'glGetCompressedTexImageARB', 'glGetBufferParameterivARB',
        'glGetBufferPointervARB', 'glSecondaryColor3bEXT', 'glSecondaryColor3fEXT',
        'glSecondaryColor3iEXT', 'glSecondaryColor3sEXT', 'glSecondaryColor3ubEXT',
        'glSecondaryColor3uiEXT', 'glSecondaryColor3usEXT', 'glFogCoordPointerEXT'
    ],
    4: [
        'glMultiTexCoord3fARB', 'glMultiTexCoord3iARB', 'glMultiTexCoord3sARB',
        'glBufferDataARB', 'glBufferSubDataARB', 'glGetBufferSubDataARB',
        'glSecondaryColorPointerEXT'
    ],
    5: [
        'glMultiTexCoord2dARB', 'glMultiTexCoord4fARB', 'glMultiTexCoord4iARB',
        'glMultiTexCoord4sARB'
    ],
    6: [
        'glSecondaryColor3dEXT', 'glDrawRangeElementsEXT', 'wglGetPixelFormatAttribivARB',
        'wglGetPixelFormatAttribfvARB', 'wglChoosePixelFormatARB'
    ],
    7: [
        'glMultiTexCoord3dARB', 'glCompressedTexImage1DARB', 'glCompressedTexSubImage1DARB'
    ],
    8: ['glCompressedTexImage2DARB'],
    9: [
        'glMultiTexCoord4dARB', 'glCompressedTexImage3DARB', 'glCompressedTexSubImage2DARB'
    ],
    10: [],
    11: ['glCompressedTexSubImage3DARB'],
});

/** Every extension function name, for telling one from a core entry point. */
export const EXTENSION_FUNCTIONS = Object.freeze(new Set([
    ...Object.values(GL_EXTENSIONS).flat(),
    ...Object.values(WGL_EXTENSIONS).flat(),
]));
