// A released image must offer source for the same exact revision it builds.
// Development pages retain their explicit unknown-revision fallback.
const revision = process.env.GIT_COMMIT_SHA;
if (
  !/^[a-f0-9]{40}$/.test(revision ?? "") ||
  process.env.NEXT_PUBLIC_RELEASE_SHA !== revision
) {
  console.error("Exact matching release SHA required");
  process.exitCode = 1;
}
