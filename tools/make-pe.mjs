/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

/**
 * Generates a minimal 32-bit console PE executable used as a loader fixture.
 *
 * Written by hand rather than produced by a compiler for two reasons: no
 * toolchain is required to reproduce it, and the file stays small enough that
 * every byte in it is accounted for by this script. It is a real PE — real
 * Windows runs it — so it can serve as a contract test rather than a mock: the
 * same binary must behave the same way under Windows and under Bottlify.
 *
 * Usage: node tools/make-pe.mjs <output.exe> [message]
 */

import { writeFile } from "node:fs/promises";

const IMAGE_BASE = 0x400000;
const SECTION_RVA = 0x1000;
const FILE_ALIGNMENT = 0x200;
const SECTION_ALIGNMENT = 0x1000;
const HEADERS_SIZE = 0x200;

/** Imports the fixture needs: just enough to write a line and exit. */
const IMPORTS = ["GetStdHandle", "WriteFile", "ExitProcess"];

class Buf {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
  }
  get length() {
    return this.bytes.length;
  }
  /** @param {number[]} values */
  push(...values) {
    this.bytes.push(...values);
    return this;
  }
  /** @param {number} value */
  u8(value) {
    return this.push(value & 0xff);
  }
  /** @param {number} value */
  u16(value) {
    return this.push(value & 0xff, (value >>> 8) & 0xff);
  }
  /** @param {number} value */
  u32(value) {
    return this.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
  }
  /** @param {string} text */
  ascii(text) {
    return this.push(...[...text].map((c) => c.charCodeAt(0)));
  }
  /** @param {number} size */
  pad(size) {
    while (this.bytes.length < size) this.bytes.push(0);
    return this;
  }
}

/**
 * Builds the executable image.
 *
 * @param {string} message text the program writes to stdout
 * @returns {Uint8Array}
 */
export function buildHelloExe(message = "Hello from Bottlify\r\n") {
  const text = new Buf();

  // Section layout is computed in two passes: reserve space for the code, lay
  // out the data that follows it, then emit the code now that the data's
  // addresses are known.
  const CODE_SIZE = 0x40;
  const rva = (/** @type {number} */ offset) => SECTION_RVA + offset;
  const va = (/** @type {number} */ offset) => IMAGE_BASE + rva(offset);

  let cursor = CODE_SIZE;
  const msgOffset = cursor;
  cursor += message.length;
  const writtenOffset = (cursor + 3) & ~3; // DWORD for WriteFile's out-parameter
  cursor = writtenOffset + 4;

  // Import name blocks: WORD hint + zero-terminated name, WORD-aligned.
  /** @type {Record<string, number>} */
  const nameOffsets = {};
  for (const name of IMPORTS) {
    cursor = (cursor + 1) & ~1;
    nameOffsets[name] = cursor;
    cursor += 2 + name.length + 1;
  }
  cursor = (cursor + 1) & ~1;
  const dllNameOffset = cursor;
  cursor += "KERNEL32.dll".length + 1;

  // Import lookup table and import address table: parallel arrays of RVAs.
  cursor = (cursor + 3) & ~3;
  const iltOffset = cursor;
  cursor += (IMPORTS.length + 1) * 4;
  const iatOffset = cursor;
  cursor += (IMPORTS.length + 1) * 4;
  const descriptorOffset = cursor;
  cursor += 2 * 20; // one descriptor plus the null terminator
  const sectionSize = cursor;

  const iatEntryVa = (/** @type {string} */ name) => va(iatOffset + IMPORTS.indexOf(name) * 4);

  // --- code ---
  text.push(0x6a, 0xf5); // push -11 (STD_OUTPUT_HANDLE)
  text.push(0xff, 0x15).u32(iatEntryVa("GetStdHandle")); // call [GetStdHandle]
  text.push(0x6a, 0x00); // push 0                      (lpOverlapped)
  text.push(0x68).u32(va(writtenOffset)); // push &written (lpNumberOfBytesWritten)
  text.push(0x6a, message.length & 0xff); // push len    (nNumberOfBytesToWrite)
  text.push(0x68).u32(va(msgOffset)); // push message    (lpBuffer)
  text.push(0x50); // push eax                           (hFile, from GetStdHandle)
  text.push(0xff, 0x15).u32(iatEntryVa("WriteFile")); // call [WriteFile]
  text.push(0x6a, 0x00); // push 0                       (uExitCode)
  text.push(0xff, 0x15).u32(iatEntryVa("ExitProcess")); // call [ExitProcess]
  if (text.length > CODE_SIZE) throw new Error(`code overflowed its ${CODE_SIZE}-byte budget`);
  text.pad(CODE_SIZE);

  // --- data ---
  text.ascii(message).pad(writtenOffset).u32(0);
  for (const name of IMPORTS) {
    text.pad(nameOffsets[name]).u16(0).ascii(name).u8(0);
  }
  text.pad(dllNameOffset).ascii("KERNEL32.dll").u8(0);

  text.pad(iltOffset);
  for (const name of IMPORTS) text.u32(rva(nameOffsets[name]));
  text.u32(0);
  for (const name of IMPORTS) text.u32(rva(nameOffsets[name]));
  text.u32(0);

  text.pad(descriptorOffset);
  text.u32(rva(iltOffset)).u32(0).u32(0).u32(rva(dllNameOffset)).u32(rva(iatOffset));
  text.pad(sectionSize);

  const rawSize = Math.ceil(sectionSize / FILE_ALIGNMENT) * FILE_ALIGNMENT;
  const sizeOfImage = SECTION_RVA + Math.ceil(sectionSize / SECTION_ALIGNMENT) * SECTION_ALIGNMENT;

  // --- headers ---
  const head = new Buf();
  head.ascii("MZ").pad(0x3c).u32(0x40); // DOS header; e_lfanew -> PE header at 0x40
  head.pad(0x40).ascii("PE").u8(0).u8(0);

  // COFF header
  head.u16(0x014c); // i386
  head.u16(1); // one section
  head.u32(0); // timestamp
  head.u32(0).u32(0); // no symbol table
  head.u16(0xe0); // size of optional header
  head.u16(0x0102); // EXECUTABLE_IMAGE | 32BIT_MACHINE

  // Optional header (PE32)
  head.u16(0x010b);
  head.u8(0).u8(0); // linker version
  head.u32(rawSize).u32(0).u32(0); // sizes of code / initialized / uninitialized data
  head.u32(SECTION_RVA); // AddressOfEntryPoint
  head.u32(SECTION_RVA).u32(0); // BaseOfCode / BaseOfData
  head.u32(IMAGE_BASE);
  head.u32(SECTION_ALIGNMENT).u32(FILE_ALIGNMENT);
  head.u16(4).u16(0); // OS version
  head.u16(0).u16(0); // image version
  head.u16(4).u16(0); // subsystem version
  head.u32(0); // win32 version
  head.u32(sizeOfImage).u32(HEADERS_SIZE);
  head.u32(0); // checksum
  head.u16(3); // subsystem: console
  head.u16(0); // dll characteristics
  head.u32(0x100000).u32(0x1000); // stack reserve / commit
  head.u32(0x100000).u32(0x1000); // heap reserve / commit
  head.u32(0).u32(16); // loader flags, number of data directories

  const directories = new Array(16).fill(null).map(() => [0, 0]);
  directories[1] = [rva(descriptorOffset), 40]; // import table
  directories[12] = [rva(iatOffset), (IMPORTS.length + 1) * 4]; // IAT
  for (const [address, size] of directories) head.u32(address).u32(size);

  // Section header: one section holding code, data and the import tables.
  head.ascii(".text").pad(head.length + 3); // name padded to 8 bytes
  head.u32(sectionSize).u32(SECTION_RVA).u32(rawSize).u32(HEADERS_SIZE);
  head.u32(0).u32(0).u16(0).u16(0);
  head.u32(0xe0000020); // CODE | EXECUTE | READ | WRITE
  head.pad(HEADERS_SIZE);

  return new Uint8Array([...head.bytes, ...text.bytes, ...new Array(rawSize - sectionSize).fill(0)]);
}

const [, , output, message] = process.argv;
if (output) {
  const image = buildHelloExe(message ? `${message}\r\n` : undefined);
  await writeFile(output, image);
  console.log(`${output}: ${image.length} bytes`);
}
