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
 * A suffixed name is its extension's and an unsuffixed one its version's:
 * `glActiveTextureARB` is answered because GL_ARB_multitexture is reported,
 * `glActiveTexture` because the version (2.1) includes OpenGL 1.3. A
 * version's functions past 1.1 are obtained the same way an extension's are,
 * since OPENGL32.dll exports 1.1 alone, and are listed here under
 * `GL_VERSIONS`, which the extension string does not name.
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
    GL_EXT_blend_color: ['glBlendColorEXT'],
    GL_EXT_blend_minmax: ['glBlendEquationEXT'],
    GL_EXT_blend_subtract: [],
    GL_EXT_blend_func_separate: ['glBlendFuncSeparateEXT'],
    GL_ARB_texture_non_power_of_two: [],
    GL_ARB_framebuffer_object: [
        'glIsRenderbuffer', 'glBindRenderbuffer', 'glDeleteRenderbuffers', 'glGenRenderbuffers',
        'glRenderbufferStorage', 'glGetRenderbufferParameteriv', 'glIsFramebuffer',
        'glBindFramebuffer', 'glDeleteFramebuffers', 'glGenFramebuffers',
        'glCheckFramebufferStatus', 'glFramebufferTexture1D', 'glFramebufferTexture2D',
        'glFramebufferTexture3D', 'glFramebufferRenderbuffer',
        'glGetFramebufferAttachmentParameteriv', 'glGenerateMipmap', 'glBlitFramebuffer',
        'glRenderbufferStorageMultisample', 'glFramebufferTextureLayer',
    ],
    GL_EXT_framebuffer_object: [
        'glIsRenderbufferEXT', 'glBindRenderbufferEXT', 'glDeleteRenderbuffersEXT',
        'glGenRenderbuffersEXT', 'glRenderbufferStorageEXT', 'glGetRenderbufferParameterivEXT',
        'glIsFramebufferEXT', 'glBindFramebufferEXT', 'glDeleteFramebuffersEXT',
        'glGenFramebuffersEXT', 'glCheckFramebufferStatusEXT', 'glFramebufferTexture1DEXT',
        'glFramebufferTexture2DEXT', 'glFramebufferTexture3DEXT', 'glFramebufferRenderbufferEXT',
        'glGetFramebufferAttachmentParameterivEXT', 'glGenerateMipmapEXT',
    ],
    GL_EXT_framebuffer_blit: ['glBlitFramebufferEXT'],
    GL_EXT_framebuffer_multisample: ['glRenderbufferStorageMultisampleEXT'],
    GL_EXT_bgra: [],
    GL_EXT_packed_pixels: [],
    GL_EXT_texture_edge_clamp: [],
    GL_SGIS_texture_edge_clamp: [],
    GL_ARB_texture_mirrored_repeat: [],
    GL_EXT_rescale_normal: [],
    GL_EXT_separate_specular_color: [],
    // The program-object entry points are defined by both program extensions,
    // and a program that finds either name must find every one of them.
    GL_ARB_vertex_program: [
        'glGenProgramsARB', 'glDeleteProgramsARB', 'glIsProgramARB', 'glBindProgramARB',
        'glProgramStringARB',
        'glProgramEnvParameter4dARB', 'glProgramEnvParameter4dvARB',
        'glProgramEnvParameter4fARB', 'glProgramEnvParameter4fvARB',
        'glProgramLocalParameter4dARB', 'glProgramLocalParameter4dvARB',
        'glProgramLocalParameter4fARB', 'glProgramLocalParameter4fvARB',
        'glGetProgramEnvParameterdvARB', 'glGetProgramEnvParameterfvARB',
        'glGetProgramLocalParameterdvARB', 'glGetProgramLocalParameterfvARB',
        'glGetProgramivARB', 'glGetProgramStringARB',
        'glVertexAttrib1sARB', 'glVertexAttrib1fARB', 'glVertexAttrib1dARB',
        'glVertexAttrib2sARB', 'glVertexAttrib2fARB', 'glVertexAttrib2dARB',
        'glVertexAttrib3sARB', 'glVertexAttrib3fARB', 'glVertexAttrib3dARB',
        'glVertexAttrib4sARB', 'glVertexAttrib4fARB', 'glVertexAttrib4dARB',
        'glVertexAttrib4NubARB',
        'glVertexAttrib1svARB', 'glVertexAttrib1fvARB', 'glVertexAttrib1dvARB',
        'glVertexAttrib2svARB', 'glVertexAttrib2fvARB', 'glVertexAttrib2dvARB',
        'glVertexAttrib3svARB', 'glVertexAttrib3fvARB', 'glVertexAttrib3dvARB',
        'glVertexAttrib4bvARB', 'glVertexAttrib4svARB', 'glVertexAttrib4ivARB',
        'glVertexAttrib4ubvARB', 'glVertexAttrib4usvARB', 'glVertexAttrib4uivARB',
        'glVertexAttrib4fvARB', 'glVertexAttrib4dvARB',
        'glVertexAttrib4NbvARB', 'glVertexAttrib4NsvARB', 'glVertexAttrib4NivARB',
        'glVertexAttrib4NubvARB', 'glVertexAttrib4NusvARB', 'glVertexAttrib4NuivARB',
        'glVertexAttribPointerARB', 'glEnableVertexAttribArrayARB',
        'glDisableVertexAttribArrayARB',
        'glGetVertexAttribdvARB', 'glGetVertexAttribfvARB', 'glGetVertexAttribivARB',
        'glGetVertexAttribPointervARB',
    ],
    GL_EXT_stencil_two_side: ['glActiveStencilFaceEXT'],
    GL_ARB_fragment_program: [
        'glGenProgramsARB', 'glDeleteProgramsARB', 'glIsProgramARB', 'glBindProgramARB',
        'glProgramStringARB',
        'glProgramEnvParameter4dARB', 'glProgramEnvParameter4dvARB',
        'glProgramEnvParameter4fARB', 'glProgramEnvParameter4fvARB',
        'glProgramLocalParameter4dARB', 'glProgramLocalParameter4dvARB',
        'glProgramLocalParameter4fARB', 'glProgramLocalParameter4fvARB',
        'glGetProgramEnvParameterdvARB', 'glGetProgramEnvParameterfvARB',
        'glGetProgramLocalParameterdvARB', 'glGetProgramLocalParameterfvARB',
        'glGetProgramivARB', 'glGetProgramStringARB',
    ],
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

/** How many stack words a value of each GL type letter takes. */
const TYPE_WORDS = /** @type {Record<string, number>} */ ({ b: 1, d: 2, f: 1, i: 1, s: 1,
    ub: 1, ui: 1, us: 1 });

/**
 * A typed family's members and their sizes: `glWindowPos3f` takes three
 * words, `glWindowPos3d` six, every `v` form one pointer, after `leading`
 * words of its own (a unit, an index).
 *
 * @param {string} stem @param {readonly number[]} counts @param {readonly string[]} types
 * @param {number} [leading]
 * @returns {[string, number][]}
 */
const typed = (stem, counts, types, leading = 0)=>counts.flatMap(count=>types.flatMap(type=>[
    /** @type {[string, number]} */ ([`${stem}${count}${type}`,
        leading + count * TYPE_WORDS[type]]),
    /** @type {[string, number]} */ ([`${stem}${count}${type}v`, leading + 1]),
]));

/**
 * The functions each version from 1.2 to 2.1 adds, with how many stack words
 * each takes. Those an extension already brought are the same functions
 * under the version's names.
 *
 * @type {Readonly<Record<string, readonly [string, number][]>>}
 */
const VERSION_FUNCTIONS = Object.freeze({
    GL_VERSION_1_2: [
        ['glBlendColor', 4], ['glBlendEquation', 1], ['glDrawRangeElements', 6],
        ['glTexImage3D', 10], ['glTexSubImage3D', 11], ['glCopyTexSubImage3D', 9],
    ],
    GL_VERSION_1_3: [
        ['glActiveTexture', 1], ['glSampleCoverage', 2], ['glCompressedTexImage3D', 9],
        ['glCompressedTexImage2D', 8], ['glCompressedTexImage1D', 7],
        ['glCompressedTexSubImage3D', 11], ['glCompressedTexSubImage2D', 9],
        ['glCompressedTexSubImage1D', 7], ['glGetCompressedTexImage', 3],
        ['glClientActiveTexture', 1],
        ...typed('glMultiTexCoord', [1, 2, 3, 4], ['d', 'f', 'i', 's'], 1),
        ['glLoadTransposeMatrixf', 1], ['glLoadTransposeMatrixd', 1],
        ['glMultTransposeMatrixf', 1], ['glMultTransposeMatrixd', 1],
    ],
    GL_VERSION_1_4: [
        ['glBlendFuncSeparate', 4], ['glMultiDrawArrays', 4], ['glMultiDrawElements', 5],
        ['glPointParameterf', 2], ['glPointParameterfv', 2], ['glPointParameteri', 2],
        ['glPointParameteriv', 2], ['glFogCoordf', 1], ['glFogCoordfv', 1], ['glFogCoordd', 2],
        ['glFogCoorddv', 1], ['glFogCoordPointer', 3],
        ...typed('glSecondaryColor', [3], ['b', 'd', 'f', 'i', 's', 'ub', 'ui', 'us']),
        ['glSecondaryColorPointer', 4],
        ...typed('glWindowPos', [2, 3], ['d', 'f', 'i', 's']),
    ],
    GL_VERSION_1_5: [
        ['glGenQueries', 2], ['glDeleteQueries', 2], ['glIsQuery', 1], ['glBeginQuery', 2],
        ['glEndQuery', 1], ['glGetQueryiv', 3], ['glGetQueryObjectiv', 3],
        ['glGetQueryObjectuiv', 3], ['glBindBuffer', 2], ['glDeleteBuffers', 2],
        ['glGenBuffers', 2], ['glIsBuffer', 1], ['glBufferData', 4], ['glBufferSubData', 4],
        ['glGetBufferSubData', 4], ['glMapBuffer', 2], ['glUnmapBuffer', 1],
        ['glGetBufferParameteriv', 3], ['glGetBufferPointerv', 3],
    ],
    GL_VERSION_2_0: [
        ['glBlendEquationSeparate', 2], ['glDrawBuffers', 2], ['glStencilOpSeparate', 4],
        ['glStencilFuncSeparate', 4], ['glStencilMaskSeparate', 2], ['glAttachShader', 2],
        ['glBindAttribLocation', 3], ['glCompileShader', 1], ['glCreateProgram', 0],
        ['glCreateShader', 1], ['glDeleteProgram', 1], ['glDeleteShader', 1],
        ['glDetachShader', 2], ['glDisableVertexAttribArray', 1],
        ['glEnableVertexAttribArray', 1], ['glGetActiveAttrib', 7], ['glGetActiveUniform', 7],
        ['glGetAttachedShaders', 4], ['glGetAttribLocation', 2], ['glGetProgramiv', 3],
        ['glGetProgramInfoLog', 4], ['glGetShaderiv', 3], ['glGetShaderInfoLog', 4],
        ['glGetShaderSource', 4], ['glGetUniformLocation', 2], ['glGetUniformfv', 3],
        ['glGetUniformiv', 3], ['glGetVertexAttribdv', 3], ['glGetVertexAttribfv', 3],
        ['glGetVertexAttribiv', 3], ['glGetVertexAttribPointerv', 3], ['glIsProgram', 1],
        ['glIsShader', 1], ['glLinkProgram', 1], ['glShaderSource', 4], ['glUseProgram', 1],
        ...[1, 2, 3, 4].flatMap(n=>/** @type {[string, number][]} */ ([
            [`glUniform${n}f`, 1 + n], [`glUniform${n}i`, 1 + n], [`glUniform${n}fv`, 3],
            [`glUniform${n}iv`, 3]])),
        ['glUniformMatrix2fv', 4], ['glUniformMatrix3fv', 4], ['glUniformMatrix4fv', 4],
        ['glValidateProgram', 1],
        ...typed('glVertexAttrib', [1, 2, 3], ['d', 'f', 's'], 1),
        ['glVertexAttrib4d', 9], ['glVertexAttrib4dv', 2], ['glVertexAttrib4f', 5],
        ['glVertexAttrib4fv', 2], ['glVertexAttrib4s', 5], ['glVertexAttrib4sv', 2],
        ['glVertexAttrib4bv', 2], ['glVertexAttrib4iv', 2], ['glVertexAttrib4ubv', 2],
        ['glVertexAttrib4uiv', 2], ['glVertexAttrib4usv', 2], ['glVertexAttrib4Nbv', 2],
        ['glVertexAttrib4Niv', 2], ['glVertexAttrib4Nsv', 2], ['glVertexAttrib4Nub', 5],
        ['glVertexAttrib4Nubv', 2], ['glVertexAttrib4Nuiv', 2], ['glVertexAttrib4Nusv', 2],
        ['glVertexAttribPointer', 6],
    ],
    GL_VERSION_2_1: [
        ['glUniformMatrix2x3fv', 4], ['glUniformMatrix3x2fv', 4], ['glUniformMatrix2x4fv', 4],
        ['glUniformMatrix4x2fv', 4], ['glUniformMatrix3x4fv', 4], ['glUniformMatrix4x3fv', 4],
    ],
});

/** The functions each version past 1.1 adds: obtainable, never in the extension string. */
export const GL_VERSIONS = Object.freeze(Object.fromEntries(Object.entries(VERSION_FUNCTIONS)
    .map(([version, functions])=>[version, functions.map(([name])=>name)])));

/**
 * The sizes of the functions extensions that came with the versions bring:
 * the framebuffer objects', under both spellings, and blending's.
 *
 * @type {readonly [string, number][]}
 */
const LATER_EXTENSION_WORDS = [
    ...['', 'EXT'].flatMap(suffix=>/** @type {[string, number][]} */ ([
        [`glIsRenderbuffer${suffix}`, 1], [`glBindRenderbuffer${suffix}`, 2],
        [`glDeleteRenderbuffers${suffix}`, 2], [`glGenRenderbuffers${suffix}`, 2],
        [`glRenderbufferStorage${suffix}`, 4], [`glGetRenderbufferParameteriv${suffix}`, 3],
        [`glIsFramebuffer${suffix}`, 1], [`glBindFramebuffer${suffix}`, 2],
        [`glDeleteFramebuffers${suffix}`, 2], [`glGenFramebuffers${suffix}`, 2],
        [`glCheckFramebufferStatus${suffix}`, 1], [`glFramebufferTexture1D${suffix}`, 5],
        [`glFramebufferTexture2D${suffix}`, 5], [`glFramebufferTexture3D${suffix}`, 6],
        [`glFramebufferRenderbuffer${suffix}`, 4],
        [`glGetFramebufferAttachmentParameteriv${suffix}`, 4],
        [`glGenerateMipmap${suffix}`, 1], [`glBlitFramebuffer${suffix}`, 10],
        [`glRenderbufferStorageMultisample${suffix}`, 5],
    ])),
    ['glFramebufferTextureLayer', 5],
    ['glBlendColorEXT', 4], ['glBlendEquationEXT', 1], ['glBlendFuncSeparateEXT', 4],
];

/**
 * Every extension function, grouped by how many stack words it takes -- the
 * same form as the core table, for the same reason.
 *
 * @type {Readonly<Record<number, readonly string[]>>}
 */
const BASE_EXTENSION_WORDS = Object.freeze({
    0: ['glUnlockArraysEXT', 'wglGetExtensionsStringEXT', 'wglGetSwapIntervalEXT'],
    1: [
        'glActiveStencilFaceEXT',
        'glActiveTextureARB', 'glClientActiveTextureARB', 'glIsBufferARB', 'glUnmapBufferARB',
        'glSecondaryColor3bvEXT', 'glSecondaryColor3dvEXT', 'glSecondaryColor3fvEXT',
        'glSecondaryColor3ivEXT', 'glSecondaryColor3svEXT', 'glSecondaryColor3ubvEXT',
        'glSecondaryColor3uivEXT', 'glSecondaryColor3usvEXT', 'glFogCoordfEXT',
        'glFogCoordfvEXT', 'glFogCoorddvEXT', 'wglGetExtensionsStringARB', 'wglSwapIntervalEXT',
        'glIsProgramARB', 'glEnableVertexAttribArrayARB', 'glDisableVertexAttribArrayARB',
    ],
    2: [
        'glMultiTexCoord1fARB', 'glMultiTexCoord1iARB', 'glMultiTexCoord1sARB',
        'glMultiTexCoord1dvARB', 'glMultiTexCoord1fvARB', 'glMultiTexCoord1ivARB',
        'glMultiTexCoord1svARB', 'glMultiTexCoord2dvARB', 'glMultiTexCoord2fvARB',
        'glMultiTexCoord2ivARB', 'glMultiTexCoord2svARB', 'glMultiTexCoord3dvARB',
        'glMultiTexCoord3fvARB', 'glMultiTexCoord3ivARB', 'glMultiTexCoord3svARB',
        'glMultiTexCoord4dvARB', 'glMultiTexCoord4fvARB', 'glMultiTexCoord4ivARB',
        'glMultiTexCoord4svARB', 'glBindBufferARB', 'glDeleteBuffersARB', 'glGenBuffersARB',
        'glMapBufferARB', 'glLockArraysEXT', 'glFogCoorddEXT',
        'glGenProgramsARB', 'glDeleteProgramsARB', 'glBindProgramARB',
        'glVertexAttrib1sARB', 'glVertexAttrib1fARB',
        'glVertexAttrib1svARB', 'glVertexAttrib1fvARB', 'glVertexAttrib1dvARB',
        'glVertexAttrib2svARB', 'glVertexAttrib2fvARB', 'glVertexAttrib2dvARB',
        'glVertexAttrib3svARB', 'glVertexAttrib3fvARB', 'glVertexAttrib3dvARB',
        'glVertexAttrib4bvARB', 'glVertexAttrib4svARB', 'glVertexAttrib4ivARB',
        'glVertexAttrib4ubvARB', 'glVertexAttrib4usvARB', 'glVertexAttrib4uivARB',
        'glVertexAttrib4fvARB', 'glVertexAttrib4dvARB',
        'glVertexAttrib4NbvARB', 'glVertexAttrib4NsvARB', 'glVertexAttrib4NivARB',
        'glVertexAttrib4NubvARB', 'glVertexAttrib4NusvARB', 'glVertexAttrib4NuivARB',
    ],
    3: [
        'glMultiTexCoord1dARB', 'glMultiTexCoord2fARB', 'glMultiTexCoord2iARB',
        'glMultiTexCoord2sARB', 'glGetCompressedTexImageARB', 'glGetBufferParameterivARB',
        'glGetBufferPointervARB', 'glSecondaryColor3bEXT', 'glSecondaryColor3fEXT',
        'glSecondaryColor3iEXT', 'glSecondaryColor3sEXT', 'glSecondaryColor3ubEXT',
        'glSecondaryColor3uiEXT', 'glSecondaryColor3usEXT', 'glFogCoordPointerEXT',
        'glProgramEnvParameter4dvARB', 'glProgramEnvParameter4fvARB',
        'glProgramLocalParameter4dvARB', 'glProgramLocalParameter4fvARB',
        'glGetProgramEnvParameterdvARB', 'glGetProgramEnvParameterfvARB',
        'glGetProgramLocalParameterdvARB', 'glGetProgramLocalParameterfvARB',
        'glGetProgramivARB', 'glGetProgramStringARB',
        'glVertexAttrib1dARB', 'glVertexAttrib2sARB', 'glVertexAttrib2fARB',
        'glGetVertexAttribdvARB', 'glGetVertexAttribfvARB', 'glGetVertexAttribivARB',
        'glGetVertexAttribPointervARB',
    ],
    4: [
        'glMultiTexCoord3fARB', 'glMultiTexCoord3iARB', 'glMultiTexCoord3sARB',
        'glBufferDataARB', 'glBufferSubDataARB', 'glGetBufferSubDataARB',
        'glSecondaryColorPointerEXT',
        'glProgramStringARB', 'glVertexAttrib3sARB', 'glVertexAttrib3fARB',
    ],
    5: [
        'glMultiTexCoord2dARB', 'glMultiTexCoord4fARB', 'glMultiTexCoord4iARB',
        'glMultiTexCoord4sARB',
        'glVertexAttrib2dARB', 'glVertexAttrib4sARB', 'glVertexAttrib4fARB',
        'glVertexAttrib4NubARB',
    ],
    6: [
        'glSecondaryColor3dEXT', 'glDrawRangeElementsEXT', 'wglGetPixelFormatAttribivARB',
        'wglGetPixelFormatAttribfvARB', 'wglChoosePixelFormatARB',
        'glProgramEnvParameter4fARB', 'glProgramLocalParameter4fARB', 'glVertexAttribPointerARB',
    ],
    7: [
        'glMultiTexCoord3dARB', 'glCompressedTexImage1DARB', 'glCompressedTexSubImage1DARB',
        'glVertexAttrib3dARB',
    ],
    8: ['glCompressedTexImage2DARB'],
    9: [
        'glMultiTexCoord4dARB', 'glCompressedTexImage3DARB', 'glCompressedTexSubImage2DARB',
        'glVertexAttrib4dARB',
    ],
    10: ['glProgramEnvParameter4dARB', 'glProgramLocalParameter4dARB'],
    11: ['glCompressedTexSubImage3DARB'],
});

/**
 * Every function past the 1.1 exports -- the extensions' and the versions'
 * -- grouped by how many stack words it takes, the same form as the core
 * table.
 *
 * @type {Readonly<Record<number, readonly string[]>>}
 */
export const EXTENSION_WORDS = (()=>{
    /** @type {Record<number, string[]>} */
    const words = {};
    for (const [count, names] of Object.entries(BASE_EXTENSION_WORDS))
    {
        words[Number(count)] = [...names];
    }
    for (const [name, count] of [...Object.values(VERSION_FUNCTIONS).flat(),
        ...LATER_EXTENSION_WORDS])
    {
        (words[count] ??= []).push(name);
    }
    return Object.freeze(words);
})();

/** Every extension function name, for telling one from a core entry point. */
/**
 * GL extensions that are implemented, sized and obtainable but left out of
 * the string a program reads: a program that finds them takes a path this
 * renderer has not yet drawn right, and one that does not find them takes
 * its slower path, which is drawn right. Every name here is also in
 * `GL_EXTENSIONS`; the pointer stays obtainable, as a driver's would, and a
 * program that reads the string first never asks. Advertising one again is
 * removing its name from here.
 */
/** @type {ReadonlySet<string>} */
export const HIDDEN_GL_EXTENSIONS = Object.freeze(new Set([]));

export const EXTENSION_FUNCTIONS = Object.freeze(new Set([
    ...Object.values(GL_EXTENSIONS).flat(),
    ...Object.values(WGL_EXTENSIONS).flat(),
    ...Object.values(GL_VERSIONS).flat(),
]));
