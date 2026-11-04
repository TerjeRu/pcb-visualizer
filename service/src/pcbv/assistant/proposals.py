"""What the assistant proposes and the person decides: command cards, label and pin-role suggestions.

Proposals are kept in memory per board. A command is checked before a card exists and again at the
moment of approval; nothing is sent until the person approves.
"""
from __future__ import annotations

import re
import secrets
import threading
from collections.abc import Callable

from ..schema import now_iso
from ..serialmgr import destructive_reason, forbidden_command_character
from .errors import AssistantError

MAX_COMMAND_CHARS = 300
MAX_PROPOSALS = 50
UNSAFE_COMMAND_RE = re.compile(r"[;&|<>`]|\$\(")


def command_problem(command: str) -> str | None:
    """Why a command may not be proposed at all, or None. Beyond the console's own guard, a proposal
    is one plain command: no chaining, pipes or redirects, so what the person approves is what runs."""
    if not isinstance(command, str) or not command.strip():
        return "the command is empty"
    if problem := forbidden_command_character(command):
        return problem
    if len(command) > MAX_COMMAND_CHARS or any(ord(ch) < 32 or ord(ch) == 127 for ch in command):
        return f"a command is one line of printable text, at most {MAX_COMMAND_CHARS} characters"
    if UNSAFE_COMMAND_RE.search(command):
        return "a command must be a single plain command, without chaining, pipes or redirects"
    reason = destructive_reason(command)
    if reason:
        return f"it {reason}; the assistant never proposes commands that change the device"
    return None


class ProposalStore:
    def __init__(self) -> None:
        self.proposals: dict[str, dict[str, dict]] = {}
        self._decide_lock = threading.Lock()

    def _remember(self, slug: str, proposal: dict) -> None:
        board = self.proposals.setdefault(slug, {})
        board[proposal["id"]] = proposal
        while len(board) > MAX_PROPOSALS:
            board.pop(next(iter(board)))

    def propose(self, slug: str, command: str, reason: str) -> dict:
        problem = command_problem(command)
        proposal = {"id": f"prop_{secrets.token_hex(16)}", "kind": "command", "command": command[:MAX_COMMAND_CHARS],
                    "reason": reason, "status": "refused" if problem else "pending", "detail": problem or "",
                    "created": now_iso()}
        self._remember(slug, proposal)
        return dict(proposal)

    def suggest(self, slug: str, suggestion: dict, by: str) -> dict:
        """A label or pin roles from the model, waiting for the person. Nothing is written until they accept."""
        proposal = {**suggestion, "id": f"prop_{secrets.token_hex(16)}", "status": "pending", "detail": "",
                    "by": by, "created": now_iso()}
        self._remember(slug, proposal)
        return {"id": proposal["id"], "status": "pending",
                "detail": "shown to the person as a card; it becomes an unverified guess if they accept it"}

    def get_proposal(self, slug: str, proposal_id: str) -> dict:
        proposal = self.proposals.get(slug, {}).get(proposal_id)
        if proposal is None:
            raise AssistantError(f"no proposal {proposal_id!r}")
        return dict(proposal)

    def mark_accepted(self, slug: str, proposal_id: str) -> None:
        with self._decide_lock:
            proposal = self.proposals.get(slug, {}).get(proposal_id)
            if proposal is not None:
                proposal.update(status="accepted", detail="", decided=now_iso())

    def mark_failed(self, slug: str, proposal_id: str, detail: str) -> None:
        proposal = self.proposals.get(slug, {}).get(proposal_id)
        if proposal is not None:
            proposal.update(status="failed", detail=detail)

    def list_proposals(self, slug: str) -> list[dict]:
        return [dict(p) for p in self.proposals.get(slug, {}).values()]

    def decide(self, slug: str, proposal_id: str, action: str, send: Callable[[str], None]) -> dict:
        """Approve (send the command through `send`) or decline a pending proposal. Only the person
        can call this, through the app; the model has no tool for it."""
        with self._decide_lock:
            return self._decide(slug, proposal_id, action, send)

    def _decide(self, slug: str, proposal_id: str, action: str, send: Callable[[str], None]) -> dict:
        proposal = self.proposals.get(slug, {}).get(proposal_id)
        if proposal is None:
            raise AssistantError(f"no proposal {proposal_id!r}")
        if proposal["status"] != "pending":
            raise AssistantError(f"this proposal is already {proposal['status']}")
        if action == "decline":
            proposal.update(status="declined", detail="")
        elif action == "approve" and proposal.get("kind", "command") != "command":
            proposal.update(status="accepted", detail="", decided=now_iso())
        elif action == "approve":
            problem = command_problem(proposal["command"])     # checked again at the moment of approval
            if problem:
                proposal.update(status="refused", detail=problem)
            else:
                send(proposal["command"])
                proposal.update(status="sent", detail="", decided=now_iso())
        else:
            raise AssistantError("action must be approve or decline")
        return dict(proposal)


def suggestion_events(proposal: dict, project: dict) -> list[dict]:
    """The board events for an accepted label or pin-role suggestion. Each carries the guess: who made it,
    how sure it was and why, so the app shows it as unverified."""
    guess = {"by": str(proposal.get("by", "assistant"))[:120], "at": now_iso()}
    if proposal["kind"] == "label":
        asset = next((a for a in project.get("assets") or [] if a.get("id") == proposal["photo"]), None)
        if asset is None or not asset.get("width") or not asset.get("height"):
            raise AssistantError("the photo for this label is gone")
        w, h = asset["width"], asset["height"]
        x, y = proposal["x"] * w / 100, proposal["y"] * h / 100
        # The label sits up and to the right of the part, or to the left near the right edge.
        lx = x - 0.16 * w if x > 0.78 * w else x + 0.05 * w
        ly = max(0.03 * h, y - 0.05 * h)
        annotation = {"id": f"an_{secrets.token_hex(5)}", "assetId": asset["id"], "x": round(x, 1), "y": round(y, 1),
                      "lx": round(lx, 1), "ly": round(ly, 1), "text": proposal["text"][:200],
                      "guess": {**guess, "confidence": proposal["confidence"], "evidence": proposal["evidence"]}}
        if proposal.get("wiki"):
            annotation["wiki"] = proposal["wiki"]
        return [{"type": "annotation/added", "annotation": annotation}]
    if proposal["kind"] == "pins":
        return [{"type": "pin/updated", "schematicId": proposal["header"], "index": pin["pin"],
                 "patch": {"guess": {**guess, "role": pin["role"], "confidence": pin["confidence"], "evidence": pin["evidence"]}}}
                for pin in proposal["pins"]]
    raise AssistantError(f"cannot turn a {proposal['kind']} proposal into board changes")
