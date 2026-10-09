import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createHash, randomUUID } from "node:crypto";

const STATE_TYPE = "omp-sessions.ralph.state";
const JUDGE = "/Users/jin.yeon/bin/adverse-judge";
const DEFAULT_CONTINUATIONS = 8;
const MIN_CONTINUATIONS = 3;
const MAX_CONTINUATIONS = 15;
const BUDGET_LINE = /^\s*CONTINUATION_BUDGET:\s*(\d+)\s*$/m;
const MAX_EVIDENCE_CHARS = 24_000;
const MAX_CRITERIA_CHARS = 12_000;
const MAX_GIT_CHARS = 8_000;
type RalphState = {
  runId: string;
  active: boolean;
  task: string;
  criteria: string;
  criteriaHash: string;
  attempts: number;
  maxContinuations: number;
};

type StateEntry = RalphState & {
  version: 1;
  kind: "start" | "update";
};

type JudgeResult = {
  verdict: "positive" | "negative";
  reason?: unknown;
  [key: string]: unknown;
};

// Reads the budget line the criteria agent appends, clamps it to the allowed range, and removes it from the criteria.
function splitBudget(reply: string): { criteria: string; maxContinuations: number } {
  const match = reply.match(BUDGET_LINE);
  if (!match) return { criteria: reply.trim(), maxContinuations: DEFAULT_CONTINUATIONS };
  const requested = Number(match[1]);
  const maxContinuations = Math.min(MAX_CONTINUATIONS, Math.max(MIN_CONTINUATIONS, requested));
  return { criteria: reply.replace(BUDGET_LINE, "").trim(), maxContinuations };
}

function criteriaHash(criteria: string): string {
  return createHash("sha256").update(criteria, "utf8").digest("hex");
}

function validStart(data: unknown): StateEntry | undefined {
  if (!data || typeof data !== "object") return;
  const value = data as Partial<StateEntry>;
  if (
    value.version !== 1 ||
    value.kind !== "start" ||
    typeof value.runId !== "string" ||
    !value.runId ||
    value.active !== true ||
    typeof value.task !== "string" ||
    !value.task ||
    typeof value.criteria !== "string" ||
    !value.criteria ||
    typeof value.criteriaHash !== "string" ||
    value.criteriaHash !== criteriaHash(value.criteria) ||
    value.attempts !== 0 ||
    !Number.isSafeInteger(value.maxContinuations) ||
    value.maxContinuations! < MIN_CONTINUATIONS ||
    value.maxContinuations! > MAX_CONTINUATIONS
  ) {
    return;
  }
  return value as StateEntry;
}

function validUpdate(data: unknown, start: StateEntry): StateEntry | undefined {
  if (!data || typeof data !== "object") return;
  const value = data as Partial<StateEntry>;
  if (
    value.version !== 1 ||
    value.kind !== "update" ||
    value.runId !== start.runId ||
    value.task !== start.task ||
    value.criteria !== start.criteria ||
    value.criteriaHash !== start.criteriaHash ||
    value.maxContinuations !== start.maxContinuations ||
    typeof value.active !== "boolean" ||
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0
  ) {
    return;
  }
  return value as StateEntry;
}

function branchEvidence(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getBranch();
  const selected: string[] = [];
  let remaining = MAX_EVIDENCE_CHARS;

  for (let index = entries.length - 1; index >= 0 && remaining > 0; index--) {
    let text: string;
    try {
      text = JSON.stringify(entries[index]);
    } catch {
      text = `[unserializable session entry at index ${index}]`;
    }
    const line = `${index}: ${text}`;
    if (line.length > remaining) {
      selected.push(line.slice(0, remaining));
      break;
    }
    selected.push(line);
    remaining -= line.length + 1;
  }

  return selected.reverse().join("\n");
}

function judgeRequest(task: string, criteria: string, evidence: string, gitStatus?: string, gitDiffStat?: string): string {
  return [
    "Original Ralph task:",
    task,
    "",
    "Locked inferred goal and acceptance criteria:",
    criteria,
    "",
    "Bounded evidence from the current session branch (oldest selected entry first):",
    evidence || "[no session evidence]",
    "",
    "git status --short:",
    gitStatus ?? "[unavailable]",
    "",
    "git diff --stat:",
    gitDiffStat ?? "[unavailable]",
  ].join("\n");
}

export default function ralph(pi: ExtensionAPI): void {
  let state: RalphState | undefined;
  let sessionId: string | undefined;
  let stateGeneration = 0;
  function persist(kind: StateEntry["kind"]): void {
    if (!state) return;
    pi.appendEntry(STATE_TYPE, { version: 1, kind, ...state } satisfies StateEntry);
  }

  function restore(ctx: ExtensionContext): void {
    stateGeneration++;
    sessionId = ctx.sessionManager.getSessionId();
    let start: StateEntry | undefined;
    let restored: RalphState | undefined;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
      const nextStart = validStart(entry.data);
      if (nextStart) {
        start = nextStart;
        restored = {
          runId: nextStart.runId,
          active: true,
          task: nextStart.task,
          criteria: nextStart.criteria,
          criteriaHash: nextStart.criteriaHash,
          attempts: 0,
          maxContinuations: nextStart.maxContinuations,
        };
        continue;
      }
      if (!start) continue;
      const update = validUpdate(entry.data, start);
      if (update) {
        restored = {
          runId: start.runId,
          active: update.active,
          task: start.task,
          criteria: start.criteria,
          criteriaHash: start.criteriaHash,
          attempts: update.attempts,
          maxContinuations: start.maxContinuations,
        };
      }
    }
    state = restored;
  }

  function ensureCurrentSession(ctx: ExtensionContext): void {
    if (sessionId !== ctx.sessionManager.getSessionId()) restore(ctx);
  }

  async function git(ctx: ExtensionContext, args: string[]): Promise<string | undefined> {
    const result = await pi.exec("git", ["-C", ctx.cwd, ...args]);
    return result.code === 0 ? (result.stdout.trim() || "[clean]").slice(0, MAX_GIT_CHARS) : undefined;
  }

  function failureReason(detail: string): string {
    return `Ralph could not run or parse the adverse judge: ${detail}. Run ${JUDGE} manually, or use /ralph stop.`;
  }

  function judgmentIsCurrent(ctx: ExtensionContext, generation: number, runId: string): boolean {
    return (
      stateGeneration === generation &&
      sessionId === ctx.sessionManager.getSessionId() &&
      state?.runId === runId &&
      state.active
    );
  }

  async function inferCriteria(task: string, ctx: ExtensionContext): Promise<{ criteria: string; maxContinuations: number }> {
    if (!ctx.runEphemeralTurn) {
      throw new Error("This OMP runtime cannot run the adverse criteria agent. Update OMP and retry.");
    }
    const result = await ctx.runEphemeralTurn({
      tools: false,
      maxTokens: 2000,
      promptText: [
        "Act as an adversarial acceptance-criteria author.",
        "Infer the user's actual goal and the evidence required to prove completion from the task below.",
        "Include explicit deliverables, observable behavior, important edge cases, and direct verification.",
        "Do not weaken, broaden, or add unrelated scope.",
        "Return only a concise numbered list. These criteria become immutable after this response.",
        `After the list, add one final line: CONTINUATION_BUDGET: <N>, where N is an integer from ${MIN_CONTINUATIONS} to ${MAX_CONTINUATIONS}.`,
        "Pick N by expected effort: 3-5 for small, well-scoped changes; 8 for typical tasks; 10-15 for large, multi-part, complex, or open-ended investigation work.",
        "",
        "Task:",
        task,
      ].join("\n"),
    });
    const reply = result.replyText.trim();
    if (!reply) throw new Error("The adverse criteria agent returned empty criteria. Retry /ralph.");
    const inferred = splitBudget(reply);
    if (!inferred.criteria) throw new Error("The adverse criteria agent returned empty criteria. Retry /ralph.");
    if (inferred.criteria.length > MAX_CRITERIA_CHARS) {
      throw new Error(`The inferred criteria exceed ${MAX_CRITERIA_CHARS} characters. Shorten the task and retry.`);
    }
    return inferred;
  }

  for (const event of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
    pi.on(event, async (_event: unknown, ctx: ExtensionContext) => restore(ctx));
  }

  pi.registerCommand("ralph", {
    description: "Infer and lock adverse criteria, then run until the judge accepts the evidence",
    handler: async (args: string, ctx: ExtensionContext) => {
      ensureCurrentSession(ctx);
      const argument = String(args ?? "");
      const command = argument.trim();

      if (command === "status") {
        const hash = state?.criteriaHash ?? "none";
        const attempts = state?.attempts ?? 0;
        const limit = state?.maxContinuations ?? "-";
        ctx.ui.notify(
          `ralph: ${state?.active ? "active" : "inactive"}, criteria sha256=${hash}, attempts=${attempts}/${limit}`,
          "info",
        );
        return;
      }

      if (command === "stop") {
        stateGeneration++;
        if (state?.active) {
          state.active = false;
          persist("update");
        }
        ctx.ui.notify("ralph: inactive", "info");
        return;
      }

      if (!command) {
        ctx.ui.notify("Usage: /ralph <task> | /ralph status | /ralph stop", "error");
        return;
      }

      if (argument.length > MAX_CRITERIA_CHARS) {
        ctx.ui.notify(`Ralph task exceeds ${MAX_CRITERIA_CHARS} characters. Shorten the task and retry.`, "error");
        return;
      }

      if (state?.active) {
        ctx.ui.notify("Ralph is active. Run /ralph stop before you start new criteria.", "error");
        return;
      }

      const inferenceGeneration = ++stateGeneration;
      const inferenceSessionId = ctx.sessionManager.getSessionId();
      let inferred: { criteria: string; maxContinuations: number };
      try {
        ctx.ui.notify("ralph: inferring adversarial acceptance criteria", "info");
        inferred = await inferCriteria(argument, ctx);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }
      if (
        inferenceGeneration !== stateGeneration ||
        inferenceSessionId !== ctx.sessionManager.getSessionId() ||
        state?.active
      ) {
        ctx.ui.notify("Ralph criteria inference was cancelled because the session state changed.", "error");
        return;
      }

      state = {
        runId: randomUUID(),
        active: true,
        task: argument,
        criteria: inferred.criteria,
        criteriaHash: criteriaHash(inferred.criteria),
        attempts: 0,
        maxContinuations: inferred.maxContinuations,
      };
      persist("start");
      pi.sendUserMessage(
        [
          "Ralph task. An adversarial criteria agent inferred and locked the acceptance criteria for this run.",
          "",
          "Original task:",
          argument,
          "",
          "Locked acceptance criteria:",
          inferred.criteria,
          "",
          "Do the real work. Verify every criterion with direct evidence. Stop only when the evidence is ready for the adverse judge.",
        ].join("\n"),
        { attribution: "agent" },
      );
      ctx.ui.notify(
        `ralph: active, criteria sha256=${state.criteriaHash}, continuation limit=${state.maxContinuations}`,
        "info",
      );
    },
  });

  pi.on("session_stop", async (_event: unknown, ctx: ExtensionContext) => {
    ensureCurrentSession(ctx);
    if (!state?.active) return;

    if (state.attempts >= state.maxContinuations) {
      stateGeneration++;
      state.active = false;
      persist("update");
      return {
        decision: "block" as const,
        reason: `Ralph reached this run's ${state.maxContinuations}-continuation limit. Review the remaining work, then start a new /ralph run or stop again to finish without Ralph.`,
      };
    }

    const judgedSessionId = ctx.sessionManager.getSessionId();
    const locked = state;
    const generation = stateGeneration;
    const [gitStatus, gitDiffStat] = await Promise.all([
      git(ctx, ["status", "--short"]),
      git(ctx, ["diff", "--stat"]),
    ]);
    if (!judgmentIsCurrent(ctx, generation, locked.runId)) return;
    const request = judgeRequest(locked.task, locked.criteria, branchEvidence(ctx), gitStatus, gitDiffStat);
    const result = await pi.exec(JUDGE, ["--tokens-used", "0", "--minimum-tokens", "0", "--json", request], {
      cwd: ctx.cwd,
    });
    if (!judgmentIsCurrent(ctx, generation, locked.runId) || ctx.sessionManager.getSessionId() !== judgedSessionId) return;

    if (result.code !== 0 && result.code !== 1) {
      return { decision: "block" as const, reason: failureReason(result.stderr.trim() || `exit ${result.code}`) };
    }

    let judged: JudgeResult;
    try {
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== "object") throw new Error("the output is not an object");
      if (!("verdict" in parsed)) throw new Error("the output has no verdict");
      const verdict = parsed.verdict;
      if (verdict !== "positive" && verdict !== "negative") throw new Error("the output has no valid verdict");
      judged = parsed as JudgeResult;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { decision: "block" as const, reason: failureReason(detail) };
    }

    const expectedCode = judged.verdict === "positive" ? 0 : 1;
    if (result.code !== expectedCode) {
      return {
        decision: "block" as const,
        reason: failureReason(`exit ${result.code} contradicts verdict ${judged.verdict}`),
      };
    }

    if (result.code === 0 && judged.verdict === "positive") {
      stateGeneration++;
      locked.active = false;
      persist("update");
      ctx.ui.notify(`ralph: complete after ${locked.attempts} continuation(s)`, "info");
      return;
    }

    stateGeneration++;
    locked.attempts += 1;
    persist("update");
    const metadata = JSON.stringify(judged);
    return {
      continue: true as const,
      additionalContext: [
        `Ralph continuation ${locked.attempts}/${locked.maxContinuations}.`,
        "Locked criteria:",
        locked.criteria,
        "",
        `Adverse judge result: ${metadata}`,
        "",
        "Inspect the current state. Continue the real work. Verify the result with direct evidence. Then stop for another judgment.",
      ].join("\n"),
    };
  });
}
