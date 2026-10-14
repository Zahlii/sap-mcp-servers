// Conventional Commits — enforced locally via husky (commit-msg hook) and in CI.
//
//   <type>(<scope>): <subject>
//   e.g.  fix(auth): refresh expired SSO cookie before retry
//         feat(roadmap): add export_markdown tool
//         chore(deps): bump playwright to 1.59
//
// Scope is optional, but when present it must be one of the names below — this
// keeps history consistent and maps cleanly onto the workspaces that
// release-please versions independently.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'auth', // packages/auth      → @marianfoo/sap-mcp-auth
        'api-hub', // packages/api-hub   → sap-api-hub-mcp
        'roadmap', // packages/roadmap   → sap-roadmap-mcp
        'notes', // packages/notes     → sap-note-search-mcp
        'discovery-center', // packages/discovery-center → sap-discovery-center-mcp
        'deps', // dependency bumps (Dependabot)
        'release', // release tooling / release-please
        'ci', // CI workflows
        'repo', // repo-wide (root config, gitignore, top-level docs)
      ],
    ],
    // Don't fail on long lines in the body (URLs, stack traces, etc.).
    'body-max-line-length': [0, 'always'],
    // Subject capitalization is stylistic and fights Dependabot's "Bump …"
    // messages — disable it. Type + scope are what we actually enforce.
    'subject-case': [0],
  },
};
