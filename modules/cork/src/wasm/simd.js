/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The SIMD instructions the translator emits, by their number in the
 * `0xfd` opcode space. Named so a lowering reads as the operation it is;
 * every number here is checked by `simd.test.js`, which validates and runs
 * a module using each one.
 */
export const SIMD = Object.freeze({
    load: 0, load64Zero: 93, load32Zero: 92, load32Lane: 86, load64Lane: 87,
    store: 11, store32Lane: 90, store64Lane: 91,
    const: 12, shuffle: 13, swizzle: 14,
    i8x16Splat: 15, i16x8Splat: 16, i32x4Splat: 17, i64x2Splat: 18, f32x4Splat: 19, f64x2Splat: 20,
    i8x16ExtractLaneU: 22, i16x8ExtractLaneU: 25, i16x8ReplaceLane: 26,
    i32x4ExtractLane: 27, i32x4ReplaceLane: 28, i64x2ExtractLane: 29, i64x2ReplaceLane: 30,
    f32x4ExtractLane: 31, f32x4ReplaceLane: 32, f64x2ExtractLane: 33, f64x2ReplaceLane: 34,
    i8x16Eq: 35, i8x16GtS: 39, i16x8Eq: 45, i16x8GtS: 49, i32x4Eq: 55, i32x4GtS: 59,
    f32x4Eq: 65, f32x4Ne: 66, f32x4Lt: 67, f32x4Gt: 68, f32x4Le: 69, f32x4Ge: 70,
    f64x2Eq: 71, f64x2Ne: 72, f64x2Lt: 73, f64x2Gt: 74, f64x2Le: 75, f64x2Ge: 76,
    not: 77, and: 78, andnot: 79, or: 80, xor: 81, bitselect: 82,
    i8x16Bitmask: 100, i8x16ShrS: 108, i8x16NarrowI16x8S: 101, i8x16NarrowI16x8U: 102,
    i8x16Add: 110, i8x16AddSatS: 111, i8x16AddSatU: 112, i8x16Sub: 113, i8x16SubSatS: 114,
    i8x16SubSatU: 115, i8x16MinU: 119, i8x16MaxU: 121, i8x16AvgrU: 123,
    i16x8ExtaddPairwiseI8x16U: 125, i32x4ExtaddPairwiseI16x8U: 127,
    i16x8NarrowI32x4S: 133, i16x8NarrowI32x4U: 134,
    i16x8Shl: 139, i16x8ShrS: 140, i16x8ShrU: 141, i16x8Add: 142, i16x8AddSatS: 143,
    i16x8AddSatU: 144, i16x8Sub: 145, i16x8SubSatS: 146, i16x8SubSatU: 147, i16x8Mul: 149,
    i16x8MinS: 150, i16x8MaxS: 152, i16x8AvgrU: 155,
    i32x4Bitmask: 164, i32x4Shl: 171, i32x4ShrS: 172, i32x4ShrU: 173, i32x4Add: 174,
    i32x4Sub: 177, i32x4Mul: 181, i32x4DotI16x8S: 186,
    i32x4ExtmulLowI16x8S: 188, i32x4ExtmulHighI16x8S: 189,
    i32x4ExtmulLowI16x8U: 190, i32x4ExtmulHighI16x8U: 191,
    i64x2Shl: 203, i64x2ShrU: 205, i64x2Add: 206, i64x2Sub: 209, i64x2ExtmulLowI32x4U: 222,
    f32x4Abs: 224, f32x4Neg: 225, f32x4Sqrt: 227, f32x4Add: 228, f32x4Sub: 229, f32x4Mul: 230,
    f32x4Div: 231, f32x4Nearest: 106, f32x4Trunc: 105, f32x4Ceil: 103, f32x4Floor: 104,
    f64x2Ceil: 116, f64x2Floor: 117, f64x2Trunc: 122,
    f64x2Sqrt: 239, f64x2Add: 240, f64x2Sub: 241, f64x2Mul: 242, f64x2Div: 243, f64x2Nearest: 148,
    i32x4TruncSatF32x4S: 248, f32x4ConvertI32x4S: 250,
    i32x4TruncSatF64x2SZero: 252, f64x2ConvertLowI32x4S: 254,
    f32x4DemoteF64x2Zero: 94, f64x2PromoteLowF32x4: 95,
});
