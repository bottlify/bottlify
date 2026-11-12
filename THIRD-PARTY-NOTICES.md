# Third-party notices: Bottlify

This lists components not authored in this repository that are distributed with the product.
Full license texts are kept alongside the corresponding component.

## FFmpeg: video and audio decoding

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

## minimp3: MPEG Layer 3 audio decoding

- Source: minimp3 by lieff, https://github.com/lieff/minimp3, compiled to WebAssembly by the
  npm package `minimp3-wasm` 0.1.0 (https://github.com/bashi/minimp3-wasm)
- Distributed artifact: that package's `dist/decoder.opt.wasm`, unmodified (SHA-256
  `3fea18c86778b24306c9f184cba41df3c7dd0ab8e49e70416ba21ae6e696e55c`), embedded as base64 in
  `modules/core/src/layers/audio/asi/minimp3.wasm.js`; the code that drives it,
  `minimp3.js` beside it, is original work under the MPL
- License: minimp3 is CC0-1.0 (public domain dedication); the WebAssembly build is Apache-2.0,
  whose full text is `modules/core/src/layers/audio/asi/minimp3.LICENSE`

## Microsoft Root Authority certificate: the default Authenticode trust anchor

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

## Microsoft Root Certificate Authority certificates (2001, 2010, 2011): default trust anchors

- What they are: the root certificates "Microsoft Root Certificate Authority" (2001-05-09 to
  2021-05-09, SHA-1 thumbprint CDD4EEAE6000AC7F40C3802C171E30148030C072), "Microsoft Root
  Certificate Authority 2010" (2010-06-23 to 2035-06-23, 3B1EFD3A66EA28B16697394703A72CA340A05BD5)
  and "Microsoft Root Certificate Authority 2011" (2011-03-22 to 2036-03-22,
  8F43288AD272F3103B6FB1428485EA3014C0BCFE), Microsoft Corporation's. The code signing and
  timestamping certificates of the .NET Framework 4 and later chain to them.
- Source: Microsoft's PKI publication, the addresses the certificates below them name for their
  issuer (`http://www.microsoft.com/pki/certs/MicrosoftRootCert.crt`,
  `MicRooCerAut_2010-06-23.crt`, `MicRooCerAut2011_2011_03_22.crt`), taken unmodified. Before
  they were committed each thumbprint was checked against the one above and each self-signature
  verified.
- Location in this repository: `modules/core/src/layers/win32/wintrust/roots.js`, as base64
  DER.
- What is used: their names and public keys, as data, as the root above: the default content of
  the root store, which the `trustedRoots` configuration replaces. Every Windows 7 installation
  whose roots are kept up to date carries them; they grant nothing beyond accepting a signature
  Windows would accept.

## Thawte Timestamping CA certificate: a default Authenticode trust anchor

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

## Wine conformance expectations: used as a specification

Wine and the Win32 specifications are used only as a source of knowledge about API behavior;
no code from them is carried into this repository.

The graphics layer states this more precisely, because it leans on that knowledge hardest.
Wine's conformance tests for DirectDraw, Direct3D and OpenGL (`dlls/*/tests`, LGPL-2.1-or-later)
establish what these APIs do: which argument combinations fail and with which result code, what
state a freshly created device holds, which calls are legal in which order. Those behaviours are
facts about a Microsoft product, established by measurement, and belong to nobody.

What is derived from them here: the boundary-case sets and the validity tables: which lock
rectangles are malformed, which pool and usage combinations are accepted, which capability bits a
surface may be created with. The selection of cases to cover is Wine's editorial work over
twenty-five years, and this entry records that debt.

Wine's `dlls/d3dx9_36/tests/shader.c` (`test_shader_semantics`) is used the same way: the six
shader token streams there and the semantics Windows answers for them are the cases of
`modules/core/src/layers/win32/d3dx9/semantics.test.js` -- test data only; the walk itself is
written from the documented token format.

What is not taken: no code, no test structure, no helper, no assertion text, no ordering. Every
test in this repository is written independently, against this project's own conventions.

## mulberry32: a seeded pseudo-random generator for tests

- Source: mulberry32, by Tommy Ettinger (2017), released into the public domain.
- Location in this repository: the seeded test generators of
  `modules/cork/src/testing/` and `modules/cork/src/runtime/arena.test.js`, and the gate
  `modules/core/src/layers/win32/jscript/fast-paths.itest.js` -- test code only.
- What is used: its few lines of integer arithmetic, so a seed names one random sequence that a
  failing case can be run again from.

## Wine's Windows Installer transform test vectors

- Source: Wine, `dlls/msi/tests/db.c` (`test_try_transform`, `generate_transform`), LGPL-2.1-or-later.
- Location in this repository: `modules/core/src/layers/win32/msi/transform.fixture.js`, test data
  only; nothing from it is in the product.
- What is used: the stream names and the words of the hand-made transform those tests apply:
  a transform's bytes as Windows reads them, used to check that ours reads and writes the same.
  The transform reader and writer themselves are written from the format, not from Wine's code.

## The Windows CD-ROM file system's behaviour: used as a specification

What a disc mounted as a drive answers (`modules/core/src/layers/filesystem/internal/iso/`,
`modules/core/src/layers/win32/kernel32/drives.js` and `filetime.js`) is taken from how
Windows' CD-ROM file system (CDFS) behaves: the Joliet descriptor read in preference to the primary
one, the volume serial number as four byte-wise sums over the descriptor it mounted, every name
reported read-only and the existence bit reported as hidden, the file system named `CDFS`.
Microsoft publishes that file system's source as a Windows Driver Kit sample (Microsoft Public
License); it is used as knowledge of the observable behaviour only, and no code from it is carried
into this repository. The disc format itself is read from its public standards, ECMA-119 and the
Joliet specification.

## The PKWARE DCL implode format: used as a specification

- Source: the format as Mark Adler's `blast.c` (zlib's `contrib/blast`, zlib license,
  https://github.com/madler/zlib/tree/develop/contrib/blast) documents it: the header bytes,
  the bit order, the inverted Huffman codes and the three fixed tables' code lengths, which
  `modules/installer/src/stirling.js` carries as the same run-length-packed constants, and the
  test vector `stirling.test.js` checks
- No code is copied; the decoder is original work under the MPL
- License: zlib (the tables are data of the format, reproduced with acknowledgement)

## wabt: the WebAssembly text format, for a development tool

- Source: the npm package `wabt` 1.0.39 (https://github.com/WebAssembly/wabt), a WebAssembly
  build of the WebAssembly Binary Toolkit
- Used by: `tools/cork-wat.mjs`, which prints cork's output as text (`wasm2wat`); a development
  dependency of the repository root, not part of any module and not distributed with the product
- License: Apache-2.0

## Lua 5.1.5: a script interpreter, for a benchmark's workload

- Source: Lua 5.1.5 by Lua.org, PUC-Rio, https://www.lua.org/ftp/lua-5.1.5.tar.gz (SHA-256
  `2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333`), unmodified; fetched by
  `tools/cork-bench/build.sh` at its checksum, not committed
- Distributed artifact: `tools/cork-bench/images/lua-x87.bin`, its core and its base, string,
  table and math libraries compiled for i386 and linked with `tools/cork-bench/src/lua` (a
  small C library, a driver and a script: original work under the MPL); a benchmark workload,
  not part of any module and not distributed with the product
- License: MIT, whose full text is `tools/cork-bench/src/lua/COPYRIGHT-lua-5.1.5.txt`

## CLDR's Windows time zone mapping: which IANA zone each Windows zone is

- Source: the Unicode Common Locale Data Repository, `common/supplemental/windowsZones.xml`
  (https://github.com/unicode-org/cldr), its territory "001" rows: each Windows time zone's
  registry key and the IANA zone it corresponds to
- Location in this repository: `modules/core/src/layers/win32/kernel32/timezones.js`, the
  `WINDOWS_ZONES` table, as the key and zone names alone; the rules of each zone are not copied
  but read at run time from the platform's own zone data
- License: Unicode License v3 (https://www.unicode.org/license.txt)

## The LZMA specification: used as a specification

- Source: Igor Pavlov's `lzma-specification.txt` from the LZMA SDK (https://www.7-zip.org/sdk.html),
  placed in the public domain: the range coder, the probability model and its constants, the
  literal, match and repeat-distance coding
- Location in this repository: `modules/core/src/steam/lzma.js`, a decoder for raw streams of
  known length; no code is copied, the decoder is original work under the MPL
- License: public domain

## The Steamworks SDK's interface headers: used as a specification

- Source: Valve's Steamworks SDK headers (`isteamclient.h`, `isteamuser.h` and the rest, every
  interface version a game may ask for, as the SDK's history is kept by projects that carry it):
  each interface's methods in vtable order and their parameter and return types
- Location in this repository: `modules/core/src/layers/win32/steamclient/interfaces.js`, written
  by `tools/steam-interfaces.mjs` -- each method's name, its argument bytes on an x86 stack and how
  it returns, which is the binary interface a game compiled against; no code is copied, and the
  client that answers the methods is original work under the MPL
- License: the Steamworks SDK Access Agreement governs the SDK; the layouts are facts of the
  binary interface, reproduced for interoperability

## Microsoft's D3D11 reference tessellator: the fixed-function tessellator

- Source: the Direct3D 11.3 functional specification's reference tessellator,
  `tessellator.cpp` and `tessellator.hpp` ("Microsoft D3D11 Fixed Function Tessellator Reference -
  May 7, 2012"), https://microsoft.github.io/DirectX-Specs/d3d/archive/images/d3d11/ (repository
  `microsoft/DirectX-Specs`, `d3d/archive/images/d3d11/`); the specification (11.7.1) names it the
  exact description of the stage
- Location in this repository: `modules/core/src/layers/graphics/d3d10/tessellator.js`, its
  hardware class (`CHWTessellator`) translated into JavaScript; and
  `modules/core/src/layers/graphics/d3d10/tess-corpus.json.gz`, the reference's own output for a
  seeded set of patches (`tools/tess-corpus.mjs`), which the translation is tested against. The
  reference's sources are not in this repository.
- License: MIT, Copyright (c) Microsoft Corporation (the repository's code license; Mesa carries
  the same files under the same notice in `src/gallium/auxiliary/tessellator/`)

  Permission is hereby granted, free of charge, to any person obtaining a copy of this software
  and associated documentation files (the "Software"), to deal in the Software without
  restriction, including without limitation the rights to use, copy, modify, merge, publish,
  distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
  Software is furnished to do so, subject to the following conditions: The above copyright notice
  and this permission notice shall be included in all copies or substantial portions of the
  Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
  INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
  AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
  DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Microsoft's BC6H and BC7 specification: used as a specification

- Source: the Direct3D 11.3 functional specification (19.5.13 BC6H, 19.5.14 BC7),
  https://microsoft.github.io/DirectX-Specs/d3d/archive/D3D11_3_FunctionalSpec.htm, and the
  Direct3D 11 documentation's "BC6H Format" and "BC7 Format" pages (repository
  `MicrosoftDocs/win32`, `desktop-src/direct3d11/`): the mode tables, BC6H's header bit fields,
  the partition and fix-up tables (read off the specification's figures) and the unquantize and
  interpolate steps
- Location in this repository: `modules/core/src/layers/graphics/d3d10/bc67.js`, written from
  them; no code of either is copied
- License: the specification's (Microsoft, MIT for `microsoft/DirectX-Specs`; CC-BY 4.0 for the
  documentation's text)

## bcdec: an independent BC6H and BC7 decoder, the test corpus's oracle

- Source: https://github.com/iOrange/bcdec (`bcdec.h`), built locally into a driver that
  `tools/bc-corpus.mjs` asks to decode seeded blocks
- Location in this repository: only its output, `modules/core/src/layers/graphics/d3d10/bc67-corpus.json.gz`,
  which `bc67.test.js` holds `bc67.js` to; none of its code is in the repository
- License: MIT or the Unlicense, at the user's choice (MIT: Copyright (c) 2022 Sergii
  Kudlai)

## Khronos' OpenGL API registry: the commands' declarations

- Source: `xml/gl.xml` of https://github.com/KhronosGroup/OpenGL-Registry at revision
  `6af574a14089ccfee87efe230ebcdd8742859813` (Copyright 2013-2026 The Khronos Group Inc.)
- Location in this repository: `modules/core/src/layers/graphics/opengl/registry.js`, written by
  `tools/gl-registry.mjs` -- each command's name and the size class of its return and of each
  argument, and which commands each version and each ARB, KHR and EXT extension adds; no code is
  copied, and what answers the commands is original work under the MPL
- License: Apache-2.0

## The GLSL specification's built-in functions: used as a specification

- Source: `chapters/builtinfunctions.adoc` of https://github.com/KhronosGroup/GLSL at revision
  `0099bf83b0288469917fc2e2972cb0a2b74d6711` (Copyright The Khronos Group Inc.)
- Location in this repository: `modules/core/src/layers/graphics/opengl/glsl-catalog.js`, written
  by `tools/glsl-functions.mjs` -- each built-in function's name, section, return and parameter
  types and parameter directions as the specification declares them; none of the specification's
  text is copied, and the compiler that checks calls against them is original work under the MPL
- License: CC-BY-4.0 (the specification's sources)

## mermaid: the diagrams on the documentation site

- Source: the npm package `mermaid` 11.4.1 (https://github.com/mermaid-js/mermaid), loaded from
  jsdelivr at that version
- Used by: the documentation site `tools/docs/site.mjs` builds, on a page with a diagram; not
  part of any module and not distributed with the product
- License: MIT

## 3d-force-graph: the 3D graph on the documentation site

- Source: the npm package `3d-force-graph` 1.79.1 (https://github.com/vasturiano/3d-force-graph),
  its UMD bundle (with three.js inside) loaded from jsdelivr at that version
- Used by: the documentation site's `architecture/graph.html` (`tools/docs/assets/graph3d.js`);
  not part of any module and not distributed with the product
- License: MIT (three.js inside it: MIT)
