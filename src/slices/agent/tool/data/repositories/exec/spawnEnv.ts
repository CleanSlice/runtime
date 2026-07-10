/**
 * Environment for agent-driven shell commands.
 *
 * The runtime can be launched locally in a terminal, but the agent's shell
 * commands are issued on behalf of remote users who have NO access to that
 * terminal. Interactive prompts (e.g. git's `Username for 'https://github.com':`)
 * read directly from /dev/tty — they bypass piped/ignored stdin — so an
 * unauthenticated `git clone` would hang forever waiting for input nobody can give.
 *
 * Forcing non-interactive mode makes those tools fail fast with an error on
 * stderr (which callers already capture) instead of blocking.
 */
export function nonInteractiveEnv(extra?: Record<string, string>): Record<string, string | undefined> {
  return {
    ...process.env,
    // git: never prompt on the terminal for HTTP credentials.
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    // git over SSH: fail instead of prompting for host keys / passphrases.
    GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
    SSH_ASKPASS: "",
    SSH_ASKPASS_REQUIRE: "never",
    // git-credential-manager: never pop an interactive prompt.
    GCM_INTERACTIVE: "never",
    // apt/dpkg and friends: assume non-interactive.
    DEBIAN_FRONTEND: "noninteractive",
    ...extra,
  }
}
