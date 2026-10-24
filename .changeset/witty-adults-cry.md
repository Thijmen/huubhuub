---
"huubhuub": patch
---

Fix the agent's gh commands failing on repos of an organization the GitHub App is installed on, like `gh repo clone org/repo` run outside a checkout. gh now gets a token for the account the command names.
