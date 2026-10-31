/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// The formats of Steam's files, which a page reads where the bytes land: a
// manifest, a chunk, a KeyValues text, and the QR code a sign-in is shown as.
// Speaking to Steam -- the account, the keys, the codes -- is GameHub's
// (`modules/bridge`), and the install is `@bottlify/core/steam/install`.
export { encodeQr, qrToSvg } from './qr.js';
export { parseText, parseBinary } from './keyvalues.js';
export {
    FILE_FLAG_DIRECTORY, adler32, decompressChunk, downloadChunk, manifest, symmetricDecrypt,
} from './depot.js';
