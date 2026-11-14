"""Exercise the portable command using real Linux namespaces."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import json

from probe import BWRAP, run, recipe_config, probe_input


def recipe(**overrides):
    return {
        "executable": "/usr/bin/python3", "entrypoint": "candidate.py",
        "fixedArgs": ["-E", "-s", "-B"],
        "mounts": [{"source": "/usr", "target": "/usr"}],
        "links": [{"target": "/lib", "source": "/usr/lib"}, {"target": "/lib64", "source": "/usr/lib64"}],
        "maxArgs": 2, "maxFiles": 2, "allowStdin": True, "timeoutMs": 4000, **overrides,
    }


class ProbeValidation(unittest.TestCase):
    def test_rejects_unknown_operation_and_scratch_paths(self):
        config = recipe_config(recipe())
        for request in (
            {"command": "sh"},
            {"args": ["a", "b", "c"]},
            {"files": [{"path": "../host-secret", "content": "x"}]},
            {"files": [{"path": "test\\outside", "content": "x"}]},
            {"files": [{"path": "dup", "content": ""}, {"path": "dup", "content": ""}]},
            {"files": [{"path": "conflict", "content": ""}, {"path": "conflict/child", "content": ""}]},
        ):
            with self.subTest(request=request), self.assertRaises(ValueError):
                probe_input(request, config)
        with self.assertRaises(ValueError):
            recipe_config(recipe(mounts=[{"source": "/usr", "target": "/scratch/usr"}]))


@unittest.skipUnless(sys.platform == "linux" and Path(BWRAP).is_file(), "requires Linux with bubblewrap")
class NativeProbe(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "snapshot"
        self.source.mkdir()
        self.candidate = self.source / "candidate.py"

    def inspect(self, program, request=None, **overrides):
        self.candidate.write_text(program, encoding="utf-8")
        return run(recipe(**overrides), self.source, request or {})

    def test_real_argv_stdin_scratch_and_python_trace(self):
        (self.source / "sibling.py").write_text("VALUE = 'sibling'\n", encoding="utf-8")
        result = self.inspect(
            "from pathlib import Path\nimport sys\nfrom sibling import VALUE\n"
            "name, literal = sys.argv[1:]\nprint(VALUE, Path(name).read_text(), sys.stdin.read(), literal)\n"
            "raise ValueError('demo failure')\n",
            {"args": ["样本/input.txt", "$(touch /scratch/executed)"], "stdin": "input",
             "files": [{"path": "样本/input.txt", "content": "fixture"}]},
        )
        self.assertEqual((result["status"], result["exitCode"]), ("exited", 1), result)
        self.assertEqual(result["stdout"].strip(), "sibling fixture input $(touch /scratch/executed)")
        self.assertIn("ValueError: demo failure", result["stderr"])
        self.assertEqual(result["frames"][-1], {"path": "candidate.py", "line": 6, "function": "<module>"})

    def test_host_advertised_fixture_limit_reaches_the_program(self):
        names = [f"fixture-{i}.txt" for i in range(12)]
        request = {"args": [*names, *names], "files": [{"path": name, "content": "x" * 1000} for name in names]}
        result = self.inspect(
            "from pathlib import Path\nimport sys\nprint(sum(len(Path(name).read_text()) for name in sys.argv[1:]))\n",
            request, maxArgs=24, maxFiles=12,
        )
        self.assertEqual((result["exitCode"], result["stdout"].strip()), (0, "24000"), result)
        request["files"][0]["content"] = "x" * 6000
        with self.assertRaisesRegex(ValueError, "byte limit"):
            self.inspect("raise AssertionError('must not execute')\n", request, maxArgs=24, maxFiles=12)

    def test_source_and_host_isolation(self):
        secret = self.root / "sensitive.txt"
        secret.write_text("host", encoding="utf-8")
        program = (
            "import os, socket\nfrom pathlib import Path\n"
            f"assert not Path({str(secret)!r}).exists()\n"
            "assert 'PROBE_TEST_SECRET' not in os.environ\n"
            "assert Path('/proc/self/ns/net').readlink().as_posix() != __import__('sys').argv[1]\n"
            "try:\n    Path('/submission/candidate.py').write_text('modified')\n"
            "except OSError:\n    pass\nelse:\n    raise AssertionError('source was writable')\n"
            "Path('/scratch/local.txt').write_text('scratch')\n"
            "print('isolated')\n"
        )
        previous = os.environ.get("PROBE_TEST_SECRET")
        os.environ["PROBE_TEST_SECRET"] = "credential"
        try:
            result = self.inspect(program, {"args": [str(Path("/proc/self/ns/net").readlink())]})
        finally:
            if previous is None:
                del os.environ["PROBE_TEST_SECRET"]
            else:
                os.environ["PROBE_TEST_SECRET"] = previous
        self.assertEqual((result["exitCode"], result["stdout"].strip()), (0, "isolated"), result)
        self.assertEqual(self.candidate.read_text(encoding="utf-8"), program)
        self.assertEqual(secret.read_text(encoding="utf-8"), "host")

    def test_timeout_output_limit_and_non_python(self):
        slow = self.inspect("import time\ntime.sleep(20)\n", timeoutMs=500)
        self.assertEqual(slow["status"], "timeout", slow)
        loud = self.inspect("while True: print('x' * 8192)\n")
        self.assertEqual(loud["status"], "output-limit", loud)
        self.assertTrue(loud["truncated"])
        self.assertLessEqual(len(loud["stdout"].encode()), 2048)
        config = recipe(executable="/usr/bin/printf", fixedArgs=["%s"], maxArgs=1)
        del config["entrypoint"]
        result = run(config, self.source, {"args": ["native"]})
        self.assertEqual((result["status"], result["exitCode"], result["stdout"], result["frames"]),
                         ("exited", 0, "native", []), result)

    def test_linked_snapshot_and_cli_input_rejection(self):
        self.candidate.write_text("raise AssertionError('must not execute')\n", encoding="utf-8")
        (self.source / "link.py").symlink_to(self.candidate)
        config = self.root / "recipe.json"
        config.write_text(json.dumps(recipe()), encoding="utf-8")
        result = subprocess.run([sys.executable, str(Path(__file__).with_name("probe.py")), str(config), str(self.source)],
                                input="{}", text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout)["status"], "unavailable")


if __name__ == "__main__":
    unittest.main()
