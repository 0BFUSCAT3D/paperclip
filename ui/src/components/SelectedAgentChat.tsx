import {
  AssistantChat,
  AssistantChatView,
  type AssistantChatProps,
  type AssistantChatViewProps,
} from "./AssistantChat";

export {
  ASSISTANT_CHAT_ACTIVE_POLL_MS,
  ASSISTANT_CHAT_IDLE_POLL_MS,
  mergeAssistantChatComments,
  resolveAssistantChatPollInterval,
  resolveDefaultChatTarget,
  type AssistantChatStarterPrompt,
  type PendingAssistantChatComment,
} from "./AssistantChat";

export type SelectedAgentChatProps = Omit<AssistantChatProps, "targetAgentId"> & {
  defaultTargetAgentId?: string | null;
  /** @deprecated AssistantChat always uses the assistant preset. */
  conferenceRoomMode?: boolean;
};

export type SelectedAgentChatViewProps = AssistantChatViewProps & {
  /** @deprecated AssistantChatView always uses the assistant preset. */
  conferenceRoomMode?: boolean;
};

export function SelectedAgentChat({
  defaultTargetAgentId,
  conferenceRoomMode: _conferenceRoomMode,
  ...props
}: SelectedAgentChatProps) {
  return <AssistantChat {...props} targetAgentId={defaultTargetAgentId} />;
}

export function SelectedAgentChatView({
  conferenceRoomMode: _conferenceRoomMode,
  ...props
}: SelectedAgentChatViewProps) {
  return <AssistantChatView {...props} />;
}
