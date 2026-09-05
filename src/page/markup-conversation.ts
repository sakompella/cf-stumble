import { OWNER_PAGE_IDS as ID } from "./element-ids.js";
import { value } from "./markup-fields.js";

/**
 * The conversation column, which is the page's main work.
 *
 * The transcript is an ordered list the turn appends to while it runs (ADR-0037): text as the model
 * produces it, one collapsible block per tool call, and the Supervisor's terminal frame last. The
 * composer sits below it, and the thread facts a reader needs to trust what they see — which
 * project, which revision, whether a turn holds the project — sit above it.
 *
 * Starting a fresh thread is two clicks, never one. It replaces the conversation, and a reader who
 * meant to press "send" should not lose it to a slip. Every repository file survives it (ADR-0038).
 */
export const OWNER_PAGE_CONVERSATION = `
    <section id="${ID.conversation}" aria-label="Conversation">
      <div class="conversation-head">
        <h2 id="${ID.conversationProject}">No project selected</h2>
        ${value("thread", ID.conversationState)}
        ${value("revision", ID.threadRevision)}
        ${value("turn active", ID.threadTurnActive)}
        ${value("messages", ID.threadMessageCount)}
      </div>
      <ol id="${ID.messageList}" class="messages"></ol>
      <div class="composer">
        <label class="field-label" for="${ID.promptInput}">prompt</label>
        <textarea id="${ID.promptInput}" rows="3" placeholder="Ask this project's agent to do something. Control-Enter sends."></textarea>
        <div class="row">
          <button id="${ID.sendTurnButton}" type="button">Send turn</button>
          <button id="${ID.cancelTurnButton}" type="button" disabled>Cancel turn</button>
          <button id="${ID.freshThreadButton}" type="button">Start fresh thread</button>
        </div>
        ${value("turn", ID.turnState)}
        ${value("fresh thread", ID.freshThreadStatus)}
        <p class="note">
          A fresh thread replaces this project's conversation and its compacted context. It leaves
          every repository file exactly as it is.
        </p>
      </div>
    </section>`;
