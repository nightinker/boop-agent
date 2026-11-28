/**
 * How the dispatcher's replies to the owner read on iMessage: like a mobile
 * text, not a report. The rules live in the dispatcher system prompt, and a
 * short reminder rides on every spawn_agent result, because relaying a long
 * sub-agent answer is where replies most often balloon into recaps.
 */

export const REPLY_STYLE_PROMPT = `
Reply style (every reply to the owner):
Write it like a text on a phone. The owner remembers the conversation.
- Lead with the answer, in 1-3 short sentences.
- Don't recap, don't restate their question, don't summarize what you or a
  sub-agent did ("I searched X, then checked Y..."). Just the result.
- No headers. No long lists unless they asked for a list.
- A file or link: just give it, with a few words at most.
- Need their input? Ask ONE short question, nothing else around it.
- Go longer only when the owner says "explain", "more detail" (or clearly
  asks for depth, e.g. "walk me through it"). Then give the full answer.
- Sources/URLs a sub-agent returned still pass through VERBATIM (see below).
  Shortening the body never means dropping or rewriting a URL.
`;

/** Appended to each spawn_agent result the dispatcher sees. */
export function relayReminder(wantsDetail: boolean): string {
  return wantsDetail
    ? "\n\n[Relay: the owner asked for detail, so a fuller answer is fine. No recap of what the agent did. Keep any Sources/URLs verbatim.]"
    : "\n\n[Relay as a mobile text: the answer in 1-3 short sentences, no recap of the task or of what the agent did, no headers. Keep any Sources/URLs verbatim. If the agent needs the owner's input, ask one short question.]";
}

const DETAIL_REQUEST =
  /\b(explain|explanation|more detail|more details|in detail|detailed|elaborate|go deeper|walk me through|full breakdown|long version|tell me more)\b/i;

/** True when the owner's message asks for a longer answer than a quick text. */
export function wantsDetailedReply(content: string): boolean {
  return DETAIL_REQUEST.test(content);
}
