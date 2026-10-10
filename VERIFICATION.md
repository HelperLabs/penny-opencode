# OpenCode 0.1.0 verification

Verified on 2026-10-10 against the released **OpenCode 1.18.35** binary and `@opencode-ai/plugin@1.18.35`.

## Results

- `npm test`: 16 tests passed. Covers configuration preservation, conflicting endpoints and headers, explicit acknowledgements, native approvals, session identity, child/shared sessions, disablement, disposal and configuration changes.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npm audit --omit=dev --audit-level=high`: zero production vulnerabilities.
- All eight bundled skill/reference files match Penny's canonical public skill tree byte for byte. Skill version: 1.0.9; tree fingerprint: `d33dda1e7d0a77d5fe7548c8f36cf277b4d5bd82c106743de2f901738333436f`.
- Native loader, user-message reminder, system guidance and compaction were exercised with the actual host and a deterministic model on loopback.
- Native OAuth completed discovery, dynamic client registration, browser sign-in/consent, PKCE callback and token exchange. OpenCode stored access and refresh tokens in its own isolated credential file, with mode `0600`. No tokens were copied from another client.
- The host rejected unenabled sessions, missing acknowledgement, rejected enablement and native child sessions. Accepted enablement used the host's permission queue and a one-time approval.
- Native Penny write, exact-ID readback, soft-delete and empty deletion readback passed. The only retrieved memory was a harmless synthetic note created by this test.
- Compaction retained public Penny guidance and invoked zero tools. Disabling Penny then blocked another read.
- Final live run: 25 local model requests, 25 system-guidance requests, one compaction-guidance request, cleanup complete. Both synthetic notes created during verification were confirmed deleted.

Penny's unauthenticated public catalog returns HTTP 200. Its existing `X-MyPenny-Require-Auth: true` compatibility header returns HTTP 401 with an OAuth challenge. This header is required because this OpenCode version can report a successful connection to a public catalog without obtaining tokens. The verifier checks token presence, resource URL and expiry before calling private tools.

## Boundaries

The deterministic model tests host integration and permission enforcement, not the behavior of every model. Actual model compliance with recall/capture guidance depends on that model. Native sharing was not exercised because it can publish a conversation; shared-session rejection is unit-tested. Token refresh was not forced. Native approval requests were answered through OpenCode's permission API during the test, rather than a terminal UI.

Compaction is best effort and has no tools. A different plugin that replaces the compaction prompt suppresses Penny's added context. Disablement cannot cancel a native operation already awaiting approval or in flight. See the README for the data flow and privacy limits.

## Reproduce safely

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
npm audit --omit=dev --audit-level=high
node node_modules/opencode-ai/postinstall.mjs
node scripts/verify-host.mjs --host
```

The host verifier uses isolated XDG paths under `.live/state`, an empty workspace and a loopback model provider. It inherits no Penny, GitHub or cloud credentials. It leaves `HOME` unchanged. The `--host` mode performs no private Penny tool call; a remote connection can still query public metadata and discover OAuth requirements.

For a live test, run `node scripts/verify-host.mjs --prepare`, then run `opencode mcp auth penny` with the same isolated XDG and `OPENCODE_CONFIG` paths. After native OAuth completes, run `node scripts/verify-host.mjs --live`. It deliberately writes one synthetic private note, retrieves only that ID and soft-deletes it. Never substitute a real note ID or copy another client's tokens.

## Release inputs

`release-toolchains.json` declares the pinned release tools and dependency install-script decisions. Canonical skill copying happens during assembly before the public source commit; builds use only the committed skill tree inside this repository.

The release workflow audits dependencies and generates `release-dependencies.json` from its clean immutable public source commit before packing or publishing. The manifest records the source commit/ref, exact tools, lock/input digests and production dependency tree. Two generations must produce identical bytes. GitHub retains the manifest and npm tarball as a commit-keyed artifact for 90 days. Generated manifests are included in the npm artifact and are not checked back into source.
