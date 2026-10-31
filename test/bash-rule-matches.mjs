// Claude Code Bash rules: `Bash(p:*)` matches p or a command starting with "p ",
// `Bash(p)` only p; a deny match refuses, else an allow match allows. Shared by
// the test files; test-only, never imported by the tool.
export function bashRuleMatches(rule, command) {
  const body = /^Bash\((.+)\)$/.exec(rule)?.[1];
  if (body === undefined) return false;
  const prefix = body.endsWith(":*") ? body.slice(0, -2) : null;
  return prefix === null ? command === body : command === prefix || command.startsWith(`${prefix} `);
}

export const commandAllowed = (permissions, command) =>
  !permissions.permissions.deny.some((rule) => bashRuleMatches(rule, command)) &&
  permissions.permissions.allow.some((rule) => bashRuleMatches(rule, command));
