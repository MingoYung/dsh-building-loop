"""Read the published manifest, verify artifact digests and recompute usage."""
from hashlib import sha256
from pathlib import Path
import json
import sys

# Read-only verification should also leave the clone free of Python cache files.
sys.dont_write_bytecode = True
from archive import serialize, usage


def verify(root):
    """Reject modified bundles or summaries that disagree with their events."""
    index = json.loads((root / "index.json").read_text(encoding="utf-8"))
    tokens = 0
    for entry in [*index["runs"], index["smoke"], *([index["harnesses"]] if "harnesses" in index else [])]:
        path = (root / entry["path"]).resolve(strict=True)
        assert path.is_relative_to(root.resolve()), "Manifest path escapes the experiment data"
        data = path.read_bytes()
        assert sha256(data).hexdigest() == entry["sha256"], entry["path"]
        bundle = json.loads(data)
        for artifact in bundle["artifacts"]:
            assert sha256(serialize(artifact["data"])).hexdigest() == artifact["publishedSha256"], artifact["path"]
        if "recordedUsage" in bundle:
            actual = usage(bundle["artifacts"])
            assert actual == bundle["recordedUsage"] == entry["recordedUsage"], entry["path"]
            tokens += sum(row.get("totalTokens", 0) for row in actual.values())
    print("Verified", len(index["runs"]), "runs and", index["smoke"]["artifacts"],
          "standalone artifacts; recorded total tokens", tokens)


if __name__ == "__main__":
    verify(Path(__file__).resolve().parent / "data")
