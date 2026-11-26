/** A failure explained to the user: the CLI prints the message and exits with code 1. */
export class AtlasError extends Error {}

/** GitHub answered with an error status; the status tells an owner scan what to do with the repository. */
export class GitHubError extends AtlasError {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** GitHub's rate limit: an owner scan stops at once rather than warn for every repository left. */
export class RateLimitError extends AtlasError {}
