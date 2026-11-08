# The bottle server's routes

The server is private: an upload belongs to whoever owns the bottle, publishing it is a separate
act, and a server with no token refuses to start. Every route is authenticated with the token:

- `/bottles/<id>/blocks?at=<offset>`: packed block bytes, in order. A part out of order is refused
  rather than leave a hole the digest never saw.
- `/bottles/<id>/finish`: the header and the index, which do not exist until the last block has
  been packed and so cannot travel in the stream. The server writes them where they belong,
  computes the block region's digest, and writes `manifest.json` beside `bundle.btl`.
- `/bottles/<id>/manifest`: changes a bottle's settings in its `manifest.json` without sending it
  again: `title`, `description`, `source` (a web address the bottle's files came from, or
  nothing), `year` (when the program came out), `rightsHolder` (who owns it now), `version`,
  `labels` (`demo`, `benchmark`, `test`), `kind` (`game`, `application`), `windows`, `graphics`.
  Any other field is refused; the entry and the bundle record belong to the upload.
- `/bottles/<id>/art/cover`, `/bottles/<id>/art/wallpaper`: a picture (PNG, JPEG, WebP or GIF, by
  its `Content-Type`) kept beside the manifest under a name taken from its bytes and named there
  as `./<name>`: `coverLarge` and `coverSmall` for the cover, `wallpaper` for the stage. A JPEG
  cover is kept only as two smaller JPEGs, fitted into 800×1200 for the details panel and 400×600
  for the card; a cover in another format is kept as given, for both. The picture it replaces is
  removed.
- `DELETE /bottles/<id>`: removes the bottle whole, for everyone: its bundle, its manifest and its
  pictures. Refused while it is still being uploaded.

`publish()`'s own `manifest` option passes straight through to that file, field for field, so a
program's own launch arguments travel with it. `commandLine` is the arguments the program is
started with, appended after the quoted image path (the `commandLine` option in
[`docs/core/api.md`](../core/api.md)): for example
`"commandLine": "+set s_realTimeDecoding 0"`, a setting a program reads only from its command
line, set there instead of by editing the bundle.

`windows`, optional, is the Windows the bottle runs under: one of `win2000`, `winxp`, `win7` and
`win10` (the `windows` option in [`docs/core/api.md`](../core/api.md)); absent means the
engine's default, XP with its third service pack. Whatever starts the bottle passes it to
`createApp`, and the install itself runs under the same one (`prefixOptions(media, { windows })`),
since an installer acts on the Windows it finds. `publish()` refuses any other value before
sending anything, naming the four, as the engine would refuse it when the bottle first started.
