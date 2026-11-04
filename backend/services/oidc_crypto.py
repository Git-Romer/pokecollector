"""Authenticated encryption for short-lived OIDC transaction secrets.

Only recoverable transaction material (the nonce and PKCE code verifier) is
encrypted here. Lookup/binding values are stored as irreversible keyed digests
(see :mod:`services.oidc_transactions`); they are never used as an encryption
key.

The AES-GCM key is derived from the resolved application JWT secret with
HKDF-SHA256 using the exact domain-separation context
``pokecollector-oidc-transaction-v1``. Rotating the JWT secret therefore makes
old transaction ciphertext undecryptable, which fails closed instead of issuing
a token.
"""
from __future__ import annotations

import os

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from services import auth

# Exact contract context; do not change without a migration/rotation plan.
TRANSACTION_CONTEXT_INFO = b"pokecollector-oidc-transaction-v1"
_AEAD_NONCE_BYTES = 12
_AEAD_TAG_BYTES = 16
_KEY_BYTES = 32


class TransactionCryptoError(RuntimeError):
    """Transaction secret could not be decrypted (tampered, wrong key or rotated)."""


def derive_transaction_key(secret_key: str | None = None) -> bytes:
    """Derive the 256-bit AEAD key from the application secret.

    ``secret_key`` exists only so tests can prove that rotation/wrong-key
    material fails closed; production callers must omit it and use the resolved
    ``services.auth.SECRET_KEY``.
    """
    material = auth.SECRET_KEY if secret_key is None else secret_key
    if not isinstance(material, str) or not material:
        raise TransactionCryptoError("OIDC transaction encryption key is unavailable")
    return HKDF(
        algorithm=hashes.SHA256(),
        length=_KEY_BYTES,
        salt=None,
        info=TRANSACTION_CONTEXT_INFO,
    ).derive(material.encode("utf-8"))


def encrypt_transaction_secret(plaintext: str, *, secret_key: str | None = None) -> bytes:
    """Encrypt one recoverable transaction secret; returns nonce || ciphertext."""
    if not isinstance(plaintext, str) or not plaintext:
        raise ValueError("Transaction secret must be a non-empty string")
    nonce = os.urandom(_AEAD_NONCE_BYTES)
    ciphertext = AESGCM(derive_transaction_key(secret_key)).encrypt(
        nonce,
        plaintext.encode("utf-8"),
        TRANSACTION_CONTEXT_INFO,
    )
    return nonce + ciphertext


def decrypt_transaction_secret(ciphertext: bytes, *, secret_key: str | None = None) -> str:
    """Decrypt a transaction secret, failing closed on tamper/key mismatch."""
    if not isinstance(ciphertext, (bytes, bytearray)):
        raise TransactionCryptoError("Transaction secret ciphertext is invalid")
    if len(ciphertext) < _AEAD_NONCE_BYTES + _AEAD_TAG_BYTES:
        raise TransactionCryptoError("Transaction secret ciphertext is invalid")
    nonce = bytes(ciphertext[:_AEAD_NONCE_BYTES])
    payload = bytes(ciphertext[_AEAD_NONCE_BYTES:])
    try:
        plaintext = AESGCM(derive_transaction_key(secret_key)).decrypt(
            nonce,
            payload,
            TRANSACTION_CONTEXT_INFO,
        )
    except (InvalidTag, ValueError) as exc:
        raise TransactionCryptoError("Transaction secret could not be decrypted") from None
    try:
        return plaintext.decode("utf-8")
    except UnicodeDecodeError:
        raise TransactionCryptoError("Transaction secret could not be decoded") from None
