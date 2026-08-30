# Keep reusable artifact identity separate from a generation mount

> **Review:** Agent-only

The supervisor addresses executable main-harness contents by an `artifactDigest` over emitted module bytes and the metadata required to interpret them. It derives a separate mount key from its own instance identity, the assigned generation, and that digest, so changed bytes cannot reuse a Loader identity and two generations may reuse content without sharing a mount. The decision does not select a bundle or module-map encoding, artifact storage, retention, or the Dynamic Worker Loader payload.
