/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The PA19 reader and applier against patches built by `pa19.fixture.js`,
 * whose layout reproduces patches made by Microsoft's compressor byte for
 * byte, with LZXD streams from the cabinet's test encoder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { APPLY_OPTION, PATCH_ERROR, PATCH_OPTION, PatchError, applyPatch, patchSignature,
    readPatchHeader } from './pa19.js';
import { ascii, buildPatch, storedStream, svli, tinyPe32, uvli, verbatimStream }
    from './pa19.fixture.js';
import { createMd5 } from '../crypto/digest.js';
import { literals } from '../cabinet/lzx.fixture.js';

/** The options a patch made with Microsoft's defaults for plain files records. */
const PLAIN = PATCH_OPTION.USE_LZX_A | PATCH_OPTION.NO_REBASE | PATCH_OPTION.NO_RESTIMEFIX
    | PATCH_OPTION.NO_TIMESTAMP;

/** @param {Uint8Array} patch */
const codeOf = patch=>{
    try
    {
        readPatchHeader(patch);
        return 0;
    }
    catch (e){
        assert.ok(e instanceof PatchError);
        return e.code;
    }
};

test('variable-length integers: the last byte has bit 7, a signed one its sign in bit 6', ()=>{
    assert.deepEqual(uvli(5), [0x85]);
    assert.deepEqual(uvli(1024), [0x00, 0x88]);
    assert.deepEqual(svli(0), [0x80]);
    assert.deepEqual(svli(-5), [0xc5]);
    assert.deepEqual(svli(100), [0x24, 0x81]);
    const header = readPatchHeader(buildPatch({ flags: PLAIN, timestamp: 1, newBytes: ascii('x'),
        oldFiles: [{ bytes: new Uint8Array(101), stream: storedStream(ascii('x')) }] }));
    assert.equal(header.oldFiles[0].size, 101, 'a size 100 more than the new one');
});

test('a header with every optional field: extended flags, time stamp, image base, ranges', ()=>{
    const old = Uint8Array.from({ length: 300 }, (_, i)=>i & 0xff);
    const newBytes = ascii('a'.repeat(120));
    const flags = PATCH_OPTION.USE_LZX_A | PATCH_OPTION.RESERVED1 | PATCH_OPTION.NO_TIMESTAMP;
    const patch = buildPatch({ flags, extendedFlags: 0x300, timestamp: 0x5cbaa5c5,
        imageBase: 0x10000000, newBytes,
        oldFiles: [{ bytes: old, stream: storedStream(newBytes),
            ignore: [{ offset: 10, length: 5 }, { offset: 40, length: 2 }],
            retain: [{ oldOffset: 100, newOffset: 20, length: 8 },
                { oldOffset: 200, newOffset: 60, length: 4 }] }] });
    const header = readPatchHeader(patch);
    assert.equal(header.flags, flags >>> 0);
    assert.equal(header.extendedFlags, 0x300);
    assert.equal(header.timestamp, 0x5cbaa5c5);
    assert.equal(header.imageBase, 0x10000000);
    assert.equal(header.newSize, 120);
    assert.equal(header.end, patch.length);
    assert.deepEqual(header.oldFiles[0].ignore,
        [{ offset: 10, length: 5 }, { offset: 40, length: 2 }]);
    assert.deepEqual(header.oldFiles[0].retain, [{ oldOffset: 100, newOffset: 20, length: 8 },
        { oldOffset: 200, newOffset: 60, length: 4 }]);
});

test('the time stamp is there when NO_TIMESTAMP is set, the image base when NO_REBASE is not', ()=>{
    const newBytes = ascii('abc');
    const oldFiles = [{ bytes: new Uint8Array(0), stream: storedStream(newBytes) }];
    const bare = readPatchHeader(buildPatch({ flags: PATCH_OPTION.NO_REBASE, newBytes, oldFiles }));
    assert.equal(bare.timestamp, null);
    assert.equal(bare.imageBase, null);
    const both = readPatchHeader(buildPatch({ flags: PATCH_OPTION.NO_TIMESTAMP, timestamp: 7,
        imageBase: 0x400000, newBytes, oldFiles }));
    assert.equal(both.timestamp, 7);
    assert.equal(both.imageBase, 0x400000);
});

test('a header that is not one: signature, CRC, options, counts, ranges', ()=>{
    const newBytes = ascii('hello');
    const spec = { flags: PLAIN, newBytes,
        oldFiles: [{ bytes: ascii('world!'), stream: storedStream(newBytes) }] };
    const good = buildPatch(spec);
    assert.equal(codeOf(good), 0);

    const signature = good.slice();
    signature[3] = 0x30; // PA10
    assert.equal(codeOf(signature), PATCH_ERROR.CORRUPT);
    const damaged = good.slice();
    damaged[good.length - 8] ^= 1;
    assert.equal(codeOf(damaged), PATCH_ERROR.CORRUPT, 'the CRC over the patch');
    assert.equal(codeOf(good.subarray(0, 12)), PATCH_ERROR.CORRUPT, 'ends inside the header');

    assert.equal(codeOf(buildPatch({ ...spec, flags: PLAIN | 0x00000100 })),
        PATCH_ERROR.NEWER_FORMAT, 'an option no version of the format has');
    assert.equal(codeOf(buildPatch({ ...spec, flags: PLAIN | PATCH_OPTION.SIGNATURE_MD5 })),
        PATCH_ERROR.NEWER_FORMAT, 'a signature option is not a patch option');
    assert.equal(codeOf(buildPatch({ ...spec, transforms: 3 })), PATCH_ERROR.DECODE_FAILURE,
        'the 32-bit executable transform table is not reversed here');
    const unknownDamaged = buildPatch({ ...spec, flags: PLAIN | 0x00000100 });
    unknownDamaged[unknownDamaged.length - 1] ^= 1;
    assert.equal(codeOf(unknownDamaged), PATCH_ERROR.CORRUPT,
        'damage is told apart from what is merely not known here');
    assert.equal(codeOf(buildPatch({ ...spec, oldFiles: [{ ...spec.oldFiles[0],
        ignore: [{ offset: 4, length: 3 }] }] })), PATCH_ERROR.CORRUPT,
    'an ignore range past the file');
    assert.equal(codeOf(buildPatch({ ...spec, oldFiles: [{ ...spec.oldFiles[0],
        retain: [{ oldOffset: 0, newOffset: 3, length: 3 }] }] })), PATCH_ERROR.CORRUPT,
    'a retain range past the new file');
    assert.equal(codeOf(buildPatch({ ...spec, oldFiles: [
        { bytes: ascii('one'), retain: [{ oldOffset: 0, newOffset: 1, length: 2 }] },
        { bytes: ascii('two'), retain: [{ oldOffset: 0, newOffset: 2, length: 2 }] }] })),
    PATCH_ERROR.CORRUPT, 'old files that disagree on the new file\'s retained ranges');

    // No old file at all, and an integer of ten bytes.
    const none = Uint8Array.from([0x50, 0x41, 0x31, 0x39, ...[1, 0, 0x44, 0], 0x85, 0, 0, 0, 0, 0]);
    assert.equal(codeOf(none), PATCH_ERROR.CORRUPT);
    const long = Uint8Array.from([0x50, 0x41, 0x31, 0x39, ...[1, 0, 0x44, 0],
        ...new Array(10).fill(0)]);
    assert.equal(codeOf(long), PATCH_ERROR.CORRUPT);
});

test('a patch that needs no old file makes the new one from its stream alone', ()=>{
    const newBytes = ascii('a file made from nothing');
    const patch = buildPatch({ flags: PLAIN, timestamp: 1555736005, newBytes,
        oldFiles: [{ bytes: new Uint8Array(0), stream: storedStream(newBytes) }] });
    const result = applyPatch(null, patch, APPLY_OPTION.FAIL_IF_EXACT);
    assert.equal(result.code, 0);
    assert.deepEqual(result.bytes, newBytes);
    assert.equal(result.timestamp, 1555736005);
    assert.equal(applyPatch(ascii('something'), patch).code, PATCH_ERROR.WRONG_FILE,
        'an old file where the patch wants none');
});

test('matches reach into the old file, its ignored ranges read as zeros', ()=>{
    const old = ascii('0123456789ABCDEFGHIJ');
    // The output: "ABCDE" from the old file, three literals, then "3456",
    // whose "56" lie in an ignored range of the old file and so are zeros.
    const tokens = [{ length: 5, offset: 10 }, ...literals('xyz'), { length: 4, offset: 25 }];
    const newBytes = Uint8Array.from([...ascii('ABCDExyz34'), 0, 0]);
    const patch = buildPatch({ flags: PLAIN, newBytes, oldFiles: [{ bytes: old,
        ignore: [{ offset: 5, length: 2 }], stream: verbatimStream(tokens, 12) }] });
    const result = applyPatch(old, patch);
    assert.equal(result.code, 0, result.reason);
    assert.deepEqual(result.bytes, newBytes);

    // The ignored range may hold anything in the old file the patch is applied to.
    const drifted = old.slice();
    drifted[5] = 0x7f;
    drifted[6] = 0x7e;
    assert.deepEqual(applyPatch(drifted, patch).bytes, newBytes);
    drifted[7] = 0x7d;
    assert.equal(applyPatch(drifted, patch).code, PATCH_ERROR.WRONG_FILE);
});

test('retained ranges come across from the old file whatever they hold', ()=>{
    const old = ascii('KEEP-this-and-that');
    const newBytes = ascii('[----]stored');
    // The new file's bytes 1..4 are the old file's 0..3, which the stream
    // leaves as zeros and the CRC reads as zeros.
    const stream = storedStream(Uint8Array.from([0x5b, 0, 0, 0, 0, ...ascii(']stored')]));
    const patch = buildPatch({ flags: PLAIN, newBytes, oldFiles: [{ bytes: old,
        retain: [{ oldOffset: 0, newOffset: 1, length: 4 }], stream }] });
    const result = applyPatch(old, patch);
    assert.equal(result.code, 0, result.reason);
    assert.equal(String.fromCharCode(...result.bytes ?? []), '[KEEP]stored');

    const other = old.slice();
    other.set(ascii('ELSE'), 0);
    assert.equal(String.fromCharCode(...applyPatch(other, patch).bytes ?? []), '[ELSE]stored',
        'a retained range is not part of the old file\'s CRC');
});

test('a patch for two old files applies to either, each with its own stream', ()=>{
    const newBytes = ascii('the new version of the file');
    const first = ascii('the old version of the file');
    const second = ascii('an older version');
    const patch = buildPatch({ flags: PLAIN, newBytes, oldFiles: [
        { bytes: first, stream: verbatimStream([...literals('the new'),
            { length: 20, offset: 27 }], 27) },
        { bytes: second, stream: storedStream(newBytes) }] });
    assert.deepEqual(applyPatch(first, patch).bytes, newBytes);
    assert.deepEqual(applyPatch(second, patch).bytes, newBytes);
    assert.equal(applyPatch(ascii('neither of them'), patch).code, PATCH_ERROR.WRONG_FILE);
});

test('a patch between identical files: the old file, or not necessary when asked', ()=>{
    const old = ascii('unchanged');
    const patch = buildPatch({ flags: PLAIN, newBytes: old, oldFiles: [{ bytes: old }] });
    assert.deepEqual(applyPatch(old, patch).bytes, old);
    assert.equal(applyPatch(old, patch, APPLY_OPTION.FAIL_IF_EXACT).code,
        PATCH_ERROR.NOT_NECESSARY);
    assert.equal(applyPatch(old, patch, APPLY_OPTION.FAIL_IF_CLOSE).code,
        PATCH_ERROR.NOT_NECESSARY);

    // A stream whose output is the old file is not necessary either.
    const again = buildPatch({ flags: PLAIN, newBytes: old,
        oldFiles: [{ bytes: old, stream: storedStream(old) }] });
    assert.equal(applyPatch(old, again).code, 0);
    assert.equal(applyPatch(old, again, APPLY_OPTION.FAIL_IF_EXACT).code,
        PATCH_ERROR.NOT_NECESSARY);
});

test('close: the same file but for the ranges the patch sets aside', ()=>{
    const old = ascii('stamp:1234;body');
    const newBytes = ascii('stamp:9999;body');
    const patch = buildPatch({ flags: PLAIN, newBytes,
        oldFiles: [{ bytes: old, ignore: [{ offset: 6, length: 4 }],
            stream: storedStream(newBytes) }] });
    assert.equal(applyPatch(old, patch, APPLY_OPTION.FAIL_IF_EXACT).code, 0);
    assert.equal(applyPatch(old, patch, APPLY_OPTION.FAIL_IF_CLOSE).code,
        PATCH_ERROR.NOT_NECESSARY);
});

test('a decoded file that fails its CRC is corrupt; a stream that does not decode fails', ()=>{
    const newBytes = ascii('payload');
    const old = ascii('base');
    const wrongCrc = buildPatch({ flags: PLAIN, newBytes, newCrc: 0x12345678,
        oldFiles: [{ bytes: old, stream: storedStream(newBytes) }] });
    assert.equal(applyPatch(old, wrongCrc).code, PATCH_ERROR.CORRUPT);

    const stream = storedStream(newBytes);
    stream[2] = (stream[2] & 0x0f) | 0x70; // block type 7 in the first word's top bits
    const undecodable = buildPatch({ flags: PLAIN, newBytes, oldFiles: [{ bytes: old, stream }] });
    assert.equal(applyPatch(old, undecodable).code, PATCH_ERROR.DECODE_FAILURE);

    const sizeOnly = buildPatch({ flags: PLAIN, newBytes,
        oldFiles: [{ bytes: ascii('payloaX') }] });
    assert.equal(applyPatch(ascii('payloaX'), sizeOnly).code, PATCH_ERROR.CORRUPT,
        'no stream, and the old file is not the new one');
});

test('a patch of its header alone tests, and does not apply', ()=>{
    const newBytes = ascii('data');
    const old = ascii('base data');
    const patch = buildPatch({ flags: PLAIN, newBytes, headerOnly: true,
        oldFiles: [{ bytes: old, stream: storedStream(newBytes) }] });
    assert.deepEqual(applyPatch(old, patch, 0, { headerOnly: true }),
        { code: 0, size: 4, timestamp: 0 });
    assert.equal(applyPatch(ascii('base date'), patch, 0, { headerOnly: true }).code,
        PATCH_ERROR.WRONG_FILE);
    assert.equal(applyPatch(old, patch).code, PATCH_ERROR.NOT_AVAILABLE);
});

test('what is refused rather than guessed: a normalised PE, interleaving, a huge old file', ()=>{
    const newBytes = ascii('new image');
    const pe = tinyPe32();
    const drifted = pe.slice();
    drifted[0x100] = 1;
    const defaults = PATCH_OPTION.USE_LZX_A | PATCH_OPTION.NO_TIMESTAMP;
    const peSpec = { newBytes, oldFiles: [{ bytes: pe, stream: storedStream(newBytes) }] };
    assert.equal(applyPatch(drifted, buildPatch({ ...peSpec, flags: defaults })).code,
        PATCH_ERROR.DECODE_FAILURE, 'it may have been made against the normalised image');
    assert.equal(applyPatch(drifted, buildPatch({ ...peSpec,
        flags: defaults | PATCH_OPTION.NO_BINDFIX | PATCH_OPTION.NO_LOCKFIX | PATCH_OPTION.NO_REBASE
            | PATCH_OPTION.NO_CHECKSUM | PATCH_OPTION.NO_RESTIMEFIX })).code,
    PATCH_ERROR.WRONG_FILE, 'with every normalisation off it is simply another file');
    assert.equal(applyPatch(pe, buildPatch({ ...peSpec, flags: defaults })).code, 0,
        'a PE image whose CRC matches as it is');

    const interleaved = buildPatch({ flags: PLAIN | PATCH_OPTION.INTERLEAVE_FILES,
        interleave: [0, 3, 3, 3, 3], ...peSpec, oldFiles: [{ bytes: ascii('abc'),
            stream: storedStream(newBytes) }] });
    assert.equal(applyPatch(ascii('abc'), interleaved).code, PATCH_ERROR.DECODE_FAILURE);
    const noRanges = buildPatch({ flags: PLAIN | PATCH_OPTION.INTERLEAVE_FILES, interleave: [0, 0],
        newBytes, oldFiles: [{ bytes: ascii('abc'), stream: storedStream(newBytes) }] });
    assert.equal(readPatchHeader(noRanges).oldFiles[0].interleave.length, 2);

    const huge = new Uint8Array(2 ** 23 + 1);
    const big = buildPatch({ flags: PLAIN, newBytes, oldFiles: [{ bytes: huge,
        stream: storedStream(newBytes) }] });
    assert.equal(applyPatch(huge, big).code, PATCH_ERROR.DECODE_FAILURE);
});

test('a patch signature: the CRC-32 or MD5 of the file without its ranges', ()=>{
    const bytes = ascii('signature subject, with a stamp: 0042');
    const plain = bytes.slice();
    plain.fill(0, 33, 37);
    const ranges = [{ offset: 33, length: 4 }];
    const crc = patchSignature(bytes, 0, ranges, [], createMd5);
    assert.match(crc ?? '', /^[0-9a-f]{8}$/);
    assert.equal(crc, patchSignature(plain, 0, [], [], createMd5));
    assert.equal(patchSignature(bytes, 0, [], ranges, createMd5), crc,
        'retained ranges are set aside the same way');
    assert.equal(patchSignature(bytes, PATCH_OPTION.SIGNATURE_MD5, ranges, [], createMd5),
        createHash('md5').update(plain).digest('hex'));
    assert.equal(patchSignature(tinyPe32(), 0, [], [], createMd5), null,
        'a PE image is signed normalised, which is not implemented');
});
