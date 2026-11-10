"""Independently verify published digests and usage from raw provider responses.

No exporter/product module is imported. Legacy DSH events retain their original
accounting convention. Direct HTTP duplicates are cross-checks, never extra calls.
"""
from collections import Counter
from decimal import Decimal
from hashlib import sha256
from pathlib import Path
import argparse
import gzip
import json
import math
import re
import sys

sys.dont_write_bytecode = True
KEYS = ("inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens")


def serialize(value):
    """The stable publication encoding is the manifest's digest contract."""
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def check(condition, message):
    """Unlike assert, accounting checks remain active under python -O."""
    if not condition:
        raise ValueError(message)


def integer(value, label):
    check(type(value) is int and value >= 0, label + ": missing/invalid token integer")
    return value


def close_number(value, expected, label, terms=1):
    """Allow only the original binary-float calculation's rounding error."""
    check(type(value) in (int, float) and math.isfinite(value), label + ": missing/invalid number")
    expected = float(expected)
    tolerance = 8 * max(1, terms) * max(math.ulp(float(value)), math.ulp(expected))
    check(abs(value - expected) <= tolerance, label + ": numerical mismatch")


def raw_usage(response, label):
    """Only complete returned provider usage is known; absence is not zero."""
    raw = response.get("usage") if response else None
    if not raw:
        return None
    check(isinstance(raw, dict), label + ": malformed provider usage")
    prompt, output, total = (raw.get(k) for k in ("prompt_tokens", "completion_tokens", "total_tokens"))
    nested = raw.get("prompt_tokens_details", {}).get("cached_tokens")
    hit = raw.get("prompt_cache_hit_tokens", nested)
    miss = raw.get("prompt_cache_miss_tokens")
    if miss is None and type(prompt) is int and type(hit) is int:
        miss = prompt - hit
    if any(v is None for v in (prompt, output, total, hit, miss)):
        return None
    for value in (prompt, output, total, hit, miss):
        integer(value, label)
    if nested is not None:
        check(integer(nested, label) == hit, label + ": cache aliases disagree")
    check(prompt == hit + miss and total == prompt + output, label + ": provider totals do not sum")
    return dict(inputTokens=miss, cacheReadTokens=hit, cacheWriteTokens=0,
                outputTokens=output, totalTokens=total, inputWithCacheTokens=prompt)


def estimate(amount, rates, label):
    """Use archived rates for a reproducible estimate, not an invoice claim."""
    values = []
    for key in ("cacheHit", "cacheMiss", "output"):
        value = rates.get(key)
        check(type(value) in (int, float) and math.isfinite(value) and value >= 0, label + ": invalid price")
        values.append(Decimal(str(value)))
    return sum(Decimal(amount[key]) * rate for key, rate in
               zip(("cacheReadTokens", "inputTokens", "outputTokens"), values)) / Decimal(1000000)


def normalized(recorded, amount, label, cost=None, causal=False):
    """Validate a copied normalization without counting it again."""
    if amount is None:
        check(recorded is None, label + ": claimed usage has no complete raw response usage")
        return
    check(isinstance(recorded, dict), label + ": normalized usage is missing")
    mapping = ({"uncachedInputTokens": "inputTokens", "cacheReadTokens": "cacheReadTokens",
                "outputTokens": "outputTokens", "totalTokens": "totalTokens", "promptTokens": "inputWithCacheTokens"}
               if causal else {k: k for k in (*KEYS, "inputWithCacheTokens")})
    for key, raw in mapping.items():
        check(integer(recorded.get(key), label + "/" + key) == amount[raw], label + ": normalized " + key + " differs")
    if causal and amount["inputWithCacheTokens"]:
        close_number(recorded.get("cacheHitRate"), amount["cacheReadTokens"] / amount["inputWithCacheTokens"], label + "/cache ratio")
    if cost is not None:
        close_number(recorded.get("estimatedUSD"), cost, label + "/cost")


def count(group, amount):
    """The sole accumulation point for each canonical response/attempt."""
    if amount is None:
        group.update(attemptEvents=1, messagesWithoutUsage=1)
    else:
        group["responses"] += 1
        for key in KEYS:
            group[key] += amount[key]


def identity(response, label, seen):
    if response is None:
        return
    key = response.get("id")
    check(isinstance(key, str) and bool(key), label + ": missing response ID")
    check(key not in seen, label + ": duplicate provider response ID; first at " + seen.get(key, ""))
    seen[key] = label


def legacy_usage(artifacts):
    """Preserve historical DSH event semantics without importing the exporter."""
    row = artifacts.get("events.jsonl", {})
    events = row.get("data", []) if row.get("kind") == "jsonl" else []
    groups = {}
    for event in events:
        group = groups.setdefault(event.get("group", "unknown"), Counter())
        if event.get("type") == "assistant/attempt":
            group["attemptEvents"] += 1
        if event.get("type") == "assistant/message":
            amount = event["data"].get("usage")
            if amount is None:
                group["messagesWithoutUsage"] += 1
            else:
                group["responses"] += 1
                for key in KEYS:
                    group[key] += amount.get(key, 0)
    return {key: dict(value) for key, value in groups.items()}


def causal_usage(artifacts, label, seen):
    """Canonical evidence is attempts[].response.usage, not providerRaw copies."""
    calls = {p: a["data"] for p, a in artifacts.items() if p.startswith("calls/") and p.endswith(".json")}
    plan = artifacts.get("plan.json", {}).get("data", {})
    followup = plan.get("spec") == "building-loop-targeted-causal-followup/1"
    judgment_kind = "targeted-followup-judgment" if followup else "matrix-judgment"
    allowed_kinds = {judgment_kind} if followup else {judgment_kind, "real-neutral-history-preparation"}
    if followup:
        validate_followup_plan(artifacts, plan, label)
    group, totals, cost = Counter(), Counter(), Decimal(0)
    ids, matrix_ids = set(), set()
    for path, call in calls.items():
        here, key = label + "/" + path, call.get("id")
        check(isinstance(key, str) and key not in ids and path == "calls/" + key + ".json", here + ": missing/duplicate call ID")
        ids.add(key)
        check(isinstance(call.get("request"), dict), here + ": missing request")
        kind = call.get("metadata", {}).get("kind")
        check(kind in allowed_kinds, here + ": unknown causal call kind")
        if kind == judgment_kind:
            matrix_ids.add(key)
        if followup:
            validate_followup_call(artifacts, plan, call, here)
        attempts, latest = call.get("attempts"), None
        check(isinstance(attempts, list) and bool(attempts), here + ": no attempts")
        for position, attempt in enumerate(attempts, 1):
            where = here + "/attempt-" + str(position)
            check(attempt.get("attempt") == position, where + ": missing/duplicate attempt")
            response, saved = attempt.get("response"), attempt.get("usage")
            identity(response, where, seen)
            amount, item_cost = raw_usage(response, where), None
            if amount is not None:
                check(isinstance(saved, dict) and saved.get("providerRaw") == response["usage"], where + ": providerRaw copy differs")
                item_cost = estimate(amount, saved.get("pricing", {}).get("ratesUSDPerMillion", {}), where)
                cost += item_cost
                totals.update(amount)
            else:
                check(response is not None or attempt.get("errorType"), where + ": missing response/failure record")
            normalized(saved, amount, where, item_cost, causal=True)
            count(group, amount)
            totals["attempts"] += 1
            if response is not None:
                latest = attempt
        check(call.get("response") == (latest or {}).get("response") and call.get("usage") == (latest or {}).get("usage"),
              here + ": top-level response/usage differs from last attempt")
    summary = artifacts.get("summary.json", {}).get("data")
    if summary:
        check(summary["allCalls"] == len(calls) and summary["matrixRows"] == len(matrix_ids)
              and summary["preparationCalls"] == len(calls) - len(matrix_ids), label + ": summary call counts differ")
        rows = summary.get("records", [])
        check(len(rows) == len(matrix_ids) and {r.get("id") for r in rows} == matrix_ids, label + ": missing/duplicate summary rows")
        for row in rows:
            call = calls["calls/" + row["id"] + ".json"]
            check(row.get("usage") == call.get("usage") and row.get("attempts") == len(call["attempts"]), label + ": summary call differs")
            if followup:
                check(row.get("cell") in plan["matrix"] and all(call["metadata"].get(k) == v for k, v in row["cell"].items()),
                      label + ": follow-up summary cell differs")
        saved = summary["totals"]
        for key, raw in {"attempts": "attempts", "totalTokens": "totalTokens", "promptTokens": "inputWithCacheTokens",
                         "outputTokens": "outputTokens", "cacheReadTokens": "cacheReadTokens", "uncachedInputTokens": "inputTokens"}.items():
            check(saved.get(key, 0) == totals[raw], label + ": summary total " + key + " differs")
        check(saved.get("attemptsWithoutReturnedUsage", 0) == group["messagesWithoutUsage"], label + ": unknown usage count differs")
        close_number(saved.get("estimatedUSD"), cost, label + "/summary cost", totals["attempts"])
    finished = artifacts.get("finished.json", {}).get("data")
    if finished:
        check(finished.get("allCalls") == len(calls) and finished.get("rows") == len(matrix_ids), label + ": finished count differs")
        if followup:
            check(len(matrix_ids) == plan["plannedCalls"] and len(calls) - len(matrix_ids) == plan["preparationCalls"],
                  label + ": completed follow-up lacks planned calls")
            cells = {(c["metadata"]["model"], c["metadata"]["supply"], c["metadata"]["repeat"]) for c in calls.values()}
            check(len(cells) == plan["plannedCalls"], label + ": missing/duplicate follow-up matrix cell")
            check(totals["attempts"] <= plan["maximumHTTPAttempts"], label + ": follow-up exceeded sealed attempt budget")
            check(finished.get("status") == "fixed-matrix-completed", label + ": unknown follow-up completion status")
        else:
            check(len(matrix_ids) == plan.get("judgments") and len(calls) - len(matrix_ids) == plan.get("neutralPreparationCalls"),
                  label + ": completed matrix lacks planned calls")
    report = dict(kind="causal-http", calls=len(calls), attempts=totals["attempts"], knownResponses=group["responses"],
                  unknownUsageAttempts=group["messagesWithoutUsage"], estimatedUSD=str(cost), completed=bool(finished))
    if followup:
        report.update(schema=plan["spec"], plannedDocumentJudgments=plan["plannedDocumentJudgments"],
                      submittedDocumentJudgments=len(calls) * 4,
                      judgmentBoundary="Submitted complete inputs, not successful semantic judgments; truncation/format failures retain their returned usage.")
    return {"controlled-http": dict(group)}, report


def validate_followup_plan(artifacts, plan, label):
    """The separately sealed 2 x 2 x 2 follow-up is not the legacy 24-row pilot.

    Keep its 8 request / 32 document contract explicit. A new experiment shape
    needs another schema rather than weakening the old planned-call checks.
    """
    check(plan.get("plannedCalls") == 8 and plan.get("plannedDocumentJudgments") == 32
          and plan.get("preparationCalls") == 0 and plan.get("maximumHTTPAttempts") == 16
          and plan.get("maxNetworkRetriesPerRequest") == 1, label + ": invalid sealed follow-up counts")
    matrix = plan.get("matrix")
    material = artifacts.get("materials.json", {}).get("data", {})
    drafts = material.get("drafts", {})
    expected = artifacts.get("sealed-expectations.json", {}).get("data", {})
    check(isinstance(drafts, dict) and len(drafts) == 4 and set(expected.get("expected", {})) == set(drafts)
          and expected.get("notSentToModels") is True, label + ": missing follow-up drafts/isolated expectations")
    check(isinstance(matrix, list) and len(matrix) == 8, label + ": invalid follow-up matrix size")
    cells = set()
    for row in matrix:
        check(isinstance(row, dict) and isinstance(row.get("model"), str)
              and row.get("supply") in {"neutral-host", "prior-verdict-leak"}
              and type(row.get("repeat")) is int and row["repeat"] in (1, 2), label + ": invalid follow-up matrix cell")
        order = row.get("documentOrder")
        check(isinstance(order, list) and len(order) == 4 and set(order) == set(drafts), label + ": invalid follow-up document order")
        cells.add((row["model"], row["supply"], row["repeat"]))
    check(len(cells) == 8 and len({row[0] for row in cells}) == 2, label + ": missing/duplicate follow-up planned cell")
    seal = artifacts.get("seal.json", {}).get("data", {}).get("files", {})
    for name in ("plan.json", "materials.json", "sealed-expectations.json"):
        check(name in seal and artifacts.get(name, {}).get("originalSha256") == seal[name],
              label + ": follow-up original artifact does not match input seal")


def validate_followup_call(artifacts, plan, call, label):
    """Bind every counted call to its unique fixed cell and four complete inputs."""
    metadata, payload = call["metadata"], call["request"]
    matches = [row for row in plan["matrix"] if all(metadata.get(k) == v for k, v in row.items())]
    check(len(matches) == 1 and payload.get("model") == metadata.get("model"), label + ": follow-up call is outside sealed matrix")
    check(sha256(serialize(payload)).hexdigest() == call.get("requestSha256"), label + ": follow-up request digest differs")
    messages = payload.get("messages", [])
    material = artifacts["materials.json"]["data"]
    check(len(messages) == 2 and messages[0] == {"role": "system", "content": material["system"]}
          and messages[1].get("role") == "user", label + ": follow-up message contract differs")
    try:
        body = json.loads(messages[1]["content"])
    except (ValueError, KeyError, TypeError) as error:
        raise ValueError(label + ": malformed follow-up input JSON") from error
    order = matches[0]["documentOrder"]
    documents = [{"id": key, "content": material["drafts"][key], "requiredLines": material["requiredLines"][key]} for key in order]
    check(body.get("documents") == documents, label + ": follow-up missing/changed submitted document")
    check(body.get("sources") == [{"file": s["file"], "content": s["content"]} for s in material["sources"]],
          label + ": follow-up source inputs differ")
    check(isinstance(body.get("task"), str)
          and (material["leakExcerpt"] in body["task"]) == (metadata["supply"] == "prior-verdict-leak"),
          label + ": follow-up supply treatment differs")
    check(len(call.get("attempts", [])) <= 2, label + ": follow-up exceeded per-call attempt budget")


def threshold_usage(artifacts, label, seen):
    """Reconcile raw response -> unit -> event -> summary once per request."""
    tables = {kind: {} for kind in ("request", "response", "unit")}
    for path, artifact in artifacts.items():
        match = re.fullmatch(r"(?:requests/)?(request|response|unit)-(\d+)\.json", path)
        if match:
            table, index = tables[match[1]], int(match[2])
            check(index not in table, label + ": duplicate " + match[1] + " number")
            table[index] = (path, artifact["data"])
    requests, responses, units = (tables[k] for k in ("request", "response", "unit"))
    check(set(responses) <= set(units) <= set(requests), label + ": orphan response/unit or missing request")
    check(set(units) == set(range(1, len(units) + 1)), label + ": missing unit in sequence")
    prices = artifacts["run.json"]["data"]["prices"]
    rates = {k: prices.get(v) for k, v in (("cacheHit", "cacheHitPerMillionUSD"),
             ("cacheMiss", "cacheMissPerMillionUSD"), ("output", "outputPerMillionUSD"))}
    events = artifacts.get("events.jsonl", {})
    check(events.get("kind") == "jsonl", label + ": missing/unparseable events")
    groups, by_unit = {}, {}
    for event in events["data"]:
        group = event.get("group", "unknown")
        groups.setdefault(group, Counter())
        if event.get("type") == "unit-recorded":
            unit = event["data"].get("unit")
            check(type(unit) is int and unit not in by_unit, label + ": duplicate/invalid unit event")
            by_unit[unit] = (group, event["data"])
        check(event.get("type") not in ("assistant/message", "assistant/attempt"), label + ": mixed accounting channels")
    check(set(by_unit) == set(units), label + ": missing/extra unit-recorded event")
    totals, cost, unknown, peak = Counter(), Decimal(0), 0, 0
    for index, (path, unit) in units.items():
        here = label + "/" + path
        request_path, request = requests[index]
        check(unit.get("unit") == index and unit.get("requestFile") == request_path, here + ": request identity differs")
        check(isinstance(request.get("payload"), dict) and request.get("sessionIndex") == unit.get("sessionIndex"),
              here + ": missing/mismatched request payload or session")
        response = responses.get(index, (None, None))[1]
        identity(response, here, seen)
        amount = raw_usage(response, here)
        if response is None:
            check(bool(unit.get("error")) and unit.get("status") != 200, here + ": successful unit has no raw response")
        item_cost = estimate(amount, rates, here) if amount is not None else None
        normalized(unit.get("usage"), amount, here, item_cost)
        group, event = by_unit[index]
        normalized(event.get("knownUsage"), amount, here + "/event", item_cost)
        check(event.get("error") == unit.get("error"), here + ": event failure status differs")
        count(groups[group], amount)
        if amount is None:
            unknown += 1
        else:
            totals.update(amount)
            cost += item_cost
            peak = max(peak, amount["inputWithCacheTokens"])
    summary = artifacts.get("summary.json", {}).get("data")
    check(summary is not None or not units, label + ": recorded units have no summary")
    if summary:
        check(summary["completedUnits"] == len(units) and summary["unknownUsageRequests"] == unknown, label + ": summary counts differ")
        check(summary["failedRequests"] == sum("error" in row for _, row in units.values()), label + ": failure count differs")
        check(summary.get("prices") == prices, label + ": summary price basis differs")
        for key in (*KEYS, "inputWithCacheTokens"):
            check(summary["usage"].get(key) == totals[key], label + ": summary " + key + " differs")
        close_number(summary["usage"].get("estimatedUSD"), cost, label + "/summary cost", len(units))
        check(summary.get("peakInputTokens") == peak, label + ": peak input differs")
        if totals["inputWithCacheTokens"]:
            close_number(summary.get("inputCacheHitRate"), totals["cacheReadTokens"] / totals["inputWithCacheTokens"], label + "/cache ratio")
        else:
            check(summary.get("inputCacheHitRate") is None, label + ": empty prompt cache ratio should be unknown")
        if summary.get("qualifiedUnits"):
            close_number(summary.get("estimatedUSDPerQualifiedUnit"), cost / summary["qualifiedUnits"], label + "/qualified cost", len(units))
    pending = sorted(set(requests) - set(units))
    check(not pending or pending == [len(units) + 1], label + ": multiple/gapped unrecorded requests")
    finished = artifacts.get("finished.json", {}).get("data")
    if finished:
        check(not pending and finished.get("units") == len(units) == summary.get("plannedUnits"), label + ": completed workload lacks units")
    report = dict(kind="threshold-http", calls=len(units), knownResponses=len(units) - unknown, unknownUsageAttempts=unknown,
                  pendingRequests=pending, estimatedUSD=str(cost), completed=bool(finished),
                  costBasis={k: prices.get(k) for k in ("source", "period", "meaning")})
    return {key: dict(value) for key, value in groups.items()}, report


def verify(root):
    """Reject modified bundles, duplicate responses and unexplained totals."""
    root = root.resolve(strict=True)
    index = json.loads((root / "index.json").read_text(encoding="utf-8"))
    tokens, responses, paths, diagnostics = 0, {}, set(), []
    entries = [*index["runs"], index["smoke"], *([index["harnesses"]] if "harnesses" in index else [])]
    for entry in entries:
        check(entry["path"] not in paths, "Duplicate manifest entry: " + entry["path"])
        paths.add(entry["path"])
        path = (root / entry["path"]).resolve(strict=True)
        check(path.is_relative_to(root), "Manifest path escapes the experiment data")
        data = path.read_bytes()
        check(sha256(data).hexdigest() == entry["sha256"], "Bundle digest mismatch: " + entry["path"])
        if entry.get("encoding") == "gzip":
            data = gzip.decompress(data)
            check(len(data) == entry.get("contentBytes") and sha256(data).hexdigest() == entry.get("contentSha256"),
                  "Uncompressed bundle digest mismatch: " + entry["path"])
        else:
            check(entry.get("encoding") is None, "Unsupported bundle encoding: " + entry["path"])
        bundle, artifacts = json.loads(data), {}
        for artifact in bundle["artifacts"]:
            check(artifact["path"] not in artifacts, entry["path"] + ": duplicate artifact path")
            artifacts[artifact["path"]] = artifact
            check(sha256(serialize(artifact["data"])).hexdigest() == artifact["publishedSha256"],
                  entry["path"] + ": artifact digest mismatch: " + artifact["path"])
        if "recordedUsage" not in bundle:
            continue
        if bundle.get("family") == "building-loop-causal-audit":
            actual, report = causal_usage(artifacts, entry["path"], responses)
            diagnostics.append(dict(path=entry["path"], **report))
        elif bundle.get("family") == "building-loop-threshold-audit":
            actual, report = threshold_usage(artifacts, entry["path"], responses)
            diagnostics.append(dict(path=entry["path"], **report))
        else:
            actual = legacy_usage(artifacts)
        check(actual == bundle["recordedUsage"] == entry["recordedUsage"], entry["path"] + ": recordedUsage differs from independent raw recomputation")
        tokens += sum(row.get("totalTokens", 0) for row in actual.values())
    report = dict(verifiedRuns=len(index["runs"]), standaloneArtifacts=index["smoke"]["artifacts"],
                  recordedTotalTokens=tokens, distinctDirectResponses=len(responses), direct=diagnostics,
                  limits=["Completeness is relative to preserved requests/events; unlogged network calls cannot be discovered.",
                          "Unknown usage and pending requests are not estimated as zero.",
                          "Costs use archived rates; this is not a provider bill or live price verification.",
                          "Historical DSH totals retain their original event convention; no archive is rewritten.",
                          "Accounting verification does not establish semantic correctness of model judgments."])
    print("Verified", len(index["runs"]), "runs and", index["smoke"]["artifacts"], "standalone artifacts; recorded total tokens",
          tokens, "; distinct direct responses", len(responses))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, nargs="?", default=Path(__file__).resolve().parent / "data")
    parser.add_argument("--report", type=Path, help="Optional validation result outside archived data")
    args = parser.parse_args()
    result = verify(args.root)
    if args.report:
        check(not args.report.resolve().is_relative_to(args.root.resolve()), "Validation report must be outside archived data")
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_bytes(serialize(result))
