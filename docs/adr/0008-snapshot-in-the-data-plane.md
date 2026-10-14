# ADR-0008: Keep a copy of the snapshot inside the data plane's failure domain

- **Status:** Accepted
- **Date:** 2026-10-14
- **Supersedes:** the object-storage channel proposed in ADR-0003 (decision 5)

## Context

A gateway serves every request from its in-memory snapshot (ADR-0002) and
keeps serving the last good one while the control plane is down (ADR-0005).
It also writes the snapshot, encrypted, to local disk, so a restarted
container finds it again.

The first failure test on GCP (2026-10-14, `deploy/gcp`) confirmed the first
half: with the control plane scaled to zero, running gateways served 6,001
requests with no errors. It also showed the gap. A gateway pod that was
deleted during the outage came back on an empty `emptyDir`, had no snapshot,
and stayed unready until the control plane returned. On Kubernetes, pods are
replaced for reasons nobody chose (node upgrades, evictions, OOM kills), so a
long control plane outage slowly drains the data plane.

The same gap matters more in the hybrid deployment, where the control plane
runs in Stratum's cloud and the gateways in the customer's datacenter. A
network cut between the two is, for the gateways, a control plane outage of
unknown length.

We considered:

- **Object storage written by the gateways** (the ADR-0003 proposal). Needs
  cloud credentials and a bucket in every installation, and gives every
  gateway write access to a resource outside the cluster.
- **Object storage written by the control plane.** Gateways only read, but in
  the hybrid case the bucket lives with the control plane, on the far side of
  the same network cut. It does not help when it is needed most.
- **Bootstrap from a sibling gateway.** No new component, but it fails when
  every replica restarts during the same outage, and it needs peer discovery
  and a new internal endpoint.
- **Valkey.** Multi-replica installations already run it for shared quotas
  (ADR-0004), next to the gateways, with persistence.

## Decision

**Rule: everything the data plane needs to start and to serve lives in the
data plane's own failure domain.** Nothing on the request path or on the
startup path may depend on the control plane, or on the network between the
customer and the control plane. In particular, Valkey always runs next to the
gateways, never as a shared service in Stratum's cloud.

1. **Write.** After a sync applies a change, each gateway stores the snapshot
   in Valkey under `<prefix>:{snapshot}:<instance_id>`, as the same blob it
   writes to disk (AES-256-GCM with `STRATUM_SNAPSHOT_KEY`). Valkey only ever
   sees ciphertext.
2. **Newest wins.** The write is a Lua script that never puts an older
   configuration back, so replicas racing each other are safe:
   - after a delta, the copy is replaced only by a higher version;
   - after a full resync, also by an equal version, because a full resync is
     the control plane's complete current state and some changes (a removed
     key, a team moved to another policy) reach gateways only that way,
     without raising the version. It also refreshes the copy's saved-at time;
   - a gateway that sees the control plane's version go backwards (for
     example a database restored from a backup) overwrites unconditionally.
3. **Read only when needed.** A gateway that starts without a snapshot on disk
   tries the control plane first. If it has not synced after
   `STRATUM_SNAPSHOT_BOOTSTRAP_TIMEOUT` (default 10 s), it loads the copy from
   Valkey, provided it is newer than what it has. Any later successful sync
   replaces it as usual. In normal operation new pods therefore always start
   from the control plane, and the shared copy is only used during an outage.
4. **Off the request path.** Valkey is never consulted to answer a request.
   If it is down, writes are retried at the next change or full resync, and
   startup behaves as before.
5. **Opt-in by configuration.** The shared copy is on when both
   `STRATUM_VALKEY_URL` and `STRATUM_SNAPSHOT_KEY` are set, and can be turned
   off with `STRATUM_SNAPSHOT_SHARED=false`. A single replica without Valkey
   keeps the disk-only behaviour.

## Consequences

- A pod can start and serve during a control plane outage or a network cut,
  as long as Valkey is up. The data plane stops being able to start only if
  the control plane and Valkey are unavailable at the same time.
- During an outage a new pod serves the configuration that was current when
  the control plane was last reachable, with the same staleness as the pods
  that never restarted (ADR-0005). Changes made in the console meanwhile,
  revocations included, apply when the control plane is reachable again; the
  `snapshot-stale` alert covers this.
- Every replica sends the blob to Valkey after each change. The script makes
  the extra writes no-ops, but the bytes still travel; at very large
  snapshots or replica counts, a check-then-write would save bandwidth.
- If the control plane database is restored from a backup while no gateway is
  running, Valkey keeps a copy with a higher version than the restored one,
  and the first gateways skip their writes until the versions pass it again.
  The restore runbook deletes the `{snapshot}` key. Gateways that are running
  during the restore fix it themselves (decision 2).
- A forced write can race with a newer write from another replica and put
  the copy back by one version; the next full resync of any replica
  (`STRATUM_FULL_RESYNC_INTERVAL`, 10 min) corrects it.
- The copy is limited by the gateway's Valkey client to 64 MiB, the same bound
  as a sync response.
- Valkey needs persistence (AOF or a replica) for this to survive a Valkey
  restart, as for quotas. The blob is encrypted, but Valkey should still run
  with auth and TLS (`rediss://`, both supported by the client). Managed
  offerings that require a custom CA bundle or token auth, such as
  Memorystore's in-transit encryption, are tracked for the first release.
