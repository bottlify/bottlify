# GameHub

Plan, agreed 2026-10-31; built in the same change. A number not measured says so.

GameHub is the browser extension in `modules/bridge`. It extends the launcher and does not work
without it: it keeps the stores' accounts and speaks their protocols, and the page asks it for
finished answers. Bottlify -- `@bottlify/core` and the launcher -- keeps the engine and the install:
the page downloads a game's manifests and chunks from the store's CDN itself, decrypts and
decompresses them, writes the bottle into its own OPFS and applies the redistributables. Steam is
the first store.

## Who does what

- **GameHub's service worker** owns each store's account and session: the refresh token (kept in
  the extension origin's IndexedDB, which only extension contexts can open -- not the content
  script, which shares the page's origin), the QR sign-in and sign-out, and the whole Steam
  protocol: the logon, licences, PICS product info, depot keys, manifest request codes, content
  servers, ownership tickets and Valve's client files. It builds and parses every CM message.
- **The content script is a pipe.** Steam's connection managers refuse a WebSocket whose Origin is
  not theirs, and the ruleset rewrites the Origin only of the page's requests -- a socket from the
  extension's own context is refused. So the content script opens the CM socket for the worker and
  relays raw frames both ways over a long-lived runtime port, and relays the page's ops to the
  worker and its answers back. It reads nothing of either.
- **No launcher page, no session.** The socket lives with the page. Each time the launcher opens,
  the worker logs on again with the stored token; the port's traffic (the CM heartbeat every few
  seconds) keeps the worker awake while the page is open. If the worker is stopped or the port
  drops, the sockets close, and the next op reconnects and logs on again.
- **The page** asks store-neutral ops and installs with what `download` answers.

## The ops

The page asks the content script (`window.postMessage`, `{ to: 'bottlify-bridge', id, op, args }`).
A store is an argument, never an op name.

| Op | Answer |
| --- | --- |
| `hello` | `{ version, stores: [{ id, name, on }] }`: the stores GameHub has, and which the site has on |
| `account { store, fresh? }` | `{ name }`, or null for nobody signed in |
| `signIn { store }` | `{ name }`; events `challenge { url }` (shown as a QR code by the page) and `scanned` |
| `signOut { store }` | `{}` |
| `list { store, fresh? }` | `[{ id, name, bytes, exact, installable }]`: the account's games |
| `cover { store, game, kind }` | the URL of the store's picture (`header`, `capsule`, `hero`), which GameHub's rules open to the page |
| `download { store, game }` | what an install needs; Steam's: `{ name, launch, installscript, art, servers, depots: [{ depot, gid, key, code, shared }] }`, the redistributables' depots asked under the app that owns them |
| `runData { store, game }` | what a run hands the engine's emulation of the store's client; Steam's: `{ win32: { steam: { steamId, accountName, apps, ownershipTickets, clientFiles, appId } } }` |
| `cancel { target }` | aborts a request by its id |

A request code lasts minutes (not measured how many): a resumed install asks `download` again.

## What moved where

| Code | Now in |
| --- | --- |
| CM connection and messages, QR sign-in, logon, licences, product info, ownership tickets (`connection.js`, `messages.js`, `auth.js`, `session.js`) | GameHub, `src/stores/steam/` |
| Depot keys, manifest request codes, content servers (`keys.js`) | GameHub |
| Which depots an install takes, the redistributables' depots, the launch option, art addresses, what a page is shown of an app (`apps.js`) | GameHub |
| Valve's client files (`client.js`) | GameHub |
| The launcher's Steam provider and plan building | GameHub (`store.js`); the launcher has one provider per store `hello` lists |
| Manifest parsing, chunk fetch and decode, AES, LZMA, zstd, protobuf decoding (`depot.js`, `lzma.js`, `zstd.js`, `protobuf.js`) | core |
| The install, the in-place bottle writer, redistributables, installscript (`install.js`, `bundle-in-place.js`, `redist.js`, `keyvalues.js`) | core |
| The QR picture (`qr.js`) | core |
| The emulated Steam client (`layers/win32/steamclient`) | core, fed `runData` |

GameHub's build copies the core modules it reads (`protobuf.js`, `keyvalues.js`) beside its own,
one source. `tools/steam-install.mjs` stays a node tool and takes the protocol from GameHub's
source. `tools/check-store-protocol.mjs` fails a change that puts store-protocol code back into
core or the launcher.

## The accepted model

- The refresh token is read only by the worker. It leaves the worker only inside a logon frame,
  which crosses the content script's isolated world on its way to the socket; scripts of the page
  never see a frame.
- The page gets no token. It gets depot keys and request codes (the same key for every owner of a
  depot), the game list, and an ownership ticket at a run (lifetime not measured). Script injected
  into bottlify.app could therefore install the account's games into bottlify.app and read its
  list; a sign-in needs the person and the Steam app.
- A compromised extension update gets everything. It is limited by hardware 2FA on the publisher
  account, builds from tagged commits with the zip's hash published, and the store's review.
- Without GameHub there are no stores (A66).

## Tests

- **The pipe**: frames relayed both ways and sockets closed with the port (`pipe.test.js`); the
  worker's relayed socket and its reconnect after the port drops (`relay.test.js`, `hub.test.js`);
  every message that crosses the port and every answer the page gets, read for the refresh token:
  found only inside ClientLogon frames (`hub.test.js`).
- **The store**: the neutral ops over a fake Steam (`store.test.js`).
- **Live**: `extension.itest.js`, headless Chrome with the dev build against Steam, anonymous.
- **The gates**: the install differential (`tools/steam-install.test.js`), the bundle build test,
  `check:boundaries` with `tools/check-store-protocol.mjs`.
