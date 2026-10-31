/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

export { connectCm, ANONYMOUS_INDIVIDUAL } from './connection.js';
export { signInWithQr } from './auth.js';
export {
    appOwnershipTicket, logOn, logOnAnonymously, library, ownedApps, productInfo, steamIdOfToken,
} from './session.js';
export { encodeQr, qrToSvg } from './qr.js';
export { parseText, parseBinary } from './keyvalues.js';
export { CLIENT_CDN, CLIENT_FILES, fetchClientFiles, zipEntries } from './client.js';
export {
    FILE_FLAG_DIRECTORY, contentServers, depotKey, downloadChunk, manifest, manifestRequestCode,
    readDepotAccess, writeDepotAccess,
} from './depot.js';
// Not install.js nor redist.js: they reach the engine's layers (the bundle
// writer, cabinets, installer databases), which the bridge, carrying this
// module and what it imports, has no use for -- `@bottlify/core/steam/install`.
export {
    STEAM_ART, depotOwners, publicAppInfo, sharedDepots, steamArt, wantedDepot, windowsLaunch,
} from './apps.js';
