/**
 * A `--import`/NODE_OPTIONS preload used only by tests. It deterministically freezes the
 * EVM or Solana wallet keychain child process before its own module graph (and therefore
 * its own bounded Keychain deadline) ever runs, so the caller's outer parent-envelope kill
 * deadline is the only mechanism that can possibly resolve the call. It never touches the
 * caller process itself: NODE_OPTIONS is inherited by every Node process in the tree, but
 * this only hangs a process whose argv carries one of the two keychain children's own
 * internal spawn flags (`--hookemon-evm-keychain-child` in
 * packages/adapters/src/signing/keychain-child-evm.mjs, or
 * `--hookemon-solana-wallet-keychain-child` in
 * packages/adapters/src/signing/operations-wallet-keychain-child.mjs).
 */
if (
  process.argv.includes('--hookemon-evm-keychain-child')
  || process.argv.includes('--hookemon-solana-wallet-keychain-child')
) {
  // A bare pending promise does not hold a libuv ref; without an active handle the
  // process would exit on its own once the (never-reached) main module finished loading.
  setInterval(() => {}, 1_000);
  await new Promise(() => {});
}
