# Repository state-directory loss

## Detection

Treat an absent, unreadable, or replacement cycle state directory as unverified custody state.

## Safe stop

Do not recreate a cycle, claim funds, or infer prior state from a wallet balance.

## Runner behavior

The repository compares a private sibling identity with an in-directory witness
bound to that directory's device and inode. A missing, copied, or mismatched witness
creates a private sibling recovery hold and refuses cycle creation and stage
preparation until the preserved journal and custody evidence can be restored and reviewed.

`.store-lock/lease.sqlite` is not a replacement state directory and is normally retained after a
clean store release. A store owner first acquires SQLite's exclusive lease, then creates `store.lock`
with a PID and random token, and verifies the same inode, PID, and token before it removes its own
fence after releasing SQLite. Do not delete the SQLite file, its rollback journal, or `store.lock`
to work around contention. Once a crashed owner's SQLite operating-system lease has released, the
next opener reclaims only a fence with an unchanged inode and token whose recorded PID is absent.
A live, inaccessible, or changed fence remains contention.

## Operator recovery

No supported command reconstructs a lost state directory. A normal repository reopen reclaims only
the verified dead-owner fence described above. Preserve the state directory, journal digest, and
prior-owner evidence for review when a fence belongs to a live or inaccessible process, or its
inode or token has changed.

## Escalation

Escalate the last known journal digest, storage incident, and custody evidence.

## Evidence

Recovery requires the durable journal and independently reconciled custody.

## Recovery contract

Failure-matrix cells: Repository recovery:state-directory-loss
Owning work package: WP10a
Expected outcome: terminal=HELD_DATA_UNVERIFIED; attempt=none; next=owner-decision
Test: packages/adapters/test/app/cycle-repository.test.mjs — a copied state-directory marker persists an owner-decision recovery hold instead of accepting a replacement tree
Alarm reason/code: OPEN FACT (WP10a): no dedicated alert code is emitted for lost repository state.
Resume command: none supported; restore and verify the repository evidence before any economic action.
