"""Run an owner-registered executable against one isolated source snapshot."""

from __future__ import annotations

import json
import math
import os
import re
import resource
import selectors
import signal
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import ExitStack
from pathlib import Path, PurePosixPath

BWRAP = "/usr/bin/bwrap"
MAX_REQUEST = 64 * 1024
MAX_OUTPUT = 64 * 1024
PREVIEW = 2048
SNAPSHOT_BYTES = 4 * 1024 * 1024
SNAPSHOT_FILES = 256
MAX_FIXTURE_BYTES = 16 * 1024
UNSAFE_PATH = re.compile(r'[:*?"<>|\\\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]|[. ]$')
FRAME = re.compile(r'^  File "/submission/([^"\n]+)", line (\d{1,8}), in ([^\n]{1,80})$', re.M)
RESERVED = {"submission", "scratch", "tmp", "proc", "dev"}


def shape(row, fields):
    if type(row) is not dict or row.keys() - fields:
        raise ValueError("Unexpected fields")


def integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("Integer outside configured bounds")
    return value


def flag(value):
    if type(value) is not bool:
        raise ValueError("Expected a boolean")
    return value


def bounded_text(value, maximum):
    if type(value) is not str or "\0" in value or len(value.encode("utf-8")) > maximum:
        raise ValueError("Invalid or oversized text")
    return value


def names(value, count, size):
    if type(value) is not list or len(value) > count:
        raise ValueError("Unexpected argument count")
    return [bounded_text(item, size) for item in value]


def relative_path(value):
    parts = bounded_text(value, 500).split("/")
    if any(not part or len(part.encode("utf-8")) > 240 or UNSAFE_PATH.search(part) for part in parts):
        raise ValueError("Expected an exact relative file path")
    return value


def sandbox_path(value):
    bounded_text(value, 240)
    if not value.startswith("/"):
        raise ValueError("Expected an absolute sandbox path")
    relative_path(value[1:])
    return value


def runtime_flags(mounts, links):
    flags, used = [], set()
    for field, rows in [("--ro-bind", mounts), ("--symlink", links)]:
        if type(rows) is not list or len(rows) > 16:
            raise ValueError("Invalid runtime recipe")
        for row in rows:
            shape(row, {"source", "target"})
            source, target = sandbox_path(row["source"]), sandbox_path(row["target"])
            if PurePosixPath(target).parts[1] in RESERVED or target in used:
                raise ValueError("Runtime mount overlaps a reserved sandbox path")
            used.add(target)
            if field == "--ro-bind":
                entry = Path(source).resolve(strict=True).stat()
                if not stat.S_ISDIR(entry.st_mode) and not stat.S_ISREG(entry.st_mode):
                    raise ValueError("Runtime mount is not a directory or regular file")
            flags.extend((field, source, target))
    return flags


def recipe_config(recipe):
    shape(recipe, {"executable", "entrypoint", "fixedArgs", "mounts", "links",
                   "maxArgs", "maxFiles", "allowStdin", "timeoutMs"})
    executable = sandbox_path(recipe["executable"])
    entrypoint = relative_path(recipe["entrypoint"]) if "entrypoint" in recipe else None
    fixed = names(recipe.get("fixedArgs", []), 24, 512)
    if entrypoint is not None:
        fixed.append("/submission/" + entrypoint)
    runtime = runtime_flags(recipe.get("mounts", []), recipe.get("links", []))
    return {
        "command": [executable, *fixed], "entrypoint": entrypoint, "runtime": runtime,
        "maxArgs": integer(recipe.get("maxArgs", 0), 0, 24),
        "maxFiles": integer(recipe.get("maxFiles", 0), 0, 12),
        "allowStdin": flag(recipe.get("allowStdin", False)),
        "timeoutMs": integer(recipe.get("timeoutMs", 4000), 100, 10000),
    }


def probe_input(request, config):
    shape(request, {"args", "stdin", "files"})
    argv = names(request.get("args", []), config["maxArgs"], 512)
    stdin = bounded_text(request.get("stdin", ""), 8192).encode("utf-8")
    if "stdin" in request and not config["allowStdin"]:
        raise ValueError("Probe does not accept stdin")
    files = request.get("files", [])
    if type(files) is not list or len(files) > config["maxFiles"]:
        raise ValueError("Unexpected scratch file count")
    contents = {}
    for row in files:
        shape(row, {"path", "content"})
        name = relative_path(bounded_text(row["path"], 160))
        if name in contents:
            raise ValueError("Duplicate scratch file")
        contents[name] = bounded_text(row["content"], MAX_FIXTURE_BYTES).encode("utf-8")
    if any(str(parent) in contents for name in contents for parent in PurePosixPath(name).parents):
        raise ValueError("A scratch file cannot also be a directory")
    if sum(map(len, contents.values())) > MAX_FIXTURE_BYTES:
        raise ValueError("Scratch inputs exceed the byte limit")
    return argv, stdin, contents


def snapshot_copy(source, target):
    """Copy exact regular files from an adapter-owned snapshot via directory FDs."""
    files, size, directories = {}, 0, 0
    root = os.open(source, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        def fail(error):
            raise error

        for parent, dirs, filenames, fd in os.fwalk(".", onerror=fail, follow_symlinks=False, dir_fd=root):
            directories += len(dirs)
            if directories > 4096:
                raise ValueError("Snapshot has too many directories")
            for directory in dirs:
                relative_path(PurePosixPath(parent, directory).as_posix())
                if not stat.S_ISDIR(os.stat(directory, dir_fd=fd, follow_symlinks=False).st_mode):
                    raise ValueError("Snapshot directories cannot be links")
            for filename in sorted(filenames):
                name = relative_path(PurePosixPath(parent, filename).as_posix())
                handle = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                with os.fdopen(handle, "rb") as stream:
                    entry = os.fstat(stream.fileno())
                    if not stat.S_ISREG(entry.st_mode) or entry.st_nlink != 1 or entry.st_size > SNAPSHOT_BYTES - size:
                        raise ValueError("Snapshot contains a linked, special or oversized file")
                    data = stream.read(SNAPSHOT_BYTES - size + 1)
                size += len(data)
                if len(files) >= SNAPSHOT_FILES or size > SNAPSHOT_BYTES:
                    raise ValueError("Snapshot exceeds the file or byte limit")
                output = target / name
                output.parent.mkdir(parents=True, exist_ok=True)
                output.write_bytes(data)
                output.chmod(entry.st_mode & 0o777)
                files[name] = data.count(b"\n") + int(bool(data) and not data.endswith(b"\n"))
    finally:
        os.close(root)
    return files


def sandbox_command(config, source, inputs, stack, status_file):
    command = [BWRAP, "--unshare-all", "--unshare-user", "--disable-userns", "--assert-userns-disabled",
               "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--clearenv",
               "--ro-bind", str(source), "/submission", "--proc", "/proc", "--dev", "/dev",
               "--size", "8388608", "--tmpfs", "/scratch", "--symlink", "/scratch", "/tmp",
               "--setenv", "LANG", "C.UTF-8", "--setenv", "HOME", "/scratch",
               "--setenv", "TMPDIR", "/scratch", "--setenv", "PATH", "/usr/bin",
               "--chdir", "/scratch", "--json-status-fd", str(status_file.fileno()), *config["runtime"]]
    fds = [status_file.fileno()]
    for path, content in inputs.items():
        file = stack.enter_context(tempfile.TemporaryFile())
        file.write(content)
        file.seek(0)
        fds.append(file.fileno())
        command.extend(("--file", str(file.fileno()), "/scratch/" + path))
    return command, fds


def drain(process, stdin, deadline):
    """Keep both pipes drained under one wall-clock deadline and byte budget."""
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    remaining = memoryview(stdin)
    with selectors.DefaultSelector() as selector:
        for name in captured:
            selector.register(getattr(process, name), selectors.EVENT_READ, name)
        if remaining:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
        while selector.get_map():
            timeout = deadline - time.monotonic()
            if timeout <= 0:
                return "timeout", captured
            for key, _ in selector.select(timeout):
                fd, name = key.fileobj.fileno(), key.data
                if name == "stdin":
                    try:
                        remaining = remaining[os.write(fd, remaining):]
                    except BrokenPipeError:
                        remaining = remaining[:0]
                    except BlockingIOError:
                        continue
                    if not remaining:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                    continue
                available = MAX_OUTPUT - sum(map(len, captured.values()))
                chunk = os.read(fd, min(4096, available + 1))
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                captured[name].extend(chunk[:available])
                if len(chunk) > available:
                    return "output-limit", captured
    try:
        process.wait(timeout=max(0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        return "timeout", captured
    return "exited", captured


def execute(config, source, inputs, argv, stdin):
    with ExitStack() as stack:
        status_file = stack.enter_context(tempfile.TemporaryFile())
        command, fds = sandbox_command(config, source, inputs, stack, status_file)
        cpu_seconds = math.ceil(config["timeoutMs"] / 1000) + 1

        def limits():
            # Bound per-process resources; bubblewrap isolates and reaps its PID namespace.
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
            resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
            resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
            resource.setrlimit(resource.RLIMIT_AS, (1024 ** 3, 1024 ** 3))
            resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))

        process = stack.enter_context(subprocess.Popen([*command, "--", *config["command"], *argv],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=tuple(fds), start_new_session=True, env={}, preexec_fn=limits))
        try:
            status, captured = drain(process, stdin, time.monotonic() + config["timeoutMs"] / 1000)
        finally:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        status_file.seek(0)
        records = [json.loads(line) for line in status_file.read(8192).splitlines()]
        if not any(type(row.get("child-pid")) is int for row in records):
            return "unavailable", None, captured
        return status, process.returncode if status == "exited" else None, captured


def run(recipe, source, request):
    config = recipe_config(recipe)
    argv, stdin, inputs = probe_input(request, config)
    with tempfile.TemporaryDirectory(prefix="building-loop-probe-") as directory:
        snapshot = Path(directory, "source")
        snapshot.mkdir()
        files = snapshot_copy(Path(source), snapshot)
        if config["entrypoint"] is not None and config["entrypoint"] not in files:
            raise ValueError("Recipe entrypoint is absent from the snapshot")
        status, exit_code, captured = execute(config, snapshot, inputs, argv, stdin)
    stderr = captured["stderr"].decode("utf-8", errors="replace")
    frames = [
        {"path": path, "line": int(line), "function": function}
        for path, line, function in FRAME.findall(stderr)
        if path in files and 1 <= int(line) <= files[path]
        and re.fullmatch(r"[A-Za-z0-9_.<> -]+", function)
    ][-6:]
    previews = {key: value.decode("utf-8", errors="replace").encode("utf-8") for key, value in captured.items()}
    return {
        "status": status, "exitCode": exit_code,
        **{key: value[:PREVIEW].decode("utf-8", errors="ignore") for key, value in previews.items()},
        "frames": frames, "truncated": status == "output-limit" or any(len(value) > PREVIEW for value in previews.values()),
    }


def main():
    try:
        recipe_file, source = sys.argv[1:]
        with open(recipe_file, "rb") as file:
            recipe_bytes = file.read(MAX_REQUEST + 1)
        raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
        if max(len(raw), len(recipe_bytes)) > MAX_REQUEST:
            raise ValueError("Request exceeds the byte limit")
        result = run(json.loads(recipe_bytes), source, json.loads(raw))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        result = {"status": "unavailable", "exitCode": None, "stdout": "", "stderr": "", "frames": [], "truncated": False}
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
