# Legacy control regression fixtures

These source fixtures preserve the existing website control-form regression tests from website commit `a05bd91`. They are test-only and are never imported by the Worker. The current operator authority belongs to `packages/dashboard` and `packages/runner`; this fixture is not a second operator service.

The retired, unreferenced Durable Object implementation is excluded from the migrated Worker source. Production operator requests continue through the authenticated service proxy.
