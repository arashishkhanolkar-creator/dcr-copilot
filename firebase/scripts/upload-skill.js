// One-time setup: uploads the DCR Copilot Agent Skill (SKILL.md + the
// UDCPR/DCPR-2034 regulation reference files) to Anthropic's Skills API,
// so the sendDcrChatMessage Cloud Function can use it via a skill_id.
//
// Run this yourself, from your own machine, with your own Anthropic API
// key — it never passes through chat or gets committed anywhere.
//
// 1. Extract the skill zip (PowerShell, from the repo root):
//      Expand-Archive downloads\dcr-copilot.zip downloads\_skill-extracted -Force
//
// 2. Set your API key and run this script (PowerShell):
//      $env:ANTHROPIC_API_KEY = "sk-ant-..."
//      node firebase\scripts\upload-skill.js downloads\_skill-extracted\dcr-copilot
//
// It prints a skill_id like "skill_01Abc...". Paste that back so
// DCR_SKILL_ID in firebase/functions/index.js can be filled in, then
// redeploy functions.
//
// Re-running this script creates a NEW skill (a new skill_id) rather
// than updating the existing one in place — the Skills API doesn't
// expose an "update files" endpoint. Treat a re-run as "create a new
// skill" and update DCR_SKILL_ID to match the new id.

const fs = require("fs");
const path = require("path");

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY in your environment first (see the comment at the top of this file).");
    process.exit(1);
  }

  const skillDir = process.argv[2];
  if (!skillDir) {
    console.error("Usage: node upload-skill.js <path to extracted dcr-copilot skill folder>");
    process.exit(1);
  }
  const resolvedDir = path.resolve(skillDir);
  if (!fs.existsSync(path.join(resolvedDir, "SKILL.md"))) {
    console.error(`Expected ${path.join(resolvedDir, "SKILL.md")} — check the path points at the folder containing SKILL.md.`);
    process.exit(1);
  }
  const topLevelDir = path.basename(resolvedDir);

  const filePaths = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else filePaths.push(full);
    }
  })(resolvedDir);

  console.log(`Uploading ${filePaths.length} files from ${resolvedDir}...`);
  const form = new FormData();
  for (const filePath of filePaths) {
    const relPath = topLevelDir + "/" + path.relative(resolvedDir, filePath).split(path.sep).join("/");
    const bytes = fs.readFileSync(filePath);
    form.append("files[]", new Blob([bytes]), relPath);
  }

  const res = await fetch("https://api.anthropic.com/v1/skills", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: form,
  });

  const body = await res.json();
  if (!res.ok) {
    console.error(`Upload failed (${res.status}):`, JSON.stringify(body, null, 2));
    process.exit(1);
  }

  console.log("\nSkill uploaded successfully:");
  console.log(JSON.stringify(body, null, 2));
  console.log(`\nskill_id: ${body.id}`);
  console.log("Paste this skill_id back so DCR_SKILL_ID in firebase/functions/index.js can be set, then redeploy functions.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
