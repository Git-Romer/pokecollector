"""Exercise the shipped Nginx image cache with a synthetic upstream.

Run in a disposable network alongside the frontend, with this server reachable
as backend:8000. No application database, external requests or real photos are
used. Example: python scripts/test-image-proxy-cache.py --bind 0.0.0.0
--proxy-url http://frontend. The frontend must use the candidate nginx.conf.
"""
import argparse
import hashlib
import http.client
import json
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class Fixture(BaseHTTPRequestHandler):
    counts = Counter()
    lock = threading.Lock()

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        with self.lock:
            self.counts[self.path] += 1
            count = self.counts[self.path]
        path = urlsplit(self.path).path
        status = 200
        cache = "public, max-age=0, s-maxage=60, must-revalidate"
        body = ("<svg xmlns='http://www.w3.org/2000/svg'><!--" + "synthetic-art " * 10000 + "--></svg>").encode()
        if "/private/" in path:
            cache = "private, no-store"
        elif "/missing/" in path and count == 1:
            status, cache, body = 307, "no-store", b""
        elif "/expires/" in path:
            cache = "public, max-age=0, s-maxage=1, must-revalidate"
            body = f"artwork version {count}".encode()
        elif "/failure/" in path:
            cache = "public, max-age=0, s-maxage=1, must-revalidate"
            if count > 1:
                status, cache, body = 503, "no-store", b"unavailable"
        self.send_response(status)
        self.send_header("Cache-Control", cache)
        self.send_header("ETag", '"' + hashlib.sha256(body).hexdigest() + '"')
        self.send_header("Content-Type", "image/svg+xml")
        self.send_header("Content-Length", str(len(body)))
        if status == 307:
            self.send_header("Location", "/cardback.jpg")
        self.end_headers()
        self.wfile.write(body)


def exercise(proxy):
    target = urlsplit(proxy)
    if target.scheme not in ("http", "https") or not target.hostname or target.username or target.password:
        raise ValueError("A credential-free HTTP(S) test proxy URL is required")

    def get(path, headers=None):
        cls = http.client.HTTPSConnection if target.scheme == "https" else http.client.HTTPConnection
        connection = cls(target.hostname, target.port, timeout=5)
        try:
            connection.request("GET", path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def header(response, name):
        return next((value for key, value in response[1].items() if key.lower() == name.lower()), None)

    def check(condition, detail):
        if not condition:
            raise AssertionError(detail)

    deadline = time.monotonic() + 30
    while True:
        try:
            if get("/api/images/card/ready/small")[0] == 200:
                break
        except (OSError, http.client.HTTPException):
            pass
        if time.monotonic() >= deadline:
            raise TimeoutError("The disposable frontend did not become ready")
        time.sleep(0.1)

    # Seed short-lived entries before the fast cases so expiry needs only one
    # bounded wait, not a sleep for each scenario.
    expire_path = "/api/images/card/expires/small"
    failure_path = "/api/images/card/failure/small"
    expired = get(expire_path)
    get(failure_path)
    expires_after = time.monotonic() + 2.2
    results = []

    def case(name, action):
        try:
            detail = action()
            results.append({"name": name, "passed": True, "detail": detail})
        except AssertionError as error:
            results.append({"name": name, "passed": False, "error": str(error)})

    def public_hit():
        path = "/api/images/card/public/small"
        first, second = get(path), get(path)
        check(first[0] == second[0] == 200 and first[2] == second[2], "Public bytes changed")
        check(Fixture.counts[path] == 1, "A repeated public image reached the upstream")
        conditional = get(path, {"If-None-Match": header(first, "ETag")})
        check(conditional[0] == 304 and conditional[2] == b"", "Cached ETag did not eliminate the response body")
        check(Fixture.counts[path] == 1, "A fresh cached validator reached the upstream")
        return {"requests": 3, "upstreamRequests": Fixture.counts[path], "imageBytes": len(first[2]), "conditionalBodyBytes": len(conditional[2])}

    def private_bypass():
        path = "/api/images/card/private/small"
        get(path)
        get(path)
        check(Fixture.counts[path] == 2, "Private artwork entered the shared cache")

    def uncached_path(path):
        get(path)
        get(path)
        check(Fixture.counts[path] == 2, "An excluded path entered the image cache: " + path)

    def credential_bypass(name, headers):
        path = "/api/images/card/" + name + "/small"
        get(path, headers)
        get(path, headers)
        check(Fixture.counts[path] == 2, "Credentialed or retry requests entered the shared cache")

    def fallback_recovery():
        path = "/api/images/card/missing/small"
        first, second = get(path), get(path)
        check(first[0] == 307 and second[0] == 200, "A fallback redirect hid newly available artwork")
        check(Fixture.counts[path] == 2, "A fallback response was cached")

    def security_headers():
        response = get("/api/images/card/security/small")
        check(header(response, "Content-Security-Policy") is not None, "Image location dropped the inherited CSP")
        check(header(response, "X-Content-Type-Options") == "nosniff", "Missing nosniff")
        check(header(response, "X-Frame-Options") == "SAMEORIGIN", "Missing frame protection")

    def expiry_update():
        response = get(expire_path, {"If-None-Match": header(expired, "ETag")})
        check(response[0] == 200 and response[2] != expired[2], "Expired artwork did not refresh")
        check(Fixture.counts[expire_path] == 2, "Expired artwork was not revalidated")

    def no_stale_on_error():
        response = get(failure_path)
        check(response[0] == 503, "A stale successful image hid an upstream failure")

    case("public image cache hit and body-free conditional request", public_hit)
    case("private artwork bypass", private_bypass)
    case("product token route excluded even if upstream labels it public", lambda: uncached_path("/api/images/product/1?token=synthetic"))
    case("fingerprint route always revalidated", lambda: uncached_path("/api/images/card/public/fingerprint"))
    case("private photo route excluded", lambda: uncached_path("/api/collection/1/photo"))
    case("authorization bypass", lambda: credential_bypass("authorized", {"Authorization": "Bearer synthetic-test-user"}))
    case("cookie bypass", lambda: credential_bypass("cookie", {"Cookie": "synthetic=test-user"}))
    case("explicit no-cache bypass", lambda: credential_bypass("forced", {"Cache-Control": "no-cache"}))
    case("retry URL bypass", lambda: uncached_path("/api/images/card/retry/small?retry=1"))
    case("fallback recovery", fallback_recovery)
    case("inherited security headers", security_headers)
    time.sleep(max(0, expires_after - time.monotonic()))
    case("expired artwork refresh", expiry_update)
    case("no stale success on upstream failure", no_stale_on_error)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--proxy-url", required=True)
    args = parser.parse_args()
    Fixture.counts.clear()
    server = ThreadingHTTPServer((args.bind, args.port), Fixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        results = exercise(args.proxy_url)
        print(json.dumps({"results": results, "passed": sum(item["passed"] for item in results), "total": len(results)}, indent=2))
        return int(any(not item["passed"] for item in results))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        if thread.is_alive():
            raise RuntimeError("Synthetic upstream did not shut down")


if __name__ == "__main__":
    raise SystemExit(main())
