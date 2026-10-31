# GameHub

Plan, no code. 2026-10-31. A number not measured says so.

GameHub is the browser extension in `modules/bridge`. It becomes the one place that talks to game
stores' services and keeps their accounts: it signs in and out, lists the account's games and
hands out what a download needs and a game's cover. Bottlify -- `@bottlify/core` and the launcher
-- keeps the engine and the install: the page fetches the manifests and chunks from the stores'
CDNs itself, decrypts and decompresses them, writes the bottle into its own OPFS and applies the
redistributables, as it does today. Steam is the first store.

## The ops

The page asks the content script (`window.postMessage`, as now). No op names a store's protocol;
the store is an argument.

| Op | Answer |
| --- | --- |
| `hello` | `{ version, stores: [{ id, name, on }] }`: the stores GameHub has, and which the site has on |
| `account { store }` | `{ name }` or null; never a token |
| `signIn { store }` | opens GameHub's sign-in page (needs a click on the page); resolves once signed in, or the page is closed |
| `signOut { store }` | `{}` |
| `list { store, fresh? }` | `[{ id, name, bytes, installable }]`: the account's games |
| `cover { store, game, kind }` | a URL of the store's art GameHub's rules open to the page; `kind` is `header`, `capsule` or `hero` |
| `download { store, game }` | what the page needs to download it -- for Steam `{ name, launch, installscript, servers: [{ host, vhost }], depots: [{ depot, gid, key, code, shared }] }`, the redistributables' depots included and their keys and codes asked under their owning app |
| `runData { store, game }` | what a run of the game hands the engine's emulation of that store's client -- for Steam `{ win32: { steam: { steamId, accountName, apps, ownershipTickets, clientFiles } } }` |
| `cancel { target }` | aborts a request by its id |

`download` replaces today's `steam.productInfo` + `steam.depotKey` + `steam.manifestCode` +
`steam.contentServers`: the plan is built in GameHub, from product info only GameHub reads. A
request code lasts minutes (not measured how many), so the page asks `download` again when it
resumes. `runData` stays store-shaped inside: the engine's `win32.steam` reads it, the launcher
passes it through.

## What moves, and what the page keeps

The line: what speaks to a store's **services** goes to GameHub; what reads a store's **file
formats** stays with the page.

| Code (core `src/steam/` today) | Goes to | Why |
| --- | --- | --- |
| `connection.js`, `messages.js` (CM socket, EMsgs) | GameHub | the store's service |
| `auth.js`, `qr.js` (QR sign-in, its picture) | GameHub (sign-in page) | the site no longer drives a sign-in |
| `session.js` (logon, licences, `ownedApps`, PICS `productInfo`, ownership tickets) | GameHub | |
| `depot.js` `depotKey`, `manifestRequestCode`, `contentServers` | GameHub (`download`) | |
| `apps.js` (`wantedDepot`, `sharedDepots`, `windowsLaunch`, `publicAppInfo`, art URLs) | GameHub | reading product info is the store's knowledge |
| `client.js` (Valve's client files from Valve's CDN) | GameHub (`runData`) | |
| launcher `src/steam/client.js`, `install.js` (`storeGame`, `askPlan`, `depotOpenings`) | GameHub (`list`, `download`) | the launcher keeps one generic provider per store `hello` lists |
| `depot.js` `manifest`, `downloadChunk`, `symmetricDecrypt`, `decompressChunk`, `adler32` | stays in core | the CDN's file format, read where the bytes land |
| `lzma.js`, `../zstd.js`, `protobuf.js` (decode) | stays in core | formats; GameHub's build copies `protobuf.js` and `keyvalues.js` for its own messages, one source |
| `install.js` (`installBundle`, `downloadFiles`, `installedFiles`), `bundle-in-place.js` | stays in core | the install |
| `redist.js`, `keyvalues.js` (installscript text, MSI and cabinets, A67) | stays in core | a file inside the downloaded game, applied to Windows |
| engine `layers/win32/steamclient` | stays in core | the emulated client; fed `runData` |

Core keeps a `./steam` export holding the formats and the install only; the protocol modules leave
it. `tools/steam-install.mjs` stays a node tool and takes the protocol code from GameHub's source.

## Tokens and sign-in

- **Sign-in on GameHub's own page** (an extension tab, or the action popup): the QR code over Steam's
  HTTPS Web API, `IAuthenticationService/BeginAuthSessionViaQR` then `PollAuthSessionStatus`.
  Whether these answer a request from an extension origin: not measured (M3).
- **The refresh token only in the service worker**, encrypted with a non-extractable AES-GCM key kept
  in the extension origin's IndexedDB. Today it sits in `chrome.storage.local`, which the content
  script can read -- and the content script runs in the page's renderer, beside the engine.
- **The CM socket.** Steam's managers refuse a WebSocket whose Origin is not theirs; today the
  content script holds the socket because the ruleset rewrites the Origin of the page's requests.
  Two ways to keep the refresh token out of the renderer:
  1. the socket in an extension context (the service worker or an offscreen document), if a
     ruleset can rewrite a request the extension itself makes -- an earlier observation in
     `content.js` (conditions not recorded) says the worker's own socket kept its Origin (M1);
  2. the socket stays in the content script and logs on with a short-lived token from
     `IAuthenticationService/GenerateAccessTokenForApp` instead of the refresh token -- whether a
     CM logon takes one, and for how long it lasts: not measured (M2).
- **What a page can get, by design**: no token, ever. A depot key and a request code (as today; the
  same key for every owner of the depot), the game list, an ownership ticket (lifetime not
  measured). XSS on bottlify.app can therefore install the account's games into bottlify.app and
  read its list; it cannot sign in, since that needs GameHub's page and the Steam app. Ops answer
  only Bottlify's pages (as today).
- **A compromised extension update** gets everything; it is limited by hardware 2FA on the
  publisher account, builds from tagged commits with the zip's hash published, and the store's
  review.

## Migration, each step shippable

0. **Measure.** M1: a CM WebSocket from the service worker or an offscreen document through a
   ruleset that sets Origin. M2: a CM logon with a `GenerateAccessTokenForApp` token. M3: the QR
   Web API from an extension page. Results with their conditions go here; a failure goes to
   `negative-results.md`.
1. **The neutral ops beside the `steam.*` ones.** GameHub answers `hello { stores }`, `account`,
   `list`, `cover`, `download`, `runData`; the launcher's Steam provider becomes a generic GameHub
   provider, and its `src/steam/` keeps only the install worker, store-neutral apart from reading
   `download`'s Steam fields. Install keeps working throughout.
2. **Sign-in in GameHub.** The sign-in page and the Web API flow; `signIn` from the page only opens
   it; the launcher's QR dialog goes; the refresh token moves to the service worker, encrypted.
3. **The CM socket out of the renderer** (per M1), or on a short-lived token (per M2).
4. **The protocol code out of core**, into GameHub's source; core's `./steam` keeps the formats and
   the install; the `steam.*` page ops are removed.

## What proves each step

- **Always**: lint, typecheck, `check:boundaries`, the bridge's unit tests, `extension.itest`
  (headless Chrome against Steam, anonymous), the launcher's tests and build, and the existing
  differential gate (the same made-up depots installed by `tools/steam-install.mjs` and by
  `installBundle` give the same files).
- **Step 1**: the launcher's library and Settings run against a fake second store answering the
  neutral ops; `download` answers what the old ops answered, for the same app (unit, with a fake
  Steam).
- **Step 2**: `extension.itest` checks no context but the service worker can read the refresh token
  (the content script's `chrome.storage.local`, the page), and that the QR challenge comes from
  GameHub's page.
- **Step 4**: a validator in `tools/` (run with the other gates) fails if core or the launcher
  imports a store-protocol module; core's `check:package` passes without them; the bridge's build
  test checks GameHub carries its own.

## For the user to decide

- If M1 and M2 both fail, the refresh token stays reachable from the content script, as today:
  accept, or stop after step 2?
- A66's last clause ("the server-side path a launcher already has stays its fallback") no longer
  holds now that the launcher's server has no store code; it needs restating.
