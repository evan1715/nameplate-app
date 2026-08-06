# refs_precanonical — the baseline BEFORE the ring set was canonicalised

These files are **not** a stale copy of `../refs/` and must not be "refreshed".
They are the Python's captured output as it stood at commit `2e07c61`, before
`nameplate_thickness.py` gained `_canonical_rings`.

## Why they are here

`tests/thickness.ts` proves the TypeScript reproduces `../refs/`. But `../refs/`
was re-captured from a Python that had just been modified, so on its own that
pairing is circular: both implementations could drift together and the suite would
stay green.

`tests/canonicalisation.ts` compares this directory against `../refs/` to pin
exactly what that one Python change did — and, more importantly, what it did not
do. The thinnest reading on every case is asserted to be bit-for-bit identical;
the moved numbers are pinned to the audited values; and every changed line in
every report must be one of a short list of allowed kinds, so a moved heading,
units legend, prose line or target verdict would fail.

## Why this commit and not the obvious one

The apparently obvious choice was `2541163`, the commit that first froze the
baseline. It is the wrong one. At that point `capture_baseline.py` called
`survey(doc, target)` without `font=`, so letters went unattributed and the
recorded numbers came from a different run than the recorded report text
(`letters_known` was `false` while the report named every letter). That was fixed
separately in `2e07c61`. Pinning against `2541163` would have charged
canonicalisation with that fix as well and made the audit meaningless.

## If canonicalisation is ever revisited

Do not edit these files. Re-audit instead: change the Python, re-capture
`../refs/`, then update the pinned numbers in `tests/canonicalisation.ts`
deliberately, with the new delta stated in `../../README.md`. The point of this
directory is that such a change cannot happen quietly.

## Scope

Only the files the canonicalisation actually moved are kept — the five thickness
reports, `thickness_numbers.json`, the ADAM_t prompt (kept precisely because it is
expected to be *unchanged*, and something has to hold it to that), and the four
`brief_*` refs that quote thickness numbers. Everything else in `../refs/` was
byte-identical across the change, so a copy here would carry no information.
