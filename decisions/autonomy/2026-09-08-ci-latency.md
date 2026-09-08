# CI latency maintenance scope

The owner explicitly authorized changes to project files and framework workflows to improve continuous autonomous work, including removing unnecessary merge confirmations. The owner then asked why CI delays merges and whether a better approach is available. This maintenance task applies that existing scope to two verified causes of wasted CI time.

The code gate retains its standalone full-repository clean-room scan and all scanner rules. The scanner test suite no longer repeats that same full-repository invocation; its positive, negative, binary and exception fixtures remain. The gate's job condition changes from `always()` to `!cancelled()` so an obsolete run can terminate. On every non-cancelled run, the first step still requires the Phase 3 bytecode job to have succeeded before any other work runs.

The v2 control-pin record in `product/dependency-verification.json` binds only the resulting workflow hash and the verifier hash changed by that workflow constant. It records the existing workflow-maintenance authorization, not a new owner review of test results. No scanner rule, required test suite, trusted-base validation, status requirement, secret policy, launch condition or financial authorization is removed or bypassed. The candidate still requires independent review and green current CI before the authorized serial merge.

Any broader path-based test selection, trusted scan cache or financial change is outside this patch and requires its own implementation and evidence.
