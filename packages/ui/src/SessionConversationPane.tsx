import { SharedOutgoingReplies } from "./SharedOutgoingReplies.tsx";
import { useId, useState } from "react";
import { ConversationComposer, type ConversationRecovery, type ConversationReplyDrafts } from "./ConversationComposer.tsx";
import { conversationTurnWorking, HistoryConversationView } from "./HistoryConversation.tsx";
import { OutgoingReplies } from "./OutgoingReplies.tsx";
import { sessionLabel } from "./format.ts";
import { useLiveConversation } from "./useLiveConversation.ts";
import type { Session } from "./types.ts";

const ignoreBusyChange = () => {};

/** Provider history and the same reply controls as the full conversation panel. */
export function SessionConversationPane({ session, machineReachable, replyDrafts, recovery, active = true }: {
  readonly session: Session;
  /** The Dashboard's resume of this session, for a stopped one (#921). */
  readonly recovery?: ConversationRecovery;
  readonly machineReachable: boolean;
  readonly active?: boolean;
  readonly replyDrafts?: ConversationReplyDrafts;
}) {
  const composerId = useId();
  const [voiceOpen, setVoiceOpen] = useState(false);
  const { conversation, providerSessionId, error, resolving } = useLiveConversation(session, {
    machineReachable, paused: !active || voiceOpen,
  });
  const outgoing = <><OutgoingReplies session={session} messages={conversation.messages} /><SharedOutgoingReplies session={session} /></>;
  return (
    <section className="slot-conversation-pane history-viewer" aria-label={`Conversation for ${sessionLabel(session)}`}
      onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
      <div className="slot-conversation-history history-viewer">
        {!providerSessionId ? (<>
          <p className="history-empty">This session has not reported a provider session ID yet. Its conversation appears here once the agent does.</p>
          {outgoing}
        </>) : error ? (<>
          <p className="history-error" role="alert">{error}</p>
          {outgoing}
        </>) : conversation.session ? (
          <>
            {!conversation.loading && conversation.messages.length === 0 ? <p className="history-empty">No conversation messages yet.</p> : null}
            <HistoryConversationView conversation={conversation} working={conversationTurnWorking(session.turn_state)} outgoing={outgoing} onJumpToLatest={() => {
              if (conversation.session) void conversation.open(conversation.session, conversation.latestMessagePaging);
            }} />
          </>
        ) : (<>
          <p className="history-empty">{resolving ? "Finding this session in history…" : "Loading conversation…"}</p>
          {outgoing}
        </>)}
      </div>
      <ConversationComposer session={session} machineReachable={machineReachable} replyDrafts={replyDrafts} messages={conversation.messages}
        messagesReady={conversation.messagesLoaded && !resolving && !conversation.loading && !conversation.browsingOlder && conversation.messagePage === 0} recovery={recovery} composerId={composerId}
        onBusyChange={ignoreBusyChange} onVoiceOpenChange={setVoiceOpen} />
    </section>
  );
}
