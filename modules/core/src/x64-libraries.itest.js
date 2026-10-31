/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program's own libraries in a process of its machine, through `createApp`:
 * a 64-bit program maps the 64-bit libraries it ships and their thread-local
 * storage, loads one at run time, and is refused a 32-bit one; a 32-bit
 * program is refused a 64-bit one. LoadLibrary of an image of the other
 * machine is ERROR_BAD_EXE_FORMAT on Windows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const ERROR_BAD_EXE_FORMAT = 193;
/** Where the libraries ask to go: they carry no relocations. */
const LIBRARY_BASE = 0x10000000;

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * x86-64 code whose RIP-relative operands are given by target: each part is
 * bytes, or an instruction's bytes up to its 32-bit displacement and the
 * address it reaches (`{ rip: [0xff, 0x15], to }`, a call through a slot).
 *
 * @param {number} base  Where the code starts.
 * @param {(number[] | { rip: number[], to: number })[]} parts
 */
function x64(base, parts){
    /** @type {number[]} */
    const bytes = [];
    for (const part of parts)
    {
        if (Array.isArray(part))
        {
            bytes.push(...part);
            continue;
        }
        const end = base + bytes.length + part.rip.length + 4;
        bytes.push(...part.rip, ...u32(part.to - end));
    }
    return bytes;
}

const SUB_RSP_28 = [0x48, 0x83, 0xec, 0x28];
const CALL_SLOT = [0xff, 0x15];
const LEA_RCX = [0x48, 0x8d, 0x0d];
const LEA_RDX = [0x48, 0x8d, 0x15];

/**
 * A library answering `Answer` (42) and `Index`, its thread-local slot's
 * number as the loader wrote it, with a thread-local directory of its own.
 *
 * @param {32 | 64} bits
 */
function library(bits){
    return buildExe({
        bits, dll: true, imageBase: LIBRARY_BASE, imports: {},
        data: { template: [1, 2, 3, 4], index: [0xff, 0xff, 0xff, 0xff] },
        tls: { template: 'template', index: 'index' },
        exports: [{ name: 'Answer', offset: 6 }, { name: 'Index', offset: 12 }],
        code: ({ at, code })=>[
            0xb8, 1, 0, 0, 0, 0xc3, // DllMain: TRUE
            0xb8, 42, 0, 0, 0, 0xc3, // Answer
            // Index: mov eax, [index] (RIP-relative at 64 bits, absolute at 32); ret
            ...bits === 64 ? x64(code(12), [{ rip: [0x8b, 0x05], to: at('index') }])
                : [0xa1, ...u32(at('index'))],
            0xc3,
        ],
    });
}

/**
 * @param {Uint8Array} executable
 * @param {Record<string, Uint8Array>} files  Beside the program, by name.
 */
async function run(executable, files){
    const app = await createApp({
        executable, imagePath: 'C:\\App\\program.exe',
        storage: { load: async()=>({ files: Object.entries(files).map(([name, bytes])=>(
            { path: `C:\\App\\${name}`, bytes })) }) },
    });
    try
    {
        return await app.run({ timeoutMs: 50000 });
    }
    finally
    {
        app.dispose();
    }
}

test('a 64-bit program maps the 64-bit library it ships, thread-local storage and all',
    { timeout: 60000 }, async()=>{
        // The program has thread-local storage too, so it is slot 0 and the
        // library slot 1, in load order with the program's own first.
        const program = buildExe({
            bits: 64, codeSize: 0x80,
            imports: { 'goo64.dll': ['Answer', 'Index'], 'KERNEL32.dll': ['ExitProcess'] },
            data: { template: [5, 6, 7, 8], index: [0xff, 0xff, 0xff, 0xff] },
            tls: { template: 'template', index: 'index' },
            code: ({ iat, code })=>x64(code(0), [
                SUB_RSP_28,
                { rip: CALL_SLOT, to: iat('Answer') },
                [0x89, 0xc3], // mov ebx, eax
                { rip: CALL_SLOT, to: iat('Index') },
                [0x6b, 0xc0, 100], // imul eax, eax, 100
                [0x01, 0xd8], // add eax, ebx
                [0x89, 0xc1], // mov ecx, eax
                { rip: CALL_SLOT, to: iat('ExitProcess') },
            ]),
        });
        assert.equal(await run(program, { 'goo64.dll': library(64) }), 142);
    });

test('a 64-bit program loads a 64-bit library at run time and is refused a 32-bit one',
    { timeout: 60000 }, async()=>{
        const name32 = [...'goo32.dll\0'].map(c=>c.charCodeAt(0));
        const name64 = [...'goo64.dll\0'].map(c=>c.charCodeAt(0));
        const answer = [...'Answer\0'].map(c=>c.charCodeAt(0));
        const program = buildExe({
            bits: 64, codeSize: 0x80,
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetLastError', 'GetProcAddress',
                'ExitProcess'] },
            data: { name32, name64, answer },
            code: ({ iat, at, code })=>x64(code(0), [
                SUB_RSP_28,
                { rip: LEA_RCX, to: at('name32') },
                { rip: CALL_SLOT, to: iat('LoadLibraryA') },
                { rip: CALL_SLOT, to: iat('GetLastError') },
                [0x69, 0xd8, ...u32(1000)], // imul ebx, eax, 1000
                { rip: LEA_RCX, to: at('name64') },
                { rip: CALL_SLOT, to: iat('LoadLibraryA') },
                [0x48, 0x89, 0xc1], // mov rcx, rax
                { rip: LEA_RDX, to: at('answer') },
                { rip: CALL_SLOT, to: iat('GetProcAddress') },
                [0xff, 0xd0], // call rax
                [0x01, 0xd8], // add eax, ebx
                [0x89, 0xc1], // mov ecx, eax
                { rip: CALL_SLOT, to: iat('ExitProcess') },
            ]),
        });
        assert.equal(await run(program, { 'goo32.dll': library(32), 'goo64.dll': library(64) }),
            ERROR_BAD_EXE_FORMAT * 1000 + 42);
    });

test('a 32-bit program is refused a 64-bit library, ERROR_BAD_EXE_FORMAT',
    { timeout: 60000 }, async()=>{
        const program = buildExe({
            imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetLastError', 'ExitProcess'] },
            data: { name: [...'goo64.dll\0'].map(c=>c.charCodeAt(0)) },
            code: ({ iat, at })=>[
                0x68, ...u32(at('name')), // push name
                0xff, 0x15, ...u32(iat('LoadLibraryA')),
                0x85, 0xc0, // test eax, eax
                0x75, 0x09, // jnz past the error: a library, exit with its handle
                0xff, 0x15, ...u32(iat('GetLastError')),
                0x50, // push eax
                0xeb, 0x01, // jmp to the exit
                0x50, // push eax (the handle)
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        assert.equal(await run(program, { 'goo64.dll': library(64) }), ERROR_BAD_EXE_FORMAT);
    });

/**
 * A GUID's bytes as memory holds them.
 *
 * @param {string} text  `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`
 */
const guid = text=>{
    const hex = text.replace(/[{}-]/g, '');
    const bytes = hex.match(/../g)?.map(pair=>parseInt(pair, 16)) ?? [];
    return [...bytes.slice(0, 4).reverse(), ...bytes.slice(4, 6).reverse(),
        ...bytes.slice(6, 8).reverse(), ...bytes.slice(8)];
};

test('a 64-bit program creates an in-process server\'s object and calls it through its vtable',
    { timeout: 60000 }, async()=>{
        // CoCreateInstance of a class an in-process server's DllGetClassObject
        // serves -- DirectInput's, as SDL asks for it -- calls the class
        // object's methods through eight-byte slots, and writes the object
        // into the program's eight-byte out pointer whole.
        const program = buildExe({
            bits: 64, codeSize: 0x100,
            imports: { 'ole32.dll': ['CoInitializeEx', 'CoCreateInstance'],
                'KERNEL32.dll': ['ExitProcess'] },
            data: {
                clsid: guid('{25E609E4-B259-11CF-BFC7-444553540000}'),
                iid: guid('{BF798031-483A-4DA2-AA99-5D64ED369700}'),
                out: new Array(8).fill(0xff),
            },
            code: ({ iat, at, code })=>x64(code(0), [
                [0x48, 0x83, 0xec, 0x38], // sub rsp, 0x38: the fifth argument's slot
                [0x31, 0xc9, 0xba, 2, 0, 0, 0], // xor ecx, ecx; mov edx, COINIT_APARTMENTTHREADED
                { rip: CALL_SLOT, to: iat('CoInitializeEx') },
                { rip: LEA_RCX, to: at('clsid') },
                [0x31, 0xd2, 0x41, 0xb8, 1, 0, 0, 0], // xor edx, edx; mov r8d, CLSCTX_INPROC_SERVER
                { rip: [0x4c, 0x8d, 0x0d], to: at('iid') }, // lea r9, iid
                { rip: [0x48, 0x8d, 0x05], to: at('out') }, // lea rax, out
                [0x48, 0x89, 0x44, 0x24, 0x20], // mov [rsp+0x20], rax
                { rip: CALL_SLOT, to: iat('CoCreateInstance') },
                [0x89, 0xc3], // mov ebx, eax
                { rip: [0x48, 0x8b, 0x0d], to: at('out') }, // mov rcx, out
                [0x48, 0x8b, 0x01, 0xff, 0x50, 0x10], // mov rax, [rcx]; call [rax+16]: Release
                [0x89, 0xd9], // mov ecx, ebx
                { rip: CALL_SLOT, to: iat('ExitProcess') },
            ]),
        });
        assert.equal(await run(program, {}), 0, 'S_OK, and the object released');
    });

test('RtlPcToFileHeader answers the base of the image an address is in', { timeout: 60000 },
    async()=>{
        // A 64-bit C++ runtime asks it as it throws, to read its throw
        // information's image-relative fields.
        const program = buildExe({
            bits: 64, codeSize: 0x80,
            imports: { 'KERNEL32.dll': ['RtlPcToFileHeader', 'ExitProcess'] },
            data: { base: new Array(8).fill(0xff) },
            code: ({ iat, at, code })=>x64(code(0), [
                SUB_RSP_28,
                { rip: LEA_RCX, to: code(0) },
                { rip: LEA_RDX, to: at('base') },
                { rip: CALL_SLOT, to: iat('RtlPcToFileHeader') },
                { rip: [0x48, 0x8b, 0x0d], to: at('base') }, // mov rcx, base
                [0x48, 0x29, 0xc1], // sub rcx, rax: what it wrote less what it answered
                [0x48, 0xc1, 0xe8, 0x10], // shr rax, 16
                [0x48, 0x01, 0xc1], // add rcx, rax
                { rip: CALL_SLOT, to: iat('ExitProcess') },
            ]),
        });
        assert.equal(await run(program, {}), 0x400000 >>> 16, 'the program\'s own base, both ways');
    });
