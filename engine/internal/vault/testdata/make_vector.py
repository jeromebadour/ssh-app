# Makes testdata/v1.json: one sealed file computed by a second, unrelated implementation (argon2-cffi and
# libsodium through PyNaCl), following only the layout written at the top of vault.go. The Go test opens it and
# must also produce the same bytes from the same inputs. Not run by any build or check; run by hand when the
# format changes:  python3 make_vector.py > v1.json   (needs: pip install argon2-cffi pynacl)
import hashlib, hmac, json, struct
from argon2.low_level import Type, hash_secret_raw
from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt

password = b"correct horse battery staple"
contents = b'{"boxes":[{"name":"demo-eu","host":"203.0.113.7"}]}'
time_cost, memory_kib, threads = 2, 65536, 3
saved_at = 1794787200  # 2026-11-16 00:00:00 UTC
salt = bytes(range(16))
nonce = bytes(range(0x40, 0x40 + 24))

derived = hash_secret_raw(password, salt, time_cost, memory_kib, threads, 64, Type.ID, 0x13)
seal_key, check_key = derived[:32], derived[32:]

head = b"BERTHVLT" + bytes([1, 1, 1, threads]) + struct.pack(">IIq", time_cost, memory_kib, saved_at) + salt + nonce
assert len(head) == 68
head += hashlib.sha256(head).digest()[:8]
head += hmac.new(check_key, head, hashlib.sha256).digest()
assert len(head) == 108
sealed = head + crypto_aead_xchacha20poly1305_ietf_encrypt(contents, head, nonce, seal_key)

print(json.dumps({
    "password": password.decode(), "contents": contents.decode(),
    "time": time_cost, "memoryKiB": memory_kib, "threads": threads, "savedAt": saved_at,
    "salt": salt.hex(), "nonce": nonce.hex(), "sealed": sealed.hex(),
}, indent=2))
