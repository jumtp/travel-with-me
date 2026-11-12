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

function checklistRevision(plan) {
  const rev = Number(plan?.checklistRev);
  return Number.isFinite(rev) && rev > 0 ? rev : 0;
}

function mergePlan(incoming, current) {
  if (!current) return incoming;
  const incomingNewer = Number(incoming.syncRev) >= Number(current.syncRev);
  const plan = incomingNewer ? { ...incoming } : { ...current };
  const creds = mergeMapCreds(incoming, current);
  plan.amapKey = creds.amapKey;
  plan.securityCode = creds.securityCode;
  const incomingChecklistRev = checklistRevision(incoming);
  const currentChecklistRev = checklistRevision(current);
  if (incomingChecklistRev > currentChecklistRev) {
    plan.checklist = incoming.checklist;
    plan.checklistRev = incomingChecklistRev;
  } else if (currentChecklistRev > incomingChecklistRev) {
    plan.checklist = current.checklist;
    plan.checklistRev = currentChecklistRev;
  } else if (incomingNewer) {
    plan.checklist = incoming.checklist;
  }
  if (!incomingNewer) plan.syncRev = current.syncRev;
  return plan;
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
    if (url.pathname === "/api/sync") {
      const key = requestKey(request);
      if (key !== PLAN_KEY) return json({ error: "密钥不正确" }, 401);
      if (!env.PLAN_ROOM) return json({ error: "实时同步未配置" }, 500);
      try {
        const id = env.PLAN_ROOM.idFromName(key);
        return await env.PLAN_ROOM.get(id).fetch(request);
      } catch (error) {
        return dbError(error);
      }
    }
    if (url.pathname !== "/api/plan") {
      return env.ASSETS.fetch(request);
    }

    if (!authorized(request)) {
      return json({ error: "密钥不正确" }, 401);
    }

    if (request.method === "GET") {
      try {
        return json({ plan: await loadPlan(env) });
      } catch (error) {
        return dbError(error);
      }
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

      try {
        const current = await loadPlan(env);
        const saved = mergePlan(plan, current);
        const incomingChecklistWins = current && checklistRevision(plan) > checklistRevision(current);
        if (current && Number(current.syncRev) > Number(plan.syncRev) && !incomingChecklistWins) {
          return json({ plan: current }, 409);
        }
        await savePlan(env, saved);
        await publishPlan(env, PLAN_KEY, saved);
        return json({ plan: saved });
      } catch (error) {
        return dbError(error);
      }
    }

    return json({ error: "只支持 GET 和 PUT" }, 405);
  },
};

function dbError(error) {
  console.error("plan db", error);
  return json({ error: "云端暂时不可用" }, 500);
}

function requestKey(request) {
  const header = request.headers.get("x-plan-key");
  if (header) return header;
  return new URL(request.url).searchParams.get("key") || "";
}

async function publishPlan(env, key, plan) {
  if (!env.PLAN_ROOM || key !== PLAN_KEY) return;
  try {
    const id = env.PLAN_ROOM.idFromName(key);
    const stub = env.PLAN_ROOM.get(id);
    await stub.fetch("https://plan-room/publish", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-plan-key": key,
      },
      body: JSON.stringify({ type: "plan", plan }),
    });
  } catch (error) {
    console.warn("publish plan", error);
  }
}

export class PlanRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const key = request.headers.get("x-plan-key") || new URL(request.url).searchParams.get("key") || "";
    if (key !== PLAN_KEY) return new Response("密钥不正确", { status: 401 });

    if (request.method === "POST") {
      const message = await request.text();
      for (const socket of this.ctx.getWebSockets()) {
        const attached = socket.deserializeAttachment();
        if (!attached || attached.key !== key) continue;
        try {
          socket.send(message);
        } catch (error) {
          console.warn("socket send", error);
        }
      }
      return new Response(null, { status: 204 });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("需要 WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ key });
    return new Response(null, { status: 101, webSocket: client });
  }
}
