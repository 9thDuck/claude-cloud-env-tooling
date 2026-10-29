# Default review rules

diff-review uses these rules when the repository has no `.diff-review.json`.
Each rule is a reason to FAIL a diff. Copy this file into your repository and
name it in `.diff-review.json` to change them.

1. No stubs or placeholders. New code must not ship `TODO`, `FIXME`, "not implemented" or empty bodies standing in for real behaviour.
2. No swallowed errors. A `catch` (or equivalent) must handle, rethrow or report the error; it must not ignore it or hide it behind a success value.
3. No silent fallbacks on external data. A default value for data from a network, file, user or other system (`??`, `||`, `or`, `getOrElse`) needs a comment saying why the default is correct.
4. No removed checks or tests without a reason. Deleting or weakening a test, assertion, validation or lint rule needs a stated reason in the diff.
5. No secrets. No API keys, tokens, passwords, private keys or credentials in code, config or fixtures.
6. A behaviour change comes with a test, or says in the diff why it cannot be tested.
7. Clear names and comments. A name or comment must not say something the code does not do.
