import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// tests/README.md carries the balance judgement the tests-folder-conventions require: which areas
// RepoFocus has, and which tests stand for each. A map nobody checks decays into a list of paths
// that used to exist, so this reads the real file and holds it to what is on disk.

const TESTS = path.dirname(fileURLToPath(import.meta.url));

interface Area {
  readonly name: string;
  readonly tests: readonly string[];
}

function areas(): Area[] {
  const rows = readFileSync(path.join(TESTS, "README.md"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2); // the header row and the one of dashes under it
  return rows.map((row) => {
    const cells = row.split("|").slice(1, -1);
    return {
      name: cells[0]?.trim() ?? "",
      tests: [...(cells[2] ?? "").matchAll(/`([^`]+)`/g)].flatMap((match) => match[1] ?? []),
    };
  });
}

describe("the area map", () => {
  it("lists areas", () => {
    expect(areas().length).toBeGreaterThan(1);
  });

  it("names at least one test for every area", () => {
    expect(areas().filter((area) => area.tests.length === 0).map((area) => area.name)).toEqual([]);
  });

  it("names only tests that exist", () => {
    const missing = areas().flatMap((area) =>
      area.tests.filter((test) => !existsSync(path.join(TESTS, test))).map((test) => `${area.name}: ${test}`),
    );
    expect(missing).toEqual([]);
  });
});
