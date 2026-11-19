// pocket-lody/service/fixture-data.ts — the sample workspace fixture.ts serves.
//
// Everything here is invented: Lantern Labs, its people, repositories, pull
// requests and conversations do not exist. The data is built from a start
// time, so the same `now` gives the same bytes.

import type { AskOption, DiffFile, Item, MachineRow, MentionRow, SessionRow, SessionState, ToolKind, ToolStatus, WorkspaceRow } from "../protocol.ts";

export const ME = { name: "林夏", email: "linxia@lantern.example" };
export const WORKSPACES: WorkspaceRow[] = [
  { id: "ws-lantern", name: "Lantern Labs" },
  { id: "ws-home", name: "林夏的个人空间" },
];

export const MACHINES: Record<string, MachineRow[]> = {
  "ws-lantern": [
    { id: "m-studio", name: "Studio Mac", online: true, mine: true },
    { id: "m-forge", name: "forge-linux", online: true },
    { id: "m-air", name: "林夏的 MacBook Air", online: false, mine: true },
  ],
  "ws-home": [
    { id: "m-studio", name: "Studio Mac", online: true, mine: true },
    { id: "m-air", name: "林夏的 MacBook Air", online: false, mine: true },
  ],
};

export const AGENTS = [
  { id: "a-claude-studio", name: "Claude", machineId: "m-studio", detail: "Claude Sonnet 4.5" },
  { id: "a-codex-studio", name: "Codex", machineId: "m-studio", detail: "GPT-5 Codex" },
  { id: "a-claude-forge", name: "Claude", machineId: "m-forge", detail: "Claude Sonnet 4.5" },
  { id: "a-codex-forge", name: "Codex", machineId: "m-forge", detail: "GPT-5 Codex" },
  { id: "a-claude-air", name: "Claude", machineId: "m-air", detail: "Claude Haiku 4.5" },
];

export const PROJECTS: { id: string; name: string; kind: "github" | "local" | "chat"; machineId?: string }[] = [
  { id: "gh:lantern-labs/tidepool", name: "lantern-labs/tidepool", kind: "github" },
  { id: "gh:lantern-labs/kite-web", name: "lantern-labs/kite-web", kind: "github" },
  { id: "gh:lantern-labs/harbor-cli", name: "lantern-labs/harbor-cli", kind: "github" },
  { id: "gh:lantern-labs/docs", name: "lantern-labs/docs", kind: "github" },
  { id: "local:scratch", name: "scratch", kind: "local", machineId: "m-studio" },
  { id: "local:notebook", name: "notebook", kind: "local", machineId: "m-air" },
  { id: "chat", name: "No project", kind: "chat" },
];

export const ROLES: MentionRow[] = [
  { kind: "role", id: "role-reviewer", label: "Reviewer", detail: "Reads a diff and lists the risks" },
  { kind: "role", id: "role-release", label: "发布经理", detail: "检查变更日志、打 tag、发版" },
  { kind: "role", id: "role-docs", label: "Docs writer", detail: "Turns a change into a how-to" },
  { kind: "role", id: "role-triage", label: "值班排障", detail: "先复现，再定位，最后给出修复方案" },
];

export const FILES: Record<string, string[]> = {
  "lantern-labs/tidepool": [
    "Cargo.toml",
    "README.md",
    "crates/engine/src/lib.rs",
    "crates/engine/src/retry.rs",
    "crates/engine/src/queue.rs",
    "crates/engine/src/journal.rs",
    "crates/store/src/lib.rs",
    "crates/store/src/segment.rs",
    "crates/store/src/compaction.rs",
    "crates/store/src/index.rs",
    "crates/store/tests/segment_roundtrip.rs",
    "docs/storage-format.md",
    "migrations/0007_partition_events.sql",
  ],
  "lantern-labs/kite-web": [
    "package.json",
    "src/app.tsx",
    "src/orders/OrdersTable.tsx",
    "src/orders/useOrders.ts",
    "src/orders/columns.ts",
    "src/theme/tokens.css",
    "src/theme/dark.css",
    "tests/orders.spec.ts",
    "tests/__snapshots__/orders.spec.ts.snap",
  ],
  "lantern-labs/harbor-cli": ["Cargo.toml", "CHANGELOG.md", "src/main.rs", "src/plugin/loader.rs", "src/plugin/manifest.rs", "src/plugin/mod.rs", "tests/plugin_loader.rs", "scripts/release.sh"],
  "lantern-labs/docs": ["docs/quickstart.md", "docs/zh/quickstart.md", "docs/concepts/sync.md", "sidebars.ts", "docusaurus.config.ts"],
  notebook: ["bench/cold-start.md", "bench/run.sh"],
};

export interface FixtureSession {
  workspace: string;
  row: SessionRow;
  items: Item[];
  activeTurn?: string;
  /** what the live simulation does with this session at start */
  live?: "stream";
}

// ---------------------------------------------------------------------------
// A conversation, written item by item.
// ---------------------------------------------------------------------------

/** An item before it has a place in a conversation. */
type Unplaced = Item extends infer T ? (T extends Item ? Omit<T, "id" | "turn" | "at"> : never) : never;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

class Script {
  readonly items: Item[] = [];
  private turn = "";
  private at = 0;
  private n = 0;

  constructor(readonly id: string) {}

  private push(after: number, item: Unplaced & { id?: string }): string {
    this.at += after;
    const id = item.id ?? `${this.id}:${++this.n}`;
    if (item.k === "user") this.turn = id;
    this.items.push({ ...item, id, turn: this.turn, at: this.at } as Item);
    return id;
  }

  user(text: string, more: { author?: string; mine?: boolean; delivery?: "queued" | "sending" | "failed"; attachments?: number; after?: number } = {}) {
    const { after, ...rest } = more;
    const mine = rest.mine ?? rest.author === undefined;
    return this.push(after ?? 3 * MINUTE, { k: "user", text, author: rest.author ?? ME.name, ...(mine ? { mine: true } : {}), ...(rest.delivery ? { delivery: rest.delivery } : {}), ...(rest.attachments ? { attachments: rest.attachments } : {}) });
  }

  thought(text: string) {
    return this.push(2 * SECOND, { k: "thought", text });
  }

  text(text: string, more: { streaming?: boolean; final?: boolean } = {}) {
    return this.push(6 * SECOND, { k: "text", text, ...(more.streaming ? { streaming: true } : {}), ...(more.final ? { final: true } : {}) });
  }

  tool(kind: ToolKind, title: string, more: { status?: ToolStatus; detail?: string; output?: string; diff?: DiffFile[] } = {}) {
    return this.push(4 * SECOND, { k: "tool", kind, title, status: more.status ?? "done", ...(more.detail ? { detail: more.detail } : {}), ...(more.output ? { output: more.output } : {}), ...(more.diff ? { diff: more.diff } : {}) });
  }

  plan(entries: [string, "pending" | "running" | "done"][]) {
    return this.push(3 * SECOND, { k: "plan", entries: entries.map(([text, status]) => ({ text, status })) });
  }

  ask(title: string, options: AskOption[], more: { detail?: string; outcome?: string; question?: boolean; requestId?: string } = {}) {
    return this.push(2 * SECOND, { k: "ask", requestId: more.requestId ?? `${this.id}:req${this.n + 1}`, title, options, ...(more.detail ? { detail: more.detail } : {}), ...(more.outcome ? { outcome: more.outcome } : {}), ...(more.question ? { question: true } : {}) });
  }

  notice(tone: "info" | "error" | "done", text: string, sessionId?: string) {
    return this.push(1 * SECOND, { k: "notice", tone, text, ...(sessionId ? { sessionId } : {}) });
  }

  end(outcome: "completed" | "failed" | "canceled", durationMs: number, model: string) {
    return this.push(1 * SECOND, { k: "turn-end", outcome, durationMs, model });
  }

  /** Every item's time moved so the last one is at `last`. */
  shifted(last: number): Item[] {
    const offset = last - this.at;
    return this.items.map((item) => ({ ...item, at: item.at + offset }));
  }

  get lastTurn() {
    return this.turn;
  }
}

const PERMISSION: AskOption[] = [
  { id: "allow", label: "Allow once", kind: "allow" },
  { id: "allow-always", label: "Always allow", kind: "allow-always" },
  { id: "reject", label: "Reject", kind: "reject" },
];
const PERMISSION_ZH: AskOption[] = [
  { id: "allow", label: "允许一次", kind: "allow" },
  { id: "allow-always", label: "始终允许", kind: "allow-always" },
  { id: "reject", label: "拒绝", kind: "reject" },
];

const SONNET = "Claude Sonnet 4.5";
const CODEX = "GPT-5 Codex";
const HAIKU = "Claude Haiku 4.5";

/** A string of one line, for a row's preview. */
export function oneLine(text: string, max = 110): string {
  const flat = text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>|]/g, "").replace(/\s+/g, " ").trim();
  const letters = Array.from(flat);
  return letters.length > max ? `${letters.slice(0, max - 1).join("")}…` : flat;
}

export function previewOf(items: Item[]): string | undefined {
  for (let at = items.length - 1; at >= 0; at--) {
    const item = items[at]!;
    if (item.k === "text" || item.k === "user") return oneLine(item.text);
    if (item.k === "ask") return oneLine(item.title);
    if (item.k === "notice" && item.tone === "error") return oneLine(item.text);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The conversations.
// ---------------------------------------------------------------------------

function syncRetry(): Script {
  const s = new Script("s-sync-retry");
  s.user("同步引擎现在的重试是固定 2 秒一次，服务端一抖动客户端就一起打过来。改成指数退避加抖动吧，上限 60 秒，另外把重试次数做成可配置的。", { attachments: 1 });
  s.thought("先看现在的重试逻辑在哪。应该在 crates/engine/src/retry.rs，调用点在 queue.rs。要确认有没有测试依赖固定间隔。");
  s.plan([
    ["阅读 retry.rs 和 queue.rs 的现有实现", "done"],
    ["实现 full jitter 的指数退避", "done"],
    ["把 max_attempts / base / cap 放进 RetryPolicy", "running"],
    ["补单元测试，跑 cargo test -p engine", "pending"],
  ]);
  s.tool("read", "Read retry.rs", { detail: "crates/engine/src/retry.rs" });
  s.tool("search", "Search for fixed_delay", {
    detail: 'rg -n "fixed_delay|RETRY_INTERVAL" crates/',
    output: "crates/engine/src/retry.rs:14:const RETRY_INTERVAL: Duration = Duration::from_secs(2);\ncrates/engine/src/retry.rs:41:    fixed_delay(RETRY_INTERVAL)\ncrates/engine/src/queue.rs:118:        let delay = retry::fixed_delay(RETRY_INTERVAL);\ncrates/engine/tests/queue_retry.rs:27:    assert_eq!(delays, vec![2, 2, 2]);",
  });
  s.text("现状确认了：`RETRY_INTERVAL` 是写死的 2 秒，`queue.rs:118` 是唯一的调用点，另外有一个测试断言了 `[2, 2, 2]`，改完要一起更新。\n\n我准备用 **full jitter**（每次在 `[0, min(cap, base * 2^n)]` 里取随机值），这样客户端之间不会同步重试。");
  s.tool("edit", "Edit retry.rs", {
    detail: "crates/engine/src/retry.rs",
    diff: [
      {
        path: "crates/engine/src/retry.rs",
        added: 31,
        removed: 6,
        lines: [
          "@@ -11,9 +11,34 @@ use std::time::Duration;",
          " ",
          "-const RETRY_INTERVAL: Duration = Duration::from_secs(2);",
          "+/// 重试策略：指数退避 + full jitter。",
          "+#[derive(Debug, Clone, Copy)]",
          "+pub struct RetryPolicy {",
          "+    pub base: Duration,",
          "+    pub cap: Duration,",
          "+    pub max_attempts: u32,",
          "+}",
          "+",
          "+impl Default for RetryPolicy {",
          "+    fn default() -> Self {",
          "+        Self { base: Duration::from_millis(500), cap: Duration::from_secs(60), max_attempts: 8 }",
          "+    }",
          "+}",
          " ",
          "-pub fn fixed_delay(interval: Duration) -> Duration {",
          "-    interval",
          "+impl RetryPolicy {",
          "+    pub fn delay(&self, attempt: u32, rng: &mut impl Rng) -> Duration {",
          "+        let ceiling = self.base.saturating_mul(1 << attempt.min(16)).min(self.cap);",
          "+        Duration::from_millis(rng.gen_range(0..=ceiling.as_millis() as u64))",
          "+    }",
          " }",
        ],
      },
    ],
  });
  s.tool("edit", "Edit queue.rs", {
    detail: "crates/engine/src/queue.rs",
    diff: [{ path: "crates/engine/src/queue.rs", added: 9, removed: 3, lines: ["@@ -115,7 +115,13 @@ impl Queue {", "         while let Some(batch) = self.pending.pop_front() {", "-        let delay = retry::fixed_delay(RETRY_INTERVAL);", "+        if batch.attempt >= self.policy.max_attempts {", "+            self.dead_letter.push(batch);", "+            continue;", "+        }", "+        let delay = self.policy.delay(batch.attempt, &mut self.rng);", "         self.timer.sleep(delay).await;"] }],
  });
  s.tool("execute", "Run engine tests", { status: "running", detail: "cargo test -p engine retry", output: "   Compiling engine v0.14.2 (/work/tidepool/crates/engine)\n    Finished test [unoptimized + debuginfo] target(s) in 9.41s\n     Running unittests src/lib.rs\n\nrunning 6 tests\ntest retry::tests::delay_never_exceeds_cap ... ok\ntest retry::tests::delay_grows_with_attempt ... ok" });
  s.text("改动已经写好，正在跑 `cargo test -p engine retry`。目前的情况：\n\n- `RetryPolicy` 有三个字段：`base`、`cap`、`max_attempts`，默认 500ms / 60s / 8 次\n- 超过次数的批次进", { streaming: true });
  return s;
}

function kiteTable(): Script {
  const s = new Script("s-kite-table");
  s.user("The orders table janks badly past ~2k rows. Can you virtualize it? Keep sorting and the sticky header, and don't pull in a big dependency.");
  s.thought("OrdersTable renders every row. A windowed list with a fixed row height is enough; the header is already position: sticky. Check how rows are measured before choosing an approach.");
  s.tool("read", "Read OrdersTable.tsx", { detail: "src/orders/OrdersTable.tsx" });
  s.tool("search", "Find row height usages", { detail: 'rg -n "rowHeight|ROW_H" src/orders', output: "src/orders/OrdersTable.tsx:18:const ROW_H = 44;\nsrc/orders/columns.ts:7:export const rowHeight = 44;" });
  s.tool("edit", "Add useWindow.ts", {
    detail: "src/orders/useWindow.ts",
    diff: [
      {
        path: "src/orders/useWindow.ts",
        added: 24,
        removed: 0,
        lines: [
          "@@ -0,0 +1,24 @@",
          "+import { useEffect, useState, type RefObject } from \"react\";",
          "+",
          "+/** The slice of `count` rows a scroller of fixed-height rows shows. */",
          "+export function useWindow(scroller: RefObject<HTMLElement>, count: number, rowHeight: number, overscan = 8) {",
          "+  const [range, setRange] = useState({ start: 0, end: 40 });",
          "+  useEffect(() => {",
          "+    const el = scroller.current;",
          "+    if (!el) return;",
          "+    const update = () => {",
          "+      const start = Math.max(0, Math.floor(el.scrollTop / rowHeight) - overscan);",
          "+      const end = Math.min(count, Math.ceil((el.scrollTop + el.clientHeight) / rowHeight) + overscan);",
          "+      setRange((old) => (old.start === start && old.end === end ? old : { start, end }));",
          "+    };",
          "+    update();",
          "+    el.addEventListener(\"scroll\", update, { passive: true });",
          "+    return () => el.removeEventListener(\"scroll\", update);",
          "+  }, [scroller, count, rowHeight, overscan]);",
          "+  return range;",
          "+}",
        ],
      },
    ],
  });
  s.tool("edit", "Edit OrdersTable.tsx", { detail: "src/orders/OrdersTable.tsx", diff: [{ path: "src/orders/OrdersTable.tsx", added: 18, removed: 7, lines: ["@@ -42,9 +42,14 @@ export function OrdersTable({ orders }: Props) {", "-      {sorted.map((order) => (", "-        <OrderRow key={order.id} order={order} />", "-      ))}", "+      <tr style={{ height: range.start * ROW_H }} aria-hidden />", "+      {sorted.slice(range.start, range.end).map((order) => (", "+        <OrderRow key={order.id} order={order} />", "+      ))}", "+      <tr style={{ height: (sorted.length - range.end) * ROW_H }} aria-hidden />"] }] });
  s.ask("Allow bun test tests/orders.spec.ts?", PERMISSION, { detail: "bun test tests/orders.spec.ts", outcome: "Always allow" });
  s.tool("execute", "Run the orders tests", { detail: "bun test tests/orders.spec.ts", output: "bun test v1.4.2\n\ntests/orders.spec.ts:\n✓ sorts by total descending [3.21ms]\n✓ keeps the header sticky while scrolling [11.80ms]\n✓ renders only the visible window for 10k rows [8.44ms]\n\n 3 pass\n 0 fail\n 9 expect() calls\nRan 3 tests across 1 file. [412.00ms]" });
  s.tool("fetch", "Check the scroll event guidance", { detail: "https://developer.example/docs/web/scroll-performance", output: "200 OK · 18.4 kB · Passive listeners keep scrolling on the compositor thread…" });
  s.text(
    [
      "## Orders table is virtualized",
      "",
      "The table now renders only the rows in view plus a small overscan. No new dependency: it is a 24-line hook, `useWindow`, in [`src/orders/useWindow.ts`](https://git.example/lantern-labs/kite-web/blob/perf/virtual-table/src/orders/useWindow.ts).",
      "",
      "### What changed",
      "",
      "1. **`useWindow(scroller, count, rowHeight)`** computes `{ start, end }` from `scrollTop`.",
      "2. **`OrdersTable`** renders `sorted.slice(start, end)` between two spacer rows, so the scrollbar keeps its real length.",
      "   - Sorting is untouched: it happens before the slice.",
      "   - The sticky header is untouched: it lives outside `<tbody>`.",
      "     - I verified it at 100%, 125% and 200% zoom.",
      "3. A test renders 10,000 orders and asserts fewer than 80 `<tr>` exist.",
      "",
      "### Numbers",
      "",
      "| Rows | Before (ms / frame) | After (ms / frame) | DOM nodes |",
      "| ---: | ---: | ---: | ---: |",
      "| 500 | 6.1 | 2.0 | 1,140 |",
      "| 2,000 | 23.8 | 2.1 | 1,140 |",
      "| 10,000 | 131.5 | 2.3 | 1,140 |",
      "",
      "```ts",
      "const range = useWindow(scrollerRef, sorted.length, ROW_H);",
      "const visible = sorted.slice(range.start, range.end);",
      "```",
      "",
      "> One caveat: rows must stay a fixed `44px`. If a row ever wraps to two lines the spacer math drifts, so I added `white-space: nowrap` to the cells.",
      "",
      "I opened **#482** with the change. Want me to also virtualize the *customers* table the same way?",
    ].join("\n"),
    { final: true },
  );
  s.end("completed", 4 * MINUTE + 12 * SECOND, CODEX);
  return s;
}

function release(): Script {
  const s = new Script("s-release");
  s.user("准备发 harbor-cli 0.9.0。检查一下 CHANGELOG，版本号都改对了就打 tag 推上去。");
  s.thought("发版步骤：确认 Cargo.toml 和 CHANGELOG 的版本一致 → 跑测试 → 打 tag → 推送。推送需要用户确认。");
  s.plan([
    ["核对 Cargo.toml 与 CHANGELOG.md 的版本号", "done"],
    ["cargo test --all 通过", "done"],
    ["创建带注释的 tag v0.9.0", "done"],
    ["推送 tag 到 origin", "running"],
    ["确认 release workflow 启动", "pending"],
  ]);
  s.tool("read", "Read CHANGELOG.md", { detail: "CHANGELOG.md" });
  s.tool("execute", "Check versions", { detail: 'grep -n "^version" Cargo.toml && head -5 CHANGELOG.md', output: '3:version = "0.9.0"\n# Changelog\n\n## 0.9.0 — 2026-11-18\n\n- 插件加载器：支持从 `~/.harbor/plugins` 发现插件' });
  s.tool("execute", "Run all tests", { detail: "cargo test --all", output: "test result: ok. 128 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 14.07s" });
  s.tool("execute", "Create tag", { detail: 'git tag -a v0.9.0 -m "harbor-cli 0.9.0"', output: "" });
  s.text("版本号一致（`Cargo.toml` 和 `CHANGELOG.md` 都是 **0.9.0**），128 个测试全部通过，本地 tag `v0.9.0` 已经打好。\n\n下一步是把 tag 推到 `origin`，这会触发 release workflow 并发布到 crates 仓库，**无法撤回**，所以需要你确认。");
  s.tool("execute", "Push tag", { status: "pending", detail: "git push origin v0.9.0" });
  s.ask("允许执行 git push origin v0.9.0 吗？", PERMISSION_ZH, { detail: "git push origin v0.9.0", requestId: "req-release-push" });
  return s;
}

function schema(): Script {
  const s = new Script("s-schema");
  s.user("events 表已经 4 亿行了，查询最近 7 天的数据越来越慢。帮我出一个分区迁移方案，要求不停机。");
  s.thought("需要先看表结构和查询模式。主要查询按 tenant_id + created_at 过滤。分区键的选择会影响后面所有步骤，应该先问清楚。");
  s.tool("read", "Read the latest migration", { detail: "migrations/0006_events_indexes.sql" });
  s.tool("execute", "Inspect table size", { detail: 'psql -c "\\dt+ events"', output: " Schema |  Name  | Type  | Owner |  Size  \n--------+--------+-------+-------+--------\n public | events | table | app   | 212 GB" });
  s.tool("think", "Compare partition strategies", { output: "RANGE(created_at) 按月：归档简单，最近数据的查询只扫 1–2 个分区。\nHASH(tenant_id)：租户隔离好，但时间范围查询要扫所有分区。\n两级分区：最灵活，分区数量 = 月数 × 桶数，运维成本最高。" });
  s.text(
    [
      "我看了表结构和慢查询日志，有三种可行的策略，取舍如下：",
      "",
      "| 方案 | 分区键 | 最近 7 天查询 | 归档旧数据 | 复杂度 |",
      "| --- | --- | --- | --- | --- |",
      "| A | `RANGE (created_at)` 按月 | 扫 1–2 个分区 | `DETACH` 即可 | 低 |",
      "| B | `HASH (tenant_id)` 16 桶 | 扫全部 16 个 | 需要逐桶删除 | 中 |",
      "| C | 先按月再按 tenant 哈希 | 扫 1–2 × 4 个 | `DETACH` 即可 | 高 |",
      "",
      "不停机迁移的步骤三种方案相同：",
      "",
      "1. 建新的分区表 `events_p`，结构与 `events` 一致",
      "2. 用触发器 **双写**，保证新数据两边都有",
      "3. 分批回填历史数据（每批 5 万行，`pg_sleep(0.2)`）",
      "4. 校验行数与校验和，然后在一个事务里 `RENAME` 切换",
      "",
      "```sql",
      "CREATE TABLE events_p (LIKE events INCLUDING ALL)",
      "  PARTITION BY RANGE (created_at);",
      "```",
      "",
      "选哪种分区策略？",
    ].join("\n"),
  );
  s.ask(
    "选哪种分区策略？",
    [
      { id: "a", label: "A：按月 RANGE (created_at)", kind: "answer" },
      { id: "b", label: "B：HASH (tenant_id) 16 桶", kind: "answer" },
      { id: "c", label: "C：两级分区（月 + tenant）", kind: "answer" },
      { id: "other", label: "其他（我来说明）", kind: "answer" },
    ],
    { question: true, requestId: "req-schema-strategy", detail: "这个选择决定迁移脚本怎么写；之后要换需要重新回填。" },
  );
  return s;
}

function ciFlake(): Script {
  const s = new Script("s-ci-flake");
  s.user("orders.spec.ts 的快照测试在 Linux CI 上三次里挂一次，本地 mac 从来不挂。Find out why and fix it — 不要直接更新快照了事。", { author: "周航", mine: false });
  s.thought("Flaky only on Linux: likely font metrics, locale-dependent number formatting, or timing. Look at the snapshot diff from the failing CI run first.");
  s.tool("execute", "Fetch the failing job log", { detail: "gh run view 88213 --log-failed | tail -20", output: "- Snapshot  - 1\n+ Received  + 1\n\n-   <td>1,204.50</td>\n+   <td>1 204,50</td>\n\n  at tests/orders.spec.ts:41:27\n\n 1 fail\n 2 pass" });
  s.text("The diff is a number format: `1,204.50` vs `1 204,50`. That is `Intl.NumberFormat` picking the runner's locale. The flaky part is that only one of the three CI runner images sets `LANG=fr_FR.UTF-8`.");
  s.tool("search", "Find toLocaleString calls", { detail: 'rg -n "toLocaleString\\(|NumberFormat\\(" src', output: "src/orders/columns.ts:22:  format: (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2 }),\nsrc/orders/OrdersTable.tsx:88:    new Intl.NumberFormat().format(total)" });
  s.tool("edit", "Edit columns.ts", { detail: "src/orders/columns.ts", diff: [{ path: "src/orders/columns.ts", added: 2, removed: 1, lines: ["@@ -19,7 +19,8 @@ export const columns: Column[] = [", "   {", "     key: \"total\",", "-    format: (v) => v.toLocaleString(undefined, { minimumFractionDigits: 2 }),", "+    // the app's locale, not the machine's: the CI runners differ", "+    format: (v) => v.toLocaleString(appLocale(), { minimumFractionDigits: 2 }),", "   },"] }] });
  s.tool("execute", "Run under a French locale", { status: "failed", detail: "LANG=fr_FR.UTF-8 bun test tests/orders.spec.ts", output: "error: Cannot find module \"../locale\" from \"src/orders/columns.ts\"\n\n 0 pass\n 1 fail\nerror: script \"test\" exited with code 1" });
  s.notice("error", "The turn failed: the agent's process exited (code 137, out of memory) while running tests. Send a message to try again.");
  s.end("failed", 2 * MINUTE + 41 * SECOND, SONNET);
  return s;
}

function docs(): Script {
  const s = new Script("s-docs");
  s.user("把 docs/quickstart.md 翻译成中文，放到 docs/zh/quickstart.md。术语保持一致：workspace 译作“工作区”，session 译作“会话”。代码块不要翻译。");
  s.thought("先读原文，确认术语表里有没有别的约定。侧边栏配置也要加上中文入口。");
  s.tool("read", "Read quickstart.md", { detail: "docs/quickstart.md" });
  s.tool("read", "Read sidebars.ts", { detail: "sidebars.ts" });
  s.tool("edit", "Write docs/zh/quickstart.md", { detail: "docs/zh/quickstart.md", diff: [{ path: "docs/zh/quickstart.md", added: 64, removed: 0, lines: ["@@ -0,0 +1,64 @@", "+# 快速开始", "+", "+五分钟内在你的电脑上跑起第一个 **会话**。", "+", "+## 1. 安装命令行工具", "+", "+```bash", "+curl -fsSL https://get.lantern.example/install.sh | sh", "+lantern --version", "+```"] }] });
  s.tool("edit", "Edit sidebars.ts", { detail: "sidebars.ts", diff: [{ path: "sidebars.ts", added: 1, removed: 0, lines: ["@@ -12,6 +12,7 @@ const sidebars = {", "     \"quickstart\",", "+    \"zh/quickstart\",", "     \"concepts/sync\","] }] });
  s.tool("other", "Check links", { detail: "docusaurus check-links docs/zh", output: "✔ 14 links checked, 0 broken" });
  s.text(
    [
      "# 翻译完成",
      "",
      "中文版在 `docs/zh/quickstart.md`，侧边栏已加入口。按你的要求：",
      "",
      "- **workspace → 工作区**，**session → 会话**，全文统一",
      "- 代码块、命令、配置键保持英文原样",
      "- 链接全部检查过，14 个，没有失效",
      "",
      "## 我另外做的决定",
      "",
      "1. 标题层级与原文一致，方便以后对照更新",
      "2. 以下术语原文没有约定，我是这样处理的：",
      "   - *agent* → **智能体**（首次出现时括注英文）",
      "   - *worktree* → 不翻译",
      "     - 理由：Git 的中文文档也保留原文",
      "   - *pull request* → **拉取请求**，之后简写为 PR",
      "3. 原文里的 `brew install` 一节只适用于 macOS，我加了一句说明",
      "",
      "## 需要你看一眼的地方",
      "",
      "| 位置 | 原文 | 译文 | 说明 |",
      "| --- | --- | --- | --- |",
      "| 第 2 节 | pair a machine | 配对一台电脑 | 也可以译“绑定” |",
      "| 第 4 节 | long-lived token | 长期令牌 | 与控制台界面一致 |",
      "",
      "详见 [术语表](https://docs.lantern.example/zh/glossary)。草稿 PR 是 **#96**，你确认术语后我再转为正式。",
    ].join("\n"),
    { final: true },
  );
  s.end("completed", 3 * MINUTE + 5 * SECOND, SONNET);
  s.user("“配对”可以。agent 就叫“智能体”吧，不用括注了。");
  s.tool("edit", "Edit docs/zh/quickstart.md", { detail: "docs/zh/quickstart.md", diff: [{ path: "docs/zh/quickstart.md", added: 3, removed: 3, lines: ["@@ -9,3 +9,3 @@", "-启动一个智能体（agent）并让它读取你的仓库。", "+启动一个智能体并让它读取你的仓库。"] }] });
  s.text("改好了：三处“智能体（agent）”都去掉了括注，“配对”保持不变。PR **#96** 已更新。", { final: true });
  s.end("completed", 38 * SECOND, SONNET);
  return s;
}

function parent(): Script {
  const s = new Script("s-parent");
  s.user("Design and build the plugin loader for harbor: discover plugins under ~/.harbor/plugins, validate each manifest, and load them in dependency order. Split the work if it helps.");
  s.thought("Three parts: manifest parsing/validation, dependency ordering (topological sort with cycle detection), and the loader itself. Tests can go in a child tab; error handling deserves an independent review.");
  s.plan([
    ["Manifest schema and validation (manifest.rs)", "done"],
    ["Topological order with cycle errors (loader.rs)", "done"],
    ["Integration tests in a child tab", "running"],
    ["Independent review of error handling", "done"],
  ]);
  s.tool("read", "Read src/plugin/mod.rs", { detail: "src/plugin/mod.rs" });
  s.tool("edit", "Write manifest.rs", {
    detail: "src/plugin/manifest.rs",
    diff: [{ path: "src/plugin/manifest.rs", added: 58, removed: 0, lines: ["@@ -0,0 +1,58 @@", "+#[derive(Debug, Deserialize)]", "+pub struct Manifest {", "+    pub name: String,", "+    pub version: semver::Version,", "+    #[serde(default)]", "+    pub requires: Vec<String>,", "+}"] }],
  });
  s.tool("edit", "Write loader.rs", {
    detail: "src/plugin/loader.rs",
    diff: [{ path: "src/plugin/loader.rs", added: 96, removed: 0, lines: ["@@ -0,0 +1,96 @@", "+pub fn load_order(manifests: &[Manifest]) -> Result<Vec<&Manifest>, LoadError> {", "+    let mut order = Vec::with_capacity(manifests.len());", "+    let mut state = HashMap::new();", "+    for manifest in manifests {", "+        visit(manifest, manifests, &mut state, &mut order)?;", "+    }", "+    Ok(order)", "+}"] }],
  });
  s.tool("delegate", "Ask a reviewer to check error handling", { detail: "审查 plugin loader 的错误处理", output: "Opened a session on forge-linux with Codex." });
  s.notice("info", "Opened “审查 plugin loader 的错误处理” on forge-linux.", "s-delegated");
  s.text("The loader is in place:\n\n- `manifest.rs` parses and validates `plugin.toml`\n- `loader.rs` orders plugins with a depth-first topological sort and reports the **full cycle path** on a cycle\n\nI opened a child tab for the integration tests and asked a second agent to review the error handling independently.");
  s.notice("done", "“审查 plugin loader 的错误处理” finished: 2 issues found, 1 fixed in place.", "s-delegated");
  s.text(
    [
      "The review came back with two findings; both are addressed:",
      "",
      "1. **A missing dependency produced `LoadError::Cycle`** — it now returns `LoadError::Missing { plugin, requires }`.",
      "2. **A manifest that fails to parse aborted the whole load** — it is now skipped with a warning, and the rest load.",
      "",
      "```rust",
      "#[derive(Debug, thiserror::Error)]",
      "pub enum LoadError {",
      "    #[error(\"plugin `{plugin}` requires `{requires}`, which is not installed\")]",
      "    Missing { plugin: String, requires: String },",
      "    #[error(\"dependency cycle: {}\", .0.join(\" -> \"))]",
      "    Cycle(Vec<String>),",
      "}",
      "```",
      "",
      "Tests are still running in the *tests* tab.",
    ].join("\n"),
    { final: true },
  );
  s.end("completed", 11 * MINUTE + 3 * SECOND, SONNET);
  return s;
}

function parentTests(): Script {
  const s = new Script("s-parent-tests");
  s.user("Write integration tests for the plugin loader: happy path, missing dependency, a cycle, and a manifest that does not parse. Use a temp dir per test.", { author: "Harbor CLI: plugin loader", mine: false });
  s.thought("tempfile::TempDir per test, write plugin.toml files, call load_all and assert on the order or the error.");
  s.tool("edit", "Write tests/plugin_loader.rs", { detail: "tests/plugin_loader.rs", diff: [{ path: "tests/plugin_loader.rs", added: 112, removed: 0, lines: ["@@ -0,0 +1,112 @@", "+#[test]", "+fn loads_in_dependency_order() {", "+    let dir = plugins(&[(\"core\", &[]), (\"git\", &[\"core\"]), (\"review\", &[\"git\"])]);", "+    let order: Vec<_> = load_all(dir.path()).unwrap().iter().map(|p| p.name.clone()).collect();", "+    assert_eq!(order, [\"core\", \"git\", \"review\"]);", "+}"] }] });
  s.tool("execute", "Run the loader tests", { status: "running", detail: "cargo test --test plugin_loader", output: "   Compiling harbor-cli v0.9.0 (/work/harbor-cli)\n   Compiling tempfile v3.14.0" });
  return s;
}

function parentReview(): Script {
  const s = new Script("s-parent-review");
  s.user("把这次 plugin loader 的改动整理成评审说明，中文，给周航看。重点写清楚行为变化。", { author: ME.name });
  s.tool("execute", "Diff against main", { detail: "git diff --stat main...feat/plugin-loader", output: " src/plugin/loader.rs       |  96 ++++++++++\n src/plugin/manifest.rs     |  58 ++++++\n src/plugin/mod.rs          |  11 +-\n tests/plugin_loader.rs     | 112 +++++++++++\n 4 files changed, 274 insertions(+), 3 deletions(-)" });
  s.text(
    [
      "## 评审说明：plugin loader",
      "",
      "**分支** `feat/plugin-loader` · 4 个文件，+274 / −3",
      "",
      "### 行为变化",
      "",
      "- 启动时会扫描 `~/.harbor/plugins/*/plugin.toml`",
      "- 插件按依赖顺序加载；出现循环依赖时**整体失败**，报错里给出完整路径，例如 `git -> review -> git`",
      "- 单个 manifest 解析失败只跳过该插件并打印警告，不影响其他插件",
      "",
      "### 请重点看",
      "",
      "1. `loader.rs` 里 `visit` 的三色标记是否正确",
      "2. `LoadError::Missing` 的文案是否对用户友好",
      "",
      "### 还没做的",
      "",
      "- Windows 路径（`%APPDATA%`）",
      "- 插件的版本约束（现在只看名字）",
    ].join("\n"),
    { final: true },
  );
  s.end("completed", 47 * SECOND, SONNET);
  return s;
}

function delegated(): Script {
  const s = new Script("s-delegated");
  s.user("请独立审查 `src/plugin/loader.rs` 和 `manifest.rs` 的错误处理：有没有把不同的失败混成同一种错误？有没有一个插件坏掉拖垮全部的情况？发现问题直接修，并说明。", { author: "Harbor CLI: plugin loader", mine: false });
  s.thought("逐个走一遍失败路径：manifest 读不到、解析失败、依赖缺失、循环依赖。看每条路径返回的错误类型。");
  s.tool("read", "Read loader.rs", { detail: "src/plugin/loader.rs" });
  s.tool("read", "Read manifest.rs", { detail: "src/plugin/manifest.rs" });
  s.tool("search", "Find error construction sites", { detail: 'rg -n "LoadError::" src/plugin', output: "src/plugin/loader.rs:41:            return Err(LoadError::Cycle(path));\nsrc/plugin/loader.rs:47:            .ok_or_else(|| LoadError::Cycle(vec![manifest.name.clone()]))?;\nsrc/plugin/loader.rs:72:        let manifest = Manifest::read(&path)?;" });
  s.text("发现两个问题：\n\n1. `loader.rs:47` 依赖找不到时返回的是 `LoadError::Cycle`，这是把**缺失依赖**和**循环依赖**混在一起了，用户看到的报错会误导。\n2. `loader.rs:72` 用了 `?`，任何一个 `plugin.toml` 解析失败都会让 `load_all` 整体返回错误。\n\n第 1 个我直接修，第 2 个涉及产品行为（跳过还是失败），我按“跳过并警告”实现，请上游确认。");
  s.tool("edit", "Edit loader.rs", { detail: "src/plugin/loader.rs", diff: [{ path: "src/plugin/loader.rs", added: 5, removed: 2, lines: ["@@ -44,7 +44,10 @@ fn visit<'a>(", "         let dep = manifests", "             .iter()", "             .find(|m| &m.name == required)", "-            .ok_or_else(|| LoadError::Cycle(vec![manifest.name.clone()]))?;", "+            .ok_or_else(|| LoadError::Missing {", "+                plugin: manifest.name.clone(),", "+                requires: required.clone(),", "+            })?;"] }] });
  s.tool("execute", "Run plugin tests", { detail: "cargo test plugin", output: "running 9 tests\n.........\ntest result: ok. 9 passed; 0 failed; 0 ignored" });
  s.text("审查结论：\n\n- **已修复**：缺失依赖现在返回 `LoadError::Missing { plugin, requires }`\n- **待确认**：单个 manifest 解析失败时跳过并警告（已实现，可回退）\n- 其余路径（读文件失败、循环依赖）的错误类型是准确的\n\n9 个测试通过。", { final: true });
  s.end("completed", 5 * MINUTE + 20 * SECOND, CODEX);
  return s;
}

function starting(): Script {
  const s = new Script("s-starting");
  s.user("给 Kite 加深色模式：跟随系统设置，也能在设置页手动切换。颜色全部走 tokens.css 里的变量。", { delivery: "sending" });
  s.notice("info", "Preparing the workspace: cloning lantern-labs/kite-web…");
  return s;
}

function chat(): Script {
  const s = new Script("s-chat");
  s.user("Rust 里这段为什么编译不过？\n\n```rust\nfn longest(a: &str, b: &str) -> &str {\n    if a.len() > b.len() { a } else { b }\n}\n```");
  s.text(
    [
      "因为返回值是一个引用，编译器需要知道它**借用自谁**，而这里有两个候选（`a` 和 `b`），生命周期省略规则推不出来。",
      "",
      "加上显式的生命周期参数就可以：",
      "",
      "```rust",
      "fn longest<'a>(a: &'a str, b: &'a str) -> &'a str {",
      "    if a.len() > b.len() { a } else { b }",
      "}",
      "```",
      "",
      "`'a` 的意思是：返回的引用至少和 `a`、`b` 中**较短**的那个活得一样久。调用方因此不能这样用：",
      "",
      "```rust",
      "let result;",
      "let a = String::from(\"long string\");",
      "{",
      "    let b = String::from(\"short\");",
      "    result = longest(&a, &b);",
      "} // b 在这里被释放",
      "println!(\"{result}\"); // error[E0597]: `b` does not live long enough",
      "```",
    ].join("\n"),
    { final: true },
  );
  s.end("completed", 9 * SECOND, HAIKU);
  s.user("那省略规则具体是哪几条？有没有官方文档？");
  s.tool("fetch", "Look up lifetime elision", { detail: "https://doc.rust-lang.example/reference/lifetime-elision.html", output: "200 OK · 31.2 kB · Lifetime elision — The Rust Reference" });
  s.text(
    [
      "一共三条，按顺序应用：",
      "",
      "1. **每个省略的输入生命周期各得一个参数**：`fn f(a: &str, b: &str)` 变成 `fn f<'a, 'b>(a: &'a str, b: &'b str)`",
      "2. **如果只有一个输入生命周期**，它被赋给所有输出：`fn first(s: &str) -> &str` 没问题",
      "3. **如果有 `&self` 或 `&mut self`**，`self` 的生命周期被赋给所有输出",
      "",
      "你的 `longest` 有两个输入、没有 `self`，第 2、3 条都不适用，所以必须手写。",
      "",
      "| 签名 | 能省略吗 | 适用规则 |",
      "| --- | --- | --- |",
      "| `fn len(s: &str) -> usize` | 能 | 1 |",
      "| `fn first(s: &str) -> &str` | 能 | 1、2 |",
      "| `fn name(&self) -> &str` | 能 | 1、3 |",
      "| `fn longest(a: &str, b: &str) -> &str` | 不能 | — |",
      "",
      "文档在 [The Rust Reference · Lifetime elision](https://doc.rust-lang.example/reference/lifetime-elision.html)。",
    ].join("\n"),
    { final: true },
  );
  s.end("completed", 14 * SECOND, HAIKU);
  return s;
}

function air(): Script {
  const s = new Script("s-air");
  s.user("Run bench/run.sh five times and tell me the median cold start. The Air is on battery, so note that.");
  s.tool("execute", "Run the benchmark", { detail: "for i in 1 2 3 4 5; do ./bench/run.sh --cold; done", output: "cold start: 412 ms\ncold start: 398 ms\ncold start: 431 ms\ncold start: 405 ms\ncold start: 402 ms" });
  s.text("Median cold start is **405 ms** over five runs (min 398, max 431). The machine was on battery in *Low Power Mode*, which usually costs 10–15%, so expect roughly 350–365 ms plugged in.\n\nI appended the numbers to `bench/cold-start.md`.", { final: true });
  s.end("completed", 52 * SECOND, HAIKU);
  s.user("Thanks. Try again tomorrow when it's plugged in.", { delivery: "failed" });
  s.notice("error", "The message was not delivered: 林夏的 MacBook Air is offline.");
  return s;
}

function old(): Script {
  const s = new Script("s-old");
  s.user("Spike: can tidepool's engine crate build for wasm32-unknown-unknown? Don't fix everything, just list what breaks.");
  s.tool("execute", "Try the build", { status: "failed", detail: "cargo build -p engine --target wasm32-unknown-unknown", output: "error[E0433]: failed to resolve: could not find `unix` in `os`\n  --> crates/engine/src/journal.rs:9:14\nerror: could not compile `engine` (lib) due to 3 previous errors" });
  s.text("It does not build yet. Three things break:\n\n1. `journal.rs` uses `std::os::unix::fs::FileExt` for positioned writes\n2. `tokio` is pulled with the `rt-multi-thread` feature\n3. `rand` needs the `js` feature of `getrandom`\n\nNone is deep; (1) is the real work: the journal needs a storage trait. I closed the draft PR since this was only a spike.", { final: true });
  s.end("canceled", 1 * MINUTE + 30 * SECOND, SONNET);
  return s;
}

// --- the long one ------------------------------------------------------------

/** A small seeded generator (mulberry32): the same seed, the same session. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LONG_FILES = ["segment.rs", "compaction.rs", "index.rs", "lib.rs"];
const LONG_ROUNDS: { ask: (file: string, n: number) => string; think: string; command: (file: string) => string; output: (n: number) => string; diff: (file: string, n: number) => string[]; answer: (file: string, n: number) => string }[] = [
  {
    ask: (file) => `Start with \`${file}\`: split the read path from the write path. No behaviour change yet.`,
    think: "Find every function that takes &mut self but only reads. Those move to the reader half.",
    command: (file) => `rg -n "fn .*&mut self" crates/store/src/${file}`,
    output: (n) => `${40 + n}:    pub fn append(&mut self, record: &Record) -> io::Result<u64> {\n${71 + n}:    pub fn get(&mut self, offset: u64) -> io::Result<Record> {\n${96 + n}:    pub fn flush(&mut self) -> io::Result<()> {`,
    diff: (_file, n) => [`@@ -${68 + n},7 +${68 + n},7 @@ impl Segment {`, "-    pub fn get(&mut self, offset: u64) -> io::Result<Record> {", "+    pub fn get(&self, offset: u64) -> io::Result<Record> {", `     let mut buf = vec![0; HEADER_LEN];`, "-        self.file.seek(SeekFrom::Start(offset))?;", "-        self.file.read_exact(&mut buf)?;", "+        self.file.read_exact_at(&mut buf, offset)?;"],
    answer: (file, n) => `Split done in \`${file}\`. \`get\` no longer needs \`&mut self\`: it reads with \`read_exact_at\`, so readers do not move the file cursor.\n\n- ${3 + (n % 4)} call sites updated\n- no behaviour change; \`cargo test -p store\` passes (${61 + n} tests)`,
  },
  {
    ask: (file) => `\`${file}\` 里的校验和现在是每条记录算一次 CRC32，改成按块算，块大小 4 KiB。`,
    think: "按块校验要改磁盘格式，需要版本号。先确认 header 里有没有预留字段。",
    command: () => 'rg -n "FORMAT_VERSION|crc32" crates/store/src',
    output: (n) => `crates/store/src/segment.rs:12:const FORMAT_VERSION: u16 = ${2 + (n % 2)};\ncrates/store/src/segment.rs:${130 + n}:        let crc = crc32fast::hash(&payload);\ncrates/store/src/index.rs:${44 + n}:    crc: u32,`,
    diff: (_file, n) => [`@@ -${128 + n},6 +${128 + n},10 @@ impl Segment {`, "-        let crc = crc32fast::hash(&payload);", "-        self.file.write_all(&crc.to_le_bytes())?;", "+        self.block.extend_from_slice(&payload);", "+        if self.block.len() >= BLOCK_LEN {", "+            let crc = crc32fast::hash(&self.block[..BLOCK_LEN]);", "+            self.write_block(crc)?;", "+        }"],
    answer: (file, n) => `改好了。\`${file}\` 现在每 **4 KiB** 写一个块校验和，格式版本升到 ${3 + (n % 2)}。\n\n| 指标 | 之前 | 之后 |\n| --- | ---: | ---: |\n| 写入吞吐 | ${180 + n} MB/s | ${240 + n * 2} MB/s |\n| 每条记录开销 | 4 字节 | 0 字节 |\n\n旧版本的段文件仍然能读：读取时按 header 里的版本号分支。`,
  },
  {
    ask: (file) => `Compaction holds the write lock for the whole run. Make \`${file}\` compact into a new segment and swap at the end.`,
    think: "Copy-on-write compaction: write the survivors to a temp segment, fsync, then rename under a short lock. Readers holding the old segment keep it alive through an Arc.",
    command: () => "cargo test -p store compaction -- --nocapture",
    output: (n) => `running ${4 + (n % 3)} tests\ntest compaction::tests::swap_is_atomic ... ok\ntest compaction::tests::readers_see_old_segment_until_drop ... ok\ntest compaction::tests::crash_before_rename_leaves_old_segment ... ok\n\ntest result: ok. ${4 + (n % 3)} passed; 0 failed`,
    diff: (_file, n) => [`@@ -${22 + n},9 +${22 + n},14 @@ pub fn compact(store: &Store) -> io::Result<Stats> {`, "-    let mut guard = store.segments.write();", "-    let live = guard.active().live_records()?;", "+    let source = store.segments.read().active();", "+    let mut target = Segment::create(store.dir.join(TMP_NAME))?;", "+    for record in source.live_records()? {", "+        target.append(&record)?;", "+    }", "+    target.sync_all()?;", "+    store.segments.write().swap(target)?;"],
    answer: (file, n) => `\`${file}\` now compacts off to the side:\n\n1. read the live records from the active segment (shared lock)\n2. write them to \`compact.tmp\` and \`fsync\`\n3. take the write lock only for the rename and the pointer swap\n\nThe write lock is held for about **${2 + (n % 5)} ms** instead of the whole compaction. A crash before step 3 leaves the old segment untouched.`,
  },
  {
    ask: () => "跑一下基准测试，对比一下重构前后的 p99 延迟。",
    think: "用 criterion 的 baseline 功能：main 分支的结果已经存成 baseline 了，直接对比。",
    command: () => "cargo bench -p store -- --baseline main",
    output: (n) => `append/4k        time:   [${11 + (n % 4)}.2 µs ${11 + (n % 4)}.4 µs ${11 + (n % 4)}.7 µs]\n                 change: [-${18 + n}.1% -${17 + n}.3% -${16 + n}.6%] (p = 0.00 < 0.05)\n                 Performance has improved.\nget/random       time:   [${3 + (n % 3)}.1 µs ${3 + (n % 3)}.2 µs ${3 + (n % 3)}.3 µs]\n                 change: [-2.1% -0.4% +1.2%] (p = 0.61 > 0.05)\n                 No change in performance detected.`,
    diff: (_file, n) => [`@@ -${8 + n},3 +${8 + n},4 @@`, " [[bench]]", ' name = "store"', " harness = false", '+required-features = ["bench"]'],
    answer: (_file, n) => `基准结果（对比 \`main\`）：\n\n- **append/4k**：快了约 ${17 + n}%，主要来自按块校验\n- **get/random**：没有显著变化（p = 0.61）\n- p99 延迟从 ${90 + n} µs 降到 ${61 + n} µs\n\n读路径没有变慢，符合预期。`,
  },
  {
    ask: (file) => `Document the on-disk format changes in docs/storage-format.md, and mention \`${file}\`.`,
    think: "The format doc has a table per version. Add a row and a short migration note.",
    command: () => "git diff --stat",
    output: (n) => ` crates/store/src/segment.rs    | ${40 + n} ++++++----\n crates/store/src/compaction.rs | ${22 + n} +++---\n docs/storage-format.md         | ${18 + (n % 6)} +++\n 3 files changed`,
    diff: (_file, n) => [`@@ -${30 + n},6 +${30 + n},12 @@ ## Versions`, " | 2 | per-record CRC32 | 0.12 |", "+| 3 | per-block CRC32, 4 KiB blocks | 0.15 |", "+", "+### Reading older segments", "+", "+A reader branches on the header's version; nothing is rewritten in place."],
    answer: (file) => `Updated \`docs/storage-format.md\`: a row for format **3**, a section on reading older segments, and a pointer to \`${file}\` for the block layout. The doc builds without warnings.`,
  },
  {
    ask: () => "有个测试偶尔失败：segment_roundtrip。看看是不是这次重构引入的。",
    think: "偶发失败多半是并发或临时目录冲突。先连续跑 50 次看看复现率。",
    command: () => "for i in $(seq 50); do cargo test -q -p store segment_roundtrip || echo FAIL; done | sort | uniq -c",
    output: (n) => `  ${47 + (n % 3)} test result: ok. 1 passed; 0 failed\n   ${3 - (n % 3)} FAIL`,
    diff: (_file, n) => [`@@ -${14 + n},5 +${14 + n},5 @@ fn segment_roundtrip() {`, "-    let dir = std::env::temp_dir().join(\"tidepool-test\");", "+    let dir = tempfile::tempdir().unwrap();", "     let mut segment = Segment::create(dir.path().join(\"0001.seg\")).unwrap();"],
    answer: (_file, n) => `不是这次重构引入的：测试用了**固定的临时目录** \`/tmp/tidepool-test\`，并行跑时两个测试会互相覆盖文件。\n\n改成 \`tempfile::tempdir()\` 后连续跑了 ${200 + n * 10} 次，全部通过。`,
  },
];

function long(): Script {
  const s = new Script("s-long");
  const random = seeded(20261118);
  s.user("We're refactoring tidepool's storage crate over a few sessions. Goals: separate read/write paths, block checksums, non-blocking compaction. I'll steer step by step; keep each change small and tested.");
  s.plan([
    ["Split read and write paths", "done"],
    ["Per-block checksums (format v3)", "done"],
    ["Copy-on-write compaction", "done"],
    ["Benchmarks against main", "done"],
    ["Docs and cleanup", "done"],
  ]);
  s.text("Understood. I'll keep every step to one concern, run `cargo test -p store` after each, and say when a change touches the on-disk format.", { final: true });
  s.end("completed", 8 * SECOND, SONNET);
  for (let round = 0; round < 20; round++) {
    const shape = LONG_ROUNDS[round % LONG_ROUNDS.length]!;
    const file = LONG_FILES[Math.floor(random() * LONG_FILES.length)]!;
    const n = Math.floor(random() * 9);
    s.user(shape.ask(file, n), round % 7 === 3 ? { author: "Mira", mine: false } : {});
    s.thought(shape.think);
    s.tool("read", `Read ${file}`, { detail: `crates/store/src/${file}` });
    s.tool(round % 2 ? "execute" : "search", round % 2 ? "Run a command" : "Search the crate", { detail: shape.command(file), output: shape.output(n) });
    s.tool("edit", `Edit ${file}`, { detail: `crates/store/src/${file}`, diff: [{ path: `crates/store/src/${file}`, added: 4 + n, removed: 2 + (n % 4), lines: shape.diff(file, n) }] });
    s.text(shape.answer(file, n), { final: true });
    s.end("completed", (40 + Math.floor(random() * 200)) * SECOND, round % 5 === 4 ? CODEX : SONNET);
  }
  return s;
}

// --- the other workspace ------------------------------------------------------

function blog(): Script {
  const s = new Script("h-blog");
  s.user("博客想从动态渲染迁到静态生成，文章是 Markdown。帮我列个迁移清单。");
  s.text("迁移清单：\n\n1. 导出现有文章为 Markdown（保留 front matter）\n2. 选生成器：文章不多的话任何一个都行，关键是**模板能复用**\n3. 把评论换成静态友好的方案\n4. 设置 301，保证旧链接不失效\n5. 部署到对象存储 + CDN\n\n要我先写导出脚本吗？", { final: true });
  s.end("completed", 11 * SECOND, HAIKU);
  return s;
}

function dotfiles(): Script {
  const s = new Script("h-dotfiles");
  s.user("Port my fish abbreviations to zsh aliases. The file is ~/.config/fish/conf.d/abbr.fish.");
  s.tool("read", "Read abbr.fish", { detail: "~/.config/fish/conf.d/abbr.fish" });
  s.tool("edit", "Write ~/.zsh/aliases.zsh", { detail: "~/.zsh/aliases.zsh", diff: [{ path: ".zsh/aliases.zsh", added: 14, removed: 0, lines: ["@@ -0,0 +1,14 @@", "+alias g='git'", "+alias gs='git status -sb'", "+alias gp='git pull --rebase'", "+alias k='kubectl'"] }] });
  s.text("Ported 14 abbreviations to `~/.zsh/aliases.zsh`. Two used fish's `--position anywhere`; zsh has global aliases (`alias -g`) for that, so I used those.\n\n```bash\nsource ~/.zsh/aliases.zsh\n```", { final: true });
  s.end("completed", 26 * SECOND, SONNET);
  return s;
}

function recipes(): Script {
  const s = new Script("h-recipes");
  s.user("菜谱小程序的数据结构怎么设计？要支持按食材搜索，还要能按份数换算用量。");
  s.thought("食材要单独成表才能搜索；用量存数值 + 单位，换算时按份数比例缩放。");
  s.text("建议三张表：\n\n- `recipes`：标题、默认份数、步骤\n- `ingredients`：食材名（唯一）\n- `recipe_ingredients`：`recipe_id`、`ingredient_id`、`amount`、`unit`\n\n```ts\ninterface RecipeIngredient {\n  ingredientId: string;\n  amount: number; // 以默认份数为基准\n  unit: \"g\" | \"ml\" | \"个\" | \"勺\";\n}\n\nconst scaled = (item: RecipeIngredient, servings: number, base: number) => ({\n  ...item,\n  amount: Math.round((item.amount * servings * 10) / base) / 10,\n});\n```\n\n“适量”“少许”这类用量 `amount` 存 `null`，换算时原样显示。", { final: true });
  s.end("completed", 19 * SECOND, SONNET);
  return s;
}

// ---------------------------------------------------------------------------
// The workspace at `now`.
// ---------------------------------------------------------------------------

interface Sheet {
  workspace: string;
  script: Script;
  /** how long before `now` the last item is */
  ago: number;
  state: SessionState;
  row: Partial<SessionRow> & { title: string };
  live?: "stream";
}

export function buildFixture(now: number): FixtureSession[] {
  const sheets: Sheet[] = [
    { workspace: "ws-lantern", script: syncRetry(), ago: 4 * SECOND, state: "running", live: "stream", row: { title: "同步引擎：重试退避改成指数加抖动", mine: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "lantern-labs/tidepool", branch: "feat/retry-jitter" } },
    { workspace: "ws-lantern", script: release(), ago: 2 * MINUTE, state: "waiting", row: { title: "发布 0.9.0：等待确认推送 tag", mine: true, unread: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "lantern-labs/harbor-cli", branch: "release/0.9.0" } },
    { workspace: "ws-lantern", script: starting(), ago: 6 * SECOND, state: "starting", row: { title: "给 Kite 加深色模式", mine: true, machineId: "m-forge", agent: "Codex", model: CODEX, project: "lantern-labs/kite-web", branch: "feat/dark-mode" } },
    { workspace: "ws-lantern", script: schema(), ago: 9 * MINUTE, state: "waiting", row: { title: "数据库迁移方案：选哪种分区策略？", mine: true, unread: true, machineId: "m-forge", agent: "Claude", model: SONNET, project: "lantern-labs/tidepool", branch: "main" } },
    { workspace: "ws-lantern", script: kiteTable(), ago: 26 * MINUTE, state: "idle", row: { title: "Kite: virtualize the orders table", mine: true, unread: true, machineId: "m-studio", agent: "Codex", model: CODEX, project: "lantern-labs/kite-web", branch: "perf/virtual-table", prs: [{ url: "https://git.example/lantern-labs/kite-web/pull/482", number: 482, state: "open" }] } },
    { workspace: "ws-lantern", script: ciFlake(), ago: 48 * MINUTE, state: "failed", row: { title: "CI: flaky snapshot test on Linux", unread: true, machineId: "m-forge", agent: "Claude", model: SONNET, project: "lantern-labs/kite-web", branch: "fix/locale-snapshots" } },
    { workspace: "ws-lantern", script: parent(), ago: 1 * HOUR + 10 * MINUTE, state: "idle", row: { title: "Harbor CLI: plugin loader", mine: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "lantern-labs/harbor-cli", branch: "feat/plugin-loader", prs: [{ url: "https://git.example/lantern-labs/harbor-cli/pull/131", number: 131, state: "open", draft: true }] } },
    { workspace: "ws-lantern", script: parentTests(), ago: 40 * SECOND, state: "running", row: { title: "tests", mine: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "lantern-labs/harbor-cli", branch: "feat/plugin-loader", parentId: "s-parent" } },
    { workspace: "ws-lantern", script: parentReview(), ago: 55 * MINUTE, state: "idle", row: { title: "评审说明", mine: true, unread: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "lantern-labs/harbor-cli", branch: "feat/plugin-loader", parentId: "s-parent" } },
    { workspace: "ws-lantern", script: delegated(), ago: 1 * HOUR + 22 * MINUTE, state: "idle", row: { title: "审查 plugin loader 的错误处理", machineId: "m-forge", agent: "Codex", model: CODEX, project: "lantern-labs/harbor-cli", branch: "feat/plugin-loader", openedById: "s-parent" } },
    { workspace: "ws-lantern", script: long(), ago: 3 * HOUR, state: "idle", row: { title: "Tidepool storage refactor", mine: true, pinned: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "lantern-labs/tidepool", branch: "refactor/store", prs: [{ url: "https://git.example/lantern-labs/tidepool/pull/311", number: 311, state: "merged" }, { url: "https://git.example/lantern-labs/tidepool/pull/318", number: 318, state: "open" }] } },
    { workspace: "ws-lantern", script: docs(), ago: 5 * HOUR, state: "idle", row: { title: "文档站：把快速开始翻译成中文", mine: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "lantern-labs/docs", branch: "docs/zh-quickstart", prs: [{ url: "https://git.example/lantern-labs/docs/pull/96", number: 96, state: "open", draft: true }] } },
    { workspace: "ws-lantern", script: chat(), ago: 1 * DAY + 2 * HOUR, state: "idle", row: { title: "Rust 生命周期问答", mine: true, machineId: "m-studio", agent: "Claude", model: HAIKU } },
    { workspace: "ws-lantern", script: air(), ago: 2 * DAY, state: "idle", row: { title: "Bench: cold start on the Air", mine: true, machineId: "m-air", agent: "Claude", model: HAIKU, project: "notebook" } },
    { workspace: "ws-lantern", script: old(), ago: 9 * DAY, state: "idle", row: { title: "Spike: wasm build of tidepool", archived: true, machineId: "m-forge", agent: "Claude", model: SONNET, project: "lantern-labs/tidepool", branch: "spike/wasm", prs: [{ url: "https://git.example/lantern-labs/tidepool/pull/297", number: 297, state: "closed" }] } },
    { workspace: "ws-home", script: recipes(), ago: 3 * HOUR + 20 * MINUTE, state: "idle", row: { title: "菜谱小程序的数据结构", mine: true, unread: true, machineId: "m-studio", agent: "Claude", model: SONNET, project: "scratch" } },
    { workspace: "ws-home", script: dotfiles(), ago: 2 * DAY + 5 * HOUR, state: "idle", row: { title: "dotfiles: fish → zsh", mine: true, machineId: "m-studio", agent: "Claude", model: SONNET } },
    { workspace: "ws-home", script: blog(), ago: 6 * DAY, state: "idle", row: { title: "博客：迁移到静态生成", mine: true, machineId: "m-air", agent: "Claude", model: HAIKU } },
  ];
  return sheets.map((sheet) => {
    const items = sheet.script.shifted(now - sheet.ago);
    const preview = previewOf(items);
    const busy = sheet.state === "running" || sheet.state === "waiting" || sheet.state === "starting";
    return {
      workspace: sheet.workspace,
      row: { id: sheet.script.id, state: sheet.state, createdAt: items[0]!.at - 2 * SECOND, updatedAt: items[items.length - 1]!.at, ...sheet.row, ...(preview ? { preview } : {}) },
      items,
      ...(busy ? { activeTurn: sheet.script.lastTurn } : {}),
      ...(sheet.live ? { live: sheet.live } : {}),
    };
  });
}

/** What the running session's last text grows into. */
export const STREAM_TAIL = [
  " `dead_letter` 队列，不再无限重试\n- `Queue::new` 多了一个 `policy` 参数，旧的调用点用 `RetryPolicy::default()`",
  "\n- 测试里原来断言 `[2, 2, 2]` 的地方改成了断言**上界**：第 n 次的延迟 ≤ `min(cap, base * 2^n)`",
  "\n\n```rust\nlet policy = RetryPolicy { max_attempts: 5, ..Default::default() };\nlet queue = Queue::new(transport, policy);\n```",
  "\n\n6 个测试全部通过。要不要我顺便把 `max_attempts` 接到配置文件的 `sync.retry.max_attempts` 上？",
];
