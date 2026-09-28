#!/usr/bin/env python3
"""Plan and transactionally update the personal Agentic SDLC installation."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import re
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path, PurePosixPath


PLUGIN_NAME = "agentic-sdlc-codex-plugin"
DEFAULT_MARKETPLACE_NAME = "personal"
STANDARD_ROOT_FILES = ("package.json", "README.md", "LICENSE")
EXCLUDED_NAMES = frozenset({".git", ".sdlc", "test", ".DS_Store"})
EXCLUDED_DISTRIBUTION_METADATA = frozenset({".npmignore"})
EXCLUDED_FILE_SUFFIXES = (".pyc", ".pyo")
INSTALL_LOCK_WAIT_SECONDS = 30.0
INSTALL_LOCK_RELEASE_SECONDS = 5.0
MINIMUM_PYTHON = (3, 8)
RTK_MINIMUM_VERSION = (0, 43, 0)
RTK_COMMAND_TIMEOUT_SECONDS = 20.0
RTK_MAX_CAPTURED_OUTPUT_CHARS = 1024 * 1024
RTK_VERSION_PATTERN = re.compile(
    r"^rtk (\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$"
)
PLAN_HASH_PATTERN = re.compile(r"^[0-9a-f]{64}$")
INSTALLER_SCHEMA = "agentic-sdlc.local-installer.v1"


class InstallError(RuntimeError):
    """Raised when staging cannot proceed without risking unmanaged files."""


class RtkGlobalConfigurationError(InstallError):
    """Raised after global RTK configuration may already have changed."""


class InstallerArgumentParser(argparse.ArgumentParser):
    """Argument parser that lets the CLI render machine-readable failures."""

    def error(self, message: str) -> None:
        raise InstallError(message)


def _parse_arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = InstallerArgumentParser(
        description=(
            "Inspect, plan, or safely update the local Agentic SDLC plugin and "
            "the list Codex uses to find it. Running without a command only "
            "creates a plan; it does not change files."
        )
    )
    parser.add_argument(
        "command",
        nargs="?",
        choices=("check", "plan", "apply"),
        default="plan",
        help=(
            "check the current installation, create an exact read-only plan "
            "(default), or apply a previously reviewed plan"
        ),
    )
    parser.add_argument(
        "--plan-hash",
        metavar="SHA256",
        help="Exact plan identifier printed by the plan command; required by apply.",
    )
    parser.add_argument(
        "--home",
        metavar="PATH",
        help=(
            "Absolute home directory used for the plugin and Codex personal-plugin "
            "list. Defaults to HOME."
        ),
    )
    parser.add_argument(
        "--locale",
        choices=("en", "it"),
        default="en",
        help="Language for the primary explanation (default: en).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print one deterministic JSON envelope and no additional text.",
    )
    parser.add_argument(
        "--with-rtk",
        action="store_true",
        help=(
            "Verify an existing Rust Token Killer 0.43.0+ installation and "
            "configure its global Codex instructions. No binary is downloaded. "
            "This is a separate global change and is not part of plugin rollback."
        ),
    )
    parser.add_argument(
        "--rtk-executable",
        metavar="PATH",
        help=(
            "RTK executable path or command name. Requires --with-rtk. When this "
            "option is omitted, the installer searches PATH for 'rtk'."
        ),
    )
    arguments = parser.parse_args(argv)
    if arguments.rtk_executable and not arguments.with_rtk:
        raise InstallError("--rtk-executable requires --with-rtk")
    if arguments.command == "apply":
        if arguments.plan_hash is None:
            raise InstallError("apply requires --plan-hash from the plan command")
        arguments.plan_hash = arguments.plan_hash.strip().lower()
        if PLAN_HASH_PATTERN.fullmatch(arguments.plan_hash) is None:
            raise InstallError("--plan-hash must contain exactly 64 hexadecimal characters")
    elif arguments.plan_hash is not None:
        raise InstallError("--plan-hash can only be used with apply")
    return arguments


def _format_command_failure(
    label: str, return_code: int, stdout: str, stderr: str
) -> str:
    detail = stderr.strip() or stdout.strip()
    if len(detail) > 500:
        detail = f"{detail[:500]}..."
    suffix = f": {detail}" if detail else ""
    return f"{label} failed with exit code {return_code}{suffix}"


def _run_rtk_command(
    executable: str, arguments: list[str], label: str, cwd: Path | None = None
) -> subprocess.CompletedProcess:
    command = [executable, *arguments]
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            encoding="utf-8",
            errors="replace",
            shell=False,
            timeout=RTK_COMMAND_TIMEOUT_SECONDS,
            cwd=cwd,
        )
    except subprocess.TimeoutExpired as exc:
        raise InstallError(
            f"{label} timed out after {RTK_COMMAND_TIMEOUT_SECONDS:g} seconds: {executable}"
        ) from exc
    except FileNotFoundError as exc:
        raise InstallError(f"RTK executable was not found: {executable}") from exc
    except PermissionError as exc:
        raise InstallError(f"RTK executable is not executable: {executable}") from exc
    except OSError as exc:
        raise InstallError(f"Could not run RTK executable {executable}: {exc}") from exc

    if (
        len(result.stdout) > RTK_MAX_CAPTURED_OUTPUT_CHARS
        or len(result.stderr) > RTK_MAX_CAPTURED_OUTPUT_CHARS
    ):
        raise InstallError(f"{label} produced unexpectedly large output")
    if result.returncode != 0:
        raise InstallError(
            _format_command_failure(label, result.returncode, result.stdout, result.stderr)
        )
    return result


def _resolve_rtk_executable(configured: str | None) -> str:
    if configured:
        expanded = os.path.expandvars(os.path.expanduser(configured.strip()))
        if not expanded:
            raise InstallError("--rtk-executable must not be empty")
        has_path_component = Path(expanded).is_absolute() or any(
            separator and separator in expanded for separator in (os.sep, os.altsep)
        )
        if has_path_component:
            candidate = Path(expanded)
            if not candidate.is_file():
                raise InstallError(f"RTK executable is not a regular file: {candidate}")
            try:
                return str(candidate.resolve(strict=True))
            except OSError as exc:
                raise InstallError(f"Could not resolve RTK executable {candidate}: {exc}") from exc
        resolved = shutil.which(expanded)
        if resolved is None:
            raise InstallError(f"RTK executable was not found on PATH: {expanded}")
        return str(Path(resolved).resolve(strict=True))

    resolved = shutil.which("rtk")
    if resolved is None:
        raise InstallError(
            "RTK 0.43.0+ is required by --with-rtk but was not found on PATH. "
            "Install Rust Token Killer from https://github.com/rtk-ai/rtk or pass "
            "--rtk-executable PATH."
        )
    return str(Path(resolved).resolve(strict=True))


def _verify_rtk_version(executable: str) -> str:
    result = _run_rtk_command(executable, ["--version"], "RTK version check")
    raw_version = result.stdout.strip()
    match = RTK_VERSION_PATTERN.fullmatch(raw_version)
    if match is None:
        raise InstallError(
            "RTK identity check failed: expected '--version' output like "
            f"'rtk 0.43.0', got {raw_version!r}. This may be a different tool named rtk."
        )
    current = tuple(int(match.group(index)) for index in range(1, 4))
    prerelease = match.group(4)
    if current < RTK_MINIMUM_VERSION or (
        current == RTK_MINIMUM_VERSION and prerelease is not None
    ):
        minimum = ".".join(str(part) for part in RTK_MINIMUM_VERSION)
        version = raw_version[len("rtk ") :]
        raise InstallError(
            f"RTK {version} is unsupported; version {minimum}+ is required."
        )
    return raw_version[len("rtk ") :]


def _is_non_negative_integer(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _verify_rtk_gain(executable: str, project_root: Path) -> None:
    result = _run_rtk_command(
        executable,
        ["gain", "--project", "--format", "json"],
        "RTK gain identity check",
        cwd=project_root,
    )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise InstallError(
            "RTK identity check failed: 'gain --project --format json' did not return valid JSON"
        ) from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("summary"), dict):
        raise InstallError(
            "RTK identity check failed: gain JSON must contain a summary object"
        )
    summary = payload["summary"]
    required_counters = (
        "total_commands",
        "total_input",
        "total_output",
        "total_saved",
    )
    if any(not _is_non_negative_integer(summary.get(key)) for key in required_counters):
        raise InstallError(
            "RTK identity check failed: gain summary counters are missing or invalid"
        )
    savings = summary.get("avg_savings_pct")
    if (
        isinstance(savings, bool)
        or not isinstance(savings, (int, float))
        or not 0 <= savings <= 100
    ):
        raise InstallError(
            "RTK identity check failed: gain summary avg_savings_pct must be from 0 to 100"
        )


def _show_reports_global_rtk_configured(output: str) -> bool:
    lines = [line.strip() for line in output.splitlines()]
    global_rtk = any(
        line.startswith("[ok]") and "Global RTK.md:" in line for line in lines
    )
    global_agents = any(
        line.startswith("[ok]") and "Global AGENTS.md:" in line for line in lines
    )
    return global_rtk and global_agents


@contextmanager
def _plan_bound_rtk_executable(rtk_plan: dict[str, object]):
    """Yield a private executable containing exactly the bytes approved in the plan."""

    configured = rtk_plan.get("executable")
    expected_digest = rtk_plan.get("binary_sha256")
    expected_size = rtk_plan.get("binary_bytes")
    if (
        not isinstance(configured, str)
        or not configured
        or not isinstance(expected_digest, str)
        or PLAN_HASH_PATTERN.fullmatch(expected_digest) is None
        or not _is_non_negative_integer(expected_size)
    ):
        raise InstallError("The reviewed RTK executable identity is incomplete")

    source = Path(configured)
    try:
        payload = source.read_bytes()
        source_mode = stat.S_IMODE(source.stat().st_mode)
    except OSError as exc:
        raise InstallError(f"Could not read the reviewed RTK executable {source}: {exc}") from exc
    actual_digest = _sha256_bytes(payload)
    if len(payload) != expected_size or actual_digest != expected_digest:
        raise InstallError(
            "The RTK executable changed after the reviewed preview. Global Codex "
            "instructions were not changed; create and review a new preview."
        )

    staging_directory = Path(tempfile.mkdtemp(prefix="agentic-sdlc-rtk-"))
    staged = staging_directory / source.name
    try:
        _write_bytes_atomically(staged, payload)
        if os.name != "nt":
            staged.chmod(source_mode | stat.S_IXUSR)
        staged_payload = staged.read_bytes()
        if (
            len(staged_payload) != expected_size
            or _sha256_bytes(staged_payload) != expected_digest
        ):
            raise InstallError(
                "The private RTK copy did not match the reviewed executable; "
                "global Codex instructions were not changed."
            )
        yield str(staged)
    finally:
        shutil.rmtree(staging_directory, ignore_errors=True)


def _configure_rtk_for_codex(
    rtk_plan: dict[str, object], project_root: Path
) -> dict[str, str]:
    with _plan_bound_rtk_executable(rtk_plan) as executable:
        version = _verify_rtk_version(executable)
        _verify_rtk_gain(executable, project_root)
        try:
            _run_rtk_command(
                executable,
                ["init", "-g", "--codex"],
                "RTK global Codex configuration",
            )
            shown = _run_rtk_command(
                executable,
                ["init", "-g", "--codex", "--show"],
                "RTK global Codex verification",
            )
            if not _show_reports_global_rtk_configured(shown.stdout):
                raise InstallError(
                    "RTK global Codex verification failed: '--show' did not report both "
                    "Global RTK.md and Global AGENTS.md as configured"
                )
        except InstallError as exc:
            raise RtkGlobalConfigurationError(str(exc)) from exc
    return {
        "executable": str(rtk_plan["executable"]),
        "version": version,
        "binary_sha256": str(rtk_plan["binary_sha256"]),
    }


def _lexists(path: Path) -> bool:
    return os.path.lexists(path)


def _is_link_like(path: Path) -> bool:
    if path.is_symlink():
        return True
    if os.name != "nt" or not _lexists(path):
        return False
    attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x0400)
    return bool(attributes & reparse_flag)


def _home_directory(configured: str | None = None) -> Path:
    raw_home = configured if configured is not None else os.environ.get("HOME")
    home = Path(raw_home).expanduser() if raw_home else Path.home()
    if not home.is_absolute():
        option = "--home" if configured is not None else "HOME"
        raise InstallError(f"{option} must be an absolute path, got: {home}")
    if _lexists(home) and _is_link_like(home):
        raise InstallError(f"Refusing symlinked or junction home path: {home}")
    try:
        resolved = home.resolve(strict=False)
    except OSError as exc:
        raise InstallError(f"Could not resolve home path {home}: {exc}") from exc
    if _lexists(resolved) and not resolved.is_dir():
        raise InstallError(f"Home path is not a directory: {resolved}")
    return resolved


def _assert_no_nested_symlinks(base: Path, target: Path, label: str) -> None:
    try:
        relative = target.absolute().relative_to(base.absolute())
    except ValueError as exc:
        raise InstallError(f"{label} escapes HOME: {target}") from exc

    current = base
    for component in relative.parts:
        current = current / component
        if _lexists(current) and _is_link_like(current):
            raise InstallError(f"Refusing symlinked or junction {label} path component: {current}")


def _process_is_alive(pid: object) -> bool | None:
    """Return process liveness, or None when the platform cannot prove it."""

    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes
            from ctypes import wintypes

            process_query_limited_information = 0x1000
            still_active = 259
            kernel32 = ctypes.windll.kernel32
            kernel32.OpenProcess.argtypes = (
                wintypes.DWORD,
                wintypes.BOOL,
                wintypes.DWORD,
            )
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.GetExitCodeProcess.argtypes = (
                wintypes.HANDLE,
                ctypes.POINTER(wintypes.DWORD),
            )
            kernel32.GetExitCodeProcess.restype = wintypes.BOOL
            kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
            kernel32.CloseHandle.restype = wintypes.BOOL
            handle = kernel32.OpenProcess(
                process_query_limited_information, False, pid
            )
            if not handle:
                return False
            try:
                exit_code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
                    return None
                return exit_code.value == still_active
            finally:
                kernel32.CloseHandle(handle)
        except (AttributeError, OSError, ValueError):
            return None
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None
    return True


def _lock_owner_is_gone(lock_path: Path) -> bool:
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    return _process_is_alive(payload.get("pid")) is False


@contextmanager
def _exclusive_install_lock(lock_path: Path):
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    nonce = secrets.token_hex(12)
    deadline = time.monotonic() + INSTALL_LOCK_WAIT_SECONDS
    payload = {
        "pid": os.getpid(),
        "nonce": nonce,
        "created_at": time.time(),
    }
    while True:
        try:
            descriptor = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(payload, handle)
            break
        except FileExistsError:
            if _lock_owner_is_gone(lock_path):
                stale_path = lock_path.with_name(
                    f".{lock_path.name}.stale-{os.getpid()}-{secrets.token_hex(4)}"
                )
                try:
                    os.replace(lock_path, stale_path)
                    stale_path.unlink(missing_ok=True)
                    continue
                except FileNotFoundError:
                    continue
                except OSError:
                    pass
        except PermissionError as exc:
            if not _lock_access_denial_is_transient(exc):
                raise
        if time.monotonic() >= deadline:
            raise InstallError(f"Timed out waiting for installer lock: {lock_path}")
        time.sleep(0.05)
    try:
        yield
    finally:
        _release_install_lock(lock_path, nonce)


def _lock_access_denial_is_transient(error: OSError) -> bool:
    """Windows denies lock access while a peer reads or deletes the lock file."""

    return os.name == "nt" and isinstance(error, PermissionError)


def _release_install_lock(lock_path: Path, nonce: str) -> None:
    deadline = time.monotonic() + INSTALL_LOCK_RELEASE_SECONDS
    while True:
        try:
            current = json.loads(lock_path.read_text(encoding="utf-8"))
            if current.get("nonce") == nonce:
                lock_path.unlink()
            return
        except (FileNotFoundError, json.JSONDecodeError):
            return
        except OSError as exc:
            if not _lock_access_denial_is_transient(exc) or time.monotonic() >= deadline:
                raise InstallError(
                    f"Could not release installer lock {lock_path}: {exc}"
                ) from exc
            time.sleep(0.05)


def _read_package_allowlist(repo_root: Path) -> tuple[str, ...]:
    package_path = repo_root / "package.json"
    try:
        package = json.loads(package_path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise InstallError(f"Missing package manifest: {package_path}") from exc
    except json.JSONDecodeError as exc:
        raise InstallError(f"Invalid JSON in {package_path}: {exc}") from exc
    except OSError as exc:
        raise InstallError(f"Could not read {package_path}: {exc}") from exc

    if not isinstance(package, dict):
        raise InstallError(f"{package_path} must contain a JSON object.")

    raw_allowlist = package.get("files")
    if not isinstance(raw_allowlist, list) or not raw_allowlist:
        raise InstallError(f"{package_path} field 'files' must be a non-empty array.")

    patterns: list[str] = []
    for index, value in enumerate(raw_allowlist):
        if not isinstance(value, str) or not value.strip():
            raise InstallError(
                f"{package_path} field 'files' item {index} must be a non-empty string."
            )

        pattern = value.strip().replace("\\", "/")
        while pattern.startswith("./"):
            pattern = pattern[2:]
        pattern = pattern.rstrip("/")
        parsed = PurePosixPath(pattern)
        if (
            not pattern
            or pattern == "."
            or pattern.startswith("!")
            or parsed.is_absolute()
            or ".." in parsed.parts
        ):
            raise InstallError(
                f"Unsafe or unsupported package files entry at index {index}: {value!r}"
            )
        if pattern not in patterns:
            patterns.append(pattern)

    return tuple(patterns)


def _is_excluded(relative_path: Path) -> bool:
    return any(part in EXCLUDED_NAMES for part in relative_path.parts) or (
        relative_path.name == "__pycache__"
        or relative_path.name in EXCLUDED_DISTRIBUTION_METADATA
        or relative_path.name.endswith(EXCLUDED_FILE_SUFFIXES)
    )


def _is_within(path: Path, parent: Path) -> bool:
    try:
        path.absolute().relative_to(parent.absolute())
        return True
    except ValueError:
        return False


def _is_forbidden_source_path(path: Path, forbidden_roots: tuple[Path, ...]) -> bool:
    return any(_is_within(path, root) for root in forbidden_roots)


def _copy_file(source: Path, repo_root: Path, staging_root: Path) -> None:
    relative_path = source.relative_to(repo_root)
    destination = staging_root / relative_path
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def _copy_directory(
    source: Path,
    repo_root: Path,
    staging_root: Path,
    forbidden_roots: tuple[Path, ...],
) -> None:
    for current_root, directory_names, file_names in os.walk(source, followlinks=False):
        current_path = Path(current_root)
        current_relative = current_path.relative_to(repo_root)

        retained_directories: list[str] = []
        for directory_name in sorted(directory_names):
            child = current_path / directory_name
            child_relative = child.relative_to(repo_root)
            if _is_excluded(child_relative) or _is_forbidden_source_path(
                child, forbidden_roots
            ):
                continue
            if _is_link_like(child):
                raise InstallError(f"Refusing allowlisted source symlink or junction: {child}")
            retained_directories.append(directory_name)
        directory_names[:] = retained_directories

        (staging_root / current_relative).mkdir(parents=True, exist_ok=True)
        for file_name in sorted(file_names):
            child = current_path / file_name
            child_relative = child.relative_to(repo_root)
            if _is_excluded(child_relative) or _is_forbidden_source_path(
                child, forbidden_roots
            ):
                continue
            if _is_link_like(child):
                raise InstallError(f"Refusing allowlisted source symlink or junction: {child}")
            if not child.is_file():
                raise InstallError(f"Refusing non-regular allowlisted source file: {child}")
            _copy_file(child, repo_root, staging_root)


def _copy_allowlisted_path(
    source: Path,
    repo_root: Path,
    staging_root: Path,
    forbidden_roots: tuple[Path, ...],
) -> None:
    relative_path = source.relative_to(repo_root)
    if _is_excluded(relative_path) or _is_forbidden_source_path(source, forbidden_roots):
        return
    if _is_link_like(source):
        raise InstallError(f"Refusing allowlisted source symlink or junction: {source}")
    if source.is_dir():
        _copy_directory(source, repo_root, staging_root, forbidden_roots)
        return
    if source.is_file():
        _copy_file(source, repo_root, staging_root)
        return
    raise InstallError(f"Refusing non-regular allowlisted source path: {source}")


def _build_staging_tree(
    repo_root: Path,
    staging_root: Path,
    destination: Path,
    allowlist: tuple[str, ...],
) -> None:
    forbidden_roots = (staging_root, destination)

    for root_file in STANDARD_ROOT_FILES:
        source = repo_root / root_file
        if _lexists(source):
            _copy_allowlisted_path(
                source, repo_root, staging_root, forbidden_roots
            )

    for pattern in allowlist:
        try:
            matches = sorted(repo_root.glob(pattern), key=lambda path: path.as_posix())
        except (OSError, ValueError) as exc:
            raise InstallError(f"Invalid package files pattern {pattern!r}: {exc}") from exc
        for source in matches:
            _copy_allowlisted_path(
                source, repo_root, staging_root, forbidden_roots
            )

    staged_manifest = staging_root / ".codex-plugin" / "plugin.json"
    if not staged_manifest.is_file():
        raise InstallError(
            "The package files allowlist did not stage .codex-plugin/plugin.json."
        )

    for staged_path in staging_root.rglob("*"):
        relative_path = staged_path.relative_to(staging_root)
        if _is_excluded(relative_path):
            raise InstallError(f"Excluded path reached the staging tree: {relative_path}")


def _is_managed_top_level(name: str, allowlist: tuple[str, ...]) -> bool:
    if name in STANDARD_ROOT_FILES:
        return True
    if name in EXCLUDED_NAMES:
        return False

    for pattern in allowlist:
        first_component = PurePosixPath(pattern).parts[0]
        if fnmatch.fnmatchcase(name, first_component):
            return True
    return False


def _validate_destination(
    repo_root: Path, destination: Path, allowlist: tuple[str, ...]
) -> None:
    if _is_link_like(destination):
        raise InstallError(f"Refusing destination symlink or junction: {destination}")

    if not _lexists(destination):
        return

    try:
        if os.path.samefile(repo_root, destination):
            raise InstallError(
                f"Refusing to replace the source checkout itself: {destination}"
            )
    except OSError as exc:
        raise InstallError(f"Could not compare source and destination: {exc}") from exc

    if not destination.is_dir():
        raise InstallError(f"Refusing non-directory destination: {destination}")

    git_marker = destination / ".git"
    if _lexists(git_marker):
        raise InstallError(
            f"Refusing to replace Git checkout at {destination}; move the checkout elsewhere."
        )

    unexpected = sorted(
        entry.name
        for entry in destination.iterdir()
        if not _is_managed_top_level(entry.name, allowlist)
    )
    if unexpected:
        formatted = ", ".join(unexpected)
        raise InstallError(
            f"Refusing to replace {destination}; unexpected unmanaged top-level "
            f"entries: {formatted}"
        )


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _canonical_digest(payload: object) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return _sha256_bytes(encoded)


def _file_entry(path: Path, relative_path: Path) -> dict[str, object]:
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise InstallError(f"Could not read managed file {path}: {exc}") from exc
    return {
        "path": relative_path.as_posix(),
        "type": "file",
        "size": len(payload),
        "sha256": _sha256_bytes(payload),
    }


def _collect_allowlisted_source_files(
    repo_root: Path, destination: Path, allowlist: tuple[str, ...]
) -> list[dict[str, object]]:
    forbidden_roots = (destination,)
    collected: dict[str, dict[str, object]] = {}

    def collect(source: Path) -> None:
        relative_path = source.relative_to(repo_root)
        if _is_excluded(relative_path) or _is_forbidden_source_path(
            source, forbidden_roots
        ):
            return
        if _is_link_like(source):
            raise InstallError(f"Refusing allowlisted source symlink or junction: {source}")
        if source.is_file():
            entry = _file_entry(source, relative_path)
            collected[str(entry["path"])] = entry
            return
        if not source.is_dir():
            raise InstallError(f"Refusing non-regular allowlisted source path: {source}")

        for current_root, directory_names, file_names in os.walk(
            source, followlinks=False
        ):
            current_path = Path(current_root)
            retained_directories: list[str] = []
            for directory_name in sorted(directory_names):
                child = current_path / directory_name
                child_relative = child.relative_to(repo_root)
                if _is_excluded(child_relative) or _is_forbidden_source_path(
                    child, forbidden_roots
                ):
                    continue
                if _is_link_like(child):
                    raise InstallError(
                        f"Refusing allowlisted source symlink or junction: {child}"
                    )
                retained_directories.append(directory_name)
            directory_names[:] = retained_directories
            for file_name in sorted(file_names):
                child = current_path / file_name
                child_relative = child.relative_to(repo_root)
                if _is_excluded(child_relative) or _is_forbidden_source_path(
                    child, forbidden_roots
                ):
                    continue
                if _is_link_like(child):
                    raise InstallError(
                        f"Refusing allowlisted source symlink or junction: {child}"
                    )
                if not child.is_file():
                    raise InstallError(
                        f"Refusing non-regular allowlisted source file: {child}"
                    )
                entry = _file_entry(child, child_relative)
                collected[str(entry["path"])] = entry

    for root_file in STANDARD_ROOT_FILES:
        source = repo_root / root_file
        if _lexists(source):
            collect(source)

    for pattern in allowlist:
        try:
            matches = sorted(repo_root.glob(pattern), key=lambda path: path.as_posix())
        except (OSError, ValueError) as exc:
            raise InstallError(f"Invalid package files pattern {pattern!r}: {exc}") from exc
        for source in matches:
            collect(source)

    if ".codex-plugin/plugin.json" not in collected:
        raise InstallError(
            "The package files allowlist does not include .codex-plugin/plugin.json."
        )
    return [collected[key] for key in sorted(collected)]


def _snapshot_tree(root: Path) -> dict[str, object]:
    if _is_link_like(root):
        raise InstallError(f"Refusing managed tree symlink or junction: {root}")
    if not _lexists(root):
        return {"exists": False, "entries": [], "digest": _canonical_digest([])}
    if not root.is_dir():
        raise InstallError(f"Refusing non-directory managed tree: {root}")

    entries: list[dict[str, object]] = []
    for current_root, directory_names, file_names in os.walk(root, followlinks=False):
        current_path = Path(current_root)
        retained_directories: list[str] = []
        for directory_name in sorted(directory_names):
            child = current_path / directory_name
            relative = child.relative_to(root)
            if _is_link_like(child):
                raise InstallError(f"Refusing managed tree symlink or junction: {child}")
            retained_directories.append(directory_name)
            entries.append({"path": relative.as_posix(), "type": "directory"})
        directory_names[:] = retained_directories
        for file_name in sorted(file_names):
            child = current_path / file_name
            relative = child.relative_to(root)
            if _is_link_like(child):
                raise InstallError(f"Refusing managed tree symlink or junction: {child}")
            if not child.is_file():
                raise InstallError(f"Refusing non-regular managed tree entry: {child}")
            entries.append(_file_entry(child, relative))
    entries.sort(key=lambda entry: (str(entry["path"]), str(entry["type"])))
    return {
        "exists": True,
        "entries": entries,
        "digest": _canonical_digest(entries),
    }


def _file_entries(snapshot: dict[str, object]) -> list[dict[str, object]]:
    entries = snapshot.get("entries", [])
    return [entry for entry in entries if entry.get("type") == "file"]


def _inspect_rtk_plan(
    enabled: bool, configured_executable: str | None
) -> dict[str, object]:
    if not enabled:
        return {
            "enabled": False,
            "transactional": False,
            "executable": None,
            "version": None,
            "binary_sha256": None,
            "binary_bytes": 0,
        }
    executable = _resolve_rtk_executable(configured_executable)
    version = _verify_rtk_version(executable)
    try:
        executable_bytes = Path(executable).read_bytes()
    except OSError as exc:
        raise InstallError(f"Could not read RTK executable {executable}: {exc}") from exc
    return {
        "enabled": True,
        "transactional": False,
        "executable": executable,
        "version": version,
        "binary_sha256": _sha256_bytes(executable_bytes),
        "binary_bytes": len(executable_bytes),
    }


def _prepare_marketplace_payload_from_bytes(
    marketplace_path: Path, original_bytes: bytes | None
) -> dict:
    if original_bytes is not None:
        try:
            payload = json.loads(original_bytes.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise InstallError(f"{marketplace_path} is not valid UTF-8: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise InstallError(f"Invalid JSON in {marketplace_path}: {exc}") from exc
    else:
        payload = {
            "name": DEFAULT_MARKETPLACE_NAME,
            "interface": {"displayName": "Personal"},
            "plugins": [],
        }

    if not isinstance(payload, dict):
        raise InstallError(f"{marketplace_path} must contain a JSON object.")

    payload.setdefault("name", DEFAULT_MARKETPLACE_NAME)
    payload.setdefault("interface", {"displayName": "Personal"})
    plugins = payload.setdefault("plugins", [])
    if not isinstance(plugins, list):
        raise InstallError(f"{marketplace_path} field 'plugins' must be an array.")

    entry = {
        "name": PLUGIN_NAME,
        "source": {
            "source": "local",
            "path": f"./plugins/{PLUGIN_NAME}",
        },
        "policy": {
            "installation": "AVAILABLE",
            "authentication": "ON_INSTALL",
        },
        "category": "Productivity",
    }

    updated_plugins: list[object] = []
    found = False
    for item in plugins:
        if isinstance(item, dict) and item.get("name") == PLUGIN_NAME:
            if found:
                continue
            updated_entry = dict(item)
            updated_entry.update(entry)
            updated_plugins.append(updated_entry)
            found = True
        else:
            updated_plugins.append(item)
    if not found:
        updated_plugins.append(entry)
    payload["plugins"] = updated_plugins

    return payload


def _read_marketplace_bytes(marketplace_path: Path) -> bytes | None:
    if _is_link_like(marketplace_path):
        raise InstallError(f"Refusing marketplace symlink or junction: {marketplace_path}")
    if not _lexists(marketplace_path):
        return None
    if not marketplace_path.is_file():
        raise InstallError(f"Refusing non-file marketplace path: {marketplace_path}")
    try:
        return marketplace_path.read_bytes()
    except OSError as exc:
        raise InstallError(f"Could not read {marketplace_path}: {exc}") from exc


def _prepare_marketplace_payload(marketplace_path: Path) -> dict:
    """Compatibility helper retained for callers that only need the payload."""

    return _prepare_marketplace_payload_from_bytes(
        marketplace_path, _read_marketplace_bytes(marketplace_path)
    )


def _json_bytes(payload: dict) -> bytes:
    return (json.dumps(payload, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _build_install_plan(
    repo_root: Path,
    home: Path,
    with_rtk: bool = False,
    rtk_executable: str | None = None,
) -> dict[str, object]:
    allowlist = _read_package_allowlist(repo_root)
    destination = home / "plugins" / PLUGIN_NAME
    marketplace_path = home / ".agents" / "plugins" / "marketplace.json"
    lock_path = home / ".agents" / "plugins" / f".{PLUGIN_NAME}.install.lock"

    _assert_no_nested_symlinks(home, destination, "plugin destination")
    _assert_no_nested_symlinks(home, marketplace_path, "marketplace")
    _assert_no_nested_symlinks(home, lock_path, "installer lock")
    _validate_destination(repo_root, destination, allowlist)

    source_entries = _collect_allowlisted_source_files(
        repo_root, destination, allowlist
    )
    source_digest = _canonical_digest(source_entries)
    source_size = sum(int(entry["size"]) for entry in source_entries)
    destination_snapshot = _snapshot_tree(destination)
    destination_files = _file_entries(destination_snapshot)

    marketplace_before = _read_marketplace_bytes(marketplace_path)
    marketplace_payload = _prepare_marketplace_payload_from_bytes(
        marketplace_path, marketplace_before
    )
    marketplace_after = _json_bytes(marketplace_payload)
    rtk_plan = _inspect_rtk_plan(with_rtk, rtk_executable)

    plugin_change = source_entries != destination_files
    marketplace_change = marketplace_before != marketplace_after
    if not bool(destination_snapshot["exists"]):
        operation = "install"
    elif plugin_change or marketplace_change:
        operation = "update"
    else:
        operation = "noop"

    changes: list[str] = []
    if plugin_change:
        changes.append("managed_plugin_copy")
    if marketplace_change:
        changes.append("personal_marketplace_entry")
    if with_rtk:
        changes.append("separate_global_rtk_configuration")

    plan_core = {
        "schema": INSTALLER_SCHEMA,
        "operation": operation,
        "changes": changes,
        "source": {
            "file_count": len(source_entries),
            "byte_count": source_size,
            "manifest_sha256": source_digest,
        },
        "destination": {
            "path": str(destination),
            "exists": bool(destination_snapshot["exists"]),
            "tree_sha256": str(destination_snapshot["digest"]),
        },
        "marketplace": {
            "path": str(marketplace_path),
            "exists": marketplace_before is not None,
            "before_sha256": (
                _sha256_bytes(marketplace_before)
                if marketplace_before is not None
                else None
            ),
            "before_bytes": len(marketplace_before or b""),
            "expected_sha256": _sha256_bytes(marketplace_after),
            "expected_bytes": len(marketplace_after),
        },
        "rtk": rtk_plan,
    }
    plan_hash = _canonical_digest(plan_core)
    return {
        **plan_core,
        "plan_hash": plan_hash,
        "_allowlist": allowlist,
        "_source_entries": source_entries,
        "_destination_snapshot": destination_snapshot,
        "_marketplace_before": marketplace_before,
        "_marketplace_after": marketplace_after,
        "_marketplace_payload": marketplace_payload,
        "_lock_path": lock_path,
    }


def _public_plan(plan: dict[str, object], include_plan_hash: bool = True) -> dict:
    public = {
        key: value
        for key, value in plan.items()
        if not key.startswith("_") and key != "plan_hash"
    }
    if include_plan_hash:
        public["plan_hash"] = plan["plan_hash"]
    return public


def _write_json_atomically(path: Path, payload: dict) -> None:
    _write_bytes_atomically(path, _json_bytes(payload))


def _write_bytes_atomically(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary_path = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    except BaseException:
        if _lexists(temporary_path):
            temporary_path.unlink()
        raise


def _remove_path(path: Path) -> None:
    if not _lexists(path):
        return
    if path.is_symlink() or path.is_file():
        path.unlink()
    else:
        shutil.rmtree(path)


def _verify_tree_files(
    root: Path, expected_entries: list[dict[str, object]], label: str
) -> None:
    actual_entries = _file_entries(_snapshot_tree(root))
    if actual_entries != expected_entries:
        raise InstallError(
            f"{label} byte verification failed; source or destination changed during apply"
        )


def _commit_marketplace_bytes(path: Path, payload: bytes) -> None:
    """Commit hook kept separate so tests can inject a deterministic failure."""

    _write_bytes_atomically(path, payload)


def _restore_marketplace_bytes(path: Path, original: bytes | None) -> None:
    if original is None:
        if _lexists(path):
            if path.is_dir() and not path.is_symlink():
                raise InstallError(f"Cannot restore absent marketplace over directory: {path}")
            path.unlink()
        return
    _write_bytes_atomically(path, original)


def _unique_empty_path(parent: Path, prefix: str) -> Path:
    candidate = Path(tempfile.mkdtemp(prefix=prefix, dir=parent))
    candidate.rmdir()
    return candidate


def _rollback_plugin_tree(
    destination: Path, plugin_backup: Path | None, destination_existed: bool
) -> Path | None:
    failed_tree: Path | None = None
    if _lexists(destination):
        failed_tree = _unique_empty_path(
            destination.parent, f".{destination.name}.failed-"
        )
        os.replace(destination, failed_tree)
    if destination_existed:
        if plugin_backup is None or not _lexists(plugin_backup):
            raise InstallError("The original plugin backup is unavailable")
        os.replace(plugin_backup, destination)
    if failed_tree is not None and _lexists(failed_tree):
        _remove_path(failed_tree)
    return failed_tree


def _write_transaction_journal(path: Path, journal: dict[str, object]) -> None:
    _write_json_atomically(path, journal)
    if os.environ.get("_AGENTIC_SDLC_INSTALLER_TEST_CRASH_PHASE") == journal.get(
        "phase"
    ):
        os._exit(86)


def _normalized_path(path: Path) -> str:
    return os.path.normcase(os.path.abspath(str(path)))


def _journal_path_matches(value: object, expected: Path) -> bool:
    return isinstance(value, str) and _normalized_path(Path(value)) == _normalized_path(
        expected
    )


def _tree_state(path: Path) -> tuple[bool, str]:
    snapshot = _snapshot_tree(path)
    return bool(snapshot["exists"]), str(snapshot["digest"])


def _marketplace_state(path: Path) -> tuple[bool, str | None, bytes | None]:
    payload = _read_marketplace_bytes(path)
    return (
        payload is not None,
        _sha256_bytes(payload) if payload is not None else None,
        payload,
    )


def _validated_recovery_journal(
    transaction_root: Path, destination: Path, marketplace_path: Path
) -> tuple[dict[str, object], Path | None, bytes | None]:
    if _is_link_like(transaction_root) or not transaction_root.is_dir():
        raise InstallError(
            f"Refusing linked or non-directory installer recovery path: {transaction_root}"
        )
    allowed_names = {"journal.json", "marketplace.before"}
    for entry in transaction_root.iterdir():
        is_atomic_temporary = (
            entry.name.startswith(".journal.json.")
            or entry.name.startswith(".marketplace.before.")
        ) and entry.name.endswith(".tmp")
        if (
            entry.name not in allowed_names
            and not is_atomic_temporary
        ) or _is_link_like(entry) or not entry.is_file():
            raise InstallError(
                "Unrecognized content was found beside an interrupted update. "
                f"Recovery stopped without deleting it: {entry}"
            )
    journal_path = transaction_root / "journal.json"
    if _is_link_like(journal_path) or not journal_path.is_file():
        raise InstallError(
            "An interrupted update has no readable recovery record. Nothing was "
            f"changed; preserve and inspect {transaction_root}."
        )
    try:
        journal = json.loads(journal_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise InstallError(
            "An interrupted update has an invalid recovery record. Nothing was "
            f"changed; preserve and inspect {transaction_root}: {exc}"
        ) from exc
    if not isinstance(journal, dict) or journal.get("schema") != INSTALLER_SCHEMA:
        raise InstallError(
            f"Unsupported installer recovery record in {journal_path}; nothing was changed."
        )
    if not _journal_path_matches(journal.get("destination"), destination) or not (
        _journal_path_matches(journal.get("marketplace"), marketplace_path)
    ):
        raise InstallError(
            f"Installer recovery paths do not match this home in {journal_path}; nothing was changed."
        )
    required_digests = (
        "destination_before_sha256",
        "destination_after_sha256",
        "marketplace_after_sha256",
    )
    if any(
        not isinstance(journal.get(field), str)
        or PLAN_HASH_PATTERN.fullmatch(str(journal[field])) is None
        for field in required_digests
    ):
        raise InstallError(
            f"Installer recovery digests are incomplete in {journal_path}; nothing was changed."
        )
    before_exists = journal.get("marketplace_existed")
    before_digest = journal.get("marketplace_before_sha256")
    if not isinstance(before_exists, bool) or (
        before_exists
        and (
            not isinstance(before_digest, str)
            or PLAN_HASH_PATTERN.fullmatch(before_digest) is None
        )
    ) or (not before_exists and before_digest is not None):
        raise InstallError(
            f"Marketplace recovery identity is invalid in {journal_path}; nothing was changed."
        )

    plugin_backup: Path | None = None
    raw_backup = journal.get("plugin_backup")
    if raw_backup is not None:
        if not isinstance(raw_backup, str):
            raise InstallError(f"Invalid plugin backup path in {journal_path}")
        plugin_backup = Path(raw_backup)
        expected_prefix = f".{destination.name}.backup-"
        if (
            _normalized_path(plugin_backup.parent)
            != _normalized_path(destination.parent)
            or not plugin_backup.name.startswith(expected_prefix)
            or _is_link_like(plugin_backup)
        ):
            raise InstallError(
                f"Unsafe plugin backup path in {journal_path}; nothing was changed."
            )

    marketplace_before: bytes | None = None
    backup_path = transaction_root / "marketplace.before"
    if before_exists:
        if _is_link_like(backup_path) or not backup_path.is_file():
            raise InstallError(
                f"The exact previous marketplace file is unavailable in {transaction_root}."
            )
        marketplace_before = backup_path.read_bytes()
        if _sha256_bytes(marketplace_before) != before_digest:
            raise InstallError(
                f"The previous marketplace file does not match its recovery record in {transaction_root}."
            )
    elif _lexists(backup_path):
        raise InstallError(
            f"Unexpected marketplace backup in {transaction_root}; nothing was changed."
        )
    return journal, plugin_backup, marketplace_before


def _recover_one_transaction(
    transaction_root: Path, destination: Path, marketplace_path: Path
) -> str:
    journal, plugin_backup, marketplace_before = _validated_recovery_journal(
        transaction_root, destination, marketplace_path
    )
    phase = journal.get("phase")
    allowed_phases = {
        "prepared",
        "plugin_backed_up",
        "plugin_replaced",
        "marketplace_replaced",
        "verified",
        "recovery_started",
        "rollback_needs_attention",
    }
    if phase not in allowed_phases:
        raise InstallError(
            f"Unknown interrupted-update phase {phase!r} in {transaction_root}; nothing was changed."
        )

    destination_existed = journal.get("destination_existed")
    if not isinstance(destination_existed, bool):
        raise InstallError(
            f"Invalid previous plugin state in {transaction_root}; nothing was changed."
        )
    before_tree_digest = str(journal["destination_before_sha256"])
    after_tree_digest = str(journal["destination_after_sha256"])
    marketplace_existed = bool(journal["marketplace_existed"])
    before_marketplace_digest = journal.get("marketplace_before_sha256")
    after_marketplace_digest = str(journal["marketplace_after_sha256"])

    destination_state = _tree_state(destination)
    marketplace_state = _marketplace_state(marketplace_path)
    backup_state = _tree_state(plugin_backup) if plugin_backup is not None else None

    destination_is_before = destination_state == (
        destination_existed,
        before_tree_digest,
    )
    destination_is_after = destination_state == (True, after_tree_digest)
    marketplace_is_before = marketplace_state[:2] == (
        marketplace_existed,
        before_marketplace_digest,
    )
    marketplace_is_after = marketplace_state[:2] == (True, after_marketplace_digest)

    if phase == "verified":
        if not destination_is_after or not marketplace_is_after:
            raise InstallError(
                "A completed update no longer matches its verified recovery record. "
                f"Nothing was changed; preserve {transaction_root}."
            )
        if plugin_backup is not None and _lexists(plugin_backup):
            if _tree_state(plugin_backup) != (destination_existed, before_tree_digest):
                raise InstallError(
                    f"The old plugin backup changed; preserve {plugin_backup} and {transaction_root}."
                )
            _remove_path(plugin_backup)
        if _tree_state(destination) != (True, after_tree_digest) or (
            _marketplace_state(marketplace_path)[:2]
            != (True, after_marketplace_digest)
        ):
            raise InstallError(
                f"Verified files changed during recovery; preserve {transaction_root}."
            )
        _remove_path(transaction_root)
        return "finalized_verified_update"

    allowed_destination_states = destination_is_before or destination_is_after or (
        not destination_state[0]
    )
    if not allowed_destination_states:
        raise InstallError(
            "Plugin files changed outside the interrupted update. Recovery stopped "
            f"without deleting them; preserve {transaction_root}."
        )
    if not marketplace_is_before and not marketplace_is_after:
        raise InstallError(
            "The personal Codex plugin list changed outside the interrupted update. "
            f"Recovery stopped without overwriting it; preserve {transaction_root}."
        )
    if destination_existed and not destination_is_before:
        if plugin_backup is None or backup_state != (True, before_tree_digest):
            raise InstallError(
                "The exact previous plugin files are unavailable. Recovery stopped "
                f"without deleting current files; preserve {transaction_root}."
            )
    if not destination_existed and plugin_backup is not None and _lexists(plugin_backup):
        raise InstallError(
            f"Unexpected plugin backup {plugin_backup}; recovery stopped without deleting it."
        )

    journal["phase"] = "recovery_started"
    _write_transaction_journal(transaction_root / "journal.json", journal)

    current_marketplace_state = _marketplace_state(marketplace_path)
    if current_marketplace_state[:2] not in {
        (marketplace_existed, before_marketplace_digest),
        (True, after_marketplace_digest),
    }:
        raise InstallError(
            f"The personal Codex plugin list changed during recovery; preserve {transaction_root}."
        )
    if current_marketplace_state[:2] != (
        marketplace_existed,
        before_marketplace_digest,
    ):
        _restore_marketplace_bytes(marketplace_path, marketplace_before)
    if _marketplace_state(marketplace_path)[:2] != (
        marketplace_existed,
        before_marketplace_digest,
    ):
        raise InstallError(
            f"Could not restore the exact personal Codex plugin list; preserve {transaction_root}."
        )

    current_destination_state = _tree_state(destination)
    current_destination_is_before = current_destination_state == (
        destination_existed,
        before_tree_digest,
    )
    current_destination_is_after = current_destination_state == (
        True,
        after_tree_digest,
    )
    if not (
        current_destination_is_before
        or current_destination_is_after
        or not current_destination_state[0]
    ):
        raise InstallError(
            f"Plugin files changed during recovery; preserve {transaction_root}."
        )
    if destination_existed:
        if not current_destination_is_before:
            if plugin_backup is None or _tree_state(plugin_backup) != (
                True,
                before_tree_digest,
            ):
                raise InstallError(
                    f"The previous plugin files changed during recovery; preserve {transaction_root}."
                )
            if current_destination_state[0]:
                _remove_path(destination)
            assert plugin_backup is not None
            os.replace(plugin_backup, destination)
        elif plugin_backup is not None and _lexists(plugin_backup):
            if _tree_state(plugin_backup) != (True, before_tree_digest):
                raise InstallError(
                    f"The duplicate plugin backup changed; preserve {plugin_backup}."
                )
            _remove_path(plugin_backup)
    elif current_destination_state[0]:
        _remove_path(destination)

    if _tree_state(destination) != (destination_existed, before_tree_digest):
        raise InstallError(
            f"Could not restore the exact previous plugin files; preserve {transaction_root}."
        )
    if plugin_backup is not None and _lexists(plugin_backup):
        raise InstallError(
            f"Plugin recovery left an unexpected backup; preserve {plugin_backup}."
        )
    _remove_path(transaction_root)
    return "restored_interrupted_update"


def _installer_recovery_candidates(home: Path) -> tuple[list[Path], list[Path]]:
    marketplace_parent = home / ".agents" / "plugins"
    destination_parent = home / "plugins"
    transaction_prefix = f".{PLUGIN_NAME}.transaction-"
    backup_prefix = f".{PLUGIN_NAME}.backup-"
    transactions: list[Path] = []
    backups: list[Path] = []
    if marketplace_parent.is_dir() and not _is_link_like(marketplace_parent):
        transactions = sorted(
            (
                entry
                for entry in marketplace_parent.iterdir()
                if entry.name.startswith(transaction_prefix)
            ),
            key=lambda entry: entry.name,
        )
    if destination_parent.is_dir() and not _is_link_like(destination_parent):
        backups = sorted(
            (
                entry
                for entry in destination_parent.iterdir()
                if entry.name.startswith(backup_prefix)
            ),
            key=lambda entry: entry.name,
        )
    return transactions, backups


def _recover_orphaned_transactions(home: Path) -> list[str]:
    destination = home / "plugins" / PLUGIN_NAME
    marketplace_path = home / ".agents" / "plugins" / "marketplace.json"
    lock_path = home / ".agents" / "plugins" / f".{PLUGIN_NAME}.install.lock"
    _assert_no_nested_symlinks(home, destination, "plugin destination")
    _assert_no_nested_symlinks(home, marketplace_path, "marketplace")
    _assert_no_nested_symlinks(home, lock_path, "installer lock")
    transactions, backups = _installer_recovery_candidates(home)
    if not transactions and not backups:
        return []
    if len(transactions) > 1:
        raise InstallError(
            "More than one interrupted update record exists. Recovery stopped "
            "without changing files so the records can be inspected."
        )

    actions: list[str] = []
    with _exclusive_install_lock(lock_path):
        transactions, backups = _installer_recovery_candidates(home)
        if len(transactions) > 1:
            raise InstallError(
                "More than one interrupted update record exists. Recovery stopped "
                "without changing files so the records can be inspected."
            )
        if transactions:
            actions.append(
                _recover_one_transaction(
                    transactions[0], destination, marketplace_path
                )
            )
        _, remaining_backups = _installer_recovery_candidates(home)
        if remaining_backups:
            paths = ", ".join(str(path) for path in remaining_backups)
            raise InstallError(
                "Unmatched old plugin backup files were found. Recovery stopped "
                f"without deleting them: {paths}"
            )
    return actions


def _execute_install_transaction(
    plan: dict[str, object], staging_root: Path
) -> list[str]:
    destination = Path(str(plan["destination"]["path"]))
    marketplace_path = Path(str(plan["marketplace"]["path"]))
    destination_existed = bool(plan["destination"]["exists"])
    marketplace_before = plan["_marketplace_before"]
    marketplace_after = plan["_marketplace_after"]
    source_entries = plan["_source_entries"]
    destination_snapshot = plan["_destination_snapshot"]
    staged_snapshot = _snapshot_tree(staging_root)

    transaction_root = Path(
        tempfile.mkdtemp(
            prefix=f".{PLUGIN_NAME}.transaction-", dir=marketplace_path.parent
        )
    )
    plugin_backup: Path | None = None
    journal_path = transaction_root / "journal.json"
    journal = {
        "schema": INSTALLER_SCHEMA,
        "plan_hash": plan["plan_hash"],
        "phase": "prepared",
        "destination": str(destination),
        "destination_existed": destination_existed,
        "destination_before_sha256": str(destination_snapshot["digest"]),
        "destination_after_sha256": str(staged_snapshot["digest"]),
        "marketplace": str(marketplace_path),
        "marketplace_existed": marketplace_before is not None,
        "marketplace_before_sha256": (
            _sha256_bytes(marketplace_before)
            if marketplace_before is not None
            else None
        ),
        "marketplace_after_sha256": _sha256_bytes(marketplace_after),
    }
    try:
        if marketplace_before is not None:
            _write_bytes_atomically(
                transaction_root / "marketplace.before", marketplace_before
            )
        _write_transaction_journal(journal_path, journal)
    except BaseException as exc:
        try:
            _remove_path(transaction_root)
        except OSError:
            pass
        raise InstallError(
            f"Could not prepare the local rollback journal: {exc}"
        ) from exc

    try:
        if destination_existed:
            plugin_backup = _unique_empty_path(
                destination.parent, f".{destination.name}.backup-"
            )
            journal["plugin_backup"] = str(plugin_backup)
            _write_transaction_journal(journal_path, journal)
            os.replace(destination, plugin_backup)
        journal["phase"] = "plugin_backed_up"
        _write_transaction_journal(journal_path, journal)

        os.replace(staging_root, destination)
        journal["phase"] = "plugin_replaced"
        _write_transaction_journal(journal_path, journal)
        _verify_tree_files(destination, source_entries, "Installed plugin")

        _commit_marketplace_bytes(marketplace_path, marketplace_after)
        journal["phase"] = "marketplace_replaced"
        _write_transaction_journal(journal_path, journal)
        if _read_marketplace_bytes(marketplace_path) != marketplace_after:
            raise InstallError("Marketplace byte verification failed after replacement")
        _verify_tree_files(destination, source_entries, "Installed plugin")

        journal["phase"] = "verified"
        _write_transaction_journal(journal_path, journal)
    except BaseException as transaction_error:
        rollback_errors: list[str] = []
        try:
            _restore_marketplace_bytes(marketplace_path, marketplace_before)
            if _read_marketplace_bytes(marketplace_path) != marketplace_before:
                raise InstallError("Marketplace bytes did not match the original backup")
        except BaseException as exc:
            rollback_errors.append(f"marketplace restore: {exc}")
        try:
            current_snapshot = _snapshot_tree(destination)
            original_is_untouched = (
                bool(current_snapshot["exists"])
                == bool(destination_snapshot["exists"])
                and current_snapshot["digest"] == destination_snapshot["digest"]
            )
            if not original_is_untouched:
                if destination_existed and (
                    plugin_backup is None or not _lexists(plugin_backup)
                ):
                    raise InstallError("The original plugin backup is unavailable")
                _rollback_plugin_tree(
                    destination, plugin_backup, destination_existed
                )
            restored_snapshot = _snapshot_tree(destination)
            if (
                bool(restored_snapshot["exists"])
                != bool(destination_snapshot["exists"])
                or restored_snapshot["digest"] != destination_snapshot["digest"]
            ):
                raise InstallError("Plugin files did not match the original backup")
        except BaseException as exc:
            rollback_errors.append(f"plugin restore: {exc}")

        if rollback_errors:
            journal["phase"] = "rollback_needs_attention"
            journal["rollback_errors"] = rollback_errors
            try:
                _write_transaction_journal(journal_path, journal)
            except BaseException:
                pass
            backup_hint = str(plugin_backup) if plugin_backup is not None else "none"
            raise InstallError(
                "The update failed and automatic restoration needs attention. "
                f"Keep {transaction_root} and plugin backup {backup_hint}; inspect "
                f"journal.json before changing either location. Update error: "
                f"{transaction_error}. Restoration errors: {'; '.join(rollback_errors)}"
            ) from transaction_error

        try:
            _remove_path(transaction_root)
        except OSError:
            pass
        raise InstallError(
            f"The update failed, so the original plugin and marketplace were restored: "
            f"{transaction_error}"
        ) from transaction_error

    cleanup_warnings: list[str] = []
    if plugin_backup is not None and _lexists(plugin_backup):
        try:
            _remove_path(plugin_backup)
        except OSError as exc:
            cleanup_warnings.append(
                f"Could not remove old plugin backup {plugin_backup}: {exc}"
            )
    if _lexists(transaction_root):
        if plugin_backup is not None and _lexists(plugin_backup):
            cleanup_warnings.append(
                f"Kept transaction journal {transaction_root} for deterministic cleanup"
            )
        else:
            try:
                _remove_path(transaction_root)
            except OSError as exc:
                cleanup_warnings.append(
                    f"Could not remove transaction journal {transaction_root}: {exc}"
                )
    return cleanup_warnings


def _apply_install_plan(
    repo_root: Path,
    home: Path,
    approved_plan_hash: str,
    with_rtk: bool,
    rtk_executable: str | None,
) -> tuple[dict[str, object], list[str]]:
    recovery_actions = _recover_orphaned_transactions(home)
    initial_plan = _build_install_plan(
        repo_root, home, with_rtk=with_rtk, rtk_executable=rtk_executable
    )
    if initial_plan["plan_hash"] != approved_plan_hash:
        raise InstallError(
            "The reviewed plan is no longer current. Run plan again and review the "
            f"new identifier (expected {approved_plan_hash}, current "
            f"{initial_plan['plan_hash']})."
        )

    lock_path = initial_plan["_lock_path"]
    cleanup_warnings: list[str] = [
        f"Recovered interrupted installer state: {action}"
        for action in recovery_actions
    ]
    with _exclusive_install_lock(lock_path):
        locked_plan = _build_install_plan(
            repo_root, home, with_rtk=with_rtk, rtk_executable=rtk_executable
        )
        if locked_plan["plan_hash"] != approved_plan_hash:
            raise InstallError(
                "Files changed while the installer was waiting. Nothing was replaced; "
                "run plan again and review the new result."
            )
        if locked_plan["operation"] == "noop":
            return locked_plan, cleanup_warnings

        destination = Path(str(locked_plan["destination"]["path"]))
        marketplace_path = Path(str(locked_plan["marketplace"]["path"]))
        destination.parent.mkdir(parents=True, exist_ok=True)
        marketplace_path.parent.mkdir(parents=True, exist_ok=True)
        _assert_no_nested_symlinks(home, destination, "plugin destination")
        _assert_no_nested_symlinks(home, marketplace_path, "marketplace")

        staging_root: Path | None = Path(
            tempfile.mkdtemp(
                prefix=f".{PLUGIN_NAME}.staging-", dir=destination.parent
            )
        )
        try:
            _build_staging_tree(
                repo_root,
                staging_root,
                destination,
                locked_plan["_allowlist"],
            )
            _verify_tree_files(
                staging_root, locked_plan["_source_entries"], "Staged plugin"
            )
            final_plan = _build_install_plan(
                repo_root,
                home,
                with_rtk=with_rtk,
                rtk_executable=rtk_executable,
            )
            if final_plan["plan_hash"] != approved_plan_hash:
                raise InstallError(
                    "Source or destination files changed during staging. Nothing was "
                    "replaced; run plan again."
                )
            cleanup_warnings.extend(
                _execute_install_transaction(final_plan, staging_root)
            )
            staging_root = None
            return final_plan, cleanup_warnings
        finally:
            if staging_root is not None and _lexists(staging_root):
                shutil.rmtree(staging_root, ignore_errors=True)


def _apply_command(plan: dict[str, object], locale: str, json_output: bool) -> str:
    parts = [
        sys.executable,
        "scripts/install-personal-marketplace.py",
        "apply",
        "--plan-hash",
        str(plan["plan_hash"]),
        "--home",
        str(Path(str(plan["destination"]["path"])).parents[1]),
        "--locale",
        locale,
    ]
    if bool(plan["rtk"]["enabled"]):
        parts.extend(
            [
                "--with-rtk",
                "--rtk-executable",
                str(plan["rtk"]["executable"]),
            ]
        )
    if json_output:
        parts.append("--json")
    if os.name == "nt":
        return subprocess.list2cmdline(parts)
    return " ".join(shlex.quote(part) for part in parts)


def _base_human_message(
    command: str,
    locale: str,
    plan: dict[str, object] | None = None,
    *,
    error: bool = False,
    rtk_partial_failure: bool = False,
) -> dict[str, str]:
    if locale == "it":
        if error and rtk_partial_failure:
            return {
                "outcome": (
                    "Agentic SDLC è stato aggiornato in locale, ma l’impostazione "
                    "globale facoltativa non è stata completata."
                ),
                "impact": (
                    "Puoi usare Agentic SDLC in locale. Solo l’ottimizzazione "
                    "facoltativa dei comandi potrebbe essere incompleta."
                ),
                "decision": (
                    "Scegli se correggere ora l’impostazione facoltativa oppure "
                    "rimuoverla e riprovare più tardi."
                ),
                "protection_boundary": (
                    "L’aggiornamento locale verificato resta integro. L’impostazione "
                    "globale facoltativa è separata e non può essere annullata "
                    "insieme automaticamente."
                ),
                "next_action": (
                    "Leggi l’errore e le istruzioni nella sezione facoltativa prima "
                    "di riprovare."
                ),
            }
        if error:
            return {
                "outcome": (
                    "L’operazione si è fermata perché non poteva continuare "
                    "senza rischiare i file già presenti."
                ),
                "impact": (
                    "Lo strumento non lascia intenzionalmente file aggiornati "
                    "solo a metà."
                ),
                "decision": (
                    "Correggi il problema descritto nella sezione facoltativa prima "
                    "di autorizzare un nuovo tentativo."
                ),
                "protection_boundary": (
                    "Lo strumento rifiuta percorsi collegati e contenuti che non "
                    "gestisce. Se aveva già iniziato a sostituire i file, ha tentato "
                    "di ripristinare insieme quelli originali."
                ),
                "next_action": (
                    "Dopo la correzione, genera una nuova anteprima e ricontrollala."
                ),
            }
        assert plan is not None
        needs_apply = plan["operation"] != "noop" or bool(plan["rtk"]["enabled"])
        if command == "check":
            return {
                "outcome": (
                    "Agentic SDLC è già aggiornato e pronto per l’uso locale."
                    if not needs_apply
                    else "È disponibile un aggiornamento locale per Agentic SDLC."
                ),
                "impact": (
                    "Questo controllo ha soltanto confrontato i file presenti con "
                    "quelli disponibili: non ha cambiato nulla."
                ),
                "decision": (
                    "Non è richiesta alcuna decisione."
                    if not needs_apply
                    else "Controlla l’anteprima dettagliata prima di autorizzare modifiche."
                ),
                "protection_boundary": (
                    "Il controllo non crea cartelle, non modifica file e non cambia "
                    "le impostazioni personali di Codex."
                ),
                "next_action": (
                    "Puoi continuare a usare la versione attuale."
                    if not needs_apply
                    else "Genera l’anteprima completa dell’aggiornamento e controllala."
                ),
            }
        if command == "plan":
            return {
                "outcome": (
                    "Agentic SDLC è già aggiornato e non richiede modifiche."
                    if not needs_apply
                    else "È pronto un piano sicuro e leggibile per aggiornare Agentic SDLC in locale."
                ),
                "impact": (
                    "Nessun file è stato modificato. L’aggiornamento riguarderà "
                    "solo i file locali di Agentic SDLC e la voce personale che "
                    "consente a Codex di trovarli."
                ),
                "decision": (
                    "Non è richiesta alcuna decisione."
                    if not needs_apply
                    else "Controlla le cartelle indicate nella sezione facoltativa; "
                    "se sono corrette, autorizza solo questo aggiornamento."
                ),
                "protection_boundary": (
                    "Se l’aggiornamento non riesce, i file locali e la voce "
                    "usata da Codex vengono ripristinati insieme. Le eventuali "
                    "impostazioni globali restano separate."
                ),
                "next_action": (
                    "Puoi continuare a usare la versione attuale."
                    if not needs_apply
                    else "Quando sei pronto, autorizza questo singolo aggiornamento "
                    "usando l’istruzione riportata nella sezione facoltativa."
                ),
            }
        return {
            "outcome": (
                "Agentic SDLC era già aggiornato per l’uso locale."
                if plan["operation"] == "noop"
                else "Agentic SDLC è stato aggiornato correttamente per l’uso locale."
            ),
            "impact": (
                "La copia locale verificata è pronta per essere attivata in Codex."
            ),
            "decision": "Non è richiesta un’altra decisione per questo aggiornamento.",
            "protection_boundary": (
                "I file locali e la voce usata da Codex sono stati "
                "verificati e aggiornati come un’unica modifica ripristinabile. "
                "Le impostazioni globali facoltative sono rimaste separate."
            ),
            "next_action": (
                "Ora puoi rendere questa versione locale disponibile in Codex; "
                "l’istruzione esatta è nella sezione facoltativa."
            ),
        }

    if error and rtk_partial_failure:
        return {
            "outcome": (
                "Agentic SDLC was updated locally, but the optional global setting "
                "was not completed."
            ),
            "impact": (
                "You can use Agentic SDLC locally. Only the optional command "
                "optimization may be incomplete."
            ),
            "decision": (
                "Choose whether to fix the optional setting now or remove it and "
                "try again later."
            ),
            "protection_boundary": (
                "The verified local update remains intact. The optional global "
                "setting is separate and cannot be undone with it automatically."
            ),
            "next_action": (
                "Read the error and instructions in the optional section before "
                "trying again."
            ),
        }
    if error:
        return {
            "outcome": (
                "The operation stopped because it could not continue without "
                "risking the files already present."
            ),
            "impact": "The tool does not intentionally leave files only partly updated.",
            "decision": (
                "Fix the problem described in the optional section before "
                "authorizing another attempt."
            ),
            "protection_boundary": (
                "The tool rejects linked locations and content it does not manage. "
                "If file replacement had already started, it attempted to restore "
                "the original files together."
            ),
            "next_action": (
                "After fixing the problem, create a new preview and review it again."
            ),
        }
    assert plan is not None
    needs_apply = plan["operation"] != "noop" or bool(plan["rtk"]["enabled"])
    if command == "check":
        return {
            "outcome": (
                "Agentic SDLC is up to date and ready to use locally."
                if not needs_apply
                else "A local Agentic SDLC update is available."
            ),
            "impact": (
                "This check only compared the files already present with the "
                "available files; it changed nothing."
            ),
            "decision": (
                "No decision is required."
                if not needs_apply
                else "Review the detailed preview before authorizing any changes."
            ),
            "protection_boundary": (
                "The check creates no folders, changes no files, and does not "
                "change your personal Codex settings."
            ),
            "next_action": (
                "You can keep using the current version."
                if not needs_apply
                else "Create the complete update preview and review it."
            ),
        }
    if command == "plan":
        return {
            "outcome": (
                "Agentic SDLC is already up to date and needs no changes."
                if not needs_apply
                else "A safe, readable preview of the local Agentic SDLC update is ready."
            ),
            "impact": (
                "No files were changed. The update will affect only the local "
                "Agentic SDLC files and the personal entry that lets Codex find them."
            ),
            "decision": (
                "No decision is required."
                if not needs_apply
                else "Review the folders shown in the optional section; if they "
                "are correct, authorize only this update."
            ),
            "protection_boundary": (
                "If the update fails, the local files and the entry used by Codex "
                "are restored together. Optional global settings remain separate."
            ),
            "next_action": (
                "You can keep using the current version."
                if not needs_apply
                else "When ready, authorize this one update with the instruction "
                "shown in the optional section."
            ),
        }
    return {
        "outcome": (
            "Agentic SDLC was already up to date for local use."
            if plan["operation"] == "noop"
            else "Agentic SDLC was updated successfully for local use."
        ),
        "impact": (
            "The verified local copy is ready to be enabled in Codex."
        ),
        "decision": "No further decision is required for this update.",
        "protection_boundary": (
            "The local files and the entry used by Codex were verified and updated "
            "as one restorable change. Optional global settings remained separate."
        ),
        "next_action": (
            "You can now make this local version available in Codex; the exact "
            "instruction is in the optional section."
        ),
    }


def _human_message(
    command: str,
    locale: str,
    plan: dict[str, object] | None = None,
    *,
    error: bool = False,
    rtk_partial_failure: bool = False,
    recovery_performed: bool = False,
) -> dict[str, str]:
    message = _base_human_message(
        command,
        locale,
        plan,
        error=error,
        rtk_partial_failure=rtk_partial_failure,
    )
    rtk_enabled = bool(plan is not None and plan["rtk"]["enabled"])
    if rtk_enabled and rtk_partial_failure:
        if locale == "it":
            message.update(
                {
                    "impact": (
                        "I file locali sono utilizzabili. Le istruzioni personali "
                        "globali di Codex potrebbero essere state modificate solo in parte."
                    ),
                    "decision": (
                        "Scegli se completare ora quelle istruzioni globali oppure "
                        "rimuoverle prima di riprovare."
                    ),
                    "protection_boundary": (
                        "La modifica delle istruzioni personali globali di Codex è "
                        "separata: non viene annullata quando vengono ripristinati i file locali."
                    ),
                }
            )
        else:
            message.update(
                {
                    "impact": (
                        "The local files are usable. Your global personal Codex "
                        "instructions may have been changed only partly."
                    ),
                    "decision": (
                        "Choose whether to finish those global instructions now or "
                        "remove them before trying again."
                    ),
                    "protection_boundary": (
                        "Changes to your global personal Codex instructions are "
                        "separate: restoring local files does not undo them."
                    ),
                }
            )
    elif rtk_enabled and not error:
        if locale == "it":
            if command == "check":
                message["impact"] += (
                    " Se autorizzi l’aggiornamento, verranno modificate anche le "
                    "istruzioni personali globali usate da Codex."
                )
                message["decision"] = (
                    "Decidi separatamente se vuoi modificare anche le istruzioni "
                    "personali globali di Codex."
                )
            elif command == "plan":
                message["impact"] = message["impact"].replace(
                    "L’aggiornamento riguarderà solo i file locali di Agentic SDLC "
                    "e la voce personale che consente a Codex di trovarli.",
                    "La parte locale aggiornerà i file di Agentic SDLC e la voce "
                    "personale che consente a Codex di trovarli.",
                )
                message["impact"] += (
                    " Autorizzando questa anteprima modificherai anche le istruzioni "
                    "personali globali usate da Codex."
                )
                message["decision"] += (
                    " Conferma inoltre che vuoi modificare quelle istruzioni globali."
                )
            else:
                message["impact"] += (
                    " L’operazione ha modificato anche le istruzioni personali "
                    "globali usate da Codex."
                )
            message["protection_boundary"] += (
                " La modifica delle istruzioni personali globali di Codex è "
                "separata e non viene annullata se vengono ripristinati i file locali."
            )
        else:
            if command == "check":
                message["impact"] += (
                    " If you authorize the update, it will also change the global "
                    "personal instructions Codex uses."
                )
                message["decision"] = (
                    "Decide separately whether you also want to change your global "
                    "personal Codex instructions."
                )
            elif command == "plan":
                message["impact"] = message["impact"].replace(
                    "The update will affect only the local Agentic SDLC files and "
                    "the personal entry that lets Codex find them.",
                    "The local part will update the Agentic SDLC files and the "
                    "personal entry that lets Codex find them.",
                )
                message["impact"] += (
                    " Authorizing this preview will also change the global personal "
                    "instructions Codex uses."
                )
                message["decision"] += (
                    " Also confirm that you want those global instructions changed."
                )
            else:
                message["impact"] += (
                    " This operation also changed the global personal instructions "
                    "Codex uses."
                )
            message["protection_boundary"] += (
                " Changes to your global personal Codex instructions are separate "
                "and are not undone if the local files are restored."
            )

    if recovery_performed and not error:
        if locale == "it":
            recovery_text = (
                "Prima di continuare, lo strumento ha riportato i file gestiti "
                "allo stato esatto precedente a un tentativo interrotto, senza "
                "toccare contenuti estranei."
            )
            if command == "plan" and message["impact"].startswith(
                "Nessun file è stato modificato. "
            ):
                message["impact"] = message["impact"].replace(
                    "Nessun file è stato modificato. ", "", 1
                )
        else:
            recovery_text = (
                "Before continuing, the tool restored managed files to their exact "
                "state before an interrupted attempt, without touching unrelated content."
            )
            if command == "plan" and message["impact"].startswith(
                "No files were changed. "
            ):
                message["impact"] = message["impact"].replace(
                    "No files were changed. ", "", 1
                )
        message["impact"] = f"{recovery_text} {message['impact']}"
    return message


def _emit_result(
    *,
    command: str,
    locale: str,
    json_output: bool,
    ok: bool,
    human: dict[str, str],
    data: dict | None = None,
    technical_details: dict | None = None,
) -> None:
    envelope = {
        "schema": INSTALLER_SCHEMA,
        "ok": ok,
        "command": command,
        "human": human,
        "data": data or {},
        "technical_details": technical_details or {},
    }
    if json_output:
        print(json.dumps(envelope, ensure_ascii=False, sort_keys=True))
        return

    labels = (
        {
            "outcome": "Risultato",
            "impact": "Cosa cambia in pratica",
            "decision": "Cosa devi decidere",
            "protection_boundary": "Cosa resta protetto",
            "next_action": "Prossimo passo",
            "technical": "Dettagli tecnici (facoltativi)",
        }
        if locale == "it"
        else {
            "outcome": "Outcome",
            "impact": "What this changes in practice",
            "decision": "What you need to decide",
            "protection_boundary": "What remains protected",
            "next_action": "Next step",
            "technical": "Technical details (optional)",
        }
    )
    stream = sys.stdout if ok else sys.stderr
    for key in (
        "outcome",
        "impact",
        "decision",
        "protection_boundary",
        "next_action",
    ):
        print(f"{labels[key]}: {human[key]}", file=stream)
    print(f"{labels['technical']}:", file=stream)
    print(
        json.dumps(technical_details or {}, ensure_ascii=False, indent=2, sort_keys=True),
        file=stream,
    )


def _requested_locale(argv: list[str]) -> str:
    for value in argv:
        if value.startswith("--locale="):
            inline = value.split("=", 1)[1]
            if inline in {"en", "it"}:
                return inline
    try:
        index = argv.index("--locale")
        if index + 1 < len(argv) and argv[index + 1] in {"en", "it"}:
            return argv[index + 1]
    except ValueError:
        pass
    return "en"


def _configure_utf8_output() -> None:
    """Keep redirected human and machine output deterministic on every host."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8")


def _help_message(locale: str) -> dict[str, str]:
    if locale == "it":
        return {
            "outcome": "Puoi controllare l'installazione locale, preparare un'anteprima oppure eseguire un aggiornamento già esaminato.",
            "impact": "Senza una scelta esplicita viene creata soltanto un'anteprima e nessun file viene modificato.",
            "decision": "Scegli se vuoi controllare lo stato, vedere l'anteprima o eseguire una modifica già approvata.",
            "protection_boundary": "Nessun file cambia finché non scegli l'aggiornamento finale e fornisci l'identificatore dell'anteprima esaminata.",
            "next_action": "Inizia dal controllo o dall'anteprima; usa l'aggiornamento finale solo dopo aver letto cosa cambierà.",
        }
    return {
        "outcome": "You can inspect the local installation, prepare a preview, or carry out an update you already reviewed.",
        "impact": "Without an explicit choice, only a preview is prepared and no files are changed.",
        "decision": "Choose whether to inspect the current state, view the preview, or carry out an already approved change.",
        "protection_boundary": "No files change until you choose the final update and provide the identifier of the preview you reviewed.",
        "next_action": "Start with the check or preview; use the final update only after reading what will change.",
    }


def _help_details(locale: str) -> dict[str, object]:
    if locale == "it":
        return {
            "usage": "python3 scripts/install-personal-marketplace.py [check|plan|apply] [options]",
            "commands": {
                "check": "Controlla lo stato senza modificare file.",
                "plan": "Crea l'anteprima esatta e il relativo SHA256 senza modificare file (predefinito).",
                "apply": "Esegue soltanto l'anteprima identificata da --plan-hash.",
            },
            "options": {
                "--home PATH": "Usa una directory HOME assoluta diversa.",
                "--locale en|it": "Sceglie la lingua della spiegazione principale.",
                "--json": "Restituisce un solo oggetto JSON deterministico.",
                "--with-rtk": "Configura RTK nelle istruzioni Codex globali come modifica separata.",
                "--rtk-executable PATH": "Indica l'eseguibile RTK da verificare; richiede --with-rtk.",
            },
        }
    return {
        "usage": "python3 scripts/install-personal-marketplace.py [check|plan|apply] [options]",
        "commands": {
            "check": "Inspect the current state without changing files.",
            "plan": "Create the exact preview and its SHA256 without changing files (default).",
            "apply": "Carry out only the preview identified by --plan-hash.",
        },
        "options": {
            "--home PATH": "Use a different absolute HOME directory.",
            "--locale en|it": "Select the language of the primary explanation.",
            "--json": "Return one deterministic JSON object.",
            "--with-rtk": "Configure RTK in global Codex instructions as a separate change.",
            "--rtk-executable PATH": "Select the RTK executable to verify; requires --with-rtk.",
        },
    }


def _recovery_required_message(locale: str) -> dict[str, str]:
    if locale == "it":
        return {
            "outcome": "Un aggiornamento locale interrotto deve essere risolto prima di creare una nuova anteprima.",
            "impact": "Nessun file è stato modificato; i dati trovati sono rimasti esattamente com'erano.",
            "decision": "Non devi approvare un nuovo cambiamento; serve completare o annullare in sicurezza quello già iniziato.",
            "protection_boundary": "Questo controllo non ripristina, sostituisce o elimina alcun file.",
            "next_action": "Ripeti l'aggiornamento interrotto usando lo stesso identificatore dell'anteprima già esaminata.",
        }
    return {
        "outcome": "An interrupted local update must be resolved before a new preview can be created.",
        "impact": "No files were changed; everything found was left exactly as it was.",
        "decision": "You do not need to approve a new change; the update already started must be completed or safely undone.",
        "protection_boundary": "This check does not restore, replace, or delete any files.",
        "next_action": "Repeat the interrupted update with the same identifier from the preview you already reviewed.",
    }


def main(argv: list[str] | None = None) -> int:
    _configure_utf8_output()
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    json_requested = "--json" in raw_argv
    requested_locale = _requested_locale(raw_argv)
    command = next(
        (value for value in raw_argv if value in {"check", "plan", "apply"}),
        "plan",
    )

    if "--help" in raw_argv or "-h" in raw_argv:
        _emit_result(
            command="help",
            locale=requested_locale,
            json_output=json_requested,
            ok=True,
            human=_help_message(requested_locale),
            data={"default_command": "plan", "read_only_default": True},
            technical_details=_help_details(requested_locale),
        )
        return 0

    try:
        if sys.version_info < MINIMUM_PYTHON:
            required = ".".join(str(part) for part in MINIMUM_PYTHON)
            current = ".".join(str(part) for part in sys.version_info[:3])
            raise InstallError(
                f"Python {required}+ is required; found {current}."
            )
        arguments = _parse_arguments(raw_argv)
        command = arguments.command
        requested_locale = arguments.locale
        json_requested = arguments.json
        repo_root = Path(__file__).resolve().parents[1]
        manifest = repo_root / ".codex-plugin" / "plugin.json"
        if not manifest.is_file():
            raise InstallError(f"Missing plugin manifest: {manifest}")
        home = _home_directory(arguments.home)
        recovery_actions: list[str] = []
        pending_transactions, pending_backups = _installer_recovery_candidates(home)
        if command != "apply" and (pending_transactions or pending_backups):
            _emit_result(
                command=command,
                locale=arguments.locale,
                json_output=arguments.json,
                ok=False,
                human=_recovery_required_message(arguments.locale),
                data={
                    "state": "recovery_required",
                    "files_changed": False,
                },
                technical_details={
                    "recovery_required": True,
                    "interrupted_updates": [str(item) for item in pending_transactions],
                    "unmatched_backups": [str(item) for item in pending_backups],
                    "recovery_action": "Repeat apply with the previously approved --plan-hash.",
                },
            )
            return 2
        if command == "apply":
            recovery_actions = _recover_orphaned_transactions(home)
        plan = _build_install_plan(
            repo_root,
            home,
            with_rtk=arguments.with_rtk,
            rtk_executable=arguments.rtk_executable,
        )

        if command == "check":
            human = _human_message(
                command,
                arguments.locale,
                plan,
                recovery_performed=bool(recovery_actions),
            )
            _emit_result(
                command=command,
                locale=arguments.locale,
                json_output=arguments.json,
                ok=True,
                human=human,
                data={
                    "state": (
                        "current"
                        if plan["operation"] == "noop"
                        and not bool(plan["rtk"]["enabled"])
                        else "update_available"
                    ),
                    "changes": plan["changes"],
                },
                technical_details={"inspection": _public_plan(plan, False)},
            )
            return 0

        if command == "plan":
            human = _human_message(command, arguments.locale, plan)
            technical = {
                "plan": _public_plan(plan),
                "apply_command": _apply_command(
                    plan, arguments.locale, arguments.json
                ),
                "rollback": {
                    "automatic_scope": [
                        "managed_plugin_copy",
                        "exact_previous_marketplace_bytes",
                    ],
                    "failure_guidance": (
                        "If automatic restoration cannot finish, keep the reported "
                        "transaction journal and backup paths, then inspect journal.json."
                    ),
                    "rtk_scope": "separate_global_side_effect_not_covered",
                },
                "recovery_actions": recovery_actions,
            }
            _emit_result(
                command=command,
                locale=arguments.locale,
                json_output=arguments.json,
                ok=True,
                human=human,
                data={
                    "state": (
                        "current"
                        if plan["operation"] == "noop"
                        and not bool(plan["rtk"]["enabled"])
                        else "ready_to_apply"
                    ),
                    "changes": plan["changes"],
                    "plan_hash": plan["plan_hash"],
                },
                technical_details=technical,
            )
            return 0

        applied_plan, cleanup_warnings = _apply_install_plan(
            repo_root,
            home,
            arguments.plan_hash,
            arguments.with_rtk,
            arguments.rtk_executable,
        )
        cleanup_warnings = [
            f"Recovered interrupted installer state: {action}"
            for action in recovery_actions
        ] + cleanup_warnings
        rtk_configuration: dict[str, str] | None = None
        if arguments.with_rtk:
            try:
                rtk_configuration = _configure_rtk_for_codex(
                    applied_plan["rtk"], repo_root
                )
            except (InstallError, OSError) as exc:
                human = _human_message(
                    command,
                    arguments.locale,
                    applied_plan,
                    error=True,
                    rtk_partial_failure=True,
                )
                _emit_result(
                    command=command,
                    locale=arguments.locale,
                    json_output=arguments.json,
                    ok=False,
                    human=human,
                    data={
                        "plugin_transaction": "committed",
                        "global_rtk_configuration": "failed_or_incomplete",
                    },
                    technical_details={
                        "error": str(exc),
                        "plan_hash": applied_plan["plan_hash"],
                        "inspect_command": "rtk init -g --codex --show",
                        "remove_command": "rtk init -g --codex --uninstall",
                        "cleanup_warnings": cleanup_warnings,
                    },
                )
                return 1

        human = _human_message(
            command,
            arguments.locale,
            applied_plan,
            recovery_performed=bool(recovery_actions),
        )
        marketplace_name = str(
            applied_plan["_marketplace_payload"].get(
                "name", DEFAULT_MARKETPLACE_NAME
            )
        )
        _emit_result(
            command=command,
            locale=arguments.locale,
            json_output=arguments.json,
            ok=True,
            human=human,
            data={
                "state": "current",
                "operation": applied_plan["operation"],
                "plugin_transaction": (
                    "unchanged"
                    if applied_plan["operation"] == "noop"
                    else "committed"
                ),
                "global_rtk_configuration": (
                    "configured" if rtk_configuration is not None else "not_requested"
                ),
            },
            technical_details={
                "plan_hash": applied_plan["plan_hash"],
                "destination": applied_plan["destination"]["path"],
                "marketplace": applied_plan["marketplace"]["path"],
                "codex_add_command": (
                    f"codex plugin add {PLUGIN_NAME}@{marketplace_name}"
                ),
                "rtk": rtk_configuration,
                "recovery_actions": recovery_actions,
                "cleanup_warnings": cleanup_warnings,
            },
        )
        return 0
    except (InstallError, OSError) as exc:
        human = _human_message(command, requested_locale, error=True)
        _emit_result(
            command=command,
            locale=requested_locale,
            json_output=json_requested,
            ok=False,
            human=human,
            data={"state": "stopped"},
            technical_details={
                "error": str(exc),
                "error_type": type(exc).__name__,
            },
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
