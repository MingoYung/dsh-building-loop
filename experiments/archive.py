"""Publish isolated building-loop test artifacts and recompute their recorded usage.

The export keeps failed and interrupted trials. Personal runtime stores stay at
their source location. Each exported artifact records its before/after digest so
path normalization and credential redaction are visible in the provenance.
"""
from collections import Counter
from hashlib import sha256
from pathlib import Path
import argparse
import json
import os
import re


def serialize(value):
    """Use stable UTF-8 JSON so an unchanged export has the same digest."""
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def sanitizer(root):
    """Return a recursive scrubber without ever printing launch credentials."""
    secrets = [v for k, v in os.environ.items()
               if re.search(r"API_KEY|TOKEN|PASSWORD|SECRET", k, re.I) and len(v) >= 12]
    replacements = []
    for source, label in [(str(root), "$WORKSPACE"), (str(Path.home()), "$USERPROFILE")]:
        for spelling in {source, source.replace("\\", "/"), source.replace("\\", "\\\\")}:
            replacements.append((spelling, label))

    def clean(value):
        if isinstance(value, list):
            return [clean(v) for v in value]
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items()}
        if not isinstance(value, str):
            return value
        for secret in secrets:
            value = value.replace(secret, "[REDACTED_CREDENTIAL]")
        value = re.sub(r"\bsk-[A-Za-z0-9_-]{16,}\b", "[REDACTED_CREDENTIAL]", value)
        value = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9_.-]{20,}", r"\1[REDACTED_CREDENTIAL]", value)
        for source, label in replacements:
            value = value.replace(source, label)
        return value

    return clean


def artifact(file, relative, clean):
    """Preserve parseable events as data and preserve malformed tails as text."""
    raw = file.read_bytes()
    content = raw.decode("utf-8-sig")
    kind = "text"
    value = content
    try:
        if file.suffix == ".jsonl":
            value = [json.loads(line) for line in content.splitlines() if line.strip()]
            kind = "jsonl"
        elif file.suffix == ".json":
            value = json.loads(content)
            kind = "json"
    except json.JSONDecodeError:
        kind = "unparsed-text"
    value = clean(value)
    return {"path": relative, "kind": kind, "originalSha256": sha256(raw).hexdigest(),
            "publishedSha256": sha256(serialize(value)).hexdigest(), "data": value}


def usage(artifacts):
    """Sum every recorded model response, including responses in failed runs."""
    events = next((a["data"] for a in artifacts if a["path"] == "events.jsonl" and a["kind"] == "jsonl"), [])
    groups = {}
    for event in events:
        group = groups.setdefault(event.get("group", "unknown"), Counter())
        if event.get("type") == "assistant/attempt":
            group["attemptEvents"] += 1
        if event.get("type") != "assistant/message":
            continue
        data = event["data"]
        amount = data.get("usage")
        if amount is None:
            group["messagesWithoutUsage"] += 1
            continue
        group["responses"] += 1
        for key in ("inputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens"):
            group[key] += amount.get(key, 0)
    return {name: dict(values) for name, values in groups.items()}


def collect(run, clean):
    """Take experiment outputs and isolated fixtures, plus the exact runtime and recorder."""
    files = [p for p in run.iterdir() if p.is_file()]
    for group in ("reuse", "fresh"):
        directory = run / group
        if directory.is_dir():
            files.extend(p for p in directory.rglob("*") if p.is_file()
                         and p.suffix in {".json", ".jsonl", ".md", ".csv", ".txt"})
    runtime = run / "isolated-home/profiles/web/node_modules/dsh-building-loop"
    for name in ("package.json", "cordis.patch.yml", "governance/index.mjs", "governance/policy.mjs",
                 "governance/preflight.mjs", "governance/evidence.mjs", "governance/ledger.mjs", "governance/goals.mjs", "governance/coverage.mjs"):
        if (runtime / name).is_file():
            files.append(runtime / name)
    for name in ("cordis.patch.yml", "witness.mjs"):
        profile = run / "isolated-home/profiles/web" / name
        if profile.is_file():
            files.append(profile)
    if run.parent.name in {"building-loop-repair-audit", "building-loop-coverage-audit"}:
        # The keyless Desktop probe loads these installed bytes, not the package copy.
        installed = run / "isolated-home/profiles/web/building-loop-governance"
        if installed.is_dir():
            files.extend(p for p in installed.iterdir() if p.is_file() and p.suffix == ".mjs")
    result = []
    for file in sorted(set(files)):
        assert file.resolve().is_relative_to(run.resolve()), "Refusing an artifact outside its isolated run"
        result.append(artifact(file, file.relative_to(run).as_posix(), clean))
    return result


def export(root, destination):
    """Export every available run and standalone smoke artifact in this workspace."""
    clean = sanitizer(root)
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {"spec": "building-loop-experiments/1", "redaction": ["workspace and user-home paths", "launch credentials"],
                "excluded": ["private runtime session stores", "dependencies", "duplicated installation payloads",
                             "full-page external source downloads"], "runs": []}
    for family in sorted((root / "outputs").glob("building-loop-*audit")):
        for run in sorted(p for p in family.iterdir() if p.is_dir()):
            artifacts = collect(run, clean)
            if not artifacts:
                continue
            ending = next((a["data"] for a in artifacts if a["path"] == "finished.json"), None)
            bundle = {"spec": "building-loop-experiment/1", "family": family.name, "run": run.name,
                      "completion": ending, "recordedUsage": usage(artifacts), "artifacts": artifacts}
            name = family.name + "/" + run.name + ".json"
            data = serialize(bundle)
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            manifest["runs"].append({"path": name, "sha256": sha256(data).hexdigest(), "bytes": len(data),
                                     "completion": ending, "recordedUsage": bundle["recordedUsage"]})
    smoke = []
    for directory in sorted((root / "work").glob("building-loop-*")):
        if not directory.is_dir() or not any(k in directory.name for k in ("smoke-", "scope-check-", "index-")):
            continue
        for file in sorted(p for p in directory.iterdir() if p.is_file()):
            smoke.append(artifact(file, file.relative_to(root / "work").as_posix(), clean))
    name = "standalone-smoke.json"
    data = serialize({"spec": "building-loop-smoke/1", "artifacts": smoke})
    (destination / name).write_bytes(data)
    manifest["smoke"] = {"path": name, "sha256": sha256(data).hexdigest(), "bytes": len(data), "artifacts": len(smoke)}
    harnesses = []
    for directory in ("building-loop-real-audit", "building-loop-guard-stage", "building-loop-preflight-stage", "building-loop-evidence-stage", "building-loop-governance", "building-loop-source-audit", "building-loop-repair-audit", "building-loop-coverage-audit", "building-loop-coverage-stage"):
        for basename in ("run.py", "witness.mjs", "analyze.py", "report.py", "manual_records.py", "final_manual.py", "verify-dsh.py", "acquire.py", "fixture.py", "fixtures.py", "bootstrap.py", "progress.py", "stop_debug.py", "quote-replay.mjs", "preflight-replay.mjs", "validate.py", "install_desktop.py"):
            file = root / "work" / directory / basename
            if file.is_file():
                harnesses.append(artifact(file, directory + "/" + basename, clean))
    file = root / "work/building-loop-smoke.py"
    if file.is_file():
        harnesses.append(artifact(file, file.name, clean))
    data = serialize({"spec": "building-loop-harnesses/1", "artifacts": harnesses})
    name = "harnesses.json"
    (destination / name).write_bytes(data)
    manifest["harnesses"] = {"path": name, "sha256": sha256(data).hexdigest(), "bytes": len(data), "artifacts": len(harnesses)}
    (destination / "index.json").write_bytes(serialize(manifest))
    total = sum(v.get("totalTokens", 0) for r in manifest["runs"] for v in r["recordedUsage"].values())
    print("Exported", len(manifest["runs"]), "runs and", len(smoke), "standalone artifacts; recorded total tokens", total)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workspace", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    export(args.workspace.resolve(strict=True), args.destination.resolve())
