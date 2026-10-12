import * as Effect from "effect/Effect";
import { Mount } from "foldkit";
import { Message } from "./message.js";

/** Within this distance of the bottom, the transcript counts as followed. */
const FOLLOW_SLACK_PX = 80;

/**
 * The transcript scrolls inside its own box. A reader at the bottom keeps following new entries;
 * a reader who scrolled up to read is left where they are.
 */
export const FollowTranscript = Mount.define("FollowTranscript", {
  messages: [Message.CompletedFollowTranscript],
  execute: ({ element }) =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          let isFollowing = true;

          const onScroll = () => {
            isFollowing =
              element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK_PX;
          };

          const observer = new MutationObserver(() => {
            if (isFollowing) {
              element.scrollTop = element.scrollHeight;
            }
          });

          element.addEventListener("scroll", onScroll);
          observer.observe(element, { childList: true, subtree: true, characterData: true });

          return { observer, onScroll };
        }),
        ({ observer, onScroll }) =>
          Effect.sync(() => {
            observer.disconnect();
            element.removeEventListener("scroll", onScroll);
          }),
      );

      return Message.CompletedFollowTranscript();
    }),
});
