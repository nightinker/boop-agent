import { api } from "../convex/_generated/api.js";
import { convex } from "./convex-client.js";
import { broadcast } from "./broadcast.js";
import { sendImessage } from "./sendblue.js";

/**
 * A message Boop sends on its own, after a background job finishes: texted
 * when the conversation is iMessage, and saved to the conversation either way.
 */
export async function notifyConversation(
  conversationId: string,
  text: string,
  event = "notice",
): Promise<void> {
  try {
    if (conversationId.startsWith("sms:")) await sendImessage(conversationId.slice(4), text);
    await convex.mutation(api.messages.send, { conversationId, role: "assistant", content: text });
    broadcast(event, { conversationId, text });
  } catch (err) {
    console.error(`[notify] ${event} failed`, err);
  }
}
