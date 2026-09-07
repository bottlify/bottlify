/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The OpenGL and WGL numbers, as the headers define them.
 *
 * One namespace object per header rather than one flat file of constants: a
 * program passes these as arguments and reads them back, so a wrong value is a
 * plausible-looking answer rather than an error, and grouping them the way the
 * headers do is what makes a transcription mistake visible.
 *
 * Only what this layer actually decides something with is here. An enumerant
 * nothing branches on is not contract, it is noise.
 */

/** GL enumerants, in the order gl.h groups them. */
export const GL = Object.freeze({
    FALSE: 0,
    TRUE: 1,

    // --- errors ---
    NO_ERROR: 0,
    INVALID_ENUM: 0x0500,
    INVALID_VALUE: 0x0501,
    INVALID_OPERATION: 0x0502,
    STACK_OVERFLOW: 0x0503,
    STACK_UNDERFLOW: 0x0504,
    OUT_OF_MEMORY: 0x0505,

    // --- primitives ---
    POINTS: 0x0000,
    LINES: 0x0001,
    LINE_LOOP: 0x0002,
    LINE_STRIP: 0x0003,
    TRIANGLES: 0x0004,
    TRIANGLE_STRIP: 0x0005,
    TRIANGLE_FAN: 0x0006,
    QUADS: 0x0007,
    QUAD_STRIP: 0x0008,
    POLYGON: 0x0009,

    // --- capabilities, whose enumerant is also their query ---
    POINT_SMOOTH: 0x0b10,
    LINE_SMOOTH: 0x0b20,
    POLYGON_SMOOTH: 0x0b41,
    CULL_FACE: 0x0b44,
    LIGHTING: 0x0b50,
    COLOR_MATERIAL: 0x0b57,
    FOG: 0x0b60,
    DEPTH_TEST: 0x0b71,
    STENCIL_TEST: 0x0b90,
    NORMALIZE: 0x0ba1,
    ALPHA_TEST: 0x0bc0,
    DITHER: 0x0bd0,
    BLEND: 0x0be2,
    SCISSOR_TEST: 0x0c11,
    TEXTURE_1D: 0x0de0,
    TEXTURE_2D: 0x0de1,
    POLYGON_OFFSET_FILL: 0x8037,
    LIGHT0: 0x4000,

    // --- state queries ---
    CURRENT_COLOR: 0x0b00,
    CURRENT_INDEX: 0x0b01,
    CURRENT_NORMAL: 0x0b02,
    CURRENT_TEXTURE_COORDS: 0x0b03,
    POINT_SIZE: 0x0b11,
    LINE_WIDTH: 0x0b21,
    LIST_MODE: 0x0b30,
    LIST_BASE: 0x0b32,
    LIST_INDEX: 0x0b33,
    POLYGON_MODE: 0x0b40,
    CULL_FACE_MODE: 0x0b45,
    FRONT_FACE: 0x0b46,
    LIGHT_MODEL_LOCAL_VIEWER: 0x0b51,
    LIGHT_MODEL_TWO_SIDE: 0x0b52,
    LIGHT_MODEL_AMBIENT: 0x0b53,
    SHADE_MODEL: 0x0b54,
    FOG_INDEX: 0x0b61,
    FOG_DENSITY: 0x0b62,
    FOG_START: 0x0b63,
    FOG_END: 0x0b64,
    FOG_MODE: 0x0b65,
    FOG_COLOR: 0x0b66,
    DEPTH_RANGE: 0x0b70,
    DEPTH_WRITEMASK: 0x0b72,
    DEPTH_CLEAR_VALUE: 0x0b73,
    DEPTH_FUNC: 0x0b74,
    ACCUM_CLEAR_VALUE: 0x0b80,
    STENCIL_CLEAR_VALUE: 0x0b91,
    STENCIL_FUNC: 0x0b92,
    STENCIL_VALUE_MASK: 0x0b93,
    STENCIL_FAIL: 0x0b94,
    STENCIL_PASS_DEPTH_FAIL: 0x0b95,
    STENCIL_PASS_DEPTH_PASS: 0x0b96,
    STENCIL_REF: 0x0b97,
    STENCIL_WRITEMASK: 0x0b98,
    MATRIX_MODE: 0x0ba0,
    VIEWPORT: 0x0ba2,
    MODELVIEW_STACK_DEPTH: 0x0ba3,
    PROJECTION_STACK_DEPTH: 0x0ba4,
    TEXTURE_STACK_DEPTH: 0x0ba5,
    MODELVIEW_MATRIX: 0x0ba6,
    PROJECTION_MATRIX: 0x0ba7,
    TEXTURE_MATRIX: 0x0ba8,
    ALPHA_TEST_FUNC: 0x0bc1,
    ALPHA_TEST_REF: 0x0bc2,
    BLEND_DST: 0x0be0,
    BLEND_SRC: 0x0be1,
    DRAW_BUFFER: 0x0c01,
    READ_BUFFER: 0x0c02,
    SCISSOR_BOX: 0x0c10,
    INDEX_CLEAR_VALUE: 0x0c20,
    COLOR_CLEAR_VALUE: 0x0c22,
    COLOR_WRITEMASK: 0x0c23,
    UNPACK_SWAP_BYTES: 0x0cf0,
    UNPACK_LSB_FIRST: 0x0cf1,
    UNPACK_ROW_LENGTH: 0x0cf2,
    UNPACK_SKIP_ROWS: 0x0cf3,
    UNPACK_SKIP_PIXELS: 0x0cf4,
    UNPACK_ALIGNMENT: 0x0cf5,
    PACK_SWAP_BYTES: 0x0d00,
    PACK_LSB_FIRST: 0x0d01,
    PACK_ROW_LENGTH: 0x0d02,
    PACK_SKIP_ROWS: 0x0d03,
    PACK_SKIP_PIXELS: 0x0d04,
    PACK_ALIGNMENT: 0x0d05,
    MAX_TEXTURE_SIZE: 0x0d33,
    MAX_MODELVIEW_STACK_DEPTH: 0x0d36,
    MAX_PROJECTION_STACK_DEPTH: 0x0d38,
    MAX_TEXTURE_STACK_DEPTH: 0x0d39,
    TEXTURE_BINDING_1D: 0x8068,
    TEXTURE_BINDING_2D: 0x8069,

    // --- values ---
    NEVER: 0x0200,
    LESS: 0x0201,
    EQUAL: 0x0202,
    LEQUAL: 0x0203,
    GREATER: 0x0204,
    NOTEQUAL: 0x0205,
    GEQUAL: 0x0206,
    ALWAYS: 0x0207,
    ZERO: 0,
    ONE: 1,
    SRC_COLOR: 0x0300,
    ONE_MINUS_SRC_COLOR: 0x0301,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_ALPHA: 0x0304,
    ONE_MINUS_DST_ALPHA: 0x0305,
    DST_COLOR: 0x0306,
    ONE_MINUS_DST_COLOR: 0x0307,
    SRC_ALPHA_SATURATE: 0x0308,
    FRONT: 0x0404,
    BACK: 0x0405,
    FRONT_AND_BACK: 0x0408,
    EXP: 0x0800,
    EXP2: 0x0801,
    CW: 0x0900,
    CCW: 0x0901,
    KEEP: 0x1e00,
    POINT: 0x1b00,
    LINE: 0x1b01,
    FILL: 0x1b02,
    FLAT: 0x1d00,
    SMOOTH: 0x1d01,
    MODELVIEW: 0x1700,
    PROJECTION: 0x1701,
    TEXTURE: 0x1702,
    COMPILE: 0x1300,
    COMPILE_AND_EXECUTE: 0x1301,

    // --- strings ---
    VENDOR: 0x1f00,
    RENDERER: 0x1f01,
    VERSION: 0x1f02,
    EXTENSIONS: 0x1f03,

    // --- pixel formats and types ---
    COLOR_INDEX: 0x1900,
    STENCIL_INDEX: 0x1901,
    DEPTH_COMPONENT: 0x1902,
    RED: 0x1903,
    GREEN: 0x1904,
    BLUE: 0x1905,
    ALPHA: 0x1906,
    RGB: 0x1907,
    RGBA: 0x1908,
    LUMINANCE: 0x1909,
    LUMINANCE_ALPHA: 0x190a,
    BGR: 0x80e0,
    BGRA: 0x80e1,
    BYTE: 0x1400,
    UNSIGNED_BYTE: 0x1401,
    SHORT: 0x1402,
    UNSIGNED_SHORT: 0x1403,
    INT: 0x1404,
    UNSIGNED_INT: 0x1405,
    FLOAT: 0x1406,
    BITMAP: 0x1a00,
    UNSIGNED_BYTE_3_3_2: 0x8032,
    UNSIGNED_SHORT_4_4_4_4: 0x8033,
    UNSIGNED_SHORT_5_5_5_1: 0x8034,
    UNSIGNED_INT_8_8_8_8: 0x8035,
    UNSIGNED_INT_10_10_10_2: 0x8036,
    UNSIGNED_SHORT_5_6_5: 0x8363,

    // --- texture objects ---
    NEAREST: 0x2600,
    LINEAR: 0x2601,
    NEAREST_MIPMAP_NEAREST: 0x2700,
    LINEAR_MIPMAP_NEAREST: 0x2701,
    NEAREST_MIPMAP_LINEAR: 0x2702,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    TEXTURE_BORDER_COLOR: 0x1004,
    TEXTURE_PRIORITY: 0x8066,
    TEXTURE_BASE_LEVEL: 0x813c,
    TEXTURE_MAX_LEVEL: 0x813d,
    CLAMP: 0x2900,
    REPEAT: 0x2901,
    CLAMP_TO_EDGE: 0x812f,
});

/**
 * PIXELFORMATDESCRIPTOR flags. The three DONTCARE bits sit in the top nibble
 * and are requests to ChoosePixelFormat rather than properties a format has,
 * which is why they never appear in a described format.
 */
export const PFD = Object.freeze({
    TYPE_RGBA: 0,
    TYPE_COLORINDEX: 1,

    MAIN_PLANE: 0,
    OVERLAY_PLANE: 1,
    UNDERLAY_PLANE: 255,

    DOUBLEBUFFER: 0x00000001,
    STEREO: 0x00000002,
    DRAW_TO_WINDOW: 0x00000004,
    DRAW_TO_BITMAP: 0x00000008,
    SUPPORT_GDI: 0x00000010,
    SUPPORT_OPENGL: 0x00000020,
    GENERIC_FORMAT: 0x00000040,
    NEED_PALETTE: 0x00000080,
    NEED_SYSTEM_PALETTE: 0x00000100,
    SWAP_EXCHANGE: 0x00000200,
    SWAP_COPY: 0x00000400,
    SWAP_LAYER_BUFFERS: 0x00000800,
    GENERIC_ACCELERATED: 0x00001000,
    SUPPORT_DIRECTDRAW: 0x00002000,

    DEPTH_DONTCARE: 0x20000000,
    DOUBLEBUFFER_DONTCARE: 0x40000000,
    STEREO_DONTCARE: 0x80000000,
});

/**
 * The Win32 error codes this seam sets. They are the observable half of a WGL
 * failure: every one of these functions reports only a zero or a FALSE, so the
 * code is how a program tells "you passed rubbish" from "somebody else has it".
 */
export const WIN32_ERROR = Object.freeze({
    SUCCESS: 0,
    INVALID_HANDLE: 6,
    BUSY: 170,
    INVALID_PIXEL_FORMAT: 2000,
});
