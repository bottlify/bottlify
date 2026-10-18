/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A program's own code disassembled, by module and offset: the address a
 * profile names hot (`hw.dll+0x35840`, from the overlay, `watch.mjs` or a
 * report) read as instructions, out of the bottle the game runs from.
 *
 *   node tools/disasm.mjs <bundle.btl | bundle id> <module> <offset[:count]>...
 *
 * The module is found in the bundle by its file name; an offset is relative to
 * its image base (an RVA), hex, and is placed through the section table. The
 * instructions come from capstone (`pip install capstone`), which the machine
 * this was written on has; the tool says so plainly when it is missing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBundle } from './btl.mjs';

const [bundleArg, moduleName, ...offsets] = process.argv.slice(2);
if (!bundleArg || !moduleName || offsets.length === 0)
{
    console.log('usage: disasm.mjs <bundle.btl | bundle id> <module> <offset[:count]>...');
    process.exit(1);
}
const path = bundleArg.endsWith('.btl') ? bundleArg : join('bundles', bundleArg, 'bundle.btl');
const bundle = await openBundle(path);
const wanted = moduleName.toLowerCase();
const file = bundle.list().find((/** @type {any} */ one)=>
    one.path.toLowerCase().split('\\').pop() === wanted);
if (!file)
{
    console.log(`${moduleName} is not in ${path}`);
    process.exit(1);
}
const bytes = Buffer.from(await bundle.read(file.path));
const image = join(mkdtempSync(join(tmpdir(), 'disasm-')), wanted);
writeFileSync(image, bytes);

// The section walk and the decoding in one small Python program: capstone is
// a Python package here, and the PE fields it needs are a few struct reads.
const program = `
import sys, struct
try:
    import capstone
except ImportError:
    print('capstone is not installed: pip install capstone')
    sys.exit(2)
data = open(sys.argv[1], 'rb').read()
pe = struct.unpack_from('<I', data, 0x3c)[0]
sections = struct.unpack_from('<H', data, pe + 6)[0]
optional = struct.unpack_from('<H', data, pe + 20)[0]
table = pe + 24 + optional
def file_of(rva):
    for index in range(sections):
        at = table + index * 40
        vsize, vaddr, rsize, raddr = struct.unpack_from('<IIII', data, at + 8)
        if vaddr <= rva < vaddr + max(vsize, rsize):
            return raddr + rva - vaddr
    return None
md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_32)
for spec in sys.argv[2:]:
    parts = spec.split(':')
    rva = int(parts[0], 16)
    count = int(parts[1]) if len(parts) > 1 else 60
    at = file_of(rva)
    if at is None:
        print(f'== +0x{rva:x}: in no section')
        continue
    print(f'== {sys.argv[1].split(chr(92))[-1].split("/")[-1]}+0x{rva:x}')
    for n, ins in enumerate(md.disasm(data[at:at + count * 16], rva)):
        if n >= count:
            break
        print(f'  {ins.address:08x}  {ins.bytes.hex():<20} {ins.mnemonic:8} {ins.op_str}')
`;
const run = spawnSync('python', ['-P', '-c', program, image, ...offsets], { encoding: 'utf8' });
process.stdout.write(run.stdout ?? '');
process.stderr.write(run.stderr ?? '');
process.exit(run.status ?? 1);
