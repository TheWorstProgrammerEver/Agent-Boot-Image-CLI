# Definitive agent definition example

This host-neutral example preserves the authoritative Agent Boot scratchpad's
ordered bootstrap semantics without copying its illustrative credentials,
network identity, key filenames, or agent-local identity.

Replace `<network-ssid>` and `<reviewed-version>` during deployment planning.
Supply the three referenced secrets through the future imaging workflow; do not
put their contents in this directory. `installUserSecret()` represents the
transactional install primitive, including protected destination creation,
verification, resumable source removal, and no declaration-authored cleanup.

The Codex sequence is deliberately ordered: install a reviewed version, write
and verify the YOLO profile, complete device authentication, leave bootstrap
mode, render the prompt, and only then invoke the provider. The provider's
working root is explicit. Command descriptors in this example are declarative;
this example and its conformance tests do not execute them.

The checked-in canonical fixtures use a stable `file:///workspace/` base so
their serialization is host-independent. `provenance.json` records their
relationship to this source example and the authoritative scratchpad digest.
