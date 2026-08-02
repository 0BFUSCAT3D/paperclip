import { cn } from "@/lib/utils";
import { MarkdownBody } from "@/components/MarkdownBody";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { AgentIcon } from "@/components/AgentIconPicker";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { extractAttachmentRefs, fileKindForName } from "./task-chat-attachments";
import type { TaskChatMessageItem } from "./task-chat-model";

interface TaskChatBubbleProps {
  item: TaskChatMessageItem;
}

function initialsForName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/**
 * Author-typed message row — the primary legibility signal. Human messages sit
 * right in a solid accent bubble; agent messages sit left in a neutral card
 * bubble with an avatar author header (the agent's assigned icon + name · mode
 * chip); system notices are centered and recede.
 */
export function TaskChatBubble({ item }: TaskChatBubbleProps) {
  if (item.interstitial) {
    // Mid-run self-talk: no bubble, no avatar header — muted narration that
    // stays in the thread but never competes with the final reply. While
    // streaming, block-level chunks type themselves in (tc-typewriter-stream);
    // history renders instantly.
    return (
      <div
        className={cn(
          "w-full text-sm text-muted-foreground",
          item.streaming && "tc-typewriter-stream",
        )}
        data-testid="task-chat-interstitial"
      >
        <MarkdownBody softBreaks linkIssueReferences>
          {item.text}
        </MarkdownBody>
      </div>
    );
  }

  if (item.author === "system") {
    return (
      <div className="tc-enter-bubble flex justify-center py-1">
        <p className="max-w-(--pct-85) text-center text-xs text-muted-foreground">{item.text}</p>
      </div>
    );
  }

  const isHuman = item.author === "human";
  // Non-image file references ("[name](/api/attachments/…/content)") render as
  // attachment chips under the bubble; link-only lines leave the body text.
  const { refs: attachmentRefs, text: bodyText } = extractAttachmentRefs(item.text);
  return (
    <div className={cn("tc-enter-bubble group flex w-full flex-col gap-1", isHuman ? "items-end" : "items-start")}>
      {!isHuman && item.authorName ? (
        <span className="flex items-center gap-2 px-1">
          <Avatar size="sm" className="shrink-0" data-testid="task-chat-agent-avatar">
            {item.agentIcon ? (
              <AvatarFallback>
                <AgentIcon icon={item.agentIcon} className="h-3.5 w-3.5" />
              </AvatarFallback>
            ) : (
              <AvatarFallback>{initialsForName(item.authorName)}</AvatarFallback>
            )}
          </Avatar>
          <span className="text-sm font-semibold text-foreground">{item.authorName}</span>
          {item.modeLabel ? (
            <span className="rounded-full border border-border px-2 py-px text-(length:--text-micro) font-medium text-muted-foreground">
              {item.modeLabel}
            </span>
          ) : null}
        </span>
      ) : null}
      {bodyText.length > 0 ? (
        <div
          className={cn(
            "max-w-(--pct-85) break-words px-3.5 py-2 text-sm",
            isHuman
              ? "rounded-2xl rounded-br-sm bg-(--liveness-blue) text-white"
              : "rounded-2xl rounded-bl-sm bg-(--bubble-agent) text-foreground",
            item.optimistic ? "opacity-80" : null,
          )}
        >
          <MarkdownBody softBreaks linkIssueReferences>
            {bodyText}
          </MarkdownBody>
        </div>
      ) : null}
      {attachmentRefs.length > 0 ? (
        <AttachmentGroup
          className="max-w-(--pct-85)"
          data-testid="task-chat-bubble-attachments"
        >
          {attachmentRefs.map((ref) => {
            const kind = fileKindForName(ref.name);
            const KindIcon = kind.icon;
            return (
              <Attachment key={ref.url} size="sm" className={cn(item.optimistic && "opacity-80")}>
                <AttachmentMedia>
                  <KindIcon aria-hidden />
                </AttachmentMedia>
                <AttachmentContent>
                  <AttachmentTitle className="max-w-48">{ref.name}</AttachmentTitle>
                  <AttachmentDescription className="max-w-48">{kind.label}</AttachmentDescription>
                </AttachmentContent>
                <AttachmentTrigger
                  aria-label={`Open ${ref.name}`}
                  render={<a href={ref.url} target="_blank" rel="noreferrer" />}
                />
              </Attachment>
            );
          })}
        </AttachmentGroup>
      ) : null}
      {item.optimistic ? (
        <span className="px-1 text-(length:--text-micro) text-muted-foreground">
          {item.optimistic === "queued" ? "Queued" : "Sending…"}
        </span>
      ) : item.timestamp ? (
        <span className="px-1 text-(length:--text-micro) text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          {item.timestamp}
        </span>
      ) : null}
    </div>
  );
}
