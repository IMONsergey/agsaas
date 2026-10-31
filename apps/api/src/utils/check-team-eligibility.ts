export interface TeamEligibilityData {
  plan: "trial" | "starter" | "pro";
  createdAt: string;
}

export function isTeamEligibleForSync(_team: TeamEligibilityData): boolean {
  return true;
}
