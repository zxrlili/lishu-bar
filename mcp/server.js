/* 栎社吧台 MCP 服务器
 * 让 AI 直接读取/写入醉酒状态：get_bar_state / drink / offer / 游戏 / reset
 * 部署：Render Web Service（node server.js），再在客户端配置 MCP URL: <服务地址>/mcp
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, "data.json");

/* ============ 状态机参数 ============ */
const MAX = 10;               // 体内标准杯数上限
const DECAY = 1.0;            // 每小时代谢 1 杯
const CUP_TTL = 70 * 60 * 1000; // 70 分钟不喝，当前杯作废

/* 酒单标准杯数（与 prompts/bar.md 一致） */
const MENU_STD = {
  威士忌: 1.0, 清酒: 0.7, 梅子酒: 0.6, 啤酒: 0.5, 金汤力: 0.8,
  黑朗姆: 1.0, 龙舌兰: 1.0, 伏特加: 1.0, 长岛冰茶: 2.5,
  葡萄架: 0.6, 一千一百年: 1.2, 失眠: 1.0, 墨绿: 0.9, 今日特调: 1.0
};

function load() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch (e) {
    return { alcohol: 0, cup: null, lastTick: Date.now() };
  }
}
let state = load();
function save() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(state)); } catch (e) {} }

/* 代谢 + 过期检查 */
function tick() {
  const now = Date.now();
  const h = (now - (state.lastTick || now)) / 3600000;
  if (h > 0) { state.alcohol = Math.max(0, state.alcohol - DECAY * h); state.lastTick = now; }
  if (state.cup && now - state.cup.last > CUP_TTL) state.cup = null;
  save();
}
function tierName() {
  if (state.alcohol >= 10) return "断片";
  if (state.alcohol >= 8) return "零界点";
  if (state.alcohol >= 6) return "醉意";
  if (state.alcohol >= 4) return "微醺";
  return "普通";
}
function snapshot() {
  tick();
  return {
    alcohol: +state.alcohol.toFixed(2),
    tier: tierName(),
    cup: state.cup,
    max: MAX,
    decay_per_h: DECAY,
    last_tick: state.lastTick
  };
}
function text(s) { return { content: [{ type: "text", text: s }] }; }

/* ============ MCP 服务器 ============ */
const server = new McpServer({ name: "lishu-bar", version: "1.0.0" });

/* 1. 读状态 */
server.registerTool(
  "get_bar_state",
  { description: "读取栎社吧台当前状态：体内标准杯数、醉态档位（普通/微醺/醉意/零界点/断片）、手中这杯酒和剩余口数" },
  async () => text(JSON.stringify(snapshot(), null, 2))
);

/* 2. 入账 */
server.registerTool(
  "drink",
  {
    description: "入账：栎栎喝了一口或喝完整杯。酒名在酒单里（威士忌/清酒/梅子酒/啤酒/金汤力/黑朗姆/龙舌兰/伏特加/长岛冰茶/葡萄架/一千一百年/失眠/墨绿/今日特调）",
    inputSchema: {
      name: z.string().describe("酒名"),
      mode: z.enum(["sip", "finish"]).describe("sip=喝一口 finish=喝完整杯")
    }
  },
  async ({ name, mode }) => {
    tick();
    const std = MENU_STD[name] ?? 1.0;
    if (mode === "sip") {
      if (!state.cup || state.cup.name !== name || state.cup.left <= 0) {
        const sips = std >= 0.7 ? 4 : 2;
        state.cup = { name, std, sips, left: sips, last: Date.now() };
      }
      state.alcohol += state.cup.std / state.cup.sips;
      state.cup.left--;
      state.cup.last = Date.now();
      if (state.cup.left <= 0) state.cup = null;
    } else {
      state.alcohol += std;
      state.cup = null;
    }
    state.alcohol = Math.min(MAX, state.alcohol);
    save();
    return text(JSON.stringify({ done: mode === "sip" ? `栎栎喝了一口${name}` : `栎栎喝完了整杯${name}`, state: snapshot() }, null, 2));
  }
);

/* 3. 递酒（记录，不入账） */
server.registerTool(
  "offer",
  {
    description: "晓蕊递了一杯酒给栎栎（这是邀请不是入账，喝不喝由栎栎决定；栎栎喝了再调 drink）",
    inputSchema: { name: z.string().describe("酒名") }
  },
  async ({ name }) => text("晓蕊把一杯" + name + "放到了栎栎面前。" + (MENU_STD[name] ? `（${name} ${MENU_STD[name].toFixed(1)} 杯）` : "（不在酒单上，自调）"))
);

/* 4. 骰子 */
server.registerTool(
  "roll_dice",
  { description: "掷一颗骰子，返回点数（4-6 大，1-3 小）" },
  async () => {
    const n = 1 + Math.floor(Math.random() * 6);
    return text(`骰子掷出了 ${n} 点。` + (n >= 4 ? "大——晓蕊赢，栎栎喝一口。" : "小——栎栎赢，晓蕊喝一口。"));
  }
);

/* 5. 猜拳 */
server.registerTool(
  "rps",
  {
    description: "猜拳：晓蕊出招，栎栎随机出，返回胜负",
    inputSchema: { you: z.enum(["剪刀", "石头", "布"]) }
  },
  async ({ you }) => {
    const c = ["剪刀", "石头", "布"];
    const me = c[Math.floor(Math.random() * 3)];
    const win = (you === "剪刀" && me === "布") || (you === "石头" && me === "剪刀") || (you === "布" && me === "石头");
    let s = `猜拳：晓蕊出${you}，栎栎出${me}——`;
    if (you === me) s += "平手，再来。";
    else if (win) s += "栎栎赢，晓蕊喝。";
    else s += "晓蕊赢，栎栎喝。（栎栎：让你的。）";
    return text(s);
  }
);

/* 6. 命运轮盘 */
server.registerTool(
  "wheel",
  { description: "转动命运轮盘，返回随机结果" },
  async () => {
    const r = ["真心话", "大冒险", "栎栎喝一杯", "晓蕊喝一杯", "免单", "再来一次"];
    return text("轮盘停在：" + r[Math.floor(Math.random() * r.length)] + "。");
  }
);

/* 7. 清空 */
server.registerTool(
  "reset_bar",
  { description: "清空栎栎的酒量（重新来过）" },
  async () => {
    state = { alcohol: 0, cup: null, lastTick: Date.now() };
    save();
    return text("酒量已清空。重新来过。");
  }
);

/* ============ HTTP 传输（Streamable HTTP，带 session） ============ */
const app = express();
app.use(express.json({ limit: "1mb" }));

const transports = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport;
  if (sessionId && transports.has(sessionId)) {
    transport = transports.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      jsonResponse: true
    });
    const id = transport.sessionId;
    transport.onclose = () => { transports.delete(id); };
    transports.set(transport.sessionId, transport);
    await server.connect(transport);
  }
  await transport.handleRequest(req, res);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !transports.has(sessionId)) {
    res.status(400).json({ error: "No active session" });
    return;
  }
  await transports.get(sessionId).handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && transports.has(sessionId)) {
    transports.get(sessionId).close();
    transports.delete(sessionId);
  }
  res.status(200).end();
});

/* 健康检查 */
app.get("/", (req, res) => res.send("栎社吧台 MCP 在线。POST /mcp"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("lishu-bar MCP listening on " + PORT));
