import { TeamTrends } from "@/features/meetings";
import { AppShell } from "@/features/auth/ui/AppShell";

// Longitudinal team-health dashboard: how the team's dynamics evolve across
// meetings over time, with actionable signals.
// Route: /meetings/trends
export function MeetingTrendsPage() {
  return (
    <div className="md:pl-14">
      <AppShell />
      <TeamTrends />
    </div>
  );
}
