# Agent Note: Feishu approval decider gating — validate-before-consume dispatch

Status: implemented

English | [中文](2026-09-17-feishu-approval-decider-gating.zh.md)

## Problem

The card-interaction bridge settled any click that carried a live interaction identity. `dispatch` deleted the pending entry before checking the verdict, so a malformed click (valid identity, no verdict) consumed the pending and left the waterfall hanging until its request aborted. Nothing checked who clicked: `operatorOpenId` was display-only, so anyone who could see an approval card in the chat could approve the tool call — group-chat visibility granted approval authority.

## Decision

- **A click is validated before it consumes anything.** `dispatch` resolves the pending, then — for approvals — requires a verdict on the click and an operator inside the configured deciders; only then does it delete the pending and settle the waterfall. A refused click answers with an error toast and leaves the card unchanged, so the pending stays claimable by a later valid click.
- **Deciders are parallel id allowlists.** `interactionCards.approval.deciderOpenIds` and `deciderUserIds` hold the ids allowed to decide approval cards, matched against the callback operator's `open_id` and `user_id` respectively; either hit qualifies. Whether the platform delivers `user_id` depends on the app's granted scope — a click without it falls to the open-id check, so the gate stays fail-closed either way, and whether real callbacks carry `user_id` under a given scope is left to real-platform verification. The checks read the live settings section, so a hot-applied rotation applies to the next click. Question forms stay answerable by the chat: ask-user answers carry no privilege.
- **No deciders configured means no approval claiming.** With both allowlists empty the bridge sends no approval card and passes the request through `next()` to other channels, the same delegation a disabled section produces. Card visibility never establishes decision authority; an unconfigured channel grants none.

## Alternatives considered

**Freeze the decider list into the pending at claim time.** Snapshotting the allowlist with each sent card would survive settings changes between send and click, but splits the authority a click is checked against; reading the live section keeps one authority and fails closed under rotation.

**Fail open when unconfigured.** Keeping the shipped anyone-can-decide behavior for empty allowlists preserves old compositions, but leaves the vulnerability exactly where no policy was configured; delegation keeps the default fail-closed.

**One id namespace per section.** A `deciderIdType` field naming the namespace one list carries keeps a single list, but forces re-keying it when the deployer's personnel records use the other id kind; two parallel lists compare like-for-like namespaces and admit entries of either kind.

**Grant the turn's sender decider rights by derivation.** Automatically letting the requesting message's sender decide was rejected for this cut: in group chats the sender and the approval owner can differ, and deriving deciders from roles belongs to the durable approval seam's trusted-rule resolution, not the in-turn card bridge.

## Consequences

Approval cards now require at least one populated decider list; a deployment that enables `interactionCards` without either keeps question cards but its approval requests fall back to other channels — the feishu-bot example wires the lists to `DSH_FEISHU_DECIDERS` and `DSH_FEISHU_DECIDER_USERS`. Malformed or unqualified clicks no longer strand a pending waterfall. The gate covers one card instance of one in-turn request; multi-level chains, trusted rule resolution, and out-of-turn expiry stay in the planned durable-approval seam, whose admission points reuse this validate-before-consume shape.

## Related decisions

The callback bridge, its ingress paths, and the card builders are recorded in [the card-interactions note](2026-09-14-feishu-card-interactions.md).
