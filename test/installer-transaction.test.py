#!/usr/bin/env python3
"""Focused tests for the plan-first personal marketplace installer."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[1]
INSTALLER_PATH = REPO_ROOT / "scripts" / "install-personal-marketplace.py"
SPEC = importlib.util.spec_from_file_location("personal_marketplace_installer", INSTALLER_PATH)
assert SPEC is not None and SPEC.loader is not None
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)

INSTALLER_V2_PATH = REPO_ROOT / "scripts" / "install-personal-marketplace-v2.py"
V2_SPEC = importlib.util.spec_from_file_location(
    "personal_marketplace_installer_v2", INSTALLER_V2_PATH
)
assert V2_SPEC is not None and V2_SPEC.loader is not None
INSTALLER_V2 = importlib.util.module_from_spec(V2_SPEC)
V2_SPEC.loader.exec_module(INSTALLER_V2)


PRIMARY_INTERNAL_JARGON = re.compile(
    r"\b(?:bounded[-_ ]autonomous|checkpoint(?:ed)?|audit[-_ ]only|receipt(?:s)?|"
    r"profile(?:s)?|ceiling|plan_hash|plugin(?:s)?|lock(?:s|ed|ing)?|rollback|"
    r"backup(?:s)?|apply|plan|marketplace|schema|manifest|sha256|transaction(?:al)?)\b",
    re.IGNORECASE,
)
PRIMARY_COMMAND_TEXT = re.compile(
    r"(?:--[a-z][a-z0-9-]*|\bpython3?\b|\bcodex\s+plugin\b|\brtk\s+init\b|"
    r"scripts[/\\]|agentic-sdlc-codex-plugin)",
    re.IGNORECASE,
)

HUMAN_FIELDS = {
    "outcome",
    "impact",
    "decision",
    "protection_boundary",
    "next_action",
}


class InstallerTransactionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="installer-transaction-")
        self.root = Path(self.temporary.name)
        self.repo = self.root / "source"
        self.home = self.root / "custom-home"
        (self.repo / ".codex-plugin").mkdir(parents=True)
        (self.repo / "lib").mkdir()
        (self.repo / ".codex-plugin" / "plugin.json").write_text(
            '{"name":"fixture","version":"1.0.0"}\n', encoding="utf-8"
        )
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "one";\n', encoding="utf-8"
        )
        (self.repo / "package.json").write_text(
            json.dumps(
                {
                    "name": "fixture",
                    "version": "1.0.0",
                    "files": [".codex-plugin", "lib"],
                }
            )
            + "\n",
            encoding="utf-8",
        )
        (self.repo / "README.md").write_text("fixture\n", encoding="utf-8")
        (self.repo / "LICENSE").write_text("fixture\n", encoding="utf-8")
        self.original_capture_codex_before = INSTALLER_V2._capture_codex_before
        self.codex_reconciliation = mock.patch.object(
            INSTALLER_V2,
            "_reconcile_codex_installation",
            return_value={
                "staging_restored": True,
                "codex_reconciled": True,
                "partial_failure": False,
                "installed": True,
                "cache_path": str(self.home / ".codex" / "fixture-cache"),
                "identity": {"package_version": "1.0.0"},
            },
        )
        self.codex_target_resolution = mock.patch.object(
            INSTALLER_V2,
            "_resolve_codex_executable",
            return_value=str(Path(sys.executable).resolve()),
        )
        self.codex_before_capture = mock.patch.object(
            INSTALLER_V2,
            "_capture_codex_before",
            return_value={
                "installed": False,
                "enabled": None,
                "version": None,
                "source_path": None,
                "identity": None,
            },
        )
        self.codex_candidate_verification = mock.patch.object(
            INSTALLER_V2,
            "_verify_codex_candidate",
            return_value={
                "installed": True,
                "identity": {"package_version": "1.0.0"},
            },
        )
        self.codex_target_resolution.start()
        self.codex_before_capture.start()
        self.codex_candidate_verification.start()
        self.codex_reconciliation.start()

    def tearDown(self) -> None:
        self.codex_reconciliation.stop()
        self.codex_candidate_verification.stop()
        self.codex_before_capture.stop()
        self.codex_target_resolution.stop()
        self.temporary.cleanup()

    def plan(self):
        return INSTALLER._build_install_plan(self.repo, self.home)

    def apply(self, plan):
        return INSTALLER._apply_install_plan(
            self.repo,
            self.home,
            plan["plan_hash"],
            False,
            None,
        )

    def v2_plan(self):
        return INSTALLER_V2._build_install_plan(self.repo, self.home)

    def v2_apply(self, plan):
        return INSTALLER_V2._apply_install_plan(
            self.repo,
            self.home,
            plan["plan_hash"],
        )

    def test_plan_is_deterministic_and_strictly_read_only(self) -> None:
        first = self.plan()
        second = self.plan()

        self.assertEqual(first["plan_hash"], second["plan_hash"])
        self.assertEqual(first["operation"], "install")
        self.assertFalse(self.home.exists())

    def test_apply_requires_current_hash_and_byte_verifies_custom_home(self) -> None:
        plan = self.plan()
        applied, warnings = self.apply(plan)

        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        marketplace = self.home / ".agents" / "plugins" / "marketplace.json"
        self.assertEqual(warnings, [])
        self.assertEqual(applied["operation"], "install")
        self.assertEqual(
            (destination / "lib" / "core.mjs").read_text(encoding="utf-8"),
            'export const version = "one";\n',
        )
        self.assertEqual(
            INSTALLER._file_entries(INSTALLER._snapshot_tree(destination)),
            plan["_source_entries"],
        )
        self.assertIn(
            INSTALLER.PLUGIN_NAME,
            [entry["name"] for entry in json.loads(marketplace.read_text())["plugins"]],
        )
        self.assertFalse(
            (self.home / ".agents" / "plugins" / f".{INSTALLER.PLUGIN_NAME}.install.lock").exists()
        )

    def test_stale_plan_fails_before_creating_home(self) -> None:
        stale = self.plan()
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )

        with self.assertRaisesRegex(INSTALLER.InstallError, "no longer current"):
            self.apply(stale)
        self.assertFalse(self.home.exists())

    def test_marketplace_failure_restores_plugin_and_exact_original_bytes(self) -> None:
        self.apply(self.plan())
        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        marketplace = self.home / ".agents" / "plugins" / "marketplace.json"
        original_plugin = (destination / "lib" / "core.mjs").read_bytes()
        original_marketplace = (
            b'{\n  "name": "personal",\n  "interface": {"displayName": "My plugins"},\n'
            b'  "plugins": [],\n  "custom": "preserve exact formatting"\n}\n'
        )
        marketplace.write_bytes(original_marketplace)
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )
        update = self.plan()

        with mock.patch.object(
            INSTALLER,
            "_commit_marketplace_bytes",
            side_effect=OSError("deterministic injected marketplace failure"),
        ):
            with self.assertRaisesRegex(
                INSTALLER.InstallError, "original plugin and marketplace were restored"
            ):
                self.apply(update)

        self.assertEqual(
            (destination / "lib" / "core.mjs").read_bytes(), original_plugin
        )
        self.assertEqual(marketplace.read_bytes(), original_marketplace)
        self.assertEqual(
            list((self.home / "plugins").glob(f".{INSTALLER.PLUGIN_NAME}.backup-*")),
            [],
        )
        self.assertEqual(
            list(
                (self.home / ".agents" / "plugins").glob(
                    f".{INSTALLER.PLUGIN_NAME}.transaction-*"
                )
            ),
            [],
        )

    def test_post_commit_verification_failure_restores_both_locations(self) -> None:
        self.apply(self.plan())
        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        marketplace = self.home / ".agents" / "plugins" / "marketplace.json"
        original_plugin = (destination / "lib" / "core.mjs").read_bytes()
        original_marketplace = marketplace.read_bytes()
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )
        update = self.plan()
        original_verify = INSTALLER._verify_tree_files
        installed_verifications = 0

        def fail_after_marketplace(root, expected, label):
            nonlocal installed_verifications
            original_verify(root, expected, label)
            if label == "Installed plugin":
                installed_verifications += 1
                if installed_verifications == 2:
                    raise INSTALLER.InstallError(
                        "deterministic injected final verification failure"
                    )

        with mock.patch.object(
            INSTALLER, "_verify_tree_files", side_effect=fail_after_marketplace
        ):
            with self.assertRaisesRegex(
                INSTALLER.InstallError, "original plugin and marketplace were restored"
            ):
                self.apply(update)

        self.assertEqual(
            (destination / "lib" / "core.mjs").read_bytes(), original_plugin
        )
        self.assertEqual(marketplace.read_bytes(), original_marketplace)

    def test_concurrent_apply_allows_one_update_and_rejects_stale_peer(self) -> None:
        self.apply(self.plan())
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )
        update = self.plan()
        barrier = threading.Barrier(2)
        outcomes: list[str] = []

        def worker() -> None:
            barrier.wait()
            try:
                self.apply(update)
                outcomes.append("applied")
            except INSTALLER.InstallError:
                outcomes.append("stale")

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)

        self.assertFalse(
            any(thread.is_alive() for thread in threads),
            "a concurrent apply is still waiting for the installer lock",
        )
        self.assertEqual(sorted(outcomes), ["applied", "stale"])
        self.assertEqual(
            (
                self.home
                / "plugins"
                / INSTALLER.PLUGIN_NAME
                / "lib"
                / "core.mjs"
            ).read_text(encoding="utf-8"),
            'export const version = "two";\n',
        )

    def test_old_lock_is_not_reclaimed_while_its_owner_is_alive(self) -> None:
        lock_path = (
            self.home
            / ".agents"
            / "plugins"
            / f".{INSTALLER.PLUGIN_NAME}.install.lock"
        )
        lock_path.parent.mkdir(parents=True)
        owner = {
            "pid": os.getpid(),
            "nonce": "active-owner",
            "created_at": 1,
        }
        lock_path.write_text(json.dumps(owner), encoding="utf-8")
        os.utime(lock_path, (1, 1))

        with mock.patch.object(INSTALLER, "INSTALL_LOCK_WAIT_SECONDS", 0.01):
            with self.assertRaisesRegex(
                INSTALLER.InstallError,
                "Timed out waiting for installer lock",
            ):
                with INSTALLER._exclusive_install_lock(lock_path):
                    self.fail("a live process must retain its installer lock")

        self.assertEqual(json.loads(lock_path.read_text(encoding="utf-8")), owner)

    def test_lock_release_survives_a_peer_reading_the_lock(self) -> None:
        # Windows refuses to delete a file while a waiting peer has it open to
        # check the owner. Release must still complete so the peer can proceed.
        lock_path = (
            self.home
            / ".agents"
            / "plugins"
            / f".{INSTALLER.PLUGIN_NAME}.install.lock"
        )
        original_unlink = Path.unlink
        denied: list[Path] = []

        def unlink_denied_once(path, *args, **kwargs):
            if path == lock_path and not denied:
                denied.append(path)
                raise PermissionError(13, "file in use by another process", str(path))
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(
            INSTALLER, "_lock_access_denial_is_transient", return_value=True
        ), mock.patch.object(
            Path, "unlink", autospec=True, side_effect=unlink_denied_once
        ):
            with INSTALLER._exclusive_install_lock(lock_path):
                pass

        self.assertEqual(denied, [lock_path])
        self.assertFalse(lock_path.exists())
        with mock.patch.object(INSTALLER, "INSTALL_LOCK_WAIT_SECONDS", 0.01):
            with INSTALLER._exclusive_install_lock(lock_path):
                pass

    def test_lock_release_failure_is_reported_instead_of_leaking_the_lock(self) -> None:
        lock_path = (
            self.home
            / ".agents"
            / "plugins"
            / f".{INSTALLER.PLUGIN_NAME}.install.lock"
        )
        with mock.patch.object(
            INSTALLER, "_lock_access_denial_is_transient", return_value=False
        ), mock.patch.object(
            Path, "unlink", side_effect=PermissionError(13, "denied")
        ):
            with self.assertRaisesRegex(
                INSTALLER.InstallError, "Could not release installer lock"
            ):
                with INSTALLER._exclusive_install_lock(lock_path):
                    pass

    def test_lock_acquire_waits_while_a_released_lock_is_being_deleted(self) -> None:
        # Windows denies creating a file whose previous copy is still pending
        # deletion; that is contention, not a permanent failure.
        lock_path = (
            self.home
            / ".agents"
            / "plugins"
            / f".{INSTALLER.PLUGIN_NAME}.install.lock"
        )
        original_open = os.open
        denied: list[str] = []

        def open_denied_once(path, *args, **kwargs):
            if os.fspath(path) == os.fspath(lock_path) and not denied:
                denied.append(os.fspath(path))
                raise PermissionError(13, "delete pending", os.fspath(path))
            return original_open(path, *args, **kwargs)

        with mock.patch.object(
            INSTALLER, "_lock_access_denial_is_transient", return_value=True
        ), mock.patch.object(INSTALLER.os, "open", side_effect=open_denied_once):
            with INSTALLER._exclusive_install_lock(lock_path):
                self.assertTrue(lock_path.is_file())

        self.assertEqual(denied, [os.fspath(lock_path)])
        self.assertFalse(lock_path.exists())

    def test_unmanaged_and_linked_destinations_fail_closed(self) -> None:
        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        destination.mkdir(parents=True)
        (destination / "unmanaged.txt").write_text("keep\n", encoding="utf-8")
        with self.assertRaisesRegex(INSTALLER.InstallError, "unexpected unmanaged"):
            self.plan()

        if os.name != "nt":
            linked_home = self.root / "linked-home"
            external = self.root / "external-plugins"
            external.mkdir()
            linked_home.mkdir()
            (linked_home / "plugins").symlink_to(external, target_is_directory=True)
            with self.assertRaisesRegex(INSTALLER.InstallError, "symlinked or junction"):
                INSTALLER._build_install_plan(self.repo, linked_home)

    def test_rtk_identity_changes_the_exact_plan(self) -> None:
        with mock.patch.object(
            INSTALLER,
            "_inspect_rtk_plan",
            return_value={
                "enabled": True,
                "transactional": False,
                "executable": "/tools/rtk",
                "version": "0.43.0",
                "binary_sha256": "a" * 64,
                "binary_bytes": 10,
            },
        ):
            first = INSTALLER._build_install_plan(
                self.repo, self.home, with_rtk=True
            )
        with mock.patch.object(
            INSTALLER,
            "_inspect_rtk_plan",
            return_value={
                "enabled": True,
                "transactional": False,
                "executable": "/tools/rtk",
                "version": "0.44.0",
                "binary_sha256": "b" * 64,
                "binary_bytes": 11,
            },
        ):
            second = INSTALLER._build_install_plan(
                self.repo, self.home, with_rtk=True
            )
        self.assertNotEqual(first["plan_hash"], second["plan_hash"])

    def test_rtk_binary_drift_stops_before_any_global_command(self) -> None:
        executable = self.root / ("rtk.cmd" if os.name == "nt" else "rtk")
        approved_bytes = b"approved RTK executable bytes\n"
        executable.write_bytes(approved_bytes)
        if os.name != "nt":
            executable.chmod(0o755)
        rtk_plan = {
            "enabled": True,
            "transactional": False,
            "executable": str(executable),
            "version": "0.43.0",
            "binary_sha256": INSTALLER._sha256_bytes(approved_bytes),
            "binary_bytes": len(approved_bytes),
        }
        executable.write_bytes(b"different bytes after review\n")

        with mock.patch.object(INSTALLER, "_run_rtk_command") as invoked:
            with self.assertRaisesRegex(
                INSTALLER.InstallError,
                "changed after the reviewed preview",
            ):
                INSTALLER._configure_rtk_for_codex(rtk_plan, self.repo)
        invoked.assert_not_called()

    def test_rtk_consent_is_explicit_and_plain_in_english_and_italian(self) -> None:
        plan = {"operation": "install", "rtk": {"enabled": True}}
        expectations = {
            "en": (
                r"global personal (?:instructions Codex|Codex instructions)",
                r"separate",
                r"(?:not undone|does not undo)",
            ),
            "it": (
                r"istruzioni personali globali (?:usate da Codex|di Codex)",
                r"separata",
                r"non (?:viene|vengono) annullat[ae]",
            ),
        }
        for locale, patterns in expectations.items():
            for command in ("check", "plan", "apply"):
                message = INSTALLER._human_message(command, locale, plan)
                primary = "\n".join(message.values())
                for pattern in patterns:
                    self.assertRegex(primary, pattern)
                self.assertNotRegex(primary, PRIMARY_INTERNAL_JARGON)
                self.assertNotRegex(primary, PRIMARY_COMMAND_TEXT)

    def test_plan_preserves_crash_state_and_apply_recovers_before_updating(self) -> None:
        crash_repo = self.root / "crash-source"
        shutil.copytree(self.repo, crash_repo)
        (crash_repo / "scripts").mkdir()
        shutil.copy2(
            INSTALLER_PATH,
            crash_repo / "scripts" / "install-personal-marketplace.py",
        )
        crash_home = self.root / "crash-home"
        copied_installer = crash_repo / "scripts" / "install-personal-marketplace.py"

        def invoke(arguments, *, crash_phase=None):
            environment = dict(os.environ)
            environment["HOME"] = str(crash_home)
            if crash_phase is not None:
                environment[
                    "_AGENTIC_SDLC_INSTALLER_TEST_CRASH_PHASE"
                ] = crash_phase
            return subprocess.run(
                [sys.executable, str(copied_installer), *arguments],
                cwd=str(crash_repo),
                env=environment,
                capture_output=True,
                encoding="utf-8",
                timeout=20,
                check=False,
            )

        initial_plan_result = invoke(
            ["plan", "--json", "--home", str(crash_home)]
        )
        self.assertEqual(initial_plan_result.returncode, 0, initial_plan_result.stderr)
        initial_hash = json.loads(initial_plan_result.stdout)["data"]["plan_hash"]
        initial_apply = invoke(
            [
                "apply",
                "--json",
                "--plan-hash",
                initial_hash,
                "--home",
                str(crash_home),
            ]
        )
        self.assertEqual(initial_apply.returncode, 0, initial_apply.stderr)

        destination = crash_home / "plugins" / INSTALLER.PLUGIN_NAME
        marketplace = crash_home / ".agents" / "plugins" / "marketplace.json"
        original_plugin = (destination / "lib" / "core.mjs").read_bytes()
        (crash_repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )
        update_plan_result = invoke(
            ["plan", "--json", "--home", str(crash_home)]
        )
        self.assertEqual(update_plan_result.returncode, 0, update_plan_result.stderr)
        update_hash = json.loads(update_plan_result.stdout)["data"]["plan_hash"]
        crashed = invoke(
            [
                "apply",
                "--json",
                "--plan-hash",
                update_hash,
                "--home",
                str(crash_home),
            ],
            crash_phase="plugin_replaced",
        )
        self.assertEqual(crashed.returncode, 86)

        unmanaged = destination / "unmanaged-after-crash.txt"
        unmanaged.write_text("preserve me\n", encoding="utf-8")
        interrupted_plugin_bytes = {
            str(item.relative_to(destination)): item.read_bytes()
            for item in destination.rglob("*")
            if item.is_file()
        }
        interrupted_marketplace_bytes = marketplace.read_bytes()
        refused = invoke(["plan", "--json", "--home", str(crash_home)])
        self.assertNotEqual(refused.returncode, 0)
        refused_envelope = json.loads(refused.stdout)
        self.assertEqual(refused_envelope["data"]["state"], "recovery_required")
        self.assertFalse(refused_envelope["data"]["files_changed"])
        self.assertTrue(refused_envelope["technical_details"]["recovery_required"])
        self.assertEqual(unmanaged.read_text(encoding="utf-8"), "preserve me\n")
        self.assertEqual(
            {
                str(item.relative_to(destination)): item.read_bytes()
                for item in destination.rglob("*")
                if item.is_file()
            },
            interrupted_plugin_bytes,
        )
        self.assertEqual(marketplace.read_bytes(), interrupted_marketplace_bytes)
        self.assertTrue(
            list(
                (crash_home / ".agents" / "plugins").glob(
                    f".{INSTALLER.PLUGIN_NAME}.transaction-*"
                )
            )
        )

        unmanaged.unlink()
        pending = invoke(["plan", "--json", "--home", str(crash_home)])
        self.assertNotEqual(pending.returncode, 0)
        self.assertEqual(json.loads(pending.stdout)["data"]["state"], "recovery_required")
        recovered = invoke(
            [
                "apply",
                "--json",
                "--plan-hash",
                update_hash,
                "--home",
                str(crash_home),
            ]
        )
        self.assertEqual(recovered.returncode, 0, recovered.stderr)
        recovered_envelope = json.loads(recovered.stdout)
        self.assertEqual(
            recovered_envelope["technical_details"]["recovery_actions"],
            ["restored_interrupted_update"],
        )
        self.assertEqual(
            (destination / "lib" / "core.mjs").read_text(encoding="utf-8"),
            'export const version = "two";\n',
        )
        self.assertNotEqual(
            (destination / "lib" / "core.mjs").read_bytes(), original_plugin
        )
        self.assertTrue(marketplace.is_file())
        self.assertEqual(
            list(
                (crash_home / ".agents" / "plugins").glob(
                    f".{INSTALLER.PLUGIN_NAME}.transaction-*"
                )
            ),
            [],
        )
        self.assertEqual(
            list(
                (crash_home / "plugins").glob(
                    f".{INSTALLER.PLUGIN_NAME}.backup-*"
                )
            ),
            [],
        )

    def test_help_is_bilingual_human_first_and_keeps_commands_secondary(self) -> None:
        labels = {
            "en": "Technical details (optional):",
            "it": "Dettagli tecnici (facoltativi):",
        }
        for locale, divider in labels.items():
            result = subprocess.run(
                [sys.executable, str(INSTALLER_PATH), "--help", "--locale", locale],
                cwd=str(REPO_ROOT),
                capture_output=True,
                encoding="utf-8",
                env={**os.environ, "PYTHONIOENCODING": "cp1252"},
                timeout=20,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            primary, technical = result.stdout.split(divider, 1)
            self.assertNotRegex(primary, PRIMARY_INTERNAL_JARGON)
            self.assertNotRegex(primary, PRIMARY_COMMAND_TEXT)
            self.assertIn("--plan-hash", technical)
            self.assertIn("SHA256", technical)
            self.assertIn("HOME", technical)
            self.assertIn("RTK", technical)
            if locale == "it":
                self.assertIn("Risultato:", primary)
                self.assertIn("Cosa devi decidere:", primary)
            else:
                self.assertIn("Outcome:", primary)
                self.assertIn("What you need to decide:", primary)

        machine = subprocess.run(
            [sys.executable, str(INSTALLER_PATH), "--help", "--locale=it", "--json"],
            cwd=str(REPO_ROOT),
            capture_output=True,
            encoding="utf-8",
            timeout=20,
            check=False,
        )
        self.assertEqual(machine.returncode, 0, machine.stderr)
        payload = json.loads(machine.stdout)
        self.assertEqual(payload["command"], "help")
        self.assertIn("Puoi controllare", payload["human"]["outcome"])

    def test_json_envelope_and_italian_primary_text_are_human_first(self) -> None:
        json_home = self.root / "json-home"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = INSTALLER.main(
                ["plan", "--home", str(json_home), "--json"]
            )
        lines = stdout.getvalue().splitlines()
        self.assertEqual(status, 0)
        self.assertEqual(len(lines), 1)
        envelope = json.loads(lines[0])
        self.assertEqual(envelope["schema"], INSTALLER.INSTALLER_SCHEMA)
        self.assertEqual(set(envelope["human"]), HUMAN_FIELDS)
        self.assertFalse(json_home.exists())

        check_home = self.root / "check-home"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = INSTALLER.main(
                ["check", "--home", str(check_home), "--json"]
            )
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(stdout.getvalue())["command"], "check")
        self.assertFalse(check_home.exists())

        human_home = self.root / "human-home"
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            status = INSTALLER.main(
                ["plan", "--home", str(human_home), "--locale", "it"]
            )
        self.assertEqual(status, 0)
        primary, divider, technical = stdout.getvalue().partition(
            "Dettagli tecnici (facoltativi):"
        )
        self.assertTrue(divider)
        for label in (
            "Risultato",
            "Cosa cambia in pratica",
            "Cosa devi decidere",
            "Cosa resta protetto",
            "Prossimo passo",
        ):
            self.assertIn(f"{label}:", primary)
        self.assertNotRegex(primary, PRIMARY_INTERNAL_JARGON)
        self.assertNotRegex(primary, PRIMARY_COMMAND_TEXT)
        self.assertIn("plan_hash", technical)
        self.assertFalse(human_home.exists())

    def test_all_primary_messages_hide_internal_jargon_and_commands(self) -> None:
        update = {"operation": "install", "rtk": {"enabled": False}}
        current = {"operation": "noop", "rtk": {"enabled": False}}

        for locale in ("en", "it"):
            messages = [
                INSTALLER._human_message(command, locale, plan)
                for command in ("check", "plan", "apply")
                for plan in (update, current)
            ]
            messages.extend(
                (
                    INSTALLER._human_message("apply", locale, error=True),
                    INSTALLER._human_message(
                        "apply", locale, error=True, rtk_partial_failure=True
                    ),
                )
            )
            for message in messages:
                self.assertEqual(set(message), HUMAN_FIELDS)
                primary = "\n".join(message.values())
                self.assertNotRegex(primary, PRIMARY_INTERNAL_JARGON)
                self.assertNotRegex(primary, PRIMARY_COMMAND_TEXT)

    def test_rendered_messages_use_exact_progressive_disclosure_labels(self) -> None:
        plan = {"operation": "install", "rtk": {"enabled": False}}
        expectations = {
            "en": (
                "Technical details (optional):",
                (
                    "Outcome",
                    "What this changes in practice",
                    "What you need to decide",
                    "What remains protected",
                    "Next step",
                ),
            ),
            "it": (
                "Dettagli tecnici (facoltativi):",
                (
                    "Risultato",
                    "Cosa cambia in pratica",
                    "Cosa devi decidere",
                    "Cosa resta protetto",
                    "Prossimo passo",
                ),
            ),
        }
        command = (
            "python3 scripts/install-personal-marketplace.py apply "
            f"--plan-hash {'a' * 64}"
        )

        for locale, (divider, labels) in expectations.items():
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                INSTALLER._emit_result(
                    command="plan",
                    locale=locale,
                    json_output=False,
                    ok=True,
                    human=INSTALLER._human_message("plan", locale, plan),
                    technical_details={"apply_command": command},
                )
            primary, found_divider, technical = stdout.getvalue().partition(divider)
            self.assertEqual(found_divider, divider)
            for label in labels:
                self.assertIn(f"{label}:", primary)
            self.assertNotRegex(primary, PRIMARY_INTERNAL_JARGON)
            self.assertNotRegex(primary, PRIMARY_COMMAND_TEXT)
            self.assertIn(command, technical)

    def test_relative_home_and_missing_apply_hash_are_rejected(self) -> None:
        self.assertEqual(INSTALLER._parse_arguments([]).command, "plan")
        with self.assertRaisesRegex(INSTALLER.InstallError, "absolute path"):
            INSTALLER._home_directory("relative/home")
        with self.assertRaisesRegex(INSTALLER.InstallError, "requires --plan-hash"):
            INSTALLER._parse_arguments(["apply"])

        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = INSTALLER.main(["apply", "--json"])
        self.assertEqual(status, 1)
        self.assertEqual(stderr.getvalue(), "")
        self.assertEqual(len(stdout.getvalue().splitlines()), 1)
        self.assertFalse(json.loads(stdout.getvalue())["ok"])

    def test_v2_apply_waits_for_validation_and_confirm_is_idempotent(self) -> None:
        legacy = self.plan()
        plan = self.v2_plan()

        self.assertNotEqual(plan["plan_hash"], legacy["plan_hash"])
        self.assertEqual(plan["protocol"], "v2")
        self.assertTrue(plan["validation_required"])
        self.assertFalse(self.home.exists())

        applied, pending = self.v2_apply(plan)
        self.assertEqual(applied["plan_hash"], plan["plan_hash"])
        self.assertEqual(pending["phase"], "validation_pending")
        self.assertRegex(pending["receipt_hash"], r"^[0-9a-f]{64}$")
        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        provenance = json.loads(
            (
                destination
                / INSTALLER_V2.BUILD_PROVENANCE_RELATIVE_PATH
            ).read_text(encoding="utf-8")
        )
        self.assertEqual(
            provenance["build_fingerprint"],
            plan["build_identity"]["build_fingerprint"],
        )
        self.assertEqual(
            provenance["package_version"],
            plan["build_identity"]["package_version"],
        )
        self.assertEqual(provenance["source_git_commit"], None)
        self.assertEqual(provenance["source_git_dirty"], None)
        self.assertEqual(
            INSTALLER._file_entries(INSTALLER._snapshot_tree(destination)),
            plan["_source_entries"],
        )
        self.assertEqual(
            INSTALLER_V2._validate_install(
                self.home,
                pending["transaction_id"],
                pending["receipt_hash"],
            )["phase"],
            "validation_pending",
        )

        _, retried = self.v2_apply(plan)
        self.assertEqual(retried["transaction_id"], pending["transaction_id"])
        self.assertEqual(retried["receipt_hash"], pending["receipt_hash"])

        confirmed = INSTALLER_V2._confirm_install(
            self.home,
            pending["transaction_id"],
            pending["receipt_hash"],
        )
        self.assertEqual(confirmed["phase"], "confirmed")
        self.assertFalse(
            INSTALLER_V2._marketplace_backup_path(self.home).exists()
        )
        self.assertEqual(
            INSTALLER_V2._confirm_install(
                self.home,
                pending["transaction_id"],
                pending["receipt_hash"],
            )["receipt_hash"],
            confirmed["receipt_hash"],
        )
        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "already confirmed"):
            INSTALLER_V2._restore_install(
                self.home,
                pending["transaction_id"],
                pending["receipt_hash"],
            )

    def test_v2_concurrent_apply_converges_on_one_pending_transaction(self) -> None:
        plan = self.v2_plan()
        barrier = threading.Barrier(2)
        outcomes = []
        failures = []

        def worker():
            barrier.wait()
            try:
                _, receipt = self.v2_apply(plan)
                outcomes.append(
                    (receipt["transaction_id"], receipt["receipt_hash"], receipt["phase"])
                )
            except BaseException as exc:
                failures.append(exc)

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=20)

        self.assertEqual(failures, [])
        self.assertEqual(len(outcomes), 2)
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[0][2], "validation_pending")

    def test_v2_apply_waits_out_the_atomic_receipt_creation_window(self) -> None:
        missing = INSTALLER_V2.InstallError("receipt creation is still in progress")
        with (
            mock.patch.object(
                INSTALLER_V2,
                "_read_receipt",
                side_effect=[missing, None],
            ) as receipt_reader,
            mock.patch.object(
                INSTALLER_V2.V1,
                "_exclusive_install_lock",
                return_value=contextlib.nullcontext(),
            ) as installer_lock,
        ):
            self.assertIsNone(INSTALLER_V2._read_receipt_for_apply(self.home))

        self.assertEqual(receipt_reader.call_count, 2)
        installer_lock.assert_called_once_with(INSTALLER_V2._lock_path(self.home))

    def test_v2_restore_is_byte_exact_and_allows_a_new_reviewed_attempt(self) -> None:
        self.apply(self.plan())
        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        marketplace = self.home / ".agents" / "plugins" / "marketplace.json"
        original_tree = INSTALLER._snapshot_tree(destination)
        original_marketplace = (
            b'{\n  "name": "personal",\n  "plugins": [],\n'
            b'  "custom": "preserve byte-for-byte"\n}\n'
        )
        marketplace.write_bytes(original_marketplace)
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )
        plan = self.v2_plan()
        _, pending = self.v2_apply(plan)

        self.assertNotEqual(INSTALLER._snapshot_tree(destination), original_tree)
        self.assertTrue(Path(pending["plugin_backup"]).is_dir())
        restored = INSTALLER_V2._restore_install(
            self.home,
            pending["transaction_id"],
            pending["receipt_hash"],
        )
        self.assertEqual(restored["phase"], "restored")
        self.assertEqual(INSTALLER._snapshot_tree(destination), original_tree)
        self.assertEqual(marketplace.read_bytes(), original_marketplace)
        self.assertEqual(
            INSTALLER_V2._restore_install(
                self.home,
                pending["transaction_id"],
                pending["receipt_hash"],
            )["receipt_hash"],
            restored["receipt_hash"],
        )

        next_plan = self.v2_plan()
        self.assertNotEqual(next_plan["plan_hash"], plan["plan_hash"])
        self.assertEqual(
            next_plan["prior_transaction"]["receipt_hash"],
            restored["receipt_hash"],
        )
        _, next_pending = self.v2_apply(next_plan)
        self.assertNotEqual(next_pending["transaction_id"], pending["transaction_id"])

    def test_v2_legacy_active_receipt_restores_local_bytes_without_guessing_codex_state(
        self,
    ) -> None:
        self.apply(self.plan())
        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        marketplace = self.home / ".agents" / "plugins" / "marketplace.json"
        original_tree = INSTALLER._snapshot_tree(destination)
        original_marketplace = marketplace.read_bytes()
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "legacy-pending";\n',
            encoding="utf-8",
        )
        _, pending = self.v2_apply(self.v2_plan())
        legacy = json.loads(json.dumps(pending))
        legacy["schema"] = INSTALLER_V2.LEGACY_RECEIPT_SCHEMA
        legacy.pop("codex_target")
        legacy.pop("codex_before")
        legacy["receipt_hash"] = INSTALLER_V2._canonical_receipt_hash(legacy)
        INSTALLER_V2._receipt_path(self.home).write_bytes(
            INSTALLER_V2.V1._json_bytes(legacy)
        )

        with self.assertRaisesRegex(
            INSTALLER_V2.InstallError,
            "active legacy update record cannot be resumed",
        ):
            INSTALLER_V2._apply_install_plan(
                self.repo,
                self.home,
                legacy["plan_hash"],
            )
        with self.assertRaisesRegex(
            INSTALLER_V2.InstallError,
            "legacy update record.*Confirmation is blocked",
        ):
            INSTALLER_V2._confirm_install(
                self.home,
                legacy["transaction_id"],
                legacy["receipt_hash"],
            )
        self.assertTrue(Path(str(legacy["plugin_backup"])).is_dir())

        with self.assertRaisesRegex(
            INSTALLER_V2.InstallError,
            "exact local files.*restored.*predates Codex-state binding",
        ):
            INSTALLER_V2._restore_install(
                self.home,
                legacy["transaction_id"],
                legacy["receipt_hash"],
            )
        self.assertEqual(INSTALLER._snapshot_tree(destination), original_tree)
        self.assertEqual(marketplace.read_bytes(), original_marketplace)
        recovered = INSTALLER_V2._read_receipt(self.home)
        self.assertEqual(recovered["schema"], INSTALLER_V2.LEGACY_RECEIPT_SCHEMA)
        self.assertEqual(recovered["phase"], "restore_reconciliation_pending")

    def test_v2_legacy_terminal_receipt_remains_readable(self) -> None:
        _, pending = self.v2_apply(self.v2_plan())
        confirmed = INSTALLER_V2._confirm_install(
            self.home,
            pending["transaction_id"],
            pending["receipt_hash"],
        )
        legacy = json.loads(json.dumps(confirmed))
        legacy["schema"] = INSTALLER_V2.LEGACY_RECEIPT_SCHEMA
        legacy.pop("codex_target")
        legacy.pop("codex_before")
        legacy["receipt_hash"] = INSTALLER_V2._canonical_receipt_hash(legacy)
        INSTALLER_V2._receipt_path(self.home).write_bytes(
            INSTALLER_V2.V1._json_bytes(legacy)
        )

        validated = INSTALLER_V2._validate_install(
            self.home,
            legacy["transaction_id"],
            legacy["receipt_hash"],
        )
        self.assertEqual(validated["phase"], "confirmed")
        self.assertEqual(
            INSTALLER_V2._confirm_install(
                self.home,
                legacy["transaction_id"],
                legacy["receipt_hash"],
            )["receipt_hash"],
            legacy["receipt_hash"],
        )

    def test_v2_drift_and_linked_state_fail_closed(self) -> None:
        plan = self.v2_plan()
        _, pending = self.v2_apply(plan)
        installed = (
            self.home
            / "plugins"
            / INSTALLER.PLUGIN_NAME
            / "lib"
            / "core.mjs"
        )
        installed.write_text("changed after apply\n", encoding="utf-8")

        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "changed after apply"):
            INSTALLER_V2._validate_install(
                self.home,
                pending["transaction_id"],
                pending["receipt_hash"],
            )
        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "changed after apply"):
            INSTALLER_V2._restore_install(
                self.home,
                pending["transaction_id"],
                pending["receipt_hash"],
            )
        self.assertEqual(installed.read_text(encoding="utf-8"), "changed after apply\n")
        self.assertEqual(
            INSTALLER_V2._read_receipt(self.home)["phase"],
            "validation_pending",
        )

        if os.name != "nt":
            linked_home = self.root / "v2-linked-home"
            linked_root = self.root / "external-v2-state"
            linked_root.mkdir()
            (linked_root / "sentinel.txt").write_text("keep\n", encoding="utf-8")
            state_parent = linked_home / ".agents" / "plugins"
            state_parent.mkdir(parents=True)
            state_parent.joinpath(f".{INSTALLER.PLUGIN_NAME}.install-v2").symlink_to(
                linked_root, target_is_directory=True
            )
            with self.assertRaisesRegex(INSTALLER_V2.InstallError, "linked"):
                INSTALLER_V2._build_install_plan(self.repo, linked_home)
            self.assertEqual(
                (linked_root / "sentinel.txt").read_text(encoding="utf-8"),
                "keep\n",
            )

    def test_v2_rejects_linked_codex_cache_ancestor_before_apply(self) -> None:
        if os.name == "nt":
            self.skipTest("symlink semantics are platform-specific")
        codex_home = self.home / ".codex"
        plugins_root = codex_home / "plugins"
        plugins_root.mkdir(parents=True)
        external_cache = self.root / "external-codex-cache"
        external_cache.mkdir()
        sentinel = external_cache / "sentinel.txt"
        sentinel.write_text("preserve\n", encoding="utf-8")
        (plugins_root / "cache").symlink_to(external_cache, target_is_directory=True)

        with self.assertRaisesRegex(
            INSTALLER_V2.InstallError,
            "Codex plugin cache.*symlink|symlinked.*Codex plugin cache",
        ):
            self.v2_apply(self.v2_plan())

        self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve\n")
        self.assertIsNone(INSTALLER_V2._read_receipt(self.home))
        self.assertFalse(
            (self.home / "plugins" / INSTALLER.PLUGIN_NAME).exists()
        )

    def test_v2_rejects_orphaned_codex_cache_before_apply(self) -> None:
        codex_home = self.home / ".codex"
        orphaned_version = (
            codex_home
            / "plugins"
            / "cache"
            / INSTALLER.DEFAULT_MARKETPLACE_NAME
            / INSTALLER.PLUGIN_NAME
            / "0.13.0"
        )
        orphaned_version.mkdir(parents=True)
        target = {
            "executable": str(Path(sys.executable).resolve()),
            "home": str(codex_home),
        }
        with (
            mock.patch.object(
                INSTALLER_V2,
                "_codex_plugin_list",
                return_value={"installed": [], "available": []},
            ),
            self.assertRaisesRegex(
                INSTALLER_V2.InstallError,
                "orphaned Agentic SDLC cache",
            ),
        ):
            self.original_capture_codex_before(self.home, target)

    def test_v2_rejects_unbounded_or_nonmatching_receipt_inputs(self) -> None:
        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "24 hexadecimal"):
            INSTALLER_V2._parse_arguments(
                [
                    "confirm",
                    "--transaction-id",
                    "a" * 25,
                    "--receipt-hash",
                    "b" * 64,
                ]
            )
        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "64 hexadecimal"):
            INSTALLER_V2._parse_arguments(
                [
                    "restore",
                    "--transaction-id",
                    "a" * 24,
                    "--receipt-hash",
                    "b" * 65,
                ]
            )

        deep_home = self.root / "deep-marketplace-home"
        deep_marketplace = deep_home / ".agents" / "plugins" / "marketplace.json"
        deep_marketplace.parent.mkdir(parents=True)
        deep_marketplace.write_text("[" * 65 + "0" + "]" * 65, encoding="utf-8")
        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "nesting depth"):
            INSTALLER_V2._build_install_plan(self.repo, deep_home)

        orphan_home = self.root / "orphaned-v2-home"
        orphan = (
            orphan_home
            / "plugins"
            / f".{INSTALLER.PLUGIN_NAME}.validation-{'a' * 24}"
        )
        orphan.mkdir(parents=True)
        (orphan / "sentinel.txt").write_text("preserve\n", encoding="utf-8")
        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "Unmatched v2 recovery"):
            INSTALLER_V2._build_install_plan(self.repo, orphan_home)
        self.assertEqual((orphan / "sentinel.txt").read_text(), "preserve\n")

        plan = self.v2_plan()
        _, pending = self.v2_apply(plan)
        receipt_path = INSTALLER_V2._receipt_path(self.home)
        receipt_path.write_bytes(b"{" + b" " * INSTALLER_V2.MAX_RECEIPT_BYTES + b"}")
        with self.assertRaisesRegex(INSTALLER_V2.InstallError, "exceeds"):
            INSTALLER_V2._read_receipt(self.home)

    def test_v2_rejects_receipt_path_alias_without_touching_external_tree(self) -> None:
        if os.name == "nt":
            self.skipTest("symlink/parent traversal semantics are POSIX-specific")

        self.apply(self.plan())
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )
        _, pending = self.v2_apply(self.v2_plan())
        backup = INSTALLER_V2._plugin_backup_path(
            self.home, pending["transaction_id"]
        )

        external_parent = self.root / "external-backup-parent"
        link_target = external_parent / "link-target"
        link_target.mkdir(parents=True)
        external_backup = external_parent / backup.name
        shutil.copytree(backup, external_backup)
        external_sentinel = external_backup / "README.md"
        sentinel_bytes = external_sentinel.read_bytes()

        alias = self.home / "plugins" / "external-alias"
        alias.symlink_to(link_target, target_is_directory=True)
        aliased_backup = alias / ".." / backup.name
        self.assertEqual(
            os.path.normpath(str(aliased_backup)),
            os.path.normpath(str(backup)),
        )

        tampered = json.loads(json.dumps(pending))
        tampered["plugin_backup"] = str(aliased_backup)
        tampered["receipt_hash"] = INSTALLER_V2._canonical_receipt_hash(tampered)
        INSTALLER_V2._receipt_path(self.home).write_bytes(
            INSTALLER_V2.V1._json_bytes(tampered)
        )

        with self.assertRaisesRegex(
            INSTALLER_V2.InstallError, "unsafe plugin backup path"
        ):
            INSTALLER_V2._confirm_install(
                self.home,
                pending["transaction_id"],
                tampered["receipt_hash"],
            )
        self.assertEqual(external_sentinel.read_bytes(), sentinel_bytes)
        self.assertTrue(external_backup.is_dir())
        self.assertTrue(backup.is_dir())

    def test_v2_preflight_bounds_empty_directories_before_snapshot(self) -> None:
        managed_tree = self.root / "many-empty-directories"
        managed_tree.mkdir()
        for index in range(4):
            (managed_tree / f"empty-{index}").mkdir()
        with mock.patch.object(INSTALLER_V2, "MAX_MANAGED_ENTRIES", 3):
            with self.assertRaisesRegex(
                INSTALLER_V2.InstallError, "resource limits"
            ):
                INSTALLER_V2._preflight_tree_bounds(managed_tree, "Managed test tree")

        source_many = self.repo / "lib" / "many-empty-directories"
        source_many.mkdir()
        for index in range(4):
            (source_many / f"empty-{index}").mkdir()
        with mock.patch.object(INSTALLER_V2, "MAX_MANAGED_ENTRIES", 8):
            with self.assertRaisesRegex(
                INSTALLER_V2.InstallError, "resource limits"
            ):
                INSTALLER_V2._preflight_source_bounds(
                    self.repo, INSTALLER_V2._destination_path(self.home)
                )

    def test_v2_interrupted_apply_retries_the_same_reviewed_update(self) -> None:
        crash_repo = self.root / "v2-crash-source"
        shutil.copytree(self.repo, crash_repo)
        (crash_repo / "scripts").mkdir()
        shutil.copy2(
            INSTALLER_PATH,
            crash_repo / "scripts" / "install-personal-marketplace.py",
        )
        shutil.copy2(
            INSTALLER_V2_PATH,
            crash_repo / "scripts" / "install-personal-marketplace-v2.py",
        )
        crash_home = self.root / "v2-crash-home"
        crash_home.mkdir()
        (crash_home / "plugin").write_text(
            """import json
import sys

if sys.argv[1:] == ["list", "--json"]:
    print(json.dumps({"installed": [], "available": []}, sort_keys=True))
    raise SystemExit(0)

print("unsupported Codex fixture command", file=sys.stderr)
raise SystemExit(2)
""",
            encoding="utf-8",
        )
        copied = crash_repo / "scripts" / "install-personal-marketplace-v2.py"

        def invoke(arguments, crash_phase=None):
            environment = dict(os.environ)
            environment["HOME"] = str(crash_home)
            if crash_phase is not None:
                environment[
                    "_AGENTIC_SDLC_INSTALLER_V2_TEST_CRASH_PHASE"
                ] = crash_phase
            codex_binding = (
                [
                    "--codex-executable",
                    sys.executable,
                    "--codex-home",
                    str(crash_home / ".codex"),
                ]
                if arguments[0] in {"apply", "confirm", "restore"}
                else []
            )
            return subprocess.run(
                [
                    sys.executable,
                    str(copied),
                    *arguments,
                    "--home",
                    str(crash_home),
                    *codex_binding,
                ],
                cwd=str(crash_repo),
                env=environment,
                capture_output=True,
                encoding="utf-8",
                timeout=20,
                check=False,
            )

        preview = invoke(["plan", "--json"])
        self.assertEqual(preview.returncode, 0, preview.stderr)
        plan_hash = json.loads(preview.stdout)["data"]["plan_hash"]
        crashed = invoke(
            ["apply", "--json", "--plan-hash", plan_hash],
            crash_phase="plugin_replaced",
        )
        self.assertEqual(
            crashed.returncode,
            87,
            f"stdout:\n{crashed.stdout}\nstderr:\n{crashed.stderr}",
        )

        retried = invoke(["apply", "--json", "--plan-hash", plan_hash])
        self.assertEqual(retried.returncode, 0, retried.stderr)
        envelope = json.loads(retried.stdout)
        self.assertEqual(envelope["data"]["state"], "validation_pending")
        self.assertTrue(
            (
                crash_home
                / "plugins"
                / INSTALLER.PLUGIN_NAME
                / "lib"
                / "core.mjs"
            ).is_file()
        )

    def test_v2_confirm_and_restore_resume_after_partial_terminal_work(self) -> None:
        self.apply(self.plan())
        destination = self.home / "plugins" / INSTALLER.PLUGIN_NAME
        marketplace = self.home / ".agents" / "plugins" / "marketplace.json"
        original_tree = INSTALLER._snapshot_tree(destination)
        original_marketplace = marketplace.read_bytes()
        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "two";\n', encoding="utf-8"
        )
        first_plan = self.v2_plan()
        _, first_pending = self.v2_apply(first_plan)

        original_write_receipt = INSTALLER_V2._write_receipt
        failed_confirmation = False

        def fail_first_terminal_receipt(home, receipt):
            nonlocal failed_confirmation
            if receipt["phase"] == "confirmed" and not failed_confirmation:
                failed_confirmation = True
                raise OSError("injected terminal receipt interruption")
            return original_write_receipt(home, receipt)

        with mock.patch.object(
            INSTALLER_V2,
            "_write_receipt",
            side_effect=fail_first_terminal_receipt,
        ):
            with self.assertRaisesRegex(OSError, "terminal receipt interruption"):
                INSTALLER_V2._confirm_install(
                    self.home,
                    first_pending["transaction_id"],
                    first_pending["receipt_hash"],
                )
        self.assertEqual(
            INSTALLER_V2._read_receipt(self.home)["phase"],
            "confirm_started",
        )
        confirmed = INSTALLER_V2._confirm_install(
            self.home,
            first_pending["transaction_id"],
            first_pending["receipt_hash"],
        )
        self.assertEqual(confirmed["phase"], "confirmed")
        confirmed_tree = INSTALLER._snapshot_tree(destination)
        self.assertNotEqual(confirmed_tree, original_tree)

        (self.repo / "lib" / "core.mjs").write_text(
            'export const version = "three";\n', encoding="utf-8"
        )
        second_plan = self.v2_plan()
        _, second_pending = self.v2_apply(second_plan)
        original_remove_verified_tree = INSTALLER_V2._remove_verified_tree
        interrupted_restore = False

        def interrupt_restore_cleanup(path, expected, label):
            nonlocal interrupted_restore
            if label == "restore work tree" and not interrupted_restore:
                interrupted_restore = True
                (path / "lib" / "core.mjs").unlink()
                raise OSError("injected restore interruption")
            return original_remove_verified_tree(path, expected, label)

        with mock.patch.object(
            INSTALLER_V2,
            "_remove_verified_tree",
            side_effect=interrupt_restore_cleanup,
        ):
            with self.assertRaisesRegex(OSError, "restore interruption"):
                INSTALLER_V2._restore_install(
                    self.home,
                    second_pending["transaction_id"],
                    second_pending["receipt_hash"],
                )
        self.assertEqual(marketplace.read_bytes(), original_marketplace)
        self.assertEqual(
            INSTALLER_V2._read_receipt(self.home)["phase"],
            "restore_started",
        )
        restored = INSTALLER_V2._restore_install(
            self.home,
            second_pending["transaction_id"],
            second_pending["receipt_hash"],
        )
        self.assertEqual(restored["phase"], "restored")
        self.assertEqual(INSTALLER._snapshot_tree(destination), confirmed_tree)
        self.assertEqual(marketplace.read_bytes(), original_marketplace)

    @unittest.skipIf(os.name == "nt", "the deterministic Codex CLI fixture uses a POSIX shebang")
    def test_v2_restore_reconciles_codex_cache_and_retries_partial_failure(self) -> None:
        old_source = self.root / "source-0.13.0"
        new_source = self.root / "source-0.13.1"
        ignored = shutil.ignore_patterns(".git", ".sdlc", "node_modules", "test")
        shutil.copytree(REPO_ROOT, old_source, ignore=ignored)
        shutil.copytree(REPO_ROOT, new_source, ignore=ignored)

        def set_version(source: Path, version: str) -> None:
            for relative in ("package.json", ".codex-plugin/plugin.json"):
                target = source / relative
                payload = json.loads(target.read_text(encoding="utf-8"))
                payload["version"] = version
                target.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )

        set_version(old_source, "0.13.0")
        set_version(new_source, "0.13.1")

        integration_home = self.root / "codex-integration-home"
        codex_home = integration_home / ".codex"
        codex_home.mkdir(parents=True)
        fake_codex = self.root / "codex-fixture"
        fake_codex.write_text(
            f"""#!{sys.executable}
import json
import os
import shutil
import sys
from pathlib import Path

PLUGIN_ID = "agentic-sdlc-codex-plugin@personal"
PLUGIN_NAME = "agentic-sdlc-codex-plugin"
home = Path(os.environ["HOME"])
codex_home = Path(os.environ.get("CODEX_HOME", home / ".codex"))
state_path = codex_home / "fixture-installed.json"
cache_root = codex_home / "plugins" / "cache" / "personal" / PLUGIN_NAME
args = sys.argv[1:]

def emit(payload):
    print(json.dumps(payload, sort_keys=True))

def read_state():
    return json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else None

def marketplace_has_plugin():
    marketplace_path = home / ".agents" / "plugins" / "marketplace.json"
    if not marketplace_path.exists():
        return False
    marketplace = json.loads(marketplace_path.read_text(encoding="utf-8"))
    return any(
        item.get("name") == PLUGIN_NAME
        for item in marketplace.get("plugins", [])
        if isinstance(item, dict)
    )

if args[:2] == ["plugin", "list"]:
    state = read_state()
    visible = state if state and marketplace_has_plugin() else None
    emit({{"installed": [visible] if visible else [], "available": []}})
    raise SystemExit(0)

if args[:3] == ["plugin", "add", PLUGIN_ID]:
    fail_once = codex_home / "fail-next-add"
    if fail_once.exists():
        fail_once.unlink()
        print("injected Codex add failure", file=sys.stderr)
        raise SystemExit(19)
    marketplace = json.loads(
        (home / ".agents" / "plugins" / "marketplace.json").read_text(encoding="utf-8")
    )
    plugin = next(item for item in marketplace["plugins"] if item["name"] == PLUGIN_NAME)
    source_value = Path(plugin["source"]["path"])
    source = source_value if source_value.is_absolute() else home / source_value
    source = source.resolve()
    version = json.loads((source / "package.json").read_text(encoding="utf-8"))["version"]
    if cache_root.exists():
        shutil.rmtree(cache_root)
    cache = cache_root / version
    cache.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, cache)
    state = {{
        "pluginId": PLUGIN_ID,
        "name": PLUGIN_NAME,
        "marketplaceName": "personal",
        "version": version,
        "installed": True,
        "enabled": True,
        "source": {{"source": "local", "path": str(source)}},
        "installPolicy": "AVAILABLE",
        "authPolicy": "ON_INSTALL",
    }}
    codex_home.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(state), encoding="utf-8")
    emit({{"ok": True, "plugin": state}})
    raise SystemExit(0)

if args[:3] == ["plugin", "remove", PLUGIN_ID]:
    if cache_root.exists():
        shutil.rmtree(cache_root)
    state_path.unlink(missing_ok=True)
    emit({{"ok": True, "removed": PLUGIN_ID}})
    raise SystemExit(0)

print("unsupported fixture command", file=sys.stderr)
raise SystemExit(2)
""",
            encoding="utf-8",
        )
        fake_codex.chmod(0o755)
        environment = {
            **os.environ,
            "HOME": str(integration_home),
            "CODEX_HOME": str(codex_home),
            "PYTHONDONTWRITEBYTECODE": "1",
        }

        def run(
            arguments: list[str],
            *,
            cwd: Path,
            expected: int = 0,
            invocation_environment: dict[str, str] | None = None,
        ) -> subprocess.CompletedProcess[str]:
            completed = subprocess.run(
                arguments,
                cwd=str(cwd),
                env=invocation_environment or environment,
                capture_output=True,
                encoding="utf-8",
                timeout=60,
                check=False,
            )
            self.assertEqual(
                completed.returncode,
                expected,
                f"{arguments}\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
            )
            return completed

        def prepare(
            source: Path,
            target_home: Path = integration_home,
        ) -> tuple[dict[str, object], list[str]]:
            installer = source / "scripts" / "install-personal-marketplace-v2.py"
            preview = json.loads(
                run(
                    [
                        sys.executable,
                        str(installer),
                        "plan",
                        "--home",
                        str(target_home),
                        "--json",
                    ],
                    cwd=source,
                ).stdout
            )
            applied = json.loads(
                run(
                    [
                        sys.executable,
                        str(installer),
                        "apply",
                        "--plan-hash",
                        str(preview["data"]["plan_hash"]),
                        "--home",
                        str(target_home),
                        "--codex-executable",
                        str(fake_codex),
                        "--codex-home",
                        str(target_home / ".codex"),
                        "--json",
                    ],
                    cwd=source,
                ).stdout
            )
            self.assertTrue(applied["data"]["candidate_registration_required"])
            registration = applied["technical_details"]["candidate_registration"]
            self.assertEqual(registration["required_before"], ["validate", "confirm"])
            self.assertEqual(
                registration["command"]["argv"],
                [
                    str(fake_codex.resolve()),
                    "plugin",
                    "add",
                    INSTALLER.PLUGIN_NAME + "@personal",
                    "--json",
                ],
            )
            self.assertEqual(
                registration["verification"]["argv"],
                [str(fake_codex.resolve()), "plugin", "list", "--json"],
            )
            expected_environment = {
                "HOME": str(target_home.resolve()),
                "CODEX_HOME": str((target_home / ".codex").resolve()),
            }
            self.assertEqual(
                registration["command"]["environment"],
                expected_environment,
            )
            self.assertEqual(
                registration["verification"]["environment"],
                expected_environment,
            )
            bound = [
                "--transaction-id",
                str(applied["technical_details"]["transaction_id"]),
                "--receipt-hash",
                str(applied["technical_details"]["receipt_hash"]),
            ]
            validated = json.loads(
                run(
                    [
                        sys.executable,
                        str(installer),
                        "validate",
                        *bound,
                        "--home",
                        str(target_home),
                        "--json",
                    ],
                    cwd=source,
                ).stdout
            )
            return validated, bound

        old_validated, old_bound = prepare(old_source)
        run(
            [str(fake_codex), "plugin", "add", INSTALLER.PLUGIN_NAME + "@personal", "--json"],
            cwd=old_source,
        )
        run(
            [
                sys.executable,
                str(old_source / "scripts" / "install-personal-marketplace-v2.py"),
                "confirm",
                *old_bound,
                "--home",
                str(integration_home),
                "--json",
            ],
            cwd=old_source,
        )
        self.assertEqual(old_validated["data"]["state"], "validation_pending")

        state_path = codex_home / "fixture-installed.json"
        disabled_state = json.loads(state_path.read_text(encoding="utf-8"))
        disabled_state["enabled"] = False
        state_path.write_text(json.dumps(disabled_state), encoding="utf-8")
        disabled_preview = json.loads(
            run(
                [
                    sys.executable,
                    str(new_source / "scripts" / "install-personal-marketplace-v2.py"),
                    "plan",
                    "--home",
                    str(integration_home),
                    "--json",
                ],
                cwd=new_source,
            ).stdout
        )
        disabled_apply = json.loads(
            run(
                [
                    sys.executable,
                    str(new_source / "scripts" / "install-personal-marketplace-v2.py"),
                    "apply",
                    "--plan-hash",
                    str(disabled_preview["data"]["plan_hash"]),
                    "--home",
                    str(integration_home),
                    "--codex-executable",
                    str(fake_codex),
                    "--codex-home",
                    str(codex_home),
                    "--json",
                ],
                cwd=new_source,
                expected=1,
            ).stdout
        )
        self.assertEqual(disabled_apply["data"]["state"], "stopped")
        self.assertIn("disabled", disabled_apply["technical_details"]["error"])
        self.assertEqual(
            json.loads(
                (
                    integration_home
                    / "plugins"
                    / INSTALLER.PLUGIN_NAME
                    / "package.json"
                ).read_text(encoding="utf-8")
            )["version"],
            "0.13.0",
        )
        disabled_state["enabled"] = True
        state_path.write_text(json.dumps(disabled_state), encoding="utf-8")

        new_validated, new_bound = prepare(new_source)
        missing_add_confirmation = json.loads(
            run(
                [
                    sys.executable,
                    str(new_source / "scripts" / "install-personal-marketplace-v2.py"),
                    "confirm",
                    *new_bound,
                    "--home",
                    str(integration_home),
                    "--json",
                ],
                cwd=new_source,
                expected=1,
            ).stdout
        )
        self.assertEqual(missing_add_confirmation["data"]["state"], "stopped")
        still_pending = INSTALLER_V2._read_receipt(integration_home.resolve())
        self.assertIsNotNone(still_pending)
        self.assertEqual(still_pending["phase"], "validation_pending")
        self.assertTrue(Path(str(still_pending["plugin_backup"])).is_dir())
        run(
            [str(fake_codex), "plugin", "add", INSTALLER.PLUGIN_NAME + "@personal", "--json"],
            cwd=new_source,
        )
        new_cache = (
            codex_home
            / "plugins"
            / "cache"
            / "personal"
            / INSTALLER.PLUGIN_NAME
            / "0.13.1"
        )
        node = shutil.which("node")
        self.assertIsNotNone(node)
        version_result = run(
            [str(node), str(new_cache / "bin" / "agentic-sdlc.mjs"), "--version", "--json"],
            cwd=new_source,
        )
        self.assertEqual(json.loads(version_result.stdout)["package_version"], "0.13.1")
        help_result = run(
            [str(node), str(new_cache / "bin" / "agentic-sdlc.mjs"), "--help"],
            cwd=new_source,
        )
        self.assertIn("Agentic SDLC", help_result.stdout)

        (codex_home / "fail-next-add").write_text("fail once\n", encoding="utf-8")
        foreign_codex_home = self.root / "foreign-codex-home"
        foreign_codex_home.mkdir()
        foreign_sentinel = foreign_codex_home / "do-not-touch.txt"
        foreign_sentinel.write_text("unchanged\n", encoding="utf-8")
        foreign_environment = {
            **environment,
            "CODEX_HOME": str(foreign_codex_home),
        }
        restore_command = [
            sys.executable,
            str(new_source / "scripts" / "install-personal-marketplace-v2.py"),
            "restore",
            *new_bound,
            "--codex-executable",
            str(fake_codex),
            "--home",
            str(integration_home),
            "--json",
        ]
        mismatched_target = json.loads(
            run(
                [*restore_command, "--codex-home", str(foreign_codex_home)],
                cwd=new_source,
                expected=1,
                invocation_environment=foreign_environment,
            ).stdout
        )
        self.assertEqual(mismatched_target["data"]["state"], "stopped")
        self.assertEqual(
            INSTALLER_V2._read_receipt(integration_home.resolve())["phase"],
            "validation_pending",
        )
        partial = json.loads(
            run(
                restore_command,
                cwd=new_source,
                expected=1,
                invocation_environment=foreign_environment,
            ).stdout
        )
        self.assertEqual(partial["data"]["state"], "restore_reconciliation_pending")
        self.assertTrue(partial["data"]["staging_restored"])
        self.assertFalse(partial["data"]["codex_reconciled"])
        self.assertTrue(partial["data"]["partial_failure"])
        self.assertEqual(partial["data"]["next_action"], "retry_restore")
        self.assertIn(
            f"--codex-executable {fake_codex}",
            partial["technical_details"]["retry_restore_command"],
        )
        self.assertEqual(foreign_sentinel.read_text(encoding="utf-8"), "unchanged\n")
        self.assertFalse((foreign_codex_home / "plugins").exists())
        self.assertEqual(
            json.loads(
                (
                    integration_home
                    / "plugins"
                    / INSTALLER.PLUGIN_NAME
                    / "package.json"
                ).read_text(encoding="utf-8")
            )["version"],
            "0.13.0",
        )
        stale_list = json.loads(
            run(
                [str(fake_codex), "plugin", "list", "--json"],
                cwd=new_source,
            ).stdout
        )
        self.assertEqual(stale_list["installed"][0]["version"], "0.13.1")

        retry_bound = [
            "--transaction-id",
            str(partial["data"]["transaction_id"]),
            "--receipt-hash",
            str(partial["technical_details"]["receipt_hash"]),
        ]
        restored = json.loads(
            run(
                [
                    sys.executable,
                    str(new_source / "scripts" / "install-personal-marketplace-v2.py"),
                    "restore",
                    *retry_bound,
                    "--codex-executable",
                    str(fake_codex),
                    "--home",
                    str(integration_home),
                    "--json",
                ],
                cwd=new_source,
                invocation_environment=foreign_environment,
            ).stdout
        )
        self.assertEqual(restored["data"]["state"], "restored")
        self.assertTrue(restored["data"]["staging_restored"])
        self.assertTrue(restored["data"]["codex_reconciled"])
        self.assertFalse(restored["data"]["partial_failure"])
        self.assertEqual(foreign_sentinel.read_text(encoding="utf-8"), "unchanged\n")
        self.assertFalse((foreign_codex_home / "plugins").exists())

        final_list = json.loads(
            run(
                [str(fake_codex), "plugin", "list", "--json"],
                cwd=new_source,
            ).stdout
        )
        self.assertEqual(final_list["installed"][0]["version"], "0.13.0")
        cache_root = (
            codex_home
            / "plugins"
            / "cache"
            / "personal"
            / INSTALLER.PLUGIN_NAME
        )
        self.assertEqual([entry.name for entry in cache_root.iterdir()], ["0.13.0"])
        restored_staging = integration_home / "plugins" / INSTALLER.PLUGIN_NAME
        restored_cache = cache_root / "0.13.0"
        self.assertEqual(
            INSTALLER_V2._plugin_distribution_identity(
                restored_staging, "restored staging test fixture"
            ),
            INSTALLER_V2._plugin_distribution_identity(
                restored_cache, "restored cache test fixture"
            ),
        )
        retry_with_overrides = INSTALLER_V2._transaction_command(
            "restore",
            {
                "transaction_id": partial["data"]["transaction_id"],
                "receipt_hash": partial["technical_details"]["receipt_hash"],
            },
            integration_home,
            "en",
            True,
            str(fake_codex),
            str(codex_home),
        )
        self.assertIn(f"--codex-executable {fake_codex}", retry_with_overrides)
        self.assertIn(f"--codex-home {codex_home}", retry_with_overrides)

        first_home = self.root / "first-install-home"
        first_codex_home = first_home / ".codex"
        first_codex_home.mkdir(parents=True)
        first_environment = {
            **environment,
            "HOME": str(first_home),
            "CODEX_HOME": str(first_codex_home),
        }
        first_validated, first_bound = prepare(new_source, first_home)
        self.assertEqual(first_validated["data"]["state"], "validation_pending")
        self.assertTrue(
            first_home.joinpath(
                "plugins",
                INSTALLER.PLUGIN_NAME,
            ).is_dir()
        )
        run(
            [
                str(fake_codex),
                "plugin",
                "add",
                INSTALLER.PLUGIN_NAME + "@personal",
                "--json",
            ],
            cwd=new_source,
            invocation_environment=first_environment,
        )
        first_cache_root = (
            first_codex_home
            / "plugins"
            / "cache"
            / "personal"
            / INSTALLER.PLUGIN_NAME
        )
        self.assertTrue(first_cache_root.joinpath("0.13.1").is_dir())

        first_restored = json.loads(
            run(
                [
                    sys.executable,
                    str(new_source / "scripts" / "install-personal-marketplace-v2.py"),
                    "restore",
                    *first_bound,
                    "--codex-executable",
                    str(fake_codex),
                    "--home",
                    str(first_home),
                    "--json",
                ],
                cwd=new_source,
                invocation_environment=first_environment,
            ).stdout
        )
        self.assertEqual(first_restored["data"]["state"], "restored")
        self.assertTrue(first_restored["data"]["staging_restored"])
        self.assertTrue(first_restored["data"]["codex_reconciled"])
        self.assertFalse(first_restored["data"]["partial_failure"])
        self.assertFalse(
            first_home.joinpath("plugins", INSTALLER.PLUGIN_NAME).exists()
        )
        self.assertFalse(
            first_home.joinpath(".agents", "plugins", "marketplace.json").exists()
        )
        self.assertFalse(first_cache_root.exists())
        first_list = json.loads(
            run(
                [str(fake_codex), "plugin", "list", "--json"],
                cwd=new_source,
                invocation_environment=first_environment,
            ).stdout
        )
        self.assertEqual(first_list["installed"], [])

    def test_v2_primary_messages_remain_plain_in_both_languages(self) -> None:
        for locale in ("en", "it"):
            for command, state in (
                ("check", "update_available"),
                ("plan", "ready_to_apply"),
                ("apply", "validation_pending"),
                ("validate", "validation_pending"),
                ("confirm", "confirmed"),
                ("restore", "restored"),
            ):
                message = INSTALLER_V2._human_message(command, locale, state)
                self.assertEqual(set(message), HUMAN_FIELDS)
                primary = "\n".join(message.values())
                self.assertNotRegex(primary, PRIMARY_INTERNAL_JARGON)
                self.assertNotRegex(primary, PRIMARY_COMMAND_TEXT)
                if command == "apply":
                    self.assertRegex(
                        message["next_action"],
                        r"registrazione candidata|required candidate-registration",
                    )


if __name__ == "__main__":
    unittest.main()
