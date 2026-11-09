// Deploys the static Provenalt website (frontend/) to Vercel production through the REST API.
//   VERCEL_TOKEN=... VERCEL_TEAM_ID=team_... node scripts/deploy-vercel.js
// Uses only project/deployment endpoints, so it also works with tokens that may not read team details (where
// `vercel deploy` fails with "token is not valid"). Creates the project on first use. Files listed in
// frontend/.vercelignore are skipped; frontend/vercel.json (security headers) is applied by Vercel.
// Optional: VERCEL_PROJECT (default "provenalt"), DOMAIN (e.g. provenalt.xyz, added to the project).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API = "https://api.vercel.com";
const TOKEN = process.env.VERCEL_TOKEN;
const TEAM = process.env.VERCEL_TEAM_ID || "";
const PROJECT = process.env.VERCEL_PROJECT || "provenalt";
const DOMAIN = process.env.DOMAIN || "";
const ROOT = path.join(__dirname, "..", "frontend");

if (!TOKEN) throw new Error("Set VERCEL_TOKEN (create one at vercel.com → Account Settings → Tokens)");
const q = (extra = "") => {
  const p = new URLSearchParams(extra);
  if (TEAM) p.set("teamId", TEAM);
  const s = p.toString();
  return s ? `?${s}` : "";
};

async function api(method, url, body, headers = {}) {
  const r = await fetch(API + url, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body && !Buffer.isBuffer(body) ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? (Buffer.isBuffer(body) ? body : JSON.stringify(body)) : undefined,
  });
  const text = await r.text();
  let j;
  try { j = text ? JSON.parse(text) : {}; } catch { j = { raw: text.slice(0, 300) }; }
  return { status: r.status, j };
}

function listFiles() {
  const ignore = new Set(fs.readFileSync(path.join(ROOT, ".vercelignore"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean));
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      if (ignore.has(r) || ignore.has(name) || name === ".vercelignore" || name.startsWith(".")) continue;
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full, r);
      else out.push({ file: r, full });
    }
  };
  walk(ROOT, "");
  return out;
}

async function main() {
  // Project (create once, as a plain static site: no framework, no build).
  let { status, j: project } = await api("GET", `/v9/projects/${PROJECT}${q()}`);
  if (status === 404) {
    ({ status, j: project } = await api("POST", `/v11/projects${q()}`, { name: PROJECT, framework: null }));
    if (status >= 300) throw new Error(`create project: ${status} ${JSON.stringify(project)}`);
    console.log(`created project ${project.name} (${project.id})`);
  } else if (status >= 300) {
    throw new Error(`read project: ${status} ${JSON.stringify(project)}`);
  }

  // Upload files by content hash, then create the deployment from the hashes.
  const files = listFiles();
  for (const f of files) {
    const data = fs.readFileSync(f.full);
    f.sha = crypto.createHash("sha1").update(data).digest("hex");
    f.size = data.length;
    const up = await api("POST", `/v2/files${q()}`, data, {
      "content-type": "application/octet-stream", "x-vercel-digest": f.sha, "content-length": String(data.length),
    });
    if (up.status >= 300) throw new Error(`upload ${f.file}: ${up.status} ${JSON.stringify(up.j)}`);
  }
  console.log(`uploaded ${files.length} files: ${files.map((f) => f.file).join(", ")}`);

  const { status: ds, j: dep } = await api("POST", `/v13/deployments${q({ skipAutoDetectionConfirmation: "1" })}`, {
    name: PROJECT, project: project.id, target: "production",
    files: files.map((f) => ({ file: f.file, sha: f.sha, size: f.size })),
    projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
  });
  if (ds >= 300) throw new Error(`deployment: ${ds} ${JSON.stringify(dep)}`);
  console.log(`deployment ${dep.id} (${dep.url}) ${dep.readyState}`);

  let d = dep;
  for (let i = 0; i < 90 && !["READY", "ERROR", "CANCELED"].includes(d.readyState); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    d = (await api("GET", `/v13/deployments/${dep.id}${q()}`)).j;
  }
  if (d.readyState !== "READY") throw new Error(`deployment ended ${d.readyState}: ${JSON.stringify(d.errorMessage || d.error || "")}`);
  const aliases = d.alias || [];
  console.log(`✓ READY  https://${dep.url}`);
  if (aliases.length) console.log(`  production: ${aliases.map((a) => "https://" + a).join("  ")}`);

  if (DOMAIN) {
    const add = await api("POST", `/v10/projects/${project.id}/domains${q()}`, { name: DOMAIN });
    if (add.status >= 300 && add.j?.error?.code !== "domain_already_in_use_by_project" && !/already/i.test(add.j?.error?.message || "")) {
      console.log(`domain ${DOMAIN}: ${add.status} ${JSON.stringify(add.j)}`);
    }
    const cfg = await api("GET", `/v6/domains/${DOMAIN}/config${q()}`);
    const info = await api("GET", `/v9/projects/${project.id}/domains/${DOMAIN}${q()}`);
    console.log(`domain ${DOMAIN}: verified=${info.j.verified} misconfigured=${cfg.j.misconfigured}`);
    if (info.j.verification) console.log("  verification:", JSON.stringify(info.j.verification));
    if (cfg.j.misconfigured) {
      console.log("  DNS to set at the domain registrar:");
      for (const a of cfg.j.recommendedIPv4 || []) console.log(`    A     @    ${(a.value || []).join(", ")}`);
      if (cfg.j.recommendedCNAME?.length) console.log(`    CNAME www  ${cfg.j.recommendedCNAME[0].value}`);
    }
  }
}

main().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
