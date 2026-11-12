const PLAN_ID = "main";
const PLAN_KEY = "hh2627";

function authorized(request) {
  return request.headers.get("x-plan-key") === PLAN_KEY;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function mergeMapCreds(incoming, current) {
  const plan = { ...incoming };
  if (!String(plan.amapKey || "").trim() && current && String(current.amapKey || "").trim()) {
    plan.amapKey = current.amapKey;
  }
  if (!String(plan.securityCode || "").trim() && current && String(current.securityCode || "").trim()) {
    plan.securityCode = current.securityCode;
  }
  return plan;
}

function readPlan(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (!body.checklist || typeof body.checklist !== "object") return null;
  const syncRev = Number(body.syncRev);
  if (!Number.isFinite(syncRev)) return null;
  return body;
}

async function loadPlan(env) {
  const row = await env.DB.prepare("SELECT payload FROM plans WHERE id = ?")
    .bind(PLAN_ID)
    .first();
  if (!row) return null;
  try {
    return readPlan(JSON.parse(row.payload));
  } catch {
    return null;
  }
}

async function savePlan(env, plan) {
  await env.DB.prepare(
    `INSERT INTO plans (id, payload, updated_at)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET
       payload = excluded.payload,
       updated_at = excluded.updated_at`
  )
    .bind(PLAN_ID, JSON.stringify(plan), Date.now())
    .run();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/plan") {
      return env.ASSETS.fetch(request);
    }

    if (!authorized(request)) {
      return json({ error: "密钥不正确" }, 401);
    }

    if (request.method === "GET") {
      return json({ plan: await loadPlan(env) });
    }

    if (request.method === "PUT") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "行程数据不是合法的 JSON" }, 400);
      }
      const plan = readPlan(body);
      if (!plan) return json({ error: "行程数据不完整" }, 400);

      const current = await loadPlan(env);
      if (current && Number(current.syncRev) > Number(plan.syncRev)) {
        return json({ plan: current }, 409);
      }
      const saved = mergeMapCreds(plan, current);
      await savePlan(env, saved);
      return json({ plan: saved });
    }

    return json({ error: "只支持 GET 和 PUT" }, 405);
  },
};
