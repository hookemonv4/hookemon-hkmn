# PR38 archival verifier fixture

`objects.pack` contains the exact Git commit and tree objects for cleanup `34fc4006e3f05a60d6a3cd9fc8383b445330aa62`, public redaction `e142bfa101f87c80b121e9c558b2a681f9ee07dd`, and complete archive `c797b6c0a9c856752d05ee2ddd18dd2411571d6f`, plus their immediate parent commit/tree objects. Blob objects are limited to these commits' historical launch package, original module card, and archive paths. Unrelated source blobs and earlier ancestor history are intentionally absent.

The fixture allows the actual fixed-source verifier to run in CI without fetching orphan refs or depending on the developer's object store. Tests unpack it into isolated temporary repositories, create synthetic task rows and owner approvals there, and exercise the production verifier. Fixture approvals confer no project authority. The archive remains historical USDG evidence.
