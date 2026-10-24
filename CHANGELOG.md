# huubhuub

## 0.0.12

### Patch Changes

- [#26](https://github.com/Thijmen/huubhuub/pull/26) [`7200134`](https://github.com/Thijmen/huubhuub/commit/72001349a5b1724a5b797a86c937a51821033669) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the agent's gh commands failing on repos of an organization the GitHub App is installed on, like `gh repo clone org/repo` run outside a checkout. gh now gets a token for the account the command names.

## 0.0.11

### Patch Changes

- [#24](https://github.com/Thijmen/huubhuub/pull/24) [`c6d61b4`](https://github.com/Thijmen/huubhuub/commit/c6d61b419cfdb50f00653d4df6beba30153eea02) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the GitHub App not being installable on organizations. New apps are created public so any account you own can install them, and the GitHub page now explains how to make an existing private app public.

## 0.0.10

### Patch Changes

- [#22](https://github.com/Thijmen/huubhuub/pull/22) [`afc42a5`](https://github.com/Thijmen/huubhuub/commit/afc42a56552f7bba8438fc47682f32bc846dee82) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the model pickers on the admin Settings page opening behind the settings below them, so no model could be picked.

- [#18](https://github.com/Thijmen/huubhuub/pull/18) [`0b20f45`](https://github.com/Thijmen/huubhuub/commit/0b20f45bacd4977e0164e54f10f44197dfeed9c6) Thanks [@Thijmen](https://github.com/Thijmen)! - Fix the "✻ Pondering…" status sometimes staying on screen after the reply arrived in private chats.

## 0.0.9

### Patch Changes

- [#16](https://github.com/Thijmen/huubhuub/pull/16) [`306d0ff`](https://github.com/Thijmen/huubhuub/commit/306d0ff2b8c8fd2ad48a5389e45f07b6c9bc15ab) Thanks [@Thijmen](https://github.com/Thijmen)! - The Docker image is now published as `ghcr.io/thijmen/huubhuub` (was `ghcr.io/thijmen/huub-v2`).

## 0.0.8

### Patch Changes

- [#13](https://github.com/Thijmen/huubhuub/pull/13) [`0ca1b5f`](https://github.com/Thijmen/huubhuub/commit/0ca1b5f35073f54f5d4aac3b1006ecf889dc4ddf) Thanks [@Thijmen](https://github.com/Thijmen)! - Release with Changesets: each release gets a changelog entry, a CHANGELOG.md update and a GitHub release.
