# Codex Fusion — Attribution and Thanks

Codex Fusion is an independent integration and enhanced distribution built by combining and adapting excellent open-source projects. We are grateful to the original authors and contributors whose work made this project possible. Codex Fusion's contribution is the reviewed integration layer, compatibility safeguards, Control Center workflow, reproducible installation/upgrade contract, and additional local extensions; it does **not** replace or obscure the authorship of the upstream projects.

## Core upstream projects

- **Codex Router** — [duolahypercho/codex-router](https://github.com/duolahypercho/codex-router). This is the routing foundation and remains the reference upstream for the Codex Router core used inside Codex Fusion. Thank you to **duolahypercho** and all Codex Router contributors for building and maintaining the multi-provider routing foundation.
- **codex-chatgpt-web** — [miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web). Codex Fusion's guarded ChatGPT Web Bridge installs and manages an audited upstream revision rather than presenting that launcher/runtime as original Fusion code. Thank you to **miuuyy** and its contributors for making the ChatGPT Web integration possible.
- **codex-auto-resume** — [feifeigong/codex-auto-resume](https://github.com/feifeigong/codex-auto-resume). Codex Fusion integrates a pinned, audited revision through Control Center while keeping its behavior isolated from model routing. Thank you to **feifeigong** and contributors for the quota-resume workflow.

Each upstream component retains its own repository history, license, copyright notices, and project identity. When Codex Fusion installs an optional upstream sidecar, the upstream project remains the source of that component; Fusion adds lifecycle management and safety/compatibility gates around it.

## Additional attribution and prior art

This project uses the merged-model-catalog and built-in-provider routing
pattern demonstrated by [opencodex](https://github.com/lidge-jun/opencodex).
The implementation in this repository provides a registry-driven local router
for Codex plus built-in Kimi and DeepSeek integrations.

`opencodex` is distributed under the MIT License. Copyright (c) 2026
opencodex contributors.

The `devin-cli` provider's understanding of Cascade's Connect RPC surface —
the service path, the doubled `Basic` credential, and which request fields a
turn must carry — follows
[devin-2api](https://github.com/leookun/devin-2api), distributed under the MIT
License. Copyright (c) 2026 devin-2api contributors. The protobuf field
numbers in `src/devin-proto.mjs` are transcribed from the descriptor set
embedded in Cognition's own `devin` binary; no code was copied.

This is an independent community project. It is not affiliated with or
endorsed by OpenAI, Anthropic, Moonshot AI, the Kimi Code team, DeepSeek,
OpenRouter, or Cognition AI. GitHub and Copilot are trademarks of GitHub,
Inc.; this project's GitHub Copilot integration is not endorsed by GitHub.
Devin and Windsurf are trademarks of Cognition AI, Inc.

The GitHub Copilot tray mark is adapted from Primer Octicons' `copilot-24.svg`,
distributed under the MIT License. Copyright (c) 2026 GitHub Inc.
