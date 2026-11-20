import "dotenv/config";
import os from "node:os";
import path from "node:path";
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
// Keep test artifacts out of data/out and data/codex-workspaces: test job ids (1, 2, ...) collide with real ones.
const tmp = path.join(os.tmpdir(), "job-hunter-tests");
process.env.RESUME_OUTPUT_DIRECTORY = path.join(tmp, "out");
process.env.CODEX_WORKSPACE_DIRECTORY = path.join(tmp, "codex-workspaces");
