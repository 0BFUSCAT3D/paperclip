import { useQuery } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { IssuePlanDecompositionsSection } from "@/components/IssuePlanDecompositionsSection";

interface IssuePropertiesPlansTabProps {
  issue: Issue;
}

/**
 * Plans tab of the redesigned properties pane (flag: enableTaskChatRedesign).
 *
 * Migrates the accepted-plan decomposition history (formerly pinned above the
 * tabs via IssuePlanDecompositionsSection) into a dedicated tab. Structured live
 * PlanEntry/todo streaming is a flagged protocol dependency (demonstrated in the
 * /dev/task-chat-lab harness); until it lands, the tab shows accepted-plan
 * revisions or an empty state.
 */
export function IssuePropertiesPlansTab({ issue }: IssuePropertiesPlansTabProps) {
  const { data } = useQuery({
    queryKey: queryKeys.issues.acceptedPlanDecompositions(issue.id),
    queryFn: () => issuesApi.listAcceptedPlanDecompositions(issue.id),
  });
  const hasPlans = (data?.length ?? 0) > 0;

  if (!hasPlans) {
    return (
      <div className="px-1 py-6 text-sm text-muted-foreground">
        No plan yet. Accepted plans and their revisions will appear here.
      </div>
    );
  }

  return (
    <div className="py-2">
      <IssuePlanDecompositionsSection issueId={issue.id} issueIdentifier={issue.identifier} />
    </div>
  );
}
