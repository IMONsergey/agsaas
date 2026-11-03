#!/usr/bin/env python3
"""Independent, offline verifier for a downloaded AGSaaS version 1 export ZIP."""
import hashlib
import json
import sys
import zipfile


def verify(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("Duplicate archive entries")
        if any(name.startswith("/") or ".." in name.split("/") for name in names):
            raise ValueError("Unsafe archive entry")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("schemaVersion") != 1:
            raise ValueError("Unsupported manifest version")
        listed = {"manifest.json"}
        for entry in manifest["files"]:
            data = archive.read(entry["path"])
            if len(data) != entry["bytes"] or hashlib.sha256(data).hexdigest() != entry["sha256"]:
                raise ValueError("File bytes do not match manifest: " + entry["path"])
            listed.add(entry["path"])
        if listed != set(names):
            raise ValueError("Manifest does not cover every archive entry")
        snapshot = json.loads(archive.read("data/snapshot.json"))
        counts = {name: len(rows) for name, rows in snapshot["tables"].items()}
        if counts != manifest["tableCounts"]:
            raise ValueError("Entity counts disagree with the SQL snapshot")
        if snapshot["asOf"] != manifest["sqlAsOf"] or snapshot["version"] != 1:
            raise ValueError("Snapshot metadata mismatch")
        absent = [asset for asset in manifest["assets"] if asset["status"] != "included"]
        if manifest["status"] == "complete" and (absent or manifest["missingTransactionIds"]):
            raise ValueError("Incomplete export falsely labeled complete")
        for asset in manifest["assets"]:
            if asset["status"] == "included":
                data = archive.read(asset["name"])
                if hashlib.sha256(data).hexdigest() != asset["sha256"] or len(data) != asset["bytes"]:
                    raise ValueError("Asset bytes disagree with receipt")
        return {"verified": True, "status": manifest["status"], "entities": sum(counts.values()), "files": len(names), "missing_files": len(absent)}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: verify-export-archive.py export.zip")
    try:
        print(json.dumps(verify(sys.argv[1]), ensure_ascii=False))
    except (KeyError, ValueError, zipfile.BadZipFile) as error:
        print(json.dumps({"verified": False, "error": str(error)}), file=sys.stderr)
        raise SystemExit(1)
