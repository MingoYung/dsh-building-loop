# Independent engineering comparison

The native runner records functional acceptance, workspace/session handover, phase, elapsed time and usage. The blinded engineering review examines the last frozen bytes by the same rubric for standard, standard with checklist, and Building-loop. Keep those conclusions independent until the code and document judgments have been pinned.

## Intake and reveal

1. The runner operator waits for both exact repetitions and verifies termination using the existing process cleanup script. They run `python -B blind-intake.py intake hard-ab <run1> <run2>` or `reservation-ab`. They give the grader only the masked intake digest, staged suite folder and count. The source SHA-256 and installed runtime are checked before copying. Run IDs, modes, timing, terminal reasons, score, usage and original runner journals stay out of the grader’s packet.
2. Run `blind-public-controls.py` under WSL bubblewrap on the masked source directories. The script verifies fixture pins and candidate digests and uses public examples and independent small contrasts. It never reads the private seeds. Preserve known false examples, positive references and visible failure mechanisms separately from the scored online and postfreeze cases. The two reservation stress cases reuse public declared sizes and calibrated evaluator time limits.
3. Read all four source files per masked cell and register code judgments for every obligation below. Save `engineering-code-judgments.json` with `intakeSha256` and a `cells` map. Each cell records each obligation’s status, supporting source location or public replay, and any causal limits. Run `blind-intake.py commit-code` before opening the docs directory.
4. Open the separate `docs/manifest.json` and review every authored artifact or mark its absence. Save `engineering-doc-judgments.json` with `intakeSha256`, `codeJudgmentsSha256`, `docsManifestSha256`, and a `cells` map. Then run `blind-intake.py commit` and only afterward allow `blind-intake.py reveal`. Filenames, comments or authoring conventions can suggest modes, so describe this as mode-label masking. Explicit Building-loop artifacts may reveal likely provenance during the document pass. Code findings remain pinned from the earlier pass.
5. Join the revealed mapping, native and postfreeze scores, public runtime cases, reviewer observations and same-directory evidence. Put completion and actual quality differences first. Report repeat-to-repeat variance, missed or timed-out parts, missing docs, native vs observed conversation completion, and functional restoration if final code still differs from the old behavior. Report elapsed time, Token and cache separately.

## Rubric

Use `supported`, `defect`, `missing`, `unresolved`, `not-applicable` for a specific obligation. Support means a code witness plus any relevant actual behavior. For absence, distinguish a missing implementation/file from an omission in comments or in the docs. Use `symptom` for a public failed response, `causal` only for a specific branch/representation plus the counterexample and a control that excludes likely alternatives. Keep no-observation facts separate. Do not combine independent dimensions into one arbitrary total.

| Stage | Frozen behavior and engineering obligations |
| --- | --- |
| G3 | `entry boundary` one JSON in/out, normal exit, delegates business. `cross-node closure` follows full graph through unapplied nodes and excludes only applied ancestors. `state isolation` no dependency/state/identity sharing between items. `atomic order` first actual item failure, no partial output. `maintainability` appropriate graph/order responsibility and clear reuse of G2 behavior. |
| G4 | All still applicable G3 obligations. `identity` same ID and structurally equal request is replay, object key order irrelevant, list order/type preserved, different IDs independent. `quota order` only accepted unique results counted, first domain failure wins, limit applied after all rows, legacy single rollback still uncapped. `maintainability` API/representation, shared logic, no mirrored unrelated guards. |
| H1 | `entry boundary` decode/forward/output, separate transport and ledger invalid-request. `owner boundaries` events identity and shape, windows interval rules, ledger ordering and business. `atomic order` local tentative changes, early business error and empty outputs on error. `replay` exact replay skips present-state checks. `scale` indexes/algorithm avoid per-event full scan on 24k reservations and 4,096 events, with actual elapsed vs threshold. |
| H2 | All still applicable H1 obligations. `closed windows` left-closed right-open, resource scoped, overlaps/out-of-order allowed and indexed, 24k retained. `revision` proper precedence, remove self before overlap, atomic replace, preserve replay output shape. `maintainability` business module ownership, rollback of tentative index updates, consistent reserve/transfer paths. |

### Necessary comments

- Look at decisions where a reasonable maintainer could change valid behavior without realizing it. Public API, data representation, cross-module transfer, temporal constraints, ordering, deduplication and failure behavior qualify. Direct assignment and obvious expressions do not require comments.
- A useful docstring or adjacent comment states why, what must remain true, and where the contract applies. A comment contradicting the current implementation or ordering is a defect even if tests pass. Record comment and code lines. If implementation is absent, mark the related comment obligation inapplicable and separately mark implementation missing.
- Compare architectural cohesion and coupling using real call/import/ownership locations and changed invariants. A static count or full test score is insufficient to assess accuracy, functional breadth or simplicity.

### Authored docs and trace

- Read visible prose and notes against current source and owner clauses. Distinguish present implementation, requirement, intended future design and a black-box verification example. Do not give credit for a plausible phrase that contradicts actual code. Use physical file/line/hash evidence.
- Planning behavior needs an actual phase/event or a retained document. File prose at freeze can show final clarity and handoff usefulness. It cannot prove it was written before implementation. Where all modes lack equivalent captured plan content, mark relative planning process unobserved.
- Read prior-stage scope before crediting a continuation. Check current phase/milestone and three-level navigation where artifacts exist. A replay artifact proves only registered outcomes. Record carried state and unresolved matters if visible. Grade executable requirements the same across modes; Building-loop’s signed receipts and workflow closure are supplemental mechanism results.

No live browser, source tree edits, new model calls or private evaluator material are needed for this review.
