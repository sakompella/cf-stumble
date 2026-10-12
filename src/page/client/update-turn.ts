import * as Match from "effect/Match";
import * as Option from "effect/Option";
import {
  isTerminalFrame,
  terminalText,
  type ProgressFrame,
  type TerminalFrame,
  type TurnFrame,
} from "./frames.js";
import type { Message } from "./message.js";
import { Turn, type Model } from "./model.js";
import {
  textEntry,
  toolStartEntry,
  toolSummaryText,
  TranscriptEntry,
  withAssistantText,
  withToolResult,
} from "./transcript.js";
import { clearError, withError, type Handlers, type UpdateReturn } from "./update-shared.js";
import { quietThreadRead } from "./update-thread.js";

/**
 * Sending a turn and applying its frames. The stream itself is a Subscription (`turn.ts`); this
 * file decides what each frame does to the transcript. A Message for a turn the Model no longer
 * holds — the reader cancelled, or picked another project — is dropped.
 */

function sendTurn(model: Model): UpdateReturn {
  const cleared = clearError(model);
  const prompt = model.prompt.trim();

  if (Option.isNone(model.maybeProjectId)) {
    return { model: { ...cleared, turnState: "select a project first" } };
  }

  if (model.turn._tag === "Streaming") {
    return { model: { ...cleared, turnState: "a turn is already running" } };
  }

  if (prompt === "") {
    return { model: { ...cleared, turnState: "type a prompt first" } };
  }

  const turnId = model.turnCount + 1;

  return {
    model: {
      ...cleared,
      turnCount: turnId,
      turn: Turn.Streaming({
        turnId,
        projectId: model.maybeProjectId.value,
        prompt,
        hasTerminalFrame: false,
      }),
      isFreshArmed: false,
      turnState: "running",
      freshThreadStatus: "",
      transcript: [...model.transcript, textEntry("user", "you", prompt)],
      isAssistantOpen: false,
      prompt: "",
    },
  };
}

function appended(model: Model, entry: TranscriptEntry): Model {
  return { ...model, transcript: [...model.transcript, entry], isAssistantOpen: false };
}

function withTerminalFrame(model: Model, frame: TerminalFrame): Model {
  const wording = terminalText(frame);

  const turn =
    model.turn._tag === "Streaming"
      ? Turn.Streaming({ ...model.turn, hasTerminalFrame: true })
      : model.turn;

  const entry = TranscriptEntry.Terminal({ wording, isProblem: frame.kind !== "saved" });

  return { ...appended(model, entry), turnState: wording, turn };
}

function withProgressFrame(model: Model, frame: ProgressFrame): Model {
  return Match.value(frame).pipe(
    Match.discriminatorsExhaustive("kind")({
      text: ({ text }) =>
        text === ""
          ? model
          : {
              ...model,
              transcript: withAssistantText(model.transcript, model.isAssistantOpen, text),
              isAssistantOpen: true,
            },
      "tool-start": ({ toolCallId, toolName, arguments: toolArguments }) =>
        appended(
          model,
          toolStartEntry(toolCallId, toolSummaryText(toolName, JSON.stringify(toolArguments))),
        ),
      "tool-result": (result) => ({
        ...model,
        isAssistantOpen: false,
        transcript: withToolResult(model.transcript, {
          toolCallId: result.toolCallId,
          toolName: result.toolName,
          content: result.content,
          isError: result.isError,
          isTruncated: result.truncated,
        }),
      }),
      diff: ({ content, truncated }) =>
        appended(model, TranscriptEntry.Diff({ content, isTruncated: truncated })),
      "diff-unavailable": ({ detail }) =>
        appended(model, TranscriptEntry.DiffUnavailable({ detail })),
    }),
  );
}

function withFrame(model: Model, frame: TurnFrame): Model {
  return isTerminalFrame(frame) ? withTerminalFrame(model, frame) : withProgressFrame(model, frame);
}

/** The turn is over for this page: Send comes back and the thread facts are read again. */
function endedTurn(model: Model): UpdateReturn {
  const ended = { ...model, turn: Turn.Idle() };

  return { model: ended, commands: quietThreadRead(ended) };
}

type TurnTags =
  | "ReceivedTurnFrame"
  | "ReceivedUnreadableFrame"
  | "RefusedTurn"
  | "EndedTurnStream"
  | "DisconnectedTurnStream";

function forCurrentTurn(
  model: Model,
  message: Extract<Message, { readonly _tag: TurnTags }>,
  handle: (current: typeof Turn.Streaming.Type) => UpdateReturn,
): UpdateReturn {
  return model.turn._tag === "Streaming" && model.turn.turnId === message.turnId
    ? handle(model.turn)
    : { model };
}

export function turnHandlers(
  model: Model,
): Handlers<
  "UpdatedPrompt" | "ClickedSendTurn" | "PressedSendShortcut" | "ClickedCancelTurn" | TurnTags
> {
  return {
    UpdatedPrompt: ({ value }) => ({ model: { ...model, prompt: value } }),
    ClickedSendTurn: () => sendTurn(model),
    PressedSendShortcut: () => sendTurn(model),
    ClickedCancelTurn: () =>
      model.turn._tag === "Streaming"
        ? endedTurn({ ...model, turnState: "cancelled: this browser stopped the turn" })
        : { model },
    ReceivedTurnFrame: (message) =>
      forCurrentTurn(model, message, () => ({ model: withFrame(model, message.frame) })),
    ReceivedUnreadableFrame: (message) =>
      forCurrentTurn(model, message, () => ({
        model: { ...model, turnState: "unreadable frame from this Worker" },
      })),
    RefusedTurn: (message) =>
      forCurrentTurn(model, message, () => endedTurn({ ...model, turnState: message.wording })),
    EndedTurnStream: (message) =>
      forCurrentTurn(model, message, (current) =>
        endedTurn(
          current.hasTerminalFrame
            ? model
            : { ...model, turnState: "the turn stream ended without a terminal frame" },
        ),
      ),
    DisconnectedTurnStream: (message) =>
      forCurrentTurn(model, message, () =>
        endedTurn({
          ...withError(model, "the turn request", message.detail),
          turnState: "disconnected: the turn stream ended early",
        }),
      ),
  };
}
