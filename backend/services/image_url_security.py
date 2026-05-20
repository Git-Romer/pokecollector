"""Validation helpers for user-provided image URLs.

The backend image proxy fetches these URLs server-side, so custom image URLs
must be restricted to public HTTPS destinations to avoid SSRF against local or
private network resources.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse


_BLOCKED_HOSTS = {"localhost", "localhost.localdomain"}


def _is_public_ip(value: str) -> bool:
    try:
        ip = ipaddress.ip_address(value)
    except ValueError:
        return False
    return ip.is_global


def validate_public_https_image_url(raw_url: str) -> str:
    """Return a normalized custom image URL or raise ValueError.

    Only public HTTPS URLs are accepted. Hostnames are resolved and every
    resolved address must be globally routable; localhost, loopback,
    link-local, private, reserved, multicast, and metadata-service addresses are
    rejected.
    """
    url = (raw_url or "").strip()
    parsed = urlparse(url)

    if parsed.scheme != "https":
        raise ValueError("Image URL must start with https://")
    if not parsed.hostname:
        raise ValueError("Image URL must include a valid host")
    if parsed.username or parsed.password:
        raise ValueError("Image URL must not include credentials")

    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Image URL has an invalid port") from exc
    if port not in (None, 443):
        raise ValueError("Image URL must use the default HTTPS port")

    host = parsed.hostname.rstrip(".").lower()
    if host in _BLOCKED_HOSTS or host.endswith(".localhost"):
        raise ValueError("Image URL host is not allowed")

    if _is_public_ip(host):
        return url

    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise ValueError("Image URL host is not publicly reachable")

    try:
        resolved = socket.getaddrinfo(host.encode("idna").decode("ascii"), port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("Image URL host could not be resolved") from exc

    if not resolved:
        raise ValueError("Image URL host could not be resolved")

    for item in resolved:
        address = item[4][0]
        if not _is_public_ip(address):
            raise ValueError("Image URL host resolves to a non-public address")

    return url
