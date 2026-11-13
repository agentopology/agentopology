import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parse } from "../../parser/index.js";
import { generateVisualization } from "../index.js";
import { drawPage } from "./vm-draw.js";

const ROOT = path.resolve(__dirname, "../../..");
const KITCHEN = fs.readFileSync(path.join(ROOT, "kitchen-sink.at"), "utf8");

/** Font size in px of every <text> in the drawn svg: its attribute, else its class rule in the page CSS. */
function textSizes(html: string, svg: string): Array<{ text: string; size: number }> {
  const css = html.match(/<style>([\s\S]*?)<\/style>/)![1];
  const classSize = (cls: string): number | undefined => {
    for (const c of cls.split(/\s+/)) {
      const m = css.match(new RegExp("(?:^|[},\\s])\\." + c.replace(/[-]/g, "\\-") + "(?:\\s[^{]*)?\\{[^}]*font-size:([\\d.]+)px", "m"));
      if (m) return parseFloat(m[1]);
    }
    return undefined;
  };
  const out: Array<{ text: string; size: number }> = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    const attrs = m[1];
    const own = attrs.match(/font-size="([\d.]+)"/);
    const cls = attrs.match(/class="([^"]*)"/);
    // A text with no size of its own takes the size of the group class around it.
    let size = own ? parseFloat(own[1]) : cls ? classSize(cls[1]) : undefined;
    if (size === undefined) {
      const before = svg.slice(0, m.index);
      const g = [...before.matchAll(/<g class="([^"]*)"/g)].pop();
      size = g ? classSize(g[1] + " " + g[1].split(" ").map((c) => c + " text").join(" ")) : undefined;
    }
    out.push({ text: m[2].replace(/<[^>]+>/g, ""), size: size ?? 16 });
  }
  return out;
}

function boxes(svg: string): Array<{ id: string; x: number; y: number; w: number; h: number }> {
  return [...svg.matchAll(/<g class="node-group[^"]*" data-id="([^"]+)"[^>]*data-box="([-\d.,]+)"/g)].map((m) => {
    const [x, y, w, h] = m[2].split(",").map(Number);
    return { id: m[1], x, y, w, h };
  });
}

describe("[VZ5] kitchen-sink.at opens readable", () => {
  const html = generateVisualization(parse(KITCHEN));
  const out = drawPage(html, { width: 1440, height: 900 });
  const bs = boxes(out.svg);

  it("[VZ-5] draws at most 25 blocks", () => {
    expect(bs.length).toBeGreaterThan(0);
    expect(bs.length).toBeLessThanOrEqual(25);
  });

  it("[VZ-5] every label is at least 11 px", () => {
    const small = textSizes(html, out.svg).filter((t) => t.size < 11);
    expect(small.map((t) => `${t.text}@${t.size}`)).toEqual([]);
  });

  it("[VZ-5] 0 node boxes overlap", () => {
    expect(bs.length).toBeGreaterThan(0);
    const hit: string[] = [];
    for (let i = 0; i < bs.length; i++)
      for (let j = i + 1; j < bs.length; j++) {
        const a = bs[i], b = bs[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) hit.push(`${a.id}/${b.id}`);
      }
    expect(hit).toEqual([]);
  });
});

const PLANTED = `topology flow-lens : [pipeline] {
  meta {
    version: "1.0.0"
    description: "planted for the flow lens"
  }
  agent a {
    model: sonnet
    description: "a"
    memory: [kb]
    tools: [Read]
  }
  agent b {
    model: sonnet
    description: "b"
    phase: 1
    tools: [Read]
  }
  agent c {
    model: sonnet
    description: "c"
    phase: 1
    tools: [Read]
  }
  agent d {
    model: sonnet
    description: "d"
    phase: 2
    tools: [Read]
  }
  agent e {
    model: sonnet
    description: "e"
    tools: [Read]
  }
  human boss {
    description: "signs off"
    timeout: 1h
    on-timeout: halt
  }
  gates {
    gate g1 {
      after: c
      before: d
      run: "scripts/g1.sh"
      behavior: blocking
    }
  }
  memory {
    store kb {
      type: semantic
      backend: lancedb
      path: ".memory/kb/"
    }
  }
  schedule {
    job nightly {
      cron: "0 3 * * *"
      agent: a
    }
  }
  triggers {
    command go {
      pattern: "/go"
    }
  }
  flow {
    a -> b -> c
    c -> d
    d -> boss
    boss -> e
    e -> d [max 2]
    d -> e [wait 30s]
    d -x-> e
  }
}`;

describe("[VZ5] the flow lens shows what sits on the flow", () => {
  const ast = parse(PLANTED);
  const html = generateVisualization(ast);
  const out = drawPage(html, { width: 1440, height: 900 });

  it("[VZ-5] a gate is a chip on the edge it guards (c is inside the collapsed stage), with a grade chip beside it", () => {
    expect(out.svg).toMatch(/<g class="gate-chip"[^>]*data-gate="g1" data-from="stage:phase-1" data-to="d"/);
  });

  it("[VZ-5] the human step sits in one seat lane", () => {
    expect(out.svg).toMatch(/<g class="seat-lane" data-seats="boss"/);
    expect(out.svg.match(/class="seat-lane"/g)!.length).toBe(1);
  });

  it("[VZ-5] stores sit on a rail with read and write ticks", () => {
    expect(out.svg).toMatch(/<g class="store-rail"/);
    expect(out.svg).toMatch(/<g class="store-tick" data-store="kb" data-kind="read" data-agent="a"/);
  });

  it("[VZ-5] jobs and triggers carry flags", () => {
    expect(out.svg).toMatch(/class="flag"[^>]*data-flag="job"[^>]*data-for="a"/);
    expect(out.svg).toMatch(/class="flag"[^>]*data-flag="trigger"/);
  });

  it("[VZ-5] loop, wait and error edges differ by dash pattern and by a word", () => {
    const dashOf = (kind: string) => out.svg.match(new RegExp('class="edge-path ' + kind + '"[^>]*stroke-dasharray="([^"]+)"'))?.[1];
    const dashes = ["loop", "wait", "error"].map(dashOf);
    dashes.forEach((d) => expect(d).toBeDefined());
    expect(new Set(dashes).size).toBe(3);
    expect(out.svg).toMatch(/>loop max 2</);
    expect(out.svg).toMatch(/>wait 30s</);
    expect(out.svg).toMatch(/>error</);
  });

  it("[VZ-5] stages open collapsed, and a click opens one", () => {
    expect(out.svg).toMatch(/<g class="node-group stage[^"]*" data-id="stage:phase-1"/);
    expect(boxes(out.svg).map((b) => b.id)).not.toContain("b");
    const after = drawPage(html, { width: 1440, height: 900 });
    after.run("toggleStage('stage:phase-1')");
    expect(after.run("document.getElementById('graph-svg').innerHTML")).toContain('data-id="b"');
  });
});
