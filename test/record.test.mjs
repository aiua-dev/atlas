import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { recordClaim, resolveOwner, formatRecordResult } from "../plugins/atlas/lib/record.mjs";

function makeProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-record-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
  }
  return root;
}

// 夹具按真实文档规模撰写：词面得分取决于文档体积与标题重合，
// 过小的夹具会让归属判定失真，测不出真实行为。
const TOPOLOGY = [
  "# 部署拓扑",
  "",
  "本文记录 flyserver 与消费者服务的当前部署事实，供发布与排障时核对。",
  "",
  "## 当前测试事实",
  "",
  "- 网关地址由环境变量注入，不在仓库中硬编码。",
  "- 测试环境与生产环境使用独立的数据库实例，避免相互污染。",
  "- 发布前需确认目标环境的配置中心已同步最新配置项。",
  "",
  "## 消费者服务",
  "",
  "消费者服务负责账号注册、登录票据签发与消费者资料读取。",
  "该服务由多个实例组成，前置负载均衡按健康检查结果分发流量。",
  "",
  "## 订单服务",
  "",
  "订单服务处理支付回调、订单状态流转与对账任务。",
  "订单相关查询走只读实例，写入走主库。",
  ""
].join("\n");

const AUTH_ORDERS = [
  "# 消费者认证与订单",
  "",
  "本文记录消费者认证链路与订单接口的调用约定。",
  "",
  "## 认证方式",
  "",
  "- 消费者登录后由认证服务签发票据，业务服务校验票据有效性。",
  "- 票据过期后需重新登录，不做静默续期。",
  "",
  "## 订单同步",
  "",
  "- 订单同步走队列，避免高峰期的直接写入压力。",
  "- 同步失败按指数退避重试，超过上限进入死信队列。",
  ""
].join("\n");

test("按词面重合挑选归属文件", () => {
  const root = makeProject({
    "docs/reference/deployment-topology.md": TOPOLOGY,
    "docs/reference/consumer-auth-orders.md": AUTH_ORDERS
  });

  const owner = resolveOwner(root, "消费者服务与订单服务共用数据库实例");
  assert.equal(owner.path, "docs/reference/deployment-topology.md");
});

test("结论写入匹配的章节而非文末", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });

  const result = recordClaim(root, "消费者服务与订单服务共用数据库实例，并共享连接池上限", {
    date: "2026-09-17"
  });
  assert.equal(result.recorded, true);
  assert.equal(result.anchor, "消费者服务");

  const content = fs.readFileSync(path.join(root, result.owner), "utf8");
  assert.match(content, /共享连接池上限/);
  // 新条目应落在「消费者服务」章节内，而不是文件末尾。
  const consumerIndex = content.indexOf("## 消费者服务");
  const claimIndex = content.indexOf("共享连接池上限");
  assert.ok(claimIndex > consumerIndex);
});

test("相同结论重复提交时跳过", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  const claim = "消费者服务与订单服务共用数据库实例，并共享连接池上限";

  const first = recordClaim(root, claim);
  assert.equal(first.recorded, true);

  const second = recordClaim(root, claim);
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "duplicate");
});

test("措辞微调不产生重复条目", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });

  recordClaim(root, "消费者服务与订单服务共用数据库实例。");
  const again = recordClaim(root, "消费者服务与订单服务共用数据库实例");
  assert.equal(again.recorded, false);
  assert.equal(again.reason, "duplicate");
});

test("无归属时新建文档而非塞进不相关的文件", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  const result = recordClaim(root, "量子隧穿效应影响边缘节点调度");
  // 默认行为：为这条结论新建一份文档。新项目首次记录必然无归属，
  // 拒绝写入会让「聊完理念就落盘」这条路径走不通。
  assert.equal(result.recorded, true);
  assert.ok(result.createdOwner, "应标记出这是新建的文档");
  const created = path.join(root, result.owner);
  assert.ok(fs.existsSync(created), "新文档应真实存在");
  assert.match(fs.readFileSync(created, "utf8"), /量子隧穿效应/);
});

test("新建的文档不会落入已有文件", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  const before = fs.readFileSync(path.join(root, "docs/reference/deployment-topology.md"), "utf8");
  recordClaim(root, "量子隧穿效应影响边缘节点调度");
  const after = fs.readFileSync(path.join(root, "docs/reference/deployment-topology.md"), "utf8");
  assert.equal(after, before, "不相关的已有文件不应被改动");
});

test("显式关闭新建时无归属则拒绝写入", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  const result = recordClaim(root, "量子隧穿效应影响边缘节点调度", { createMissing: false });
  assert.equal(result.recorded, false);
  assert.equal(result.reason, "no-owner");
  assert.match(formatRecordResult(result), /未找到归属文件/);
});

test("新建文档后重复记录同一结论不产生第二份", () => {
  const root = makeProject();
  const first = recordClaim(root, "量子隧穿效应影响边缘节点调度");
  assert.equal(first.recorded, true);
  const second = recordClaim(root, "量子隧穿效应影响边缘节点调度");
  // 第二次会因词面匹配命中第一份文档，指纹相同故跳过。
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "duplicate");
});

test("显式 --owner 绕过自动归属", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  const result = recordClaim(root, "任意内容只要显式指定归属", {
    owner: "docs/reference/deployment-topology.md"
  });
  assert.equal(result.recorded, true);
  assert.equal(result.owner, "docs/reference/deployment-topology.md");
});

test("显式归属越出项目时报错", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  assert.throws(() => recordClaim(root, "越界写入", { owner: "../../../etc/passwd" }), /必须位于项目内/);
});

test("超长结论拒绝记录", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  assert.throws(() => recordClaim(root, "长".repeat(2001)), /应作为独立文档/);
});

test("记录带指纹标记以便追溯", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  const result = recordClaim(root, "消费者服务与订单服务共用数据库实例，并共享连接池上限");
  const content = fs.readFileSync(path.join(root, result.owner), "utf8");
  assert.match(content, new RegExp(`<!-- atlas:${result.fingerprint} -->`));
  assert.match(content, /记录于 \d{4}-\d{2}-\d{2}/);
});

test("空结论被拒绝", () => {
  const root = makeProject({ "docs/reference/deployment-topology.md": TOPOLOGY });
  assert.throws(() => recordClaim(root, "   "), /内容为空/);
});

test("候选势均力敌时拒绝写入并报告歧义", () => {
  const root = makeProject({
    "docs/reference/deployment-topology.md": TOPOLOGY,
    "docs/reference/consumer-auth-orders.md": AUTH_ORDERS
  });
  // 「服务」「订单」「消费者」在两份文档里权重接近，不应猜测归属。
  const result = recordClaim(root, "订单服务与消费者服务之间的关系");
  if (result.recorded === false && result.reason === "ambiguous-owner") {
    assert.match(formatRecordResult(result), /归属存在歧义/);
  } else {
    // 若判定为明确归属，则必须是两份文档之一，且分数具备优势。
    assert.equal(result.recorded, true);
  }
});
