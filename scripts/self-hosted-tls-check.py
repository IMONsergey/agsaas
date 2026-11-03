#!/usr/bin/env python3
"""Owned IP TLS expiry/served-leaf proof and validated renewal reload hook.

Default check is read-only. Reload and ACME dry-run are explicit admin actions.
Never binds or alters port 443, the VPN or another certificate installation.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import ssl
import subprocess
import sys
import time

HOST = "94.249.186.240"
CONTROL = Path("/opt/agsaas/preview-20261101/control")
CERT = CONTROL / "tls/live/agsaas-preview-ip/fullchain.pem"
KEY = CONTROL / "tls/live/agsaas-preview-ip/privkey.pem"
CERTBOT = "/opt/agsaas/tools/certbot-ip-5.4.0/bin/certbot"


def command(args, data=None, timeout=30):
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        raise RuntimeError("TLS operation failed; private subprocess output suppressed")
    return result.stdout


def peer(port):
    context = ssl.create_default_context()
    with socket.create_connection((HOST, port), timeout=8) as raw:
        with context.wrap_socket(raw, server_hostname=HOST) as tls:
            certificate = tls.getpeercert()
            end = ssl.cert_time_to_seconds(certificate["notAfter"])
            return {"port": port, "sha256": hashlib.sha256(tls.getpeercert(binary_form=True)).hexdigest(),
                    "expiresAt": dt.datetime.fromtimestamp(end, dt.timezone.utc).isoformat(),
                    "remainingSeconds": int(end-time.time()), "tlsVersion": tls.version(), "trusted": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["check", "reload", "renew-dry-run"], nargs="?", default="check")
    parser.add_argument("--ports", default="8543,8544,8545")
    parser.add_argument("--minimum-hours", type=int, default=36)
    parser.add_argument("--receipt", type=Path)
    args = parser.parse_args()
    ports = [int(value) for value in args.ports.split(",")]
    if not ports or len(set(ports)) != len(ports) or any(p not in (8543,8544,8545,8546) for p in ports):
        raise RuntimeError("Only the owned preview TLS ports may be checked")
    if not 12 <= args.minimum_hours <= 120:
        raise RuntimeError("Invalid short-lived certificate alert threshold")
    previous = []
    try:
        previous = [peer(port) for port in ports]
    except (OSError, ssl.SSLError):
        if args.action == "check":
            raise RuntimeError("Owned endpoint TLS is unavailable or untrusted") from None
    disk_fingerprint = None
    if args.action != "check":
        if os.geteuid() != 0:
            raise RuntimeError("Renewal operations require the deployment owner")
        if args.action == "renew-dry-run":
            command([CERTBOT, "renew", "--cert-name", "agsaas-preview-ip", "--config-dir", str(CONTROL / "tls"),
                     "--work-dir", str(CONTROL / "tls-work"), "--logs-dir", str(CONTROL / "tls-logs"),
                     "--dry-run", "--quiet"], timeout=300)
        else:
            pem = CERT.read_text()
            match = re.search(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", pem, re.S)
            if not match:
                raise RuntimeError("Owned certificate is missing")
            disk_fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(match.group())).hexdigest()
            command(["openssl", "x509", "-in", str(CERT), "-noout", "-checkend", str(args.minimum_hours * 3600)])
            public_certificate = command(["openssl", "x509", "-in", str(CERT), "-noout", "-pubkey"])
            public_key = command(["openssl", "pkey", "-in", str(KEY), "-pubout"])
            if public_certificate != public_key:
                raise RuntimeError("Certificate/private-key pair differs")
            command(["nginx", "-t"])
            command(["systemctl", "reload", "nginx"])
    current = [peer(port) for port in ports]
    if disk_fingerprint:
        # Graceful Nginx reload may return before old workers stop accepting.
        for _ in range(15):
            if all(item["sha256"] == disk_fingerprint for item in current):
                break
            time.sleep(1)
            current = [peer(port) for port in ports]
    if any(item["remainingSeconds"] < args.minimum_hours * 3600 for item in current):
        raise RuntimeError("Owned TLS certificate is below the renewal safety window")
    if disk_fingerprint and any(item["sha256"] != disk_fingerprint for item in current):
        raise RuntimeError("Nginx is not serving the renewed owned certificate")
    result = {"checkedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "action": args.action,
              "success": True, "host": HOST, "endpoints": current,
              "diskSha256": disk_fingerprint, "nginxReloadVerified": args.action == "reload",
              "acmeDryRunVerified": args.action == "renew-dry-run",
              "rotationObserved": bool(previous and any(a["sha256"] != b["sha256"] for a,b in zip(previous,current)))}
    if args.receipt:
        if not args.receipt.is_absolute() or args.receipt.is_symlink():
            raise RuntimeError("Unsafe receipt path")
        descriptor = os.open(args.receipt, os.O_CREAT | os.O_TRUNC | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as output:
            json.dump(result, output, indent=2)
            output.write("\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else "TLS verification failed; private details suppressed", file=sys.stderr)
        sys.exit(1)
