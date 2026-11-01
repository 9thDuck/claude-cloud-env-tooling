/**
 * Read-only command classifier for diff-review reviewers (bead 67njw).
 *
 * The reviewer's permission rules are prefix rules, so a read-only call in a
 * shape the list did not foresee (`jq -e . < f`, `git show X | sed -n 195p`,
 * `git branch -a`) was refused, and one refusal made a whole review an ERROR.
 * This accepts read-only commands as a class instead: a pipeline of commands
 * from a fixed read-only set, with flags that write or run programs refused,
 * and output redirects only into the run directory. Anything it does not
 * accept is left to the normal rules, which refuse it as before; it never
 * refuses on its own, and it never allows a command on the deny list.
 *
 * It sees only the command text, like the rules. It is not the boundary:
 * review() still checks the repository is unchanged after the workers ran.
 */
import { isAbsolute, resolve } from "node:path";

/** Commands that only read, whatever their arguments, except as checked below. */
const READ_ONLY = new Set([
  "cat", "head", "tail", "wc", "ls", "grep", "egrep", "fgrep", "rg", "jq", "cut",
  "uniq", "tr", "diff", "cmp", "comm", "stat", "sha256sum", "sha1sum", "md5sum",
  "pwd", "basename", "dirname", "realpath", "readlink", "nl", "tac", "rev", "column",
  "fold", "od", "expand", "echo", "printf", "true", "find", "sed", "git",
]);

/** git subcommands that only read. `branch` is checked further. */
const GIT_READ = new Set([
  "status", "diff", "log", "show", "blame", "grep", "rev-parse", "ls-files", "rev-list",
  "ls-tree", "cat-file", "check-ignore", "merge-base", "branch", "describe", "name-rev",
  "for-each-ref", "show-ref", "shortlog", "whatchanged", "range-diff",
]);

/** `git branch` flags that only list. */
const BRANCH_LIST = new Set([
  "-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "-l", "--show-current",
  "--contains", "--no-contains", "--merged", "--no-merged", "--points-at", "--no-color", "--color",
]);
const BRANCH_VALUE = new Set(["--contains", "--no-contains", "--merged", "--no-merged", "--points-at"]);

/**
 * Split a command into words and operators the way a POSIX shell would for
 * the subset accepted here. Returns null for anything outside that subset:
 * expansions ($, backticks), newlines, unclosed quotes, globs are fine (they
 * only expand to file names to read).
 * @param {string} command
 * @returns {Array<{ op?: string, word?: string }> | null}
 */
function tokenize(command) {
  const out = [];
  let word = null;
  const push = () => {
    if (word !== null) out.push({ word });
    word = null;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (c === "'") {
      const end = command.indexOf("'", i + 1);
      if (end < 0) return null;
      word = (word ?? "") + command.slice(i + 1, end);
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let text = "";
      for (; j < command.length && command[j] !== '"'; j += 1) {
        if (command[j] === "$" || command[j] === "`") return null;
        if (command[j] === "\\" && j + 1 < command.length) j += 1;
        text += command[j];
      }
      if (j >= command.length) return null;
      word = (word ?? "") + text;
      i = j;
    } else if (c === "\\") {
      if (i + 1 >= command.length || command[i + 1] === "\n") return null;
      word = (word ?? "") + command[i + 1];
      i += 1;
    } else if (c === "$" || c === "`" || c === "\n" || c === "\r") {
      return null;
    } else if (c === " " || c === "\t") {
      push();
    } else if ("|&;<>()".includes(c)) {
      // An fd number right before a redirect (2>) belongs to the operator.
      let op = c;
      if ((c === ">" || c === "<") && word !== null && /^\d$/.test(word)) {
        op = word + c;
        word = null;
      }
      push();
      while (i + 1 < command.length && "|&;<>".includes(command[i + 1])) {
        op += command[i + 1];
        i += 1;
      }
      out.push({ op });
    } else {
      word = (word ?? "") + c;
    }
  }
  push();
  return out;
}

/**
 * @param {string} path
 * @param {string} cwd
 * @param {string[]} roots
 */
function under(path, cwd, roots) {
  const full = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return roots.some((root) => full === resolve(root) || full.startsWith(`${resolve(root)}/`));
}

/**
 * Why one simple command (no operators) is not read-only, or "" when it is.
 * @param {string[]} w words
 * @param {{ readRoots: string[], cwd: string }} o
 */
function why(w, o) {
  if (w.length === 0) return "empty command";
  const [head] = w;
  if (head.includes("=")) return "environment assignment";
  if (!READ_ONLY.has(head)) return `${head} is not a read-only command`;
  // Paths named in arguments stay inside the repository and the run dir.
  for (const arg of w.slice(1)) {
    const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
    if ((value.startsWith("/") || value.startsWith("~") || value.split("/").includes("..")) && !under(value.replace(/^~/, "/root"), o.cwd, o.readRoots))
      return `${arg} is outside the repository and the run directory`;
  }
  const args = w.slice(1);
  const flag = (re) => args.some((a) => re.test(a));
  switch (head) {
    case "sed": {
      if (!args.includes("-n")) return "sed only as sed -n";
      const scripts = args.filter((a) => !a.startsWith("-"));
      // The first operand is the script: only line-range prints.
      if (flag(/^-(i|.*[iszw])|^--in-place|^--expression|^-e$|^-f$|^--file/) || scripts.length === 0
        || !/^(\d+|\$)(,(\d+|\$))?p$/.test(scripts[0]))
        return "sed only as sed -n <range>p";
      return "";
    }
    case "find":
      return flag(/^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/) ? "find that runs or writes" : "";
    case "rg":
      return flag(/^--pre/) ? "rg --pre runs a program" : "";
    case "git":
      return gitWhy(args, o);
    default:
      return "";
  }
}

/** @param {string[]} args after "git" */
function gitWhy(args, o) {
  let j = 0;
  while (j < args.length && args[j].startsWith("-")) {
    if (args[j] === "--no-pager") j += 1;
    else if (args[j] === "-C") {
      if (j + 1 >= args.length || !under(args[j + 1], o.cwd, o.readRoots)) return "git -C outside the repository";
      j += 2;
    } else return `git ${args[j]} is not allowed`;
  }
  const sub = args[j];
  const rest = args.slice(j + 1);
  if (!GIT_READ.has(sub)) return `git ${sub} is not read-only`;
  if (rest.some((a) => /^--(output|ext-diff|textconv|open-files-in-pager)|^-O/.test(a))) return `git ${sub} flag that writes or runs a program`;
  if (sub === "branch") {
    for (let k = 0; k < rest.length; k += 1) {
      if (BRANCH_VALUE.has(rest[k])) k += 1;
      else if (!BRANCH_LIST.has(rest[k])) return "git branch only to list";
    }
  }
  return "";
}

/**
 * Whether `command` is read-only: a pipeline of read-only commands, input
 * redirects from readable paths, and output redirects only into `writeRoot`.
 * @param {string} command
 * @param {{ readRoots: string[], writeRoot: string, cwd: string }} options
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
export function isReadOnlyCommand(command, { readRoots, writeRoot, cwd }) {
  const tokens = tokenize(command);
  if (tokens === null) return { ok: false, why: "expansion, newline or unclosed quote" };
  const o = { readRoots, cwd };
  let words = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.word !== undefined) {
      words.push(t.word);
      continue;
    }
    const { op } = t;
    if (op === "|") {
      const w = why(words, o);
      if (w) return { ok: false, why: w };
      words = [];
    } else if (op === "2>&" && tokens[k + 1]?.word === "1") {
      k += 1;
      // stderr into the pipe or stdout: no file is written.
    } else if (/^[012]?(<|>|>>)$/.test(op)) {
      const target = tokens[k + 1]?.word;
      if (target === undefined) return { ok: false, why: `${op} without a file` };
      k += 1;
      const roots = op.endsWith("<") ? readRoots : [writeRoot];
      if (!under(target, cwd, roots)) return { ok: false, why: `${op} ${target} is outside the allowed directory` };
    } else {
      return { ok: false, why: `${op} is not allowed (one pipeline per call)` };
    }
  }
  const w = why(words, o);
  return w ? { ok: false, why: w } : { ok: true };
}
