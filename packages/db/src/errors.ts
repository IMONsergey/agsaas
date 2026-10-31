export class ReportNotFoundError extends Error {
  code = "REPORT_NOT_FOUND" as const;

  constructor() {
    super("Report not found");
    this.name = "ReportNotFoundError";
  }
}

export class ReportExpiredError extends Error {
  code = "REPORT_EXPIRED" as const;

  constructor() {
    super("Report has expired");
    this.name = "ReportExpiredError";
  }
}

export class InvalidReportTypeError extends Error {
  code = "INVALID_REPORT_TYPE" as const;

  constructor() {
    super("Invalid report type");
    this.name = "InvalidReportTypeError";
  }
}

export class WhatsAppAlreadyConnectedToAnotherTeamError extends Error {
  code = "WHATSAPP_ALREADY_CONNECTED_TO_ANOTHER_TEAM" as const;

  constructor() {
    super("Phone number already connected to another team");
    this.name = "WhatsAppAlreadyConnectedToAnotherTeamError";
  }
}

export class TelegramAlreadyConnectedToAnotherTeamError extends Error {
  code = "TELEGRAM_ALREADY_CONNECTED_TO_ANOTHER_TEAM" as const;

  constructor() {
    super("Telegram account already connected to another team");
    this.name = "TelegramAlreadyConnectedToAnotherTeamError";
  }
}

export class PlatformIdentityAlreadyLinkedToAnotherUserError extends Error {
  code = "PLATFORM_IDENTITY_ALREADY_LINKED_TO_ANOTHER_USER" as const;

  constructor() {
    super("Platform identity is already linked to another user");
    this.name = "PlatformIdentityAlreadyLinkedToAnotherUserError";
  }
}

export class PlatformIdentityAlreadyLinkedToAnotherTeamError extends Error {
  code = "PLATFORM_IDENTITY_ALREADY_LINKED_TO_ANOTHER_TEAM" as const;

  constructor() {
    super("Platform identity is already linked to another team");
    this.name = "PlatformIdentityAlreadyLinkedToAnotherTeamError";
  }
}
export class TeamMembershipError extends Error {
  constructor(
    public readonly code:
      | "TEAM_ACCESS_DENIED"
      | "TEAM_OWNER_REQUIRED"
      | "LAST_TEAM_OWNER"
      | "ACCOUNT_DELETION_PENDING",
  ) {
    super(
      code === "ACCOUNT_DELETION_PENDING"
        ? "Account deletion is pending. Retry deletion before joining or creating a team"
        : code === "LAST_TEAM_OWNER"
          ? "Transfer ownership before leaving or removing the last team owner"
          : code === "TEAM_OWNER_REQUIRED"
            ? "Only team owners can perform this action"
            : "You do not have access to this team",
    );
    this.name = "TeamMembershipError";
  }
}
