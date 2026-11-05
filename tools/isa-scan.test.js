/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, walk } from './isa-scan.mjs';

/**
 * Encodings as LLVM's assembler (llvm-mc 18) gives them, with the extension
 * the Intel SDM puts each instruction in ('' for the base set).
 *
 * @type {[32 | 64, string, string][]}
 */
const CASES = [
    [64, 'c5f458c2', 'AVX'], // vaddps ymm0, ymm1, ymm2
    [64, 'c5f8108cc845230100', 'AVX'], // vmovups xmm1, xmmword ptr [rax + 8*rcx + 0x12345]
    [64, 'c5f5fec2', 'AVX2'], // vpaddd ymm0, ymm1, ymm2
    [64, 'c5f1fec2', 'AVX'], // vpaddd xmm0, xmm1, xmm2
    [64, 'c5fd704424401b', 'AVX2'], // vpshufd ymm0, ymmword ptr [rsp + 0x40], 0x1b
    [64, 'c4e25d001d00010000', 'AVX2'], // vpshufb ymm3, ymm4, ymmword ptr [rip + 0x100]
    [64, 'c4e26d900488', 'AVX2'], // vpgatherdd ymm0, ymmword ptr [rax + 4*ymm1], ymm2
    [64, 'c4e3fd00c14e', 'AVX2'], // vpermq ymm0, ymm1, 0x4e
    [64, 'c4e37538c201', 'AVX2'], // vinserti128 ymm0, ymm1, xmm2, 1
    [64, 'c4e375180201', 'AVX'], // vinsertf128 ymm0, ymm1, xmmword ptr [rdx], 1
    [64, 'c4e275b8c2', 'FMA'], // vfmadd231ps ymm0, ymm1, ymm2
    [64, 'c4e2f1a903', 'FMA'], // vfmadd213sd xmm0, xmm1, qword ptr [rbx]
    [64, 'c4e27d13c1', 'F16C'], // vcvtph2ps ymm0, xmm1
    [64, 'c4e37d1dc104', 'F16C'], // vcvtps2ph xmm1, ymm0, 4
    [64, 'c4e260f2c1', 'BMI1'], // andn eax, ebx, ecx
    [64, 'c4e2f8f3cb', 'BMI1'], // blsr rax, rbx
    [64, 'c4e268f701', 'BMI1'], // bextr eax, dword ptr [rcx], edx
    [64, 'c4e2e2f5c1', 'BMI2'], // pext rax, rbx, rcx
    [64, 'c4e271f7c3', 'BMI2'], // shlx eax, ebx, ecx
    [64, 'c4e37bf0c307', 'BMI2'], // rorx eax, ebx, 7
    [64, 'c4e2e3f6c1', 'BMI2'], // mulx rax, rbx, rcx
    [64, '62f1744858c2', 'AVX-512'], // vaddps zmm0, zmm1, zmm2
    [64, '62f17448584001', 'AVX-512'], // vaddps zmm0, zmm1, zmmword ptr [rax + 0x40]
    [64, '62f3754825c2ff', 'AVX-512'], // vpternlogd zmm0, zmm1, zmm2, 0xff
    [64, '660f3800c1', 'SSSE3'], // pshufb xmm0, xmm1
    [64, '660f3a0f0004', 'SSSE3'], // palignr xmm0, xmmword ptr [rax], 4
    [64, '660f3840c1', 'SSE4.1'], // pmulld xmm0, xmm1
    [64, '660f3a0bc101', 'SSE4.1'], // roundsd xmm0, xmm1, 1
    [64, '660f3a140803', 'SSE4.1'], // pextrb byte ptr [rax], xmm1, 3
    [64, '660f3a63c10c', 'SSE4.2'], // pcmpistri xmm0, xmm1, 0x0c
    [64, 'f20f38f001', 'SSE4.2'], // crc32 eax, byte ptr [rcx]
    [64, '660f3837c1', 'SSE4.2'], // pcmpgtq xmm0, xmm1
    [64, '0f38f001', 'MOVBE'], // movbe eax, dword ptr [rcx]
    [64, 'f3480fb8c3', 'POPCNT'], // popcnt rax, rbx
    [64, 'f30fbdc3', 'LZCNT'], // lzcnt eax, ebx
    [64, 'f3480fbc03', 'TZCNT'], // tzcnt rax, qword ptr [rbx]
    [64, '660f38dcc1', 'AES'], // aesenc xmm0, xmm1
    [64, '660f3adfc101', 'AES'], // aeskeygenassist xmm0, xmm1, 1
    [64, '660f3a44c111', 'PCLMULQDQ'], // pclmulqdq xmm0, xmm1, 0x11
    [64, '0f38cbca', 'SHA'], // sha256rnds2 xmm1, xmm2, xmm0
    [64, '66480f38f6c3', 'ADX'], // adcx rax, rbx
    [64, 'f30f38f6c3', 'ADX'], // adox eax, ebx
    [64, '0f01d0', 'xgetbv'], // xgetbv
    [64, '0fa2', 'cpuid'], // cpuid
    [64, '0fae20', 'XSAVE'], // xsave [rax]
    [64, '480fae28', 'XSAVE'], // xrstor64 [rax]
    [64, '0fc720', 'XSAVE'], // xsavec [rax]
    [64, '0fc7f0', 'RDRAND'], // rdrand eax
    [64, 'f20f7cc1', 'SSE3'], // haddps xmm0, xmm1
    [64, '0f58c1', ''], // addps xmm0, xmm1
    [64, '488b0500100000', ''], // mov rax, qword ptr [rip + 0x1000]
    [32, 'c5f458c2', 'AVX'], // vaddps ymm0, ymm1, ymm2
    [32, 'c4e271b8448808', 'FMA'], // vfmadd231ps xmm0, xmm1, xmmword ptr [eax + 4*ecx + 8]
    [32, 'c5f5fec2', 'AVX2'], // vpaddd ymm0, ymm1, ymm2
    [32, '6201', ''], // bound eax, dword ptr [ecx]
    [32, '660f3800c1', 'SSSE3'], // pshufb xmm0, xmm1
    [32, 'f20f38f1442408', 'SSE4.2'], // crc32 eax, dword ptr [esp + 8]
    [32, '0fa2', 'cpuid'], // cpuid
    [32, 'f30fbd01', 'LZCNT'], // lzcnt eax, dword ptr [ecx]
    [64, 'c5f877', 'AVX'], // vzeroupper
    [64, 'c5fc77', 'AVX'], // vzeroall
    [32, 'c5f877', 'AVX'], // vzeroupper
    [64, 'c4e27d58c1', 'AVX2'], // vpbroadcastd ymm0, xmm1
    [64, 'c4e27d1800', 'AVX'], // vbroadcastss ymm0, dword ptr [rax]
    [64, 'c5f57407', 'AVX2'], // vpcmpeqb ymm0, ymm1, ymmword ptr [rdi]
    [64, 'c5fdd7c0', 'AVX2'], // vpmovmskb eax, ymm0
    [64, 'c4e27d17c1', 'AVX'], // vptest ymm0, ymm1
    [64, 'c4e37144c200', 'AVX'], // vpclmulqdq xmm0, xmm1, xmm2, 0
    [64, 'c4e271dcc2', 'AVX'], // vaesenc xmm0, xmm1, xmm2
    [64, 'c4e37d39c801', 'AVX2'], // vextracti128 xmm0, ymm1, 1
    [64, 'c4e37502c203', 'AVX2'], // vpblendd ymm0, ymm1, ymm2, 3
    [64, 'c4e37546c220', 'AVX2'], // vperm2i128 ymm0, ymm1, ymm2, 0x20
    [64, 'c5fd73d904', 'AVX2'], // vpsrldq ymm0, ymm1, 4
    [64, 'c5f972f103', 'AVX'], // vpslld xmm0, xmm1, 3
    [64, 'c5f4c2c201', 'AVX'], // vcmpps ymm0, ymm1, ymm2, 1
    [64, 'c4e37d04c11b', 'AVX'], // vpermilps ymm0, ymm1, 0x1b
    [64, 'c4e269920488', 'AVX2'], // vgatherdps xmm0, xmmword ptr [rax + 4*xmm1], xmm2
    [64, 'c4e2718c00', 'AVX2'], // vpmaskmovd xmm0, xmm1, xmmword ptr [rax]
    [64, 'c4e27547c2', 'AVX2'], // vpsllvd ymm0, ymm1, ymm2
    [64, 'c4e27d5a00', 'AVX2'], // vbroadcasti128 ymm0, xmmword ptr [rax]
    [64, 'c4e3750fc204', 'AVX2'], // vpalignr ymm0, ymm1, ymm2, 4
    [64, 'c4e37d08c101', 'AVX'], // vroundps ymm0, ymm1, 1
    [64, 'c4e37122c001', 'AVX'], // vpinsrd xmm0, xmm1, eax, 1
    [64, 'c4e3f916c001', 'AVX'], // vpextrq rax, xmm0, 1
    [64, 'c5f96ec0', 'AVX'], // vmovd xmm0, eax
    [64, 'c5fa2cc0', 'AVX'], // vcvttss2si eax, xmm0
    [64, 'c4e27536c2', 'AVX2'], // vpermd ymm0, ymm1, ymm2
    [64, 'c4e2753bc2', 'AVX2'], // vpminud ymm0, ymm1, ymm2
    [64, 'c4e27d30c1', 'AVX2'], // vpmovzxbw ymm0, xmm1
];

/** @param {string} hex */
const reader = hex=>{
    const bytes = Buffer.from(hex, 'hex');
    return (/** @type {number} */ address)=>bytes[address] ?? 0x90;
};

/** The code as one group, followed from its first byte. @param {string} hex */
const wholeOf = hex=>[{ starts: [0], within: (/** @type {number} */ address)=>address < hex.length / 2 }];

test('each encoding is read to its end and counted as its extension', ()=>{
    for (const [bits, hex, extension] of CASES)
    {
        const found = classify(reader(hex), 0, bits);
        assert.equal(found.length, hex.length / 2, `${hex} (${bits}-bit): length`);
        assert.equal(found.extension ?? '', extension, `${hex} (${bits}-bit): extension`);
    }
});

test('C4 and C5 with a memory operand are LES and LDS in 32-bit code, not VEX', ()=>{
    for (const hex of ['c401', 'c54304'])
    {
        assert.notEqual(classify(reader(hex), 0, 32).extension, 'AVX');
    }
});

test('the data a function keeps after a jump is not read as code', ()=>{
    // vxorps; jmp over 8 bytes that read as vaddps ymm and an EVEX vaddps zmm;
    // vzeroupper; ret.
    const code = ['c5f857c0', 'eb08', 'c5f458c262f17448', 'c5f877', 'c3'].join('');
    const scan = walk(reader(code), wholeOf(code), 64);
    assert.deepEqual([...scan.counts], [['AVX', 2]]);
    assert.equal(scan.instructions, 4);
});

test('a branch target is followed and each extension is told once per group', ()=>{
    // je +4; four rets; vfmadd231ps ymm0, ymm1, ymm2; vaddps ymm0, ymm1, ymm2; ret
    const code = ['7404', 'c3c3c3c3', 'c4e275b8c2', 'c5f458c2', 'c3'].join('');
    /** @type {[string, number][]} */
    const told = [];
    const scan = walk(reader(code), wholeOf(code), 64,
        (extension, group)=>told.push([extension, group]));
    assert.deepEqual(Object.fromEntries(scan.counts), { FMA: 1, AVX: 1 });
    assert.deepEqual(told, [['FMA', 0], ['AVX', 0]]);
});
