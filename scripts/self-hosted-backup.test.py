#!/usr/bin/env python3
"""Focused safety tests, using real archives and a simulated Docker lifecycle."""
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
import sys
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("backup", Path(__file__).with_name("self-hosted-backup.py"))
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupSafety(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.previous_umask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.previous_umask)
        self.temporary.cleanup()

    def archive(self, members):
        archive = self.root / "input.tar"
        with tarfile.open(archive, "w") as output:
            for member, data in members:
                output.addfile(member, io.BytesIO(data) if data is not None else None)
        return archive

    def test_real_archive_round_trip_preserves_content_modes_and_rejects_overwrite(self):
        source = self.root / "source"
        source.mkdir()
        data = source / "durable-key"
        data.write_bytes(b"synthetic-unit-test-key")
        data.chmod(0o600)
        archive = self.root / "state.tar.gz"
        backup.create_tar(source, archive)
        backup.safe_extract(archive, self.root / "restored")
        restored = self.root / "restored" / "durable-key"
        self.assertEqual(restored.read_bytes(), data.read_bytes())
        self.assertEqual(restored.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(backup.Failure):
            backup.safe_extract(archive, self.root / "restored")

    def test_traversal_absolute_links_devices_and_duplicate_entries_fail_before_extraction(self):
        for name in ("../escape", "/escape"):
            item = tarfile.TarInfo(name)
            with self.assertRaises(backup.Failure):
                backup.safe_extract(self.archive([(item, b"")]), self.root / "unsafe")
            self.assertFalse((self.root / "unsafe").exists())
        for kind, link in ((tarfile.SYMTYPE, "../escape"), (tarfile.LNKTYPE, "/escape"), (tarfile.CHRTYPE, "")):
            item = tarfile.TarInfo("unsafe")
            item.type, item.linkname = kind, link
            with self.assertRaises(backup.Failure):
                backup.safe_extract(self.archive([(item, None)]), self.root / "unsafe")
        first = tarfile.TarInfo("duplicate")
        with self.assertRaises(backup.Failure):
            backup.safe_extract(self.archive([(first, b""), (first, b"")]), self.root / "unsafe")

    def test_archive_cannot_write_through_a_prior_symlink(self):
        link = tarfile.TarInfo("link")
        link.type, link.linkname = tarfile.SYMTYPE, "safe"
        file = tarfile.TarInfo("link/file")
        with self.assertRaisesRegex(backup.Failure, "through a symlink"):
            backup.safe_extract(self.archive([(link, None), (file, b"")]), self.root / "unsafe")

    def test_certbot_relative_links_stay_inside_restored_control_state(self):
        source = self.root / "control"
        (source / "tls/archive/site").mkdir(parents=True)
        (source / "tls/live/site").mkdir(parents=True)
        (source / "tls/archive/site/fullchain1.pem").write_bytes(b"synthetic-public-certificate")
        (source / "tls/live/site/fullchain.pem").symlink_to("../../archive/site/fullchain1.pem")
        archive = self.root / "control.tar.gz"
        backup.create_tar(source, archive)
        backup.safe_extract(archive, self.root / "restored-control")
        restored = self.root / "restored-control/tls/live/site/fullchain.pem"
        self.assertTrue(restored.is_symlink())
        self.assertEqual(restored.read_bytes(), b"synthetic-public-certificate")
        self.assertTrue(restored.resolve().is_relative_to(self.root / "restored-control"))

    def test_capacity_uses_real_available_space_and_never_erases_remote_data(self):
        payload = 1024**3
        expected = backup.RESERVE + 1_234_803_098
        self.assertEqual(backup.capacity_required(payload), expected)
        response = b"Size Used Avail (root) %Capacity\n39535100 30153656 9323128 9381444 76%\n"
        with patch.object(backup, "command", return_value=response) as called:
            result = backup.offsite_capacity(payload)
            self.assertFalse(result["fits"])
            self.assertEqual(result["availableBytes"], 9323128 * 1024)
            argv = called.call_args.args[0]
            self.assertIn("-oStrictHostKeyChecking=yes", argv)
            self.assertIn("-oUpdateHostKeys=no", argv)
            self.assertEqual(called.call_args.kwargs["data"], b"df /data\n")

    def test_snapshot_archive_failure_resumes_exact_original_running_set(self):
        root = self.root / "backups"
        root.mkdir()
        originals = [
            {"id": "a" * 64, "service": "db", "running": True, "health": "healthy", "exitCode": 0},
            {"id": "b" * 64, "service": "redis-queue", "running": True, "health": "healthy", "exitCode": 0},
            {"id": "c" * 64, "service": "storage", "running": True, "health": "healthy", "exitCode": 0},
            {"id": "d" * 64, "service": "api", "running": True, "health": "healthy", "exitCode": 0},
            {"id": "e" * 64, "service": "worker", "running": False, "health": None, "exitCode": 0},
        ]
        current = {c["id"]: dict(c) for c in originals}
        calls = []
        plan = {"release": "f" * 40, "estimatedUncompressedBytes": 1,
                "containers": originals, "selectedImages": [], "roots": [{"name": "runtime", "path": str(self.root)}]}
        cfg = {"project": "agsaas-fixture", "source": str(self.root), "backupRoot": str(root)}

        def fake_docker(*args, **_kwargs):
            calls.append(args)
            if args[0] == "stop":
                current[args[-1]]["running"] = False
            elif args[0] == "start":
                current[args[-1]]["running"] = True
            elif args[0] == "inspect":
                return json.dumps({"Running": current[args[-1]]["running"], "Health": {"Status": "healthy"}}).encode()
            return b""

        def fake_command(_args, **kwargs):
            kwargs["output"].write(b"source-fixture")
            return b""

        with patch.object(backup, "inventory", return_value=plan), \
             patch.object(backup, "canonical_directory"), \
             patch.object(backup, "containers", side_effect=lambda _: list(current.values())), \
             patch.object(backup, "docker", side_effect=fake_docker), \
             patch.object(backup, "command", side_effect=fake_command), \
             patch.object(backup.shutil, "disk_usage", return_value=type("Space", (), {"free": 10**14})()), \
             patch.object(backup, "create_tar", side_effect=backup.Failure("Synthetic archive failure")):
            with self.assertRaisesRegex(backup.Failure, "Synthetic archive failure"):
                backup.snapshot(cfg, require_offsite=False)
        self.assertEqual({key: c["running"] for key, c in current.items()}, {c["id"]: c["running"] for c in originals})
        self.assertEqual([c[-1] for c in calls if c[0] == "stop"], ["d" * 64, "c" * 64, "b" * 64, "a" * 64])
        self.assertEqual([c[-1] for c in calls if c[0] == "start"], ["a" * 64, "b" * 64, "c" * 64, "d" * 64])
        journal = json.loads((root / "active-operation.json").read_text())
        self.assertTrue(journal["resumed"])
        self.assertFalse(any(root.glob("*/manifest.json")))

    def test_resume_refuses_changed_container_identity(self):
        old = {"id": "a" * 64, "running": True, "service": "db"}
        with patch.object(backup, "containers", return_value=[{**old, "id": "b" * 64}]), \
             patch.object(backup, "docker") as called:
            with self.assertRaisesRegex(backup.Failure, "Project changed"):
                backup.resume({"project": "agsaas-fixture"}, {"project": "agsaas-fixture", "containers": [old]})
            called.assert_not_called()


if __name__ == "__main__":
    unittest.main(verbosity=2)
