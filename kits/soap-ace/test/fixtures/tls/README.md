# TEST ONLY TLS material

Self-signed CA, a `localhost` server certificate, and a client certificate
(PEM and PKCS#12, passphrase `test-only-passphrase`) used by
`Transport.test.ts` to exercise mTLS against a local HTTPS server. Generated
for this repository's tests; they protect nothing and must never be used
anywhere else. The CA key was discarded after signing.
