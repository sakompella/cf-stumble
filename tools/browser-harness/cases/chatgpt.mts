import { OWNER_PAGE_IDS as ID } from "../../../src/page/element-ids.js";
import {
  assertIncludes,
  assertRequestBody,
  assertSame,
  byId,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_CALLBACK_URL,
  CHATGPT_CALLBACK_WITHOUT_CODE,
  readChatGPT,
  readProjectList,
  selectRequests,
  waitForText,
  type HarnessCase,
} from "../harness.mjs";

const COMPLETE_PATH = "/api/chatgpt/login/complete";

export const CASES: readonly HarnessCase[] = [
  {
    id: "CHATGPT-1",
    title: "connecting ChatGPT: sign-in link, a refused address, then finish",
    rank: "must",
    scenario: "ready",
    allowedRequestFailures: [`POST ${COMPLETE_PATH}`],
    run: async ({ page, server }) => {
      const before = await readChatGPT(page);
      assertSame(before.connection, "not connected (Workers AI fallback)", "the starting state");
      assertSame(before.hasConnectButton, true, "the connect button while disconnected");
      assertSame(before.hasFinishButton, false, "the finish button before a sign-in");
      assertSame(before.signInHref, "", "the sign-in link before a sign-in");

      await page.click(byId(ID.chatgptConnectButton));
      await page.waitFor(`document.getElementById("${ID.chatgptSignInLink}") !== null`, 10_000);
      const signingIn = await readChatGPT(page);
      assertIncludes(signingIn.signInHref, CHATGPT_AUTHORIZE_URL, "the sign-in link");
      assertSame(signingIn.signInTarget, "_blank", "the sign-in link target");
      assertIncludes(signingIn.signInRel, "noopener", "the sign-in link rel");
      assertIncludes(signingIn.signInRel, "noreferrer", "the sign-in link rel");
      assertIncludes(signingIn.instruction, "paste the address", "the instruction");

      await page.type(byId(ID.chatgptCallbackInput), `  ${CHATGPT_CALLBACK_WITHOUT_CODE}  `);
      await page.click(byId(ID.chatgptFinishButton));
      await waitForText(page, ID.chatgptResult, "rejected: missing-code");
      const refused = await readChatGPT(page);
      assertSame(refused.hasFinishButton, true, "the finish button after a refusal");
      assertSame(refused.addressValue.trim(), CHATGPT_CALLBACK_WITHOUT_CODE, "the kept address");

      await page.type(byId(ID.chatgptCallbackInput), CHATGPT_CALLBACK_URL);
      await page.click(byId(ID.chatgptFinishButton));
      await waitForText(page, ID.chatgptConnection, "connected (gpt-6.1-sol)");
      const connected = await readChatGPT(page);
      const finishes = selectRequests(server.requests(), "POST", COMPLETE_PATH);
      assertSame(connected.hasDisconnectButton, true, "the disconnect button once connected");
      assertSame(connected.hasConnectButton, false, "the connect button once connected");
      assertSame(connected.signInHref, "", "the sign-in link once connected");
      assertSame(connected.result, "", "the result once connected");
      assertSame(finishes.length, 2, "finish requests");
      assertRequestBody(
        finishes[0],
        { attemptId: "attempt-1", callbackUrl: CHATGPT_CALLBACK_WITHOUT_CODE },
        "the refused finish",
      );
      assertRequestBody(
        finishes[1],
        { attemptId: "attempt-1", callbackUrl: CHATGPT_CALLBACK_URL },
        "the accepted finish",
      );
      assertSame(server.chatgpt().connection.state, "connected", "the stub's own connection");
      assertSame((await readProjectList(page)).credentialInputs.length, 0, "credential inputs");

      return "Connect ChatGPT showed a new-tab sign-in link and its instruction; a trimmed address without a code was refused as missing-code and kept; the accepted address connected gpt-6.1-sol and replaced the sign-in with Disconnect";
    },
  },
  {
    id: "CHATGPT-2",
    title: "disconnecting, and a connection that needs reconnecting",
    rank: "should",
    scenario: "chatgpt-connected",
    run: async ({ page, server, reopen }) => {
      const connected = await readChatGPT(page);
      assertSame(connected.connection, "connected (gpt-6.1-sol)", "the connected state");
      assertSame(connected.hasConnectButton, false, "the connect button while connected");

      await page.click(byId(ID.chatgptDisconnectButton));
      await waitForText(page, ID.chatgptConnection, "not connected (Workers AI fallback)");
      const disconnected = await readChatGPT(page);
      const disconnects = selectRequests(server.requests(), "POST", "/api/chatgpt/disconnect");
      assertSame(disconnected.hasConnectButton, true, "the connect button after disconnecting");
      assertSame(disconnected.hasDisconnectButton, false, "the disconnect button after");
      assertSame(disconnects.length, 1, "disconnect requests");
      assertRequestBody(disconnects[0], {}, "the disconnect request");
      assertSame(server.chatgpt().connection.state, "disconnected", "the stub's own connection");

      await reopen("chatgpt-needs-reconnect");
      const stale = await readChatGPT(page);
      assertSame(stale.connection, "reconnect required: refresh-refused", "the reconnect state");
      assertSame(stale.hasConnectButton, true, "the connect button when reconnecting");
      assertSame(stale.hasDisconnectButton, false, "the disconnect button when reconnecting");

      return "Disconnect sent one empty request and showed the fallback wording with Connect ChatGPT again; a refused refresh showed reconnect required: refresh-refused with Connect ChatGPT and no Disconnect";
    },
  },
];
