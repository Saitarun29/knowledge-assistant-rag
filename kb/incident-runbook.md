---
title: Incident Response Runbook
owner: Platform Engineering
updated: 2026-08-20
---
# Incident Response Runbook

Use this runbook for any production incident affecting Northwind Flow customers.

## Severity levels

| Severity | Definition | Response target |
|---|---|---|
| **SEV1** | Full outage, data loss, or security breach affecting many customers | Acknowledge in **5 min**, update every **30 min** |
| **SEV2** | Major feature degraded, or one Enterprise customer down | Acknowledge in **15 min**, update every hour |
| **SEV3** | Minor bug or degraded performance with a workaround | Next business day |

## Declaring an incident

1. Anyone can declare an incident. Type `/incident declare` in Slack.
2. This creates a dedicated channel (`#inc-YYYYMMDD-short-name`) and pages the on-call engineer via **PagerDuty**.
3. Assign an **Incident Commander (IC)**. The IC coordinates; they do not debug.
4. Assign a **Communications lead** for SEV1/SEV2.

## On-call

The primary on-call engineer rotates weekly, Monday 10:00 UTC. The secondary on-call takes over if the primary does not acknowledge a page within **10 minutes**. On-call engineers receive a stipend of $300 per week.

## Customer communication

- Post the first update on status.northwindlabs.example within **20 minutes** of declaring a SEV1.
- Enterprise customers with a named CSM are contacted directly by their CSM.
- Never speculate about root cause in public updates.

## Mitigation first

Prioritise restoring service over finding the root cause. Common mitigations:
- Roll back the last deploy with `deployctl rollback flow-api`.
- Fail over to the standby database region.
- Disable the faulty feature flag in LaunchDarkly.
- Scale the worker pool with `kubectl scale deploy flow-workers --replicas=40`.

## Resolution and postmortem

- The IC declares the incident resolved once metrics are back to normal for 30 minutes.
- A **blameless postmortem** is required for every SEV1 and SEV2, published in Notion within **5 business days**.
- Action items are tracked in Linear with the `postmortem` label and an owner and due date.

## Security incidents

If the incident involves a possible breach or leaked credentials, page the Security on-call immediately and follow the Security Policy. Customers must be notified of a confirmed personal-data breach within **72 hours**.
