# Third-party notices — Bottlify

This lists components not authored in this repository that are distributed with the product.
Full license texts are kept alongside the corresponding component.

## FFmpeg — video and audio decoding

- Source: upstream https://github.com/FFmpeg/FFmpeg at release tag `n6.1`, commit
  `d4ff0020b40b524a490cf62eccbd3a318f4c0e58`, unmodified
- Build definition: `modules/core/scripts/Dockerfile.video-decoder`,
  `modules/core/scripts/video-decoder/build-decoder.sh` and `build-video-decoder.mjs` in this
  repository; the workflow `.github/workflows/vendor.yml` runs it and publishes the result as a
  release of this repository
- Distributed artifact: `video-decoder.wasm`, a WebAssembly build of the FFmpeg libraries linked
  with `modules/core/scripts/video-decoder/decoder.c` (original work under the MPL), fetched into
  `modules/core/vendor/prebuilt/` by `npm run fetch:video-decoder` from the release pinned in
  `modules/core/video-decoder-lock.json`. It is a build artifact and is not committed to this
  repository.
- License: LGPL-2.1-or-later

The build passes neither `--enable-gpl` nor `--enable-nonfree`, so no GPL-licensed and no
non-redistributable component is compiled in; the result is FFmpeg under the LGPL, distributed
alongside this MPL-2.0 product as a separately licensed component rather than merged into it.
Adding either flag would relicense the artifact, and `build-decoder.sh` says so where the flags
are.

The corresponding source obligation is met by upstream itself: FFmpeg's code is compiled as
released, and the image pins the tag by commit so that a tag that moved fails the build rather
than compiling something else. The commit is repeated inside `video-decoder.manifest.json`,
published beside the `.wasm`: the exact tree that was compiled is public and named, and
rebuilding it needs only Docker.

FFmpeg's full license text is in that tree (`COPYING.LGPLv2.1`).

## minimp3 — MPEG Layer 3 audio decoding

- Source: minimp3 by lieff, https://github.com/lieff/minimp3, compiled to WebAssembly by the
  npm package `minimp3-wasm` 0.1.0 (https://github.com/bashi/minimp3-wasm)
- Distributed artifact: that package's `dist/decoder.opt.wasm`, unmodified (SHA-256
  `3fea18c86778b24306c9f184cba41df3c7dd0ab8e49e70416ba21ae6e696e55c`), embedded as base64 in
  `modules/core/src/layers/audio/asi/minimp3.wasm.js`; the code that drives it,
  `minimp3.js` beside it, is original work under the MPL
- License: minimp3 is CC0-1.0 (public domain dedication); the WebAssembly build is Apache-2.0,
  whose full text is `modules/core/src/layers/audio/asi/minimp3.LICENSE`

## Microsoft Root Authority certificate — the default Authenticode trust anchor

- What it is: the root certificate "Microsoft Root Authority" (issued 1997-01-10, expired
  2020-12-31, serial number C1008B3C3C8811D13EF663ECDF40, SHA-1 thumbprint
  A43489159A520F0D93D032CCAF37E7FE20A8B419), Microsoft Corporation's. The certificates with
  which Microsoft signed and timestamped its software in those years chain to it.
- Source: Microsoft's own publication of the roots Windows trusts, the root certificate
  distribution Windows Update serves
  (`http://www.download.windowsupdate.com/msdownload/update/v3/static/trustedr/en/A43489159A520F0D93D032CCAF37E7FE20A8B419.crt`),
  taken unmodified. Before it was committed its thumbprint was checked against the one above,
  its validity against the dates above, and the "Microsoft Code Signing PCA" and "Microsoft
  Timestamping PCA" certificates carried in signed Microsoft cabinets were verified against its
  public key.
- Location in this repository: `modules/core/src/layers/win32/wintrust/roots.js`, as base64
  DER.
- What is used: its names and public key, as data. It is the default content of the root store
  `WinVerifyTrust` verifies Authenticode signatures against; the store is configuration
  (`trustedRoots`) and replaces it when given. The certificate is a public document that every
  Windows installation carries; it is included so that a signature Windows would accept is
  accepted here, and it grants nothing beyond that.

## Thawte Timestamping CA certificate — a default Authenticode trust anchor

- What it is: the root certificate "Thawte Timestamping CA" (issued 1997-01-01, expired
  2020-12-31, SHA-1 thumbprint BE36A4562FB2EE05DBB3D32323ADF445084ED656), Thawte's (now
  DigiCert's). VeriSign's "Time Stamping Services CA", which countersigned Authenticode
  signatures in the 2000s, chains to it.
- Source: the Windows trusted root store, where Microsoft's root program distributes it,
  taken unmodified; its thumbprint was checked against the one above.
- Location in this repository: `modules/core/src/layers/win32/wintrust/roots.js`, as base64
  DER.
- What is used: its names and public key, as data, the same way as the Microsoft root above:
  default content of the root store, so that a timestamp Windows XP accepts is accepted here.

## Wine conformance expectations — used as a specification

Wine and the Win32 specifications are used only as a source of knowledge about API behavior;
no code from them is carried into this repository.

The graphics layer states this more precisely, because it leans on that knowledge hardest.
Wine's conformance tests for DirectDraw, Direct3D and OpenGL (`dlls/*/tests`, LGPL-2.1-or-later)
establish what these APIs do: which argument combinations fail and with which result code, what
state a freshly created device holds, which calls are legal in which order. Those behaviours are
facts about a Microsoft product, established by measurement, and belong to nobody.

What is derived from them here: the boundary-case sets and the validity tables — which lock
rectangles are malformed, which pool and usage combinations are accepted, which capability bits a
surface may be created with. The selection of cases to cover is Wine's editorial work over
twenty-five years, and this entry records that debt.

What is not taken: no code, no test structure, no helper, no assertion text, no ordering. Every
test in this repository is written independently, against this project's own conventions.

## The Windows CD-ROM file system's behaviour -- used as a specification

What a disc mounted as a drive answers (`modules/core/src/layers/filesystem/internal/iso/`,
`modules/core/src/layers/win32/kernel32/drives.js` and `filetime.js`) is taken from how
Windows' CD-ROM file system (CDFS) behaves: the Joliet descriptor read in preference to the primary
one, the volume serial number as four byte-wise sums over the descriptor it mounted, every name
reported read-only and the existence bit reported as hidden, the file system named `CDFS`.
Microsoft publishes that file system's source as a Windows Driver Kit sample (Microsoft Public
License); it is used as knowledge of the observable behaviour only, and no code from it is carried
into this repository. The disc format itself is read from its public standards, ECMA-119 and the
Joliet specification.
