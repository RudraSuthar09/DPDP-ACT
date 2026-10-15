# TEST-ONLY TLS fixtures

Used by `transport.spec.ts` and `network.e2e.spec.ts` to stand up local HTTPS
servers that imitate a corporate TLS-inspection CA. **Nothing here is trusted
by, or shipped with, the Gateway**: `src/` is pruned from the installer bundle.

| File | What it is |
|---|---|
| `test-ca.pem` | Self-signed root, `CN=DPDP Gateway TEST-ONLY Root CA`, `CA:TRUE`. Its private key was deleted right after signing, so no further certificates can be issued from it. |
| `localhost.pem` / `.key` | Leaf signed by the test CA; SAN `DNS:localhost, DNS:gateway-backend.test, IP:127.0.0.1`. `gateway-backend.test` (reserved TLD, never resolves) is the name proxy tests tunnel to: the mock proxy maps it to 127.0.0.1, so a direct connection attempt would fail instead of silently succeeding. |
| `wrong-host.pem` / `.key` | Leaf signed by the test CA; SAN `DNS:wrong.example` only (hostname-mismatch tests). |

Valid for 100 years. To regenerate, use OpenSSL (Git for Windows ships one):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -keyout test-ca.key -out test-ca.pem -days 36500 \
  -subj "/CN=DPDP Gateway TEST-ONLY Root CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
# per leaf: req -newkey ... | x509 -req -CA test-ca.pem -CAkey test-ca.key with
#   basicConstraints=CA:FALSE, extendedKeyUsage=serverAuth, subjectAltName=<SAN>
# then delete test-ca.key
```
