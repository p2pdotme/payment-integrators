---
name: New integrator proposal
about: Propose a new integrator before opening a PR
title: "[Proposal] <Integrator Name>"
labels: ["proposal", "integrator"]
---

## Summary

<!-- One-line description of what this integrator does. -->

## Why a new integrator?

<!-- What does it do that ExampleIntegrator / LotPotCheckoutIntegrator can't? -->

## Business client

<!-- Which contract receives the USDC and delivers the product? Is it new, or an existing one? -->

## External dependencies

<!-- List any third-party protocols / oracles / vaults this integrator routes through.
     For each, include the verified mainnet address. -->

## Order flow

<!-- Walk through one happy-path order from userPlaceOrder to delivery.
     Note anything async (batch orders, keepers, etc.) -->

## Custody / proxy

- [ ] Uses canonical `UserProxy` unmodified
- [ ] USDC never exits a proxy to the user EOA

## Limits

- [ ] Uses standard RP-based per-tx + daily-count limits
- [ ] Or: custom limit shape (describe):

## Target networks

- [ ] Base mainnet
- [ ] Base Sepolia (testing first)

## Maintainer / contact

<!-- Who owns this long-term? Who do we reach out to for incident response? -->

## Open questions

<!-- Anything you're unsure about; reviewers can weigh in before you start coding. -->
