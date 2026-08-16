import { Card, CardContent } from "@/components/ui/card";

/**
 * Empty state (UI.md §5.8): one verb + one sentence + one primary
 * action; nothing bigger than the text.
 */
export function EmptyState({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col items-start gap-3 py-2">
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}
