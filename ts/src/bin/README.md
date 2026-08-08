# `src/bin/` — the command-line entry points

One file per command, each of which does nothing but call a `main()` that lives
in the module beside it.

## Why these exist

The modules used to invoke their own `main()` behind a guard:

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(await main());
}
```

That is correct when Node loads each module as its own file. It is **wrong the
moment the code is bundled**: esbuild concatenates every module into one file, so
`import.meta.url` becomes the same string for all of them and *every* guard
fires. The bundled app therefore started, ran `fontcheck`'s CLI — which is
reachable from the server through `viewmodel.ts` — saw the server's `--port`,
printed the font checker's usage text and exited 2.

It shipped a broken app past a build that had just run every suite green,
because nothing in the suites bundles anything.

## The other thing they fixed

`nameplate_thickness.py` had a `main()`; `src/thickness.ts` did not. The
paste-ready prompt's "HOW IT WILL BE CHECKED" line names that command, so the
instruction pointed at something that could not be run. `src/bin/thickness.ts`
and `thickness.ts`'s `main()` are a port of the Python's, argument for argument,
and the line now names them.

## Why a separate file works

A separate entry file has no such ambiguity. The library modules now have no
side effect at all on import, which is what makes them safe to bundle, safe to
import from a test, and safe to import from each other.
