import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";

const PROFILE_ID = /^[a-f0-9-]{36}$/i;
const MAX_PROFILES = 100;

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function profilesFile(dshHome) {
  return join(dshHome, "desktop", "model-profiles.json");
}

function cleanText(value, label, max = 160) {
  const text = String(value || "").trim();
  if (!text || text.length > max || /[\0\r\n]/.test(text)) throw httpError(400, `${label} is invalid`);
  return text;
}

function normalizeSelection(input) {
  const selection = {
    provider: cleanText(input?.provider, "provider"),
    model: cleanText(input?.model, "model"),
  };
  const reasoningEffort = String(input?.reasoningEffort || "").trim();
  if (reasoningEffort) selection.reasoningEffort = cleanText(reasoningEffort, "reasoning effort", 80);
  return selection;
}

function normalizeProfile(input, fallbackId) {
  const id = String(input?.id || fallbackId || "").trim();
  if (!PROFILE_ID.test(id)) throw httpError(400, "model profile id is invalid");
  return {
    id,
    name: cleanText(input?.name, "profile name", 60),
    ...normalizeSelection(input),
    updatedAt: typeof input?.updatedAt === "string" ? input.updatedAt : new Date().toISOString(),
  };
}

async function readModelProfiles(dshHome) {
  let data;
  try { data = JSON.parse(await readFile(profilesFile(dshHome), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return [];
    if (error instanceof SyntaxError) throw httpError(500, "model profile file is not valid JSON");
    throw error;
  }
  const output = [];
  for (const item of Array.isArray(data?.profiles) ? data.profiles : []) {
    try { output.push(normalizeProfile(item)); } catch {}
  }
  return output.slice(0, MAX_PROFILES);
}

async function writeProfiles(dshHome, profiles) {
  const file = profilesFile(dshHome);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFileAtomic(file, JSON.stringify({ schemaVersion: 1, profiles }, null, 2) + "\n", { mode: 0o600, dirMode: 0o700 });
}

async function saveModelProfile(dshHome, input) {
  const profiles = await readModelProfiles(dshHome);
  const id = input?.id ? String(input.id) : randomUUID();
  const next = normalizeProfile({ ...input, id, updatedAt: new Date().toISOString() });
  const at = profiles.findIndex((item) => item.id === id);
  if (at >= 0) profiles[at] = next;
  else {
    if (profiles.length >= MAX_PROFILES) throw httpError(413, `at most ${MAX_PROFILES} model profiles are allowed`);
    profiles.push(next);
  }
  await writeProfiles(dshHome, profiles);
  return next;
}

async function deleteModelProfile(dshHome, id) {
  if (!PROFILE_ID.test(String(id || ""))) throw httpError(400, "model profile id is invalid");
  const profiles = await readModelProfiles(dshHome);
  const next = profiles.filter((item) => item.id !== id);
  if (next.length === profiles.length) throw httpError(404, "model profile was not found");
  await writeProfiles(dshHome, next);
}

function runningAgents(ctx) {
  return ctx.agents.list().filter((agent) => agent.status === "running").map((agent) => String(agent.id));
}

async function listModelCatalog(ctx) {
  const groups = [];
  const failures = [];
  for (const provider of ctx.llm.listProviders()) {
    try {
      const models = await ctx.llm.listModels(provider.id);
      groups.push({
        id: provider.id,
        name: provider.name,
        models: await Promise.all(models.map(async (model) => {
          const info = await ctx.llm.resolveModelInfo(provider.id, model.id);
          return {
            id: model.id,
            name: model.name,
            description: model.description || "",
            efforts: info.reasoning?.efforts || [],
            defaultEffort: info.reasoning?.defaultEffort || "",
          };
        })),
      });
    } catch (error) {
      failures.push({ provider: provider.id, error: String(error?.message || error) });
    }
  }
  return { groups, failures };
}

function sameSelection(a, b) {
  return a?.provider === b?.provider && a?.model === b?.model && (!a?.reasoningEffort || a.reasoningEffort === b?.reasoningEffort);
}

let switchChain = Promise.resolve();

function queueModelSwitch(ctx, resolveSelection) {
  const operation = switchChain.then(async () => {
    const running = runningAgents(ctx);
    if (running.length) throw httpError(409, `有 ${running.length} 个任务正在运行，结束或停止任务后才能切换模型`);
    const requested = await resolveSelection();
    const resolved = await ctx.llm.resolveCallConfig(normalizeSelection(requested));
    const rechecked = runningAgents(ctx);
    if (rechecked.length) throw httpError(409, `有 ${rechecked.length} 个任务刚刚开始运行，本次切换已取消`);
    const selected = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    };
    await ctx.agentDefaultModel.saveSelection(selected);
    return { selected };
  });
  switchChain = operation.then(() => undefined, () => undefined);
  return operation;
}

function switchModelProfile(ctx, dshHome, id) {
  let profile;
  return queueModelSwitch(ctx, async () => {
    const profiles = await readModelProfiles(dshHome);
    profile = profiles.find((item) => item.id === id);
    if (!profile) throw httpError(404, "model profile was not found");
    return profile;
  }).then((result) => ({ ...result, profile }));
}

function switchModelProvider(ctx, providerValue) {
  const provider = cleanText(providerValue, "provider");
  return queueModelSwitch(ctx, async () => {
    const registered = ctx.llm.listProviders().find((item) => item.id === provider);
    if (!registered) throw httpError(404, "model provider was not found");
    const models = await ctx.llm.listModels(provider);
    if (!models.length) throw httpError(409, `提供方「${registered.name || provider}」没有可用模型`);
    const current = ctx.agentDefaultModel.currentSelection();
    const model = current?.provider === provider && models.some((item) => item.id === current.model)
      ? current.model
      : models[0].id;
    return {
      provider,
      model,
      ...(current?.provider === provider && current.reasoningEffort !== undefined
        ? { reasoningEffort: current.reasoningEffort }
        : {}),
    };
  });
}

export {
  deleteModelProfile,
  listModelCatalog,
  normalizeSelection,
  readModelProfiles,
  runningAgents,
  sameSelection,
  saveModelProfile,
  switchModelProvider,
  switchModelProfile,
};
