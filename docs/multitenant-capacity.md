# Multitenant development and E2E capacity

The runtime policy is versioned in `lib/runtime/capacity-policy.ts` and enforced
at three boundaries. The Firecracker launcher accepts only fixed `SMALL` (2C4G),
`STANDARD` (4C8G), or `LARGE` (8C16G) pool configurations. PostgreSQL migrations
`067_multitenant_capacity_guards.sql` and `068_shared_e2e_queue.sql` serialize
admission per workspace and physical Runner and derive immutable queue metadata,
so horizontally scaled workers and tenants cannot bypass fairness or priority.

- Reserve 8 vCPU and 24 GiB per development host for the host, caches and
  recovery. CPU scheduling may use 1.5x; memory remains 1.0x with no unsafe
  overcommit. The planning target is 28 standard-equivalent active microVMs.
- Each workspace may run two Agent jobs and one exclusive E2E attempt. These
  limits apply to active work, not to queued work, and are transactionally
  guarded with tenant-scoped advisory locks.
- Linux, Windows and macOS may each run two genuinely headless jobs per machine.
  Visual, GPU, audio, and Steam clean-install jobs are exclusive. A headless
  job never shares a machine with an exclusive job.
- Test machines are never reserved per user. Signed assignments are scanned
  round-robin across tenants; each tenant queue uses `RELEASE`, `INTERACTIVE`
  and `BACKGROUND` lanes. A one-minute aging boost prevents starvation and the
  shorter estimate backfills gaps within equal effective priority.
- Candidate validation starts with `linux-fast`; selected full gates then run
  in Linux, Windows, macOS order. Delivery still requires every selected full
  gate and its evidence bundle to pass.
- The scheduler keeps a 24-hour ready-work horizon. Linux and Windows target
  96% busy time / 90% productive time; macOS targets 94% / 85%. The remainder
  is an explicit reimage, evidence-upload, failure-recovery and interactive-SLO
  reserve, not unplanned idle capacity.
- Queue SLOs are Agent P95 <= 60 seconds, Linux/Windows interactive E2E P95 <=
  5 minutes, and macOS <= 10 minutes. Scale-out thresholds are deliberately
  high (92% CPU, 90% memory and 90% Mac occupancy), or immediate on an SLO
  breach, so adding capacity does not destroy fleet utilization.

## Requirements dialogue reserve

The requirements dialogue is not a test job and does not share the Agent or
E2E pools. `spec-dialogue` and `spec-model-broker` each keep three warm replicas
spread across different hosts, with at least two protected during voluntary
disruption. Every replica reserves 500m CPU and 512 MiB; autoscaling starts at
55% in-flight/CPU utilization and can grow to 20 replicas. Capacity alarms fire
when admission P95 exceeds 250 ms or a complete model turn exceeds 8 seconds.
This reserved pool remains responsive when Windows/Linux/macOS queues are
saturated.

The capacity policy never installs autonomous Agents on E2E or Steam nodes.
Those nodes execute only signed TestKit jobs or narrowly scoped release work.
