#!/usr/bin/env python3
"""Real own-origin login -> tenant RLS -> Vault upload/read/metadata/delete canary.

Requires an operator-supplied dedicated account/team. Creates no accounts, sends
no email, enables no provider and never uses a service-role credential. All
mutations are a unique small canary object with finally cleanup. Public-only is
an explicitly partial check and never reports authenticated business readiness.
"""
import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
        raise RuntimeError("Canonical own HTTPS origins are required")
    return value.rstrip("/")


def request(url, *, method="GET", headers=None, data=None, expected=(200,), json_body=False):
    if json_body:
        data = json.dumps(data).encode()
    hdr = {"User-Agent": "AGSaaS-owned-canary/1", **(headers or {})}
    if json_body:
        hdr["Content-Type"] = "application/json"
    req = urllib.request.Request(url, method=method, headers=hdr, data=data)
    try:
        response = urllib.request.build_opener(NoRedirect()).open(req, timeout=10)
    except urllib.error.HTTPError as error:
        # Tokens, response data and user records never enter the receipt/log.
        raise RuntimeError("Own endpoint returned HTTP " + str(error.code)) from None
    with response:
        if response.status not in expected:
            raise RuntimeError("Own endpoint returned an unexpected status")
        value = response.read(2 * 1024 * 1024 + 1)
        if len(value) > 2 * 1024 * 1024:
            raise RuntimeError("Canary response exceeded its size budget")
        return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--public-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    info = args.config.lstat()
    if not stat.S_ISREG(info.st_mode) or args.config.is_symlink() or info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o077:
        raise RuntimeError("Canary configuration must be a private owned file")
    cfg = json.loads(args.config.read_text())
    website, dashboard, api, supabase = [origin(cfg[key]) for key in ("website", "dashboard", "api", "supabase")]
    release = cfg.get("release")
    if not re.fullmatch(r"[a-f0-9]{40}", release or ""):
        raise RuntimeError("Use the exact deployed release SHA")
    result = {"checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "release": release,
              "success": False, "authenticatedBusinessVerified": False, "publicOnly": args.public_only,
              "checks": [], "cleanupComplete": True}
    token = None
    object_name = None
    upload_attempted = False
    data_headers = None
    failure = None
    phase = "public-website"

    def checked(name, condition):
        if not condition:
            raise RuntimeError("Canary assertion failed: " + name)
        result["checks"].append({"name": name, "passed": True})

    try:
        website_status = json.loads(request(website + "/api/health/"))
        checked(phase, website_status.get("status") == "ok" and website_status.get("version") == release)
        phase = "public-login-screen"
        checked(phase, b"<html" in request(dashboard + "/login").lower())
        phase = "api-dependency-readiness"
        checked(phase, json.loads(request(api + "/health/ready")).get("status") == "ok")
        if not args.public_only:
            phase = "dedicated-account-configuration"
            if cfg.get("allowMutations") is not True or not cfg.get("email") or not cfg.get("password") or not cfg.get("publishableKey"):
                raise RuntimeError("Dedicated canary credentials and explicit mutation scope are not configured")
            team = str(uuid.UUID(cfg.get("teamId", "")))
            phase = "real-password-login"
            login = json.loads(request(supabase + "/auth/v1/token?grant_type=password", method="POST",
                                       headers={"apikey": cfg["publishableKey"]},
                                       data={"email": cfg["email"], "password": cfg["password"]}, json_body=True))
            token = login.get("access_token")
            checked(phase, isinstance(token, str) and bool(token))
            data_headers = {"apikey": cfg["publishableKey"], "Authorization": "Bearer " + token}
            phase = "authoritative-tenant-read"
            teams = json.loads(request(supabase + "/rest/v1/teams?" + urllib.parse.urlencode({"id": "eq." + team, "select": "id"}), headers=data_headers))
            checked(phase, teams == [{"id": team}])
            object_name = team + "/__healthcheck/" + str(uuid.uuid4()) + ".txt"
            path = urllib.parse.quote(object_name, safe="/")
            payload = b"AGSaaS owned infrastructure canary\n"
            phase = "vault-upload"
            upload_attempted = True
            request(supabase + "/storage/v1/object/vault/" + path, method="POST",
                    headers={**data_headers, "Content-Type": "text/plain", "x-upsert": "false"},
                    data=payload, expected=(200, 201))
            checked(phase, True)
            phase = "vault-owned-download"
            checked(phase, request(supabase + "/storage/v1/object/authenticated/vault/" + path, headers=data_headers) == payload)
            phase = "native-document-projection"
            query = urllib.parse.urlencode({"name": "eq." + object_name, "select": "id,team_id,name"})
            for _ in range(20):
                documents = json.loads(request(supabase + "/rest/v1/documents?" + query, headers=data_headers))
                if len(documents) == 1 and documents[0].get("team_id") == team and documents[0].get("name") == object_name:
                    break
                time.sleep(1)
            else:
                raise RuntimeError("Vault object did not obtain its tenant-owned document metadata")
            checked(phase, True)
            result["authenticatedBusinessVerified"] = True
        result["success"] = True
    except Exception as error:
        failure = str(error) if isinstance(error, RuntimeError) else "Canary operation failed; private details suppressed"
        result["checks"].append({"name": phase, "passed": False, "error": failure})
    finally:
        if upload_attempted and data_headers and object_name:
            try:
                request(supabase + "/storage/v1/object/vault", method="DELETE", headers=data_headers,
                        data={"prefixes": [object_name]}, json_body=True)
                query = urllib.parse.urlencode({"name": "eq." + object_name, "select": "id"})
                remaining = json.loads(request(supabase + "/rest/v1/documents?" + query, headers=data_headers))
                checked("vault-object-and-metadata-cleanup", remaining == [])
            except Exception:
                result.update(success=False, cleanupComplete=False, cleanupStoragePath=object_name)
                result["checks"].append({"name": "vault-object-and-metadata-cleanup", "passed": False})
        if token and data_headers:
            try:
                request(supabase + "/auth/v1/logout?scope=local", method="POST", headers=data_headers, expected=(200, 204))
            except Exception:
                result.update(success=False, cleanupComplete=False)
                result["checks"].append({"name": "canary-session-logout", "passed": False})
        if args.receipt:
            if not args.receipt.is_absolute() or args.receipt.is_symlink():
                raise RuntimeError("Unsafe canary receipt path")
            descriptor = os.open(args.receipt, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "w") as output:
                json.dump(result, output, indent=2)
                output.write("\n")
    print(json.dumps(result, indent=2))
    return 0 if result["success"] else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "Canary configuration failed; private details suppressed", file=sys.stderr)
        sys.exit(1)
