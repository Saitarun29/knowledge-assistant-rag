---
title: Information Security Policy
owner: Security Team
updated: 2026-06-30
---
# Information Security Policy

Northwind Labs is SOC 2 Type II certified. Every employee is responsible for protecting customer and company data.

## Passwords and authentication

- Use **1Password** for every work credential. Passwords must be at least **14 characters** and unique.
- **Single sign-on via Okta** is mandatory for all SaaS tools that support it.
- Multi-factor authentication is required everywhere. Hardware keys (YubiKey) are required for engineers with production access and are shipped on request.
- Never share credentials, including with IT. IT will never ask for your password.

## Devices

- Company laptops must be enrolled in **Kandji**, with full-disk encryption (FileVault) on and automatic OS updates enabled.
- Screens lock after **5 minutes** of inactivity.
- Personal devices may access Slack and Google Workspace only through the official mobile apps with a device passcode set. Customer data must never be stored on personal devices.

## Data classification

| Level | Examples | Handling |
|---|---|---|
| Public | Website, published docs | No restrictions |
| Internal | Roadmaps, wiki pages | Employees only |
| Confidential | Contracts, financials, HR records | Need-to-know, no external sharing |
| Restricted | Customer data, secrets, keys | Encrypted, access logged, never in Slack or email |

## Access

Production access follows least privilege and is reviewed **quarterly**. Access requests go through the #access-requests workflow and need manager plus Security approval. Access is revoked within **24 hours** of an employee leaving.

## AI tools

Approved AI tools are listed in Notion under *Security > Approved AI tools*. Do not paste Confidential or Restricted data into any AI tool that is not on the approved list.

## Reporting incidents

If you suspect phishing, a lost device, or a data leak, report it **immediately** — within 1 hour — in **#security-incidents** or to security@northwindlabs.example. Lost or stolen laptops can be remotely wiped, so speed matters. You will never be penalised for reporting in good faith.

## Training

All staff complete Security Awareness training at onboarding and **annually** thereafter. Phishing simulations run monthly.
