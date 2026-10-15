/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The .btl bundle format: what a writer and a reader have to agree on -- the
 * header's magic, size and versions, the block codecs, and the checksum a
 * block is stored with. Published as `@bottlify/core/bundle` for whoever
 * writes a bundle, in a browser or on a host; the engine reads bundles with
 * the same constants, so the two cannot drift apart. Reading and writing files
 * on a host is `@bottlify/core/bundle/node`.
 */

export { MAGIC, HEADER_SIZE, FORMAT_VERSION, READABLE_VERSIONS, Codec, openBundle }
    from './layers/filesystem/internal/bundle/format.js';
export { crc32 } from './layers/filesystem/internal/bundle/crc32.js';
