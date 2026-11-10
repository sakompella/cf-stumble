type Block = Readonly<{ text?: string }>;

type Message = Readonly<{ role: string; content: string | Block[] }>;

type Item = Readonly<{ id: number; conversationId: number; model: Message[] }>;

type Entries = Readonly<{ items: Item[] }>;

type Docs = Readonly<{ "pi.live"?: object; "pi.inbox"?: object }>;

type Payload = Readonly<{ conversation: Readonly<{ id: number }>; docs: Docs }>;

type RawFrame = [[string, Payload]];

export type Server = Readonly<{
  conversation: number;
  users: readonly string[];
  assistants: number;
  isFull: boolean;
  isIdle: boolean;
}>;

const PAGE_SIZE = 100;

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isBlock(value: unknown): value is Block {
  return isObject(value) && (!("text" in value) || typeof value.text === "string");
}

function isMessage(value: unknown): value is Message {
  return (
    isObject(value) &&
    "role" in value &&
    typeof value.role === "string" &&
    "content" in value &&
    (typeof value.content === "string" ||
      (Array.isArray(value.content) && value.content.every(isBlock)))
  );
}

function isItem(value: unknown): value is Item {
  return (
    isObject(value) &&
    "id" in value &&
    typeof value.id === "number" &&
    "conversationId" in value &&
    typeof value.conversationId === "number" &&
    "model" in value &&
    Array.isArray(value.model) &&
    value.model.every(isMessage)
  );
}

function isEntries(value: unknown): value is Entries {
  return (
    isObject(value) && "items" in value && Array.isArray(value.items) && value.items.every(isItem)
  );
}

function isDocs(value: unknown): value is Docs {
  return (
    isObject(value) &&
    (!("pi.live" in value) || value["pi.live"] === undefined || isObject(value["pi.live"])) &&
    (!("pi.inbox" in value) || value["pi.inbox"] === undefined || isObject(value["pi.inbox"]))
  );
}

function isPayload(value: unknown): value is Payload {
  return (
    isObject(value) &&
    "conversation" in value &&
    isObject(value.conversation) &&
    "id" in value.conversation &&
    typeof value.conversation.id === "number" &&
    "docs" in value &&
    isDocs(value.docs)
  );
}

function isRawFrame(value: unknown): value is RawFrame {
  return Array.isArray(value) && Array.isArray(value[0]) && isPayload(value[0][1]);
}

function liveRun(docs: Docs): boolean {
  const live = docs["pi.live"];

  return live !== undefined && "run" in live && live.run !== undefined;
}

function queued(docs: Docs): boolean {
  const inbox = docs["pi.inbox"];

  return (
    inbox !== undefined && "items" in inbox && Array.isArray(inbox.items) && inbox.items.length > 0
  );
}

function textOfMessage(message: Message): string {
  return Array.isArray(message.content)
    ? message.content.map((block) => block.text ?? "").join("")
    : message.content;
}

async function firstLine(response: Response): Promise<string> {
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();

  if (reader === undefined) return "";

  let text = "";

  for (;;) {
    const { done, value } = await reader.read();

    if (done) break;

    text += value;

    if (text.includes("\n")) break;
  }

  await reader.cancel();

  return text.split("\n")[0] ?? "";
}

async function readFrame(window: Window, projectId: string): Promise<Payload> {
  const response = await window.fetch(`/api/projects/${encodeURIComponent(projectId)}/events`);
  const frame: unknown = JSON.parse(await firstLine(response));

  if (!isRawFrame(frame)) throw new Error("the events stream sent an unexpected first frame");

  return frame[0][1];
}

export async function conversationOf(window: Window, projectId: string): Promise<number> {
  return (await readFrame(window, projectId)).conversation.id;
}

export async function serverState(window: Window, projectId: string): Promise<Server> {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const body: unknown = await (await window.fetch(`${base}/entries?limit=${PAGE_SIZE}`)).json();

  if (!isEntries(body)) throw new Error("the entries list has an unexpected shape");

  const { docs, conversation } = await readFrame(window, projectId);

  const messages = body.items
    .filter((item) => item.conversationId === conversation.id)
    .toReversed()
    .flatMap((item) => item.model);

  const answered = messages.filter(
    (message) => message.role === "assistant" && textOfMessage(message).trim() !== "",
  );

  return {
    conversation: conversation.id,
    users: messages
      .filter((message) => message.role === "user")
      .map((message) => textOfMessage(message)),
    assistants: answered.length,
    isFull: body.items.length < PAGE_SIZE,
    isIdle: !liveRun(docs) && !queued(docs),
  };
}
